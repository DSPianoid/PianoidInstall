# AI Assistant in the Pianoid UI — Proposal (rev 2: full control)

**Date:** 2026-10-13 · **Author:** `/analyse` (orchestrator-dispatched, research + docs only)
**Status:** PROPOSAL — awaiting user decisions (§9). **Implementation is blocked on the infrastructure prerequisites** in [assistant-infrastructure-2026-10-13.md](assistant-infrastructure-2026-10-13.md).
**Requests (Telegram, 2026-10-13):** (1) "propose a plan to embed AI assistant into the Pianoid interface." (2) 18:37 UTC: "The assistant should be able to modify parameters, change windows layouts, and initiate any actions like playback, measurement etc. Plan necessary infrastructure update before the assistant implementation. The editors should be synchronized with the backend on any change."

**Revision history:**
- **rev 1** (commit 0d01a05): read tools on the server; writes as Apply-button change sets applied by the frontend.
- **rev 2** (this): **full control.** The assistant executes parameter writes, layout and UI commands, and actions (playback, preset ops, renders, measurements, rig jobs) itself, through a unified command layer. A safety envelope plus confirmation **only for destructive or irreversible ops**. Editors stay correct because the backend broadcasts every change, which is the infrastructure prerequisite. rev 1 also stated that feedin/feedback are keyed by *mode*. That is **wrong**: they are keyed by *pitch* (`parse_range`). REST_API.md carries the same error, and fixing it is infra item I0.

**Prior art:** no other proposal covers an in-UI assistant. Related: [`standalone-process-agents-2026-06-19.md`](standalone-process-agents-2026-06-19.md), [`m12-host-supervisor-app-2026-06-14.md`](m12-host-supervisor-app-2026-06-14.md), `tools/supervisor/README.md`, [`model-agnostic-agents-2026-06-19.md`](model-agnostic-agents-2026-06-19.md).

**Docs read:** `docs/index.md` → `PROJECT_CONFIG.md` (`#frontend-stack` `#rest-endpoints` `#key-paths` `#data-model-facts` `#verification-surfaces`) → `architecture/SYSTEM_OVERVIEW.md` → `modules/pianoid-tunner/OVERVIEW.md` → `modules/pianoid-middleware/{OVERVIEW,REST_API}.md` → `tools/supervisor/README.md`. The source audit of write paths is in the infra doc §1.

---

## 1. Summary

| | |
|---|---|
| **Recommendation** | An **Assistant pane** (react-mosaic, MUI v6 dark) talks to an **assistant service in the Node launcher (`:3001`)**. The service runs the Claude API tool loop (Anthropic TS SDK tool runner) with the key kept on the server. **Its tools are generated from the unified command registry** (infra I4). Backend commands go to Flask `/command/<name>` (source=`assistant`). UI commands (layout, panes, workbenches, selection, zoom) go to the **leader tab's FE command bus** over the launcher `/ui-control` WS (infra I5). Every resulting state change is broadcast by the backend (infra I1), and every editor in every tab reconciles to it (infra I2). Undo is backend-side and grouped per assistant command (infra I3). The **MCP server is then a thin adapter** over the same registry. |
| **Model** | `claude-opus-5-5` at effort `medium` by default; `claude-sonnet-5-5` selectable; `claude-haiku-5-5` only for bulk digesting. |
| **Infrastructure first** | I0 data-model card → I1 backend broadcast → I2 FE sync (incl. half-open WS fix) → I3 backend undo; I4 command registry + jobs and I5 layout API in parallel. About 20–27 agent-days, critical path about 12–15 days. |
| **Assistant phases (after infra)** | A1 read, explain, diagnose + UI/layout control + playback (M) → A2 direct parameter and preset writes in the envelope, with grouped undo (M) → A3 renders, measurements, rig, calibration jobs (L) → A4 MCP adapter (S) → A5 preset generation / optimisation loops (L) |
| **Biggest risks** | Audio harm from direct writes (envelope + destructive confirms + undo); data-model mistakes (key spaces, stored vs effective); API spend; a global `ANTHROPIC_API_KEY` flipping Claude Code to paid billing (§7). |

---

## 2. Use cases ranked by value for this user

