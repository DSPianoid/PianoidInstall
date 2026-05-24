# Debug Data Extraction

GPU state extraction and the Python `PianoidResult` wrapper for debug visualization, charting, and analysis.

---

## Overview

The synthesis kernel writes intermediate results into GPU buffers every cycle. C++ methods perform device-to-host (D2H) copies on demand. The Python `PianoidResult` class reshapes the flat vectors into NumPy arrays for chart functions and analysis tooling.

```
MainKernel (GPU)
  │ writes per-cycle data to dev_* buffers
  ▼
Pianoid C++ methods (D2H copy)
  │ getPianoidState(), getOutputData(), getSoundRecords(), ...
  │ Returns std::vector<real/float>
  ▼
PianoidResult (Python)
  │ Reshapes into NumPy arrays
  │ self.string_states, self.output_data, self.sound, ...
  ▼
Chart Functions / Tests
  │ Access via pianoid.result.*
  ▼
Frontend (JSON + base64 audio)
```

---

## Compile Guard

A single preprocessor flag controls all debug data extraction. It is **not** defined
in `constants.h` — instead, `setup.py` passes `-DPIANOID_DEBUG_DATA` only when
building the **debug** variant (`PIANOID_BUILD_VARIANT=debug`).

| Flag | Layer | Effect | When active |
|------|-------|--------|-------------|
| `PIANOID_DEBUG_DATA` | Kernel + Host | **Kernel:** enables `recordOutputData()` writes to `dev_output_data` (records 0–9), `dev_sound_records`, `dev_string_state`. **Host:** enables D2H copies in `getPianoidState()`, `getOutputData()`, `getParameters()`, `getSoundRecords()` | Debug variant only (`pianoidCuda_debug`) |

