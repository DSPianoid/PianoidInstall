---
name: dev
description: Development workflow — study context, baseline test, branch, edit, verify, debug, document, commit.
user-invocable: true
argument-hint: <task description — bug fix, feature, or refactor>
---

# Pianoid Development Workflow

Disciplined development cycle for PianoidCore, PianoidBasic, and PianoidTunner. Follow every step in order. Do not skip steps.

**Code principles:** Lean (minimum code for the task), modular (one function one job), no workarounds (fix root causes), no redundancy (reuse existing utilities), match existing style.

## Step 0: Start Session Log

Create a session log file to track all actions during this dev session.

```bash
# Generate log filename with timestamp
LOG_FILE="D:/repos/PianoidInstall/docs/development/logs/dev-$(date +%Y-%m-%d-%H%M%S).md"
```

Write the log header:

```markdown
# Dev Session Log

- **Task:** <user's task description>
- **Started:** <ISO timestamp>
- **Plan file:** <path to plan file if following one, or "None">
- **Status:** In Progress

## Actions

```

**Add a reference to `docs/development/WORK_IN_PROGRESS.md`** under a `## Active Dev Session` heading at the top of the file:

```markdown
## Active Dev Session

**Log:** [dev-YYYY-MM-DD-HHMMSS.md](logs/dev-YYYY-MM-DD-HHMMSS.md) — <brief task description>

---
```

**Logging rule:** After completing each step below, append a timestamped entry to the log file:

```markdown
### Step N: <Step Name> — <HH:MM>
- <what was done: files read, commands run, decisions made>
- <outcomes, metrics, errors encountered>
```

Keep entries concise — bullet points, not prose. The log is a breadcrumb trail, not a narrative.

## Step 1: Understand Context (top-down)

Read documentation in this order, stopping when you have enough context:

1. `D:\repos\PianoidInstall\docs\index.md` — big picture, module map
2. `D:\repos\PianoidInstall\docs\architecture\SYSTEM_OVERVIEW.md` — 4-layer stack, threading, lifecycle
3. `D:\repos\PianoidInstall\docs\architecture\DATA_FLOWS.md` — trace the relevant data flow
4. Drill into the specific module doc:
   - CUDA engine: `docs/modules/pianoid-cuda/*.md`
   - Middleware: `docs/modules/pianoid-middleware/*.md`
   - Domain model: `docs/modules/pianoid-basic/OVERVIEW.md`
   - Frontend: `docs/modules/pianoid-tunner/OVERVIEW.md`
5. Read the actual source files identified from the docs
6. Check `docs/development/WORK_IN_PROGRESS.md` for related ongoing work

Summarize to the user:
- Which files are affected
- Which data flow / component is involved
- Proposed approach

**Ask the user to confirm the approach before proceeding.**

## Step 1b: Kill Stale Backend Instances (MANDATORY)

Before running any tests, builds, or starting the backend, **always** kill existing Pianoid backend and frontend processes. Stale instances from previous sessions cause port conflicts and distorted audio output (two audio drivers fighting over the sound device).

**CRITICAL: Only kill processes bound to Pianoid ports — NEVER use blanket `taskkill //F //IM python.exe` or `taskkill //F //IM node.exe`.** Those commands kill MCP servers (WhatsApp, email, Google Workspace), Chrome DevTools, and even Claude Code itself (node.exe), crashing the orchestrator session.

```bash
# Kill ONLY processes on Pianoid ports (5000=backend, 3000/3001=frontend)
for port in 5000 3000 3001; do
  pid=$(netstat -ano 2>/dev/null | grep ":${port} .*LISTENING" | awk '{print $NF}' | head -1)
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    echo "Killing PID $pid on port $port"
    taskkill //F //PID "$pid" 2>/dev/null
  fi
done
# Wait for ports to release
sleep 2
# Verify ports are free
netstat -ano 2>/dev/null | grep -E ":(3000|3001|5000) " && echo "WARNING: ports still in use" || echo "Ports clear"
```

**This applies every time** — even if you think nothing is running. Previous sub-agents or user sessions may have left orphaned processes. Distorted sound is the #1 symptom of skipping this step.

