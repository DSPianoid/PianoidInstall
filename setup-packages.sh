#!/usr/bin/env bash
# ============================================================================
# setup-packages.sh — install Pianoid system dependencies on Linux
#
# Companion to setup-packages.bat (Windows). Installs:
#   - Build toolchain (gcc, make, pkg-config, build-essential)
#   - Python 3.12 (interpreter + venv module + headers)
#   - NVIDIA CUDA toolkit (matches versions.cuda from setup-config.json)
#   - SDL2 + SDL3 development libraries
#   - Node.js LTS
#   - Helper utilities (curl, lsof, git)
#
# Usage:
#   sudo ./setup-packages.sh           # interactive menu
#   sudo ./setup-packages.sh --all     # non-interactive: install everything
#   sudo ./setup-packages.sh --python  # only Python
#   sudo ./setup-packages.sh --cuda    # only CUDA
#   sudo ./setup-packages.sh --node    # only Node.js
#   sudo ./setup-packages.sh --sdl     # only SDL2 + SDL3
#   sudo ./setup-packages.sh --build   # only build toolchain
#
# After this script completes, run (without sudo) ./setup-pianoid.sh to
# create the venv and build PianoidBasic / PianoidCuda / Tunner.
# ============================================================================
set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/setup-config.json"

# Allow --help / -h before the root check so users can read usage without sudo.
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    sed -n '1,30p' "$0" | grep -E '^# ' | sed 's/^# \{0,1\}//'
    exit 0
fi

# -- root check --------------------------------------------------------------
if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: this script installs system packages and must run as root."
    echo "Re-run with: sudo $0 $*"
    exit 1
fi

# Capture the invoking user (not root) so we can chown things back if needed.
REAL_USER="${SUDO_USER:-$USER}"

# -- distro detection --------------------------------------------------------
DISTRO_ID=""
DISTRO_LIKE=""
if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    DISTRO_ID="${ID:-}"
    DISTRO_LIKE="${ID_LIKE:-}"
fi

PKG_MANAGER=""
case "$DISTRO_ID $DISTRO_LIKE" in
    *debian*|*ubuntu*) PKG_MANAGER="apt" ;;
    *fedora*|*rhel*|*centos*|*rocky*|*alma*) PKG_MANAGER="dnf" ;;
    *arch*|*manjaro*) PKG_MANAGER="pacman" ;;
    *opensuse*|*suse*) PKG_MANAGER="zypper" ;;
esac

if [[ -z "$PKG_MANAGER" ]]; then
    # Fall back to whichever package manager is on PATH
    for pm in apt dnf pacman zypper; do
        if command -v "$pm" >/dev/null 2>&1; then
            PKG_MANAGER="$pm"
            break
        fi
    done
fi

if [[ -z "$PKG_MANAGER" ]]; then
    echo "ERROR: could not detect a supported package manager on this system."
    echo "Supported: apt (Debian/Ubuntu), dnf (Fedora/RHEL), pacman (Arch), zypper (openSUSE)."
    exit 1
fi

echo "Detected distro: ${DISTRO_ID:-unknown} (using $PKG_MANAGER)"

# -- config loading ----------------------------------------------------------
PY_VERSION="3.12"
CUDA_VERSION="12.6"
NODE_VERSION="20"
SDL2_VERSION="2.30.8"
SDL3_VERSION="3.1.6"

if [[ -r "$CONFIG_FILE" ]] && command -v python3 >/dev/null 2>&1; then
    echo "Loading versions from $CONFIG_FILE ..."
    eval "$(python3 - "$CONFIG_FILE" <<'PY'
import json, sys, shlex
try:
    with open(sys.argv[1]) as f:
        cfg = json.load(f)
    v = cfg.get("versions", {})
    out = {
        "PY_VERSION":   v.get("python", "3.12"),
        "CUDA_VERSION": v.get("cuda",   "12.6"),
        "NODE_VERSION": v.get("nodejs", "20"),
        "SDL2_VERSION": v.get("sdl2",   "2.30.8"),
        "SDL3_VERSION": v.get("sdl3",   "3.1.6"),
    }
    for k, val in out.items():
        print("{}={}".format(k, shlex.quote(str(val))))
