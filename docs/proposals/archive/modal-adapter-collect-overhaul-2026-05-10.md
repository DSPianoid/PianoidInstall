# Modal Adapter Collect Subpanel Overhaul — Proposal (SUPERSEDED)

> **STATUS — SUPERSEDED (2026-05-06).**
> The 8 open questions in §7 of this document were answered by the user on
> 2026-05-06. The answers fundamentally changed the architecture: instead of
> per-project per-scenario configuration with project-level persistence,
> **Measurement** becomes a first-class entity that owns the collection-time
> setup (channel mapping, layout, audio devices, impulse, series settings,
> raw recordings) and is referenced by one-or-more thinner Project entities
> that own their own ESPRIT / averaging / tracking config.
>
> This document is preserved for historical reference (Stream-2/3 inventory,
> migration-table cross-walk, side-by-side driver audit). **Do not use as a
> design source.** The current canonical proposal is:
>
> **→ [`../modal-adapter-measurement-entity-2026-05-10.md`](../modal-adapter-measurement-entity-2026-05-10.md)**
>
> The new proposal is self-contained and does NOT back-reference this one
> (per the single-source-of-truth rule); any still-relevant context has been
> forward-copied.

**Date:** 2026-05-10
**Status:** Proposal — analysis + phased plan, NOT IMPLEMENTED (SUPERSEDED)
**Author:** /analyse pass (orchestrator-spawned read-only investigation)
**Replaces / supersedes:** none (first canonical proposal for the post-B-3 overhaul)
**Builds on:** [`docs/development/proposals/COLLECT_MIGRATION_FROM_ROOMRESPONSE.md`](../../development/proposals/COLLECT_MIGRATION_FROM_ROOMRESPONSE.md) — that doc captured the parameter-by-parameter migration table; this proposal expanded it into a 4-section UX redesign + a porting / driver-merge plan.

---

## 1. Executive Summary

The user has asked for three interrelated changes to the Modal Adapter Collect subpanel:

1. **(UX overhaul)** Rebuild the Collect subpanel to follow the canonical "Settings sections" pattern used by the Setup subpanel (collapsible Accordion blocks + per-section "Save Settings" button + `settingsFrozen` lock semantics), grouping fields into four conceptual buckets: **General · Audio Devices · Impulse Configuration · Series Configuration**.
2. **(Port from RoomResponse)** Eliminate the runtime dependency on the sibling `D:\repos\RoomResponse\` repo. Today, `MeasurementSession._invoke_collection` lazy-imports `RoomResponseRecorder`, `SingleScenarioCollector`, and `generate_averaged_responses_for_scenario` after the `_room_response_bootstrap.py` shim adds `RoomResponse/` to `sys.path`. Port these three modules (plus their two transitive deps `MicTesting` and `signal_processor`) into PianoidCore so the modal-adapter-server is self-contained.
3. **(Driver merge feasibility)** Investigate merging RoomResponse's `sdl_audio_core` C++/pybind11 module into Pianoid's `pianoid_cuda` SDL3 driver. Today they share the host SDL3 device and contend for it (the `pause_synthesis`/`resume_synthesis` dance lives precisely to mediate that). A merged driver would eliminate the dance.

**Recommended phasing (see § 6 below):**

| Phase | Stream | Scope | Effort | Risk |
|---|---|---|---|---|
| **Phase 1** | Stream 1 (UX) | Reorganise Collect into 4 sections + Settings/Save semantics — backend stays as-is, every new field round-trips through the existing `recorder_config_overrides` envelope | **M** (~250-350 frontend LOC, 0 backend) | Low |
| **Phase 2a** | Stream 1 (UX) + Stream 2 prep | Expand `_build_recorder_config` allow-list (add `pulse_*`, `cycle_duration`, `impulse_form`, `voice_coil_config`, `recording_mode`, `truncate_config`) so the Phase 1 UI fields actually flow to the recorder. Plumb `recording_mode` into `_invoke_collection` | **S** (~25 backend LOC, ~150 frontend additions) | Low |
| **Phase 2b** | Stream 2 | Port `RoomResponseRecorder.py` + `DatasetCollector.py` + `generate_missing_averages.py` + `MicTesting.py` + `signal_processor.py` (≈3700 LOC total) into `PianoidCore/pianoid_middleware/modal_adapter/measurement/`. Delete `_room_response_bootstrap.py` shim | **L** (~3700 LOC port + tests + ~1 week wall) | Medium — these are the recording hot path |
| **Phase 3** | Stream 3 | Audio driver merge — port `sdl_audio_core` device-management + multichannel record/playback into Pianoid's SDL3 driver, expose pybind11 surface so the ported recorder talks to ONE driver. Eliminates pause/resume dance | **XL** (~3200 LOC C++ port + new pybind11 layer + cross-cutting test suite + ~3 weeks wall) | High — touches synthesis hot path |

**Strong recommendation:** **Phase 1 ships standalone first** as it's pure UI restructuring with zero new backend code paths. **Phase 2a + 2b ship together** (the new UI fields are dead weight without the backend allow-list expansion AND the port removes the cross-repo coupling that today causes the dev-mastop coordination dance to be necessary). **Phase 3 is a separate decision** that should not block Phases 1-2; the dev-mastop pause/resume coordination is already shipped, working, and well-tested, so the cost-benefit of an XL refactor needs an explicit user OK before it is taken on.

---

## 2. Stream 1 — Collect Panel UX Overhaul

### 2.1 Current State

**Frontend** — `D:\repos\PianoidInstall\PianoidTunner\src\components\CollectPanel.jsx` (427 lines). Single component, single Paper, all fields in one collapsible "Recorder config" section. No per-field grouping. Fields exposed:

| Field | Source line | UI control |
|---|---|---|
| `scenario_number` (0-87) | 200-216 | NumInput |
| `project_dir` | 217-228 | TextField |
| `sample_rate` (Hz) | 254-269 | NumInput |
| `num_pulses` | 271-287 | NumInput |
| `volume` (0-1) | 288-307 | NumInput |
| `num_measurements` | 308-323 | NumInput |
| `input_device` (SDL3 ordinal) | 327-345 | Select (populated by `/modal/collect/devices`) |
| `output_device` (SDL3 ordinal) | 346-363 | Select |

**Mounting** — `ModalAdapter.jsx:1148-1150` mounts `<CollectPanel url={url} initialProjectDir={projectDir||""} />` when `activeSection === "collect"`. The other three sections (`"setup"`, `"tracking"`, `"apply"`) follow a different pattern — they have a **collapsible "Settings" accordion at the top** populated by `MappingEditor` + `EspritConfig` etc. (`ModalAdapter.jsx:822-1142`).

**Backend** — `collection_engine.py:510-531` `_build_recorder_config` allow-lists exactly seven top-level keys (`sample_rate`, `num_pulses`, `volume`, `input_device`, `output_device`, `input_device_name`, `output_device_name`) plus passes `multichannel_config` verbatim. Everything else in `recorder_config_overrides` is silently dropped. `_build_scenario_dict` at lines 578-595 accepts six scenario-level keys (`description`, `computer`, `room`, `num_measurements`, `measurement_interval`, plus the implicit `scenario_number`).

### 2.2 Canonical "Settings Section" Pattern (from Setup subpanel)

Each settings group lives inside an MUI Accordion with these properties (see `ModalAdapter.jsx:891-1003` for `MappingEditor`, lines 950-1003 for `EspritConfig`):

```jsx
<Accordion defaultExpanded={isDirty} disableGutters square sx={{...}}>
  <AccordionSummary expandIcon={<ExpandMoreIcon fontSize="small" />}>
    <Stack direction="row" spacing={1} alignItems="center">
      <Typography variant="caption" sx={{ fontWeight: 500 }}>Section Title</Typography>
      {settingsFrozen && <Chip icon={<LockIcon/>} label="Locked" size="small" variant="outlined" />}
    </Stack>
  </AccordionSummary>
  <AccordionDetails sx={{ pt: 0 }}>
    {/* per-field controls — disabled={settingsFrozen} on every input */}
    {!settingsFrozen && (
      <Button variant={dirty ? "contained" : "outlined"}
              color={dirty ? "primary" : "inherit"}
              onClick={handleSaveSection}>
        {dirty ? "Save Settings *" : "Save Settings"}
      </Button>
    )}
  </AccordionDetails>
