# Testing System

Three-level pytest framework in `PianoidCore/tests/`, organized top-down by integration scope.

## Structure

```
PianoidCore/tests/
├── conftest.py          # Root: markers, skip logic, shared constants
├── pytest.ini           # Configuration
├── fixtures/            # Reference data (e.g. reference_c4_preset_test5.npy)
├── system/              # Full stack — GPU + audio hardware
│   ├── conftest.py      # Session-scoped Pianoid with SDL3 audio
│   ├── test_audio_drivers.py
│   ├── test_performance.py
│   └── test_playback.py
├── integration/         # GPU required, no audio
│   ├── conftest.py      # Session-scoped Pianoid without audio, offline helpers
│   └── test_feedback_coupling.py
└── unit/                # Pure Python, no GPU (planned)
```

## Running Tests

```bash
cd PianoidCore

# All tests (release variant)
.venv/Scripts/python -m pytest tests/ -v

# All tests with debug variant (enables PIANOID_DEBUG_DATA extraction)
PIANOID_USE_DEBUG=1 .venv/Scripts/python -m pytest tests/ -v

# System tests only (requires GPU + audio)
.venv/Scripts/python -m pytest tests/system/ -v -s

# Skip slow tests
.venv/Scripts/python -m pytest tests/ -v -m "not slow"
```

The debug variant must be built first (`build_pianoid_cuda.bat --heavy --both`). `conftest.py` reads `PIANOID_USE_DEBUG` and aliases `pianoidCuda_debug` as `pianoidCuda` via `sys.modules`.

## Markers

| Marker | Meaning |
|--------|---------|
| `gpu` | Requires NVIDIA GPU with `pianoidCuda` |
| `audio` | Requires audio hardware (SDL3/ASIO) |
| `slow` | Takes >30 seconds |

Tests marked `gpu` or `audio` auto-skip when hardware is unavailable.

## System Tests (implemented)

### test_audio_drivers.py

| Test | What it validates |
|------|-------------------|
| `TestDriverAvailability` | At least one audio driver compiled |
| `TestSinewave[sdl3/asio_callback]` | Driver init + GPU sinewave output |
| `TestSynthesis[sdl3/asio_callback]` | Full synthesis path through driver |

### test_performance.py

| Test | What it validates |
|------|-------------------|
| `TestGpuCycleTiming` | Per-cycle GPU kernel time < 1.333ms budget (CUDA events) |
| `TestTotalCycleTiming` | Wall-clock cycle time via offline playback |
| `TestSoundOutputQuality` | Pitch detection (C4 ±5%), non-silent output |
| `TestSoundRegression` | Waveform/spectral correlation vs saved reference |
| `TestBufferSynchronization` | Buffer underrun diagnosis — correlates GPU time with callback stats |
| `TestTimingDistribution` | Statistical tail analysis (p95/p99) of GPU, total, and buffer phase |

### test_playback.py

| Test | What it validates |
|------|-------------------|
| `TestOnlinePlayback::test_chord_playback` | C major chord via `runOnlinePlayback()` — no profiling, no debug data, auditory evaluation |

Production-safe: no dependency on `PIANOID_DEBUG_DATA`. Plays a 3-second C major chord (C4+E4+G4) through the audio driver with note-off and release tail.

## Integration Tests (implemented)

### test_excitation_interpolation.py

Verifies that excitation base-level interpolation is consistent between C++ and Python, and that updating excitation parameters via `setNewExcitationBaseLevels()` changes sound output.

| Test | What it validates |
|------|-------------------|
| `TestInterpolationAlgorithm::test_boundary_values_match` | Boundary velocities (0, 31, 63, 95, 127) map directly to base levels without interpolation |
| `TestInterpolationAlgorithm::test_cpp_reference_matches_python_extrapolate` | Python reference implementation of `interpolateBaseLevels()` matches `StringExcitation.extrapolate()` |
| `TestInterpolationAlgorithm::test_monotonic_interpolation` | Interpolated matrix is monotonically non-decreasing per velocity index |
| `TestInterpolationAlgorithm::test_multiple_random_strings` | Interpolation consistency holds across randomly generated base-level sets |
| `TestExcitationUpdate::test_excitation_update_changes_output` | Calling `setNewExcitationBaseLevels()` with different base levels produces different audio output |
| `TestExcitationUpdate::test_velocity_sensitivity` | Higher-velocity base levels produce louder output than lower-velocity base levels |

Key constants used: `NUM_BASE_LEVELS=5`, `LEN_LEVEL_GP=20`, `BOUNDARIES=[0, 31, 63, 95, 128]`.

