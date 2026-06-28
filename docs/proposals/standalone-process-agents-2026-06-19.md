# Standalone Process-per-Agent vs In-Process Agent-Teams — Decision-Support Proposal

**Date:** 2026-06-19 · **Author:** `/analyse` (architecture proposal, max-rigor) · **Mode:** READ-ONLY research + this one doc.
**Status:** DECISION-SUPPORT (no code change proposed here; recommends a model + a cheap experiment to de-risk it).
**Scope:** the **sub-agent execution model** for the Pianoid Supervisor — should the orchestrator's `/dev`, `/analyse`, controller, etc. run as **in-process Claude Code agent-team members** (the Agent tool inside one `claude` child — **current**), or each in its **own OS-level `claude` process** coordinated by the supervisor (**proposed**)?

**Relationship to prior docs (one-doc-per-topic):**
- This is a **new sibling topic** — no prior `docs/proposals/` doc covers process-per-agent (verified: grep `standalone.process|process-per-agent` → none). **No archival was performed.**
- It sits **one layer above** `m12-host-supervisor-app-2026-06-14.md` (which packages the *host* that owns ONE orchestrator child) and **extends** `docs/development/reviews/m12-supervisor-architecture-review-2026-06-17.md` (which chose the structured `SessionDriver` seam, retired PTY, made SDK primary + `cli-stream` the hedge). That review decided **how the supervisor talks to the single orchestrator**; this doc decides **how the orchestrator's sub-agents run underneath it**. The two are orthogonal and composable.

> **How to read.** PART A = verified facts (current code + the billing/concurrency verification). PART B = the three axes (reliability, speed, cost). PART C = containment (mandatory for any spawned process). PART D = the recommendation + a hybrid. PART E = the de-risking experiment + open decisions. Every code claim carries a file:line; every external claim is VERIFIED-with-source or explicitly FLAGGED.

---

# PART A — GROUND TRUTH (verified against the running code, 2026-06-19)

## A.1 What "the current model" actually is

The live production path is **NOT** the SDK and **NOT** the PTY scraper — it is the **`cli-stream` driver**: one persistent headless `claude -p --output-format stream-json --input-format stream-json --verbose` child, owned by the supervisor.

| Fact | Evidence |
|---|---|
| The orchestrator profile **defaults to `cli-stream`** because it is "the ONLY backend that exposes agent-teams (SendMessage/Monitor/Task*), which the orchestrator skill REQUIRES" | `tools/supervisor/src/profiles.ts:170-174` + `:60-63` |
| Production launches with **no `--driver`** → the profile default (`cli-stream`), Opus 4.8[1m], on the subscription | `tools/supervisor/launch-prod-orch.mjs:99-104` |
| The orchestrator skill is **hard-bound to team coordination** — 127 references to SendMessage/Monitor/Task*/sub-agent/spawn | `.claude/commands/orchestrator.md` (grep count) |
| Sub-agents run **in-process inside that one child**: when the orchestrator uses Agent/Task, the sub-agent's narration + tool results **ride the SAME stdout stream**, tagged with a non-null `parent_tool_use_id` | `tools/supervisor/src/adapters/cli-stream-driver.ts:108-120`; test `tools/supervisor/src/test/cli-stream-sidechain.test.ts` |
| Billing is **subscription**, enforced structurally: the env is kept key-free; `assertCostSafe` throws if `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` is present | `tools/supervisor/src/cost-safety.ts:35,83-87`; `launch-prod-orch.mjs:93-94` |

So today **N sub-agents = N logical agents inside 1 OS process / 1 session**, all sharing one stdout stream, one context budget, and one lifecycle.

## A.2 The capability that makes in-process teams work — and its costs, in the code

Two code facts are load-bearing for the whole comparison:

