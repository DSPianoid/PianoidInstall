# SDL3 Audio Driver Usage Guide

## Overview

PianoidCore now supports three audio driver options selectable at compile time:
- **SDL2** - Legacy driver (has callback restart bugs, default for backward compatibility)
- **SDL3** - Modern driver (recommended, fixes restart bugs, requires SDL3 installation)
- **ASIO** - Professional audio driver (Windows only)

## Why SDL3?

SDL2 has fundamental bugs:
- Audio callbacks stop being invoked after device restart
- Cleanup functions can hang during shutdown
- Internal state corruption after stop/restart cycles

SDL3 fixes these issues with:
- Complete audio subsystem rewrite
- Stream-based API (more reliable than callbacks)
- Proper cleanup without hangs
- Better thread safety

## Prerequisites for SDL3

### Install SDL3

SDL3 is not included by default. You need to install it manually.

**Option 1: Download Pre-built SDL3 (Windows)**

1. Download SDL3 from: https://github.com/libsdl-org/SDL/releases
2. Look for `SDL3-devel-X.X.X-VC.zip` (Visual C++ development libraries)
3. Extract to a location like `C:\SDL3`
4. Update your `build_config.json` to point to SDL3 instead of SDL2

**Option 2: Build from Source**

```bash
git clone https://github.com/libsdl-org/SDL.git
cd SDL
mkdir build
cd build
cmake ..
cmake --build . --config Release
cmake --install . --prefix C:\SDL3
```

### Update build_config.json

Your `build_config.json` needs to point to SDL3 when using the SDL3 driver.

**For SDL2 (current default):**
```json
{
  "windows": {
    "sdl2": {
      "base_path": "C:\\path\\to\\SDL2"
    }
  }
}
```

**For SDL3:**
```json
{
  "windows": {
    "sdl2": {
      "base_path": "C:\\path\\to\\SDL3"
    }
  },
  "audio_driver": "SDL3"
}
```

Note: The field is still called `sdl2` for backward compatibility, but it should point to your SDL3 installation when using SDL3.

## Compiling with SDL3

### Method 1: Using build_config.json (Recommended)

Add `"audio_driver": "SDL3"` to your `build_config.json`:

```json
{
  "windows": {
    "cuda_home": "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.0",
    "visual_studio": {
      "vc_tools_bin_hostx64_x64": "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Tools\\MSVC\\14.XX.XXXXX\\bin\\Hostx64\\x64"
    },
    "sdl2": {
      "base_path": "C:\\SDL3"
    }
  },
  "audio_driver": "SDL3",
  "cuda_arch_list": ["80", "86", "89"]
}
```

Then build normally:
```bash
build_pianoid_complete.bat
```

### Method 2: Using Environment Variable

Set the environment variable before building:

**Windows (PowerShell):**
```powershell
$env:PIANOID_AUDIO_DRIVER = "SDL3"
build_pianoid_complete.bat
```

**Windows (CMD):**
```cmd
set PIANOID_AUDIO_DRIVER=SDL3
build_pianoid_complete.bat
```

### Method 3: Manual Header Edit

Edit `pianoid_cuda/AudioDriverConfig.h`:

```cpp
// Change this line:
#define USE_SDL2_AUDIO  // Default fallback

// To this:
#define USE_SDL3_AUDIO  // SDL3 modern driver
```

Then build normally.

## Switching Between Drivers

To switch between drivers, you need to **rebuild** the entire PianoidCuda extension:

### Switch to SDL3:
1. Update `build_config.json`: `"audio_driver": "SDL3"`
2. Point `sdl2.base_path` to your SDL3 installation
3. Run `build_pianoid_complete.bat`

### Switch to SDL2 (Legacy):
1. Update `build_config.json`: `"audio_driver": "SDL2"`
2. Point `sdl2.base_path` to your SDL2 installation
3. Run `build_pianoid_complete.bat`

### Switch to ASIO:
1. Update `build_config.json`: `"audio_driver": "ASIO"`
2. Run `build_pianoid_complete.bat`

## Verifying Your Build

After building, check the build log to confirm which driver was compiled:

**Look for this line in build.log:**
```
SETUP: Audio Driver: SDL3
SETUP: Audio driver define: -DUSE_SDL3_AUDIO
```

You should also see:
```
SETUP: Found sources: X cu, Y cpp
SETUP: CUDA files: [..., 'SDL3AudioDriver.cpp', ...]
```

## Runtime Behavior Differences

### SDL2 (Legacy)
- Callback-based (SDL calls your function to request audio)
- Can hang on stop/cleanup
- Callbacks may stop working after restart
- Fast initial startup

