#!/usr/bin/env bash
# ============================================================================
# update-repos.sh — Linux equivalent of update-repos.bat
#
# Pulls each Pianoid repo on its INTEGRATION branch (the same branch
# check-updates.ps1 compares against), --ff-only:
#   PianoidInstall -> master   (FIRST: it may update this script itself)
#   PianoidCore / PianoidBasic / PianoidTunner -> dev
# A repo checked out on another branch is SKIPPED with a warning (never
# switched, never pulled). PianoidInstall is also skipped while it has
# uncommitted changes to tracked files.
#
# Then rebuilds ONLY what the pulls changed (PROJECT_CONFIG.md rebuild matrix /
# BUILD_SYSTEM.md "Post-Merge / Post-Pull Rebuild Gate"):
#   - PianoidCore .cu/.cpp/.cuh/.h/setup.py/detect_paths.py/build_config.json
#       ......................................... CUDA heavy build (build_pianoid_cuda.sh)
#   - PianoidBasic changed any file ............ PianoidBasic build (build_pianoid_basic.sh)
#   - PianoidTunner package.json / package-lock (or no node_modules) ... npm install
#   - tools/pianoid-assistant package.json / package-lock (or no node_modules)
#       ......................................... npm install there
#   - pianoid_middleware/*.py only, docs, tests  no build (the middleware runs
#     from the source tree; the CUDA build does not touch it)
#
# Build variant (CUDA):
#   default     ->  build_pianoid_cuda.sh --heavy --both   (release + debug)
#   --release   ->  build_pianoid_cuda.sh --heavy --release
#   --debug     ->  build_pianoid_cuda.sh --heavy --debug
#   --dry-run   ->  fetch only; print what would be pulled and rebuilt
#   --help      ->  print usage and exit
#
# Run by a human in a foreground terminal. Before any CUDA rebuild it STOPS the
# process holding the .so (a running backend), otherwise the --heavy uninstall
# fails and leaves the package uninstalled.
#
# Self-update: bash reads a script while running it, so the whole body is the
# function main(), called on the last line together with `exit` (parsed before
# main runs). When the PianoidInstall pull changed update-repos.sh, main execs
# the NEW version with PIANOID_UPDATE_REEXEC=1 and
# PIANOID_UPDATE_INSTALL_PRE=<pre-pull SHA>; the new version skips the
# PianoidInstall pull and classifies <pre-pull SHA>..HEAD instead. Keep this
# handover contract stable (update-repos.bat uses the same one).
#
# See:
#   docs/architecture/BUILD_SYSTEM.md  (Post-Merge / Post-Pull Rebuild Gate)
#   docs/guides/OPERATIONS_FOR_ASSISTANT.md (Update from git)
# ============================================================================
set -u
set -o pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_DIR="$ROOT_DIR/PianoidCore"
BASIC_DIR="$ROOT_DIR/PianoidBasic"
TUNNER_DIR="$ROOT_DIR/PianoidTunner"
ASSISTANT_DIR="$ROOT_DIR/tools/pianoid-assistant"
LAUNCHER_URL="http://127.0.0.1:3001/api/stop-backend"

usage() {
    cat <<EOF
Usage: ./update-repos.sh [--release | --debug | --both] [--dry-run] [--help]

  Pulls PianoidInstall (master) first, then PianoidCore, PianoidBasic,
  PianoidTunner (dev), --ff-only, and rebuilds only what the pulls changed.
  A repo on another branch is skipped with a warning (never switched);
  PianoidInstall is also skipped while tracked files are modified.

  --both      Build BOTH release and debug CUDA variants (DEFAULT).
  --release   Build only the release CUDA variant (--heavy --release).
  --debug     Build only the debug CUDA variant (--heavy --debug).
  --dry-run   Fetch only: print what would be pulled and rebuilt.
  --help, -h  Show this help and exit.

  Rebuild rules (BUILD_SYSTEM.md Post-Merge / Post-Pull Rebuild Gate):
    PianoidCore .cu/.cpp/.cuh/.h/setup.py/detect_paths.py/build_config.json -> CUDA heavy build
    PianoidBasic changed -> PianoidBasic build
    PianoidTunner package.json / package-lock.json -> npm install
    tools/pianoid-assistant package.json / package-lock.json -> npm install there
    nothing relevant -> skip (no-op)

  Before any CUDA rebuild the running backend (holding the .so) is stopped via
  the launcher REST, else a port-targeted kill of the listener on 5000.
EOF
}

