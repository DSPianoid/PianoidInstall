---
name: dev
description: Development workflow — study context, baseline test, branch, edit, verify, debug, document, commit.
user-invocable: true
argument-hint: <task description — bug fix, feature, or refactor>
---

# Pianoid Development Workflow

Disciplined development cycle for PianoidCore, PianoidBasic, and PianoidTunner. Follow every step in order. Do not skip steps.

## Audio Verification Routing (strict A1)

When a code change affects sound output and verification is required (per the Audio Verification Rule in `.claude/CLAUDE.md`):

- **Synthesis-output change** (volume, excitation, physical params, hammer shape, kernel coefficients) → invoke `/test-ui` (audio_off mode). Comparison via `note_playback` offline buffer. Most code changes route here.
- **Mic-engaging change** (calibration, `MicAnalyzer`, `measurement_engine`, mic capture path, `/calibrate_volume` family, `assert_synth_reaches_mic`) → invoke `/diagnose` with mic Phase 7 (audio_on mode). Comparison via mic-vs-synth Goertzel transferRatio. Requires `_MIC_LOOPBACK_CONFIGURED=True` in `tests/system/conftest.py`.

See `docs/development/TESTING.md` for the binary contract details.

**Code principles (anchored in `docs/development/CODE_QUALITY.md`):**
- **P1 Separation of Authority** — every piece of state has exactly one owner (the sole writer). Before you touch state, name its owner. If your change makes a non-owner write it, you're violating P1.
- **P2 Separation of Concern** — every module/class/function has one job. Before you widen a module, ask whether the new responsibility is actually the module's concern. If not, put it elsewhere.
- Supporting principles: lean code (S1), no redundancy (S2), no duplication (S3), fail-fast no workarounds (S5), file-size red flags (C4 — any file approaching 500 LOC deserves scrutiny; >1000 is a split-plan trigger).

Do not ship a change that pushes a file past the C4 thresholds without discussing a split first.

## Docs-first (MANDATORY) for compile + run

Every rebuild, install, or server restart starts by reading the canonical docs — NOT by typing `pip install`. Skipping this burned ~3h on 2026-04-23 when a stale `.pyd` masqueraded as a working rebuild.

- **Before ANY CUDA build** — read `docs/architecture/BUILD_SYSTEM.md` + `docs/guides/QUICK_START.md`.
- **Canonical rebuild command** — `cd /d PianoidCore && .\build_pianoid_cuda.bat --heavy --both` (cd-safe `.\` path + default `--both`; in agent context use the detached `Start-Process` form — see [`BUILD_SYSTEM.md` → Canonical Install / Rebuild](../../docs/architecture/BUILD_SYSTEM.md#canonical-install--rebuild-read-this-first)). Do NOT substitute `pip install --force-reinstall --no-cache-dir pianoid_cuda/` — it silently reinstalls the STALE `.pyd` and your edit never lands.
- **Debug variant trap** — `PIANOID_BUILD_VARIANT=debug` alone does NOT copy CUDA DLLs; run release first (or `--both`). Missing DLLs look like import errors, not build errors.
- **Verify the rebuild landed** — `grep -a "<new-string-you-just-added>" PianoidCore/.venv/Lib/site-packages/pianoidCuda.cp312-win_amd64.pyd`. If your marker is absent, nothing changed — do NOT run tests.
- **Pre-build hygiene** — `tasklist //M pianoidCuda.cp312-win_amd64.pyd` to find stale holders; kill by PID before building. A locked `.pyd` causes `[WinError 5] Access is denied`, leaves the package uninstalled, and breaks the venv.
- **Before starting the backend** — read `docs/guides/QUICK_START.md` + `docs/modules/pianoid-middleware/REST_API.md`.
- **On unexpected build or startup failure** — invoke `/startup` rather than troubleshooting blindly. `/startup` is the authoritative reference.

## Documentation Folder Taxonomy (MANDATORY)

Every doc artefact a `/dev` session produces (or moves) belongs in exactly one canonical location. Mixing types in `docs/development/logs/` makes orchestrator log scans noisy and breaks the "every log = one agent" invariant. Follow this taxonomy:

| Folder | Contents | Naming |
|--------|----------|--------|
| `docs/development/logs/` | Agent session logs ONLY - one file per `/dev` (or `/fn`) session | `dev-XXXX-YYYY-MM-DD-HHMMSS.md` |
| `docs/development/logs/archive/` | Completed agents' session logs (moved here at Step 10 wrap-up) | same naming |
| `docs/proposals/` | Refactor proposals, design analyses, plans, planning docs not yet implemented | `<topic>-<YYYY-MM-DD>.md` |
| `docs/development/reviews/` | Code reviews, system reviews, audits | `<scope>-review-<YYYY-MM-DD>.md` |
| `docs/development/diagnostics/` | Diagnostic snippets, troubleshooting scripts (`.py`, `.js`, etc.) | `<agent-id>-<purpose>.<ext>` |
| `docs/development/screenshots/` | Standalone UI screenshots not referenced from a session log | `<agent-id>-<view>.png` |
| `docs/architecture/` | Long-lived architecture docs | UPPER_CASE.md |
| `docs/guides/` | User-facing guides | UPPER_CASE.md |
| `docs/modules/` | Module-specific reference docs | per-module subfolder |

**Rules:**
1. Never write a non-session-log file into `docs/development/logs/`. Plans, proposals, reviews, and diagnostic snippets go to the correct folder above.
2. Screenshots referenced from a session log stay in `docs/development/logs/` (next to the log that cites them); standalone screenshots go to `docs/development/screenshots/`.
3. Plan / proposal output written to disk (Step 4 deferral, design doc, refactor analysis) -> `docs/proposals/`. Reference it from the session log via relative path.
4. Diagnostic `.py` / `.js` / `.html` artefacts produced during investigation -> `docs/development/diagnostics/`, prefixed with the agent ID for traceability.

**One-doc-per-topic in `docs/proposals/` (MANDATORY):** the proposals folder contains ONLY currently-active design proposals — exactly ONE document per topic. Preparation analyses, older revisions, superseded versions, and research Q&A docs that fed into a proposal must be archived to `docs/proposals/archive/`. When you produce a NEW proposal that supersedes an existing one, archive the prior version (via `git mv`) BEFORE adding the new one. When proposal work fans out into multiple investigation docs (e.g. analysis + experiment + plan), the FINAL plan stays in `docs/proposals/`; the supporting docs go to `docs/proposals/archive/` with cross-references in the plan's "Investigation history" footer pointing to the archived paths. Once a proposal has been fully implemented, archive it too — `docs/proposals/` is for *future-work* designs, not historical records.

**Single-source-of-truth for plans (MANDATORY):** a planning document MUST NOT reference older versions of itself or earlier supersededs of the same plan. The current plan is the single source of truth — readers should never have to "compare against the previous version" to understand what's authoritative. Allowed references from a plan: research/measurement docs, analysis docs, code reviews, architecture docs, module reference docs, external-system specs (anything that's NOT another planning document on the same topic). When a new plan supersedes an old one, copy any still-relevant context FORWARD into the new plan body — don't link backward to the archived old plan. The "Investigation history" footer (when used) lists the supporting research/analysis docs only, never prior planning revisions.

## Step 0: Initialize Session

### Generate Agent ID

Every dev agent session has a unique identifier used in logs, WIP references, commits, and lock records.

```bash
AGENT_ID="dev-$(openssl rand -hex 2)"   # e.g. dev-a3f1
```

**Agent ID persistence rule:** When an agent is **restarted after a lock conflict** or **recovered after abnormal termination**, the new session MUST reuse the original agent's ID. This keeps log references, WIP entries, commit prefixes, and lock records consistent. Only generate a fresh ID for genuinely new tasks.

### Create Session Log

