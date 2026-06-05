# Testing System

Three-level pytest framework in `PianoidCore/tests/`, organized top-down by integration scope.

For **live UI verification** (browser-driven tests, audio measurement via `/test-ui`), see [UI Testing](../guides/UI_TESTING.md) — it covers the three-process startup, `note_playback` sound measurement, and shutdown sequence.

## Structure

```
PianoidCore/tests/
├── conftest.py          # Root: markers, skip logic, shared constants
├── pytest.ini           # Configuration
├── fixtures/            # Reference data (e.g. reference_c4_preset_test5.npy)
├── system/              # Full stack — GPU + audio hardware
│   ├── conftest.py      # Session Pianoid fixtures: pianoid_audio_off / pianoid_audio_on; module-scoped pianoid_midi_engine (dedicated running-engine instance)
│   ├── test_asio_multichannel.py
│   ├── test_audio_drivers.py
│   ├── test_backend_midi_ingress.py   # MIDI W5/P4 — backend ingress: emit_midi_note_event broadcast gate + note-only filter, broadcast switchability, schedule_event dispatch + chord stress (audio_off)
│   ├── test_kernel_midi_batch.py      # MIDI W1/P1 — per-cycle kernel batch envelope: same-cycle chords, NOTE_ON+NOTE_OFF, TEST_* interleave, MAX_EVENTS_PER_CYCLE cap (audio_off)
│   ├── midi_latency.py                # MIDI W5/P4 — schedule_event dispatch-latency measurement (standalone script + one pytest test asserting the Gate-3 budget)
│   ├── test_performance.py
│   ├── test_performance_audio_off.py  # Perf — GPU/total timing, sound-output quality, sound-regression vs fixtures/reference_c4_preset_test5.npy (audio_off)
│   ├── test_performance_audio_on.py   # Perf — callback / buffer-phase distribution (audio_on, real driver)
│   ├── test_cfl_stability_guard.py    # CFL/Courant FDTD stability guard v2 (HOST-side gate) — baseline-stable-via-ratio, unstable tension/jung/r REJECTED (CflRejected→400) BEFORE upload + engine-finite + model-NOT-mutated, stable/length not falsely rejected, host-backed stability_ratio extraction, per-string tension_offset (audio_off)
│   ├── test_playback.py
│   ├── test_preset_switch_mode_count.py  # Cross-mode-count /preset/switch regression (Bug A)
│   ├── test_websocket.py              # WebSocket unit tests — imports, binary frames, event schemas, param schemas, feedback mapping, debug flag
│   └── test_websocket_integration.py  # WebSocket integration — server startup, WS connection, lifecycle push, play events, parameter updates, REST regression
├── integration/         # GPU required, no audio
│   ├── conftest.py      # Session-scoped Pianoid without audio, offline helpers
│   ├── test_feedback_coupling.py
│   └── test_modal_adapter_e2e.py   # Full modal adapter pipeline (Belarus data + GPU ESPRIT)
└── unit/                # Pure Python, no GPU
    ├── test_cfl_amp.py              # CFL guard v2 closed-form (cfl_stability.py) — PINNED K=24 grid vs dense max|g| (0 false-accept/reject), empirical crash borders incl. LOWER-edge, per-string tension_offset worst-string, collapse-not-flagged, isfinite (no GPU)
    ├── test_channel_assignment.py   # MappingConfig persistence round-trip, _load_mapping_results file priority, ESPRIT response channel filtering
    ├── test_direct_correction.py    # CalibrationController: direct linear correction algorithm, fallback to bisection, edge cases (11 tests)
    ├── test_event_buffer_backpressure.py # RealTimeEventBuffer back-pressure: setSizeLimit/getSizeLimit, drop-oldest-NOTE_OFF-first policy, fallback to oldest, stats.dropped_event_count (Tranche A / M12, 7 tests)
    ├── test_esprit_gpu_fallback.py  # ESPRIT GPU->CPU fallback is LOUD not silent: _to_gpu_or_cpu + _free_gpu_memory log WARNING when use_gpu=True but CuPy missing, and the return flag degrades to False (dev-5dd4 regression guard, 4 tests)
    ├── test_mic_analyzer.py         # MicAnalyzer: Goertzel spectral measurement, DC removal, harmonics, reference signal comparison (16 tests)
    ├── test_modal_adapter_state.py  # ModalAdapter state/data checks, persistence, ESPRIT refactor, pipeline, offline preset builder, PresetConfig features, REST endpoints, scenario discovery helpers (`_discover_{npy,roomresponse}_scenarios`)
    ├── test_modal_adapter_apply_route.py # Cross-server `apply_to_preset` wiring: F9 503 on port 5001 preserved, main-server (5000) counterpart route covers 400/404/409 paths (5 tests)
    ├── test_play_listen_gate_regression.py # REST/WS `/play` must reach the EventQueue while the MIDI listener runs — guards the W4-P3 gate regression (5 tests)
    ├── test_health_listen_mode_regression.py # `GET /health` `listen_mode` must report `pianoid.mp.listen_to_modes` (engine listen-to-modes truth), NOT `pianoid.listen` (the MIDI-listener flag). Stub sets pianoid.listen to the inverse so a regression flips the value. Drives /health via test_client, no engine (dev-lmode, 3 tests)
    ├── test_project_export_import.py # Project export/import: zip creation, manifest validation, sanitisation, round-trip, name conflict resolution
    └── test_start_right_away_binary.py # `/load_preset` `start_right_away` is BINARY 0/1 — value 1 starts the playback bg thread, 0/non-1 = init only; pins removal of dead value-2 (deprecated inline) + value-3 (no-op) branches. Drives load_preset_route via test_client with heavy deps monkeypatched, no engine (dev-5c3b, 5 tests)
```

