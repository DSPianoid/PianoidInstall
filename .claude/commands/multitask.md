---
name: multitask
description: Orchestrate multiple dev tasks — classify, detect conflicts, schedule parallel waves, spawn sub-agents, coordinate testing and merging.
user-invocable: true
tier: generic
argument-hint: <task1> | <task2> | <task3> [...]
---

# Multi-Task Orchestrator

> **Project-agnostic skill** (`tier: generic`). Operates on an **active project**: resolve `$PROJECT_ROOT`
> and the project's `docs/PROJECT_CONFIG.md` per the machine-global `~/.claude/CLAUDE.md` "Config resolution" section (#config-resolution)
> — including the **graceful fallback** when no `PROJECT_CONFIG.md` is found. All project facts (build,
> ports, venv, repos, endpoints, verification surfaces) come from that config by anchor; this skill
> resolves them there rather than hard-coding them.

**Worked examples (project-tier):** concrete invocations for the active project — the canonical rebuild + reject-traps, the port-scoped env sweep, the baseline/per-wave/final test commands, the worktree merge + per-repo push, and the layer→repo→build map — live in [`.claude/skill-examples/multitask.md`](../skill-examples/multitask.md) ([`#skill-examples`](../../docs/PROJECT_CONFIG.md#skill-examples)).

Orchestrate a list of development tasks across the active project's repos (resolve the repo set from [`PROJECT_CONFIG.md#repos`](../../docs/PROJECT_CONFIG.md#repos)). Analyses dependencies, groups tasks into parallel waves, spawns sub-agents for each, and coordinates testing and merging.

**Input format:** Tasks separated by `|` (pipe). Each task is a description as you would pass to `/dev`.

Example:
```
/multitask Fix buffer underrun in CircularBuffer.cu | Add FIR bypass mode for debugging | Update excitation chart tooltip in React
```

---

## Docs-first (MANDATORY) for every rebuild in every wave

Each rebuilding sub-agent follows the canonical build procedure; the orchestrator reinforces it in every sub-agent prompt (a single stale native build contaminates the whole post-wave test suite).

- **Every rebuilding sub-agent follows the single canonical docs-first build/run discipline at the active project's [`PROJECT_CONFIG.md` → Docs-first for build + run](../../docs/PROJECT_CONFIG.md#docs-first-build--run).**
- **Canonical rebuild** — each sub-agent uses the project's canonical build command via the agent-context detached form (stop the build holder first). **Reject** any sub-agent that uses the project's known venv-bricking / stale-binary anti-patterns (resolve the canonical command + the traps from [`PROJECT_CONFIG.md#docs-first-build--run`](../../docs/PROJECT_CONFIG.md#docs-first-build--run) and [`#build-holders`](../../docs/PROJECT_CONFIG.md#build-holders); the concrete command + the exact reject-patterns are in the [worked-examples companion](../skill-examples/multitask.md)). **Verify each rebuild landed** before that wave's tests; if missing, mark the wave's tests INVALID and re-run.
- **On unexpected build/startup failure in a wave** — halt the wave, spawn the project's startup/build-recovery skill, resume after green. Do NOT patch the build from the orchestrator.

---

## Phase 1: Task Classification

For each task, determine its **layer scope** and **file scope** by reading documentation first (documentation-first rule applies — see CLAUDE.md).

### 1.1 Layer Classification

Read docs in order: `docs/index.md` → the system-overview architecture doc → relevant module docs (resolve the doc tree from [`PROJECT_CONFIG.md#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy)). For each task, assign one or more layers. The layer → repo → build mapping is a project fact — resolve it from the active project's [`PROJECT_CONFIG.md` → Repos](../../docs/PROJECT_CONFIG.md#repos) and [→ Rebuild matrix](../../docs/PROJECT_CONFIG.md#rebuild-matrix). The active project's concrete layer→repo→indicator map is in the [worked-examples companion](../skill-examples/multitask.md). Generic layer shape:

| Layer | Repo | Indicators |
|-------|------|-----------|
| Compiled engine | *(per [`#repos`](../../docs/PROJECT_CONFIG.md#repos))* | compiled-source files (`.cu`/`.cpp`/`.cuh`/`.h`), kernels, bindings |
| Middleware/server | *(per [`#repos`](../../docs/PROJECT_CONFIG.md#repos))* | server module `*.py`, routes, parameter routing |
| Domain model | *(per [`#repos`](../../docs/PROJECT_CONFIG.md#repos))* | domain `*.py`, preset model, core classes |
| Frontend | *(per [`#repos`](../../docs/PROJECT_CONFIG.md#repos))* | `*.tsx`, `*.ts`, components, npm |
| Build | *(per [`#repos`](../../docs/PROJECT_CONFIG.md#repos))* | `setup.py`, build config, build scripts |
| Docs | *(per [`#repos`](../../docs/PROJECT_CONFIG.md#repos))* | `docs/**/*.md`, `mkdocs.yml` |
| Tests | *(per [`#repos`](../../docs/PROJECT_CONFIG.md#repos))* | `tests/**/*.py`, `conftest.py` |

### 1.2 File Scope Estimation

For each task, list the likely affected files/directories (best guess from docs and task description). This does not need to be exact — it is used for conflict detection.

### 1.3 Present Classification Table

Present to user:

| # | Task | Layers | Repos | Estimated Files | Build Required |
|---|------|--------|-------|-----------------|----------------|
| 1 | ... | engine, middleware | *(per repo)* | ... | heavy |
| 2 | ... | middleware | *(per repo)* | ... | light |
| 3 | ... | frontend | *(per repo)* | ... | `npm run build` |
| 4 | ... | docs | *(per repo)* | ... | none |

---

## Phase 2: Conflict Detection & Wave Planning

### 2.1 Conflict Matrix

Two tasks **conflict** (must run in separate waves) if ANY of these conditions hold:

| Conflict Rule | Condition | Rationale |
|--------------|-----------|-----------|
| **Same compiled source** | Both touch compiled-source files (`.cu`/`.cpp`/`.cuh`/`.h`) | Shared build config, the native compiler is sequential |
| **Compiled build contention** | Both require a heavy or light native build | Build artifacts shared, only one compiler at a time |
| **Same source file** | Both edit the same `.py`/`.js` file | Merge conflicts |
| **API contract** | One adds/modifies a REST endpoint, other consumes it in frontend | Frontend depends on backend API shape |
| **Parameter format** | One changes parameter structure (one layer), other reads it | Cross-layer data format dependency |
| **Build system** | Either touches `setup.py`, build config, build scripts | Shared build infrastructure |
| **Same test fixtures** | Both modify test fixtures or `conftest.py` | Merge conflicts in test infrastructure |
| **Domain model + consumers** | One modifies domain-model classes, other uses them in middleware/engine | Interface dependency |

Two tasks are **compatible** (can be parallel) if NONE of the above apply. Common compatible pairs:

- Frontend-only + engine/middleware (no new endpoints) — different repos, no API change
- Docs-only + any code task — no code interaction
- Pure middleware (file A) + pure middleware (file B) — different files, mergeable
- Tests-only + frontend-only — different repos

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
| 1 | #1 (engine fix), #4 (docs) | Yes | #1: worktree | heavy | unit + integration |
| 2 | #2 (middleware), #3 (frontend) | Yes | separate repos | light + npm | unit + system |

Conflict rationale:
- #1 and #2: both touch the same repo's native build → wave 1 then wave 2
- #3 and #4: no conflicts → parallel within their waves
```

**Ask user to confirm the plan before proceeding.** User may override: force sequential, reorder, drop tasks, or merge waves.

---

## Phase 3: Execution

### 3.1 Pre-Execution Baseline

Before wave 1 starts, capture baseline performance (once). Resolve the venv interpreter from [`PROJECT_CONFIG.md#interpreters`](../../docs/PROJECT_CONFIG.md#interpreters) and the performance-test path from [`#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths); the example uses placeholders (the concrete project command is in the [worked-examples companion](../skill-examples/multitask.md)):

```bash
# <venv-python> = PROJECT_CONFIG.md#interpreters · <perf-test> = PROJECT_CONFIG.md#key-paths
cd <engine-repo>
<venv-python> -m pytest <perf-test> -v -s 2>&1 | tee /tmp/multitask_baseline.log
```

Record baseline metrics. If baseline fails, report to user and ask whether to proceed.

### 3.2 Branch Strategy

| Isolation Mode | When | Branch Naming |
|---------------|------|---------------|
| **Worktree** | Multiple tasks in same repo within one wave | `feature/mt-<wave>-<task#>-<short-name>` |
| **Direct branch** | Single task per repo in a wave | `feature/mt-<task#>-<short-name>` |
| **No branch** | Docs-only tasks | Work directly on current branch |

### 3.3 Wave Execution Loop

For each wave (waves execute sequentially):

#### 3.3a Spawn Sub-Agents in Parallel

For each task in the wave, spawn a sub-agent using the **Agent tool**:

- **Same-repo parallel tasks** → use `isolation: "worktree"` in the Agent call. The sub-agent invokes `/dev <task-description>` inside the isolated worktree.
- **Different-repo tasks** → spawn Agent normally (no worktree needed, repos are separate). The sub-agent invokes `/dev <task-description>` directly.
- **Docs-only tasks** → invoke `/update-docs <scope>` instead of `/dev`.

**Controller notification (MANDATORY).** Before each wave's spawns, send `SendMessage(to: "controller", ...)` for every agent in the wave with the wave plan and conflict matrix. The controller pre-arms cross-agent invariant checks for the named file scopes. Notification format: `"Add <agent-id> to watch list. Skill: /dev. Task: <one-line>. Wave: <N>. Expected file scope: <list>. Conflict matrix: <pairs>. Spawn timestamp: <ISO>"`.

**All sub-agents for a wave are spawned in a SINGLE message** (parallel Agent tool calls). Use `run_in_background: true` if there are other tasks to coordinate.

**CRITICAL safety constraints during parallel execution:**
- Only ONE task may run the native build (the compiled-engine build) at a time — if this constraint is somehow violated (shouldn't happen per conflict rules), serialize their build steps
- Only ONE engine instance may be active for testing (exclusive GPU/audio hardware)
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

After all tasks in a wave complete, run tests appropriate to the wave's scope. Resolve the venv interpreter from [`PROJECT_CONFIG.md#interpreters`](../../docs/PROJECT_CONFIG.md#interpreters) and the test-tier locations from [`#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths) (concrete commands in the [worked-examples companion](../skill-examples/multitask.md)):

| Wave Content | Test Suite | Command |
|-------------|-----------|---------|
| Any compiled-engine changes | Integration tests | `<venv-python> -m pytest tests/integration/ -v` |
| Any backend/script changes | Unit tests | `<venv-python> -m pytest tests/unit/ -v` |
| Frontend changes | npm test | `cd <frontend-repo> && npm test` |
| Mixed backend | Integration + unit | Both commands above |

**System tests are deferred to Phase 4** — they require exclusive hardware access, and running them per-wave would serialize everything.

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

Resolve the venv interpreter from [`PROJECT_CONFIG.md#interpreters`](../../docs/PROJECT_CONFIG.md#interpreters) and the test-tier locations + engine-repo from [`#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths) / [`#repos`](../../docs/PROJECT_CONFIG.md#repos) (concrete commands in the [worked-examples companion](../skill-examples/multitask.md)):

```bash
cd <engine-repo>

# Unit tests
<venv-python> -m pytest tests/unit/ -v

# Integration tests (compute, no hardware)
<venv-python> -m pytest tests/integration/ -v

# System tests (full stack — exclusive hardware access)
<venv-python> -m pytest tests/system/ -v -s 2>&1 | tee /tmp/multitask_final.log
```

### 4.2 Performance Comparison

Compare final metrics against Phase 3.1 baseline. The exact metric set + thresholds are a project fact — resolve them from the project's performance-test surface ([`PROJECT_CONFIG.md#verification-surfaces`](../../docs/PROJECT_CONFIG.md#verification-surfaces) / [`#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths)); the table below is illustrative:

| Metric | Baseline | Final | Delta | Status |
|--------|----------|-------|-------|--------|
| compute mean (ms) | — | — | — | OK/WARN/FAIL |
| compute p99 (ms) | — | — | — | OK/WARN/FAIL |
| total cycle mean (ms) | — | — | — | OK/WARN/FAIL |
| underrun count | — | — | — | OK/WARN/FAIL |
| output correlation | — | — | — | OK/WARN/FAIL |

Regression criteria follow `/dev`'s verification gate (same thresholds the project's `/dev` Step 5 applies — a hot-path-mean ceiling, an output-correlation floor, and "no new test failure"; the project's concrete numbers are illustrated in the [worked-examples companion](../skill-examples/multitask.md)).

### 4.3 Documentation Sweep

For each completed task, verify `/dev` sub-agents updated docs in their Step 8. If gaps remain, invoke `/update-docs` to fill them.

---

## Phase 5: Final Report

Present summary:

```
### Multi-Task Execution Report

| # | Task | Wave | Status | Branch | Build | Tests | Time |
|---|------|------|--------|--------|-------|-------|------|
| 1 | Fix buffer underrun | 1 | PASSED | merged | heavy | 12/12 | 8m |
| 2 | Add FIR bypass mode | 2 | PASSED | merged | light | 12/12 | 3m |
| 3 | Update tooltip | 1 | PASSED | merged | npm | 5/5 | 2m |
| 4 | Update engine docs | 1 | PASSED | direct | none | n/a | 1m |

### Performance Summary
| Metric | Baseline | Final | Delta |
|--------|----------|-------|-------|
| ... | ... | ... | ... |

Total: Xm (estimated sequential: Ym, speedup: Z.Zx)
```

### 5.1 Cleanup

Before declaring the environment clean, sweep the project's ports with the project's **port-scoped** sweep — never kill by image name (resolve the canonical sweep executable from [`PROJECT_CONFIG.md#process-sweep`](../../docs/PROJECT_CONFIG.md#process-sweep), which names the project's richer kill script; the concrete invocation is in the [worked-examples companion](../skill-examples/multitask.md)).

Ask user before each action:

1. **Delete merged feature branches:**
   ```bash
   git -C <repo> branch -d feature/mt-<N>-<name>
   ```

2. **Push to origin** (per repo, ask individually — iterate the repo + branch list from [`PROJECT_CONFIG.md#repos`](../../docs/PROJECT_CONFIG.md#repos)):
   ```bash
   # Per-repo push — substitute each repo-relative path + integration branch from PROJECT_CONFIG.md#repos
   git -C "<repo>" push origin "<integration-branch>"
   ```

3. **Remove any remaining worktree directories**

---

## Key Paths

Repo roots, venv interpreter, test paths, and the build script are project facts — resolve them from the
active project's [`PROJECT_CONFIG.md` → Key Paths](../../docs/PROJECT_CONFIG.md#key-paths),
[→ Interpreters](../../docs/PROJECT_CONFIG.md#interpreters), and [→ Docs-first for build + run](../../docs/PROJECT_CONFIG.md#docs-first-build--run).
