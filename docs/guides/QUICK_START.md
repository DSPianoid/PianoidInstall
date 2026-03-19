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

The PianoidCore repository contains batch scripts for building:

```bat
cd PianoidInstall\PianoidCore
build_pianoid_complete.bat
```

This will:
1. Create a Python virtual environment at `PianoidCore\.venv`
2. Install `PianoidBasic` (the domain model package) into the venv via `pip install -e`
3. Install all Python dependencies from `requirements.txt`
4. Compile the CUDA extension (`pianoid_cuda`) against the detected CUDA toolkit
5. Install frontend dependencies for PianoidTunner via `npm install`

If the build fails on the CUDA step, verify that `nvcc` is on the system PATH and that the GPU architecture is supported. Run `detect_paths.py` to diagnose SDL and CUDA path detection:

```bat
cd PianoidInstall\PianoidCore
.venv\Scripts\activate.bat
python detect_paths.py
```

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

## Starting the Backend Server Manually

To start the Flask backend server without `start-pianoid.bat`:

```bat
cd PianoidInstall\PianoidCore
.venv\Scripts\activate.bat
cd pianoid_middleware
python backendserver.py
```

Or without activating:

```bat
cd PianoidInstall\PianoidCore
.venv\Scripts\python.exe pianoid_middleware\backendserver.py
```

The server starts on `http://localhost:5000`. Verify with:

```bat
curl http://localhost:5000/health
```

To use the debug CUDA build, set the environment variable before starting:

```bat
set PIANOID_USE_DEBUG=1
python backendserver.py
```

---

## Step 4 — Run

From the install root:

```bat
start-pianoid.bat
```

The script performs pre-flight checks:
- `PianoidCore` directory exists
- `PianoidCore\pianoid_middleware\backendserver.py` exists
- `PianoidCore\.venv` exists
- `PianoidTunner\node_modules` exists

If all checks pass it opens two terminal windows:

| Window | Command | What it does |
|---|---|---|
| PianoidCore Backend | `.venv\Scripts\activate.bat && python backendserver.py` | Flask server, CUDA engine, audio driver |
| PianoidCore Frontend | `npm start` | React development server |

The backend starts first; the script waits 3 seconds before launching the frontend.

---

## Step 5 — Access

| Service | URL |
|---|---|
| Frontend (React UI) | http://localhost:3000 |
| Backend API (Flask) | http://localhost:5000 |
| Health check | http://localhost:5000/health |

The browser should open automatically. If not, navigate to `http://localhost:3000` manually.

---

## Verification Steps

1. Open `http://localhost:5000/health` in a browser. The response should be a JSON object with `"status": "not_started"` or `"healthy"`. A connection refused error means the backend did not start.

2. In the frontend, the `BackendStatusIndicator` badge (top-right of the UI) should show green. If it shows red/orange, the backend is unreachable or the CUDA engine failed to initialise.

3. Click **Load / Save** and load a preset file. After loading, the virtual piano should populate with available notes and the Feedin/Feedback matrices should render.

4. Press a key on the virtual piano or connected MIDI device. The backend should synthesise a note and play it through the audio output.

5. Check `PianoidCore\build.log` if the CUDA build step produced errors — it contains the full compiler output.

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