```bash
LOG_FILE="docs/development/logs/${AGENT_ID}-$(date +%Y-%m-%d-%H%M%S).md"
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

**Logging rule:** Log each step to your session log as you start it, with a timestamp and brief description. Update the log BEFORE starting the step's work, not after. This includes Steps 1-10 — not just initialization. The session log is how the orchestrator monitors your progress.

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

### Step 0 Completion Marker

Once the log file exists, the WIP entry is added, and (if any) initial locks are acquired, emit `[STEP-0-COMPLETE] 2026-05-05T12:30:22Z` as the FIRST line under `## Actions` in your session log. The controller computes `spawn → STEP-0-COMPLETE` delta:
- Tier-1 warn if Step 0 takes longer than 120 seconds
- Tier-2 escalate if Step 0 takes longer than 300 seconds

These are not new requirements — they are the existing Step 0 rules with explicit timing. A controller is always active in orchestrator-driven sessions and watches every dev agent's session log.

**Do not idle after `[STEP-0-COMPLETE]`.** Proceed directly into Step 1 (or Step 0b for a resume) and start emitting `[PROGRESS]` heartbeats. An agent that completes Step 0 then stops producing markers is flagged as idle-after-step by the controller's fast freshness check (> 8 min silent) within minutes, and will be nudged or re-spawned. A multi-step task is yours to carry through autonomously — don't stop and wait after the initial step.

**Helper script (optional — collapses this scaffold into one turn).** `python tools/dev-pipeline/dev_init.py "<task>" [--agent-id dev-xxxx] [--branch feature/x --repo PianoidCore] [--plan docs/proposals/x.md]` generates the agent ID, writes the byte-faithful log header (with `[STEP-0-COMPLETE]` as the first `## Actions` line), adds the WIP `## Active Dev Sessions` row, and optionally creates the branch — then prints the agent ID + log path. Opus still owns the judgment the script never touches: whether to branch vs work on dev, and lock acquisition. See `tools/dev-pipeline/README.md`.

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
### Step N: <Step Name> — 2026-05-05T12:30:22Z
- <what was done: files read, commands run, decisions made>
- <outcomes, metrics, errors encountered>
```

Step heading timestamps use **ISO 8601 UTC** (`$(date -u +%Y-%m-%dT%H:%M:%SZ)`), not local `HH:MM`. The earlier `HH:MM` form is ambiguous across day boundaries — a step that began at 23:50 and was logged again at 00:10 cannot be ordered without a date. The controller's invariant checks (Step-0 SLA, debug-iteration counts, Phase-1/2 ordering) require unambiguous timestamps.

Keep entries concise — bullet points, not prose. The log is a breadcrumb trail, not a narrative.

### Marker Convention

In addition to step headings, dev agents emit explicit **markers** at action boundaries. Markers are short bracketed tags written on their own line in the session log; they supplement (do not replace) step headings and structured sections like `## Data Model Card` and `## Pause Snapshot`. The controller reads these markers to enforce workflow invariants reliably without grep-style heuristics.

**Format rules:**
- Each marker appears on its own line at column 0
- Starts with `[MARKER NAME]` in square brackets — spaces or hyphens inside the brackets are both accepted
- When a marker carries a timestamp, the timestamp follows the closing bracket: `[BUILD STARTED] 2026-05-05T12:30:22Z mode=heavy variant=release`
- Fields use `key=value`; values containing spaces are quoted (`name="my file.py"`); multiple fields are space-separated
- Emitted by the agent's own `Edit`/`Write` to the session log file — no special tooling required
- Coexists with existing narrative entries; markers are additive

**Catalogue (each step section below specifies which markers to emit and when):**

| Marker | Where emitted | What it captures |
|---|---|---|
| `[STEP-0-COMPLETE] {ts}` | First line under `## Actions` once log + WIP + locks set | Step-0 SLA gate |
| `[LOCK ACQUIRED] {file}` | When adding a file to lock row | Lock-acquire intent |
| `[LOCK RELEASED] {file}` | When removing a file from lock row | Lock-release intent |
| `[STEP-1B-KILL] port=<N> pid=<N>` | Step 1b before any port-scoped `taskkill` | Port-scoped kill |
| `[STEP-1B-VENV-CHECK] interpreter=<path>` | Step 1b once before first venv use | Confirms venv interpreter |
| `[SERVER-START] role=<r> port=<N> pid=<N>` | After starting a server | Server lifecycle start |
| `[SERVER-STOP] port=<N> pid=<N>` | At cleanup or exit | Server lifecycle end |
| `[DMC-COMPLETE]` | End of Data Model Card section | Card complete signal |
| `[EDIT] file=<path>` | After each Edit/Write batch on a source file | Edit operation log |
| `[FILE-LOC] <path> before=<N> after=<N>` | After edit batch on a file | C4 threshold tracking |
| `[BUILD-PRECHECK] holders=<...>` | Before any build invocation | Pre-build hygiene |
| `[BUILD STARTED] {ts} mode=<m> variant=<v>` | Before build invocation | Canonical build start |
| `[BUILD OK] {ts} duration=<s> marker=<s> verified=<y\|n>` | On build success | Build success + verification |
| `[BUILD FAILED] {ts} code=<N> error_summary=<one-line>` | On build failure | Build failure |
| `[TEST-WRITTEN] path=<...>` | Before fn-spawn | Test exists before sub-agent |
| `[FN-SPAWNED] id=<...> target=<...>` | At fn-spawn | fn-spawn record |
| `[FN-RESULT] id=<...> status=<ok\|fail>` | After fn-results incorporated | fn-completion record |
| `[BASELINE-TEST] {ts} result=<pass\|fail> ...` | After Step 2 | Baseline ran before Step 4 |
| `[REGRESSION-CHECK] {ts} ... verdict=<v>` | After Step 5 | Post-change perf summary |
| `[REGRESSION-DETECTED] {ts} file=<f> metric=<m> delta=<d>` | After Step 5 if verdict=fail | Per-metric regression record |
| `[STEP-6-DEBUG iter=<N>]` | Each debug iteration | Debug-iteration counter |
| `[VERIFY-INVOKE] skill=<...> mode=<...>` | Step 7 audio verification | Mode-routing record |
| `[STEP-8-COMPLETE] {ts} docs_touched=<...>` | End of Step 8 | Doc update done |
| `[DOC-GAP] description=<...> resolution=<...>` | Step 8 if gap found | Doc-gap closure record |
| `[STEP-10A-PHASE-1] {ts} commit=<sha>` | Step 10a Phase 1 complete | Phase 1 boundary |
| `[STEP-10A-PHASE-2] {ts}` | Step 10a Phase 2 start | Phase 2 boundary |
| `[STEP-10B-RESET] {ts} phase=<start\|done>` | Step 10b boundaries | Reset completeness |
| `[STEP-10C-PAUSE] {ts}` | Start of Step 10c | Pause start marker |
| `[STEP-10E-RESTART] {ts} blocking_agent=<id>` | Start of Step 10e | Restart-after-lock marker |
| `[BASH-CALL] {ts} {cmd_summary}` | Before every Bash invocation | Bash-call boundary |
| `[BASH-RETURN] {ts} duration_ms=<N> exit_code=<N>` | After every Bash return | Bash-return boundary |
| `[MCP-CALL] {ts} server=<name> tool=<name> args_summary=<...>` | Before every MCP tool invocation | MCP-call boundary |
| `[MCP-RETURN] {ts} duration_ms=<N> status=<ok\|error>` | After every MCP tool return | MCP-return boundary |
| `[READ] {ts} path=<path>` | Before every `Read` on a project file | Read operation log |
| `[GREP] {ts} pattern=<pattern> path=<path>` | Before every `Grep`/`Glob` on project files | Grep/Glob operation log |
| `[PROGRESS] {ts} step=<N> note=<...>` | At every step heading AND ≥ every 3 min during any long op | Liveness heartbeat (freshness) |
| `[PERM-RISK] {ts} action=<...> method=<...> gate-risk=<...>` | Before any gate-risky action (process-spawn, taskkill, mcp-auth) | Permission-risk pre-marker |

**Backwards compatibility.** Archived dev session logs predating this convention lack these markers — that's expected. Only new sessions are subject to the marker rules.

### Bash & MCP Discipline (cross-cutting)

Applies to **every** step that runs `Bash` or invokes an MCP tool. Without these markers, the controller cannot detect agents that stalled on a CLI permission prompt invisible to the Telegram user (the dominant stall pattern per `.claude/CLAUDE.md` "Known gaps in `bypassPermissions`").