1. **Permission routing already spans sub-agents.** Under `cli-stream`, `--permission-prompt-tool stdio` surfaces every gated tool as a `control_request{can_use_tool, …, agent_id}`. Because the request **carries `agent_id`**, a *sub-agent's* gated tool routes through the **same** PermissionRouter to the user — the orchestrator's AND its sub-agents' prompts. `cli-stream-driver.ts:358-372,508-520`. This **closes the historic silent-sub-agent-permission-hang** (finding F3 in `archive/supervisor-orchestrator-io-boundary-2026-06-18.md`). *This is an advantage the current model already has and any alternative must match.*

2. **The shared stdout stream is also the source of a known failure mode — the channel flood.** Because sub-agent narration rides the orchestrator's own stream, every "thinking out loud" line was being forwarded to the user (~16 messages in one `/dev` run). The fix is a **filter** — drop any message with a non-null `parent_tool_use_id` (`cli-stream-driver.ts:120`). This is the in-process model's central tension: **isolation is achieved by filtering a shared stream, not by construction.** The orchestrator's own messages and the sub-agent's *final* report (which returns as the orchestrator's `tool_result`, parent = null) are kept; everything in between is suppressed but still consumes the **shared context window**.

## A.3 ★ VERIFIED — does N concurrent `claude` cost extra SEATS, or is it rate-limited?

This is the pivotal factual question for "process per agent." It was verified via WebSearch/WebFetch against Anthropic's own docs/terms on 2026-06-19. **Separating VERIFIED facts from ASSUMPTIONS:**

### VERIFIED (source + quote)
- **Concurrency on an individual plan (Pro / Max 5x / Max 20x) is RATE-LIMIT-gated, NOT seat-gated.** No Anthropic term, pricing page, or doc requires one seat per concurrent session, and **no clause prohibits one user running multiple simultaneous Claude Code sessions** on their own account. Consumer terms forbid only *credential sharing* ("You may not share your Account login information, Anthropic API key, or Account credentials with anyone else" — `anthropic.com/legal/terms`).
- **One shared usage pool across all surfaces.** "Note that your usage of all different Claude product surfaces (claude.ai, Claude Code, Claude Desktop) counts towards the same usage limit" (`support.claude.com/.../11647753`); "all activity in both tools counts against the same usage limits" (`support.claude.com/.../11145838`). → Running more concurrent sessions **drains the one budget faster**; it does not require more licenses.
- **Parallel agents are a first-class, documented feature with no extra purchase.** "There's no hard limit on the number of teammates, but practical constraints apply: token costs scale linearly, coordination overhead increases, diminishing returns" (`code.claude.com/docs/en/agent-teams`); recommended start 3-5 teammates.
- **The cost of parallelism is token consumption, not licensing.** "Agent teams use approximately 7x more tokens than standard sessions … because each teammate maintains its own context window and runs as a separate Claude instance" (`code.claude.com/docs/en/costs`). *(Note: this confirms even in-process teammates each carry their own context — see A.4.)*
- **Headless `claude -p` and the interactive TUI bill identically** under a subscription; billing follows the **auth mode** (OAuth/no-key = subscription), not the surface. Corroborated on **this machine**: the architecture review's live probe reported `apiKeySource:"none"` for `claude -p` (`m12-supervisor-architecture-review-2026-06-17.md` §3.1; `cost-safety.ts` header).
- **Team/Enterprise are seat-based**, but a seat grants *access + usage allowance*, not a "one session per seat" concurrency rule (`anthropic.com/news/claude-code-on-team-and-enterprise`).
- **5-hour rolling-window limits were doubled 2026-05-06** for Pro/Max/Team/seat-Enterprise (`anthropic.com/news/higher-limits-spacex`); Max plans also carry **weekly caps** (all-models + Sonnet-only) (`support.claude.com/.../11049741`). Anthropic publishes **relative multipliers (1x/5x/20x), not absolute token numbers**.

### ASSUMPTIONS / UNVERIFIED (stated plainly)
- "Parallel sessions drain the shared pool proportionally faster" is a **logical inference** from the single-pool statement; Anthropic never states "3 sessions = 3x drain" verbatim.
- **No documented hard *concurrent-process* ceiling** (distinct from TPM/RPM/window caps) was found for subscription users. Community claims of "~5-7 concurrent before queuing" are **anecdotal**, not official.
- Exact shape of throttling at high concurrency (pure token-bucket vs. a connection cap) is **undocumented**.

### WHAT WOULD NEED CONFIRMING to be 100% sure
1. An **empirical concurrency test** on *this* Max-20x account: spawn N `claude -p` processes simultaneously and observe where 429/queueing begins (token-window vs. connection cap).
2. A **support confirmation** that N concurrent `claude -p` under one subscription share one TPM budget (vs. per-process budgets).
3. Re-check `code.claude.com/docs/en/sub-agents` / `agent-teams` for any **maximum-parallel-agents** number at the time of building.

**CONFIDENCE: HIGH** that the seats-vs-rate-limit answer is **rate-limit**. The bottom line for this proposal: **process-per-agent has NO licensing cost** — its cost is **token/throughput** (shared pool drained faster, sooner-throttled) and **engineering** (coordination + containment per process), **not seats**.

## A.4 The token-economics correction this enables

A common argument *for* in-process teams is "one shared session = no duplicated system prompt/context." **The docs refute the strong form of that argument:** agent teams already cost **~7x tokens** *because each teammate maintains its own context window and runs as a separate Claude instance* (`code.claude.com/docs/en/costs`, verified A.3). So the per-agent context cost is **largely paid in both models** — the in-process model does not save N system-prompts the way the intuition suggests. The genuine shared-vs-duplicated delta is narrower than assumed (see B.3).

---

# PART B — THE THREE AXES

## B.1 Reliability

| Sub-aspect | In-process agent-teams (CURRENT) | Standalone process-per-agent (PROPOSED) | Edge to |
|---|---|---|---|
| **Failure isolation** | A crash/OOM/`isnan`-freeze in the one `claude` child takes **the orchestrator AND every sub-agent** with it. One bad sub-agent task can wedge the whole session. | Each agent is its **own process**; one crash is contained — the supervisor reaps it and the orchestrator + siblings continue. **This is the strongest single argument for the split.** | **Proposed** |
| **Context-bloat containment** | All sub-agent work accrues into **one shared context window**; long multi-agent sessions bloat → compaction → the very "context bloated/corrupt → restart" pressure that motivated the self-restart endpoint (`archive/hosted-agent-lifecycle-restart-2026-06-18.md`). Bloat is **structural**. | Each agent has a **fresh, bounded** context; it exits and frees it. The orchestrator's own context stays lean (it sees only spawn + final report). Bloat is contained **by construction**. | **Proposed** |
| **Restart / recovery semantics** | Already built and good *for the orchestrator*: `LifecycleManager` restart+`--resume` (`lifecycle.ts`), liveness ping/pong with idle-gating (`archive/supervisor-orchestrator-io-boundary-2026-06-18.md` §4.3b), agent-requested restart (`archive/hosted-agent-lifecycle-restart-2026-06-18.md`). But a sub-agent **cannot be restarted independently** — it has no process of its own. | The supervisor can restart/resume/kill **each agent independently**; a stuck `/dev` is killed without disturbing the orchestrator. Requires **building** per-agent lifecycle (the orchestrator-level machinery generalizes, but is real work). | Proposed (capability); **Current** (already-built) |
| **Silent-inbox / silent-permission failure** | **Already solved** on `cli-stream`: `control_request` carries `agent_id` → sub-agent prompts route to the user (A.2, F3 closed). The original silent-hang was a PTY-era artifact, now structurally gone. | Must be **re-built per process**: each `claude -p` child needs its OWN `--permission-prompt-tool stdio` wired to the supervisor's router (doable — it's the same mechanism the orchestrator child already uses, just multiplied). | **Current** (works today; the split must not regress it) |
| **Channel-flood blast radius** | A single shared stream → sub-agent narration leaks unless filtered (`parent_tool_use_id` guard, A.2). The guard works but is a **filter on a firehose**; a new message shape could re-leak. | Each agent's output goes to **its own** stdout the supervisor consumes privately; **nothing reaches the channel unless the supervisor forwards it.** Flood isolation is **by construction**, not by filter. | **Proposed** |

