# Pianoid System Review — 2026-04-27

**Scope:** PianoidCore (`pianoid_cuda` + `pianoid_middleware`), PianoidBasic, PianoidTunner.
**Mode:** Read-only audit, written against `docs/development/CODE_QUALITY.md`. No code changes.
**Baseline:** "Current Known God Objects" snapshot dated 2026-04-19 in CODE_QUALITY.md.

---

## 1. Top 10 Files in Scope by LOC

| # | File | LOC | Flag | vs. 2026-04-19 baseline |
|---|------|-----|------|-------------------------|
| 1 | `PianoidCore/pianoid_cuda/Pianoid.cu` | 2983 | RED | +31 (regressed) |
| 2 | `PianoidCore/pianoid_middleware/backendServer.py` | 2990 | RED | +159 (regressed) |
| 3 | `PianoidCore/pianoid_middleware/modal_adapter/modal_adapter.py` | 2725 | RED | unchanged |
| 4 | `PianoidCore/pianoid_middleware/chartFunctions.py` | 2612 | RED | +23 (regressed) |
| 5 | `PianoidCore/pianoid_middleware/pianoid.py` | 2547 | RED | +59 (regressed) |
| 6 | `PianoidTunner/src/PianoidTuner.js` | 2468 | RED | -325 (improvement) |
| 7 | `PianoidTunner/src/components/StabilizationDiagram.jsx` | 2231 | RED | unchanged |
| 8 | `PianoidTunner/src/components/NumInput/NumInput.js` | 1565 | RED | +89 (regressed) |
| 9 | `PianoidTunner/src/hooks/usePreset.js` | 1516 | RED | +79 (regressed) |
| 10 | `PianoidTunner/src/hooks/useModalAdapter.js` | 1356 | RED | unchanged |

Other notable RED files (existing baseline): `calibration_controller.py` 1305 (+2), `mode_tracking.py` 1215 (=), `UnifiedGpuMemoryManager.cu` 1122 (=), `ModalAdapter.jsx` 1077 (=), `asio.h` 1070 (vendor — excluded).

**Notable YELLOW transitions since baseline:**
- `PianoidTunner/src/components/Excitation.jsx`: 532 → 629 (+97, growing toward RED)
- `PianoidCore/pianoid_middleware/auto_tuner.py`: 607 → 609

**Wins since baseline:**
- `PianoidTuner.js` reduced 2793 → 2468 (-325 LOC) — visible reduction of god-object debt.

**Regressions:** 7 of 10 RED files in baseline grew further. Per CODE_QUALITY.md C4: "an existing RED file that grows further is a regression (High)."

---

## 2. Architectural Consistency

**Layer audit: VIOLATION** (3 instances).

1. **PianoidBasic domain model imports matplotlib/seaborn/librosa.** The "domain model" layer is supposed to be pure Python with no I/O / no side effects (CODE_QUALITY C1). Yet:
   - `PianoidBasic/Pianoid/sound_measurements.py:1` imports `librosa.pyin, yin`
   - `PianoidBasic/Pianoid/chart_animation.py:1-7` imports `matplotlib.pyplot, seaborn, matplotlib.widgets, matplotlib.animation`
   - 6 domain model files (`Mode.py`, `PhysicalParameters.py`, `PianoidSimulation.py`, `PianoMeasure.py`, `StringExcitation.py`, `StringMap.py`, `StringState.py`) `from chart_animation import ...` at top-level, pulling matplotlib into the domain layer.
   - Effect: importing PianoidBasic for any reason drags GUI plotting libs into the process.

2. **`backendServer.py` reaches into modal-adapter concern.** `backendServer.py:2927` defines a hand-written `/modal/apply_to_preset` route that duplicates `modal_adapter/routes.py:853`. The main server takes on a modal-adapter role ("modal" prefix on a non-modal-adapter route); the comment block at lines 2918-2925 acknowledges this is a workaround. See "API Consistency" #1 below for the signature drift this creates.

3. **`chartFunctions.py` calls `_stop_online_engine` / `_restart_online_engine`** (line 2158, 2229) — chart-generation module reaching into engine lifecycle. C3/P2 concern bleed: chart family should not stop the audio engine.

**Server audit: VIOLATION** (1 instance).

The `/modal/apply_to_preset` duplication on port 5000 (not via blueprint registration but as a hand-written route in `backendServer.py:2927`) violates C2's "main server code must not import from `modal_adapter/*`" — it lazy-imports `from modal_adapter import ModalAdapter` at line 2960. This is a deliberate workaround for the GPU-context split, but the duplication creates two separate signatures (`selected_chains` vs `selected_modes`) that reach the same C++ engine differently depending on which port the frontend used.

