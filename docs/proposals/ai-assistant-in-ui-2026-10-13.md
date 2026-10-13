# AI Assistant in the Pianoid UI — Proposal

**Date:** 2026-10-13 · **Author:** `/analyse` (orchestrator-dispatched, research + proposal only — no source edits)
**Status:** PROPOSAL — awaiting user decisions (§9)
**Request (Telegram, 2026-10-13):** "propose a plan to embed AI assistant into the Pianoid interface."
**Prior art:** no earlier proposal covers an in-UI assistant (checked `docs/proposals/` + `archive/` + `parked/`), so nothing was archived. Related: [`standalone-process-agents-2026-06-19.md`](standalone-process-agents-2026-06-19.md), [`m12-host-supervisor-app-2026-06-14.md`](m12-host-supervisor-app-2026-06-14.md), `tools/supervisor/README.md`, [`model-agnostic-agents-2026-06-19.md`](model-agnostic-agents-2026-06-19.md).

**Docs read (Documentation-First):** `docs/index.md` → `PROJECT_CONFIG.md` (`#frontend-stack` `#rest-endpoints` `#key-paths` `#data-model-facts`) → `architecture/SYSTEM_OVERVIEW.md` (FE↔BE state discipline) → `modules/pianoid-tunner/OVERVIEW.md` (`usePreset`, history hooks, tab leadership, bug-report tool, mosaic) → `modules/pianoid-middleware/REST_API.md` (WS channel, parameter endpoints + safety net, runtime params, Layer B `output_scale`, health) → `tools/supervisor/README.md` + `src/` (cost-safety, secret-store, session-driver, permission-router). Source was read only to confirm what the docs say about the supervisor modules.

---

## 1. Summary

| | |
|---|---|
| **Recommendation** | **Option (a), with a tool layer you can reuse.** Add an **Assistant pane** (react-mosaic, MUI v6, dark theme) that talks to a **new assistant service inside the Node launcher (`:3001`)**. The service calls the Claude API (Anthropic TS SDK tool runner) and keeps the key on the server. **Read tools** run on the server. **Write tools** only *propose* a change set. The **frontend applies it through `usePreset.writeParam`**, the same single path every UI edit already takes, once the user clicks Apply. The same tool registry is later published as an **MCP server** (option c, Phase 4), after the backend gains a `param_changed` broadcast. The supervisor (option b) is **not** the runtime. We reuse its patterns (driver seam, permission router, secret store, cost-safety) and keep a driver seam so a subscription-billed runtime can be added later. |
| **Default model** | `claude-opus-5-5` at effort `medium` (its default). The pane offers `claude-sonnet-5-5` as the cheaper option. `claude-haiku-5-5` is used only for bulk summarising (doc and preset digests). |
| **Phases** | P0 decisions + glossary (S) → **P1 read-only assistant: explain, inspect, diagnose (M)** → **P2 proposed edits with confirm, undo and an audio-safety policy (L)** → P3 measurement and rig jobs (L) → P4 backend broadcast + MCP server (M) → P5 preset generation / optimisation loops (L) |
| **Biggest risks** | (1) UI desync if anything writes to the backend outside `usePreset`. (2) Audio harm from level or feedback edits. (3) Wrong data-model inference: pitch vs output-pitch key space, units, same-name pairs. (4) API spend. (5) An `ANTHROPIC_API_KEY` in the shared environment would flip the user's Claude Code sessions to paid API billing (§7). |

---

## 2. Use cases ranked by value for this user

The user builds the engine, runs rig measurements with D. Elyashev, and ports FPGA presets. Ranking = value × frequency ÷ risk.