set_summary() {
    case "$1" in
        PianoidInstall) INSTALL_SUMMARY="$2" ;;
        PianoidCore)    CORE_SUMMARY="$2" ;;
        PianoidBasic)   BASIC_SUMMARY="$2" ;;
        PianoidTunner)  TUNNER_SUMMARY="$2" ;;
    esac
}

# --------------------------------------------------------------------------
# classify_repo <display-name> <repo-dir> <pre-sha> <post-sha>
#   Sets the per-repo "what changed" flags from the diff pre..post.
# --------------------------------------------------------------------------
classify_repo() {
    local name="$1" dir="$2" changed
    changed="$(git -C "$dir" diff --name-only "$3" "$4")"
    case "$name" in
        PianoidInstall)
            if echo "$changed" | grep -Eq '^tools/pianoid-assistant/package(-lock)?\.json$'; then
                ASSISTANT_DEPS_CHANGED=1
                echo "  PianoidInstall: assistant deps changed -> npm install"
            else
                echo "  PianoidInstall: no assistant dependency change"
            fi
            if echo "$changed" | grep -Eq '^update-repos\.sh$'; then SELF_CHANGED=1; fi
            ;;
        PianoidCore)
            if echo "$changed" | grep -Eiq '\.(cu|cpp|cuh|h)$|(^|/)setup\.py$|(^|/)detect_paths\.py$|(^|/)build_config\.json$'; then
                CORE_CUDA_CHANGED=1
                echo "  PianoidCore: compiled sources changed -> CUDA rebuild"
            else
                echo "  PianoidCore: no compiled-source change"
            fi
            ;;
        PianoidBasic)
            # ANY change in PianoidBasic triggers a PianoidBasic rebuild.
            BASIC_CHANGED=1
            echo "  PianoidBasic: changed -> PianoidBasic rebuild"
            ;;
        PianoidTunner)
            if echo "$changed" | grep -Eiq '(^|/)package\.json$|(^|/)package-lock\.json$'; then
                TUNNER_DEPS_CHANGED=1
                echo "  PianoidTunner: deps changed -> npm install"
            else
                echo "  PianoidTunner: no dependency change"
            fi
            ;;
    esac
}