### SDL3 (Modern)
- Stream-based (you push audio to SDL's stream)
- Clean shutdown, never hangs
- Reliable restart behavior
- Slightly slower startup (thread creation)

### ASIO
- Professional low-latency audio
- Windows only
- Requires ASIO hardware or ASIO4ALL

## Troubleshooting

### Build Error: "SDL3 driver requested but not compiled"

**Cause:** Runtime code is trying to use SDL3 but it wasn't compiled in.

**Fix:** Ensure you built with SDL3 option enabled (see compilation methods above).

### Build Error: "SDL3/SDL.h not found"

**Cause:** SDL3 headers not in the expected location.

**Fix:**
1. Verify SDL3 is installed
2. Check `build_config.json` points to correct SDL3 path
3. Ensure path contains `include/SDL3/SDL.h`

### Build Error: "Cannot find SDL3.lib"

**Cause:** SDL3 libraries not found during linking.

**Fix:**
1. Verify SDL3 lib files exist at `{base_path}/lib/x64/SDL3.lib`
2. Update setup.py if library path is different

### Runtime Error: "SDL3.dll not found"

**Cause:** SDL3.dll not in PATH or next to pianoidCuda.pyd.

**Fix:**
1. Copy `SDL3.dll` from SDL3 installation to where `pianoidCuda.pyd` is located
2. Or add SDL3's `bin` folder to your PATH

### No Sound After Restart

**If using SDL2:** This is the known bug. Switch to SDL3.

**If using SDL3:**
1. Check console output for "SDL3 audio push thread started"
2. Verify `audioDriverActive=1` in health_check
3. Check for any error messages about SDL_PutAudioStreamData

## Performance Comparison

| Metric | SDL2 | SDL3 | ASIO |
|--------|------|------|------|
| Latency | ~10-20ms | ~10-20ms | ~5-10ms |
| CPU Overhead | Low | Low (+1-2%) | Low |
| Restart Reliability | ❌ Broken | ✅ Excellent | ✅ Excellent |
| Cleanup Behavior | ❌ Can hang | ✅ Clean | ✅ Clean |
| Thread Safety | ⚠️ Limited | ✅ Excellent | ✅ Good |

The 1-2% CPU overhead of SDL3 is due to the push thread, but this is negligible compared to the reliability benefits.

## API Compatibility

The driver selection is **transparent** to Python code. All drivers implement the same `AudioDriverInterface`, so your Python code doesn't change:

```python
# Works with any driver (SDL2, SDL3, ASIO)
pianoid.startApplication()
pianoid.stopApplication()
pianoid.start_pianoid()
pianoid.stop_pianoid()
```

## Migration Checklist

Switching from SDL2 to SDL3:

- [ ] Install SDL3 (download or build from source)
- [ ] Update `build_config.json` with SDL3 path and `"audio_driver": "SDL3"`
- [ ] Run `build_pianoid_complete.bat`
- [ ] Verify build log shows "Audio Driver: SDL3"
- [ ] Test application start/stop cycles
- [ ] Confirm no hangs during shutdown
- [ ] Verify sound works after restart

## Recommended Configuration

For production use, we recommend:

**Option 1: SDL3 (Best for most users)**
```json
{
  "audio_driver": "SDL3",
  "windows": {
    "sdl2": {
      "base_path": "C:\\SDL3"
    }
  }
}
```

**Option 2: ASIO (For professional audio users)**
```json
{
  "audio_driver": "ASIO"
}
```

**Option 3: SDL2 (Only for testing/comparison)**
```json
{
  "audio_driver": "SDL2",
  "windows": {
    "sdl2": {
      "base_path": "C:\\SDL2"
    }
  }
}
```

## Future Plans

- SDL2 will remain available for backward compatibility
- SDL3 will become the **default** in future releases
- ASIO will continue to be supported for professional use cases
- Eventually SDL2 may be deprecated after 6 months of SDL3 stability

## Support

If you encounter issues:

1. Check `build.log` for compilation errors
2. Verify which driver was compiled: Look for "Audio Driver: SDL3" in build.log
3. Check console output during runtime for SDL messages
4. Use health_check endpoint to verify driver status

## References

- SDL3 GitHub: https://github.com/libsdl-org/SDL
- SDL3 Migration Guide: https://github.com/libsdl-org/SDL/blob/main/docs/README-migration.md
- SDL3 Audio Documentation: https://wiki.libsdl.org/SDL3/CategoryAudio
- SDL3 Releases: https://github.com/libsdl-org/SDL/releases
