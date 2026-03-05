# Pianoid Build System

## Toolchain Requirements

| Component | Version | Purpose |
|---|---|---|
| Python | 3.12.x | Middleware runtime, build scripts |
| MSVC (Visual Studio 2022) | VC Tools 14.x | C++ compilation, CUDA host compiler |
| Windows SDK | 10.x | System headers and libraries |
| CUDA Toolkit | 12.6.x | nvcc, CUDA runtime, GPU libraries |
| SDL2 (optional) | 2.30.x | SDL2 audio driver |
| SDL3 (optional) | 3.1.x | SDL3 audio driver (preferred if present) |
| Node.js | 20.x LTS | React frontend build |
| pybind11 | any pip-installable | C++/Python binding headers |

At least one of SDL2 or SDL3 must be present. SDL3 is preferred when both are found.
ASIO is always compiled in on Windows regardless of SDL availability.

---

## Build Pipeline Overview

```
setup-packages.bat
  (installs Python, VS Build Tools, CUDA, SDL, Node.js via PowerShell)
        |
        v
build_pianoid_basic.bat
  (builds PianoidBasic pure-Python wheel, installs into .venv)
        |
        v
build_pianoid_cuda.bat
  [1] Clean artifacts (.egg-info, build/, dist/, *.pyd, *.obj)
  [2] pip uninstall pianoidCuda
  [3] pip cache purge
  [4] detect_paths.py  -->  build_config.json
  [5] pip install --upgrade pip setuptools wheel
  [6] pip install --force-reinstall PianoidCore/pianoid_cuda/
        |
        v
  setup.py (pianoid_cuda/setup.py)
    _discover_sources()  --> *.cu + *.cpp (SDL driver filtered)
    build_ext.build_extension()
      nvcc  *.cu  -->  *.obj   (CUDA compilation)
      MSVC  *.cpp -->  linked  (C++ compilation)
      link  pianoidCuda.pyd
      copy  SDL2.dll / SDL3.dll + cudart64_*.dll
        |
        v
  pianoidCuda.pyd  (importable from .venv)
        |
        v
(optional) npm install / npm run build
  (React frontend, separate from Python build)
```

---

## Step 1: Package Installation (setup-packages.bat)

`setup-packages.bat` is an interactive launcher that delegates to `setup-dev.ps1`
(PowerShell). It installs system-level dependencies using component versions defined
in `setup-config.json`:

```json
{
  "versions": {
    "python": "3.12.0",
    "cuda":   "12.6.0",
    "nodejs": "20.18.0",
    "sdl2":   "2.30.8",
    "sdl3":   "3.1.6"
  },
  "cuda": {
    "architectures": ["75", "80", "86", "89"]
  }
}
```

Options include selective reinstall of individual components (Python, CUDA, Node.js)
or a full reinstall of all components.

---

## Step 2: PianoidBasic Wheel (build_pianoid_basic.bat)

`build_pianoid_basic.bat` builds and installs the pure-Python domain model package:

1. Activates `.venv` inside `PianoidCore/`
2. Locates the sibling `PianoidBasic/` directory (contains `pyproject.toml`)
3. Cleans `build/`, `dist/`, `*.egg-info` from previous builds
4. Runs `python -m build` to produce an sdist and wheel in `PianoidBasic/dist/`
5. Installs the newest `.whl` with `pip install --no-deps --force-reinstall`

After this step, `import Pianoid` works inside the `.venv`.

---

## Step 3: Toolchain Detection (detect_paths.py)

`detect_paths.py` is a pure-stdlib Python script that auto-discovers all build tools
and writes `pianoid_cuda/build_config.json`. It accepts optional hints via CLI flags:

```
python detect_paths.py \
  --out   pianoid_cuda/build_config.json \
  --cuda  "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.6" \
  --sdl2  "C:\SDL2-2.30.8" \
  --sdl3  "C:\SDL3-3.1.6" \
  --project-root pianoid_cuda/
```

Discovery logic per component:

