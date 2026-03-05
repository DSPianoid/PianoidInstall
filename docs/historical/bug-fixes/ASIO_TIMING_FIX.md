# ASIO Audio Timing Fix - Sample Cycle Alignment

## Issue Summary

Online ASIO playback produced audio at a lower pitch compared to offline playback (WAV file). The ratio of playback durations was approximately 4.08/3.05 ≈ 1.33, which corresponds exactly to 64/48.

## Root Cause

**Mismatch between synthesis cycle size and ASIO buffer size:**

- **Synthesis cycle (mode_iteration)**: 48 samples per cycle
- **ASIO BUFFER_SIZE**: 64 samples (hardcoded constant in `AsioAudioInterface.h`)

The ASIO callback always copies `BUFFER_SIZE` (64) samples from `pcmValues[64]`, but synthesis was only writing 48 samples per cycle. This caused:
1. Audio stretched by factor of 64/48 = 1.333x
2. Pitch lowered by the same factor (perceived as lower tone)
3. Online playback taking 33% longer than expected

## Technical Details

### ASIO Buffer Constants (`AsioAudioInterface.h`)
```cpp
constexpr auto BUFFER_SIZE = 64;     // ASIO buffer size - MUST match synthesis cycle
constexpr auto SAMPLES_PER_MS = 48;  // 48kHz = 48 samples per millisecond
```

### ASIO Callback (`AsioAudioInterface.cpp`)
The callback always copies exactly `BUFFER_SIZE` samples:
```cpp
memcpy((uint8_t*)asioDriverInfo.bufferInfos[i].buffers[index],
       (uint8_t*)cbElementCB.element[i - asioDriverInfo.inputBuffers].pcmValues,
       buffSize * sizeof(uint32_t));  // buffSize = BUFFER_SIZE = 64
```

### Constraint
ASIO buffer size must be divisible by 32 (power-of-2 requirement with granularity -1).

## Solution

Changed synthesis `samples_in_cycle` from 48 to 64 to match ASIO's `BUFFER_SIZE`:

```python
# In test_asio_recording.py and any ASIO-mode initialization:
pianoid_instance = initialize(
    preset_file,
    filterlen=64 * 128 * 3,  # Adjusted for 64 samples/cycle
    samples_in_cycle=64,     # Must match ASIO BUFFER_SIZE (64)
    ...
)
```

## Verification

Three-way audio comparison test (`test_asio_recording.py`):

1. **Sound 1 - Online**: Live synthesis through ASIO
2. **Sound 2 - Offline ASIO**: Recorded audio played back through `playRecordedAudio()`
3. **Sound 3 - Offline WAV**: Same recorded audio played via Windows `winsound`

### Results After Fix
| Playback Method | Duration | Expected |
|-----------------|----------|----------|
| Online (ASIO)   | ~4.10s   | 4.00s    |
| Offline (ASIO)  | ~4.08s   | 4.00s    |
| Offline (WAV)   | ~4.18s   | 4.00s    |

All three sounds now have **identical pitch**, confirming the timing alignment is correct.

## Files Modified

- `pianoid_middleware/test_asio_recording.py` - Changed `samples_in_cycle=64`
- `pianoid_cuda/ASIOAudioDriver.cpp` - Added `playRecordedAudio()` method for testing
- `pianoid_cuda/ASIOAudioDriver.h` - Added `playRecordedAudio()` declaration

## Key Takeaway

**When using ASIO audio driver, `samples_in_cycle` (mode_iteration) MUST equal `BUFFER_SIZE` (64).**

The synthesis cycle size is a tunable parameter set at preset load time, but for ASIO mode it must be aligned with the ASIO buffer size constant.
