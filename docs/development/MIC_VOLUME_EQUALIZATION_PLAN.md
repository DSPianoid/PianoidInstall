# Microphone-Based Volume Equalization — Implementation Plan

**Status:** Implemented. Verified 2026-03-31.
**Date:** 2026-03-31

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

The per-string `volume_coeff` array (`dev_volume_coeff`, 256 reals in `gaussKernel`) is a hidden scaling factor with no frontend editor. It must be deprecated.

**Current usage:**
- `gaussKernel` (`gaussTest.cu:50,92`): `result *= volume_coefficient`
- Updated via `setUpdatedParameters()`, `loadPresetToLibrary()`, `updateSingleStringParameter_NEW()`
- Stored in `PresetParameters.h:47`: `real volume_coefficients[NUM_STRINGS]`

**Migration path:**
1. Fold existing `volume_coeff` values into the excitation parameters (`ExcitationParameters.volume_coefficients[level_idx]`) so the effect is preserved
2. Set all `volume_coeff[i] = 1.0` (neutral)
3. Remove `volume_coeff` multiplication from `gaussKernel`
4. Remove `volume_coeff` from preset packing/unpacking
5. All future volume adjustments go through excitation parameters, which are editable in the frontend

**This migration must happen before the mic equalization work.**

## Architecture

```
Mic Input
   |
   v
[Audio Hardware]
   |
   +--- SDL3: SDL_OpenAudioDeviceStream(RECORDING) --> recordingCallback()
   +--- ASIO: bufferSwitchTimeInfo() reads input buffers (already allocated)
   |
   v
CaptureBuffer (host std::vector<float>, sequential write)
   |
   v
stopCapture() returns samples
   |
   v
MicAnalyzer::analyze(samples, sampleRate, freqHz)
   - Skip attack transient (frequency-dependent)
   - Windowed RMS measurement
   - Optional bandpass around fundamental
   |
   v
Compute correction coefficient
   |
   v
Apply to ExcitationParameters.volume_coefficients[level_idx]
   |
   v
Upload via setNewExcitationBaseLevels() (double-buffer swap)
```

## Measurement Timing

Short windows are sufficient since we only need RMS energy, not full decay analysis.

| Frequency Range | Skip (attack) | Window (measure) | Total per note |
|-----------------|---------------|-------------------|----------------|
| Low (A0–C3)    | 100 ms        | 300 ms            | ~500 ms        |
| Mid (C3–C5)    | 50 ms         | 200 ms            | ~350 ms        |
| High (C5–C8)   | 30 ms         | 150 ms            | ~280 ms        |

**Estimated total calibration time:** 88 pitches x 5 velocities x ~400ms avg = ~3 minutes

## New C++ Components

### CaptureBuffer (`CaptureBuffer.h`)

Simple host-memory sequential buffer. Not GPU-aware.

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

CPU-only signal analysis.

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
    // ... existing methods ...

    // Mic capture (optional, default throws)
    virtual void startCapture(int maxDurationMs = 5000) { throw ...; }
    virtual std::vector<float> stopCapture() { throw ...; }
    virtual bool isCapturing() const { return false; }

    // Mic device selection
    virtual void setInputDevice(const std::string& deviceName) {}
    virtual std::vector<std::string> listInputDevices() { return {}; }
};
```

### SDL3 Recording Implementation

1. Open `SDL_AUDIO_DEVICE_DEFAULT_RECORDING` (or named device) as second stream
2. Recording callback writes to `CaptureBuffer`
3. Separate from playback stream — both run simultaneously
4. Device enumeration via `SDL_GetAudioRecordingDevices()`

### ASIO Recording Implementation

1. Input buffers already allocated in `create_asio_buffers()` (indices 0..inputChannels-1)
2. Currently skipped in `bufferSwitchTimeInfo()` (`isInput == FALSE` guard)
3. When `capturing`, read input buffer data and append to `CaptureBuffer`
4. Zero overhead when not capturing (just an `if (capturing)` check)
5. ASIO input device = same hardware as output (no separate device selection)

### Pianoid Class Extensions

```cpp
class Pianoid {
    // ... existing ...
    void startMicCapture(int maxDurationMs);
    std::vector<float> stopMicCapture();
    MicMeasurement analyzeCapturedAudio(
        const std::vector<float>& samples, int sampleRate, float freqHz);
    void setMicDevice(const std::string& deviceName);
    std::vector<std::string> listMicDevices();
};
```

### pybind11 Bindings

Expose `startMicCapture`, `stopMicCapture`, `analyzeCapturedAudio`, `setMicDevice`, `listMicDevices` to Python.

## Calibration Workflow

```
POST /calibrate_volume { velocity_levels: [0,1,2,3,4], pitches: "all" }

