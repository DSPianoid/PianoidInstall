# Microphone-Based Volume Equalization

**Status:** Implemented but uncommitted. Precision investigation ongoing.
**Date:** 2026-03-31 (initial), 2026-04-02 (updated)

## Problem

When outputting sound via a real soundboard with exciters, perceived acoustic volume differs from the transmitted digital signal. The current `VolumeTuner` measures only the **digital** output (offline rendering), not the actual acoustic output through hardware. To equalize correctly, the system needs microphone input to measure real-world sound levels.

## Design Goals

1. All audio processing in C++ (no Python-level audio)
2. Support both SDL3 and ASIO audio drivers
3. Mic device: configurable, defaults to system default
4. Calibration at all 5 fixed velocity levels
5. Short measurement windows per pitch (not multi-second)
6. Corrections applied to excitation parameters, not per-string `volume_coeff`

## Prerequisite: Deprecate Per-String `volume_coeff`

**Status:** Partially done (uncommitted).

The per-string `volume_coeff` array (`dev_volume_coeff`, 256 reals in `gaussKernel`) is a hidden scaling factor with no frontend editor. Migration is in progress:

- `volume_coefficient` removed from `PhysicalParameters.set_params` (PianoidBasic)
- `volume_coefficient` path deprecated in `Pitch.update_excitation` (PianoidBasic)
- `_debug_extra_volume_arg` and old volume_coefficients upload path removed from `parameter_manager.py`

Remaining: remove `volume_coeff` multiplication from `gaussKernel` and preset packing.

## Architecture — Semi-Offline Mode (Implemented)

The original plan used online playback with `time.sleep` for measurement timing. The implementation replaced this with a **semi-offline** approach that eliminates all timing races:

```
Python CalibrationController
   |
   | enter_calibration_mode()
   |   └── stopEngineKeepAudio() — stops engine loop, audio driver stays alive
   |
   | For each pitch:
   |   1. reset() — cut previous note tail
   |   2. executeSingleMeasurementCycle() x N — run settling cycles (freq-dependent)
   |   3. startMicCapture(duration_ms) — begin recording
   |   4. beginStringBatch() / addStringToBatch() / commitStringBatch() — excite strings
   |   5. executeSingleMeasurementCycle() x M — run measurement cycles
   |   6. stopMicCapture() → samples
   |   7. analyzeCapturedAudio(samples, sampleRate, freq) → MicMeasurement
   |   8. Compute correction, apply to volume_coefficients, upload to GPU
   |
   | exit_calibration_mode()
   |   └── restartOnlineEngine() — resume normal playback
```

Key C++ additions for semi-offline mode:

| Method | Description |
|--------|-------------|
| `stopEngineKeepAudio()` | Stops engine loop, keeps audio driver alive via `PlaybackConfig.keep_audio_on_stop` |
| `executeSingleMeasurementCycle()` | Runs exactly one synthesis cycle synchronously |
| `restartOnlineEngine()` | Resumes the normal online engine loop |

### Measurement Timing

Frequency-dependent settling and capture windows:

| Frequency Range | Settling delay | Skip (attack) | Window (measure) | Total per note |
|-----------------|---------------|---------------|-------------------|----------------|
| Low (< C3)     | 500 ms        | 100 ms        | 300 ms            | ~1000 ms       |
| Mid (C3–C5)    | 300 ms        | 50 ms         | 200 ms            | ~650 ms        |
| High (> C5)    | 150 ms        | 30 ms         | 150 ms            | ~430 ms        |

All timing is converted to exact cycle counts via `ms_to_cycles()` — no `time.sleep` anywhere.

## C++ Components (Implemented)

### CaptureBuffer, MicAnalyzer, AudioDriver Extensions

As originally planned — `CaptureBuffer` for host-memory sequential capture, `MicAnalyzer` for CPU-only RMS/spectral analysis. Both SDL3 and ASIO recording paths implemented. See the original plan section below for API signatures.

### Pianoid Class Extensions

