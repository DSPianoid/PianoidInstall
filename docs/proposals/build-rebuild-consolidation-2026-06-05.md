# Build / Rebuild / Update Instruction-Set — Audit & Consolidation Proposal

- **Date:** 2026-06-05
- **Agent:** analyse-buildaudit
- **Scope:** Audit the Pianoid BUILD / REBUILD / UPDATE instruction-set across CLAUDE.md, the skill files (`/dev`, `/startup`, `/sync`, `/update-pianoid`, `/orchestrator`), and the build docs (`BUILD_SYSTEM.md`, `QUICK_START.md`, `STARTUP_TROUBLESHOOTING.md`, `LINUX_BUILD.md`). Find gaps, conflicts, duplication. Propose ONE authoritative procedure + a mechanical change-list.
- **Status:** Proposal — READ-ONLY audit; no skill/doc/source edited. Fixes applied separately per the change-list below.
- **Motivating incidents (both this session, both avoidable):**
  - **FAIL #1** — a `/sync` merged origin's compiled-code changes (`.cu` + PianoidBasic `dev-d52b`, which added `StringMap.pack_output_mask` + a 7th `devMemoryInit` arg) into local dev and **pushed without rebuilding**. Backend then ran new Python against stale binaries → `/load_preset` 500 `AttributeError 'StringMap' has no attribute 'pack_output_mask'`. A post-merge rebuild + smoke-test should have been mandatory before "done".
  - **FAIL #2** — an agent launched `build_pianoid_cuda.bat` **without `cd`-ing to `PianoidCore` first** → the bat resolved `pianoid_cuda` against the repo root (`D:\repos\PianoidInstall\pianoid_cuda`) instead of `PianoidCore\pianoid_cuda` → `[ERROR] Folder not found: D:\repos\PianoidInstall\pianoid_cuda` → instant build failure + ~13-min idle stall.