| Rank | Use case | Why it ranks here | Risk | Phase |
|---|---|---|---|---|
| 1 | **Diagnose audio and backend health.** "Why is it silent?", "is the rig OK?", "why is `output_scale.warning` set?" | Recurring pain: silent ASIO hangs that still report healthy, rig dropouts, `output_scale` load-settings mismatch, CFL rejections, half-open WS. All the needed data is read-only (`/health`, `/audio/devices`, `/get_runtime_parameters`, `/calibration_status`, launcher `/api/backend-status` + console WS). | Low (read-only) | P1 |
| 2 | **Analyse and compare presets.** "Compare Belarus_8band vs F15_Elyashev modes 0–40", "which pitches have outlier excitation curves", "is this FPGA port's damping plausible?" | Very frequent in the FPGA-port and Elyashev work. Presets are about 2.7 MB of JSON, too big for a human to diff. The assistant can summarise with server-side statistics. | Low (read-only) | P1 |
| 3 | **Natural-language parameter editing with measured feedback.** "Make the bass warmer", "reduce damping on mode 12 by 20%", "flatten the p40–p60 volume ripple" | The headline feature. It is only worth having if each edit is **measured**: an offline `note_playback` render before and after, reporting peak dBFS, decay and spectral centroid, rather than trusted. | **High.** Level, feedback and stability edits are where harm happens. | P2 |
| 4 | **Explain a parameter or panel**, citing MkDocs | Moderate value for the user, who already knows the system. High for collaborators and testers. Cheap to build and the risk is zero. | None | P1 |
| 5 | **Drive measurements** (modal pipeline on `:5001`, rig `/audio/session`, calibration) **and interpret the results** | High value (mode discovery with Dima), but jobs run for minutes, engage the mic or rig, and fail in hardware-specific ways. Needs async job tools and strict gating. | High (rig, mic, long jobs) | P3 |
| 6 | **Generate presets** from a description or a target response | Research-grade work: render, measure, adjust loops. The least predictable outcome and the highest spend. | Medium (always on a working copy) | P5 |

---

## 3. Architecture options

### 3.1 What the docs establish (constraints any option must meet)

| Fact | Source | Consequence |
|---|---|---|
| The frontend applies edits optimistically; **the backend is the single source of truth**. Editors re-sync only when a preset-replacing event bumps `presetVersion`. | SYSTEM_OVERVIEW "Frontend ↔ Backend State Discipline" | A write that bypasses the frontend (curl, MCP, a server-side tool) **leaves every open editor showing stale values**. The backend pushes `param_ack` / `lifecycle` / `calibration` / `engine_error`, but **no `param_changed` broadcast** exists (REST_API WS table; middleware OVERVIEW emit list). |
| Every param write already passes **one chokepoint**: `usePreset.writeParam`. It handles WS-with-ack, falls back to REST, debounces per key, and records into the bug-report `actionRecorder`. | Tunner OVERVIEW `usePreset` (F1/F4/F11) + bug-report tool | An assistant write that goes through `writeParam` gets transport, debounce, flush-on-switch and replay logging for free. |
| Principle 3: **emits happen imperatively at the user-action site**, never from a `useEffect` that watches state. | SYSTEM_OVERVIEW | The **Apply click on a change card** is the user-action site. The assistant never emits on its own. |
| The backend safety net rejects only **catastrophic** input: NaN/Inf, `decrement<0`, `mass_inv<=0`, `sigma<=0`, CFL `|g|>1`. "Range bounds beyond these … are NOT validated" (dev-2706). | REST_API "Engine safety net" | The assistant needs its **own** audio-safety envelope (§4.4). The backend will happily accept "feedback ×8" or "volume 127", which is +29 dB and clips according to the Layer B notes. |
| **Tab leadership**: only the leader tab performs automatic backend writes. | Tunner OVERVIEW `useTabLeadership` | Assistant writes only from the leader tab. A follower tab's pane is read-only and shows "Use this tab". |
| Library entries can be read-only (`activePresetReadOnly`). Working copies come from `/preset/spawn_working_copy`. | Tunner OVERVIEW / REST_API preset library | Edits go to a **working copy**. That is a natural sandbox, and discarding the copy rolls everything back. |
| `/get_chart_test note_playback` stops the realtime thread, renders offline, then restarts it. `/recalibrate_output_level` follows the same stop → render → restart pattern. | SYSTEM_OVERVIEW; REST_API Layer B | Before/after renders are possible on a live stack, but they cause audio dropouts and are GPU-exclusive. Treat them as **gated, rate-limited** tools. Memory note: any *other* offline render on a live backend page-faults (0xC0000006), so expose only these documented routes. |
| The Flask `:5000` process hosts the realtime engine. Host-thread preemption was the cp0→cp1 overrun root cause. | memory `project_cp0cp1_host_preemption_solved` | **Do not host the LLM loop in the engine process.** HTTP streaming, JSON and the SDK would all compete with the synth thread. |
| The launcher (`:3001`, Node) already owns backend lifecycle REST + console WS and runs whenever the user's normal `npm run dev` does. | PROJECT_CONFIG `#ports`; Tunner OVERVIEW launcher | Natural home for the assistant service: outside the engine process, already Node, and same-origin with the dev server's proxy. |