To use the debug variant at runtime, set `PIANOID_USE_DEBUG=1` or pass
`use_debug_build=True` to `initialize_pianoid()`. See
[BUILD_SYSTEM.md](../../architecture/BUILD_SYSTEM.md#build-variants-debug--release)
for build commands.

**Design rationale:** Writing intermediate results to GPU global memory during synthesis is expensive and should be avoided in production deployments. Disabling `PIANOID_DEBUG_DATA` has three effects:

1. **Kernel:** removes all debug writes from the synthesis kernel
2. **Host:** D2H extraction methods return zero-filled vectors
3. **Memory:** debug buffers are not allocated (~113 MB saved), registered under `DEBUG_OUTPUT` category

**What is always active (regardless of flag):**

- Audio buffers (`dev_soundFloat`, `dev_soundInt`) — production audio path, `OUTPUT` category
- Mode state (`dev_mode_state`) — readable via `getModeDisplacements()`, used at runtime
- String state to `string_state` buffer (when `*status > 0`) — simulation state, `OUTPUT` category
- NaN detection in the main loop — always-on, negligible cost, catches corruption early

**What requires `PIANOID_DEBUG_DATA`:**

- GPU buffer allocation: `dev_output_data`, `dev_sound_records_ms`, `dev_sound_records` (`DEBUG_OUTPUT` category)
- Kernel writes: output\_data records 0–9, sound\_records, string\_state snapshots
- Host D2H copies: `getOutputData()`, `getParameters()`, `getSoundRecords()` (note: `getPianoidState()` is now always active)
- Per-cycle operations: `dev_output_data` memset (debug-only kernel writes)

---

## C++ Extraction API

### Audio Extraction

| Method | Returns | Source Buffer | Notes |
|--------|---------|---------------|-------|
| `getRawSoundRecord()` | `vector<float>` | `rawSoundBuffer` (host circular buffer) | Always active. Returns last 5 seconds of audio in chronological order |
| `getRecordedAudio()` | `vector<float>` | `last_recorded_audio_` (host) | Audio from last completed playback session (online or offline) |
| `getCurrentCycleAudio()` | `vector<float>` (mode_iteration samples) | `dev_soundFloat` or `dev_soundInt` (GPU) | Single cycle. Auto-converts int32→float via `/ INT32_MAX` |

**Raw sound recording** uses a fixed circular buffer (`5 * sample_rate * num_channels` floats) that is always active — no enable/disable toggle. Each cycle writes directly into the buffer via `cudaMemcpy` (no intermediate allocation, no `cudaDeviceSynchronize`). `clearRecords()` resets the buffer.

### State Extraction

| Method | Returns | Size | Source Buffer | Guard |
|--------|---------|------|---------------|-------|
| `getPianoidState()` | `vector<real>` | 2 × total_points | `dev_string_state` | Always |
| `getModeDisplacements()` | `vector<real>` | num_modes × 5 | `dev_mode_running` (q, q_prev) + `dev_mode_state` (dec, omega, mass_inv) | Always |
| `getStringStabilityRatios()` | `vector<real>` | num_strings | `dev_string_stability_ratio` | Always |
| `getStringStableFlags()` | `vector<int>` | num_strings | `dev_string_stable_flag` | Always |
| `getOutputData()` | `vector<real>` | 10 × num_strings × array_size | `dev_output_data` | `PIANOID_DEBUG_DATA` |
| `getParameters()` | `vector<real>` | total_points × POINT_PARAMETERS_NO | `dev_parameters` | `PIANOID_DEBUG_DATA` |
| `fetchExcitation(stringNo, cycleIdx)` | `vector<real>` | total_steps [× EXCITATION_FACTOR] | `dev_force_function` | Always |
| `getSoundRecords(length)` | `vector<real>` | length × mode_iteration × num_strings × 4 | `dev_sound_records` | `PIANOID_DEBUG_DATA` |

**`fetchExcitation`** supports two modes:
- `cycleIdx >= 0` — returns a single excitation cycle (`total_steps` reals)
- `cycleIdx == -1` — returns all cycles concatenated (`total_steps × EXCITATION_FACTOR` reals)

### Buffer Management

| Method | Effect |
|--------|--------|
| `clearRecords()` | Resets `sound_record_index` to 0 and clears the raw sound circular buffer |

### Per-Cycle Recording (called from `Pianoid::runCycle`)

| Method | What it does |
|--------|-------------|
| `appendCycleAudioToHostBuffer()` | D2H copy from `dev_soundFloat` → writes to `rawSoundBuffer` (5-second circular host ring) at current position. Called from the Online regime when `record_to_host == true`. |

The `dev_sound_records` archival path was reinstated in C2 (dev-568e,
`77479ea`, 2026-04-20) — the `copyKernel<<<>>>(dev_sound_records_ms, 0,
dev_sound_records, ...)` plus `sound_record_index++` now runs inline in
`Pianoid::runCycle` behind `#ifdef PIANOID_DEBUG_DATA`. Release builds skip
this entirely. Debug builds once again populate the long-form
`dev_sound_records` buffer for debug-data chart extraction.

---

## Output Data Records

The `dev_output_data` buffer contains `NUM_OUTPUT_RECORDS` (10) records, each of size `num_strings × array_size`. All records require `PIANOID_DEBUG_DATA`. Constants defined in `constants.h`.

| Constant | Index | Content | Written When | Index Domain |
|----------|-------|---------|-------------|--------------|
| `OUTPUT_REC_STRING_SHAPE` | 0 | String displacement `s_a[point]` | Error path only | Spatial (point position) |
| `OUTPUT_REC_STRING_PREV` | 1 | Previous string state `s_b` | Error path only | Spatial |
| `OUTPUT_REC_STRING_ID` | 2 | String identification tag | Always (debug) | Spatial |
| `OUTPUT_REC_HAMMER_FORCE` | 3 | Spatial hammer force distribution `coeff_force` | Pre-loop | Spatial |
| `OUTPUT_REC_MODE_FEEDIN` | 4 | Feedin coefficients `mode_feedin[string, mode]` | Pre-loop | Mode index |
| `OUTPUT_REC_MODE_FEEDBACK` | 5 | Feedback coefficients `mode_feedback[string, mode]` | Pre-loop | Mode index |
| `OUTPUT_REC_FEEDIN_MATRIX` | 6 | Feedin cycle matrix (string→mode accumulation) | Cycle 0 snapshot | Mode index |
| `OUTPUT_REC_FEEDBACK_MATRIX` | 7 | Feedback cycle matrix (mode→string accumulation) | Cycle 32 snapshot | Mode index |
| `OUTPUT_REC_STEM_FEEDBACK` | 8 | Final feedback applied to string stem | Error path only | Spatial |
| `OUTPUT_REC_RAW_COEFFICIENTS` | 9 | Raw mode coefficients from GPU memory | Pre-loop | Mode index |

Records 6 and 7 are **snapshot records** — they capture the accumulation matrix at a specific cycle index (0 and 32 respectively), not the final state.

---

## Sound Records Buffer

A circular GPU buffer for per-string debug data across multiple synthesis cycles.

| Property | Value |
|----------|-------|
| Max cycles | `MAX_SOUND_RECORD_INDEX` = 500 |
| Parameters per string per cycle | `NUM_PARAMS_IN_SOUND_RECORD` = 4 |
| Total buffer size | 500 × mode_iteration × num_strings × 4 reals |

Written by `recordOutputData()` calls in the kernel. Constants defined in `constants.h`:

| Constant | Index | Content |
|----------|-------|---------|
| `SOUND_REC_BRIDGE_FORCE` | 0 | `force_on_bridge_summed` (bridge force per string) |
| `SOUND_REC_MODE_STATE` | 1 | `s_mode` (mode displacement) |
| `SOUND_REC_APPLIED_FORCE` | 2 | `applied_force` (force after hammer processing) |
| `SOUND_REC_MODE_FORCE` | 3 | `s_mode_applied_force` (force applied to mode) |

Controlled by `sound_record_index`. The archival write was reinstated in C2
(dev-568e, commit `77479ea`, 2026-04-20) and now runs inline in
`Pianoid::runCycle` behind `#ifdef PIANOID_DEBUG_DATA` (see also
[Per-Cycle Recording](#per-cycle-recording-called-from-pianoidruncycle) above).
Debug builds populate `dev_sound_records` and advance `sound_record_index`;
release builds skip the archival write entirely and `getSoundRecords()`
returns an empty vector.

> **Debug-build required.** All four `SOUND_REC_*` records — including the
> mode-indexed records 1 and 3 consumed by `play_mode()` and the chart
> functions `mode_playback` and `pure_mode_test` (in `chartFunctions.py`) —
> require `PIANOID_BUILD_VARIANT=debug`. In release builds these chart
> functions silently produce empty oscillation arrays. Project policy is
> that these tools are intended for debug-build use; build the debug
> variant (`build_pianoid_cuda.bat --heavy --both`) before invoking them.

---

## PianoidResult (Python Wrapper)

**File:** `pianoid_middleware/PanoidResult.py` (note: filename has legacy typo — 'PanoidResult' not 'PianoidResult')

### Constructor

```python
PianoidResult(pianoid_cpp, model_params, num_records=4, num_states=10, num_parameters=32)
```

### Data Members

| Member | Shape | Source Method |
|--------|-------|--------------|
| `sound` | `(num_channels, samples)` | `get_sound_from_pianoid(length=None)` ← `getRawSoundRecord()`. `length=None` returns full circular buffer |
| `string_states` | `(2, num_blocks, array_size)` | `get_pianoid_state()` ← `getPianoidState()` |
| `output_data` | `(10, num_strings, array_size)` | `get_output_data_from_pianoid()` ← `getOutputData()` |
| `records` | `(4, num_strings, samples)` | `get_sound_records_from_pianoid(length)` ← `getSoundRecords()` |
| `parameter_data` | `(32, num_blocks, array_size)` | `get_parameters_data_from_pianoid()` ← `getParameters()` |

### Key Methods

| Method | Purpose |
|--------|---------|
| `fetch(length, debug, point_parameters)` | Master fetch — always gets string states; conditionally gets output_data, sound, records (if `debug=True`) and parameters (if `point_parameters=True`) |
| `get_sound(channel, wav, result_type)` | Returns sound for a channel (list or ndarray). `channel=-1` returns all channels |
| `get_record(record_no, obj_no)` | Extracts a specific sound record. `obj_no='all'` or `-1` returns all strings flattened |
| `point_parameters(param_no, block_no)` | Extracts point parameter data. Lazy-fetches if not captured |
| `save_sound_to_wav(channel, path, normalize)` | Saves single channel to 16-bit WAV file |
| `save_all_channels_to_wav(base_path)` | Saves all channels to separate WAV files |

### Usage from Middleware

```python
# In pianoid.py: get_result_from_pianoid(length, clear=False)
if clear:
    pianoid_cpp.clearRecords()
    time.sleep(length / 1000)       # accumulate data during playback
result.fetch(length, self.debug)    # debug=True → full extraction
sm.unpack_blocks(result.string_states)  # distribute back to Python model
```

The `debug` flag on the `Pianoid` middleware class (default `True`) controls whether `fetch()` retrieves the full debug dataset or only string states.

---

## Data Flow by Consumer

### Chart Functions (chartFunctions.py)

| Chart Function | Data Used | Extraction Call |
|----------------|----------|-----------------|
| `sound_function` | `result.get_sound()` | `get_sound_from_pianoid()` → `getRawSoundRecord()` (fetches fresh data from circular buffer) |
| `string_shape_function` | `result.string_states` | `getPianoidState()` |
| `block_output_data_function` | `result.string_states` (rec 0-1) or `result.output_data` (rec 2-9) | `getPianoidState()` / `getOutputData()` |
| `mode_feedin_analysis_function` | `result.output_data[4..9]` | `getOutputData()` |
| `play_note_offline_chart_function` | `getRecordedAudio()` | Direct C++ call |
| `online_midi_playback_chart_function` | `result.get_sound()` | Reads last sound buffer |

### Tests

| Test | Data Used |
|------|----------|
| `test_performance.py` | `getRecordedAudio()`, `getGpuProfilingData()` |
| `test_feedback_coupling.py` | `getRecordedAudio()`, `getModeDisplacements()` |

---

## Related Documentation

- [SYNTHESIS_ENGINE.md](SYNTHESIS_ENGINE.md) — MainKernel that writes the debug buffers
- [MEMORY_MANAGEMENT.md](MEMORY_MANAGEMENT.md) — GPU buffer allocation (OUTPUT category)
- [PLAYBACK_SYSTEM.md](PLAYBACK_SYSTEM.md) — PlaybackCycleExecutor calls `recordCycleAudio()`
- [Chart System](../pianoid-middleware/CHART_SYSTEM.md) — Chart functions that consume debug data
- [Testing](../../development/TESTING.md) — Instrumentation APIs reference
