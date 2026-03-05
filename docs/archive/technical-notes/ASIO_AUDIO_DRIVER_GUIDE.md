# ASIO Audio Driver Technical Guide

**Last Updated:** February 2026
**Status:** Active - Consolidates all ASIO driver documentation

---

## Overview

Pianoid supports ASIO audio output for low-latency professional audio interfaces. This document consolidates all technical knowledge about the ASIO driver implementation, configuration, and troubleshooting.

---

## Architecture

### Driver Modes

The ASIO driver supports two operation modes:

| Mode | Type Value | Description | Use Case |
|------|------------|-------------|----------|
| **Non-Callback** (Manual) | 1 | Producer pushes to circular buffer; ASIO callback pulls | Testing, recording |
| **Callback** | 4 | ASIO callback directly invokes synthesis | Production playback |

### Class Hierarchy

```
AudioDriverInterface (abstract)
    └── ASIOAudioDriver
            └── AsioAudioOutput (low-level ASIO wrapper)
```

### Key Components

- **ASIOAudioDriver** (`pianoid_cuda/ASIOAudioDriver.cpp`): High-level driver wrapping ASIO
- **AsioAudioOutput** (`pianoid_cuda/AsioAudioInterface.cpp`): Low-level ASIO SDK wrapper
- **LockFreeCircularBuffer** (`pianoid_cuda/CircularBuffer.cuh`): GPU-aware lock-free buffer for audio data

---

## Configuration

### Critical Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| `samples_in_cycle` | **64** | MUST match ASIO BUFFER_SIZE |
| `audio_driver_type` | 1 or 4 | Non-callback (1) or Callback (4) |
| `circular_buffer_chunks` | 2-64 | Circular buffer depth (default: 4) |
| `sample_rate` | 48000 | Sample rate in Hz |

### Constants in Code

```cpp
// AsioAudioInterface.h
constexpr auto BUFFER_SIZE = 64;           // ASIO buffer size (samples)
constexpr auto NUMBER_CHANNELS = 8;        // Max output channels
constexpr auto SAMPLES_PER_MS = 48;        // 48kHz sample rate

// AudioConfig.h - Configurable circular buffer
int circular_buffer_chunks = 4;  // Default: ~5.3ms latency at 48kHz with 64-sample chunks
```

### Python Initialization Example

```python
from pianoid import initialize

pianoid_instance = initialize(
    preset_file,
    filterlen=64 * 128,      # Filter buffer (64 samples × 128)
    samples_in_cycle=64,     # MUST match ASIO BUFFER_SIZE
    sample_rate=48000,
    buffer_size=4,           # Circular buffer packets
    audio_driver_type=1,     # Non-callback mode
    audio_on=True
)
```

---

## Sample Cycle Alignment

### The Problem

If `samples_in_cycle` doesn't match ASIO `BUFFER_SIZE`, audio plays at wrong pitch:

- **Mismatch example:** synthesis=48, ASIO=64 → pitch 33% lower
- **Ratio:** 64/48 = 1.333x stretch

### Technical Details

The ASIO callback always copies exactly `BUFFER_SIZE` samples:

```cpp
// AsioAudioInterface.cpp
memcpy((uint8_t*)asioDriverInfo.bufferInfos[i].buffers[index],
       (uint8_t*)cbElementCB.element[i - asioDriverInfo.inputBuffers].pcmValues,
       buffSize * sizeof(uint32_t));  // buffSize = BUFFER_SIZE = 64
```

### Solution

**Always set `samples_in_cycle = 64` when using ASIO.**

ASIO buffer size must be divisible by 32 (power-of-2 requirement with granularity -1).

---

## Ready() Return Type Fix

### The Problem

The `Ready()` function originally returned `void`, but the driver code expected `BOOL` for flow control:

```cpp
// ASIOAudioDriver.cpp - expected BOOL for spin-wait loop
while (asioDriver.Ready() == FALSE)  // Comparing void to FALSE!
    Sleep(0);
```

### The Fix

Changed `Ready()` to return success/failure status:

```cpp
// AsioAudioInterface.h
BOOL Ready(void);  // Returns TRUE if packet queued, FALSE if buffer full

// AsioAudioInterface.cpp
BOOL AsioAudioOutput::Ready(void)
{
    uint32_t nextPacketNumber = packetNumber + 1;
    cbElementTmp.packetNumber = nextPacketNumber;

    if (queueToPlay.PutCircularBuffer(&cbElementTmp))
    {
        packetNumber = nextPacketNumber;  // Commit only on success
        return TRUE;
    }
    else
    {
        return FALSE;
    }
}
```

---

## Flow Control and Latency

### Buffer Configuration

```
Total audio latency = ASIO buffer + Circular buffer

Formula: circular_buffer_chunks × buffer_size × (1000 / sample_rate) ms

Examples at 48kHz with 64-sample buffer:
- 2 chunks: 2 × 64 × (1000/48000) = 2.67ms (minimum latency)
- 4 chunks: 4 × 64 × (1000/48000) = 5.33ms (default, recommended)
```

### Producer Synchronization Strategies

| Strategy | Latency | CPU Usage | Result |
|----------|---------|-----------|--------|
| `sleep(100µs)` | High | Low | Distorted (Windows sleep granularity ~15ms) |
| `sleep(50µs)` | Medium | Low | Distorted (buffer underruns) |
| `yield()` | Low | High | Distorted (CPU contention) |
| **Spin-wait** | **Lowest** | **Highest** | **Clean audio** |

The driver uses pure spin-wait for best audio quality:

```cpp
while (asioDriver.Ready() == FALSE) {
    // Re-output the same data since Ready() failed
    for (int ch = 0; ch < numChannels; ch++) {
        asioDriver.Output(ch, channelData.data(), BUFFER_SIZE);
    }
}
```

---

## Recording Mechanism

### Audio Data Paths

The synthesis engine maintains several audio buffers:

| Buffer | Content | Volume Applied |
|--------|---------|----------------|
| `dev_soundFloat` | Raw synthesis output | No |
| `dev_soundInt` | Synthesis with volume | Yes |
| `dev_filteredSoundFloat` | FIR filter output | Yes |

### Recording Capture Point

The `getRawSoundRecord()` method captures from `dev_soundFloat`:

- Contains **raw synthesis** before volume coefficient
- When saving to WAV, apply `volume_coeff` manually:

```python
# Apply volume coefficient for WAV export
volume_coeff = pianoid_instance.get_current_volume_coefficient()
scaled_int32 = audio_stereo * volume_coeff
scale_factor = 32767.0 / 2147483647.0
audio_int16 = (scaled_int32 * scale_factor).astype(np.int16)
```

### Volume Coefficient Calculation

```
volume_coeff = max_volume^(volume_level / 127)

Example: max_volume=1e18, volume_level=64 → volume_coeff ≈ 1e9
```

### Non-Callback vs Callback Mode for Recording

| Mode | Recording Status | Notes |
|------|------------------|-------|
| Non-callback (type=1) | **Works** | Records raw synthesis correctly |
| Callback (type=4) | **Issues** | May record zeros; callback timing interferes |

**Recommendation:** Use non-callback mode (type=1) for recording tests.

---

## Testing

### GPU-Based Sinewave Generator

The `SinewaveGenerator` module provides GPU-accelerated sinewave testing via ASIO callback mode:

```python
import pianoidCuda

config = pianoidCuda.SinewaveConfig()
config.frequency = 440.0      # A4
config.duration_ms = 3000     # 3 seconds
config.amplitude = 0.3
config.sample_rate = 48000
config.segment_length = 64    # MUST match buffer_size
config.buffer_size = 64
config.driver_type = int(pianoidCuda.ASIO_CALLBACK)
config.record_to_wav = True
config.wav_filename = "test_sinewave.wav"

result = pianoid.testSinewave(config)
print(f"Underruns: {result.stats.buffer_full_waits}")
```

See [SINEWAVE_GENERATOR_GUIDE.md](SINEWAVE_GENERATOR_GUIDE.md) for full details.

### Online vs Offline Comparison Test

`pianoid_middleware/test_online_vs_recorded.py` performs a three-way comparison:

1. **Online:** Live synthesis through ASIO
2. **Offline ASIO:** Recorded audio via `playRecordedAudio()`
3. **Offline WAV:** Same audio via Windows `winsound`

All three should sound identical if the driver is configured correctly.

### Callback Timing Statistics

```python
stats = pianoid_instance.pianoid.getCallbackStats()
print(f"Avg interval: {stats.avgIntervalMs:.3f}ms")
print(f"Max interval: {stats.maxIntervalMs:.3f}ms")
print(f"Missed callbacks: {stats.missedCallbacks}")
```

---

## Troubleshooting

### Audio Plays at Wrong Pitch

**Cause:** `samples_in_cycle` doesn't match ASIO `BUFFER_SIZE`

**Solution:** Set `samples_in_cycle=64`

### Clicks, Pops, or Distortion

**Possible causes:**
1. Buffer underruns - increase `audio_buffer_size`
2. Wrong `Ready()` return type - ensure using fixed version
3. FIR filter issues - disable filter for testing

### Recording Returns All Zeros (Callback Mode)

**Cause:** Callback mode interferes with recording mechanism

**Solution:** Use non-callback mode (type=1) for recording tests

### CUDA Errors with FIR Filter

**Cause:** `convolutionKernel` has issues with certain buffer configurations

**Workaround:** Disable FIR filter by not calling `setFirFilter()`

---

## Files Reference

| File | Description |
|------|-------------|
| `pianoid_cuda/ASIOAudioDriver.cpp` | High-level ASIO driver |
| `pianoid_cuda/ASIOAudioDriver.h` | Driver header |
| `pianoid_cuda/AsioAudioInterface.cpp` | Low-level ASIO wrapper |
| `pianoid_cuda/AsioAudioInterface.h` | ASIO wrapper header |
| `pianoid_cuda/CircularBuffer.cuh` | Lock-free circular buffer |
| `pianoid_cuda/SinewaveGenerator.cu` | GPU sinewave test generator |
| `pianoid_cuda/SinewaveGenerator.h` | Sinewave generator header |

---

## Related Documentation

- [SINEWAVE_GENERATOR_GUIDE.md](../guides/SINEWAVE_GENERATOR_GUIDE.md) - GPU sinewave test utility
- [ASIO_CALLBACK_READY_FIX.md](../historical/bug-fixes/ASIO_CALLBACK_READY_FIX.md) - Historical bug fix details
- [ASIO_AUDIO_DEBUGGING_FINDINGS.md](../ASIO_AUDIO_DEBUGGING_FINDINGS.md) - Original debugging investigation
- [ASIO_TIMING_FIX.md](../ASIO_TIMING_FIX.md) - Sample cycle alignment fix

---

## Version History

| Date | Change |
|------|--------|
| Jan 2026 | Initial ASIO debugging and sine wave test |
| Jan 2026 | Ready() return type fix |
| Feb 2026 | Sample cycle alignment fix (64 samples) |
| Feb 2026 | Consolidated documentation |
| Feb 2026 | Added SinewaveGenerator module |
| Feb 2026 | Made circular_buffer_chunks configurable (default: 4) |