| Rank | Use case | Risk | Phase |
|---|---|---|---|
| 1 | **Diagnose audio and backend health:** silent ASIO hangs, rig dropouts, `output_scale.warning`, CFL rejections, half-open WS | low | A1 |
| 2 | **Drive the UI hands-free:** "open Modes and Feedin side by side, zoom to modes 0–40, select p48–p60", "show the stabilisation diagram for chain 12", "play C4 mf then the chord" | low (view + playback) | A1 |
| 3 | **Analyse and compare presets** (FPGA ports, Elyashev vs Belarus), with the assistant arranging the comparison panes itself | low | A1 |
| 4 | **Natural-language parameter editing**, executed directly and measured: "make the bass warmer", "reduce damping on mode 12 by 20%", "flatten the p40–p60 ripple". Each change is followed by a `note_playback` before/after metric and can be undone in one step. | **high** | A2 |
| 5 | **Drive measurements**: modal pipeline stages on `:5001`, rig `/audio/session`, calibration, with interpretation and opening of the result panes | high | A3 |
| 6 | **Explain a parameter or panel** with MkDocs citations (most valuable for collaborators) | none | A1 |
| 7 | **Generate presets** from a description or target response (render → measure → adjust loops on a working copy) | medium | A5 |

---

## 3. Architecture

### 3.1 Why rev 1's "frontend applies, backend silent" constraint goes away

rev 1 found that the backend has **no change broadcast**, so any write not made by the frontend leaves the editors stale. The infra doc §1 confirms it and goes further: there is **no single write choke point** (14 mutation-path classes B1–B14 bypass `Pianoid.apply_parameter_request`, including calibration, MIDI CC, `/excitation_energy` and `/modal/apply_to_preset`). The user's requirement ("editors synchronized with the backend on any change") is therefore a **platform fix needed regardless of the assistant**. Once it lands (infra I1 + I2), the assistant can write directly through the same command path as everything else. The no-speculative-emit principle holds because editors reconcile only to backend events.

### 3.2 Options (re-evaluated for full control)

| | (a) Pane + launcher service (Claude API) over the command registry | (b) Supervisor / Agent SDK as the runtime | (c) MCP server over the registry |
|---|---|---|---|
| Role in rev 2 | **Primary runtime** | Driver for long autonomous loops (A5) and the subscription-billing option (D1) | **Thin adapter** for Claude Code / orchestrator agents (A4) |
| Writes | `/command/*` with source=`assistant`; broadcast keeps editors in sync | same, through MCP or HTTP tools | same |
| UI control | in-process access to the launcher `/ui-control` relay to the leader tab | via an HTTP tool to the launcher | via an MCP tool to the launcher |
| Latency | low (no harness boot) | high (Claude Code harness) | client-dependent |
| Tool surface | exactly the registry | coding harness (Bash / Edit) must be locked down | exactly the registry |

**Recommendation: (a) as the in-UI runtime, (c) as a by-product, and (b) behind a driver seam.**

```
 Browser                                 Node launcher :3001                              Flask :5000 / modal :5001
 ┌──────────────────────────┐  SSE/WS  ┌──────────────────────────────────┐  HTTP     ┌──────────────────────────────┐
 │ AssistantPane            │◄────────►│ assistant: tool runner (TS SDK)  │──────────►│ /command/<name> (I4)         │
 │  chat · activity log ·   │          │  tools = registry (I4.0) → tiers │           │  → apply_parameter_request   │
 │  Undo group · Stop       │          │  policy.ts envelope · confirms   │           │  → StateJournal seq++ (I1)   │
 │                          │          │  /ui-control relay (I5) ─────────┼──┐        │  → jobs: started/progress    │
 │ FE command bus (I5) ◄────┼──────────┼──────────────────────────────────┘  │        └──────────────┬───────────────┘
 │ useBackendSync (I2) ◄────┼──────────┼───────── state_changed / preset_changed / job_* broadcast ◄──┘
 └──────────────────────────┘          │ key: PIANOID_ASSISTANT_API_KEY   │──HTTPS──► Claude API
                                       └──────────────────────────────────┘
```

---

## 4. Tool surface (= the command registry, infra I4)

### 4.1 Tiers (a field of every registry entry)

