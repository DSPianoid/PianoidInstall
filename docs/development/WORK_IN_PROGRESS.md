# Work in Progress

## Active Dev Sessions

| Agent | Task | Log | Started |
|-------|------|-----|---------|
| dev-b3ba | Display chain properties (freq, damping) on selection in stabilization diagram | [log](logs/dev-b3ba-2026-04-14-155749.md) | 2026-04-14 |

---

## WebSocket Migration — Hybrid REST + Socket.IO

**Status:** Complete. Merged and pushed (2026-04-11). All 4 phases shipped.

Flask-SocketIO backend + socket.io-client frontend. Note playback via WebSocket with REST fallback, lifecycle push events (replace health polling), calibration progress push, MIDI playback push, engine error push, **parameter updates via WebSocket** (all 8 debounced write paths: string, mode, excitation, feedin, feedback, sound channel, volume, deck feedback). Debounce reduced from 300ms to 50ms when WS connected. `param_ack` events returned to client. Independent fixes: print() gated behind PIANOID_DEBUG_PLAY env var, deduplication added to unified play path, `_map_feedback_to_coefficient()` helper extracted.

Tests: 30/30 pass (20 unit in `test_websocket.py`, 10 integration in `test_websocket_integration.py`).

See [WEBSOCKET_MIGRATION_ANALYSIS.md](WEBSOCKET_MIGRATION_ANALYSIS.md) for full analysis and implementation details.

---

## Preset System Revision — Per-Preset Runtime State & Complete Switch

**Status:** Planned. Implementation pending.

Volume and feedback are global runtime parameters that persist across preset switches — switching from a loud preset A to quiet B and back loses A's volume/feedback settings. Additionally, available notes are not refreshed after switch (stale keyboard), the frontend MIDI feedback slider position is lost (lossy reverse mapping from coefficient), and rapid `[`/`]` key presses can interleave switch requests.

The fix adds a `runtime` dict to each `_library_models[name]` entry (backend-authoritative), saves/restores `RuntimeParameters` during `switch_preset()`, enriches the `/preset/switch` response with volume/feedback/sensitivity values, and updates the frontend to consume these values and refresh available notes.

See [PRESET_SYSTEM_REVISION_PLAN.md](PRESET_SYSTEM_REVISION_PLAN.md) for full analysis, architecture decision, implementation steps, data flow, edge cases, and verification checklist.

**Files to modify:**
- `PianoidCore/pianoid_middleware/pianoid.py` — `switch_preset()`, `load_preset_to_library()`, `init_pianoid()`, new helpers
- `PianoidCore/pianoid_middleware/backendServer.py` — `/preset/switch` response, `/set_runtime_parameters` sync
- `PianoidTunner/src/hooks/usePreset.js` — `switchPreset()` consume runtime state, add `getAvailableNotes()`, concurrency guard

---

## NumInput Bidirectional Data Flow — Cursor Drift on Rapid Stepping

**Status:** Partially fixed. Core bidirectional issues resolved; cursor drift during rapid arrow/wheel remains.

Seven issues were fixed in `NumInput.js`, `PropertyInput.jsx`, and `usePreset.js` to stabilize the digital input components when connected to the live backend. The remaining open issue is cursor position drift during rapid arrow key or scroll wheel stepping — caused by React's controlled input pattern resetting the cursor on each render cycle.

See [DIGITAL_INPUT_ANALYSIS.md](DIGITAL_INPUT_ANALYSIS.md) for full root cause analysis, fixes applied, and potential solutions for the cursor drift.

**Branch:** `feature/fix-bidirectional-input` in PianoidTunner

---

## C++ Logging Migration

**Status:** Session 1 complete. Remaining files pending.

Replaced all `printf`/`cout`/`cerr` in hot-path and core C++ files with `PianoidLogger` file-based logging. Three hot-path statements fixed (cycle-level `std::cout` in `Pianoid.cu`, per-callback `printf` in `SDL3AudioDriver.cpp`, warmup `cout` in `CycleTimeEstimator.cu`).

See [LOGGING.md](../modules/pianoid-cuda/LOGGING.md) for full details and migration status.

| Scope | Status |
|-------|--------|
| PianoidLogger infrastructure | Done |
| Hot-path fixes (3 locations) | Done |
| Core C++ files (~175 statements in 8 files) | Done |
| pybind11 bindings + Python lifecycle | Done |
| Remaining C++ files (~75 statements) | Pending |
| Python print migration (578 statements) | Planned |

---

## Parameter Update Sleep Removal

**Status:** Future refactoring.

`parameter_manager.py` has `time.sleep(0.01)` after every bulk `setNew*Parameters()` call (hammer, mode, deck, excitation). The sleeps are a crude workaround for the `DROP_IF_BUSY` async policy — without them, consecutive updates can be silently dropped because `cudaMemcpyAsync` returns before the double-buffer swap completes.

