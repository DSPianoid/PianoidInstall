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

A single preprocessor flag in `constants.h` controls all debug data extraction:

```c
#define PIANOID_DEBUG_DATA
```

| Flag | Layer | Effect | Default |
|------|-------|--------|---------|
| `PIANOID_DEBUG_DATA` | Kernel + Host | **Kernel:** enables `recordOutputData()` writes to `dev_output_data` (records 0–9), `dev_sound_records`, `dev_string_state`. **Host:** enables D2H copies in `getPianoidState()`, `getOutputData()`, `getParameters()`, `getSoundRecords()` | Defined |

**Design rationale:** Writing intermediate results to GPU global memory during synthesis is expensive and should be avoided in production deployments. Disabling `PIANOID_DEBUG_DATA` removes all debug writes from the kernel and all corresponding D2H copies from the host extraction methods (which return zero-filled vectors since there is nothing to read).

**What is always active (regardless of flag):**

- Audio buffers (`dev_soundFloat`, `dev_soundInt`) — production audio path
- Mode state (`dev_mode_state`) — readable via `getModeDisplacements()`, used at runtime
- String state to `string_state` buffer (when `*status > 0`) — simulation state, not debug
- NaN detection in the main loop — always-on, negligible cost, catches corruption early

**What requires `PIANOID_DEBUG_DATA`:**

- output\_data records 0–9 (string shape snapshots, feedin/feedback diagnostics, hammer force)
- sound\_records circular buffer (per-string per-cycle bridge force, mode force)
- string\_state writes to `dev_string_state` (snapshot for chart extraction)
- Host D2H copies in `getPianoidState()`, `getOutputData()`, `getParameters()`, `getSoundRecords()`

---

## C++ Extraction API

### Audio Extraction

| Method | Returns | Source Buffer | Notes |
|--------|---------|---------------|-------|
| `getRawSoundRecord()` | `vector<float>` | `rawSound` (host) | Returns accumulated per-cycle audio. Must call `enableRawSoundRecording(true)` first |
| `getRecordedAudio()` | `vector<float>` | `last_recorded_audio_` (host) | Audio from last completed playback session (online or offline) |
| `getCurrentCycleAudio()` | `vector<float>` (mode_iteration samples) | `dev_soundFloat` or `dev_soundInt` (GPU) | Single cycle. Auto-converts int32→float via `/ INT32_MAX` |

**Raw sound recording** is disabled by default for performance (~1.5ms saved per cycle). Control with:
- `enableRawSoundRecording(true/false)`
- `isRawSoundRecordingEnabled()`
- `clearRawSoundRecording()`

### State Extraction

| Method | Returns | Size | Source Buffer | Guard |
|--------|---------|------|---------------|-------|
| `getPianoidState()` | `vector<real>` | 2 × total_points | `dev_string_state` | `PIANOID_DEBUG_DATA` |
| `getModeDisplacements()` | `vector<real>` | num_modes × 5 | `dev_mode_state` | Always |
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
| `clearRecords()` | Resets `sound_record_index` to 0 (dev_sound_records overwrites from start) |
| `clearRawSoundRecording()` | Clears the `rawSound` host vector |

### Per-Cycle Recording (called by PlaybackCycleExecutor)

| Method | What it does |
|--------|-------------|
| `recordCycleAudio()` | Calls `appendSoundRecords()` — GPU kernel copies `dev_sound_records_ms` → `dev_sound_records` at current index |
| `appendRawSound(name)` | D2H copy from named GPU float buffer → appends to `rawSound` host vector |

---

## Output Data Records

The `dev_output_data` buffer contains 10 records, each of size `num_strings × array_size`. All records require `PIANOID_DEBUG_DATA`.

| Record | Content | Written When | Index Domain |
|--------|---------|-------------|--------------|
| 0 | String displacement `s_a[point]` | `PIANOID_DEBUG_DATA` | Spatial (point position) |
| 1 | String previous state `s_b` | `PIANOID_DEBUG_DATA` | Spatial |
| 2 | String identification (debug) | `PIANOID_DEBUG_DATA` | Spatial |
| 3 | Spatial hammer force distribution `coeff_force` | `PIANOID_DEBUG_DATA` | Spatial |
| 4 | Active feedin to modes `mode_feedin[string, mode]` | `PIANOID_DEBUG_DATA` | Mode index |
| 5 | Computed feedback from modes `mode_feedback[string, mode]` | `PIANOID_DEBUG_DATA` | Mode index |
| 6 | Feedin cycle matrix (string→mode accumulation) | `PIANOID_DEBUG_DATA`, cycle 0 | Mode index |
| 7 | Feedback cycle matrix (mode→string accumulation) | `PIANOID_DEBUG_DATA`, cycle 32 | Mode index |
| 8 | Final feedback applied to string stem | `PIANOID_DEBUG_DATA` | Spatial |
| 9 | Raw mode coefficients (unfiltered feedin) | `PIANOID_DEBUG_DATA` | Mode index |

Records 6 and 7 are **snapshot records** — they capture the accumulation matrix at a specific cycle index (0 and 32 respectively), not the final state.

---

## Sound Records Buffer

A circular GPU buffer for per-string debug data across multiple synthesis cycles.

| Property | Value |
|----------|-------|
| Max cycles | `MAX_SOUND_RECORD_INDEX` = 500 |
| Parameters per string per cycle | `NUM_PARAMS_IN_SOUND_RECORD` = 4 |
| Total buffer size | 500 × mode_iteration × num_strings × 4 reals |

Written by `recordOutputData()` calls in the kernel:
- Record 0: `force_on_bridge_summed` (bridge force per string)
- Record 2: `applied_force` (force after processing)
- Records 1, 3: reserved / commented out

Controlled by `sound_record_index` (incremented each cycle by `appendSoundRecords()`). Wraps silently when index exceeds `MAX_SOUND_RECORD_INDEX`.

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
| `sound` | `(num_channels, samples)` | `get_sound_from_pianoid(length)` ← `getRawSoundRecord()` |
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
| `sound_function` | `result.get_sound()` | `getRawSoundRecord()` |
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
