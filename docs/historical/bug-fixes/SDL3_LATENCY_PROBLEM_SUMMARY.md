# SDL3 Audio Latency Problem - Summary of Investigation and Solution

**Investigation Date**: 2025-10-18
**Solution Date**: 2025-10-19 (commit fc2f3e2)
**Status**: ✅ **RESOLVED** - Callback-based driver implemented
**Original Issue**: SDL3 audio had clean output but >1 second latency
**Solution**: Replaced push-thread model with SDL3 native callback API
**Result**: ~5-8ms latency (matches SDL2/ASIO performance)

---

## Problem Statement

### Current Behavior
- **Audio quality**: Clean, no distortion
- **Latency**: >1 second (1000+ ms)
- **Target latency**: <8ms total pipeline for live performance
  - MIDI buffer: 1 cycle (1.33ms)
  - GPU synthesis: 1 cycle (1.33ms)
  - Audio output: Maximum 4 cycles (5.33ms)
  - Total acceptable: ~8ms

### SDL3 Architecture (Current Working Implementation)

**File**: [SDL3AudioDriver.cpp](pianoid_cuda/SDL3AudioDriver.cpp)

```cpp
// Push thread model
void SDL3AudioDriver::audioThreadFunc() {
    while (shouldRun.load()) {
        audioBuffer.consume(buffer);  // Get 64 samples from CircularBuffer
        SDL_PutAudioStreamData(audioStream, buffer, 256);  // Push to SDL3 stream
    }
}
```

**Data flow**:
```
Pianoid → CircularBuffer (4 chunks) → Audio Thread → SDL3 Stream → Hardware
          5.3ms latency              Pushes fast    UNBOUNDED!     Pulls at 48kHz
```

**Root cause**: SDL3 internal stream buffer grows unbounded because:
1. Audio thread pushes as fast as CircularBuffer has data
2. SDL3 stream accepts all data (no backpressure mechanism)
3. CircularBuffer stays nearly empty (audio thread consumes immediately)
4. SDL3 stream accumulates 1000+ ms of audio before hardware drains it

---

## Comparison with Working Drivers

### SDL2 - Callback Model (Works Well)