### 3.2 The three options

| | (a) FE pane + backend proxy (Claude API) | (b) Local Claude Code / Agent SDK supervisor as runtime | (c) MCP server over Pianoid REST/WS |
|---|---|---|---|
| **Shape** | Assistant pane ⇄ launcher `/api/assistant/*` (streaming) ⇄ Claude Messages API, using a TS SDK tool runner over Pianoid tools | Pane ⇄ supervisor (`tools/supervisor`) hosting a `claude -p` / Agent SDK session, with the UI as a new channel adapter | Standalone MCP server (stdio or HTTP) exposing tools. Any Claude client (Claude Code, Desktop, orchestrator agents) drives Pianoid. |
| **Latency** | Low. First token in about 1–3 s, no harness boot. | High. Harness boot, plus a CLI-sized system prompt and tool set for every session. | Depends on the client. |
| **Tool control** | Exact: only the tools we define | The Claude Code harness ships Bash/Edit/Write/WebFetch. They must be locked down, which is wrong for a music UI. | Exact |
| **UI coherence** | **Writes go through the frontend chokepoint**, so the editors stay correct | Writes happen server-side and bypass the frontend, so the UI desyncs (unless the P4 broadcast exists) | Same as (b): needs the P4 broadcast |
| **Billing** | Pay-per-token API key (§7) | Can use the Claude subscription, as the supervisor does today (`cost-safety.ts`). See open decision D1. | Rides whatever client is used |
| **Maturity** | New code, standard SDK patterns | Supervisor Phases 1–2 are built. **Phase 3 (production cut-over) is not done.** It is Telegram- and orchestrator-shaped. | New code, small |
| **Reuse** | Borrows supervisor *patterns* | Reuses the supervisor *directly*: `SessionDriver` seam, `permission-router` (canUseTool → UI approval instead of Telegram), capture store | Shares the tool registry with (a) |
| **Best for** | The in-UI chat the user asked for | Long autonomous jobs (P5 optimisation loops, "escalate to orchestrator") | Letting **Claude Code / orchestrator agents** drive Pianoid. It would replace the ad-hoc curl in `/pianoid-ui` and `/test-ui`. |

### 3.3 Recommendation

**Build (a) now. Design the tool registry once so it also serves (c) in P4. Keep a driver seam so (b) can be plugged in later for P5 or for subscription billing.**

```
 Browser (leader tab)                         Node launcher :3001                       Claude API
 ┌───────────────────────────┐   SSE/WS   ┌───────────────────────────────┐  HTTPS  ┌──────────────┐
 │ AssistantPane (mosaic)    │◄──────────►│ /api/assistant/chat (stream)  │◄───────►│ messages     │
 │  ├ chat log + citations   │            │  tool runner (TS SDK)         │         │ (opus-5-5)   │
 │  ├ ChangeSetCard (diff,   │            │  ├ READ tools ──► :5000 / :5001 GET      └──────────────┘
 │  │  Apply / Reject /      │            │  ├ DOCS tool  ──► mkdocs search_index.json
 │  │  Revert)               │            │  ├ WRITE tools ─► return a ChangeSet proposal (no I/O)
 │  └ useAssistant ──────────┼─ Apply ───►│  ├ JOB tools  ──► gated, async (P3)
 │        │                  │            │  └ policy.ts (audio-safety envelope, pure)
 │        ▼                  │            │ key: PIANOID_ASSISTANT_API_KEY (launcher-only)
 │ usePreset.writeParam  ────┼── WS/REST ─► :5000 (unchanged single write path)
 └───────────────────────────┘
```

Why not (b) as the MVP runtime: it has the wrong tool surface (a coding harness), heavy per-session start-up, a supervisor that is not yet cut over, and server-side writes that desync the UI. Its **billing advantage** is real. That is open decision D1, and the driver seam keeps it open without a rewrite.

---

## 4. Tool surface

### 4.1 Tool tiers

| Tier | Executed where | Confirmation | Examples |
|---|---|---|---|
| **R: read** | launcher → backend GET | none | health, params, presets, docs |
| **P: propose-write** | **no I/O.** Returns a `ChangeSet`. The frontend applies it through `writeParam`. | **Always**: Apply button on the change card (D3 may allow auto-apply inside a safe envelope) | string / mode / excitation / hammer / deck / mask / runtime edits |
| **G: gated action** | launcher, after an explicit confirm dialog naming the effect ("stops audio ~2 s") | **Always**, every call | offline render, save, promote, load / switch, recalibrate, modal jobs, rig session |
| **X: excluded** | never exposed | n/a | `/shutdown`, `/debug/audio_fault`, `/api/kill-stale`, `/api/stop-backend`, `/modal/projects/delete`, `amplitude_gate_enabled=false`, raising `amplitude_limit`, `/set_mic_device` |

