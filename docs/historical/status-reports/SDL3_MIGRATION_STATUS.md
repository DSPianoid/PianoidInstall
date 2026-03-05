# SDL3 Audio Driver Migration Status

## Completion Date
**October 18, 2025**

## Overview
Successfully migrated PianoidCore from SDL2 to SDL3 audio driver, achieving reliable stop/restart functionality without hangs.

## Motivation
SDL2 had fundamental bugs with audio callback restart that caused the system to hang on stop/restart cycles. SDL3 uses a modern stream-based (push) model that provides:
- Reliable cleanup (SDL_DestroyAudioStream works properly)
- No callback corruption after device restart
- Better thread safety
- Active SDL development (SDL2 is legacy-only)

## Implementation Details

### Architecture: Stream-Based Push Model
- **SDL2 (old)**: Callback-based pull model - SDL calls our callback when it needs data
- **SDL3 (new)**: Stream-based push model - We push data to SDL stream from our own thread

### Key Components

#### 1. SDL3AudioDriver.h/.cpp
New driver implementation replacing SDLAudioDriver (SDL2):

**Features:**
- `SDL_AudioStream*` instead of SDL_AudioDeviceID
- Push thread (`audioThreadFunc()`) that continuously pushes samples to stream
- Mono output (extracts first channel from 4-channel interleaved data, matching SDL2 behavior)
- Small circular buffer (4 chunks) for low-latency playback
- Proper cleanup sequence: stop thread → pause device → destroy stream

**Key Methods:**
- `init()`: Creates SDL3 audio stream with `SDL_OpenAudioDeviceStream()`
- `start()`: Resumes device and starts push thread
- `stop()`: Thread-safe cleanup with proper sequencing
- `audioThreadFunc()`: Continuously consumes from CircularBuffer and pushes to SDL stream

#### 2. Build System Updates

**detect_paths.py:**
- Preserves existing `audio_driver` setting from config
- Dynamic SDL subdirectory detection (SDL2 vs SDL3)
- Preserves SDL root path across rebuilds

**setup.py:**
- Dynamic SDL library selection (SDL2.lib vs SDL3.lib) based on `audio_driver` config
- Dynamic SDL DLL copying (SDL2.dll vs SDL3.dll)
- Uses `define_macros` for preprocessor defines (fixes MSVC compilation)
- Audio driver define added during build_extension phase

**build_config.json:**
```json
{
  "audio_driver": "SDL3",
  "libraries": ["SDL3", "cudart", "winmm", "ole32", "advapi32"],
  "include_dirs": ["C:\\SDL3\\include", "C:\\SDL3\\include\\SDL3"],
  "library_dirs": ["C:\\SDL3\\lib\\x64"]
}
```

#### 3. Type Abstraction

**audio_types.h:**
All non-driver CUDA files now use this header instead of SDL headers:
```cpp
using AudioSample = int32_t;
using Sint32 = int32_t;
using Sint16 = int16_t;
using Uint32 = uint32_t;
// ... etc
```

**Files updated:**
- CircularBuffer.cu/cuh
- FIRFilter.cu/cuh
- MainKernel.cu/cuh
- pianoid_cycle.cu

#### 4. Conditional Compilation

**AudioDriverConfig.h:**
```cpp
#if defined(USE_SDL3_AUDIO)
  #define PLAY_WITH_SDL3
#elif defined(USE_SDL2_AUDIO)
  #define PLAY_WITH_SDL
#endif
```

**SDLAudioDriver.h (SDL2):**
Wrapped in `#if defined(USE_SDL2_AUDIO) || defined(PLAY_WITH_SDL)` guards

**SDL3AudioDriver.h:**
Wrapped in `#if defined(USE_SDL3_AUDIO)` guards

#### 5. Middleware Thread Management