## Running Tests

```bash
cd PianoidCore

# Default: audio_off scope (everything that does NOT need a real driver)
.venv/Scripts/python -m pytest -m "not audio_on and not mic" tests/ -v

# audio_on scope (real driver + mic comparison; needs hardware + loopback)
.venv/Scripts/python -m pytest -m "audio_on" tests/ -v

# All tests (release variant) — runs audio_on too; auto-skips without audio device
.venv/Scripts/python -m pytest tests/ -v

# Debug variant (enables PIANOID_DEBUG_DATA extraction)
PIANOID_USE_DEBUG=1 .venv/Scripts/python -m pytest tests/ -v

# System tests only
.venv/Scripts/python -m pytest tests/system/ -v -s

# Skip slow tests
.venv/Scripts/python -m pytest tests/ -v -m "not slow"

# Unit tests only (auto-tagged audio_off, no GPU needed for many)
.venv/Scripts/python -m pytest tests/unit/ -v
```

The debug variant must be built first (`build_pianoid_cuda.bat --heavy --both`). `conftest.py` reads `PIANOID_USE_DEBUG` and aliases `pianoidCuda_debug` as `pianoidCuda` via `sys.modules`.

## Audio Testing Modes (strict A1)

Two modes — no middle ground. **Driver-on-mic-off is forbidden in tests.**

| Mode | Driver | Mic | Verification surface |
|------|--------|-----|----------------------|
| `audio_off` (default) | NOT created — `audio_on=False, audio_driver_type=0` | impossible (driver-off ⇒ no mic) | offline buffer (`runOfflinePlayback`, `getRecordedAudio`), `note_playback` chart, REST endpoints with no driver path |
| `audio_on` | real driver engaged — `audio_on=True, audio_driver_type=2/3/4` | engaged via `startMicCapture` | mic-vs-synth comparison via `assert_synth_reaches_mic` (Goertzel transferRatio) |

