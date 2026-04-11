---
name: dev
description: Development workflow — study context, baseline test, branch, edit, verify, debug, document, commit.
user-invocable: true
argument-hint: <task description — bug fix, feature, or refactor>
---

# Pianoid Development Workflow

Disciplined development cycle for PianoidCore, PianoidBasic, and PianoidTunner. Follow every step in order. Do not skip steps.

**Code principles:** Lean (minimum code for the task), modular (one function one job), no workarounds (fix root causes), no redundancy (reuse existing utilities), match existing style.

## Step 0: Initialize Session

### Generate Agent ID

Every dev agent session has a unique identifier used in logs, WIP references, commits, and lock records.

```bash
AGENT_ID="dev-$(openssl rand -hex 2)"   # e.g. dev-a3f1
```

**Agent ID persistence rule:** When an agent is **restarted after a lock conflict** or **recovered after abnormal termination**, the new session MUST reuse the original agent's ID. This keeps log references, WIP entries, commit prefixes, and lock records consistent. Only generate a fresh ID for genuinely new tasks.

### Create Session Log

```bash
LOG_FILE="D:/repos/PianoidInstall/docs/development/logs/${AGENT_ID}-$(date +%Y-%m-%d-%H%M%S).md"
```

Write the log header:

```markdown
# Dev Session Log

- **Agent:** <AGENT_ID>
- **Task:** <user's task description>
- **Started:** <ISO timestamp>
- **Plan file:** <path to plan file if following one, or "None">
- **Status:** In Progress

## Actions

```

### Register in WIP

Add a reference to `docs/development/WORK_IN_PROGRESS.md` under `## Active Dev Sessions` at the top of the file. If the heading doesn't exist, create it. Multiple agents may have entries here simultaneously.

```markdown
## Active Dev Sessions

| Agent | Task | Log | Started |
|-------|------|-----|---------|
| dev-a3f1 | <brief task description> | [log](logs/dev-a3f1-2026-04-10-143022.md) | 2026-04-10 |

---
```

Append rows for new agents; do not replace existing entries from other agents.

### Check for Paused or Stale Sessions

Before starting new work, check for existing sessions:

1. Read `docs/development/WORK_IN_PROGRESS.md` — look for `## Active Dev Sessions` entries
2. List files in `docs/development/logs/` (excluding archive)

If a **Paused** session exists for the same task (or the user asks to resume one):
- **Do not proceed with normal Step 1.** Go to **Step 0b: Resume Paused Session** instead.

If **stale** sessions exist (no "Paused" marker, but log files remain from crashed/abandoned agents):
- Report them to the user. They may need cleanup (reset procedure).

### Logging Rule

After completing each step below, append a timestamped entry to the log file:

```markdown
### Step N: <Step Name> — <HH:MM>
- <what was done: files read, commands run, decisions made>
- <outcomes, metrics, errors encountered>
```

Keep entries concise — bullet points, not prose. The log is a breadcrumb trail, not a narrative.

## Step 0b: Resume Paused Session

Use this instead of Steps 1–4 when picking up a paused session. The goal is to restore full context before touching any code — documentation first, then the pause snapshot, then the code state.

### 1. Read documentation (same as Step 1)

Follow the documentation-first rule. Read in order:
1. `docs/index.md` — module map
2. `docs/architecture/SYSTEM_OVERVIEW.md` — stack overview
3. `docs/architecture/DATA_FLOWS.md` — relevant data flow
4. Drill into the specific module doc under `docs/modules/`
5. `docs/development/WORK_IN_PROGRESS.md` — find the paused session entry

This ensures the resuming agent understands the architecture before reading the snapshot. **Do not skip this even if the snapshot seems self-contained.**

### 2. Read the paused session log

The paused entry in `## Active Dev Sessions` links to the log file in `docs/development/logs/`. Read the entire log:
- **Task** and **Plan file** — what the previous agent was working on and what plan it followed
- **Actions** — what steps were completed, what was learned
- **Pause Snapshot** — the critical handoff section containing:
  - Branch name
  - Commit hash or stash reference
  - Modified files list
  - What's done vs. what's pending
  - Recommended next steps
  - Gotchas and non-obvious findings

### 3. Restore code state

Based on the snapshot's commit/stash info:

```bash
# If paused via commit on a feature branch:
cd D:\repos\PianoidInstall\PianoidCore
git checkout <branch-name>
git log --oneline -5   # verify you're on the right branch with the WIP commit

# If paused via stash:
cd D:\repos\PianoidInstall\PianoidCore
git stash list          # find the stash by AGENT_ID in the message
git stash pop <stash-ref>
```

