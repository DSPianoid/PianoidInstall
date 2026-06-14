---
name: dev
description: Development workflow — study context, baseline test, branch, edit, verify, debug, document, commit.
user-invocable: true
tier: generic
argument-hint: <task description — bug fix, feature, or refactor>
---

# Development Workflow

> **Project-agnostic skill** (`tier: generic`). Operates on an **active project**: resolve `$PROJECT_ROOT`
> and the project's `docs/PROJECT_CONFIG.md` per the machine-global `~/.claude/CLAUDE.md` "Config resolution" section (#config-resolution)
> — including the **graceful fallback** when no `PROJECT_CONFIG.md` is found. All project facts (build,
> ports, venv, repos, endpoints, verification surfaces) come from that config by anchor; this skill
> resolves them there rather than hard-coding them.

**Worked examples (project-tier):** concrete invocations for the active project — the port-scoped kill loops, the detached canonical build block, the venv pytest baseline/post-change runs, the server-start hierarchy, the codegen-delegation pipeline, the build/test/doc decision tables, and the spawned-`/fn` example — live in [`.claude/skill-examples/dev.md`](../skill-examples/dev.md) ([`#skill-examples`](../../docs/PROJECT_CONFIG.md#skill-examples)).

Disciplined development cycle across the active project's repos ([`PROJECT_CONFIG.md#repos`](../../docs/PROJECT_CONFIG.md#repos)). Follow every step in order. Do not skip steps.

## Verification Routing

When a code change affects an observable output and verification is required (per the verification rules in the project's `.claude/CLAUDE.md`), route to the surface that **observes** that output, with measured before/after evidence. The project declares its change-class → surface → mode → skill mapping in [`PROJECT_CONFIG.md#verification-surfaces`](../../docs/PROJECT_CONFIG.md#verification-surfaces); the binary marker/mode contract is in the development/testing doc ([`#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy)). Resolve the right verification skill + mode for your change class there before claiming the change works.

**Code principles (anchored in the project's code-quality doc — [`#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy)):**
- **P1 Separation of Authority** — every piece of state has exactly one owner (the sole writer). Before you touch state, name its owner. If your change makes a non-owner write it, you're violating P1.
- **P2 Separation of Concern** — every module/class/function has one job. Before you widen a module, ask whether the new responsibility is actually the module's concern. If not, put it elsewhere.
- Supporting principles: lean code, no redundancy, no duplication, fail-fast no workarounds, file-size red flags (any file approaching 500 LOC deserves scrutiny; >1000 is a split-plan trigger).

Do not ship a change that pushes a file past the file-size thresholds without discussing a split first.

## Docs-first (MANDATORY) for compile + run

Every rebuild, install, or server restart starts by reading the canonical docs — NOT a package-install command (a silently-stale binary otherwise masquerades as a working rebuild and voids every "I verified this" claim).

- **The full docs-first build/run discipline is the single canonical copy at [`docs/PROJECT_CONFIG.md` → Docs-first for build + run](../../docs/PROJECT_CONFIG.md#docs-first-build--run)** (read-which-docs · canonical build · debug-variant trap · verify-landed · pre-build hygiene). Read it before any build/restart.
- **Canonical rebuild** — use the project's canonical build command + the agent-context **detached** form (absolute build-script path, stop the build holder first); resolve the command, the never-substitute traps, and the verify-landed step from [`PROJECT_CONFIG.md#docs-first-build--run`](../../docs/PROJECT_CONFIG.md#docs-first-build--run), [`#rebuild-matrix`](../../docs/PROJECT_CONFIG.md#rebuild-matrix), and [`#build-holders`](../../docs/PROJECT_CONFIG.md#build-holders). (Concrete command + detached invocation: [worked-examples companion](../skill-examples/dev.md).)
- **Verify the rebuild landed** (grep the rebuilt binary for a string you just added) — if your marker is absent, nothing changed; **do NOT run tests**.
- **On unexpected build/startup failure → invoke the project's startup/build-recovery skill** (see [`PROJECT_CONFIG.md#docs-first-build--run`](../../docs/PROJECT_CONFIG.md#docs-first-build--run)) rather than troubleshooting blindly.

## Documentation Folder Taxonomy (MANDATORY)

Every doc artefact a `/dev` session produces (or moves) belongs in exactly one canonical location. Mixing types in `docs/development/logs/` makes orchestrator log scans noisy and breaks the "every log = one agent" invariant. Follow this taxonomy:

| Folder | Contents | Naming |
|--------|----------|--------|
| `docs/development/logs/` | Agent session logs ONLY - one file per `/dev` (or `/fn`) session | `dev-XXXX-YYYY-MM-DD-HHMMSS.md` |
| `docs/development/logs/archive/` | Completed agents' session logs (moved here at Step 10 wrap-up) | same naming |
| `docs/proposals/` | UPPER-LEVEL development/refactoring proposals ONLY — one doc per topic; future-work designs, not historical records | `<topic>-<YYYY-MM-DD>.md` |
| `docs/development/` | Working/planning docs, investigation notes, substrate/context docs that feed a proposal (directly under `development/`, NOT a `proposals/` subfolder) | `<topic>-<YYYY-MM-DD>.md` |
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

**One-doc-per-topic in `docs/proposals/` (MANDATORY):** the proposals folder contains ONLY currently-active design proposals — exactly ONE document per topic. Preparation analyses, older revisions, superseded versions, and research Q&A docs that fed into a proposal must be archived to `docs/proposals/archive/`. When you produce a NEW proposal that supersedes an existing one, archive the prior version (via `git mv`) BEFORE adding the new one. When proposal work fans out into multiple investigation docs (e.g. analysis + experiment + plan), the FINAL plan stays in `docs/proposals/`; the supporting docs go to `docs/proposals/archive/` with cross-references in the plan's "Investigation history" footer pointing to the archived paths. Once a proposal has been fully implemented, archive it too — `docs/proposals/` is for *future-work* designs, not historical records. **`docs/development/proposals/` MUST NOT exist:** proposals live in `docs/proposals/` ONLY; all working/planning, investigation, and substrate/context docs live directly under `docs/development/` (never a `proposals/` subfolder). If you encounter a `docs/development/proposals/` folder, re-home its contents (upper-level proposal → `docs/proposals/`; working/planning → `docs/development/`; already-shipped → `docs/proposals/archive/`) and delete the folder — never add to it.

**Single-source-of-truth for plans (MANDATORY):** a planning document MUST NOT reference older versions of itself or earlier supersededs of the same plan. The current plan is the single source of truth — readers should never have to "compare against the previous version" to understand what's authoritative. Allowed references from a plan: research/measurement docs, analysis docs, code reviews, architecture docs, module reference docs, external-system specs (anything that's NOT another planning document on the same topic). When a new plan supersedes an old one, copy any still-relevant context FORWARD into the new plan body — don't link backward to the archived old plan. The "Investigation history" footer (when used) lists the supporting research/analysis docs only, never prior planning revisions.

## Step 0: Initialize Session

### Generate Agent ID

Every dev agent session has a unique identifier used in logs, WIP references, commits, and lock records.

```bash
AGENT_ID="dev-$(openssl rand -hex 2)"   # e.g. dev-a3f1
```

**Agent ID persistence rule:** When an agent is **restarted after a lock conflict** or **recovered after abnormal termination**, the new session MUST reuse the original agent's ID. This keeps log references, WIP entries, commit prefixes, and lock records consistent. Only generate a fresh ID for genuinely new tasks.

### Create Session Log

Create the session log under the project's logs dir ([`PROJECT_CONFIG.md#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths)):

```bash
LOG_FILE="<logs-dir>/${AGENT_ID}-$(date +%Y-%m-%d-%H%M%S).md"
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

**This table is a TRANSIENT roster of IN-FLIGHT agents, not a status ledger.** Use EXACTLY the 4 columns above — do NOT add a "Status" column. A row exists only while the agent is active or awaiting close-out, and is **removed entirely at Phase 2** (its outcome goes into a historical `<!-- -->` comment, never into a status cell). Convey progress through your session LOG's `[STEP-X]` markers, not this row. A row left present with a terminal status ("MERGED"/"done") is the #1 source of WIP debt — see Step 10a Phase 2.

### Step 0 Completion Marker

Once the log file exists, the WIP entry is added, and (if any) initial locks are acquired, emit `[STEP-0-COMPLETE] 2026-05-05T12:30:22Z` as the FIRST line under `## Actions` in your session log. The controller computes `spawn → STEP-0-COMPLETE` delta:
- Tier-1 warn if Step 0 takes longer than 120 seconds
- Tier-2 escalate if Step 0 takes longer than 300 seconds

These are not new requirements — they are the existing Step 0 rules with explicit timing. A controller is always active in orchestrator-driven sessions and watches every dev agent's session log.

**Do not idle after `[STEP-0-COMPLETE]`.** Proceed directly into Step 1 (or Step 0b for a resume) and start emitting `[PROGRESS]` heartbeats. An agent that completes Step 0 then stops producing markers is flagged as idle-after-step by the controller's fast freshness check (> 8 min silent) within minutes, and will be nudged or re-spawned. A multi-step task is yours to carry through autonomously — don't stop and wait after the initial step.

**Helper script (optional — collapses this scaffold into one turn).** The project's dev-pipeline session-init helper generates the agent ID, writes the byte-faithful log header (with `[STEP-0-COMPLETE]` as the first `## Actions` line), adds the WIP `## Active Dev Sessions` row, and optionally creates the branch — then prints the agent ID + log path. Opus still owns the judgment the script never touches: whether to branch vs work on the integration branch, and lock acquisition. (Concrete invocation: [worked-examples companion](../skill-examples/dev.md).)

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
| `[STEP-1B-KILL] port=<N> pid=<N>` | Step 1b before any port-scoped kill | Port-scoped kill |
| `[STEP-1B-VENV-CHECK] interpreter=<path>` | Step 1b once before first venv use | Confirms venv interpreter |
| `[SERVER-START] role=<r> port=<N> pid=<N>` | After starting a server | Server lifecycle start |
| `[SERVER-STOP] port=<N> pid=<N>` | At cleanup or exit | Server lifecycle end |
| `[DMC-COMPLETE]` | End of Data Model Card section | Card complete signal |
| `[EDIT] file=<path>` | After each Edit/Write batch on a source file | Edit operation log |
| `[FILE-LOC] <path> before=<N> after=<N>` | After edit batch on a file | File-size threshold tracking |
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
| `[VERIFY-INVOKE] skill=<...> mode=<...>` | Step 7 verification | Mode-routing record |
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
| `[PERM-RISK] {ts} action=<...> method=<...> gate-risk=<...>` | Before any gate-risky action (process-spawn, kill, mcp-auth) | Permission-risk pre-marker |

**Backwards compatibility.** Archived dev session logs predating this convention lack these markers — that's expected. Only new sessions are subject to the marker rules.

### Bash & MCP Discipline (cross-cutting)

Applies to **every** step that runs `Bash` or invokes an MCP tool. Without these markers, the controller cannot detect agents that stalled on a CLI permission prompt invisible to a remote user (the dominant stall pattern per the machine-global `~/.claude/CLAUDE.md` "Sub-agent permission rule + known gaps").

- **Before every `Bash` invocation:** emit `[BASH-CALL] {ts} {first 80 chars of command, escaped}` to the session log
- **After every `Bash` return:** emit `[BASH-RETURN] {ts} duration_ms=<N> exit_code=<N>`
- **Before every MCP tool invocation:** emit `[MCP-CALL] {ts} server=<name> tool=<name> args_summary=<first 80 chars>`
- **After every MCP tool return:** emit `[MCP-RETURN] {ts} duration_ms=<N> status=<ok\|error>`

The pairs are **load-bearing** — an unmatched `[BASH-CALL]` or `[MCP-CALL]`, or a `[PROGRESS]` heartbeat, older than `STALL_THRESHOLD = 8 minutes` is the controller's primary signal that the agent has stalled (Tier-2). Older than 20 minutes is Tier-3. A trailing `[PERM-RISK]` marker escalates immediately, without waiting for the threshold — it is the strongest single signal of a CLI permission stall.

Failure to emit these markers is itself a Tier-2 violation — the controller cannot enforce stall detection or pre-emptive gating-pattern flagging without them.

### Read & Grep Discipline (cross-cutting)

Applies to **every** investigation phase: Step 1 (Understand Context), Step 5 (Test), Step 6 (Debug), Step 7 (Verify). Without these markers, the controller cannot enforce the machine-global "Documentation-First rule".

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

**Heartbeat (MANDATORY).** Emit `[PROGRESS] {ts} step=<N> note=<short>` (a) at every step boundary alongside the `### Step N` heading, and (b) at least every **3 minutes** during any operation that runs longer than that — heavy builds, full test suites, long derivations, the project's verification-skill invocations, or any extended analysis stretch with no tool calls. Emit one `[PROGRESS]` *before* a long op starts and again whenever you regain control. The controller's fast freshness check (every 3 min) flags any active agent whose log has gained no new marker for > **8 minutes** as STALLED — a live agent's log is therefore never silent longer than ~3 min.

**Permission-risk pre-marker (MANDATORY).** Before any action that may trip a CLI permission prompt (see the machine-global `~/.claude/CLAUDE.md` "Sub-agent permission rule + known gaps") — process-spawn via `run_in_background`/`Start-Process`, a kill on a non-trivial PID, an MCP tool whose name matches `*auth*|*pair*|*init*`, or any TTY-opening Bash — emit `[PERM-RISK] {ts} action=<desc> method=<bash-bg|start-process|launcher-rest|kill|mcp-auth|...> gate-risk=<why>` **first**, then the `[BASH-CALL]`/`[MCP-CALL]`. If you then stall, this marker pinpoints the prompting action so the orchestrator can re-route you to a no-prompt method instead of relaying the invisible prompt to the user. Emit `[PERM-RISK] method=launcher-rest` even for the safe launcher-REST path, to record that the no-prompt method was chosen.

## Step 0b: Resume Paused Session

Use this instead of Steps 1–4 when picking up a paused session. The goal is to restore full context before touching any code — documentation first, then the pause snapshot, then the code state.

### 1. Read documentation (same as Step 1)

Follow the documentation-first rule. Read the project's doc hierarchy top-down ([`PROJECT_CONFIG.md#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy)) — index/module-map, system overview, the relevant data-flow doc, then the specific module doc — and finally `docs/development/WORK_IN_PROGRESS.md` to find the paused session entry.

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

Based on the snapshot's commit/stash info (resolve the repo path from [`PROJECT_CONFIG.md#repos`](../../docs/PROJECT_CONFIG.md#repos)):

```bash
# If paused via commit on a feature branch:
cd <repo>
git checkout <branch-name>
git log --oneline -5   # verify you're on the right branch with the WIP commit

# If paused via stash:
cd <repo>
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

Read documentation in the project's doc-hierarchy order ([`PROJECT_CONFIG.md#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy)), stopping when you have enough context:

1. the index / module map — big picture
2. the system-overview architecture doc — the layered stack, threading, lifecycle
3. the data-flows architecture doc — trace the relevant data flow
4. Drill into the specific module doc under `docs/modules/` (resolve the module→doc mapping from [`#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy) — engine/compute, middleware/server, domain-model, and frontend each have their own module doc)
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

**When you hit an operational blocker — a server won't start or won't stay up, a tab needs a fresh load, the backend keeps dropping — the answer is ALWAYS a documented procedure, NEVER offloading the step to the user.** A persistent operational blocker means you haven't found or applied the right documented procedure yet — not that the task needs the user. The most common trap: a long-running server won't stay up because it was started via Bash / `run_in_background`, which (a) hits the harness long-running-process permission gate that prompts even under bypass mode (so the process just looks "stuck"), and (b) gets reaped / reloader-orphaned after ~30–120 s. The documented fix is a detached `Start-Process -WindowStyle Hidden` with redirected output (or the project's start API) — see the startup hierarchy below + the project's live-UI / startup-troubleshooting guides ([`PROJECT_CONFIG.md#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy)). Solve it; do not escalate it to the user.

### Kill Stale Processes

Before running any tests, builds, or starting servers, **always** kill existing project backend and frontend processes. Stale instances from previous sessions cause port conflicts and distorted output (e.g. two drivers fighting over a shared device).

**CRITICAL: Only kill processes bound to the project's ports — NEVER use a blanket kill-by-image-name (`taskkill //F //IM python.exe` / `//IM node.exe`).** Those commands kill MCP servers (WhatsApp, email, Google Workspace), browser-automation tooling, and even Claude Code itself (node.exe), crashing the orchestrator session.

**The canonical, structurally-safe sweep is the project's process-sweep executable — it can ONLY kill PIDs discovered as listeners on the project's declared ports (the safety invariant is encoded in the script; there is no path to kill by name). Use it instead of hand-pasting a `for port in … kill` loop.** Resolve the ports + the sweep command from [`PROJECT_CONFIG.md#ports`](../../docs/PROJECT_CONFIG.md#ports) and [`#process-sweep`](../../docs/PROJECT_CONFIG.md#process-sweep). (Concrete port-scoped kill loop + the sweep invocation: [worked-examples companion](../skill-examples/dev.md).)

**This applies every time** — even if you think nothing is running. Previous sub-agents or user sessions may have left orphaned processes. Distorted output is the #1 symptom of skipping this step.

**Markers (MANDATORY):** for each port-scoped kill, emit `[STEP-1B-KILL] port=<N> pid=<N>` to the session log. The **absence** of `[STEP-1B-KILL]` markers around a kill invocation is the controller's smoking gun for blanket-kill (kill-by-image-name), which is a Tier-3 halt.

### Start Servers With Correct Venv

When the task requires a running server, **start it yourself** — using the no-prompt method hierarchy (full detail in *Recommended startup hierarchy* below):
1. **PREFERRED — project start API** (an HTTP call to the launcher/start endpoint, e.g. `POST /api/start-backend` — [`PROJECT_CONFIG.md#rest-endpoints`](../../docs/PROJECT_CONFIG.md#rest-endpoints)): an HTTP call, NO process-spawn → never trips the permission gate. Use this whenever a launcher is up.
2. **FALLBACK — `Start-Process -WindowStyle Hidden`** (detached, redirected output): survives long-running, though a fresh process can trip the long-running-process gate once per session.
3. **LAST RESORT — `Bash run_in_background: true`**: trips the gate AND gets reaped / reloader-orphaned (~30–120 s). Only if 1 + 2 are impossible.

Emit `[PERM-RISK] {ts} action="start <server>" method=<launcher-rest|start-process|bash-bg> gate-risk=<...>` **before** any start attempt (per *Heartbeat & Permission-Risk Discipline*). Start each server from the project venv ([`#interpreters`](../../docs/PROJECT_CONFIG.md#interpreters)), with the correct working directory, redirecting output to a log; the LAST-RESORT form passes `run_in_background: true` to the Bash tool — do NOT use shell `&` (the Bash tool reports it as immediate exit). (Concrete per-server start commands + the verify-port-then-health check: [worked-examples companion](../skill-examples/dev.md).)

Then verify in a separate Bash call: wait briefly, confirm the port is LISTENING, and hit the server's health endpoint ([`#rest-endpoints`](../../docs/PROJECT_CONFIG.md#rest-endpoints)). If the port is not listening, read the log to diagnose.

**Rules:**
- Before the first venv invocation in this session, emit `[STEP-1B-VENV-CHECK] interpreter=<absolute path>` (the project venv per [`#interpreters`](../../docs/PROJECT_CONFIG.md#interpreters)). The controller flags any subsequent `python` Bash call lacking the matching prefix as a Tier-2 violation.
- Always use the project venv ([`#interpreters`](../../docs/PROJECT_CONFIG.md#interpreters)), NEVER system Python
- Always set the correct working directory before starting (the project's start commands may use relative paths — see the companion)
- Always use `run_in_background: true` on the Bash tool, NOT shell `&`
- Always redirect output to a log file for diagnostics
- Always verify with port check + endpoint test after startup
- After successful server start, emit `[SERVER-START] role=<...> port=<N> pid=<N>`. After shutdown (in any exit path), emit a matching `[SERVER-STOP] port=<N> pid=<N>`. The controller verifies every START has a matching STOP before the agent transitions to CLOSED.
- If the server crashes on startup, read the log file to diagnose — do not ask the user
- If startup fails 3 times, report the log contents and stop — do not loop indefinitely

### Server startup failure modes & workarounds

**Debug-reloader child-takeover.** A dev server run with an auto-reloader (e.g. a framework `debug=True`) spawns a child process to be the actual server, and the parent (which the bash tool was tracking via `run_in_background: true`) exits. The bash tool's process management may then reap the orphaned child after ~2 minutes, taking the server down. Symptom: the server works for a couple of minutes after start, then the port stops responding. (Project-specific instances + the proper env-gated fix, where one exists, are tracked in the project's startup-troubleshooting guide / `WORK_IN_PROGRESS.md`.)

**Long-running-process harness gate.** The Claude Code harness has a "long-running process" detector that gates regardless of permission mode — even under bypass mode, the first attempt to start a server via `Bash run_in_background: true` may trigger a CLI prompt that's invisible to the user when they're on a remote channel. (See the machine-global `~/.claude/CLAUDE.md` "Sub-agent permission rule + known gaps".) Each retry triggers another prompt — do NOT keep retrying.

**Recommended startup hierarchy:**

1. **PREFERRED: project start API.** If the launcher is already running, ask it to start the server via its start endpoint ([`PROJECT_CONFIG.md#rest-endpoints`](../../docs/PROJECT_CONFIG.md#rest-endpoints)). The launcher spawns the server as ITS child process with proper lifecycle management — no harness gate, no reloader-orphan trap. This is the pattern the user's normal startup uses. (Concrete start-API call: [worked-examples companion](../skill-examples/dev.md).)

2. **FALLBACK: PowerShell `Start-Process -WindowStyle Hidden` with redirected output.** Properly detaches the process so neither the bash tool's process management nor the harness gate interferes. Use the project venv interpreter + working directory ([`#interpreters`](../../docs/PROJECT_CONFIG.md#interpreters)) and redirect stdout/stderr to log files. (Concrete detached invocation: [worked-examples companion](../skill-examples/dev.md).) Note: PowerShell Start-Process on a fresh process can ALSO trigger the long-running-process gate the first time per session. If it does, escalate to the orchestrator via SendMessage rather than retrying.

3. **LAST RESORT: Bash `run_in_background: true`** as documented above. Works in most cases but is vulnerable to reloader child-takeover after ~2 minutes; if the server dies mid-session use option 1 instead of restarting via this pattern.

**Escalation rule.** If options 1 + 2 both fail, SendMessage the orchestrator. The orchestrator's own Bash calls render in its conversation as tool deltas which the orchestrator can see; it can either approve any prompt that fires OR start the server itself OR pre-allow the specific Bash invocation in `settings.local.json`.

### Clean Up After Yourself (MANDATORY)

**Full clearance before every handoff (MANDATORY).** Every agent MUST leave the environment fully cleared when it exits — regardless of exit path (wrap-up, reset, pause, or any abnormal termination). Full clearance means **(a) all project servers down** — nothing left listening on the project's ports ([`#ports`](../../docs/PROJECT_CONFIG.md#ports)) — and **(b) your working tree clean** — every change committed, stashed, or reverted, with temporary debug/instrumentation **reverted** (never committed), and your locks released. The user must always receive a clean, ready-to-restart slate; a running server OR a dirty tree at handoff is a severe violation. (Exception: if the orchestrator has told you a concurrent agent is actively using the stack, shut down only what you started, leave its servers up, and report the rest to the orchestrator — which owns the final all-down sweep.)

Run the project's port-scoped process sweep ([`#process-sweep`](../../docs/PROJECT_CONFIG.md#process-sweep)) to bring down every listener on the project's ports. (Concrete sweep/kill commands: [worked-examples companion](../skill-examples/dev.md).)

**Rules:**
- The sweep kills every listener on the project's ports — at handoff, ALL project servers come down, not only the ones you started (unless the orchestrator flagged a concurrent agent still using the stack)
- Your working tree must be clean at handoff: commit or stash real work, and **revert** temporary debug/instrumentation rather than committing it — a dirty tree is not a clean handoff
- Include clearance in ALL exit paths: Step 10a (wrap-up), Step 10b (reset), Step 10c (pause), and error/exception paths
- The user should never have to clean up after an agent — leaving stale processes OR uncommitted changes is a severe violation
- If the agent used a browser-automation tool to open a page, close the page before exiting

## Step 2: Baseline Performance Test

Before any code changes, run the project's performance/verification test suite and save results (resolve the suite path + the venv runner from [`PROJECT_CONFIG.md#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths) / [`#interpreters`](../../docs/PROJECT_CONFIG.md#interpreters)). (Concrete `cd <repo>` + venv-pytest command: [worked-examples companion](../skill-examples/dev.md).)

Record the project's performance/verification metrics from the output (e.g. compute mean/p99 latency, total-cycle mean, underrun count, output correlation — the project's actual metric set is whatever its perf suite reports):

| Metric | Value |
|--------|-------|
| (metric 1) | — |
| (metric 2) | — |
| ... | — |

If baseline tests fail, report to user and ask whether to proceed.

**Marker (MANDATORY):** after baseline tests pass, emit `[BASELINE-TEST] 2026-05-05T12:30:22Z result=<pass\|fail> perf_log=<path> <key metrics as fields>`. The controller alerts if Step 4 edit markers appear without a preceding `[BASELINE-TEST] result=pass` (Tier-1 warn).

## Step 3: Branch (if needed)

**Non-trivial changes** (new features, refactors, multi-file edits) — branch off the repo's integration branch ([`PROJECT_CONFIG.md#repos`](../../docs/PROJECT_CONFIG.md#repos)):
```bash
git -C "<repo>" checkout <integration-branch>
git -C "<repo>" pull origin <integration-branch>
git -C "<repo>" checkout -b feature/<short-description>
```

**Small fixes** (single-file, low risk): work directly on the integration branch.

Ask the user which approach if unclear.

## Step 4: Acquire Module Locks and Edit Code

### Before you write a single line

Answer these two questions out loud (in your session log):

1. **(P1 Authority)** Which piece of state am I about to touch, and who is its sole owner? If the change makes a non-owner write it, stop — either move the work to the owner, or redesign ownership first.
2. **(P2 Concern)** What is the single concern of every module I'm editing? Is the change within each module's existing concern, or does it widen the module's responsibility? Concern bleed is not acceptable — find or create a module whose job this actually is.

If either answer is unclear or uncomfortable, pause and read the project's code-quality doc ([`#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy)) — the Primary Principles section at the top. You cannot proceed until both answers are crisp.

### Pre-implementation Data Model Card (MANDATORY)

Before writing the first line of fix code, produce a **Data Model Card** in your session log. The card lists every non-trivial data-model fact the fix depends on, with explicit doc support. Format the heading literally as `## Data Model Card — 2026-05-05T12:30:22Z` (ISO 8601 UTC). Table format:

| Fact the fix relies on | Doc citation (file + section/anchor) | Inferred-only? (Y/N) |
|---|---|---|

After the table, emit `[DMC-COMPLETE]` on its own line to mark the card complete. The controller searches for this marker before any `[EDIT]` line targeting source files; missing or out-of-order DMC is a Tier-2 escalate.

If any row is marked "inferred-only" (i.e. you could not find doc support and are reasoning from source code), **PAUSE** before editing and either (a) route the question to the orchestrator/user via SendMessage, or (b) close the doc gap *first* — confirm with measurement against the engine, then write the doc, then proceed with the fix. Source-code-only inference about data-model facts is a recurring failure mode that produces wrong diagnoses (an endpoint mismatch, then a value-scale mismatch, before a measurement-based diagnosis finally succeeds).

**See the high-stakes inference categories** the project declares ([`PROJECT_CONFIG.md#data-model-facts`](../../docs/PROJECT_CONFIG.md#data-model-facts), and the cross-cutting rule in the machine-global `~/.claude/CLAUDE.md`) for the full list of fact categories where silent inference is forbidden (axis semantics, dimension ordering, index conventions, "stored vs effective" entries, unit ranges, "same name different thing" pairs).

**File-size watch:** Before adding significant code to any file, check its current LOC (`wc -l <file>`). If the file is in YELLOW territory (500–1000 LOC), prefer extraction over insertion. If the file is already RED (>1000 LOC), do not add to it without a split plan — report to the orchestrator and request guidance.

### Acquire Locks

Before editing any file, **register locks** in `docs/development/MODULE_LOCKS.md`. The lock file uses this format:

```markdown
# Module Locks

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-a3f1 | `<repo>/path/to/file_a.py`, `<repo>/path/to/file_b.py` | 2026-04-10T14:30:22Z | <task description> |
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

**Before writing new code**, search for existing utilities in the relevant modules (resolve the key source files from the module docs — [`PROJECT_CONFIG.md#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy) — and the shared test helpers/`conftest.py`).

**Code style rules:**
- Minimum code for the task — no speculative features, no "while I'm here" cleanup
- One function, one responsibility — split at ~50 lines
- Fix root causes, not symptoms — no `#ifdef` hacks, no silent fallbacks
- Reuse existing helpers — grep before writing
- Match existing patterns in the file (naming, indentation, error handling)

**Edit markers (MANDATORY):** after each batch of `Edit`/`Write` calls on a tracked source file, emit `[EDIT] file=<path>`. After you finish editing a file, run `wc -l <path>` and emit `[FILE-LOC] <path> before=<N> after=<N>` (use the pre-edit LOC from the lock-acquisition snapshot). The controller flags threshold crosses (`before<500 && after>=500` or `before<1000 && after>=1000`) as Tier-1 warn — these correspond to the file-size YELLOW and RED transitions and require updating the code-quality doc's God Objects list in Step 8.

**Rebuild after edits:**

Before building, consult the project's build-system doc ([`#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy)) for build pipeline details, venv handling, and troubleshooting.

**Pre-build check (MANDATORY):** Before every build, verify no process holds the native binary or its runtime DLLs open. A locked file causes an access-denied error and a failed uninstall leaves the package missing. Find holders per [`PROJECT_CONFIG.md#build-holders`](../../docs/PROJECT_CONFIG.md#build-holders) and stop the holder FIRST (the project's graceful stop endpoint, else a PID-targeted kill — never by image name; see [`#process-sweep`](../../docs/PROJECT_CONFIG.md#process-sweep)). (Concrete holder-check commands: [worked-examples companion](../skill-examples/dev.md).)

**Pre-build marker (MANDATORY):** after running the precheck above, emit `[BUILD-PRECHECK] holders=<comma-separated-pids or "none">` to the session log. The controller alerts if `[BUILD STARTED]` appears without a preceding `[BUILD-PRECHECK]` (Tier-2 escalate).

**Build command — which build for which changed file is the active project's rebuild decision matrix ([`PROJECT_CONFIG.md#rebuild-matrix`](../../docs/PROJECT_CONFIG.md#rebuild-matrix))**: compiled sources → heavy build; server/middleware code → light or no build; tests/docs → no build. The canonical build command + the agent-context **detached** form (absolute build-script path, stop the holder first) live at [`#docs-first-build--run`](../../docs/PROJECT_CONFIG.md#docs-first-build--run). (Concrete decision table + the detached build invocation + the build-log done-marker: [worked-examples companion](../skill-examples/dev.md).)

> **Build the binary, do not hand-install it.** In agent context the canonical build script MUST run **detached** (the non-detached agent-context form removes the binary before reinstall and bricks the venv), and you MUST NOT substitute a `pip install --force-reinstall` of the compiled sources — it silently returns a STALE binary and your edit never lands. Both traps + the variant/`--both` rule are in [`#docs-first-build--run`](../../docs/PROJECT_CONFIG.md#docs-first-build--run).

**Helper script (optional — the whole procedure above in one call).** The project's dev-pipeline build helper precheck-s holders → stops the holder FIRST (start API, else PID-targeted, never by image name) → launches the detached build (absolute script path) → polls the log for success → grep-verifies the binary for your marker → emits `[BUILD STARTED]`/`[BUILD OK]`/`[BUILD FAIL]`. It NEVER hand-installs the compiled package (the stale-binary trap) and ABORTS rather than build against a held binary (the venv-brick guard). **Build-failure diagnosis stays Opus** — on `[BUILD FAIL]` it tails the log + flags the exit code; you apply the documented recovery. (Concrete invocation: [worked-examples companion](../skill-examples/dev.md).)

**On a build failure with a DLL-init / access-denied class of error:** do NOT fall back to a manual `pip install --force-reinstall` of the compiled sources — that silently returns a stale cached binary and your edit never lands. Instead, follow the recovery documented in the project's build-system doc ([`#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy)) (typically: clear the pip build-env temp dirs, purge the pip cache, then re-run the canonical build).

**Post-build verification:** import-verify the rebuilt module resolves from inside the project venv ([`#interpreters`](../../docs/PROJECT_CONFIG.md#interpreters)) — and confirm the path is inside the project venv, not a root/other venv — then verify-landed per the docs-first step above. (Concrete import-verify command: [worked-examples companion](../skill-examples/dev.md).)

**Build markers (MANDATORY):** wrap each build invocation in a marker triple.
- **Before** the build: `[BUILD STARTED] 2026-05-05T12:30:22Z mode=<heavy\|light> variant=<release\|debug>`
- **On success:** `[BUILD OK] 2026-05-05T12:30:55Z duration=<seconds> marker=<grep-string-used-to-verify> verified=<yes\|no>`
- **On failure:** `[BUILD FAILED] 2026-05-05T12:30:55Z code=<exit-code> error_summary=<one-line>`

The controller alerts if Step 5 begins without a preceding `[BUILD OK] verified=yes` (Tier-1 warn). Any `pip install` of the compiled sources lacking a paired `[BUILD STARTED]` is the canonical-build-script violation (Tier-2 escalate).

## Step 4b: Codegen delegation — /dev designs, the codegen backend does routine bodies, /fn is judgment + debug

When a task decomposes into functions with clear, testable acceptance criteria, the **/dev agent itself owns the design** — it writes each function's spec + test + selects the context — and routes the work by KIND. The external code-generation backend is a **project-configured** capability: when the project declares a codegen backend (a codegen MCP tool + its batch pipeline) it is used for routine bodies; absent one, /dev writes those bodies itself. (The active project's concrete codegen tool, the batch-pipeline path, and the language matrix are in the [worked-examples companion](../skill-examples/dev.md).)

- **Routine, codegen-eligible function** (the common case) → **/dev does NOT spawn a `/fn` per function.** It writes the spec + test + picks the context snippets, then delegates the codegen to the **configured backend through its batch pipeline** — **uniformly, even for a single function** (a 1-function manifest; no direct-call special case). The pipeline delegates + runs the per-function test gate + flags failures with zero Opus per function (the strategy-C win: one designing /dev agent beats N spawned `/fn` workers each re-paying the per-spawn startup tax). Clean pass → apply, done. Failure → see **On codegen failure** below.
  - *Eligible WHEN (all hold):* a language with a fast isolated test gate the backend supports (e.g. Python tested via pytest, or JS/TS/React tested via Jest); a single, pure, well-specified unit; the test is written FIRST (see "Prepare tests FIRST" below).
  - *Manifest layout + CLI:* one directory, per function `<name>`: a spec file (signature + behaviour) · a test file (the gate — imports the candidate) · a meta file (`{target_module, language, xp_agnostic, deps:[<sibling helpers it may call>]}`) · shared test config if needed. (Concrete manifest layout + the pipeline CLI: [worked-examples companion](../skill-examples/dev.md).)
- **Judgment-heavy function** (genuine design judgment a hard test can't fully pin) → /dev's discretion: **write it inline** (pruning between functions per Context hygiene below), OR **spawn an Opus `/fn`** sub-agent for it (the enforced-clarity + isolation path — the Spawning procedure below). Reserve the `/fn` spawn for a unit large enough to clear the per-spawn startup tax AND needing Opus judgment.
- **HARD RULE — never delegate to the codegen backend:** any of the project's **compiled file types** ([`PROJECT_CONFIG.md#rebuild-matrix`](../../docs/PROJECT_CONFIG.md#rebuild-matrix)) (they need the heavy build), and any cross-cutting or multi-file refactor, stays on **Claude /dev** (write inline or via an Opus `/fn`) — never the backend. (The MCP tool also refuses compiled sources as a backstop, but the gate is /dev's routing decision first.)

So **`/fn` now has exactly two roles:** (1) implement a *judgment-heavy* function (Opus, when /dev chooses isolation over inline), and (2) **debug a codegen-backend failure** (below). The routine-codegen path no longer spawns a `/fn` per function — specs + context + delegation live in /dev; the codegen is the backend-via-pipeline.

**SAFETY (unchanged):** codegen-backend output is never trusted, only tested — the /dev-written test is the gate. The backend never writes files, never commits, never updates docs. Mechanism + setup: the project's codegen-backend README (+ `/fn` Step 2a for the single-unit envelope).

### On codegen failure (the `/fn` debug agent)

When the pipeline flags a function as failed (the backend couldn't pass the gate after its retries), /dev:
1. **Tries ONE quick inline fix** — /dev already holds the spec + test + context; read the failure + the flagged body, attempt a targeted fix, re-run the gate. (Cheaper than a spawn for a trivial miss.)
2. **If that doesn't land, or the bug is clearly deep** → spawn a **dedicated `/fn` debug agent** (Opus) for that ONE function: hand it the failing body + the test + the failure output + the spec; it debugs/rewrites to green. This is where Opus cognition earns the spawn.

Never ship a failing body; never enter Step 5 with a red function.

**Dual-backend tests for array-agnostic functions (MANDATORY).** When a function takes an array module (`xp`, numpy/cupy/torch), the test you prepare FIRST must exercise **both** numpy AND cupy — a numpy-only test ships latent cupy bugs (an A/B run once shipped a `cupy + numpy` add the numpy-only gate never caught). See the dual-backend rule in `/fn` Step 2a; it governs the tests `/dev` writes before delegating, too.

**Declare deps in the manifest.** Since ALL backend codegen flows through the pipeline, each function's meta declares its `deps` (the sibling helpers it may call). The pipeline builds leaf helpers first and exposes them in the delegate prompt — otherwise the backend **re-implements** shared logic (an A/B run re-implemented a shared helper in two functions instead of calling it). **Same for React:** a component declares the shared component it composes as a dep, so that component is built first and its prop interface exposed — don't let the backend re-create a shared input control (divergent styling/a11y/debounce a Jest test rarely asserts).

### When to delegate

- The function has clear inputs, outputs, and behavior that can be specified upfront
- Acceptance criteria can be expressed as a test (unit, integration, or system)
- The function can be implemented and verified independently

### When NOT to delegate

- The change is a cross-cutting refactor (rename across many call sites, structural reorganization)
- The function's behavior can only be verified through the full system (no isolated test possible)
- The change is so trivial that writing the spec would take longer than the edit

### Context hygiene & spawn-cost discipline (cost control)

Every Opus turn re-reads the agent's **entire accumulated context** as cache-read before it does anything — that re-read (not the work) dominates cost. So the levers are: make fewer turns, and keep each turn's resident context small. Apply these to this agent AND to how it shapes `/fn` work:

- **Read narrowly.** Read the target function span with `offset`/`limit`, not the whole file, when one function is in scope. Read the one gating test, not the whole suite.
- **Test once at the end** of a function, not after each speculative edit (review-on-red). The incremental-test pattern re-reads the whole context each time — the wasted turns add up.
- **Prune stale tool output.** Once a function is green, don't keep its full diff + every intermediate test dump resident — summarize to one line in the **session log** (the durable record) and move on. Prune *stale* output, never *load-bearing* context (Data Model Card facts, the spec, the current test).
- **Don't fan out Opus `/fn` workers for small units.** A fresh Opus sub-agent re-pays a fixed **per-spawn startup tax** (harness + `CLAUDE.md` prefix), so N isolated Opus workers LOSE to one context-pruned agent at every N ≥ 2. **Never spawn an Opus sub-agent for a unit of work smaller than that startup tax — do it inline or script it.** Group functions that share context (read the same files) into one agent that prunes between them, rather than one worker per function. Fan-out earns its startup tax ONLY when the unit is a *judgment* function needing Opus isolation — for ROUTINE codegen the cheaper path is the configured codegen pipeline (Step 4b above), never a fanned-out Opus `/fn`.

(Full cost model + the measured figures — the ~65% context-re-read share, the incremental-test waste, the +38%@N=3 / +60%@N=10 fan-out loss: the project's dev-pipeline cost-model proposal — see the [worked-examples companion](../skill-examples/dev.md).)

### Prepare tests FIRST (dev agent responsibility)

Before spawning a sub-agent, the dev agent must ensure a test exists for the function. This is the dev agent's job, not the sub-agent's.

**If a suitable test already exists:** reference it in the sub-agent's `test_command`.

**If testing is non-trivial:** the dev agent writes the test script first, placing it in the correct location within the project test hierarchy (resolve the tiers + locations from [`PROJECT_CONFIG.md#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths) / the development/testing doc — typically a pure-logic tier, a compute/integration tier, and a full-stack/system tier). (Concrete tier table: [worked-examples companion](../skill-examples/dev.md).)

The test file **persists in the project** — it is not disposable scaffolding. Follow patterns from existing tests (`conftest.py` fixtures, markers, assertions). The test should:
- Import the function (or call the API that exercises it)
- Cover the requirements specified for the sub-agent
- Include edge cases identified during Step 1 context analysis
- Be runnable via a single test invocation

**Write the test, commit-stage it, then reference it in the sub-agent spawn.** This way the test survives regardless of the sub-agent's outcome.

### Spawning procedure (for a `/fn` spawn — judgment or debug, NOT the routine pipeline path)

> The procedure + markers below (`[TEST-WRITTEN]` / `[FN-SPAWNED]` / `[FN-RESULT]`) apply when you SPAWN a `/fn` agent — i.e. a *judgment-heavy* function or a *debug-on-codegen-failure*. The routine codegen path (above) runs the **pipeline** instead and emits no `[FN-SPAWNED]` — its gate is the pipeline's per-function test run.

1. **Decompose** — for each function, define:
   - `target_file`: absolute path to the file to edit
   - `function_spec`: what to implement (name, signature, behavior, edge cases)
   - `requirements`: acceptance criteria matching the test assertions
   - `test_command`: exact test command referencing the test written above (the project's venv runner — [`#interpreters`](../../docs/PROJECT_CONFIG.md#interpreters))
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
       - test_command: <exact test command>\n\
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

A concrete end-to-end example for the active project — the dev agent writing a unit test first, then spawning the `/fn` sub-agent that implements against it — lives in the [worked-examples companion](../skill-examples/dev.md).

## Step 5: Post-Change Performance Test

Run the same test suite as the baseline (via the project venv runner — [`#interpreters`](../../docs/PROJECT_CONFIG.md#interpreters)). (Concrete command: [worked-examples companion](../skill-examples/dev.md).)

Compare against baseline and print a table (the project's actual metric set):

| Metric | Baseline | After | Delta |
|--------|----------|-------|-------|
| (metric 1) | — | — | — |
| (metric 2) | — | — | — |
| ... | — | — | — |

**Regression criteria (hard fail → go to step 6):**
- Compute mean increase > 10%
- Output correlation drop below the project's pass threshold
- Any new test failure

**Warning (report but continue):**
- Compute p99 increase > 20%
- Underrun count increase > 50%

(The project's exact metric names + thresholds come from its perf suite — [`PROJECT_CONFIG.md#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths) / [`#verification-surfaces`](../../docs/PROJECT_CONFIG.md#verification-surfaces).)

**Markers (MANDATORY):** after the comparison table, emit `[REGRESSION-CHECK] 2026-05-05T12:30:22Z <delta fields> verdict=<pass\|warn\|fail>`. On `verdict=fail`, also emit `[REGRESSION-DETECTED] 2026-05-05T12:30:22Z file=<path> metric=<name> delta=<value>` per offending metric. The controller alerts if `[REGRESSION-DETECTED]` is followed by `[STEP-10A-PHASE-1]` without an intervening `[STEP-6-DEBUG]` marker (Tier-2 escalate — regression triggers debug, not commit).

**Helper script (optional — runs the test + parses metrics + builds the delta table + emits the markers in one call).** The project's dev-pipeline perf-runner helper writes the baseline JSON + emits `[BASELINE-TEST]` at Step 3, then prints the Baseline/After/Delta table + emits `[REGRESSION-CHECK]` / `[REGRESSION-DETECTED]` with a `verdict_hint` from the thresholds above. **The regression VERDICT stays Opus** — the script computes the deltas + a hint; you decide whether a breach is acceptable for THIS change. (Concrete invocation: [worked-examples companion](../skill-examples/dev.md).)

## Step 6: Debug (if tests fail)

**Build failures:** If a build command fails (linker errors, missing libraries, DLL issues), consult the project's build-system doc — especially its Troubleshooting section ([`#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy)) — before attempting manual fixes. Common issues (missing libs, import failures, heavy-vs-light trade-offs) are documented there with diagnosis steps and fixes.

Iterative loop (max 5 iterations):
1. Read failure output — identify root cause, not just symptom
2. Make targeted fix
3. Rebuild if needed (step 4 commands)
4. Re-run failing test only (the single-test form of the project's test runner)
5. Once that test passes, re-run full suite (step 5)
6. Repeat until all pass

After 5 failed iterations, stop and report findings to the user. Do not keep looping.

**Marker (MANDATORY):** at the start of each debug iteration, emit `[STEP-6-DEBUG iter=<N>]` on its own line (in addition to the `### Step 6: Debug iteration N — <ISO timestamp>` step heading). The controller counts iterations: warn at iter 6, escalate at iter 8.

## Step 7: Feature-Specific Testing (new features only)

### 7a: Verification on the observing surface (mandatory for output-affecting changes)

If the change affects an observable output (per the change classes in [`PROJECT_CONFIG.md#verification-surfaces`](../../docs/PROJECT_CONFIG.md#verification-surfaces)) — invoke the project's verification skill for that change class to verify with measured evidence:

```
/<verification-skill> <description of what to verify>
```

This launches the relevant surface, applies the change, measures the output on the surface that observes it (the project's deterministic verification surface), and reports pass/fail with numbers. **Do not skip this for output-affecting features.** Resolve which skill + mode maps to your change class from [`#verification-surfaces`](../../docs/PROJECT_CONFIG.md#verification-surfaces). (Concrete skill name + invocation: [worked-examples companion](../skill-examples/dev.md).)

**Marker (MANDATORY):** when invoking a verification skill, emit `[VERIFY-INVOKE] skill=<...> mode=<...>` to the session log. The controller cross-references the chosen mode against the agent's edited file list (the change-class classification per the project's verification rules — [`#verification-surfaces`](../../docs/PROJECT_CONFIG.md#verification-surfaces)). Wrong mode (e.g., a mic-engaging change verified via the offline-render mode instead of the mic mode) is a Tier-2 escalate.

### 7b: Automated Tests

Ask the user for acceptance criteria:
- What inputs to test?
- What behavior is expected?
- Edge cases?

Write tests in the appropriate tier (resolve the tier locations from [`PROJECT_CONFIG.md#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths) / the development/testing doc) — typically full-stack, compute/integration, and pure-logic tiers. Follow patterns from the existing perf-suite tests (fixtures, markers, assertions).

## Step 8: Update Documentation

**This step is mandatory for ALL exit procedures (wrap-up, reset, pause).** Documentation must always reflect the current state of the codebase.

### Doc-gap closure (MANDATORY)

If during the fix you uncovered a documentation gap that contributed to the misdiagnosis or to the difficulty of the fix, **closing that gap is part of THIS session, not a deferred follow-up**. The session is not "done" until either:

  (a) the docs are updated to reflect the now-confirmed truth, OR
  (b) a `WORK_IN_PROGRESS.md` entry is filed with a concrete owner and ETA for closing the gap, AND the session log calls out the deferral explicitly.

"We learned X, but didn't write it down" is a failed wrap-up. The next agent will hit the same trap.

**Principle-namespace cross-reference:** when the change affects any state ownership, module concern, file-size threshold, or patch/workaround handling, cite the relevant principle from the project's code-quality doc ([`#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy)). Docs that justify a change by its principle age better than docs that describe what the code does.

**File-size regression check:** if any file in scope crossed the 500 or 1000 LOC threshold during this session, update the "Current Known God Objects" list at the bottom of the code-quality doc accordingly — add new RED entries, remove entries that dropped below threshold after a refactor. Files are listed in decreasing LOC order.

For each affected section, update the relevant doc file (resolve the source→doc mapping from [`PROJECT_CONFIG.md#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy)):

| Changed source | Doc to update |
|---------------|---------------|
| engine/compute sources | the engine/compute module doc |
| middleware/server sources | the middleware/server module doc |
| `tests/**` | the development/testing doc |
| Architecture/flow changes | the data-flows architecture doc |
| New WIP items | `docs/development/WORK_IN_PROGRESS.md` |

Keep docs lean and concise. Tables over prose. Every sentence earns its place.
**Structural doc changes (new pages, nav changes) require user approval.**

**Infographics** — whenever code changes affect logic depicted in an existing infographic, update it to reflect the new state (check the SVGs in `docs/images/` and Mermaid blocks in the affected docs). Diagram authoring + style rules (prefer Mermaid over ASCII, hand-SVG for hero diagrams, never add new ASCII art) live canonically in `/update-docs` §2b — follow them here.

**Markers (MANDATORY):**
- At the end of Step 8, emit `[STEP-8-COMPLETE] 2026-05-05T12:30:22Z docs_touched=<comma-separated-paths or "none">`. The controller alerts if `[STEP-10A-PHASE-1]`, `[STEP-10B-RESET]`, or `[STEP-10C-PAUSE]` appears without a preceding `[STEP-8-COMPLETE]` (Tier-2 escalate — Step 8 is mandatory for ALL exit procedures).
- If the session identified a doc gap, emit `[DOC-GAP] description=<one-line> resolution=<doc-edit\|wip-deferred> ref=<file-or-wip-anchor>`. The controller flags log entries that mention "doc gap" / "should be documented" if no doc edit or WIP entry follows before commit (Tier-1 warn).

## Step 9: Merge Feature Branch to the Integration Branch

**This step is mandatory when a feature branch was created in Step 3.** Unmerged feature branches break other systems that install from the integration branch ([`PROJECT_CONFIG.md#repos`](../../docs/PROJECT_CONFIG.md#repos)).

**Default: merge only after the user has tested the fix on the feature branch and approved it.** Per the standing handoff default (Step 10a Phase 1: stack down, repo left on the feature branch), the user runs their OWN live test first — a passing agent test is NOT approval. Only after the user confirms the fix works and approves the merge:

1. **Merge into the integration branch** for each repo that has a feature branch:
```bash
# Example for one repo
cd <repo>
git checkout <integration-branch>
git merge feature/<name> --no-ff -m "Merge feature/<name> into <integration-branch>"
git push origin <integration-branch>
```
Repeat for each other repo that was changed (resolve the repo set + their integration branches from [`#repos`](../../docs/PROJECT_CONFIG.md#repos)).

2. **Clean up** — ask user if the feature branch should be deleted:
```bash
git branch -d feature/<name>
git push origin --delete feature/<name>
```

**Do not end the workflow with commits only on a feature branch.** If the user declines to merge now, warn them explicitly: "Feature branch `feature/<name>` has not been merged to the integration branch. Other systems installing from it will not have these changes."

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
3. **Final commit** — commit any remaining uncommitted changes (per-repo source changes, then documentation changes), each with the `[${AGENT_ID}]` prefix.

   **Helper script (optional — enforces the `[agent-id]` prefix + does the git in one call).** The project's dev-pipeline commit helper runs `git add -- <exactly those files>` (never `-A`) + `git commit -m "[<agent-id>] <type>: <subject>"`, refusing a bad agent-id / empty message / no files — removing the `[agent-id]`-prefix violations the controller Tier-1-catches. **You write the message wording**; the script only enforces the prefix + does the plumbing. (Concrete invocation: [worked-examples companion](../skill-examples/dev.md).)
4. **Release locks** — remove this agent's rows from `docs/development/MODULE_LOCKS.md`. Emit `[LOCK RELEASED] {file}` for each.
5. **Pre-handoff process hygiene (MANDATORY).** Always leave a CLEAR environment before reporting "ready to test". Kill all running server instances (the project's port-scoped process sweep — [`#process-sweep`](../../docs/PROJECT_CONFIG.md#process-sweep)). **Do NOT restart unless explicitly instructed to.** The user prefers to start fresh manually so their browser tab is guaranteed to bind to a known-new bundle on first connect (no HMR ghost state, no stale dev-server cache, no chance the orchestrator's restart timing misaligns with the user's hard-refresh). (Concrete sweep + verify-clear commands: [worked-examples companion](../skill-examples/dev.md).)

   **Then in your Phase 1 report:** confirm all project ports are clear, list which PIDs were killed, state explicitly that the stack is DOWN and the user should start fresh.

   **Restart only when the user explicitly says so** (e.g. "restart the stack", "bring it up"). The orchestrator may also instruct you to restart in cases where the user is on a remote channel and can't run the launcher themselves — in that case spawn detached background processes via `Start-Process -WindowStyle Hidden` (Bash run_in_background hits the long-running-process gate).

   **Why kill-but-don't-restart is the default:** a documented incident — multiple iterations of UI fixes where the agent restarted the stack as a side effect of "ready to test" handoffs; the user's browser tab kept connecting to whichever bundle the agent last started, leading to ambiguity about which fix was being tested; the user repeatedly reported "Same" bug. Resolution: the agent always leaves clean (DOWN) state; the user manually starts the stack and hard-refreshes — guarantees a fresh server-tab binding.

   **Skip this step ONLY** if the change is documentation-only or research-only with no user-runtime impact. When in doubt, kill (do not restart).

6. **Phase 1 marker** — emit `[STEP-10A-PHASE-1] 2026-05-05T12:30:22Z commit=<sha>` (use the most recent commit SHA from `git rev-parse HEAD`).

**STOP HERE.** Report changes to the orchestrator/user and wait for approval. Do NOT proceed to Phase 2 until explicitly told to. The controller cross-references `git log` against the orchestrator's approval-relay messages — Phase 2 actions (log archive, WIP cleanup) appearing before an approval-relay trigger Tier-2 escalate.

#### Phase 2: User-approved (only after explicit approval)

Emit `[STEP-10A-PHASE-2] 2026-05-05T12:30:22Z` as the first action of Phase 2. The Phase-2 timestamp must follow the orchestrator's approval-relay timestamp; the controller flags out-of-order Phase-2 starts as Tier-2 escalate.

**Helper script (optional — collapses steps 7–9 into one turn; fires at max context, so it is the highest $/turn save).** After the approval above, the project's dev-pipeline Phase-2 wrap helper performs the deterministic moves: `git mv` the log → `logs/archive/`, remove the agent's WIP row, and (when a shipped proposal is named) `git mv` it → `docs/proposals/archive/` + prepend the `**Status:**` line. The approval, WHICH proposal shipped, and the de-reference-from-working-code step (#9 first bullet) stay with Opus — the script refuses to archive a proposal unless explicitly told which one. (Concrete invocation: [worked-examples companion](../skill-examples/dev.md).)

7. **Archive log** — move log file to archive:
   ```bash
   mkdir -p docs/development/logs/archive
   mv "$LOG_FILE" docs/development/logs/archive/
   ```
8. **Remove WIP row — do NOT re-status it.** DELETE this agent's entire row from the `## Active Dev Sessions` table in `WORK_IN_PROGRESS.md`. Phase 2 means the row is **GONE**, not set to "MERGED"/"done"/"COMPLETED". If the outcome (merge SHAs, branch, deferred follow-ups) is not already captured in a COMPLETED/RELEASED comment block elsewhere in the file, add a one-line historical `<!-- dev-xxxx COMPLETED <date> — <outcome> -->` comment in its place. **A row left present with a terminal status is NOT done** — it is the #1 source of WIP debt (a sweep once cleared 6 such rows whose Phase-2 commits said "mark MERGED" instead of deleting the row).
9. **Archive any proposal this work implemented (prevents backlog pile-up).** If this task IMPLEMENTED, COMPLETED, or SUPERSEDED a proposal in `docs/proposals/`, archive it now as part of the wrap — a shipped design must not linger at top-level (leaving them there is what lets stale "draft/awaiting" proposals — already shipped — pile up before a triage):
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
   cd <repo>
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
   cd <repo>
   git add <modified-files>
   git commit -m "[${AGENT_ID}] wip: <what's done so far>"

   # Or stash if on the integration branch and changes aren't ready:
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

2. **Check actual state against the log** — run `git status --short` and `git diff --stat` in each repo ([`#repos`](../../docs/PROJECT_CONFIG.md#repos)) to see what uncommitted changes exist and what they look like.

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

Repo roots, venv interpreter (per-OS), test paths, and the lock/log locations are project facts —
resolve them from the active project's [`PROJECT_CONFIG.md` → Key Paths](../../docs/PROJECT_CONFIG.md#key-paths)
and [→ Interpreters](../../docs/PROJECT_CONFIG.md#interpreters).

## Example Usage

```
/dev Fix buffer underrun race condition in the producer path
/dev Add a filter bypass mode for debugging
/dev Refactor preset loading to support hot-reload
```
