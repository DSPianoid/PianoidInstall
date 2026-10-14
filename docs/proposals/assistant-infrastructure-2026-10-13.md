# Assistant Infrastructure Prerequisites — Backend-Authoritative Sync, Command Layer, Layout Control

**Date:** 2026-10-13 · **Author:** `/analyse` (orchestrator-dispatched, research + docs only, no source edits)
**Status:** PROPOSAL — dispatchable as `/dev` tasks once the user approves the sequencing (§8)
**Progress (2026-10-14):** I0 + I1 IMPLEMENTED (dev-960f, merged Core dev 7ba5afc). **I2 IMPLEMENTED** (dev-fbcb, merged Core dev 5fb3dd6, Tunner dev b39e523, docs master 6fb91da; live UI regression of every editor in two tabs passed). Latency: p95 96.5 ms met, p50 86.6 ms vs the 50 ms target not met (re-render cost, WIP follow-up). I3–I5 open.
**Parent:** [AI Assistant in the Pianoid UI](ai-assistant-in-ui-2026-10-13.md). That doc covers the assistant itself. This doc covers everything that must exist **before** it.
**Driver (user, Telegram 2026-10-13 18:37 UTC):** *"The assistant should be able to modify parameters, change windows layouts, and initiate any actions like playback, measurement etc. Plan necessary infrastructure update before the assistant implementation. The editors should be synchronized with the backend on any change."*

**Docs read:** `PROJECT_CONFIG.md` (`#data-model-facts`, `#ports`, `#verification-surfaces`), `architecture/SYSTEM_OVERVIEW.md` (FE↔BE State Discipline, Principles 1–4), `modules/pianoid-middleware/OVERVIEW.md` (Pianoid / ParameterManager / Layer B / runtime params), `modules/pianoid-middleware/REST_API.md` (WS channel, parameter endpoints, `parse_range` key space, `/graph_names` registry), `modules/pianoid-tunner/OVERVIEW.md` (`usePreset` F1/F4/F11, `useSocketIO`, tab leadership, `useLayout`, history hooks, bug-report action recorder). The docs do not enumerate the mutation paths, so the inventory in §1 was taken from source (`PianoidCore@dev`: `backendServer.py`, `pianoid.py`, `parameter_manager.py`, `calibration_controller.py`, `hammer_mass_gain.py`, `output_level.py`, `auto_tuner.py`, `pianoidMidiListener.py`, `modal_adapter/preset_injector.py`, `modal_adapter/sound_channel_calibrator.py`, `chartFunctions.py`; `PianoidTunner@dev`: `usePreset.js`, `useSocketIO.js`, `useLayout.js`, `useWindowManager.js`).

---

## 0. Target state in one picture

```
            any client: Tab A (leader) · Tab B (follower) · curl · MCP · assistant service · MIDI CC · calibration thread
                 │ command / param write (+ clientId, opId)
                 ▼
  ┌──────────────────────────── Flask :5000 ────────────────────────────┐
  │ Command registry (I4) ──► Pianoid.apply_parameter_request (I1 CHOKE) │
  │                              │ before/after, keys, source, opId      │
  │                              ▼                                       │
  │                     StateJournal (I1): seq++, ring buffer,           │
  │                     undo groups (I3), coalescing                     │
  │                              │                                       │
  │  safety net: ParameterManager._gpu_upload / output_level writes ─────┤ coarse "domain_invalidated" (I1b)
  └──────────────────────────────┼───────────────────────────────────────┘
                                 ▼ WS broadcast to ALL clients
            state_changed {seq, presetEntry, version, source, opId, domain, keys, fields, after}
                 │
     ┌───────────┴─────────────┐
     ▼                         ▼
  Tab A: own opId → confirm   Tab B: reconcile into usePreset + editor histories (I2)
  optimistic value (echo      gap in seq / reconnect → hello{lastSeq} → replay or full resync (I2)
  suppression)
```

---

## 1. Finding: there is no single write choke point today

`Pianoid.apply_parameter_request(request)` (pianoid.py ~3833) and its legacy twin `Pianoid.update_parameter` (~3818) both call `_assert_active_editable()` and `_note_param_edit()` (Layer B) and then delegate to `ParameterManager`. **They are the natural choke point.** The REST and WS `set_parameter`, `set_string_excitation` and `set_hammer_shape` handlers reach it through `backendServer._apply_parameter_request` / `_apply_string_excitation`. Everything below **bypasses** it. Each bypass mutates engine or model state without a hookable event today.

