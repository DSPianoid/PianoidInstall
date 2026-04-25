# Acoustic Measurement Processing & Input — System Analysis

**Date:** 2026-04-06
**Scope:** End-to-end analysis of mic-based calibration, signal processing, modal extraction integration, and frontend UI.

---

## 1. System Overview

Pianoid includes a **4-phase mic-based calibration system** that measures real-world acoustic output through a microphone and adjusts synthesis parameters to equalize volume across the keyboard. The system operates in **semi-offline mode** — the engine loop stops but the audio driver stays alive, allowing deterministic cycle-by-cycle measurement with zero timing races.

A separate **modal adapter** pipeline bridges ESPRIT modal extraction from physical soundboard measurements into Pianoid presets.

---

## 2. Signal Chain

```
Microphone Hardware                      Synthesis Engine
       |                                        |
  SDL3 / ASIO callback                   dev_soundFloat (GPU)
       |                                        |
  CaptureBuffer (lock-free)              startSynthesisCapture()
       |                                        |
  stopCapture()                          stopSynthesisCapture()
       |                                        |
       +---------- MicAnalyzer::analyzeWithReference() (CPU) ----------+
                   |                                                    |
                   |-- Extract mono channel                             |
                   |-- Skip attack transient (Python-configurable)      |
                   |-- DC removal (subtract mean)                       |
                   |-- Goertzel @ fundamental + harmonics 2..6          |
                   |-- Sum harmonic energies -> spectralEnergy          |
                   |-- Same Goertzel on reference -> referenceEnergy    |
                   |-- transferRatio = mic / synth                      |
                   |
  MicMeasurement {rms, spectralEnergy, referenceEnergy, transferRatio, harmonics[]}
       |
  CalibrationController (Python)
       |-- Ambient noise measurement (pre-excitation)
       |-- Noise power subtraction: rms = sqrt(max(0, rms^2 - noise^2))
       |-- Noise floor detection (spectral ratio < 0.15 -> boost)
       |-- Bisection search on volume coefficient (+/-0.2 dB tolerance)
       |-- ISO 226 perception curve adjustment
       |-- 3 repetitions with median selection
       |-- Upload corrected excitation to GPU
```

---

## 3. C++ Components

### 3.1 CaptureBuffer (`pianoid_cuda/CaptureBuffer.h`)

Lock-free ring buffer for real-time mic capture:

- **Atomic sync**: `writePos` uses `memory_order_relaxed`/`memory_order_release` — no mutex on audio callback
- **Dual input**: `appendSamples(float*)` for SDL3, `appendSamplesInt32(int32_t*, bitDepth)` for ASIO with normalization `1.0 / (1 << (bitDepth-1))`
- **Pre-allocated**: sized at construction for `maxDurationMs` worth of samples — no heap allocation in real-time path
- **Thread model**: single writer (audio callback), single reader (`stopAndRetrieve()`)

### 3.2 MicAnalyzer (`pianoid_cuda/MicAnalyzer.h`, `MicAnalyzer.cpp`)

CPU-only signal analysis returning `MicMeasurement`:

| Field | Computation |
|-------|-------------|
| `rms` | `sqrt(sum(x^2) / N)` over DC-removed measurement window |
| `peak` | `max(|x|)` over DC-removed measurement window |
| `spectralEnergy` | Sum of Goertzel energy at fundamental + harmonics 2..N (skipping above Nyquist) |
| `referenceEnergy` | Same Goertzel analysis on synthesis output buffer (when `analyzeWithReference` used) |
| `transferRatio` | `spectralEnergy / referenceEnergy` — mic/synth energy ratio |
| `numHarmonics` | Number of harmonics analyzed (those below Nyquist, max 8) |
| `harmonics[]` | Per-harmonic breakdown: `{frequency, energy}` for mic signal |
| `referenceHarmonics[]` | Per-harmonic breakdown: `{frequency, energy}` for synthesis output |
| `capturedFrames` | Total frames in capture buffer |
| `analyzedFrames` | Frames in measurement window only |