### 4. Verify restored state

- Confirm the files listed in the snapshot are present and modified
- Run a quick sanity check (import test or build) to ensure the codebase is functional
- Read the source files listed as modified to re-establish code-level context

### 5. Re-acquire module locks

Check `docs/development/MODULE_LOCKS.md` — the previous agent released its locks on pause. Re-acquire locks for the same files (or an updated list if scope changed):
- If any file is now locked by a different agent, **stop and report the conflict**
- Register new locks under the new agent ID

### 6. Update session tracking

- Update the `## Active Dev Sessions` table: replace the old paused entry with a new active entry (new agent ID, link to new log)
- The old log file stays in `docs/development/logs/` as history — append a note:
  ```markdown
  ## Resumed by <NEW_AGENT_ID> — <ISO timestamp>
  ```
- Create the new agent's own log file (per Step 0) and reference the old log:
  ```markdown
  - **Resuming:** [<OLD_AGENT_ID> log](logs/<old-log-filename>.md)
  ```

### 7. Continue from where the previous agent left off

Based on the snapshot's "What's pending" and "Next steps", jump to the appropriate step (typically Step 4, 5, or 6). **Do not re-run completed steps** unless the snapshot indicates uncertainty about their results.

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

### Check Module Locks and Repo Cleanliness

**Invariant: Every module file is either committed+clean OR locked by an editing agent.** Violations of this invariant are urgent.

For every file you plan to modify, perform two checks:

#### Check 1: Lock conflicts

Read `docs/development/MODULE_LOCKS.md`. If any target file is locked by another agent:
- **This is a normal execution conflict.** Report it clearly:
  - Which file(s) are locked
  - Which agent holds the lock and what task it's performing
  - Recommend: pause this session (Step 10c) and resume after the lock is released
- **Do not proceed.** The orchestrator will monitor the lock and restart this agent when it's released.

#### Check 2: Uncommitted changes in target files

Run `git status` in each repo containing target files. If any target file has uncommitted changes but is NOT locked by any agent:
- **This is a repo inconsistency — URGENT.** Something left dirty state without a lock.
- Report immediately:
  - Which file(s) are dirty and in which repo
  - What the changes appear to be (`git diff <file>` summary)
  - Likely cause: a crashed/terminated agent that didn't clean up
- **Do not proceed until resolved.** The user or orchestrator must investigate — either the changes should be committed (if valid) or reverted (if orphaned).

#### Summary

After both checks, summarize to the user:
- Which files are affected
- Which data flow / component is involved
- Lock conflicts (if any) — normal, recommend pause
- Repo inconsistencies (if any) — urgent, must investigate
- Proposed approach (if no conflicts)

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

## Step 4: Acquire Module Locks and Edit Code

### Acquire Locks

Before editing any file, **register locks** in `docs/development/MODULE_LOCKS.md`. The lock file uses this format:

```markdown
# Module Locks

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-a3f1 | `PianoidCore/pianoid_middleware/pianoid.py`, `PianoidCore/pianoid_middleware/backendServer.py` | 2026-04-10T14:30:22Z | Fix preset switch silence |
```

Rules:
- List every file you intend to modify (source files, not docs)
- If a file is already locked by another agent, **stop and report the conflict**
- Locks persist until explicitly released (wrap-up, reset, or pause)
- The lock file itself is not locked — multiple agents may add/remove their own rows

### Edit Code

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

## Step 4b: Delegate to `/fn` Sub-Agents (preferred)

When a task can be decomposed into functions with clear requirements and testable acceptance criteria, **prefer delegating to `/fn` sub-agents** over editing code inline. This applies whether there's one function or many — the value is in enforced requirements clarity and test-driven implementation, not just parallelism.

### When to delegate

- The function has clear inputs, outputs, and behavior that can be specified upfront
- Acceptance criteria can be expressed as a test (unit, integration, or system)
- The function can be implemented and verified independently

### When NOT to delegate

- The change is a cross-cutting refactor (rename across many call sites, structural reorganization)
- The function's behavior can only be verified through the full system (no isolated test possible)
- The change is so trivial that writing the spec would take longer than the edit

### Prepare tests FIRST (dev agent responsibility)

Before spawning a sub-agent, the dev agent must ensure a test exists for the function. This is the dev agent's job, not the sub-agent's.