| # | Path | Entry (file:~line) | What it mutates | Goes through choke? |
|---|---|---|---|---|
| B1 | `POST /set_mode_parameters` (legacy) | backendServer.py ~2022 | `mode.update_params()` + `send_mode_params_to_CUDA()` directly | **No** (has its own read-only guard) |
| B2 | `POST /excitation_energy` | backendServer.py ~2242 | `sm.pitches[p].physics.hammer_mass`, `mp.hammer_speeds`, `mp.excitation_impulse_calibration` assigned directly + direct upload | **No** |
| B3 | `POST /rescale_hammer_mass` + end of every calibration pass | CalibrationController → `hammer_mass_gain.py` ~187 `param_manager._recompose_excitation_coefficients` + `compensate_output_scale` | per-pitch `hammer_mass`, `output_scale` | **No** |
| B4 | Calibration family: `/calibrate_volume`, `/equalize_keyboard`, `/tune_note`, `/apply_perception`, `/normalize_volume`, `/calibration_curve/{apply,revert,load}`, `/calibrate_synthesis`, `/calibrate_acoustic` | calibration_controller.py (`_set_amplitude_scale`, `apply_level_multipliers`, `_upload_excitations`) | `hammer_mass` per pitch (background thread) | **No** |
| B5 | Auto-tuner (chart action) | auto_tuner.py ~390/662 `update_pitch_physical_params_GRANULAR(tension=…)` | string tension | **No** (calls the `Pianoid` facade below the choke) |
| B6 | `POST /modal/apply_to_preset` (served by :5000) | modal_adapter/preset_injector.py ~643–744: `pm.update_parameter(...)`, `pm.send_mode_params_to_CUDA()`, `pm.send_deck_params_to_CUDA()` | modes, feedin/feedback (whole preset sections) | **No.** It calls `ParameterManager` directly, so it also skips `_assert_active_editable` and the Layer B policy. |
| B7 | Sound-channel calibrator | sound_channel_calibrator.py ~315 `pianoid.apply_parameter_request(req)` | sound_channel rows | **Yes.** Needs only a `source` tag. |
| B8 | Runtime params: REST + WS `set_runtime_parameters` | backendServer.py `_apply_runtime_parameters` ~248 → `setRuntimeParameters`, `set_deck_feedback_coefficient`, `mp.deck_feedback_coefficient` (`store_feedback_coeff`) | volume / feedback / centre / range / gate | **No.** It is a separate path by design (OVERVIEW: "do NOT go through ParameterManager"). |
| B9 | MIDI CC handlers | pianoidMidiListener.py ~403 `set_volume_level`; ~472–487 `update_pitch_physical_params` (deprecated bulk: tension / jung / gamma / offset); ~493/503 `send_deck_params_to_CUDA(coeffs)` | volume, string physics, deck scaling | **No** |
| B10 | Fix-velocity: REST + WS `set_fix_velocity`; `/set_excitation_mode` | backendServer.py ~2074/2127/2092 → `pianoid.set_pitch_excitation_mode` | session state, per-pitch excitation type | **No** |
| B11 | Layer B output level | output_level.py ~349/372 (`mp.output_scale = …`), `/recalibrate_output_level`, `ensure_calibrated` on load / structural re-init | `output_scale`, engine `volume_center` | **No** |
| B12 | Preset lifecycle: `/load_preset` (full / hot / structural-inplace), `/preset/{load,switch,unload,spawn_working_copy,promote}`, `/save_preset` | backendServer.py ~1234–1800 | the whole model, the active entry, on-disk JSON | n/a: these are *preset-level* events, not param edits |
| B13 | Transient engine overrides inside chart / test actions | chartFunctions.py ~1242/1271 `setNewDeckParameters`, ~1778–1859 `setInitialization/RuntimeParameters`, ~2726/2755 `setCycleIterations`; backendServer.py ~1081 `update_physical_parameters` → `setUpdatedParameters` | engine GPU state, **restored afterwards** | **No.** Classify as *transient* (no event, but a `engine_busy` lifecycle event around them). |
| B14 | `/set_mic_device`, `/midi/*`, `/calibration_params`, `/clear_limiting` | backendServer.py | device / session / config state, not preset data | n/a: session events |