Default for every test, fixture, and skill is `audio_off`. A test promotes to `audio_on` only when it has a legitimate reason to engage the real driver (callback timing, ASIO routing, calibration flow), AND it pairs that driver with a mic capture and a synth-vs-mic comparison. A driver-on test that never opens the mic is a contract violation: either add the mic comparison or demote to `audio_off`.

**Why strict A1.** The previous "audio" marker meant "needs a driver", which left a silent middle category — driver active, no mic check, no offline assertions either. Such tests pass on a working build with broken audio routing because nothing on either end of the audio path is observed. Strict A1 closes that gap: every audio_on assertion must end at the mic, and every audio_off assertion must end at an offline buffer.

### Markers

| Marker | Meaning | Hardware gate |
|--------|---------|---------------|
| `audio_off` | No driver, no mic. Synth-only checks via offline buffer or REST without driver. Default for unit/integration and most system tests. | none — must run anywhere with GPU |
| `audio_on` | Real audio driver engaged. Test MUST also engage mic and compare. Without the mic comparison the test does not earn this marker. | audio device required (auto-skip when unavailable) |
| `mic` | Subclass of `audio_on` — explicit annotation that the test calls `startMicCapture` and asserts on captured frames. Tests carrying `audio_on` and reading from the mic SHOULD also carry `mic` so reviewers can locate them. | audio device required + `_MIC_LOOPBACK_CONFIGURED` (see below) |
| `gpu` | Requires NVIDIA GPU with `pianoidCuda`. | GPU required |
| `audio` | Legacy alias of `audio_on`. New tests SHOULD use `audio_on`. Auto-skipped under the same hardware gate. | audio device required |
| `slow` | Takes >30 seconds. | none |

`tests/conftest.py::pytest_collection_modifyitems` auto-tags every `tests/unit/**` test with `audio_off` and skips `audio` / `audio_on` items when `audio_available()` returns False.

### Fixtures (system tests)

`tests/system/conftest.py` exposes the contract as two session-scoped fixtures:

| Fixture | Mode | Init kwargs |
|---------|------|-------------|
| `pianoid_audio_off` | `audio_off` | `audio_on=False, audio_driver_type=0` |
| `pianoid_audio_on` | `audio_on` | `audio_on=True, audio_driver_type=3` (SDL3) |
| `performance_pianoid` | back-compat alias of `pianoid_audio_on` (legacy) | — |

A test selects its mode by requesting the matching fixture. Re-using the wrong fixture is the canonical contract bug — `audio_off` tests must NEVER request `pianoid_audio_on`.

### `assert_synth_reaches_mic` — canonical audio_on promotion pattern

`tests/conftest.py::assert_synth_reaches_mic(pianoid, pitch, velocity, ...)` is the goldilocks helper for audio_on tests. It:

1. Starts `startSynthesisCapture()` (host buffer of the kernel output) and `startMicCapture()` simultaneously.
2. Schedules a NOTE_ON at `pitch`/`velocity`, waits `note_duration_s`, schedules NOTE_OFF, waits `tail_s`.
3. Stops both captures and calls C++ `analyzeCapturedAudioWithReference` (Goertzel-based per-harmonic energy + transferRatio).
4. Asserts `capturedFrames > 0`, `rms > 0`, and `transferRatio > transfer_threshold` (default `1e-3`).

Returns the `MicMeasurement` so the caller can do additional asserts on harmonics. Pre-condition: `pianoid` was initialised `audio_on=True` and the realtime engine is running — the helper restarts it idempotently if needed.

To promote a test to audio_on, request `pianoid_audio_on` and call `assert_synth_reaches_mic(...)`. Do NOT write a new mic-comparison helper in a test file — extend the canonical one if more assertion hooks are needed.

### `_MIC_LOOPBACK_CONFIGURED` gate

`tests/system/conftest.py::_MIC_LOOPBACK_CONFIGURED` (boolean) controls whether tests that need a working speaker→mic loopback run on this host. It is hard-coded `False` until the dev box has the loopback configured and verified.

