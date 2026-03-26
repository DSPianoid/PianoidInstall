---
name: multitask
description: Orchestrate multiple dev tasks — classify, detect conflicts, schedule parallel waves, spawn sub-agents, coordinate testing and merging.
user-invocable: true
argument-hint: <task1> | <task2> | <task3> [...]
---

# Pianoid Multi-Task Orchestrator

Orchestrate a list of development tasks across PianoidCore, PianoidBasic, and PianoidTunner. Analyses dependencies, groups tasks into parallel waves, spawns sub-agents for each, and coordinates testing and merging.

**Input format:** Tasks separated by `|` (pipe). Each task is a description as you would pass to `/dev`.

Example:
```
/multitask Fix buffer underrun in CircularBuffer.cu | Add FIR bypass mode for debugging | Update excitation chart tooltip in React
```

---

## Phase 1: Task Classification

For each task, determine its **layer scope** and **file scope** by reading documentation first (documentation-first rule applies — see CLAUDE.md).

### 1.1 Layer Classification

Read docs in order: `docs/index.md` → `docs/architecture/SYSTEM_OVERVIEW.md` → relevant module docs. For each task, assign one or more layers:

| Layer | Repo | Indicators |
|-------|------|-----------|
| `CUDA` | PianoidCore | `.cu`, `.cpp`, `.cuh`, `.h` files, GPU kernels, pybind11 bindings |
| `MIDDLEWARE` | PianoidCore | `pianoid_middleware/*.py`, Flask routes, parameter routing |
| `DOMAIN` | PianoidBasic | `Pianoid/*.py`, preset model, pitch/string/mode classes |
| `FRONTEND` | PianoidTunner | `*.tsx`, `*.ts`, React components, npm |
| `BUILD` | PianoidCore | `setup.py`, `detect_paths.py`, `build_config.json`, `*.bat` |
| `DOCS` | PianoidInstall | `docs/**/*.md`, `mkdocs.yml` |
| `TESTS` | PianoidCore | `tests/**/*.py`, `conftest.py` |

### 1.2 File Scope Estimation

For each task, list the likely affected files/directories (best guess from docs and task description). This does not need to be exact — it is used for conflict detection.

### 1.3 Present Classification Table

Present to user:

| # | Task | Layers | Repos | Estimated Files | Build Required |
|---|------|--------|-------|-----------------|----------------|
| 1 | ... | CUDA, MIDDLEWARE | PianoidCore | `CircularBuffer.cu`, `pianoid.py` | `--heavy` |
| 2 | ... | MIDDLEWARE | PianoidCore | `chartFunctions.py` | `--light` |
| 3 | ... | FRONTEND | PianoidTunner | `ExcitationPanel.tsx` | `npm run build` |
| 4 | ... | DOCS | PianoidInstall | `docs/modules/...` | none |

---

## Phase 2: Conflict Detection & Wave Planning

### 2.1 Conflict Matrix

Two tasks **conflict** (must run in separate waves) if ANY of these conditions hold:

| Conflict Rule | Condition | Rationale |
|--------------|-----------|-----------|
| **Same CUDA source** | Both touch `.cu`/`.cpp`/`.cuh`/`.h` files | Shared `build_config.json`, nvcc is sequential |
| **CUDA build contention** | Both require `--heavy` or `--light` CUDA build | Build artifacts shared, only one nvcc at a time |
| **Same Python file** | Both edit the same `.py` file | Merge conflicts |
| **API contract** | One adds/modifies REST endpoint, other consumes it in frontend | Frontend depends on backend API shape |
| **Parameter format** | One changes parameter structure (Python or C++), other reads it | Cross-layer data format dependency |
| **Build system** | Either touches `setup.py`, `detect_paths.py`, build scripts | Shared build infrastructure |
| **Same test fixtures** | Both modify test fixtures or `conftest.py` | Merge conflicts in test infrastructure |
| **Domain model + consumers** | One modifies PianoidBasic classes, other uses them in middleware/CUDA | Interface dependency |

Two tasks are **compatible** (can be parallel) if NONE of the above apply. Common compatible pairs:

- FRONTEND-only + CUDA/MIDDLEWARE (no new endpoints) — different repos, no API change
- DOCS-only + any code task — no code interaction
- Pure MIDDLEWARE (file A) + pure MIDDLEWARE (file B) — different files, mergeable
- TESTS-only + FRONTEND-only — different repos

### 2.2 Wave Scheduling Algorithm

1. Build an undirected **conflict graph**: nodes = tasks, edges = conflicts (from 2.1)
2. **Greedy graph coloring** (fewest colors = fewest waves):
   a. Sort tasks by conflict count descending (most-constrained first)
   b. Assign each task the lowest color not used by its neighbors