**Reliability verdict:** the proposed model is **structurally** stronger on the three things that actually hurt today — whole-session crash blast radius, context bloat, and flood — but the **current model already solves** the silent-permission/inbox class that historically caused the most pain, and the split must carry that forward, not regress it.

## B.2 Speed

| Sub-aspect | In-process (CURRENT) | Process-per-agent (PROPOSED) | Notes |
|---|---|---|---|
| **Agent spawn cost** | **Cheap** — Agent/Task spawns a logical teammate inside the live child; no new OS process, no cold start. | **Expensive per spawn** — a new `claude -p` is a **cold OS process**: Node/binary start, `system/init`, MCP server boot, settings/skills load. Seconds, not milliseconds. For short tasks this overhead dominates. | **Current** wins on spawn latency |
| **Parallelism ceiling** | Bounded by the in-session team mechanics + the **one shared context/token budget**; the 7x-token reality (A.4) makes deep fan-out expensive in one session. | Bounded by the **shared account rate-limit** (A.3), CPU/RAM for N `claude` + their Bash/MCP subtrees, and the build-tool contention below — **not** by a session ceiling. Can in principle run wider, until throttled. | Tie — different ceilings; **the binding limit for both is the shared subscription rate-limit** |
| **Coordination latency** | **In-process** SendMessage/Monitor — near-zero IPC; the team mechanics are in-memory in the child. | **Supervisor-mediated IPC** — each turn crosses stdin/stdout NDJSON + supervisor scheduling. Higher per-message latency; the supervisor becomes a message broker for N children. | **Current** wins on coordination latency |
| **Build/test throughput** | Sub-agents share **one git working tree** → the documented **concurrent-/dev-worktree collision** (memory: `feedback_concurrent_dev_worktree` — two `/dev` agents collide even on disjoint files); CUDA rebuilds also contend on the **build holders** (`PROJECT_CONFIG.md#build-holders`). Today this is serialized by the orchestrator. | Process isolation pairs naturally with **git-worktree-per-agent** (the supervisor already does worktree isolation for the orchestrator — `launch-pty-orch.mjs:47-77`). True parallel `/dev` becomes safe. **But** parallel CUDA builds still contend on the single GPU/build holder — throughput-gated by hardware, not the model. | **Proposed** for FS parallelism; hardware-gated for builds |

