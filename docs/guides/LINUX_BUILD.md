# Linux Build & Run Guide

Pianoid runs on Linux as well as Windows. This guide covers Linux-specific
prerequisites, build steps, and known limitations. For the original Windows
walkthrough see [QUICK_START.md](QUICK_START.md).

## Linux limitations

| Component | Linux status |
|---|---|
| CUDA synthesis kernel | Supported |
| SDL3 audio driver | Supported (recommended) |
| SDL2 audio driver | Supported (legacy) |
| ASIO audio driver | **Not supported** — Windows only (depends on COM, ole32, advapi32). Excluded from the Linux build. |

The ASIO source files (`asio.cpp`, `asiodrivers.cpp`, `asiolist.cpp`,
`AsioAudioInterface.cpp`, `ASIOAudioDriver.cpp`) are filtered out by
`setup.py` on non-Windows platforms. The runtime `AudioDriverFactory` reports
ASIO as unavailable and selects SDL3 by default.

---

## Prerequisites

Tested on Ubuntu 24.04, but should work on any modern distro that ships
Python 3.12, gcc, and a recent NVIDIA driver + CUDA toolkit.

### Automated install — `setup-packages.sh`

The install root ships a `setup-packages.sh` that mirrors the Windows
`setup-packages.bat` menu. It detects your distro (`apt` / `dnf` / `pacman`
/ `zypper`), reads the version pins from `setup-config.json`, and installs
the build toolchain, Python, CUDA, SDL, and Node.js.

```bash
sudo ./setup-packages.sh             # interactive menu
sudo ./setup-packages.sh --all       # non-interactive
sudo ./setup-packages.sh --cuda      # one component at a time
sudo ./setup-packages.sh --python
sudo ./setup-packages.sh --sdl
sudo ./setup-packages.sh --node
sudo ./setup-packages.sh --build
```

The script must run as root because it installs system packages. Once it
finishes, run `./setup-pianoid.sh` (without sudo) to create the venv and
build the project.

### Manual install — Debian/Ubuntu

If you'd rather install packages directly:

```bash
sudo apt update
sudo apt install -y \
    build-essential pkg-config \
    python3.12 python3.12-venv python3-dev \
    nvidia-cuda-toolkit \
    libsdl3-dev \
    libsdl2-dev \
    nodejs npm \
    lsof curl
```

If `nvidia-cuda-toolkit` is too old or unavailable on your distro, install
CUDA 12.6+ from NVIDIA's official runfile and export `CUDA_HOME` (the build
script honours `CUDA_HOME` and `CUDA_PATH`).

If `libsdl3-dev` isn't packaged for your distro yet, `setup-packages.sh`
will install SDL2 alone and print the source-build steps for SDL3.

### Filesystem requirements

The Python venv at `PianoidCore/.venv/` cannot live on a Windows-style
filesystem (NTFS via ntfs-3g, NTFS via the kernel ntfs3 driver, exFAT,
FAT32). Two NTFS limitations break pip:

1. **No filenames ending in `.`** — pip writes such paths during wheel
   install (`python_rtmidi.dist-info` becomes `python_rtmidi.` mid-extract)
   and crashes with `OSError: [Errno 22] Invalid argument`.
2. **Symlink reparse points are unreliable** — `python -m venv`'s
   `bin/python3.12` symlink to `/usr/bin/python3.12` may be stored as a
   reparse point that ntfs-3g can't read back, breaking the venv.

`setup-pianoid.sh` detects this automatically. When the repo lives on
`fuseblk` / `ntfs` / `exfat` / `vfat` / `msdos`, it relocates the venv to
`~/.cache/pianoid-venv-<hash>` (where `<hash>` is a 12-char SHA-1 of the
repo path, so multiple checkouts get isolated venvs) and writes the
relocated path to `PianoidCore/.venv-pointer` (gitignored, per-machine
state). All build/start scripts (`build_pianoid_cuda.{bat,sh}`,
`build_pianoid_basic.{bat,sh}`, `start-pianoid.{bat,sh}`,
`setup-pianoid.bat`) resolve the venv via:

1. `PIANOID_VENV_DIR` env var (highest priority — set inside `setup-pianoid.sh`
   so subprocess builds inherit it)
2. `PianoidCore/.venv-pointer` file content
3. `PianoidCore/.venv` (default — what fresh ext4/btrfs/xfs installs use)

The previous design — a working-tree symlink at `PianoidCore/.venv` — was
removed because the symlink target is a Linux path that breaks every Windows
tool when the same checkout is shared with a Windows machine. The new design
keeps the working tree free of platform-specific symlinks.

If you'd rather host the venv yourself: either set `PIANOID_VENV_DIR=/your/path`
in your shell before invoking the scripts, or place a `PianoidCore/.venv` directory
(or symlink to one) on any POSIX filesystem before running `setup-pianoid.sh`.

### NVIDIA driver

The NVIDIA kernel driver is **separate from the CUDA toolkit** and must be
installed independently. The toolkit (`nvcc` + `libcudart`) gives you the
ability to *build* CUDA code; the driver gives you the ability to *run* it.
Without the driver Pianoid will build successfully but the backend will
fail at runtime with `RuntimeError: no CUDA-capable device is detected`.

