# M12 — PtySessionDriver Design + Transcript Probe Report (Option 3)

**Agent:** dev-m12p3a · **Date:** 2026-06-15 · **Status:** DESIGN + PROBE REPORT — **mini-probe DONE; persistence micro-probe DEFINITIVE → interactive node-pty does NOT persist a transcript (§(e))**. Transcript-tail is OFF the table for the PTY path → the OUTPUT must be render-derived. This is a material change vs what the user approved → **STOPPED for a DECISION (PART 4: 3a full-render / 3b SDK / 3c minimal-render-hybrid)** per the team-lead's pre-build persistence gate. Build still HELD.
**Decision (user):** the supervisor drives the **interactive `claude` TUI via a PTY** (subscription-billed) instead of the headless Agent SDK. Additive — a new `PtySessionDriver` behind the EXISTING `SessionDriver` seam; the `SdkSessionDriver` stays selectable. All Phase-3a infra (permission-router, channel adapter, capture store, panel, profiles, lifecycle) is REUSED unchanged.

> Grounding: empirical probe of the transcript JSONL + a real ConPTY spawn of `claude.exe` (no doc-guessing). Two items are FLAGGED for a follow-up node-pty mini-probe; the design notes exactly which and the resolution path.

---

## PART 1 — PROBE REPORT (what was measured)

### ✅ (a) Transcript path + mangle — CONFIRMED EXACT
Interactive Claude Code writes `~/.claude/projects/<mangled-cwd>/<session-id>.jsonl`. The mangle replaces `:` and `\` (and `/`) with `-`:
`D:\repos\PianoidInstall` → `C:\Users\astri\.claude\projects\D--repos-PianoidInstall\`. Directory confirmed present. Sub-agents get their own `agent-<id>.jsonl` in the same dir.
**Discovery options:** compute the mangle from cwd, OR watch the dir for the newest non-`agent-` `*.jsonl` after spawn and read its `sessionId`. (Recommend: compute the mangled dir, then watch it for the new file → capture session-id from the first line's `sessionId`.)

### ✅ (b) Real-time append — CONFIRMED
The JSONL is appended line-by-line during a turn (this very in-CLI orchestrator session's file is ~5 MB and updates live as work proceeds). A line-tailer (`fs.watch` + read-from-offset, or poll size) sees user/assistant/tool events as they land.

### ✅ (c) Structured content — CONFIRMED, clean, and = our existing parser
Each line is one JSON object: top-level `type`, `uuid`, `parentUuid`, `timestamp`, `sessionId`, `cwd`, `gitBranch`. Bus-relevant shapes:
- **assistant turn:** `type:"assistant"`, `message.content[]` = blocks of `{type:'text', text}` / `{type:'thinking'}` / `{type:'tool_use', id, name, input, caller}`.
- **tool result:** `type:"user"`, `message.content[]` contains `{type:'tool_result', tool_use_id, content}`.
- Counts in a real session: **211 `tool_use` ↔ 211 `tool_result`** (balanced). ⇒ **a pending permission = an unmatched `tool_use` (a `tool_use` with no `tool_result` yet)** — a clean, screen-free detection signal.

This is the SAME structure `SdkSessionDriver.mapMessage` already parses (it maps `system/init` / `assistant` / `tool_result` / `result`). So **transcript-line → normalized `SessionEvent` → existing bus events** is a near-direct reuse. **No ANSI screen-scraping for content.**

### ✅ ConPTY feasibility — CONFIRMED
A pseudo-console (pywinpty) DID spawn `claude.exe` from a non-TTY parent (it ran 388 s). So the supervisor can host interactive claude in a PTY child it owns.

### ✅ (d) Permission-prompt RENDER + answering keystroke — RESOLVED (node-pty re-probe)
pywinpty captured ZERO TUI output (its read doesn't surface claude.exe's alternate-screen buffer). **node-pty (ConPTY) drains it correctly** (`onData` → 1247 B at boot, growing). The re-probe captured the exact gates:

**First-run / trust gate** (fresh cwd) — numbered menu, default on 1, answered by **Enter** (or `1`+Enter):
```
Quick safety check: Is this a project you created or one you trust?
❯ 1. Yes, I trust this folder
  2. No, exit
