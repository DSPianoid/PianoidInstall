#!/usr/bin/env bash
# ============================================================================
# start-pianoid.sh — Linux equivalent of start-pianoid.bat
# Launches the Tunner dev stack (`npm run dev`), which starts the launcher
# (port 3001) and React dev server (port 3000). The launcher manages the
# Flask backend on demand from the UI (port 5000 after APPLY).
# ============================================================================
set -u
set -o pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_DIR="$ROOT_DIR/PianoidCore"
MIDDLEWARE_DIR="$CORE_DIR/pianoid_middleware"
TUNNER_DIR="$ROOT_DIR/PianoidTunner"
BACKEND_SCRIPT="$MIDDLEWARE_DIR/backendserver.py"

echo "========================================================================="
echo "Starting Pianoid Application (Linux)"
echo "========================================================================="
echo "Root directory: $ROOT_DIR"
echo "PianoidCore:    $CORE_DIR"
echo "PianoidTunner:  $TUNNER_DIR"
echo

# -- verify prerequisites ----------------------------------------------------
echo "Checking prerequisites..."
for D in "$CORE_DIR" "$MIDDLEWARE_DIR" "$TUNNER_DIR"; do
    if [[ ! -d "$D" ]]; then
        echo "ERROR: directory not found: $D"
        exit 1
    fi
done
if [[ ! -f "$BACKEND_SCRIPT" ]]; then
    echo "ERROR: backendserver.py not found: $BACKEND_SCRIPT"
    exit 1
fi
if [[ ! -f "$TUNNER_DIR/package.json" ]]; then
    echo "ERROR: package.json not found in PianoidTunner"
    exit 1
fi
echo "  OK  All directories and files found"

if [[ ! -d "$CORE_DIR/.venv" ]]; then
    echo "ERROR: Python virtual environment not found at $CORE_DIR/.venv"
    echo "Run setup-pianoid.sh first."
    exit 1
fi
echo "  OK  Python virtual environment found"

if [[ ! -d "$TUNNER_DIR/node_modules" ]]; then
    echo "ERROR: node_modules not found in PianoidTunner"
    echo "Run setup-pianoid.sh first."
    exit 1
fi
echo "  OK  Frontend dependencies found"
echo

# -- launch ------------------------------------------------------------------
echo "Starting Pianoid..."
echo "  npm run dev runs the launcher (port 3001) + React dev server (port 3000)"
echo "  Browser opens automatically at http://localhost:3000"
echo "  Click APPLY in the UI to start the backend on port 5000."
echo
echo "  Services:"
echo "    Frontend UI:  http://localhost:3000"
echo "    Launcher WS:  http://localhost:3001"
echo "    Backend API:  http://localhost:5000  (after APPLY)"
echo
echo "Press Ctrl+C to stop."
echo

cd "$TUNNER_DIR"
exec npm run dev