### 4.2 Endpoint → tool map

| Tool | Tier | Backing endpoint(s) | Notes |
|---|---|---|---|
| `get_health` | R | `GET /health`, launcher `GET /api/backend-status`, last N lines of console WS | Includes the `output_scale` block, driver fallback and `gpu_available` |
| `get_audio_devices` | R | `GET /audio/devices` | ASIO snapshot for rig diagnosis |
| `get_runtime_parameters` | R | `GET /get_runtime_parameters` | volume / feedback / centre / range / gate |
| `list_presets` | R | `GET /preset/list` | `{name, kind, source, path}` records + active |
| `get_preset_summary` | R | `/health` + `GET /get_parameter/{string,mode,excitation}/all` → **summarised in the launcher** | num_modes, channels, listen_to_modes, pitch range, per-param min/median/max and outliers. Never the raw 2.7 MB. |
| `get_parameter` | R | `GET /get_parameter/<p>/<key_no>` | Required `fields[]`, range ≤ 128 rows, numbers rounded. Larger requests return statistics plus a downsample. |
| `get_stability_ratio` | R | `GET /get_parameter/stability_ratio/<range>` | CFL headroom before proposing string edits |
| `compare_presets` | R | two summaries + per-field diff | Works on library entries already loaded. Loading a new one is G. |
| `get_ui_context` | R | sent by the frontend with every turn | active preset + read-only flag, selected pitch / modes / param / level, visible panes, leader-tab flag |
| `search_docs` | R | MkDocs `site/search/search_index.json` (lunr; created by `mkdocs build`) | Returns sections + `http://localhost:8001/...#anchor` links for citations |
| `get_modal_status` | R | `:5001 GET /modal/data_status`, `/modal/project_state`, `/modal/status`, `/calibration_status` | progress of P3 jobs |
| `propose_string_params` | P | → `writeParam('string', …)` → `/set_parameter/string/<k>` | `length` is in **metres** (REST_API note) |
| `propose_mode_params` | P | → `/set_parameter/mode/<k>` | key = mode number |
| `propose_excitation` / `propose_hammer_shape` | P | → `/set_parameter/excitation/<k>`, `/set_hammer_shape/<p>` | shape edits clear `output_scale_calibrated` (Layer B edit policy). Surface that in the card. |
| `propose_deck_rows` | P | → `/set_parameter/{feedin,feedback}/<k>` (+ `_mask`) | key = **mode range**. Output pitches 128+ only for `feedback`/`feedback_mask`. |
| `propose_runtime` | P | → `set_runtime_parameters` | volume / feedback slider only, inside the envelope (§4.4) |
| `render_note` | G | `POST /get_chart_test` `note_playback` | before/after measurement: peak dBFS, RMS decay, spectral centroid computed in the launcher. Audio drops for about 2 s. |
| `spawn_working_copy` / `switch_preset` / `save_preset` / `promote` | G | `/preset/*`, `/save_preset` | `promote` overwrites the original JSON, so it gets a double confirm |
| `recalibrate_output_level` | G | `POST /recalibrate_output_level` | stop / render / restart, 2–18 s |
| `run_modal_stage` | G | `:5001 /modal/run_*` (async) + `get_modal_status` | P3 |
| `rig_session` | G | `POST /audio/session` | P3. Requires the rig to be present (memory: rig drops). |
| `ui_open_pane` / `ui_select` | R (UI) | frontend-only: `useWindowManager`, `useCurrentValues` | "show me" actions. These change only the view. |

### 4.3 The ChangeSet contract (how writes stay single-source-of-truth)

```ts
type ChangeSet = {
  id: string; rationale: string;            // model's one-line why
  target: { preset: string; mustBeWorkingCopy: true };
  edits: Array<{ kind: 'string'|'mode'|'excitation'|'hammer'|'feedin'|'feedback'|'feedin_mask'|'feedback_mask'|'runtime';
                 key: string;               // "57" | "from21to40" — same key grammar as /set_parameter
                 field: string; from: number; to: number }>;  // `from` read by the launcher just before proposing
  predicted?: { levelDb?: number; cfl?: 'ok'|'near'|'reject' }; // from policy.ts
};
```