Verify with:

```bash
nvidia-smi                                # must show your GPU
cat /proc/driver/nvidia/version           # must list a driver version
```

Install on Ubuntu:

```bash
sudo ubuntu-drivers autoinstall           # auto-detect
# or pin a specific version:
sudo apt install nvidia-driver-560
sudo reboot
```

The driver version must be ≥ the minimum required by your CUDA toolkit
(CUDA 12.0 needs driver ≥ 525.60.13; CUDA 12.6 needs ≥ 560.x).

### SDL3

If `libsdl3-dev` is unavailable on your distro, build SDL3 from source and
either install it system-wide (`make install`) or set `SDL3_DIR` to the
install prefix.

---

## Step 1 — Clone repositories

Clone the four component repos into sibling directories under the install
root:

```bash
mkdir -p ~/pianoid && cd ~/pianoid
git clone https://github.com/DSPianoid/PianoidInstall
cd PianoidInstall
git clone https://github.com/DSPianoid/PianoidCore
git clone https://github.com/DSPianoid/PianoidBasic
git clone -b Status_indicator_OK https://github.com/DSPianoid/PianoidTunner
```

## Step 2 — Run the installer

```bash
cd ~/pianoid/PianoidInstall
./setup-pianoid.sh
```

This script:

1. Creates `PianoidCore/.venv/` (Python 3.12 venv) and installs
   `requirements.txt`.
2. Builds and installs PianoidBasic into the venv.
3. Builds PianoidCuda (release + debug) via `build_pianoid_cuda.sh`.
4. Runs `npm install` in PianoidTunner.

## Step 3 — Start the application

```bash
cd ~/pianoid/PianoidInstall
./start-pianoid.sh
```

This launches `npm run dev` in PianoidTunner, which starts:

* **Launcher** on port 3001 (manages backend lifecycle)
* **React dev server** on port 3000 (UI)

The browser opens automatically at <http://localhost:3000>. Click APPLY in the
UI to start the Flask backend on port 5000.

---

## Manual build (incremental)

After making C++/CUDA changes:

```bash
cd PianoidCore
./build_pianoid_cuda.sh --light --release   # incremental
# or
./build_pianoid_cuda.sh --heavy --release   # full clean rebuild
```

For Python middleware-only changes you don't need to rebuild — just restart
the backend.

After making PianoidBasic changes:

```bash
cd PianoidCore
./build_pianoid_basic.sh
```

---

## Verifying the install

```bash
PianoidCore/.venv/bin/python -c "import pianoidCuda; print(pianoidCuda.__file__)"
```

The output must point inside `PianoidCore/.venv/`, not the repo-root `.venv/`.
On Linux the extension is `pianoidCuda.cpython-312-x86_64-linux-gnu.so`
(filename suffix varies by Python version).

---

## Toolchain detection

`PianoidCore/detect_paths.py` autodetects gcc, CUDA, and SDL on Linux. It
honours these environment variables:

* `CUDA_HOME` / `CUDA_PATH` — root of the CUDA toolkit (containing `bin/nvcc`)
* `SDL3_DIR` — root of the SDL3 install (containing `include/SDL3` and `lib/`)
* `SDL2_DIR` — same for SDL2
* `CUDA_ARCHES` — comma-separated GPU compute capabilities (e.g. `89` for
  Ada / RTX 4070; default `80,86,89`)

Run it standalone to check:

```bash
PianoidCore/.venv/bin/python PianoidCore/detect_paths.py --out /tmp/cfg.json
```

A successful run writes `pianoid_cuda/build_config.json` with `"platform":
"linux"` and exits 0. A failure prints which components are missing and the
hints needed to fix it.

---

## Troubleshooting

### `nvcc: command not found`

The CUDA toolkit is not on PATH. Either install `nvidia-cuda-toolkit` (Debian
package) or export `CUDA_HOME=/usr/local/cuda` (or wherever the runfile
installed CUDA).

### `libcudart.so.X: cannot open shared object`

The runtime can't find `libcudart`. The `setup.py` adds the CUDA libdir as an
RPATH entry on the built `.so`, so this usually doesn't happen. If it does,
add the CUDA libdir to `LD_LIBRARY_PATH`:

```bash
export LD_LIBRARY_PATH="/usr/local/cuda/lib64:${LD_LIBRARY_PATH:-}"
```

### `libSDL3.so.X: cannot open shared object`

SDL3 isn't installed system-wide. Either `sudo apt install libsdl3-0` (or
equivalent) or rebuild after pointing `SDL3_DIR` at a working SDL3 install.

### Audio driver fails to initialize

ASIO is not available on Linux. The default SDL3 driver requires PulseAudio,
PipeWire, or ALSA. Verify with:

```bash
PianoidCore/.venv/bin/python -c "import pianoidCuda; print(pianoidCuda.AudioDriverFactory.getBestAvailableDriver())"
```

The output should be `AudioDriverType.SDL3` (or `SDL2` if only SDL2 was
detected).

### Port already in use

`launcher.js` clears stale processes on ports 3001/5000/5001 at startup using
`lsof -ti tcp:<port>` and `kill -TERM`. If `lsof` is missing, install it
(`sudo apt install lsof`) or kill the stragglers manually.
