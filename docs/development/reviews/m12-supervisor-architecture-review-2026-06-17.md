# M12 Supervisor — Message-Delivery Architecture Review

**Reviewer:** `/analyse` (architecture review, max-rigor) · **Date:** 2026-06-17 · **Scope:** `tools/supervisor/` — the I/O driver layer that delivers Telegram messages into a hosted Claude orchestrator session and its answers back.
**Mode:** READ-ONLY (no `tools/supervisor` edits; the running supervisor + dev-m12p3a's lock/WIP/log were not touched; live forensics preserved).
**Verdict (one line):** The recurring bug stream is real, is structural, and traces to ONE root cause — the architecture screen-scrapes a human terminal UI to recover machine state. That root cause is now **avoidable**: a subscription-billed Claude session can emit fully structured machine-readable I/O today. **Recommend replacing the I/O driver, not patching the scraper.**

---

## 1. The real requirement (sharpened)

> User's framing (verbatim): *"This is a relatively simple task we are struggling with; robustly deliver incoming messages to the agent's CLI and deliver its answers back to user. The fact that it causes so many problems indicates that the architecture is incorrect or overcomplicated."*

Sharpened to testable terms, the system must:

| # | Requirement | Acceptance |
|---|---|---|
| R1 | Deliver an inbound channel (Telegram) message INTO a hosted Claude "orchestrator" session as a user turn | No dropped / mis-timed inbound; a message sent while the session is busy is queued, not lost |
| R2 | Deliver the session's answer BACK to the user | Exactly one outbound per turn; no lost, stale, doubled, or empty answers |
| R3 | Know turn boundaries (when an answer is complete) | Deterministic turn-complete signal; works for fast AND slow (90s+) turns |
| R4 | Route tool-permission decisions (approve/deny destructive ops) | Programmatic allow/deny round-trip with the user; safety floor on destructive ops |
| R5 | Run **subscription-billed** (Claude Max), NOT API pay-per-token | The hosted session draws from the user's plan |
| R6 | Multi-turn continuity in a long-lived session | Conversational memory across turns; survivable restart/resume |
| R7 | Containment | The hosted session cannot reach production channels (telegram plugin, whatsapp, outward email) |

R5 is the constraint the current design treats as forcing everything else. **This review's central empirical finding is that R5 does NOT force TUI scraping** — it is satisfiable alongside structured I/O. That changes the answer to the whole question.

---

## 2. Root-cause analysis — does the bug stream trace to TUI screen-scraping?

### 2.1 The thesis, tested

**Thesis:** every recurring bug is a symptom of one root cause — the architecture SCREEN-SCRAPES a human-oriented terminal UI (the interactive `claude` TUI via `node-pty` + a rendered-grid parser, `pty-grid.ts` on `@xterm/headless`) to recover machine state (turn boundaries, answer text, permission prompts).

**Held? YES — decisively.** The evidence is the session log's own debug ledger plus the live capture store.

### 2.2 The bug ledger (from `docs/development/logs/dev-m12p3a-2026-06-15-082752.md`)

The Option-3 PTY path produced **26 debug iterations** (`[STEP-6-DEBUG iter=1…26]`). After removing the genuinely-separate ones (the role-bootstrap timing fix iter 1; the containment-breach iters 15–17 which are an MCP-config inheritance problem, not scraping; the double-response investigation iter 22 which exonerated the harnesses), the residual is a **monotonic stream of "recover machine state from the render" defects** — at least **nine distinct recurrences of the same class**:

| iter | Defect | What was being scraped | The "fix" |
|---|---|---|---|
| 6 | Spinner `"Orchestrating…"` leaked to the channel AS the reply; final text dropped | turn-complete + answer text | catch-all row→prose removed; pattern spinner reject |
| 7 | Answer block split by blank lines; trailing spinner became the "reply" | answer-block boundaries | "answer-block model": `●` head + continuation rows |
| 8 | `$()` permission gate undetected → child blocked → hang; premature turn-complete on a start-of-turn `❯` flash | permission prompt + turn-complete | generic prompt detector; `turnCompleteStableNeeded=3` |
| 14 | Completed turn never emitted a result; answer trapped on screen — `"✻ Crunched for 3m 28s"` (past-tense completion) mis-read as an active spinner | turn-complete | `isCompletionSummary()` predicate |
| 18 | A FAST reply never fired a result — the data-gated poll stalled when the TUI stopped repainting | turn-complete | self-reschedule poll |
| 19/20 | Fast follow-up silence — a pinned `"✘ Auto-update failed… /doctor"` banner hid the input box, so turn-complete never latched | input-box / footer detection | banner added to `FOOTER_MARKERS`; direct last-12-row scan |
| 21 | Turn 2 re-sent turn 1's answer BYTE-IDENTICAL (2807 chars) | "which `●` block belongs to THIS turn" | per-turn baseline (`markTurnStart` / `currentTurnAnswer`) |
| 23/26 | Stale-answer recurrence + an 84s `"Composing…"` think → anti-hang fallback fired → EMPTY result → answer orphaned 30s later; and an inbound dropped at exactly the 60s `inputReadyTimeoutMs` on an idle-but-working session | distinguishing "working" from "wedged" / "stale" | activity-gated countdowns via `signature()` |

Every row is the same shape: **the engine's true state was knowable, but had to be inferred from glyphs, spinners, box-drawing, cursor-positioned repaints, and timers that exist for a human's eyes.** Each fix narrowed a heuristic; the next iteration found a render shape the heuristic didn't anticipate. This is the signature of an under-determined parsing problem, not a set of independent bugs.

### 2.3 Live telemetry corroboration (capture store + raw renders)

From `~/.claude/supervisor/capture/events.ndjson` (549 events) and `D:/tmp/supervisor-pty-raw.log` (224 KB of ANSI renders):

- **Stale double-send, confirmed in production data:** seq 12 (`2026-06-16T11:12:59Z`, sentIds `["35"]`) and seq 40 (`2026-06-16T11:34:26Z`, sentIds `["41"]`) carry **byte-identical 2807-char replies** to the same `replyToMessageId="31"`. This is the iter-21 bug, captured live — the scraper re-surfaced a stale scrollback block as a fresh answer.
- **TUI-wedge inbound loss, confirmed:** seq 25 (`2026-06-17T09:50:11Z`): `"turn not delivered: the session input box never became ready (TUI wedged)"` with a matching `subtype:"error"` lifecycle event. A user turn lost because the render-parse never saw a ready input box.
- **The 90s-think condition, confirmed:** the raw render shows `"Composing… (1m 30s)"` / `"(1m 31s)"` spinners — exactly the long-think window behind the iter-26 empty-result orphan.
- **Event ratio shows the scraping burden:** 371 `stream.assistant` events produced only 31 `channel.outbound` and 25 `stream.result`. The driver re-reads and re-classifies the grid continuously, and the turn-complete/answer-selection decision sits on top of a noisy, racy stream of intermediate repaints.

### 2.4 Why this is intrinsic, not a maturity problem

The PTY child's render is an **alternate-screen, cursor-addressed, in-place-repainted** human UI. The driver must reconstruct, from that:
1. **Turn boundaries** — there is no end-of-turn token; completion is inferred from "spinner gone + input box present + answer settled + no prompt," each of which has multiple visual forms (`Crunched/Baked/Cooked/Brewed/Churned/Cooked for Ns`, bare gerunds, banners, flashes).
2. **Answer identity** — "the last `●` block in the scrollback" has no notion of *which turn it belongs to* (the stale-double root cause).
3. **Permission prompts** — the interactive TUI **blocks and does NOT write the `tool_use` to any structured source until granted** (proven in the probe, design doc §(d) REFINEMENT). So even the transcript JSONL cannot help; detection is render-only.

The design doc is candid that the parser is "≈5–8 regexes… version-guarded" and that the SDK driver is retained "as the instant fallback if a Claude Code update breaks the parse" (`m12-pty-driver-design-2026-06-15.md` §3, PART 4 Option 3c). That fallback clause is an admission that the content path is coupled to a UI that changes between Claude Code versions. (This very session's renders already show Claude Code v2.1.177–2.1.179 chrome variations.)

**Conclusion:** the thesis holds. The overwhelming majority of the post-pivot bug stream (≥9 of the ~26 debug iterations, and all three live-telemetry failures) is directly attributable to recovering machine state from a human render. The remaining iterations are the containment-seal work (a different problem, see §6) and harness hygiene.

---

## 3. The pivotal empirical question — structured machine-readable I/O from a SUBSCRIPTION-billed session?

This decides the recommendation. It was tested four ways: the machine's auth model, a live `claude -p` probe, a live multi-turn probe, and doc-cited billing facts. **The answer is YES, available today.**

### 3.1 Billing is determined by AUTH MODE, not interactive-vs-headless — and this machine is on subscription

- `~/.claude.json` → `oauthAccount`: `billingType: "stripe_subscription"`, `organizationType: "claude_max"`, `organizationRateLimitTier: "default_claude_max_20x"`, `subscriptionCreatedAt: 2024-05-09`. **No `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` set** in the environment.
- Empirical probe — `echo "…" | claude -p --output-format stream-json --verbose --model haiku` in a scratch dir → the `system/init` event reports **`apiKeySource: "none"`**. The CLI used **no API key**; it authenticated via the subscription OAuth login. This is the authoritative, machine-checkable billing signal: headless `-p` ran on the **subscription**.
- claude-code-guide (doc-cited, `code.claude.com/docs/en/costs.md` + `support.claude.com`): billing follows the auth method; subscription OAuth (no API key) bills the plan for **both** interactive and headless `-p`.

> Nuance honestly flagged: the `result` event still reports a notional `total_cost_usd` (e.g. `0.0219` for the probe). That is the *equivalent* USD value the CLI always prints; it is NOT an API charge when `apiKeySource: "none"`. The disambiguator is `apiKeySource`, not the presence of a cost number.

### 3.2 `claude -p --output-format stream-json` IS the structured machine-readable interface

Live probe output (scratch dir, subscription):

- **Event schema (NDJSON, one JSON object per line):** `system/init`, `assistant`, `user` (tool results), `result/success`, plus `system/thinking_tokens`, `rate_limit_event`, `system/task_started`, `system/task_notification`.
- **`system/init` carries the full composition proof, structured:** `session_id`, `model`, `tools`, `mcp_servers`, `slash_commands`, `agents`, `skills`, `plugins`, `permissionMode`, `memory_paths`, `apiKeySource`, `cwd`. (This is the same data the supervisor's `system_init` SessionEvent already models — and the same the PTY driver tries to scrape from a boot banner.)
- **Clean final answer:** `result.result` = the answer text verbatim; `result.subtype = "success"`, `result.is_error`, `result.num_turns`, `result.session_id`, `result.usage`, `result.permission_denials`.
- **Discrete tool visibility (probe 4, a tool-using run):** `assistant` events carry `tool_use {name, input}`; `user` events carry `tool_result {content}` — `tool_use=1 ↔ tool_result=1`, the **exact shape `SdkSessionDriver.mapMessage` already parses.** No glyph reconstruction.

There is no turn-boundary heuristic, no answer-identity ambiguity, no spinner classification, no input-box detection. Turn-complete = the `result` object. Answer = `result.result`. Done.

### 3.3 Multi-turn in a SINGLE long-lived process works (refutes the "one-shot" claim)

Live probe — two user turns fed as stream-json on stdin to ONE `claude -p --input-format stream-json --output-format stream-json` process:
- turn 1 ("remember 42") → assistant `"I'll save that for you."`
- turn 2 ("what number?") → assistant `"42"` → `result/success result="42" num_turns=2`.

**The single process retained conversational memory across turns and answered both.** So a long-running orchestrator can be one persistent process fed turn-by-turn over stdin — the exact shape R1/R2/R6 need. (`--input-format stream-json`'s envelope schema is officially under-documented — GitHub issue open — but it empirically accepts the standard Anthropic `{type:"user",message:{role,content:[…]}}` envelope, which is also what `SdkSessionDriver.makeUserTurn` already builds.)

### 3.4 The Agent SDK ALSO runs on subscription (the premise that drove the PTY pivot is void)

The original pivot rationale (log lines 31–33, `m12-orchestrator-wiring-design-2026-06-15.md`) assumed the SDK forces API billing via an `ANTHROPIC_API_KEY`. **That assumption was never tested and is now contradicted by an official source.**

- claude-code-guide (doc-cited, `support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan`): *"The Claude Agent SDK works with your Claude subscription account (not API keys). You authenticate using your Claude subscription credentials rather than Claude Platform API keys."*
- Corroborated by the code: `adapters/sdk-session-driver.ts` passes `env` only if `opts.env` is provided (line ~204); it does **not** inject an API key. With no API key in the environment, `query()` would inherit the same OAuth credentials the CLI uses. (The dev agent's own throwaway SDK probe earlier in the session ran and returned `cost 0.41` — that was almost certainly subscription-billed too, but the agent recorded it as "real cost" without checking `apiKeySource`.)

### 3.5 The June-2026 billing split — PAUSED, not in effect (with an honest caveat)

- claude-code-guide (doc-cited): *"As of June 15, the previously announced changes to Claude Agent SDK billing have been paused. Currently, Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits."* The change that would have moved Agent SDK + `claude -p` to a separate metered credit pool **did not take effect** (confirmed by The New Stack + Anthropic support).
- **Honest caveat:** it is *paused, not cancelled* — Anthropic is "reworking the proposal" and may reintroduce a metered split with notice. This argues for a design that is **billing-mode-agnostic** (works on subscription today, survives a future split by flipping auth, with zero rewrite). Both structured options below satisfy that; the PTY scraper does too — but at a fragility cost the structured options do not pay.

### 3.6 Transcript-JSONL output (the agent's Step-11 middle path) — correctly ruled OUT

The dev agent's own probes (design doc §(e)/(f), 4 runs + a `--print` control) proved **a node-pty-spawned INTERACTIVE `claude` writes NO session JSONL** — not live, not on clean `/exit`, not with `--session-id`. Journaling is a `--print`/SDK/harness concept (`--no-session-persistence` is documented "only works with `--print`"). This is a genuine dead end for the interactive-PTY path and is not worth re-opening. **But note the framing it implies:** the clean structured journal exists exactly in the `--print` world — i.e. it is one more reason the structured `-p`/SDK path is the right home, not a reason to keep scraping.

---

## 4. Options matrix

Five options, scored against the requirements. "Subscription?" answers R5; the rest map to R1–R7 and rewrite cost.

| Option | Robustness (R2/R3) | Billing (R5) | Multi-turn (R6) | Permission handling (R4) | Rewrite cost | What's salvageable |
|---|---|---|---|---|---|---|
| **A. SDK `query()`** (current `SdkSessionDriver`, behind the seam) | **High** — structured stream events; turn-complete = `result`; answer = content blocks; no heuristics | **Subscription** (OAuth, no API key) — per §3.4; survives a split by setting a key | **Yes** — async-iterable input queue already built (`TurnQueue`, `makeUserTurn`) | **Best** — `canUseTool` async callback = the cleanest programmatic allow/deny; safety-floor predicate already wired | **~Zero** — already BUILT, 4 unit tests + lifecycle/router coverage, LIVE-validated this session (139/139 era) | Everything above the seam + the SDK driver itself + the in-process `mcp__supervisor_channel__reply` tool (works in-process) |
| **B. Headless `claude -p --output-format stream-json --input-format stream-json`** (new driver behind the seam) | **High** — NDJSON; turn-complete = `result` object; answer = `result.result`; discrete `tool_use`/`tool_result` (probes §3.2/3.3) | **Subscription** — empirically `apiKeySource:"none"` (§3.1) | **Yes** — one persistent process, turns over stdin (proven §3.3) | **Adequate** — `--permission-prompt-tool <mcp tool>` is the documented programmatic hook; needs a small stdio MCP shim (the in-process channel tool can't be passed to a child process) | **Low–Medium** — one new `adapters/cli-stream-driver.ts` mapping NDJSON→SessionEvent (≈ the SDK mapper); reuse the seam | Everything above the seam; `mapMessage`-style parsing is near-identical to the SDK driver's |
| **C. PTY + transcript-JSONL output** (keep PTY for input, read structured output from the session journal) | n/a | Subscription | n/a | n/a | n/a — **NOT VIABLE**: interactive PTY writes no transcript (§3.6, proven) | — |
| **D. PTY + grid-scrape** (CURRENT, `--driver pty`) | **Low** — 9+ recurring turn-boundary/answer/prompt defects; stale-double + TUI-wedge in live telemetry (§2) | **Subscription** (interactive CLI) | Yes (turn queue built) | Fragile — render-detect the prompt + inject `1\r`/Esc; gate state-dependent ($()); auto-allow catch-22 | n/a (built) — but **ongoing maintenance cost**, coupled to TUI version | Above-the-seam infra is fine; the PTY driver + grid (`pty-session-driver.ts`, `pty-grid.ts`, `pty-render-parser.ts`, ~47 tests of pure render heuristics) is the liability |
| **E. Other** (MCP loopback / remote-control / custom IPC) | varies | — | — | — | High / speculative | — |

Notes on the matrix:
- **A vs B is a near-tie on capability**, because *both* are now subscription-capable and structured. They differ on permission ergonomics and operational shape (in-process SDK vs child process + stdio permission shim).
- **A is strictly cheaper than B** here because A is **already written, tested, and was live-validated this session** before the (now-void) billing premise caused the pivot away from it. B is a fresh (if small) driver.
- **D's only advantage over A/B was "subscription billing"** — which A and B both now provide. With that advantage gone, D is dominated: it is less robust, equally subscription-billed, and carries perpetual TUI-coupling maintenance.

---

## 5. Recommendation

### 5.1 Primary: adopt the **SDK `query()` driver (Option A)** as the default; retire the PTY+grid driver to an experimental flag

**Reasoning:**
1. **It removes the entire root cause.** Turn boundaries, answer text, and tool/permission events become structured events instead of scraped glyphs. Every bug class in §2 ceases to exist by construction — not by a better heuristic, but by deleting the heuristic.
2. **It satisfies the subscription constraint** (§3.4) — the sole reason A was abandoned. The abandonment rested on an untested assumption that is now contradicted by Anthropic's own support article and by the code (no API key is injected).
3. **It is the lowest-cost path.** A is already built (`adapters/sdk-session-driver.ts`), unit-tested, lifecycle/router-covered, and was live-validated on the test bot earlier this session. The work is *configuration and re-validation*, not construction.
4. **It restores the clean channel design.** The in-process `mcp__supervisor_channel__reply` tool (`channel-tool.ts`, a `createSdkMcpServer` instance) works with the SDK driver — the orchestrator gets a real reply tool matching the skill's "all output via the channel" contract. The PTY path could not receive an in-process tool (separate process), which is *why* it was forced into "reach the user via assistant text only," which is *what* spawned the whole turn-complete/answer-extraction problem. A structured driver makes the channel a tool call, not a scrape.

### 5.2 Hedge against the paused-billing-split: keep **Option B (`claude -p` stream-json)** as a second structured driver behind the same seam

Because the June-15 split is *paused, not cancelled* (§3.5), and because the SDK-on-subscription mechanism is officially confirmed but lightly documented, it is prudent to also implement the **`claude -p --output-format stream-json` driver (B)**. It is a small new adapter (NDJSON→SessionEvent, ≈ the existing SDK mapper) and gives a second, independently-billed-the-same structured path. If Anthropic ever meters the SDK differently from the CLI, flipping `--driver sdk` ↔ `--driver cli-stream` is a one-line change at the single construction site (`index.ts`). This is cheap insurance that the architecture is **billing-mode-agnostic AND mechanism-agnostic**, both behind the proven seam.

> If only one is built now: build **A** (already done; just re-default and re-validate). Add **B** when there's appetite for the hedge.

### 5.3 What is REUSABLE from the 191-test codebase (most of it)

The `SessionDriver` seam is the design's saving grace — it cleanly separates *what the supervisor does* from *how it talks to Claude*. The I/O DRIVER is what is in question; **everything above the seam is reusable as-is.**

| Component | File | Reuse |
|---|---|---|
| The seam itself | `session-driver.ts` | **Keep** — the contract both structured drivers already satisfy |
| Lifecycle (FI restart/resume, watchdog, per-turn de-dup, heartbeat, clearContext) | `lifecycle.ts` | **Keep** — driver-agnostic; consumes `SessionEvent`s |
| Session host (operator binding, inbound routing, role prefix, send-side idempotency) | `session-host.ts` | **Keep** |
| Permission router + safety floor | `permission-router.ts` | **Keep** — `canUseTool` (A) or `--permission-prompt-tool` (B) feeds the SAME router |
| Channel permission round-trip (FC-1) | `channel-permission.ts` | **Keep** |
| In-process channel reply tool | `channel-tool.ts` | **Keep** — works with A (and gives the orchestrator its reply tool back) |
| Profiles (demo/orchestrator, destructive predicates) | `profiles.ts` | **Keep** |
| Bus / capture / delivery-queue / panel | `io-bus.ts`, `capture-store.ts`, `delivery-queue.ts`, `panel.ts` | **Keep** — FC-3 observability is independent of the driver |
| Telegram + transport adapters, access gate | `adapters/telegram*.ts`, `access-gate.ts`, `transport-policy.ts` | **Keep** |
| Composition root + flags | `index.ts` | **Keep** — flip the default `--driver`, retire `pty` to experimental |
| **SDK driver** | `adapters/sdk-session-driver.ts` | **Promote to default** |
| **PTY driver + grid + render parser** | `adapters/pty-session-driver.ts`, `pty-grid.ts`, `pty-render-parser.ts` | **Retire** behind `--driver pty` (experimental); freeze. ~47 render-heuristic tests retire with it. |

Of 191 tests, roughly **47 are pure PTY render-heuristic tests** (`pty-session-driver.test.ts` 33, `pty-grid.test.ts` 14). Those exist *only* to defend the scraper; they retire with the PTY driver. The remaining ~144 tests cover the reusable, driver-agnostic core and stay green. **No rewrite of the supervisor's logic is needed — only a driver swap at the seam.**

### 5.4 Migration sketch (low blast radius)

1. **Re-default the driver.** In `index.ts`, the single construction site, set `--driver sdk` (or a new `--driver cli-stream`) as default; keep `--driver pty` selectable but mark experimental. (Confirmed: there is exactly ONE construction site — the seam's payoff.)
2. **Confirm SDK-on-subscription on this host.** Launch the SDK driver with `ANTHROPIC_API_KEY` unset and assert `apiKeySource:"none"` (or its SDK equivalent) appears in `system_init`; this is the go/no-go for R5. (The CLI probe already proved the auth model; this confirms the SDK respects it.)
3. **Re-validate the orchestrator profile end-to-end** on the test bot via the SDK driver: composition proof (`system_init` carries `hasOrchestrator`, MCP-minus-telegram), a multi-turn dialog with DIFFERENT back-to-back questions (the stale-double failing case — which cannot occur structurally), a permission round-trip via `canUseTool`→router→channel (allow + deny), and the containment seal.
4. **(Optional, the hedge) Add `adapters/cli-stream-driver.ts`** — spawn one persistent `claude -p --output-format stream-json --input-format stream-json` process; map NDJSON `system/init`/`assistant`/`user`(tool_result)/`result` → the existing `SessionEvent` shapes (≈ copy `mapMessage`); feed turns over stdin as the standard user envelope; permission via a tiny stdio `--permission-prompt-tool` MCP shim that calls the existing `PermissionRouter`. Test with a `FakeChildProcess` feeding captured NDJSON frames (the structured analog of the FakePty — and far simpler, since NDJSON has no chrome).
5. **Keep containment regardless of driver** — see §6; it is orthogonal and must be carried into whichever driver is default.
6. **Decommission cleanly:** once A (and/or B) passes live acceptance, freeze the PTY driver + grid + their fixtures behind the experimental flag (or remove). Drop `node-pty` and `@xterm/headless` from `dependencies` if the PTY driver is removed (they exist solely for scraping).

---

## 6. Honest counter-case (and what survives the driver swap)

A rigorous review must argue the other side. Here it is, and where it nets out.

**Counter-argument 1 — "The PTY scraper is now mostly debugged; switching throws away 191 tests and re-litigates a working system."**
Rebuttal: the ~144 driver-agnostic tests are *kept* (they test the reusable core, not the scraper). Only the ~47 render-heuristic tests retire — and those defend a mechanism we are deleting, so their loss is the point, not a cost. More importantly, the scraper is **not** debugged in the sense that matters: iter 26 (the latest before the user called this review) found *two new* failures under real Opus timing that fast-haiku tests never exercised, and the fix's own meta-lesson is "the earlier PASS was on insufficient turns." The defect rate is not converging to zero; it is converging to "whatever render shape we haven't seen yet." That is unbounded by construction.

**Counter-argument 2 — "Subscription billing is the hard constraint and only the interactive TUI is *certainly* subscription-billed; the SDK-on-subscription path is lightly documented."**
Rebuttal: this is the strongest objection, and it is why §5.2 recommends *also* keeping the `claude -p` stream-json driver (B), whose subscription billing is **empirically proven on this machine** (`apiKeySource:"none"`), not merely documented. B is structured AND certainly-subscription — it dominates the PTY path on both axes. So even granting maximal skepticism about the SDK, the conclusion (replace the scraper with a structured driver) is unchanged; only the *choice between A and B* is affected. The PTY scraper is not rescued by this objection.

**Counter-argument 3 — "The paused billing split could return and meter `-p`/SDK, forcing us back to the interactive TUI anyway."**
Rebuttal: if that happens, the interactive TUI is reachable *with structured output* via a different route only if Anthropic provides one; absent that, the fallback would indeed be PTY. But (a) the change is paused with promised advance notice; (b) the seam means we can keep the frozen PTY driver as a break-glass option for exactly that scenario at zero ongoing cost; (c) designing the *primary* path today around a *paused, un-scheduled* future billing change — at the price of the bug stream the user is reacting to — optimizes for the wrong risk. Keep PTY frozen behind the flag as insurance; do not run on it.

**Where the counter-case correctly limits the recommendation:** the driver swap does **NOT** by itself solve two problems that live *above* the driver and must be carried forward:
- **Containment (R7)** — the production-telegram breach (iters 15–17) was an MCP-config/plugin *inheritance* problem. The SDK driver actually handles this *better* (it filters `mcpServers` via `query()` options and never inherits the full `~/.claude.json` the way a spawned child does), but the disallowed-tools + plugin-disable + outward-send exclusion policy in `profiles.ts`/`mcp-config.ts` must remain wired. This is a point in favor of A.
- **Worktree isolation (#2)** and the **heartbeat (#8)** are driver-agnostic UX/safety features in the reusable layer; they survive unchanged.

**Net:** the counter-case strengthens the *hedge* (build B too, keep PTY frozen) but does not overturn the core recommendation. The user's "overcomplicated" instinct is correct and is now backed by evidence: the system is complex *specifically and only* in the layer that scrapes a human UI, and that complexity is unnecessary because a structured, subscription-billed interface exists.

---

## 7. Health summary

| Aspect | Rating | Notes |
|---|---|---|
| Documentation (design docs + session log) | **Good** | Unusually candid; the probes and the 3a/3b/3c fork are well-recorded. The one gap: the SDK-billing premise was never tested before the pivot. |
| Architecture — above the seam | **Good** | Clean `SessionDriver` seam; driver-agnostic lifecycle/router/host/bus/panel. This is what makes the fix cheap. |
| Architecture — the I/O driver (PTY+grid) | **Poor** | Screen-scrapes a human UI for machine state; unbounded edge-case surface; TUI-version-coupled (the design doc concedes this). |
| Code quality | **Good** | Well-tested, well-factored; the fragility is intrinsic to the approach, not the implementation. |
| Test coverage | **Fair→Good** | 191 tests, but ~47 are defending the scraper (deterministic FakePty fixtures cannot reproduce real Opus render timing — proven twice). The structured path needs far fewer, simpler tests. |
| Fit to requirement | **Poor (current) → Good (recommended)** | R1–R7 are all met *more simply* by a structured driver; the current path meets them only with a growing heuristic stack. |

## 8. Findings (severity-ranked)

| # | Finding | Severity | Action |
|---|---|---|---|
| 1 | The I/O driver recovers machine state by scraping a human TUI render → unbounded recurring turn-boundary/answer/prompt defects (≥9 debug iters; stale-double + TUI-wedge in live telemetry) | **Critical** | Replace with a structured driver (A; optionally B) |
| 2 | The subscription-billing premise that forced the PTY pivot is void — both `claude -p` stream-json (proven `apiKeySource:"none"`) and the Agent SDK (official support article) run on subscription today | **Critical** | Re-default to the SDK driver (already built/tested/live-validated) |
| 3 | Deterministic tests (FakePty) cannot reproduce real Opus render timing → two "PASS"es were on insufficient turns (iters 19/26) | **Major** | A structured driver makes turn-complete a `result` object — no timing heuristic to test |
| 4 | The in-process channel reply tool is unreachable from the PTY child → orchestrator forced to "assistant-text only," the seed of the answer-extraction problem | **Major** | The SDK driver restores the in-process reply tool |
| 5 | Containment (telegram/whatsapp/email) was a separate MCP-inheritance breach; must be carried into the chosen driver | **Major** | Keep `profiles`/`mcp-config` seal; the SDK driver handles MCP filtering natively |
| 6 | Paused (not cancelled) June-15 billing split is a standing risk to R5 | **Minor** | Billing-mode-agnostic design (A primary, B hedge, PTY frozen as break-glass) |

---

## 9. Documentation updates

This review proposes no source/doc edits (it is read-only per the brief). The actionable doc follow-ups, for when work resumes: update `m12-pty-driver-design-2026-06-15.md` PART 4 to record that the 3a/3b/3c fork's premise (SDK = API-billed) has been overturned (SDK + `claude -p` are subscription-capable as of 2026-06-17, split paused), and that the recommendation is now Option A (SDK) with an optional `claude -p` stream-json hedge — superseding the "3c if subscription wanted" conclusion. File that as a design-doc revision, not a new proposal (one-doc-per-topic).

---

## 10. Evidence index (for reproducibility)

- **Bug ledger:** `docs/development/logs/dev-m12p3a-2026-06-15-082752.md` — `[STEP-6-DEBUG iter=1..26]`; turn-complete recurrences at iters 6,7,8,14,18,19,20,21,26.
- **Design + transcript/persistence probes:** `docs/development/m12-pty-driver-design-2026-06-15.md` §(d)/(e)/(f) (no-transcript proof), PART 4 (3a/3b/3c fork).
- **Original SDK premise:** `docs/development/m12-orchestrator-wiring-design-2026-06-15.md` §0/§4 (the `env`/API-key assumption).
- **Auth model:** `~/.claude.json` → `oauthAccount.billingType = "stripe_subscription"`, `organizationType="claude_max"`, no `ANTHROPIC_API_KEY`.
- **`claude -p` stream-json (subscription):** live probe → `system/init.apiKeySource="none"`; `result.result` = clean answer; discrete `tool_use`/`tool_result`.
- **Multi-turn one-process:** live probe → 2 turns, `num_turns=2`, memory retained.
- **Billing facts:** `support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan` (SDK on subscription; split paused as of 2026-06-15), corroborated by The New Stack.
- **Live failure telemetry:** `~/.claude/supervisor/capture/events.ndjson` (stale-double seq 12/40; TUI-wedge seq 25) + `D:/tmp/supervisor-pty-raw.log` (90s `Composing…`).
- **Code map:** `tools/supervisor/src/session-driver.ts` (seam) + the driver-agnostic core (`lifecycle`, `session-host`, `permission-router`, `channel-permission`, `profiles`, `channel-tool`, `io-bus`, `delivery-queue`, `panel`, `index`) vs the driver-specific PTY trio (`pty-session-driver`, `pty-grid`, `pty-render-parser`).