1. The model calls `propose_*`. The launcher reads the current values (`from`), runs `policy.ts`, and returns the ChangeSet to the model and to the pane. **No backend write happens.**
2. The pane renders a `ChangeSetCard`: a table of field, key, from → to, Δ%, any policy warnings, then **Apply / Reject**.
3. **Apply** is the user-action site (Principle 3). `useAssistant.applyChangeSet` calls the *existing* `usePreset` mutators (`changeParametersOfStrings`, …), which emit through `writeParam`. That gives bulk-range emits, WS ack with REST fallback, flush-on-switch, and `actionRecorder` entries tagged `source:'assistant', changeSetId`.
4. Then **Verify**: the backend ack, plus a read-back GET of the edited keys. A mismatch is reported to the model as a tool result.
5. **Revert**: the pane keeps the applied ChangeSets as a stack (an *assistant history*, separate from the per-editor `useMatrixHistory` / `useValuesHistory`). Revert applies the inverse (`to → from`) through the same path. Deck edits are also pushed into `useMatrixHistory` so the matrix editors' own undo sees them. A `presetVersion` bump (full reload or switch) clears the assistant history, mirroring Principle 1.
6. If the active entry is read-only, the card's Apply button becomes **"Spawn working copy & apply"** (tier G).

### 4.4 Safety model

| Layer | Rule |
|---|---|
| **Envelope (pure `policy.ts`, unit-tested)** | Per ChangeSet: runtime `volume` up by at most +6 levels (about +2.9 dB at range 10); feedback multiplier at most ×1.5 per step and ≤ 2.0 absolute without a G-confirm; `mode.decrement` cut by at most 50% per step and never < 0; `string` edits blocked when the prospective CFL `ratio > 0.98`, since the backend rejects at > 1; `string_damping` / `string_gain` changes by at most ×2 per step; at most 128 keys per ChangeSet. Anything outside the envelope comes back as `needs_override` with the reason, and the user must tick an override box. |
| **Level awareness** | Classify each edit with the documented Layer B classes. **Shape** edits (excitation, hammer) mark `output_scale` stale, so the card shows "level will be re-calibrated on next legal calibration". **Level** edits (mass, speeds, impulse calibration) are loudness by design and show a predicted dB change. **Physics** edits are kept as heard. After any level-class edit, offer `render_note` for p60 v127 and warn if the measured peak is above the preset's `output_scale_target_dbfs` + 3 dB. |
| **Feedback** | Never touch `amplitude_gate_enabled` / `amplitude_limit` (tier X). Measured fact for the prompt: lower feedback is louder but stable, and the real risk is clipping (memory `project_feedback_coeff_is_damping`). |
| **Destructive ops** | Every tier-G call opens a confirm dialog stating the side effect (audio stop, overwrite, minutes of GPU time). `promote` and `save` over an existing file get a second confirm. Tier X is never exposed. |
| **Leader tab only** | Write and job tools are disabled in follower tabs (`useTabLeadership.isLeader`). |
| **Rate limits** | At most 1 `render_note` per 5 s and at most 1 running modal job. Every tool call has a timeout. Each session has a hard token budget (§7). |
| **Data-model facts** | The system prompt carries the `#data-model-facts` list verbatim: piano pitches 0–127 vs output pitches 128+; `string_sound_channel` effective only at 128+; `deck` and `sound_channel` same-name pairs; feedin/feedback keyed by **mode**; `length` in metres; volume 0–127 MIDI scale; the feedback 1–127 vs direct-coefficient auto-detect. Rule: **read before you write.** Every propose call must follow a `get_parameter` of the same keys in the same turn, and the launcher enforces it. |
| **Prompt injection** | Preset names, doc text and console logs are tool *data*. They are wrapped and labelled as such. The model cannot reach tier X. |

---

## 5. Context strategy