- **Confirmed-live launch failures from dev-presetfix's actual rebuild this session** (team-lead, ground truth — these are the exact failure modes the consolidated command must be immune to):
  - **(L-1) WRONG CWD** = FAIL #2 above. Bare bat from repo root → `[ERROR] Folder not found: D:\repos\PianoidInstall\pianoid_cuda`. The bat resolves `pianoid_cuda` relative to cwd → cwd MUST be `PianoidCore`.
  - **(L-2) BARE BAT NAME "not recognized"** (NEW): after `cd /d …\PianoidCore`, invoking the **bare** `build_pianoid_cuda.bat` failed with *"is not recognized"* — the current directory is NOT on cmd's executable search path in this environment. Forms that WORK: the **absolute** bat path (`D:\repos\PianoidInstall\PianoidCore\build_pianoid_cuda.bat`) or `.\build_pianoid_cuda.bat`. CLAUDE.md's repo-root-relative `cmd //c "PianoidCore\build_pianoid_cuda.bat …"` (no `cd`) also avoids this — but the instant anyone *adds* a `cd` (the FAIL-#2 fix), the bare name breaks. **The consolidated command must be cd-safe: explicit path, never a bare bat name.** → see **GAP (h)**.
  - **(L-3) LOCKED BINARY → WinError 5** (NEW; confirms GAP (e) is real, not theoretical): a running backend held `pianoidCuda.cp312-win_amd64.pyd`; the `--heavy` build's pip-uninstall step would have failed `[WinError 5] Access is denied` had the backend not been stopped first. dev-presetfix had to stop the backend (PID 37348) via the launcher REST (`POST /api/stop-backend`) before the build could proceed. **The pre-build "stop the .pyd holder" step is load-bearing, not optional.**

---

## 1. Sources audited (docs-first order)

| Source | Build-relevant content |
|---|---|
| `.claude/CLAUDE.md` | "Build Commands (Quick Reference)" §; "Build & Environment Problems"; "Startup & Build Failure Rule"; "Cross-venv binary fetching is forbidden" |
| `.claude/commands/dev.md` | "Docs-first for compile + run" block; Step 4 "Rebuild after edits" + build markers; Step 6 build-failure pointer |
| `.claude/commands/startup.md` | "Build Commands" table; "Step 3B Build Failure"; "Step 3G Fresh Installation" |
| `.claude/commands/sync.md` | **(no build step at all)** — Step 3 merge, Step 6 push |
| `.claude/commands/update-pianoid.md` | "Docs-first before any rebuild" block; Step 3 rebuild-decision matrix; Step 5 rebuild commands |
| `.claude/commands/orchestrator.md` | "Rebuild Default — `--both` (BLOCKING)"; "Phase 2 sequence" (W1–W4); build-failure routing in "Stalled Agent Recovery" |
| `docs/architecture/BUILD_SYSTEM.md` | **Canonical pipeline** — the authoritative build reference |
| `docs/guides/QUICK_START.md` | "Build individual components" block |
| `docs/guides/STARTUP_TROUBLESHOOTING.md` | Build-failure symptoms + recovery |
| `feedback_bat_heavy_for_cuda_builds` / `feedback_build_both_for_user_test` / `feedback_follow_build_docs_strictly` (memories) | Detached-launch, `--both`-for-user-test, docs-first-strictly lessons |

---

## 2. GAPS

### GAP (a) — Working-directory requirement is INCONSISTENT and the dominant agent-facing copies OMIT the `cd` (caused FAIL #2). **[CRITICAL]**

The build script `build_pianoid_cuda.bat` MUST run with `PianoidCore` as cwd (or via a launch form that `cd /d`s into it first) because `setup.py` resolves `pianoid_cuda/` relative to cwd, not to the bat's own location in every invocation form. The corpus states this five different ways, and the two most prominent **agent-facing** copies (CLAUDE.md quick-ref, dev.md Step 4) DROP the `cd`:

| Source | Exact form | Has `cd`? |
|---|---|---|
| **CLAUDE.md** quick-ref | `unset VIRTUAL_ENV && cmd //c "PianoidCore\build_pianoid_cuda.bat --heavy --release"` | **NO** — relies on `%~dp0` |
| **dev.md** Step 4 | `unset VIRTUAL_ENV` … `cmd //c "PianoidCore\build_pianoid_cuda.bat --heavy"` | **NO** |
| dev.md docs-first block (line 33) | `cd PianoidCore && build_pianoid_cuda.bat --heavy --release` | yes |
| **update-pianoid.md** Step 5 | `env -u VIRTUAL_ENV cmd //c "cd /d PianoidCore && PianoidCore\build_pianoid_cuda.bat …"` | yes (but see GAP (g) — double-prefix bug) |
| BUILD_SYSTEM / startup / QUICK_START / STARTUP_TROUBLESHOOTING | `cd PianoidCore && ./build_pianoid_cuda.bat …` | yes |

BUILD_SYSTEM.md line 20 even documents *why* the bare-path form is fragile: *"`cmd //c "abs\path\to.bat"` can mis-resolve `%~dp0` — always `cd` first."* Yet the CLAUDE.md and dev.md copies (the ones an agent reads first) use exactly the bare-path form the doc warns against. **An agent that copies the CLAUDE.md or dev.md command verbatim reproduces FAIL #2 (= L-1).**

→ **Fix:** every build command in every file gets a `cd /d <PianoidCore>` (or the detached form's `cd /d` inside the `cmd /c`), with the `cd` stated as a hard precondition, not an option — **AND the bat is invoked by absolute (or `.\`-prefixed) path, never a bare name**, so the `cd` does not re-introduce the L-2 "not recognized" failure. The two fixes are coupled: `cd` alone fixes L-1 but creates L-2; `cd` + explicit-path fixes both. See GAP (h).

### GAP (b) — Detached-launch requirement is buried in prose / memory, NOT in the agent-facing build command. **[CRITICAL]**

The only correct way for an agent/orchestrator to run a `--heavy` build is a **detached** `PowerShell Start-Process -WindowStyle Hidden` with an **absolute** bat path + redirected log + poll. This is because:
- `cmd //c "...build...bat --heavy"` hits the harness **long-running-process gate** (fires even under `bypassPermissions`) AND **gates DESTRUCTIVELY** — the install removes the old `.pyd` at `[4/6]` before installing the new one at `[6/6]`; a gate-freeze there leaves the venv with NO `.pyd` (bricked `import pianoidCuda`). [memory: `feedback_bat_heavy_for_cuda_builds`]
- `Bash run_in_background: true` is reaped after ~2 min.
- Long foreground Bash trips the same long-running-process gate.

Where each source puts this:
- **CLAUDE.md** — the detached workaround is in the *startup/permission* prose ("Known gaps in bypassPermissions" → "Long-running process Bash invocations"), NOT next to the "Build Commands (Quick Reference)" block. The quick-ref block itself shows `cmd //c "..."`, the form that gate-stalls destructively.
- **dev.md** — Step 4 shows `cmd //c "PianoidCore\build_pianoid_cuda.bat --heavy"`; the detached requirement is only implied via the Step 1b server-start hierarchy, which is about *servers*, not *builds*.
- **update-pianoid.md** — Step 5 shows `env -u VIRTUAL_ENV cmd //c "..."`, again the gate-stall form.
- **orchestrator.md** — "Rebuild Default `--both`" mandates the *flag* but says nothing about the *launch mechanism*; "Stalled Agent Recovery" §12a mentions `Start-Process -WindowStyle Hidden` only as a recovery action AFTER a stall, not as the up-front build method.
- Only the **memory** has the full correct detached command (with the `set "VIRTUAL_ENV=...\.venv"` explicit-venv fix).

→ **Fix:** the authoritative procedure's agent-facing block leads with the detached `Start-Process` form as THE way agents build; `cmd //c` is documented only as the interactive-human form.

### GAP (c) — Post-merge / post-pull REBUILD trigger is MISSING in `/sync` and UNDER-SPECIFIED in `/orchestrator` Phase 2 (caused FAIL #1). **[CRITICAL]**

- **`/sync` has NO build step whatsoever.** It does Step 3 (merge feature branches into main), Step 5 (commit), Step 6 (push). Nothing between "merge" and "push" rebuilds or smoke-tests. A `/sync` that merges compiled-code changes (`.cu/.cpp/.cuh/.h/setup.py` or any PianoidBasic file) and pushes leaves local binaries stale AND publishes the new source — **this is exactly FAIL #1**. `/sync`'s own Step 2 "Conflict Detection" looks for *API contract mismatches* but never connects that to "therefore rebuild."
- **`/orchestrator` Phase 2 sequence** (W1 merge features → local dev, W2 wrap agents, W3 reconcile with origin/pull, W4 push) has **no rebuild step** between W3 (pull from origin, which can bring in others' compiled changes) and W4 (push). The sequence is about *git topology*, not *binary freshness*. After W3 pulls origin/dev, the local binaries may be stale against the merged source, and nothing forces a rebuild + smoke-test before the orchestrator declares the environment ready or the user live-tests.
- **`/update-pianoid` DOES handle this correctly** — Step 3 rebuild-decision matrix keys off `git diff HEAD..origin/<branch> --name-only` and Step 5 rebuilds. This is the model the others should follow. But `/update-pianoid` is a *separate* skill the user must invoke; a `/sync` or an orchestrator Phase-2 reconcile does NOT call it.

→ **Fix:** add a mandatory "post-merge/pull rebuild gate" to `/sync` (new step between merge and push) and to `/orchestrator` Phase 2 (new W3.5 between reconcile and push). The trigger is mechanical: *if the merged/pulled diff touches `.cu`/`.cpp`/`.cuh`/`.h`/`setup.py`/`detect_paths.py`/any `PianoidBasic/**` → rebuild (heavy if C++/CUDA/PianoidBasic, light if middleware-only) THEN `/load_preset` 200 smoke-test, BEFORE push/handoff.*

### GAP (d) — Build-completion VERIFICATION is stated but the `/load_preset` 200 smoke-test is NOT a uniform required step. **[MAJOR]**

The corpus has TWO levels of "verify" and conflates them:
- **Level 1 — import verify** (`import pianoidCuda; print(pianoidCuda.__file__)` resolves inside `PianoidCore/.venv/`). Present in CLAUDE.md, dev.md, update-pianoid.md, BUILD_SYSTEM.md. Good.
- **Level 2 — runtime smoke-test** (`/load_preset` returns 200, `/health` 200, no Python tracebacks). This is what would have caught FAIL #1 (`pack_output_mask` AttributeError surfaces only at `/load_preset`, not at bare `import`). It is mandated for **user-facing handoffs** by memory `feedback_follow_build_docs_strictly` ("'Ready' means backend smoke-tested … not 'ports listening'") and partially by startup.md Step 3D / Step 4, but it is NOT a required closing step of `/dev` Step 4 (build), `/sync`, or the orchestrator Phase-2 reconcile. Import-verify alone passes even when the Python↔C++ API has diverged (the import succeeds; the missing-attribute error fires only when the middleware *calls* the new API).

→ **Fix:** elevate the `/load_preset` 200 smoke-test to a required post-rebuild step in the consolidated procedure, explicitly for any rebuild triggered by a merge/pull (API-divergence is precisely the case import-verify misses).

### GAP (e) — Locked-binary PRE-CHECK is present but UNEVEN. **[MAJOR — CONFIRMED real this session (L-3)]**

The "stop the `.pyd`/`cudart` holder before building" pre-check is well-covered in BUILD_SYSTEM.md (twice), dev.md Step 4 (with `[BUILD-PRECHECK]` marker), CLAUDE.md quick-ref, and startup.md. It is **absent** from `/sync` (which has no build step at all) and **absent** from `/update-pianoid` Step 5 (the docs-first block at line 19 mentions it, but Step 5 — the actual rebuild commands — does not restate it). Since `/update-pianoid` is the most likely place a stale-holder lock bites (a backend may be running when the user invokes it), the pre-check belongs inline at Step 5.

**Confirmed live this session (L-3):** dev-presetfix's `--heavy` build would have hit `[WinError 5] Access is denied` on the pip-uninstall step because a running backend held `pianoidCuda.cp312-win_amd64.pyd` — the holder (PID 37348) had to be stopped via the launcher REST (`POST /api/stop-backend`) first. The `--heavy` uninstall removes the `.pyd` *before* reinstall, so a WinError-5 there leaves the venv broken (same bricked-venv class as the destructive gate-stall in GAP (b)). This pre-check is load-bearing, not advisory — upgrading severity from MINOR to MAJOR.

→ **Fix:** the consolidated procedure includes the pre-check as STEP 1 of the build block (stop-holder, by PID or via launcher REST, never blanket `//IM python.exe`); every skill that rebuilds references it. Prefer the launcher REST `POST /api/stop-backend` when a launcher is up (graceful, no PID hunt).

### GAP (h) — The single authoritative command is NOT cd-safe: `cd` + bare bat name fails "not recognized" (NEW, confirmed L-2). **[CRITICAL]**

The fix for FAIL #2 / GAP (a) is "add a `cd` to PianoidCore". But adding a `cd` and then invoking the **bare** `build_pianoid_cuda.bat` fails in this environment with *"'build_pianoid_cuda.bat' is not recognized…"* — because cmd does not search the current directory for executables unless it is on `PATH` (and `.` is not, by default, in this env). So the naive FAIL-#2 fix trades one failure (wrong-cwd folder-not-found) for another (cd'd-but-bat-not-found). Three forms actually work:

| Form | Works? | Why |
|---|---|---|
| `cmd //c "PianoidCore\build_pianoid_cuda.bat …"` (repo-root cwd, no `cd`, relative path) | works **only** from repo root | CLAUDE.md's current form — but FAIL #2 is exactly an agent NOT at repo root |
| `cd /d …\PianoidCore && build_pianoid_cuda.bat` (cd + **bare** name) | **FAILS (L-2)** "not recognized" | `.` not on cmd PATH |
| `cd /d …\PianoidCore && .\build_pianoid_cuda.bat` (cd + `.\`) | works | explicit current-dir prefix |
| `cd /d …\PianoidCore && D:\…\PianoidCore\build_pianoid_cuda.bat` (cd + **absolute** path) | works | absolute path needs no search |
| `Start-Process -FilePath "D:\…\PianoidCore\build_pianoid_cuda.bat" …` (absolute, detached) | works | absolute path; the agent form |

→ **Fix:** the consolidated copy-pasteable command uses an **absolute bat path** (cd-safe regardless of cwd, and the only form that also works in the detached `Start-Process -FilePath` agent build). The `cd /d …\PianoidCore` is still present (it sets cwd so `setup.py` finds `pianoid_cuda/` — L-1), but the bat is invoked by absolute path, not bare name. This single change makes the command immune to BOTH L-1 and L-2 simultaneously.

### GAP (f) — `--release` vs `--both` DEFAULT is contradictory across files (also a CONFLICT — see §3). **[MAJOR]**

This is both a gap (no single stated default) and a conflict. Summarized here, detailed in §3 row C1. The root-`.venv`-vs-`PianoidCore/.venv` trap is well-covered everywhere (`unset VIRTUAL_ENV` / `env -u VIRTUAL_ENV`), so that sub-gap is closed; the variant default is the open one.

### GAP (g) — `/update-pianoid` Step 5 command has a latent double-prefix path bug. **[MINOR]**

Step 5: `env -u VIRTUAL_ENV cmd //c "cd /d PianoidCore && PianoidCore\build_pianoid_cuda.bat --heavy --both"`. From the repo root, `cd /d PianoidCore` makes cwd `…\PianoidCore`, then `PianoidCore\build_pianoid_cuda.bat` resolves to `…\PianoidCore\PianoidCore\build_pianoid_cuda.bat` — which does not exist. (It currently "works" only because the repo-root thin-wrapper `build_pianoid_cuda.bat` also exists and the relative path from repo-root cwd happens to find it in some invocation orders — but it is fragile and contradicts BUILD_SYSTEM.md's "the canonical build pair is the one under `PianoidCore/`".)

→ **Fix:** in the consolidated command, `cd` and bat-path are consistent and cd-safe: `cd /d <abs>\PianoidCore` then the **absolute** bat path `<abs>\PianoidCore\build_pianoid_cuda.bat` (NOT the bare name — that's the L-2 "not recognized" failure per GAP (h); NOT the double `PianoidCore\` prefix — that's this bug). One absolute path, used after the `cd`, is immune to L-1, L-2, and this double-prefix bug at once.

---

## 3. CONFLICTS (divergent instructions — which is authoritative)

| # | Topic | Divergence | Authoritative | Resolution |
|---|---|---|---|---|
| **C1** | **Default variant** | dev.md Step 4 = `--heavy` (no variant → `release`); CLAUDE.md quick-ref = `--heavy --release`; startup.md table + update-pianoid.md + orchestrator.md "Rebuild Default" + QUICK_START + STARTUP_TROUBLESHOOTING + BUILD_SYSTEM "Build Commands" table = `--heavy --both`. | **`--both`** per orchestrator.md "Rebuild Default — `--both` (BLOCKING)" + memories `feedback_build_both_for_user_test` / `feedback_follow_build_docs_strictly`. The `--release`-only default in dev.md/CLAUDE.md is the *exact* form the 2026-05-30 incident corrected. | dev.md Step 4 and CLAUDE.md quick-ref change to `--both` as the default; `--release`-only kept only as an explicit "release only" option with the caveat that the debug `.pyd` goes stale. |
| **C2** | **Launch mechanism for agents** | CLAUDE.md quick-ref + dev.md Step 4 + update-pianoid.md Step 5 = `cmd //c "..."` (gate-stalls destructively in agent context); memory + orchestrator §12a = `Start-Process -WindowStyle Hidden`. | **`Start-Process -WindowStyle Hidden`** for agent/orchestrator contexts (memory `feedback_bat_heavy_for_cuda_builds`, confirmed cost 2 bricked builds). `cmd //c` is the human-interactive form only. | Consolidated procedure presents BOTH, clearly labelled "agent/orchestrator (detached)" vs "interactive human". The agent-facing skill copies lead with the detached form. |
| **C3** | **Working directory** | CLAUDE.md + dev.md Step 4 = no `cd` (bare `PianoidCore\...bat`); everyone else = `cd PianoidCore` first. BUILD_SYSTEM line 20 explicitly says always `cd` first. | **`cd` first** (BUILD_SYSTEM.md is the canonical build reference and warns against the bare form). | All copies get the `cd /d`. |
| **C4** | **Shell idiom in shared doc commands** | BUILD_SYSTEM / QUICK_START / STARTUP_TROUBLESHOOTING / startup.md use bash-ish `cd X && ./build…bat --heavy --both`; the platform shell is PowerShell (`&&` is a parse error in WinPS 5.1; `./` + `unset`/`env -u` are bash). | Mixed by design (docs are cross-platform-ish), but the **agent-facing** copies (CLAUDE.md, dev.md, update-pianoid, orchestrator dispatch) must be runnable as-is in the agent's actual shell. | Consolidated procedure gives a PowerShell-correct detached form (no `&&` chaining; `cd /d` inside the single `cmd /c` arg-string) + a bash form, each tagged. |
| **C5** | **Co-author trailer in `/sync` commits** | sync.md Step 5 hard-codes `Co-Authored-By: Claude Opus 4.6`. | Out of scope for build, but flag: stale model name. | Note only — not a build fix. |

No conflict found in: venv location (uniformly `PianoidCore/.venv/`), `unset VIRTUAL_ENV` requirement (uniform), 0xC0000142 recovery (uniform pointer to BUILD_SYSTEM.md), `--heavy` vs `--light` semantics (uniform), debug-variant DLL trap (uniform).

---

## 4. DUPLICATION (drift risk — same commands copy-pasted)

The canonical CUDA rebuild command and its caveats are **copy-pasted in 7 places**, already drifted (per §2/§3):

| Location | What's duplicated | Drift today |
|---|---|---|
| BUILD_SYSTEM.md "Canonical Install / Rebuild" | full command + pre-checks + 0xC0000142 + verify | — (the canonical source) |
| CLAUDE.md "Build Commands (Quick Reference)" | command + pre-check + verify | `--release` default (should be `--both`); no `cd`; `cmd //c` form |
| dev.md Step 4 + docs-first block | command + pre-check + markers | `--heavy` no-variant; no `cd` in Step 4 |
| startup.md "Build Commands" table | command variants | OK on `--both` but `cd` only in the table's "Location" column |
| update-pianoid.md Step 5 | command + matrix | double-prefix path bug (GAP g) |
| QUICK_START.md "Build individual components" | command variants | bash `./` form |
| STARTUP_TROUBLESHOOTING.md (4 occurrences) | recovery commands | mix of `--both` / `--release` |

CLAUDE.md line 183 already states the intent — *"do not maintain a competing copy of build commands here"* — but then the quick-ref block immediately below it IS a competing copy (and a drifted one). The "Verify" and "locked-files" sub-blocks are likewise re-stated.

→ **Fix:** make **BUILD_SYSTEM.md** the single source of truth (it already is, structurally). Every other file keeps ONE tight agent-facing block (the copy-pasteable command, because agents need it inline to act) but **trims the prose/caveats to a one-line "see BUILD_SYSTEM.md §Canonical for pre-checks, recovery, verify."** The inline command in each file is identical to BUILD_SYSTEM's and kept in sync by being short and singular.

---

## 5. PROPOSED CONSOLIDATION — the single source of truth

### 5.1 The authoritative "Build & Rebuild Procedure"

This block becomes the body of **BUILD_SYSTEM.md → "Canonical Install / Rebuild (Read This First)"** and is referenced (not re-derived) everywhere else. `<CORE>` = the OS-specific PianoidCore absolute path (`D:\repos\PianoidInstall\PianoidCore` on Windows).

```
PIANOID BUILD & REBUILD — CANONICAL PROCEDURE  (single source of truth: BUILD_SYSTEM.md)

WHEN TO BUILD
  • Edited .cu/.cpp/.cuh/.h/setup.py/detect_paths.py ........ HEAVY CUDA build
  • Edited pianoid_middleware/*.py only ..................... LIGHT CUDA build
  • Edited / merged / pulled any PianoidBasic/** ............ PianoidBasic build  (+ heavy CUDA if .cu/.cpp also changed)
  • MERGED or PULLED a diff touching any of the above ....... REBUILD per the file types in the diff  (POST-MERGE/PULL GATE, §5.2)
  • Edited tests/** only .................................... no rebuild
  Default variant = --both (release + debug). Use --release ONLY when the caller says "release only"
  (leaving the debug .pyd stale silently breaks every later debug-variant import / the APPLY debug_mode=1 path).

STEP 1 — PRE-CHECK + STOP the locked-binary holder   [agents emit [BUILD-PRECHECK] holders=...]
  A running backend holding the .pyd makes the --heavy pip-uninstall fail [WinError 5] and BRICKS the venv
  (uninstall removes the .pyd before reinstall). This step is LOAD-BEARING (confirmed L-3, PID 37348 this session).
  PREFERRED — if a launcher is up, stop the backend gracefully (no PID hunt):
            curl -X POST http://127.0.0.1:3001/api/stop-backend
  ELSE — find + kill the specific holder:
  Windows:  tasklist //M pianoidCuda.cp312-win_amd64.pyd 2>/dev/null | grep python
            tasklist //M cudart64_12.dll 2>/dev/null | grep python
            taskkill //F //PID <pid>        # specific PID only — NEVER //IM python.exe
  Linux:    lsof PianoidCore/.venv/lib/python3.12/site-packages/pianoidCuda*.so 2>/dev/null

STEP 2 — BUILD  (cwd MUST be PianoidCore [L-1]; bat invoked by ABSOLUTE path [L-2]; VIRTUAL_ENV set EXPLICITLY)
  cd-safety: the `cd /d <CORE>` sets cwd so setup.py finds pianoid_cuda/ (L-1). The bat is ALWAYS invoked by its
  ABSOLUTE path `<CORE>\build_pianoid_cuda.bat` — a BARE `build_pianoid_cuda.bat` after a cd FAILS "not recognized"
  (L-2: cwd is not on cmd's exec PATH). Never bare-name, never the double `PianoidCore\PianoidCore\` prefix (GAP g).

  --- AGENT / ORCHESTRATOR context (DETACHED — required; cmd //c gate-stalls DESTRUCTIVELY) ---
  PowerShell:
    Start-Process -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList `
      '/c','set "VIRTUAL_ENV=<CORE>\.venv" && cd /d <CORE> && <CORE>\build_pianoid_cuda.bat --heavy --both > D:\tmp\build.log 2>&1' -PassThru
    # set VIRTUAL_ENV EXPLICITLY to <CORE>\.venv (NOT empty — empty-but-defined sends the install to SYSTEM python).
    # ABSOLUTE bat path inside the cmd /c (cd does not put cwd on PATH → a bare bat name = "not recognized", L-2).
    # Then poll D:\tmp\build.log + the .pyd mtime; emit [PROGRESS]; done when log shows [SUCCESS] Build completed.

  --- INTERACTIVE HUMAN context (Windows) ---
    cd /d <CORE> && <CORE>\build_pianoid_cuda.bat --heavy --both      # absolute path, or .\build_pianoid_cuda.bat
    (light:  <CORE>\build_pianoid_cuda.bat --light --both    |   release-only: ... --heavy --release)

  --- Linux (any context) ---
    PianoidCore/build_pianoid_cuda.sh --heavy --both       # ASIO excluded; produces .so; libdir lib64; g++ host

  PianoidBasic:  cd /d <CORE> && <CORE>\build_pianoid_basic.bat        (Linux: build_pianoid_basic.sh)

STEP 3 — VERIFY  (BOTH levels; import-only is NOT enough after a merge/pull)
  L1 import:   PianoidCore/.venv/Scripts/python -c "import pianoidCuda; print(pianoidCuda.__file__)"
               → path MUST be inside PianoidCore/.venv/  (NOT root .venv/)   [Linux: .venv/bin/python]
  L1 debug:    ...python -c "import pianoidCuda; import pianoidCuda_debug; print('OK')"   (when --both)
  L2 smoke:    start backend, then  POST /load_preset {path:"presets/BaselinePreset1.json", start_right_away:1}
               → expect 200 + /health 200 + NO Python traceback (AttributeError/ImportError/ModuleNotFoundError).
               REQUIRED after any merge/pull-triggered rebuild (API divergence shows only at /load_preset, not at import).
  agents emit:  [BUILD OK] duration=<s> marker=<verify> verified=yes

RECOVERY
  • Exit 3221225794 (0xC0000142): NOT a pip-install fallback — delete %TEMP%\pip-build-env-*, pip cache purge,
    re-run the canonical build.  Full steps: BUILD_SYSTEM.md §0xC0000142 Recovery.
  • Any other build/install/startup failure: invoke /startup. Do NOT improvise (.pth shim, pip --force-reinstall).
  • NEVER  pip install --force-reinstall pianoid_cuda/  → silently reinstalls the STALE .pyd.
```

### 5.2 Post-merge / post-pull REBUILD GATE (the new mandatory trigger — closes FAIL #1)

> After ANY operation that brings new source into the working tree — a feature→dev merge, a `git pull`/reconcile, a `/sync` merge, an `/update-pianoid` pull, or an orchestrator Phase-2 reconcile — compute the incoming diff and rebuild BEFORE pushing or handing off:
>
> ```
> git -C <repo> diff <pre-state>..<post-state> --name-only
> ```
>
> | Diff touches | Action (then §5.1 STEP 3 VERIFY incl. L2 smoke) |
> |---|---|
> | `pianoid_cuda/*.cu`, `*.cpp`, `*.cuh`, `*.h`, `setup.py`, `detect_paths.py` | HEAVY CUDA `--both` |
> | any `PianoidBasic/**` | PianoidBasic build (+ HEAVY CUDA if `.cu/.cpp` also in diff) |
> | `pianoid_middleware/*.py` only | LIGHT CUDA `--both` |
> | `PianoidTunner` `package.json` / `package-lock.json` | `npm install` |
> | docs / tests only | no rebuild |
>
> **Push / declare-ready is BLOCKED until the rebuild + `/load_preset` 200 smoke-test pass.** This is the gate that FAIL #1 skipped: new Python (`StringMap.pack_output_mask`) ran against stale binaries because merge→push had no rebuild step.

### 5.3 One-line reference stub (drop into every non-canonical file)

> **Build / rebuild:** follow the canonical procedure in [`docs/architecture/BUILD_SYSTEM.md` → Canonical Install / Rebuild](../architecture/BUILD_SYSTEM.md#canonical-install--rebuild-read-this-first) — stop the .pyd holder first (launcher REST or PID), cwd `PianoidCore`, bat by **absolute path** (cd-safe), `unset VIRTUAL_ENV`, default `--both`, detached `Start-Process` in agent contexts, verify import **and** `/load_preset` 200. After any merge/pull touching compiled code, the post-merge rebuild gate (§ that doc) is mandatory before push/handoff.

---

## 6. CHANGE-LIST (mechanical; each tagged [ORCH] = skill/CLAUDE.md → orchestrator edits, sub-agents gated · [DOCS] = docs/** → /dev or /update-docs agent edits)

> Recommendation: **BUILD_SYSTEM.md holds the authoritative procedure** (§5.1 + §5.2). CLAUDE.md keeps a tight agent-facing quick-block; all other files trim to the §5.3 stub + their own decision matrix. Apply [DOCS] edits via one `/update-docs` (or `/dev`) agent; apply [ORCH] edits directly (sub-agents are gated from `.claude/`).

### 6.1 — `docs/architecture/BUILD_SYSTEM.md`  **[DOCS]** — make it the single source of truth
- **§"Canonical Install / Rebuild (Read This First)"** — REPLACE the current top block with §5.1 verbatim (adds: detached agent form leading, explicit-VIRTUAL_ENV note, L2 `/load_preset` smoke-test, **cd-safe absolute bat path (closes L-2)**, launcher-REST stop-holder as STEP-1 preferred (closes L-3)).
- **NEW §"Post-Merge / Post-Pull Rebuild Gate"** — add §5.2 verbatim (this concept does not exist anywhere in the docs today).
- Before:`cd PianoidCore && ./build_pianoid_cuda.bat --heavy --release` (line 9, release default, bash form) → After: the §5.1 block (both contexts, `--both` default).

### 6.2 — `.claude/CLAUDE.md`  **[ORCH]** — fix the quick-ref drift
- **§"Build Commands (Quick Reference)"** —
  - Before: `unset VIRTUAL_ENV && cmd //c "PianoidCore\build_pianoid_cuda.bat --heavy --release"` → After: the agent-facing detached `Start-Process` form from §5.1 STEP 2 (with `cd /d <CORE>` + **absolute bat path `<CORE>\build_pianoid_cuda.bat`** + `--both` default). The absolute path is what makes it cd-safe — closes L-1 and L-2 together.
  - Add the §5.2 post-merge gate as a 3-line callout ("After a merge/pull touching `.cu/.cpp/.cuh/.h/setup.py`/PianoidBasic → rebuild + `/load_preset` 200 before push.").
  - Replace the inline Windows release-only command with a pointer: "default `--both`; `--release` only on explicit request — see BUILD_SYSTEM.md §Canonical."
  - Keep the Linux block (it's correct) but align its default to `--both`.

### 6.3 — `.claude/commands/dev.md`  **[ORCH]** — Step 4 default + cwd + detached
- **Step 4 "Build commands"** —
  - Before (CUDA heavy): `unset VIRTUAL_ENV` / `cmd //c "PianoidCore\build_pianoid_cuda.bat --heavy"` → After: detached `Start-Process` form, `cd /d <CORE>` + **absolute bat path** `<CORE>\build_pianoid_cuda.bat`, `--heavy --both` default.
  - Before (CUDA light): `cmd //c "PianoidCore\build_pianoid_cuda.bat --light"` → After: `... <CORE>\build_pianoid_cuda.bat --light --both`.
  - The Step-4 build-decision **table** (line ~626) keep, but change the "see below (heavy)" target to the §5.1 procedure and set `--both` default.
- **"Docs-first for compile + run" block (line ~33)** — currently `cd PianoidCore && build_pianoid_cuda.bat --heavy --release` (bare name + release): change to `cd /d <CORE> && <CORE>\build_pianoid_cuda.bat --heavy --both` (absolute path closes L-2, `--both` closes C1).
- Leave all the `[BUILD-PRECHECK]/[BUILD STARTED]/[BUILD OK]` markers as-is (they're good); just ensure `[BUILD OK]` description mentions L2 smoke when the build was merge/pull-triggered.

### 6.4 — `.claude/commands/sync.md`  **[ORCH]** — ADD the missing rebuild gate (closes FAIL #1)
- **NEW Step 5.5 "Post-Merge Rebuild Gate" (between Step 5 Commit and Step 6 Push)** — insert §5.2: after the Step-3 merges and Step-5 commits, compute `git diff` of what the merges brought in; if it touches compiled code, run the canonical rebuild + `/load_preset` 200 smoke-test; **block Step 6 push until it passes.** Cross-reference BUILD_SYSTEM.md §Canonical + §Post-Merge Gate.
- **Step 2 "Conflict Detection"** — add a closing line: "If any cross-repo change alters a Python↔C++ API surface, the post-merge rebuild gate (Step 5.5) is mandatory — stale binaries against new source is the FAIL-#1 class."
- (Optional, [ORCH]) Step 5 commit trailer `Claude Opus 4.6` is stale — out of scope but worth a same-pass fix.

### 6.5 — `.claude/commands/update-pianoid.md`  **[ORCH]** — fix path bug + inline pre-check + smoke-test
- **Step 5 build commands** —
  - Before: `env -u VIRTUAL_ENV cmd //c "cd /d PianoidCore && PianoidCore\build_pianoid_cuda.bat --heavy --both"` (double-prefix, GAP g) → After: `... cmd //c "cd /d <CORE> && <CORE>\build_pianoid_cuda.bat --heavy --both"` — **absolute bat path after the `cd`** (NOT bare name, which is the L-2 "not recognized" failure; NOT the double `PianoidCore\` prefix), OR the detached `Start-Process` form for agent context. Same fix for the `--light --both` and `build_pianoid_basic.bat` lines.
  - Add the locked-binary pre-check + stop-holder (§5.1 STEP 1, launcher-REST preferred) as the first action of Step 5 (currently only in the docs-first preamble).
  - Add L2 `/load_preset` 200 smoke-test to the post-rebuild verify (Step 5 currently stops at import-verify in the preamble).
- The Step-3 rebuild-decision matrix is the model — leave it; just align its targets to the §5.1 procedure and confirm `detect_paths.py` row triggers heavy (it does).

### 6.6 — `.claude/commands/orchestrator.md`  **[ORCH]** — Phase-2 rebuild step + dispatch mechanism
- **§"Full Clearance … Phase 2 sequence"** — insert **W3.5 "Rebuild gate" between W3 (reconcile with origin) and W4 (push)**: "After the origin reconcile, if the pulled/merged diff touches compiled code (`.cu/.cpp/.cuh/.h/setup.py`/PianoidBasic), dispatch a rebuild (`--both`) + `/load_preset` 200 smoke-test before W4 push or before declaring the environment ready. Stale binaries against reconciled source is the FAIL-#1 class." Cross-ref BUILD_SYSTEM.md §Post-Merge Gate.
- **§"Rebuild Default — `--both` (BLOCKING)"** — keep (it's correct and load-bearing); add one line: "Dispatch prompts for builds MUST also direct the agent to the **detached `Start-Process -WindowStyle Hidden`** launch (not `cmd //c`, which gate-stalls destructively), to `cd /d PianoidCore` AND invoke the bat by **absolute path** (a bare bat name after the cd fails 'not recognized', L-2), and to **stop the .pyd holder first** (launcher REST `POST /api/stop-backend`, L-3) — see BUILD_SYSTEM.md §Canonical STEP 1–2."

### 6.7 — `.claude/commands/startup.md`  **[ORCH]** — align + add detached note
- **"Build Commands" table** — already `--both`-correct; add a footnote: "Agent/orchestrator runs use the detached `Start-Process` form (BUILD_SYSTEM.md §Canonical STEP 2); the table shows the interactive form." Confirm every row's "Location" = `PianoidCore/` is restated as a `cd /d` precondition in §3B/§3G.
- **Step 3B / Step 3G** — add the L2 `/load_preset` 200 smoke-test to "Step 4 Verify Fix" as the closing gate (it has import + health; make `/load_preset` 200 explicit).

### 6.8 — `docs/guides/QUICK_START.md` + `docs/guides/STARTUP_TROUBLESHOOTING.md`  **[DOCS]** — trim to reference
- Replace each in-file full command block with the §5.3 stub + a pointer to BUILD_SYSTEM.md §Canonical, keeping at most ONE short copy-pasteable line for the human reader. Normalize stray `--release` defaults to `--both` (STARTUP_TROUBLESHOOTING has 4 occurrences mixing the two). LINUX_BUILD.md already references BUILD_SYSTEM.md — leave it, just confirm `--both` default.

---

## 7. Summary of the change-list

| File | Tag | Core change |
|---|---|---|
| BUILD_SYSTEM.md | [DOCS] | Becomes single source of truth: replace canonical block (§5.1, cd-safe absolute path + launcher-REST stop) + ADD post-merge gate (§5.2) |
| CLAUDE.md | [ORCH] | Quick-ref → detached `--both` form + `cd` + **absolute bat path** + post-merge callout |
| dev.md | [ORCH] | Step 4 + docs-first → detached `--both` + `cd` + **absolute bat path** |
| sync.md | [ORCH] | **ADD Step 5.5 rebuild gate** (closes FAIL #1) |
| update-pianoid.md | [ORCH] | Fix double-prefix path bug + **absolute bat path** + inline pre-check/stop-holder + L2 smoke-test |
| orchestrator.md | [ORCH] | **ADD W3.5 rebuild gate** in Phase 2 + detached/absolute-path/stop-holder note on Rebuild-Default |
| startup.md | [ORCH] | Detached-form footnote + L2 smoke-test in Verify |
| QUICK_START.md, STARTUP_TROUBLESHOOTING.md | [DOCS] | Trim to §5.3 stub + normalize `--both` |

**Highest-value fixes (each directly closes one of this session's three live failures):**
1. **`/sync` Step 5.5 + orchestrator W3.5 post-merge/pull rebuild gate** (§5.2) → closes **FAIL #1** (merge/pull-then-push without rebuild; import-verify alone misses it → L2 `/load_preset` smoke-test required).
2. **`cd /d PianoidCore` precondition + bat invoked by ABSOLUTE path** in CLAUDE.md + dev.md + update-pianoid + orchestrator dispatch (§5.1 STEP 2) → closes **FAIL #2 / L-1** (wrong-cwd `[ERROR] Folder not found`) AND **L-2** (cd'd-but-bare-bat `not recognized`) in one stroke. The two are coupled: the naive `cd`-only fix for L-1 *creates* L-2 — only `cd` + absolute path is immune to both.
3. **Stop the .pyd holder (launcher REST preferred) as a load-bearing STEP 1** (§5.1) → closes **L-3** (running backend → `[WinError 5]` on the `--heavy` uninstall → bricked venv). Confirmed real this session (PID 37348).

All three were reproduced live by dev-presetfix's actual rebuild this session — the consolidated command (cd + absolute path + stop-holder + `--both` + detached) is constructed to be simultaneously immune to L-1, L-2, and L-3.

---

### Investigation history
- Sources read in full: CLAUDE.md, BUILD_SYSTEM.md, dev.md (1241 LOC), startup.md, sync.md, update-pianoid.md, orchestrator.md (1188 LOC); spot-grep of QUICK_START.md + STARTUP_TROUBLESHOOTING.md build commands; memories `feedback_bat_heavy_for_cuda_builds`, `feedback_build_both_for_user_test`, `feedback_follow_build_docs_strictly`.
- No prior build/rebuild proposal existed in `docs/proposals/` (checked `*build*`, `*rebuild*`) — nothing to archive.