# --------------------------------------------------------------------------
# pull_repo <display-name> <repo-dir> <integration-branch>
#   Skips (return 0, summary SKIPPED) a repo that is not on its integration
#   branch, and PianoidInstall while tracked files are modified. Otherwise
#   pulls origin/<integration> --ff-only (dry run: fetches and compares), sets
#   PRE_SHA / POST_SHA, fills the summary and classifies the diff.
#   Return 1 only on a failed pull (diverged / conflict / no remote).
# --------------------------------------------------------------------------
pull_repo() {
    local name="$1" dir="$2" integ="$3" branch
    PRE_SHA=""; POST_SHA=""
    echo
    echo "--- $name ---"

    branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    if [[ -z "$branch" ]]; then
        echo "ERROR: could not determine current branch in $dir"
        return 1
    fi
    echo "  Branch: $branch"
    if [[ "$branch" != "$integ" ]]; then
        echo "  WARNING: $name is on '$branch', not '$integ' — NOT updated."
        echo "           To update it: git -C \"$dir\" checkout $integ   then re-run."
        set_summary "$name" "SKIPPED (on '$branch', not '$integ')"
        return 0
    fi

    if [[ -n "$(git -C "$dir" status --porcelain -uno 2>/dev/null)" ]]; then
        if [[ "$name" == "PianoidInstall" ]]; then
            echo "  WARNING: PianoidInstall has local changes — NOT updated."
            echo "           See them: git -C \"$dir\" status"
            set_summary "$name" "SKIPPED (local changes)"
            return 0
        fi
        echo "  NOTE: local changes present — git refuses the pull if they overlap the update."
    fi

    PRE_SHA="$(git -C "$dir" rev-parse HEAD 2>/dev/null)"

    if [[ "$DRY_RUN" == "1" ]]; then
        echo "  Fetching origin/$integ (dry run)..."
        git -C "$dir" fetch --quiet origin "$integ" || true
        POST_SHA="$(git -C "$dir" rev-parse "origin/$integ" 2>/dev/null || true)"
        if [[ -z "$POST_SHA" ]]; then
            echo "  ERROR: origin/$integ not found for $name."
            return 1
        fi
        if git -C "$dir" merge-base --is-ancestor "$POST_SHA" "$PRE_SHA" 2>/dev/null; then
            POST_SHA="$PRE_SHA"
        elif ! git -C "$dir" merge-base --is-ancestor "$PRE_SHA" "$POST_SHA" 2>/dev/null; then
            echo "  DRY RUN: WOULD FAIL — $integ has diverged from origin/$integ."
            set_summary "$name" "WOULD FAIL (diverged from origin/$integ)"
            return 0
        fi
    else
        echo "  Pulling origin/$integ..."
        if ! git -C "$dir" pull --ff-only origin "$integ"; then
            echo "  ERROR: git pull failed for $name."
            echo "  Resolve manually (diverged branch / conflicts / no network) and re-run."
            return 1
        fi
        POST_SHA="$(git -C "$dir" rev-parse HEAD 2>/dev/null)"
    fi

    if [[ "$PRE_SHA" == "$POST_SHA" ]]; then
        echo "  Already up to date (no new commits)."
        set_summary "$name" "$branch (up to date)"
        return 0
    fi

    if [[ "$DRY_RUN" == "1" ]]; then
        echo "  DRY RUN: would update: ${PRE_SHA:0:9} -> ${POST_SHA:0:9}"
    else
        echo "  Updated: ${PRE_SHA:0:9} -> ${POST_SHA:0:9}"
    fi
    set_summary "$name" "$branch (${PRE_SHA:0:9}..${POST_SHA:0:9})"
    classify_repo "$name" "$dir" "$PRE_SHA" "$POST_SHA"
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

# npm_install <label> <dir>
npm_install() {
    echo "--- Installing $1 dependencies [npm install] ---"
    if ! ( cd "$2" && npm install ); then
        echo "ERROR: npm install failed for $1."
        return 1
    fi
    echo "  OK  $1 dependencies installed"
    BUILD_SUMMARY="$BUILD_SUMMARY npm install($1);"
    echo
}

main() {
    CUDA_VARIANT="both"
    DRY_RUN=0
    local arg
    for arg in "$@"; do
        case "$arg" in
            --release) CUDA_VARIANT="release" ;;
            --debug)   CUDA_VARIANT="debug" ;;
            --both)    CUDA_VARIANT="both" ;;
            --dry-run) DRY_RUN=1 ;;
            --help|-h) usage; return 0 ;;
            *)
                echo "ERROR: unknown argument: $arg"
                usage
                return 1
                ;;
        esac
    done

    echo "========================================================================="
    echo "Pianoid Repo Update  (pull + rebuild what changed)"
    echo "========================================================================="
    echo "Root directory:  $ROOT_DIR"
    echo "CUDA variant:    --heavy --$CUDA_VARIANT"
    [[ "$DRY_RUN" == "1" ]] && echo "DRY RUN:         fetch only — nothing is pulled, built or installed"
    echo

    # -- verify prerequisites: git + the three sub-repos exist ---------------
    if ! command -v git >/dev/null 2>&1; then
        echo "ERROR: git not found on PATH."
        return 1
    fi
    local D
    for D in "$CORE_DIR" "$BASIC_DIR" "$TUNNER_DIR"; do
        if [[ ! -d "$D" ]]; then
            echo "ERROR: required directory missing: $D"
            echo "Run clone-packages.sh first."
            return 1
        fi
        if [[ ! -d "$D/.git" ]]; then
            echo "ERROR: not a git repository: $D"
            return 1
        fi
    done

    # Result accumulators (filled per repo, printed in the final summary)
    INSTALL_SUMMARY="skipped"
    CORE_SUMMARY="skipped"
    BASIC_SUMMARY="skipped"
    TUNNER_SUMMARY="skipped"

    # Per-repo "what changed" flags (computed by classify_repo via diff)
    CORE_CUDA_CHANGED=0
    BASIC_CHANGED=0
    TUNNER_DEPS_CHANGED=0
    ASSISTANT_DEPS_CHANGED=0
    SELF_CHANGED=0

    # ------------------------------------------------------------------------
    # STEP 1: Pull PianoidInstall first, then the three sub-repos
    # ------------------------------------------------------------------------
    echo "[STEP 1/3] Pulling repositories (integration branch each)..."
    echo "========================================================================="
    if [[ -n "${PIANOID_UPDATE_REEXEC:-}" ]]; then
        echo
        echo "--- PianoidInstall ---"
        echo "  Already pulled by the previous version of update-repos.sh."
        local install_post
        install_post="$(git -C "$ROOT_DIR" rev-parse HEAD)"
        INSTALL_SUMMARY="master (${PIANOID_UPDATE_INSTALL_PRE:0:9}..${install_post:0:9})"
        classify_repo "PianoidInstall" "$ROOT_DIR" "$PIANOID_UPDATE_INSTALL_PRE" "$install_post"
    else
        pull_repo "PianoidInstall" "$ROOT_DIR" "master" || return 1
        if [[ "$SELF_CHANGED" == "1" && "$DRY_RUN" == "0" ]]; then
            echo
            echo "  update-repos.sh was updated by this pull — continuing with the new version..."
            echo
            PIANOID_UPDATE_REEXEC=1 PIANOID_UPDATE_INSTALL_PRE="$PRE_SHA" exec bash "$ROOT_DIR/update-repos.sh" "$@"
        fi
        if [[ "$SELF_CHANGED" == "1" ]]; then
            echo "  DRY RUN: the pull would update update-repos.sh; a real run continues with the new version."
        fi
    fi
    pull_repo "PianoidCore"   "$CORE_DIR"   "dev" || return 1
    pull_repo "PianoidBasic"  "$BASIC_DIR"  "dev" || return 1
    pull_repo "PianoidTunner" "$TUNNER_DIR" "dev" || return 1
    echo
    echo "  OK  STEP 1 COMPLETED"
    echo

    # ------------------------------------------------------------------------
    # STEP 2: Decide what to rebuild (Post-Merge / Post-Pull Rebuild Gate)
    # ------------------------------------------------------------------------
    echo "[STEP 2/3] Deciding what to rebuild..."
    echo "========================================================================="
    NEED_CUDA=0
    NEED_BASIC=0
    NEED_NPM=0
    NEED_NPM_ASSISTANT=0

    # PianoidBasic changed -> PianoidBasic build only (the CUDA build does not
    # consume PianoidBasic).
    [[ "$BASIC_CHANGED" == "1" ]] && NEED_BASIC=1
    # PianoidCore compiled sources changed -> CUDA rebuild.
    [[ "$CORE_CUDA_CHANGED" == "1" ]] && NEED_CUDA=1
    # npm deps changed, or never installed -> npm install.
    [[ "$TUNNER_DEPS_CHANGED" == "1" || ! -d "$TUNNER_DIR/node_modules" ]] && NEED_NPM=1
    [[ "$ASSISTANT_DEPS_CHANGED" == "1" ]] && NEED_NPM_ASSISTANT=1
    [[ -f "$ASSISTANT_DIR/package.json" && ! -d "$ASSISTANT_DIR/node_modules" ]] && NEED_NPM_ASSISTANT=1

    echo "  PianoidCore CUDA sources changed : $CORE_CUDA_CHANGED"
    echo "  PianoidBasic changed             : $BASIC_CHANGED"
    echo "  PianoidTunner deps changed       : $TUNNER_DEPS_CHANGED"
    echo "  Assistant deps changed           : $ASSISTANT_DEPS_CHANGED"
    echo
    echo "  -> Rebuild PianoidBasic        : $NEED_BASIC"
    echo "  -> Rebuild CUDA                : $NEED_CUDA"
    echo "  -> npm install (PianoidTunner) : $NEED_NPM"
    echo "  -> npm install (assistant)     : $NEED_NPM_ASSISTANT"
    echo

    BUILD_SUMMARY=""
    if [[ "$NEED_CUDA$NEED_BASIC$NEED_NPM$NEED_NPM_ASSISTANT" == "0000" ]]; then
        echo "  Nothing relevant changed — no rebuild needed."
        BUILD_SUMMARY="nothing to rebuild (idempotent no-op)"
        echo
        echo "  OK  STEP 2 COMPLETED"
    elif [[ "$DRY_RUN" == "1" ]]; then
        echo "  OK  STEP 2 COMPLETED"
        echo
        echo "  DRY RUN: skipping STEP 3 (no backend stop, no build, no npm install)."
        BUILD_SUMMARY="DRY RUN - would run: Basic=$NEED_BASIC CUDA=$NEED_CUDA npm-Tunner=$NEED_NPM npm-assistant=$NEED_NPM_ASSISTANT"
        echo
    else
        echo "  OK  STEP 2 COMPLETED"
        echo

        # --------------------------------------------------------------------
        # STEP 3: Rebuild
        # --------------------------------------------------------------------
        echo "[STEP 3/3] Rebuilding..."
        echo "========================================================================="

        # Stop the .so holder BEFORE any CUDA rebuild.
        if [[ "$NEED_CUDA" == "1" ]]; then
            echo "Stopping any running backend that may hold the .so ..."
            stop_backend
            echo
        fi

        # PianoidBasic (before the CUDA build, as in the canonical order).
        if [[ "$NEED_BASIC" == "1" ]]; then
            echo "--- Building PianoidBasic ---"
            if [[ ! -f "$CORE_DIR/build_pianoid_basic.sh" ]]; then
                echo "ERROR: build_pianoid_basic.sh not found in $CORE_DIR"
                return 1
            fi
            chmod +x "$CORE_DIR/build_pianoid_basic.sh" 2>/dev/null || true
            if ! ( cd "$CORE_DIR" && bash build_pianoid_basic.sh ); then
                echo "ERROR: PianoidBasic build failed."
                return 1
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
                return 1
            fi
            chmod +x "$CORE_DIR/build_pianoid_cuda.sh" 2>/dev/null || true
            if ! ( cd "$CORE_DIR" && bash build_pianoid_cuda.sh --heavy --"$CUDA_VARIANT" ); then
                echo "ERROR: PianoidCuda build failed. Check $CORE_DIR/build.log for details."
                return 1
            fi
            echo "  OK  PianoidCuda rebuilt [--heavy --$CUDA_VARIANT]"
            BUILD_SUMMARY="$BUILD_SUMMARY PianoidCuda(--heavy --$CUDA_VARIANT);"
            echo
        fi

        # npm install (PianoidTunner, assistant).
        if [[ "$NEED_NPM$NEED_NPM_ASSISTANT" != "00" ]] && ! command -v node >/dev/null 2>&1; then
            echo "ERROR: Node.js not found on PATH."
            return 1
        fi
        if [[ "$NEED_NPM" == "1" ]]; then npm_install "PianoidTunner" "$TUNNER_DIR" || return 1; fi
        if [[ "$NEED_NPM_ASSISTANT" == "1" ]]; then npm_install "assistant" "$ASSISTANT_DIR" || return 1; fi

        echo "  OK  STEP 3 COMPLETED"
        echo
    fi

    # ------------------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------------------
    echo "========================================================================="
    echo "  UPDATE SUMMARY"
    echo "========================================================================="
    echo "  PianoidInstall : $INSTALL_SUMMARY"
    echo "  PianoidCore    : $CORE_SUMMARY"
    echo "  PianoidBasic   : $BASIC_SUMMARY"
    echo "  PianoidTunner  : $TUNNER_SUMMARY"
    echo "  Rebuilt        : ${BUILD_SUMMARY:-nothing}"
    echo
    if [[ "$NEED_CUDA" == "1" && "$DRY_RUN" == "0" ]]; then
        echo "  Verify the CUDA build landed in the correct venv:"
        echo "    PianoidCore/.venv/bin/python -c \"import pianoidCuda; print(pianoidCuda.__file__)\""
        echo "  Then smoke-test: start the backend and POST /load_preset (expect 200)."
        echo
    fi
    echo "To start the application:  ./start-pianoid.sh"
    echo "========================================================================="
}

# Keep main + exit on ONE line: bash has parsed it before main runs, so a pull
# that rewrites this file cannot change what runs after main returns.
main "$@"; exit $?
