---
name: fn
description: Single-function development — focused edit with clear requirements and test criteria. Designed for use standalone or as a sub-agent of /dev.
user-invocable: true
argument-hint: <file path> <function name or description> [--test <test command>] [--context <comma-separated context files>]
---

# Single-Function Development Workflow

Focused, lightweight workflow for implementing or modifying a single function with clear requirements and test criteria. No branching, no WIP registration, no documentation updates, no commits — those belong to the caller (the `/dev` agent or the user).

## Audio Mode: inherits from caller

This skill inherits its audio mode from the invoker (parent `/dev` session, `/test-ui`, `/diagnose`, or direct user invocation). The caller-supplied `--test <command>` determines whether `audio_on` or `audio_off` markers / fixtures apply. See `docs/development/TESTING.md` for the strict-A1 binary contract.

**When spawned by `/dev`:** The parent agent provides context, requirements, test instructions, and holds module locks. This agent edits code, builds, tests, and reports back. The parent handles everything else.

**When invoked directly by the user:** Suitable for small, self-contained changes where the full `/dev` workflow is overkill. The user is responsible for committing and documentation.

## Docs-first (MANDATORY) for compile + run

Before rebuilding or restarting anything, READ the canonical docs — skipping this burned ~3h on 2026-04-23 when a stale `.pyd` masqueraded as a working rebuild.

- **Before ANY build** — read `docs/architecture/BUILD_SYSTEM.md` + `docs/guides/QUICK_START.md`.
- **Canonical rebuild** — `cd PianoidCore && build_pianoid_cuda.bat --heavy --release`. NEVER substitute `pip install --force-reinstall --no-cache-dir pianoid_cuda/` — silently reinstalls STALE `.pyd`, your edit never lands.
- **Debug variant trap** — `PIANOID_BUILD_VARIANT=debug` alone skips DLL copy; run release (or `--both`) first.
- **Verify the rebuild landed** — `grep -a "<marker-string-just-added>" PianoidCore/.venv/Lib/site-packages/pianoidCuda.cp312-win_amd64.pyd`. If missing, the build did not land — do NOT test.
- **Pre-build hygiene** — `tasklist //M pianoidCuda.cp312-win_amd64.pyd` to find stale holders; kill by PID before building. Locked `.pyd` causes `[WinError 5] Access is denied` → package uninstalled.
- **When a build or startup fails unexpectedly** — invoke `/startup` instead of ad-hoc troubleshooting.

## Input Contract

The caller (user or `/dev` agent) MUST provide:

| Field | Description | Example |
|-------|-------------|---------|
| **target_file** | Absolute path to the file to edit | `D:/repos/.../pianoid.py` |
| **function_spec** | What to implement/modify — name, signature, behavior | "Add `clamp_velocity(v, min, max)` that returns clamped int" |
| **requirements** | Acceptance criteria — what "done" looks like | "Returns min when v < min, max when v > max, v otherwise" |
| **test_command** | Exact command to verify the change | `.venv/Scripts/python -m pytest tests/unit/test_clamp.py -v` |
| **context_files** | Files to read for understanding (optional) | `pianoid.py`, `DATA_FLOWS.md` |
| **parent_agent** | Parent agent ID if spawned by `/dev` (optional) | `dev-a3f1` |
| **held_locks** | Files already locked by parent (optional) | `pianoid.py, backendServer.py` |

When invoked directly by user, extract these from the argument string and ask for any missing required fields.

## Step 0: Initialize

### Generate Agent ID

```bash
AGENT_ID="fn-$(openssl rand -hex 2)"   # e.g. fn-b7c2
```

### Create Session Log

```bash
LOG_FILE="docs/development/logs/${AGENT_ID}-$(date +%Y-%m-%d-%H%M%S).md"
```

Write the log header:

```markdown
# Fn Session Log

- **Agent:** <AGENT_ID>
- **Parent:** <parent_agent or "standalone">
- **Target:** <target_file>:<function_name>
- **Requirements:** <one-line summary>
- **Started:** <ISO timestamp>
- **Status:** In Progress

## Actions
```

### Logging Rule

After each step, append a timestamped entry:

```markdown
### Step N: <Name> — <HH:MM>
- <what was done>
- <outcome>
```

Keep entries terse — this log will be incorporated into the parent's log.

### Marker Discipline (cross-cutting)

`/fn` agents are monitored by the same controller as `/dev` agents. Apply the same marker discipline as the parent dev agent:

- **Before every `Bash` invocation:** emit `[BASH-CALL] {ts} {first 80 chars of command, escaped}` to the session log
- **After every `Bash` return:** emit `[BASH-RETURN] {ts} duration_ms=<N> exit_code=<N>`
- **Before every MCP tool invocation:** emit `[MCP-CALL] {ts} server=<name> tool=<name> args_summary=<...>`
- **After every MCP tool return:** emit `[MCP-RETURN] {ts} duration_ms=<N> status=<ok\|error>`
- **Before every `Read` invocation on a project file:** emit `[READ] {ts} path=<path>`
- **Before every `Grep`/`Glob` invocation on project files:** emit `[GREP] {ts} pattern=<pattern> path=<path>`
- **At least every few minutes during any long operation** (build, test, capture): emit `[PROGRESS] {ts} step=<N> note=<short>` — the heartbeat that proves you are alive between tool-call pairs
- **Before any operation that could hit a CLI permission gate** (backend spawn, `taskkill`, MCP auth): emit `[PERM-RISK] {ts} action=<...> method=<bash-bg\|start-process\|launcher-rest\|taskkill\|mcp-auth> gate-risk=<...>` — identical to the parent dev agent's discipline

The `[BASH-CALL]` / `[MCP-CALL]` pairs and the `[PROGRESS]` heartbeat feed the controller's freshness check (tiered: a fast 3-min scan with an 8-min stall threshold, plus a 15-min deep sweep). A `[PERM-RISK]` marker left as the newest line of a stale log is the single strongest signal of a CLI permission stall. The `[READ]` / `[GREP]` markers feed the Documentation-First compliance check. Failure to emit is itself a Tier-2 violation.

## Step 1: Read Context

Read the files specified in `context_files` (if any) and the `target_file` itself.

**Documentation-first rule still applies.** If context_files include doc paths, read those before source files. If no context_files are provided but the change touches synthesis/audio, read the relevant module doc under `docs/modules/` first.

Identify:
- The exact location where the function exists or should be added
- Adjacent code patterns (naming, error handling, imports)
- Any existing utilities that could be reused

Log what was read and what was learned.

## Step 2: Edit Code

Implement the function according to `function_spec` and `requirements`.

**Code rules (same as /dev):**
- Minimum code for the task
- Match existing patterns in the file
- One function, one responsibility
- Reuse existing helpers — search before writing
- No speculative features

**Lock check:** If `held_locks` is provided, verify that `target_file` is in the list. If not, and a `parent_agent` exists, **stop and report** — the parent must acquire the lock first. If standalone (no parent), check `docs/development/MODULE_LOCKS.md` directly and acquire a lock if needed.

The controller verifies parent-lock inheritance: if `target_file` is not in `held_locks` and no `parent_agent` is set, that's a Tier-2 escalate. Always verify before editing.

Log the edit: what changed, line numbers, rationale.

## Step 2a (optional): Delegate codegen to DeepSeek

Before writing the function yourself, you MAY offload the *body* to DeepSeek via the `deepseek-codegen` MCP tool — Claude still owns the test, the review, the build, the test run, the debug loop, and the commit. This is opt-in and falls back silently to writing it yourself.

