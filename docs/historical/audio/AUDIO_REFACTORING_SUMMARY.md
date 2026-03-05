# Audio Driver Refactoring Summary

## Overview
All audio driver functionality has been extracted from Pianoid.cu into separate driver-specific files, with a unified interface for clean integration.

## New Files Created

### Core Architecture
1. **AudioConfig.h** - Configuration structure for audio drivers
   - Defines `AudioDriverType` enum (SDL, ASIO, ASIO_CALLBACK)
   - Contains `AudioConfig` struct with all audio parameters

2. **AudioDriverInterface.h** - Pure virtual interface
   - Defines contract for all audio drivers
   - Methods: init(), start(), pause(), resume(), stop(), pushSamples(), setupCuda(), etc.

3. **AudioDriverConfig.h** - Centralized compilation configuration
   - All `PLAY_WITH_*` defines now in one place
   - Defines `ACTIVE_AUDIO_DRIVER` macro based on selected driver

### Driver Implementations
4. **SDLAudioDriver.h/.cpp** - SDL2 implementation (legacy)
   - Migrated SDL2-specific code from Pianoid.cu
   - Callback-based pull model (SDL calls our callback)
   - Includes SDL callback, CircularBuffer integration
   - CUDA setup support for GPU acceleration
   - **Note:** SDL2 has callback restart bugs - use SDL3 for production

5. **SDL3AudioDriver.h/.cpp** - SDL3 implementation (recommended)
   - Modern stream-based push model (we push to SDL stream)
   - Reliable stop/restart without hangs
   - Dedicated push thread with blocking CircularBuffer
   - Mono output (extracts first channel from 4-channel data)
   - Small buffer (4 chunks) for low latency

6. **ASIOAudioDriver.h/.cpp** - ASIO implementation
   - Supports both callback and manual push modes
   - Migrated ASIO-specific code from Pianoid.cu
   - LockFreeCircularBuffer for ASIO callback mode

7. **AudioDriverFactory.h/.cpp** - Factory pattern
   - `createDriver()` - Runtime driver selection
   - `createDefaultDriver()` - Compile-time driver selection based on defines

## Modified Files

### Pianoid.cuh
**Removed:**
- All `#ifdef PLAY_WITH_*` preprocessor blocks
- SDL and ASIO specific includes
- `SDL_AudioDeviceID audioDev` member
- `AsioAudioOutput AsioDriver` member
- `audioBuffer` member (moved to driver implementations)
- Static callback methods (`audioCallback`, `audioCallbackForASIO`)
- `pushToAudioDriver()` method declaration

**Added:**
- `#include "AudioDriverInterface.h"`
- `#include "AudioDriverFactory.h"`
- `std::unique_ptr<AudioDriverInterface> audioDriver` member

### Pianoid.cu
**Removed:**
- SDL, ASIO, CircularBuffer includes (now in drivers)
- Conditional audioBuffer initialization in constructor
- All `#ifdef PLAY_WITH_*` blocks in:
  - Constructor (lines 188-193, 204-211)
  - playSoundSamples() (lines 1757-1761)
  - startAudioDevice() (lines 1866-1901)
  - pauseAudioPlayback() (lines 1903-1910)
  - resumeAudioPlayback() (lines 1912-1919)
  - stopAudioDevice() (lines 1920-1969)
- `pushToAudioDriver()` implementation (moved to ASIOAudioDriver)
- `audioCallback()` implementation (moved to SDLAudioDriver)
- `audioCallbackForASIO()` implementation (moved to ASIOAudioDriver)

**Added:**
- `#include "AudioDriverConfig.h"`
- Audio driver initialization in constructor:
  ```cpp
  audioDriver = AudioDriverFactory::createDefaultDriver(
      cp_.sample_rate, cp_.buffer_size, cp_.num_channels, this);
  audioDriver->setupCuda(0);
  ```

**Simplified to unified calls:**
- `startAudioDevice()` → `audioDriver->init(); audioDriver->start();`
- `pauseAudioPlayback()` → `audioDriver->pause();`
- `resumeAudioPlayback()` → `audioDriver->resume();`
- `stopAudioDevice()` → `audioDriver->stop();`
- `playSoundSamples()` → `audioDriver->pushSamples(outputData, dataSize);`

## How to Switch Audio Drivers

**Method 1: Build Configuration (recommended)**
Edit `build_config.json`:
```json
{
  "audio_driver": "SDL3"  // Options: "SDL2", "SDL3", "ASIO"
}
```

**Method 2: Compile-time**
Edit `AudioDriverConfig.h`:
```cpp
// Uncomment ONE of these:
//#define USE_SDL2_AUDIO  // SDL2 (legacy, has restart bugs)
#define USE_SDL3_AUDIO   // SDL3 (recommended, reliable restart)
//#define PLAY_WITH_ASIO_CALLBACK
//#define PLAY_WITH_ASIO
```

**Method 2: Runtime (future enhancement)**
Pass `AudioConfig` with desired driver type to factory:
```cpp
AudioConfig config(48000, 64, 2, AudioDriverType::ASIO);
audioDriver = AudioDriverFactory::createDriver(config, this);
```

## Benefits Achieved

✅ **Separation of Concerns**: Audio driver logic completely isolated from synthesis engine
✅ **Clean Main Code**: Pianoid.cu is free from all `#ifdef PLAY_WITH_*` preprocessor clutter
✅ **Maintainability**: Each driver in its own file, easier to debug and modify
✅ **Extensibility**: New drivers (WASAPI, CoreAudio) can be added without touching Pianoid
✅ **Testability**: Can mock AudioDriverInterface for unit tests
✅ **Single Responsibility**: Each class has one clear, well-defined purpose

## Compilation Notes

The driver implementation files use conditional compilation:
- **SDLAudioDriver.cpp**: Only compiles content when `PLAY_WITH_SDL` is defined
- **ASIOAudioDriver.cpp**: Only compiles content when `PLAY_WITH_ASIO` or `PLAY_WITH_ASIO_CALLBACK` is defined
- **AudioDriverFactory.cpp**: Always compiles, but conditionally includes drivers based on defines

This means ALL .cpp files can be included in the build - they will automatically compile only the active driver code.

Link against appropriate libraries:
- SDL: SDL2.lib (only when `PLAY_WITH_SDL` is defined)
- ASIO: ASIO SDK libraries (only when ASIO modes are defined)

## Build Fix Applied

Added conditional compilation guards to driver implementation files:
- `ASIOAudioDriver.cpp`: Wrapped in `#if defined(PLAY_WITH_ASIO) || defined(PLAY_WITH_ASIO_CALLBACK)`
- `SDLAudioDriver.cpp`: Wrapped in `#ifdef PLAY_WITH_SDL`

This prevents compilation errors when ASIO headers are not available or when building with SDL only.
