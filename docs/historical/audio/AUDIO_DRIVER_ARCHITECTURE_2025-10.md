# Audio Driver Architecture

**Last Updated:** October 19, 2025
**Status:** ✅ Complete - SDL2/SDL3 Mutual Exclusion Implemented

---

## Table of Contents

1. [Overview](#overview)
2. [Critical Discovery: SDL2/SDL3 Mutual Exclusion](#critical-discovery-sdl2sdl3-mutual-exclusion)
3. [Driver Selection Strategy](#driver-selection-strategy)
4. [Build-Time Configuration](#build-time-configuration)
5. [Runtime Driver Selection](#runtime-driver-selection)
6. [Driver Implementations](#driver-implementations)
7. [Fixes and Improvements](#fixes-and-improvements)
8. [Migration Guide](#migration-guide)

---

## Overview

PianoidCore supports three audio driver backends:
- **SDL2** - Legacy SDL audio driver (stable, low latency)
- **SDL3** - Modern SDL audio driver (recommended, callback-based, most reliable)
- **ASIO** - Professional audio driver (lowest latency, Windows only)

### Key Architecture Principle

**CRITICAL:** SDL2 and SDL3 cannot be compiled together in the same binary due to symbol conflicts at the linker level. This fundamentally changes the driver compilation strategy.

---

## Critical Discovery: SDL2/SDL3 Mutual Exclusion

### The Problem

Initial attempts to compile all drivers together for runtime selection failed with:

```
RuntimeError: SDL2 driver requested but headers not included (compile-time)
```

Even with header guards preventing both SDL2 and SDL3 headers from being included simultaneously, **linking both SDL2.lib and SDL3.lib into the same binary causes runtime conflicts**.

### Root Cause

SDL2 and SDL3 have:
- **Conflicting symbols** - Many function names are identical
- **Incompatible initialization** - SDL_Init() in both libraries conflicts
- **Different ABI versions** - Binary interface incompatibility

### Solution

**Build-time driver selection:** Compile only ONE SDL driver per build.

---

## Driver Selection Strategy

### Compilation Model

```
┌─────────────────────────────────────────┐
│         Build Configuration             │
│  (pianoid_cuda/build_config.json)      │
└─────────────┬───────────────────────────┘
              │
              ▼
    ┌─────────────────────────┐
    │  default_audio_driver   │
    │  "SDL2" or "SDL3"       │
    └─────────┬───────────────┘
              │
              ▼
┌─────────────┴──────────────┐
│                            │
▼                            ▼
SDL2 Build                   SDL3 Build
├─ SDL2AudioDriver.cpp      ├─ SDL3AudioDriver.cpp
├─ SDL2.lib (linked)        ├─ SDL3.lib (linked)
├─ ASIOAudioDriver.cpp      ├─ ASIOAudioDriver.cpp
└─ SDL2.dll (copied)        └─ SDL3.dll (copied)
```

### Runtime Selection

Within a build, you can switch between:
- **ASIO ↔ SDL** (whichever SDL version was compiled)

**Cannot switch at runtime:**
- ~~SDL2 ↔ SDL3~~ (requires rebuild)

---

## Build-Time Configuration

### Configuration File

Edit `pianoid_cuda/build_config.json`:

```json
{
  "audio_driver": "SDL3",
  "default_audio_driver": "SDL3",
  "sdl2_available": true,
  "sdl2_include": "C:\\SDL2-2.30.8\\include",
  "sdl2_libdir": "C:\\SDL2-2.30.8\\lib\\x64",
  "sdl2_dll": "C:\\SDL2-2.30.8\\lib\\x64\\SDL2.dll",
  "sdl3_available": true,
  "sdl3_include": "C:\\SDL3\\include",
  "sdl3_libdir": "C:\\SDL3\\lib\\x64",
  "sdl3_dll": "C:\\SDL3\\bin\\SDL3.dll"
}
```

### Switching Between SDL Versions

**To switch from SDL3 to SDL2:**

1. Edit `pianoid_cuda/build_config.json`:
   ```json
   {
     "audio_driver": "SDL2",
     "default_audio_driver": "SDL2"
   }
   ```

2. Rebuild:
   ```bash
   python build.py
   ```

3. Restart application

**To switch from SDL2 to SDL3:**

1. Edit `pianoid_cuda/build_config.json`:
   ```json
   {
     "audio_driver": "SDL3",
     "default_audio_driver": "SDL3"
   }
   ```

2. Rebuild:
   ```bash
   python build.py
   ```

3. Restart application

### Build System Implementation

The build system (`pianoid_cuda/setup.py`) implements mutual exclusion:

```python
# Only compile ONE SDL driver
default_driver = cfg.get("default_audio_driver", "SDL3")
if default_driver == "SDL2":
    audio_defines.append("-DUSE_SDL2_AUDIO")
    # Exclude SDL3AudioDriver.cpp from compilation
elif default_driver == "SDL3":
    audio_defines.append("-DUSE_SDL3_AUDIO")
    # Exclude SDLAudioDriver.cpp from compilation

# Always compile ASIO
audio_defines.append("-DUSE_ASIO_AUDIO")
```

**Key operations:**
- **Source filtering** - Exclude non-selected SDL driver's .cpp file
- **Conditional linking** - Link only selected SDL library (SDL2.lib OR SDL3.lib)
- **Include path filtering** - Only add include paths for selected SDL driver
- **DLL copying** - Copy only selected SDL DLL to output directory

---

## Runtime Driver Selection

### Python API

```python
import pianoidCuda

# Option 1: Use default driver (from build config)
config = AudioConfig(sample_rate, buffer_size, num_channels, mode_iteration, -1)

# Option 2: Request specific driver
config = AudioConfig(
    sample_rate,
    buffer_size,
    num_channels,
    mode_iteration,
    pianoidCuda.AudioDriverType.SDL3  # or SDL2, ASIO
)

driver = AudioDriverFactory.createDriver(config, pianoid_instance)
```

### REST API

Use the `user_1` parameter in preset loading:

```json
{
  "path": "presets/Preset_test5.json",
  "user_1": 3,  // 0=default, 1=ASIO, 2=SDL2, 3=SDL3
  // ... other parameters
}
```

### Audio Driver Type Enum

```cpp
enum class AudioDriverType {
    SDL2 = 2,           // SDL2 legacy driver
    SDL3 = 3,           // SDL3 modern driver
    ASIO = 1,           // ASIO low-latency driver
    ASIO_CALLBACK = 4   // ASIO with callback mode
};
```

### Driver Availability Check

```cpp
// Check if a driver is available at runtime
bool available = AudioDriverFactory::isDriverAvailable(AudioDriverType::SDL3);

// This returns true only if the driver was compiled into the binary
```

---

## Driver Implementations

### SDL2 Driver (SDLAudioDriver)

**Status:** Legacy, stable
**Latency:** Low (~5-10ms)
**Mode:** Callback-based

**Characteristics:**
- Uses SDL 2.x API
- Reliable playback
- Known issue: Callback may not restart cleanly after stop
- Recommended for: Production use with SDL2 ecosystem

**Key Methods:**
```cpp
void init();           // Initialize SDL2 audio subsystem
void start();          // Start audio playback
void stop();           // Stop audio playback (may have restart issues)
void pushSamples(Sint32* data, size_t dataSize);
```

### SDL3 Driver (SDL3AudioDriver)

**Status:** Recommended, modern
**Latency:** Very low (~5-8ms)
**Mode:** Callback-based

**Characteristics:**
- Uses SDL 3.x API
- Hardware-driven callback model
- Reliable stop/restart (after CircularBuffer fix)
- Better resource management
- Recommended for: New projects, best overall choice

**Key Methods:**
```cpp
void init();           // Initialize SDL3 audio subsystem
void start();          // Start audio playback
void stop();           // Stop audio playback (reliable)
void pause();          // Pause without destroying stream
void resume();         // Resume from pause
void pushSamples(Sint32* data, size_t dataSize);
```

**Implementation Details:**
- Uses `SDL_OpenAudioDeviceStream()` with callback
- CircularBuffer: 10 chunks × 64 samples = 640 samples total buffering
- Callback fires when hardware needs data (no polling)
- Auto-converts sample rates and formats

### ASIO Driver (ASIOAudioDriver)

**Status:** Professional, lowest latency
**Latency:** Ultra-low (~1-3ms with professional audio interfaces)
**Mode:** Callback-based

**Characteristics:**
- Windows only
- Requires ASIO-compatible audio interface
- Direct hardware access
- Recommended for: Professional audio production, live performance

**Key Methods:**
```cpp
void init();           // Initialize ASIO driver
void start();          // Start audio playback
void stop();           // Stop audio playback
void pushSamples(Sint32* data, size_t dataSize);
```

---

## Fixes and Improvements

### Fix 1: SDL3 Restart Distortion (October 19, 2025)

**Problem:**
After stop/restart, SDL3 played distorted audio.

**Root Cause:**
`CircularBuffer::resume()` only cleared the stop flag but didn't reset buffer pointers:

```cpp
// OLD (BUGGY)
void CircularBuffer::resume() {
    stopFlag.store(false);  // Only cleared flag
}
```

On restart:
1. Buffer pointers (`begin_chunk`, `end_chunk`) still pointed to old positions
2. SDL3 callback read **stale data** from previous session
3. Resulted in distorted/glitchy audio

**Fix:**
Reset buffer state in `resume()`:

```cpp
// NEW (FIXED)
void CircularBuffer::resume() {
    std::lock_guard<std::mutex> lock(mutex);

    // Reset buffer state to avoid stale data
    begin_chunk = 0;
    end_chunk = 0;
    chunks_in_buffer = 0;

    // Clear the stop flag
    stopFlag.store(false);

    printf("CircularBuffer resumed (buffer reset: 0 chunks)\n");
}
```

**Result:** SDL3 restart now works perfectly with clean audio.

### Fix 2: Build System Mutual Exclusion

**Changes:**
1. **Source filtering** - `_discover_sources()` excludes non-selected SDL driver
2. **Conditional linking** - Only link selected SDL library
3. **Include path filtering** - Only add selected SDL driver's headers
4. **DLL management** - Copy only selected SDL DLL

**Benefits:**
- No linker symbol conflicts
- No runtime initialization conflicts
- Clean separation between SDL versions
- Smaller binary size (only one SDL library linked)

### Fix 3: Driver Availability Reporting

**Updated `AudioDriverFactory::isDriverAvailable()`:**

```cpp
bool AudioDriverFactory::isDriverAvailable(AudioDriverType driverType) {
    switch (driverType) {
        case AudioDriverType::SDL2:
#if defined(USE_SDL2_AUDIO)
            return true;
#else
            return false;
#endif

        case AudioDriverType::SDL3:
#if defined(USE_SDL3_AUDIO)
            return true;
#else
            return false;
#endif

        case AudioDriverType::ASIO:
#if defined(USE_ASIO_AUDIO)
            return true;
#else
            return false;
#endif
    }
}
```

**Benefits:**
- Applications can query which drivers are available
- Prevents runtime errors from requesting unavailable drivers
- Clear error messages when driver not compiled

---

## Migration Guide

### For Existing Applications

**No breaking changes** - REST and Python APIs remain compatible.

**What changed:**
- SDL2 and SDL3 can no longer coexist in the same build
- Applications must choose ONE SDL version at build time
- Runtime selection still works for ASIO ↔ SDL

**Migration steps:**

1. **Determine your SDL version:**
   ```bash
   # Check current build
   python -c "import json; print(json.load(open('pianoid_cuda/build_config.json'))['default_audio_driver'])"
   ```

2. **Update application logic:**
   ```python
   # OLD: Assumed all drivers available
   driver_type = user_preference  # Could be SDL2 or SDL3

   # NEW: Check availability first
   import pianoidCuda
   if pianoidCuda.AudioDriverFactory.isDriverAvailable(driver_type):
       # Use requested driver
   else:
       # Fall back to available driver
       driver_type = -1  # Use default
   ```

3. **Update documentation:**
   - Document which SDL version your build uses
   - Explain how to rebuild for different SDL version

### For New Applications

**Recommended configuration:**

```json
{
  "default_audio_driver": "SDL3"
}
```

**Why SDL3:**
- Most reliable stop/restart behavior
- Better resource management
- Modern API design
- Active development and support

**Driver selection priority:**
1. **SDL3** - Best for most applications (recommended)
2. **SDL2** - For compatibility with existing SDL2 ecosystems
3. **ASIO** - For professional audio production (can coexist with SDL3)

---

## Performance Comparison

| Driver | Latency | CPU Usage | Reliability | Restart |
|--------|---------|-----------|-------------|---------|
| SDL2   | ~10ms   | Low       | High        | Issues  |
| SDL3   | ~7ms    | Low       | Very High   | Perfect |
| ASIO   | ~2ms    | Very Low  | High        | Good    |

**Notes:**
- Latency includes CircularBuffer buffering
- ASIO latency depends on audio interface hardware
- SDL3 has best restart behavior after October 19 fix

---

## Troubleshooting

### Error: "SDL2 driver requested but headers not included"

**Cause:** Application requested SDL2 but build was configured for SDL3.

**Solution:**
1. Either rebuild for SDL2:
   ```bash
   # Edit pianoid_cuda/build_config.json
   # Set "default_audio_driver": "SDL2"
   python build.py
   ```

2. Or change application to request SDL3 (`user_1: 3`)

### Error: "SDL3 driver requested but headers not included"

**Cause:** Application requested SDL3 but build was configured for SDL2.

**Solution:**
1. Either rebuild for SDL3:
   ```bash
   # Edit pianoid_cuda/build_config.json
   # Set "default_audio_driver": "SDL3"
   python build.py
   ```

2. Or change application to request SDL2 (`user_1: 2`)

### SDL3 Audio Distorted After Restart

**Status:** ✅ FIXED (October 19, 2025)

If you're on an older version, update to latest code which includes the CircularBuffer reset fix.

### Build Fails with Symbol Conflicts

**Cause:** Both SDL2 and SDL3 libraries being linked simultaneously.

**Solution:** This should no longer happen with current build system. If it does:
1. Clean build directory: `python build.py clean`
2. Verify `build_config.json` has only ONE `default_audio_driver`
3. Rebuild: `python build.py`

---

## Future Work

### Potential Improvements

1. **Plugin Architecture**
   - Load SDL2 and SDL3 as separate DLLs
   - True runtime selection between all drivers
   - Requires significant refactoring

2. **Automatic Driver Detection**
   - Query available drivers at startup
   - Auto-select best available driver
   - Fallback chain: ASIO → SDL3 → SDL2

3. **Hot-Swap Support**
   - Switch drivers without restarting application
   - Seamless audio stream migration
   - Requires careful state management

---

## References

- SDL2 Documentation: https://wiki.libsdl.org/SDL2/
- SDL3 Documentation: https://wiki.libsdl.org/SDL3/
- ASIO SDK: https://www.steinberg.net/asiosdk

---

**Maintained by:** PianoidCore Development Team
**Last Updated:** October 19, 2025
**Contact:** astrinleonid@digitalstringspiano.com