**If a suitable test already exists:** reference it in the sub-agent's `test_command`.

**If testing is non-trivial:** the dev agent writes the test script first, placing it in the correct location within the project test hierarchy:

| Test type | Location | When to use |
|-----------|----------|-------------|
| Pure logic, no GPU | `PianoidCore/tests/unit/` | Utility functions, data transforms, formatters |
| GPU required, no audio | `PianoidCore/tests/integration/` | Buffer operations, CUDA kernel wrappers |
| Full stack | `PianoidCore/tests/system/` | Audio pipeline, preset loading, API endpoints |

The test file **persists in the project** — it is not disposable scaffolding. Follow patterns from existing tests (`conftest.py` fixtures, markers, assertions). The test should:
- Import the function (or call the API that exercises it)
- Cover the requirements specified for the sub-agent
- Include edge cases identified during Step 1 context analysis
- Be runnable via a single pytest invocation

**Write the test, commit-stage it, then reference it in the sub-agent spawn.** This way the test survives regardless of the sub-agent's outcome.

### Spawning procedure

1. **Decompose** — for each function, define:
   - `target_file`: absolute path to the file to edit
   - `function_spec`: what to implement (name, signature, behavior, edge cases)
   - `requirements`: acceptance criteria matching the test assertions
   - `test_command`: exact pytest command referencing the test written above
   - `context_files`: docs and source files the sub-agent needs to read

2. **Verify locks** — all target files must be in this agent's lock list (acquired in Step 4). The sub-agent inherits locks from the parent; it does NOT acquire its own.

3. **Spawn** — use the `Agent` tool. Independent sub-agents can be spawned in parallel (single message, multiple Agent calls). Use `run_in_background: true` for parallel spawns.

   ```
   Agent({
     description: "Implement <function_name>",
     prompt: "Execute the /fn skill with these parameters:\n\n\
       - target_file: <absolute path>\n\
       - function_spec: <what to implement — be specific about signature, behavior, edge cases>\n\
       - requirements: <acceptance criteria — must match the test assertions>\n\
       - test_command: <exact pytest command>\n\
       - context_files: <comma-separated paths>\n\
       - parent_agent: <this agent's AGENT_ID>\n\
       - held_locks: <comma-separated locked files>\n\n\
       <any additional context: architectural constraints, performance requirements, \
       related functions to be aware of>",
     run_in_background: true
   })
   ```

   **CRITICAL:** The sub-agent invokes `/fn` via the `Skill` tool inside its own context. Do NOT use `Skill("fn")` from the parent — that would expand the skill into the parent's context.

4. **Collect results** — when sub-agents complete, read their log files:
   ```bash
   ls D:/repos/PianoidInstall/docs/development/logs/fn-*.md
   ```

5. **Incorporate logs** — for each sub-agent, append a summary to THIS agent's log:
   ```markdown
   ### Step 4b: Sub-Agent <fn-XXXX> — <HH:MM>
   - **Task:** <function_spec summary>
   - **Result:** Success | Failed
   - **Log:** [fn-XXXX](logs/fn-XXXX-timestamp.md)
   - **Changes:** <one-line summary>
   - **Test:** <test file path> — <pass/fail>
   ```

6. **Handle failures** — if a sub-agent fails:
   - Read its log to understand the failure
   - Either fix it directly (inline, as normal Step 4 edit) or spawn a new sub-agent with adjusted instructions
   - Do NOT proceed to Step 5 with failing sub-agents

7. **Clean up sub-agent logs** — after incorporating into the parent log, move fn logs to archive:
   ```bash
   mv D:/repos/PianoidInstall/docs/development/logs/fn-*.md D:/repos/PianoidInstall/docs/development/logs/archive/
   ```

### Example: Dev agent prepares test, then spawns sub-agent

Task: "Add velocity clamping to the MIDI input handler"

**Step 1: Dev agent writes the test first:**
```python
# PianoidCore/tests/unit/test_velocity_clamp.py
import pytest
from pianoid_middleware.midi_utils import clamp_velocity

class TestClampVelocity:
    def test_within_range(self):
        assert clamp_velocity(64, 1, 127) == 64

    def test_below_min(self):
        assert clamp_velocity(0, 1, 127) == 1

    def test_above_max(self):
        assert clamp_velocity(200, 1, 127) == 127

    def test_at_boundaries(self):
        assert clamp_velocity(1, 1, 127) == 1
        assert clamp_velocity(127, 1, 127) == 127
```