</Accordion>
```

Lock semantics for the Setup section are driven by `settingsFrozen = stages.esprit.running || stages.esprit.done` (`ModalAdapter.jsx:390`). The equivalent for Collect needs a parallel `collectionFrozen` flag that should be `true` while a measurement session is `recording | saving | resuming`. After completion (`done | error | cancelled`), the lock should release so the user can re-edit and start the next scenario.

**Save semantics.** The Setup pattern has each section declare its own dirty flag (`mappingDirty`, `espritConfigDirty` in `useModalAdapter.js`) and a section-scoped save endpoint:

- `saveEspritConfig` → `POST /modal/esprit_config` (`useModalAdapter.js:1368-1370`)
- `handleSaveMapping` → `POST /modal/mapping` (called from `ModalAdapter.jsx:421-428`)

For Collect, the natural equivalents are **per-section project-level persistence** — the General + Audio Devices + Impulse + Series settings should be stored on the modal-adapter project (alongside `mapping_config.json`) and survive across scenario starts, rather than being a per-scenario form filled out from scratch each time. This requires four new endpoints (or one batched endpoint with section keys):

```
POST /modal/projects/{name}/collect_config
  body: {general: {...}, audio: {...}, impulse: {...}, series: {...}}
GET  /modal/projects/{name}/collect_config -> {general, audio, impulse, series}
```

Then `start()` merges the saved per-project config with the per-scenario form (only `scenario_number` is per-scenario; everything else has defaults from project config).

### 2.3 Proposed UX — Four Sections

Wire-frame using the user's grouping (verbatim quote: "general / audio device / impulse / series"). Citations are to existing source as the design authority.

#### Section A: **General**

| Field | Type | Default | Maps to (backend) | Source of truth |
|---|---|---|---|---|
| Project name | str (read-only display) | from `current_project` | not sent — context only | `useModalAdapter.js` current_project |
| Layout (linear / grid) | radio toggle | inherited from `mapping_config.layout_type` | not sent — context only | `mapping.py:34` (already a project-level field) |
| Channel mapping summary | read-only display | inherited from `mapping_config` | not sent — link to Setup section's `MappingEditor` for editing | `mapping.py` |
| `description` | TextField | empty | `recorder_config_overrides.description` | `_build_scenario_dict:588` |
| `computer` | TextField | "ModalAdapter" | `recorder_config_overrides.computer` | `_build_scenario_dict:591` |
| `room` | TextField | "Run" | `recorder_config_overrides.room` | `_build_scenario_dict:592` |

**Note on layout + channel-mapping integration:** the user's request to put "channel mapping" inside Collect's General section creates a duplication risk. The Setup subpanel already owns `MappingEditor` (and bridge_boundary + pitch_offset) — these should not be edited from two places. The recommendation is that Collect's General section shows a **read-only summary** ("Layout: Linear · 16 channels · 12 response, 1 force, 3 skip") with a "Edit in Setup" link/chip that switches `activeSection` to `"setup"`. The Collect panel thus inherits these values without duplicating the editor.

#### Section B: **Audio Device Selection**

| Field | Type | Default | Maps to (backend) | Source of truth |
|---|---|---|---|---|
| Input device | Select (SDL3 ordinal) | "" → `recorderConfig.json` default | `recorder_config_overrides.input_device` / `input_device_name` | `_build_recorder_config:524` |
| Output device | Select | "" → default | `recorder_config_overrides.output_device` / `input_device_name` | `_build_recorder_config:524` |
| Refresh devices button | action | — | re-calls `GET /modal/collect/devices` | existing endpoint |
| SDL version display | str (read-only) | from `/modal/collect/devices` | — | `list_audio_devices:644` |
| `multichannel_config.enabled` | Switch | False | `recorder_config_overrides.multichannel_config.enabled` | `recorder.py:59` |
| `multichannel_config.num_channels` | NumInput | 1 | same | `recorder.py:60` |
| `multichannel_config.channel_names` | editable list | `["Channel 0"]` | same | `recorder.py:61` |
| `multichannel_config.calibration_channel` | Select int / None | None | same | `recorder.py:62` |
| `multichannel_config.reference_channel` | Select int | 0 | same | `recorder.py:63` |
| `multichannel_config.response_channels` | multi-select chips | `[0]` | same | `recorder.py:64` |
| `multichannel_config.normalize_by_calibration` | Switch | False | same | `recorder.py:66` |
| `multichannel_config.alignment_correlation_threshold` | NumInput | 0.7 | same | `recorder.py:58-67` |
| `multichannel_config.alignment_target_onset_position` | NumInput | 0 | same | `recorder.py:58-67` |

**Backend status:** the `multichannel_config` block is already passed verbatim by `_build_recorder_config:528-530`. Zero backend changes. The values are consumed by `RoomResponseRecorder._init_multichannel_config` (`RoomResponseRecorder.py:55-64`).

#### Section C: **Impulse Configuration** (per "RoomResponse project" reference)

The user direction explicitly says "refer to the RoomResponse project". The RR Streamlit panel `gui_series_settings_panel.py:1015-1027` calls this group "Pulse Configuration" — the user said "impulse" in their direction. Either name works; I'll use **Impulse** here per the user. This section maps 1:1 to RR's pulse-shape parameters.

| Field | Type | Default | Backend allow-list status | Source line |
|---|---|---|---|---|
| `impulse_form` | Select (sine / square / voice_coil) | 'sine' | NOT in allow-list — Phase 2a adds | `recorder.py:48,458` |
| `pulse_duration_ms` (sine/square only) | NumInput, ms | 8.0 | NOT in allow-list — Phase 2a adds (convert ms→s in `_build_recorder_config`) | `recorder.py:42,459` |
| `pulse_frequency_hz` (sine only) | NumInput, Hz | 1000 | NOT in allow-list — Phase 2a adds | `recorder.py:47,460` |
| `pulse_fade_ms` | NumInput, ms | 0.1 (clamped) | NOT in allow-list — Phase 2a adds | `recorder.py:43,463` |
| `invert_polarity` | Switch | False | NOT in allow-list — Phase 2a adds | `recorder.py:50,529` |
| `pulse_smoothing_ms` | NumInput | 0.0 | NOT in allow-list — Phase 2a adds | `recorder.py:51,521` |
| **Voice-coil sub-block** (conditional on `impulse_form === 'voice_coil'`) | nested | — | — | `recorder.py:97-104` |
| → `voice_coil_config.init_pos_ms` | NumInput | 0.0 | passed via `voice_coil_config` (Phase 2a) | `recorder.py:98,478` |
| → `voice_coil_config.init_pos_amplitude` | Slider [-0.2, 0] | -0.1 | same | `recorder.py:99,479` |
| → `voice_coil_config.positive_ms` | NumInput | 20.0 | same | `recorder.py:100,480` |
| → `voice_coil_config.gap_ms` | NumInput | 10.0 | same | `recorder.py:101,481` |
| → `voice_coil_config.negative_ms` | NumInput | 100.0 | same | `recorder.py:102,482` |
| → `voice_coil_config.pullback_amplitude` | Slider [-1, 1] | 0.5 | same | `recorder.py:103,483` |
| **Test Pulse button** (optional Phase 3) | action | — | needs new endpoint | `gui_series_settings_panel.py:749-928` |

**Unit policy:** RR's UI uses ms for all human-facing time values, RR's recorder stores seconds. Pianoid's UI should keep ms (matches the band editor's `ir_length_ms`/`skip_start_ms`/etc convention). Conversion happens in `handleStart` (frontend) or `_build_recorder_config` (backend) — pick **one** layer; recommend backend so the override envelope stays unit-consistent with `recorderConfig.json`. Surface the unit explicitly in every label ("(ms)" suffix).

#### Section D: **Series Configuration**

| Field | Type | Default | Backend allow-list status | Source line |
|---|---|---|---|---|
| `num_pulses` (per cycle) | NumInput | 8 (RR) / 50 (Pianoid current) | already in allow-list | `_build_recorder_config:524` |
| `cycle_duration_ms` | NumInput, ms | 100.0 | NOT in allow-list — Phase 2a adds | `recorder.py:44,184` |
| `record_extra_time_ms` | NumInput, ms | 200.0 | NOT in allow-list — Phase 2a adds (and verify `_apply_series_settings_to_recorder` semantics — see § 7 Q4) | `series_settings_origin.py:996-1002` |
| `volume` | NumInput, 0-1 | 0.4 (RR) / 0.5 (Pianoid current) | already in allow-list | `_build_recorder_config:524` |
| `num_measurements` (pulses per scenario) | NumInput | 5 (RR) / 8 (Pianoid current) | already in allow-list (in scenario_dict) | `_build_scenario_dict:593` |
| `measurement_interval` (s) | NumInput | 0.5 (Pianoid current — too tight) | already accepted | `_build_scenario_dict:594` |
| Recording mode | Radio (Standard / Calibration) | Standard | NOT plumbed — Phase 2a adds `recording_mode=` to `_invoke_collection` `collector_factory(...)` call | `DatasetCollector.py:92,699` |
| `averaging_start_cycle` | NumInput | 2 | conflicts with `scenario_averager.py` defaults — see § 7 Q3 | `series_settings_origin.py:1032-1038` |
| **Calculated** Gap duration | read-only | derived | display only | `recorder.py:185` |
| **Calculated** Series duration | read-only | derived | display only | `recorder.py:186` |
| **Calculated** Duty cycle | read-only | derived | display only | UI 1125 |
| **Calculated** Pulse rate | read-only | derived | display only | UI 1127 |

The four "Calculated" rows are display-only derivations: a small footer block under the form computes them client-side in real time so the user can see how `num_pulses × cycle_duration + extra_time` reaches the actual scenario duration. Pattern: matches the EspritConfig "Effective Signal Length warning" Alert footer (`EspritConfig.jsx:541-548`).

### 2.4 Estimate

Rebuilding `CollectPanel.jsx` to host the four Accordion sections with proper `settingsFrozen` semantics and per-section "Save Settings" buttons (with project-level persistence):

| Item | LOC delta |
|---|---|
| Frontend — restructure existing 427-line component into 4 sections | +250 (much of the existing form fields stay; new shell + accordion wrappers + section dirty flags) |
| Frontend — additional fields in Audio (multichannel block ~120) and Impulse (pulse + voice_coil ~150) and Series (cycle_duration, recording_mode, etc. ~50) | +320 |
| Frontend — new `useCollectConfig` hook for project-level persistence (mirror of `useEspritConfig` shape) | +120 |
| Backend — new `GET/POST /modal/projects/{name}/collect_config` endpoints | +80 |
| Backend — `_build_recorder_config` allow-list expansion + `recording_mode` plumbing | +25 |
| Backend — Phase 2a tests | +60 |
| Frontend — Phase 2a tests | +50 |
| **Total Phase 1 + 2a** | **~900 LOC** |

**Effort: M-L (~3-5 days wall, two `/dev` sessions).**

---

## 3. Stream 2 — RoomResponse Port

### 3.1 Inventory of Cross-Repo Imports

The exhaustive grep across `D:\repos\PianoidInstall\PianoidCore` for `from RoomResponse|from RoomResponseRecorder|from DatasetCollector|from generate_missing_averages|from sdl_audio_core|from MicTesting|from signal_processor` returns four call sites in PianoidCore proper, all inside the modal_adapter package:

| File | Line | Import | Classification |
|---|---|---|---|
| `pianoid_middleware/modal_adapter/_room_response_bootstrap.py` | 69-70 | `import sdl_audio_core` + `import RoomResponseRecorder` | **Bootstrap probe** — proves RR is importable; runs at server start. After port: deleted entirely. |
| `pianoid_middleware/modal_adapter/collection_engine.py` | 605 | `from RoomResponseRecorder import RoomResponseRecorder` | **Runtime — must port.** Lazy factory inside `_default_recorder_factory`. |
| `pianoid_middleware/modal_adapter/collection_engine.py` | 611 | `from DatasetCollector import SingleScenarioCollector` | **Runtime — must port.** Lazy factory inside `_default_collector_factory`. |
| `pianoid_middleware/modal_adapter/collection_engine.py` | 617 | `from generate_missing_averages import generate_averaged_responses_for_scenario` | **Runtime — must port.** Lazy factory inside `_default_averager`. |
| `pianoid_middleware/modal_adapter/collection_engine.py` | 637 | `import sdl_audio_core` (inside `list_audio_devices()`) | **Runtime — must port.** Used by `GET /modal/collect/devices`. The pybind11 module itself is built from `RoomResponse/sdl_audio_core/`; it is the C++ extension piece (deeper port — see Stream 3). |

There is also one **comment-only** mention in `modal_adapter.py:1294` ("Loads from RoomResponse or flat npy format…") which is documentation, not an import. The ESPRIT subpackage at `pianoid_middleware/modal_adapter/esprit/` was already inlined per its own header comment (`esprit_runner.py:27-30`: "ESPRIT library (inlined from RoomResponse — no external dependency)"); no port work for that subtree.

There is also one test-only reference in `tests/integration/test_scenario_averager.py:439`: a skip-message saying RR "not on sys.path — install at D:/repos/RoomResponse to enable." This is a soft-fail test gate, post-port the message just changes ("not yet ported" → "test was for the legacy bootstrap path").

### 3.2 Transitive Import Closure

`RoomResponseRecorder.py:8-9`:

```python
from MicTesting import _SDL_AVAILABLE, sdl_audio_core
from signal_processor import SignalProcessor, SignalProcessingConfig
```

So porting `RoomResponseRecorder` pulls in `MicTesting.py` (177 LOC) and `signal_processor.py` (594 LOC). `DatasetCollector.py` only depends back on `RoomResponseRecorder` (line 20). `generate_missing_averages.py` has no RR-internal imports (only stdlib + numpy).

Total port surface (LOC, source of truth):

| Module | LOC | Role |
|---|---|---|
| `RoomResponseRecorder.py` | 1457 | Recorder lifecycle, signal generation, multichannel record/playback, per-cycle alignment, on-disk save (raw_recordings, impulse_responses, room_responses) |
| `DatasetCollector.py` | 995 | `SingleScenarioCollector` — orchestrates N measurements per scenario, writes `metadata/session_metadata.json`, mode dispatch (standard / calibration) |
| `generate_missing_averages.py` | 217 | Walks scenario dirs, computes per-channel mean IR → `averaged_responses/average_chN.npy` |
| `MicTesting.py` | 177 | `_SDL_AVAILABLE` guard + thin wrapper around `sdl_audio_core` for mic stream |
| `signal_processor.py` | 594 | Cycle-onset detection, per-cycle alignment, calibration-quality validation, IR truncation |
| `multichannel_filename_utils.py` | 264 | Filename helpers for per-channel WAV/NPY (only some functions used, may be subset port) |
| **Total port** | **~3700 LOC** | |

The bundled config file `RoomResponse/recorderConfig.json` (currently consulted by `collection_engine._load_default_recorder_config`) needs a Pianoid-side equivalent. Recommendation: ship a `PianoidCore/pianoid_middleware/modal_adapter/measurement/recorder_defaults.json` and reuse the discovery logic from `_load_default_recorder_config:533-557`.

### 3.3 Per-Module Porting Plan

**Target package layout:**

```
PianoidCore/pianoid_middleware/modal_adapter/measurement/
    __init__.py               # public API: RoomResponseRecorder, SingleScenarioCollector,
                              #             generate_averaged_responses_for_scenario
    recorder.py               # ported RoomResponseRecorder.py (renamed module)
    collector.py              # ported DatasetCollector.py
    averager.py               # ported generate_missing_averages.py
    mic_testing.py            # ported MicTesting.py
    signal_processor.py       # ported signal_processor.py
    multichannel_utils.py     # ported subset of multichannel_filename_utils.py
    recorder_defaults.json    # ported recorderConfig.json (Pianoid-tuned defaults)