| Tier | Assistant behaviour | Examples |
|---|---|---|
| **read** | executes freely | health, audio devices, runtime params, preset list / summary, `get_parameter` (fields + range bounded), stability ratio, history, job status, docs search, UI snapshot |
| **ui** | executes freely (view only, leader tab, "assistant driving" chip with Stop) | `ui.pane.open/close/maximize/restore`, `ui.layout.set/apply_named`, `ui.workbench.select/spawn`, `ui.select.pitch/range/modes/param/level`, `ui.chart.tie/untie/zoom` |
| **act** | executes freely within rate limits | `play.note` / `play.chord` / `play.mode` / `play.stop`, `reset`, `midi_playback` start/stop |
| **write** | **executes directly** if inside the envelope (§4.3); outside it, asks for an override | `param.set` (string / mode / excitation / hammer / feedin / feedback / masks / sound_channel), `runtime.set` (volume / feedback slider), `preset.switch`, `preset.spawn_working_copy`, `history.undo/redo` |
| **destructive** | **always confirms** (dialog naming the side effect) | `preset.save` over an existing file, `preset.promote` (overwrites the original JSON), `preset.unload`, `preset.load` (full re-init), `render.*` (stops audio ~2 s), `level.recalibrate`, `calibration.*` (mic, minutes, rewrites hammer_mass), `modal.run_stage` / `modal.apply_to_preset`, `rig.session`, envelope overrides |
| **excluded** | never exposed | `/shutdown`, `/debug/audio_fault`, launcher kill / stop, project delete, `amplitude_gate_enabled=false`, raising `amplitude_limit`, mic device change |

### 4.2 Data-model rules the tools enforce (from `#data-model-facts`; I0 card)

- **feedin / feedback / masks / sound_channel are keyed by PITCH** (`parse_range`). Output pitches 128+ are accepted only for `feedback` / `feedback_mask`. `string_sound_channel` is effective only at 128+.
- `string.length` is in metres. Runtime `volume` is 0–127 MIDI. `feedback` 1–127 is mapped, while other values are taken as direct coefficients. `volume_center` is bare.
- Read before write: a `param.set` must follow a read of the same keys in the same turn (enforced by the launcher), so the model always knows the `from` values it reports and the journal can be cross-checked.
- Masks are mutes. Never write zeros into raw rows to silence something.

### 4.3 Safety model for direct execution