```cpp
class Pianoid {
    // Semi-offline calibration
    void stopEngineKeepAudio();           // Stop loop, keep audio driver
    void executeSingleMeasurementCycle(); // Run one synthesis cycle synchronously
    void restartOnlineEngine();           // Resume online loop

    // Mic capture and analysis
    void startMicCapture(int maxDurationMs);
    std::vector<float> stopMicCapture();
    MicMeasurement analyzeCapturedAudio(
        const std::vector<float>& samples, int sampleRate, float freqHz);
    void setMicDevice(const std::string& deviceName);
    std::vector<std::string> listMicDevices();

    // String batch excitation (for calibration)
    void beginStringBatch();
    void addStringToBatch(int cudaIdx, int velocity);
    void commitStringBatch();
};
```

All exposed via pybind11 bindings.

## Python Calibration Controller (Implemented)

`pianoid_middleware/calibration_controller.py` — orchestrates the full calibration workflow.

### Core Methods

**`measure_single(pitch, velocity, repetitions=1)`**

Measures RMS for a single pitch. Enters/exits semi-offline mode automatically if not already in calibration mode. With `repetitions > 1`, takes multiple measurements and returns the median for outlier rejection.

Returns: `{rms, peak, spectralEnergy, db, capturedFrames, analyzedFrames}`

**`equalize_keyboard(reference_pitch, velocity, reference_rms=None)`**

Full keyboard equalization relative to a reference pitch. Three-phase process per pitch:

1. **Noise floor detection** — if spectral energy near the fundamental is too low relative to broadband RMS (ratio < 0.15), boost the excitation volume coefficient up to 5 times (2x per boost, max coefficient 20.0) until the signal is above noise.
2. **Initial correction** — compute `reference_rms / measured_rms`, clamp to [0.1, 10.0], apply immediately.
3. **Iterative verification** — re-measure up to 3 times. If error within 20% of reference, stop. Otherwise apply refinement correction (clamped to [0.5, 2.0]).

Runs in a background thread. Progress tracked via `/calibration_status`.

**`tune_single(pitch, velocity, target_db)`**

Iteratively adjusts a single pitch to match a target dB level. Algorithm per iteration:
1. Measure current RMS, convert to dB
2. `correction = 10^((target_db - current_db) / 20)`
3. Multiply volume coefficient by correction, upload to GPU
4. Re-measure

Stops when |error| < 1 dB or after 5 iterations.

### Safety Features

- **Sint32 clipping protection** — before each measurement, checks whether `volume_coeff * main_volume_coefficient` could overflow Sint32 max. Clamps with 90% headroom if needed.
- **Cancellation** — `cancel()` sets `running = False`, checked between pitches during `equalize_keyboard`.

## REST Endpoints (Implemented)