## Step 2: Baseline Performance Test

Before any code changes, run the performance test suite and save results:

```bash
cd D:\repos\PianoidInstall\PianoidCore
.venv/Scripts/python -m pytest tests/system/test_performance.py -v -s 2>&1 | tee /tmp/baseline_perf.log
```

Record these metrics from the output:

| Metric | Value |
|--------|-------|
| GPU mean (ms) | — |
| GPU p99 (ms) | — |
| Total cycle mean (ms) | — |
| Underrun count | — |
| Sound correlation | — |

If baseline tests fail, report to user and ask whether to proceed.

## Step 3: Branch (if needed)

**Non-trivial changes** (new features, refactors, multi-file edits):
```bash
git -C "D:\repos\PianoidInstall\PianoidCore" checkout dev
git -C "D:\repos\PianoidInstall\PianoidCore" pull origin dev
git -C "D:\repos\PianoidInstall\PianoidCore" checkout -b feature/<short-description>
```

**Small fixes** (single-file, low risk): work directly on `dev`.

Ask the user which approach if unclear.

## Step 4: Edit Code

**Before writing new code**, search for existing utilities:
- `PianoidCore/pianoid_middleware/pianoid.py` — initialization, orchestration
- `PianoidCore/pianoid_middleware/chartFunctions.py` — analysis helpers
- `PianoidCore/tests/conftest.py` — test constants, helpers
- `PianoidCore/pianoid_cuda/Pianoid.cuh` — C++ API surface

**Code style rules:**
- Minimum code for the task — no speculative features, no "while I'm here" cleanup
- One function, one responsibility — split at ~50 lines
- Fix root causes, not symptoms — no `#ifdef` hacks, no silent fallbacks
- Reuse existing helpers — grep before writing
- Match existing patterns in the file (naming, indentation, error handling)

**Rebuild after edits:**

Before building, consult `docs/architecture/BUILD_SYSTEM.md` for build pipeline details, venv handling, and troubleshooting.

**Pre-build check (MANDATORY):** Before every build, verify no process holds the `.pyd` or CUDA DLLs. A locked file causes `[WinError 5] Access is denied` and a failed uninstall leaves the package missing.

```bash
# Check for locked pianoidCuda files
locked_pids=$(tasklist //M pianoidCuda.cp312-win_amd64.pyd 2>/dev/null | grep python | awk '{print $2}')
if [ -n "$locked_pids" ]; then
  echo "WARNING: pianoidCuda.pyd is locked by PIDs: $locked_pids"
  echo "Kill these processes before building (they are likely stale backends or test runners)"
  # Show what they are:
  for pid in $locked_pids; do
    wmic process where "ProcessId=$pid" get CommandLine 2>/dev/null | head -2
  done
  # Ask user before killing, or kill only known-safe Pianoid processes
fi
# Also check cudart DLL
tasklist //M cudart64_12.dll 2>/dev/null | grep python && echo "WARNING: cudart64_12.dll locked — kill holder first"
```

**Build commands:** The build script MUST be invoked from `PianoidCore/` using its own `.venv`. Clear `VIRTUAL_ENV` first to prevent the script from installing into the wrong venv (see `docs/architecture/BUILD_SYSTEM.md` — the script uses `%REPO_ROOT%.venv`).

| Changed Files | Build Command |
|--------------|---------------|
| `pianoid_cuda/*.cu`, `*.cpp`, `*.h`, `*.cuh`, `setup.py` | see below (heavy) |
| `pianoid_middleware/*.py` only | see below (light) |
| PianoidBasic `*.py` | `unset VIRTUAL_ENV && cmd //c "D:\repos\PianoidInstall\PianoidCore\build_pianoid_basic.bat"` |
| `tests/**` only | No rebuild needed |

**CUDA build (heavy — full rebuild for C++/CUDA changes):**
```bash
unset VIRTUAL_ENV
cmd //c "D:\repos\PianoidInstall\PianoidCore\build_pianoid_cuda.bat --heavy"
```

**CUDA build (light — incremental for Python-only middleware changes):**
```bash
unset VIRTUAL_ENV
cmd //c "D:\repos\PianoidInstall\PianoidCore\build_pianoid_cuda.bat --light"
```