**Step 2: Dev agent spawns the sub-agent:**
```
Agent({
  description: "Implement clamp_velocity",
  prompt: "Execute the /fn skill:\n\
    - target_file: D:/.../pianoid_middleware/midi_utils.py\n\
    - function_spec: clamp_velocity(v: int, min_v: int, max_v: int) -> int\n\
    - requirements: Clamp v to [min_v, max_v]. Return min_v if v < min_v, max_v if v > max_v, v otherwise.\n\
    - test_command: .venv/Scripts/python -m pytest tests/unit/test_velocity_clamp.py -v\n\
    - context_files: docs/modules/pianoid-middleware/OVERVIEW.md\n\
    - parent_agent: dev-a3f1\n\
    - held_locks: midi_utils.py"
})
```

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

## Step 8: Update Documentation

**This step is mandatory for ALL exit procedures (wrap-up, reset, pause).** Documentation must always reflect the current state of the codebase.

For each affected section, update the relevant doc file:

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

## Step 10: Exit Procedures

Every dev session ends with one of three procedures. **All three require Step 8 (Update Documentation) to be completed first.**

### Commit Convention

All commits made by a dev agent MUST include the agent ID:

```bash
git commit -m "[dev-a3f1] <type>: <description>"
```

### 10a: Wrap-up (successful implementation)

Sequence: **Document → Commit → Release locks → Archive log → Clean WIP**

1. **Verify Step 8 is done** — documentation is up to date
2. **Commit** — ask user before committing:
   ```bash
   # PianoidCore changes
   cd D:\repos\PianoidInstall\PianoidCore
   git add <specific-files>
   git commit -m "[${AGENT_ID}] <type>: <description>"
   ```
   ```bash
   # Documentation changes
   cd D:\repos\PianoidInstall
   git add docs/ mkdocs.yml
   git commit -m "[${AGENT_ID}] docs: <description>"
   ```
3. **Release locks** — remove this agent's rows from `docs/development/MODULE_LOCKS.md`
4. **Archive log** — move log file to archive:
   ```bash
   mkdir -p D:/repos/PianoidInstall/docs/development/logs/archive
   mv "$LOG_FILE" D:/repos/PianoidInstall/docs/development/logs/archive/
   ```
5. **Clean WIP** — remove this agent's row from the `## Active Dev Sessions` table in `WORK_IN_PROGRESS.md`
6. **Merge** — proceed to Step 9 if a feature branch was created

### 10b: Reset (failed implementation)

Sequence: **Document → Revert → Release locks → Delete log → Clean WIP**

1. **Verify Step 8 is done** — document what was attempted and why it failed (in WIP or relevant doc)
2. **Revert uncommitted changes:**
   ```bash
   # Revert only files this agent modified (check the lock registry for the list)
   cd D:\repos\PianoidInstall\PianoidCore
   git checkout -- <file1> <file2> ...
   ```
   If changes were already committed, ask the user whether to revert the commit(s).
3. **Release locks** — remove this agent's rows from `docs/development/MODULE_LOCKS.md`
4. **Delete log:**
   ```bash
   rm "$LOG_FILE"
   ```
5. **Clean WIP** — remove this agent's row from the `## Active Dev Sessions` table

### 10c: Pause (freeze for handoff)

Sequence: **Document → Commit/stash → Snapshot → Release locks → Update WIP**

Use this when work is incomplete but needs to be handed off to another session.

1. **Verify Step 8 is done** — document current state in relevant docs
2. **Commit or stash all current changes:**
   ```bash
   # Prefer commit on a feature branch:
   cd D:\repos\PianoidInstall\PianoidCore
   git add <modified-files>
   git commit -m "[${AGENT_ID}] wip: <what's done so far>"
   
   # Or stash if on dev and changes aren't ready:
   git stash push -m "${AGENT_ID}: <task description>"
   ```
3. **Append snapshot to log** — a complete handoff context:
   ```markdown
   ## Pause Snapshot — <ISO timestamp>
   
   - **Branch:** <branch name>
   - **Commit/stash:** <commit hash or stash ref>
   - **Modified files:** <list>
   - **What's done:** <bullet points>
   - **What's pending:** <bullet points>
   - **Next steps:** <what the next agent should do first>
   - **Gotchas:** <anything non-obvious discovered during this session>
   ```
