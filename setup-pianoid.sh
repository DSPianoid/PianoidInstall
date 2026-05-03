#!/usr/bin/env bash
# ============================================================================
# setup-pianoid.sh — Linux equivalent of setup-pianoid.bat
# Builds the venv, PianoidBasic, PianoidCuda, and frontend node_modules.
# Assumes system packages (Python 3.12, build-essential, nvidia-cuda-toolkit,
# libsdl3-dev, node, npm) are already installed. Run setup-packages.sh
# (companion script) or your distro's package manager first.
# ============================================================================
set -u
set -o pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_DIR="$ROOT_DIR/PianoidCore"
BASIC_DIR="$ROOT_DIR/PianoidBasic"
TUNNER_DIR="$ROOT_DIR/PianoidTunner"

echo "========================================================================="
echo "Pianoid Package Installation (Linux)"
echo "========================================================================="
echo
echo "Root directory:  $ROOT_DIR"
echo "PianoidCore:     $CORE_DIR"
echo "PianoidBasic:    $BASIC_DIR"
echo "PianoidTunner:   $TUNNER_DIR"
echo

# -- verify directories ------------------------------------------------------
for D in "$CORE_DIR" "$BASIC_DIR" "$TUNNER_DIR"; do
    if [[ ! -d "$D" ]]; then
        echo "ERROR: required directory missing: $D"
        echo "Run clone-packages.sh first."
        exit 1
    fi
done
if [[ ! -f "$TUNNER_DIR/package.json" ]]; then
    echo "ERROR: package.json not found in $TUNNER_DIR"
    exit 1
fi
echo "  OK  All directories found"
echo

# -- STEP 1: Python venv -----------------------------------------------------
echo "[STEP 1/4] Setting up Python virtual environment..."
echo "========================================================================="
PY_BIN="$(command -v python3.12 || command -v python3 || command -v python || true)"
if [[ -z "$PY_BIN" ]]; then
    echo "ERROR: python3.12 / python3 not found on PATH"
    exit 1
fi
PY_MAJ_MIN=$("$PY_BIN" -c "import sys;print('%d.%d'%sys.version_info[:2])")
echo "Python: $PY_BIN ($PY_MAJ_MIN)"

VENV_DIR="$CORE_DIR/.venv"

# Some filesystems can't host a Python venv reliably:
#   - NTFS (mount type "fuseblk" via ntfs-3g, or "ntfs" via kernel ntfs3)
#     rejects filenames ending in '.' (Windows API restriction). pip writes
#     such paths during wheel install (e.g. 'python_rtmidi.dist-info' temp
#     names) and crashes mid-install with EINVAL.
#   - exFAT lacks POSIX symlink support entirely.
# Detect and relocate the venv to $HOME/.cache (assumed ext4) when the repo
# lives on one of these filesystems, then symlink PianoidCore/.venv at the
# expected location so all downstream tooling keeps working unmodified.
CORE_FS="$(stat -f -c '%T' "$CORE_DIR" 2>/dev/null || echo unknown)"
case "$CORE_FS" in
    fuseblk|ntfs|exfat|msdos|vfat)
        # Hash the repo path so multiple checkouts get isolated venvs.
        REPO_HASH=$(echo -n "$ROOT_DIR" | sha1sum | cut -c1-12)
        ALT_VENV="$HOME/.cache/pianoid-venv-$REPO_HASH"
        echo "Repo is on '$CORE_FS' (POSIX-incompatible for Python venv);"
        echo "relocating venv to $ALT_VENV (with symlink at $VENV_DIR)."
        if [[ -L "$VENV_DIR" ]]; then
            # Already a symlink — refresh target if stale
            CURRENT=$(readlink "$VENV_DIR")
            if [[ "$CURRENT" != "$ALT_VENV" ]]; then
                rm -f "$VENV_DIR"
            fi
        elif [[ -d "$VENV_DIR" ]]; then
            # Real dir on NTFS — must remove (it's broken anyway)
            echo "  Removing broken venv at $VENV_DIR ..."
            rm -rf "$VENV_DIR"
        fi
        mkdir -p "$(dirname "$ALT_VENV")"
        if [[ ! -d "$ALT_VENV" ]]; then
            echo "Creating venv at $ALT_VENV ..."
            "$PY_BIN" -m venv "$ALT_VENV"
        fi
        if [[ ! -e "$VENV_DIR" ]]; then
            ln -s "$ALT_VENV" "$VENV_DIR"
        fi
        ;;
    *)
        if [[ ! -d "$VENV_DIR" ]]; then
            echo "Creating virtual environment at $VENV_DIR ..."
            # --copies makes the venv interpreter a real file (not a symlink to
            # /usr/bin/python3.12), so the venv survives if the system Python
            # is upgraded or the partition is moved. Costs ~30MB.
            "$PY_BIN" -m venv --copies "$VENV_DIR"
        else
            echo "Virtual environment already exists at $VENV_DIR"
        fi
        ;;
