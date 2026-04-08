# Work in Progress

## NumInput Bidirectional Data Flow — Cursor Drift on Rapid Stepping

**Status:** Partially fixed. Core bidirectional issues resolved; cursor drift during rapid arrow/wheel remains.

Seven issues were fixed in `NumInput.js`, `PropertyInput.jsx`, and `usePreset.js` to stabilize the digital input components when connected to the live backend. The remaining open issue is cursor position drift during rapid arrow key or scroll wheel stepping — caused by React's controlled input pattern resetting the cursor on each render cycle.

See [DIGITAL_INPUT_ANALYSIS.md](DIGITAL_INPUT_ANALYSIS.md) for full root cause analysis, fixes applied, and potential solutions for the cursor drift.

**Branch:** `feature/fix-bidirectional-input` in PianoidTunner

---

## ~~Excitation API Mismatch — PianoidBasic Missing `pack_base_excitations()`~~ (Fixed)

**Status:** Complete. `StringMap.pack_base_excitations()` added to PianoidBasic, merged to dev. GPU-side interpolation verified by integration tests (`test_excitation_interpolation.py`).

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

## Parameter Routing Unification

**Status:** Complete.

All parameter modifications now route through `ParameterManager`. Dead code removed (`TunePreset.py`, `playPianoid.py`, `playNotes.py`, `update_physical_parameters()`). Broken `pitch_wheel` MIDI handler fixed. `/set_mode_parameters` and MIDI deck handlers routed through dispatcher/facade.

---

## Parameter Update Sleep Removal

**Status:** Future refactoring.

`parameter_manager.py` has `time.sleep(0.01)` after every bulk `setNew*Parameters()` call (hammer, mode, deck, excitation). The sleeps are a crude workaround for the `DROP_IF_BUSY` async policy — without them, consecutive updates can be silently dropped because `cudaMemcpyAsync` returns before the double-buffer swap completes.

All UI-driven parameter routes (REST endpoints, MIDI handlers) are designed to work during online playback. The bulk `setNew*` methods and their sleep workarounds may be obsolete — the granular `updateMultiStringParameter_NEW()` path (used by `update_pitch_params()`) already handles this correctly with explicit `waitForParameterUpdate()`.

**Refactoring options:**
- Replace sleeps with `waitForParameterUpdate()` calls
- Migrate all paths to the granular API
- Remove bulk methods if no longer needed

---

## Buffer Underrun Investigation

**Status:** Diagnostic tests implemented. Root cause identified. Fix not yet applied.

### Problem

With SDL3 audio enabled, ~12% of synthesis cycles show buffer phase times exceeding the 1.333ms real-time budget, causing audible underruns — despite GPU computation using only ~36% of the budget (mean 0.48ms).

### Root Cause

In `CircularBuffer.cu:105`, `produce()` releases its mutex **before** `cudaMemcpy`:

```
lock.unlock()           ← mutex released
cudaMemcpy(...)         ← ~0.5-1.3ms unprotected
cudaDeviceSynchronize()
write_position.store()  ← data visible only here
```

The SDL3 callback's `consume()` reads `write_position` atomically. During the `cudaMemcpy` window, the consumer sees stale `write_position` → empty buffer → underrun.

### Diagnostic Tests (done)

`TestBufferSynchronization` in `test_performance.py` instruments the issue:

- **test_buffer_underrun_diagnosis** — Proves GPU is fast while underruns occur. Prints per-phase timing breakdown and automatic root cause diagnosis.
- **test_callback_timing_regularity** — Measures SDL3 callback interval, jitter, and chunk coverage. Shows SDL3 batches ~7 chunks per callback at ~10ms intervals.

### Remaining Work

| Task | Status |
|------|--------|
| Diagnostic tests | Done |
| Root cause analysis | Done |
| Fix `produce()` lock scope in CircularBuffer.cu | Pending |
| Integration tests (test_cuda_bridge, test_offline_playback, etc.) | Planned |
| Unit tests (test_string_block, test_model_parameters, etc.) | Planned |

### Testing Plan Overview

The full 3-level testing system is being built top-down:

| Level | Directory | Scope | Status |
|-------|-----------|-------|--------|
| System | `tests/system/` | Full stack + audio hardware | 11/11 passing |
| Integration | `tests/integration/` | GPU, no audio | Planned |
| Unit | `tests/unit/` | Pure Python | Planned |

See [Testing](TESTING.md) for the implemented test inventory and usage.

---

## Modal Adapter Redesign — Independent Stages

**Status:** All 6 waves complete — untested (not yet verified in browser).

All backend (Waves 1-4) and frontend (Waves 5-6) implementation is done. The redesign replaces the sequential `AdapterState` enum with data-availability checks, adds per-section "Load Saved" buttons, a "Run Full Pipeline" button with Stepper progress, and data-driven section enablement. Pending browser verification.