except Exception as e:
    print("# config load failed: {}".format(e), file=sys.stderr)
PY
)"
fi

echo "Versions: python=$PY_VERSION cuda=$CUDA_VERSION node=$NODE_VERSION sdl2=$SDL2_VERSION sdl3=$SDL3_VERSION"

# -- pkg manager wrappers ----------------------------------------------------
pkg_update() {
    case "$PKG_MANAGER" in
        apt)    apt update ;;
        dnf)    dnf -y check-update || true ;;  # check-update returns 100 when updates are available
        pacman) pacman -Sy --noconfirm ;;
        zypper) zypper --non-interactive refresh ;;
    esac
}

pkg_install() {
    # Install a list of packages. Skips packages already installed.
    case "$PKG_MANAGER" in
        apt)    DEBIAN_FRONTEND=noninteractive apt install -y "$@" ;;
        dnf)    dnf -y install "$@" ;;
        pacman) pacman -S --noconfirm --needed "$@" ;;
        zypper) zypper --non-interactive install --no-confirm "$@" ;;
    esac
}

# Map a logical name to the distro-specific package(s). Returns an array via
# stdout; empty result means "not directly available".
pkg_for() {
    local name="$1"
    case "$PKG_MANAGER:$name" in
        apt:build)   echo "build-essential pkg-config curl ca-certificates lsof git" ;;
        apt:python)  echo "python${PY_VERSION} python${PY_VERSION}-venv python${PY_VERSION}-dev python3-pip" ;;
        apt:sdl)     echo "libsdl3-dev libsdl2-dev" ;;
        apt:cuda)    echo "nvidia-cuda-toolkit" ;;
        apt:node)    echo "nodejs npm" ;;

        dnf:build)   echo "gcc gcc-c++ make pkgconf-pkg-config curl ca-certificates lsof git" ;;
        dnf:python)  echo "python${PY_VERSION} python${PY_VERSION}-devel python3-pip" ;;
        dnf:sdl)     echo "SDL2-devel" ;;  # SDL3 isn't in stock Fedora yet
        dnf:cuda)    echo "cuda-toolkit-${CUDA_VERSION%%.*}-${CUDA_VERSION##*.}" ;;
        dnf:node)    echo "nodejs npm" ;;

        pacman:build)   echo "base-devel pkg-config curl lsof git" ;;
        pacman:python)  echo "python python-pip python-virtualenv" ;;
        pacman:sdl)     echo "sdl2 sdl3" ;;
        pacman:cuda)    echo "cuda" ;;
        pacman:node)    echo "nodejs npm" ;;

        zypper:build)   echo "patterns-devel-base-devel_basis pkg-config curl ca-certificates lsof git" ;;
        zypper:python)  echo "python${PY_VERSION//./} python${PY_VERSION//./}-devel python3-pip" ;;
        zypper:sdl)     echo "libSDL2-devel" ;;
        zypper:cuda)    echo "" ;;  # use NVIDIA runfile
        zypper:node)    echo "nodejs${NODE_VERSION} npm${NODE_VERSION}" ;;

        *) echo "" ;;
    esac
}

# -- per-component installers ------------------------------------------------
install_build() {
    echo
    echo "[Build toolchain] Installing gcc, make, pkg-config, curl, lsof, git ..."
    local pkgs; pkgs=$(pkg_for build)
    # shellcheck disable=SC2086
    pkg_install $pkgs
    echo "  OK build toolchain installed"
}