- **Before every `Bash` invocation:** emit `[BASH-CALL] {ts} {first 80 chars of command, escaped}` to the session log
- **After every `Bash` return:** emit `[BASH-RETURN] {ts} duration_ms=<N> exit_code=<N>`
- **Before every MCP tool invocation:** emit `[MCP-CALL] {ts} server=<name> tool=<name> args_summary=<first 80 chars>`
- **After every MCP tool return:** emit `[MCP-RETURN] {ts} duration_ms=<N> status=<ok\|error>`

The pairs are **load-bearing** — an unmatched `[BASH-CALL]` or `[MCP-CALL]`, or a `[PROGRESS]` heartbeat, older than `STALL_THRESHOLD = 8 minutes` is the controller's primary signal that the agent has stalled (Tier-2). Older than 20 minutes is Tier-3. A trailing `[PERM-RISK]` marker escalates immediately, without waiting for the threshold — it is the strongest single signal of a CLI permission stall.

Failure to emit these markers is itself a Tier-2 violation — the controller cannot enforce stall detection or pre-emptive gating-pattern flagging without them.

### Read & Grep Discipline (cross-cutting)

Applies to **every** investigation phase: Step 1 (Understand Context), Step 5 (Test), Step 6 (Debug), Step 7 (Verify). Without these markers, the controller cannot enforce the CLAUDE.md "Documentation-First Rule (MANDATORY)".

- **Before every `Read` invocation on a project file:** emit `[READ] {ts} path=<path>`
- **Before every `Grep`/`Glob` invocation on project files:** emit `[GREP] {ts} pattern=<pattern> path=<path>`

The controller maintains a sliding window over the last 3 non-NEUTRAL events (per agent, per investigation phase). Three source-reads with no preceding doc-read in the window is a violation: Tier-1 first occurrence per session, Tier-2 if it recurs.

Exemptions (the controller suppresses violations under these conditions):
- Syntactic / mechanical tasks (rename, replace, move file, lint fix)
- Doc-internal navigation (`Grep` on markdown headings within `docs/`, `Glob` restricted to `docs/`)
- Single-source-file deep-dive after a doc-read pointed to it (next 5 reads of THAT file are exempt)

Failure to emit these markers is itself a Tier-2 violation.

Keep entries concise — bullet points, not prose. The log is a breadcrumb trail, not a narrative.

### Heartbeat & Permission-Risk Discipline (cross-cutting)

**Heartbeat (MANDATORY).** Emit `[PROGRESS] {ts} step=<N> note=<short>` (a) at every step boundary alongside the `### Step N` heading, and (b) at least every **3 minutes** during any operation that runs longer than that — `--heavy` builds, full pytest, ESPRIT/modal derivations, `/test-ui` or `/diagnose` invocations, or any extended analysis stretch with no tool calls. Emit one `[PROGRESS]` *before* a long op starts and again whenever you regain control. The controller's fast freshness check (every 3 min) flags any active agent whose log has gained no new marker for > **8 minutes** as STALLED — a live agent's log is therefore never silent longer than ~3 min.

**Permission-risk pre-marker (MANDATORY).** Before any action that may trip a CLI permission prompt (see `.claude/CLAUDE.md` "Known gaps in `bypassPermissions`") — process-spawn via `run_in_background`/`Start-Process`, `taskkill`/`Stop-Process` on a non-trivial PID, an MCP tool whose name matches `*auth*|*pair*|*init*`, or any TTY-opening Bash — emit `[PERM-RISK] {ts} action=<desc> method=<bash-bg|start-process|launcher-rest|taskkill|mcp-auth|...> gate-risk=<why>` **first**, then the `[BASH-CALL]`/`[MCP-CALL]`. If you then stall, this marker pinpoints the prompting action so the orchestrator can re-route you to a no-prompt method instead of relaying the invisible prompt to the user. Emit `[PERM-RISK] method=launcher-rest` even for the safe launcher-REST path, to record that the no-prompt method was chosen.

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
cd PianoidCore
git checkout <branch-name>
git log --oneline -5   # verify you're on the right branch with the WIP commit

# If paused via stash:
cd PianoidCore
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

1. `docs\index.md` — big picture, module map
2. `docs\architecture\SYSTEM_OVERVIEW.md` — 4-layer stack, threading, lifecycle
3. `docs\architecture\DATA_FLOWS.md` — trace the relevant data flow
4. Drill into the specific module doc:
   - CUDA engine: `docs/modules/pianoid-cuda/*.md`
   - Middleware: `docs/modules/pianoid-middleware/*.md`
   - Domain model: `docs/modules/pianoid-basic/OVERVIEW.md`
   - Frontend: `docs/modules/pianoid-tunner/OVERVIEW.md`
5. Read the actual source files identified from the docs
6. Check `docs/development/WORK_IN_PROGRESS.md` for related ongoing work

**Documentation-First compliance (controller-monitored).** The `[READ]` / `[GREP]` discipline above feeds the controller's Documentation-First compliance check. Skipping `docs/` and going straight to source greps in this step (or in Steps 5/6/7) is detected as a Tier-1 warn (first occurrence per session) or Tier-2 escalate (recurring). Exemptions: syntactic/mechanical tasks; doc-internal navigation; deep-dive on a specific source file the doc pointed to.

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

## Step 1b: Environment Control (MANDATORY)

**You own the environment AND the full operational loop. NEVER ask the user to start/stop servers, check processes, refresh/close browser tabs, run captures, paste console logs, or drive the repro/test for you. NEVER rely on servers already running. Always take full control.**

**When you hit an operational blocker — a server won't start or won't stay up, a tab needs a fresh load, the backend keeps dropping — the answer is ALWAYS a documented procedure, NEVER offloading the step to the user.** A persistent operational blocker means you haven't found or applied the right documented procedure yet — not that the task needs the user. The most common trap: the backend won't stay up because it was started via Bash / `cmd` / `run_in_background`, which (a) hits the harness long-running-process permission gate that prompts even under `bypassPermissions` (so the process just looks "stuck"), and (b) gets reaped / Flask-reloader-orphaned after ~30–120 s. The documented fix is `Start-Process -WindowStyle Hidden` with redirected output (or the launcher REST API) — see the startup hierarchy below + `docs/guides/UI_TESTING.md` / `docs/guides/STARTUP_TROUBLESHOOTING.md`. Solve it; do not escalate it to the user.

### Kill Stale Processes

Before running any tests, builds, or starting the backend, **always** kill existing Pianoid backend and frontend processes. Stale instances from previous sessions cause port conflicts and distorted audio output (two audio drivers fighting over the sound device).

**CRITICAL: Only kill processes bound to Pianoid ports — NEVER use blanket `taskkill //F //IM python.exe` or `taskkill //F //IM node.exe`.** Those commands kill MCP servers (WhatsApp, email, Google Workspace), Chrome DevTools, and even Claude Code itself (node.exe), crashing the orchestrator session.

```bash
# Kill ONLY processes on Pianoid ports (5000=backend, 5001=modal adapter, 3000/3001=frontend)
for port in 5000 5001 3000 3001; do
  pid=$(netstat -ano 2>/dev/null | grep ":${port} .*LISTENING" | awk '{print $NF}' | head -1)
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    echo "Killing PID $pid on port $port"
    taskkill //F //PID "$pid" 2>/dev/null
  fi
done
# Wait for ports to release
sleep 2
# Verify ports are free
netstat -ano 2>/dev/null | grep -E ":(3000|3001|5000|5001) " && echo "WARNING: ports still in use" || echo "Ports clear"
```

**This applies every time** — even if you think nothing is running. Previous sub-agents or user sessions may have left orphaned processes. Distorted sound is the #1 symptom of skipping this step.

**Markers (MANDATORY):** for each port-scoped kill above, emit `[STEP-1B-KILL] port=<N> pid=<N>` to the session log. The **absence** of `[STEP-1B-KILL]` markers around a `taskkill` invocation is the controller's smoking gun for blanket-kill (`taskkill //F //IM python.exe` / `node.exe`), which is a Tier-3 halt.

### Start Servers With Correct Venv

