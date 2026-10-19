#!/usr/bin/env bash
# ============================================================================
# test_update_repos.sh — sandbox test for update-repos.sh (Linux / Git Bash)
#
# Same idea as test_update_repos.ps1: throw-away bare remotes + a working
# install in a temp dir, fake build scripts, curl / lsof / npm / node stubs
# first on PATH (the backend-stop step can never reach a real backend).
# Usage: bash tools/tests/update-repos/test_update_repos.sh [path/to/update-repos.sh]
# Exit 0 = all assertions passed.
# ============================================================================
set -u
SCRIPT="$(cd "$(dirname "${1:-$(dirname "$0")/../../../update-repos.sh}")" && pwd)/$(basename "${1:-update-repos.sh}")"
BASE="$(mktemp -d)"
FAILS=0
export GIT_CONFIG_COUNT=3
export GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=false
export GIT_CONFIG_KEY_1=user.name     GIT_CONFIG_VALUE_1=update-repos-test
export GIT_CONFIG_KEY_2=user.email    GIT_CONFIG_VALUE_2=test@example.invalid

STUBS="$BASE/stubs"; mkdir -p "$STUBS"
for n in curl lsof npm node; do
    printf '#!/usr/bin/env bash\necho "%s $* cwd=$PWD" >> "$STUB_LOG"\nexit 0\n' "$n" > "$STUBS/$n"
    chmod +x "$STUBS/$n"
done

check() { if eval "$2"; then echo "  PASS  $1"; else echo "  FAIL  $1"; FAILS=$((FAILS + 1)); fi; }
head_of() { git -C "$1" rev-parse HEAD; }
push_change() {  # <sb> <repo> <branch> <path> <text> [<path> <text>]...
    local up="$1/up/$2" br="$3"; shift 3
    while [[ $# -gt 0 ]]; do mkdir -p "$(dirname "$up/$1")"; printf '%s' "$2" > "$up/$1"; shift 2; done
    git -C "$up" add -A && git -C "$up" commit -qm "upstream change" && git -C "$up" push -q origin "HEAD:$br"
}
new_sandbox() {  # <name> -> echoes the sandbox root
    local sb="$BASE/$1" repo br
    for spec in install:master core:dev basic:dev tunner:dev; do
        repo="${spec%%:*}"; br="${spec##*:}"
        git init -q --bare -b "$br" "$sb/remotes/$repo.git"
        git clone -q "$sb/remotes/$repo.git" "$sb/up/$repo" 2>/dev/null
        git -C "$sb/up/$repo" checkout -q -b "$br"
        case "$repo" in
            install) cp "$SCRIPT" "$sb/up/install/update-repos.sh"
                     printf '/PianoidCore/\n/PianoidBasic/\n/PianoidTunner/\nnode_modules/\n' > "$sb/up/install/.gitignore"
                     mkdir -p "$sb/up/install/tools/pianoid-assistant"
                     echo '{"v":1}' > "$sb/up/install/tools/pianoid-assistant/package.json" ;;
            core)    printf 'echo "build_pianoid_cuda $*" >> "$STUB_LOG"\n' > "$sb/up/core/build_pianoid_cuda.sh"
                     printf 'echo "build_pianoid_basic $*" >> "$STUB_LOG"\n' > "$sb/up/core/build_pianoid_basic.sh"
                     mkdir -p "$sb/up/core/pianoid_cuda" "$sb/up/core/pianoid_middleware"
                     echo v1 > "$sb/up/core/pianoid_cuda/Pianoid.cu"; echo v1 > "$sb/up/core/pianoid_middleware/backendServer.py" ;;
            basic)   echo v1 > "$sb/up/basic/model.py" ;;
            tunner)  echo '{"v":1}' > "$sb/up/tunner/package.json" ;;
        esac
        git -C "$sb/up/$repo" add -A && git -C "$sb/up/$repo" commit -qm initial && git -C "$sb/up/$repo" push -q -u origin "$br"
    done
    git clone -q -b master "$sb/remotes/install.git" "$sb/work" 2>/dev/null
    git clone -q -b dev "$sb/remotes/core.git"   "$sb/work/PianoidCore" 2>/dev/null
    git clone -q -b dev "$sb/remotes/basic.git"  "$sb/work/PianoidBasic" 2>/dev/null
    git clone -q -b dev "$sb/remotes/tunner.git" "$sb/work/PianoidTunner" 2>/dev/null
    mkdir -p "$sb/work/PianoidTunner/node_modules" "$sb/work/tools/pianoid-assistant/node_modules"
    echo "$sb"
}
run_update() {  # <sb> [args] -> sets OUT, CODE, STUBLOG
    : > "$1/stub.log"
    OUT="$(PATH="$STUBS:$PATH" STUB_LOG="$1/stub.log" bash "$1/work/update-repos.sh" "${@:2}" 2>&1)"; CODE=$?
    STUBLOG="$(cat "$1/stub.log")"
    [[ -n "${VERBOSE:-}" ]] && echo "$OUT"
    return 0
}