| Layer | Content | Size (est.) | Caching |
|---|---|---|---|
| **Tools** | about 20 tool schemas with tight descriptions (units, key grammar) | ~4k tokens | stable order, so it sits inside the cached prefix |
| **System (frozen)** | role, safety rules, data-model facts, Layer B edit classes, a **parameter glossary** (new doc: param → meaning, units, range, panel, doc link; generated once from the module docs and reviewed) | ~6–10k | **explicit `cache_control` on the last system block.** Use a 1 h TTL if sessions are bursty (D-cost); otherwise the default 5 min. The 512-token minimum is easily met on opus-5-5 / sonnet-5-5 / haiku-5-5. |
| **Conversation** | turns + tool results | grows | top-level automatic caching for the tail; enable **compaction** (beta) for long sessions; clear old tool results (context editing) |
| **Per-turn volatile** | `get_ui_context` snapshot (active preset, selection, panes) | ~300 | appended **after** the last breakpoint as a user-turn block. Never put it in `system`, because that would invalidate the cache. |
| **Docs** | retrieved on demand with `search_docs` (lunr index from `mkdocs build`). REST_API.md alone is about 180 KB, so never inline whole docs. | per call | none |
| **Presets** | never raw. `get_preset_summary` / `get_parameter(fields, range)` with statistics and downsampling done in the launcher. | ≤ 4k per result | none |

Notes from the claude-api reference: Opus 5.5 always thinks (no `disabled`); use `effort` (`medium` default; `low` for quick explain turns). Forced `tool_choice` returns 400, so use `auto` + `strict: true` tool schemas. Stream to the pane (SSE). Set `eager_input_streaming` on tools and validate the parsed input against the schema before executing. Handle `stop_reason: "refusal"` and enable server-side `fallbacks: "default"`. Show `usage.cache_read_input_tokens` in a debug footer to catch silent cache invalidators.

---

## 6. Phased plan

Effort: S = hours, M = 1–2 days, L = 3+ days (agent-days, including verification).

### P0: decisions and groundwork (S)
| | |
|---|---|
| **Scope** | User answers D1–D6. Write `docs/guides/PARAMETER_GLOSSARY.md` from the module docs, with data-model facts and units, reviewed by the user. Confirm `mkdocs build` writes `site/search/search_index.json`. Key-storage scheme (§7). |
| **Files** | PianoidInstall: `docs/guides/PARAMETER_GLOSSARY.md`, `mkdocs.yml` nav (structural, so needs approval). |
| **Verify** | Glossary reviewed by the user. Index file exists. |

### P1: read-only assistant: explain, inspect, diagnose (M, about 3–4 days)
| | |
|---|---|
| **Scope** | Assistant pane (mosaic leaf `"Assistant"`, MUI v6 dark, dense, streaming markdown, doc-link citations, model and effort selector, cost footer). Launcher service with tier-R tools + `search_docs` + `get_ui_context` + UI view tools. Use cases 1, 2 and 4. |
| **Files** | **PianoidTunner:** `server/assistant/{router.js, runner.js, prompt.js, tools/*.js, summarise.js, docsIndex.js, keyStore.js}`; mount in `server/launcher.js`; `src/components/Assistant/{AssistantPane.jsx, MessageList.jsx}`; `src/hooks/useAssistant.js`; register the pane in the panel registry / `useWindowManager`; `package.json` (+`@anthropic-ai/sdk`, `zod`). **PianoidCore:** none. **PianoidInstall:** `docs/modules/pianoid-tunner/ASSISTANT.md`. |
| **Verify** | Node `node --test` for tool schemas, summariser and key store (fake client, **zero spend**). Jest for the pane. Live via `/pianoid-ui` + chrome-devtools: (i) "what does string_damping do" returns a cited `localhost:8001` link; (ii) "why no sound" with the backend stopped vs running gives a correct diagnosis from `/health`; (iii) compare two loaded presets; (iv) a network log showing **zero** backend writes. No synthesis change, so no audio surface is needed. |

### P2: proposed edits with confirm, undo and the audio-safety policy (L, about 5–7 days)
| | |
|---|---|
| **Scope** | Tier-P tools + ChangeSet contract (§4.3), `ChangeSetCard`, apply through the `usePreset` mutators, assistant history + Revert, `policy.ts`, working-copy guard, leader-tab gating, `render_note` (G) before/after measurement. Use case 3. |
| **Files** | **PianoidTunner:** `server/assistant/policy.js` (+ tests), `tools/propose*.js`, `tools/renderNote.js`; `src/components/Assistant/ChangeSetCard.jsx`; `src/hooks/useAssistant.js` (`applyChangeSet` / `revert`); small hook-ups in `usePreset` (accept a `source` tag for `actionRecorder`) and `useMatrixHistory` (push external edits). **PianoidCore:** none. The existing endpoints are enough. |
| **Verify** | **Synthesis-output surface (`/test-ui`, audio_off):** an assistant-applied ChangeSet and the identical manual edit give **bit-identical `note_playback` buffers**, and Revert restores the pre-edit buffer bit-exactly. Policy unit tests cover every envelope rule. Node socket.io + backend GET read-back (memory `feedback_node_socketio_backend_get_verify`): edit → confirm → restore. Live: "reduce damping on mode 12 by 20%" gives a card with the correct key space, Apply, then a GET showing `decrement × 0.8`. A follower tab cannot apply. |