**Speed verdict:** **in-process is faster for many short, chatty, tightly-coordinated sub-tasks** (cheap spawn, zero-IPC coordination). **Process-per-agent is faster for a few long, independent, file-heavy tasks** (real FS isolation, crash containment) — but pays a cold-start tax per spawn and a coordination-latency tax, and **neither escapes the shared subscription rate-limit** as the true parallelism ceiling.

## B.3 Cost (token economics)

- **No seat cost either way** (A.3, HIGH confidence). The whole comparison is **token throughput + engineering**, not licensing.
- **The "shared session saves duplicated context" argument is weak** (A.4): teammates already each carry their own context window and bill ~7x; a separate process adds mainly the **fixed per-process overhead** — its own `system/init`, the **system-prompt append** (the orchestrator preamble is ~12KB; `cli-stream-driver.ts:406-416`), and re-loading project skills/CLAUDE.md per process. That is a **real but bounded** duplication (system prompt + bootstrap per process), **not** an N-fold blow-up of the *work* tokens.
- **Where in-process is genuinely cheaper:** very short sub-tasks where the per-process bootstrap would dominate the actual work — there, paying the bootstrap N times is pure waste.
- **Where process-per-agent is genuinely cheaper:** long sessions where in-process **context bloat** forces compaction/restart (re-sending a fat history repeatedly). A bounded fresh per-agent context avoids re-billing an ever-growing shared transcript. The crossover is **task length/chattiness**: short+chatty → in-process; long+independent → separate process.
- **Throughput risk (shared pool):** more concurrent agents drain the 5-hour window + weekly cap **faster** and risk 429/throttle sooner (A.3). Process-per-agent makes it **easier to accidentally fan out** into a rate-limit wall. A concurrency cap in the supervisor is a needed guardrail (E.1).

