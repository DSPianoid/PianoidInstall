# SDL3 Online Playback Distortion - Failed Investigation

**Date**: 2026-01-02
**Status**: ❌ FAILED - All attempts caused crashes or worsened performance
**Issue**: Audio distortion and slowdown in online playback mode
**Outcome**: Reverted to original callback-based implementation

---

## Problem Statement

Online playback mode produced distorted, slow audio. Profiling showed:
- Mean Interval: 3.346ms (251% of 1.333ms budget)
- 80% of intervals over budget
- Audio Buffer Mgmt: ~1.8ms (blocking)

---

## Key Finding: SDL3 Callback Batching

Debug logging revealed the **root cause**:
- SDL3 callbacks fire every ~10ms (not per-chunk)
- Each callback requests ~1920 bytes = 10 chunks
- `SDL_HINT_AUDIO_DEVICE_SAMPLE_FRAMES` hint is **ignored**
- With 3-chunk buffer, 7 chunks filled with silence per callback = 70% underrun

---

## Attempted Solutions

### 1. SPSC Lock-Free CircularBuffer
Changed mutex-based buffer to atomic Single-Producer Single-Consumer pattern.
**Result**: ❌ Performance worsened (249% → same). Spin-wait consumed CPU.

### 2. Increased Buffer to 15 Chunks
Matched SDL3's 10-chunk batch requests with 15-chunk buffer.
**Result**: ⚠️ Partial improvement (27% over budget), but:
- Audio still distorted
- GPU performance degraded
- Unacceptable latency (~15ms buffer)

### 3. Push Model (No Callback)
Removed callback entirely, pushed directly to SDL3 stream via `SDL_PutAudioStreamData()`.
**Result**: ❌ System crash

---

## Why Solutions Failed

The fundamental problem is **throughput mismatch**:
- Synthesis averages ~1.4ms/chunk
- Audio needs 1.0ms/chunk (48 samples @ 48kHz)
- 40% deficit means audio will always distort

Buffer size changes don't fix throughput - they only mask or shift the problem:
- Small buffer → immediate underruns
- Large buffer → unacceptable latency + still underruns when drained

---

## Constraints Confirmed

- Buffer must remain ≤3 chunks for low latency requirement
- SDL3 callback batching is hardware/driver dependent, not controllable
- Push model crashes the system

---

## Recommendation

The SDL3 online playback distortion is caused by **synthesis throughput being slower than audio consumption rate**. This is not a buffering or synchronization problem.

Options to explore:
1. Optimize GPU kernel to achieve <1ms/chunk
2. Reduce synthesis complexity (fewer strings, simpler algorithm)
3. Increase chunk size for better GPU efficiency
4. Use SDL2 driver which has different timing characteristics

---

## Files Reverted

All changes reverted to commit state:
- `pianoid_cuda/SDL3AudioDriver.cpp`
- `pianoid_cuda/SDL3AudioDriver.h`
- `pianoid_cuda/CircularBuffer.cu`
- `pianoid_cuda/CircularBuffer.cuh`
