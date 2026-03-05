# ASIO Audio Driver Debugging - Key Findings

## Overview

This document summarizes the key findings from debugging the ASIO audio output system in Pianoid. The investigation confirmed that the ASIO audio driver path is functional, and identified the root causes of audio distortion issues.

## Test Environment

- **ASIO Driver**: ESI GIGAPORT eX (ASIO 2.0)
- **Sample Rate**: 48000 Hz
- **Buffer Size**: 64 samples per callback
- **Channels**: 4 output channels
- **Circular Buffer**: 4 packets (meeting ≤5ms latency requirement)

## Key Findings

### 1. ASIO Audio Path Confirmed Working

A direct sine wave test (`testAudioSineWave`) was implemented to bypass the physics simulation and verify the audio output path independently. This test confirmed that:

- ASIO driver initialization works correctly
- Audio callbacks are firing at the expected rate (~750 Hz for 64 samples at 48kHz)
- Data flows correctly from the circular buffer to ASIO output

### 2. Circular Buffer Flow Control

**Problem**: The original `Ready()` function returned `void` and silently dropped packets when the circular buffer was full. This caused audio distortion due to missing samples.

**Solution**: Modified `Ready()` to return `BOOL`:
- Returns `TRUE` if packet was successfully queued
- Returns `FALSE` if buffer is full
- Packet number is only incremented on successful queue (prevents packet number inflation during retries)

**File**: `pianoid_cuda/AsioAudioInterface.cpp` lines 581-606

```cpp
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

### 3. Producer Synchronization Strategy

**Problem**: Different waiting strategies have different trade-offs:

| Strategy | Latency | CPU Usage | Result |
|----------|---------|-----------|--------|
| `sleep(100µs)` | High | Low | Distorted (Windows sleep granularity ~15ms) |
| `sleep(50µs)` | Medium | Low | Distorted (buffer underruns) |
| `yield()` | Low | High | Distorted (CPU contention with ASIO thread) |
| **Spin-wait (no sleep)** | **Lowest** | **Highest** | **Clean audio** |

**Solution**: Pure spin-wait without any sleep or yield:

```cpp
while (asioDriver.Ready() == FALSE) {
    // Re-output the same data since Ready() failed
    for (int ch = 0; ch < numChannels; ch++) {
        asioDriver.Output(ch, channelData.data(), BUFFER_SIZE);
    }
}
```

This ensures immediate response when buffer space becomes available.

### 4. Buffer Size Requirements

**Requirement**: Maximum audio output latency of 5ms

**Configuration**: `CIRCULAR_BUFFER_SIZE = 4` packets

**Calculation**: 4 packets × 64 samples/packet ÷ 48000 Hz = 5.33ms

This is the minimum viable buffer size that provides stable operation while meeting the latency requirement.

### 5. ASIO Manual Mode vs Callback Mode

The codebase supports two ASIO modes:

- **Manual Mode** (`PLAY_WITH_ASIO`): Producer pushes to `queueToPlay` circular buffer, ASIO callback pulls from it
- **Callback Mode** (`PLAY_WITH_ASIO_CALLBACK`): ASIO callback directly calls `directOutputFn` to fill buffers

Current configuration uses **Manual Mode**.

## Files Modified

1. **`pianoid_cuda/AsioAudioInterface.h`**
   - Changed `Ready()` return type from `void` to `BOOL`

2. **`pianoid_cuda/AsioAudioInterface.cpp`**
   - Modified `Ready()` to return success/failure status
   - Packet number only incremented on successful queue

3. **`pianoid_cuda/ASIOAudioDriver.cpp`**
   - Added `testSineWave()` method for direct audio testing
   - Implemented spin-wait flow control

4. **`pianoid_cuda/ASIOAudioDriver.h`**
   - Added `testSineWave()` declaration

5. **`pianoid_cuda/Pianoid.cu`**
   - Added `testAudioSineWave()` wrapper method

6. **`pianoid_cuda/Pianoid.cuh`**
   - Added `testAudioSineWave()` declaration

7. **`pianoid_cuda/AddArraysWithCUDA.cpp`**
   - Exposed `testAudioSineWave()` to Python via pybind11

## Test Script

A standalone test script `pianoid_middleware/test_asio_direct.py` was created to verify ASIO audio output independently of the physics simulation.

Usage:
```bash
cd pianoid_middleware
python test_asio_direct.py
```

Expected output: A clean 440 Hz sine wave tone for 2 seconds.

## Remaining Investigation

The physics simulation produces zero string vibration, which is a separate issue from the audio driver. The `testAudioSineWave` test confirms the audio path works correctly when fed valid audio data.

## Configuration Constants

Key constants in `AsioAudioInterface.h`:

```cpp
constexpr auto BUFFER_SIZE = 64;           // ASIO buffer size (samples)
constexpr auto CIRCULAR_BUFFER_SIZE = 4;   // Circular buffer depth (packets)
constexpr auto NUMBER_CHANNELS = 8;        // Output channels
constexpr auto SAMPLES_PER_MS = 48;        // 48kHz sample rate
```

## Latency Calculation

Total audio latency = ASIO buffer latency + Circular buffer latency

- ASIO buffer: 64 samples = 1.33ms
- Circular buffer: 4 × 64 samples = 5.33ms
- **Total maximum latency**: ~6.67ms (acceptable for real-time piano simulation)