| Layer | Rule |
|---|---|
| **Envelope** (pure `policy.ts`, unit-tested; checked before every write) | Per command: `volume` up by at most +6 levels; feedback multiplier at most ×1.5 per step and ≤ 2.0 absolute; `mode.decrement` cut by at most 50% per step and never < 0; string edits blocked when the prospective CFL ratio is > 0.98 (`stability_ratio`); `string_damping` / gain changes by at most ×2 per step; at most 128 keys per command; at most 20 writes per assistant turn. Outside the envelope, the assistant must ask (an override confirm). |
| **Working copy** | If the active entry is a read-only original, the assistant **auto-spawns a working copy** (non-destructive) and says so. It never edits originals (B6's guard bug is fixed in I1). |
| **Grouped undo** | Every assistant command carries a `groupId`. The pane shows an activity log with **Undo** per group and **Undo all from this turn** (infra I3). A `Stop` button aborts the turn, cancels running jobs and leaves already-applied groups undoable. |
| **Level awareness** | Layer B classes: shape edits mark `output_scale` stale (reported); level edits report a predicted dB change; after any level-class write the assistant runs or offers `render.note_playback` p60 v127 and auto-reverts the group if the peak exceeds target + 3 dB (the user can re-apply). |
| **Feedback / limits** | Never touch `amplitude_gate_enabled` / `amplitude_limit`. Measured fact in the prompt: lower feedback is louder but stable, and the risk is clipping. |
| **Leader tab / multi-tab** | UI commands go only to the leader. Writes come from the service (any tab sees them through I2). |
| **Rate limits** | at most 1 render per 5 s, at most 1 running long job, at most 10 notes/s, a per-tool timeout, and a session token budget |
| **Prompt injection** | Preset names, docs and logs are labelled tool data. Excluded tools are absent from the tool list, not just refused. |

---

## 5. Context strategy

| Layer | Content | Size (est.) | Caching |
|---|---|---|---|
| Tools | generated from the registry (descriptions carry units, key spaces, tier) | ~5–7k | stable order (registry sorted) inside the cached prefix |
| System (frozen) | role, envelope rules, data-model facts, Layer B classes, **parameter glossary** (P0) | ~6–10k | explicit `cache_control` on the last system block (1 h TTL if sessions are bursty, otherwise 5 min; the 512-token minimum is met) |
| Conversation | turns + tool results | grows | top-level automatic caching for the tail; compaction (beta) + tool-result clearing for long sessions |
| Per-turn volatile | `ui.snapshot` digest (active entry + version, selection, visible panes, running jobs, last 5 `state_changed` from other sources) | ~400 | after the last breakpoint, never in `system` |
| Docs | `search_docs` over the MkDocs `search_index.json` → section + `localhost:8001` link | per call | — |
| Presets | summaries / bounded `get_parameter` only (presets are about 2.7 MB JSON) | ≤ 4k per result | — |

API notes (claude-api reference): Opus 5.5 always thinks, so tune `effort`; forced `tool_choice` returns 400, so use `auto` + `strict: true` schemas (generated from the registry JSON Schemas); stream to the pane; validate eagerly streamed tool inputs against the schema before executing; handle `stop_reason: "refusal"` with `fallbacks: "default"`; watch `usage.cache_read_input_tokens`.

---

## 6. Phased plan (re-sequenced on the infrastructure)

**Gate:** each A-phase lists the infra items it needs. Infra details, tasks and verification are in [assistant-infrastructure-2026-10-13.md](assistant-infrastructure-2026-10-13.md).

| Phase | Needs | Scope | Files / modules | Verification surface | Effort |
|---|---|---|---|---|---|
| **P0** | — | User decisions D1–D7; `docs/guides/PARAMETER_GLOSSARY.md`; confirm the MkDocs search index; key storage | PianoidInstall docs (+ `mkdocs.yml` nav, structural, needs approval) | user review | S |
| **A1: read, explain, diagnose, drive the UI, play** | I1, I2, I4.0, I5 | Assistant pane (chat, activity log, Stop, cost footer, model / effort picker); launcher service + tool runner; read / ui / act tiers; `search_docs`; UI snapshot per turn | PianoidTunner `server/assistant/{router,runner,prompt,registryTools,summarise,docsIndex,keyStore,policy}.js`, `server/launcher.js`; `src/components/Assistant/*`; `src/hooks/useAssistant.js`; pane registry entry | Node tests with a fake client (zero spend); Jest for the pane; live (`/pianoid-ui` + chrome-devtools): "open Modes + Feedin side by side and zoom modes 0–40" → screenshot; "why no sound" with the backend down / up; play note → `/playback_stats` count increases; a follower tab cannot be driven | M (3–4 d) |
| **A2: direct writes** | + I3, I4.1–4.2 (param / preset / runtime families) | `write` tier executed directly within the envelope; auto working copy; grouped undo UI; post-write `render.note_playback` metric + auto-revert on a level breach; override confirm | `policy.js` (+ tests), activity-log Undo; no new backend code (registry + journal exist) | **audio_off `note_playback`:** an assistant command and the identical manual edit give **bit-identical buffers**; Undo restores the pre-edit buffer bit-exactly; the open editor (and a second tab) shows the change within the I2 latency bound; envelope tests | M (2–3 d) |
| **A3: jobs** | + I4.1 jobs, I4.3 (calibration / modal / rig families) | destructive-tier jobs with confirm; progress from `job_*` events; interpretation; opens result panes | `server/assistant/jobs.js`, pane job cards | **audio_on (`/diagnose`)** for calibration / rig; modal stage results equal to a manual run; rig-absent → clean diagnosis, no hang | M–L (3–4 d) |
| **A4: MCP adapter** | I4 | stdio MCP server generated from the registry (tiers → MCP annotations; destructive via elicitation / confirm) for Claude Code, the orchestrator, `/pianoid-ui`, `/test-ui` | PianoidInstall `tools/pianoid-mcp/` (Node), `.mcp.json` template | Claude Code `list_tools`; a write through MCP shows in the open editor (I2 surface) | S (1–2 d) |
| **A5: generation / optimisation** | A2, A3 | "a preset like X", "match this target": a working copy + propose → render → measure loop; long runs through the driver seam (supervisor / Agent SDK); an "escalate to orchestrator" button carrying a bug-report JSON | `server/assistant/drivers/{api,supervisor}.js`; supervisor channel adapter | metric convergence; every step undoable; spend within the task budget | L |

---

## 7. Costs and billing

Estimates per turn, before measurement (Opus 5.5 $4 / $20 per MTok, cache read $0.20; Sonnet 5.5 $2 / $10, cache read $0.20):

| Turn | Opus 5.5 | Sonnet 5.5 |
|---|---|---|
| explain / UI command (1–2 tools) | ≈ $0.035 | ≈ $0.018 |
| diagnose / compare (3–6 tools) | ≈ $0.11 | ≈ $0.06 |
| edit + render verify (4–6 tools) | ≈ $0.15 | ≈ $0.08 |

Typical use (20–40 turns a day) costs about $1–4/day; heavy use (100 turns) about $5–10/day on Opus. The A1 cost footer replaces these estimates with measured `usage` after a week. Controls: a session token budget, a daily cap (D7), and the model picker.

**Billing catch.** `tools/supervisor/src/cost-safety.ts` treats `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` in the environment as switching billing to the API. A globally exported key would flip the user's Claude Code sessions to paid billing. Use a **launcher-only** `PIANOID_ASSISTANT_API_KEY` or a gitignored 0600 key file (`secret-store.ts` masking pattern), passed explicitly to `new Anthropic({ apiKey })`, never sent to the browser, never logged. The launcher binds to 127.0.0.1.

---

## 8. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Editor desync | Critical | **removed as a design constraint** by infra I1 / I2 (broadcast + reconcile + resync), verified by the latency, multi-tab and half-open surfaces |
| R2 | Loud, clipping or unstable output from direct writes | Critical | envelope, destructive confirms, level check + auto-revert, grouped undo, gate and limit excluded |
| R3 | Wrong key space / units / stored-vs-effective | Major | I0 data-model card, registry schemas carry units and key spaces, read-before-write enforced |
| R4 | Engine disturbance | Major | LLM loop in the launcher, not `:5000`; I1 emits outside `cuda_lock`; renders and jobs rate-limited |
| R5 | The assistant fighting the user (simultaneous edits) | Major | the user's edits win by `seq`; the assistant sees foreign `state_changed` in its per-turn context; Stop button |
| R6 | API spend | Major | budgets, cost footer, model picker, verified caching |
| R7 | Key leakage / billing flip | Major | launcher-only key (§7) |
| R8 | Third-party rig data (Elyashev) sent to the API | Major (policy) | D4; per-project opt-out blocks the modal and rig tools |
| R9 | Infra scope (≈ 3–5 weeks before the first assistant byte) | Major (schedule) | I2.4 / I5 / I4.0 in parallel; A1 can start once I1 + I2 + I5 land (I3 / I4.1+ not needed for A1) |

---

## 9. Open decisions for the user

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Billing / runtime | (i) API key through the launcher; (ii) subscription through the supervisor / Agent SDK driver | (i) for A1–A4; (ii) behind the seam for A5 |
| D2 | Default model | Opus 5.5 medium / Sonnet 5.5 / per use case | Opus 5.5 medium, Sonnet selectable |
| **D3 (restated)** | **Execution autonomy** | **The assistant executes directly** (parameter writes, UI / layout, playback, preset switch, working copies) inside the envelope; **confirm only for destructive or irreversible ops** (save over a file, promote, unload, full load, renders, recalibration, calibration, modal apply, rig jobs, envelope overrides). Open sub-choices: (a) should renders (audio stops ~2 s) be destructive-tier or free? (b) should the post-write auto-revert on a level breach be on by default? | as stated; (a) destructive-tier at first; (b) on |
| D4 | Data sharing | may preset / measurement data incl. Elyashev captures go to the API? | user / collaborator call; per-project opt-out either way |
| D5 | Audience | user only / collaborators too | affects the explain weight and whether to tighten the envelope |
| D6 | Infra sequencing | all infra before A1 / start A1 after I1 + I2 + I5 (recommended) | start A1 after I1 + I2 + I5 |
| D7 | Spend cap | daily $ cap | start at $5/day |

---

## 10. /analyse bookkeeping

- **Documentation defects found (not edited; scheduled as infra I0):** (1) REST_API.md "`key_no` formats" wrongly says feedin / feedback keys are mode ranges; `parse_range` and the FE use pitches. (2) No doc states that out-of-FE writers leave editors stale, or lists the mutation paths (infra §1 is the first inventory). (3) There is no parameter glossary.
- **Latent bug found:** `/modal/apply_to_preset` (preset_injector → `ParameterManager` directly) skips `_assert_active_editable` and the Layer B edit policy, so it can modify a read-only original. Fixed by infra I1.3.
- **Tests to add:** see infra §9 (state-event coverage, latency, multi-tab, half-open, undo bit-exactness, command contract) plus A-phase surfaces in §6.