esac

# Activate
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
"$VENV_DIR/bin/python" -m pip install --upgrade pip setuptools wheel build >/dev/null

if [[ -f "$CORE_DIR/requirements.txt" ]]; then
    echo "Installing Python requirements..."
    "$VENV_DIR/bin/pip" install -r "$CORE_DIR/requirements.txt"
else
    echo "  Note: no requirements.txt found, skipping"
fi
echo "  OK  STEP 1 COMPLETED"
echo

# -- STEP 2: PianoidBasic ----------------------------------------------------
echo "[STEP 2/4] Building PianoidBasic package..."
echo "========================================================================="
if [[ ! -x "$CORE_DIR/build_pianoid_basic.sh" ]]; then
    chmod +x "$CORE_DIR/build_pianoid_basic.sh" 2>/dev/null || true
fi
if [[ ! -f "$CORE_DIR/build_pianoid_basic.sh" ]]; then
    echo "ERROR: build_pianoid_basic.sh not found in $CORE_DIR"
    exit 1
fi
( cd "$CORE_DIR" && bash build_pianoid_basic.sh )
echo "  OK  STEP 2 COMPLETED"
echo

# -- STEP 3: PianoidCuda -----------------------------------------------------
echo "[STEP 3/4] Building PianoidCuda (release + debug)..."
echo "========================================================================="
if [[ ! -f "$CORE_DIR/build_pianoid_cuda.sh" ]]; then
    echo "ERROR: build_pianoid_cuda.sh not found in $CORE_DIR"
    exit 1
fi
chmod +x "$CORE_DIR/build_pianoid_cuda.sh" 2>/dev/null || true
( cd "$CORE_DIR" && bash build_pianoid_cuda.sh --heavy --both )
echo "  OK  STEP 3 COMPLETED"
echo

# -- STEP 4: Frontend dependencies -------------------------------------------
echo "[STEP 4/4] Installing frontend dependencies..."
echo "========================================================================="
if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: Node.js not found on PATH. Install via your package manager."
    exit 1
fi
echo "Node.js version: $(node --version)"

( cd "$TUNNER_DIR" && npm install )
echo "  OK  STEP 4 COMPLETED"
echo

# -- summary -----------------------------------------------------------------
echo "========================================================================="
echo "  SUCCESS: Pianoid installation completed!"
echo "========================================================================="
echo
echo "  [1/4]  Python venv and dependencies"
echo "  [2/4]  PianoidBasic package"
echo "  [3/4]  PianoidCuda (release + debug)"
echo "  [4/4]  Frontend dependencies"
echo
SO_RELEASE=$(ls "$VENV_DIR"/lib/python*/site-packages/pianoidCuda*.so 2>/dev/null | head -n 1 || true)
if [[ -n "$SO_RELEASE" ]]; then
    echo "  OK  pianoidCuda*.so found: $SO_RELEASE"
else
    echo "  ??  pianoidCuda*.so not found in site-packages"
fi
if [[ -d "$TUNNER_DIR/node_modules" ]]; then
    echo "  OK  node_modules found"
else
    echo "  ??  node_modules not found"
fi
echo
echo "To start the application:  ./start-pianoid.sh"
echo "========================================================================="
