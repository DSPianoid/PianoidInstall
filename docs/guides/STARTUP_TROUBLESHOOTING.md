# Startup & Installation Troubleshooting

This guide covers common failures during installation, building, and startup of the Pianoid system.

---

## Port Conflicts

### Symptom: "Address already in use" or backend won't start

Another process is occupying port 5000 (backend), 3000 (frontend), or 3001 (launcher).

**Diagnosis:**

```bat
netstat -ano | findstr :5000
netstat -ano | findstr :3000
netstat -ano | findstr :3001
```

**Fix — kill by PID (safe):**

```bat
:: Find the PID from netstat output, then:
taskkill /pid <PID> /T /F
```

**Fix — use the launcher's kill-stale endpoint:**

```bash
curl -X POST http://localhost:3001/api/kill-stale
```

!!! warning "Never blanket-kill processes"
    Do **not** use `taskkill /F /IM python.exe` or `taskkill /F /IM node.exe` — this kills MCP servers, Claude Code, and other unrelated processes. Always kill by specific PID.

---

## CUDA / GPU Failures

### Symptom: `import pianoidCuda` fails with DLL error

The `.pyd` extension module cannot find its runtime DLLs.

**Check:**

```bat
cd PianoidInstall\PianoidCore
.venv\Scripts\python -c "import pianoidCuda; print(pianoidCuda.__file__)"
```

**Diagnosis:** Look for `SDL3.dll` (or `SDL2.dll`) and `cudart64_*.dll` next to the `.pyd` file in `site-packages/`. If missing, the build's DLL deployment step failed.

**Fix:** Rebuild with `--heavy`:

```bat
cd PianoidCore
build_pianoid_cuda.bat --heavy --both
```

### Symptom: GPU initialization fails at runtime

The CUDA engine cannot access the GPU after preset load.

**Check:**

```bat
:: Verify CUDA is accessible
.venv\Scripts\python -c "import pianoidCuda; print('CUDA OK')"

:: Check NVIDIA driver
nvidia-smi
```

**Common causes:**

- NVIDIA driver not installed or outdated — update to latest Game/Studio driver
- GPU compute capability < 7.5 (pre-Turing) — not supported
- Another process holding exclusive GPU access — check Task Manager for GPU usage
- CUDA toolkit version mismatch — the build was compiled against a different CUDA version than installed

### Symptom: `nvcc` not found during build

**Check:**

```bat
where nvcc
echo %CUDA_PATH%
```

**Fix:**

1. Install CUDA Toolkit 12.6 from NVIDIA (or run `setup-packages.bat`)
2. Ensure `CUDA_PATH` points to the installation root (e.g. `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.6`)
3. Add `%CUDA_PATH%\bin` to system PATH

Run `detect_paths.py` to see all search strategies and what was found:

```bat
cd PianoidCore
.venv\Scripts\python detect_paths.py --project-root pianoid_cuda --out NUL
```

---

## Build Failures

### Symptom: MSVC / Visual Studio not found

`detect_paths.py` cannot locate the C++ compiler.

**Fix:**

1. Install Visual Studio 2022 Build Tools with the "Desktop development with C++" workload
2. If installed but not detected, set `VCToolsInstallDir` environment variable
3. Or ensure `cl.exe` is on PATH (run from "Developer Command Prompt for VS 2022")

### Symptom: SDL library not found (`LNK1181: cannot open input file 'SDL3.lib'`)

**Fix (in order of preference):**

1. Install SDL3 to a standard location: `C:\SDL3-<version>\` with `include\` and `lib\x64\` subdirectories
2. Set `SDL3_DIR` (or `SDL2_DIR`) environment variable to the SDL root
3. Pass `--sdl3` hint to `detect_paths.py`

At least one of SDL2 or SDL3 must be present. SDL3 is preferred when both are found.

### Symptom: "File in use" error (`[WinError 5] Access is denied`) during CUDA build

The `.pyd` file is locked by a running Python process (usually the backend server).
The uninstall step cannot delete the file and the package ends up uninstalled.

**Diagnosis:**

```bash
tasklist //M pianoidCuda.cp312-win_amd64.pyd 2>/dev/null | grep python
tasklist //M cudart64_12.dll 2>/dev/null | grep python
```

**Fix:** Kill the specific PID, then rebuild. Never use `taskkill //F //IM python.exe` —
that kills MCP servers and Claude Code:

```bash
taskkill //F //PID <pid>
```

If a launcher is running, `curl -X POST http://localhost:3001/api/stop-backend` is a
safer alternative. Retry via `build_pianoid_cuda.bat --heavy --release`.

### Symptom: Code changes appear to have no effect after rebuild

You edit a `.cu` / `.cpp` file, rebuild with direct `pip install`, but runtime behavior
is unchanged. Sabotage tests that should produce silence or distortion produce identical
output to the baseline.

**Root cause:** `pip install --force-reinstall --no-cache-dir pianoid_cuda/` sometimes
silently returns a cached stale `.pyd` from setuptools build isolation, even though `.obj`
files regenerate and `nvcc` runs.

**Fix:** always rebuild via the batch script:

```bash
cd D:/repos/PianoidInstall/PianoidCore && ./build_pianoid_cuda.bat --heavy --release
```

**Verify** a known new string from your edit is in the installed binary:

```bash
grep -a "<some-new-string-from-your-edit>" \
  PianoidCore/.venv/Lib/site-packages/pianoidCuda.cp312-win_amd64.pyd
```

Zero matches means a stale pyd was installed. See
[BUILD_SYSTEM.md — Canonical CUDA Rebuild](../architecture/BUILD_SYSTEM.md#canonical-cuda-rebuild-read-this-first).

### Symptom: Debug variant fails to import / release loads instead

You run with `PIANOID_USE_DEBUG=1` or `"debug_mode": 1`, but log output shows
`pianoidCuda` (release) was loaded — or you get `ImportError: DLL load failed while
importing pianoidCuda_debug`.

**Root cause:** `PIANOID_BUILD_VARIANT=debug` rebuild **skips DLL copy**. Without
`cudart64_12.dll` and `SDL3.dll` next to `pianoidCuda_debug.pyd`, the debug module
cannot load. The middleware's `select_cuda_variant` catches the ImportError silently
and falls back to release, so code edits that live only in the debug build appear to
have zero effect.

**Fix:** always rebuild release before debug, so the DLLs are present:

```bash
./build_pianoid_cuda.bat --heavy --release   # copies DLLs
./build_pianoid_cuda.bat --heavy --debug     # reuses DLLs
# or in one call:
./build_pianoid_cuda.bat --heavy --both
```

Verify both variants load:

```bash
PianoidCore/.venv/Scripts/python -c "import pianoidCuda; import pianoidCuda_debug; print('OK')"
```

See [BUILD_SYSTEM.md — Debug variant DLL trap](../architecture/BUILD_SYSTEM.md#debug-variant-dll-trap).

### Symptom: Build succeeds but wrong variant loaded (normal case)

The middleware loads `pianoidCuda` (release) by default. To use the debug build:

```bat
set PIANOID_USE_DEBUG=1
python backendserver.py
```

Or pass `"debug_mode": 1` in the `/load_preset` request body. Both variants must
already be built and importable (see the previous symptom).

---

## Backend Startup Failures

### Symptom: Flask server starts but `/load_preset` fails

**Check the backend console output** for Python tracebacks. Common causes:

- **Preset file not found** — the path is relative to `pianoid_middleware/`. Default: `presets/BaselinePreset1.json`
- **Missing Python package** — run `pip list` in the venv to verify `Pianoid` (PianoidBasic) and `pianoidCuda` are installed
- **Wrong Python interpreter** — always use `PianoidCore\.venv\Scripts\python`, never system Python

### Symptom: Audio driver fails to initialize

**ASIO issues:**

- No ASIO driver installed — install ASIO4ALL or use your audio interface's ASIO driver
- ASIO device in use by another application (DAW, etc.) — close the other application
- **Fallback:** switch to SDL2 (`"audio_driver_type": 2`)

**SDL issues:**

- SDL DLL not found next to `.pyd` — rebuild with `--heavy`
- SDL version mismatch — ensure the installed SDL version matches what was used during build

### Symptom: Backend starts but no audio output

1. Check audio driver selection: query `GET /health` — the `lifecycle.audio_driver_active` field should be `true`
2. Verify volume is non-zero: `curl http://localhost:5000/get_parameter/runtime/volume`
3. Check Windows audio output device — ensure the correct playback device is selected in Windows Sound settings
4. Try playing a note: `curl -X POST http://localhost:5000/play -H "Content-Type: application/json" -d '{"pitch": 60, "velocity": 100}'`

---

## Frontend Startup Failures

### Symptom: `npm run dev` fails

**Check:**

```bat
node --version    :: Requires 20.x
npm --version
```

**Fix:**

```bat
cd PianoidTunner
rm -rf node_modules
npm install
npm run dev
```

### Symptom: Frontend loads but shows "Backend not connected"

The launcher (port 3001) or the backend (port 5000) is not running.

- If using `start-pianoid.bat` / `npm run dev`: the backend starts only after clicking APPLY in the UI
- If using `npm start` (no launcher): start the backend manually in a separate terminal

### Symptom: Browser shows blank page or React errors

1. Clear browser cache or try incognito mode
2. Check the browser console (F12) for JavaScript errors
3. Verify `npm run dev` is still running in the terminal (check for crash output)

---

## First-Run Checklist

Use this checklist to verify a fresh installation:

- [ ] All prerequisites installed: `setup-packages.bat` completed without errors
- [ ] Build completed: `setup-pianoid.bat` all 4 steps passed
- [ ] CUDA import works: `.venv\Scripts\python -c "import pianoidCuda; print('OK')"`
- [ ] PianoidBasic import works: `.venv\Scripts\python -c "import Pianoid; print('OK')"`
- [ ] Frontend deps installed: `PianoidTunner\node_modules` exists
- [ ] Frontend starts: `npm run dev` in PianoidTunner starts without errors
- [ ] Browser opens: http://localhost:3000 shows the Pianoid UI
- [ ] Backend starts: click APPLY — status indicator turns green
- [ ] Audio works: press a virtual piano key — sound plays
- [ ] MIDI works (optional): connect MIDI device — keys trigger sound

---

## Log File Locations

| Log | Location | Contents |
|---|---|---|
| CUDA build log | `PianoidCore\build.log` | Full nvcc/MSVC compiler output |
| Backend console | Terminal running `backendserver.py` | Flask requests, CUDA init, errors |
| Launcher console | Terminal running `npm run dev` | Backend spawn/kill events |
| WebSocket console | `ws://localhost:3001/ws/console` | Real-time backend log stream (from UI) |
| PianoidLogger | `PianoidCore\pianoid_middleware\logs\` | File-based engine logs (if enabled) |

---

## Recovery Procedures

### Full clean rebuild

When the build state is corrupted or multiple issues compound:

```bat
cd PianoidInstall\PianoidCore

:: Clean and rebuild PianoidBasic
build_pianoid_basic.bat

:: Full clean CUDA rebuild (both variants)
build_pianoid_cuda.bat --heavy --both

:: Reinstall frontend deps
cd ..\PianoidTunner
rd /s /q node_modules
npm install
```

### Reset to known-good state

```bat
cd PianoidInstall

:: Pull latest code
git pull
cd PianoidCore && git pull && cd ..
cd PianoidBasic && git pull && cd ..
cd PianoidTunner && git pull && cd ..

:: Full rebuild
setup-pianoid.bat
```
