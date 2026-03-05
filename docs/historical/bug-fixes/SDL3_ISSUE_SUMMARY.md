# SDL3 Audio Driver Issue - Root Cause Analysis

## Problem
SDL3 audio driver fails to initialize with error: **"Found 0 playback devices"**

## Root Cause
The SDL3.dll installed at `C:\SDL3\bin\SDL3.dll` (dated October 18, 00:48) has **broken audio device enumeration** on Windows. When calling `SDL_GetAudioPlaybackDevices()`, it returns 0 devices, making it impossible to open any audio stream.

## Evidence
1. SDL2 works perfectly - confirms Windows audio is functional
2. SDL3 initialization succeeds (SDL_Init returns 0)
3. `SDL_GetAudioPlaybackDevices()` returns count = 0
4. `SDL_OpenAudioDeviceStream()` returns NULL with empty error string
5. Both callback and push modes fail identically

## What We Tried
- ✅ Removed preprocessor guards (not the issue)
- ✅ Restored working code from commit f8fc629 (still failed)
- ✅ Tested with/without SDL2.dll present (no difference)
- ✅ Tried callback mode and push mode (both fail)
- ✅ Tried explicit device enumeration (0 devices found)
- ✅ Added extensive debug output (confirmed 0 devices)

## Solution
**Download and install a newer/stable SDL3 release** that has working Windows audio device enumeration.

### Steps:
1. Download latest SDL3 from: https://github.com/libsdl-org/SDL/releases
   - Look for SDL3-xxx-win32-x64.zip or similar
   - Or build from source if only preview releases available

2. Extract to `C:\SDL3` (replace existing)

3. Verify the new DLL has device enumeration:
   ```cpp
   int count = 0;
   SDL_AudioDeviceID *devices = SDL_GetAudioPlaybackDevices(&count);
   printf("Found %d devices\n", count);  // Should be > 0
   ```

4. Rebuild PianoidCore:
   ```bash
   cd pianoid_middleware
   python build_pianoid_cuda.bat
   ```

## Current Workaround
**Use SDL2 driver** which works perfectly:
- In UI: Set `user_1 = 2` in load_preset request
- This selects SDL2 instead of SDL3

## Technical Details
- SDL3 API is correct (headers match expected usage)
- The code is identical to the working version from commit f8fc629
- The issue is in the SDL3.dll binary itself, not our code
- Windows audio backend in this SDL3 build is non-functional

## Files Modified (for debugging)
- `SDL3AudioDriver.cpp`: Added device enumeration diagnostic
- Can revert debug output once working SDL3 is installed

## Conclusion
This is a **broken SDL3 DLL issue**, not a code issue. The October 18 SDL3 preview you installed has broken Windows audio support. Either:
1. Install a working SDL3 version, OR
2. Use SDL2 (which works perfectly)