---

## 3. Authority Violations (P1)

| # | State | Owner (intended) | Violating Writer | Severity |
|---|-------|------------------|------------------|----------|
| 1 | `apply_to_preset` selection list | `modal_adapter` blueprint (`routes.py:853`, accepts `selected_modes`) | `backendServer.py:2927` accepts `selected_chains` and constructs its **own** `ModalAdapter()` instance via `adapter = ModalAdapter()` then `adapter.open_project(...)` — i.e., a **second copy** of adapter state derived from disk. The 5001 server holds the "real" adapter; 5000 hydrates a parallel one for one call. | **High** |
| 2 | `MidiListener` lifecycle | `pianoid.py` (live listener, `pianoid.midi_listener`) | Two implementations exist: legacy `pianoidMidiListener.py:8 MidiListener` (485 LOC, used in `pianoid.py:1374`, `midi_keyboard.py:11`) and the C++/`MIDI_listener_unified` path described in SYSTEM_OVERVIEW.md. Documentation says the Python one is "retained for YAML config / per-note CC handlers but not wired into the default startup path" — it is, however, instantiated for one path and bypassed for another, with no clear ownership rule. | Medium |
| 3 | Two `MeasurementEngine` classes (same name, different jobs) | should be ONE module per job | `auto_tuner.py:49 MeasurementEngine` (offline render + pitch/volume measurement, used by chart_functions) AND `measurement_engine.py:46 MeasurementEngine` (mic-based, used by `CalibrationController` / `synthesis_tuner.py` / `acoustic_tuner.py`). Same class name, different signatures, different concerns. A future maintainer reading "MeasurementEngine" cannot tell which one is meant. | High |

---

## 4. Concern Violations (P2)

| # | Module | Stated concern (from baseline) | Concern bleed observed | Severity |
|---|--------|-------------------------------|----------------------|----------|
| 1 | `backendServer.py` (RED, 2990 LOC, +159) | "Main server routes + lifecycle" | grew with calibration-curve routes (`/calibration_curve/*`, 8 endpoints, ~140 LOC), modal route copy (~60 LOC), reference-capture routes (`/save_reference`, `/set_reference`, `/reference`). The file already mixed REST + WS + calibration proxy + MIDI; this commit period added "modal-adapter relay" as a 5th concern. | High |
| 2 | `pianoid.py` (RED, 2547 LOC, +59) | "Synthesis orchestrator" | also imports `ChartGenerator` and `ActionPerformer` (line 14) and lazy-imports `FirFilterFileIO` mid-method (line 2015). Synthesis orchestrator should not link in chart-renderer or filter-IO. | Medium |
| 3 | `chartFunctions.py` (RED, 2612 LOC) | "Chart generation" | contains `_stop_online_engine` / `_restart_online_engine` lifecycle helpers (callers at 2158, 2229) — engine lifecycle is not "chart generation." 36 module-level functions in one file with no class structure, mixing chart families (sound, spectrum, mode, deck, profiling, tuning) into one namespace. Imports `auto_tuner.MeasurementEngine` lazily inside chart code (lines 2298, 2348). | High |
| 4 | `modal_adapter.py` (RED, 2725 LOC) | "Modal adapter orchestrator" | single `ModalAdapter` class spans 2628 lines (line 29 → 2657) — does measurement loading, ESPRIT pipeline, mode tracking integration, feedin extraction, channel mapping, persistence, and apply-to-preset. P2: this is at minimum 4 concerns. | High |
| 5 | `Pianoid.cu` (RED, 2983 LOC, +31) | "CUDA synthesis hub" | ~80 methods on the `Pianoid` C++ class spanning init / GPU memory / parameter sets / runtime state / playback / mode excitation / audio driver / mic capture / FIR filter / single-cycle runs / batch APIs. | High |
| 6 | `usePreset.js` (RED, 1516 LOC, +79) | "Preset hook" | already known to combine WS + REST + debounce + optimistic UI + available notes. Two commented-out blocks (lines 359, 387, 493) reference `/get_deck/feedin` and `/set_deck/feedin` paths that don't exist on the backend — dead branches preserved as documentation. | Medium |

---

## 5. Patch / Workaround Findings

