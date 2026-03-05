# Sinewave Generator Guide

**Last Updated:** February 2026
**Status:** Active

---

## Overview

The `SinewaveGenerator` is a GPU-based audio test utility that generates pure sine waves through the audio driver. It provides:

- GPU-accelerated sinewave generation (CUDA kernel)
- Direct audio output via ASIO callback mode
- WAV recording capability
- Comprehensive timing diagnostics

This module is useful for testing and validating the audio driver path independently of the main synthesis engine.

---

## Architecture

### Components

| Component | File | Description |
|-----------|------|-------------|
| `SinewaveGenerator` | `pianoid_cuda/SinewaveGenerator.cu` | Main generator class |
| `SinewaveConfig` | `pianoid_cuda/SinewaveGenerator.h` | Configuration struct |
| `SinewaveResult` | `pianoid_cuda/SinewaveGenerator.h` | Result with stats |
| `sinewaveKernel` | `pianoid_cuda/SinewaveGenerator.cu` | CUDA kernel |

### Data Flow

```
sinewaveKernel (GPU)
    → dev_output_buffer (GPU memory)
    → audioBuffer.produce() (GPU→CPU copy)
    → LockFreeCircularBuffer
    → ASIO callback → audioBuffer.consume()
    → ASIO output buffers
```

---

## Configuration

### SinewaveConfig Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `sample_rate` | int | 48000 | Sample rate in Hz |
| `segment_length` | int | 64 | **MUST match ASIO buffer_size** |
| `num_channels` | int | 8 | Number of output channels |
| `buffer_size` | int | 64 | ASIO buffer size (samples per callback) |
| `circular_buffer_chunks` | int | 4 | Circular buffer depth (2-64, lower = less latency) |
| `frequency` | float | 440.0 | Sine wave frequency (Hz) |
| `amplitude` | float | 0.8 | Amplitude (0.0 to 1.0) |
| `duration_ms` | int | 1000 | Duration in milliseconds |
| `record_to_wav` | bool | false | Enable WAV recording |
| `wav_filename` | string | "" | WAV output filename |
| `log_filename` | string | "" | Log file path |
| `driver_type` | int | -1 | -1 for default, or AudioDriverType |

### Critical Requirements

1. **segment_length MUST equal buffer_size** - Mismatch causes distortion
2. **Uses ASIO_CALLBACK mode** - Automatically converts ASIO to ASIO_CALLBACK
3. **Per-channel blocks format** - Data layout: `[ch0_s0..ch0_sN, ch1_s0..ch1_sN, ...]`

---

## Usage

### Python Example

```python
import pianoidCuda

# Create Pianoid instance (required for testSinewave method)
init_params = pianoidCuda.InitializationParameters()
init_params.sample_rate = 48000
init_params.buffer_size = 64
init_params.mode_iteration = 48
init_params.num_channels = 8
init_params.audio_driver_type = pianoidCuda.ASIO

pianoid = pianoidCuda.Pianoid(strings_in_pitches, init_params)

# Configure sinewave test
config = pianoidCuda.SinewaveConfig()
config.frequency = 440.0      # A4
config.duration_ms = 3000     # 3 seconds
config.amplitude = 0.3
config.sample_rate = 48000
config.segment_length = 64    # MUST match buffer_size
config.num_channels = 8
config.buffer_size = 64
config.circular_buffer_chunks = 4  # 2-64, lower = less latency
config.driver_type = int(pianoidCuda.ASIO_CALLBACK)
config.record_to_wav = True
config.wav_filename = "test_sinewave.wav"

# Run test
result = pianoid.testSinewave(config)

# Check results
print(f"Success: {result.success}")
print(f"Packets: {result.stats.packets_generated}")
print(f"Avg gen time: {result.stats.avg_generation_us:.2f} us")
print(f"Buffer waits: {result.stats.buffer_full_waits}")
print(f"WAV file: {result.wav_file_path}")
```

### Test Script

Use `pianoid_middleware/test_asio_sinewave.py` for quick testing:

```bash
python pianoid_middleware/test_asio_sinewave.py
```

---

## Technical Details

### CUDA Kernel

The sinewave kernel generates samples in **per-channel blocks format**:

```cpp
// Output layout: [ch0_s0..ch0_sN, ch1_s0..ch1_sN, ...]
for (int ch = 0; ch < num_channels; ch++) {
    output[ch * segment_length + s] = int_value;
}
```

This format matches `LockFreeCircularBuffer::consume()` expectations.

### Volume Control

```cpp
constexpr float VOLUME_COEFFICIENT = 0.15f;  // -16.5dB headroom
float sine_value = amplitude * VOLUME_COEFFICIENT * sinf(2*PI * frequency * t);
```

### Circular Buffer Latency

The circular buffer depth is configurable via `circular_buffer_chunks` (default: 4):

```
Latency = circular_buffer_chunks × buffer_size × (1000 / sample_rate) ms

Examples at 48kHz with 64-sample buffer:
- 2 chunks: 2 × 64 × (1000/48000) = 2.67ms
- 4 chunks: 4 × 64 × (1000/48000) = 5.33ms
```

Lower values reduce latency but increase risk of buffer underruns.

---

## Diagnostics

### SinewaveGeneratorStats

| Field | Description |
|-------|-------------|
| `packets_generated` | Total packets sent to audio driver |
| `avg_generation_us` | Average GPU generation time per packet |
| `min_generation_us` | Minimum generation time |
| `max_generation_us` | Maximum generation time |
| `stddev_generation_us` | Standard deviation (Welford's algorithm) |
| `buffer_full_waits` | Count of producer blocking events |
| `total_blocking_us` | Total time waiting on buffer |

### Callback Stats

```
[CALLBACK STATS] count=2248, avg_interval=1335.5us, min=770.0us, max=2226.0us, underruns=0
```

- **count**: Total ASIO callbacks received
- **avg_interval**: Average time between callbacks (~1333us expected at 48kHz/64)
- **underruns**: Buffer empty events (should be 0)

---

## Troubleshooting

### Distortion in Audio Output

**Cause:** `segment_length` doesn't match `buffer_size`

**Solution:** Set `segment_length = buffer_size = 64`

### Wrong Pitch

**Cause:** Data format mismatch (interleaved vs per-channel blocks)

**Solution:** Ensure kernel uses per-channel blocks format

### High Latency

**Cause:** Circular buffer too large

**Solution:** Reduce `circular_buffer_chunks` in SinewaveConfig (minimum: 2)

### Buffer Underruns (Clicks/Pops)

**Cause:** Circular buffer too small for synthesis load

**Solution:** Increase `circular_buffer_chunks` (try 4 or higher)

---

## Files Reference

| File | Description |
|------|-------------|
| `pianoid_cuda/SinewaveGenerator.cu` | GPU implementation |
| `pianoid_cuda/SinewaveGenerator.h` | Class and config definitions |
| `pianoid_cuda/AddArraysWithCUDA.cpp` | Python bindings |
| `pianoid_middleware/test_asio_sinewave.py` | Test script |

---

## Version History

| Date | Change |
|------|--------|
| Feb 2026 | Initial SinewaveGenerator module |
| Feb 2026 | Fixed data format (per-channel blocks) |
| Feb 2026 | Made circular_buffer_chunks configurable (default: 4) |