When the task requires a running backend, **start it yourself** — using the no-prompt method hierarchy (full detail in *Recommended startup hierarchy* below):
1. **PREFERRED — launcher REST** (`curl -X POST http://127.0.0.1:3001/api/start-backend`): an HTTP call, NO process-spawn → never trips the permission gate. Use this whenever a launcher is up.
2. **FALLBACK — `Start-Process -WindowStyle Hidden`** (detached, redirected output): survives long-running, though a fresh process can trip the long-running-process gate once per session.
3. **LAST RESORT — `Bash run_in_background: true`**: trips the gate AND gets reaped / Flask-reloader-orphaned (~30–120 s). Only if 1 + 2 are impossible.

Emit `[PERM-RISK] {ts} action="start backend" method=<launcher-rest|start-process|bash-bg> gate-risk=<...>` **before** any start attempt (per *Heartbeat & Permission-Risk Discipline*). The `Bash run_in_background` example below is the LAST-RESORT form (NOT shell `&`, which the Bash tool reports as immediate exit):

```bash
# Backend server (port 5000) — CWD must be pianoid_middleware for relative preset paths
cd PianoidCore/pianoid_middleware && ../.venv/Scripts/python -u backendserver.py > /tmp/backend.log 2>&1
```
Pass `run_in_background: true` to the Bash tool. Do NOT use shell `&` — it causes the Bash tool to report immediate exit.

Then verify in a separate Bash call:
```bash
# Wait for startup and verify
sleep 2 && netstat -ano 2>/dev/null | grep ":5000 .*LISTENING" && curl -s http://127.0.0.1:5000/health | head -3
```

If the port is not listening, read the log to diagnose:
```bash
cat /tmp/backend.log
```

**Modal adapter server (port 5001)** — same pattern:
```bash
cd PianoidCore/pianoid_middleware && ../.venv/Scripts/python -u modal_adapter/modal_adapter_server.py > /tmp/modal_adapter.log 2>&1
```

**Rules:**
- Before the first venv invocation in this session, emit `[STEP-1B-VENV-CHECK] interpreter=<absolute path>` (e.g., `interpreter=D:/repos/PianoidInstall/PianoidCore/.venv/Scripts/python.exe`). The controller flags any subsequent `python` Bash call lacking the matching prefix as a Tier-2 violation.
- Always use `PianoidCore/.venv/Scripts/python`, NEVER system Python (`C:\Python312\python.exe`)
- Always set CWD to `pianoid_middleware/` before starting — preset paths are relative
- Always use `run_in_background: true` on the Bash tool, NOT shell `&`
- Always redirect output to a log file for diagnostics
- Always verify with port check + endpoint test after startup
- After successful server start, emit `[SERVER-START] role=<backend\|frontend\|adapter> port=<N> pid=<N>`. After shutdown (in any exit path), emit a matching `[SERVER-STOP] port=<N> pid=<N>`. The controller verifies every START has a matching STOP before the agent transitions to CLOSED.
- If the server crashes on startup, read the log file to diagnose — do not ask the user
- If startup fails 3 times, report the log contents and stop — do not loop indefinitely

### Backend startup failure modes & workarounds

**Flask debug-reloader child-takeover.** `backendServer.py` runs `socketio.run(debug=True)` which enables Werkzeug's auto-reloader. The reloader spawns a child Python process to be the actual server, and the parent (which the bash tool was tracking via `run_in_background: true`) exits. The bash tool's process management may then reap the orphaned child after ~2 minutes, taking the backend down. Symptom: backend works for a couple of minutes after start, then port 5000 stops responding. (Tracked in `WORK_IN_PROGRESS.md` under deferred follow-ups; proper fix is gating `debug=True` behind `PIANOID_FLASK_DEBUG=1` env var.)

**Long-running-process harness gate.** The Claude Code harness has a "long-running process" detector that gates regardless of permission mode — even with `mode: "bypassPermissions"`, the first attempt to start a backend via `Bash run_in_background: true` may trigger a CLI prompt that's invisible to the user when they're on Telegram. (See `.claude/CLAUDE.md` "Orchestrator Sub-Agent Permission Rule — Known gaps in `bypassPermissions`".) Each retry triggers another prompt — do NOT keep retrying.

**Recommended startup hierarchy:**

1. **PREFERRED: launcher REST API.** If the launcher is already running on port 3001, ask it to start the backend:
   ```bash
   curl -X POST http://127.0.0.1:3001/api/start-backend
   ```
   The launcher spawns the backend as ITS child process with proper lifecycle management — no harness gate, no Flask-reloader-orphan trap. This is the pattern the user's normal startup (via React frontend "APPLY" button) uses.

2. **FALLBACK: PowerShell `Start-Process -WindowStyle Hidden` with redirected output.** Properly detaches the process so neither the bash tool's process management nor the harness gate interferes:
   ```powershell
   Start-Process -WindowStyle Hidden -FilePath "D:/repos/PianoidInstall/PianoidCore/.venv/Scripts/python.exe" -ArgumentList "-u","backendserver.py" -WorkingDirectory "D:/repos/PianoidInstall/PianoidCore/pianoid_middleware" -RedirectStandardOutput "D:/tmp/backend.log" -RedirectStandardError "D:/tmp/backend.err"
   ```
   Note: PowerShell Start-Process on a fresh process can ALSO trigger the long-running-process gate the first time per session. If it does, escalate to the orchestrator via SendMessage rather than retrying.

3. **LAST RESORT: Bash `run_in_background: true`** as documented above. Works in most cases but is vulnerable to Flask reloader child-takeover after ~2 minutes; if backend dies mid-session use option 1 instead of restarting via this pattern.

**Escalation rule.** If options 1 + 2 both fail, SendMessage the orchestrator. The orchestrator's own Bash calls render in its conversation as tool deltas which the orchestrator can see; it can either approve any prompt that fires OR start the server itself OR pre-allow the specific Bash invocation in `settings.local.json`.

### Clean Up After Yourself (MANDATORY)

**Full clearance before every handoff (MANDATORY).** Every agent MUST leave the environment fully cleared when it exits — regardless of exit path (wrap-up, reset, pause, or any abnormal termination). Full clearance means **(a) all Pianoid servers down** — nothing left listening on ports 3000/3001/5000/5001 — and **(b) your working tree clean** — every change committed, stashed, or reverted, with temporary debug/instrumentation **reverted** (never committed), and your locks released. The user must always receive a clean, ready-to-restart slate; a running server OR a dirty tree at handoff is a severe violation. (Exception: if the orchestrator has told you a concurrent agent is actively using the stack, shut down only what you started, leave its servers up, and report the rest to the orchestrator — which owns the final all-down sweep.)

```bash
# Graceful shutdown of servers started by this agent
for port in 5000 5001 3000 3001; do
  pid=$(netstat -ano 2>/dev/null | grep ":${port} .*LISTENING" | awk '{print $NF}' | head -1)
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    echo "Cleaning up: killing PID $pid on port $port"
    taskkill //F //PID "$pid" 2>/dev/null
  fi
done
```

**Rules:**
- The sweep above kills every listener on 3000/3001/5000/5001 — at handoff, ALL Pianoid servers come down, not only the ones you started (unless the orchestrator flagged a concurrent agent still using the stack)
- Your working tree must be clean at handoff: commit or stash real work, and **revert** temporary debug/instrumentation rather than committing it — a dirty tree is not a clean handoff
- Include clearance in ALL exit paths: Step 10a (wrap-up), Step 10b (reset), Step 10c (pause), and error/exception paths
- The user should never have to clean up after an agent — leaving stale processes OR uncommitted changes is a severe violation
- If the agent used chrome-devtools to open a browser, close the page before exiting

## Step 2: Baseline Performance Test

Before any code changes, run the performance test suite and save results:

```bash
cd PianoidCore
.venv/Scripts/python -m pytest tests/system/test_performance_audio_off.py -v -s 2>&1 | tee /tmp/baseline_perf.log
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

**Marker (MANDATORY):** after baseline tests pass, emit `[BASELINE-TEST] 2026-05-05T12:30:22Z result=<pass\|fail> perf_log=/tmp/baseline_perf.log gpu_mean_ms=<N> sound_corr=<N>`. The controller alerts if Step 4 edit markers appear without a preceding `[BASELINE-TEST] result=pass` (Tier-1 warn).

## Step 3: Branch (if needed)

**Non-trivial changes** (new features, refactors, multi-file edits):
```bash
git -C "PianoidCore" checkout dev
git -C "PianoidCore" pull origin dev
git -C "PianoidCore" checkout -b feature/<short-description>
```

**Small fixes** (single-file, low risk): work directly on `dev`.

Ask the user which approach if unclear.

## Step 4: Acquire Module Locks and Edit Code

### Before you write a single line

Answer these two questions out loud (in your session log):

1. **(P1 Authority)** Which piece of state am I about to touch, and who is its sole owner? If the change makes a non-owner write it, stop — either move the work to the owner, or redesign ownership first.
2. **(P2 Concern)** What is the single concern of every module I'm editing? Is the change within each module's existing concern, or does it widen the module's responsibility? Concern bleed is not acceptable — find or create a module whose job this actually is.

If either answer is unclear or uncomfortable, pause and read `docs/development/CODE_QUALITY.md` — the Primary Principles section at the top. You cannot proceed until both answers are crisp.

### Pre-implementation Data Model Card (MANDATORY)

Before writing the first line of fix code, produce a **Data Model Card** in your session log. The card lists every non-trivial data-model fact the fix depends on, with explicit doc support. Format the heading literally as `## Data Model Card — 2026-05-05T12:30:22Z` (ISO 8601 UTC). Table format:

| Fact the fix relies on | Doc citation (file + section/anchor) | Inferred-only? (Y/N) |
|---|---|---|

After the table, emit `[DMC-COMPLETE]` on its own line to mark the card complete. The controller searches for this marker before any `[EDIT]` line targeting source files; missing or out-of-order DMC is a Tier-2 escalate.

If any row is marked "inferred-only" (i.e. you could not find doc support and are reasoning from source code), **PAUSE** before editing and either (a) route the question to the orchestrator/user via SendMessage, or (b) close the doc gap *first* — confirm with measurement against the engine, then write the doc, then proceed with the fix. Source-code-only inference about data-model facts is the failure mode that produced two consecutive wrong diagnoses in dev-833f (Phase A endpoint mismatch, Phase B value-scale mismatch on the SoundChannels silence bug, 2026-04-30) before the third measurement-based diagnosis succeeded.

**See the cross-cutting "High-stakes inference categories" section in `.claude/CLAUDE.md`** for the full list of fact categories where silent inference is forbidden (axis semantics, dimension ordering, index conventions, "stored vs effective" entries, unit ranges, "same name different thing" pairs).

**File-size watch (C4):** Before adding significant code to any file, check its current LOC (`wc -l <file>`). If the file is in YELLOW territory (500–1000 LOC), prefer extraction over insertion. If the file is already RED (>1000 LOC), do not add to it without a split plan — report to the orchestrator and request guidance.

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
- **Lock-before-edit invariant:** Before writing to ANY file not already in your lock list, you MUST first add it to `MODULE_LOCKS.md`. Update your lock row to include the new file. Check for conflicts (another agent holding that file) before proceeding. This applies even when scope expands mid-session — **never edit an unlocked file.**

**Lock markers (MANDATORY):** when adding a file to your lock row, emit `[LOCK ACQUIRED] {file}`. When removing, emit `[LOCK RELEASED] {file}`. The controller cross-references these markers against `MODULE_LOCKS.md` reads — divergence (marker says acquired but file row absent, or marker says released but row still present) is a Tier-2 escalate. The controller detects unlocked dirty files within seconds via `git status` sweeps — not at Step 10a's audit. Treat lock-before-edit as a hard precondition, not a wrap-up reconciliation.

### Multi-Stage Session Management

When a task involves multiple stages or scope expands during implementation:

- **Commit intermediate work.** Don't accumulate all changes for one final commit. After completing a logical unit (e.g., a bug fix, a backend change before starting frontend), commit what you have. Use the agent ID prefix: `[dev-XXXX] feat: <what this intermediate commit does>`.
- **Release locks on completed files.** If you're done with a file and moving to a different stage, release its lock in MODULE_LOCKS.md. Only hold locks on files you are actively editing or plan to edit next.
- **Acquire new locks as needed.** When scope expands to new files, add them to your lock row before editing. This keeps the lock registry accurate at all times.
- **Keep the "Files Modified" log section current.** Every file you edit must appear in your session log's Files Modified list — update it as you go, not just at the end.

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

**Edit markers (MANDATORY):** after each batch of `Edit`/`Write` calls on a tracked source file, emit `[EDIT] file=<path>`. After you finish editing a file, run `wc -l <path>` and emit `[FILE-LOC] <path> before=<N> after=<N>` (use the pre-edit LOC from the lock-acquisition snapshot). The controller flags threshold crosses (`before<500 && after>=500` or `before<1000 && after>=1000`) as Tier-1 warn — these correspond to C4 YELLOW and RED transitions and require updating `CODE_QUALITY.md` God Objects list in Step 8.

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

**Pre-build marker (MANDATORY):** after running the precheck above, emit `[BUILD-PRECHECK] holders=<comma-separated-pids or "none">` to the session log. The controller alerts if `[BUILD STARTED]` appears without a preceding `[BUILD-PRECHECK]` (Tier-2 escalate).

**Build commands:** The build script MUST be invoked from `PianoidCore/` using its own `.venv`. Clear `VIRTUAL_ENV` first to prevent the script from installing into the wrong venv (see `docs/architecture/BUILD_SYSTEM.md` — the script uses `%REPO_ROOT%.venv`).

| Changed Files | Build Command |
|--------------|---------------|
| `pianoid_cuda/*.cu`, `*.cpp`, `*.h`, `*.cuh`, `setup.py` | see below (heavy) |
| `pianoid_middleware/*.py` only | see below (light) |
| PianoidBasic `*.py` | `cd /d PianoidCore && .\build_pianoid_basic.bat` (detached `Start-Process` in agent ctx) |
| `tests/**` only | No rebuild needed |

**CUDA build — agent context (DETACHED + `--both`; `cmd //c` gate-stalls DESTRUCTIVELY here).** Stop the `.pyd` holder first (launcher REST `POST /api/stop-backend`, or a PID-targeted kill — never `//IM python.exe`), then build detached (`--heavy` = C++/CUDA changes; `--light` = Python-only middleware):
```powershell
Start-Process -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList `
  '/c','set "VIRTUAL_ENV=D:\repos\PianoidInstall\PianoidCore\.venv" && cd /d D:\repos\PianoidInstall\PianoidCore && D:\repos\PianoidInstall\PianoidCore\build_pianoid_cuda.bat --heavy --both > D:\tmp\build.log 2>&1' -PassThru
# --light --both for middleware-only. ABSOLUTE bat path after cd /d (a bare name fails "not recognized", L-2).
# Poll D:\tmp\build.log; done at "[SUCCESS] Build completed". Full procedure: BUILD_SYSTEM.md → Canonical Install / Rebuild.
```

**Helper script (optional — the whole procedure above in one call).** `python tools/dev-pipeline/build_pianoid.py --heavy --both [--marker "<string from your edit>"]`: precheck `.pyd` holders → stop the holder FIRST (launcher REST, else PID-targeted, never `//IM`) → launch the detached build (absolute bat path) → poll the log for `[SUCCESS]` → grep-verify the `.pyd` for your marker → emit `[BUILD STARTED]`/`[BUILD OK]`/`[BUILD FAIL]`. It NEVER pip-installs (the stale-`.pyd` trap) and ABORTS rather than build against a held `.pyd` (the venv-brick guard). **Build-failure diagnosis stays Opus** — on `[BUILD FAIL]` it tails the log + flags the exit code (incl. 0xC0000142); you apply the documented recovery below. See `tools/dev-pipeline/README.md`.

**If the build fails with exit code `3221225794` (0xC0000142 STATUS_DLL_INIT_FAILED):**