**TODO/FIXME/HACK/XXX in scope (excluding vendored/archived):**
- `pianoid_middleware/*.py`: 8 markers across 4 files
- `pianoid_cuda/*.{cu,h}`: 6 markers across 5 files
- `pianoid_tunner/src/**/*.{js,jsx}`: 0 (clean)
- `PianoidBasic/Pianoid/*.py`: 8 markers across 4 files

| # | Category | File:Line | Severity | Description |
|---|----------|-----------|----------|-------------|
| 1 | TODO rot | `pianoid.py:136` & `198` | High | Two `############## TODO: TEMPORARY !!!!!!!!!!!!!!!!!!` markers — TEMPORARY hacks left in the synthesis orchestrator. CODE_QUALITY.md S5 names this exact pattern as an anti-pattern: "TODO comments that persist across commits — either fix it now or record it in WORK_IN_PROGRESS.md." Neither is in `WORK_IN_PROGRESS.md`. |
| 2 | TODO rot | `parameter_manager.py:245` | Medium | `hammer_params['verbose'] = True ############## TODO: DEBUG !!!!!!!!!!!!!!!!!!` — debug flag forced on every hammer-param update, in the canonical parameter pipeline. |
| 3 | Silent exception (S5) | `pianoid.py:255-256, 345-346, 352-353, 1591-1592, 1675-1676` | Medium | 5 instances of `except Exception: pass` in the synthesis orchestrator. Two are documented ("Stats unavailable after engine exit") but the others have no comment; impossible to know if they swallow real bugs. |
| 4 | Silent exception (S5) | `chartFunctions.py:1230-1231, 1348-1349, 1387-1388` | Medium | 3 bare `except: pass` in chart code. Only line 1230 is annotated ("Sound records not available (release build)"). |
| 5 | Silent exception (S5) | `modal_adapter.py:130-131, 464-465` | Medium | Two bare `except: pass` blocks inside the orchestrator. 464 is annotated ("Backward compatible: missing file = not applied"); 130 has no comment. |
| 6 | Silent exception (S5) | `band_merging.py:342` | Low | `except (ImportError, Exception): pass` — `Exception` is the parent of `ImportError`, so the tuple is redundant. Indicates copy/paste origin. |
| 7 | Dead branch | `usePreset.js:359, 387, 493` | Low | Three commented-out `/get_deck/feedin` / `/set_deck/feedin` / `/get_deck/feedback` axios calls. The endpoints don't exist on the backend; the comments describe endpoints that may never have shipped. |
| 8 | "TEMPORARY" hack survived | `pianoidMidiListener.py:77` | Medium | `############# TODO: DEBUG !!!!!!!!!!!!!!!!` in the legacy MIDI listener — combined with the file's "retained for YAML config" note in SYSTEM_OVERVIEW.md, this is an unowned debugging artefact in code that's already half-deprecated. |
| 9 | Test file in production module dir | `pianoid_middleware/test_audio_driver.py` (513), `test_backendserver_audio.py` (664), `test_gauss.py`, `StringBlock_test.py`, `FirFilterTest.py`, `runTests.py` | Low | Test files live alongside production middleware modules. The canonical test root is `PianoidCore/tests/`. These are not picked up by the normal pytest layout and several are imported at production startup (`chartFunctions.py:4` `from FirFilterTest import ...` ships test stubs into the production server). |

---

## 6. API Consistency Table

### 6.1 Endpoints with naming/casing/error-shape inconsistency