**Fallback (if bat script fails or for quick iteration):**
```bash
cd D:/repos/PianoidInstall/PianoidCore
.venv/Scripts/python -m pip install --force-reinstall --no-deps pianoid_cuda/
```

**Post-build verification:**
```bash
D:/repos/PianoidInstall/PianoidCore/.venv/Scripts/python -c "import pianoidCuda; print(pianoidCuda.__file__)"
```
Verify the path is inside `PianoidCore/.venv/` (not root `.venv/`).

## Step 5: Post-Change Performance Test

Run the same test suite:
```bash
cd D:\repos\PianoidInstall\PianoidCore
.venv/Scripts/python -m pytest tests/system/test_performance.py -v -s 2>&1 | tee /tmp/postchange_perf.log
```

Compare against baseline and print a table:

| Metric | Baseline | After | Delta |
|--------|----------|-------|-------|
| GPU mean (ms) | — | — | — |
| GPU p99 (ms) | — | — | — |
| Total cycle mean (ms) | — | — | — |
| Underrun count | — | — | — |
| Sound correlation | — | — | — |

**Regression criteria (hard fail → go to step 6):**
- GPU mean increase > 10%
- Sound correlation drop below 0.95
- Any new test failure

**Warning (report but continue):**
- GPU p99 increase > 20%
- Underrun count increase > 50%

## Step 6: Debug (if tests fail)

**Build failures:** If a build command fails (linker errors, missing libraries, DLL issues),
consult `docs/architecture/BUILD_SYSTEM.md` — especially the Troubleshooting section — before
attempting manual fixes. Common issues (SDL3.lib not found, import failures, `--heavy` vs
`--light` trade-offs) are documented there with diagnosis steps and fixes.

Iterative loop (max 5 iterations):
1. Read failure output — identify root cause, not just symptom
2. Make targeted fix
3. Rebuild if needed (step 4 commands)
4. Re-run failing test only: `.venv/Scripts/python -m pytest tests/system/test_performance.py::<TestClass>::<test_name> -v -s`
5. Once that test passes, re-run full suite (step 5)
6. Repeat until all pass

After 5 failed iterations, stop and report findings to the user. Do not keep looping.

## Step 7: Feature-Specific Testing (new features only)

### 7a: UI + Audio Verification (mandatory for audio-affecting changes)

If the change affects synthesis output, volume, excitation, or any parameter that
influences sound — invoke `/test-ui` to verify with measured evidence:

```
/test-ui <description of what to verify>
```

This launches the full stack, applies the change via UI, measures sound via
`note_playback` chart (deterministic offline render), and reports pass/fail with
amplitude numbers. **Do not skip this for audio features.**

Changes that require `/test-ui`:
- Volume formula or sensitivity
- Excitation parameters (sliders, curves)
- Physical string parameters (tension, damping, etc.)
- Hammer shape changes
- Any new UI control that sends data to the synthesis engine

### 7b: Automated Tests

Ask the user for acceptance criteria:
- What inputs to test?
- What behavior is expected?
- Edge cases?

Write tests in the appropriate level:
- Full stack (GPU + audio) → `tests/system/`
- GPU, no audio → `tests/integration/`
- Pure Python → `tests/unit/`

Follow patterns from `test_performance.py` (fixtures, markers, assertions).

## Step 8: Update Documentation and Commit

**Documentation** — for each affected section, update the relevant doc file:

| Changed source | Doc to update |
|---------------|---------------|
| `pianoid_cuda/*.cu/cpp/h` | `docs/modules/pianoid-cuda/*.md` |
| `pianoid_middleware/*.py` | `docs/modules/pianoid-middleware/*.md` |
| `tests/**` | `docs/development/TESTING.md` |
| Architecture/flow changes | `docs/architecture/DATA_FLOWS.md` |
| New WIP items | `docs/development/WORK_IN_PROGRESS.md` |

Keep docs lean and concise. Tables over prose. Every sentence earns its place.
**Structural doc changes (new pages, nav changes) require user approval.**