```

**Sequencing:**

1. **Port stage** (one PR): copy the 6 files into the new package, normalise imports (`from MicTesting import …` → `from .mic_testing import …`), keep behaviour byte-identical. Assertions: `pytest tests/integration/test_modal_collection_b1.py` passes against the new package; `pytest tests/integration/test_scenario_averager.py` passes; manual `curl /modal/collect/start` end-to-end pass on a small scenario.
2. **Switch stage** (same PR or next): change `collection_engine.py` factories to import from `.measurement` instead of from sibling-repo top-level. Remove `_room_response_bootstrap.py` discovery, `bootstrap_roomresponse()` call from `modal_adapter_server.py`, and the `PIANOID_ROOMRESPONSE_PATH` env var. Update `_room_response_bootstrap.py:32-42` discovery removal — the path is no longer external. The `health` endpoint (`GET /modal/collect/health`) becomes a trivial "available: true" check.
3. **Cleanup stage** (separate PR): delete dead files (`_room_response_bootstrap.py`, the `.dev-mastop-tmp` orphans), update `MODAL_COLLECTION.md` and `OVERVIEW.md` to remove the "RoomResponse Bootstrap (Wave B-0)" section, archive `docs/development/proposals/COLLECT_MIGRATION_FROM_ROOMRESPONSE.md` (its job is done).
4. **Tests** (rolling): the existing `test_modal_collection_b1.py` and `test_scenario_averager.py` already exercise the surface; they just point at the new module path. New unit tests for the ported `signal_processor` cycle-alignment + calibration-quality blocks (the legacy code has no in-repo tests beyond the e2e ones).

### 3.4 Port Risk Matrix

| Module | Risk | Why |
|---|---|---|
| `generate_missing_averages.py` | **Low** | Pure numpy, no SDL dep, ~200 LOC, already has e2e test coverage |
| `signal_processor.py` | **Low-Med** | Numerical, no SDL dep, but 600 LOC of cycle-alignment + calibration validation logic — needs unit tests it doesn't have today |
| `multichannel_filename_utils.py` | **Low** | Pure path/filename string helpers |
| `MicTesting.py` | **Low** | Thin SDL wrapper; once `sdl_audio_core` is importable from the same env, no Path or import gymnastics needed |
| `DatasetCollector.py` | **Med** | 1000 LOC of orchestration with two recording modes, queue-driven worker thread — needs careful integration testing |
| `RoomResponseRecorder.py` | **Med-High** | The recording hot path. 1500 LOC. Time-critical SDL stream callbacks. Must not introduce buffer-size or alignment regressions |
| `sdl_audio_core` (the C++ pybind11 module) | **N/A for Stream 2 — see Stream 3** | The `.pyd` itself is a compiled artefact built from `RoomResponse/sdl_audio_core/`. For Stream 2 the recommendation is to keep it as a **vendored pybind11 binary** (drop the `.pyd` + `SDL3.dll` into PianoidCore's site-packages, like any other Python C-ext dep) and defer the C++ unification to Stream 3. The `_room_response_bootstrap.py` path-prepend goes away in either case |

### 3.5 Stream 2 Effort Estimate

| Item | Effort |
|---|---|
| Code port (≈3700 LOC, mostly mechanical) | **L** — 2-3 days for one engineer |
| Test plumbing (new unit tests for `signal_processor` + `recorder` + `collector`) | M — 2 days |
| Integration test re-pointing + `MODAL_COLLECTION.md` doc rewrite | S — 0.5 day |
| pybind11 `.pyd` vendoring decision + ship plan (where does it live, who builds it, how does it survive `update-pianoid`) | S — 0.5 day discussion + 0.5 day setup |
| **Total Stream 2 wall time** | **~1 week** for one engineer |

**Risk register:**

- The `.pyd` lives outside PianoidCore today (`D:/repos/RoomResponse/sdl_audio_core/sdl_audio_core.cp312-win_amd64.pyd`). Vendoring it into PianoidCore creates a build-system question: who rebuilds it, when, and against which SDL3 version. Pianoid's SDL3 is version-pinned at 3.2.0 (per `RoomResponse/sdl_audio_core/build_config.json:14-15`: "Version-pin alignment with PianoidCore (3.2.0) is intentional"). This pin survives the port but the build process needs documenting in `BUILD_SYSTEM.md`.
- `RoomResponseRecorder` keeps a singleton `sdl_audio_core.AudioEngine` open across recording sessions; the modal-adapter-server today re-instantiates the recorder per scenario. After port, audit whether the existing per-scenario churn is OK or whether we should hoist the AudioEngine to a server-singleton (matches the dev-mastop direction).

---

## 4. Stream 3 — Audio Driver Merge Feasibility

### 4.1 Side-by-Side Audit

| Aspect | Pianoid `pianoid_cuda/SDL3AudioDriver` | RoomResponse `sdl_audio_core::AudioEngine` |
|---|---|---|
| **Underlying lib** | SDL3 (pinned 3.2.0) | SDL3 (pinned 3.2.0) — explicitly version-aligned |
| **Source path** | `PianoidCore/pianoid_cuda/SDL3AudioDriver.{h,cpp}` (115 + 506 LOC) | `RoomResponse/sdl_audio_core/src/audio_engine.{h,cpp}` (270 + 1302 LOC) |
| **Build target** | Linked into `pianoidCuda.cp312-win_amd64.pyd` (the PianoidCuda C++/CUDA extension) | Standalone `sdl_audio_core.cp312-win_amd64.pyd` pybind11 module |
| **Output path** | Stereo only (`numChannels = 2` hardcoded `SDL3AudioDriver.cpp:16`) | 1-32 output channels (`audio_engine.h:60`, `audio_engine.cpp:111-119` validation) |
| **Input path (mic)** | Recording stream + `CaptureBuffer` for calibration mic; **single channel** (mono mic capture, see `SDL3AudioDriver.h:107` + `MicAnalyzer.{cpp,h}`) | Multi-channel recording 1-32 input channels (`audio_engine.h:113` `recording_buffers_[channel_idx][samples]`, `audio_engine.cpp:122-133`) |
| **Buffer model** | `LockFreeCircularBuffer` (CUDA stream-isolated D→H copy via `produce_stream` — see `AUDIO_DRIVERS.md` line 252) — chunked GPU output | `AudioBuffer` (mutex-protected ring buffer per direction) — host-only |
| **Sample format** | `SDL_AUDIO_S32` (int32, downmix in callback) | `SDL_AUDIO_F32` (float, native — confirmed by the `recording_buffers_<float>` typing at `audio_engine.h:113`) |
| **Device handle ownership** | One `SDL_AudioDeviceID deviceId` for output stream only (no concurrent input device — input device opened ad-hoc by `setInputDevice`/`startCapture`) | TWO `SDL_AudioDeviceID` (`input_device_` + `output_device_`) opened concurrently |
| **Lifecycle** | `init() → start() → pause() / resume() → stop() → stopAndWait()` (matches `AudioDriverInterface.h`) | `initialize() → start() → stop() → shutdown()` (no public pause/resume) |
| **Threading** | Synthesis thread (CUDA producer) + SDL audio thread (consumer); no other threads | Two SDL audio threads (input + output) + Python caller thread; recording-completion `condition_variable` |
| **Pybind11 surface** | None — `pianoidCuda` exposes `Pianoid` class which owns the driver internally | `sdl_audio_core.AudioEngine` directly bound (`python_bindings.cpp` 508 LOC) |

### 4.2 Why Merging Is Hard

Three cross-coupling problems make a true merge non-trivial:

1. **Channel arity mismatch.** Pianoid downmixes 8 GPU channels → 2 stereo output channels in the SDL3 callback (`SDL3AudioDriver.cpp` `fillAudioStream`). RoomResponse needs 1-N output to drive a single-channel hammer impulse and N-channel record. A merged driver must support both: stereo downmix for the synthesis path AND arbitrary-channel output for the impulse path. Not impossible (the channel count is a runtime config) but the synthesis-side downmix kernel is hard-coded for stereo today and would need to become a runtime channel-count parameter.

2. **Sample format mismatch.** Pianoid is `S32` end-to-end; RR is `F32` end-to-end. A single driver can stream either format, but the synthesis `produce()` path generates `Sint32` from the GPU kernel and the recorder's signal_processor expects `float32` numpy arrays. Either:
   - merge at the SDL stream level only (each consumer keeps its own format internally — F32 callback for the recorder, S32 callback for the synthesiser, both backed by the same SDL device), OR
   - convert at the boundary (extra latency-sensitive copy in the synthesis hot path, **not acceptable**).

3. **Lifecycle ownership.** The dev-mastop coordination (pause synthesis → record → resume synthesis) exists because the SDL3 device is exclusive. A merged driver would let both consumers share the device — but only if the two consumers can coexist:
   - synthesis pushes 8-channel S32 chunks every cycle into a circular buffer drained by the SDL output callback,
   - recorder pushes a one-shot impulse signal AND wants to read N input channels.

   These cannot run simultaneously on a single output stream (the two would interleave samples). The merge therefore reduces to "shared device ownership but mutually-exclusive activity", which is exactly what `pause_synthesis`/`resume_synthesis` already implements at the Python level.

The architectural insight: **merging the C++ drivers does NOT eliminate the contention** — the hardware is still mutually exclusive for output. What it could improve:

- **(modest gain)** Single SDL_Init / shared device-discovery cache. Pianoid and the recorder enumerate devices independently today.
- **(modest gain)** No cross-process coordination needed — but the modal-adapter-server is already in-process with the recorder; the synthesis backend at port 5000 is a separate process and that's the boundary the pause/resume HTTP call crosses. Merging the driver code doesn't remove the process boundary.
- **(real gain)** Mic capture for the dev-833f / SoundChannels measurement infrastructure could share buffer plumbing with the recorder's multi-channel input. Today `CaptureBuffer` (in `pianoid_cuda`) is mono and used by `MicAnalyzer` for calibration; the recorder's multi-channel input is in a separate process. A unified multi-channel input path would simplify mic-loopback test infrastructure.

### 4.3 Three Merge Options

**Option A — full merge (single C++ library replaces both).**
Port `sdl_audio_core::AudioEngine` capabilities into Pianoid's `SDL3AudioDriver` (multi-channel support, F32 alongside S32, pybind11 bindings for the recorder API surface). Delete `RoomResponse/sdl_audio_core/` after Stream 2 port lands.
- Effort: **XL — ~3 weeks wall** (port + extend + new bindings + cross-cutting tests + risk of regressing synthesis hot path).
- Pro: one codebase, one bug surface, shared device discovery, mic infrastructure unification.
- Con: touches the synthesis hot path with audio-correctness consequences. Requires extensive A/B testing against the existing synthesis benchmarks (test-perf, mic-loopback A1, etc.).

**Option B — minimal merge (shared DLL, separate top-level classes).**
Don't actually unify the drivers; just have BOTH (`SDL3AudioDriver` + `sdl_audio_core::AudioEngine`) link the SAME `SDL3.dll` from a shared location. Today they each link their own. The pause/resume dance stays — the gain is purely deployment hygiene (no dual SDL3.dll, no dual SDL3 init).
- Effort: **S — ~2 days** (build-system change only).
- Pro: low risk, removes one class of "two SDL3.dll versions out of sync" bugs.
- Con: doesn't actually solve the device contention. The dev-mastop dance survives.

**Option C — defer indefinitely (status quo + better docs).**
Keep both drivers separate. The pause/resume dance is shipped, working, and well-tested. Document the boundary explicitly. The Stream 2 port (which DOES eliminate the cross-repo `sys.path` shim) achieves most of the user's "no imports from RoomResponse" goal without taking on driver-merge risk.
- Effort: **S — ~1 day** (doc updates).
- Pro: zero synthesis hot path risk, ships immediately.
- Con: long-term we still have two SDL3 driver implementations; mic capture infrastructure stays mono.

### 4.4 Recommendation

**Option C for now, Option A as a longer-term goal contingent on user direction.**

Justification:

1. The user's three asks are interrelated but separable. UX overhaul (Stream 1) and port (Stream 2) deliver 100% of the user-visible benefit ("no imports from RoomResponse") without taking on the synthesis-hot-path risk.
2. The dev-mastop coordination is already shipped, tested, and documented. Replacing it costs more than maintaining it.
3. If the team later decides multi-channel mic capture (for measurement_engine, MicAnalyzer, the calibration_volume family) needs to scale beyond mono, **that** is the natural trigger for Option A — at which point the recorder's multi-channel input path becomes the design template. The user has not asked for this today.
4. Option B's payoff (no duplicate DLL) is real but small; it can ride along inside the Stream 2 port as a build-system tidy-up if convenient.

**Hard stop:** if the user comes back and explicitly asks for Option A, the proposal returns for a Phase 3 design pass — there's enough complexity that designing it inline here would be premature.

---

## 5. Cross-Stream Dependency Graph

```
                 ┌─────────────────────┐
                 │ Phase 1 — UX shell  │  (4 sections, project-level persistence, lock semantics)
                 │ ~600 frontend LOC   │
                 │ ~80 backend LOC     │
                 └──────────┬──────────┘
                            │  (UI fields exist but most of Impulse + Series silently no-op
                            │   until the allow-list expands)
                            ▼
                 ┌─────────────────────┐
                 │ Phase 2a — backend  │  (allow-list expansion + recording_mode plumbing)
                 │ ~25 backend LOC     │
                 │ ~100 test LOC       │
                 └──────────┬──────────┘
                            │  (Phase 1 + 2a together = full UX overhaul end-to-end)
                            ▼
                 ┌─────────────────────────────┐
                 │ Phase 2b — Stream 2 port    │  (RR modules into PianoidCore/measurement/)
                 │ ~3700 LOC port + tests      │
                 │ Eliminates `sys.path` shim  │
                 └──────────┬──────────────────┘
                            │  (modal-adapter-server is fully self-contained)
                            ▼
                 ┌─────────────────────────────┐
                 │ Phase 3 (OPTIONAL) — driver merge │  (XL, only if user explicitly asks)
                 │ ~3200 C++ port + new pybind11     │
                 │ Eliminates pause/resume dance     │
                 └───────────────────────────────────┘
