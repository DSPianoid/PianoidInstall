# Audio Driver Guide

**Last Updated:** February 2026
**Status:** Active - Consolidated documentation for all audio drivers

---

## Overview

PianoidCore supports three audio driver backends:

| Driver | Latency | Platform | Use Case |
|--------|---------|----------|----------|
| **SDL3** | ~20ms | Cross-platform | Recommended for most users |
| **SDL2** | ~20ms | Cross-platform | Legacy support only |
| **ASIO** | ~2-5ms | Windows | Professional audio production |

### Key Architecture Principle

**SDL2 and SDL3 cannot coexist in the same binary.** They must be selected at compile time due to symbol conflicts at the linker level. ASIO can coexist with either SDL version.

---

## Quick Start

### Check Current Configuration

```bash
# View build config
type pianoid_cuda\build_config.json
```

Look for `"audio_driver"` and `"default_audio_driver"` fields.

### Switch Audio Drivers

1. Edit `pianoid_cuda/build_config.json`:
   ```json
   {
     "audio_driver": "SDL3",
     "default_audio_driver": "SDL3"
   }
   ```

2. Rebuild:
   ```cmd
   build_pianoid_cuda.bat --heavy
   ```

---

## Driver Details

### SDL3 (Recommended)

**Status:** Recommended for production
**Latency:** ~20ms total (10ms buffer + 10ms SDL3 internal)

**Advantages:**
- Reliable stop/restart behavior
- Clean shutdown without hangs
- Modern stream-based API
- Active development and support

**Configuration:**
```json
{
  "audio_driver": "SDL3",
  "default_audio_driver": "SDL3",
  "sdl3_root": "C:\\SDL3-3.1.6"
}
```

For detailed SDL3 setup, see [SDL3_USAGE_GUIDE.md](SDL3_USAGE_GUIDE.md).

### SDL2 (Legacy)

**Status:** Legacy, not recommended
**Latency:** ~20ms

**Known Issues:**
- Audio callbacks may stop after device restart
- Cleanup functions can hang during shutdown
- Internal state corruption after stop/restart cycles

**Use only for:** Backward compatibility with existing SDL2 ecosystems.

### ASIO (Professional)

**Status:** Active for professional use
**Latency:** ~2-5ms (depends on hardware)

**Requirements:**
- Windows only
- ASIO-compatible audio interface (or ASIO4ALL)
- `samples_in_cycle` MUST equal 64 (ASIO buffer size)

**Configuration:**
```python
# Python initialization for ASIO
pianoid_instance = initialize(
    preset_file,
    samples_in_cycle=64,     # MUST match ASIO BUFFER_SIZE
    sample_rate=48000,
    buffer_size=8,           # Circular buffer chunks
    audio_driver_type=1,     # 1=ASIO, 4=ASIO_CALLBACK
    audio_on=True
)
```

For detailed ASIO configuration, see [ASIO_AUDIO_DRIVER_GUIDE.md](../technical-notes/ASIO_AUDIO_DRIVER_GUIDE.md).

---

## Circular Buffer

All drivers use a lock-free circular buffer for GPU-to-audio data transfer.

### Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `circular_buffer_chunks` | 8 | Buffer depth (chunks) |
| `segment_length` | 64 | Samples per chunk |

**Latency Formula:**
```
Buffer latency = chunks × segment_length × (1000 / sample_rate) ms

Example at 48kHz:
8 chunks × 64 samples × (1000/48000) = 10.67ms
```

### Thread Safety

The circular buffer uses `std::atomic` with proper memory ordering:

```cpp
std::atomic<int> write_position;  // Producer writes
std::atomic<int> read_position;   // Consumer reads

// Producer uses release semantics
write_position.store(pos + 1, std::memory_order_release);

// Consumer uses acquire semantics
int wp = write_position.load(std::memory_order_acquire);
```

This ensures correct visibility between the synthesis thread (producer) and audio callback (consumer).

---

## Runtime vs Compile-Time Selection

### Compile-Time (SDL2 vs SDL3)

SDL2 and SDL3 **require recompilation** to switch:

```json
// For SDL3 (recommended)
{ "default_audio_driver": "SDL3" }

// For SDL2 (legacy)
{ "default_audio_driver": "SDL2" }
```

### Runtime (SDL vs ASIO)

Within a build, you can switch between SDL and ASIO at runtime:

```python
import pianoidCuda

# Use default driver
config = AudioConfig(sample_rate, buffer_size, num_channels, mode_iteration, -1)

# Request specific driver
config = AudioConfig(
    sample_rate, buffer_size, num_channels, mode_iteration,
    pianoidCuda.AudioDriverType.ASIO  # or SDL3, SDL2
)
```

### REST API / GUI Selection

Use `audio_driver_type` parameter in preset loading:

```json
{
  "path": "presets/Preset_test5.json",
  "audio_driver_type": 2  // 1=ASIO, 2=SDL (auto-detect), 4=ASIO_CALLBACK
}
```

**GUI Options:**
| Value | Label | Description |
|-------|-------|-------------|
| 1 | ASIO (Spin-wait) | ASIO with spin-wait polling |
| 2 | SDL | Auto-detects SDL2 or SDL3 based on build |
| 4 | ASIO Callback (Recommended) | ASIO with callback mode |

The SDL option automatically detects which SDL version was compiled into the binary using `pianoidCuda.isDriverAvailable()`.

---

## Performance Comparison

| Driver | Buffer Latency | Total Latency | CPU Usage | Restart Reliability |
|--------|----------------|---------------|-----------|---------------------|
| SDL2   | ~10ms          | ~20ms         | Low       | Poor                |
| SDL3   | ~10ms          | ~20ms         | Low       | Excellent           |
| ASIO   | ~1-3ms         | ~2-5ms        | Very Low  | Excellent           |

**Notes:**
- SDL latency includes internal SDL buffering
- ASIO latency depends on audio interface hardware
- All values at 48kHz, 64-sample buffer

---

## Troubleshooting

### "SDL3 driver requested but headers not included"

**Cause:** Application requested SDL3 but build was configured for SDL2.

**Solution:** Rebuild with SDL3:
```cmd
# Edit pianoid_cuda/build_config.json
# Set "default_audio_driver": "SDL3"
build_pianoid_cuda.bat --heavy
```

### Audio Distorted or Clicks/Pops

**Possible causes:**
1. **Buffer underruns** - Increase `circular_buffer_chunks` (try 8 or 16)
2. **Race condition** - Ensure using latest code with atomic circular buffer
3. **ASIO size mismatch** - Set `samples_in_cycle=64` for ASIO

### Audio at Wrong Pitch (ASIO)

**Cause:** `samples_in_cycle` doesn't match ASIO `BUFFER_SIZE` (64)

**Solution:** Always set `samples_in_cycle=64` when using ASIO.

### No Sound After Restart

**SDL2:** Known bug - switch to SDL3
**SDL3:** Check console for "SDL3 audio push thread started"
**ASIO:** Verify circular buffer was reset on restart

---

## File Reference

| File | Purpose |
|------|---------|
| `pianoid_cuda/AudioDriverInterface.h` | Abstract driver interface |
| `pianoid_cuda/SDL3AudioDriver.cpp/h` | SDL3 implementation |
| `pianoid_cuda/SDLAudioDriver.cpp/h` | SDL2 implementation |
| `pianoid_cuda/ASIOAudioDriver.cpp/h` | ASIO implementation |
| `pianoid_cuda/AudioDriverFactory.cpp/h` | Driver factory |
| `pianoid_cuda/CircularBuffer.cuh/cu` | Lock-free circular buffer |
| `pianoid_cuda/build_config.json` | Build configuration |

---

## Related Documentation

- [SDL3_USAGE_GUIDE.md](SDL3_USAGE_GUIDE.md) - SDL3 installation and setup
- [SDL3_BUILD_INSTRUCTIONS.md](SDL3_BUILD_INSTRUCTIONS.md) - Building with SDL3
- [ASIO_AUDIO_DRIVER_GUIDE.md](../technical-notes/ASIO_AUDIO_DRIVER_GUIDE.md) - ASIO technical details
- [SINEWAVE_GENERATOR_GUIDE.md](SINEWAVE_GENERATOR_GUIDE.md) - Audio driver testing

---

## Version History

| Date | Change |
|------|--------|
| Oct 2025 | Initial audio driver architecture |
| Jan 2026 | ASIO debugging and fixes |
| Feb 2026 | SDL3 integration, circular buffer atomic fix |
| Feb 2026 | Consolidated documentation |
| Feb 2026 | Unified SDL option with auto-detection (SDL2/SDL3 based on build) |