| # | Endpoint | Issue | Severity |
|---|----------|-------|----------|
| 1 | `POST /modal/apply_to_preset` (port 5000) **vs** `POST /modal/apply_to_preset` (port 5001) | Same path, different bodies. Port 5000 (`backendServer.py:2927`) accepts `{ project_name, selected_chains, merge }`. Port 5001 (`routes.py:853`) accepts `{ selected_modes, merge }`. The port-5001 handler reads `_get_pianoid()` which returns 503 in the modal-adapter role; port 5000 maintains its own `ModalAdapter()` rehydrated from disk. Frontend (`useModalAdapter.applyToPreset`) hits port 5000. The 503-returning shadow route on 5001 is dead in practice. | High |
| 2 | `GET /preset/list`, `POST /preset/load`, `POST /preset/switch`, `POST /preset/unload` (slash-segmented) **vs** `POST /set_runtime_parameters`, `POST /set_mode_parameters`, `POST /load_preset`, `POST /save_preset` (snake_case-flat) | Two grouping conventions on the same server. `preset/*` uses path segments; `*_preset`, `set_*`, `get_*` use underscore-flat. CODE_QUALITY.md N1: "API endpoints — lowercase with underscores." `/preset/list` violates that; `/preset/list` should be `/preset_list` or the entire surface should switch to slash-segmented. | Medium |
| 3 | `POST /set_string_excitation/<pitch_no>` (param in path) **vs** `POST /set_mode_parameters` (params in body) | Inconsistent parameterisation: pitch goes in URL for excitation/hammer/parameter routes but in body for mode/runtime/deck routes. | Low |
| 4 | `POST /calibration_curve` (no suffix) **vs** `POST /calibration_curve/flat`, `/calibration_curve/follow`, `/calibration_curve/apply`, `/calibration_curve/revert`, `/calibration_curve/save`, `/calibration_curve/load`, `/calibration_curve/rcm/{start,stop,status,capture,remove}` | The curve routes mix verb-noun ("save", "load", "apply") with subresource hierarchies ("rcm/start"). 13 endpoints under one prefix; pattern ad hoc. | Low |
| 5 | Modal blueprint endpoint `GET /modal/projects` (REST-flat) **vs** `POST /modal/projects/create`, `/modal/projects/open`, `/modal/projects/copy`, `/modal/projects/delete` (verb-after-noun) | Verb endpoints inconsistent with REST conventions. Acceptable internally but worth flagging for any future external API. | Low |
| 6 | Error envelopes | `routes.py:_error()` returns `{"error": <str>}` with HTTP code from `_classify_error`. `backendServer.py` routes return varied shapes: `{'error': msg}, 400`, `{'status': 'error', ...}, 500`, `{'message': '...'}, 503`. No shared error helper. | Medium |

### 6.2 Frontend → Backend signature mismatches / dead routes

| # | Frontend caller | Endpoint called | Backend status | Severity |
|---|----------------|-----------------|----------------|----------|
| 1 | `modules/Deck.jsx:139,150,161,172,182,200,211,226` | `/get_deck_feedin/{pitch}`, `/set_deck_feedin/{pitch}`, `/get_deck_feedin_for_mode/{mode}`, `/set_deck_feedin_for_mode/{mode}`, `/get_deck_feedback_for_mode/{mode}`, `/get_deck_feedback/{pitch}`, `/set_deck_feedback/{pitch}` | **NONE of these routes exist** in `backendServer.py`. The whole `modules/Deck.jsx` (772 LOC, YELLOW) is dead — only `App.js` imports it, and `App.js` is not the entry point (see Dead Code §1). | High (file dead, but masquerades as live) |
| 2 | `modules/StringModule.jsx:46,57` | `/get_deck_feedin/{val}`, `/set_deck_feedin/{val}` | Same — routes do not exist. File dead-coded via `App.js`. | High (same root cause) |
| 3 | `usePreset.js:359, 387, 493` | `/get_deck/feedin`, `/set_deck/feedin`, `/get_deck/feedback` (commented out) | Endpoints do not exist; commented code. | Low |
| 4 | `backendServer.py:1194` | `# @app.route('/get_chart', methods=['POST', 'GET'])` (commented out) | Dead route preserved as comment for ~25 LOC. | Low |
| 5 | `Excitation.jsx (components)`:65,97,121,171 | `/save_reference`, `/measure_rms`, `/equalize_keyboard`, `/tune_note` | All exist on backend. **However**, `components/Excitation.jsx` and `modules/Excitation.jsx` are TWO different files with different APIs both in src; only one is wired (PianoidTuner.js imports `components/Excitation`; `App.js` imports `modules/Excitation`). | Medium (both ship in build) |

---

## 7. Redundancy Clusters

### 7.1 Two `MeasurementEngine` classes

| File:Line | Class purpose | Used by |
|-----------|--------------|---------|
| `pianoid_middleware/auto_tuner.py:49` | offline render + pitch/volume measurement | `chartFunctions.py:2298` lazy import (only) |
| `pianoid_middleware/measurement_engine.py:46` | mic-based capture + clipping detection | `calibration_controller.py:47`, `synthesis_tuner.py:15`, `acoustic_tuner.py:12` |

Same class name, no shared base class, no shared interface. Either rename one (e.g., `OfflineRenderEngine`) or merge if they truly do the same thing.

### 7.2 Three tuner modules with overlapping concerns

| File | LOC | Job |
|------|-----|-----|
| `auto_tuner.py` | 609 | `FrequencyTuner`, `VolumeTuner`, `MeasurementEngine`, `TuningResults` (offline tuning) |
| `synthesis_tuner.py` | 549 | `SynthesisTuner` (offline synthesis-only volume calibration) |
| `acoustic_tuner.py` | 448 | `AcousticTuner` (mic-based acoustic calibration) |
| `calibration_controller.py` | 1305 | orchestrator delegating to the above + `MeasurementEngine` + `CurveManager` |

