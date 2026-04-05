---
name: startup
description: Diagnose and fix Pianoid installation, build, and startup failures — toolchain detection, CUDA compilation, server launch, port conflicts, audio driver issues.
user-invocable: true
argument-hint: <problem description — e.g. "backend won't start", "CUDA build failed", "no audio output", "fresh install", "port 5000 in use">
---

# Pianoid Installation, Build & Startup Skill

This skill is the single reference for all installation, build, and startup operations. Invoke it when:

- The standard startup procedure (`start-pianoid.bat` or `npm run dev`) fails
- A build step fails (PianoidBasic, PianoidCuda, frontend)
- A fresh installation needs to be performed or verified
- External dependencies are missing or misconfigured
- Non-standard installation/build/startup is required
- Audio driver initialization fails
- Port conflicts prevent services from starting

## Critical Rules

1. **Documentation first** — before investigating source code, read the relevant docs:
   - `docs/guides/QUICK_START.md` — full installation and startup reference
   - `docs/guides/STARTUP_TROUBLESHOOTING.md` — known failure modes and fixes
   - `docs/architecture/BUILD_SYSTEM.md` — build pipeline, environment variables, toolchain detection
   - `docs/modules/pianoid-cuda/AUDIO_DRIVERS.md` — driver selection and configuration
2. **Never blanket-kill processes** — always kill by specific PID, never `taskkill /F /IM python.exe` or `taskkill /F /IM node.exe`
3. **Use the correct venv** — always `PianoidCore\.venv`, never root `.venv/` or system Python
4. **Port-specific cleanup** — use `netstat -ano | findstr :<port>` to identify PIDs before killing

## Knowledge Base

### System Architecture

```
PianoidInstall/                    (installer + launcher repo)
  PianoidCore/                     (backend: Flask + CUDA engine)
    .venv/                         (Python virtual environment — THE one to use)
    pianoid_middleware/             (Flask server)
      backendserver.py             (entry point)
      presets/BaselinePreset1.json (default preset)
    pianoid_cuda/                   (CUDA extension source)
      setup.py                     (custom build_ext with nvcc)
      build_config.json            (auto-generated toolchain paths)
    build_pianoid_cuda.bat         (CUDA build script)
    build_pianoid_basic.bat        (PianoidBasic build script)
    detect_paths.py                (toolchain auto-detection)
    build.log                      (CUDA compiler output)
  PianoidBasic/                    (domain model package)
  PianoidTunner/                   (React frontend)
    server/launcher.js             (Node.js backend lifecycle manager)
    package.json                   (scripts: start, dev, build)
  setup-pianoid.bat                (full build: venv + basic + cuda + npm)
  setup-packages.bat               (system deps: Python, CUDA, VS, SDL, Node)
  start-pianoid.bat                (launcher startup script)
  detect_paths.py                  (toolchain detection — parent copy)
  setup-config.json                (version specs, CUDA architectures)
```

### Ports

| Port | Service | Started by |
|------|---------|-----------|
| 3000 | React frontend | `npm start` or `npm run dev` |
| 3001 | Node.js launcher (backend manager) | `npm run dev` only |
| 5000 | Flask backend (CUDA engine) | Launcher APPLY button or manual `python backendserver.py` |

### External Dependencies

| Dependency | Version | Required | Installed by |
|-----------|---------|----------|-------------|
| Windows 10+ (64-bit) | 10.0+ | Yes | — |
| NVIDIA GPU (sm_75+) | Turing+ | Yes | — |
| NVIDIA Driver | Latest | Yes | Manual / Windows Update |
| Visual Studio 2022 Build Tools | C++ workload | Yes | `setup-packages.bat` |
| CUDA Toolkit | 12.6 | Yes | `setup-packages.bat` |
| Python | 3.12 | Yes | `setup-packages.bat` |
| Node.js | 20 LTS | Yes | `setup-packages.bat` |
| SDL2 | 2.30.8 | One of SDL2/SDL3 | `setup-packages.bat` |
| SDL3 | 3.1.6 | One of SDL2/SDL3 | `setup-packages.bat` |
| pybind11 | any | Yes | `pip install` (in venv) |
| ASIO driver | any | Optional | Manual (ASIO4ALL / interface driver) |

### Build Commands

