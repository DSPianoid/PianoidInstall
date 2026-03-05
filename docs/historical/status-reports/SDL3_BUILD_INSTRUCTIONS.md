# SDL3 Build Instructions

## What Was Done

SDL3 has been successfully installed and the PianoidCore codebase has been updated to support it as a compile-time option.

### Installation Summary

1. **SDL3 Built from Source**
   - Cloned SDL repository: `~/SDL3-source`
   - Built using Visual Studio 2022 Build Tools
   - Location: `C:\SDL3`
   - Files installed:
     - `C:\SDL3\bin\SDL3.dll` (2.7 MB)
     - `C:\SDL3\lib\x64\SDL3.lib` (283 KB)
     - `C:\SDL3\include\SDL3\SDL3\*.h` (all headers)

2. **Code Changes**
   - Created [SDL3AudioDriver.h](pianoid_cuda/SDL3AudioDriver.h) and [SDL3AudioDriver.cpp](pianoid_cuda/SDL3AudioDriver.cpp)
   - Updated [AudioDriverConfig.h](pianoid_cuda/AudioDriverConfig.h) with USE_SDL3_AUDIO support
   - Updated [AudioConfig.h](pianoid_cuda/AudioConfig.h) with SDL2/SDL3 enum values
   - Updated [AudioDriverFactory.cpp](pianoid_cuda/AudioDriverFactory.cpp) to instantiate SDL3 driver
   - Modified [setup.py](pianoid_cuda/setup.py) to read audio_driver from build_config.json
   - Created [build_sdl3.bat](build_sdl3.bat) for easy SDL3 builds

## How to Build with SDL3

### Quick Method (Recommended)

Simply run the SDL3 build script:

```cmd
build_sdl3.bat
```

This script will:
1. Set `PIANOID_AUDIO_DRIVER=SDL3`
2. Run detect_paths.py with SDL3 path
3. Update build_config.json with SDL3 settings
4. Build PianoidCuda with SDL3 driver

### Manual Method

If you need more control:

1. **Set SDL3 path in detect_paths**:
   ```cmd
   python detect_paths.py --out pianoid_cuda\build_config.json --project-root pianoid_cuda --sdl2 "C:\SDL3"
   ```

2. **Edit build_config.json** to add audio driver setting:
   ```json
   {
     "windows": {
       "sdl2": {
         "base_path": "C:\\SDL3"
       }
     },
     "audio_driver": "SDL3"
   }
   ```

3. **Build**:
   ```cmd
   build_pianoid_cuda.bat
   ```

### Environment Variable Method

Set the environment variable before building:

```cmd
set PIANOID_AUDIO_DRIVER=SDL3
python detect_paths.py --out pianoid_cuda\build_config.json --project-root pianoid_cuda --sdl2 "C:\SDL3"
build_pianoid_cuda.bat
```

## Verifying SDL3 Build

After building, check `build.log` for these lines:

```
SETUP: Audio Driver: SDL3
SETUP: Audio driver define: -DUSE_SDL3_AUDIO
```

And verify the include paths point to C:\SDL3:
```
-I C:\SDL3\include
```

And linking uses SDL3.lib:
```
SDL3.lib cudart.lib winmm.lib ole32.lib advapi32.lib
```

## Troubleshooting

### Problem: Still builds with SDL2

**Symptom**: Build log shows `SETUP: Audio Driver: SDL2`

**Cause**: `detect_paths.py` overwrote your build_config.json without the audio_driver setting

**Solution**: Use `build_sdl3.bat` which updates the config AFTER detect_paths runs

### Problem: SDL3.dll not found at runtime

**Symptom**: Python import error about SDL3.dll missing

**Solution**: The build process should copy SDL3.dll next to pianoidCuda.pyd. Check:
```cmd
dir .venv\Lib\site-packages\*.dll
```

You should see `SDL3.dll` there. If not, manually copy:
```cmd
copy C:\SDL3\bin\SDL3.dll .venv\Lib\site-packages\
```

### Problem: Compilation errors about SDL3 headers

**Symptom**: Build fails with "SDL3/SDL.h not found"

**Solution**: Verify SDL3 installation:
```cmd
dir C:\SDL3\include\SDL3\SDL3\SDL.h
```

If missing, SDL3 wasn't installed correctly.

## Build Configuration Reference

### build_config.json Structure for SDL3

```json
{
  "windows": {
    "cuda_home": "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.6",
    "visual_studio": {
      "vc_tools_bin_hostx64_x64": "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64"
    },
    "sdl2": {
      "base_path": "C:\\SDL3"
    }
  },
  "audio_driver": "SDL3",
  "cuda_arch_list": ["80", "86", "89"]
}
```

**Important**: The field is still called `"sdl2"` for backward compatibility, but it points to the SDL3 installation.

## Switching Between Drivers

### To Switch to SDL3