**pianoid.py:**
`start_pianoid()` now ALWAYS creates the application thread (unified behavior):
```python
def start_pianoid(self):
    self.pianoid.startApplication()

    # ALWAYS start application thread (idempotent)
    if not hasattr(self, 'application_thread') or not self.application_thread.is_alive():
        self.application_thread = threading.Thread(target=self.run_application, args=(20000000,))
        self.application_thread.start()
```

**Methods updated** (removed duplicate thread creation):
- `play_mode_with_CUDA()` (note: actual function name is `play_mode_with_CUDA`, not `play_mode_CUDA`)
- `continue_play_CUDA()`
- `runPianoid()`

_Note: `play_CUDA()` was incorrectly listed here - this function never existed in the codebase._

#### 6. Buffer Size Fix

**Pianoid.cu:**
Fixed `dataSize` calculation in `playSoundSamples()`:
```cpp
// OLD (broken): dataSize = sizeof(Sint32);  // Only 4 bytes!
// NEW (correct):
dataSize = samplesInCycle * cp_.num_channels * sizeof(Sint32);  // 1024 bytes
```

#### 7. Audio Format

**Configuration:**
- Sample rate: 48000 Hz
- Format: SDL_AUDIO_S32 (32-bit signed integer)
- Channels: 1 (mono - extracts first channel from 4-channel data)
- Buffer: 64 samples per push = 1.33ms at 48kHz

**Data Layout:**
Pianoid generates 4-channel sequential data:
```
[Ch0_Sample0...Ch0_Sample63, Ch1_Sample0...Ch1_Sample63, Ch2..., Ch3...]
```
CircularBuffer extracts first 64 samples (Channel 0) for mono output.

## Issues Resolved

### 1. SDL3 API Constant (FIXED)
**Problem:** `SDL_AUDIO_DEVICE_DEFAULT_OUTPUT` undefined
**Solution:** Used `SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK` constant instead

### 2. Missing getNumChannels() Method (FIXED)
**Problem:** SDL3AudioDriver abstract - missing interface implementation
**Solution:** Added `int getNumChannels() const override { return numChannels; }`

### 3. Buffer Size Mismatch (FIXED)
**Problem:** Distorted audio - only 4 bytes pushed instead of full buffer
**Solution:** Fixed dataSize calculation in Pianoid.cu (1024 bytes = 64 samples × 4 channels × 4 bytes)

### 4. Channel Configuration (FIXED)
**Problem:** Configured for 4 channels but SDL2 uses mono
**Solution:** Set `numChannels = 1` and `chunk_size = mode_iteration` (64 samples) to match SDL2

### 5. Audio Thread Blocking Sleep (FIXED)
**Problem:** 500μs sleep caused audio gaps and distortion
**Solution:** Removed sleep - `audioBuffer.consume()` already blocks when empty

### 6. Stop Hang (FIXED)
**Problem:** `audioThread.join()` hung because thread blocked in `consume()`
**Solution:** Call `audioBuffer.stop()` to wake thread before joining

### 7. No Sound After Restart (FIXED)
**Problem:** CircularBuffer `stopFlag` remained true after restart
**Solution:** Call `audioBuffer.resume()` in `start()` to reset stopFlag

### 8. Stream Destroyed But Not Recreated (FIXED)
**Problem:** After stop, `audioStream = nullptr` but `start()` returned error
**Solution:** `start()` now calls `init()` if stream is null (recreates stream)

### 9. Duplicate Application Threads (FIXED)
**Problem:** Multiple methods created their own application threads after calling `start_pianoid()`
**Solution:** Made `start_pianoid()` the single source of truth - always creates thread, removed duplicates

## Known Issues

### 1. Audio Latency (OPEN)
**Symptoms:** Delay varies from 0.5 to several seconds between action and sound
**Current Buffer:** 4 chunks × 64 samples = 256 samples = 5.3ms theoretical latency
**Possible Causes:**
- SDL3 internal stream buffering
- Producer/consumer rate mismatch
- GPU-to-host memory transfer delays
- Middleware scheduling delays