**Cost verdict:** roughly a **wash on principle**, with opposite tails: in-process cheaper for short/chatty fan-out, process-per-agent cheaper for long/independent work by avoiding shared-context bloat. The dominant *risk* is throughput (shared rate-limit), which the supervisor must cap regardless of model.

---

# PART C — CONTAINMENT (mandatory for EVERY spawned process)

The token-hijack lesson is **non-negotiable** and **scales with process count**: a hosted `claude -p` launched with `--setting-sources user` **loads the user's `enabledPlugins`** → the prod Telegram plugin server **seizes the single `getUpdates` poller and SIGTERM-kills the real orchestrator** (the recurring "messages don't reach me" bug). The current fix:

- `--setting-sources project,local` (**drop `user`**) so the plugin never loads — `profiles.ts:157-169`;
- `--disallowed-tools` deny-list for telegram/whatsapp/outward-send — `profiles.ts:234-242`;
- delete `TELEGRAM_BOT_TOKEN` from the child env (defense in depth) — `launch-prod-orch.mjs:77`;
- the `~/.claude/CLAUDE.md` methodology folded into the system-prompt append to compensate for dropping `user` — `profiles.ts:166-168`.

**Implication for process-per-agent: this seal must be applied to EVERY spawned `claude` process, identically — not just the orchestrator.** N processes = N chances to breach containment; one mis-launched child with `user` sources re-seizes the token and kills the live channel. This is the **single biggest engineering risk** of the split:

1. **One choke-point launcher.** No agent may `spawn('claude', …)` ad hoc. Every agent process MUST go through ONE supervisor primitive that *always* sets `--setting-sources project,local`, the deny-list, and the key-free env (reuse `buildCliArgs` + `assertCostSafe`). Make the unsealed path **unrepresentable**.
2. **Single-poller invariant holds harder.** Exactly one `getUpdates` poller exists — the **supervisor's adapter**. Spawned agents must be **channel-mute by construction**: no telegram/whatsapp/email tools, no token in env. The existing `8790` single-instance guard (`launch-prod-orch.mjs:46-57`) and the "supervisor self-sends only in tier-b" rule (`archive/supervisor-orchestrator-io-boundary-2026-06-18.md` §4.3) must extend to "**only the supervisor ever touches the channel; agents reach the user only via the supervisor**."
3. **The SDK driver is *intrinsically* safer here.** The review notes the SDK `query()` **filters `mcpServers` via options and never inherits the full `~/.claude.json`** the way a spawned child does (`m12-supervisor-architecture-review-2026-06-17.md` §6, finding 5). A process-per-agent design built on **spawned CLIs** must re-prove containment per process; one built on **SDK sub-queries** inherits less by default. (But the SDK lacks team tools — see D.)
4. **Worktree isolation per agent** (already a pattern — `launch-pty-orch.mjs`) prevents N agents corrupting the shared tree and pairs naturally with process isolation.

---

# PART D — RECOMMENDATION

## D.1 The honest framing: it is not strictly either/or

The supervisor's `SessionDriver` seam already cleanly hosts **one** orchestrator child. "Process per agent" = generalizing that ownership from 1 child to N. The two models can **coexist**, and the right answer is **selective**, driven by the SDK-vs-CLI team-tool gap that the project has already measured:

- **Agent teams (SendMessage/Monitor/Task*) exist in `claude -p` (CLI) but NOT in the SDK `query()` API** (measured: `reference_sdk_no_agent_teams`; encoded at `profiles.ts:60-63,170-174`). The orchestrator **hard-requires** teams (A.1).
- Therefore the **orchestrator itself cannot move to the SDK** without losing teams — it must stay a `cli-stream` child (or keep in-process teams). This **constrains** the design: you cannot naively "make every agent an SDK sub-query."

