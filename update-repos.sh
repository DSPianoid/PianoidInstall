#!/usr/bin/env bash
# ============================================================================
# update-repos.sh — Linux equivalent of update-repos.bat
#
# Pulls each sub-repo (PianoidCore, PianoidTunner, PianoidBasic) on its CURRENT
# branch (does NOT force-switch branches), then rebuilds ONLY what the pulls
# changed, following the BUILD_SYSTEM.md "Post-Merge / Post-Pull Rebuild Gate":
#   - PianoidCore pull touched .cu/.cpp/.cuh/.h/setup.py/detect_paths.py,
#     OR PianoidBasic changed .................. CUDA rebuild (build_pianoid_cuda.sh)
#   - PianoidBasic pull changed any file ....... PianoidBasic rebuild (build_pianoid_basic.sh)
#   - PianoidTunner package.json / package-lock changed ... npm ci
#   - nothing relevant ......................... skip (idempotent no-op)
#
# Build variant (CUDA):
#   default     ->  build_pianoid_cuda.sh --heavy --both   (release + debug)
#   --release   ->  build_pianoid_cuda.sh --heavy --release
#   --debug     ->  build_pianoid_cuda.sh --heavy --debug
#   --help      ->  print usage and exit
#
# Run by a human in a foreground terminal. Before any CUDA rebuild it STOPS the
# process holding the .so (a running backend), otherwise the --heavy uninstall
# fails and leaves the package uninstalled.
#
# Mirrors setup-pianoid.sh's structure/idioms. See:
#   docs/architecture/BUILD_SYSTEM.md  (Post-Merge / Post-Pull Rebuild Gate)
#   docs/guides/QUICK_START.md         (Launcher API: stop-backend)
# ============================================================================
set -u
set -o pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_DIR="$ROOT_DIR/PianoidCore"
BASIC_DIR="$ROOT_DIR/PianoidBasic"
TUNNER_DIR="$ROOT_DIR/PianoidTunner"
LAUNCHER_URL="http://127.0.0.1:3001/api/stop-backend"

# -- parse arguments — default CUDA variant is --both (release + debug) ------
CUDA_VARIANT="both"
usage() {
    cat <<EOF
Usage: ./update-repos.sh [--release | --debug | --both] [--help]

  Pulls PianoidCore, PianoidTunner, PianoidBasic on their CURRENT branch
  (does not switch branches), then rebuilds only what the pulls changed.

  --both      Build BOTH release and debug CUDA variants (DEFAULT).
  --release   Build only the release CUDA variant (--heavy --release).
  --debug     Build only the debug CUDA variant (--heavy --debug).
  --help, -h  Show this help and exit.

  Rebuild rules (BUILD_SYSTEM.md Post-Merge / Post-Pull Rebuild Gate):
    PianoidCore .cu/.cpp/.cuh/.h/setup.py/detect_paths.py changed -> CUDA rebuild
    PianoidBasic changed -> PianoidBasic rebuild (+ CUDA, consumed by engine)
    PianoidTunner package.json / package-lock.json changed -> npm ci
    nothing relevant -> skip (no-op)

  Before any CUDA rebuild the running backend (holding the .so) is stopped via
  the launcher REST, else a port-targeted kill of the listener on 5000.
EOF
}
for arg in "$@"; do
    case "$arg" in
        --release) CUDA_VARIANT="release" ;;
        --debug)   CUDA_VARIANT="debug" ;;
        --both)    CUDA_VARIANT="both" ;;
        --help|-h) usage; exit 0 ;;
        *)
            echo "ERROR: unknown argument: $arg"
            usage
            exit 1
            ;;
    esac
done

echo "========================================================================="
echo "Pianoid Repo Update  (pull + rebuild what changed)"
echo "========================================================================="
echo "Root directory:  $ROOT_DIR"
echo "CUDA variant:    --heavy --$CUDA_VARIANT"
echo