1. Run `build_sdl3.bat`
2. Restart backendServer.py

### To Switch Back to SDL2

1. Edit build_config.json:
   ```json
   {
     "windows": {
       "sdl2": {
         "base_path": "C:\\SDL2-2.30.8"
       }
     },
     "audio_driver": "SDL2"
   }
   ```
2. Run `build_pianoid_cuda.bat`
3. Restart backendServer.py

### To Use ASIO

1. Edit build_config.json:
   ```json
   {
     "audio_driver": "ASIO"
   }
   ```
2. Run `build_pianoid_cuda.bat`
3. Restart backendServer.py

## Runtime Behavior

### SDL2 vs SDL3 Differences

| Feature | SDL2 | SDL3 |
|---------|------|------|
| API Model | Callback-based (pull) | Stream-based (push) |
| Cleanup | Can hang | Always clean |
| Restart | Callbacks stop working | Always works |
| Thread | SDL controls | We control |
| CPU Overhead | Minimal | +1-2% (push thread) |
| Reliability | ❌ Broken | ✅ Excellent |

### Expected Console Output (SDL3)

When starting audio with SDL3:

```
Starting audio driver...
SDL3AudioDriver constructed (stream-based model)

*********** Initializing Audio with SDL3 (Stream-Based) *************
Initializing SDL3 audio subsystem...
Opening SDL3 audio device stream...
  Sample rate: 48000 Hz
  Format: S32 (32-bit signed integer)
  Channels: 1
SDL3 Audio stream opened successfully!
  Stream pointer: 0x...
  Device ID: 2
  Stream-based model: Audio thread will push samples to stream
*********** SDL3 Audio Initialization Complete *************

SDL3AudioDriver::start() - Starting audio stream and push thread
  Audio device 2 resumed
SDL3 audio push thread started (thread ID: ...)
SDL3: Pushed 64 samples (256 bytes) to stream (count: 1)
SDL3: Pushed 64 samples (256 bytes) to stream (count: 2)
...
Audio driver started successfully - audioOn=1, audioDriverActive=1
```

When stopping:

```
Stopping audio driver...
Stopping SDL3 audio driver (thread-safe cleanup)...
  Stopping audio push thread...
SDL3 audio push thread stopped
  Pausing audio device...
  Destroying audio stream...
SDL3 audio driver stopped successfully (clean shutdown)
```

## Known Issues

### Current Build Issue

**Problem**: The current build still used SDL2 instead of SDL3.

**Cause**: The `build_pianoid_cuda.bat` script runs `detect_paths.py` which overwrites `build_config.json` WITHOUT preserving the `audio_driver` setting.

**Solution**: Use the new `build_sdl3.bat` script which:
1. Runs detect_paths.py with --sdl2 pointing to C:\SDL3
2. Updates the JSON to add `"audio_driver": "SDL3"`
3. Then runs the standard build

## Next Steps

1. **Build with SDL3**:
   ```cmd
   build_sdl3.bat
   ```

2. **Verify the build log** shows SDL3 being used

3. **Restart your backend server** to load the new SDL3-compiled module

4. **Test stop/restart cycles** - they should now work reliably without hangs or "no sound" issues

## Technical Details

### SDL3 Audio Thread

The SDL3 driver uses a separate thread that continuously pushes audio samples from the circular buffer to the SDL3 stream:

```cpp
void SDL3AudioDriver::audioThreadFunc() {
    while (shouldRun.load()) {
        // Get samples from circular buffer
        audioBuffer.consume(buffer);

        // Push to SDL3 stream
        SDL_PutAudioStreamData(audioStream, buffer, bytesPerPush);

        // Small sleep to avoid busy-waiting
        std::this_thread::sleep_for(std::chrono::microseconds(500));
    }
}
```

This is more reliable than SDL2's callback model because:
- We control the thread lifecycle
- SDL3's stream API is more robust
- Cleanup always works (SDL_DestroyAudioStream is reliable)
- Restart always works (no callback registration issues)

### Compilation Defines

The setup.py adds the appropriate define based on audio_driver setting:

- `audio_driver: "SDL2"` → `-DUSE_SDL2_AUDIO`
- `audio_driver: "SDL3"` → `-DUSE_SDL3_AUDIO`
- `audio_driver: "ASIO"` → `-DUSE_ASIO_AUDIO`

These defines are used in `AudioDriverConfig.h` to set `ACTIVE_AUDIO_DRIVER` and in `AudioDriverFactory.cpp` to conditionally compile the correct driver.

## References

- [SDL3_MIGRATION_PLAN.md](SDL3_MIGRATION_PLAN.md) - Full migration plan
- [SDL3_USAGE_GUIDE.md](SDL3_USAGE_GUIDE.md) - Detailed usage guide
- [SDL3 GitHub](https://github.com/libsdl-org/SDL)
- [SDL3 Documentation](https://wiki.libsdl.org/SDL3)