**Consequences.** (1) The FE editors go stale after B1–B6, B8 (another tab or curl), B9 and B11. Today only `/load_preset` / `/preset/switch` resync, through the `presetVersion` bump. (2) B6 can **edit a read-only original**, because it skips `_assert_active_editable`. That is a latent bug, fixed as part of I1. (3) B2 and B9 bypass the Layer B edit policy.

---

## 2. Data-model doc support required (high-stakes gate)

These items depend on [`#data-model-facts`](../PROJECT_CONFIG.md#data-model-facts) categories. Each needs an explicit **Data Model Card** (measured against the live engine and written to the module docs) **before** implementation. Source inference alone is not enough.

| Fact | Why it matters here | Current doc state |
|---|---|---|
| **Deck (feedin / feedback) key space** | Event `keys` and undo inverses must address the right axis | ⚠ **Docs contradict code.** REST_API.md "`key_no` formats" says *"For `mode`, `feedin`, `feedback`, `output`: key_no is treated as a mode number range"*. `parse_range` (backendServer.py ~1144) treats `feedin`/`feedback` (+ masks) as **pitch** keys with modes = all. The FE sends `/set_parameter/feedin/{pitch}` (Tunner OVERVIEW `usePreset` table), and `feedback_mask` is keyed by output pitch 128+ch. **Measure and fix the doc in I0.** (The parent proposal's v1 also carried this error and has been corrected.) |
| Output pitches 128+ vs piano pitches 0–127 | Key paths in events must preserve the disjoint key spaces (`OUTPUT_PITCH_RAW_PARAMS`) | documented (REST_API pitch key space) |
| **Stored vs effective**: masks (`*_mask` × raw at pack time), `hammer_width` stored vs `hammer_width_effective`, `string_sound_channel` effective only at 128+, `output_scale` bare vs engine `volume_center` | Events and undo must carry **stored** values. Undoing an effective value would corrupt raw data (a mute would become a permanent zero). | documented per field; needs one consolidated card for the journal |
| **Derived fields** (e.g. string `tail` = length/10, `hammer_radius`, `length` in metres vs `p_main` blocks) | Journal "before" snapshots must exclude derived fields, or re-derive them on undo | partly documented (REST_API `length` unit note; memory: `tail` derived) |
| **Unit ranges**: runtime `volume` 0–127 MIDI, `feedback` 1–127 mapped vs direct coefficient auto-detect, `volume_center` bare | Runtime events must state which representation they carry | documented (REST_API runtime params) |
| **Same-name pairs**: `deck` (Python per-pitch) vs `deck` (CUDA matrix); `sound_channel` vs `string_sound_channel`; feedin / feedback modes path vs strings path | Event `domain` names must be unambiguous | documented in `#data-model-facts`; the event schema must adopt the REST parameter names verbatim |

---

## 3. I1: Backend-authoritative change broadcast

**Goal.** Every mutation of preset or engine-visible state, from any source, produces exactly one `state_changed` event (or a preset-level / session-level event) on the WS, carrying `source`, a monotonic `seq`, and key paths.

### 3.1 Design

| Piece | Spec |
|---|---|
| **`state_journal.py`** (new, PianoidCore/pianoid_middleware) | Owns `seq` (process-monotonic int) and a per-entry `version` (per library entry, survives switch). Bounded ring buffer of the last N=2000 events for replay. **Coalescing:** events for the same `(domain, key)` from the same `source` within 30 ms are merged (drag-paint and calibration loops). Thread-safe (calibration and MIDI threads emit). Emits through the existing thread-safe socketio pattern (`emit_lifecycle_event` precedent). It does no GPU work. |
| **Event schema** | `state_changed {seq, entry, version, source:{kind:'fe'\|'rest'\|'ws'\|'mcp'\|'assistant'\|'calibration'\|'midi_cc'\|'modal'\|'autotune'\|'system', clientId?, opId?, groupId?}, domain:'string'\|'mode'\|'excitation'\|'hammer'\|'feedin'\|'feedback'\|'feedin_mask'\|'feedback_mask'\|'sound_channel'\|'sound_channel_mask'\|'string_sound_channel'\|'runtime'\|'output_level'\|'excitation_energy'\|'excitation_mode', keys:[...], fields:[...], after:{key:{field:value}}, before?:… (server-side only, for I3)}`. Plus `preset_changed {seq, kind:'load_full'\|'load_hot'\|'load_structural'\|'switch'\|'spawn'\|'promote'\|'unload'\|'save', entry, version}` and `session_changed {seq, domain:'fix_velocity'\|'mic'\|'midi'\|'limiter'…}`. The domain names are **the REST `parameter` names verbatim** (§2 same-name rule). |
| **Choke point** | `Pianoid.apply_parameter_request` becomes the single param-write entry and emits after a successful apply. `update_parameter` is reduced to a shim over it. A `RequestContext` (`source`, `clientId`, `opId`, `groupId`) flows in from the REST and WS handlers through new optional request fields / headers (`X-Pianoid-Client`, `X-Pianoid-Op`). |
| **Bypass migration** | B1 → route through `apply_parameter_request(kind='mode')`, or **retire** the legacy route (the FE uses `/set_parameter/mode`). B2 / B3 / B4 → add `kind='excitation_energy'` and `kind='hammer_mass'` requests (`hammer_mass_gain.commit()` emits one grouped event per pass). B5 → `apply_parameter_request(kind='string')`. B6 → `preset_injector` calls `Pianoid.apply_parameter_request` (gaining the read-only guard and Layer B policy), with one `groupId` per apply. B8 / B10 → emit `runtime` / `session_changed` from `_apply_runtime_parameters` and the fix-velocity / excitation-mode helpers. B9 → MIDI CC handlers call the same helpers, and the deprecated bulk `update_pitch_physical_params` is replaced by granular requests. B11 → `output_level` emits `output_level` on every commit. B12 → each lifecycle route emits `preset_changed` after success. B13 → wrapped in `engine_busy` start/end lifecycle events, no state events. |
| **I1b safety net** | `ParameterManager._gpu_upload` (14 call sites) and the `output_level` writers record "domain touched in this request". At the end of a request or thread op, any touched domain **not** covered by a precise event emits `domain_invalidated {seq, domain, source}`, and the FE refetches that domain. Future bypasses then degrade to a coarse refetch, never to silent staleness. A dev-mode `logging.warning` names the uncovered call site. |
| **Structural guard (test)** | A pytest that walks `app.url_map` + the `@socketio.on` handlers and asserts each mutating route is **classified** (`param` / `preset` / `session` / `transient` / `read_only`) in a registry table. An unclassified new POST route fails CI. This is the anti-regression for §1. |

### 3.2 `/dev` tasks
| Task | Scope | Effort |
|---|---|---|
| I1.1 | `state_journal.py` + event schema + unit tests (seq, coalescing, ring buffer, thread safety) | M |
| I1.2 | Choke-point emit + `RequestContext` plumbing (REST headers, WS payload fields) + B7 source tag | S |
| I1.3 | Bypass migration B1, B2, B5, B6, B9 (each one commit). B6 includes the read-only-guard bug fix. | M |
| I1.4 | Calibration / Layer B emits B3, B4, B11 (grouped per pass) | S–M |
| I1.5 | Runtime / session / preset events B8, B10, B12, B14 + `engine_busy` around B13 | S |
| I1.6 | I1b sink-level `domain_invalidated` + route-classification pytest | S–M |

**Repos / modules:** PianoidCore `pianoid_middleware/{backendServer.py, pianoid.py, parameter_manager.py, state_journal.py (new), calibration_controller.py, hammer_mass_gain.py, output_level.py, auto_tuner.py, pianoidMidiListener.py, modal_adapter/preset_injector.py}`; PianoidInstall docs (REST_API WS table + new "State events" section, middleware OVERVIEW, DATA_FLOWS). **Build:** LIGHT CUDA `--both` (middleware `.py` only) + `/load_preset` 200 smoke test.
**Risks:** (1) emit cost on the WS during drag-paint (mitigated by coalescing and `after` limited to edited keys); (2) the emit must happen **outside** `cuda_lock` (no socket I/O under the lock, so the synth thread cannot stall); (3) `backendServer.py` (4.8k LOC) and `pianoid.py` (4k LOC) are C4-RED god objects with conflicting concurrent edits, so take MODULE_LOCKS; (4) the calibration threads' emit rate (group per pass).
**Effort:** L total (≈ 4–5 agent-days). **Data-model card:** deck key space, stored-vs-effective, derived fields (§2). **Depends on:** I0.

---

## 4. I2: Frontend editor sync (single source of truth, version reconciliation)

**Status: DONE (dev-fbcb, 2026-10-14)** — I2.1–I2.5 implemented as designed; see Tunner OVERVIEW "useBackendSync + useStateReconcilers" and REST_API "Reconnect protocol (I2)".

### 4.1 Design

| Piece | Spec |
|---|---|
| **`useBackendSync`** (new hook, PianoidTunner) | Subscribes to `state_changed` / `preset_changed` / `session_changed` / `domain_invalidated`. Tracks `lastSeq`. Dispatches each event to a **reconciler per domain** owned by `usePreset` (the sole state owner, P1). Lives in every tab, so followers stay live as well. |
| **Optimistic reconciliation** | Every FE write carries `clientId` (per tab, from `tabLeadership` id) + `opId`. `writeParam` keeps `pending[opId] = {domain, keys, value}`. On an **own echo** (matching `clientId`), drop the pending entry: the value is already shown (echo suppression, no re-render storm). On a **foreign event** for a key with a pending own op, the later `seq` wins: if the foreign `seq` is after our write's ack, apply it; otherwise keep ours and let our echo settle it. Foreign event, no pending op: apply `after` into state. **Reconcilers never emit** (Principle 3: no speculative or state-watching emits). |
| **Editor histories** | The string / mode / excitation / feedin / feedback histories in `PianoidTuner.js` and `useMatrixHistory` / `useValuesHistory` receive foreign events as **external steps**, so the displayed matrix reflects them without discarding local history. Once I3 lands, undo moves to the backend (§6) and these become views. |
| **Gap / reconnect resync** | On `connect` (first or re-), emit `hello {clientId, lastSeq, entry, version}`. The backend replies with `replay [events]` if `lastSeq` is within the ring buffer, otherwise `resync_required`. In that case the FE re-fetches every domain for the active entry **without** bumping `presetVersion` (no history wipe), via the existing `getFeedInMatrix` / … fetchers. A `seq` gap seen in the live stream triggers the same path. |
| **Half-open socket** (memory `project_ws_buffering_masks_emit`; F1 `emitWithAck` already falls back to REST on ack timeout) | Add (1) a **liveness probe**: `ping_ws` every 5 s, and 2 missed pongs or any ack timeout force `socket.disconnect().connect()` (a real reconnect, not just a REST fallback); (2) after a forced reconnect, run the `hello` resync above, so edits that went over REST during the dead window are confirmed by their events; (3) a status chip state "resyncing" (reuses the existing WS indicator). |
| **Multi-tab** | All tabs apply foreign events (another tab is a foreign source). Tab leadership is unchanged for **automatic** writes. The assistant's UI-command channel (I5) targets the **leader** only. A follower's own edits are allowed (explicit user actions are never gated) and echo to the leader like any other source. |
| **Preset events** | `preset_changed{load_full\|switch\|spawn\|unload}` → today's `presetVersion` bump path (Principle 1) driven by the event instead of the local call, so a switch made by another client or the assistant resyncs this tab. `load_hot` → no bump (Cluster C semantics preserved). `save` / `promote` → only refresh the library list. |

### 4.2 `/dev` tasks
| Task | Scope | Effort |
|---|---|---|
| I2.1 | `useBackendSync` + `clientId` / `opId` in `writeParam` (WS payload + REST headers) + per-domain reconcilers in `usePreset` | M–L |
| I2.2 | History integration (external steps) for the 5 editor histories + Sound Channels | M |
| I2.3 | `hello` / replay / resync protocol (FE + backend handler) + gap detection | M |
| I2.4 | Liveness probe + forced reconnect + status chip | S |
| I2.5 | Preset-event-driven `presetVersion` + library refresh | S |

**Repos / modules:** PianoidTunner `src/hooks/{usePreset.js, useSocketIO.js, useBackendSync.js (new), useMatrixHistory.js, useValuesHistory.js, useSoundChannels.js}`, `src/PianoidTuner.js` (history wiring); PianoidCore `backendServer.py` (`hello` handler). Docs: Tunner OVERVIEW, SYSTEM_OVERVIEW State Discipline (new Principle 5: "the backend event is the only remote-state input").
**Risks:** (1) `usePreset.js` (2.2k LOC) / `PianoidTuner.js` (4.5k LOC) are hot files, so take MODULE_LOCKS; (2) reconcile loops (a reconciler that triggers a debounced write) are prevented by construction (reconcilers write state only) and covered by a Jest "no emit on foreign event" test; (3) bulk events (whole-matrix) are handled as one state update.
**Effort:** L (≈ 4–5 agent-days). **Depends on:** I1.1–I1.2 (schema + choke emit). The reconnect probe I2.4 can start in parallel.

---

## 5. I5: Layout control API (FE command bus)

| Piece | Spec |
|---|---|
| **Serializable UI state** | `UiState = {mosaic: MosaicNode (useLayout, already serialised to localStorage "mosaicLayout"), visibleWindows (useWindowManager), workbenches (useCurrentValues.updateWorkbench), selection {pitch, selectedPitches, selectedModes, param, level}, chartTies (useCurrentValues tie/untie), paneSettings}`. `GET` = `buildUiSnapshot()` (the bug-report `buildBugSnapshot` already gathers most of this). |
| **FE command bus** (`utils/commandBus.js` + `useCommandBus`) | `register(name, schema, handler)` / `dispatch(name, args) → result`. Handlers are registered by the owning hooks, so ownership stays with the owner: `ui.pane.open/close/maximize/restore`, `ui.layout.set/apply_named`, `ui.workbench.select/spawn`, `ui.select.pitch/range/modes/param/level`, `ui.chart.tie/untie/zoom`, `ui.snapshot`. Every dispatch is recorded in the `actionRecorder` with its `source`. |
| **Remote reach** | The launcher (`:3001`) exposes WS namespace `/ui-control`. The **leader** tab connects and registers. The launcher forwards `{name, args, requestId}` and returns the result. A follower or no tab gives `503 no_leader_tab`. The assistant service lives in the launcher (parent proposal), so it calls this in-process. |
| **Safety** | UI commands are view-only (no backend writes). They are rate-limited, and the leader tab shows a transient "assistant is driving the layout" chip with **Stop**. |

`/dev` tasks: I5.1 command bus + UI-state snapshot + handlers for layout / panes / workbench / selection (M); I5.2 launcher `/ui-control` relay + leader registration (S–M). **Repos:** PianoidTunner `src/utils/commandBus.js`, `src/hooks/{useLayout.js, useWindowManager.js, useCurrentValues.js, useCommandBus.js}`, `server/launcher.js`. **Risks:** the mosaic tree must stay valid (`ensureGlobalWorkbench`); reuse the existing helpers, never build trees ad hoc. **Effort:** M (≈ 2–3 days). **Depends on:** the command-schema format from I4.0 only. It is otherwise independent of I1 / I2 and can run in parallel. **Data-model card:** not needed (view state), except the strings-axis 128 offset in selections (documented).

---

## 6. I3: Backend-aware undo / history

| Piece | Spec |
|---|---|
| **Journal undo records** | At the choke point, `StateJournal` stores `before` (stored values of exactly the edited keys and fields, never derived or effective, §2) beside `after`, grouped by `groupId` (one UI gesture, one assistant command, one calibration pass, one `apply_to_preset`). It is per library entry and bounded (last 200 groups per entry). Cleared on `preset_changed{load_full\|unload}`. Kept across `switch` (per entry). |
| **API** | `POST /history/undo {entry?, groupId?}` / `POST /history/redo` / `GET /history?entry=&limit=`. Undo applies the inverse **through `apply_parameter_request`** with `source.kind='undo'`, so it is itself broadcast and every editor follows. Refuses (409) if a key was modified by a later group that is not being undone (a linear-history check). |
| **Scope rules** | Undoable: param domains, `excitation_energy`, `hammer_mass` groups, `runtime` **stored** baseline (`store_feedback_coeff`) but not the live slider. Not undoable (reported as such): `output_scale` recalibration (re-run instead), preset lifecycle (use working-copy discard), session state. |
| **FE** | Global Undo / Redo (ToolBar + `Ctrl+Z` / `Ctrl+Shift+Z`, added to `useHotkeys`) call the API. The per-editor local undo buttons are re-pointed to "undo last group touching this domain". Over time `useMatrixHistory` / `useValuesHistory` shrink to transient in-gesture buffers. |

`/dev` tasks: I3.1 journal before/after + groups + undo / redo / history API + pytest (M); I3.2 FE global undo / redo + per-editor re-pointing (M). **Repos:** PianoidCore `state_journal.py`, `backendServer.py`; PianoidTunner `useHotkeys.js`, ToolBar, editor panes. **Risks:** capturing `before` for whole-matrix writes is memory-heavy (bounded per entry; store row diffs); a mask undo must restore the mask, never the raw row. **Effort:** M–L (≈ 3–4 days). **Depends on:** I1 (journal), I2 (FE follows undo through events). **Data-model card:** stored vs effective, derived fields (§2). **Mandatory.**

---

## 7. I4: Unified command / action layer (= the future tool registry)

| Piece | Spec |
|---|---|
| **Registry format (I4.0)** | One declarative registry: `commands/*.json` (JSON Schema per command) in a shared location (PianoidInstall `schemas/commands/`, consumed by PianoidCore, PianoidTunner and the launcher). Fields: `name` (`preset.save`, `play.note`, `param.set`, `render.note_playback`, `modal.run_stage`, `rig.session`, `calibration.equalize`, `history.undo`, `ui.pane.open`, …), `target` (`backend` \| `modal` \| `launcher` \| `ui`), `args` schema, `result` schema, `tier` (`read` \| `write` \| `destructive` \| `excluded`, which feeds the assistant envelope), `long_running` (bool), `doc` (MkDocs anchor). **Precedent:** `ChartTypeRegistry` (`chart_config.json`, served by `GET /graph_names` with per-parameter schemas) shows a schema'd registry already works here. |
| **Backend executor** | `command_registry.py`: `POST /command/<name>` + WS `command` event → validate the schema → call the **existing** route helper (thin wrappers; no logic moves). The source context goes to I1. `GET /commands` lists the registry, superseding `/command_names` (`{"commands":["volume"]}`). |
| **Jobs** | `long_running` commands return `{jobId}` immediately and emit `job_started` / `job_progress {pct, stage, msg}` / `job_finished {result}` / `job_failed`. Adapters fold the existing ad-hoc channels (`calibration` progress, `midi_progress`, `:5001 /modal/status` polling, `/calibration_status`) into the job model. `POST /command/job.cancel {jobId}` maps to `/calibration_cancel`, `/modal/cancel`, … |
| **UI uses it** | Toolbar and pane buttons call `commandBus.dispatch(name, args)`. For `target≠ui` the bus forwards to the backend / launcher. So UI, REST, curl, MCP and the assistant are **literally the same call** with a different `source`. Migrate per family (playback, preset, render, calibration, modal, rig). |
| **MCP / assistant** | The tool list is generated from the registry (name, description, schema, tier). The MCP server and assistant become thin adapters (parent proposal §6). |

`/dev` tasks: I4.0 registry format + JSON Schemas for the first 3 families + validator shared FE/BE (S–M); I4.1 backend executor + `/commands` + jobs model + adapters for calibration / modal / MIDI progress (L); I4.2 FE command bus forwarding + migrate the playback / preset / render buttons (M); I4.3 migrate the calibration / modal / rig families (M). **Repos:** PianoidInstall `schemas/commands/`; PianoidCore `command_registry.py`, `job_manager.py`, `backendServer.py`, `modal_adapter_server.py`; PianoidTunner `utils/commandBus.js`, ToolBar, panes, `server/launcher.js` (launcher-target commands: backend start/stop). **Risks:** scope creep (wrap, don't rewrite); dual paths during migration (old routes stay; the route-classification test from I1.6 tracks coverage); modal :5001 is a separate process, so job events cross processes (the launcher or :5000 relays). **Effort:** L (≈ 6–8 days across the families). **Depends on:** I1 (source context + events). I4.0 should come first because I5 uses its format. **Data-model card:** per-command arg units and key spaces (reuse §2).

---

## 8. Sequencing, dependencies and effort

```
I0 Data Model Card + doc fixes (S) ──┬──► I1 broadcast (L) ──► I2 FE sync (L) ──► I3 undo (M-L) ──┐
                                     ├──► I4.0 registry format (S-M) ──► I5 layout API (M) ───────┤
                                     │                       └──► I4.1-4.3 commands + jobs (L) ◄─ I1
                                     └──► I2.4 liveness/reconnect probe (S, independent)            ▼
                                                                                   Assistant A1… (parent doc)
```

| Item | Effort | Depends on | Parallel with | Data-model card? |
|---|---|---|---|---|
| **I0** Data Model Card (deck key space measured on the live engine; stored-vs-effective + derived-field table); fix REST_API.md `key_no` statement | S | — | — | **is** the card |
| **I1** backend broadcast + bypass migration + safety net + route classification | L (4–5 d) | I0 | I4.0, I5, I2.4 | **yes** |
| **I2** FE sync, reconciliation, resync, half-open fix | L (4–5 d) | I1.1–I1.2 | I3.1 backend half | **yes** (key spaces in reconcilers) |
| **I3** backend undo / redo | M–L (3–4 d) | I1, I2 | I4.1 | **yes** (stored vs effective) |
| **I4** command registry + jobs + UI migration | L (6–8 d) | I1 (4.0 needs nothing) | I2, I3 | per command |
| **I5** layout control API | M (2–3 d) | I4.0 | I1, I2 | no |
| **Total** | ≈ 20–27 agent-days, critical path ≈ 12–15 d with I4 / I5 in parallel | | | |

---

## 9. Verification surfaces (per item, measured)

| Item | Surface | Pass criterion |
|---|---|---|
| I0 | live engine GET before/after a single-pitch `feedin/57` POST | the measured key axis matches the corrected doc |
| I1 | pytest integration (`PianoidCore/tests/integration/test_state_events.py`): parametrised over B1–B14, each mutation → exactly one correctly-keyed event (or the classified exemption); route-classification test; `cuda_lock` not held during emit (instrumented) | 100% of classified mutating routes emit; zero unclassified POST routes |
| I1 perf | `test_performance_audio_off.py` + drag-paint load (200 writes/s) | no cycle-time regression at N≥3 runs (memory: multi-run rule) |
| **I2 latency** | **curl `POST /set_parameter/string/60` → the open editor shows the new value.** Measured with a node socket.io client (event arrival) + chrome-devtools `performance.now()` at React commit; 50 runs | **p95 ≤ 150 ms** local, p50 ≤ 50 ms |
| I2 multi-tab | two tabs; an edit in A shows in B; a follower edit shows in the leader | 50/50 |
| I2 half-open | kill the transport (devtools offline 10 s / restart the backend socket) while editing; reconnect | after reconnect, backend GET = FE state for all domains; `resync` logged; zero lost edits |
| I2 echo | Jest: own echo → no extra state update and no emit; foreign event → state update and no emit | green |
| I3 | curl edit → FE Ctrl+Z → backend GET restores the exact stored values; **`note_playback` buffer bit-identical to pre-edit** (audio_off surface); a mask undo restores the mask, not the raw row | bit-exact |
| I4 | contract test: the same command via UI button, REST and WS produces identical journal entries (except `source`); job lifecycle events for a modal stage and a calibration | identical |
| I5 | Jest command bus; live: launcher `/ui-control` → `ui.pane.open("Modes")` → screenshot shows the pane; the follower tab is rejected | pass |

---

## 10. Risks (infrastructure-wide)

| Risk | Mitigation |
|---|---|
| Concurrent `/dev` agents on the same god-object files (`backendServer.py`, `pianoid.py`, `usePreset.js`, `PianoidTuner.js`) | MODULE_LOCKS per task; isolated worktrees (memory: isolated worktree for build agents); I1.3 split one bypass per commit |
| Realtime engine disturbance | emits outside `cuda_lock`, coalesced; perf gate at N≥3 |
| Event storms during calibration / drag | 30 ms coalescing + grouped calibration events + FE batches state updates per animation frame |
| Two write paths during the migration window | the I1b safety net turns any missed path into a coarse refetch, never silent staleness; the route-classification test |
| Undo of derived / effective values corrupting raw data | I0 card + stored-only `before` + bit-exact verification |
