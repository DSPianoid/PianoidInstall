# M12 — Host / Supervisor App — Implementation Proposal

**Status:** ✅ APPROVED + **Phase 1 IMPLEMENTED** — merged to master 2026-06-15 (merge `93ffa66`; `tools/supervisor/`, 68/68 tests green, code-reviewed, live Telegram connectivity verified end-to-end against a dedicated test bot). **Phase 2** (subprocess ownership) IN PROGRESS; Phase 3 pending. Lean, top-down; every element traces to a governing principle.
**traces-to:** [`generic-dev-skillset-opensource-2026-06-11.md#M12`](generic-dev-skillset-opensource-2026-06-11.md) (the Campaign proposal **GOVERNS** this doc; this is a T2 module-design under it). Realises **M12**; supports **M10** (channel adapter), **M1** (orchestrator), **M6** (controller). Principles: **AP1, AP8**; **CP3, CP1, CP7**. Flows: **FI** (recovery), **FO** (wait→wake on the I/O bus).

**How to read.** PART A states *why* (the three failure classes, traced). PART B states *what* (architecture, runtime, subsume/retire). PART C states *how/when* (phases, repo, cross-platform). PART D is the decisions + risks the user signs off. Upstream (the Campaign proposal's PART 0) governs everything here; where this doc asserts a capability of Claude Code / the Agent SDK it carries a **[doc]** citation, and anything unconfirmed is **FLAGGED**, never invented.

---

# PART A — PURPOSE & THE THREE FAILURE CLASSES

## A.1 Purpose

The methodology (M1–M11) is today driven from **inside** an interactive Claude Code CLI session running in a VS Code integrated terminal. That host has three structural defects that no amount of skill-authoring can fix, because they live **below** the skill layer — in how the process is driven. **M12 is the packaging that makes the methodology a controllable app:** a **standalone supervisor process that owns Claude Code as a managed subprocess** (headless `claude -p` / the Agent SDK, stream-json I/O), exposing **full programmatic stdin/stdout**, a **thin local web/TUI panel**, and the **durable pluggable channel adapter (M10)**. It is the **runtime + I/O-control** module — it owns no project logic; it *hosts* M1 (orchestrator) and M6 (controller) and *carries* M10.

> **Trace:** §0.6 "four substrates → Host runtime"; §0.11 "Orchestrator-as-app"; D2 (locked: standalone supervisor owning the CLI subprocess). The supervisor is the chosen form-factor over (A) stay-in-CLI + harden the glue, or (B) a plugin — only it delivers literal full programmatic I/O, survives reloads, and dissolves the invisible-prompt / stdio-drift classes.

## A.2 The three failure classes it designs out

Each class is a category of incident we hit **today**, in-CLI; the supervisor removes the class **structurally** (by construction), not by mitigation.

### FC-1 — Invisible permission prompts → **AP1, CP1, CP7, CP3; FI**

**Today.** A sub-agent's tool call needs approval; the prompt renders **only in the local VS Code terminal**. A remote (Telegram) user cannot see it, so the agent **stalls silently**. This is documented in-repo as *"the dominant stall pattern"* — the orchestrator runs a periodic **30-minute marker sweep** for unmatched `[BASH-CALL]`/`[MCP-CALL]` markers (`orchestrator.md:285`), and the only remote unblock is a **synthesized keystroke** (`/cli-control release`) or a **user-side fallback** ("check the CLI window for a pending prompt", `orchestrator.md:1145`). The entire `cli_control.ps1` + the `bypassPermissions`-allow-list whack-a-mole exist *because of this one class*.

**Designed out.** The supervisor owns Claude Code through the SDK's **`canUseTool` permission callback** (TS) / **`can_use_tool`** (Python) — a function the supervisor controls, invoked **before** any tool runs that isn't pre-approved, returning **allow / deny / (route-to-user)** programmatically. **[doc: agent-sdk/permissions.md]** There is no terminal prompt to be invisible: the supervisor **sees every request**, applies the allow-list, and for anything on the safety floor (CP7) **routes the decision out over the channel** and blocks on the user's reply. The 30-min sweep, the keystroke `release`, and the user-side "go look at the window" all disappear.

### FC-2 — Editor reloads / MCP stdio drift → **CP3, AP8; FI** (the recovery owner)

**Today.** Claude Code runs inside VS Code; an **editor reload** (`Ctrl+Shift+P → Reload Window`, required after MCP config changes per `~/.claude/CLAUDE.md`) tears down the session and the MCP stdio pipes. MCP servers communicating over stdio **drift** (the chrome-devtools `@latest` pipe-break in `reference_chrome_devtools_mcp_profile`; the WhatsApp bridges that must run in separate terminals and re-auth ~every 20 days). Recovery is manual and lossy; inbound messages can be dropped across the reload (the very reason the **Telegram inbox-queue patch** exists — `apply_telegram_patch.py`).

**Designed out.** Claude Code becomes a **supervised child process** of a long-lived supervisor that is **not** inside the editor. A crash / unhealthy state → the supervisor **restarts the subprocess** and **resumes the session** (`--resume <session_id>` / SDK `resume`, with the session id captured from the `system/init` / result message) **[doc: agent-sdk/sessions.md, headless.md#continue-conversations]**. The supervisor is the **FI recovery owner**: it owns the wait→wake plumbing (**FO**) on its I/O bus, so a stall/health-check fires a deterministic restart rather than a guessed sleep. MCP servers are configured **programmatically as SDK options** (`mcpServers` / `mcp_servers`) **[doc: agent-sdk/typescript.md, python.md]** and supervised with the subprocess — no editor reload in the loop.

### FC-3 — No programmatic I/O (keystroke + monkey-patch glue) → **AP1, AP8, CP1; FO**

**Today.** There is **no clean programmatic stdin/stdout** to the running session. To drive it we **synthesize OS keystrokes** into the VS Code window (`cli_control.ps1` → .NET `SendKeys`, walking the parent-process chain to find the window, stripping the `●` unsaved-edits marker) and we **monkey-patch the Telegram plugin** to capture inbound (`apply_telegram_patch.py` → a file queue) and to emit voice (`apply_telegram_voice_patch.py` → `sendVoice`). I/O is **scraped from transcript `.jsonl` tails** for receipts. This is brittle (window-title dependent, focus-stealing, race-prone) and **un-observable** (no captured byte-stream, no metrics).

**Designed out.** **Every byte passes through the supervisor's I/O bus** — `stream-json` over the subprocess stdin/stdout. Input is injected as `stream-json` user messages over stdin (`--input-format stream-json`); output is consumed as the `stream-json` event stream (`system/init`, `assistant`, `tool_*`, `result`, partial `stream_event` with `--include-partial-messages`) **[doc: headless.md#stream-responses, cli-reference.md]**. No keystroke synthesis, no window-finding, no transcript scraping; and because the bus captures everything, **session-replay / metrics** (token cost, tier breakdown, stall events, the verification-evidence index — §2c) become free.

> **One-line summary of A.2:** FC-1 = *see+route every prompt*; FC-2 = *managed subprocess → supervised restart + resume*; FC-3 = *every byte on a captured bus*. The three together are exactly the M12 mandate (proposal line ~273).

---

# PART B — ARCHITECTURE

## B.1 The shape (one diagram, in words)

```
                          ┌──────────────────────────────────────────────┐
   USER (anywhere)        │            SUPERVISOR  (standalone)           │
   ┌───────────┐  M10     │  ┌────────────┐   ┌──────────────────────┐    │
   │ Telegram  │◄────────►│  │  Channel   │   │   Local panel        │    │
   │ / email   │  adapter │  │  adapter   │   │   (web or TUI)       │    │
   │ / WA /CLI │  contract│  │  registry  │   │   read+approve       │    │
   └───────────┘          │  └─────┬──────┘   └──────────┬───────────┘    │
                          │        │   I/O BUS (stream-json, captured)    │
                          │        ▼                      ▼               │
                          │  ┌──────────────────────────────────────┐    │
                          │  │  SESSION SUPERVISOR / lifecycle       │    │
                          │  │  • spawn / health / restart / resume  │    │  ← FI owner
                          │  │  • canUseTool permission router       │    │  ← FC-1
                          │  │  • wait→wake (FO) on the bus          │    │
                          │  └───────────────┬──────────────────────┘    │
                          │                  │ owns as subprocess         │
                          │      ┌───────────▼─────────────┐              │
                          │      │  Claude Code (headless)  │  M1 orch +   │
                          │      │  claude -p / Agent SDK   │  M6 ctrl run │
                          │      │  stream-json in/out      │  *inside*    │
                          │      └──────────────────────────┘              │
                          └──────────────────────────────────────────────┘
```

## B.2 Components & responsibility borders

| Component | Owns | Border (does NOT do) | Traces |
|---|---|---|---|
| **Session supervisor / lifecycle** | spawn the headless Claude Code child; health-check; restart + `--resume` on crash/stall; capture the session id from `system/init`; own the wait→wake (FO) | any project logic; any code edits (M1/sub-agents do that *inside* the child) | AP1, CP3; **FI**, **FO** |
| **Permission router** | receive each `canUseTool` request; apply the allow-list; auto-allow safe tiers; **route safety-floor decisions out over the channel** and block on reply | decide *which approach* a task takes (that's M1) | CP7, CP1; FC-1 |
| **I/O bus** | marshal `stream-json` in (stdin) / out (stdout); fan-out to channel + panel + capture log | interpret meaning (that's M1) | AP1; FC-3 |
| **Channel-adapter registry (M10)** | hold ≥1 adapter implementing the **adapter contract**; route inbound→bus, bus→outbound; queued+recoverable delivery; voice/text modality + on-the-fly switch | be hardwired to one channel | AP8; **CP3**, FC-2/FC-3 |
| **Local panel (web or TUI)** | a thin operator view: live transcript, pending approvals, session/health, cost; an approval click | be a full IDE; hold project state | CP3 (operator surface), §2c observability |
| **Hosted: M1 orchestrator** | runs *inside* the headless child as the system-prompt/role; classifies, dispatches sub-agents, relays | — | AP1 |
| **Hosted: M6 controller** | the read-only monitor; with the bus it now reads **captured markers** instead of scraping `.jsonl` | act (still report-only) | AP5 |

> **The channel-adapter contract (M10), made concrete.** An adapter is an interface, not a channel:
> `inbound → {text?, voice_path?, attachments[], user, ts, reply_handle}` ; `outbound(reply_handle, {text?, voice_ogg_path?, files[]})` ; plus `start()/stop()/health()`. **Queued + recoverable** (inbound persists to a durable queue until acked — this is the inbox-queue patch's job, now a first-class adapter responsibility, not a monkey-patch). The supervisor codes to *this*, never to Telegram. The **Telegram adapter** is the reference impl (CLI + Telegram are the locked core, D5); **email / WhatsApp / a future web chat** are siblings behind the same contract. **Voice** is an adapter concern: STT-in / TTS-out live behind the contract (B.4).

## B.3 How M1 + M6 run "under" the supervisor

The supervisor does **not** re-implement the orchestrator. It **launches a headless Claude Code session whose role is M1** (via `--system-prompt` / `--append-system-prompt` or the SDK `systemPrompt` option **[doc: cli-reference.md]**), wires that session's hooks + MCP + permission callback as SDK options, and lets M1 do exactly what it does today — *except* its channel I/O, its context-clear, and its stall-recovery are now **served by the supervisor** instead of by in-session glue. M6 (controller) likewise runs as a monitoring consumer of the **bus's captured event stream** (markers arrive as `tool_*` / text events, not transcript-file tails). **Nothing in M1/M6's logic changes** — only their substrate.

## B.4 Voice & modality (M10 detail, FN support)

STT (inbound voice → text) and TTS (outbound text → voice note) move from in-session shell-outs to **adapter-internal steps on the bus**: an inbound voice attachment is transcribed (the `transcribe_voice.py` faster-whisper logic) and delivered to the bus as `text` + a "voice received" note; an outbound message flagged voice is rendered (the `tts_voice.py` edge-tts→OGG logic) and sent via the adapter's native voice path (the `sendVoice` behavior, now built into the Telegram adapter, **not** a plugin patch). The §0.10g **on-the-fly modality switch** is honored by the adapter. **Artifact language stays canonical English; interaction language is per-user** (FN).

> **Trace:** §0.10g (modality, voice/text, on-the-fly switch) → M10 carries it; M1 runs the FN loop. The supervisor just guarantees the bytes flow.

---

# PART C — RUNTIME / STACK RECOMMENDATION

## C.1 Recommendation: **TypeScript / Node**, with a Python escape hatch for ML helpers

**Build the supervisor in TypeScript on Node**, using the official **`@anthropic-ai/claude-agent-sdk`** as the subprocess owner.

### Why (rationale, traced to "least friction owning `claude -p` + the bus + a panel + adapters")

1. **The SDK is most complete in TS.** Confirmed TS-only capabilities the supervisor wants: **in-process SDK MCP servers** (`tool()` + `createSdkMcpServer()`) — so supervisor-provided tools (e.g. an approval-routing tool, status tools) run **in-process**, no extra child; and a **richer hook set** (`SessionStart`/`SessionEnd`/`Setup`/`ConfigChange`/`WorktreeCreate`…). The **Python SDK lacks in-process tool definition** (external MCP only). **[doc: agent-sdk/typescript.md, python.md — FLAGGED: Python in-process MCP not found]**
2. **`canUseTool` + hooks + `mcpServers` are all first-class `query()` options** in TS, the exact control surface FC-1/FC-2/FC-3 need, in one runtime. **[doc: agent-sdk/permissions.md, hooks.md]**
3. **One language for the whole I/O path.** The channel adapters (Telegram's grammY/Bot API is JS-native — it's literally what the current plugin's `server.ts` uses), the web panel (Node HTTP + WS/SSE), and the SDK all live in Node → a single event loop, a single `stream-json` consumer, no cross-runtime bridge on the hot path.
4. **The Telegram reference adapter already exists in TS** (the plugin `server.ts` we patch). Porting it into a first-class adapter is a *lift*, not a *rewrite* — and it deletes both monkey-patches.
5. **Cross-platform parity** (C.4): the SDK bundles a native Claude Code binary per-platform as an optional npm dependency, so `npm install` resolves Win/Linux/macOS uniformly. **[doc: agent-sdk/overview.md]**

### Trade-offs & the escape hatch

- **Against TS:** the existing dogfood tooling (`tools/dev-pipeline/`, `transcribe_voice.py`, `tts_voice.py`, the codegen MCP) is **Python**. *Mitigation:* these are **leaf utilities**, not the I/O core — keep them as **out-of-process helpers** the Node supervisor shells out to (STT/TTS) or talks to as MCP servers (codegen). The **kit's `/dev` pipeline scripts stay Python**; only the **supervisor shell** is TS. The boundary is clean: TS owns *driving Claude Code + the bus + adapters + panel*; Python stays the *script tier (M8)*.
- **If the team strongly prefers Python** (familiarity, the existing scripts): the Python SDK **does** support `query()`/`ClaudeSDKClient`, `can_use_tool`, hooks, `resume`, and external `mcp_servers` **[doc: agent-sdk/python.md]** — the supervisor is **buildable in Python**, losing only in-process SDK MCP (use an external MCP child instead) and some TS-only hooks. This is a viable **fallback runtime**, recorded as **open decision OD-1**.
- **Headless CLI vs SDK:** the SDK *is* the supported embedding API and spawns the same native binary; prefer the SDK over hand-rolling `child_process` around `claude -p` + parsing `stream-json` ourselves (we'd reinvent the SDK). Keep raw `claude -p --output-format stream-json` as the **conceptual contract** (and a debugging fallback), but **drive via the SDK**.

---

# PART D — SUBSUME / RETIRE MAP

What the app **replaces**, what **stays**, and the **migration safety** (it runs **alongside** today's orchestrator first, so nothing is deleted before its replacement is proven).

| Today's glue | Role today | Under the supervisor | Disposition |
|---|---|---|---|
| **`/cli-control` skill + `cli_control.ps1`** (keystroke `verify`/`clear`/`release`) | remote context-clear+relaunch; release a stuck invisible prompt | clear+relaunch → **lifecycle restart + `--resume`**; release → **`canUseTool` returns the decision** (no prompt to release) | **RETIRE** (subsumed by M12; proposal: "Subsumes `cli-control`") |
| **`apply_telegram_patch.py`** (inbox-queue monkey-patch) | don't drop inbound across reload/busy | **adapter contract's "queued+recoverable delivery"** (first-class) | **RETIRE** (becomes adapter responsibility) |
| **`apply_telegram_voice_patch.py`** (`sendVoice` monkey-patch) | render `.ogg` as a voice bubble | **Telegram adapter's native voice-out path** | **RETIRE** (built into the adapter) |
| **`transcribe_voice.py`** (faster-whisper STT) | inbound voice → text | **adapter STT step** (same logic, called by the adapter, not the session) | **KEEP logic, RE-HOME** behind the adapter (out-of-process helper) |
| **`tts_voice.py`** (edge-tts→OGG TTS) | outbound text → voice note | **adapter TTS step** | **KEEP logic, RE-HOME** behind the adapter |
| **Detached `Start-Process Hidden` clear+relaunch** | survive `/clear` with no live agent | **supervisor is the always-alive process**; clear = end+`--resume` a fresh session it spawns | **RETIRE** (the supervisor *is* the surviving process) |
| **Transcript `.jsonl` tail scraping** (receipts; controller reads) | observe I/O without a real channel | **the captured `stream-json` bus** | **RETIRE** (real byte-stream replaces scraping) |
| **`bypassPermissions` allow-list whack-a-mole** (`settings.local.json` `Bash(*)`+`PowerShell(*)`) | stop silent prompt-stalls | **`canUseTool` router** decides per-call; the allow-list becomes a *supervisor policy*, not a blanket bypass | **REPLACE** (policy moves into the router; D-note §2c "ship the allow-list as a `devkit init` artifact" still applies for the *project rules*, but the supervisor enforces it) |
| **M1 orchestrator skill, M6 controller** | the methodology | **unchanged logic, hosted inside the headless child** | **KEEP** (re-host, do not rewrite) |
| **The `/dev` pipeline scripts (`tools/dev-pipeline/`, Python)** | the script tier (M8) | unchanged; the supervisor shells/MCPs to them | **KEEP** |

**Migration safety (the core de-risking).** Per **P2 phasing** and §0.11, the supervisor is brought up **alongside** the current in-CLI orchestrator: Phase 1 **only adds** a channel adapter + transcript capture **as a parallel observer** (the existing orchestrator keeps running, keystroke glue intact) — **zero disruption, nothing retired**. Only once Phase 2 proves subprocess ownership + prompt-routing + resume do we **retire** the keystroke/patch glue (Phase 3). At every point there is a **known-good fallback** (D2 fallback A = stay-in-CLI; B = plugin).

---

# PART E — INCREMENTAL BUILD PHASES (the P2 order)

Each phase: **deliverables · acceptance criteria · verification surface**. Phases are sequential; each ends in a demonstrable, fallback-safe state. (P2 depends on **P1** — skills channel-agnostic — **already satisfied** by the H4 / generic-separation work.)

## Phase 1 — Channel adapter + transcript capture (alongside today's orchestrator)

**Goal:** stand up the supervisor skeleton + the **M10 adapter contract** + a **read-only capture** of the session's I/O — **without owning the subprocess yet** and **without retiring anything**. This is the smallest shippable, zero-disruption slice.

- **Deliverables**
  1. Supervisor skeleton (TS/Node): config load, structured logging, the **I/O bus abstraction**, graceful start/stop.
  2. The **channel-adapter contract** (interface) + the **Telegram reference adapter** (lift `server.ts`'s grammY logic into it; fold in the **inbox-queue** = queued/recoverable delivery, and **voice in/out** = STT/TTS, so both monkey-patches are obsoleted *in the adapter* even though the old session still runs).
  3. **Transcript capture**: consume the session's `stream-json` (initially by reading the session `--output-format stream-json` / the existing `.jsonl`) into a durable, queryable capture store — the seed of §2c observability.
- **Acceptance**
  - A Telegram message round-trips **through the adapter contract** (in→bus→out), including a **voice note both directions**, with **no plugin monkey-patch applied** (the adapter does it natively).
  - Inbound survives a simulated restart of the adapter (queue replay; nothing dropped) — the FC-2 delivery guarantee, proven in isolation.
  - The capture store holds a complete, replayable record of a session's events.
- **Verification surface:** a recorded round-trip transcript (text+voice) from the adapter + a queue-replay test (kill adapter mid-inbound → message still delivered) + the capture-store query showing the full event stream. *(Warn-first verification, D11.)*

## Phase 2 — Subprocess ownership (own the CLI, route prompts, programmatic I/O)

**Goal:** the supervisor **spawns and owns** headless Claude Code; **all I/O via the bus**; **permission prompts routed programmatically**. This is where FC-1 and FC-3 are *eliminated*.

- **Deliverables**
  1. Lifecycle manager: spawn the headless child via the **Agent SDK `query()`/`ClaudeSDKClient`** with M1 as the system prompt; capture **session id** from `system/init`. **[doc: sessions.md]**
  2. **`canUseTool` permission router**: allow-list fast-path; **route safety-floor (CP7) requests out over the channel** and block on the user's reply; deny on policy. **[doc: permissions.md]**
  3. **stream-json bidirectional I/O**: inject user turns (`--input-format stream-json`) and consume the event stream (incl. partial events) → fan-out to channel + panel + capture. **[doc: cli-reference.md, headless.md]**
  4. **Health-check + `--resume` restart** (FI) wired to the **FO** wait→wake. **[doc: sessions.md]**
  5. Programmatic **hooks + `mcpServers`** as SDK options (controller markers via a hook; project MCP servers configured here, not via editor reload). **[doc: hooks.md, typescript.md]**
- **Acceptance**
  - A task that triggers a tool-permission decision is **surfaced to the remote user and resolved over the channel** — **no terminal prompt, no stall** (FC-1 closed; reproduce the exact old stall scenario and show it now routes).
  - Killing the child mid-task → supervisor **restarts + resumes** the same session id and continues (FC-2 ownership half + FI, proven).
  - A full task runs **end-to-end with every byte on the bus** (FC-3 closed) while the **old in-CLI orchestrator can still be used as fallback** (both exist).
- **Verification surface:** a recording of (a) a permission decision routed+answered remotely, (b) a kill→resume continuation, (c) a full task's captured byte-stream. Measured **before/after** the old stall scenario.

## Phase 3 — Retire the glue + self-context-clean / recovery

**Goal:** make the supervisor the **default** host; **delete** the keystroke + monkey-patch glue; add **self-context-clean** and full **recovery** as supervisor mechanisms.

- **Deliverables**
  1. **Self-context-clean**: the orchestrator's intra-session clear+relaunch (today `cli-control clear`) becomes **end-session → spawn-fresh → `--resume`/re-bootstrap** under supervisor control (the SDK pattern is "end & start new"; **FLAGGED**: no in-session compact API in the SDK — design clear as new-session-from-snapshot). **[doc: sessions.md — compact-in-SDK not found]**
  2. **Recovery owner (FI)** fully assumed: reload/drift/stall all handled by supervised restart+resume.
  3. **Delete** `cli_control.ps1` + the `/cli-control` skill + both `apply_telegram_*` patches + the detached-Start-Process pattern; re-home STT/TTS as the adapter's helpers; switch M6 to the captured bus.
  4. Local **panel** to operator-grade: live transcript, pending approvals (click-to-approve), session/health, **cost + tier + stall + verification-evidence** views (§2c).
- **Acceptance**
  - The full methodology runs **only** through the supervisor (old glue removed) for a representative multi-task session with **no regression** vs the in-CLI baseline.
  - A remote `/clear`-equivalent + relaunch works **with no keystroke synthesis**.
  - Grep proves the retired files are gone and nothing references them.
- **Verification surface:** a representative session run end-to-end on the supervisor (recorded), a self-clean+resume recording, and a clean grep/CI for the deleted glue.

> **Note on P4 dependency.** The Campaign's **P4** ("wire the supervisor-based marker hook", split the Controller) depends on this M12 work — the **PostToolUse/PreToolUse marker hook** the controller wants is exactly an SDK hook the supervisor configures (Phase 2 deliverable 5). Flag the linkage; P4 lands after Phase 2.

---

# PART F — WHERE IT LIVES (repo location & timing)

**Decision D10 (locked):** the kit lives in a **new dedicated public repo** with its own CI. The supervisor is the kit's runtime — it ultimately belongs in that repo.

**Recommendation: stage in-repo first, extract at P5.** Build the supervisor under a **staging path in the dogfood repo** (e.g. `tools/supervisor/` — sibling to `tools/dev-pipeline/`) through Phases 1–3, then **extract to the new public repo** as part of **P5 (public release)**, together with the rest of the kit. Rationale:

- **Dogfooding** — the supervisor must drive *this* project's real orchestrator to be validated; staging in-repo keeps it next to the thing it hosts during the risky phases.
- **D9** keeps the dogfood project private and ships a **sanitized generic example** — so the *public* repo gets the supervisor + a generic `examples/` project, not Pianoid specifics; extraction at P5 is the natural sanitization point.
- **Avoids premature repo split** — a second repo + CI + cross-repo dev loop is overhead we don't want during Phase-1/2 churn.

**Counter-option (OD-2):** bootstrap the **new public repo now** and develop the supervisor there from Phase 1, pulling the dogfood project as a dev dependency. Cleaner final history; heavier day-1 setup + a cross-repo loop while the design is still moving. **Defer to the user (OD-2).**

> **Trace:** D10 (new public repo), D9 (sanitized example, dogfood private), P5 (release/extraction). Either way, **no second-repo commit is made under this proposal** — this doc only recommends.

---

# PART G — CROSS-PLATFORM

Windows is primary today; the kit is open-source → **Linux/macOS are first-class** (§2c "cross-platform parity as a first-class config concern"). The supervisor centralizes the platform-specific bits that are **scattered inline today**.

| Concern | Today (Windows-inline) | In the supervisor (resolved once) | Note |
|---|---|---|---|
| **Headless invocation** | n/a (interactive) | **SDK bundles the native binary per-platform** as an optional npm dep → uniform spawn | **[doc: agent-sdk/overview.md]** Win/Linux(glibc+musl)/macOS confirmed |
| **Process kill / restart** | `taskkill //F //PID`, port-scoped sweeps (`PROJECT_CONFIG.md#process-sweep`) | the supervisor **owns the child handle** → kill/restart via the process API, **no OS-specific kill** for the session itself | project-stack kills (Pianoid backend) stay project-config-resolved (M8) |
| **Interpreter / path** | per-OS roots in `PROJECT_CONFIG.md#repos`/`#interpreters` | resolved from config, not hard-coded in the supervisor | AP2/AP3 — supervisor stays project-agnostic |
| **Window driving** | `cli_control.ps1` SendKeys into the VS Code window | **deleted** — no window to drive | FC-3 removes the most Windows-coupled glue entirely |
| **Shell** | PowerShell 5.1 primary | SDK auto-detects shell; supervisor logic is Node (cross-platform) | **[doc: setup.md]** Windows needs Git-for-Windows or PowerShell; WSL2 ok, WSL1 not |
| **Voice helpers** | `winget` ffmpeg path fallbacks in `tts_voice.py` | adapter helper resolves ffmpeg/edge-tts per-platform (or documents the dep) | keep logic, generalize path resolution |

**Net:** the single most platform-specific component (keystroke window-driving) is **deleted**, not ported; the rest is Node (portable) + config-resolved project facts. **No Windows-only assumption survives in the supervisor core.**

---

# PART H — OPEN DECISIONS FOR THE USER

Crisp, one-by-one (per AP-cross-cutting "multi-issue → consecutive resolution"). Each carries the three meta-choices implicitly (go-as-recommended / decide-yourself / explain).

| # | Decision | Recommendation | Why it's open |
|---|---|---|---|
| **OD-1** | **Runtime: TypeScript/Node vs Python** for the supervisor shell | **TypeScript/Node** (C.1: most complete SDK surface, in-process MCP, one language for SDK+adapters+panel, Telegram adapter is already TS) | Existing dogfood tooling is Python; team familiarity may tip it. Python is a viable fallback (loses in-process SDK MCP). |
| **OD-2** | **Repo: stage in-repo (`tools/supervisor/`) now, extract at P5** vs **bootstrap the new public repo now** | **Stage in-repo, extract at P5** (PART F: dogfood next to its host; sanitize at extraction; avoid premature split) | D10 mandates a new repo *eventually*; only the *timing* is open. |
| **OD-3** | **Local panel scope: TUI vs minimal web** (and how much in Phase 1 vs Phase 3) | **Minimal web** (Node HTTP+WS) — drive-from-anywhere fits a browser; ship **read-only** in Phase 1, **approve-click + metrics** in Phase 3 | A TUI is lighter to build but isn't remote; a web panel overlaps the channel's role. Scope affects Phase-1 size. |
| **OD-4** | **How much of Phase 1 to build first** — full adapter contract + Telegram + voice + capture, or a thinner first cut (adapter + capture, voice later) | **Full Phase-1 as specified** (it's already the minimal zero-disruption slice; voice reuse is cheap) | If the user wants the very first PR even smaller, voice can defer to a Phase-1b. |
| **OD-5** | **Package name (D4, deferred)** | leave deferred; pick at P5 packaging | `hammock`/`offleash`/`codenomad` collide; not blocking design. |

> **Recommendation framing:** OD-1 (TS) and OD-2 (stage-in-repo) are the two that shape the first PR. If the user picks **go-as-recommended** on both, Phase 1 starts as a TS skeleton under `tools/supervisor/`.

---

# PART I — RISKS & FALLBACKS

| Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|
| **SDK can't do something the design assumes** (e.g. routing a permission to a *human over a channel and blocking* may need us to implement the "ask" as a `canUseTool` that awaits an async channel reply — confirmed the callback is async, but the *block-on-remote-human* pattern is **our** code on top) | low-med | high | The primitives are confirmed (`canUseTool` is async, returns allow/deny; **[doc: permissions.md]**). The remote-block is supervisor logic, not an SDK feature — **buildable**. If a gap appears: **D2 fallback A** = stay-in-CLI (keep today's glue), **B** = plugin. |
| **No in-session context-compact API** in the SDK | confirmed (FLAGGED) | med | Design self-clean as **end-session → new-session-from-snapshot → `--resume`-style re-bootstrap** (the documented "end & start new" pattern). Not a blocker; just not a one-call compact. **[doc: sessions.md]** |
| **Python SDK lacks in-process MCP** (if OD-1 → Python) | confirmed (FLAGGED) | low | Use an **external MCP child** for supervisor-provided tools; everything else (callbacks, hooks, resume) is present in Python. **[doc: python.md]** |
| **stream-json input multi-turn** edge cases (partial-message framing, backpressure) | med | med | Drive via the **SDK** (it owns the framing) rather than hand-parsing `claude -p`; keep raw CLI as a debug fallback. Phase-2 acceptance explicitly tests a full byte-stream task. |
| **MCP stdio drift still bites** the supervised child's MCP servers | med | med | MCP servers are **supervised with the child** (configured as SDK options, restarted with it) — drift → restart, not a manual editor reload. The chrome-devtools `@latest` lesson → pin versions in config. |
| **Migration regresses** the working orchestrator | low (by design) | high | **Runs alongside** through Phase 2; nothing retired until Phase 3 proves parity; **fallback A** always available; each phase ends fallback-safe. |
| **Telegram adapter lift** misses a behavior of the patched `server.ts` | med | low | The patches are small + documented (inbox-queue, sendVoice); fold their exact logic into the adapter and keep Phase-1 acceptance = "round-trip incl. voice, no monkey-patch". |

---

## Appendix — SDK capability ledger (citations)

Confirmed against the Claude Code docs (via the claude-code-guide research pass, 2026-06-14):

- **Headless / `claude -p`** — `--print`, `--output-format {text,json,stream-json}`, `--input-format {text,stream-json}`, `--include-partial-messages` (needs stream-json + `--verbose`), `--max-turns`, `--model`, `--system-prompt(-file)`, `--append-system-prompt(-file)`, `--permission-mode`, `--allowedTools`/`--disallowedTools`, `--permission-prompt-tool`, `--resume`/`--continue`/`--fork-session`, `--no-session-persistence`. **[headless.md, cli-reference.md]**
- **Agent SDK** — TS `@anthropic-ai/claude-agent-sdk`, Python `claude-agent-sdk`; entry `query()` (+ `ClaudeSDKClient`); both spawn the native Claude Code binary. **[agent-sdk/overview.md, typescript.md, python.md]**
- **stream-json** — NDJSON events: `system/init` (carries session_id, model, tools), `assistant`, `tool_*`, `stream_event` (partial `text_delta`), `result` (session_id, cost, success/`error_max_turns`); multi-turn **input** over stdin via `--input-format stream-json`. **[headless.md#stream-responses]**
- **Permissions** — `canUseTool` / `can_use_tool` async callback → allow / deny (+`updated_input`, `interrupt`); `PreToolUse` hook `permissionDecision`; permission modes; allow/deny rules; CLI `--permission-prompt-tool` (MCP). **[agent-sdk/permissions.md, hooks.md]**
- **Sessions** — `--resume <id>` / `--continue` / `--fork-session`; session id from `system/init`/`ResultMessage`; persisted to `~/.claude/projects/...jsonl`; **FLAGGED — no in-session compact API** (pattern = end & start new). **[agent-sdk/sessions.md]**
- **Hooks + MCP from SDK** — `hooks` + `mcpServers`/`mcp_servers` as `query()` options; **TS-only** in-process `tool()` + `createSdkMcpServer()`; **FLAGGED — Python in-process MCP not found**. **[agent-sdk/hooks.md, typescript.md, python.md]**
- **Cross-platform** — native binary for Win / Linux(glibc+musl) / macOS bundled by the SDK; Windows needs Git-for-Windows or PowerShell; WSL2 ok, WSL1 not. **[agent-sdk/overview.md, setup.md]**

*(Doc base: `https://code.claude.com/docs/en/...`. Every assumed capability above is confirmed or explicitly FLAGGED; none invented.)*