See [REST API Reference](http://localhost:8001/modules/pianoid-middleware/REST_API/#calibration-endpoints) for full endpoint documentation.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/measure_rms` | POST | Measure RMS for a single pitch |
| `/equalize_keyboard` | POST | Start full keyboard equalization (background) |
| `/tune_note` | POST | Iteratively tune a single pitch to target dB |
| `/calibration_status` | GET | Poll calibration progress |
| `/calibration_cancel` | POST | Cancel running equalization |
| `/mic_devices` | GET | List available microphone devices |
| `/set_mic_device` | POST | Select microphone input device |

## Frontend UI (Implemented)

`PianoidTunner/src/Excitation.jsx` (+233 lines):

- **Measure RMS** button — calls `/measure_rms` for the selected pitch, displays result in dB
- **Target dB** input + **Tune Note** button — calls `/tune_note` with iterative convergence
- **Equalize Keyboard** button — calls `/equalize_keyboard`, polls `/calibration_status` for progress, supports cancel

## Known Issues and Precision Investigation

### Non-Linear Volume/Multiplier Relationship

User testing revealed that the volume-to-multiplier relationship is monotonic but **non-linear**. The current correction algorithm assumes linearity (`correction = target / measured`), which causes:

- Good convergence at medium volume levels
- Poor precision at low volume levels (small coefficient changes produce disproportionate dB changes)
- `tune_single` may oscillate instead of converging

**Root cause:** The CUDA synthesis path has multiple non-linear stages (excitation curve shape, mode force computation, output scaling). A simple linear gain correction does not model the actual transfer function.

**Needed:** A better descent algorithm where tuning precision matches measurement precision — potentially logarithmic stepping or binary search in dB domain.

### Other Issues

| Issue | Status |
|-------|--------|
| `MEASURE_REPETITIONS = 1` (outlier rejection disabled) | Implemented but disabled for speed |
| Single velocity level per session | Only velocity parameter used; 5-level sweep not wired |
| No persistence to preset file | Corrections lost on restart |

## Original Plan — C++ API Signatures

<details>
<summary>Click to expand original C++ component designs</summary>

### CaptureBuffer (`CaptureBuffer.h`)

```cpp
class CaptureBuffer {
    std::vector<float> buffer;
    std::atomic<size_t> writePos{0};
    std::atomic<bool> capturing{false};
    int numChannels;
public:
    CaptureBuffer(int maxDurationMs, int sampleRate, int channels);
    void startCapture();
    void appendSamples(const int32_t* data, size_t numFrames);
    std::vector<float> stopAndRetrieve();
    bool isCapturing() const;
};
```

### MicAnalyzer (`MicAnalyzer.h` / `MicAnalyzer.cpp`)

```cpp
struct MicMeasurement {
    float rms;
    float peak;
    float spectralEnergy;  // Energy near fundamental
};

class MicAnalyzer {
public:
    static MicMeasurement analyze(
        const std::vector<float>& samples,
        int sampleRate,
        float fundamentalFreqHz,
        int skipMs,
        int windowMs
    );
};
```

### AudioDriverInterface Changes

```cpp
class AudioDriverInterface {
public:
    virtual void startCapture(int maxDurationMs = 5000) { throw ...; }
    virtual std::vector<float> stopCapture() { throw ...; }
    virtual bool isCapturing() const { return false; }
    virtual void setInputDevice(const std::string& deviceName) {}
    virtual std::vector<std::string> listInputDevices() { return {}; }
};
```

</details>

## Files Created/Modified

| File | Action | Description |
|------|--------|-------------|
| `pianoid_cuda/CaptureBuffer.h` | Created | Host-memory capture buffer |
| `pianoid_cuda/MicAnalyzer.h` | Created | Analysis header |
| `pianoid_cuda/MicAnalyzer.cpp` | Created | RMS/spectral analysis |
| `pianoid_cuda/AudioDriverInterface.h` | Modified | Capture + device selection methods |
| `pianoid_cuda/SDL3AudioDriver.h/.cpp` | Modified | SDL3 recording stream |
| `pianoid_cuda/ASIOAudioDriver.h/.cpp` | Modified | ASIO input buffer reading |
| `pianoid_cuda/Pianoid.cuh/.cu` | Modified | Semi-offline methods + capture/analysis |
| `pianoid_cuda/AddArraysWithCUDA.cpp` | Modified | pybind11 bindings for all new methods |
| `pianoid_middleware/calibration_controller.py` | Created | CalibrationController with 3 calibration modes |
| `pianoid_middleware/backendServer.py` | Modified | 7 new REST endpoints |
| `pianoid_middleware/parameter_manager.py` | Modified | Removed legacy volume_coefficients path |
| `PianoidBasic/PhysicalParameters.py` | Modified | Removed volume_coefficient from set_params |
| `PianoidBasic/Pitch.py` | Modified | Deprecated volume_coefficient update path |
| `PianoidTunner/src/Excitation.jsx` | Modified | Calibration UI (+233 lines) |

## Risks and Open Questions

1. **Non-linear transfer function** — the biggest open issue. Linear correction does not converge well at low volumes. Needs logarithmic or binary-search approach.
2. **Room noise** — mic captures room reflections + background noise. Spectral-ratio noise detection helps, but noisy environments degrade accuracy.
3. **Soundboard transfer function** — the exciter-soundboard system has a frequency-dependent response. Per-pitch calibration compensates naturally, but cross-coupling between strings/exciters may cause interference.
4. **No persistence** — corrections are not saved to the preset file. A restart loses all calibration work.
5. **Single velocity level** — only one velocity level is calibrated per session. The 5-level sweep from the original plan is not yet wired into the UI or the equalize_keyboard endpoint.