echo "S1 all repos behind: pull all four + rebuild per matrix"
sb="$(new_sandbox S1)"
push_change "$sb" install master tools/pianoid-assistant/package.json '{"v":2}'
push_change "$sb" core dev pianoid_cuda/Pianoid.cu v2
push_change "$sb" basic dev model.py v2
push_change "$sb" tunner dev package.json '{"v":2}'
run_update "$sb"
check 'exit code 0' '[[ $CODE -eq 0 ]]'
for r in install:work core:work/PianoidCore basic:work/PianoidBasic tunner:work/PianoidTunner; do
    check "${r%%:*} pulled" "[[ \$(head_of '$sb/${r##*:}') == \$(head_of '$sb/up/${r%%:*}') ]]"
done
check 'Basic build ran' 'grep -q "^build_pianoid_basic" <<<"$STUBLOG"'
check 'CUDA build --heavy --both' 'grep -q "^build_pianoid_cuda --heavy --both" <<<"$STUBLOG"'
check 'npm install in Tunner' 'grep -q "^npm install cwd=.*PianoidTunner" <<<"$STUBLOG"'
check 'npm install in assistant' 'grep -q "^npm install cwd=.*pianoid-assistant" <<<"$STUBLOG"'

echo "S2 PianoidInstall pull rewrites update-repos.sh: new version takes over"
sb="$(new_sandbox S2)"
newtext="$(sed 's/^    echo "Pianoid Repo Update  (pull + rebuild what changed)"$/&\n    echo SELFTEST-NEW-VERSION/' "$SCRIPT")"
push_change "$sb" install master update-repos.sh "$newtext"$'\n' tools/pianoid-assistant/package.json '{"v":3}'
push_change "$sb" core dev pianoid_middleware/backendServer.py v2
run_update "$sb"
check 'exit code 0' '[[ $CODE -eq 0 ]]'
check 'hand-over announced' 'grep -q "continuing with the new version" <<<"$OUT"'
check 'new version ran' 'grep -q SELFTEST-NEW-VERSION <<<"$OUT"'
check 'new version did not pull again' 'grep -q "Already pulled by the previous version" <<<"$OUT"'
check 'assistant npm across hand-over' 'grep -q "^npm install cwd=.*pianoid-assistant" <<<"$STUBLOG"'
check 'core pulled' '[[ $(head_of "$sb/work/PianoidCore") == $(head_of "$sb/up/core") ]]'
check 'middleware-only -> no CUDA build' '! grep -q "^build_pianoid_cuda" <<<"$STUBLOG"'

echo "S3 dirty install + core on a feature branch"
sb="$(new_sandbox S3)"
push_change "$sb" install master README.md x
push_change "$sb" core dev pianoid_cuda/Pianoid.cu v2
echo local >> "$sb/work/.gitignore"
git -C "$sb/work/PianoidCore" checkout -qb feature/x
pre_i="$(head_of "$sb/work")"; pre_c="$(head_of "$sb/work/PianoidCore")"
run_update "$sb"
check 'exit code 0' '[[ $CODE -eq 0 ]]'
check 'install not pulled' '[[ $(head_of "$sb/work") == "$pre_i" ]] && grep -q "SKIPPED (local changes)" <<<"$OUT"'
check 'core not pulled' '[[ $(head_of "$sb/work/PianoidCore") == "$pre_c" ]] && grep -q "SKIPPED (on .feature/x., not .dev.)" <<<"$OUT"'
check 'no CUDA build' '! grep -q "^build_pianoid_cuda" <<<"$STUBLOG"'

echo "S4 --dry-run"
sb="$(new_sandbox S4)"
push_change "$sb" install master update-repos.sh "$(cat "$SCRIPT")"$'\n# v2\n'
push_change "$sb" core dev build_config.json '{"v":2}'
push_change "$sb" basic dev model.py v2
pre_i="$(head_of "$sb/work")"; pre_c="$(head_of "$sb/work/PianoidCore")"
run_update "$sb" --dry-run
check 'exit code 0' '[[ $CODE -eq 0 ]]'
check 'nothing pulled' '[[ $(head_of "$sb/work") == "$pre_i" && $(head_of "$sb/work/PianoidCore") == "$pre_c" ]]'
check 'no stub called' '[[ -z "$STUBLOG" ]]'
check 'self-update reported' 'grep -q "would update update-repos.sh" <<<"$OUT"'
check 'build_config.json -> CUDA' 'grep -q "Rebuild CUDA                : 1" <<<"$OUT"'

rm -rf "$BASE"
echo
if [[ $FAILS -eq 0 ]]; then echo "ALL PASSED"; exit 0; fi
echo "$FAILS FAILED"; exit 1