| Task | Command | Location |
|------|---------|----------|
| Full setup (all 4 steps) | `setup-pianoid.bat` | `PianoidInstall/` |
| System dependencies | `setup-packages.bat` (as admin) | `PianoidInstall/` |
| PianoidBasic only | `build_pianoid_basic.bat` | `PianoidCore/` |
| CUDA full clean, both variants | `build_pianoid_cuda.bat --heavy --both` | `PianoidCore/` |
| CUDA incremental, release only | `build_pianoid_cuda.bat --light --release` | `PianoidCore/` |
| CUDA incremental, both variants | `build_pianoid_cuda.bat --light --both` | `PianoidCore/` |
| Toolchain detection (diagnostic) | `.venv/Scripts/python detect_paths.py --project-root pianoid_cuda --out NUL` | `PianoidCore/` |
| Frontend dependencies | `npm install` | `PianoidTunner/` |

### Startup Commands

| Method | Command | Result |
|--------|---------|--------|
| **UI method (standard)** | `start-pianoid.bat` | Opens terminal with launcher + React. Backend starts on APPLY click. |
| **UI method (manual)** | `cd PianoidTunner && npm run dev` | Same as above without pre-flight checks |
| **CLI backend only** | `cd PianoidCore && .venv\Scripts\activate && cd pianoid_middleware && python backendserver.py` | Flask on :5000, no preset loaded |
| **CLI frontend only** | `cd PianoidTunner && npm start` | React on :3000 (no launcher on :3001) |
| **Debug build** | `set PIANOID_USE_DEBUG=1 && python backendserver.py` | Loads `pianoidCuda_debug` |

### Startup Parameters (`POST /load_preset`)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `path` | `presets/BaselinePreset1.json` | Preset file (relative to `pianoid_middleware/`) |
| `audio_driver_type` | `4` | `0`=default, `1`=ASIO, `2`=SDL2, `3`=SDL3, `4`=ASIO Callback |
| `sample_rate` | `48` | kHz (values < 1000 multiplied by 1000) |
| `volume` | `120` | MIDI-style 0–127 |
| `string_iterations` | `4` | Solver iterations per sample |
| `cycle_iterations` | `64` | Samples per synthesis cycle (min 16) |
| `audio_buffer_size` | `4` | Buffer chunks: 2=low latency, 4=balanced, 8=stable |
| `array_size` | `384` | Spatial points per string (384–512) |
| `audio_on` | `1` | Enable audio output |
| `start_right_away` | `1` | 0/3=init only, 1=start in background thread |
| `listen_to_midi` | `0` | Start MIDI listener on load |
| `listen_to_modes` | `1` | 0=bridge displacement, 1=mode forces |
| `use_cuda` | `1` | GPU synthesis |
| `debug_mode` | `0` | Load debug CUDA build |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `PIANOID_USE_DEBUG` | `1` = load debug CUDA build at runtime |
| `PIANOID_BUILD_VARIANT` | `release` or `debug` — controls setup.py output |
| `PIANOID_BUILD_CONFIG` | Override `build_config.json` path |
| `PIANOID_INCREMENTAL_BUILD` | `1` = skip unchanged `.cu` files |
| `CUDA_ARCHES` | Comma-separated compute capabilities |
| `CUDA_PATH` / `CUDA_HOME` | CUDA root hint |
| `SDL2_DIR` / `SDL3_DIR` | SDL root hint |
| `VCToolsInstallDir` | MSVC tools root hint |

## Execution Steps

### Step 1: Read Documentation

Read the relevant documentation for the reported problem:

```
docs/guides/QUICK_START.md                    — installation and startup procedures
docs/guides/STARTUP_TROUBLESHOOTING.md        — known failure modes and recovery
docs/architecture/BUILD_SYSTEM.md             — build pipeline and toolchain detection
docs/modules/pianoid-cuda/AUDIO_DRIVERS.md    — audio driver configuration
docs/modules/pianoid-middleware/REST_API.md    — /load_preset parameters and health checks
```

### Step 2: Classify the Problem

Determine the failure category:

| Category | Symptoms | Start at |
|----------|----------|----------|
| **Missing dependencies** | Build fails immediately, tool not found | Step 3A |
| **Build failure** | nvcc error, linker error, import failure | Step 3B |
| **Port conflict** | Address in use, connection refused on wrong port | Step 3C |
| **Backend startup failure** | Flask starts but /load_preset fails, crash | Step 3D |
| **Audio failure** | No sound, driver init error, distortion | Step 3E |
| **Frontend failure** | npm error, blank page, "not connected" | Step 3F |
| **Fresh installation** | Nothing set up yet | Step 3G |