See [MODAL_ADAPTER_REDESIGN_PLAN.md](MODAL_ADAPTER_REDESIGN_PLAN.md) for full plan and commit references.

| Wave | Scope | Commit | Status |
|------|-------|--------|--------|
| 1 | State machine removal + data checks + ModeChain reconstruction | `b4c7238` (PianoidCore) | Done |
| 2 | Measurement persistence + ESPRIT refactor + pipeline method | `e3378ca` (PianoidCore) | Done |
| 3 | Offline preset builder | `607a11c` (PianoidCore) | Done |
| 4 | New API endpoints (`data_status`, `run_pipeline`) | `8e6d4a5` (PianoidCore) | Done |
| 5 | Frontend hook (`useModalAdapter`) | `273b494` (PianoidTunner) | Done |
| 6 | Frontend UI (`ModalAdapter.jsx`) | `3f4ea58` (PianoidTunner) | Done |

---

## Playback System Known Issues

**Status:** Partially fixed.

### ~~play_mode() Blocking Sleep~~ (Fixed)

Replaced `time.sleep(length / 1000)` with cycle-aware polling via `CycleTimeEstimator`.
Falls back to sleep when no online engine is running. `TODO: DEBUG!!!!!!!` for mode
state management remains (separate issue).

### ~~Duplicate Stop Methods~~ (Fixed)

Consolidated into canonical `stop_playback()`. Legacy methods (`stop_pianoid()`,
`stop_unified_playback()`, `pause_playback()`) now delegate to it.

### ~~long_running_procedure() Dead Reference~~ (Fixed)

Updated to reference `_playback_thread` instead of `application_thread`.

### ~~Sleep Race Condition in stop_pianoid()~~ (Fixed)

Replaced `time.sleep(0.15)` with `_playback_thread.join(timeout=3.0)`.

### ~~RealTimeEventBuffer Double Mutex~~ (Fixed)

Consolidated to single lock scope in `pushEvent()` and `drainEventsUpTo()`.

### ~~PlaybackConfig.cycle_accurate Unused~~ (Fixed)

Removed field, pybind11 binding, and all Python set-sites.

---

## Playback System Analysis — Improvement Tracker

**Source:** `/analyse playback system` (2026-03-12)

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Three overlapping stop methods | Major | **Done** — canonical `stop_playback()`, legacy methods delegate |
| 2 | `stop_pianoid()` sleep race condition | Major | **Done** — `thread.join(timeout)` replaces `time.sleep()` |
| 3 | `long_running_procedure()` dead reference | Major | **Done** — `application_thread` → `_playback_thread` |
| 4 | MIDI→EventType mapping duplicated 3× | Major | **Done** — `midi_to_event_type()` helper, 4 sites consolidated |
| 5 | No CUDA error check in online engine | Minor | **Done** — `cudaGetLastError()` after `executeCycle()`, matches offline engine |
| 6 | `play_mode()` blocking sleep | Minor | **Done** — cycle-aware polling via `CycleTimeEstimator`, sleep fallback if no engine |
| 7-10 | Dead code cleanup (`processEventsAtTime`, `applyEvent`, `cycle_accurate`, debug printfs) | Minor | **Done** — removed dead methods, unused field, reduced printfs |
| 11 | Double mutex in `RealTimeEventBuffer` | Minor | **Done** — consolidated to single lock scope in `pushEvent()` and `drainEventsUpTo()` |
| 14 | No playback integration tests | Major | Pending |

---

## Microphone-Based Volume Equalization

**Status:** Implemented. 4-phase calibration system committed across all 3 repos.

### Architecture: Semi-Offline Calibration Mode

The engine loop stops but the audio driver stays alive. Python calls `executeSingleMeasurementCycle()` synchronously — exact cycle count, no timing races. Eliminates all `time.sleep` calls.

### 4-Phase Calibration Pipeline

| Phase | Status | Description |
|-------|--------|-------------|
| 1. Persistence | **Done** | Calibration data (perception curves, timing bands, level multipliers) saved/loaded from preset JSON via `_calibration_data` |
| 2. 6 velocity levels | **Done** | `POST /calibrate_volume` calibrates across all 6 base levels (`[0, 5, 31, 63, 95, 127]`) per pitch |
| 3. Level multipliers | **Done** | Per-velocity-level global scaling (6-element array), editable from CalibrationPanel UI |
| 4. ISO 226 curves | **Done** | Frequency-dependent perception compensation: low-freq boost + high-freq cut, editable via PerceptionCurveEditor |

### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `CalibrationController` | `PianoidCore/pianoid_middleware/calibration_controller.py` | Orchestrates measurement, correction, and persistence |
| `CalibrationPanel` | `PianoidTunner/src/components/CalibrationPanel.jsx` | Tabbed UI: perception curves, timing bands, level multipliers |
| `PerceptionCurveEditor` | `PianoidTunner/src/components/PerceptionCurveEditor.jsx` | Interactive drag editor for per-pitch correction weights |
| `TimingBandEditor` | `PianoidTunner/src/components/TimingBandEditor.jsx` | Editable frequency-dependent timing parameters |

### Algorithm

Bisection search on volume coefficient: bracket `[lo, hi]`, bisect to 0.2 dB tolerance, max 20 iterations. Constants: `BISECTION_TOLERANCE_DB = 0.2`, `BISECTION_MAX_ITERATIONS = 20`, `MEASURE_REPETITIONS = 1` (3 for internal workflows).

### Known Issues

| Issue | Status | Description |
|-------|--------|-------------|
| ~~Single velocity only~~ | **Fixed** | All 6 velocity levels calibrated in one pass |
| ~~No persistence~~ | **Fixed** | Corrections saved to preset JSON via `_calibration_data` |
| ~~Precision at low volume~~ | **Fixed** | Bisection algorithm converges reliably |

See [MIC_VOLUME_EQUALIZATION_PLAN.md](MIC_VOLUME_EQUALIZATION_PLAN.md) for the original design.
See [ACOUSTIC_MEASUREMENT_ANALYSIS.md](ACOUSTIC_MEASUREMENT_ANALYSIS.md) for the full system analysis (signal chain, algorithms, modal adapter, frontend).

---

## Modal Adapter Redesign — Independent Stages + Full Pipeline

**Status:** Planned. Not started.

Redesign the Modal Adapter panel from sequential-only execution to independent-stage execution with a full pipeline command. Each stage should be runnable individually using saved intermediate data from different sessions. A "Run Full Pipeline" command covers all steps from raw data to saved preset file (offline, no running engine required).

Key changes: replace `AdapterState` enum with data-availability checks, add ModeChain reconstruction from serialized data, persist measurement source path, add `build_preset_to_file()` for headless apply, per-section "Load Saved" buttons in UI.

See [MODAL_ADAPTER_REDESIGN_PLAN.md](MODAL_ADAPTER_REDESIGN_PLAN.md) for the full implementation plan.

---

## RoomResponse Modal Adapter Integration

**Status:** All 4 waves complete.

### Known Issues

| Issue | Severity | Root Cause | Status |
|-------|----------|------------|--------|
| Uniform feedin (all 1.0) | **Critical** | No FFT feedin extraction from measured IRs | **Fixed** — `feedin_extractor.py` extracts FFT magnitudes at mode frequencies |
| Sound output pitches zeroed (>= 128) | **Critical** | `preset_injector.py` skips pitch >= 128 | **Fixed** — explicit zero deck for output pitches, average sound coefficients; dynamic channel count (up to 16) |
| No MAC-based band merging | Major | `esprit_runner.py` uses frequency-only dedup | **Fixed** — uses `merge_multiband_results()` with MAC |
| No spatial mode tracking | Major | Global clustering instead of bridge-aware tracking | **Fixed** — `run_tracking()` calls `track_modes_along_bridge()` per bridge |
| No intermediate result persistence | Major | Long ESPRIT runs lost on crash | **Fixed** — auto-persist to `{project_dir}/modal_adapter/{stage}/` |
| Channel roles not configurable | Minor | Force/reference/response hardcoded | **Fixed** — `channel_roles` in `MappingConfig` |

### Rebuild Plan (4 waves)

Full pipeline: Load → ESPRIT Extract → Mode Tracking → Feedin Extraction → Channel Mapping → Apply. Panel-based UI (not wizard) with independent stage execution and auto-persisted intermediates.

| Wave | Scope | Key Deliverables | Status |
|------|-------|-----------------|--------|
| 1 | Backend core | `feedin_extractor.py` (new), rewrite `esprit_runner.py` to use `merge_multiband_results()` + `track_modes_along_bridge()`, channel roles in `mapping.py` | **Done** |
| 2 | State machine + fixes | Independent stages + persistence in `modal_adapter.py`, sound output bug fix in `preset_injector.py`, FFT feedin path (`apply_with_feedin`), 12 new REST endpoints (21 total) | **Done** |
| 3 | Frontend | Panel with collapsible sections (Accordion), stabilization diagram (ECharts scatter), mode shape along bridge, feedin heatmap, enhanced mode table with sort/filter, band preset selector, channel role assignment | **Done** |
| 4 | Integration test | End-to-end with Belarus data: 78 scenarios → ESPRIT → tracking → FFT feedin → preset → verify sound. Bug fix: feedin key-type mismatch in `preset_injector.py`. | **Done** |