Do NOT fall back to a manual `pip install --force-reinstall ... pianoid_cuda/` — that silently
returns a stale cached `.pyd` and your edit never lands. Instead, follow the recovery steps
documented in
[`docs/architecture/BUILD_SYSTEM.md` — 0xC0000142 Recovery](../../docs/architecture/BUILD_SYSTEM.md#0xc0000142-recovery-status_dll_init_failed):
delete `%TEMP%\pip-build-env-*`, `pip cache purge`, then re-run the canonical `build_pianoid_cuda.bat`.

**Post-build verification:**
```bash
PianoidCore/.venv/Scripts/python -c "import pianoidCuda; print(pianoidCuda.__file__)"
```
Verify the path is inside `PianoidCore/.venv/` (not root `.venv/`).

**Build markers (MANDATORY):** wrap each build invocation in a marker triple.
- **Before** the build: `[BUILD STARTED] 2026-05-05T12:30:22Z mode=<heavy\|light> variant=<release\|debug>`
- **On success:** `[BUILD OK] 2026-05-05T12:30:55Z duration=<seconds> marker=<grep-string-used-to-verify> verified=<yes\|no>`
- **On failure:** `[BUILD FAILED] 2026-05-05T12:30:55Z code=<exit-code> error_summary=<one-line>`

The controller alerts if Step 5 begins without a preceding `[BUILD OK] verified=yes` (Tier-1 warn). Any `pip install ... pianoid_cuda/` invocation lacking a paired `[BUILD STARTED]` is the canonical-build-script violation (Tier-2 escalate).

## Step 4b: Delegate to `/fn` Sub-Agents (preferred)

When a task can be decomposed into functions with clear requirements and testable acceptance criteria, **prefer delegating to `/fn` sub-agents** over editing code inline. This applies whether there's one function or many — the value is in enforced requirements clarity and test-driven implementation, not just parallelism.

### DeepSeek codegen offload (via `/fn`)

Function-level work delegated to `/fn` can have its codegen step offloaded to **DeepSeek** (the `deepseek-codegen` MCP tool, wired into `/fn` Step 2a) — cheaper + faster for routine function bodies, with Claude still owning the spec, test, review, build, debug, and commit. The dev agent does NOT call DeepSeek directly; it flows through the `/fn` sub-agent, and only when eligible.

- **WHEN (all must hold):** target is Python (`.py`/pytest) or JS/TS/React (`.js/.jsx/.ts/.tsx`/Jest — PianoidTunner frontend included), or any language with a fast isolated test gate; a single, pure, well-specified unit (the `/fn` envelope); and the test is written FIRST (see "Prepare tests FIRST" below). These are the same delegate-to-`/fn` conditions — DeepSeek just generates the body inside that envelope.
- **HARD RULE — never DeepSeek:** any `.cu/.cpp/.cuh/.h/setup.py` (CUDA/C++) change, and any cross-cutting or multi-file refactor, stays on **Claude `/dev`** — the dev agent implements these itself and does not route them to `/fn` for offload. (The MCP tool also refuses C++/CUDA as a backstop, but the gate is the dev agent's routing decision first.)
- **SAFETY:** DeepSeek output is never trusted, only tested — the Claude-written test is the gate. If the generated body fails the Step-4b debug loop, fall back to a Claude implementation. DeepSeek never writes files, never commits, never updates docs.

Mechanism + setup: `/fn` Step 2a and `tools/deepseek-codegen-mcp/README.md`.

**Dual-backend tests for array-agnostic functions (MANDATORY).** When a function takes an array module (`xp`, numpy/cupy/torch), the test you prepare FIRST must exercise **both** numpy AND cupy — a numpy-only test ships latent cupy bugs (the 2026-06-06 A/B shipped a `cupy + numpy` add the numpy-only gate never caught). See the dual-backend rule in `/fn` Step 2a; it governs the tests `/dev` writes before delegating, too.

**Batching interdependent functions — declare deps.** When you route **≥2** functions to DeepSeek where some call others, use the **batch pipeline** (`tools/deepseek-codegen-mcp/batch_pipeline.py`) and DECLARE the dependency edges (each function's `meta.json` `deps` = the sibling helpers it may call). The pipeline then builds leaf helpers first and exposes them in the delegate prompt — otherwise each function is delegated in isolation and DeepSeek **re-implements** shared logic (in the 2026-06-06 A/B it re-implemented `compute_mac` in two functions and re-derived a helper instead of calling it). **Same rule for React:** a component that composes a shared component declares it as a dep, so the shared component is built first and its prop interface exposed — don't let DeepSeek re-create a `NumInput` (divergent styling/a11y/debounce that a Jest test rarely asserts).

### When to delegate

- The function has clear inputs, outputs, and behavior that can be specified upfront
- Acceptance criteria can be expressed as a test (unit, integration, or system)
- The function can be implemented and verified independently

### When NOT to delegate

- The change is a cross-cutting refactor (rename across many call sites, structural reorganization)
- The function's behavior can only be verified through the full system (no isolated test possible)
- The change is so trivial that writing the spec would take longer than the edit

### Context hygiene & spawn-cost discipline (cost control)

Every Opus turn re-reads the agent's **entire accumulated context** as cache-read before it does anything — that re-read (not the work) is ~65% of cost. So the levers are: make fewer turns, and keep each turn's resident context small. Apply these to this agent AND to how it shapes `/fn` work:

- **Read narrowly.** Read the target function span with `offset`/`limit`, not the whole file, when one function is in scope. Read the one gating test, not the whole suite / `SUITE.md`.
- **Test once at the end** of a function, not after each speculative edit (review-on-red). The 4×-incremental-pytest pattern re-reads ~50k each time — three wasted turns ≈ $0.13 on a 3-function run.
- **Prune stale tool output.** Once a function is green, don't keep its full diff + every intermediate pytest dump resident — summarize to one line in the **session log** (the durable record) and move on. Prune *stale* output, never *load-bearing* context (Data Model Card facts, the spec, the current test).
- **Don't fan out Opus `/fn` workers for small units.** A fresh Opus sub-agent re-pays a fixed **~$0.15 startup tax** (harness + `CLAUDE.md` prefix), so N isolated Opus workers LOSE to one context-pruned agent at every N ≥ 2 (measured: +38% at N=3, +60% at N=10). **Never spawn an Opus sub-agent for a unit of work smaller than ~$0.15 — do it inline or script it.** Group functions that share context (read the same files) into one agent that prunes between them, rather than one worker per function. Fan-out earns its startup tax ONLY paired with a cheap model (the infra-gated cheap-`/fn` lane).

(Full cost model + measurements: `docs/proposals/minimize-opus-calls-dev-pipeline-2026-06-06.md`.)

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

   The controller verifies `/fn` parent-lock inheritance — fn-spawned edits must land on files in the parent dev agent's lock list. New files require the parent to retroactively add them to its own lock row before the fn agent edits, or the controller will Tier-3 halt.

3. **Spawn** — use the `Agent` tool. Independent sub-agents can be spawned in parallel (single message, multiple Agent calls). Use `run_in_background: true` for parallel spawns.

   **Markers (MANDATORY):**
   - Before the spawn: emit `[TEST-WRITTEN] path=<test-file>` (the test the parent prepared in the section above). The controller compares ordering — `[FN-SPAWNED]` without a preceding `[TEST-WRITTEN]` is a Tier-1 warn.
   - At the spawn: emit `[FN-SPAWNED] id=<fn-XXXX> target=<file>`.
   - After the fn results are incorporated into the parent log: emit `[FN-RESULT] id=<fn-XXXX> status=<ok\|fail>`. Step 5 entry in the parent log without all `[FN-RESULT]` lines having `status=ok` (or an explicit `[FN-RETRY]` / `[FN-INLINE-FALLBACK]` follow-up) is a Tier-2 escalate.

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
   ls docs/development/logs/fn-*.md
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
   mv docs/development/logs/fn-*.md docs/development/logs/archive/
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
cd PianoidCore
.venv/Scripts/python -m pytest tests/system/test_performance_audio_off.py -v -s 2>&1 | tee /tmp/postchange_perf.log
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

**Markers (MANDATORY):** after the comparison table, emit `[REGRESSION-CHECK] 2026-05-05T12:30:22Z gpu_mean_delta_pct=<N> sound_corr=<N> verdict=<pass\|warn\|fail>`. On `verdict=fail`, also emit `[REGRESSION-DETECTED] 2026-05-05T12:30:22Z file=<path> metric=<name> delta=<value>` per offending metric. The controller alerts if `[REGRESSION-DETECTED]` is followed by `[STEP-10A-PHASE-1]` without an intervening `[STEP-6-DEBUG]` marker (Tier-2 escalate — regression triggers debug, not commit).

**Helper script (optional — runs the test + parses metrics + builds the delta table + emits the markers in one call).** `python tools/dev-pipeline/run_perf.py --baseline [--out baseline.json]` at Step 3 (writes the baseline JSON + emits `[BASELINE-TEST]`), then `--compare baseline.json` here (prints the Baseline/After/Delta table + emits `[REGRESSION-CHECK]` / `[REGRESSION-DETECTED]` with a `verdict_hint` from the thresholds above; `--audio-on` for the mic variant). **The regression VERDICT stays Opus** — the script computes the deltas + a hint; you decide whether a breach is acceptable for THIS change. See `tools/dev-pipeline/README.md`.

## Step 6: Debug (if tests fail)

**Build failures:** If a build command fails (linker errors, missing libraries, DLL issues),
consult `docs/architecture/BUILD_SYSTEM.md` — especially the Troubleshooting section — before
attempting manual fixes. Common issues (SDL3.lib not found, import failures, `--heavy` vs
`--light` trade-offs) are documented there with diagnosis steps and fixes.

Iterative loop (max 5 iterations):
1. Read failure output — identify root cause, not just symptom
2. Make targeted fix
3. Rebuild if needed (step 4 commands)
4. Re-run failing test only: `.venv/Scripts/python -m pytest tests/system/test_performance_audio_off.py::<TestClass>::<test_name> -v -s`
5. Once that test passes, re-run full suite (step 5)
6. Repeat until all pass

After 5 failed iterations, stop and report findings to the user. Do not keep looping.

**Marker (MANDATORY):** at the start of each debug iteration, emit `[STEP-6-DEBUG iter=<N>]` on its own line (in addition to the `### Step 6: Debug iteration N — <ISO timestamp>` step heading). The controller counts iterations: warn at iter 6, escalate at iter 8.

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

**Marker (MANDATORY):** when invoking `/test-ui` or `/diagnose`, emit `[VERIFY-INVOKE] skill=<test-ui\|diagnose> mode=<audio_off\|audio_on>` to the session log. The controller cross-references the chosen mode against the agent's edited file list (synthesis-output vs mic-engaging classification per `.claude/CLAUDE.md` "Audio Verification Rule"). Wrong mode (e.g., calibration change verified via `/test-ui` instead of `/diagnose`) is a Tier-2 escalate.

### 7b: Automated Tests

Ask the user for acceptance criteria:
- What inputs to test?
- What behavior is expected?
- Edge cases?

Write tests in the appropriate level:
- Full stack (GPU + audio) → `tests/system/`
- GPU, no audio → `tests/integration/`
- Pure Python → `tests/unit/`

Follow patterns from `test_performance_audio_off.py` (fixtures, markers, assertions).

## Step 8: Update Documentation

**This step is mandatory for ALL exit procedures (wrap-up, reset, pause).** Documentation must always reflect the current state of the codebase.

### Doc-gap closure (MANDATORY)

If during the fix you uncovered a documentation gap that contributed to the misdiagnosis or to the difficulty of the fix, **closing that gap is part of THIS session, not a deferred follow-up**. The session is not "done" until either:

  (a) the docs are updated to reflect the now-confirmed truth, OR
  (b) a `WORK_IN_PROGRESS.md` entry is filed with a concrete owner and ETA for closing the gap, AND the session log calls out the deferral explicitly.

"We learned X, but didn't write it down" is a failed wrap-up. The next agent will hit the same trap.

**Principle-namespace cross-reference:** when the change affects any state ownership, module concern, file-size threshold, or patch/workaround handling, cite the relevant principle from `docs/development/CODE_QUALITY.md` (P1/P2, A1–A5, C1–C6, S1–S5). Docs that justify a change by its principle age better than docs that describe what the code does.

**C4 regression check:** if any file in scope crossed the 500 or 1000 LOC threshold during this session, update the "Current Known God Objects" list at the bottom of `CODE_QUALITY.md` accordingly — add new RED entries, remove entries that dropped below threshold after a refactor. Files are listed in decreasing LOC order.

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

**Markers (MANDATORY):**
- At the end of Step 8, emit `[STEP-8-COMPLETE] 2026-05-05T12:30:22Z docs_touched=<comma-separated-paths or "none">`. The controller alerts if `[STEP-10A-PHASE-1]`, `[STEP-10B-RESET]`, or `[STEP-10C-PAUSE]` appears without a preceding `[STEP-8-COMPLETE]` (Tier-2 escalate — Step 8 is mandatory for ALL exit procedures).
- If the session identified a doc gap, emit `[DOC-GAP] description=<one-line> resolution=<doc-edit\|wip-deferred> ref=<file-or-wip-anchor>`. The controller flags log entries that mention "doc gap" / "should be documented" if no doc edit or WIP entry follows before commit (Tier-1 warn).

## Step 9: Merge Feature Branch to Dev

**This step is mandatory when a feature branch was created in Step 3.** Unmerged feature
branches break other systems that install from `dev`.

**Default: merge only after the user has tested the fix on the feature branch and approved it.** Per the standing handoff default (Step 10a Phase 1: stack down, repo left on the feature branch), the user runs their OWN live test first — a passing agent test is NOT approval. Only after the user confirms the fix works and approves the merge:

1. **Merge into dev** for each repo that has a feature branch:
```bash
# Example for PianoidCore
cd PianoidCore
git checkout dev
git merge feature/<name> --no-ff -m "Merge feature/<name> into dev"
git push origin dev

# Example for PianoidBasic (if changed)
cd PianoidBasic
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

### Intermediate Commits

Agents may make as many intermediate commits as needed during development. Use intermediate commits after completing a logical unit of work (e.g., a bug fix before starting the next, backend changes before frontend). This prevents accumulating large uncommitted diffs and makes recovery easier.

```bash
git commit -m "[${AGENT_ID}] <type>: <description of this unit>"
```

Intermediate commits do not require user approval. They are part of normal development flow.

### 10a: Wrap-up (successful implementation)

Wrap-up has two phases: **agent-autonomous** (steps 1-4) and **user-approved** (steps 5-7). The agent completes steps 1-4 and then **stops and reports to the orchestrator/user**. Steps 5-7 only proceed after explicit user approval.

#### Phase 1: Agent-autonomous (do immediately)

Sequence: **Document → Audit locks → Final commit → Release locks**

1. **Verify Step 8 is done** — documentation is up to date
2. **Audit locks vs. dirty files** — run `git diff --name-only` in each repo. Every dirty file must appear in your lock list in `MODULE_LOCKS.md`. If you find unlocked dirty files:
   - Add them to your lock row retroactively (to maintain the invariant during commit)
   - Include them in your commit
   - Log a warning in the session log: "Scope expanded beyond original locks — added retroactive locks for: <files>"
3. **Final commit** — commit any remaining uncommitted changes:
   ```bash
   # PianoidCore changes
   cd PianoidCore
   git add <specific-files>
   git commit -m "[${AGENT_ID}] <type>: <description>"
   ```
   ```bash
   # Documentation changes
   cd .
   git add docs/ mkdocs.yml
   git commit -m "[${AGENT_ID}] docs: <description>"
   ```

   **Helper script (optional — enforces the `[agent-id]` prefix + does the git in one call).** `python tools/dev-pipeline/dev_commit.py <agent-id> <type> "<subject>" <files...> [--repo PianoidCore] [--body "..."]` runs `git add -- <exactly those files>` (never `-A`) + `git commit -m "[<agent-id>] <type>: <subject>"`, refusing a bad agent-id / empty message / no files — removing the `[agent-id]`-prefix violations the controller Tier-1-catches. **You write the message wording**; the script only enforces the prefix + does the plumbing. See `tools/dev-pipeline/README.md`.
4. **Release locks** — remove this agent's rows from `docs/development/MODULE_LOCKS.md`. Emit `[LOCK RELEASED] {file}` for each.
5. **Pre-handoff process hygiene (MANDATORY).** Always leave a CLEAR environment before reporting "ready to test". Kill all running server instances. **Do NOT restart unless explicitly instructed to.** The user prefers to start fresh manually so their browser tab is guaranteed to bind to a known-new bundle on first connect (no HMR ghost state, no stale dev-server cache, no chance the orchestrator's restart timing misaligns with the user's hard-refresh).

   **Procedure:**
   ```bash
   # Kill ALL Pianoid-port processes
   for port in 5000 5001 3000 3001; do
     pid=$(netstat -ano 2>/dev/null | grep ":${port} .*LISTENING" | awk '{print $NF}' | head -1)
     if [ -n "$pid" ] && [ "$pid" != "0" ]; then
       taskkill //F //PID "$pid" 2>/dev/null
     fi
   done
   sleep 2
   # Verify clear
   netstat -ano 2>/dev/null | grep -E ":(3000|3001|5000|5001) " && echo "WARN: ports still in use" || echo "All Pianoid ports clear"
   ```

   **Then in your Phase 1 report:** confirm all 4 Pianoid ports are clear, list which PIDs were killed, state explicitly that the stack is DOWN and the user should start fresh.

   **Restart only when the user explicitly says so** (e.g. "restart the stack", "bring it up", "run start-pianoid.bat"). The orchestrator may also instruct you to restart in cases where the user is on Telegram and can't run the launcher themselves — in that case spawn detached background processes via `Start-Process -WindowStyle Hidden` (Bash run_in_background hits the long-running-process gate).

   **Why kill-but-don't-restart is the default:** documented incident on 2026-05-07 — multiple iterations of dev-bandui fixes; the agent restarted the stack as a side effect of "ready to test" handoffs; user's browser tab kept connecting to whichever bundle the agent last started, leading to ambiguity about which fix was being tested; user repeatedly reported "Same" bug. Resolution: agent always leaves clean (DOWN) state; user manually runs `npm run dev` / `start-pianoid.bat` and hard-refreshes — guarantees a fresh server-tab binding.

   **Skip this step ONLY** if the change is documentation-only or research-only with no user-runtime impact. When in doubt, kill (do not restart).

6. **Phase 1 marker** — emit `[STEP-10A-PHASE-1] 2026-05-05T12:30:22Z commit=<sha>` (use the most recent commit SHA from `git rev-parse HEAD`).

**STOP HERE.** Report changes to the orchestrator/user and wait for approval. Do NOT proceed to Phase 2 until explicitly told to. The controller cross-references `git log` against the orchestrator's approval-relay messages — Phase 2 actions (log archive, WIP cleanup) appearing before an approval-relay trigger Tier-2 escalate.

#### Phase 2: User-approved (only after explicit approval)

Emit `[STEP-10A-PHASE-2] 2026-05-05T12:30:22Z` as the first action of Phase 2. The Phase-2 timestamp must follow the orchestrator's approval-relay timestamp; the controller flags out-of-order Phase-2 starts as Tier-2 escalate.

**Helper script (optional — collapses steps 7–9 into one turn; fires at max context, so it is the highest $/turn save).** After the approval above, `python tools/dev-pipeline/dev_wrap_phase2.py <agent-id> [--proposal docs/proposals/<name>.md --status "IMPLEMENTED <evidence>"]` performs the deterministic moves: `git mv` the log → `logs/archive/`, remove the agent's WIP row, and (when a shipped proposal is named) `git mv` it → `docs/proposals/archive/` + prepend the `**Status:**` line. The approval, WHICH proposal shipped, and the de-reference-from-working-code step (#9 first bullet) stay with Opus — the script refuses to archive a proposal unless explicitly told which one. See `tools/dev-pipeline/README.md`.

7. **Archive log** — move log file to archive:
   ```bash
   mkdir -p docs/development/logs/archive
   mv "$LOG_FILE" docs/development/logs/archive/
   ```
8. **Clean WIP** — remove this agent's row from the `## Active Dev Sessions` table in `WORK_IN_PROGRESS.md`
9. **Archive any proposal this work implemented (prevents backlog pile-up).** If this task IMPLEMENTED, COMPLETED, or SUPERSEDED a proposal in `docs/proposals/`, archive it now as part of the wrap — a shipped design must not linger at top-level (leaving them there is what let ~17 stale "draft/awaiting" proposals — already shipped — pile up before the 2026-06-06 triage):
   - **De-reference it from working code FIRST.** If any working file (`.claude/commands/*.md`, `CLAUDE.md`, or a `docs/` reference page) points at the proposal, move the content it relies on into a WORKING doc (`docs/development/` or `docs/architecture/`) and re-point the reference there — working code references working docs, NEVER a proposal. (Skill / `CLAUDE.md` edits are orchestrator-applied — flag them in your Phase-1 report for the orchestrator to apply before the archive.)
   - **Then archive:** `git mv docs/proposals/<name>.md docs/proposals/archive/` and prepend a `**Status:** IMPLEMENTED <commit/agent evidence> — Archived <YYYY-MM-DD>.` line. (Do the status edit AFTER the `git mv`, then `git add` the moved file, so the edit isn't stranded unstaged.)
   - If the proposal is only PARTIALLY implemented, do NOT archive — instead correct its stale header to the true state (which phases/waves shipped, what remains).
10. **Merge** — proceed to Step 9 if a feature branch was created

### 10b: Reset (failed implementation)

Sequence: **Document → Revert → Release locks → Delete log → Clean WIP**

**Markers (MANDATORY):** wrap the reset in a pair: `[STEP-10B-RESET] 2026-05-05T12:30:22Z phase=start` at the beginning, `[STEP-10B-RESET] 2026-05-05T12:30:55Z phase=done` after all four actions complete. Between the markers the controller verifies all four actions happened; partial completion at `phase=done` (e.g., locks released but log not deleted) is the violation (Tier-2 escalate).

1. **Verify Step 8 is done** — document what was attempted and why it failed (in WIP or relevant doc)
2. **Revert uncommitted changes:**
   ```bash
   # Revert only files this agent modified (check the lock registry for the list)
   cd PianoidCore
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

**Marker (MANDATORY):** at the start of the pause procedure, emit `[STEP-10C-PAUSE] 2026-05-05T12:30:22Z`. The `## Pause Snapshot` section format below remains as already specified.

Use this when work is incomplete but needs to be handed off to another session.

1. **Verify Step 8 is done** — document current state in relevant docs
2. **Commit or stash all current changes:**
   ```bash
   # Prefer commit on a feature branch:
   cd PianoidCore
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
   cd PianoidCore && git status --short
   cd PianoidTunner && git status --short
   cd PianoidBasic && git status --short
   cd . && git status --short
   
   # What do the changes look like?
   cd PianoidCore && git diff --stat
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

**Marker (MANDATORY):** at the start of the restart procedure, emit `[STEP-10E-RESTART] 2026-05-05T12:30:22Z blocking_agent=<id-of-agent-that-held-the-lock>`. The `## Restart After Lock Conflict` section format below remains as already specified. The controller flags previously-paused agents that resume without the marker as Tier-1 warn.

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
| PianoidCore | `PianoidCore` |
| PianoidBasic | `PianoidBasic` |
| PianoidTunner | `PianoidTunner` |
| Performance tests | `PianoidCore/tests/system/test_performance_audio_off.py` |
| Audio driver tests | `PianoidCore/tests/system/test_audio_drivers.py` |
| Documentation | `docs/` |
| Session logs | `docs\development\logs/` |
| Log archive | `docs\development\logs\archive/` |
| Module locks | `docs\development\MODULE_LOCKS.md` |
| venv Python | `PianoidCore/.venv/Scripts/python` |

## Example Usage

```
/dev Fix buffer underrun race condition in CircularBuffer.cu produce()
/dev Add FIR filter bypass mode for debugging
/dev Refactor preset loading to support hot-reload
```