### test_feedback_coupling.py

Validates string-to-soundboard coupling via the feedin matrix. Uploads custom deck matrices with single nonzero coefficients, excites specific pitches via offline playback, and verifies mode displacements.

| Test | What it validates |
|------|-------------------|
| `TestCouplingCompleteness::test_target_mode_excited` | Nonzero feedin[S,M] produces displacement in mode M |
| `TestCouplingCompleteness::test_no_leakage_to_other_modes` | Only the target mode is excited — all others zero |
| `TestPerPairLeakage::test_zero_coefficient_blocks_signal` | feedin[S,M]=0 blocks signal to M while feedin[S,M']!=0 excites M' |
| `TestFullZeroLeakage::test_zero_row_string_produces_no_mode_excitation` | All-zero deck produces no mode excitation |
| `TestFullZeroLeakage::test_zero_column_mode_receives_no_signal` | Mode with zero feedin stays silent while adjacent mode with nonzero feedin is excited |
| `TestFullZeroLeakage::test_zero_feedback_coefficient_keeps_feedin_active` | Feedin path works independently of deck_feedback_coefficient |

Key implementation detail: deck rows are indexed by position in `StringMap.string_index` (not by raw string ID). The `_deck_row()` helper converts string IDs to deck row indices.

## Key Constants

```python
SAMPLE_RATE = 48000
SAMPLES_PER_CYCLE = 64
GPU_BUDGET_MS = 64 / 48000 * 1000   # 1.333 ms
TOTAL_BUDGET_MS = GPU_BUDGET_MS * 1.5  # 2.0 ms
```

## Instrumentation APIs

### Performance Profiling

| Python API | Data | Source |
|-----------|------|--------|
| `p.startProfiling()` / `getGpuProfilingData()` | Per-cycle GPU kernel timings (ms) | PianoidProfiler (CUDA events) |
| `p.initTimeRecord()` / `getTimeRecord()` | Per-cycle wall-clock checkpoints (µs) | PlaybackCycleExecutor |
| `p.getCallbackStats()` | Callback count, interval, underruns | AudioDriverInterface |

### Audio Extraction

| Python API | Data | Source |
|-----------|------|--------|
| `p.getRecordedAudio()` | Audio from last completed playback session | `last_recorded_audio_` (host) |
| `p.getRawSoundRecord()` | Per-cycle accumulated audio (if recording enabled) | `rawSound` (host vector) |
| `p.enableRawSoundRecording(bool)` | Enable/disable per-cycle D2H audio copy | `rawSoundRecordingEnabled` flag |
| `p.getCurrentCycleAudio()` | Audio from current synthesis cycle (float or int32→float) | `dev_soundFloat` / `dev_soundInt` (GPU) |

### State Extraction (GPU → Host)

| Python API | Data | Source |
|-----------|------|--------|
| `p.getPianoidState()` | String displacement + velocity (2 × total_points) | `dev_string_state` (GPU, always active) |
| `p.getModeDisplacements()` | Per-mode: q, q\_prev, dec, omega, mass\_inv (5×N) | `dev_mode_state` (GPU) |
| `p.getOutputData()` | 10 debug records × num\_strings × array\_size | `dev_output_data` (GPU, `PIANOID_DEBUG_DATA`) |
| `p.getParameters()` | Per-point parameters (POINT\_PARAMETERS\_NO × total\_points) | `dev_parameters` (GPU, `PIANOID_DEBUG_DATA`) |
| `p.fetchExcitation(stringNo, cycleIdx)` | Hammer excitation waveform for a string | `dev_force_function` (GPU) |
| `p.getSoundRecords(length)` | Per-string debug records (circular, up to 500 cycles) | `dev_sound_records` (GPU, `PIANOID_DEBUG_DATA`) |

### Compile Guards

The `PIANOID_DEBUG_DATA` flag controls debug data extraction — kernel-side writes to GPU global memory and host-side D2H copies for `getOutputData()`, `getParameters()`, `getSoundRecords()`. The flag is **not** in `constants.h` — it is added by `setup.py` only when building the debug variant (`PIANOID_BUILD_VARIANT=debug`). Without it, these methods return zero-filled vectors (~113 MB GPU memory saved). `getPianoidState()` and `getRawSoundRecord()` are always active regardless of variant. See [DEBUG\_DATA.md](../../modules/pianoid-cuda/DEBUG_DATA.md#compile-guard) and [BUILD\_SYSTEM.md](../../architecture/BUILD_SYSTEM.md#build-variants-debug--release).