install_python() {
    echo
    echo "[Python] Target version: $PY_VERSION"
    local pkgs; pkgs=$(pkg_for python)
    if [[ -z "$pkgs" ]]; then
        echo "  WARN: no Python package mapping for $PKG_MANAGER. Skipping."
        return
    fi
    # shellcheck disable=SC2086
    if ! pkg_install $pkgs 2>/dev/null; then
        # Some distros (older Ubuntu) don't ship Python 3.12 in main repos;
        # add the deadsnakes PPA on Debian/Ubuntu as a fallback.
        if [[ "$PKG_MANAGER" == "apt" ]]; then
            echo "  Python $PY_VERSION not in main repos; adding deadsnakes PPA..."
            pkg_install software-properties-common
            add-apt-repository -y ppa:deadsnakes/ppa
            apt update
            # shellcheck disable=SC2086
            pkg_install $pkgs
        else
            echo "  ERROR: failed to install $pkgs. Install Python $PY_VERSION manually."
            return 1
        fi
    fi
    if command -v "python${PY_VERSION}" >/dev/null 2>&1; then
        echo "  OK python${PY_VERSION} installed: $(python${PY_VERSION} --version 2>&1)"
    else
        echo "  WARN: python${PY_VERSION} not on PATH after install"
    fi
}

install_sdl() {
    echo
    echo "[SDL] Installing SDL2 + SDL3 dev libraries ..."
    local pkgs; pkgs=$(pkg_for sdl)
    if [[ -z "$pkgs" ]]; then
        echo "  WARN: no SDL package mapping for $PKG_MANAGER. Skipping."
        return
    fi
    # shellcheck disable=SC2086
    if ! pkg_install $pkgs 2>/dev/null; then
        # SDL3 is new — many distros only have SDL2. Try SDL2 alone, then
        # fall back to building SDL3 from source.
        echo "  WARN: full SDL install failed; trying SDL2 only..."
        case "$PKG_MANAGER" in
            apt)    pkg_install libsdl2-dev || true ;;
            dnf)    pkg_install SDL2-devel || true ;;
            pacman) pkg_install sdl2 || true ;;
            zypper) pkg_install libSDL2-devel || true ;;
        esac
        echo
        echo "  NOTE: SDL3 was not installed via the system package manager."
        echo "        If your distro ships only SDL2, build SDL3 from source:"
        echo "          git clone https://github.com/libsdl-org/SDL.git -b SDL3"
        echo "          cd SDL && cmake -B build -DCMAKE_INSTALL_PREFIX=/usr/local && cmake --build build && cmake --install build"
        echo "        Then export SDL3_DIR=/usr/local before running ./setup-pianoid.sh"
        return
    fi
    echo "  OK SDL packages installed"
}

install_cuda() {
    echo
    echo "[CUDA] Target toolkit version: $CUDA_VERSION"

    # Prefer the NVIDIA APT repository on Debian/Ubuntu so the requested
    # version (12.6) is available. The distro package (nvidia-cuda-toolkit)
    # is usually older.
    if [[ "$PKG_MANAGER" == "apt" ]]; then
        if command -v nvcc >/dev/null 2>&1; then
            echo "  nvcc already on PATH at $(command -v nvcc):"
            nvcc --version | head -n 4 | sed 's/^/    /'
        fi
        echo "  NOTE: distro-provided nvidia-cuda-toolkit may be older than $CUDA_VERSION."
        echo "        For an exact version match, install from NVIDIA's apt repo:"
        echo "          https://developer.nvidia.com/cuda-${CUDA_VERSION}-download-archive"
        echo "        Falling back to nvidia-cuda-toolkit from main archive..."
        # shellcheck disable=SC2086
        if ! pkg_install $(pkg_for cuda); then
            echo "  ERROR: nvidia-cuda-toolkit install failed. Use NVIDIA's runfile:"
            echo "    https://developer.nvidia.com/cuda-${CUDA_VERSION}-download-archive"
            return 1
        fi
    elif [[ "$PKG_MANAGER" == "pacman" ]]; then
        # shellcheck disable=SC2086
        pkg_install $(pkg_for cuda)
    elif [[ "$PKG_MANAGER" == "dnf" ]]; then
        echo "  NOTE: install CUDA $CUDA_VERSION from NVIDIA's RPM repo:"
        echo "    https://developer.download.nvidia.com/compute/cuda/repos/"
        echo "  Attempting distro-provided package as fallback..."
        # shellcheck disable=SC2086
        pkg_install $(pkg_for cuda) || {
            echo "  WARN: CUDA install via dnf failed. Use NVIDIA's RPM repo or runfile."
            return 1
        }
    else
        echo "  WARN: automated CUDA install not implemented for $PKG_MANAGER."
        echo "        Install manually from https://developer.nvidia.com/cuda-${CUDA_VERSION}-download-archive"
        return 1
    fi

    if command -v nvcc >/dev/null 2>&1; then
        echo "  OK nvcc available: $(nvcc --version | head -n 4 | tail -n 1)"
    else
        echo "  WARN: nvcc not on PATH after install. You may need to add /usr/local/cuda/bin to PATH"
        echo "        and /usr/local/cuda/lib64 to LD_LIBRARY_PATH (or /etc/ld.so.conf.d/)."
    fi
}