**Goertzel algorithm** (replaced 2nd-order IIR bandpass):
- `goertzelEnergy(data, N, freq, sampleRate)` — O(N) per harmonic, normalized by N^2
- Measures energy at fundamental and harmonics 2..6 (configurable via `numHarmonics` param)
- Harmonics above Nyquist are automatically skipped
- No transient settling issues — works identically at all frequencies
- **DC removal** applied before all analysis (mean subtracted from measurement window)

**Reference signal comparison** (`analyzeWithReference`):
- Runs identical Goertzel analysis on both mic recording and synthesis output
- Transfer ratio compensates for speaker response, room acoustics, mic response
- Per-harmonic ratios available for diagnostics

### 3.3 Audio Driver Extensions

**SDL3AudioDriver** (`SDL3AudioDriver.cpp`):
- `startCapture(maxDurationMs)` creates `CaptureBuffer`, opens SDL3 recording stream (mono float, matching playback sample rate)
- `recordingStreamCallback()` feeds `CaptureBuffer::appendSamples()`

**ASIOAudioDriver** (`ASIOAudioDriver.cpp`):
- `startCapture(maxDurationMs)` creates `CaptureBuffer`
- ASIO callback supplies mono data via `appendSamplesInt32()` with bit-depth conversion

**AudioDriverInterface** (`AudioDriverInterface.h`):
- Abstract base: `startCapture()`, `stopCapture()`, `isCapturing()`, `setInputDevice()`, `listInputDevices()`

### 3.4 Semi-Offline Mode (Pianoid class)

| Method | Description |
|--------|-------------|
| `stopEngineKeepAudio()` | Stops OnlinePlaybackEngine loop; audio driver callbacks continue |
| `executeSingleMeasurementCycle()` | Runs exactly one synthesis cycle synchronously |
| `restartOnlineEngine()` | Resumes normal event-driven loop |

All exposed via pybind11 in `AddArraysWithCUDA.cpp`.

---

## 4. Measurement Timing

Frequency-dependent settling and capture windows, configurable via `TimingBandEditor` UI:

| Band | Freq Threshold | Settling | Skip (attack) | Window (measure) | Total |
|------|---------------|---------|---------------|-------------------|-------|
| Low (< C3) | 131 Hz | 500 ms | 100 ms | 300 ms | ~1000 ms |
| Mid (C3-C5) | 523 Hz | 300 ms | 50 ms | 200 ms | ~650 ms |
| High (> C5) | 99999 Hz | 150 ms | 30 ms | 150 ms | ~430 ms |

All timing converted to exact cycle counts via `ms_to_cycles()`. No `time.sleep` anywhere in the measurement path.

### Single Measurement Sequence (`_measure_once`)

1. `reset()` — cut previous note tail
2. Run settling cycles synchronously (frequency-dependent)
3. Measure ambient noise: capture brief silence, analyze RMS (no fundamental)
4. `startMicCapture(duration_ms)` + `startSynthesisCapture()` — begin dual recording
5. `beginStringBatch()` / `addStringToBatch()` / `commitStringBatch()` — excite strings
6. Run measurement cycles:
   - First `CLIPPING_PROBE_CYCLES` (10 cycles, ~13 ms) to sample synthesis peak
   - Remaining cycles until `skip_ms + window_ms + 100` elapsed
7. `stopMicCapture()` -> mic samples; `stopSynthesisCapture()` -> synthesis samples
8. `analyzeCapturedAudioWithReference(mic, ref, sampleRate, freq, skipMs, windowMs)` -> `MicMeasurement`
9. Ambient noise correction: `rms = sqrt(max(0, rms^2 - ambient_rms^2))`
10. `reset()` — cut this note's tail

**Timing is unified**: Python passes `skipMs`/`windowMs` from its configurable timing bands to C++. The C++ defaults are used only when Python omits them (backward compatibility).

---

## 5. Calibration Algorithms

### 5.1 Bisection Search

Binary search on volume coefficient (monotonic volume-to-dB relationship):

**Constants:**
- `BISECTION_MAX_ITERATIONS = 20`
- `BISECTION_TOLERANCE_DB = 0.2`
- `BISECTION_BRACKET_FACTOR = 4.0`
- Coefficient range: `[0.001, 50.0]`