**Refactoring options:**
- Replace sleeps with `waitForParameterUpdate()` calls
- Migrate all paths to the granular API
- Remove bulk methods if no longer needed

---

## Buffer Underrun Investigation

**Status:** Diagnostic tests implemented. Root cause identified. Fix not yet applied.

In `CircularBuffer.cu:105`, `produce()` releases its mutex **before** `cudaMemcpy`, creating a ~0.5–1.3ms window where the SDL3 callback's `consume()` sees stale `write_position` → empty buffer → underrun. ~12% of synthesis cycles exceed the 1.333ms real-time budget despite GPU using only ~36%.

| Task | Status |
|------|--------|
| Diagnostic tests | Done |
| Root cause analysis | Done |
| Fix `produce()` lock scope in CircularBuffer.cu | Pending |

See [Testing](TESTING.md) for the test inventory.

---

## Interactive Stabilization Diagram — Chain Editing & Visualization

**Status:** All phases complete (Phase 1–5) + UI refactoring (2026-04-11).

See [INTERACTIVE_STABILIZATION_DIAGRAM_PLAN.md](INTERACTIVE_STABILIZATION_DIAGRAM_PLAN.md) for full architecture decisions, 5-phase implementation plan, and risk analysis.

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Zoom/pan, brush selection, chain paths, bidirectional sync, visual encoding, damping toggle | Done |
| 2 | `save_edited_chains()` + `POST /modal/chains/save` | Done |
| 3 | `useChainEditor` hook + `StabilizationToolbar` + `StabilizationDiagram` extraction + `saveEditedChains` in useModalAdapter | Done |
| 4 | Interactive chart editing (mode-dependent handlers) | Done |
| 5 | Polish: unassigned detections, keyboard shortcuts, validation, performance, feedin guard | Done |
| Refactor | ESPRIT-only view, chain toggle fix, selection highlighting, rectangle zoom, damping/amplitude viz | Done |

**Refactoring changes (2026-04-11):**
- Diagram shows ESPRIT extraction data (unassigned dots) even before tracking runs
- Chain path toggle (showPaths) fixed — no longer sticks in "on" state
- Chain selection: default no selection; selected chains have white border + blue glow + larger size; unselect clears all visual emphasis
- Rectangle zoom: brush selection in select mode zooms to area; "Reset Zoom" button restores full view
- Damping overlay removed. Replaced with: (1) heatmap mode (D/A buttons) color-codes points by damping or amplitude, (2) sub-chart below main chart (Damp/Amp/Both) showing line charts for selected chains sharing X-axis

**Sub-chart data fix (2026-04-12):**
- Amplitude/shape/MAC sub-charts showed empty when loading existing projects (chains.json lacked amplitude/shape data saved before the feature was added)
- Fix: `_enrich_chains_from_esprit()` in `modal_adapter.py` back-fills amplitude and shape from ESPRIT per_scenario_results into chain detections on load, then persists enriched chains to disk

**Reference projection sub-chart (2026-04-12):**
- New "Proj" toggle button alongside Damp/Amp/MAC/Shape
- Computes signed reference projection from complex mode shapes in frontend: mean shape as reference, Re(dot(shape, conj(ref))) per detection
- X=scenario (zoom-synced with main diagram), Y=signed scalar (+in-phase / -anti-phase)
- Zero reference line marks nodal boundary, area fill highlights positive/negative regions

**Selected chain properties display (2026-04-14):**
- When chains are selected, MUI Chips appear above the main chart showing per-chain: ID, mean frequency (Hz), mean damping ratio, scenario count
- Chips bordered by stability color (green/yellow/orange/grey) for quick identification
- Compact and non-intrusive — wraps across multiple rows when many chains selected

**Visualization enhancements (2026-04-14):**
- Bridge boundary: replaced inaccurate graphic percentage line with ECharts markLine at exact scenario index, tracks zoom/pan, "Bass | Treble" label
- Chain visibility filter: ToggleButtonGroup (Stable / +Semi / All / Unasgn) filters chains by stability class; "Unasgn" hides all chains and shows only orphan detections (larger, orange)
- Chain paths visible by default (`showPaths` initialized to `true`)
- Chain selection fix: brush tool was intercepting clicks before scatter handler; tiny brush areas now detected and converted to click-select via `findNearestChain`
- Full-bridge chains (`bridge="full"`): path lines split at `bridgeBoundary` to show natural gap between bass/treble sections
- Interactive shape sub-chart: clicking selects ALL lines crossing the click area (5% Y-range tolerance), not just the single clicked line; all corresponding points highlighted on main chart (white diamond, orange glow); non-matching shape lines dim; toggleable
- Zoom fixes: brush rectangle artifact cleared via brush tool toggle off/on; reset zoom also dispatches `dataZoom` reset to 0-100% on both axes
- Shape phase alignment: scenario shapes normalized to consistent phase before display — dot product with reference shape determines sign flip, so shapes from different scenarios are visually comparable

