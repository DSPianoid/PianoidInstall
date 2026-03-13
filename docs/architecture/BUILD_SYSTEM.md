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
      link  pianoidCuda.pyd (or pianoidCuda_debug.pyd)
      copy  SDL2.dll / SDL3.dll + cudart64_*.dll (release only)
        |
        v
  pianoidCuda.pyd + pianoidCuda_debug.pyd  (importable from .venv)
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

The output is one or two Python extension modules:

```
pianoidCuda.pyd          (release variant)
pianoidCuda_debug.pyd    (debug variant, optional)
```

Loaded in middleware via `import pianoidCuda`. When the debug variant is selected
at runtime, `pianoidCuda_debug` is aliased as `pianoidCuda` in `sys.modules`.
The extension exposes the full C++ Pianoid API through pybind11 bindings defined
in the `.cu` / `.cpp` sources.

---

## Build Variants (Debug / Release)

`setup.py` supports two build variants controlled by the `PIANOID_BUILD_VARIANT` env var:

| Variant | Module name | Optimization | `PIANOID_DEBUG_DATA` | GPU memory |
|---------|-------------|-------------|----------------------|------------|
| `release` (default) | `pianoidCuda` | `-O3 -use_fast_math` (nvcc), `/O2` (MSVC) | OFF | ~170 MB |
| `debug` | `pianoidCuda_debug` | `-O2` (nvcc), `/Od` (MSVC) | ON | ~170 MB + ~113 MB debug |

Both variants can be installed simultaneously — they are separate pip packages with
different module names. The middleware selects which to import at runtime.

### Building variants

```bash
# Release only (default, backward compatible)
build_pianoid_cuda.bat --heavy

# Debug only
build_pianoid_cuda.bat --heavy --debug

# Both variants (builds release first, then debug)
build_pianoid_cuda.bat --heavy --both

# Incremental + both
build_pianoid_cuda.bat --light --both
```

### Runtime selection

Set `PIANOID_USE_DEBUG=1` before starting the server, or pass `use_debug_build=True`
to `initialize_pianoid()`. The middleware aliases `pianoidCuda_debug` as `pianoidCuda`
via `sys.modules`, so all existing import sites work unchanged.

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `PIANOID_BUILD_CONFIG` | Override path to `build_config.json` |
| `PIANOID_BUILD_VARIANT` | `release` (default) or `debug` — controls module name and flags |
| `PIANOID_INCREMENTAL_BUILD` | Set to `1` to enable incremental `.cu` recompilation |
| `PIANOID_USE_DEBUG` | Set to `1` at runtime to import `pianoidCuda_debug` as `pianoidCuda` |
| `CUDA_ARCHES` | Comma-separated compute capabilities, e.g. `"80,86,89"` |
| `CUDA_PATH` | CUDA installation root hint |
| `SDL2_DIR` / `SDL_DIR` | SDL2 root hint |
| `SDL3_DIR` | SDL3 root hint |
| `VCToolsInstallDir` | MSVC tools root hint |

---

## Troubleshooting

### `LINK : fatal error LNK1181: cannot open input file 'SDL3.lib'`

`detect_paths.py` could not find the SDL3 library directory. The script scans for
`SDL3-*` directories on the system drive root (e.g. `C:\SDL3-3.1.6\lib\x64\`).

**Diagnosis:** Run `detect_paths.py` standalone and check the output:

```bash
cd PianoidCore
.venv/Scripts/python detect_paths.py --project-root pianoid_cuda --out /dev/null
```

Check the `sdl3_libdir` field. If empty, the directory structure doesn't match expectations
(`<root>/include/` and `<root>/lib/x64/` must both exist).

**Fixes (in order of preference):**
1. Install SDL3 to a standard location: `C:\SDL3-<version>\` with `include\` and `lib\x64\`
2. Pass `--sdl3` hint: edit `build_pianoid_cuda.bat` step [4/6] to add `--sdl3 "C:\path\to\SDL3"`
3. Set `SDL3_DIR` environment variable to the SDL3 root

**Important:** `build_pianoid_cuda.bat` runs `detect_paths.py` on every build (step [4/6]),
regenerating `build_config.json`. Manual edits to `build_config.json` are overwritten.
To persist changes, fix the discovery inputs (directory layout, env vars, or CLI hints).

### Build succeeds but `import pianoidCuda` fails

The `.pyd` file is installed into the `.venv` `site-packages/`. Check:

```bash
.venv/Scripts/python -c "import pianoidCuda; print(pianoidCuda.__file__)"
```

If it fails with a DLL error, verify that `SDL3.dll` and `cudart64_*.dll` are present
next to the `.pyd` file. The build copies them automatically; if missing, the DLL source
paths in `build_config.json` (`sdl3_dll`, `cuda_home`) may be incorrect.

### `--heavy` vs `--light` build modes

| Mode | Behavior |
|------|----------|
| `--heavy` (default) | Full clean, uninstall, cache purge, rebuild from scratch |
| `--light` | Incremental — keeps build cache, skips uninstall/purge |

`--heavy` uninstalls `pianoidCuda` before building. If the build then fails, the package
is gone. Use `--light` for iterative development; use `--heavy` only when a clean
rebuild is needed (e.g. after changing `setup.py` or pybind11 bindings).
