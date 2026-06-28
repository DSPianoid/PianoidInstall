# Model-Agnostic ORCHESTRATOR (Tier-1) — Campaign Proposal

**Date:** 2026-06-22 · **Author:** `/analyse` (architecture design, max-rigor) · **Mode:** READ-ONLY study + this one doc.
**Status:** DRAFT — for user review (proposal lifecycle: Draft → Review/Approval → Active → Archive + Implementation Report). NO code written; NO live supervisor touched.
**Scope:** make the SUPERVISOR'S OWN HOSTED ORCHESTRATOR run on a **non-Claude model** (e.g. DeepSeek) — the Tier-1 piece the model-agnostic campaign *analyzed* (Q.3 named "Tier-1 = the orchestrator's own model") but built only for **Claude-tier** model swaps. Today a non-Claude orchestrator is structurally **impossible**: the orchestrator profile is hard-pinned to the `cli-stream` (`claude -p`) driver because it is the only backend exposing agent-teams, which the orchestrator skill hard-requires.

**Relationship to prior docs (one-doc-per-topic — extend, do not duplicate):**
- **NEW SIBLING TOPIC.** Verified no existing proposal covers a *non-Claude orchestrator*: `grep -i 'tier-1|non-claude.*orchestrator|model-agnostic orchestrator'` over `docs/proposals/` hits only (a) this campaign's **Tier-2** dispatch layer and (b) the control-plane's Tier-1 **model selector** (`CONTROL_MODEL_CHOICES` — Claude ids only: opus/sonnet/haiku). Neither makes the orchestrator process itself a non-Claude model. **No archival performed.**
- **EXTENDS** `docs/proposals/model-agnostic-agents-2026-06-19.md` (the governing campaign). That doc made the **agents the orchestrator dispatches** model-agnostic (the `SessionDriver` contract + role-router + backend-registry + `ApiAdapterDriver` + the live dispatch surface + `/setkey`/`/setrole`/`/roles` + the P6 activation switch). THIS doc generalizes one layer **up**: the **orchestrator process** itself becomes model-agnostic. The campaign is the foundation; it is **demoted to a REFERENCE** for this sibling (the spawner-demotion rule). Its `CP`/`AP`/`FD`/`OD` ids are cited verbatim below.
- **EXTENDS** `docs/proposals/standalone-process-agents-2026-06-19.md` (PART C containment, PART D hybrid, PART E.1 the cheap de-risking probe, OD-1..4). Its containment seal + its "measure before you build" discipline govern the orchestrator process exactly as they govern a dispatched agent.
- **Sits beside** `m12-host-supervisor-app-2026-06-14.md` (the host that owns ONE orchestrator child) and `m12-supervisor-architecture-review-2026-06-17.md` (the `SessionDriver`-seam decision). Those govern the *single hosted orchestrator*; this changes *what model that one orchestrator runs on*.

> **How to read.** §1 Goal + non-goals. §2 Ground truth (verified against the just-pushed `origin/master` code; every claim file:line). §3 The architecture — the 5 pieces, each wired into the existing seam, citing the files it extends. §4 The phased build plan (smallest-first; reusable vs net-new). §5 Key decisions (each with a recommendation). §6 Risks (the big one: *can a non-Claude model drive the orchestrator role at all* → a cheap probe FIRST). §7 What's reusable from what shipped. §8 Traceability. Every code claim carries a file:line; every campaign element carries its `CP`/`AP`/`FD`/`OD` id.

---

# §1 — GOAL + NON-GOALS

## 1.1 Goal

Let the user select a **non-Claude model as the orchestrator's own backing model** (Tier-1), so the supervisor can host (for example) a **DeepSeek orchestrator** that receives tasks over the channel, **acts** (reads/edits files, runs shell, curls the dispatch surface), **coordinates** sub-work, and reports back — all behind the **existing `SessionDriver` seam**, with the **existing containment**, **without breaking** the live Claude-hosted orchestrator (which stays the default).

The campaign already proved the *contract* is model-agnostic for **leaf agents** (a bare DeepSeek compute turn). The orchestrator is harder because it is **long-lived, multi-turn, tool-using, and coordinates other agents** — the four things the one-shot `ApiAdapterDriver` deliberately does NOT do (`api-adapter-driver.ts:469-471,640-645`). This proposal designs those four capabilities onto the same seam.

## 1.2 Non-goals