`calibration_controller.py` doc explicitly delegates to `synthesis_tuner` + `acoustic_tuner` + `measurement_engine` + `curve_manager` — the split is intentional. **However** `auto_tuner.py` is a separate parallel implementation with its own offline-tuning pipeline, used only by chart-generation code (not by `CalibrationController`). Two parallel approaches to "tune note volume" coexist.

### 7.3 Two `MeasureGenerator` classes

| File:Line | Status |
|-----------|--------|
| `pianoid_middleware/MeasureGenerator.py:81` | 291 LOC class — never imported |
| `pianoid_middleware/stringMapGenerator.py:326` | second `MeasureGenerator` in the same module as `StringMapGenerator` — never imported |

Both completely dead per Grep across all source dirs. See Dead Code §3.

### 7.4 `PianoidBasic/build/lib/Pianoid/` — stale wheel build copy

20 `.py` files duplicated under `PianoidBasic/build/lib/Pianoid/`, one per source file. Confirmed via diff that `Mode.py` and `StringMap.py` differ between `Pianoid/` and `build/lib/Pianoid/` — the build dir holds an older snapshot. `build/lib/` should not be tracked; it's a setup.py side-product. Naming variants (`StringMap.py:1` references and `build/lib/Pianoid/StringMap.py:1` references both surface in Grep).

### 7.5 Chart family scattered across 4 modules

| File | LOC | Role |
|------|-----|------|
| `chartFunctions.py` | 2612 | 36 chart functions (sound, spectrum, mode, deck, profiling, tuning) |
| `ChartRegistry.py` | 507 | `ChartType`, `ChartTypeRegistry`, `ChartArray`, `ChartParameter`, `ChartData` |
| `ChartGenerator.py` | unknown | `ChartGenerator`, `ActionPerformer` — imported by `pianoid.py` and `backendServer.py` |
| `chart_animation.py` (in PianoidBasic!) | 248 | matplotlib animation helpers — used by 6 domain model files |

Four modules, three layers, one concern. ChartRegistry is the type system; ChartGenerator wraps it; chartFunctions does the actual work; `chart_animation` is dragged in via the domain model. Cleanup candidate: consolidate chart concerns under one middleware module + drop `chart_animation` from PianoidBasic (move to a `tools/` script).

### 7.6 Frontend Excitation duplication

`components/Excitation.jsx` (629 LOC, YELLOW, growing) and `modules/Excitation.jsx` (545 LOC, YELLOW) are different React components both named `Excitation`. The components/ version is wired into `PianoidTuner.js`; the modules/ version is wired into the dead `App.js`. (See Dead Code §1.)

---

## 8. Dead Code

### 8.1 `App.js` and its dependency closure (~2000+ LOC of UI)

Entry point is `index.js` → `<PianoidTuner />`. `App.js` is never imported by `index.js` and is not in the React tree, but ships in the build. Files imported transitively by `App.js` and only by `App.js`:

| File | LOC | Status |
|------|-----|--------|
| `PianoidTunner/src/App.js` | ? | Dead root |
| `PianoidTunner/src/modules/Connection.jsx` | ? | Dead via App.js |
| `PianoidTunner/src/modules/Module.jsx` | ? | Dead via App.js |
| `PianoidTunner/src/modules/Excitation.jsx` | 545 | Dead via App.js |
| `PianoidTunner/src/modules/Deck.jsx` | 772 (YELLOW) | Dead via App.js — calls 8 nonexistent endpoints |
| `PianoidTunner/src/modules/StringModule.jsx` | ? | Dead via App.js — calls 2 nonexistent endpoints |
| `PianoidTunner/src/modules/MouseEventsExample.jsx` | ? | Demo, only referenced by itself |