### P3: measurement and rig jobs (L, about 5+ days)
| | |
|---|---|
| **Scope** | Async job tools (`run_modal_stage`, `rig_session`, `recalibrate_output_level`) with progress through the existing WS `calibration` events and `:5001` status polling. Result interpretation opens the existing chart panes (`ui_open_pane`) rather than inventing charts. Use case 5. |
| **Files** | **PianoidTunner:** `server/assistant/tools/jobs/*.js`, job-progress UI in the pane. **PianoidCore:** possibly a compact `GET /modal/summary` if the existing status payloads are too large (decide after a P1 measurement). |
| **Verify** | **Mic / rig-engaging surface (`/diagnose`, audio_on)** for calibration and rig tools. Modal: run a stage on a known project and compare with the manual-run outputs. Fault injection: rig absent gives a clean "rig not present" diagnosis with no hang. |

### P4: backend `param_changed` broadcast + MCP server (M, about 2–3 days)
| | |
|---|---|
| **Scope** | (1) The backend emits `param_changed {kind, key, fields, source}` on **every** successful write (REST or WS, any client). `usePreset` merges it into state. This also fixes multi-tab and external-writer staleness for everyone. (2) A stdio **MCP server** exposing the *same* tool registry (shared module), so Claude Code, the orchestrator and `/pianoid-ui` / `/test-ui` drive Pianoid through typed tools instead of curl. MCP writes are safe once (1) exists. Tier G stays gated through MCP elicitation or confirm tools. |
| **Files** | **PianoidCore:** `pianoid_middleware/backendServer.py` (+ the parameter-write paths). **PianoidTunner:** `src/hooks/usePreset.js` (subscribe + merge; must not re-emit, Principle 3), and move the tool registry into a shared package. **PianoidInstall:** `tools/pianoid-mcp/` (Node), `.mcp.json` template, REST_API.md WS table. |
| **Verify** | Two-tab test: a write in tab A shows in tab B's editor. A curl write shows in the open editor. MCP: Claude Code `list_tools` and a read-tool round trip. LIGHT CUDA rebuild (middleware `.py`) + `/load_preset` 200 smoke test. |

### P5: preset generation and optimisation loops (L, open-ended)
| | |
|---|---|
| **Scope** | "Generate a preset like X", "match this target spectrum": a working copy plus an iterative propose → render → measure loop. Long-running work moves to the **driver seam**: an Agent SDK / supervisor driver (option b) for autonomous multi-step runs, with an "escalate to orchestrator" button that sends the conversation and a bug-report JSON to the Telegram orchestrator. |
| **Files** | `server/assistant/drivers/{api.js, supervisor.js}`; supervisor channel adapter `adapters/pianoid-ui.ts`. |
| **Verify** | Offline buffer metrics converge toward the target. Every intermediate state is revertible. Spend stays within the task budget. |

---

## 7. Costs and billing

**Per-turn estimate** (Opus 5.5: $4 in / $20 out per MTok, cache read $0.20; Sonnet 5.5: $2 / $10, cache read $0.20; Haiku 5.5: $0.10 / $0.50):

| Turn type | Cached prefix | Uncached in | Out (incl. thinking) | Opus 5.5 | Sonnet 5.5 |
|---|---|---|---|---|---|
| Explain (1–2 tool calls) | ~12k | ~4k | ~0.8k | ≈ $0.035 | ≈ $0.018 |
| Diagnose / compare (3–6 tool calls) | ~12k × 4 requests | ~15k | ~2k | ≈ $0.11 | ≈ $0.06 |
| Edit + render verify | ~12k × 5 requests | ~20k | ~3k | ≈ $0.15 | ≈ $0.08 |