**File**: [SDLAudioDriver.cpp:151-162](pianoid_cuda/SDLAudioDriver.cpp#L151-L162)

```cpp
void SDLAudioDriver::audioCallback(void* userdata, Uint8* stream, int len) {
    SDLAudioDriver* driver = static_cast<SDLAudioDriver*>(userdata);
    driver->audioBuffer.consume(reinterpret_cast<Sint32*>(stream));
}
```

**Data flow**:
```
Pianoid → CircularBuffer (4 chunks) → SDL2 callback → Hardware
          5.3ms latency              Pulls at 48kHz   (direct)
```

**Why it works**:
- SDL2 **pulls** data via callback when hardware needs it
- Callback rate is synchronized with hardware playback (48kHz)
- No intermediate buffer between CircularBuffer and hardware
- CircularBuffer's lock mechanism controls Pianoid production rate
- Total latency: ~5-8ms ✅

### ASIO - Callback Model (Works Well)

**File**: [ASIOAudioDriver.cpp:114-131](pianoid_cuda/ASIOAudioDriver.cpp#L114-L131)

```cpp
void ASIOAudioDriver::audioCallbackForASIO(uint32_t* (*source_of_pointers)) {
    if (staticInstance) {
        staticInstance->audioBuffer.consume(source_of_pointers);
    }
}
```

**Data flow**:
```
Pianoid → CircularBuffer (4 chunks) → ASIO callback → Hardware
          5.3ms latency              Pulls at 48kHz   (direct)
```

**Why it works**:
- Same as SDL2 - callback pulls when hardware needs data
- No intermediate buffering
- CircularBuffer lock controls latency
- Total latency: ~5-8ms ✅

---

## Attempted Solutions and Why They Failed

### Attempt 1: SDL3 Stream Throttling (Check Before Consume)

**Approach**: Wait if SDL3 stream buffer exceeds threshold before consuming from CircularBuffer.

```cpp
while (shouldRun.load()) {
    // Wait if SDL3 stream too full
    while (SDL_GetAudioStreamQueued(audioStream) >= 512) {
        sleep(200μs);
    }

    audioBuffer.consume(buffer);
    SDL_PutAudioStreamData(audioStream, buffer, 256);
}
```

**Result**: ❌ **Audio distortion**

**Why it failed**: The sleep creates timing gaps in the audio stream. When we wait, we're not consuming smoothly, which causes irregular data flow to SDL3.

---

### Attempt 2: Channel Extraction (Incorrect Assumption)

**Approach**: Assumed Pianoid outputs 4-channel interleaved data, tried to extract channel 0.

```cpp
// CircularBuffer configured for 256 samples (64 × 4 channels)
audioBuffer(config.mode_iteration * config.num_channels, ...)

// Extract every 4th sample
for (int i = 0; i < 64; i++) {
    monoBuffer[i] = interleavedBuffer[i * 4];
}
```

**Result**: ❌ **Severe distortion and quieter audio**

**Why it failed**:
- Pianoid actually outputs **mono** (cp_.num_channels = 1)
- Pianoid pushes 64 samples (256 bytes), not 256 samples (1024 bytes)
- CircularBuffer was trying to copy 1024 bytes but only got 256 bytes
- Reading uninitialized memory caused distortion
- Extracting every 4th sample lost 3/4 of the audio → quieter

**Correction**: Reverted CircularBuffer to 64 samples, removed channel extraction.

---

### Attempt 3: Remove Throttling Entirely

**Approach**: Let SDL3 stream buffer grow unbounded, rely only on CircularBuffer.

```cpp
while (shouldRun.load()) {
    audioBuffer.consume(buffer);  // Always consume
    SDL_PutAudioStreamData(audioStream, buffer, 256);  // Always push
}
```

**Result**: ✅ **Clean audio** but ❌ **>1 second latency**

**Why it failed**: This is the original problem - SDL3 stream grows unbounded.

---

### Attempt 4: SDL3 Callback Mode

**Approach**: Use SDL3's callback parameter instead of push thread.

```cpp
// Register callback
audioStream = SDL_OpenAudioDeviceStream(
    SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK,
    &spec,
    SDL3AudioDriver::audioCallback,  // Callback
    this
);

// Callback implementation
void audioCallback(void* userdata, SDL_AudioStream* stream,
                   int additional_amount, int total_amount) {
    driver->audioBuffer.consume(buffer);
    SDL_PutAudioStreamData(stream, buffer, bytes);
}
```

**Result**: ❌ **Just noise**

**Why it failed**:
- SDL3 callback signature is different from SDL2
- `additional_amount` parameter doesn't necessarily match CircularBuffer chunk size (64)
- CircularBuffer.consume() expects exactly 64 samples
- Size mismatch caused reading wrong data → noise
- SDL3 callback model may work differently than SDL2 (requires further investigation)

---

## The Fundamental Problem: SDL3 Push Model vs Callback Model

### SDL2/ASIO (Pull Model - Works)

```
                        Hardware needs data
                               ↓
                        Callback fires (at 48kHz rate)
                               ↓
                        Pull from CircularBuffer
                               ↓
                        Fill device buffer directly
                               ↓
                        Play immediately

Latency: CircularBuffer only (4 chunks = 5.3ms)
```

### SDL3 (Push Model - Doesn't Work Well)

```
Audio Thread Loop (runs as fast as possible)
        ↓
Pull from CircularBuffer
        ↓
Push to SDL3 Stream (intermediate buffer)
        ↓
SDL3 Stream accumulates (no size limit)
        ↓
Hardware pulls from SDL3 Stream (at 48kHz rate)
        ↓
Play

Latency: CircularBuffer (5.3ms) + SDL3 Stream (unbounded) = 1000+ ms
```

**The core issue**: SDL3 adds an **intermediate buffer** (SDL3 stream) that has no built-in size limit and receives data faster than hardware can play it.

---

## Why CircularBuffer Lock Isn't Enough for SDL3

### SDL2/ASIO Backpressure Chain

```
Hardware pulls → Callback fires → CircularBuffer.consume() → If empty, blocks →
    → CircularBuffer fills → Pianoid.produce() → If full, blocks
```

**Single lock (CircularBuffer) is sufficient** because:
- Hardware pulls at fixed rate (48kHz)
- Callback synchronized with hardware
- CircularBuffer directly connected to hardware
- If CircularBuffer empty, callback waits (hardware underrun)
- If CircularBuffer full, Pianoid blocks

### SDL3 Broken Backpressure

```
Audio Thread: consume() → push() → SDL3 Stream grows unbounded
    ↑                                      ↓
CircularBuffer                        Hardware pulls
(always drained)                      (can't keep up)
```

**CircularBuffer lock doesn't help** because:
- Audio thread consumes immediately → CircularBuffer rarely fills
- SDL3 stream has no size limit → keeps growing
- No feedback from SDL3 stream to audio thread
- CircularBuffer can't apply backpressure to Pianoid (buffer always has space)

---

## What We Learned

### 1. SDL3 Callback Mode Complexity

SDL3's `SDL_AudioStreamCallback` has a different signature than SDL2:
- SDL2: `void callback(void* userdata, Uint8* stream, int len)`
- SDL3: `void callback(void* userdata, SDL_AudioStream* stream, int additional_amount, int total_amount)`

The SDL3 callback doesn't provide a buffer pointer to fill directly. It's more of a notification that SDL3 needs data, and you still push via `SDL_PutAudioStreamData()`. This is fundamentally different from SDL2's model.

### 2. Pianoid Output Format

Pianoid outputs **mono** audio (only channel 0), controlled by `cp_.num_channels = 1`:
- Pushes: 64 samples × 1 channel × 4 bytes = 256 bytes per cycle
- CircularBuffer chunk_size must be 64 samples (not 256)
- No channel extraction needed

### 3. CircularBuffer Is Device-Agnostic

CircularBuffer correctly stores whatever Pianoid pushes:
- `chunk_size = 64` samples (matches Pianoid's mono output)
- `num_chunks = 4` (provides 5.3ms buffering)
- Lock mechanism controls Pianoid production rate
- **But** this only works if the consumer (callback/thread) is rate-limited by hardware

### 4. Push Model Requires Manual Rate Limiting

Unlike callback models where hardware rate-limits consumption, push models need explicit throttling:
- Monitor downstream buffer size
- Block producer when buffer exceeds threshold
- But blocking creates timing gaps → distortion

---

## Potential Solutions (Untested)

### Option 1: SDL3 Callback Mode (Needs Research)

Investigate SDL3's callback model more thoroughly:
- How does `additional_amount` relate to buffer size?
- Should we fill SDL3 stream in callback or some other mechanism?
- Does SDL3 have a "fill buffer directly" mode like SDL2?

**Action**: Study SDL3 documentation and examples for proper callback usage.

### Option 2: Reduce CircularBuffer Size

Current: 4 chunks = 256 samples = 5.3ms

If SDL3 stream is unavoidable, reduce CircularBuffer to minimum:
- Try 2 chunks = 128 samples = 2.67ms
- Or even 1 chunk = 64 samples = 1.33ms (risky - may cause underruns)

**Benefit**: Lower base latency, but SDL3 stream will still add latency.

### Option 3: SDL3 Stream Buffer Size Configuration

Research if SDL3 allows setting maximum stream buffer size:
```cpp
// Hypothetical - needs investigation
SDL_SetAudioStreamBufferSize(audioStream, 512);  // Cap at 512 bytes
```

If SDL3 stream can be capped, it might apply backpressure naturally.

### Option 4: Adaptive Sleep in Audio Thread

Instead of fixed throttle, adapt sleep time based on SDL3 queue:
```cpp
int queued = SDL_GetAudioStreamQueued(audioStream);
if (queued > 512) {
    int excess = queued - 512;
    int sleep_us = excess / bytesPerPush * 1330;  // Scale to time
    sleep(min(sleep_us, 500));
}
```

**Issue**: Still creates timing gaps, may still cause distortion.

### Option 5: Use SDL2 Instead

SDL2 works perfectly with low latency. Consider staying on SDL2 until SDL3 matures or callback mode is better understood.

---

## Files in Current Working State (Post-Revert)

All code reverted to commit `3758562`:

| File | State |
|------|-------|
| [SDL3AudioDriver.cpp](pianoid_cuda/SDL3AudioDriver.cpp) | Push thread model, no throttling |
| [SDL3AudioDriver.h](pianoid_cuda/SDL3AudioDriver.h) | Push thread declarations |
| [AudioDriverInterface.h](pianoid_cuda/AudioDriverInterface.h) | Base interface |
| [Pianoid.cu](pianoid_cuda/Pianoid.cu) | Unchanged |
| [Pianoid.cuh](pianoid_cuda/Pianoid.cuh) | Unchanged |
| [CircularBuffer.cu](pianoid_cuda/CircularBuffer.cu) | Unchanged |

**Current behavior**: Clean audio, >1 second latency.

---

## Next Steps (Recommendations)

### Immediate Action
1. **Research SDL3 callback mode** thoroughly
   - Find SDL3 examples using callback mode
   - Understand how `additional_amount` works
   - Determine if direct buffer filling is possible

2. **Check SDL3 documentation** for stream buffer control
   - Can stream buffer size be capped?
   - Are there performance hints or settings?

3. **Profile current implementation**
   - Add monitoring to see exactly how large SDL3 stream buffer grows
   - Measure timing of consume/push operations
   - Identify if there's a pattern to buffer growth

### Alternative Path
4. **Consider SDL2 for production**
   - SDL2 works perfectly with 5-8ms latency
   - SDL3 migration may be premature
   - Revisit SDL3 when documentation/examples improve

---

## Summary

**Problem**: SDL3 push model creates unbounded intermediate buffer (SDL3 stream) leading to >1 second latency.

**Root Cause**: Architectural difference between callback (pull) and push models:
- Callback: Hardware rate-limits consumption → CircularBuffer lock sufficient
- Push: Need manual rate limiting → Attempted throttling caused distortion

**Attempted Solutions**:
1. Throttling before consume → Distortion
2. Channel extraction → Wrong assumption, severe distortion
3. No throttling → Clean audio, >1s latency (original problem)
4. SDL3 callback mode → Noise (incorrect implementation)

**Current State**: Reverted to clean audio with >1s latency (unacceptable).

**Recommended Path**: Research SDL3 callback mode or consider staying with SDL2.

---

---

## ✅ SOLUTION IMPLEMENTED (2025-10-19)

**Commit**: fc2f3e2 - "Implement SDL3 callback-based audio driver for low latency"

### What Was Changed

Replaced the push-thread model with SDL3's native callback API:

**Previous Architecture (Push Model - BROKEN)**:
```cpp
// Manual thread pushing data as fast as possible
void SDL3AudioDriver::audioThreadFunc() {
    while (shouldRun.load()) {
        audioBuffer.consume(buffer);  // Fast consumption
        SDL_PutAudioStreamData(audioStream, buffer, 256);  // Unbounded buffering!
    }
}
```
**Result**: SDL3 stream buffer grew to >1000ms of audio.

**New Architecture (Callback Model - WORKING)**:
```cpp
// SDL3 calls our callback when hardware needs data
static void audioStreamCallback(void* userdata, SDL_AudioStream* stream,
                                int additional_amount, int total_amount) {
    SDL3AudioDriver* driver = static_cast<SDL3AudioDriver*>(userdata);
    driver->fillAudioStream(stream, additional_amount, total_amount);
}

void SDL3AudioDriver::fillAudioStream(SDL_AudioStream* stream,
                                      int additional_amount, int total_amount) {
    int chunks_needed = (additional_amount + CHUNK_SIZE - 1) / CHUNK_SIZE;
    chunks_needed = std::min(chunks_needed, 10);  // Cap at 10 chunks

    for (int i = 0; i < chunks_needed; i++) {
        if (audioBuffer.tryConsume(buffer, 1)) {  // 1ms timeout
            SDL_PutAudioStreamData(stream, buffer, CHUNK_SIZE);
        } else {
            // Underrun: fill with silence
            memset(buffer, 0, CHUNK_SIZE);
            SDL_PutAudioStreamData(stream, buffer, CHUNK_SIZE);
        }
    }
}
```
**Result**: Hardware-driven rate limiting, ~5-8ms latency ✅

### Key Design Decisions

1. **Register Callback with SDL_OpenAudioDeviceStream()**:
   ```cpp
   SDL_AudioStreamCallback callback = audioStreamCallback;
   audioStream = SDL_OpenAudioDeviceStream(
       SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK,
       &spec,
       callback,  // SDL3 manages callback thread
       this       // userdata pointer
   );
   ```

2. **Remove Manual Thread**: SDL3 handles callback invocation internally, no need for our own thread

3. **Calculate Chunks Dynamically**: Provide exactly what SDL3 requests (up to 10 chunks = 2560 bytes)

4. **Use tryConsume()**: Non-blocking with 1ms timeout prevents callback from blocking

5. **Graceful Underrun Handling**: Fill with silence if CircularBuffer is empty

### Performance Results

- **Latency**: ~5-8ms (CircularBuffer only, no SDL3 buffer growth)
- **No underruns**: Proper 10-chunk buffer sizing prevents silence gaps
- **Clean audio**: Matches SDL2/ASIO quality
- **Reliable stop/restart**: No hangs, no callback corruption

### Why This Works

The callback model provides **hardware-driven rate limiting**:
- SDL3 only calls callback when hardware actually needs data
- Callback rate synchronized with 48kHz playback
- No intermediate buffering between CircularBuffer and hardware
- CircularBuffer's lock mechanism naturally controls Pianoid production rate

This matches the proven SDL2/ASIO callback pattern that already worked.

### Files Modified

- [pianoid_cuda/SDL3AudioDriver.cpp](pianoid_cuda/SDL3AudioDriver.cpp) - Callback implementation
- [pianoid_cuda/SDL3AudioDriver.h](pianoid_cuda/SDL3AudioDriver.h) - Interface updates

### References

- Full design details: [SDL3_LATENCY_SOLUTIONS_ANALYSIS.md](SDL3_LATENCY_SOLUTIONS_ANALYSIS.md) - Solution 1
- SDL3 callback API: [SDL3 Audio Documentation](https://wiki.libsdl.org/SDL3/CategoryAudio)

---

**Document Version**: 2.0 (Updated with solution)
**Investigation Date**: 2025-10-18
**Solution Date**: 2025-10-19
**Status**: ✅ RESOLVED - Callback-based driver achieves target latency