Recommendation: confirm `App.js` is truly unused (it isn't in the React Router tree in `index.js`) and remove the entire chain.

### 8.2 `PianoidBasic/build/lib/`

Build artefact directory tracked in repo. 20 stale `.py` files. Should be in `.gitignore` and deleted from the working tree. (See §7.4.)

### 8.3 `pianoid_middleware/MeasureGenerator.py` (291 LOC) and the inner `MeasureGenerator` in `stringMapGenerator.py:326`

Neither is imported anywhere in the codebase per Grep. `stringMapGenerator.py` itself appears to also be unused — only mentioned in werkzeug reload logs. (`StringPack` and `StringMapGenerator` classes have no consumer.) Delete the file or move to `tools/`.

### 8.4 `TunePreset.py` (340 LOC)

Class `TunePreset` defined; no `from TunePreset import` or `import TunePreset` found in the codebase. The file's own TODOs at lines 54 and 82 ("NOT working", "New procedure to load from txt") suggest it's been parked for a while.

### 8.5 `pianoid_cuda_placeholder.py`

Imported only as a fallback in `pianoid.py:1756`: `import pianoid_cuda_placeholder as pianoidCuda`. The fallback exists for builds without CUDA — but in practice, the build system requires CUDA, and tests / production both import the real `pianoidCuda`. If the placeholder path is intended for CPU-only smoke tests, it should be documented as such; if not, it's S5 dead code.

### 8.6 `playNotes.py`, `runTests.py`, `test_gauss.py`, `pianoidMidiListener.py`

Mix of legacy / scratch / partially-used scripts in the production middleware directory. Per SYSTEM_OVERVIEW.md, `pianoidMidiListener.py` is "retained for YAML config / per-note CC handlers but not wired into the default startup path" — half-deprecated. `playNotes.py` and `runTests.py` are top-level scripts not used by the server.

### 8.7 Commented-out routes/imports

- `backendServer.py:1194` — `# @app.route('/get_chart', methods=['POST', 'GET'])` followed by ~25 commented LOC.
- `pianoid.py:13` — `# from chart_animation import *` (commented import).
- `usePreset.js:359, 387, 493` — three commented `/get_deck/*` axios calls.

### 8.8 Frontend demo / test components

| File | Status |
|------|--------|
| `components/GaussDemo.jsx` (333 LOC) | Reachable only via `/gauss-demo` Router route; not used in main UI |
| `components/TestChart.jsx` | Reachable only via `/chart-compare` Router route; not used in main UI |
| `components/NumInputTest.jsx` | Imported into `PianoidTuner.js` (line 47) but appears to be a developer harness |
| `dev/DrawableChartDemo.jsx` | Reachable only via `/drawable-demo` |
| `GaussTest.jsx` | Reachable nowhere (no Router entry) |

The `/gauss-demo`, `/chart-compare`, `/drawable-demo` routes are demo/dev sandboxes shipped to production. Either gate them behind a dev flag or move them to a separate dev-tools entry.

---

## 9. Structural Inconsistencies (naming, organization, patterns)

### 9.1 Naming violations

| # | Issue | Example | Severity |
|---|-------|---------|----------|
| 1 | Python file named in camelCase instead of snake_case (N1) | `pianoid_middleware/stringMapGenerator.py`, `pianoidMidiListener.py`, `chartFunctions.py`, `auto_tuner.py` (OK) vs `MeasureGenerator.py`, `ChartRegistry.py`, `ChartGenerator.py`, `MidiRecord.py`, `FirFilterTest.py`, `FirFilterFileIO.py`, `TunePreset.py`, `PanoidResult.py` (PascalCase Python files). N1 says snake_case. | Low–Medium |
| 2 | Typo in module name | `pianoid_middleware/PanoidResult.py` (should be `PianoidResult.py`) — the class inside is `PianoidResult`, but the file is `PanoidResult.py`. | Low |
| 3 | Domain-term synonym (N2) | `parameter_manager.py:79`: `'damper_tail': 'dump_coeff_tail'` — `dump_coeff` is a synonym for `damper_coefficient` / `damping_coefficient`. CODE_QUALITY explicitly calls this an N2 violation: "dump_ratio vs damping_ratio is a bug." Also surfaces in CUDA: `pianoid_cuda/Kernels.cu`, `MainKernel.cu`, `MainKernel.cuh`, `ParameterInfo.h`. | Medium |
| 4 | API endpoint case (N1) | "API endpoints — lowercase with underscores" — but `/preset/list`, `/preset/load`, `/preset/switch`, `/preset/unload` use slash-segmented; `/calibration_curve/rcm/start` mixes. | Low |
| 5 | Frontend hook file casing | `useApi.js`, `useBackendHealth.js` — fine. But components include a mix: `ContinuousPressButton.js`, `MatrixTable.js`, `ModesRule.js`, `RowEditor.js`, `ModeWaveChart.js`, `VirtualPiano.js` → these are React components but use `.js` not `.jsx`. Inconsistent with the project standard ("React components use `PascalCase.jsx`"). | Low |

### 9.2 Module organization

| # | Issue | Severity |
|---|-------|----------|
| 1 | Test files in production module directory: `pianoid_middleware/test_audio_driver.py`, `test_backendserver_audio.py`, `test_gauss.py`, `StringBlock_test.py`, `FirFilterTest.py`, `runTests.py`. Canonical test root is `PianoidCore/tests/`. Worse, **chartFunctions.py:4 imports from `FirFilterTest`** — the production server depends on a file that looks like a test. | Medium |
| 2 | Duplicate component name across directories: `components/Excitation.jsx` AND `modules/Excitation.jsx`. Same for `Hammers.jsx`/`HammerSpatialProperties.jsx` overlap. | Medium |
| 3 | `pianoid_middleware/_archive/` and `docs/archive/`, `docs/development/archive/`, `docs/development/logs/archive/` exist — the convention is fine, but `PianoidBasic/build/lib/` and stale `*_test.py` in production dirs are not archived. | Low |

### 9.3 Pattern divergence

| # | Issue | Severity |
|---|-------|----------|
| 1 | **Dataclasses vs ad-hoc dicts**: `parameter_manager.py:40 ParameterUpdateRequest` is a `@dataclass` with strict validation (`__post_init__`). `routes.py:42 DEFAULT_TRACKING_PARAMS` is a plain dict. `mode_tracking.py:65 TrackingConfig` is a `@dataclass`. `mapping.py:18 MappingConfig` is `@dataclass`. `chartFunctions.py` uses raw dicts everywhere. Inconsistent type discipline at module boundaries. | Medium |
| 2 | **Error envelope shapes** (see API §6.1 #6) — three or four shapes in `backendServer.py` alone; `routes.py` uses a unified `_error()` helper. backendServer should adopt the same helper. | Medium |
| 3 | **Two REST-call conventions in frontend**: most routes use `${PIANOID_URL}/...`; some (e.g. `components/Excitation.jsx:65,97,121,171`) hardcode `http://127.0.0.1:5000/...`. Hardcoded URLs break any deployment / port-override pathway. | Medium |
| 4 | **REST + WS dual surface** is asymmetric: 6 WS handlers (`set_parameter`, `set_string_excitation`, `set_hammer_shape`, `set_runtime_parameters`, `play`, `ping_ws`) shadow 6 of ~70 REST routes. The migration log ("WebSocket Migration — Hybrid REST + Socket.IO" in WORK_IN_PROGRESS.md) marks this complete but leaves all REST endpoints in place as fallback — that's intentional, but the partial coverage means the contract is "WS for these 6, REST for the rest" and is not enforced anywhere. | Low |

---

## 10. Categorized Punch List

### Critical
1. **Fix `App.js` ghost UI**: `App.js` is built and shipped but never mounted (entry is `index.js` → `PianoidTuner`). Remove `App.js`, its CSS, and its dead dependency closure (`modules/Connection.jsx`, `modules/Module.jsx`, `modules/Excitation.jsx`, `modules/Deck.jsx` (772 LOC YELLOW), `modules/StringModule.jsx`, `modules/MouseEventsExample.jsx`). This eliminates ~2000+ LOC of frontend including a YELLOW file, plus 10+ phantom REST calls to nonexistent endpoints.

### High
1. **`/modal/apply_to_preset` signature drift between port 5000 and port 5001** — same path, different request bodies (`selected_chains` vs `selected_modes`), different code paths, two parallel adapter instances. Pick one server, route the other to it explicitly (or delete the 5001 handler since it always returns 503 on this route).
2. **Two `MeasurementEngine` classes** (`auto_tuner.py:49` and `measurement_engine.py:46`) — rename one, or merge if they overlap.
3. **`backendServer.py` grew +159 LOC since baseline** (now 2990 LOC, almost 3000) and absorbed a 5th concern (modal-adapter relay). C4 regression. Plan a split: routes → `routes_calibration.py`, `routes_modal_relay.py`, `routes_preset.py`, `routes_calibration_curve.py`.
4. **`Pianoid.cu` grew +31 LOC since baseline** (2983 LOC). Same C4 regression — already had a known split plan in CODE_QUALITY.md. Any further edit must split.
5. **`pianoid.py` grew +59 LOC since baseline** (2547 LOC); same regression.
6. **`chartFunctions.py` calls engine lifecycle helpers** (`_stop_online_engine`, `_restart_online_engine`) — concern bleed. Move lifecycle into `pianoid.py` or into a dedicated `engine_lifecycle.py`.
7. **TODO TEMPORARY rot** in `pianoid.py:136, 198` — these are flagged as "TEMPORARY" but live in the synthesis orchestrator. Either fix them now or record them in WORK_IN_PROGRESS.md.
8. **Modal `ModalAdapter` god-class** (single class, 2628 LOC, 1 file). Plan a split by stage (load / esprit / tracking / feedin / mapping / apply) into 5–6 collaborator modules; the orchestrator class becomes ~400 LOC.
9. **PianoidBasic domain model imports matplotlib/seaborn/librosa** at top level — C1 layer violation. Move plotting helpers (`chart_animation.py`, `sound_measurements.py`) out of the wheel package into a separate dev/tools package, leaving `Pianoid` pure-Python.

### Medium
1. **Domain-term synonym** `dump_coeff_tail` for damping coefficient — N2 violation, should be `damping_coeff_tail`. Also touches CUDA (`Kernels.cu`, `MainKernel.cu`, `MainKernel.cuh`, `ParameterInfo.h`) — coordinated rename.
2. **`backendServer.py` error envelope inconsistency** — adopt the `routes.py:_error()` helper or extract a shared utility.
3. **Hardcoded `http://127.0.0.1:5000/...` URLs** in `components/Excitation.jsx` (4 sites). Use `PIANOID_URL` like the rest.
4. **Test files in production module directory** + `chartFunctions.py:4 from FirFilterTest import ...` — production code depends on a "test" file. Move `FirFilterTest`'s exported helpers (`filter_test`, `dummy_input`, `dummy_filter`) into a non-test module, then move all `*_test.py` / `test_*.py` to `PianoidCore/tests/`.
5. **`auto_tuner.py` parallel tuning pipeline** vs `synthesis_tuner.py` + `acoustic_tuner.py` + `calibration_controller.py` — confirm the auto_tuner path is still in active use by any shipped feature; if not, archive it.
6. **`PianoidBasic/build/lib/` checked into repo** — add to `.gitignore`, delete the directory.
7. **5 silent `except Exception: pass`** in `pianoid.py` — annotate or replace with named exception types.
8. **`usePreset.js` 3 commented-out `/get_deck/*` axios blocks** — delete or document.
9. **`/preset/*` slash-segmented vs `*_preset` underscore-flat endpoint convention** — pick one.

### Low
1. Duplicate `MeasureGenerator` class in `MeasureGenerator.py` and inside `stringMapGenerator.py:326` — both unreferenced; delete or relocate.
2. `TunePreset.py` (340 LOC) unreferenced; delete or relocate.
3. `pianoid_cuda_placeholder.py` fallback path — clarify intent or remove.
4. Frontend components named `*.js` instead of `*.jsx` (`ContinuousPressButton.js`, `MatrixTable.js`, `ModesRule.js`, `RowEditor.js`, `ModeWaveChart.js`, `VirtualPiano.js`) — N1 nit.
5. `PanoidResult.py` typo in filename — should be `PianoidResult.py`.
6. `band_merging.py:342` `except (ImportError, Exception): pass` redundant tuple.
7. `backendServer.py:1194` 25-line commented-out `/get_chart` block — delete.
8. Demo Router routes in `index.js` (`/gauss-demo`, `/chart-compare`, `/drawable-demo`) — gate behind dev flag or move to a separate dev-tools entry point.

---

## 11. Severity Summary

| Severity | Count |
|----------|------:|
| Critical | 1 |
| High     | 9 |
| Medium   | 9 |
| Low      | 8 |

---

## 12. Overall Health Score

| Dimension | Score | Note |
|-----------|------:|------|
| Architecture | 3/5 | Layer boundaries breached at 3 points (domain model + matplotlib, modal-relay on main server, chartFunctions calling engine lifecycle). Otherwise the 4-layer / dual-server split is well-modeled. |
| State Management | 4/5 | Authority is well-claimed for most state; the `apply_to_preset` dual-instance issue and the two `MeasurementEngine` collision drag this down. |
| Consistency | 2/5 | Endpoint naming, error envelopes, dataclass-vs-dict, file casing, REST-vs-WS surface — many inconsistencies. The `/preset/*` vs `set_preset` split alone is enough to flag this. |
| Performance Safety | 4/5 | Audio thread inviolability is documented and respected; `cuda_lock` discipline is mostly clean. No new threads, no new lock orderings introduced. |
| Documentation | 4/5 | docs/index.md is a good entry point and matches the codebase well. WORK_IN_PROGRESS.md is current and substantial. The "Current Known God Objects" baseline is exactly the right discipline. |

---

*Generated by `/review system` on 2026-04-27. Read-only audit; no code modified.*