---

## Modal Adapter Redesign — Phase 1 + Phase 2 + Phase 3

**Status:** All implementation complete (2026-04-06 to 2026-04-09). Browser verification pending.

See [MODAL_ADAPTER_REDESIGN_PLAN.md](MODAL_ADAPTER_REDESIGN_PLAN.md) for full plan, commit references, and architecture details.

### Phase 1: Independent Stages + Full Pipeline (6 waves)

Replaces sequential `AdapterState` enum with data-availability checks, per-section "Load Saved" buttons, "Run Full Pipeline" with Stepper progress.

| Wave | Scope | Status |
|------|-------|--------|
| 1 | State machine removal + data checks + ModeChain reconstruction | Done |
| 2 | Measurement persistence + ESPRIT refactor + pipeline method | Done |
| 3 | Offline preset builder (`build_preset_to_file`) | Done |
| 4 | New API endpoints (`GET /modal/data_status`, `POST /modal/run_pipeline`) | Done |
| 5 | Frontend hook (`useModalAdapter` — `dataStatus`, `canRun*` flags, `runPipeline`, `loadIntermediate`) | Done |
| 6 | Frontend UI (`ModalAdapter.jsx` — data-driven enablement, pipeline controls) | Done |

### Phase 2: Server Separation, Projects & UI Overhaul (2026-04-08/09)

| Feature | Commits | Status |
|---------|---------|--------|
| Separate modal adapter server (port 5001, `threaded=False`) | `8fd1226` | Done |
| Project management system (7 CRUD endpoints, project.json storage) | `8fd1226` | Done |
| Synthesis pause/resume (`/pause_synthesis`, `/resume_synthesis`) | `8fd1226` | Done |
| ESPRIT fixes (`_resolve_bands`, null `window_length`, numpy serialization) | `8fd1226` | Done |
| FolderBrowser component (native OS folder picker via tkinter) | `2e55e80` | Done |
| Frontend tab UI (Project/ESPRIT/Tracking/Apply replacing accordions) | `020dbd7` | Done (superseded by Phase 3 toolbar) |
| Per-scenario ESPRIT with checkbox selection + shift-click | `020dbd7` | Done |
| EspritConfig simplification (GPU checkbox + advanced toggle) | `020dbd7` | Done |
| Dual-process launcher (port 5000 + 5001 management) | `020dbd7` | Done |

### Phase 3: Toolbar UI (2026-04-09)

Replaced tab navigation with a compact single-row toolbar: server status chip, project button, pipeline ButtonGroup (ESPRIT/Tracking/Apply with checkmark/spinner status), gear icon for collapsible context-sensitive settings, and play/skip-next buttons (with stop when running). Settings and run buttons removed from section bodies.

| Feature | Status |
|---------|--------|
| Toolbar with pipeline ButtonGroup | Done |
| Server status chip (On/Off, clickable) | Done |
| Project button with name + checkmark | Done (merged into Setup button) |
| Context-sensitive settings panel (gear toggle) | Done |
| Play (run step) + SkipNext (run to end) buttons | Done |
| Stop button overlay when running | Done |

### Phase 4: Merged Setup Panel + Settings Freeze (2026-04-12)

Merged Project and ESPRIT into a unified "Setup" section. Channel roles and ESPRIT config moved to settings/gear panel. All settings freeze (disabled + lock icon) once ESPRIT processing starts.

| Feature | Status |
|---------|--------|
| Merge Project + ESPRIT into unified Setup section | Done |
| Channel roles in settings/gear panel (not section body) | Done |
| ESPRIT config in settings/gear panel alongside channel roles | Done |
| Settings freeze when ESPRIT starts (running or done) | Done |
| Lock icon replaces gear icon when frozen | Done |
| Project creation/import/copy/delete hidden when frozen | Done |
| Setup button shows project name | Done |

### State Management Rewrite (2026-04-13)

Phased elimination of split-brain state between frontend and backend.

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Backend `GET /modal/project_state` endpoint | Done |
| 2 | Backend `DEFAULT_CONFIG.preset` → `extended_8band` | Done |
| 3 | Frontend `mappingDirty` tracking for explicit save | Done |
| 4 | Frontend `syncFromBackend()` — single state sync function | Done |
| 5 | Frontend cleanup — dead code, state consolidation, log path fix | Done |

Phase 4 replaced ~200 lines of ad-hoc state restoration across `openProject`, `createProject`, `copyProject`, mount effect, and `addMeasurementsToProject` with a single `syncFromBackend()` function. Every mutation now calls `syncFromBackend()` after success. Removed dead `applyConfig`/`setConfigPreset` (endpoint deleted in Phase 1).

