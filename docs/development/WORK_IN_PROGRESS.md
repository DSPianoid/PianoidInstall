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

**Status:** Implemented but uncommitted. Precision investigation ongoing.

Acoustic volume equalization using microphone feedback. Required because exciter-soundboard output differs from the digital signal. The system has been significantly rewritten from the original plan.

### What Was Implemented (uncommitted across 3 repos)

**PianoidCore (~947 lines changed):**

- **Semi-offline calibration mode** — new C++ methods (`stopEngineKeepAudio`, `executeSingleMeasurementCycle`, `restartOnlineEngine`) plus `PlaybackConfig.keep_audio_on_stop` flag. The engine loop stops but the audio driver stays alive, enabling deterministic cycle-by-cycle synthesis from Python (no `time.sleep` timing).
- **`CalibrationController` rewrite** — replaced time-based waits with synchronous cycle execution:
  - `measure_single(pitch, velocity)` — single note measurement with frequency-dependent settling
  - `equalize_keyboard(reference_pitch, velocity)` — full keyboard equalization with noise-floor detection, correction, and iterative 3-pass verification (20% error threshold)
  - `tune_single(pitch, velocity, target_db)` — iterative single-note tuning to a target dB (1 dB tolerance, max 5 iterations)
- **Clipping protection** — Sint32 overflow guard before each measurement
- **3 new REST endpoints:** `POST /measure_rms`, `POST /equalize_keyboard`, `POST /tune_note` (plus `/calibration_status` and `/calibration_cancel`)
- **`parameter_manager.py`** — removed `_debug_extra_volume_arg` and old volume_coefficients upload path

**PianoidBasic:**

- Removed `volume_coefficient` from `PhysicalParameters.set_params`
- Deprecated `volume_coefficient` path in `Pitch.update_excitation`

**PianoidTunner (+233 lines in Excitation.jsx):**

- "Measure RMS" button with dB display
- Target dB input + "Tune Note" button
- "Equalize Keyboard" with progress polling and cancel support

### Architecture Change: Semi-Offline Mode

The original plan used online playback with `time.sleep` for timing. The implementation replaced this with a **semi-offline** approach:

1. `enter_calibration_mode()` stops the engine loop but keeps the audio driver alive
2. Python calls `executeSingleMeasurementCycle()` synchronously — exact cycle count, no timing races
3. `exit_calibration_mode()` restarts the online engine loop

This eliminates all `time.sleep` calls and makes measurements deterministic.

### Known Issues (from user testing)

| Issue | Status | Description |
|-------|--------|-------------|
| ~~Precision at low volume~~ | **Fixed** | Bisection algorithm converges reliably at all volume levels |
| ~~Non-linear volume curve~~ | **Fixed** | Bisection exploits monotonicity without assuming linearity |
| ~~Outlier rejection disabled~~ | **Fixed** | `MEASURE_REPETITIONS = 3` — median filtering now active |
| Single velocity only | Open | Only one velocity level supported per session; plan calls for all 5 levels |
| No persistence | Open | Corrections are not saved to the preset file — lost on restart |

### Algorithm Change: Linear Correction to Bisection

The original `tune_single` and `equalize_keyboard` Phase 3 used linear dB correction (`10^(error/20)`) which assumed the volume-to-multiplier relationship was linear in dB. This caused oscillation and overshoot, especially at low volume levels.

Replaced with `_bisect_to_target()` — a bisection search on the volume coefficient:

1. Measure at current coefficient
2. Establish a bracket `[lo, hi]` where measured dB straddles the target (exponential probing with factor 4x)
3. Bisect: midpoint coefficient, measure, narrow bracket
4. Converge to 0.2 dB tolerance (was 1.0 dB) within max 20 iterations

Key constants: `BISECTION_TOLERANCE_DB = 0.2`, `BISECTION_MAX_ITERATIONS = 20`, `MEASURE_REPETITIONS = 3`.

### Next Steps

- Implement all 5 velocity levels in a single calibration pass
- Persist corrections to preset JSON

See [MIC_VOLUME_EQUALIZATION_PLAN.md](MIC_VOLUME_EQUALIZATION_PLAN.md) for the original design and current implementation details.