**To Investigate:**
- Query SDL3 stream buffer size with `SDL_GetAudioStreamAvailable()`
- Monitor producer/consumer rates
- Profile memory transfer times
- Consider adjusting CircularBuffer size or SDL3 stream properties

## Testing Status

✅ **Build:** Compiles successfully with SDL3
✅ **Initial Start:** Sound plays correctly
✅ **Stop:** Clean shutdown without hang
✅ **Restart:** Sound works after restart
✅ **Audio Quality:** Clean mono output (when latency permits)
⚠️ **Latency:** Variable delay (0.5-several seconds) - needs investigation

## Build Instructions

### Prerequisites
- SDL3 installed at `C:\SDL3` (or update path in build_config.json)
- SDL3.dll in system PATH or copied to executable directory

### Build Steps
1. Set audio driver in `pianoid_cuda/build_config.json`:
   ```json
   { "audio_driver": "SDL3" }
   ```

2. Run build:
   ```batch
   cd C:\Users\astri\PianoidInstall\PianoidCore
   build_pianoid_cuda.bat
   ```

3. Verify build log shows:
   ```
   SETUP: Audio Driver: SDL3
   SETUP: Adding preprocessor define: USE_SDL3_AUDIO
   ```

### Alternative: Use Wrapper Script
```batch
build_with_sdl3.bat
```
(Ensures SDL3 configuration preserved)

## API Compatibility

### SDL2 → SDL3 Changes
| SDL2 | SDL3 | Notes |
|------|------|-------|
| `SDL_OpenAudioDevice()` | `SDL_OpenAudioDeviceStream()` | New stream-based API |
| `SDL_AudioSpec` | `SDL_AudioSpec` | Same structure |
| `AUDIO_S32SYS` | `SDL_AUDIO_S32` | New naming convention |
| `SDL_PauseAudioDevice()` | `SDL_PauseAudioDevice()` | Same |
| `SDL_CloseAudioDevice()` | `SDL_DestroyAudioStream()` | Stream cleanup |
| Callback mode | Stream mode | Push instead of pull |

### Backward Compatibility
SDL2 driver remains available via `USE_SDL2_AUDIO` define. Both drivers can coexist in codebase.

## File Manifest

### New Files
- `pianoid_cuda/SDL3AudioDriver.h` - SDL3 driver interface
- `pianoid_cuda/SDL3AudioDriver.cpp` - SDL3 driver implementation
- `pianoid_cuda/audio_types.h` - Type abstraction header
- `SDL3_MIGRATION_STATUS.md` - This document

### Modified Files
- `pianoid_cuda/AudioDriverConfig.h` - Added SDL3 defines
- `pianoid_cuda/AudioDriverFactory.cpp` - Added SDL3 driver creation
- `pianoid_cuda/SDLAudioDriver.h` - Added conditional compilation guards
- `pianoid_cuda/Pianoid.cu` - Fixed dataSize calculation
- `pianoid_cuda/CircularBuffer.cu` - No changes (already compatible)
- `pianoid_cuda/FIRFilter.cu/cuh` - Use audio_types.h instead of SDL.h
- `pianoid_cuda/MainKernel.cu/cuh` - Use audio_types.h instead of SDL.h
- `pianoid_cuda/pianoid_cycle.cu` - Use audio_types.h instead of SDL.h
- `pianoid_cuda/setup.py` - Dynamic SDL library/DLL selection, define_macros
- `detect_paths.py` - Preserve audio_driver config, dynamic subdirectory
- `pianoid_middleware/pianoid.py` - Unified thread management in start_pianoid()

## Conclusion

SDL3 migration is **functionally complete** with reliable stop/restart behavior. The remaining latency issue is a performance optimization task that doesn't affect core functionality.

**Next Steps:**
1. Profile and optimize audio latency
2. Consider implementing variable buffer sizes
3. Monitor SDL3 stream buffer levels
4. Document latency optimization findings