## D.2 Recommended model: **keep ONE `cli-stream` orchestrator with in-process teams as the default; add supervisor-owned standalone processes for the heavy, isolation-critical, long-running roles** (a hybrid)

**Rationale — match each role to the model that fits its task shape (B.2/B.3 crossover):**

| Role | Task shape | Recommended model | Why |
|---|---|---|---|
| **Orchestrator** | Long-lived, chatty, coordinates everything, **needs team tools** | **In-process is forced** → stays a single `cli-stream` child (current) | SDK lacks teams (D.1); cheap coordination; it is the I/O hub |
| **Short/chatty sub-agents** (`/fn`, quick `/analyse`, controller pings) | Seconds, tightly coupled, low blast radius | **In-process teammate** (current) | Cheap spawn, zero-IPC coordination; cold-start would dominate |
| **Heavy `/dev`, CUDA builds, long `/analyse`, anything that can OOM/freeze or runs minutes** | Long, independent, file-heavy, real crash risk | **Standalone supervisor-owned `claude -p` process**, worktree-isolated, sealed | Crash containment, context-bloat containment, FS-parallelism, flood isolation — exactly where in-process hurts |

This is **"isolate the dangerous, keep the cheap in-process."** It captures the proposed model's reliability wins **where they pay** (the long/heavy/crashy tasks) without paying the cold-start + coordination-latency tax on the chatty majority, and **without** moving the orchestrator off the only backend that has teams.

## D.3 If forced to choose ONE pure model

- **For the project's current reality (small team, single GPU, subscription, orchestrator needs teams): keep IN-PROCESS as the default.** It already works in production, already solves the silent-permission class (A.2), and the reliability gaps (crash blast radius, bloat) are **partially mitigated** by the *existing* lifecycle/restart machinery. A full pure process-per-agent rebuild is **significant engineering** (per-agent lifecycle, per-agent permission wiring, N-way containment, a supervisor scheduler/broker) whose biggest win — crash isolation — is also obtainable more cheaply via the hybrid (D.2) for just the risky roles.
- **Pure process-per-agent becomes the right default IF** any of these change: (a) sub-agent crashes/freezes start taking down the orchestrator regularly in practice; (b) you need **true parallel multi-`/dev`** as a routine workflow; (c) you outgrow one machine and distribute agents across hosts; (d) Anthropic reintroduces a billing split (A.3 caveat) that meters per-process differently and you want per-process cost attribution. Then the per-process overhead is worth it.

---

# PART E — DE-RISKING + OPEN DECISIONS

## E.1 The cheap experiment that should precede any build (HIGH value, LOW cost)