**MSVC (`_find_msvc`)**
1. `cl.exe` on `PATH` -> derives MSVC tools root from path components
2. `VCToolsInstallDir` environment variable
3. `vswhere.exe` via `ProgramFiles(x86)\Microsoft Visual Studio\Installer\`
4. Default path: `Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\<latest>`

**CUDA (`_find_cuda`)**
1. `--cuda` hint argument
2. `CUDA_PATH` environment variable
3. Glob latest `v*` under `Program Files\NVIDIA GPU Computing Toolkit\CUDA\`

**SDL2 (`_find_sdl2`) / SDL3 (`_find_sdl3`)**
1. `--sdl2` / `--sdl3` hint argument
2. `SDL2_DIR` / `SDL3_DIR` / `SDL_DIR` environment variable
3. Glob `SDL2-*` / `SDL3-*` on system drive root, `Program Files`, home directory,
   and common dev directories (`dev`, `Development`, `libs`, `Libraries`, `SDK`)
4. Prefers versioned directory names (sorted descending)

**CUDA architectures (`_default_arches`)**
1. `CUDA_ARCHES` environment variable (comma-separated compute capabilities)
2. `torch.cuda.get_device_capability()` if PyTorch is installed
3. Default: `["80", "86", "89"]` (RTX 30xx and 40xx cards)

The generated `build_config.json` contains flat paths, SDL availability flags, and
derived `include_dirs` / `library_dirs` / `libraries` lists. SDL3 is set as the
default driver if found; otherwise SDL2. The config is validated - required fields
are `msvc_cl`, `msvc_tools_root`, `winsdk_root`, `cuda_home`, `cuda_nvcc`,
`python_include`, `python_libdir`, and at least one of `sdl2_root` or `sdl3_root`.

---

## Step 4: CUDA Extension Build (setup.py)

`pianoid_cuda/setup.py` implements a custom `build_ext` class that drives the full
compilation pipeline.

### Source Discovery

`_discover_sources()` globs all `*.cu` and `*.cpp` files from the `pianoid_cuda/`
directory. SDL driver files are filtered: only the selected driver is compiled.

```python
# SDL2 driver excluded when building for SDL3, and vice versa
if "SDLAudioDriver.cpp" in cpp_file and default_driver != "SDL2":
    continue   # exclude SDL2
if "SDL3AudioDriver.cpp" in cpp_file and default_driver != "SDL3":
    continue   # exclude SDL3
```

### CUDA Compilation (nvcc)

Each `.cu` file is compiled individually to a `.obj` file:

```
nvcc -c <source.cu> -o <source.obj>
  --std=c++17
  -O3
  -use_fast_math
  -ccbin <MSVC HostX64/x64 bin>
  -Xcompiler /MD /EHsc -bigobj
  --compiler-options -bigobj
  -DUSE_SDL3_AUDIO          (or USE_SDL2_AUDIO)
  -DUSE_ASIO_AUDIO          (always added on Windows)
  -gencode=arch=compute_80,code=sm_80
  -gencode=arch=compute_86,code=sm_86
  -gencode=arch=compute_89,code=sm_89
  -I <pybind11 include>
  -I <CUDA include>
  -I <pianoid_cuda/>
  -I <Python include>
  -I <SDL include>
```

The arch list comes from `build_config.json` `cuda_arch_list` field. The default
covers compute capabilities 80 (Ampere), 86 (Ampere), and 89 (Ada Lovelace),
plus 75 (Turing) when specified in `setup-config.json`.

Incremental builds are supported when `PIANOID_INCREMENTAL_BUILD=1`: each `.cu`
source is skipped if the `.obj` timestamp is newer than the source file.

### C++ / Linking (MSVC via setuptools)

After CUDA compilation, the `.obj` files are passed to the standard setuptools
linker as `extra_objects`. MSVC C++ sources are compiled with:

```
/std:c++17  /O2  /bigobj
```

Preprocessor defines `USE_SDL3_AUDIO` (or `USE_SDL2_AUDIO`) and `USE_ASIO_AUDIO`
are injected into `ext.define_macros` to match the CUDA compilation flags.

### Libraries Linked

```
SDL3       (or SDL2, whichever is the default driver)
cudart     (CUDA runtime)
winmm      (Windows multimedia: ASIO/MIDI)
ole32      (COM: ASIO)
advapi32   (Windows registry)
```

### DLL Deployment

After linking, the build copies runtime DLLs next to `pianoidCuda.pyd`:
- `SDL3.dll` or `SDL2.dll` (default driver only)
- `cudart64_*.dll` (CUDA runtime)

This ensures `import pianoidCuda` works without modifying `PATH`.

### Extension Module

The output is a single Python extension module:

```
pianoidCuda.pyd
```

Loaded in middleware via `import pianoidCuda`. The extension exposes the full C++
Pianoid API through pybind11 bindings defined in the `.cu` / `.cpp` sources.

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `PIANOID_BUILD_CONFIG` | Override path to `build_config.json` |
| `PIANOID_INCREMENTAL_BUILD` | Set to `1` to enable incremental `.cu` recompilation |
| `CUDA_ARCHES` | Comma-separated compute capabilities, e.g. `"80,86,89"` |
| `CUDA_PATH` | CUDA installation root hint |
| `SDL2_DIR` / `SDL_DIR` | SDL2 root hint |
| `SDL3_DIR` | SDL3 root hint |
| `VCToolsInstallDir` | MSVC tools root hint |