# -- verify prerequisites: git + the three sub-repos exist -------------------
if ! command -v git >/dev/null 2>&1; then
    echo "ERROR: git not found on PATH."
    exit 1
fi
for D in "$CORE_DIR" "$BASIC_DIR" "$TUNNER_DIR"; do
    if [[ ! -d "$D" ]]; then
        echo "ERROR: required directory missing: $D"
        echo "Run clone-packages.sh first."
        exit 1
    fi
    if [[ ! -d "$D/.git" ]]; then
        echo "ERROR: not a git repository: $D"
        exit 1
    fi
done

# Result accumulators (filled per repo, printed in the final summary)
CORE_SUMMARY="skipped"
BASIC_SUMMARY="skipped"
TUNNER_SUMMARY="skipped"

# Per-repo "what changed" flags (computed by pull_repo via diff)
CORE_CUDA_CHANGED=0
BASIC_CHANGED=0
TUNNER_DEPS_CHANGED=0

# --------------------------------------------------------------------------
# pull_repo <display-name> <repo-dir>
#   Records current branch + pre-pull SHA, pulls the current branch's upstream,
#   records post-pull SHA, WARNs if not on dev, and computes the changed-file
#   flags via diff.
# --------------------------------------------------------------------------
pull_repo() {
    local name="$1" dir="$2"
    echo
    echo "--- $name ---"

    local branch pre_sha post_sha
    branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    if [[ -z "$branch" ]]; then
        echo "ERROR: could not determine current branch in $dir"
        return 1
    fi
    echo "  Branch: $branch"
    if [[ "$branch" != "dev" ]]; then
        echo "  WARNING: $name is NOT on 'dev' (on '$branch') — pulling its current branch anyway."
    fi

    pre_sha="$(git -C "$dir" rev-parse HEAD 2>/dev/null)"

    echo "  Pulling..."
    if ! git -C "$dir" pull --ff-only; then
        echo "  ERROR: git pull failed for $name."
        echo "  Resolve manually (diverged branch / no upstream / conflicts) and re-run."
        return 1
    fi

    post_sha="$(git -C "$dir" rev-parse HEAD 2>/dev/null)"

    if [[ "$pre_sha" == "$post_sha" ]]; then
        echo "  Already up to date (no new commits)."
        case "$name" in
            PianoidCore)   CORE_SUMMARY="$branch (up to date)" ;;
            PianoidBasic)  BASIC_SUMMARY="$branch (up to date)" ;;
            PianoidTunner) TUNNER_SUMMARY="$branch (up to date)" ;;
        esac
        return 0
    fi

    echo "  Updated: ${pre_sha:0:9} -> ${post_sha:0:9}"
    case "$name" in
        PianoidCore)   CORE_SUMMARY="$branch (${pre_sha:0:9}..${post_sha:0:9})" ;;
        PianoidBasic)  BASIC_SUMMARY="$branch (${pre_sha:0:9}..${post_sha:0:9})" ;;
        PianoidTunner) TUNNER_SUMMARY="$branch (${pre_sha:0:9}..${post_sha:0:9})" ;;
    esac

    # -- classify the incoming diff per repo --------------------------------
    local changed
    changed="$(git -C "$dir" diff --name-only "$pre_sha" "$post_sha")"
    case "$name" in
        PianoidCore)
            if echo "$changed" | grep -Eiq '\.(cu|cpp|cuh|h)$|(^|/)setup\.py$|(^|/)detect_paths\.py$'; then
                CORE_CUDA_CHANGED=1
                echo "  PianoidCore: compiled sources changed -> CUDA rebuild"
            else
                echo "  PianoidCore: no compiled-source change"
            fi
            ;;
        PianoidBasic)
            # ANY change in PianoidBasic triggers a PianoidBasic rebuild.
            BASIC_CHANGED=1
            echo "  PianoidBasic: changed -> PianoidBasic rebuild (+ CUDA, it is consumed by the engine)"
            ;;
        PianoidTunner)
            if echo "$changed" | grep -Eiq '(^|/)package\.json$|(^|/)package-lock\.json$'; then
                TUNNER_DEPS_CHANGED=1
                echo "  PianoidTunner: deps changed -> npm ci"
            else
                echo "  PianoidTunner: no dependency change (no npm ci)"
            fi
            ;;
    esac
    return 0
}