For each velocity_level V in requested levels:
  For each pitch P in [21..108]:
    1. startMicCapture(skip_ms + window_ms + margin)
    2. playNote(P, velocity_for_level[V])
    3. wait(skip_ms + window_ms + margin)
    4. samples = stopMicCapture()
    5. measurement = analyzeCapturedAudio(samples, 48000, freq[P])
    6. correction = target_rms(freq[P], V) / measurement.rms
    7. correction = clamp(correction, 0.1, 10.0)
    8. Update excitation volume_coefficients[V] for pitch P

After all pitches measured:
  Upload via setNewExcitationBaseLevels() (bulk double-buffer swap)

Optional verification pass:
  Re-measure a subset of pitches, report convergence
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `pianoid_cuda/CaptureBuffer.h` | Create | Host-memory capture buffer |
| `pianoid_cuda/MicAnalyzer.h` | Create | Analysis header |
| `pianoid_cuda/MicAnalyzer.cpp` | Create | RMS/spectral analysis |
| `pianoid_cuda/AudioDriverInterface.h` | Modify | Add capture + device selection methods |
| `pianoid_cuda/SDL3AudioDriver.h` | Modify | Add recording stream, CaptureBuffer |
| `pianoid_cuda/SDL3AudioDriver.cpp` | Modify | Implement SDL3 recording |
| `pianoid_cuda/ASIOAudioDriver.h` | Modify | Add CaptureBuffer |
| `pianoid_cuda/ASIOAudioDriver.cpp` | Modify | Read input buffers when capturing |
| `pianoid_cuda/AsioAudioInterface.h` | Modify | Expose input buffer pointers |
| `pianoid_cuda/AsioAudioInterface.cpp` | Modify | Pass input data to callback |
| `pianoid_cuda/Pianoid.cuh` | Modify | Capture/analysis method declarations |
| `pianoid_cuda/Pianoid.cu` | Modify | Implement capture/analysis |
| `pianoid_cuda/AddArraysWithCUDA.cpp` | Modify | pybind11 bindings |
| `pianoid_cuda/setup.py` | Modify | Add MicAnalyzer.cpp to sources |
| `pianoid_middleware/calibration_controller.py` | Create | REST orchestration |
| `pianoid_middleware/backendServer.py` | Modify | Register calibration endpoint |

## Risks and Open Questions

1. **ASIO input channel mapping:** The ESI GIGAPORT eX has 2 input channels. Need to confirm which physical input maps to which ASIO buffer index.
2. **Room noise:** Mic captures room reflections + background noise. Bandpass filtering around the fundamental helps, but noisy environments degrade accuracy.
3. **Soundboard transfer function:** The exciter-soundboard system has a frequency-dependent response. Per-pitch calibration compensates for this naturally, but cross-coupling between strings/exciters may cause interference.
4. **Non-linearity:** Correction assumes `output = input * gain`. If the system is nonlinear (especially at high volumes), single-point calibration may not generalize across velocity levels — hence calibrating at all 5 levels.
5. **ASIO callback timing:** Reading input data adds ~256 bytes memcpy to the callback. Trivially fast (< 1 microsecond), no risk of buffer underrun.