4. **Release locks** — remove this agent's rows from `docs/development/MODULE_LOCKS.md`
5. **Update WIP** — change this agent's row status to "Paused":
   ```markdown
   | ~~dev-a3f1~~ | <task> | [log](logs/dev-a3f1-...) | 2026-04-10 | **Paused** |
   ```
   The log file stays in `docs/development/logs/` (not archived) so the next session can read it to resume.

### 10d: Recover (orphaned session)

Use this when a dev agent terminated abnormally — no wrap-up (10a), reset (10b), or pause (10c) was performed. Indicators: log file exists in `logs/` (not archived), agent listed in Active Dev Sessions, locks still held, but no running agent.

**The recovering agent MUST reuse the original agent's ID.** Do not generate a new ID. This keeps all references (logs, WIP, locks, commits) consistent.

#### Recovery procedure

1. **Read the orphaned agent's log file** — understand what was attempted:
   - What task was it working on?
   - Which steps were completed?
   - What files were being modified?

2. **Check actual state against the log:**
   ```bash
   # What uncommitted changes exist in each repo?
   cd D:/repos/PianoidInstall/PianoidCore && git status --short
   cd D:/repos/PianoidInstall/PianoidTunner && git status --short
   cd D:/repos/PianoidInstall/PianoidBasic && git status --short
   cd D:/repos/PianoidInstall && git status --short
   
   # What do the changes look like?
   cd D:/repos/PianoidInstall/PianoidCore && git diff --stat
   ```

3. **Classify recoverability:**

   | Condition | Classification | Action |
   |-----------|---------------|--------|
   | Log documents all changes AND uncommitted changes match log | **RECOVERABLE** | Report status, ask user: continue or reset |
   | Uncommitted changes exist that aren't documented in log | **PARTIALLY RECOVERABLE** | Report discrepancies, ask user to decide |
   | No log, or log is empty/minimal, and changes exist | **NOT RECOVERABLE** | Auto-reset, report what was reverted |
   | No uncommitted changes, only stale WIP/locks | **ALREADY CLEAN** | Just clean up metadata (locks, WIP, log) |

4. **Report to user/orchestrator:**
   - Original agent ID and task
   - Last completed step (from log)
   - Uncommitted changes found (file list + summary)
   - Recovery classification
   - Recommended action

5. **Execute based on user decision:**

   **Continue (recoverable):**
   - Append to existing log:
     ```markdown
     ## Recovery — <ISO timestamp>
     - **Recovered by:** same agent ID, new session
     - **State at recovery:** <summary of uncommitted changes>
     - **Continuing from:** Step <N>
     ```
   - Re-acquire locks (same files from original session)
   - Resume from the last completed step

   **Reset (any classification):**
   - Execute Step 10b (reset procedure) using the original agent ID
   - Revert uncommitted changes, release locks, clean WIP, delete log

### 10e: Restart After Lock Conflict

Use this when an agent was paused (10c) due to a lock conflict and the blocking lock has been released. The restarted agent must account for changes made by the agent that held the lock.

**The restarting agent MUST reuse the original agent's ID.**

#### Restart procedure

1. **Follow Step 0b (Resume Paused Session)** — read docs, read pause snapshot, restore code state

2. **Check what the blocking agent changed:**
   - Read the blocking agent's log (if archived, check `logs/archive/`)
   - Run `git log --oneline -10` in affected repos to see recent commits
   - Run `git diff <pause-commit>..HEAD` to see all changes since this agent was paused

3. **Assess impact on this agent's task:**
   - Do the blocking agent's changes conflict with this agent's planned work?
   - Did the blocking agent modify any of this agent's target files?
   - Does this agent's approach need adjustment?

4. **Append to log:**
   ```markdown
   ## Restart After Lock Conflict — <ISO timestamp>
   - **Paused at:** <original pause timestamp>
   - **Blocking agent:** <agent-id that held the lock>
   - **Changes by blocking agent:** <summary of what changed>
   - **Impact on this task:** <none / requires adjustment / conflicts>
   - **Adjusted approach:** <if needed>
   ```

5. **Continue from where the pause snapshot left off**, incorporating awareness of the blocking agent's changes

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
| Log archive | `D:\repos\PianoidInstall\docs\development\logs\archive/` |
| Module locks | `D:\repos\PianoidInstall\docs\development\MODULE_LOCKS.md` |
| venv Python | `PianoidCore/.venv/Scripts/python` |

## Example Usage

```
/dev Fix buffer underrun race condition in CircularBuffer.cu produce()
/dev Add FIR filter bypass mode for debugging
/dev Refactor preset loading to support hot-reload
```
