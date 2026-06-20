# Model-Agnostic Agent System — Campaign Proposal (governing document)

**Date:** 2026-06-19 (extended 2026-06-20: PART Q — multi-provider + in-channel `/setkey` + two-tier model selection) · **Author:** `/compose-proposal` (Mode A draft-first; governed top-down) · **Status:** DRAFT (proposal lifecycle: Draft → Review/Approval → Active → Archive + Implementation Report).
**Scope:** the **agent EXECUTION + ROUTING layer** of the Pianoid Supervisor — make every agent the orchestrator dispatches run its OWN model/API behind ONE uniform contract, with per-role model routing (initial map planning=Claude, coding=DeepSeek, reviewing=Codex). **Generalized (PART Q) to ANY OpenAI-compatible provider pluggable by config (DeepSeek, OpenAI/Codex, Groq, Gemini, + more later), with the user supplying provider keys IN-CHANNEL (`/setkey`) and selecting models in two tiers (Tier-1 the orchestrator's own model; Tier-2 the dispatched role models — `/setrole` next batch).**

> **How to read.** This document is GOVERNED top-down: **PART 0 (foundations) governs the body.** Purpose → Core Principles → Decision Hierarchy → Architectural Principles → Architecture + Flows, then the body (Classification → Modules → Cross-cutting). Every element carries a `traces-to:` tag; the machine-checkable record lives in the **Traceability matrices** (§T), not inline. An upstream change re-traces the whole document (grep the ID). The durable spec is lean; the composition history lives in the side seed `docs/proposals/.process/model-agnostic-agents-composition-2026-06-19.md`.

**Relationship to prior docs (one-doc-per-topic — extend, do not duplicate):**
- **EXTENDS** `docs/proposals/standalone-process-agents-2026-06-19.md` (the standalone process-per-agent decision-support; its hybrid recommendation D.2 + its containment PART C + its concurrency de-risking). That doc decided *how a sub-agent runs as its own sealed OS process*; THIS doc generalizes "sealed standalone `claude -p` process" → "**sealed standalone `<model>` process behind a uniform agent contract**" + adds the **role→model router**. The standalone-process doc is the foundation; it is **demoted to a REFERENCE** for this Campaign (the spawner-demotion rule).
- **BUILDS ON the measured seam** in `tools/supervisor/src/` — the `SessionDriver` interface (`session-driver.ts`) is the existing normalized boundary this proposal adopts AS the uniform agent contract (reuse, not reinvent). Integration is additive behind that seam; the running orchestrator is untouched.
- **Sits one layer beside** `m12-host-supervisor-app-2026-06-14.md` (the host that owns ONE orchestrator child) and the `m12-supervisor-architecture-review-2026-06-17.md` (the driver-seam decision). Those govern the *single hosted orchestrator*; this governs the *agents the orchestrator dispatches underneath it*.

**De-risking already performed today (2026-06-19), cited as a foundation:**
- A live concurrency probe found **NO seat cap** — **≥64 concurrent SEALED `claude -p` sessions ran clean** (zero throttle / 429 / local error); the channel survived every wave. → Concurrency is **rate/token-gated, not seat-gated** (confirms the standalone-process doc A.3 at HIGH confidence). The binding cap is **local RAM/CPU + the 5-hour token budget under sustained heavy agents**, not licensing.
- **`--setting-sources project,local` (no `user`) is proven to seal the telegram-plugin token hijack** (the recurring "messages don't reach me" failure). The seal is the non-negotiable launch invariant for EVERY spawned process (`reference_hosted_claude_plugin_token_hijack`).

---

# PART 0 — FOUNDATIONS

## 0.1 Purpose

Make the supervisor a **model-agnostic agent runtime**: the orchestrator dispatches work to agents that each run their **own backing model/API** (Claude, DeepSeek, Codex/OpenAI, future) behind **ONE uniform agent contract** (structured task in → structured result out, with shared lifecycle / streaming / permission / error semantics), routed **per role** by a config-driven dispatcher — so each role uses the best-fit model (judgment on premium models, routine codegen on cheap models), with no single-vendor lock-in, **without breaking the live Claude-hosted orchestrator**.

## 0.2 Core principles (`CP`)

| ID | Principle (one line) |
|---|---|
| **CP1 — Uniform contract** | Every agent, whatever its backing model/API, satisfies ONE contract: task in → result out, plus lifecycle, streaming, permission, error. The orchestrator/runtime code never special-cases a vendor. |
| **CP2 — Best-model-per-role** | The model is a per-ROLE routing decision (config), not a code constant. Roles map to backends; the map is data, hot-swappable without code change. |
| **CP3 — Containment is per-process and universal** | The seal (sealed setting-sources, channel-mute, scoped secrets, one choke-point launcher) applies to EVERY spawned agent of EVERY backend, identically. N backends = N chances to breach; make the unsealed path unrepresentable. |
| **CP4 — Cost is bounded + attributable per backend** | Each backend has its own billing surface (Claude=subscription/key-free; DeepSeek/Codex=their own metered key). The guard is per-backend: a backend's key is allowed ONLY for that backend and never leaks to another. Spend is observable per agent. |
| **CP5 — Host safety / non-regression** | The Campaign is additive behind the existing seam. The running cli-stream orchestrator keeps working unchanged; nothing activates until a coordinated rebuild/restart the user triggers. Backward-compatible by construction. |
| **CP6 — Reuse the proven seam** | Build on the existing `SessionDriver` / lifecycle / permission-router / profile machinery. New code is the router + the non-Claude driver(s) + per-backend seal; the orchestration spine is reused, not rewritten. |
| **CP7 — Measured before trusted** | A backend, a route, or a cap is trusted only after a measured slice proves it end-to-end (the concurrency probe pattern). Phase 1 proves the contract with Claude BEFORE any non-Claude backend. |

## 0.3 Decision hierarchy (conflict resolution — the user's priority ordering)

When two principles pull apart, resolve in this order (higher wins):

**CP5 (host safety) > CP3 (containment) > CP4 (cost) > CP1 (uniform contract) > CP2 (best-model-per-role) > CP6 (reuse) > CP7 (measured).**

Read: never regress the live host to gain a feature (CP5 first). Never relax the seal to save money or simplify (CP3 > CP4/CP1). A clean uniform contract outranks adding more backends (CP1 > CP2) — get ONE backend right behind the contract before widening. Reuse and measurement are how we build, but they yield to a correctness/safety need. *(The one conflict that actually bites — the key-free cost guard (CP4) vs. a non-Claude backend that REQUIRES a key (CP2) — is resolved by per-backend key scoping, see §M4 + OD-1; it is surfaced for the user, not decided silently.)*

## 0.4 Architectural principles (`AP`)

| ID | Architectural principle | traces-to |
|---|---|---|
| **AP1 — The contract IS the existing `SessionDriver` seam, generalized** | Adopt `tools/supervisor/src/session-driver.ts` (`SessionDriver` + `SessionEvent` + `PermissionHandler`) as the uniform AGENT contract. A non-Claude agent implements the SAME interface. No parallel contract is invented. | CP1, CP6 |
| **AP2 — Role→backend routing is a pure, data-driven resolver** | A `role-router` (mirroring `driver-policy.ts`) maps `role → {backend, model, …}` from config; a `backend registry` constructs the concrete driver. Pure decision, side-effect-free, unit-testable, hot-swappable. | CP2, CP6 |
| **AP3 — Every backend driver is a sealed standalone process** | Each agent = its own OS process behind the contract (extends the standalone-process doc). Claude = sealed `claude -p`; DeepSeek/Codex = a sealed adapter process (or in-runtime API client) speaking the same `SessionEvent` stream. The seal generalizes across vendors. | CP3, CP1 |
| **AP4 — One choke-point launcher; secrets scoped per backend** | No agent is spawned except through ONE primitive that applies the backend's seal + injects ONLY that backend's credential (Claude: key-free; DeepSeek: `DEEPSEEK_API_KEY`; Codex: `OPENAI_API_KEY`) and asserts no FOREIGN key is present. The cost-safety guard becomes backend-aware. | CP3, CP4 |
| **AP5 — Additive, dormant-until-activated integration** | All new code lands on a feature branch, behind a default-OFF switch; the orchestrator profile's current cli-stream path is the unchanged default. Activation = a later coordinated rebuild/restart. No edit to the live path's behavior. | CP5 |
| **AP6 — Agents are channel-mute; results return to the orchestrator only** | A dispatched agent NEVER touches the user channel. Its result returns to the orchestrator as a structured report (the existing `onResult`/reply-relay shape); only the orchestrator (the single hosted session) speaks to the user. | CP3, CP1 |

## 0.5 Overall architecture + flows

**Layers / actors (where things live):**

```
 user ── channel ──>  SUPERVISOR (single owner of channel; unchanged)
                          │
                          ├── Hosted ORCHESTRATOR session (cli-stream claude -p; UNCHANGED default)
                          │        │  dispatches roles ↓
                          │        ▼
                          │   ROLE ROUTER (AP2)  ──reads──>  role→backend config (data)
                          │        │  resolves role→backend+model
                          │        ▼
                          │   BACKEND REGISTRY (AP4)  ── one choke-point launcher (seal + scoped secret)
                          │        │  constructs a driver that satisfies the CONTRACT (AP1)
                          │        ▼
                          │   AGENT PROCESS  (sealed standalone, AP3) ── one of:
                          │        • ClaudeBackendDriver   (sealed `claude -p`  — key-free)   [reuses CliStreamDriver]
                          │        • DeepSeekBackendDriver  (sealed adapter — DEEPSEEK_API_KEY only)
                          │        • CodexBackendDriver      (sealed adapter — OPENAI_API_KEY only)
                          │        │  emits the SAME SessionEvent stream + routes permissions
                          │        ▼
                          │   result report ──returns to──> orchestrator (AP6; never to the channel directly)
                          │
                          └── PermissionRouter / CaptureStore / Panel (UNCHANGED; now span all backends)
```

- **STRUCTURE/LAYER** (not modules): the role→backend **config** (a data file/section), the per-agent **process** (an OS process, a place work runs), the **backend env/secret set** (scoped credential per backend). These are *places things live*, governed by the architecture.

**Flow set (derived from the principles — each principle implying a recurring process yields a flow `FD`):**

| ID | Flow | Derived from | Sequence (summary) |
|---|---|---|---|
| **FD1 — Role dispatch** | CP2 | orchestrator names a ROLE + task → role-router resolves `role→{backend,model}` → backend-registry launches a sealed agent via the choke-point → agent runs → result returns to orchestrator (AP6). |
| **FD2 — Seal-on-spawn** | CP3 | choke-point launcher applies the backend's seal (sealed setting-sources / channel-mute) + injects ONLY that backend's secret + asserts no foreign key (AP4) BEFORE the process starts; an unsealed spawn is impossible. |
| **FD3 — Uniform streaming + result** | CP1 | any backend maps its native output → the normalized `SessionEvent` stream (`system_init`/`assistant`/`tool_result`/`result`); the runtime consumes one shape regardless of vendor. |
| **FD4 — Permission routing across backends** | CP1, CP3 | a gated tool inside ANY agent surfaces as a normalized `PermissionRequest` → the existing PermissionRouter → the user over the channel (block-on-reply). A backend with no tool-permission surface declares so (its capability descriptor), so the router treats it correctly. |
| **FD5 — Per-backend cost guard** | CP4 | at spawn, assert the env carries the agent's OWN backend key (if any) and NO other backend's billing key; record spend/attribution per agent. |
| **FD6 — Backend failure + fallback** | CP7, CP5 | an agent crash/timeout/backend-API-error is contained to that process; the router may FALL BACK to a designated backend (e.g. coding DeepSeek→Claude) per config, or surface the failure — never wedging the orchestrator or the host. |
| **FD7 — Activation cut-over** | CP5 | the feature ships dormant (default-OFF); a later coordinated rebuild + supervisor restart flips routing on. Backward-compatible: with routing OFF, behavior is byte-for-byte the current cli-stream path. |

> Completeness check (walk the principles): CP1→FD3+FD4; CP2→FD1; CP3→FD2(+FD4); CP4→FD5; CP5→FD7(+FD6); CP6→(reuse, no new recurring process — realized by adopting the seam in the modules); CP7→FD6(+the phased measured slices). Every principle that implies a recurring process has a flow; CP6 is realized structurally (reuse) rather than as a runtime flow — flagged, not missing.

---

# THE ELEMENT BODY

## §C Classification + transition graph (the agent-execution taxonomy)

Design the graph before the modules + lifecycles that consume it.

**Backend-kind taxonomy** — how an agent's backing model resolves to an execution shape:

| Backend kind | Native interface | Contract realization | Seal specifics | Secret |
|---|---|---|---|---|
| **claude-cli** (Claude) | `claude -p` stream-json | REUSE `CliStreamDriver` (already satisfies the contract) | `--setting-sources project,local`, `--disallowed-tools` deny-list, key-free env | NONE (subscription OAuth) |
| **api-adapter** (DeepSeek, Codex/OpenAI) | OpenAI-compatible HTTPS chat/completions | a NEW driver that maps request/stream → `SessionEvent`; runs as a thin standalone process OR an in-runtime client (OD-2) | no plugin/setting-sources surface (not Claude Code) → seal = channel-mute + scoped key + no FS/git tool surface unless explicitly granted | that backend's key ONLY (`DEEPSEEK_API_KEY` / `OPENAI_API_KEY`) |
| **(future) local/other** | varies | same contract; same registry slot | same universal seal | per-backend |

**Role taxonomy** (the routing keys, initial map — DATA, in config, hot-swappable):

| Role | Initial backend | Rationale |
|---|---|---|
| **planning** | claude-cli (Claude) | judgment/architecture — premium reasoning; has teams/skills |
| **coding** | api-adapter (DeepSeek `deepseek-v4-flash`) | routine codegen — cheap tier (precedent: deepseek-codegen-mcp, measured 90%/100%-w-retry) |
| **reviewing** | api-adapter (Codex/OpenAI) | code review — second-opinion model, vendor diversity |
| *(fallback default)* | claude-cli | any unmapped role resolves here (fail-safe to the proven backend) |

**Transition graph (how an agent moves through states — the lifecycle edges the modules thread along):**

```
   RESOLVED ──launch(sealed)──> RUNNING ──result──> REPORTED ──> DONE
   (role→backend)                 │  │                              
                                  │  └──(gated tool)──> AWAITING-PERMISSION ──decision──> RUNNING
                                  │
                                  ├──crash/timeout/api-error──> FAILED ──(config)──> FALLBACK-RESOLVED ──> RESOLVED(new backend)
                                  │                                   └──(no fallback)──> SURFACED (report failure to orchestrator)
                                  └──orchestrator-kill──> KILLED
```

**Framework validation — map the user's concrete cases onto it:**
- *planning=Claude* → role `planning` → `claude-cli` backend → `RESOLVED→RUNNING(sealed claude -p)→REPORTED`. ✓ (this is Phase 1).
- *coding=DeepSeek* → role `coding` → `api-adapter` backend (DeepSeek key) → same lifecycle; on API error → `FAILED→FALLBACK-RESOLVED(claude-cli)`. ✓
- *reviewing=Codex* → role `reviewing` → `api-adapter` backend (OpenAI key) → same lifecycle. ✓
- *existing in-process Claude teammate* (`/fn`, quick `/analyse`) → NOT a routed standalone agent; stays an in-process Agent/Task teammate of the cli-stream orchestrator (the standalone-process doc's "keep the cheap in-process" — this Campaign does not remove it). The taxonomy covers ROUTED standalone agents; in-process teammates remain the orchestrator's own mechanism. ✓ (boundary surfaced, not a misfit).

## §M Modules (one concern each; concern-driven, not name-driven)

**M1 — Agent Contract (adopt + extend `SessionDriver`).**
*Concern:* the single interface every backend satisfies. It IS `SessionDriver` (`start(opts)→AsyncIterable<SessionEvent>`, `send`, `interrupt`, `stop`, `health`) + the `SessionEvent` union + `PermissionHandler`. The ONLY extension this Campaign adds is a small **capability descriptor** per backend (`{ supportsTools: bool, supportsPermissionRouting: bool, supportsResume: bool, supportsTeams: bool }`) so the runtime knows what a non-Claude backend can/can't do (e.g. a bare api-adapter has no tool-permission surface → FD4 treats it as "no gated tools" rather than mis-wiring the router). `traces-to: AP1, CP1, CP6.`

**M2 — Role Router.**
*Concern:* resolve `role → {backend, model, fallbackBackend?}` from config. A pure resolver mirroring `driver-policy.ts` (`resolveRoleBackend({role, config})→BackendSelection`), with precedence (explicit per-dispatch override > config map > the fail-safe default = claude-cli). Unrecognized role → default backend (never a hard error). No I/O, fully unit-testable. `traces-to: AP2, CP2.`

**M3 — Backend Registry + Driver Factory.**
*Concern:* given a `BackendSelection`, construct the concrete `SessionDriver` for that backend kind (claude-cli→`CliStreamDriver`; api-adapter→the new `ApiAdapterDriver` parameterized by base-URL/model/secret-name). One registry keyed by backend kind; adding a backend = one registry entry + its driver. `traces-to: AP1, AP2, AP4, CP6.`

**M4 — Backend Seal + Scoped-Secret Guard (the choke-point launcher).**
*Concern:* the ONE primitive every agent spawn goes through. It (a) applies the backend's seal (claude-cli: `settingSources project,local` + deny-list + `bootstrapTurns`/role; api-adapter: channel-mute + no FS/git tools unless granted); (b) injects ONLY that backend's secret into the child env; (c) asserts NO FOREIGN billing key is present (generalizes `cost-safety.ts`: today it throws on ANY `ANTHROPIC_API_KEY`; it becomes *backend-aware* — a Claude agent's env MUST stay Anthropic-key-free, a DeepSeek agent's env MUST carry `DEEPSEEK_API_KEY` and NO `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` it doesn't own, etc.). Makes the unsealed/cross-credential spawn unrepresentable. `traces-to: AP3, AP4, CP3, CP4.` *(This module owns the CP4-vs-CP2 tension resolution — see OD-1.)*

**M5 — API-Adapter Driver (the non-Claude backend).**
*Concern:* a `SessionDriver` implementation for OpenAI-compatible backends (DeepSeek, Codex/OpenAI). Maps a task turn → a chat/completions request (streamed), maps the response/stream → the `SessionEvent` shape (`system_init` synthesized at start; assistant text deltas → `assistant`; final → `result` with cost). Reuses the deepseek-codegen-mcp precedent for key handling (`DEEPSEEK_API_KEY` from env only, never logged), model pinning, thinking-disabled, and clean error → `DeepSeekError`-style surfaced failure. Injectable HTTP client (tests feed canned responses; no network). Declares its capability descriptor (M1): tools/permission-routing OFF by default. `traces-to: AP1, AP3, CP1, CP2.`

**M6 — Agent Dispatch Result-Relay.**
*Concern:* return a finished agent's structured result to the ORCHESTRATOR (never the channel — AP6), reusing the existing result shape (`onResult` / the channel-tool reply pattern is the model). For a routed standalone agent the runtime relays the `result` event's text back as the orchestrator's tool-result/turn (the same way an in-process sub-agent's final report returns today). `traces-to: AP6, CP1, CP3.`

> **Re-homing notes (concern-driven placement — nothing lost):**
> - *Concurrency cap / scheduler* is NOT a module here — it is a **cross-cutting rule** (§X2), since it spans all backends/agents (it governs the runtime, not one component).
> - *Worktree-per-agent isolation* is NOT a new module — it REUSES the existing worktree mechanism (`launch-pty-orch.mjs` pattern + the `SUPERVISOR_WORKTREE_CLEANUP` teardown in `index.ts`); it is a **cross-cutting rule** (§X3) that the choke-point launcher (M4) invokes for FS-writing backends.
> - *"DeepSeek codegen"* already exists as an MCP TOOL (`tools/deepseek-codegen-mcp`) used INSIDE a Claude agent. This Campaign's `coding=DeepSeek` is a different concern — the AGENT ITSELF is DeepSeek (M5), not a Claude agent calling a DeepSeek tool. The MCP tool is a REFERENCE (key-handling precedent), not re-homed.

## §X Cross-cutting processes / rules / lifecycles (span the modules; built after §C)

**X1 — Agent lifecycle (threads the §C transition graph).**
Each routed agent: `RESOLVED → RUNNING → (AWAITING-PERMISSION ↔ RUNNING)* → REPORTED → DONE`, with `FAILED→FALLBACK|SURFACED` and `KILLED` edges. REUSES `LifecycleManager` semantics (own the driver, consume the event stream, restart/timeout) per agent. The orchestrator-level lifecycle (one long-lived hosted session) is unchanged; this is the *per-dispatched-agent* lifecycle, generalizing the same machinery. `traces-to: FD1, FD6, AP1, CP6.`

**X2 — Concurrency + token-budget cap (runtime guardrail).**
A supervisor-level cap on concurrent routed agents + a token-budget awareness, since the binding limit is local RAM/CPU + the 5-hr Claude window (de-risking: NOT seats; ≥64 ran clean, so the cap is generous but present to avoid a self-inflicted rate-limit/RAM wall under sustained heavy agents). Spans all backends. `traces-to: CP4, CP7, FD5.`

**X3 — Worktree isolation for FS-writing agents.**
Any agent that writes the repo runs in its own git worktree (reuse the existing pattern); read-only/compute agents (e.g. a pure DeepSeek codegen turn) need none. Invoked by M4 at spawn for FS-writing backends; cleaned up on teardown. `traces-to: CP3, CP5, FD2.`

**X4 — Universal containment seal (the non-negotiable rule).**
EVERY spawned agent of EVERY backend is channel-mute and credential-scoped (M4). The single-poller invariant holds: only the supervisor's adapter touches the channel; agents reach the user ONLY via the orchestrator's relay (AP6). No backend may load the prod telegram plugin (claude-cli: `project,local` sources; api-adapter: not Claude Code at all). `traces-to: CP3, CP5, FD2, FD4.`

**X5 — Dormant-until-activated rollout (host-safety lifecycle).**
The Campaign ships behind a default-OFF switch (`SUPERVISOR_ROLE_ROUTING=off` by default). With it OFF, the orchestrator profile resolves exactly as today (cli-stream, in-process teams) — byte-for-byte backward compatible. Activation is a later, separately-approved coordinated rebuild + supervisor restart. The build NEVER rebuilds/restarts the live supervisor during development. `traces-to: CP5, AP5, FD7.`

---

# PART P — PHASED BUILD PLAN

Each phase is a discrete `/dev` unit (scope + files + tests + verification surface). **Phase 1 is the smallest end-to-end slice that proves the CONTRACT with Claude BEFORE any non-Claude backend (CP7).** All phases: READ-ONLY-on-live, additive, default-OFF; no commit/branch/build/restart of the live supervisor by the design pass.

| Phase | Scope (one line) | Key files (new unless noted) | Tests | Verification surface |
|---|---|---|---|---|
| **P0 — Contract + capability descriptor** | Lock the contract: confirm `SessionDriver` is THE contract; add the per-backend `capability descriptor` type (M1) + a `BackendKind`/`Role` type. No behavior change. | `session-driver.ts` (extend: capability type), `backend-kinds.ts` | unit: descriptor defaults; type-level | `npm test` green in `tools/supervisor`; no runtime path touched |
| **P1 — Route ONE role to a standalone Claude agent (PROVES the contract end-to-end)** | `role-router` (M2) + `backend-registry` (M3) wired so role `planning` resolves → a sealed standalone `claude -p` agent (REUSE `CliStreamDriver`), dispatched + result relayed (M6), behind default-OFF switch. NO non-Claude backend yet. | `role-router.ts`, `backend-registry.ts`, `backend-seal.ts` (M4, claude-cli path only — generalizes `cost-safety`/`buildCliArgs`), result-relay glue | unit: router resolution + precedence; registry constructs CliStreamDriver; seal asserts key-free; relay maps result. Integration: fake-spawn a claude agent, assert one `result` returns | with switch ON in a TEST harness: a dispatched standalone claude agent runs sealed + returns a report; switch OFF = unchanged orchestrator |
| **P2 — Backend-aware cost/secret guard (M4 full)** | Generalize `cost-safety.ts` → backend-aware: per-backend allowed key + foreign-key assertion (FD5). Resolves the CP4-vs-CP2 tension (OD-1 decision baked in). | `backend-seal.ts` / `cost-safety.ts` (extend) | unit: claude env key-free passes / Anthropic-key fails; deepseek env with `DEEPSEEK_API_KEY` passes / with stray `ANTHROPIC_API_KEY` fails | unit-only; pure |
| **P3 — API-adapter driver (DeepSeek = `coding`)** | `ApiAdapterDriver` (M5) mapping OpenAI-compatible stream → `SessionEvent`; register `api-adapter`; route `coding`→DeepSeek; capability descriptor (no tools). REUSE deepseek-codegen-mcp key/error/pin patterns. | `api-adapter-driver.ts`, registry entry, config for `coding` | unit (injected HTTP client, canned responses): request build, stream→event map, error→surfaced FAILED, key-from-env-only | TEST harness: dispatch `coding` role → DeepSeek agent returns code as a report; on forced API error → FD6 fallback to claude-cli |
| **P4 — Second api-adapter backend (Codex/OpenAI = `reviewing`)** | Parameterize the adapter for OpenAI/Codex; route `reviewing`→Codex; vendor-diversity proof. | config + (likely zero new driver — same `ApiAdapterDriver`, different base-URL/model/key) | unit: OpenAI base-URL/model/key wiring; reuse adapter tests | TEST harness: dispatch `reviewing`→Codex agent returns a review report |
| **P5 — Cross-cutting guardrails (X2 concurrency cap, X3 worktree, FD6 fallback policy)** | Concurrency/token cap (X2), worktree-for-FS-writers (X3, reuse), config-driven fallback policy (FD6). | `agent-concurrency.ts`, registry/launcher hooks | unit: cap enforced; fallback resolves per config; FS-writer gets a worktree | TEST harness: N concurrent routed agents respect the cap; an FS-writing agent isolates |
| **P6 — Activation cut-over (separately approved)** | Wire role-routing into the orchestrator profile/launcher behind the switch; the coordinated rebuild + restart the USER triggers. NOT part of the dormant build. | `index.ts` / launcher (switch wiring), profiles | e2e on the test bot first | live: a user-approved rebuild/restart flips routing ON; rollback = switch OFF |

**Phase ordering rationale (CP7 + decision hierarchy):** prove the uniform contract with the KNOWN-good backend (P1) before adding any vendor; make the guard backend-aware (P2) before introducing a key-bearing backend (P3); add backends one at a time (P3 then P4); add runtime guardrails (P5) once ≥2 backends exist; activation (P6) is last + separately approved (CP5 first).

---

# PART Q — MULTI-PROVIDER + IN-CHANNEL SECRET-INTAKE + TWO-TIER MODEL SELECTION (extension 2026-06-20)

> **Why an extension, not a rewrite.** PART 0–P already make the agent layer model-agnostic *behind the contract* (one `ApiAdapterDriver` serves DeepSeek + Codex by config). This part GENERALIZES that to **any OpenAI-compatible provider pluggable by config**, adds the **in-channel mechanism by which the user supplies a provider's key** (`/setkey`) without that key ever touching the orchestrator, and names the **two tiers of model selection**. It introduces NO new principle — every element below traces to an existing `CP`. Built dormant/default-OFF/zero-spend; the live path is byte-for-byte unchanged until P6.

## Q.1 Provider registry — any OpenAI-compatible provider = one config entry  ·  `traces-to: CP1, CP2, AP1, AP2, CP6; M3, M5`

The per-backend api-adapter config is generalized into a **PROVIDER registry** (`provider-registry.ts`) — the SINGLE source of truth for the wired providers. A provider is pure DATA:

```
Provider = { id, baseUrl, defaultModel (CONFIGURABLE placeholder), secretEnvVar, openAiCompatible: true, rate? }
```

- **Adding a provider = one entry** in `DEFAULT_PROVIDERS`. The EXISTING `ApiAdapterDriver` (M5) serves every entry parameterized by `{baseUrl, model, secretEnvVar}` — **no new driver per provider** (the OD-4 property, generalized). The registry projects each provider → an `ApiAdapterConfig` (`apiAdapterConfigForProvider`), and DERIVES both the default api-adapter config map (`DEFAULT_API_ADAPTER_CONFIGS`, keyed by model id — M3 keys on it) AND the per-provider secret-env-var set (`BACKEND_SECRET_ENV_VARS` in `cost-safety.ts`).
- **Wired providers** (DATA; models are CONFIGURABLE placeholders set via Tier-2 `/setrole` / before activation):

| Provider id | baseUrl | secretEnvVar | OpenAI-compat | Notes |
|---|---|---|---|---|
| `deepseek` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | ✓ | coding backend (existed; pins reproduced byte-identical) |
| `openai` (alias `codex`) | `https://api.openai.com/v1` | `OPENAI_API_KEY` | ✓ | reviewing backend (existed; OD-4) |
| **`groq`** | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | ✓ | **NEW** — Groq's OpenAI-compatible API |
| **`gemini`** (alias `google`) | `https://generativelanguage.googleapis.com/v1beta/openai/` | `GEMINI_API_KEY` | ✓ | **NEW** — Gemini via its **OpenAI-COMPATIBILITY endpoint** → the SAME `ApiAdapterDriver` serves it; NO new driver |

- **Cross-provider key scoping is automatic (CP3/CP4).** Because the per-provider secret set is DERIVED from the registry, the backend-aware guard (M4 / `assertBackendCostSafe`) now knows EVERY provider's key, so each provider's agent env carries ONLY its own key and **rejects every foreign provider key for every pair** (a Groq agent rejects DEEPSEEK/OPENAI/GEMINI keys; a Gemini agent rejects the others; an Anthropic key is foreign to all). Adding a provider extends the scoping for free.

## Q.2 In-channel secret-intake — `/setkey <provider> <key>`  ·  `traces-to: CP3, CP4, X4; M4; new module M7`

The user supplies a provider's key OVER the channel. The key MUST never enter the orchestrator's context, never linger in chat, and never land in the durable capture log. Mechanism (mirrors the supervisor-intercepted `/mode` seam):

- **Supervisor-intercepted, never forwarded (X4).** `/setkey <provider> <key>` is parsed + handled AT THE SUPERVISOR (`SessionHost.handleInbound`, the same interception point as `/mode`/`/channel-check`); it is NEVER injected as an orchestrator turn → the raw key never reaches the orchestrator's context/stream.
- **Scoped secret store (M7 — `secret-store.ts`).** The key is stored in a **GITIGNORED** per-provider store (under the supervisor's `.state/` — gitignored by construction), keyed by the provider's `secretEnvVar`. The launcher/seal (M4) loads this store at spawn and injects each key into ONLY that provider's agents (the per-provider scoping of Q.1 then enforces no foreign key).
- **Redaction from capture + logs (FC-3 hygiene).** The captured inbound record for a `/setkey` message carries a MASKED placeholder, not the key: the supervisor passes every inbound through an (additive, default-OFF) `redactInbound` hook before publishing to the bus → the capture store / panel never hold the value; the host hook still receives the raw key (to store it). The store + handler never log a key value.
- **Masked confirmation only.** The reply is a masked acknowledgement (e.g. `GROQ_API_KEY set: gsk…1234 ✓`) — never the full key, never voiced (plain-text control message).
- **Message delete.** The user's original plaintext-key message is deleted from chat (`deleteMessage`, best-effort) so it does not linger in history.
- **Validation.** Unknown provider → a helpful error listing the known providers; empty/garbage key → rejected; a provider with no registered secret var → warn.
- **Dormant-until-activated (CP5/AP5).** The interception is GATED on a wired secret store; with none wired (the current default) `/setkey` falls through to a normal turn **byte-for-byte unchanged**. Activation (wiring the store + redactor into the composition root) is the P6 rebuild/restart the user triggers.

**M7 — Scoped Secret Store + In-Channel Intake.** *Concern:* durable per-provider key persistence (gitignored) + masked display, and the supervisor-intercepted `/setkey` command that fills it (parse + redact + store + masked-confirm + delete), NEVER forwarding the key to the orchestrator. Pure-FS, no network, zero spend. `traces-to: CP3, CP4, X4; AP4.`

## Q.3 Two-tier model selection  ·  `traces-to: CP2, AP2, AP5`

Model choice is **two distinct tiers** — different authority, different lifecycle:

| Tier | What it selects | Where configured | Lifecycle | Status |
|---|---|---|---|---|
| **Tier-1 — orchestrator's OWN model** | the model the hosted ORCHESTRATOR session itself runs on (supervisor-level) | supervisor config (the orchestrator profile's `model`) | needs a supervisor **restart** to take effect | existing config surface; documented here |
| **Tier-2 — the role models the orchestrator dispatches** | the per-ROLE backend+model the orchestrator routes work to (planning/coding/reviewing/…) | the role-router config map (M2), set on user request at RUNTIME | **runtime**, no restart (set then dispatched) | the `/setrole` control = the **NEXT batch** |

- **Tier-1** is the supervisor's own orchestrator-model decision (restart-scoped); changing it re-launches the hosted session on a different model.
- **Tier-2** is what THIS Campaign's router resolves: the orchestrator, on the user's request, sets a role→{provider, model} mapping at runtime and dispatches agents accordingly. The runtime control that EDITS the Tier-2 map (`/setrole <role> <provider> [model]`, a sibling supervisor-intercepted command) is the **next batch** — this batch lays the provider registry + the key intake it depends on (you cannot route a role to Groq until Groq is a provider AND its key is supplied).

## Q.4 Decisions + open questions (extending §D)

| # | Decision (locked in this extension) |
|---|---|
| D-F | The provider set is a config-only registry; ANY OpenAI-compatible provider is pluggable by ONE entry; Groq + Gemini are wired (Gemini via its OpenAI-compat endpoint → no new driver). Per-provider key scoping is DERIVED from the registry. |
| D-G | Provider keys are supplied IN-CHANNEL via the supervisor-intercepted `/setkey <provider> <key>`: scoped gitignored store, redacted from capture/logs, masked confirmation, message-deleted, NEVER forwarded to the orchestrator. |
| D-H | Model selection is two-tier: Tier-1 = the orchestrator's own model (supervisor config, restart); Tier-2 = the role models the orchestrator dispatches (runtime via the role-router; the `/setrole` control is the next batch). |

| ID | Open question | Recommendation |
|---|---|---|
| **OD-6** | Confirm the real (non-placeholder) default model id per provider (esp. Groq + Gemini) before activation. | Set via Tier-2 `/setrole` (next batch) or by editing `DEFAULT_PROVIDERS` once; the placeholders keep the dormant path resolvable meanwhile. |
| **OD-7** | The secret store is at-rest plaintext in a gitignored `.state/` file (perms 0o600 where honored). Acceptable, or require OS-keychain/at-rest encryption? | Plaintext-in-gitignored-state for v1 (matches the env-var model the drivers already use); revisit if the threat model requires a keychain. |

---

# §T Traceability matrices (the machine-checkable record)

**Principle → (architectural principles + flows):**

| Principle | Architectural principles | Flows |
|---|---|---|
| CP1 Uniform contract | AP1, AP3, AP6 | FD3, FD4 |
| CP2 Best-model-per-role | AP2 | FD1 |
| CP3 Containment universal | AP3, AP4, AP6 | FD2, FD4 |
| CP4 Cost per-backend | AP4 | FD5 |
| CP5 Host safety / non-regression | AP5 | FD6, FD7 |
| CP6 Reuse the seam | AP1, AP2, AP3 | (structural — reuse) |
| CP7 Measured before trusted | — (phasing) | FD6 (+ phased slices) |

**Element → (principles + flows + kind):**

| Element | Kind | traces-to (CP / AP / FD) |
|---|---|---|
| Role→backend config | STRUCTURE | CP2 / AP2 / FD1 |
| Per-agent process | STRUCTURE | CP3 / AP3 / FD2 |
| Backend env/secret set | STRUCTURE | CP4 / AP4 / FD5 |
| Provider registry (Q.1; any OpenAI-compat provider = 1 entry; Groq+Gemini wired) | STRUCTURE | CP1,CP2 / AP1,AP2 / FD1,FD3 |
| In-channel scoped secret store (Q.2 / M7) | STRUCTURE+MODULE | CP3,CP4 / AP4 / FD2,FD5 |
| Two-tier model selection (Q.3) | CLASSIFICATION | CP2 / AP2,AP5 / FD1,FD7 |
| Backend-kind taxonomy | CLASSIFICATION | CP1,CP2 / AP1,AP2 / FD1,FD3 |
| Role taxonomy | CLASSIFICATION | CP2 / AP2 / FD1 |
| Transition graph | CLASSIFICATION | CP1,CP7 / AP1 / FD1,FD6 |
| M1 Agent Contract | MODULE | CP1,CP6 / AP1 / FD3 |
| M2 Role Router | MODULE | CP2 / AP2 / FD1 |
| M3 Backend Registry/Factory | MODULE | CP6 / AP1,AP2,AP4 / FD1 |
| M4 Seal + Scoped-Secret Guard | MODULE | CP3,CP4 / AP3,AP4 / FD2,FD5 |
| M5 API-Adapter Driver | MODULE | CP1,CP2 / AP1,AP3 / FD3 |
| M6 Result-Relay | MODULE | CP1,CP3 / AP6 / FD1 |
| M7 Scoped Secret Store + `/setkey` intake (Q.2) | MODULE | CP3,CP4 / AP4 / FD2,FD5 |
| X1 Agent lifecycle | CROSS-CUTTING | CP6 / AP1 / FD1,FD6 |
| X2 Concurrency/token cap | CROSS-CUTTING | CP4,CP7 / — / FD5 |
| X3 Worktree isolation | CROSS-CUTTING | CP3,CP5 / — / FD2 |
| X4 Universal seal | CROSS-CUTTING | CP3,CP5 / AP4,AP6 / FD2,FD4 |
| X5 Dormant rollout | CROSS-CUTTING | CP5 / AP5 / FD7 |
| FD1–FD7 | FLOW | (per §0.5) |

*Spine checks:* every module/cross-cutting element serves ≥1 principle (no scope creep); every CP has ≥1 downstream element (no unrealised principle); CP6 is realized structurally (reuse) — recorded, not a gap.

---

# §D Decisions + open questions

**Decisions locked in this proposal:**

| # | Decision |
|---|---|
| D-A | The uniform agent contract IS the existing `SessionDriver` seam (+ a capability descriptor); no parallel contract. |
| D-B | Role→backend is data-driven config (`role → {backend, model, fallback}`), resolved by a pure router; initial map planning=Claude / coding=DeepSeek / reviewing=Codex; fail-safe default = claude-cli. |
| D-C | EVERY backend spawns through ONE choke-point launcher with a backend-aware seal + per-backend scoped secret; the cost guard generalizes from "no Anthropic key, ever" to "exactly this backend's key, no foreign billing key". |
| D-D | Phase 1 routes ONE role to a sealed standalone CLAUDE agent (proves the contract) BEFORE any non-Claude backend; the whole Campaign is additive + default-OFF; activation is a later coordinated rebuild/restart. |
| D-E | Routed standalone agents are channel-mute; results return to the orchestrator only. In-process Claude teammates (cheap/chatty roles) remain the orchestrator's own mechanism — out of this Campaign's routing scope. |

**Open questions for the user (need a decision BEFORE the build):**

| ID | Open question | Recommendation |
|---|---|---|
| **OD-1** | **The CP4-vs-CP2 tension:** a non-Claude backend REQUIRES an API key, but the live cost-safety guard throws on ANY key. Confirm the resolution = **per-backend key scoping** (a Claude agent's env stays Anthropic-key-free; a DeepSeek agent's env carries ONLY `DEEPSEEK_API_KEY`; a Codex agent's env carries ONLY `OPENAI_API_KEY`; each asserts no foreign billing key), with each non-Claude backend billed to ITS OWN metered key (real spend, separate from the Claude subscription). | **Yes** — it is the only way to have both the subscription-safe Claude path AND paid non-Claude agents without leaking credentials. Surfaced because it changes the "key-free, always" invariant into "scoped key" (a deliberate, safety-relevant relaxation for non-Claude backends ONLY). |
| **OD-2** | **API-adapter execution shape:** run a non-Claude agent as a **separate standalone OS process** (full crash isolation, parity with the claude-cli model) OR as an **in-runtime API client** (no cold-start, simpler) inside the supervisor? | **In-runtime client for v1** (simpler; a bare DeepSeek/Codex codegen turn has low blast radius — no FS/tools), with the contract identical so it can be moved to a separate process later if isolation is needed. (The standalone-process doc's crash-isolation argument applies most to FS-writing/long agents; a pure API turn is low-risk.) |
| **OD-3** | **Budget posture for paid backends:** is real per-token spend on DeepSeek + OpenAI/Codex approved (and any monthly ceiling), since these leave the Claude subscription? | Set a conservative per-backend monthly cap + per-dispatch token cap (X2); start DeepSeek-only (cheapest) and add Codex after the coding slice proves out. |
| **OD-4** | **Codex backend identity:** "Codex" = the OpenAI Codex/`gpt-*` coding models via the OpenAI API (OpenAI-compatible), correct? (Confirms the adapter target + the `OPENAI_API_KEY` secret name.) | Treat `reviewing=Codex` as OpenAI-API (OpenAI-compatible) so M5's single `ApiAdapterDriver` serves both DeepSeek + Codex by config (base-URL/model/key). Confirm the exact model id at P4. |
| **OD-5** | **Permission surface for non-Claude agents:** do api-adapter agents get ANY tool/FS access (then they need the permission router + a seal), or stay pure compute-in/text-out (no tools, no router) for v1? | **Pure compute-in/text-out for v1** (matches deepseek-codegen-mcp's HC-3 "no side effects") — simplest + safest; the capability descriptor (M1) declares `supportsTools:false` so FD4 skips them. Grant tools later per backend if needed. |

---

# Appendix — Evidence index (file:line / source)

- **Uniform contract = the existing seam:** `tools/supervisor/src/session-driver.ts` (`SessionDriver`, `SessionEvent`, `PermissionHandler`, `SessionStartOptions`).
- **Claude backend reuse:** `tools/supervisor/src/adapters/cli-stream-driver.ts` (`buildCliArgs`, `--setting-sources`, `--permission-prompt-tool stdio`, key-free env, tree-kill).
- **Driver-selection pattern to mirror for the role-router:** `tools/supervisor/src/driver-policy.ts`; the single construction site `tools/supervisor/src/index.ts:158-334`.
- **The seal (containment):** `tools/supervisor/src/profiles.ts:152-187` (`settingSources project,local`, deny-list), `launch-prod-orch.mjs:74-94` (`TELEGRAM_BOT_TOKEN` deleted, key-free env), `reference_hosted_claude_plugin_token_hijack`.
- **Cost guard to generalize (backend-aware):** `tools/supervisor/src/cost-safety.ts:35,51-87` (`BILLING_FLIPPING_ENV_VARS`, `assertCostSafe`).
- **Lifecycle/restart to generalize per-agent:** `tools/supervisor/src/lifecycle.ts`; **result-relay shape:** `tools/supervisor/src/session-host.ts` (`onResult`/`sendToOperator`), `tools/supervisor/src/channel-tool.ts` (the reply-tool pattern).
- **Worktree isolation to reuse:** `tools/supervisor/src/index.ts:266-272,379-394` (`SUPERVISOR_SESSION_CWD`, `SUPERVISOR_WORKTREE_CLEANUP`), `launch-pty-orch.mjs`.
- **DeepSeek backend precedent (key/error/pin/no-side-effects):** `tools/deepseek-codegen-mcp/core.py:16-48,88+`, `tools/deepseek-codegen-mcp/README.md` (HC-1..HC-4, `DEEPSEEK_API_KEY` env-only).
- **Standalone-process foundation (extended here):** `docs/proposals/standalone-process-agents-2026-06-19.md` (hybrid D.2, containment PART C, concurrency A.3).
- **Multi-provider + `/setkey` extension (PART Q, 2026-06-20):** `tools/supervisor/src/provider-registry.ts` (Provider/DEFAULT_PROVIDERS — DeepSeek/OpenAI/Groq/Gemini; `apiAdapterConfigForProvider`/`buildDefaultApiAdapterConfigs`/`buildProviderSecretEnvVars`), `tools/supervisor/src/secret-store.ts` (gitignored scoped store + masking), `tools/supervisor/src/setkey-command.ts` (`parseSetKeyCommand`/`redactSetKeyText`), `tools/supervisor/src/session-host.ts` (`/setkey` interception — gated on a wired secretStore), `tools/supervisor/src/supervisor.ts` (`redactInbound` + `deleteMessage`), `tools/supervisor/src/cost-safety.ts` (`BACKEND_SECRET_ENV_VARS` derived from the registry). Tests: `test/{provider-registry,secret-store,setkey-command}.test.ts`. Gemini uses its OpenAI-compat endpoint → the existing `ApiAdapterDriver` serves it (no new driver).
- **Vision + the SDK-vs-CLI teams gap:** memory `project_model_agnostic_agents_2026-06-19`, `reference_sdk_no_agent_teams` (teams in `claude -p`, not SDK query()).
- **Orchestrator Mode B/B2 (the independent-agent coordination this routing rides on):** `.claude/commands/orchestrator.md` (Mode B / B1 / B2).
- **De-risking (2026-06-19):** ≥64 concurrent sealed `claude -p` clean (no seat cap; rate/token-gated); `--setting-sources project,local` seals the plugin hijack — this session's live concurrency probe.
