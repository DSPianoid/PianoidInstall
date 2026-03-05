# ASIO Callback Mode - Ready() Return Type Fix

**Date**: 2026-01-30
**Status**: ✅ FIXED - Online audio playback working correctly
**Branch**: fix/asio-audio-callback-ready
**Issue**: Audio distortion in ASIO callback mode

---

## Problem Statement

GUI application using ASIO callback mode (audio_driver_type=4) produced distorted audio despite the underlying audio synthesis being correct when tested offline.

---

## Root Cause

**Function signature mismatch in AsioAudioOutput::Ready()**

The `Ready()` function in `AsioAudioInterface.h` was declared as:
```cpp
void Ready(void);  // WRONG - returns nothing
```

But `ASIOAudioDriver.cpp` expected it to return BOOL for the spin-wait loop:
```cpp
// ASIOAudioDriver.cpp line ~119
while (asioDriver.Ready() == FALSE)  // Comparing void to FALSE!
    Sleep(0);
```

This caused undefined behavior in the wait loop that synchronizes audio packet delivery.

---

## The Fix

### 1. AsioAudioInterface.h
Changed return type from `void` to `BOOL`:
```cpp
BOOL Ready(void);  // Returns TRUE if packet was queued, FALSE if buffer full
```

### 2. AsioAudioInterface.cpp
Updated implementation to return proper status:
```cpp
BOOL AsioAudioOutput::Ready(void)
{
    cbElementTmp.packetNumber = ++packetNumber;
#ifdef TIMESTAMP_ASIO
    // Debug code with explicit returns
    if (queueToPlay.PutCircularBuffer(&cbElementTmp)) {
        printf(" **********  Packet Put  %5d \n", packetNumber);
        return TRUE;
    } else {
        printf(" ********** Circular buffer Full \n");
        return FALSE;
    }
#else
    return queueToPlay.PutCircularBuffer(&cbElementTmp);
#endif
}
```

### 3. setup.py
Added support for ASIO-only builds (no SDL required):
```python
elif default_driver == "ASIO":
    # ASIO-only mode - no SDL required
    _log("ASIO-only mode: no SDL library linked")
```

---

## Additional Changes

### FIR Filter Disabled
The FIR filter (`setFirFilter`) was causing CUDA errors with convolutionKernel. Disabled in `backendServer.py` as a workaround:
```python
# FIR filter disabled - enable when filter CUDA issues are resolved
# filterlen = 48*128*3
# filter_l = read_filter('presets/Filters/impulse_resp_L.txt')[:filterlen]
# pianoid.setFirFilter(filterlen, 1, filter_l)
```

### Parameter Name Migration
Renamed cryptic parameters to meaningful names:
- `user_1` → `audio_driver_type`
- `user_3` → `audio_buffer_size`
- `user_2` → removed (unused)

Backend supports both old and new names for compatibility.

---

## Working Configuration

These parameters produce clean ASIO callback audio:

| Parameter | Value | Description |
|-----------|-------|-------------|
| audio_driver_type | 4 | ASIO_CALLBACK mode |
| cycle_iterations | 64 | Matches ASIO BUFFER_SIZE |
| audio_buffer_size | 4 | Balanced latency/stability |

---

## Files Changed

- `pianoid_cuda/AsioAudioInterface.h` - Ready() return type
- `pianoid_cuda/AsioAudioInterface.cpp` - Ready() implementation
- `pianoid_cuda/setup.py` - ASIO-only build support
- `pianoid_middleware/backendServer.py` - FIR filter disabled, parameter names

---

## Related Issues

- **FIR Filter**: CUDA errors in convolutionKernel - needs separate investigation
- **SDL Mode**: Distortion issues documented in SDL3_ONLINE_DISTORTION_INVESTIGATION.md

---

## Verification

Tested with `test_backendserver_audio.py`:
1. Backend starts with ASIO callback mode
2. Audio plays without distortion
3. All three test notes (C4, E4, G4) sound identical to offline rendering