**Algorithm:**
1. Measure current coefficient -> dB
2. If within tolerance, return immediately
3. Establish bracket `[lo, hi]` by probing at 4x multiplier steps (up to 8 probes)
4. Bisect: `mid = (lo + hi) / 2`, measure, adjust bracket
   - Clipping forces hi bracket down
   - Convergence: `|measured - target| <= 0.2 dB`
   - Early exit if bracket width exhausted (`(hi - lo) / lo < 1e-6`)

**Convergence:** typically 5-10 iterations for the full 50,000:1 coefficient range.

### 5.2 Noise Floor Detection

When `spectralEnergy / rms < 0.15` (signal buried in broadband noise):
- Boost excitation coefficient by 2x per step
- Max 5 iterations, cap at coefficient = 20.0
- Re-measure after each boost until spectral ratio clears threshold
- Absolute minimum: `rms < 1e-5` always fails

### 5.3 Clipping Detection

Before each measurement:
- Sample synthesis peak during attack phase (first 10 cycles)
- `estimated_sint32 = synthesis_peak * main_volume_coefficient`
- If `estimated_sint32 > 0.9 * Sint32_MAX` (~1.93e9), mark as clipping
- Clipping forces bisection hi bracket down

### 5.4 ISO 226 Perception Compensation

Frequency/level-dependent target adjustment applied before bisection:

| Parameter | Value | Effect |
|-----------|-------|--------|
| `ISO226_LOW_FREQ_BOOST` | 1.4 | Boost below knee |
| `ISO226_LOW_FREQ_KNEE` | log10(~398 Hz) | Transition point |
| `ISO226_HIGH_FREQ_CUT` | 0.15 | Cut above knee |
| `ISO226_HIGH_FREQ_KNEE` | log10(~1585 Hz) | Transition point |
| `ISO226_LEVEL_DECAY` | 0.15 | Stronger compensation at quiet levels |

Result: low C at pp gets +3.5 dB target boost; high C at ff gets ~0 adjustment.

---

## 6. 4-Phase Calibration Pipeline

| Phase | Description | Status |
|-------|-------------|--------|
| 1. Persistence | Calibration data saved/loaded from preset JSON (`_calibration_data`) | Done |
| 2. 6 velocity levels | Calibrates across `[0, 5, 31, 63, 95, 127]` per pitch | Done |
| 3. Level multipliers | Per-velocity global scaling (6-element array, editable from UI) | Done |
| 4. ISO 226 curves | Frequency-dependent perception compensation, drag-to-paint editor | Done |

---

## 7. Modal Adapter Integration

### 7.1 Architecture

```
RoomResponse ESPRIT pipeline
       |
  modal_adapter/ (pianoid_middleware)
       |-- modal_adapter.py    State machine: IDLE->LOADED->MAPPED->RUNNING->RESULTS->APPLIED
       |-- esprit_runner.py    Multi-band ESPRIT, cross-point mode clustering
       |-- preset_injector.py  Incremental or full preset injection
       |-- mapping.py          MappingConfig: excitation->pitch, channel->sound
       |-- routes.py           9 REST endpoints under /modal/*
```

### 7.2 REST Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/modal/load_folder` | POST | Load .npy or RoomResponse scenario folders |
| `/modal/upload_measurements` | POST | Upload multi-file measurement arrays |
| `/modal/measurement_info` | GET | Query loaded measurement metadata |
| `/modal/mapping` | POST | Define excitation-to-pitch and channel-to-sound mappings |
| `/modal/run_esprit` | POST | Launch background ESPRIT extraction |
| `/modal/status` | GET | Poll extraction progress |
| `/modal/results` | GET | Retrieve frequencies, damping, mode shapes |
| `/modal/apply_to_preset` | POST | Inject modes into active preset |
| `/modal/cancel` | POST | Cancel running extraction |

### 7.3 Processing Pipeline

**Per excitation point:**
1. Load multi-channel IR `(T, n_channels)`
2. Frequency band decomposition (4 bands: 30-200, 150-500, 400-1500, 1200-5000 Hz)
3. ESPRIT per band with model order 10-100
4. Cross-band deduplication (2% frequency tolerance)
5. Return merged `ModalParameters`