### Step 3A: Missing Dependencies

1. Check what's installed:

```bash
where python && python --version
where nvcc && nvcc --version
where node && node --version
where cl    # MSVC compiler
```

2. For missing components, run `setup-packages.bat` as administrator (option 1 for full install, or options 2-4 for individual components)

3. After installing CUDA or VS Build Tools, a system restart may be required

4. Verify toolchain detection:

```bash
cd PianoidCore
.venv/Scripts/python detect_paths.py --project-root pianoid_cuda --out NUL
```

### Step 3B: Build Failure

1. Check `PianoidCore/build.log` for the actual compiler error
2. Run toolchain detection standalone to verify paths
3. Common fixes:
   - **File in use**: stop backend → retry build
   - **SDL not found**: install SDL or set `SDL2_DIR`/`SDL3_DIR`
   - **CUDA arch error**: check `setup-config.json` architecture list matches your GPU
   - **pybind11 missing**: `pip install pybind11` in the venv

4. For persistent issues, do a full clean rebuild:

```bash
cd PianoidCore
build_pianoid_basic.bat
build_pianoid_cuda.bat --heavy --both
```

### Step 3C: Port Conflict

1. Identify what's using the port:

```bash
netstat -ano | findstr ":5000\|:3000\|:3001"
```

2. Kill specific PIDs (NOT blanket process kills):

```bash
taskkill /pid <PID> /T /F
```

3. If using the launcher, try the kill-stale endpoint:

```bash
curl -X POST http://localhost:3001/api/kill-stale
```

### Step 3D: Backend Startup Failure

1. Check health: `curl http://localhost:5000/health`
2. Look at the backend terminal output for Python tracebacks
3. Verify correct Python: `PianoidCore\.venv\Scripts\python` (not system Python)
4. Verify packages installed:

```bash
cd PianoidCore
.venv/Scripts/python -c "import pianoidCuda; import Pianoid; print('OK')"
```

5. Try loading preset with minimal parameters:

```bash
curl -X POST http://localhost:5000/load_preset \
  -H "Content-Type: application/json" \
  -d '{"path": "presets/BaselinePreset1.json", "audio_driver_type": 2, "start_right_away": 1}'
```

### Step 3E: Audio Failure

1. Check driver status: `curl http://localhost:5000/health` — check `lifecycle.audio_driver_active`
2. If ASIO fails, fall back to SDL2 (`audio_driver_type: 2`)
3. Check Windows audio output device in Sound settings
4. Try playing a note: `curl -X POST http://localhost:5000/play -H "Content-Type: application/json" -d '{"pitch": 60, "velocity": 100}'`
5. Check volume: `curl http://localhost:5000/get_parameter/runtime/volume`

### Step 3F: Frontend Failure

1. Check Node.js version: `node --version` (requires 20.x)
2. Reinstall dependencies:

```bash
cd PianoidTunner
rm -rf node_modules
npm install
```

3. If using `npm start` (no launcher), start backend manually in separate terminal
4. If blank page, check browser console (F12) for errors

### Step 3G: Fresh Installation

Execute the full installation sequence:

```bash
cd PianoidInstall

# 1. Clone sub-repos (if not already cloned)
clone-packages.bat

# 2. Install system dependencies (as admin)
setup-packages.bat

# 3. Build everything
setup-pianoid.bat

# 4. Verify
cd PianoidCore
.venv/Scripts/python -c "import pianoidCuda; import Pianoid; print('OK')"

# 5. Start
cd ..
start-pianoid.bat
```

### Step 4: Verify Fix

After applying a fix:

1. **Build verification**: `.venv/Scripts/python -c "import pianoidCuda; print('OK')"`
2. **Backend health**: `curl http://localhost:5000/health`
3. **Audio verification**: play a note through the UI or API and confirm audio output
4. **Full stack**: open http://localhost:3000, click APPLY, play a note

### Step 5: Report

Summarize what was found and fixed:

- What was the root cause
- What fix was applied
- Whether the system is now operational
- Any remaining issues or recommendations
- Link to relevant documentation section for future reference