Before committing to process-per-agent, run the **empirical concurrency test** (A.3, #1) — it is the one unverified fact that most affects the design:

1. On this Max-20x account, spawn **2, 4, 8** concurrent `claude -p --output-format stream-json` probes (each a trivial one-turn task) and record: time-to-`system/init`, where 429/`rate_limit_event` first appears, and whether failures look like a **token-window** exhaustion vs. a **connection cap**. (The `cli-stream-driver` already parses `rate_limit_event` — `cli-stream-driver.ts:180`.)
2. Outcome → sets the supervisor's **max-concurrent-agents** guardrail and tells you whether wide fan-out is even reachable before throttling. **This single test converts the A.3 ASSUMPTIONS into facts** and right-sizes the whole effort.

*(This is a read-only-ish probe — it spends a little subscription budget but touches no production channel and edits nothing. It is exactly the kind of thing a future `/dev` should do; it is NOT done in this proposal per the read-only constraint.)*

## E.2 If the hybrid (D.2) is approved — the build leverages what already exists

The `SessionDriver` seam + `LifecycleManager` + `PermissionRouter` + the sealed `buildCliArgs` are **directly reusable** to own N children instead of 1. The new work is bounded:
- a **multi-session manager** (registry of agent processes, each a `LifecycleManager`-like owner) — generalizes the existing single-child lifecycle;
- a **scheduler/concurrency cap** (E.1's number) so fan-out can't hit the rate-limit wall;
- **per-agent containment** via the existing seal applied at one choke-point (PART C #1);
- **result plumbing**: an agent's final report returns to the orchestrator (today it returns as the orchestrator's `tool_result`; for separate processes the supervisor must relay it back as a turn).

## E.3 Open decisions for the user

| # | Decision | Recommendation | Why open |
|---|---|---|---|
| **OD-1** | Pure model vs **hybrid** (D.2) vs keep current | **Hybrid** — isolate heavy/long/crashy roles as standalone processes; keep chatty ones in-process | Hybrid captures the reliability wins where they pay without the cold-start/coordination tax on the majority, and keeps the orchestrator on the only team-capable backend |
| **OD-2** | Run the **concurrency experiment (E.1)** before building? | **Yes** — it's cheap and resolves the one HIGH-impact unverified fact (seat-free is confirmed; the *throttle shape* is not) | Cost is a few cents of subscription budget; value is right-sizing the entire design |
| **OD-3** | If process-per-agent: **spawned CLI** vs **SDK sub-queries** for the *non-team* agents | **Spawned `claude -p`** for anything needing teams/skills parity; **SDK** is safer-by-default on containment (§C #3) for leaf tasks that don't need teams | The SDK lacks team tools but inherits less of `~/.claude.json`; a per-agent choice mirrors the existing per-profile `defaultDriver` |
| **OD-4** | Supervisor **max-concurrent-agents** cap | Set from E.1's measured throttle point (placeholder: start conservative, e.g. 2-3, until measured) | Undocumented official ceiling (A.3); a cap prevents a self-inflicted rate-limit DoS |

---

# Appendix — Evidence index

- **Current model is in-process teams via `cli-stream`:** `tools/supervisor/src/profiles.ts:60-63,170-174`; `tools/supervisor/launch-prod-orch.mjs:99-104`.
- **Sub-agents share the orchestrator's stdout (the flood + its filter):** `tools/supervisor/src/adapters/cli-stream-driver.ts:108-120`; `tools/supervisor/src/test/cli-stream-sidechain.test.ts`.
- **Sub-agent permission routing carries `agent_id` (F3 closed):** `cli-stream-driver.ts:358-372,508-520`; `archive/supervisor-orchestrator-io-boundary-2026-06-18.md` §0,§3.
- **Subscription cost guard:** `tools/supervisor/src/cost-safety.ts:35,83-87`; `launch-prod-orch.mjs:93-94`.
- **Containment seal (token-hijack fix):** `profiles.ts:157-169,234-242`; `launch-prod-orch.mjs:77`; `reference_hosted_claude_plugin_token_hijack`.
- **SDK-vs-CLI team-tool gap:** `profiles.ts:60-63`; `reference_sdk_no_agent_teams`; `driver-policy.ts:1-27`.
- **Existing lifecycle / restart / liveness:** `tools/supervisor/src/lifecycle.ts`; `archive/supervisor-orchestrator-io-boundary-2026-06-18.md` §4; `archive/hosted-agent-lifecycle-restart-2026-06-18.md`.
- **Worktree isolation pattern:** `tools/supervisor/launch-pty-orch.mjs:47-77`.
- **Prior driver decision (seam, retire PTY, SDK primary + cli-stream hedge, `apiKeySource:"none"`):** `docs/development/reviews/m12-supervisor-architecture-review-2026-06-17.md`.
- **Concurrency/billing verification (2026-06-19):** `anthropic.com/legal/terms`; `support.claude.com/.../11647753`, `.../11145838`, `.../11049741`; `code.claude.com/docs/en/agent-teams`, `.../costs`; `anthropic.com/news/claude-code-on-team-and-enterprise`, `.../higher-limits-spacex`; `claude.com/pricing`.