# --------------------------------------------------------------------------
# stop_backend
#   Stop the process holding the .so before a CUDA rebuild. Prefer the launcher
#   REST (no PID hunt); fall back to a port-targeted kill of the listener on
#   5000. Never blanket-kill python.
# --------------------------------------------------------------------------
stop_backend() {
    if command -v curl >/dev/null 2>&1; then
        echo "  Asking the launcher to stop the backend ($LAUNCHER_URL) ..."
        curl -s -X POST "$LAUNCHER_URL" >/dev/null 2>&1 || true
        sleep 2
    fi
    if command -v lsof >/dev/null 2>&1; then
        local pids
        pids="$(lsof -ti tcp:5000 2>/dev/null || true)"
        if [[ -n "$pids" ]]; then
            echo "  Backend still listening on 5000 (PID(s): $pids) — killing those PIDs."
            # shellcheck disable=SC2086
            kill -TERM $pids 2>/dev/null || true
            sleep 1
            # shellcheck disable=SC2086
            kill -KILL $pids 2>/dev/null || true
        else
            echo "  No backend listening on 5000."
        fi
    else
        echo "  Note: lsof not available — cannot port-target a leftover backend. Install lsof if a rebuild fails on a locked .so."
    fi
}

# --------------------------------------------------------------------------
# STEP 1: Pull each sub-repo on its CURRENT branch
# --------------------------------------------------------------------------
echo "[STEP 1/3] Pulling repositories (current branch each)..."
echo "========================================================================="
pull_repo "PianoidCore"   "$CORE_DIR"   || exit 1
pull_repo "PianoidBasic"  "$BASIC_DIR"  || exit 1
pull_repo "PianoidTunner" "$TUNNER_DIR" || exit 1
echo
echo "  OK  STEP 1 COMPLETED"
echo

# --------------------------------------------------------------------------
# STEP 2: Decide what to rebuild (Post-Merge / Post-Pull Rebuild Gate)
# --------------------------------------------------------------------------
echo "[STEP 2/3] Deciding what to rebuild..."
echo "========================================================================="
NEED_CUDA=0
NEED_BASIC=0
NEED_NPM=0

# PianoidBasic changed -> rebuild PianoidBasic AND (consumed by engine) CUDA.
if [[ "$BASIC_CHANGED" == "1" ]]; then
    NEED_BASIC=1
    NEED_CUDA=1
fi
# PianoidCore compiled sources changed -> CUDA rebuild.
[[ "$CORE_CUDA_CHANGED" == "1" ]] && NEED_CUDA=1
# PianoidTunner deps changed -> npm ci.
[[ "$TUNNER_DEPS_CHANGED" == "1" ]] && NEED_NPM=1

echo "  PianoidCore CUDA sources changed : $CORE_CUDA_CHANGED"
echo "  PianoidBasic changed             : $BASIC_CHANGED"
echo "  PianoidTunner deps changed       : $TUNNER_DEPS_CHANGED"
echo
echo "  -> Rebuild PianoidBasic : $NEED_BASIC"
echo "  -> Rebuild CUDA         : $NEED_CUDA"
echo "  -> npm ci (frontend)    : $NEED_NPM"
echo

BUILD_SUMMARY=""
if [[ "$NEED_CUDA$NEED_BASIC$NEED_NPM" == "000" ]]; then
    echo "  Nothing relevant changed — no rebuild needed."
    BUILD_SUMMARY="nothing to rebuild (idempotent no-op)"
    echo
    echo "  OK  STEP 2 COMPLETED"