Tests that depend on a loopback (mic actually hears the synth) request the `require_mic_loopback` fixture as their first fixture; the fixture skips the test with a deferred-WIP message when the gate is False. To enable on a verified loopback: flip `_MIC_LOOPBACK_CONFIGURED = True`.

### Markers, fixtures, and the gate together

A canonical audio_on test ends up looking like:

```python
import pytest

pytestmark = [pytest.mark.gpu, pytest.mark.audio_on, pytest.mark.mic]


def test_callback_stats_reach_mic(require_mic_loopback, pianoid_audio_on):
    from tests.conftest import assert_synth_reaches_mic
    meas = assert_synth_reaches_mic(pianoid_audio_on, pitch=60, velocity=100)
    assert meas.transferRatio > 1e-2
```

A canonical audio_off test:

```python
import pytest

pytestmark = [pytest.mark.gpu, pytest.mark.audio_off]


def test_offline_render_amplitude(pianoid_audio_off):
    audio = pianoid_audio_off.runOfflinePlayback(...)
    assert audio.max() > 0
```



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
| `TestOnlinePlayback::test_chord_playback` | C major chord via `OnlinePlaybackEngine` (initialize/loadEvents/run) — no profiling, no debug data, auditory evaluation |

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

### test_length_dx_propagation.py

Regression test: editing a string's physical `length` through the granular
parameter-update path must change the synthesised sound. `length` (metres) is not a GPU
parameter — only the derived `dx = length / p_main` is — and the granular path does not
repack via `pack()`, so `dx` must be recomputed and re-sent explicitly. Before the fix,
a `length` edit updated only the Python model and left the GPU `dx` slot stale (no
audible change). Verification surface: deterministic offline render.

| Test | What it validates |
|------|-------------------|
| `TestLengthDxPropagation::test_dx_invariant_holds` | `StringGeometry.dx() == length / p_main` for the test pitch (sanity) |
| `TestLengthDxPropagation::test_length_change_changes_sound` | A `length` edit via `update_pitch_physical_params_GRANULAR` changes the offline-rendered waveform well above the engine's render-to-render noise floor (~2.3% RMS); a +20% length edit moves it ~135% RMS |
| `TestLengthDxPropagation::test_length_change_is_reversible` | Restoring `length` restores the sound to within a few multiples of the noise floor — `dx` tracks `length` in both directions, no hysteresis |

Note: the offline engine is not bit-exact across consecutive renders (`resetStringsState()` does not zero all carried state — mode `q/q_prev`, excitation cycle index, `sound_prev_diff` persist), giving a ~2.3% render-to-render RMS noise floor. Thresholds are set relative to that measured floor.

### test_modal_pipeline_payload.py

Regression tests for finding F1 (Modal Adapter review, Wave 1) — payload key alignment between frontend `ModalAdapter.jsx` and backend `/modal/run_pipeline`. ESPRIT/tracking/feedin stages are stubbed so the test runs without real measurement data.

| Test | What it validates |
|------|-------------------|
| `TestFrontendPayloadKeys::test_esprit_config_key_reaches_esprit_stage` | Payload `esprit_config` reaches `_run_esprit_sync` verbatim (not dropped to defaults) |
| `TestFrontendPayloadKeys::test_tracking_params_key_reaches_tracking_stage` | Payload `tracking_params` reaches `run_tracking` with the exact values posted |
| `TestMappingPreservation::test_reused_folder_does_not_call_load_folder` | Re-running the pipeline with the currently-loaded `folder_path` skips `load_folder` (avoids wiping `_mapping`) |
| `TestMappingPreservation::test_missing_mapping_in_payload_preserves_existing` | Omitting `mapping` in the payload preserves the adapter's existing `_mapping` instead of silently replacing with defaults |
| `TestPayloadAcceptance::test_full_frontend_payload_accepted` | The exact JSON shape emitted by `ModalAdapter.jsx handleRunPipeline` is accepted and completes the pipeline |

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
