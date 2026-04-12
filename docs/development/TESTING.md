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
│   ├── test_asio_multichannel.py
│   ├── test_audio_drivers.py
│   ├── test_performance.py
│   ├── test_playback.py
│   ├── test_websocket.py              # WebSocket unit tests — imports, binary frames, event schemas, param schemas, feedback mapping, debug flag
│   └── test_websocket_integration.py  # WebSocket integration — server startup, WS connection, lifecycle push, play events, parameter updates, REST regression
├── integration/         # GPU required, no audio
│   ├── conftest.py      # Session-scoped Pianoid without audio, offline helpers
│   ├── test_feedback_coupling.py
│   └── test_modal_adapter_e2e.py   # Full modal adapter pipeline (Belarus data + GPU ESPRIT)
└── unit/                # Pure Python, no GPU
    ├── test_channel_assignment.py   # MappingConfig persistence round-trip, _load_mapping_results file priority, ESPRIT response channel filtering
    ├── test_mic_analyzer.py         # Microphone SNR analyzer
    ├── test_modal_adapter_state.py  # ModalAdapter state/data checks, persistence, ESPRIT refactor, pipeline, offline preset builder, PresetConfig features, REST endpoints
    └── test_project_export_import.py # Project export/import: zip creation, manifest validation, sanitisation, round-trip, name conflict resolution
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

# Unit tests only (no GPU/audio needed)
.venv/Scripts/python -m pytest tests/unit/ -v
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

### test_asio_multichannel.py

Verifies ASIO multi-channel output using the string-direct audio path (`listen_to_modes=False`).

| Test | What it validates |
|------|-------------------:|
| `TestAsioMultiChannel::test_channel_playback[0..3]` | C4 played on ASIO channels 0–3 — non-silent audio on each channel |

Key implementation details:
- **`outer_sound` patch**: defaults to `max(pitch - 127, 0) = 0` for all MIDI pitches ≤ 127, silencing string-direct audio. The fixture monkey-patches `Pitch.pack_params_for_string` **before** `init_pianoid` so `stringMapKernel` bakes `outerSoundChannel = channel + 1`.
- **FIR filter**: `firFilterLength` must be non-zero (buffers must be allocated for `initParameters()`). `FIRfilterON=False` by default (no coefficients loaded), so `playSoundSamples` takes the else branch and sends `soundInt` directly to ASIO.
- **Volume**: `max_volume=1e25` → coefficient `(1e25)^(64/127) ≈ 4e12` → peak `soundInt ≈ −8 dBFS`. The default `5e18` gives −71 dBFS (inaudible).
- One function-scoped Pianoid instance per channel; ASIO re-initialised between iterations.

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

Key constants used: `NUM_BASE_LEVELS=6`, `LEN_LEVEL_GP=20`, `BOUNDARIES=[0, 5, 31, 63, 95, 128]`.

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
| `TestPerStringFeedback::test_all_strings_receive_feedback` | Every string in every multi-string pitch has nonzero stem displacement (mode→string feedback) |
| `TestPerStringFeedback::test_feedback_absent_without_coefficient` | With deck_feedback_coeff=0, all stems are zero (sanity check) |

Key implementation detail: deck rows are indexed by position in `StringMap.string_index` (not by raw string ID). The `_deck_row()` helper converts string IDs to deck row indices.

### test_feedin_zero_leakage.py

Validates that `pack_pitch_feedin()` respects the `listen_to_modes` flag when injecting sound channel coefficients, and that the CUDA kernel has no inherent leakage on an all-zero deck.

| Test | What it validates |
|------|-------------------|
| `TestPythonPackingLeakage::test_sound_channel_indices_exist` | Preset has sound channels configured at expected mode indices |
| `TestPythonPackingLeakage::test_sound_channel_coefficients_nonzero` | Test pitch has non-zero sound channel coefficients |
| `TestPythonPackingLeakage::test_modes_mode_injects_coefficients` | `listen_to_modes=True`: zeroed feedin row has sc coefficients at mode_channel_index |
| `TestPythonPackingLeakage::test_strings_mode_zeroes_injection` | `listen_to_modes=False`: zeroed feedin row is truly all-zero (no injection) |
| `TestGpuZeroDeckSilence::test_zero_deck_produces_silent_audio` | All-zero deck → zero mode displacement (no kernel leakage) |
| `TestGpuZeroDeckSilence::test_zero_deck_zero_audio_rms` | All-zero deck → zero audio RMS |
| `TestEndToEndZeroedFeedinProducesSound::test_zeroed_feedin_via_pack_deck_still_produces_mode_excitation` | Modes mode + zeroed feedin + pack_deck → sc modes excited |
| `TestEndToEndZeroedFeedinProducesSound::test_zeroed_feedin_via_pack_deck_still_produces_audio` | Modes mode + zeroed feedin + pack_deck → non-silent audio |
| `TestEndToEndZeroedFeedinProducesSound::test_regular_modes_negligible_vs_sound_channel_modes` | Regular modes have negligible displacement from cross-coupling |
| `TestStringsModeSilenceOnZeroedFeedin::test_strings_mode_zeroed_feedin_produces_silence` | Strings mode + zeroed feedin + pack_deck → silence (fix validation) |