- **NOT** removing or weakening the Claude orchestrator. Claude (cli-stream, Opus 4.8[1m]) stays the DEFAULT and the fail-safe (CP5 host-safety first). A non-Claude orchestrator is an **opt-in alternative**, dormant until a switch + restart.
- **NOT** running the non-Claude orchestrator as Claude Code. It is **not** `claude -p` — it has no `settingSources`, no plugins, no skills, no in-process Agent/Task/SendMessage. (That is the entire point — and the source of pieces #2 and #4.)
- **NOT** porting the `.claude/commands/orchestrator.md` skill verbatim. A non-Claude orchestrator gets its role from a **system-prompt brief** + a **tool manifest**, not from Claude Code's skill loader (§3.1).
- **NOT** an N-host distributed system, a new web UI, or a new channel. Single machine, single supervisor, single channel — unchanged.
- **NOT** decided here: whether to actually run production on a non-Claude orchestrator. This delivers the *capability* + a **de-risking probe** (§6.1) that must pass before anyone commits a model to the role.

---

# §2 — GROUND TRUTH (verified against `origin/master`, 2026-06-22)

## 2.1 Why a non-Claude orchestrator is impossible today

| Fact | Evidence |
|---|---|
| The orchestrator profile **hard-defaults to `cli-stream`** "because ONLY the CLI exposes agent-teams (SendMessage/Monitor/Task*), which the orchestrator skill REQUIRES" | `profiles.ts:58-63,237-239` |
| The composition root constructs the session with `model: config.orchestratorModel ?? profile.model` — but `profile.model` is `'claude-opus-4-8[1m]'` and the **driver is the profile default (`cli-stream`)** regardless of the model string | `index.ts:545`; `profiles.ts:242` |
| Tier-1 model selection EXISTS but is **Claude-only**: `SUPERVISOR_ORCHESTRATOR_MODEL` is read at construction (`config.orchestratorModel`), and the change-model menu offers only `claude-opus-4-8[1m]`/`claude-sonnet-4-6`/`claude-haiku-4-5` | `config.ts:660-671`; `control-command.ts:229-233` |
| The `cli-stream` driver IS genuinely multi-turn + tool-capable: a persistent `claude -p --output-format stream-json --input-format stream-json` child; `send()` writes each new user turn to stdin; permission routing carries `agent_id` | `cli-stream-driver.ts:6,197,627-630`; (permission routing) campaign Appendix |

So: feeding `SUPERVISOR_ORCHESTRATOR_MODEL=deepseek-…` today would pass a non-Claude model string **to a `claude -p` child** — nonsense. The **driver**, not just the model string, must change when the model is non-Claude.

## 2.2 What the campaign already shipped that this reuses (the seam is ready)

| Built artifact | What it gives this proposal | Evidence |
|---|---|---|
| `SessionDriver` contract (`start`→`AsyncIterable<SessionEvent>`, `send`, `interrupt`, `stop`, `health`) + `BackendCapabilities` descriptor | THE seam a non-Claude orchestrator driver implements — no new contract | `session-driver.ts:167-225` |
| `LifecycleManager` owns ONE driver: `driver.start(startOpts)` then `driver.send(turn)` per turn; restart/resume/watchdog | The orchestrator-hosting machinery is **already driver-agnostic** — swap the driver, keep the host | `lifecycle.ts:261,456-461`; `session-driver.ts:162-166` |
| `ApiAdapterDriver` (OpenAI-compatible: request build, SSE→event map, cost/token accounting, injected HTTP client, clean-error→surfaced result) | ~80% of a multi-turn driver: everything except the conversation loop + a tool-call loop. `send()` is the ONLY rejected method | `api-adapter-driver.ts:280-305,337-403,472-660` |
| Provider registry (DeepSeek/OpenAI/Groq/Gemini, all OpenAI-compatible by config; `secretEnvVar` per provider) | The non-Claude orchestrator's model + key come from the SAME table; no new provider plumbing | campaign Q.1; `provider-registry.ts` (DEFAULT_PROVIDERS) |
| **Dispatch surface** — `POST /api/dispatch {role,task}` (`panel.ts:281-309`) → `SessionHost.dispatchRole` (`session-host.ts:2399-2430`) → `dispatchRoleAgentWithFallback` (`result-relay.ts:332-400`) | The orchestrator's **teams-replacement**: a sealed spawn+coordinate primitive callable over loopback REST. This is the crux of piece #2 | as cited |
| `AgentConcurrencyGate` (cap 24; per-dispatch + rolling USD caps; sole spend-ledger owner) | The concurrency + cost cap is built AND already wired into the dispatch closure | `agent-concurrency.ts:25-75`; `index.ts:308-311,348-376` |
| Backend-aware seal + cost guard (`sealBackendOptions`, `assertBackendCostSafe`, `UNIVERSAL_CHANNEL_DENY`, scoped per-provider key) | The containment a sealed agent gets; this proposal extends it to the orchestrator PROCESS | `backend-seal.ts:67-70,158-172`; `cost-safety.ts:189-264` |
| Change-model restart: `restartControl` → `setOrchestratorModel` → `LifecycleManager.setModel` + drain + handoff re-inject | The Tier-1 swap flow already exists; the handoff is a **text brief** (model-agnostic by construction) | `index.ts:420-432`; `session-host.ts:1768-1789,2516-2519`; `config.ts:174-208` (startupHandoff) |

## 2.3 The orchestrator's hard requirement, decomposed

`.claude/commands/orchestrator.md` requires "teams" — but "teams" is really **three capabilities**, and only the first is Claude-Code-specific:

1. **Spawn a sub-agent** to do focused work (today: in-process `Agent`/`Task`). → replaceable by the **dispatch surface** (already built; §3.2).
2. **Coordinate / monitor** running sub-agents (today: `SendMessage`/`Monitor`/`TaskList`). → replaceable by a **coordinate/monitor/await REST surface** extending dispatch (§3.2).
3. **Act directly** — read/edit files, run shell, curl loopback (today: `Read`/`Edit`/`Bash`/`PowerShell`). → replaceable by a **tool-call loop** in the multi-turn driver (§3.1).

This decomposition is the key insight: **the orchestrator does not need Claude Code's in-process team mechanism; it needs spawn + coordinate + act, all of which can be supervisor-mediated tools.** That converts "impossible (no teams off-CLI)" into "an OpenAI tool-calling loop whose tools are supervisor REST endpoints."

---

# §3 — THE ARCHITECTURE (the 5 pieces, each wired into the existing seam)

```
 user ── channel ──>  SUPERVISOR (single channel owner; UNCHANGED)
                          │
                          │  Tier-1 driver SELECTED BY MODEL (piece #3):
                          │    model is Claude  → cli-stream (claude -p)         [UNCHANGED default]
                          │    model is non-Claude → MULTI-TURN ADAPTER DRIVER   [NEW, piece #1]
                          ▼
                  LifecycleManager  (owns ONE SessionDriver — already driver-agnostic)
                          │  drives start()/send() + restart/resume/watchdog (REUSED)
                          ▼
            ┌─────────────────────────────────────────────────────────────┐
            │  MultiTurnAdapterDriver (piece #1) — implements SessionDriver  │
            │   • persistent OpenAI-compatible chat: messages[] grows        │
            │   • send() appends a user turn + runs the next assistant turn  │
            │   • TOOL-CALL LOOP: assistant tool_calls → run tool → feed     │
            │     tool result back → loop until a final text turn            │
            │   • tools = a fixed manifest (piece #2 + the act tools)        │
            └─────────────────────────────────────────────────────────────┘
                          │ tool calls route to ↓ (piece #4: the sealed choke-point + permission router)
            ┌──────────────────────────────┬──────────────────────────────┐
            ▼                              ▼                              ▼
   ACT tools (fs/shell/http)     COORDINATE tools (piece #2)      report-to-user
   → permission router            → POST /api/dispatch + the       → an assistant text
     (reuse FC-1 block-on-reply)    NEW coordinate/monitor/await     turn → supervisor
   → seal: channel-mute,           surface → sealed sub-agents       forwards to channel
     scoped keys, no foreign key     (REUSES result-relay)            (AP6 / existing auto-out)
```

## 3.1 Piece #1 — A multi-turn, tool-capable adapter driver

**Concern.** A `SessionDriver` for a non-Claude (OpenAI-compatible) model that holds a **growing conversation** and runs a **tool-call loop**, so the orchestrator can act over many turns. **Extends `ApiAdapterDriver`** (`api-adapter-driver.ts`) — it reuses that file's request builder, SSE parser, token/cost accounting, injected HTTP client, and clean-error discipline; it adds (a) a persistent `messages[]` that `send()` appends to, (b) a per-turn `tools` array in the request, (c) the loop that executes returned tool calls and feeds results back.

**Wired into the seam.** It implements `SessionDriver` (`session-driver.ts:167-196`) exactly like `ApiAdapterDriver` does — so `LifecycleManager` (`lifecycle.ts:261,456-461`) drives it with **zero host changes**. Its capability descriptor (`session-driver.ts:213-225`) reports `supportsTools:true, supportsPermissionRouting:true, supportsTeams:false` — distinct from the bare api-adapter's all-false (`backend-kinds.ts:78-83`).

**The OpenAI tool-calling schema (the conversation grammar).** The driver speaks the standard OpenAI `/chat/completions` tool protocol (which DeepSeek/Groq/Gemini-compat all honor):
- **Request** carries `tools: [{type:'function', function:{name, description, parameters:<JSON-Schema>}}]` and `tool_choice:'auto'`. The request builder is the EXISTING `buildChatCompletionRequest` (`api-adapter-driver.ts:280-305`) plus these two fields.
- **Assistant turn** may return `choices[0].message.tool_calls: [{id, function:{name, arguments:<json-string>}}]` (instead of, or alongside, `content`). The driver maps each `tool_call` → a normalized `SessionEvent` of `kind:'assistant'` with `toolUses:[{id,name,input}]` (the contract already has `ToolUse` — `session-driver.ts:26-34,54-60`).
- **Tool result feedback.** For each executed tool, the driver appends an OpenAI `{role:'tool', tool_call_id:<id>, content:<result>}` message to `messages[]`, then issues the NEXT completion. This is the loop. The contract already has `kind:'tool_result'` (`session-driver.ts:61-68`) for the event stream the host consumes.
- **Termination.** The loop ends when an assistant turn returns `content` with **no** `tool_calls` (a final answer) → the driver emits one terminal `result` event (success), exactly as the one-shot adapter does today (`api-adapter-driver.ts:577-594`). A turn cap (e.g. 40 tool iterations) bounds runaway loops → terminal `result` with an error subtype.

**`send()` becomes real.** Today `send()` throws (`api-adapter-driver.ts:640-645`). In the multi-turn driver, `send(turn)` appends `{role:'user', content:turn.text}` to `messages[]` and triggers the next assistant turn (+ its tool loop). This is the direct analog of `CliStreamDriver.send()` writing a user turn to stdin (`cli-stream-driver.ts:627-630`) — same seam contract, different transport.

**How tool results feed back (the data path).** A returned `tool_call` is dispatched through piece #4's choke-point (which runs the actual fs/shell/http/coordinate operation under the permission router + seal), and the operation's stringified output becomes the `{role:'tool', …}` message. Errors (a denied permission, a failed shell command, a network error) are fed back as the tool result `content` (e.g. `"DENIED by operator"` / `"exit 1: <stderr>"`) so the model can react — never thrown (CP5: a tool failure must not wedge the orchestrator).

**Error / timeout handling (reuse + extend).**
- Per-completion: REUSE the adapter's existing total-catch → clean surfaced `result` (`api-adapter-driver.ts:595-630`), its `ApiAdapterHttpError` mapping (`:610-621`), and its per-call `timeoutMs` abort (`:419-431`). No thrown crash, no leaked key — already proven.
- Per-tool: a tool that hangs is bounded by the SAME per-turn watchdog the host already owns (`lifecycle.ts:356`, the `interrupt()` path), plus an inner per-tool timeout in the choke-point (piece #4).
- Loop-level: the turn cap + a cumulative wall-clock budget. A breach → terminal `result` error subtype; the host's restart/resume machinery (`lifecycle.ts`) recovers exactly as for a Claude crash.

## 3.2 Piece #2 — A teams-replacement: a supervisor-mediated spawn + coordinate + monitor surface

**Concern.** Replace in-process `SendMessage`/`Monitor`/`Task*` with **supervisor REST tools** the orchestrator invokes from its tool-call loop, so it never needs `claude -p` teams. **Extends the now-live `POST /api/dispatch`** (`panel.ts:281-309`) into a small **coordinate/monitor/await** family.

**The dispatch primitive already exists and is the foundation.** `SessionHost.dispatchRole(role, task)` (`session-host.ts:2399-2430`) → `dispatchRoleAgentWithFallback` (`result-relay.ts:332-400`) already: resolves role→backend (`role-router.ts`), seals the spawn (`backend-seal.ts`), runs the agent to completion, returns a structured `RoleDispatchResult`, and the agent is **channel-mute** (only the report returns — AP6). That IS "spawn a sub-agent + get its report," supervisor-mediated, today. The synchronous `dispatch` call already covers the common orchestrator pattern: *delegate a unit of work, await the report, act on it.*

**What to ADD (the monitor/coordinate gap).** `dispatch` today is **blocking + fire-and-await-one**. The orchestrator's `Monitor`/`SendMessage` patterns need **concurrent, observable, addressable** sub-agents. Extend the surface (additive new endpoints on `panel.ts`, new `SessionHost` methods mirroring `dispatchRole`):

| New tool (REST + SessionHost method) | Replaces | Behavior |
|---|---|---|
| `POST /api/dispatch/async {role,task}` → `{agentId}` | `Task`/`Agent` spawn (non-blocking) | Start a sealed agent, return a handle immediately; the agent runs under the SAME `dispatchRoleAgentWithFallback` + the SAME concurrency/cost gate (`agent-concurrency.ts`) |
| `GET /api/dispatch/status?agentId=` → `{state, partial?}` | `Monitor` | Poll a running agent's state (running/done/failed) + its final report when done |
| `POST /api/dispatch/await {agentId, timeoutMs}` → report | `Monitor`(block) | Block up to `timeoutMs` for an agent to finish (the model's tool loop can "wait for the team") |
| `POST /api/dispatch/cancel {agentId}` | `TaskStop` | Stop a running agent (reuse `driver.stop()` in result-relay) |
| (`POST /api/dispatch` synchronous — UNCHANGED) | the common case | spawn+await-one in a single call (already live) |

**Wired into the seam.** Every new endpoint is a thin `panel.ts` route → a `SessionHost` method that is the structural mirror of the shipped `dispatchRole` (`session-host.ts:2399-2430`) — same injected `dispatchRoleAgent` closure (`index.ts:313-386`), same `AgentConcurrencyGate`, same seal, same channel-mute. The ONLY net-new state is an **agent registry** (a `Map<agentId, {promise, state, report}>`) the async endpoints read — a small generalization of "run one and await" to "run several and observe." The coordinated agents are the SAME sealed backends the campaign already builds (Claude cli-stream OR api-adapter, per role-routing) — so a DeepSeek orchestrator can dispatch a Claude planning agent or a DeepSeek coding agent identically.

**Crucially, this surface is model-agnostic and useful to the CLAUDE orchestrator too** — the Claude orchestrator can `curl` it instead of (or alongside) in-process teams. So piece #2 is not throwaway non-Claude scaffolding; it is a general supervisor capability that also de-risks the campaign's existing dispatch story.

## 3.3 Piece #3 — Driver selection by model

**Concern.** When `SUPERVISOR_ORCHESTRATOR_MODEL` resolves to a **non-Claude** model, the orchestrator profile must resolve to the **multi-turn adapter driver** instead of `cli-stream`; and the change-model menu must **offer** non-Claude models.

**Wired into the seam (one pure resolver + two small edits).**
- **A pure `resolveOrchestratorDriver(model)`** (mirrors `driver-policy.ts` / `role-router.ts` — a side-effect-free decision): if the model id matches a registry provider's model (or carries a provider prefix), return `'api-adapter-multiturn'`; else `'cli-stream'` (the proven default). This is the SAME pattern the role-router uses to map a model→backend (`role-router.ts:106-134`); the orchestrator is just "role = the orchestrator itself."
- **`index.ts` composition** (`index.ts:545` neighborhood): today `model` is chosen but the driver is the profile default. Add: when `resolveOrchestratorDriver(config.orchestratorModel)` is the multi-turn adapter, construct **that** driver for the `LifecycleManager` (with the provider's `secretEnvVar` scoped into the orchestrator env via the seal), the orchestrator brief as `systemPrompt`, and the tool manifest. When it resolves to `cli-stream`, **byte-for-byte today**. This is gated so the default (no env, or a Claude model) is unchanged — the CP5/AP5 dormant-rollout discipline the campaign already uses (`config.ts:210-230`).
- **`CONTROL_MODEL_CHOICES`** (`control-command.ts:229-233`): add the wired non-Claude orchestrator models (e.g. `deepseek-…`) so the `/control → Change model` submenu offers them. The change-model→restart flow (`session-host.ts:1768-1789` → `restartControl` `index.ts:420-432`) **already** does drain + handoff + relaunch on the new model — it just needs the driver to switch with the model (the resolver above), which the relaunch re-runs at construction.

**Why driver-by-model and not a separate `--orchestrator-driver` flag:** the model uniquely determines the viable driver (a non-Claude model CANNOT use cli-stream; a Claude model SHOULD use cli-stream for teams). Coupling them removes an inconsistent-config footgun (model X + wrong driver). An explicit override env can still exist for experiments (mirrors `SUPERVISOR_DRIVER`).

## 3.4 Piece #4 — Containment for a non-Claude orchestrator

**Concern.** A non-Claude orchestrator is **not** Claude Code (no `settingSources`/plugin/skill surface — so the telegram-plugin hijack vector that PART C of standalone-process-agents fixes simply *does not exist* for it). But its **tool calls + spawns** must still route through the sealed choke-point, the permission router, and the single-poller / channel-mute invariants.

**Wired into the seam (reuse the campaign's containment, applied to the orchestrator process).**
- **Choke-point for the orchestrator's OWN tools.** Every fs/shell/http tool the orchestrator's loop invokes runs through ONE supervisor primitive (NOT raw `child_process` from the driver) that applies the permission policy. REUSE the EXISTING `PermissionRouter` + the orchestrator profile's policy (`profiles.ts:255-343`): the SAME allow-list / `fallback:'route'` / safety-floor predicate (`isDestructiveOp` — `profiles.ts:85-107`) that gates the Claude orchestrator's Bash/Edit gates the non-Claude orchestrator's tool calls. The block-on-reply FC-1 guarantee (`session-driver.ts:110-115`, `PermissionHandler`) is the same. **This is the load-bearing safety claim: a non-Claude orchestrator's `Bash("git push")` routes to the user for approval exactly like the Claude orchestrator's does** — because the gate is in the supervisor's tool layer, not in Claude Code.
- **Seal on the orchestrator process.** REUSE `sealBackendOptions('api-adapter', …)` (`backend-seal.ts:158-172`) + `assertBackendCostSafe` (`cost-safety.ts:256-264`): the orchestrator's env carries ONLY its provider's key (e.g. `DEEPSEEK_API_KEY`) and NO foreign billing key (no Anthropic key, no other provider key). The `UNIVERSAL_CHANNEL_DENY` (`backend-seal.ts:67-70`) keeps it channel-mute at the tool layer (it cannot be granted a telegram tool).
- **Single-poller / channel-mute invariant.** The supervisor remains the SOLE channel owner; the orchestrator reaches the user ONLY by emitting an assistant-text turn the supervisor forwards (the existing auto-out path — `profiles.ts:244-250`, `suppressAutoOutbound:false`). The orchestrator's coordinate tools (piece #2) spawn ONLY channel-mute sealed sub-agents (AP6, already enforced by `result-relay`). So the "only the supervisor touches the channel; agents reach the user only via the orchestrator" rule (standalone PART C #2) holds unchanged.
- **The one genuinely-new containment surface: the non-Claude model provider sees the conversation.** A Claude orchestrator's transcript stays on the Claude subscription; a DeepSeek orchestrator's full transcript (including any file contents it reads into context) is sent to DeepSeek's API. This is a **data-egress** consideration distinct from the token-hijack class. Surfaced as a decision (§5 D-G), not silently accepted.

## 3.5 Piece #5 — Confirm change-model snapshot→restart→handoff works for a non-Claude target

**Confirmed by construction — the handoff is a text brief.** The Tier-1 change-model flow already: composes a handoff note (`composeHandoffNote` → `session-host.ts:1773`), sets the next-launch model (`setOrchestratorModel` → `LifecycleManager.setModel`, `session-host.ts:2516-2519`), drains + restarts (`restartControl` `index.ts:420-432`), and re-injects the note into the fresh session's FIRST turn (`config.ts:174-208` `startupHandoff`, applied after the role prefix). **Nothing in that path is Claude-specific** — the snapshot is plain text, the model is a string, the re-injection is a user-turn prepend. So switching Claude→DeepSeek (or DeepSeek→Claude) carries the conversation across **with only the piece-#3 driver-by-model resolver added** (so the relaunch builds the right driver for the new model). The role-adoption "first turn" for a non-Claude orchestrator is its **brief is the system prompt** + the handoff is its first user turn — the same shape, minus the `/orchestrator` skill token (which is meaningless off-CLI; replaced by the brief).

**Net:** piece #5 requires NO new restart machinery — only that piece #3's resolver runs at the post-restart construction (which it does, since the driver is chosen at construction from `config.orchestratorModel`).

---

# §4 — PHASED BUILD PLAN (smallest-first; reusable vs net-new)

All phases: **READ-ONLY on the live host, additive, default-OFF.** The non-Claude orchestrator is selected ONLY when `SUPERVISOR_ORCHESTRATOR_MODEL` is a non-Claude id AND a switch is on; the Claude path is byte-for-byte the default. No commit/branch/build/restart of the live supervisor by the design pass.

| Phase | Scope (one line) | Reusable vs net-new | Tests | Verification surface |
|---|---|---|---|---|
| **T0 — De-risking probe (do FIRST, §6.1)** | A throwaway script: drive a chosen non-Claude model (DeepSeek) through ~5 representative orchestrator turns (read a file, decide, dispatch, summarize) via the OpenAI tool-calling API and SCORE whether it can hold the role | NET-NEW (throwaway; not shipped) | n/a (a probe) | a written go/no-go: does the model follow the brief, emit valid tool_calls, recover from a tool error, stay on task across turns? |
| **T1 — Multi-turn driver (no tools yet)** | Extend `ApiAdapterDriver` → a `MultiTurnAdapterDriver`: persistent `messages[]`, real `send()`, conversation loop, terminal `result` per turn. NO tool-calls yet (pure chat). | REUSE the adapter's request/SSE/cost/error code; NET-NEW the conversation loop + `send()` | unit (injected HTTP client, canned multi-turn responses): `send()` appends + runs the next turn; N turns accumulate; capability descriptor | harness: host a chat-only non-Claude session behind the seam; it answers across turns (no acting yet) |
| **T2 — Tool-call loop (ACT tools)** | Add the OpenAI tool schema + the tool-call loop; wire the ACT tools (Read/Edit/Bash/PowerShell/curl) through the EXISTING `PermissionRouter` + orchestrator policy (piece #4). | REUSE `PermissionRouter`/`profiles` policy/seal; NET-NEW the loop + the tool manifest + tool-runner choke-point | unit: a tool_call → tool runs → result fed back → loop continues to a final text; a DENIED permission feeds back "denied" not a crash; turn cap bounds the loop | harness: a non-Claude session reads a file + runs a safe shell cmd, with a destructive cmd ROUTED to the operator |
| **T3 — Coordinate surface (teams-replacement)** | Add `POST /api/dispatch/async` + `status`/`await`/`cancel` + the agent registry; expose them as orchestrator tools (piece #2). | REUSE `dispatchRoleAgentWithFallback` + the concurrency/cost gate; NET-NEW the async endpoints + the agent registry | unit: async dispatch returns a handle; status/await observe it; cap enforced; cancel stops it | harness: a non-Claude orchestrator spawns 2 sealed sub-agents, awaits both, summarizes — all sub-agents channel-mute |
| **T4 — Driver-by-model selection + menu** | `resolveOrchestratorDriver(model)`; wire `index.ts` to build the multi-turn driver when the model is non-Claude (switch-gated); add non-Claude ids to `CONTROL_MODEL_CHOICES`. | REUSE the change-model/restart/handoff flow + `driver-policy` pattern; NET-NEW the resolver + 2 small edits | unit: resolver maps Claude→cli-stream, non-Claude→multi-turn; OFF/Claude path byte-for-byte; the menu lists the new ids | harness: `/control → Change model → deepseek-…` restarts onto the non-Claude orchestrator; switching back restores Claude |
| **T5 — Containment hardening + activation** | Confirm the seal/cost-guard/channel-mute on the orchestrator process end-to-end; the data-egress decision (§5 D-G) surfaced; the user-triggered rebuild/restart to go live. | REUSE the seal + cost guard + single-poller; NET-NEW only the activation wiring + docs | e2e on the TEST bot first | live: a user-approved rebuild/restart can select a non-Claude orchestrator; rollback = unset the env (→ Claude default) |

**Ordering rationale (CP7 + the decision hierarchy):** the **probe (T0) gates everything** — if a non-Claude model cannot hold the role, the rest is moot (§6.1). Then build the contract pieces smallest-first: chat (T1) before tools (T2) before coordination (T3); selection (T4) once a non-Claude orchestrator can actually act + coordinate; activation (T5) last + separately approved (CP5 first). T1–T3 are testable entirely behind the seam with the injected HTTP client — **no live host, no real paid call** until T5.

---

# §5 — KEY DECISIONS (each with a recommendation)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| **D-A** | **Multi-turn via EXTENDING `ApiAdapterDriver` vs a NEW sibling driver?** | **A new sibling class `MultiTurnAdapterDriver` that REUSES the one-shot adapter's pure helpers** (`buildChatCompletionRequest`, `iterateSsePayloads`, `parseStreamPayload`, `computeCostUsd`, the HTTP client) but is its OWN `SessionDriver`. | The one-shot adapter is deliberately one-shot (its `send()` throws; its `start()` is a single turn — `api-adapter-driver.ts:469-471`). Multi-turn + a tool loop is a different lifecycle; bolting state onto the one-shot class would muddy the clean leaf-agent contract the campaign relies on (CP1). Reuse the *helpers* (they are already exported + pure), not the *class shape*. (Mirrors how `CliStreamDriver` and `SdkSessionDriver` are siblings, not subclasses.) |
| **D-B** | **The tool-loop approach: OpenAI native `tool_calls`, or a text-protocol (ReAct-style "Action: …")?** | **OpenAI-native `tool_calls`** (the `tools`/`tool_choice`/`tool_call_id` protocol). | All wired providers (DeepSeek/OpenAI/Groq/Gemini-compat) support it; it is structured (no brittle text parsing), maps cleanly onto the existing `ToolUse`/`tool_result` events (`session-driver.ts:26-34,61-68`), and is the same protocol the campaign's request builder already targets. A text-protocol is a fallback ONLY if the probe (T0) shows a chosen model's native tool-calling is weak — keep it as a documented escape hatch, not the default. |
| **D-C** | **Does the orchestrator run FULLY on the adapter, or stay a THIN coordinator (non-Claude plans/coordinates; Claude/sub-agents do the heavy lifting)?** | **Thin-coordinator-first, full-capable by construction.** Build the full tool loop (so it CAN act), but in the brief + the recommended pattern, steer the non-Claude orchestrator to **coordinate** (dispatch heavy `/dev`/`/analyse` to sealed sub-agents) and act directly only for light glue (read a file, curl status). | The campaign's whole thesis is best-model-per-role (CP2): judgment/coordination is cheap to run on a non-Claude model, but deep CUDA/code work should still route to the best sub-agent (which may itself be Claude). Forcing the non-Claude orchestrator to do everything itself wastes the dispatch layer that already exists. Full capability stays available (no artificial limit) — the *guidance* is thin-coordinator. This also bounds the data-egress surface (D-G): less heavy work in the orchestrator's own context = less sent to the non-Claude provider. |
| **D-D** | **Spawned-CLI vs SDK for the COORDINATED sub-agents the non-Claude orchestrator dispatches?** | **Reuse the campaign's existing choice — per-role backend via `role-router` (cli-stream for team/skill parity, api-adapter for leaf compute).** No new decision; the coordinated agents are EXACTLY the campaign's routed agents. | Piece #2 dispatches through `dispatchRoleAgentWithFallback`, which already resolves role→backend (`result-relay.ts`, `role-router.ts`). A non-Claude orchestrator dispatching a Claude planning agent or a DeepSeek coding agent is the campaign's FD1 unchanged. (This is also why piece #2 reuses, not reinvents, the dispatcher.) |
| **D-E** | **The concurrency cap for a non-Claude orchestrator's coordinated agents.** | **Reuse `AgentConcurrencyGate` (default 24; per-dispatch + rolling USD caps).** Start conservative for a non-Claude orchestrator's fan-out (e.g. 3–5 concurrent) until the probe + early use calibrate it (mirrors standalone OD-4). | The gate is built AND already wired into the dispatch closure (`index.ts:308-311`). A non-Claude orchestrator using the async coordinate surface goes through the SAME gate — no new mechanism, just a (config) ceiling. The binding limit is local RAM/CPU + the providers' rate limits, not seats (standalone A.3). |
| **D-F** | **Which non-Claude model to target FIRST?** | **DeepSeek** (`deepseek-…`) — the campaign's coding backend, with a measured codegen track record, an existing key path (`/setkey` + the deepseek-key-bridge), and the cheapest tier; it is also the model the user named. | Lowest-friction: provider already wired (`provider-registry.ts`), key intake already built, cost lowest. The probe (T0) targets DeepSeek; Groq/Gemini/OpenAI are later, free additions (same driver, different `baseUrl`/`model`/`secretEnvVar`). |
| **D-G** | **Data egress: a non-Claude orchestrator's full transcript (incl. file contents it reads) is sent to that provider's API. Acceptable?** | **Surface it; recommend a per-provider acknowledgement at activation + the thin-coordinator default (D-C) to minimize what enters the orchestrator's own context.** Do NOT block on it for the probe (the probe uses only synthetic tasks). | This is the one genuinely-new exposure a non-Claude orchestrator adds beyond the campaign's leaf agents (which already send their task to the provider). It is a deliberate, user-visible trade (CP3/CP4 spirit: containment is about not LEAKING credentials/channel; data-egress to a chosen provider is a policy choice the user makes knowingly). The thin-coordinator pattern keeps heavy/sensitive work in sealed sub-agents whose provider the user picks per role. |
| **D-H** | **Permission UX for a non-Claude orchestrator's tool calls — same router, or auto-allow more?** | **Same `PermissionRouter` + the EXACT orchestrator policy** (`profiles.ts:255-343`): read/compute auto-allow, destructive ops route to the user (block-on-reply). No relaxation. | CP3 > CP4 > CP1 (the decision hierarchy): a non-Claude orchestrator is NOT more trusted; if anything its tool-calling is less battle-tested, so the safety floor matters MORE. Reusing the identical policy means a non-Claude orchestrator's `git push`/`rm -rf`/outward-send routes for approval exactly as Claude's does — the user's safety expectation is invariant across the orchestrator's model. |

---

# §6 — RISKS

## 6.1 ★ THE BIG ONE — can a non-Claude model reliably drive the orchestrator role at all? (de-risk FIRST)

This is the analog of standalone-process-agents **E.1** (run the cheap experiment before committing). The orchestrator role is demanding: hold a long multi-turn plan, emit **valid** tool_calls, interpret tool results, recover from a denied permission / a failed command, decide *when to dispatch vs act*, and stay on-task — all WITHOUT Claude Code's skill scaffolding. **It is unproven that DeepSeek (or any non-Claude model) can hold this role with acceptable reliability.** A model that emits malformed tool_calls, loops, or loses the thread would be worse than useless as an orchestrator.

**Recommended probe (T0; HIGH value, LOW cost) — runs BEFORE any of T1–T5 ships:**
1. A throwaway script drives the chosen model (DeepSeek) through ~5 **representative orchestrator turns** via the raw OpenAI tool-calling API with a draft brief + a mock tool manifest (the real tool *names/schemas* of pieces #2+#4, but mock implementations returning canned results): e.g. "read this file" → "decide an approach" → "dispatch a coding agent" → "the agent reported X, now summarize for the user" → "the user pushed back, revise."
2. **Score:** does it (a) follow the brief, (b) emit well-formed `tool_calls` matching the schema, (c) feed tool results back into a coherent next step, (d) recover when a mock tool returns an error/denial, (e) stay on task across all 5 turns without looping? A simple rubric (pass/partial/fail per criterion).
3. **Outcome → go/no-go + sizing.** A clean pass → build T1–T5 with confidence. A partial → the brief/tool-schema needs hardening, or fall back to the text-protocol (D-B), or constrain to thin-coordinator-only (D-C). A fail on a given model → try another provider, or shelve Tier-1 for that model. **This single probe converts the central unknown into a fact and right-sizes (or cancels) the whole build** — exactly the standalone E.1 pattern. It spends a few cents of DeepSeek budget, touches NO production channel, edits nothing.

## 6.2 Tool-loop reliability

- **Malformed tool_calls / hallucinated tool names.** Mitigate: strict schema validation in the choke-point (an unknown tool / bad args → a tool-result error fed back, never executed); the turn cap bounds repeated failures; the model sees its own errors and can correct (and if it can't, the probe should have caught it).
- **Infinite / runaway loops** (the model keeps calling tools, never finalizes). Mitigate: a hard per-turn tool-iteration cap + a cumulative wall-clock budget → terminal error → the host's restart/resume recovers (`lifecycle.ts`). The `AgentConcurrencyGate` USD cap (`agent-concurrency.ts:37-50`) bounds the *cost* of a runaway dispatch fan-out.
- **Tool-result size / context bloat.** A non-Claude model has its own (often smaller) context window; large tool outputs (a big file, verbose shell) can blow it. Mitigate: the choke-point truncates/sizes tool results (and the thin-coordinator default D-C keeps heavy work in sub-agents); the host's existing context-clean/restart (`session-host.ts` clearContext) is the backstop.

## 6.3 Containment

- **The token-hijack class does NOT apply** (no Claude Code, no `settingSources`, no plugin loader) — that whole risk surface vanishes for a non-Claude orchestrator. ✓
- **The new surface is data-egress (D-G)** — surfaced, user-acknowledged, bounded by thin-coordinator. NOT a credential/channel leak.
- **Tool-layer is the new trust boundary.** If the tool-runner choke-point were bypassed (a driver calling `child_process` directly instead of through the router), the safety floor would be skipped. Mitigate: make the unsealed/unrouted tool path **unrepresentable** — the driver gets ONLY a `runTool(name,args)` callback that always goes through the permission router + policy (the SAME "one choke-point" discipline standalone PART C #1 mandates for spawns, here applied to the orchestrator's own tools). Asserted by tests (a denied op must NOT execute).
- **Key scoping.** REUSE `assertBackendCostSafe('api-adapter', env, ownSecretName)` on the orchestrator process so it carries ONLY its provider key + no foreign key (`cost-safety.ts:256-264`). A misconfig (e.g. an Anthropic key in env) fails fast, loudly.

## 6.4 Host-safety / non-regression (the governing constraint)

- The Claude orchestrator is the DEFAULT; the non-Claude path is gated behind `SUPERVISOR_ORCHESTRATOR_MODEL` being a non-Claude id (+ a switch). With the default (unset/Claude), `index.ts` builds cli-stream exactly as today — byte-for-byte, proven by an OFF-path test (the campaign's P6 pattern, `index.ts:266-280`). Rollback = unset the env + restart → the Claude host returns. CP5 first, always.
- **Coexistence risk:** piece #2's async coordinate endpoints are additive on `panel.ts` (loopback-only, like every existing `/api/*`); they don't alter the synchronous `/api/dispatch` the campaign shipped. The Claude orchestrator can use them too (a bonus), but is not forced to.

---

# §7 — WHAT'S REUSABLE FROM WHAT SHIPPED

| Shipped (campaign + supervisor) | Reused here as | File:line |
|---|---|---|
| `SessionDriver` contract + `BackendCapabilities` | THE seam the multi-turn driver implements — no new contract | `session-driver.ts:167-225` |
| `LifecycleManager` (owns ONE driver; start/send/restart/resume/watchdog) | The orchestrator-hosting machinery — already driver-agnostic; swap the driver only | `lifecycle.ts:261,456-461` |
| `ApiAdapterDriver` pure helpers (request build, SSE iterate, payload parse, cost compute, HTTP client, error discipline) | ~80% of the multi-turn driver's body (reused as helpers, not subclass — D-A) | `api-adapter-driver.ts:280-305,337-403,176-199,416-464` |
| Provider registry (DeepSeek/OpenAI/Groq/Gemini; `secretEnvVar`) | The non-Claude orchestrator's model + key source — no new provider plumbing | campaign Q.1; `provider-registry.ts` |
| **The dispatch surface** (`POST /api/dispatch` → `dispatchRole` → `dispatchRoleAgentWithFallback`) | The teams-replacement's foundation (piece #2 extends it to async coordinate/monitor) | `panel.ts:281-309`; `session-host.ts:2399-2430`; `result-relay.ts:332-400` |
| `AgentConcurrencyGate` (cap + USD caps; sole ledger) | The concurrency + cost cap for the orchestrator's coordinated agents — already wired into the dispatch closure | `agent-concurrency.ts:25-75`; `index.ts:308-311` |
| The seal + cost guard (`sealBackendOptions`, `assertBackendCostSafe`, `UNIVERSAL_CHANNEL_DENY`) | Containment applied to the orchestrator PROCESS (piece #4) | `backend-seal.ts:67-70,158-172`; `cost-safety.ts:256-264` |
| `PermissionRouter` + orchestrator policy (`isDestructiveOp`, allow-list, `fallback:'route'`, block-on-reply) | The orchestrator's own tool-call gate — identical safety floor (piece #4 / D-H) | `profiles.ts:85-107,255-343`; `session-driver.ts:110-115` |
| Change-model restart (`restartControl` → `setOrchestratorModel` → `LifecycleManager.setModel` + drain + handoff re-inject) | The Tier-1 swap flow — handoff is a text brief = model-agnostic (piece #5) | `index.ts:420-432`; `session-host.ts:1768-1789,2516-2519`; `config.ts:174-208` |
| Tier-1 model env (`SUPERVISOR_ORCHESTRATOR_MODEL`, `config.orchestratorModel`) + `CONTROL_MODEL_CHOICES` | The selection knob (piece #3 makes the driver follow the model + adds non-Claude ids) | `config.ts:660-671`; `control-command.ts:229-233`; `index.ts:545` |
| The dormant-default-OFF discipline (conditional construction; OFF-path byte-for-byte test) | The activation pattern for piece #3/#5 (CP5/AP5) | `index.ts:266-280`; `config.ts:210-230` |

**Net new (bounded):** (1) the conversation loop + real `send()` + the tool-call loop in `MultiTurnAdapterDriver`; (2) the async coordinate endpoints + the agent registry; (3) `resolveOrchestratorDriver` + 2 small composition edits + the menu ids; (4) the orchestrator tool-runner choke-point (a `runTool` callback always through the router); (5) the orchestrator brief + tool manifest. Everything else is reuse.

---

# §8 — TRACEABILITY (to the campaign + standalone proposals)

**Pieces → campaign principles / flows / open-decisions:**

| Piece | Campaign element it extends | Traces-to |
|---|---|---|
| #1 Multi-turn tool-capable driver | M5 `ApiAdapterDriver` (one-shot) → multi-turn; the `SessionDriver` contract (AP1) | CP1 (uniform contract), CP6 (reuse the seam); AP1; FD3 |
| #2 Teams-replacement (coordinate surface) | The live `POST /api/dispatch` (Q.6.1 `dispatchRole`) + M6 result-relay + FD1 dispatch | CP2 (best-model-per-role); AP2, AP6; FD1, FD6 |
| #3 Driver selection by model | Tier-1 model selection (Q.3); the role-router pattern (M2 / AP2); the change-model menu | CP2, CP5; AP2, AP5; FD7 |
| #4 Containment for a non-Claude orchestrator | M4 seal + scoped-secret guard; X4 universal seal; standalone PART C #1/#2 | CP3 (containment universal), CP4 (cost per-backend); AP3, AP4, AP6; FD2, FD4, FD5 |
| #5 Snapshot→restart→handoff for non-Claude | The change-model restart + the startup-handoff (model-agnostic text brief) | CP5 (host-safety / non-regression); AP5; FD7 |
| §6.1 De-risking probe FIRST | standalone E.1 (the cheap experiment before the build); CP7 measured-before-trusted | CP7; (the phased gate) |

**Decision hierarchy applied (campaign §0.3):** CP5 (host safety — Claude stays default, non-Claude is gated/rollback-able) > CP3 (containment — same safety floor, scoped keys, channel-mute, the data-egress trade surfaced) > CP4 (cost — the gate's USD caps bound a runaway non-Claude orchestrator) > CP1 (uniform contract — the multi-turn driver IS a `SessionDriver`) > CP2 (best-model-per-role — a non-Claude orchestrator that coordinates per-role backends) > CP6 (reuse — ~80% reused) > CP7 (measured — the probe gates the build).

**Spine check:** every piece serves ≥1 campaign principle (no scope creep); the central unknown (can a non-Claude model hold the role) is gated by a cheap probe before any build (CP7); the Claude host is never regressed (CP5 first). The proposal adds NO new principle — it generalizes the campaign's existing CP/AP/FD one layer up (agents → the orchestrator itself).

---

# Appendix — Evidence index (file:line)

- **Orchestrator pinned to cli-stream (teams requirement):** `tools/supervisor/src/profiles.ts:58-63,237-239`.
- **Composition: model chosen, driver = profile default:** `tools/supervisor/src/index.ts:545`; `profiles.ts:242`.
- **Tier-1 model env + Claude-only menu:** `tools/supervisor/src/config.ts:210-230,660-671`; `control-command.ts:229-233`.
- **cli-stream IS multi-turn + tool-capable (the template):** `tools/supervisor/src/adapters/cli-stream-driver.ts:6,197,627-630,632-636`.
- **The `SessionDriver` seam + capability descriptor:** `tools/supervisor/src/session-driver.ts:26-34,41-85,110-115,167-225`.
- **`LifecycleManager` is driver-agnostic (start/send):** `tools/supervisor/src/lifecycle.ts:261,356,456-461`.
- **One-shot `ApiAdapterDriver` (extend its helpers; `send()` throws):** `tools/supervisor/src/api-adapter-driver.ts:280-305,337-403,176-199,416-464,469-471,577-630,640-645`.
- **The dispatch surface (teams-replacement foundation):** `tools/supervisor/src/panel.ts:281-309`; `session-host.ts:2386-2430,1849-1858`; `result-relay.ts:332-400`.
- **Concurrency + spend gate (built + wired):** `tools/supervisor/src/agent-concurrency.ts:25-75`; `index.ts:303-393`.
- **Seal + cost guard (containment to reuse for the process):** `tools/supervisor/src/backend-seal.ts:67-70,124-172`; `cost-safety.ts:189-264`.
- **Permission router + orchestrator policy (the safety floor):** `tools/supervisor/src/profiles.ts:85-123,255-343`.
- **Change-model restart + handoff (Tier-1 swap, model-agnostic):** `tools/supervisor/src/index.ts:420-432`; `session-host.ts:1768-1789,2516-2519`; `config.ts:174-208,696-724`.
- **The campaign (governing; demoted to reference):** `docs/proposals/model-agnostic-agents-2026-06-19.md` (CP/AP/FD, §C taxonomy, M1–M8, PART P, PART Q, OD-1..7, §Q.6 dispatch mechanism).
- **Standalone process-per-agent (containment PART C, hybrid D.2, de-risk E.1, OD-1..4):** `docs/proposals/standalone-process-agents-2026-06-19.md`.
- **Verified NEW sibling topic (no existing non-Claude-orchestrator proposal):** `grep -i 'tier-1|non-claude.*orchestrator|model-agnostic orchestrator' docs/proposals/` → only the Tier-2 dispatch + the Claude-only Tier-1 model selector.