At heavy use of about 100 turns a day this comes to roughly $5–10/day on Opus or $3–5/day on Sonnet. Typical use (20–40 turns) is about $1–4/day. These are **estimates**. P1 shows real `usage` per turn in the cost footer, and the estimate is replaced with measurements after one week. Controls: a per-session token budget (hard stop plus `task_budget` beta on agentic turns), a daily cap in the launcher, and the model picker.

**Billing gotcha (must be designed in).** `tools/supervisor/src/cost-safety.ts` treats `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` in the environment as "flip to paid API billing" and refuses to start. Any Claude Code session that inherits such a variable bills the API instead of the subscription. So the assistant key **must not** be exported globally. Use a launcher-only variable `PIANOID_ASSISTANT_API_KEY`, or a gitignored `PianoidTunner/server/.state/assistant-key` with 0600 permissions, reusing the `secret-store.ts` masking pattern. Pass it explicitly as `new Anthropic({ apiKey })`. It is never sent to the browser and never logged. The launcher binds to 127.0.0.1.

---

## 8. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | UI desync from writes outside `usePreset` | Critical | P1–P3 writes go only through the ChangeSet → `writeParam` path; P4 broadcast before any external writer (MCP) |
| R2 | Loud or clipping output, or runaway, from assistant edits | Critical | `policy.ts` envelope, level-class annotations, render-verify, tier X for gate and limit, leader-tab gating |
| R3 | Wrong key space, units or same-name confusion | Major | data-model facts in the system prompt, read-before-write enforced, launcher-side key-space validation that mirrors `parse_range` |
| R4 | Engine disturbance from tool calls | Major | LLM loop in the launcher, not `:5000`; renders and recalibration rate-limited and gated; only the documented stop/restart render routes are exposed |
| R5 | API spend creep | Major | budgets, cost footer, model picker, caching verified via `cache_read_input_tokens` |
| R6 | Key leakage, or accidentally flipping Claude Code to API billing | Major | launcher-only key name and file (§7) |
| R7 | Sending third-party rig data (Elyashev measurements) to the API | Major (policy) | open decision D4; per-project "do not send" flag that blocks the modal tools |
| R8 | Hallucinated explanations | Minor | `search_docs` citations required for "how does X work" answers; the glossary is the source of truth |
| R9 | Launcher only exists under `npm run dev` | Minor | the pane shows "assistant unavailable (launcher not running)"; production `npm start` is out of scope |

---

## 9. Open decisions for the user

| # | Decision | Options | Recommendation |
|---|---|---|---|
| **D1** | Billing / runtime | (i) Anthropic API key, pay-per-token, via the launcher; (ii) Claude subscription through an Agent SDK / supervisor driver (slower, coding harness, Phase 3 of the supervisor not done) | **(i)** for P1–P4. Keep (ii) behind the driver seam for P5. |
| **D2** | Default model | `claude-opus-5-5` (medium) / `claude-sonnet-5-5` / per-use-case routing | **Opus 5.5 medium** default, with Sonnet 5.5 selectable in the pane |
| **D3** | Write autonomy | always confirm / auto-apply inside a "safe envelope" on working copies | **Always confirm** in P2. Revisit after usage data. |
| **D4** | Data sharing | may preset and measurement data (incl. Elyashev rig captures) be sent to the API? | user / collaborator call; per-project opt-out flag either way |
| **D5** | Audience | the user only / also collaborators (Dima, testers) | affects how much weight goes on explain (use case 4) and how strict the gating is |
| **D6** | P4 priority | MCP + broadcast after P3 / **right after P1** (agents get typed Pianoid tools sooner) | Consider pulling P4 forward. It also fixes multi-tab staleness for normal UI use. |
| D7 | Spend caps | daily $ cap value | start at $5/day, then tune |

---

## 10. /analyse bookkeeping

- **Documentation gaps found (no edits made; proposal-only brief):** (1) REST_API's WS table and the middleware OVERVIEW emit list are accurate, but no doc states the consequence that **external writers leave the frontend stale**. Fold that into SYSTEM_OVERVIEW "State Discipline" when P4 lands. (2) There is no parameter glossary. Each param's meaning and units are spread across REST_API, the module docs and PianoidBasic OVERVIEW (P0 deliverable).
- **Tests to add (by phase):** P1: tool-schema / summariser / key-store node tests, pane Jest. P2: `policy.ts` envelope tests, apply/revert bit-identity on the audio_off surface, follower-tab gating. P4: `param_changed` integration test (REST write → WS event) under `PianoidCore/tests/integration/`, two-tab FE test.