```

**Hard dependencies:**

- Phase 2a depends on Phase 1: the new UI fields are dead-code without the backend allow-list.
- Phase 2b is **independent** of Phase 1/2a — it can ship before, after, or interleaved. The two streams touch disjoint code (Stream 1 = `CollectPanel.jsx` + `collection_engine._build_recorder_config`; Stream 2 = `collection_engine._default_*_factory` + new `measurement/` package).
- Phase 3 has no hard dependency on 1/2 but benefits from Phase 2b having landed first (so the recorder code is in PianoidCore and the C++ merge is reorganising in-tree code rather than across repos).

**Recommended sequence (preserving safety):**

1. Phase 1 standalone PR — pure UI restructure, no functional change. Reviewable in isolation.
2. Phase 2a as a follow-up — backend allow-list + the per-section new fields end-to-end. Includes integration test that the new envelope round-trips through `MeasurementSession`.
3. Phase 2b in its own multi-day PR — port + delete bootstrap. High-volume code change but mechanical.
4. (Optional) Phase 3 — separate proposal pass after user sign-off.

---

## 6. Sign-off Gates

Each phase requires a measured pass before promotion.

| Phase | Gate | Measurement |
|---|---|---|
| Phase 1 | UI smoke test via `/test-ui` (audio_off mode — no synthesis output change) | Each accordion expands, fields edit-and-save, "Locked" chip appears on `recording` phase, all four "Save Settings" buttons work. Snapshot test of the rendered DOM vs the spec |
| Phase 2a | Round-trip test: build a `recorder_config` payload covering all new fields, POST `/modal/collect/start`, assert the recorder receives the values via a mock factory | New unit test under `tests/unit/test_collection_engine_envelope.py`; existing `test_modal_collection_b1.py` continues to pass |
| Phase 2b | End-to-end measurement test against Belarus dataset (or equivalent) — collect one scenario via the ported recorder, compare the resulting averaged_responses against a reference run from the cross-repo recorder | byte-equal (or numpy-close within float tolerance) on `averaged_responses/average_chN.npy` |
| Phase 3 | Synthesis perf benchmark (test-perf-audio-on) + mic-loopback A1 (test-ui audio_on Phase 7) — neither regresses. New multi-channel mic test with at least one synth + one capture stream sharing the merged driver | per N≥3 runs, p99 callback interval Δ < 5%; mic captures within 2dB of synth volume target |

---

## 7. Open Questions for the User

These are the architectural decisions that need explicit user direction before any phase ships. Several of them inherit from the prior `COLLECT_MIGRATION_FROM_ROOMRESPONSE.md` proposal (§E) and are still open:

1. **Project-level vs per-scenario form for General/Audio/Impulse/Series.** The natural pattern matches the rest of Modal Adapter (project-level persistence + per-scenario form for only `scenario_number`). But this means a new endpoint `POST /modal/projects/{name}/collect_config` and a per-project JSON file. Confirm vs. the alternative ("keep the per-scenario form, just rearrange it" — simpler but less consistent with the rest of the UI).

2. **Where does layout / channel-mapping live?** The user's spec says "general — project name, layout (grid or linear), channel mapping" inside Collect. But layout + channel mapping are already owned by the Setup subpanel's `MappingEditor`. Recommendation in this proposal: read-only summary in Collect's General + edit-link to Setup. Confirm vs. the alternative (mirror the editor in two places — a duplication risk).

3. **Truncation & averaging duplication.** `RoomResponseRecorder._process_recorded_signal` (with `truncate_config.ir_working_length_ms = 500`) and Pianoid's `scenario_averager.py` (with `ir_working_length_ms = 600`) both run today. Decision needed before the Impulse/Series sections expose either knob — see prior proposal §E.3.

4. **Calibration mode plumbing.** Today `_invoke_collection` always uses `recording_mode='standard'`; the bundled `recorderConfig.json` has `calibration_channel: 2` set but the calibration code path is unreachable from the Pianoid frontend. The Series section "Recording Mode" radio assumes Phase 2a will plumb `recording_mode` through `collector_factory(...)`. Confirm calibration is in-scope.

5. **Test Pulse button (RoomResponse's sensor diagnosis).** Worth porting to the Impulse section? Cost is one new endpoint + ~150 LOC; payoff is preventing wasted scenarios when a sensor is unplugged. Confirm in/out of scope.

6. **`sdl_audio_core.pyd` vendoring strategy** (Phase 2b only). Three options: (a) commit the prebuilt `.pyd` to PianoidCore with a build-time refresh script; (b) add `sdl_audio_core/` source as a subdirectory of PianoidCore and build it as part of `build_pianoid_cuda.bat`; (c) keep it sibling-built but copy it into `PianoidCore/.venv/Lib/site-packages/` during `update-pianoid`. Recommendation: (b) — keeps the build-system contract uniform with `pianoidCuda`. Confirm.

7. **Phase 3 — driver merge — green-light or defer?** The recommendation in §4.4 is to defer. If the user wants it green-lit, that triggers a separate proposal pass; this document does not commit to a Phase 3 design.

8. **Streaming progress messages.** The RR Streamlit panel surfaces per-measurement progress text; today `GET /modal/collect/status` only reports `progress_pct`. Add richer messages ("Measurement 4/8…")? Trivial backend change but cross-cutting.

---

## 8. Cross-References

- **Prior migration analysis (parameter table source):** [`docs/development/proposals/COLLECT_MIGRATION_FROM_ROOMRESPONSE.md`](../development/proposals/COLLECT_MIGRATION_FROM_ROOMRESPONSE.md)
- **REST surface for the Collect endpoints:** [`docs/modules/pianoid-middleware/MODAL_COLLECTION.md`](../modules/pianoid-middleware/MODAL_COLLECTION.md)
- **Pianoid driver architecture:** [`docs/modules/pianoid-cuda/AUDIO_DRIVERS.md`](../modules/pianoid-cuda/AUDIO_DRIVERS.md)
- **Modal Adapter pipeline architecture:** [`docs/guides/MODAL_ADAPTER_GUIDE.md`](../guides/MODAL_ADAPTER_GUIDE.md)
- **Frontend canonical "Settings section" pattern (lock + Save):** `D:\repos\PianoidInstall\PianoidTunner\src\modules\ModalAdapter.jsx:822-1003` (Setup section's accordions)
- **Backend collection orchestrator:** `D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\modal_adapter\collection_engine.py`
- **RR import-bootstrap shim (target for deletion in Phase 2b):** `D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\modal_adapter\_room_response_bootstrap.py`
- **RoomResponse source-of-truth (read-only reference):** `D:\repos\RoomResponse\` — specifically `RoomResponseRecorder.py`, `DatasetCollector.py`, `generate_missing_averages.py`, `MicTesting.py`, `signal_processor.py`, `sdl_audio_core/` (pybind11 module)