Reference presets:
- `presets/IversPond_ESPRIT_128modes.json` (128 modes, base64 deck matrices)
- `presets/Belarus_ESPRIT_v2.json` (100 modes, uniform feedin — to be replaced)
- `presets/BaselineBelorus1.json` (196 modes, Belarus measured feedin, per-mode normalised)

See [MODAL_ADAPTER_PIPELINE_PLAN.md](MODAL_ADAPTER_PIPELINE_PLAN.md) for the full implementation plan.
See [ROOMRESPONSE_INTEGRATION_PLAN.md](ROOMRESPONSE_INTEGRATION_PLAN.md) for the original design.
See [ACOUSTIC_MEASUREMENT_ANALYSIS.md](ACOUSTIC_MEASUREMENT_ANALYSIS.md) for the acoustic measurement system analysis.

---

## note_playback Chart Auto-Normalization

**Status:** Pending fix.

The `note_playback` chart type produces misleading amplitude readings. `ChartData.create_audio()` in `ChartRegistry.py` (line 152) normalises the WAV audio to 0.8× peak amplitude before sending to the frontend:

```python
audio_data = audio_data / np.max(np.abs(audio_data)) * amplitude_scale
```

This means `note_playback` always appears loud regardless of actual synthesis output level. During the Belarus preset development, this masked a silent-output bug — `note_playback` reported max_amp=26213 while the ASIO real-time output was inaudible (mic measured -38 dB, synthesis_peak=1.8e-6).

The chart statistics (max, RMS) are computed from the raw buffer before normalisation, but the WAV audio IS normalised. This mismatch between displayed stats and audible output is confusing.

**Fix options:**
1. Report `synthesis_peak` (actual kernel output magnitude) alongside the chart stats
2. Add a warning when synthesis_peak is below a threshold (e.g. < 0.001)
3. Optionally disable auto-normalisation so the chart reflects true output level

---

## ASIO Driver Re-initialization Failure

**Status:** Pending fix.

**Problem:** After the ASIO callback driver is stopped (e.g. by offline `note_playback` chart or preset switch), re-initialization fails with "ASIO driver initialization failed — no working ASIO device found". All ASIO drivers on the system fail (UMC, Realtek, etc.), not just the previously used one. A fresh server start succeeds.

**Root cause:** `AsioAudioOutput::Close()` in `AsioAudioInterface.cpp` (line 615) calls `ASIOStop()`, `ASIODisposeBuffers()`, `ASIOExit()` but does not reset global state variables:

- `asioDriverInfo` — retains previous driver data
- `directOutputFn` — callback pointer still set (potential race with ASIO callback thread)
- `asioCallbacks` — stale callback table
- `queueToPlay` — circular buffer state lingers
- `asioDrivers` — COM singleton never destroyed/recreated

The `AsioDrivers` COM wrapper (global singleton, allocated with `new`, never deleted) holds stale COM references after `ASIOExit()`, causing all subsequent driver init attempts to fail.

**Fix:** Reset all globals in `Close()` and destroy/recreate the `AsioDrivers` singleton. Add `directOutputFn = nullptr` before `ASIOStop()` to prevent callback races. The destructor (`~AsioAudioOutput`) is empty and should call `Close()`.

**Workaround:** Restart the backend server between ASIO sessions.

---

## Sound Channel useEffect Feedback Loop

**Status:** Pending fix.

**Problem:** During normal online playback (no user editing), the frontend continuously sends `POST /set_parameter/sound_channel/null` and `POST /set_parameter/feedback/output` to the backend. This rewrites all output pitch (128–131) feedback values every 300ms and triggers full deck re-upload to GPU on each call.

**Root cause:** Two `useEffect` hooks in `PianoidTuner.js` (lines 1021–1038) fire whenever their history object's `mutedMatrix` changes:

```js
useEffect(() => {
    changeSoundChannelValues(scModesHistory.mutedMatrix, null, "sound_channel");
}, [scModesHistory.mutedMatrix]);

useEffect(() => {
    changeSoundChannelFeedback(scStringsHistory.mutedMatrix, null);
}, [scStringsHistory.mutedMatrix]);
```

Inside `changeSoundChannelValues` (`usePreset.js` line 225), `setSoundChannelData()` updates React state, which triggers the history object to update, which fires the `useEffect` dependency again — creating a loop. The 300ms debounce throttles but does not break the cycle.

Additionally, `pitch` is passed as `null`, producing the endpoint path `/set_parameter/sound_channel/null` which returns 416 (invalid key).

**Impact:** Continuous GPU deck re-uploads during playback; potential audio glitches; unnecessary backend load.

**Fix:** Break the feedback loop by either:
1. Guard the `useEffect` to only fire on user-initiated changes (not state-driven updates)
2. Use a ref to track whether the change originated from the backend fetch vs user edit
3. Compare previous and new `mutedMatrix` values and skip if unchanged