else
    echo "  OK  STEP 2 COMPLETED"
    echo

    # ----------------------------------------------------------------------
    # STEP 3: Rebuild
    # ----------------------------------------------------------------------
    echo "[STEP 3/3] Rebuilding..."
    echo "========================================================================="

    # Stop the .so holder BEFORE any CUDA rebuild.
    if [[ "$NEED_CUDA" == "1" ]]; then
        echo "Stopping any running backend that may hold the .so ..."
        stop_backend
        echo
    fi

    # PianoidBasic (must precede the CUDA build that consumes it).
    if [[ "$NEED_BASIC" == "1" ]]; then
        echo "--- Building PianoidBasic ---"
        if [[ ! -f "$CORE_DIR/build_pianoid_basic.sh" ]]; then
            echo "ERROR: build_pianoid_basic.sh not found in $CORE_DIR"
            exit 1
        fi
        chmod +x "$CORE_DIR/build_pianoid_basic.sh" 2>/dev/null || true
        if ! ( cd "$CORE_DIR" && bash build_pianoid_basic.sh ); then
            echo "ERROR: PianoidBasic build failed."
            exit 1
        fi
        echo "  OK  PianoidBasic rebuilt"
        BUILD_SUMMARY="$BUILD_SUMMARY PianoidBasic;"
        echo
    fi

    # PianoidCuda.
    if [[ "$NEED_CUDA" == "1" ]]; then
        echo "--- Building PianoidCuda [--heavy --$CUDA_VARIANT] ---"
        if [[ ! -f "$CORE_DIR/build_pianoid_cuda.sh" ]]; then
            echo "ERROR: build_pianoid_cuda.sh not found in $CORE_DIR"
            exit 1
        fi
        chmod +x "$CORE_DIR/build_pianoid_cuda.sh" 2>/dev/null || true
        if ! ( cd "$CORE_DIR" && bash build_pianoid_cuda.sh --heavy --"$CUDA_VARIANT" ); then
            echo "ERROR: PianoidCuda build failed. Check $CORE_DIR/build.log for details."
            exit 1
        fi
        echo "  OK  PianoidCuda rebuilt [--heavy --$CUDA_VARIANT]"
        BUILD_SUMMARY="$BUILD_SUMMARY PianoidCuda(--heavy --$CUDA_VARIANT);"
        echo
    fi

    # Frontend npm ci.
    if [[ "$NEED_NPM" == "1" ]]; then
        echo "--- Installing frontend dependencies [npm ci] ---"
        if ! command -v node >/dev/null 2>&1; then
            echo "ERROR: Node.js not found on PATH."
            exit 1
        fi
        if ! ( cd "$TUNNER_DIR" && npm ci ); then
            echo "ERROR: npm ci failed."
            exit 1
        fi
        echo "  OK  Frontend dependencies reinstalled"
        BUILD_SUMMARY="$BUILD_SUMMARY npm ci(PianoidTunner);"
        echo
    fi

    echo "  OK  STEP 3 COMPLETED"
    echo
fi

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
echo "========================================================================="
echo "  UPDATE SUMMARY"
echo "========================================================================="
echo "  PianoidCore    : $CORE_SUMMARY"
echo "  PianoidBasic   : $BASIC_SUMMARY"
echo "  PianoidTunner  : $TUNNER_SUMMARY"
echo "  Rebuilt        : ${BUILD_SUMMARY:-nothing}"
echo
if [[ "$NEED_CUDA" == "1" ]]; then
    echo "  Verify the CUDA build landed in the correct venv:"
    echo "    PianoidCore/.venv/bin/python -c \"import pianoidCuda; print(pianoidCuda.__file__)\""
    echo "  Then smoke-test: start the backend and POST /load_preset (expect 200)."
    echo
fi
echo "To start the application:  ./start-pianoid.sh"
echo "========================================================================="