**Cross-point clustering:** aggregate modes across all excitation points by frequency.

### 7.4 Parameter Conversion

| ESPRIT Output | Pianoid Input | Conversion |
|---------------|---------------|------------|
| `frequencies[k]` (Hz) | `Piano_mode.frequency` (Hz) | Direct |
| `damping_ratios[k]` (zeta) | `Piano_mode.decrement` | `2*pi*zeta / sqrt(1 - zeta^2)` |
| `mode_shapes[k, ch]` (complex) | `Pitch.deck['feedin']` (real) | `Re(phi)` after phase normalization |

### 7.5 Preset Application Modes

| Mode | Trigger | Action |
|------|---------|--------|
| Incremental | Same mode count | Update via `ParameterManager`, per-pitch deck upload |
| Full reload | Mode count mismatch | Generate JSON in temp dir, load via `/preset/load` |

### 7.6 Frontend

| Component | Purpose |
|-----------|---------|
| `ModalAdapter.jsx` | 6-step stepper wizard (load -> map -> configure -> run -> review -> apply) |
| `ModalResultsView.jsx` | Results table, mode shapes heatmap, singular value plot |
| `useModalAdapter.js` | React hook: state management, API calls, progress polling |

### 7.7 Phase Status

| Phase | Deliverables | Status |
|-------|--------------|--------|
| 1. Minimal Viable Integration | Converter, preset generator, CLI | Skeleton done — but feedin uniform, sound channels zeroed |
| 2. Spatial Deck Coupling | Bridge geometry RBF interpolation | Not started |
| 3. Live REST Updates | Incremental mode updates | REST endpoints exist, incremental path works |
| 4. Validation Loop | MAC, spectral error, T60 comparison | Not started |
| 5. Robust Extraction | Multi-band, batch processing | ESPRIT runs but uses naive dedup instead of MAC merging |

Pipeline rebuild planned — see [MODAL_ADAPTER_PIPELINE_PLAN.md](MODAL_ADAPTER_PIPELINE_PLAN.md).

**Reference presets:**
- `presets/IversPond_ESPRIT_128modes.json` (128 modes, base64-encoded deck matrices — has measured feedin)
- `presets/Belarus_ESPRIT_v2.json` (100 modes, uniform feedin — to be replaced)

---

## 8. Calibration REST Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/measure_rms` | POST | Single pitch measurement -> `{rms, peak, spectralEnergy, db}` |
| `/tune_note` | POST | Bisection tune to target dB |
| `/calibrate_volume` | POST | Full keyboard equalization (background, all 6 levels) |
| `/equalize_keyboard` | POST | Relative equalization vs reference pitch |
| `/calibration_status` | GET | Poll progress |
| `/calibration_cancel` | POST | Cancel running calibration |
| `/calibration_params` | GET/POST | Perception curves, timing bands, level multipliers |
| `/mic_devices` | GET | List available input devices |
| `/set_mic_device` | POST | Select mic device |

---

## 9. Frontend Components

### Calibration UI

| Component | Location | Role |
|-----------|----------|------|
| `CalibrationPanel.jsx` | `src/components/` | 3-tab orchestrator: perception curves, timing bands, level multipliers |
| `PerceptionCurveEditor.jsx` | `src/components/` | ECharts drag-to-paint editor for 6 velocity levels; smoothing, copy-to-all |
| `TimingBandEditor.jsx` | `src/components/` | Editable per-band timing parameters with stacked bar visualization |
| `Excitation.jsx` | `src/components/` | Per-note measure RMS, tune to target dB, equalize keyboard with polling |

### Interaction Summary

- **Measure RMS**: single-pitch measurement, displays result in dB
- **Tune Note**: bisection convergence to target dB, shows iterations and convergence status
- **Equalize Keyboard**: background job measuring all pitches relative to reference, 1s polling
- **Perception Curves**: drag-to-paint across 88 keys, per-velocity-level, with smooth and copy-to-all
- **Timing Bands**: inline numeric editing of settle/skip/window per frequency band
- **Level Multipliers**: slider + text field per velocity level (range 0.1-10.0)