install_node() {
    echo
    echo "[Node.js] Target major version: $NODE_VERSION"
    local pkgs; pkgs=$(pkg_for node)
    if [[ -z "$pkgs" ]]; then
        echo "  WARN: no Node.js package mapping for $PKG_MANAGER. Skipping."
        return
    fi

    # On apt-based distros, the system nodejs may be far behind. Use NodeSource
    # if the major version differs.
    if [[ "$PKG_MANAGER" == "apt" ]]; then
        local CURRENT_MAJOR=""
        if command -v node >/dev/null 2>&1; then
            CURRENT_MAJOR=$(node --version | sed -E 's/^v([0-9]+).*/\1/')
        fi
        if [[ "$CURRENT_MAJOR" != "$NODE_VERSION" ]]; then
            echo "  Adding NodeSource repo for Node.js $NODE_VERSION ..."
            curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -
        fi
    fi

    # shellcheck disable=SC2086
    pkg_install $pkgs
    if command -v node >/dev/null 2>&1; then
        echo "  OK node installed: $(node --version)"
    fi
    if command -v npm >/dev/null 2>&1; then
        echo "  OK npm installed:  $(npm --version)"
    fi
}

install_all() {
    pkg_update
    install_build
    install_python
    install_sdl
    install_cuda
    install_node
    echo
    echo "========================================================================="
    echo "  Done. Installed components: build toolchain, Python, SDL, CUDA, Node.js"
    echo "========================================================================="
    echo
    echo "Next step (run as your normal user, NOT root):"
    echo "  ./setup-pianoid.sh"
    echo
}

# -- arg / menu dispatch -----------------------------------------------------
if [[ $# -gt 0 ]]; then
    case "$1" in
        --all)    install_all ;;
        --build)  install_build ;;
        --python) pkg_update && install_python ;;
        --sdl)    pkg_update && install_sdl ;;
        --cuda)   pkg_update && install_cuda ;;
        --node)   pkg_update && install_node ;;
        --help|-h)
            sed -n '1,30p' "$0" | grep -E '^# ' | sed 's/^# \{0,1\}//'
            ;;
        *) echo "Unknown option: $1"; echo "Run: $0 --help"; exit 1 ;;
    esac
    exit 0
fi

# Interactive menu (matches setup-packages.bat options)
echo
echo "========================================================================="
echo "Pianoid System Dependency Installation (Linux)"
echo "========================================================================="
echo
echo "This script will install/update:"
echo "  - Build toolchain (gcc, make, pkg-config, curl, lsof, git)"
echo "  - Python $PY_VERSION (interpreter + venv + dev headers)"
echo "  - NVIDIA CUDA toolkit ($CUDA_VERSION target)"
echo "  - SDL2 $SDL2_VERSION + SDL3 $SDL3_VERSION (audio libraries)"
echo "  - Node.js $NODE_VERSION LTS"
echo
echo "Available options:"
echo "  1. Normal install (everything)"
echo "  2. Install/update Python only"
echo "  3. Install/update CUDA only"
echo "  4. Install/update Node.js only"
echo "  5. Install/update SDL only"
echo "  6. Install/update build toolchain only"
echo
read -rp "Choose option (1-6, default 1): " choice
choice="${choice:-1}"

case "$choice" in
    1) install_all ;;
    2) pkg_update && install_python ;;
    3) pkg_update && install_cuda ;;
    4) pkg_update && install_node ;;
    5) pkg_update && install_sdl ;;
    6) pkg_update && install_build ;;
    *) echo "Invalid choice. Running normal install..."; install_all ;;
esac