Phase 5 cleanup: removed `onPresetSelect` dead prop from EspritConfig, removed band-preset retry-polling (fetch once on mount instead), consolidated 4 project-related useState calls into grouped `project` state object, removed unused `pct` variable in importProject upload handler, fixed hardcoded log path in modal_adapter `__init__.py` to use system temp directory.

### Remaining

- Browser verification of all Phase 1 + Phase 2 + Phase 3 + Phase 4 features
- Browser verification of state management rewrite (project open/create/copy, ESPRIT run, state persistence)
- Independent-stage loading, full pipeline execution, backward compatibility
- Project CRUD workflow, toolbar navigation, per-scenario ESPRIT UI

---

## Extended 8-Band Pipeline Run (2026-04-07/08)

**Status:** ESPRIT + tracking + feedin complete. Preset built, not yet volume-matched.

The `extended_8band_medium` pipeline completed all stages on Belarus piano data:
- **ESPRIT:** 78/78 scenarios, 8210 raw modes, ~56 sec/scenario, ~72 min total
- **Tracking:** 441 chains (210 stable, 133 semi-stable, 64 weak, 34 spurious)
- **Feedin:** 88 pitches (78 measured + 10 interpolated), 441 mode frequencies

A 196-mode preset (`Belarus_8band_196modes.json`) was built from the top 196 stable modes with per-mode normalized feedin (0–1 range) and per-channel output pitch feedback. The preset produces sound but is quieter than BaselineBelorus1 at higher pitches — likely due to different modal content between 4-band and 8-band extractions.

Data: `D:/tmp/belarus_78_extended_8band_medium/`

See [EXTENDED_8BAND_PIPELINE_REPORT.md](EXTENDED_8BAND_PIPELINE_REPORT.md) and [BELARUS_PIPELINE_RUN_REPORT.md](BELARUS_PIPELINE_RUN_REPORT.md) for run details.

Reference presets:
- `presets/BaselineBelorus1.json` (196 modes, 4-band, per-mode normalised feedin)
- `presets/Belarus_8band_196modes.json` (196 modes, 8-band medium, per-mode normalised feedin)
- `presets/Belarus_ESPRIT_v2.json` (100 modes, uniform feedin — legacy)

---

## note_playback Chart Auto-Normalization

**Status:** Pending fix.

`ChartData.create_audio()` in `ChartRegistry.py` normalises the WAV audio to 0.8× peak before sending to the frontend, masking silent-output bugs. The chart statistics (max, RMS) are from the raw buffer before normalisation, but the WAV IS normalised. During Belarus preset development, this masked a silent-output bug.

**Fix options:**
1. Report `synthesis_peak` (actual kernel output magnitude) alongside chart stats
2. Add a warning when synthesis_peak is below a threshold
3. Optionally disable auto-normalisation

---

## ASIO Driver Re-initialization Failure

**Status:** Pending fix.

After ASIO callback driver is stopped, re-initialization fails with "no working ASIO device found". Root cause: `AsioAudioOutput::Close()` in `AsioAudioInterface.cpp` doesn't reset global state variables (`asioDriverInfo`, `directOutputFn`, `asioCallbacks`, `queueToPlay`) and the `AsioDrivers` COM singleton is never destroyed/recreated.

**Workaround:** Restart the backend server between ASIO sessions.

---

## Completed Items (archived)

| Item | Status | Notes |
|------|--------|-------|
| Excitation API Mismatch | Fixed | `StringMap.pack_base_excitations()` added to PianoidBasic |
| Parameter Routing Unification | Complete | All routes through `ParameterManager` |
| Playback System Fixes | Complete | 11/14 findings fixed (see tracker below) |
| Microphone-Based Volume Equalization | Implemented | 4-phase calibration across all 3 repos |
| RoomResponse Modal Adapter Integration | Complete | All 4 waves, 6 critical bugs fixed |
| Sound Channel useEffect Feedback Loop | Fixed | Restored init-once guards with `scDataRefresh` flag |
| Second Derivative Sound Output | Resolved | Kernel-level 2nd derivative implemented |

### Playback System — Improvement Tracker

| # | Finding | Status |
|---|---------|--------|
| 1 | Three overlapping stop methods | **Done** |
| 2 | `stop_pianoid()` sleep race condition | **Done** |
| 3 | `long_running_procedure()` dead reference | **Done** |
| 4 | MIDI→EventType mapping duplicated 3× | **Done** |
| 5 | No CUDA error check in online engine | **Done** |
| 6 | `play_mode()` blocking sleep | **Done** |
| 7-10 | Dead code cleanup | **Done** |
| 11 | Double mutex in `RealTimeEventBuffer` | **Done** |
| 14 | No playback integration tests | Pending |
