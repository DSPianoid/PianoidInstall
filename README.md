# Pianoid

Real-time GPU-accelerated physical modeling piano synthesizer. Simulates piano string acoustics by solving wave equations on the GPU, producing physically accurate sound at interactive latency.

```
PianoidTunner  (React/TypeScript)   -- parameter UI, visualization, MIDI input
      |  HTTP REST
pianoid_middleware  (Python/Flask)   -- orchestration, REST API, MIDI routing
      |  C API / pybind11
pianoid_cuda  (CUDA C++)            -- wave equation solver, 256 strings x 256 modes
      +
PianoidBasic  (Python)              -- physical domain model, string geometry, excitation curves
```

## Requirements

- **Windows 10+** (64-bit)
- **NVIDIA GPU** with compute capability 7.5+ (RTX 2060 or newer)
- **Git**

All other dependencies (Python, CUDA Toolkit, Visual Studio Build Tools, SDL, Node.js) are installed automatically by the setup script.

## Installation

### 1. Clone

```bat
git clone https://github.com/DSPianoid/PianoidInstall
cd PianoidInstall
clone-packages.bat
```

This clones PianoidCore, PianoidBasic, and PianoidTunner as sibling directories.

### 2. Install system prerequisites

Run as **Administrator**:

```bat
setup-packages.bat
```

Select option 1 (normal install). Installs Python 3.12, VS 2022 Build Tools, CUDA 12.6, SDL2/SDL3, and Node.js 20. Versions are configured in `setup-config.json`.

A restart may be required after this step.

### 3. Build all packages

```bat
setup-pianoid.bat
```

This creates the Python virtual environment, builds PianoidBasic, compiles the CUDA extension, and installs frontend dependencies. Build output is logged to `PianoidCore\build.log`.

### 4. Run

```bat
start-pianoid.bat
```

Opens two terminal windows (backend Flask server + frontend React dev server). The browser should open automatically at `http://localhost:3000`.

| Service | URL |
|---------|-----|
| Frontend UI | http://localhost:3000 |
| Backend API | http://localhost:5000 |
| Health check | http://localhost:5000/health |

## Verification

1. `http://localhost:5000/health` returns JSON with `"status"` field
2. Backend status badge in the UI (top-right) shows green
3. Load a preset via **Load / Save**, then press a key on the virtual piano or a connected MIDI device

## Customizing the build

Edit `setup-config.json` to change dependency versions or target only your GPU architecture (faster builds):

```json
{
  "versions": { "python": "3.12.0", "cuda": "12.6.0", "nodejs": "20.18.0" },
  "cuda": { "architectures": ["89"] }
}
```

Architecture values: `75` (Turing/RTX 2000), `80`/`86` (Ampere/RTX 3000), `89` (Ada/RTX 4000).

## Troubleshooting

- **CUDA build fails**: verify `nvcc` is on PATH and GPU architecture is in `setup-config.json`. Run `PianoidCore\.venv\Scripts\python detect_paths.py` to diagnose.
- **`import pianoidCuda` fails**: check that `SDL3.dll` and `cudart64_*.dll` are next to the `.pyd` in `PianoidCore\.venv\Lib\site-packages\`. See `PianoidCore\build.log`.
- **Backend won't start**: ensure you're using `PianoidCore\.venv` (not the root `.venv`).

## Documentation

Full documentation is available via MkDocs:

```bat
cd PianoidInstall
pip install mkdocs mkdocs-material
mkdocs serve -a localhost:8001
```

Then open http://localhost:8001. Key pages:

- [Quick Start Guide](docs/guides/QUICK_START.md) -- detailed setup walkthrough
- [System Overview](docs/architecture/SYSTEM_OVERVIEW.md) -- architecture and data flow
- [Build System](docs/architecture/BUILD_SYSTEM.md) -- compilation pipeline and env vars
- [REST API](docs/modules/pianoid-middleware/REST_API.md) -- all HTTP endpoints

## Project structure

```
PianoidInstall/
    PianoidCore/           Flask backend + CUDA synthesis engine
    PianoidBasic/          Python domain model (pip package)
    PianoidTunner/         React 18 frontend
    setup-packages.bat     Install system dependencies (admin)
    setup-pianoid.bat      Build all packages
    start-pianoid.bat      Launch the application
    setup-config.json      Version and build configuration
    clone-packages.bat     Clone sub-repositories
    docs/                  MkDocs documentation
```

## Contact

**Maintainer:** Astrin Leonid
**Email:** astrinleonid@digitalstringspiano.com