**Eligible ONLY when ALL hold:**
- `target_file` is `.py` (NOT `.cu/.cpp/.cuh/.h/setup.py` — hard exclusion, HC-1).
- The function is a single, pure, well-specified responsibility (the `/fn` envelope) — not a cross-cutting refactor.
- A concrete test exists already (the caller's `test_command` + the test source) — HC-2: never delegate without the test.

**Procedure:**
1. Emit `[MCP-CALL] {ts} server=deepseek-codegen tool=delegate_codegen args_summary=<fn name>`.
2. Call `mcp__deepseek-codegen__delegate_codegen(function_spec=<sig+behaviour>, test_or_signature=<the test source>, constraints=<requirements>, context_snippets=<the adjacent patterns from Step 1 — NOT the whole repo>)`.
3. Emit `[MCP-RETURN] {ts} status=<ok|refused|error>`.
4. On `status:"ok"`: REVIEW the returned `code` (style match, no speculative features, sane imports). If good, apply it via Edit/Write (the tool never writes files) and continue to Step 3. If the review rejects it, write the function yourself (normal Step 2).
5. On `status:"refused"` or `status:"error"`: write the function yourself (normal Step 2) — no retry needed.

Note: DeepSeek output is never trusted, only tested — Step 4 (the Claude-written test) is the gate. If the applied code fails the test after the Step 4b ≤3-iteration debug loop, discard it and rewrite from scratch.

## Step 3: Build (if needed)

Only rebuild if the edited file requires it:

| File type | Build action |
|-----------|-------------|
| `*.cu`, `*.cpp`, `*.cuh`, `*.h`, `setup.py` | Heavy CUDA build (see below) |
| `pianoid_middleware/*.py` | Light build or no build |
| `tests/**` | No build |
| `PianoidBasic/*.py` | PianoidBasic build |

**Pre-build check (MANDATORY):**
```bash
locked_pids=$(tasklist //M pianoidCuda.cp312-win_amd64.pyd 2>/dev/null | grep python | awk '{print $2}')
if [ -n "$locked_pids" ]; then
  echo "WARNING: pianoidCuda.pyd locked by PIDs: $locked_pids"
fi
```

**Build commands:**
```bash
# Heavy (C++/CUDA)
unset VIRTUAL_ENV && cmd //c "PianoidCore\build_pianoid_cuda.bat --heavy"

# Light (Python middleware)
unset VIRTUAL_ENV && cmd //c "PianoidCore\build_pianoid_cuda.bat --light"

# PianoidBasic
unset VIRTUAL_ENV && cmd //c "PianoidCore\build_pianoid_basic.bat"
```

**Post-build verification:**
```bash
PianoidCore/.venv/Scripts/python -c "import pianoidCuda; print(pianoidCuda.__file__)"
```

Log build result (success/failure, duration).

## Step 4: Test

Run the `test_command` provided by the caller:

```bash
cd PianoidCore
<test_command> 2>&1 | tee /tmp/${AGENT_ID}_test.log
```

### Evaluate Results

- **All tests pass:** Proceed to Step 5 (wrap-up).
- **Tests fail:** Go to Step 4b (debug).

Log test output summary (pass/fail counts, any failure messages).

## Step 4b: Debug (if tests fail)

Iterative loop (max 3 iterations — this is a single function, not a deep investigation):

1. Read failure output — identify root cause
2. Make targeted fix to the function
3. Rebuild if needed
4. Re-run `test_command`
5. Repeat until pass

After 3 failed iterations, **stop and report failure** with:
- What was tried
- Current error output
- Hypothesis for root cause

The parent agent (or user) decides next steps.

## Step 5: Wrap-Up

### Finalize Log

Append completion summary:

```markdown
## Result — <HH:MM>

- **Status:** Success | Failed
- **Function:** <name> in <file>
- **Changes:** <one-line summary of what changed>
- **Tests:** <pass/fail summary>
- **Duration:** <elapsed time>
```

Update the log header status to `Complete` or `Failed`.

### Release Standalone Locks

If this agent acquired its own locks (standalone mode only), release them from `docs/development/MODULE_LOCKS.md`.

**Do NOT release locks if spawned by a parent** — the parent manages its own locks.

### Report to Caller

If spawned by `/dev`, the log file path IS the report. The parent agent reads it and incorporates findings.

If standalone, print a summary to the user:
- What was changed
- Test results
- Any warnings or caveats

**Do NOT:**
- Commit code (parent or user does this)
- Update documentation (parent or user does this)
- Modify WIP tracking (parent does this)
- Archive the log (parent does this)

## Key Paths

| Resource | Path |
|----------|------|
| PianoidCore | `PianoidCore` |
| PianoidBasic | `PianoidBasic` |
| PianoidTunner | `PianoidTunner` |
| Session logs | `docs\development\logs/` |
| Module locks | `docs\development\MODULE_LOCKS.md` |
| venv Python | `PianoidCore/.venv/Scripts/python` |

## Example Usage

### Standalone (user invokes directly)
```
/fn PianoidCore/pianoid_middleware/pianoid.py clamp_velocity --test ".venv/Scripts/python -m pytest tests/unit/test_utils.py::test_clamp -v"
```

### Spawned by /dev agent (via Agent tool)
```
Agent({
  description: "Implement clamp_velocity",
  prompt: "Execute the /fn skill with these parameters:\n- target_file: D:/repos/.../pianoid.py\n- function_spec: Add clamp_velocity(v, min_v, max_v) -> int ...\n- requirements: Returns clamped value...\n- test_command: .venv/Scripts/python -m pytest tests/unit/test_utils.py::test_clamp -v\n- context_files: docs/modules/pianoid-middleware/OVERVIEW.md, pianoid.py\n- parent_agent: dev-a3f1\n- held_locks: pianoid.py"
})
```