3. Each color becomes a **wave** — all tasks in a wave run in parallel
4. **Order waves by dependency**: if task A needs the output of task B (e.g., B adds an API endpoint that A's frontend consumes), B's wave must come first
5. Within a wave, tasks in the **same repo** need `isolation: "worktree"` for git isolation; tasks in **different repos** do not

### 2.3 Present Wave Plan

Show to user for approval before any execution:

```
### Execution Plan

| Wave | Tasks | Parallel? | Isolation | Build Step | Test Step |
|------|-------|-----------|-----------|------------|-----------|
| 1 | #1 (CUDA fix), #4 (docs) | Yes | #1: worktree | --heavy | unit + integration |
| 2 | #2 (middleware), #3 (frontend) | Yes | separate repos | --light + npm | unit + system |

Conflict rationale:
- #1 and #2: both touch PianoidCore CUDA build → wave 1 then wave 2
- #3 and #4: no conflicts → parallel within their waves
```

**Ask user to confirm the plan before proceeding.** User may override: force sequential, reorder, drop tasks, or merge waves.

---

## Phase 3: Execution

### 3.1 Pre-Execution Baseline

Before wave 1 starts, capture baseline performance (once):

```bash
cd D:\repos\PianoidInstall\PianoidCore
.venv/Scripts/python -m pytest tests/system/test_performance.py -v -s 2>&1 | tee /tmp/multitask_baseline.log
```

Record baseline metrics. If baseline fails, report to user and ask whether to proceed.

### 3.2 Branch Strategy

| Isolation Mode | When | Branch Naming |
|---------------|------|---------------|
| **Worktree** | Multiple tasks in same repo within one wave | `feature/mt-<wave>-<task#>-<short-name>` |
| **Direct branch** | Single task per repo in a wave | `feature/mt-<task#>-<short-name>` |
| **No branch** | DOCS-only tasks | Work directly on current branch |

### 3.3 Wave Execution Loop

For each wave (waves execute sequentially):

#### 3.3a Spawn Sub-Agents in Parallel

For each task in the wave, spawn a sub-agent using the **Agent tool**:

- **Same-repo parallel tasks** → use `isolation: "worktree"` in the Agent call. The sub-agent invokes `/dev <task-description>` inside the isolated worktree.
- **Different-repo tasks** → spawn Agent normally (no worktree needed, repos are separate). The sub-agent invokes `/dev <task-description>` directly.
- **DOCS-only tasks** → invoke `/update-docs <scope>` instead of `/dev`.

**All sub-agents for a wave are spawned in a SINGLE message** (parallel Agent tool calls). Use `run_in_background: true` if there are other tasks to coordinate.

**CRITICAL safety constraints during parallel execution:**
- Only ONE task may run `build_pianoid_cuda.bat` at a time — if this constraint is somehow violated (shouldn't happen per conflict rules), serialize their build steps
- Only ONE Pianoid instance may be active for testing (GPU memory exclusive)
- Frontend (`npm`) builds are independent and can overlap with backend builds

#### 3.3b Track Progress

Maintain a status tracker:

| Task # | Description | Status | Current Step | Notes |
|--------|-------------|--------|-------------|-------|
| 1 | ... | Running | Step 4 (Edit) | ... |
| 3 | ... | Running | Step 5 (Test) | ... |
| 4 | ... | Complete | Done | 2 files updated |

Update the user when milestones are reached (task completion, failures).

#### 3.3c Handle Failures

| Failure Type | Action |
|-------------|--------|
| Build failure | Let `/dev` Step 6 handle (5 debug iterations). If still failing, mark FAILED. |
| Test regression | Mark FAILED. Report regression metrics. Ask user: retry, skip, or abort wave. |
| Merge conflict (worktree) | Pause that task. Complete other tasks. Present conflict to user. |
| Sub-agent crash | Mark FAILED. Log last known state. Continue other tasks. |

**Wave completion rule:** A wave is complete when ALL its tasks reach a terminal state (PASSED, FAILED, SKIPPED). Do NOT start the next wave until the current wave is complete.

### 3.4 Post-Wave Testing

After all tasks in a wave complete, run tests appropriate to the wave's scope:

| Wave Content | Test Suite | Command |
|-------------|-----------|---------|
| Any CUDA changes | Integration tests | `.venv/Scripts/python -m pytest tests/integration/ -v` |
| Any Python changes | Unit tests | `.venv/Scripts/python -m pytest tests/unit/ -v` |
| Frontend changes | npm test | `cd PianoidTunner && npm test` |
| Mixed backend | Integration + unit | Both commands above |

**System tests are deferred to Phase 4** — they require exclusive audio hardware access, and running them per-wave would serialize everything.

### 3.5 Post-Wave Merge

After wave tests pass, merge each task's branch back:

**For worktree tasks:**
1. From the main working directory, merge the worktree branch:
   ```bash
   cd <repo-path>
   git merge feature/mt-<wave>-<task#>-<name> --no-ff -m "Merge multitask #<N>: <short description>"
   ```
2. Clean up worktree after successful merge

**For direct-branch tasks:**
1. Merge the feature branch back to the working branch:
   ```bash
   cd <repo-path>
   git merge feature/mt-<task#>-<name> --no-ff -m "Merge multitask #<N>: <short description>"
   ```

**Merge conflict resolution:**
- If conflicts occur between tasks in the same wave, present both sides to the user
- Show file paths, line numbers, and both versions
- Apply user's resolution, then re-run wave tests

### 3.6 Next Wave

After merge + tests pass, proceed to next wave. Next wave's sub-agents will see the merged results of all previous waves.

---

## Phase 4: Final Validation

After ALL waves complete:

### 4.1 Full Test Suite

```bash
cd D:\repos\PianoidInstall\PianoidCore

# Unit tests
.venv/Scripts/python -m pytest tests/unit/ -v

# Integration tests (GPU, no audio)
.venv/Scripts/python -m pytest tests/integration/ -v

# System tests (GPU + audio — exclusive access)
.venv/Scripts/python -m pytest tests/system/ -v -s 2>&1 | tee /tmp/multitask_final.log
```

### 4.2 Performance Comparison

Compare final metrics against Phase 3.1 baseline:

| Metric | Baseline | Final | Delta | Status |
|--------|----------|-------|-------|--------|
| GPU mean (ms) | — | — | — | OK/WARN/FAIL |
| GPU p99 (ms) | — | — | — | OK/WARN/FAIL |
| Total cycle mean (ms) | — | — | — | OK/WARN/FAIL |
| Underrun count | — | — | — | OK/WARN/FAIL |
| Sound correlation | — | — | — | OK/WARN/FAIL |

Regression criteria (same as `/dev` Step 5):
- **Hard fail:** GPU mean increase > 10%, sound correlation < 0.95, any new test failure
- **Warning:** GPU p99 increase > 20%, underrun count increase > 50%

### 4.3 Documentation Sweep

For each completed task, verify `/dev` sub-agents updated docs in their Step 8. If gaps remain, invoke `/update-docs` to fill them.

---

## Phase 5: Final Report

Present summary:

```
### Multi-Task Execution Report

| # | Task | Wave | Status | Branch | Build | Tests | Time |
|---|------|------|--------|--------|-------|-------|------|
| 1 | Fix buffer underrun | 1 | PASSED | merged | --heavy | 12/12 | 8m |
| 2 | Add FIR bypass mode | 2 | PASSED | merged | --light | 12/12 | 3m |
| 3 | Update tooltip | 1 | PASSED | merged | npm | 5/5 | 2m |
| 4 | Update CUDA docs | 1 | PASSED | direct | none | n/a | 1m |

### Performance Summary
| Metric | Baseline | Final | Delta |
|--------|----------|-------|-------|
| ... | ... | ... | ... |

Total: Xm (estimated sequential: Ym, speedup: Z.Zx)
```

### 5.1 Cleanup

Ask user before each action:

1. **Delete merged feature branches:**
   ```bash
   git -C <repo> branch -d feature/mt-<N>-<name>
   ```

2. **Push to origin** (per repo, ask individually):
   ```bash
   git -C "D:\repos\PianoidInstall\PianoidCore" push origin <branch>
   git -C "D:\repos\PianoidInstall\PianoidBasic" push origin <branch>
   git -C "D:\repos\PianoidInstall\PianoidTunner" push origin <branch>
   git -C "D:\repos\PianoidInstall" push origin <branch>
   ```

3. **Remove any remaining worktree directories**

---

## Key Paths

| Resource | Path |
|----------|------|
| PianoidCore | `D:\repos\PianoidInstall\PianoidCore` |
| PianoidBasic | `D:\repos\PianoidInstall\PianoidBasic` |
| PianoidTunner | `D:\repos\PianoidInstall\PianoidTunner` |
| Documentation | `D:\repos\PianoidInstall\docs/` |
| Performance tests | `PianoidCore/tests/system/test_performance.py` |
| venv Python | `PianoidCore/.venv/Scripts/python` |
| Build script | `PianoidCore/build_pianoid_cuda.bat` |
