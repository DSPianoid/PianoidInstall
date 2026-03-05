# SDL Mode Bug Fix Plan

**Date**: 2026-01-30
**Status**: Planning
**Priority**: Medium (ASIO is primary driver, SDL for fallback/cross-platform)

---

## Current State

### ASIO (Working)
- Uses `LockFreeCircularBuffer` with per-channel consume
- `consume(uint32_t* (*source_of_pointers))` - array of pointers per channel
- Data layout: `[ch0_s0..ch0_s63, ch1_s0..ch1_s63, ...]`
- BUFFER_SIZE = 64 samples matches cycle_iterations

### SDL3 (Distortion)
- Uses `CircularBuffer` with single-pointer consume
- `consume(Sint32* data)` - single output buffer
- numChannels = 1 (mono output only)
- Callback batches requests (~1920 bytes = ~7.5 chunks)
- Documented throughput mismatch: synthesis ~1.4ms/chunk vs audio 1.0ms/chunk

### SDL2 (Distortion + Hang on Stop)
- Same issues as SDL3
- Additional: device abandoned on stop to avoid SDL_CloseAudioDevice hang

---

## Root Cause Analysis

### 1. Data Layout Mismatch
- **GPU Kernel Output**: Per-channel layout `[ch0_all_samples, ch1_all_samples, ...]`
- **SDL CircularBuffer.consume()**: Expects single interleaved or mono buffer
- **Result**: Wrong samples copied, causing distortion

### 2. Mono-Only Output
- SDL drivers hardcode `numChannels = 1`
- GPU produces 8 channels of data
- Only first channel extracted, rest discarded
- May need stereo or proper channel downmix

### 3. Buffer Size Mismatch
- SDL3 creates 10-chunk buffer: `audioBuffer(config.mode_iteration, 10, 10)`
- SDL2 creates large buffer: `audioBuffer(..., buffer_size * 128)`
- But `cycle_iterations` may be 48 (old default) not 64 (ASIO default)
- Chunk boundaries don't align with audio callback requests

### 4. Throughput Issue (SDL3-Specific)
- SDL3 callbacks fire every ~10ms requesting ~10 chunks
- Synthesis produces ~0.7 chunks per ms
- 30% deficit accumulates, causing underruns

---

## Fix Strategy

### Phase 1: Parameter Alignment (Quick Win)
1. Ensure `cycle_iterations = 64` for SDL modes (same as ASIO)
2. Match buffer sizes appropriately for each driver
3. Verify chunk_size consistency between producer and consumer

### Phase 2: CircularBuffer Data Layout Fix
Option A: **Use LockFreeCircularBuffer for SDL**
- Modify SDL drivers to use same buffer as ASIO
- Change consume signature to match
- Downmix channels to mono/stereo in callback

Option B: **Fix CircularBuffer produce() for per-channel data**
- Keep separate CircularBuffer for SDL
- Modify produce() to de-interleave from per-channel to flat layout
- Simpler consume() can stay as-is

**Recommendation**: Option A (unified buffer) - less code duplication

### Phase 3: Channel Handling
1. Add channel downmix in SDL callback:
   - Mono: average all channels or take left channel
   - Stereo: L = ch0, R = ch1 (or downmix)
2. Update `numChannels` in SDL spec based on output device capabilities

### Phase 4: SDL3 Throughput (Advanced)
Options to explore:
1. Increase synthesis chunk size for better GPU efficiency
2. Reduce synthesis complexity (fewer modes)
3. Pre-buffer more chunks before starting playback
4. Accept higher latency with larger buffer

---

## Implementation Tasks

### Task 1: Verify cycle_iterations Alignment
- [ ] Ensure GUI sends `cycle_iterations = 64` for SDL modes
- [ ] Update backendServer.py to validate/enforce this

### Task 2: Switch SDL to LockFreeCircularBuffer
- [ ] Replace `CircularBuffer audioBuffer` with `LockFreeCircularBuffer`
- [ ] Update SDL3AudioDriver constructor
- [ ] Update SDLAudioDriver constructor

### Task 3: Update SDL Callback to Handle Multi-Channel
- [ ] Modify audioCallback/fillAudioStream to use new consume signature
- [ ] Add channel downmix logic (8ch -> mono or stereo)
- [ ] Update SDL audio spec for stereo if needed

### Task 4: Test and Verify
- [ ] Test SDL2 with new buffer
- [ ] Test SDL3 with new buffer
- [ ] Verify no distortion
- [ ] Check latency is acceptable
- [ ] Verify stop/restart works cleanly

---

## Files to Modify

1. `pianoid_cuda/SDL3AudioDriver.cpp` - Use LockFreeCircularBuffer, update callback
2. `pianoid_cuda/SDL3AudioDriver.h` - Change buffer type
3. `pianoid_cuda/SDLAudioDriver.cpp` - Use LockFreeCircularBuffer, update callback
4. `pianoid_cuda/SDLAudioDriver.h` - Change buffer type
5. `pianoid_middleware/backendServer.py` - Ensure correct parameters for SDL

---

## Testing Plan

1. **Unit Test**: Create test similar to test_backendserver_audio.py for SDL
2. **Integration Test**: Full GUI with SDL driver selected
3. **A/B Comparison**: Record output from ASIO and SDL, compare waveforms
4. **Stress Test**: Long playback session to verify stability

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| LockFreeCircularBuffer threading issues | Medium | High | Add mutex for SDL callback safety |
| Stereo downmix artifacts | Low | Medium | Use proper mixing algorithm |
| SDL2 shutdown hang persists | Medium | Medium | Keep device-abandon workaround |
| Throughput still insufficient | High | High | Accept higher latency for SDL3 |

---

## Success Criteria

1. SDL2 and SDL3 produce clean audio without distortion
2. Audio matches ASIO output quality
3. Start/stop works reliably without hangs
4. Latency <= 50ms (acceptable for non-professional use)