**Infographics** — whenever code changes affect logic that is depicted in an existing
infographic, update that infographic to reflect the new state. All infographics live in
`docs/images/` (SVGs) or inline in markdown (Mermaid). Check existing SVGs in
`docs/images/` and Mermaid blocks in the affected doc files.

When documentation would benefit from a new diagram (flow, architecture, state machine,
sequence, etc.), prefer **Mermaid** over ASCII art. Mermaid is configured in `mkdocs.yml`
(superfences custom fences) and renders natively in MkDocs Material. Use fenced code
blocks with `mermaid` language tag. For complex, high-visual-impact diagrams (hero
overviews, dense coupling diagrams), use **hand-crafted SVG** in `docs/images/`.

SVG style rules:
- Dark background (`#1a1a2e`), gradient fills matching Material theme (deep purple + amber)
- `filter` with `feDropShadow` for depth, rounded rectangles (`rx="10-14"`)
- Embed as `![Alt text](../images/filename.svg)` in markdown

**Never add new ASCII art diagrams.** Replace existing ASCII diagrams with Mermaid or SVG
when you are already editing that section.

**Commit** — ask user before committing:

```bash
# PianoidCore changes
cd D:\repos\PianoidInstall\PianoidCore
git add <specific-files>
git commit -m "<type>: <description>"
```

Then ask if they want to push and/or merge to dev.

```bash
# Documentation changes
cd D:\repos\PianoidInstall
git add docs/ mkdocs.yml
git commit -m "Update documentation"
git push origin master
```

## Step 9: Merge Feature Branch to Dev

**This step is mandatory when a feature branch was created in Step 3.** Unmerged feature
branches break other systems that install from `dev`.

After the user confirms the work is complete and tests pass:

1. **Merge into dev** for each repo that has a feature branch:
```bash
# Example for PianoidCore
cd D:\repos\PianoidInstall\PianoidCore
git checkout dev
git merge feature/<name> --no-ff -m "Merge feature/<name> into dev"
git push origin dev

# Example for PianoidBasic (if changed)
cd D:\repos\PianoidInstall\PianoidBasic
git checkout dev
git merge feature/<name> --no-ff -m "Merge feature/<name> into dev"
git push origin dev
```

2. **Clean up** — ask user if the feature branch should be deleted:
```bash
git branch -d feature/<name>
git push origin --delete feature/<name>
```

**Do not end the workflow with commits only on a feature branch.** If the user declines
to merge now, warn them explicitly: "Feature branch `feature/<name>` has not been merged
to dev. Other systems installing from dev will not have these changes."

## Step 10: Close Session Log

After all work is complete (committed, merged, or user says done):

1. **Update the log file** — mark status as Complete, add a summary:

```markdown
- **Status:** Complete
- **Completed:** <ISO timestamp>

## Summary
- <one-line outcome>
- <files changed, tests passed/failed>
```

2. **Remove the `## Active Dev Session` block** from `docs/development/WORK_IN_PROGRESS.md`

3. **Delete the log file:**
```bash
rm "$LOG_FILE"
```

If no log files remain in `docs/development/logs/` (other than `.gitkeep`), the directory stays clean for the next session.

**If the session is abandoned** (user cancels mid-way, agent crashes), the log and WIP reference remain as breadcrumbs for the next session to discover and clean up.

## Key Paths

| Resource | Path |
|----------|------|
| PianoidCore | `D:\repos\PianoidInstall\PianoidCore` |
| PianoidBasic | `D:\repos\PianoidInstall\PianoidBasic` |
| PianoidTunner | `D:\repos\PianoidInstall\PianoidTunner` |
| Performance tests | `PianoidCore/tests/system/test_performance.py` |
| Audio driver tests | `PianoidCore/tests/system/test_audio_drivers.py` |
| Documentation | `D:\repos\PianoidInstall\docs/` |
| Session logs | `D:\repos\PianoidInstall\docs\development\logs/` |
| venv Python | `PianoidCore/.venv/Scripts/python` |

## Example Usage

```
/dev Fix buffer underrun race condition in CircularBuffer.cu produce()
/dev Add FIR filter bypass mode for debugging
/dev Refactor preset loading to support hot-reload
```