---

## 10. Key Design Decisions

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| Capture sync | Lock-free atomics | Real-time safe; no mutex on audio callback |
| Measurement timing | Frequency-dependent bands | Low frequencies need longer settling for accurate RMS |
| Spectral energy | Goertzel at fundamental + harmonics 2-6 | Consistent across all frequencies; includes harmonic energy; O(N) per harmonic |
| Reference signal | Goertzel on synthesis output | Compensates speaker/room/mic response automatically |
| DC removal | Mean subtraction on measurement window | Prevents DC offset from corrupting RMS and Goertzel |
| Ambient noise | Pre-excitation RMS, power subtraction | Removes background noise contribution from measurement |
| Bisection tolerance | +/-0.2 dB | Matches mic measurement precision; finer adds no value |
| Semi-offline mode | Stop loop, keep driver | Eliminates timing races; synthesis still real-time |
| Noise floor lifting | Adaptive 2x boost, max 5 steps | Empirically effective; caps to prevent runaway |
| Perception curves | ISO 226-inspired formula | Accounts for human hearing sensitivity by frequency and level |
| Clipping detection | Synthesis peak * main_coeff | Full signal path check; formula alone insufficient |
| Modal extraction | Multi-band ESPRIT + clustering | Covers 30-5000 Hz; handles model order uncertainty |
| Preset injection | Incremental or full reload | Avoids restart when mode count matches |

---

## 11. Known Limitations

| Area | Issue | Status |
|------|-------|--------|
| Room noise | Mic captures reflections + background; spectral ratio detection helps but noisy environments degrade accuracy | Mitigated |
| Soundboard transfer function | Exciter-soundboard frequency response varies; per-pitch calibration compensates but cross-coupling may interfere | Acknowledged |
| Spatial deck coupling | Mode shapes interpolated from sparse measurement grid (6-20 points) to 224 strings | Phase 2 planned |
| Validation loop | No automated measure-extract-synthesize-compare pipeline | Phase 4 planned |
| Complex mode shapes | `Re(phi)` taken after phase normalization; high-imaginary modes not flagged | Acknowledged |

---

## 12. File Reference

### C++ (pianoid_cuda)

| File | Role |
|------|------|
| `CaptureBuffer.h` | Lock-free mic capture ring buffer |
| `MicAnalyzer.h` / `.cpp` | RMS, peak, bandpass spectral energy analysis |
| `AudioDriverInterface.h` | Abstract capture/device interface |
| `SDL3AudioDriver.h` / `.cpp` | SDL3 recording stream integration |
| `ASIOAudioDriver.h` / `.cpp` | ASIO input buffer integration |
| `Pianoid.cuh` / `.cu` | Semi-offline methods, capture/analysis orchestration |
| `AddArraysWithCUDA.cpp` | pybind11 bindings for all measurement APIs |

### Python (pianoid_middleware)

| File | Role |
|------|------|
| `calibration_controller.py` | CalibrationController: bisection, noise floor, perception, persistence |
| `backendServer.py` | 9 calibration + 9 modal REST endpoints |
| `modal_adapter/modal_adapter.py` | State machine orchestrator |
| `modal_adapter/esprit_runner.py` | Multi-band ESPRIT wrapper |
| `modal_adapter/preset_injector.py` | Mode injection with damping conversion |
| `modal_adapter/mapping.py` | Measurement geometry configuration |
| `modal_adapter/routes.py` | Flask blueprint for /modal/* endpoints |

### Frontend (PianoidTunner)

| File | Role |
|------|------|
| `src/components/CalibrationPanel.jsx` | 3-tab calibration orchestrator |
| `src/components/PerceptionCurveEditor.jsx` | Drag-to-paint perception curve editor |
| `src/components/TimingBandEditor.jsx` | Measurement timing band editor |
| `src/components/Excitation.jsx` | Per-note measurement and tuning UI |
| `src/modules/ModalAdapter.jsx` | 6-step modal adapter wizard |
| `src/components/ModalResultsView.jsx` | ESPRIT results visualization |
| `src/hooks/useModalAdapter.js` | Modal adapter state/API hook |