### test_modal_adapter_e2e.py

End-to-end integration test for the Modal Adapter pipeline with Belarus measurement data. Tests all 6 stages: Load → ESPRIT → Tracking → Feedin → Channel Mapping → Apply to Preset.

Requires Belarus data at `D:/repos/RoomResponse/piano/` and RoomResponse ESPRIT library.

| Test | What it validates |
|------|-------------------|
| `TestBelarusLoad::test_load_folder_auto_detects_roomresponse` | Auto-detects RoomResponse scenario folder structure |
| `TestBelarusLoad::test_scenario_indices_populated` | Scenario indices extracted from folder names |
| `TestBelarusLoad::test_measurement_shape` | Measurement arrays have correct (samples, channels) shape |
| `TestBelarusLoad::test_load_subset` | Load specific subset of scenarios |
| `TestBelarusLoad::test_sample_rate` | Sample rate setter works |
| `TestBelarusMapping::test_set_mapping_with_roles` | Channel roles (force/reference/response) accepted |
| `TestBelarusMapping::test_channel_roles_parsed` | Roles correctly categorize channels |
| `TestBelarusMapping::test_bridge_boundary` | Bridge boundary and pitch offset stored correctly |
| `TestBelarusESPRIT::test_run_esprit_subset` | GPU ESPRIT runs on 6-scenario subset, produces per-scenario results |
| `TestBelarusESPRIT::test_esprit_modes_in_expected_range` | Mode frequencies are in audible range |
| `TestBelarusPipeline::test_tracking_on_subset` | Mode tracking produces chains with stability classification |
| `TestBelarusPipeline::test_feedin_extraction_on_subset` | FFT feedin is non-uniform and non-zero |
| `TestBelarusPipeline::test_channel_mapping` | Channel-to-sound mapping persists |
| `TestBelarusPipeline::test_stabilization_data` | Stabilization diagram data formatted correctly |
| `TestBelarusPipeline::test_mode_shape_data` | Mode shape data has pitch/magnitude arrays |
| `TestBelarusPipeline::test_mode_preview_params` | Mode preview returns frequency/damping |
| `TestBelarusPipeline::test_persistence_roundtrip` | Intermediate results save and reload correctly |
| `TestBelarusReferenceComparison::test_reference_structure` | Reference file has 300 chains |
| `TestBelarusReferenceComparison::test_reference_stability_distribution` | 100+ stable, 80+ semi-stable |
| `TestBelarusReferenceComparison::test_reference_frequency_coverage` | Modes span <50 Hz to >5 kHz |
| `TestBelarusReferenceComparison::test_reference_chain_format_matches_pipeline` | Chain dict keys match pipeline output |
| `TestBelarusApplyPreset::test_baseline_preset_produces_sound` | Belarus_ESPRIT_v2 preset produces non-silent audio |
| `TestBelarusApplyPreset::test_apply_pipeline_results` | Pipeline results applied → non-silent sound on measured and interpolated pitches |
| `TestBelarusFullPipeline::test_esprit_all_scenarios` | (slow) ESPRIT on all 78 scenarios |
| `TestBelarusFullPipeline::test_tracking_stability_counts` | (slow) 80+ stable chains (ref: 121) |
| `TestBelarusFullPipeline::test_feedin_non_uniform` | (slow) Feedin varies across pitches |
| `TestBelarusFullPipeline::test_interpolated_pitches` | (slow) Unmeasured pitches interpolated |
| `TestBelarusFullPipeline::test_sound_coefficients_per_channel` | (slow) Sound coefficients vary across channels |

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
| `p.initTimeRecord()` / `getTimeRecord()` | Per-cycle wall-clock checkpoints (µs) — columns: `[timing_offset, cycle_start, after_gpu, after_buffer, ..., cycle_end]` | `PlaybackCycleExecutor::executeCycle()` |
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