Enter to confirm · Esc to cancel
```

**Permission prompt** (e.g. a Write) — numbered menu, default on 1, with a `● Write(<file>)` indicator + a "Do you want to …?" header:
```
Do you want to create hello_probe.txt?
❯ 1. Yes
  2. Yes, allow all edits during this session (shift+tab)
  3. No
Esc to cancel · Tab to amend ● Write(hello_probe.txt)
```
Answer: **`1`+Enter** (allow once) / `2` (allow-all-session) / `3` or **Esc** (deny). Default highlighted on 1.

**★ CRITICAL REFINEMENT (changes §2.4):** interactive Claude Code **blocks at the permission prompt and does NOT write the `tool_use` to the transcript until the permission is GRANTED**. So the "unmatched `tool_use` in the transcript = pending permission" heuristic (true for the headless SDK stream) does **NOT** detect interactive prompts — the transcript stays empty while the prompt is pending (probe confirmed: no scratch `*.jsonl`, file not created, while the prompt was on-screen). ⇒ **pending-permission detection MUST be PTY-RENDER-based** (match the prompt markers: "Do you want to" / the numbered "❯ 1. Yes …" list / a `● <Tool>(…)` indicator), NOT transcript-based. The transcript still drives all CONTENT (assistant text / the tool_use-after-grant / tool_result); only the PROMPT signal moves to the render. The driver therefore parses BOTH: transcript (content) + a thin render-scan (just the prompt markers, not a full terminal emulator).

**Note:** the probe's own answer keystroke didn't land (timing/format of `1`+`\r` after the prompt); the build will tune the exact write (likely needs the prompt-rendered confirmation before sending, + possibly a small delay). This is an implementation detail, not an open feasibility question — the gate/prompt shapes + keys are now known.

### ✅ (d-FINAL) node-pty MINI-PROBE — ALL THREE FLAGGED ITEMS LANDED + the OUTPUT-half risk RESOLVED (2026-06-15)
A clean single short scratch-dir session (brand-new untrusted dir, no `--name`, default persistence) confirmed the full round-trip end-to-end, keystrokes LANDING:

- **(i) DRAIN** — node-pty drains the entire TUI (trust gate + what's-new panel + input box all rendered). Confirmed again.
- **(ii) TRUST GATE — keystroke LANDED.** Fresh dir showed the gate verbatim ("Quick safety check: Is this a project you created or one you trust? … ❯ 1. Yes, I trust this folder / 2. No, exit / Enter to confirm"). Sending **`\r`** (Enter = default "1. Yes") **cleared the gate in 0.7 s** → input box `❯ Try "…"` rendered. (The prior scratch probe never confirmed the clear — this one did.)
- **(iii) PERMISSION PROMPT — keystroke LANDED + verified by side effect.** A "create a file" turn produced the prompt verbatim ("Do you want to create probe_marker.txt? / ❯ 1. Yes / 2. Yes, allow all edits during this session (shift+tab) / 3. No / Esc to cancel · Tab to amend"). Sending **`1\r`** (allow once) → render showed `● Write(probe_marker.txt)` → `⎿  Wrote 1 lines to probe_marker.txt` → the input box `❯` re-rendered. **The file was actually created on disk** (`probe_marker.txt`, content `PROBE-OK-98765`) — so the keystroke genuinely granted the action, not just dismissed the menu. **Turn-complete signal = the `⎿ Wrote…`/tool-result line + the input box `❯` re-render** (no `result` JSON like stream-json — derive completion from the render).

**★ REFINEMENT A — prompt PARSING (corrects §2.4 below):** at the permission prompt, the tool+arg are NOT yet a `● <Tool>(<arg>)` line — that line only appears AFTER the grant. At the prompt instant the render shows a **header block**: `Create file` / `<filename>` + a diff preview + the `Do you want to <verb> <file>?` line. ⇒ the driver builds the `PermissionRequest{toolName, input}` from the **prompt header** ("Create file"→Write, the filename line→the arg) + the "Do you want to <verb>…" verb, NOT from a `● Tool(…)` line. (The `●` indicator is the POST-grant transcript-style echo.)

**★ REFINEMENT B — TRANSCRIPT FLUSH LAG = the OUTPUT-half core fact (resolves the prior `--name` open risk):** this no-`--name` spawn's transcript directory WAS created at the correctly-mangled path (`~/.claude/projects/C--Users-astri-AppData-Local-Temp-pty-miniprobe-…/`) but was **still EMPTY at +12 s**, after the turn fully completed on screen and the file was written. ⇒ the earlier "`--name` wrote no transcript" finding was NOT `--name`-specific — interactive Claude Code **does not flush the session JSONL synchronously during a short turn**; it writes with a lag (likely on idle / session-end / a buffered interval). **Design consequence:** the transcript tail is NOT a low-latency turn-by-turn event source for a live PTY session — it lags the render by seconds-to-longer. Therefore the **RENDER is the real-time signal source** (assistant text, tool-run lines `⎿ …`, prompts, turn-complete `❯` re-render), and the transcript is at best a delayed cross-check / for sub-agent content. This **flips §2.3**: the OUTPUT half should be **render-derived (ANSI-aware line parsing of the PTY stream)**, with the transcript as a lagging supplement — NOT transcript-tail-primary. (The render content is clean and parseable, as the probe snapshots show; it is more work than transcript-tailing but it is the only real-time source.)

**Net:** all feasibility is proven — drain ✓, trust-gate detect+clear ✓, permission detect+route-shape+answer-keystroke+side-effect ✓, turn-complete signal ✓. The two refinements (parse the prompt HEADER; OUTPUT is RENDER-primary not transcript-primary) are folded into the design below. **No open feasibility question remains; the build is a tuning + parsing exercise.**

### ✅ (e) TRANSCRIPT-PERSISTENCE micro-probe — DEFINITIVE: interactive node-pty does NOT persist a transcript (2026-06-15, pre-build gate)
The team-lead gated the build on this (transcript-tail is the *clean* output half; if a node-pty session can't persist, the design degrades to full render-scraping — a user-visible change). REFINEMENT B above said "flush lag"; the follow-up micro-probe proves it is stronger than a lag — it is **NO persistence at all**. Three independent node-pty interactive runs + a headless control settle it:

| run | invocation | turn completed? | transcript persisted? |
|---|---|---|---|
| scratch mini-probe | interactive, no `--name`, scratch dir | yes (file written on disk) | **NO** (empty at +12 s) |
| persist v2 (definitive) | interactive, no `--name`, project dir | **yes — assistant rendered the marker reply** (2 occ.) | **NO** — not live (15 s) AND not after a clean `/exit` (+9 s, child exit 0) |
| persist v3 | interactive, **`--session-id <uuid>`**, project dir | yes (marker reply rendered) | **NO** — expected `<uuid>.jsonl` never created, live or on `/exit` |
| **control** | **`--print` headless** one-shot | yes | **YES** — `<id>.jsonl` 17.5 KB, **found instantly by the same dir-scan** ⇒ scan logic is SOUND, the NO is real |

**Verdict: a node-pty-spawned INTERACTIVE `claude` session does NOT write a session JSONL at all** — not live, not on clean exit, not with a pre-assigned `--session-id`. Confirmed against the confound (the turn DID complete — the assistant's reply rendered) and against measurement error (the `--print` control persisted and the identical scan found it). `--no-session-persistence` is documented "(only works with --print)", i.e. persistence is a `--print`/SDK-mode concept; the interactive TUI does not journal to `~/.claude/projects/` the way the CLI-harness-hosted session (my own 5.5 MB `18e2fcea`) does. (The harness session is launched by Claude Code's own top-level process, not a child PTY — that's the difference.)

**⇒ TRANSCRIPT-TAIL IS NOT AVAILABLE for the interactive PTY path.** §2.3's render-primary plan is therefore not merely *preferred* — it is the ONLY option for a PTY session, and the "transcript = lagging cross-check" supplement is **GONE** (there is no transcript to cross-check against). This is a material design fact the user must see before the build — see **PART 4 (DECISION)**. **STOPPED + reporting per the team-lead's gate; NOT silently falling back to render-scraping.**

### ✅ (f) FLUSH-LATENCY investigation — the "in-CLI flushes but probe didn't" CONTRADICTION resolved (2026-06-15)
The team-lead correctly flagged a contradiction: the in-CLI session (18e2fcea) flushes its transcript continuously, yet the probe was empty — same binary, same dir — so "interactive doesn't flush synchronously" might be premature (the probe might just have been *idle*, below a flush trigger, while an active orchestrator would flush). Two measurements settle it:

**Method (a) — in-CLI flush latency (FREE, watched 30 s):** the harness session is **event-driven with ~1 s latency**. Idle stretch (15 s): file STATIC, last event aged 45→58 s (nothing to write). The instant an event occurred (a tool result), the file grew +21 KB and the event landed at **eventLag ≈ 1.0 s, mtimeLag ≈ 0.7 s**. ⇒ the team-lead was right that the big "lag" numbers were idle-no-write, not slow flushing — **an active harness session journals events in ~1 s.**

**Method (b) — spawned ACTIVE multi-turn session (1 node-pty spawn, 95 s, 3 turns at 1 s / 24 s / 49 s, watched continuously):** **NO transcript ever appeared** — firstFlush = NONE, not even an empty file, across the entire active window. The session was never idle longer than ~24 s and completed 3 turns; still zero journal.

**RESOLUTION (no contradiction):** flush is *fast when it happens* (≈1 s) but **only happens for a HARNESS-launched session, not a node-pty-spawned child** — regardless of activity. The discriminator is **launch mode, not activity level**: method (b) was continuously active and wrote nothing, so "active ⇒ persists" is **refuted** for the child-PTY case. This reconciles every data point: in-CLI (harness) flushes in ~1 s; spawned child (PTY) never flushes; the `--no-session-persistence "only works with --print"` doc hint predicted exactly this (journaling is a `--print`/SDK/harness concept, not a child-TUI one). **My render-primary conclusion stands — now with the idle-confound eliminated, not assumed away.** The decision (PART 4) is unchanged and firmer.

---

## PART 2 — PtySessionDriver DESIGN (behind the existing seam)

`class PtySessionDriver implements SessionDriver` — same contract as `SdkSessionDriver`, so `LifecycleManager`/`SessionHost`/the router/panel are unchanged. Selected by a launch flag (`--driver pty|sdk`, default keeps current).

### 2.1 LIFECYCLE / spawn
- Spawn `claude.exe` in a **node-pty ConPTY**, `cwd = repo`, `--name supervisor-orch` (+ resume via `claude --resume <session-id>` on restart — the FI path). Env carries `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` etc. (same as the SDK path).
- **First-run/trust gate handler (RESOLVED):** on spawn in a fresh/untrusted cwd, the TUI shows the "Is this a project you trust?" numbered gate (probe-captured). Clear it by detecting the gate marker in the render and sending **Enter** (default = "1. Yes, I trust this folder"). The supervisor's own repo cwd is likely already trusted (no gate), but the handler must cover the fresh case. (Optionally PRE-TRUST via the trust-state file to skip it — investigate at build time.) Ready-state = gate cleared + input box rendered (the `❯ Try "…"` placeholder).
- Role bootstrap (orchestrator): the existing `roleTurnPrefix` ('/orchestrator' on the first user turn) carries over unchanged.

### 2.2 INPUT — write user turn + Enter
`send(turn)` writes `turn.text` + the submit key to the PTY. (The Phase-2 streaming-input envelope is SDK-only; the PTY path just types text — simpler.) FLAGGED: confirm the exact submit sequence (`\r` vs `\r\n` vs bracketed-paste) in the mini-probe — the TUI may need bracketed-paste for multi-line.

### 2.3 OUTPUT — RENDER-PRIMARY (post-(d-FINAL) refinement; transcript = lagging supplement)
> **★ Updated by REFINEMENT B:** the transcript JSONL is NOT flushed synchronously during a short turn (probe: dir created, still empty at +12 s post-completion). So transcript-tail is NOT a real-time source for a live PTY session. **The PTY render is the real-time signal source.** Below replaces the original "tail the transcript primary" plan.
- **Real-time (RENDER):** parse the ANSI-stripped PTY line stream for: assistant text blocks, tool-run result lines (`⎿ …`), the per-tool indicator (`● <Tool>(<arg>)` appears AFTER a tool runs), the permission prompt (§2.4), and the **turn-complete** signal = a settled assistant block + the input box `❯` re-rendering (no pending prompt). Map these → the SAME `SessionEvent` shapes the bus already consumes (assistant / tool_result / result). The render content is clean + parseable (probe snapshots confirm); keep it to known line markers, not a full terminal emulator.
- **Spawn / session-id:** compute the mangled dir (`~/.claude/projects/<cwd with :\/ → ->/`), watch for the new `*.jsonl`; capture `sessionId` from its first line for the resume id (it appears once the file is eventually flushed — fine, resume only needs it at restart, not in real time). `system_init` is emitted from the boot render (banner: model/cwd/version) so it does not wait on the transcript.
- **Transcript = lagging supplement (optional):** once flushed, the JSONL is a clean cross-check + the source for sub-agent (`agent-<id>.jsonl`) content. Reuse `mapMessage` there. NOT on the real-time path.
- This feeds the SAME bus → capture/panel/channel-out (incl. the per-turn de-dup + the channel reply tool, unchanged).

### 2.4 PERMISSIONS — rare; detect pending → route → keystroke
- Most tools are auto-allowed by the allow-list (the supervisor passes `--allowedTools`/settings). A prompt is RARE.
- **Detect (RENDER-based — the probe refinement):** the pending prompt is NOT in the transcript (claude blocks BEFORE writing the tool_use). The driver runs a thin render-scan for the prompt markers: a "Do you want to …?" header + the numbered "❯ 1. Yes / 2. … / 3. No" list. This is NOT a full terminal emulator — just a few regexes over the recent ANSI-stripped PTY bytes.
- **Route:** build a `PermissionRequest{toolName, input}` from the **prompt HEADER block** (per REFINEMENT A): the action line (`Create file` → `Write`, `Edit file` → `Edit`, a command → `Bash`, …) + the following filename/arg line + the "Do you want to <verb> <target>?" line. (NOT a `● <Tool>(…)` line — that only appears AFTER the grant.) → hand to the EXISTING `PermissionRouter` → channel round-trip (the FC-1 path, unchanged) → block on the user's allow/deny.
- **Answer:** on the verdict, inject the keystroke into the PTY: **`1\r`** (allow once) or **`3\r`/Esc** (deny). (Build tunes the exact send — likely gate on seeing the prompt fully rendered first.) This replaces the SDK's `canUseTool` return. NOTE the safety-floor predicate still runs at the router, so even if the allow-list passes a tool, a destructive op routes to the user before the keystroke is sent.

### 2.5 What's REUSED unchanged
PermissionRouter (+ safety-floor predicate), ChannelPermission + the channel reply tool, IoBus + CaptureStore, Panel (operator-grade), profiles (demo|orchestrator), LifecycleManager (watchdog/restart/clearContext), SessionHost (operator binding, de-dup, roleTurnPrefix). The PtySessionDriver is the only new file; it's a drop-in `SessionDriver`.

### 2.6 Dependencies / risks — POST-PROBE STATUS
- **node-pty** — ✅ RESOLVED. Installed `node-pty@1.1.0` in tools/supervisor; loads via BOTH `require` and ESM dynamic-import (`spawn/fork/createTerminal/open/native`); native binary present (`node_modules/node-pty/build/Release`). The native-build risk did NOT bite (prebuilt/built clean). It's a `dependencies` entry (staged, commits with the build).
- **"turn complete" signal** — ✅ RESOLVED (render-based): the `⎿ <tool-result>` line + the input box `❯` re-render (no pending prompt). Derive from the render, not the transcript.
- **First-run/trust gate** — ✅ RESOLVED two ways: (a) **pre-trust via settings (decision 3, the clean path):** the trusted-folder state lives in `~/.claude.json` under `projects["<cwd>"].hasTrustDialogAccepted` — set it `true` before spawn to skip the gate, NO keystroke. NOTE the key is the EXACT path string Claude normalizes to (it stores `D:/repos/PianoidInstall` with **forward slashes** + case-sensitive; a `D:\…` backslash entry is a DIFFERENT key). The build computes the same normalization the CLI uses (or watches which `projects[]` key gets `onboardingSeenCount` bumped). (b) **keystroke fallback** for an untrusted/fresh cwd: detect the gate marker, send `\r` (default "1. Yes") — probe-confirmed to clear in 0.7 s. The supervisor's repo cwd is already trusted (no gate in the project-dir probe), so (a) covers production; (b) is the safety net.
- **OUTPUT = RENDER-primary** (REFINEMENT B) — the transcript flush lag means content comes from the RENDER, not the transcript. So the PTY parsing is NOT "minimal gate/prompt only" — it parses assistant text + tool-result lines too. Still known-line-marker parsing (ANSI-stripped), NOT a full terminal emulator, but it is the larger half of the build. The render content is clean (probe snapshots). The transcript is a lagging cross-check only.
- **node-pty child cleanup** — the probe's `term.kill()` exits the child cleanly (observed exit). The driver owns the child and kills its tree on `end()`/process exit (same discipline as the SDK driver's abort).

### 2.7 BUILD-READINESS — verified seam contract + test plan (design-readiness pass, no code written)
A read-only audit of the existing Phase-3a seam (during the build-go hold) confirms the PtySessionDriver is a clean drop-in and pins the test surface:

**Contract the PtySessionDriver MUST implement** (`src/session-driver.ts`, verified): `start(opts): AsyncIterable<SessionEvent>`, `send(turn): Promise<void>`, `interrupt(): Promise<void>`, `stop(): Promise<void>`, `health(): SessionDriverHealth`. It emits the 4 `SessionEvent` kinds — `system_init{sessionId,model?,tools?,slashCommands?,mcpServers?}` / `assistant{text,toolUses[]}` / `tool_result{toolUseId,content,isError?}` / `result{sessionId,subtype,result?,costUsd?}` — and takes a `PermissionHandler` (the router) it invokes per gated tool. Same contract `SdkSessionDriver` satisfies ⇒ LifecycleManager/SessionHost/router/panel/channel are unchanged (the seam holds).

**PTY-specific method mapping** (vs the SDK driver):
- `send(turn)` → `term.write(turn.text)` then the submit key (`\r`; confirm bracketed-paste for multi-line at build) — NO `SdkUserTurn` envelope/`assertValidUserTurn` needed (the TUI takes raw text; that whole `makeUserTurn`/`TurnQueue` machinery is SDK-only).
- `interrupt()` → inject **Esc** (or Ctrl-C) keystroke into the PTY (NOT `query().interrupt()`). The H2 watchdog hook (lifecycle `interrupt()` → restart) works identically — it's already wired in `lifecycle.ts`.
- `start()` → node-pty `spawn` + pre-trust (`hasTrustDialogAccepted`) or gate-keystroke; then an async generator that yields `SessionEvent`s parsed from the render stream (the new mapper — the PTY analog of `mapMessage`, but render-line→event instead of SDK-json→event).
- `stop()` → `term.kill()` + dispose the tailer/watchers.

**`mapMessage` reuse:** NOT reused directly (it parses SDK-shaped `{type,message:{content[]}}` JSON; the PTY source is rendered lines). The PtySessionDriver has its OWN `renderLineToEvent` mapper producing the SAME `SessionEvent` shapes. Clean parallel, confined to the new file — the seam's whole point.

**TEST PLAN (deterministic, NO real PTY/subprocess/network — mirrors `FakeSessionDriver`):**
1. The existing driver-agnostic suite (lifecycle/router/panel/channel/controller-bridge/session-host tests) **already covers PtySessionDriver** — they script at the `SessionEvent` level via `FakeSessionDriver` (`src/test/fake-session-driver.ts`), so any seam-conformant driver passes them unchanged. No new lifecycle tests needed.
2. **NEW unit test — the one new piece: `pty-session-driver.test.ts` with a `FakePty`** (a scriptable `{onData, write, kill}` double — NO `node-pty`). It feeds **byte frames captured verbatim from the mini-probe** (trust-gate frame, assistant-text frame, permission-prompt frame, tool-result frame, input-box-ready frame) and asserts:
   - render frames → the right `SessionEvent`s (assistant text, tool_result, result/turn-complete, system_init from the boot banner);
   - the permission-prompt frame → the right `PermissionRequest{toolName,input}` built from the **prompt HEADER** (REFINEMENT A) — e.g. the `Create file`/`<filename>` frame → `{toolName:'Write', input:{file_path:…}}`;
   - on a verdict, the driver `write`s the right keystroke to the FakePty (`1\r` allow / `3\r`|Esc deny);
   - the trust-gate frame (when not pre-trusted) → an Enter keystroke; pre-trust path → no keystroke.
   - the safety-floor predicate still routes a destructive op to the user BEFORE the keystroke (router-level, already tested in `permission-router.test.ts` — just confirm the PTY path calls the same router).
3. **Fixtures = the captured render bytes** (checked into `src/test/fixtures/pty/`), so the parser is tested against REAL claude TUI output, not invented strings.

**First LIVE smoke** (test bot, post-build, the transcript-flush/render-path gate): `--driver pty` → spawn → pre-trust → one real turn → observe render→bus→panel/channel + one permission round-trip via the channel. Then a live test-bot run with the user.

**Net:** the build is one new file (`adapters/pty-session-driver.ts`) + one new test (`pty-session-driver.test.ts` + fixtures), behind `--driver pty`, SDK driver intact + default. Low blast radius; the seam already insulates everything else.

---

## PART 3 — NEXT STEP — mini-probe DONE (all 3 items + the 3 decisions resolved); HOLD the build for user-OK

**Mini-probe: COMPLETE (see (d-FINAL) above).** All 3 flagged items landed on a clean short scratch session — drain ✓, trust-gate detect+clear ✓, permission detect+route-shape+answer-keystroke+side-effect ✓, turn-complete signal ✓. The two refinements (parse the prompt HEADER not a `●` line; OUTPUT is RENDER-primary because the transcript flush lags) are folded into §2.

**The 3 open decisions are all RESOLVED:**
1. node-pty dep — ✅ added (`@1.1.0`, loads + native binary present; no build pain).
2. mini-probe — ✅ ran (1 short scratch session; child owned + killed; prod untouched; ~12 s).
3. pre-trust via settings — ✅ found: `~/.claude.json` `projects["<normalized-cwd>"].hasTrustDialogAccepted=true` (forward-slash path key); keystroke fallback kept for fresh dirs.

**THE BUILD (on user-OK of the approach — the user's checkpoint is before the build):** implement PtySessionDriver per §2, behind `--driver pty`, SDK driver intact + default. Deterministic test suite = a **FakePty** (scriptable byte stream: trust-gate frame, assistant-text frame, permission-prompt frame, tool-result frame) + assertions that the driver emits the right `SessionEvent`s, builds the right `PermissionRequest` from a prompt-header fixture, and sends the right keystroke on a verdict — NO real PTY/subprocess in tests (mirrors FakeSessionDriver). First **live smoke** on the test bot: spawn → trust pre-set → one real turn → observe the render→bus→panel/channel path → one permission round-trip via the channel. Then a live test-bot run with the user.

**Status: HELD.** Reporting the probe + the refined design to the team-lead; awaiting the user's OK on the approach before building. Branch only; prod untouched; token kept.

---

## PART 4 — DECISION (the persistence finding forces a fork the user must pick)

The persistence micro-probe (§(e)) is decisive: **the interactive PTY session writes NO transcript JSONL.** So Option 3's "clean output via transcript-tail + a thin render-scan only for prompts" is **not achievable** — the PTY path's output MUST come entirely from the rendered terminal. That is a real change to what the user approved (they OK'd transcript-tail as the clean half), so per the team-lead's gate this STOPS for a decision. The honest options:

**Option 3a — PTY + FULL render-parsing (subscription billing, the original Option-3 intent, minus transcript-tail).** Build PtySessionDriver with ALL output derived from the ANSI render stream (assistant text, tool-run `⎿` lines, prompts, turn-complete `❯`). Pros: keeps subscription billing (the whole reason for Option 3); feasibility 100% proven (drain/gate/permission/keystroke/turn-complete all landed). Cons: render-parsing is the fragile path the team-lead wanted to avoid — it depends on the TUI's visual format (glyphs, box-drawing, spinners, alternate-screen redraws) which can change between Claude Code versions; it needs careful, version-pinned line parsing + maintenance. It is doable (the render content is clean and the markers are stable today) but it is genuinely more brittle than a structured stream.

**Option 3b — keep the SDK driver (structured stream-json, the de-risked path) — accept API billing.** The SDK/`--print` path persists AND streams clean structured JSON (control proved it). It's already BUILT, TESTED (139/139), and was LIVE-validated on the test bot this session. Cons: API-metered, not subscription — which is exactly what Option 3 set out to avoid. This is the "if subscription-via-PTY is too fragile, the structured path is right there" fallback.

**Option 3c — HYBRID: PTY for the interactive/subscription session, but parse the render with a SMALL, well-bounded surface (not a full emulator).** In practice 3a, but scoped: the supervisor only needs a handful of signals (assistant final text, a permission prompt + its tool/arg, turn-complete, errors). It does NOT need to reproduce the whole TUI. A tight parser over those known markers (all captured verbatim in the probes) is far less brittle than "full render-scraping" implies — it's ~5-8 regexes over ANSI-stripped lines, version-guarded. This is the recommended shape IF the user wants subscription billing: accept render-parsing, but keep it minimal + pinned, with the SDK driver retained behind `--driver sdk` as the instant fallback if a Claude Code update breaks the parse.

**RECOMMENDATION:** present 3a/3b/3c to the user. If they still want subscription billing → **3c** (minimal render-parse, SDK fallback retained). If the render-parse brittleness is unacceptable → **3b** (SDK, already done). Either way the Phase-3a infra (router/channel/capture/panel/profiles/lifecycle/seam) is REUSED and the SDK driver stays selectable. The build itself is unchanged in scope (1 adapter + 1 test + a flag); only the OUTPUT-parsing source (render vs SDK-stream) differs — and that's the user's call because it's the subscription-vs-API tradeoff they raised.
