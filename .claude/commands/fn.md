---
name: fn
description: Single-function development — focused edit with clear requirements and test criteria. Designed for use standalone or as a sub-agent of /dev.
user-invocable: true
tier: generic
argument-hint: <file path> <function name or description> [--test <test command>] [--context <comma-separated context files>]
---

# Single-Function Development Workflow

> **Project-agnostic skill** (`tier: generic`). Operates on an **active project**: resolve `$PROJECT_ROOT`
> and the project's `docs/PROJECT_CONFIG.md` per the machine-global `~/.claude/CLAUDE.md` "Config resolution" section (#config-resolution)
> — including the **graceful fallback** when no `PROJECT_CONFIG.md` is found. All project facts (build,
> ports, venv, repos, endpoints, verification surfaces) come from that config by anchor; this skill
> resolves them there rather than hard-coding them.

**Worked examples (project-tier):** concrete invocations for the active project — the canonical rebuild command, the venv pytest invocations, the build-decision table, the pre-build holder check, the post-build import-verify, the optional codegen-delegation pipeline, and the standalone/`/dev`-spawned usage — live in [`.claude/skill-examples/fn.md`](../skill-examples/fn.md) ([`#skill-examples`](../../docs/PROJECT_CONFIG.md#skill-examples)).

Focused, lightweight workflow for implementing or modifying a single function with clear requirements and test criteria. No branching, no WIP registration, no documentation updates, no commits — those belong to the caller (the `/dev` agent or the user).

## Audio/Verification Mode: inherits from caller

This skill inherits its verification mode from the invoker (parent `/dev` session, the project's verification skills, or direct user invocation). The caller-supplied `--test <command>` determines which verification markers / fixtures apply. The project's verification-surface routing + the binary marker contract live in the active project's [`PROJECT_CONFIG.md#verification-surfaces`](../../docs/PROJECT_CONFIG.md#verification-surfaces) and the development/testing doc ([`#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy)).

**When spawned by `/dev`:** The parent agent provides context, requirements, test instructions, and holds module locks. This agent edits code, builds, tests, and reports back. The parent handles everything else.

**When invoked directly by the user:** Suitable for small, self-contained changes where the full `/dev` workflow is overkill. The user is responsible for committing and documentation.

## Docs-first (MANDATORY) for compile + run

Before rebuilding or restarting, READ the canonical docs (else a silently-stale binary masquerades as a working rebuild and voids every "I verified this" claim).

- **Full docs-first build/run discipline: the single canonical copy at the active project's [`PROJECT_CONFIG.md` → Docs-first for build + run](../../docs/PROJECT_CONFIG.md#docs-first-build--run)** — the canonical build command + agent-context detached form (stop the build holder first), the **never-substitute traps**, and the **verify-landed** step (marker absent → the rebuild didn't land, any conclusion is void); also [`#rebuild-matrix`](../../docs/PROJECT_CONFIG.md#rebuild-matrix) / [`#build-holders`](../../docs/PROJECT_CONFIG.md#build-holders). (Concrete command + verify-grep: [worked-examples companion](../skill-examples/fn.md).)
- **On unexpected build or startup failure → invoke the project's startup/build-recovery skill** (see [`PROJECT_CONFIG.md#docs-first-build--run`](../../docs/PROJECT_CONFIG.md#docs-first-build--run)) instead of ad-hoc troubleshooting.

## Input Contract

The caller (user or `/dev` agent) MUST provide:

| Field | Description |
|-------|-------------|
| **target_file** | Path to the file to edit (repo-relative; resolve the repo root from [`PROJECT_CONFIG.md#repos`](../../docs/PROJECT_CONFIG.md#repos)) |
| **function_spec** | What to implement/modify — name, signature, behavior |
| **requirements** | Acceptance criteria — what "done" looks like |
| **test_command** | Exact command to verify the change (the project's venv runner — [`#interpreters`](../../docs/PROJECT_CONFIG.md#interpreters)) |
| **context_files** | Files to read for understanding (optional) |
| **parent_agent** | Parent agent ID if spawned by `/dev` (optional) |
| **held_locks** | Files already locked by parent (optional) |

(Concrete example values for each field — for the active project — are in the [worked-examples companion](../skill-examples/fn.md).) When invoked directly by user, extract these from the argument string and ask for any missing required fields.

## Step 0: Initialize

### Generate Agent ID

```bash
AGENT_ID="fn-$(openssl rand -hex 2)"   # e.g. fn-b7c2
```

### Create Session Log

Create the session log under the project's logs dir ([`PROJECT_CONFIG.md#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths)):

```bash
LOG_FILE="<logs-dir>/${AGENT_ID}-$(date +%Y-%m-%d-%H%M%S).md"
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

`/fn` agents are monitored by the same compliance controller as `/dev` agents. Apply the same marker discipline as the parent dev agent:

- **Before every `Bash` invocation:** emit `[BASH-CALL] {ts} {first 80 chars of command, escaped}` to the session log
- **After every `Bash` return:** emit `[BASH-RETURN] {ts} duration_ms=<N> exit_code=<N>`
- **Before every MCP tool invocation:** emit `[MCP-CALL] {ts} server=<name> tool=<name> args_summary=<...>`
- **After every MCP tool return:** emit `[MCP-RETURN] {ts} duration_ms=<N> status=<ok\|error>`
- **Before every `Read` invocation on a project file:** emit `[READ] {ts} path=<path>`
- **Before every `Grep`/`Glob` invocation on project files:** emit `[GREP] {ts} pattern=<pattern> path=<path>`
- **At least every few minutes during any long operation** (build, test, capture): emit `[PROGRESS] {ts} step=<N> note=<short>` — the heartbeat that proves you are alive between tool-call pairs
- **Before any operation that could hit a CLI permission gate** (server/backend spawn, process kill, MCP auth): emit `[PERM-RISK] {ts} action=<...> method=<bash-bg\|start-process\|launcher-rest\|kill\|mcp-auth> gate-risk=<...>` — identical to the parent dev agent's discipline

The `[BASH-CALL]` / `[MCP-CALL]` pairs and the `[PROGRESS]` heartbeat feed the controller's freshness check (tiered: a fast 3-min scan with an 8-min stall threshold, plus a 15-min deep sweep). A `[PERM-RISK]` marker left as the newest line of a stale log is the single strongest signal of a CLI permission stall. The `[READ]` / `[GREP]` markers feed the Documentation-First compliance check. Failure to emit is itself a Tier-2 violation.

## Context Hygiene (cost discipline)

Every turn re-reads this agent's **entire accumulated context** before it does anything — that re-read, not the work itself, is the majority of the cost (~65%). Keep the resident working set small:

- **Read narrowly.** Read the **target function span** with `offset`/`limit`, not the whole file, when only one function is in scope; read the **one gating test**, not the whole suite. Don't load module docs "for context" the function doesn't touch — if a fact isn't cited in your reasoning, it needn't stay resident.
- **Test once.** Run the gate **once** when the function is complete, not after each speculative edit — each full test turn re-reads your whole context; the 4×-incremental-test pattern is the canonical waste. Use the Step-4b debug loop only after the single run goes red.
- **Prune stale output.** After the function is green, don't keep its full diff + every intermediate test dump resident — the durable record is the **session log**, not the live context. Prune *stale* output, never *load-bearing* context (the spec, the current test, cited doc facts).

(Cost model + measurements: the project's dev-pipeline cost-model proposal — see the [worked-examples companion](../skill-examples/fn.md).)

## Step 1: Read Context

Read the files specified in `context_files` (if any) and the `target_file` itself.

**Documentation-first rule still applies.** If context_files include doc paths, read those before source files. If no context_files are provided but the change touches a high-stakes data-model area, read the relevant module doc first (resolve the module→doc mapping + the high-stakes inference categories from [`PROJECT_CONFIG.md#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy) / [`#data-model-facts`](../../docs/PROJECT_CONFIG.md#data-model-facts)).

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

**Lock check:** If `held_locks` is provided, verify that `target_file` is in the list. If not, and a `parent_agent` exists, **stop and report** — the parent must acquire the lock first. If standalone (no parent), check the project's module-locks file directly ([`PROJECT_CONFIG.md#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths)) and acquire a lock if needed.

The controller verifies parent-lock inheritance: if `target_file` is not in `held_locks` and no `parent_agent` is set, that's a Tier-2 escalate. Always verify before editing.

Log the edit: what changed, line numbers, rationale.

**Array-module-agnostic targets (MANDATORY dual-backend test).** If the function takes an array module (`xp`, or otherwise dispatches over numpy/cupy/torch), the test MUST exercise **both** backends — a numpy-only test does **not** validate the cupy path and ships latent host/device bugs (e.g. mixing a host `rng.standard_normal(...)` into a device array → `cupy + numpy` under `xp=cupy`). Parametrise the array module over `{numpy, cupy-if-importable}` (skip cupy cleanly when unavailable, but record that it was skipped — never hide it). Only after the test runs under both backends may you delegate the body (Step 2a) or write it yourself. **The cupy parametrisation is the gate that forces `xp.asarray(...)` on any host-drawn array** — without it the bug ships green (a `signal + numpy_noise` add passes the numpy-only gate and would fail under cupy).

## Step 2a (optional): Delegate codegen to an external code-generation backend

Before writing the function yourself, you MAY offload the *body* to an external code-generation backend via a codegen MCP tool, when one is configured — Claude still owns the test, the review, the build, the test run, the debug loop, and the commit. This is opt-in and falls back silently to writing it yourself. (The active project's concrete codegen tool, the batch-pipeline path, and the language matrix are in the [worked-examples companion](../skill-examples/fn.md).)

**Eligible ONLY when ALL hold:**
- `target_file` is a language with a fast isolated test gate that the configured backend supports (e.g. Python tested via pytest, or JavaScript/TypeScript/React tested via Jest) — pass the matching `language` to the tool. **HARD-EXCLUDED: the project's compiled file types** (they need the heavy build — resolve the set from [`PROJECT_CONFIG.md#rebuild-matrix`](../../docs/PROJECT_CONFIG.md#rebuild-matrix)).
- The function is a single, pure, well-specified responsibility (the `/fn` envelope) — not a cross-cutting refactor.
- A concrete test exists already (the caller's `test_command` + the test source) — never delegate without the test.
- If the target is **xp-agnostic**, that test must already be **dual-backend** (per the MANDATORY rule above). Delegating against a numpy-only test re-introduces the blind spot — the backend will (correctly, per its prompt) make the numpy-only test pass and leave the cupy path broken.

**Procedure:**
1. Emit `[MCP-CALL] {ts} server=<codegen-server> tool=<delegate-tool> args_summary=<fn name>`.
2. Call the codegen tool with `function_spec=<sig+behaviour>`, `test_or_signature=<the test source>`, `constraints=<requirements>`, `context_snippets=<the adjacent patterns from Step 1 — NOT the whole repo>`.
3. Emit `[MCP-RETURN] {ts} status=<ok|refused|error>`.
4. On `status:"ok"`: REVIEW the returned `code` (style match, no speculative features, sane imports). If good, apply it via Edit/Write (the tool never writes files) and continue to Step 3. If the review rejects it, write the function yourself (normal Step 2).
5. On `status:"refused"` or `status:"error"`: write the function yourself (normal Step 2) — no retry needed.

Note: delegated output is never trusted, only tested — Step 4 (the Claude-written test) is the gate. If the applied code fails the test after the Step 4b ≤3-iteration debug loop, discard it and rewrite from scratch.

**Reuse existing helpers (don't let the backend re-implement).** If the function should call an **existing** helper (in the repo, or one written earlier in this `/dev` run), put that helper's **signature** in `context_snippets` with an explicit "call this; do NOT re-implement." (To generate **several interdependent** functions at once, use the codegen backend's **batch pipeline** — see the [worked-examples companion](../skill-examples/fn.md) — which declares dependencies, builds leaf helpers first, and exposes them automatically; a lone Step-2a delegation has no sibling context, so it WILL re-implement an undeclared helper.)

## Step 3: Build (if needed)

Only rebuild if the edited file requires it. **Which build for which changed file is the active project's rebuild decision matrix — [`PROJECT_CONFIG.md#rebuild-matrix`](../../docs/PROJECT_CONFIG.md#rebuild-matrix)** (compiled sources → heavy build; server/middleware code → light or no build; tests/docs → no build).

**Pre-build check (MANDATORY):** before a heavy rebuild, confirm no live process is holding the native binary open (a held binary fails the rebuild with an access-denied / broken-venv error). Find holders per [`PROJECT_CONFIG.md#build-holders`](../../docs/PROJECT_CONFIG.md#build-holders) and stop the holder FIRST (the project's graceful stop endpoint, else a PID-targeted kill — never by image name; see [`#process-sweep`](../../docs/PROJECT_CONFIG.md#process-sweep)). (Concrete holder-check + stop commands: [worked-examples companion](../skill-examples/fn.md).)

**Build command (agent context — DETACHED).** Use the project's canonical build command in the **detached** form with an absolute build-script path (the non-detached agent-context form removes the binary before reinstall and bricks the venv). Resolve the command + the detached form + the never-substitute traps from [`PROJECT_CONFIG.md#docs-first-build--run`](../../docs/PROJECT_CONFIG.md#docs-first-build--run) and [`#rebuild-matrix`](../../docs/PROJECT_CONFIG.md#rebuild-matrix). (Concrete detached invocation + the build-log done-marker: [worked-examples companion](../skill-examples/fn.md).)

**Post-build verification:** import-verify the rebuilt module resolves from inside the project venv ([`#interpreters`](../../docs/PROJECT_CONFIG.md#interpreters)), then verify-landed per the docs-first step above. (Concrete import-verify command: [worked-examples companion](../skill-examples/fn.md).)

Log build result (success/failure, duration).

## Step 4: Test

Run the `test_command` provided by the caller (from the project repo, via the project venv runner — [`#interpreters`](../../docs/PROJECT_CONFIG.md#interpreters)):

```bash
<test_command> 2>&1 | tee /tmp/${AGENT_ID}_test.log
```

(Concrete `cd <repo>` + venv-pytest form: [worked-examples companion](../skill-examples/fn.md).)

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

If this agent acquired its own locks (standalone mode only), release them from the project's module-locks file ([`PROJECT_CONFIG.md#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths)).

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

Repo roots, the venv interpreter (per-OS), and the lock/log locations are project facts — resolve them
from the active project's [`PROJECT_CONFIG.md` → Key Paths](../../docs/PROJECT_CONFIG.md#key-paths) and
[→ Interpreters](../../docs/PROJECT_CONFIG.md#interpreters).

## Example Usage

Concrete standalone and `/dev`-spawned invocations for the active project live in the [worked-examples companion](../skill-examples/fn.md) ([`#skill-examples`](../../docs/PROJECT_CONFIG.md#skill-examples)). The shapes:

- **Standalone (user invokes directly):** `/fn <repo-relative target file> <function name> --test "<venv pytest command>"`
- **Spawned by `/dev` (via Agent tool):** an `Agent({...})` call whose prompt sets `target_file`, `function_spec`, `requirements`, `test_command`, `context_files`, `parent_agent`, and `held_locks`.
