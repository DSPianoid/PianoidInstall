# Quick Start Guide

## Prerequisites

The following must be present before installation. `setup-dev.ps1` can install all of them automatically.

| Requirement | Version | Notes |
|---|---|---|
| Windows | 10 or later (64-bit) | Required OS |
| NVIDIA GPU | Compute capability 7.5+ (Turing / RTX 2000 series or newer) | CUDA kernel requires sm_75 minimum |
| Visual Studio Build Tools | 2022 (C++ workload) | Required for building the CUDA extension |
| CUDA Toolkit | 12.6 | Matched to `setup-config.json` default |
| Python | 3.12 | Used by PianoidCore backend |
| Node.js | 20 LTS | Used by PianoidTunner frontend |
| SDL2 | 2.30.8 | Audio output library |
| SDL3 | 3.1.6 | Audio output library (alternative driver) |

GPU compute capability 7.5 corresponds to: RTX 2060/2070/2080, Quadro RTX series, T4, and all later Ampere/Ada cards. The `setup-config.json` lists target architectures `75`, `80`, `86`, `89`.

---

## Step 1 — Clone Repositories

The project consists of three packages that live in sibling directories under a common root.

```bat
REM Create and enter a working directory
mkdir C:\pianoid && cd C:\pianoid

REM Clone the installer/launcher repo first
git clone https://github.com/DSPianoid/PianoidInstall

REM Enter the install root
cd PianoidInstall

REM Clone all three component packages
clone-packages.bat
```

`clone-packages.bat` runs:

```bat
git clone -b Status_indicator_OK https://github.com/DSPianoid/PianoidTunner
git clone https://github.com/DSPianoid/PianoidCore
git clone https://github.com/DSPianoid/PianoidBasic
```

After this step the directory tree is:

```
PianoidInstall\
    PianoidCore\          (Flask backend + CUDA engine)
    PianoidBasic\         (Python domain model package)
    PianoidTunner\        (React 18 frontend)
    setup-dev.ps1
    setup-packages.bat
    start-pianoid.bat
    setup-config.json
    clone-packages.bat
```

---

## Step 2 — Install System Prerequisites

`setup-dev.ps1` is a PowerShell script that downloads and installs all system-level dependencies using `winget` and direct installers. `setup-packages.bat` is a menu wrapper around it.

Run as Administrator:

```bat
setup-packages.bat
```

Select option **1** (normal install). The script will:

1. Install **Python 3.12** if not present
2. Install **Visual Studio 2022 Build Tools** (C++ workload)
3. Install **CUDA Toolkit 12.6**
4. Download and unpack **SDL2 2.30.8** and **SDL3 3.1.6** to `C:\SDL2` and `C:\SDL3`
5. Install **Node.js 20 LTS**

Versions are read from `setup-config.json`. To override a version, edit that file before running the script, or pass command-line flags:

```powershell
.\setup-dev.ps1 -CudaVersion "12.6.0" -NodeVersion "20.18.0" -PythonVersion "3.12.0"
```

Individual components can be skipped:

```powershell
.\setup-dev.ps1 -SkipVS -SkipSDL    # Skip Visual Studio and SDL installation
```

After the script completes, a system restart may be required if VS Build Tools or CUDA were newly installed.

---

## Step 3 — Build All Packages

Once system prerequisites are installed, build the Python virtual environment and compile the CUDA extension:

```bat
cd PianoidInstall
setup-pianoid.bat
```

This runs four steps in sequence:

1. **Python venv** — creates `PianoidCore\.venv`, installs `requirements.txt`
2. **PianoidBasic** — builds the domain model wheel, installs into `.venv`
3. **PianoidCuda** — detects toolchain paths, compiles CUDA extension (release + debug)
4. **Frontend** — runs `npm install` in PianoidTunner

The build takes 5–15 minutes depending on GPU architecture count. Check `PianoidCore\build.log` for compiler output.

### Build individual components

```bat
cd PianoidInstall\PianoidCore

:: PianoidBasic only
build_pianoid_basic.bat

:: CUDA extension — full clean rebuild, both variants
build_pianoid_cuda.bat --heavy --both

:: CUDA extension — incremental rebuild, release only
build_pianoid_cuda.bat --light --release
```

### Diagnosing build failures

If the CUDA step fails, run toolchain detection standalone to see what was found/missing:

```bat
cd PianoidInstall\PianoidCore
.venv\Scripts\python detect_paths.py --project-root pianoid_cuda --out NUL
```

Common issues:

- **`nvcc` not found** — CUDA Toolkit not installed or not on PATH. Set `CUDA_PATH` environment variable.
- **SDL library not found** — install SDL2/SDL3 to `C:\SDL2-<version>` or `C:\SDL3-<version>`, or set `SDL2_DIR`/`SDL3_DIR`.
- **MSVC not found** — install Visual Studio 2022 Build Tools with C++ workload.
- **File in use error** — backend server or Python is still running and holding `.pyd` files. Stop the backend first.

See [Build System](../architecture/BUILD_SYSTEM.md) for the full pipeline reference and environment variables.

---

## Using the Virtual Environment

All Python work (running the server, installing packages, running tests) must use the venv at `PianoidCore\.venv`. There are two ways to use it:

### Option A: Activate the venv (interactive sessions)

```bat
cd PianoidInstall\PianoidCore
.venv\Scripts\activate.bat
```

After activation, the prompt shows `(.venv)` and `python` / `pip` resolve to the venv automatically:

```bat
(.venv) > python -c "import pianoidCuda; print('OK')"
(.venv) > pip list
```

### Option B: Call the venv Python directly (scripts, one-off commands)

```bat
cd PianoidInstall\PianoidCore
.venv\Scripts\python.exe -c "import pianoidCuda; print('OK')"
.venv\Scripts\python.exe -m pip list
```

This is useful when you don't want to activate the venv, e.g. from batch scripts or CI.

> **Important:** Do NOT use the system Python or any other venv. The root `.venv/` (if present) does not contain Pianoid packages. Always use `PianoidCore\.venv`.

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `PIANOID_USE_DEBUG` | Set to `1` to load `pianoidCuda_debug` instead of `pianoidCuda` at runtime |
| `PIANOID_BUILD_VARIANT` | `release` (default) or `debug` — controls which variant `setup.py` builds |
| `PIANOID_BUILD_CONFIG` | Override path to `build_config.json` |
| `PIANOID_INCREMENTAL_BUILD` | Set to `1` to enable incremental `.cu` recompilation |
| `CUDA_ARCHES` | Comma-separated compute capabilities, e.g. `"80,86,89"` |
| `CUDA_PATH` | CUDA installation root hint for `detect_paths.py` |
| `SDL2_DIR` / `SDL3_DIR` | SDL root hint for `detect_paths.py` |

To start the backend with the debug CUDA build:

```bat
set PIANOID_USE_DEBUG=1
cd PianoidInstall\PianoidCore\pianoid_middleware
..\\.venv\Scripts\python backendserver.py
```

---

## Step 4 — Start (UI Method)

The standard way to run Pianoid uses the launcher architecture: a Node.js process manager (port 3001) controls the backend lifecycle from the browser UI.

```bat
start-pianoid.bat
```

The script checks prerequisites (directories, `.venv`, `node_modules`), then opens a terminal running `npm run dev` in PianoidTunner. This starts two services simultaneously:

| Service | Port | Role |
|---|---|---|
| React dev server | 3000 | Frontend UI |
| Node.js launcher | 3001 | Backend process manager + WebSocket console |

The backend (port 5000) is **not started yet** — it launches on demand when you click **APPLY** in the UI.

### Starting the backend from the UI

1. Open http://localhost:3000 in a browser (opens automatically)
2. In the **Settings** sidebar, configure:
   - **Preset path**: `presets/BaselinePreset1.json` (default)
   - **Audio driver**: ASIO Callback (4) if you have an ASIO device, otherwise SDL (2)
   - **Sample rate**: 48000
   - **Volume**: 120
3. Click **APPLY**
4. The frontend calls the launcher (`POST http://localhost:3001/api/start-backend`), which spawns the Flask process
5. The backend initializes the CUDA engine, loads the preset, and starts the audio playback thread
6. The status indicator turns green when ready

### Launcher API (port 3001)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/start-backend` | POST | Spawn Flask backend process |
| `/api/stop-backend` | POST | Graceful shutdown → force kill |
| `/api/kill-stale` | POST | Force-kill any process on port 5000 |
| `/api/backend-status` | GET | Returns `{ running, pid }` |
| `/ws/console` | WebSocket | Real-time backend log stream |

---

## Step 4 (Alternative) — Start via CLI

To start the backend directly without the launcher UI:

### Terminal 1 — Backend

```bat
cd PianoidInstall\PianoidCore
.venv\Scripts\activate.bat
cd pianoid_middleware
python backendserver.py
```

The Flask server starts on http://localhost:5000. It does **not** load a preset or start audio automatically — you must call `/load_preset`.

### Terminal 2 — Frontend (optional)

```bat
cd PianoidInstall\PianoidTunner
npm start
```

This starts only the React dev server on port 3000 (no launcher on 3001).

### Initialize via API

After starting the backend manually, load a preset and start playback:

```bash
curl -X POST http://localhost:5000/load_preset \
  -H "Content-Type: application/json" \
  -d '{
    "path": "presets/BaselinePreset1.json",
    "audio_driver_type": 2,
    "sample_rate": 48,
    "volume": 120,
    "string_iterations": 4,
    "cycle_iterations": 64,
    "audio_buffer_size": 4,
    "array_size": 384,
    "audio_on": 1,
    "start_right_away": 1,
    "listen_to_midi": 0,
    "listen_to_modes": 1,
    "use_cuda": 1,
    "use_simulation": 0,
    "debug_mode": 0
  }'
```

Verify:

```bash
curl http://localhost:5000/health
# Expected: {"status": "healthy", "pianoid_loaded": true, ...}
```

---

## Startup Parameters Reference

Parameters passed to `POST /load_preset` control engine initialization:

| Parameter | Default | Description |
|---|---|---|
| `path` | `presets/BaselinePreset1.json` | Preset file path (relative to `pianoid_middleware/`) |
| `audio_driver_type` | `4` | `0`=default, `1`=ASIO, `2`=SDL2, `3`=SDL3, `4`=ASIO Callback |
| `sample_rate` | `48` | Sample rate in kHz (values < 1000 are multiplied by 1000) |
| `volume` | `120` | MIDI-style volume 0–127 |
| `max_volume` | — | Float, explicit max volume (overrides `volume` if set) |
| `string_iterations` | `4` | Solver iterations per sample |
| `cycle_iterations` | `64` | Samples per synthesis cycle (min 16) |
| `audio_buffer_size` | `4` | Buffer chunks: `2`=low latency, `4`=balanced, `8`=stable |
| `array_size` | `384` | Spatial discretization points per string (384–512) |
| `audio_on` | `1` | `1`=enable audio output, `0`=silent |
| `start_right_away` | `1` | `0`/`3`=init only, `1`=start in background thread |
| `listen_to_midi` | `0` | `1`=start MIDI listener on load |
| `listen_to_modes` | `1` | `0`=bridge displacement output, `1`=mode forces output |
| `use_cuda` | `1` | `1`=GPU synthesis, `0`=CPU fallback |
| `use_simulation` | `0` | `1`=simulation mode |
| `debug_mode` | `0` | `1`=load debug CUDA build (`pianoidCuda_debug`) |

### Audio driver selection guide

| Driver | Code | When to use |
|---|---|---|
| ASIO Callback | `4` | Best: lowest latency, requires ASIO device/driver (e.g. ASIO4ALL, Focusrite, RME) |
| ASIO | `1` | Legacy ASIO mode |
| SDL2 | `2` | Universal fallback, works on any system, higher latency |
| SDL3 | `3` | Newer SDL, same role as SDL2 |
| Default | `0` | Auto-select based on compile-time configuration |

---

## Services and Ports

| Service | Port | Started by |
|---|---|---|
| React frontend | 3000 | `npm start` or `npm run dev` |
| Node.js launcher | 3001 | `npm run dev` only (not `npm start`) |
| Flask backend | 5000 | Launcher APPLY button, or manual `python backendserver.py` |

---

## Verification Steps

1. **Health check**: `curl http://localhost:5000/health` — expect `"status": "healthy"` after preset load, or `"status": "not_started"` if backend is running but no preset loaded yet. Connection refused means the backend process is not running.

2. **Status indicator**: the badge in the top-right of the React UI should show green after APPLY. Red/orange means the backend is unreachable or CUDA initialization failed.

3. **Load preset**: click **APPLY** in Settings (UI) or call `POST /load_preset` (CLI). The virtual piano should populate with available notes.

4. **Play a note**: press a key on the virtual piano or connected MIDI device. Audio should play through the selected audio driver.

5. **Build log**: check `PianoidCore\build.log` for CUDA compiler output if the extension failed to build.

---

## Configuration Reference (`setup-config.json`)

```json
{
  "versions": {
    "python":  "3.12.0",
    "cuda":    "12.6.0",
    "nodejs":  "20.18.0",
    "sdl2":    "2.30.8",
    "sdl3":    "3.1.6"
  },
  "paths": {
    "sdl_root": "C:\\"
  },
  "options": {
    "skip_components": [],
    "force_reinstall_components": [],
    "auto_reboot": false,
    "clean_install": true
  },
  "cuda": {
    "architectures": ["75", "80", "86", "89"]
  }
}
```

To target only your GPU's architecture (faster build):

```json
"cuda": { "architectures": ["86"] }   // RTX 3000 series
"cuda": { "architectures": ["89"] }   // RTX 4000 series
```
