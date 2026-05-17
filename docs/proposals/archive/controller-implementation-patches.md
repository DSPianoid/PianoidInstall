# Controller Implementation Patches

**Source:** `docs/proposals/controller-role.md` (commit 174fca8)
**Generated:** 2026-05-05
**Application target:** orchestrator-level Edit tool (sub-agents are silently denied under `.claude/commands/`)

Patches are listed in implementation order per Section 16 of the proposal. Each `old_string` was selected to be unique in its target file; anchor reasoning is documented per patch.

---

## Patch 1 — dev.md: Replace Logging Rule + add Marker Convention block

**File:** `D:\repos\PianoidInstall\.claude\commands\dev.md`
**Anchor reasoning:** The current "Logging Rule" subsection at line 104 (with its single fenced example) is unique in dev.md. We replace it wholesale with the ISO timestamp format + the new `## Marker Convention` block + the new `## Bash & MCP Discipline` and `## Read & Grep Discipline` subsections (which Section 15 says belong cross-cuttingly; we land them adjacent to Logging Rule because the markers ARE logging rules).

### old_string
```
### Logging Rule

After completing each step below, append a timestamped entry to the log file:

```markdown
### Step N: <Step Name> — <HH:MM>
- <what was done: files read, commands run, decisions made>
- <outcomes, metrics, errors encountered>
```

Keep entries concise — bullet points, not prose. The log is a breadcrumb trail, not a narrative.
```

### new_string
```
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

**Backwards compatibility.** Archived dev session logs predating this convention lack these markers — that's expected. Only new sessions are subject to the marker rules.

### Bash & MCP Discipline (cross-cutting)

Applies to **every** step that runs `Bash` or invokes an MCP tool. Without these markers, the controller cannot detect agents that stalled on a CLI permission prompt invisible to the Telegram user (the dominant stall pattern per `.claude/CLAUDE.md` "Known gaps in `bypassPermissions`").

- **Before every `Bash` invocation:** emit `[BASH-CALL] {ts} {first 80 chars of command, escaped}` to the session log
- **After every `Bash` return:** emit `[BASH-RETURN] {ts} duration_ms=<N> exit_code=<N>`
- **Before every MCP tool invocation:** emit `[MCP-CALL] {ts} server=<name> tool=<name> args_summary=<first 80 chars>`
- **After every MCP tool return:** emit `[MCP-RETURN] {ts} duration_ms=<N> status=<ok\|error>`

The pairs are **load-bearing** — an unmatched `[BASH-CALL]` or `[MCP-CALL]` older than 30 minutes is the controller's primary signal that the agent has stalled (Tier-2). Older than 60 minutes is Tier-3.

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
```

---

## Patch 2 — dev.md: Step 0 marker requirements + Step 0 controller note

**File:** `D:\repos\PianoidInstall\.claude\commands\dev.md`
**Anchor reasoning:** The "Append rows for new agents" sentence at the end of the WIP-registration block in Step 0 is unique. We append the controller note + STEP-0-COMPLETE marker requirement immediately after it (before "Check for Paused or Stale Sessions").

### old_string
```
Append rows for new agents; do not replace existing entries from other agents.

### Check for Paused or Stale Sessions
```

### new_string
```
Append rows for new agents; do not replace existing entries from other agents.

### Step 0 Completion Marker

Once the log file exists, the WIP entry is added, and (if any) initial locks are acquired, emit `[STEP-0-COMPLETE] 2026-05-05T12:30:22Z` as the FIRST line under `## Actions` in your session log. The controller computes `spawn → STEP-0-COMPLETE` delta:
- Tier-1 warn if Step 0 takes longer than 120 seconds
- Tier-2 escalate if Step 0 takes longer than 300 seconds

These are not new requirements — they are the existing Step 0 rules with explicit timing. A controller is always active in orchestrator-driven sessions and watches every dev agent's session log.

### Check for Paused or Stale Sessions
```

---

## Patch 3 — dev.md: Step 1b kill markers

**File:** `D:\repos\PianoidInstall\.claude\commands\dev.md`
**Anchor reasoning:** The "This applies every time" sentence at the end of the Kill Stale Processes section (line 264) is unique. We append the marker requirement immediately after it before the "### Start Servers With Correct Venv" heading.

### old_string
```
**This applies every time** — even if you think nothing is running. Previous sub-agents or user sessions may have left orphaned processes. Distorted sound is the #1 symptom of skipping this step.

### Start Servers With Correct Venv
```

### new_string
```
**This applies every time** — even if you think nothing is running. Previous sub-agents or user sessions may have left orphaned processes. Distorted sound is the #1 symptom of skipping this step.

**Markers (MANDATORY):** for each port-scoped kill above, emit `[STEP-1B-KILL] port=<N> pid=<N>` to the session log. The **absence** of `[STEP-1B-KILL]` markers around a `taskkill` invocation is the controller's smoking gun for blanket-kill (`taskkill //F //IM python.exe` / `node.exe`), which is a Tier-3 halt.

### Start Servers With Correct Venv
```

---

## Patch 4 — dev.md: Step 1b venv check + server-start markers

**File:** `D:\repos\PianoidInstall\.claude\commands\dev.md`
**Anchor reasoning:** The exact "Rules:" block at line 292 (with its 7 bullets ending at "If startup fails 3 times…") is unique in dev.md. We replace the leading rule with the new venv-check requirement and append the SERVER-START / SERVER-STOP requirements after.

### old_string
```
**Rules:**
- Always use `PianoidCore/.venv/Scripts/python`, NEVER system Python (`C:\Python312\python.exe`)
- Always set CWD to `pianoid_middleware/` before starting — preset paths are relative
- Always use `run_in_background: true` on the Bash tool, NOT shell `&`
- Always redirect output to a log file for diagnostics
- Always verify with port check + endpoint test after startup
- If the server crashes on startup, read the log file to diagnose — do not ask the user
- If startup fails 3 times, report the log contents and stop — do not loop indefinitely
```

### new_string
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
```

---

## Patch 5 — dev.md: Step 4 lock-acquire / lock-release / DMC / EDIT / FILE-LOC markers

**File:** `D:\repos\PianoidInstall\.claude\commands\dev.md`
**Anchor reasoning:** The bulleted "Rules:" block under "### Acquire Locks" has a unique terminating bullet about lock-before-edit invariant (line 421). We append marker requirements immediately after it.

### old_string
```
- **Lock-before-edit invariant:** Before writing to ANY file not already in your lock list, you MUST first add it to `MODULE_LOCKS.md`. Update your lock row to include the new file. Check for conflicts (another agent holding that file) before proceeding. This applies even when scope expands mid-session — **never edit an unlocked file.**

### Multi-Stage Session Management
```

### new_string
```
- **Lock-before-edit invariant:** Before writing to ANY file not already in your lock list, you MUST first add it to `MODULE_LOCKS.md`. Update your lock row to include the new file. Check for conflicts (another agent holding that file) before proceeding. This applies even when scope expands mid-session — **never edit an unlocked file.**

**Lock markers (MANDATORY):** when adding a file to your lock row, emit `[LOCK ACQUIRED] {file}`. When removing, emit `[LOCK RELEASED] {file}`. The controller cross-references these markers against `MODULE_LOCKS.md` reads — divergence (marker says acquired but file row absent, or marker says released but row still present) is a Tier-2 escalate. The controller detects unlocked dirty files within seconds via `git status` sweeps — not at Step 10a's audit. Treat lock-before-edit as a hard precondition, not a wrap-up reconciliation.

### Multi-Stage Session Management
```

---

## Patch 6 — dev.md: Step 4 Data Model Card heading + DMC-COMPLETE marker

**File:** `D:\repos\PianoidInstall\.claude\commands\dev.md`
**Anchor reasoning:** The Data Model Card paragraph at lines 391-400 (ending with the "High-stakes inference categories" cross-reference) is unique. We update the heading instructions and add the DMC-COMPLETE marker rule.

### old_string
```
### Pre-implementation Data Model Card (MANDATORY)

Before writing the first line of fix code, produce a **Data Model Card** in your session log. The card lists every non-trivial data-model fact the fix depends on, with explicit doc support. Format:

| Fact the fix relies on | Doc citation (file + section/anchor) | Inferred-only? (Y/N) |
|---|---|---|

If any row is marked "inferred-only" (i.e. you could not find doc support and are reasoning from source code), **PAUSE** before editing and either (a) route the question to the orchestrator/user via SendMessage, or (b) close the doc gap *first* — confirm with measurement against the engine, then write the doc, then proceed with the fix. Source-code-only inference about data-model facts is the failure mode that produced two consecutive wrong diagnoses in dev-833f (Phase A endpoint mismatch, Phase B value-scale mismatch on the SoundChannels silence bug, 2026-04-30) before the third measurement-based diagnosis succeeded.

**See the cross-cutting "High-stakes inference categories" section in `.claude/CLAUDE.md`** for the full list of fact categories where silent inference is forbidden (axis semantics, dimension ordering, index conventions, "stored vs effective" entries, unit ranges, "same name different thing" pairs).
```

### new_string
```
### Pre-implementation Data Model Card (MANDATORY)

Before writing the first line of fix code, produce a **Data Model Card** in your session log. The card lists every non-trivial data-model fact the fix depends on, with explicit doc support. Format the heading literally as `## Data Model Card — 2026-05-05T12:30:22Z` (ISO 8601 UTC). Table format:

| Fact the fix relies on | Doc citation (file + section/anchor) | Inferred-only? (Y/N) |
|---|---|---|

After the table, emit `[DMC-COMPLETE]` on its own line to mark the card complete. The controller searches for this marker before any `[EDIT]` line targeting source files; missing or out-of-order DMC is a Tier-2 escalate.

If any row is marked "inferred-only" (i.e. you could not find doc support and are reasoning from source code), **PAUSE** before editing and either (a) route the question to the orchestrator/user via SendMessage, or (b) close the doc gap *first* — confirm with measurement against the engine, then write the doc, then proceed with the fix. Source-code-only inference about data-model facts is the failure mode that produced two consecutive wrong diagnoses in dev-833f (Phase A endpoint mismatch, Phase B value-scale mismatch on the SoundChannels silence bug, 2026-04-30) before the third measurement-based diagnosis succeeded.

**See the cross-cutting "High-stakes inference categories" section in `.claude/CLAUDE.md`** for the full list of fact categories where silent inference is forbidden (axis semantics, dimension ordering, index conventions, "stored vs effective" entries, unit ranges, "same name different thing" pairs).
```

---

## Patch 7 — dev.md: Step 4 Edit Code — EDIT + FILE-LOC markers

**File:** `D:\repos\PianoidInstall\.claude\commands\dev.md`
**Anchor reasoning:** The "Match existing patterns in the file" code-style bullet at the end of the Edit Code rules block (line 445) is unique. We append the EDIT and FILE-LOC marker rules right before "Rebuild after edits:".

### old_string
```
**Code style rules:**
- Minimum code for the task — no speculative features, no "while I'm here" cleanup
- One function, one responsibility — split at ~50 lines
- Fix root causes, not symptoms — no `#ifdef` hacks, no silent fallbacks
- Reuse existing helpers — grep before writing
- Match existing patterns in the file (naming, indentation, error handling)

**Rebuild after edits:**
```

### new_string
```
**Code style rules:**
- Minimum code for the task — no speculative features, no "while I'm here" cleanup
- One function, one responsibility — split at ~50 lines
- Fix root causes, not symptoms — no `#ifdef` hacks, no silent fallbacks
- Reuse existing helpers — grep before writing
- Match existing patterns in the file (naming, indentation, error handling)

**Edit markers (MANDATORY):** after each batch of `Edit`/`Write` calls on a tracked source file, emit `[EDIT] file=<path>`. After you finish editing a file, run `wc -l <path>` and emit `[FILE-LOC] <path> before=<N> after=<N>` (use the pre-edit LOC from the lock-acquisition snapshot). The controller flags threshold crosses (`before<500 && after>=500` or `before<1000 && after>=1000`) as Tier-1 warn — these correspond to C4 YELLOW and RED transitions and require updating `CODE_QUALITY.md` God Objects list in Step 8.

**Rebuild after edits:**
```

---

## Patch 8 — dev.md: Step 4 BUILD-PRECHECK marker

**File:** `D:\repos\PianoidInstall\.claude\commands\dev.md`
**Anchor reasoning:** The pre-build check fenced bash block (lines 453-467) ends with the unique cudart64_12.dll grep line. We append the BUILD-PRECHECK marker rule after the closing fence.

### old_string
```
# Also check cudart DLL
tasklist //M cudart64_12.dll 2>/dev/null | grep python && echo "WARNING: cudart64_12.dll locked — kill holder first"
```

**Build commands:** The build script MUST be invoked from `PianoidCore/` using its own `.venv`. Clear `VIRTUAL_ENV` first to prevent the script from installing into the wrong venv (see `docs/architecture/BUILD_SYSTEM.md` — the script uses `%REPO_ROOT%.venv`).
```

### new_string
```
# Also check cudart DLL
tasklist //M cudart64_12.dll 2>/dev/null | grep python && echo "WARNING: cudart64_12.dll locked — kill holder first"
```

**Pre-build marker (MANDATORY):** after running the precheck above, emit `[BUILD-PRECHECK] holders=<comma-separated-pids or "none">` to the session log. The controller alerts if `[BUILD STARTED]` appears without a preceding `[BUILD-PRECHECK]` (Tier-2 escalate).

**Build commands:** The build script MUST be invoked from `PianoidCore/` using its own `.venv`. Clear `VIRTUAL_ENV` first to prevent the script from installing into the wrong venv (see `docs/architecture/BUILD_SYSTEM.md` — the script uses `%REPO_ROOT%.venv`).
```

---

## Patch 9 — dev.md: Step 4 BUILD STARTED / BUILD OK / BUILD FAILED markers

**File:** `D:\repos\PianoidInstall\.claude\commands\dev.md`
**Anchor reasoning:** The Post-build verification block at lines 498-502 is unique (it's the only `import pianoidCuda; print(pianoidCuda.__file__)` snippet outside the docs path). We append the build-marker triple immediately after that block.

### old_string
```
**Post-build verification:**
```bash
PianoidCore/.venv/Scripts/python -c "import pianoidCuda; print(pianoidCuda.__file__)"
```
Verify the path is inside `PianoidCore/.venv/` (not root `.venv/`).

## Step 4b: Delegate to `/fn` Sub-Agents (preferred)
```

### new_string
```
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
```

---

## Patch 10 — dev.md: Step 4b TEST-WRITTEN / FN-SPAWNED / FN-RESULT markers + parent-lock note

**File:** `D:\repos\PianoidInstall\.claude\commands\dev.md`
**Anchor reasoning:** The "Verify locks" step in the Step 4b spawning procedure (line 551 with its unique "inherits locks from the parent; it does NOT acquire its own" sentence) is unique. We append fn-marker requirements + the controller note about parent-lock inheritance.

### old_string
```
2. **Verify locks** — all target files must be in this agent's lock list (acquired in Step 4). The sub-agent inherits locks from the parent; it does NOT acquire its own.

3. **Spawn** — use the `Agent` tool. Independent sub-agents can be spawned in parallel (single message, multiple Agent calls). Use `run_in_background: true` for parallel spawns.
```

### new_string
```
2. **Verify locks** — all target files must be in this agent's lock list (acquired in Step 4). The sub-agent inherits locks from the parent; it does NOT acquire its own.

   The controller verifies `/fn` parent-lock inheritance — fn-spawned edits must land on files in the parent dev agent's lock list. New files require the parent to retroactively add them to its own lock row before the fn agent edits, or the controller will Tier-3 halt.

3. **Spawn** — use the `Agent` tool. Independent sub-agents can be spawned in parallel (single message, multiple Agent calls). Use `run_in_background: true` for parallel spawns.

   **Markers (MANDATORY):**
   - Before the spawn: emit `[TEST-WRITTEN] path=<test-file>` (the test the parent prepared in the section above). The controller compares ordering — `[FN-SPAWNED]` without a preceding `[TEST-WRITTEN]` is a Tier-1 warn.
   - At the spawn: emit `[FN-SPAWNED] id=<fn-XXXX> target=<file>`.
   - After the fn results are incorporated into the parent log: emit `[FN-RESULT] id=<fn-XXXX> status=<ok\|fail>`. Step 5 entry in the parent log without all `[FN-RESULT]` lines having `status=ok` (or an explicit `[FN-RETRY]` / `[FN-INLINE-FALLBACK]` follow-up) is a Tier-2 escalate.
```

---

## Patch 11 — dev.md: Step 2 BASELINE-TEST marker

**File:** `D:\repos\PianoidInstall\.claude\commands\dev.md`
**Anchor reasoning:** The "If baseline tests fail" sentence at line 365 is unique. We append the BASELINE-TEST marker rule before the next step heading.

### old_string
```
If baseline tests fail, report to user and ask whether to proceed.

## Step 3: Branch (if needed)
```

### new_string
```
If baseline tests fail, report to user and ask whether to proceed.

**Marker (MANDATORY):** after baseline tests pass, emit `[BASELINE-TEST] 2026-05-05T12:30:22Z result=<pass\|fail> perf_log=/tmp/baseline_perf.log gpu_mean_ms=<N> sound_corr=<N>`. The controller alerts if Step 4 edit markers appear without a preceding `[BASELINE-TEST] result=pass` (Tier-1 warn).

## Step 3: Branch (if needed)
```

---

## Patch 12 — dev.md: Step 5 REGRESSION-CHECK / REGRESSION-DETECTED markers

**File:** `D:\repos\PianoidInstall\.claude\commands\dev.md`
**Anchor reasoning:** The "Warning (report but continue):" block at lines 662-664 is unique (only Step 5 talks about underrun count > 50%). We append the regression-marker rules right before the Step 6 heading.

### old_string
```
**Warning (report but continue):**
- GPU p99 increase > 20%
- Underrun count increase > 50%

## Step 6: Debug (if tests fail)
```

### new_string
```
**Warning (report but continue):**
- GPU p99 increase > 20%
- Underrun count increase > 50%

**Markers (MANDATORY):** after the comparison table, emit `[REGRESSION-CHECK] 2026-05-05T12:30:22Z gpu_mean_delta_pct=<N> sound_corr=<N> verdict=<pass\|warn\|fail>`. On `verdict=fail`, also emit `[REGRESSION-DETECTED] 2026-05-05T12:30:22Z file=<path> metric=<name> delta=<value>` per offending metric. The controller alerts if `[REGRESSION-DETECTED]` is followed by `[STEP-10A-PHASE-1]` without an intervening `[STEP-6-DEBUG]` marker (Tier-2 escalate — regression triggers debug, not commit).

## Step 6: Debug (if tests fail)
```

---

## Patch 13 — dev.md: Step 6 STEP-6-DEBUG iter marker

**File:** `D:\repos\PianoidInstall\.claude\commands\dev.md`
**Anchor reasoning:** The "After 5 failed iterations" sentence at line 681 is unique. We append the iteration-marker rule before the Step 7 heading.

### old_string
```
After 5 failed iterations, stop and report findings to the user. Do not keep looping.

## Step 7: Feature-Specific Testing (new features only)
```

### new_string
```
After 5 failed iterations, stop and report findings to the user. Do not keep looping.

**Marker (MANDATORY):** at the start of each debug iteration, emit `[STEP-6-DEBUG iter=<N>]` on its own line (in addition to the `### Step 6: Debug iteration N — <ISO timestamp>` step heading). The controller counts iterations: warn at iter 6, escalate at iter 8.

## Step 7: Feature-Specific Testing (new features only)
```

---

## Patch 14 — dev.md: Step 7 VERIFY-INVOKE marker

**File:** `D:\repos\PianoidInstall\.claude\commands\dev.md`
**Anchor reasoning:** The "Changes that require `/test-ui`" bulleted list (line 698-703) ends uniquely with "Any new UI control that sends data to the synthesis engine". We append the VERIFY-INVOKE marker rule before the "### 7b: Automated Tests" subheading.

### old_string
```
Changes that require `/test-ui`:
- Volume formula or sensitivity
- Excitation parameters (sliders, curves)
- Physical string parameters (tension, damping, etc.)
- Hammer shape changes
- Any new UI control that sends data to the synthesis engine

### 7b: Automated Tests
```

### new_string
```
Changes that require `/test-ui`:
- Volume formula or sensitivity
- Excitation parameters (sliders, curves)
- Physical string parameters (tension, damping, etc.)
- Hammer shape changes
- Any new UI control that sends data to the synthesis engine

**Marker (MANDATORY):** when invoking `/test-ui` or `/diagnose`, emit `[VERIFY-INVOKE] skill=<test-ui\|diagnose> mode=<audio_off\|audio_on>` to the session log. The controller cross-references the chosen mode against the agent's edited file list (synthesis-output vs mic-engaging classification per `.claude/CLAUDE.md` "Audio Verification Rule"). Wrong mode (e.g., calibration change verified via `/test-ui` instead of `/diagnose`) is a Tier-2 escalate.

### 7b: Automated Tests
```

---

## Patch 15 — dev.md: Step 8 STEP-8-COMPLETE / DOC-GAP markers + controller note

**File:** `D:\repos\PianoidInstall\.claude\commands\dev.md`
**Anchor reasoning:** The "Never add new ASCII art diagrams" sentence at lines 765-766 is the unique closing line of Step 8 before the Step 9 heading. We append the marker rules and the controller note immediately after.

### old_string
```
**Never add new ASCII art diagrams.** Replace existing ASCII diagrams with Mermaid or SVG
when you are already editing that section.

## Step 9: Merge Feature Branch to Dev
```

### new_string
```
**Never add new ASCII art diagrams.** Replace existing ASCII diagrams with Mermaid or SVG
when you are already editing that section.

**Markers (MANDATORY):**
- At the end of Step 8, emit `[STEP-8-COMPLETE] 2026-05-05T12:30:22Z docs_touched=<comma-separated-paths or "none">`. The controller alerts if `[STEP-10A-PHASE-1]`, `[STEP-10B-RESET]`, or `[STEP-10C-PAUSE]` appears without a preceding `[STEP-8-COMPLETE]` (Tier-2 escalate — Step 8 is mandatory for ALL exit procedures).
- If the session identified a doc gap, emit `[DOC-GAP] description=<one-line> resolution=<doc-edit\|wip-deferred> ref=<file-or-wip-anchor>`. The controller flags log entries that mention "doc gap" / "should be documented" if no doc edit or WIP entry follows before commit (Tier-1 warn).

## Step 9: Merge Feature Branch to Dev
```

---

## Patch 16 — dev.md: Step 10a Phase 1 / Phase 2 markers + controller note

**File:** `D:\repos\PianoidInstall\.claude\commands\dev.md`
**Anchor reasoning:** The "STOP HERE" line at line 850 with its full reasoning is unique. We extend it with Phase-1 marker, then append the Phase-2 marker requirement at the start of Phase 2.

### old_string
```
4. **Release locks** — remove this agent's rows from `docs/development/MODULE_LOCKS.md`

**STOP HERE.** Report changes to the orchestrator/user and wait for approval. Do NOT proceed to Phase 2 until explicitly told to.

#### Phase 2: User-approved (only after explicit approval)

5. **Archive log** — move log file to archive:
```

### new_string
```
4. **Release locks** — remove this agent's rows from `docs/development/MODULE_LOCKS.md`. Emit `[LOCK RELEASED] {file}` for each.

5. **Phase 1 marker** — emit `[STEP-10A-PHASE-1] 2026-05-05T12:30:22Z commit=<sha>` (use the most recent commit SHA from `git rev-parse HEAD`).

**STOP HERE.** Report changes to the orchestrator/user and wait for approval. Do NOT proceed to Phase 2 until explicitly told to. The controller cross-references `git log` against the orchestrator's approval-relay messages — Phase 2 actions (log archive, WIP cleanup) appearing before an approval-relay trigger Tier-2 escalate.

#### Phase 2: User-approved (only after explicit approval)

Emit `[STEP-10A-PHASE-2] 2026-05-05T12:30:22Z` as the first action of Phase 2. The Phase-2 timestamp must follow the orchestrator's approval-relay timestamp; the controller flags out-of-order Phase-2 starts as Tier-2 escalate.

5. **Archive log** — move log file to archive:
```

---

## Patch 17 — dev.md: Step 10b RESET markers

**File:** `D:\repos\PianoidInstall\.claude\commands\dev.md`
**Anchor reasoning:** The Step 10b sequence "Sequence: **Document → Revert → Release locks → Delete log → Clean WIP**" line is unique to Step 10b. We append the marker requirement immediately after.

### old_string
```
### 10b: Reset (failed implementation)

Sequence: **Document → Revert → Release locks → Delete log → Clean WIP**

1. **Verify Step 8 is done** — document what was attempted and why it failed (in WIP or relevant doc)
```

### new_string
```
### 10b: Reset (failed implementation)

Sequence: **Document → Revert → Release locks → Delete log → Clean WIP**

**Markers (MANDATORY):** wrap the reset in a pair: `[STEP-10B-RESET] 2026-05-05T12:30:22Z phase=start` at the beginning, `[STEP-10B-RESET] 2026-05-05T12:30:55Z phase=done` after all four actions complete. Between the markers the controller verifies all four actions happened; partial completion at `phase=done` (e.g., locks released but log not deleted) is the violation (Tier-2 escalate).

1. **Verify Step 8 is done** — document what was attempted and why it failed (in WIP or relevant doc)
```

---

## Patch 18 — dev.md: Step 10c PAUSE marker

**File:** `D:\repos\PianoidInstall\.claude\commands\dev.md`
**Anchor reasoning:** The Step 10c sequence "Sequence: **Document → Commit/stash → Snapshot → Release locks → Update WIP**" line is unique to Step 10c. We append the marker requirement after.

### old_string
```
### 10c: Pause (freeze for handoff)

Sequence: **Document → Commit/stash → Snapshot → Release locks → Update WIP**

Use this when work is incomplete but needs to be handed off to another session.

1. **Verify Step 8 is done** — document current state in relevant docs
```

### new_string
```
### 10c: Pause (freeze for handoff)

Sequence: **Document → Commit/stash → Snapshot → Release locks → Update WIP**

**Marker (MANDATORY):** at the start of the pause procedure, emit `[STEP-10C-PAUSE] 2026-05-05T12:30:22Z`. The `## Pause Snapshot` section format below remains as already specified.

Use this when work is incomplete but needs to be handed off to another session.

1. **Verify Step 8 is done** — document current state in relevant docs
```

---

## Patch 19 — dev.md: Step 10e RESTART marker

**File:** `D:\repos\PianoidInstall\.claude\commands\dev.md`
**Anchor reasoning:** The Step 10e header sentence "**The restarting agent MUST reuse the original agent's ID.**" is unique. We append the marker rule and a forward-reference to the controller after.

### old_string
```
### 10e: Restart After Lock Conflict

Use this when an agent was paused (10c) due to a lock conflict and the blocking lock has been released. The restarted agent must account for changes made by the agent that held the lock.

**The restarting agent MUST reuse the original agent's ID.**

#### Restart procedure
```

### new_string
```
### 10e: Restart After Lock Conflict

Use this when an agent was paused (10c) due to a lock conflict and the blocking lock has been released. The restarted agent must account for changes made by the agent that held the lock.

**The restarting agent MUST reuse the original agent's ID.**

**Marker (MANDATORY):** at the start of the restart procedure, emit `[STEP-10E-RESTART] 2026-05-05T12:30:22Z blocking_agent=<id-of-agent-that-held-the-lock>`. The `## Restart After Lock Conflict` section format below remains as already specified. The controller flags previously-paused agents that resume without the marker as Tier-1 warn.

#### Restart procedure
```

---

## Patch 20 — dev.md: Step 1 docs-first reference (controller monitoring note)

**File:** `D:\repos\PianoidInstall\.claude\commands\dev.md`
**Anchor reasoning:** The Step 1 numbered docs-list ending with "Check `docs/development/WORK_IN_PROGRESS.md` for related ongoing work" at line 201 is unique. We insert a controller note right before "### Check Module Locks and Repo Cleanliness".

### old_string
```
6. Check `docs/development/WORK_IN_PROGRESS.md` for related ongoing work

### Check Module Locks and Repo Cleanliness
```

### new_string
```
6. Check `docs/development/WORK_IN_PROGRESS.md` for related ongoing work

**Documentation-First compliance (controller-monitored).** The `[READ]` / `[GREP]` discipline above feeds the controller's Documentation-First compliance check. Skipping `docs/` and going straight to source greps in this step (or in Steps 5/6/7) is detected as a Tier-1 warn (first occurrence per session) or Tier-2 escalate (recurring). Exemptions: syntactic/mechanical tasks; doc-internal navigation; deep-dive on a specific source file the doc pointed to.

### Check Module Locks and Repo Cleanliness
```

---

## Patch 21 — orchestrator.md: Insert Controller Agent section after Step 1.5

**File:** `D:\repos\PianoidInstall\.claude\commands\orchestrator.md`
**Anchor reasoning:** The Step 1.5 "Repo Inconsistency Resolution" subsection ends with the unique line "Do NOT accept new tasks that touch the dirty files until resolved" before the `---` separator and the "## Dev Agent Rules Reference" heading. We insert (a) the controller-spawn bullet at the end of Step 1.5, and (b) the new "## Controller Agent" section after the separator, before "## Dev Agent Rules Reference".

### old_string
```
### Repo Inconsistency Resolution

When unlocked dirty files are found:
1. Report to user via Telegram with file list and `git diff --stat` summary
2. Ask user to decide: commit the changes, revert them, or investigate further
3. If user says investigate → spawn an Explore agent to determine what made the changes
4. Do NOT accept new tasks that touch the dirty files until resolved

---

## Dev Agent Rules Reference
```

### new_string
```
### Repo Inconsistency Resolution

When unlocked dirty files are found:
1. Report to user via Telegram with file list and `git diff --stat` summary
2. Ask user to decide: commit the changes, revert them, or investigate further
3. If user says investigate → spawn an Explore agent to determine what made the changes
4. Do NOT accept new tasks that touch the dirty files until resolved

### Spawn the Controller (LAST action of Step 1.5)

After the health check completes and before exiting Step 1.5, **spawn the controller agent**. Single Agent call, run_in_background, bypassPermissions. The controller initializes by reading the same lock/WIP/log state Step 1.5 just verified. Spawn happens once per orchestrator session — not per dispatch. See the "Controller Agent" section below for the full spawn template.

---

## Controller Agent

The orchestrator runs alongside a permanent **controller agent** for the full session. The controller is a read-only compliance monitor: it watches `MODULE_LOCKS.md`, `WORK_IN_PROGRESS.md`, dev-agent session logs, and `git status` and reports graduated alerts (warn → escalate → halt) to the orchestrator. It never edits source, never spawns or kills agents, never messages the user.

See the full proposal at `docs/proposals/controller-role.md` for the complete invariant catalogue, marker conventions, and tier rules.

### Lifecycle

- **Spawned once** at orchestrator startup, as the last action of Step 1.5
- **Lives** for the full orchestrator session (event-driven, near-zero idle cost)
- **Exits** when the orchestrator sends `SendMessage(to: "controller", "session ending")`
- **Singleton:** at most one controller per orchestrator session

### Spawn template

```javascript
Agent({
  team_name: "pianoid-dev",
  name: "controller",
  subagent_type: "general-purpose",
  run_in_background: true,
  mode: "bypassPermissions",
  description: "Compliance controller for this orchestrator session",
  prompt: `Run as the dev pipeline controller for this orchestrator session.

  Your job is to monitor /dev, /multitask, /fn, and any other dispatches for
  workflow compliance. You are read-only on project source — never use Edit
  or Write on PianoidCore, PianoidBasic, PianoidTunner, or any docs/ file.
  You may write only to your own session log at
  docs/development/logs/controller-<id>-<timestamp>.md.

  Initial actions:
    1. Generate controller ID: ctrl-$(openssl rand -hex 2)
    2. Create your session log
    3. Read docs/development/MODULE_LOCKS.md, WORK_IN_PROGRESS.md
    4. Glob docs/development/logs/dev-*.md (non-archive) to enumerate any
       pre-existing active sessions (e.g., orphaned from a prior orchestrator)
    5. Subscribe via Monitor to each pre-existing dev-agent log file (if any)
    6. Send initial pulse to team-lead — confirms boot, may report orphans

  Invariants to enforce — see docs/proposals/controller-role.md sections 5a,
  5b, 5c, 5d (substantive event-driven), 8d + 12 (periodic 30-min stale-agent
  scan), 8e (continuous Documentation-First sliding-window scan), and 9 (tier
  rules). Signal/marker conventions per Section 5e.

  STAY ALIVE until orchestrator sends "session ending". Do not exit on your
  own. Wake events: SendMessage from team-lead, Monitor notifications, pulse
  timer (5 min when ≥1 dev agent alive; 15 min idle), stale-agent scan timer
  (30 min).`
})
```

### What the controller monitors

The controller enforces invariants along **five functional axes**:

1. **Per-agent lifecycle** (Step-0 SLA, locks, commit prefix, premature Phase 2) — event-driven via `Monitor` on agent log files
2. **Cross-agent** (overlapping locks, sequential nvcc, untracked dirty files) — event-driven on `MODULE_LOCKS.md` / `git status`
3. **Workflow-specific** (multitask wave honesty, fn parent-lock inheritance, auto-trigger compliance) — event-driven
4. **Stale-agent + permission-stall** (agents stuck on a CLI permission prompt invisible to the Telegram user — the dominant stall pattern per CLAUDE.md "Known gaps in `bypassPermissions`") — periodic 30-minute sweep over unmatched `[BASH-CALL]` / `[MCP-CALL]` markers
5. **Documentation-First rule** (per CLAUDE.md "Documentation-First Rule (MANDATORY)") — continuous sliding-window scan over `[READ]` / `[GREP]` markers; flags agents grepping/reading source code without first consulting `docs/`

### Tier rules

| Tier | Trigger | Controller action |
|---|---|---|
| **Tier-1 (warn)** | Late Step 0 by 2 min; commit missing `[agent-id]` prefix; soft-convention break first occurrence | `SendMessage` to team-lead only |
| **Tier-2 (escalate)** | Late Step 0 by 5 min; agent edited unlocked file; premature Phase 2; `/fn` agent edited file outside parent's lock; unmatched `[BASH-CALL]` 30+ min | `SendMessage` to team-lead AND to dev agent ("pause edits and check with orchestrator") |
| **Tier-3 (halt)** | Two agents on same lock; unlocked dirty source file; concurrent `--heavy` builds; unmatched `[BASH-CALL]` 60+ min | `SendMessage` to team-lead with "HALT" prefix; SendMessage to ALL alive dev agents |

The orchestrator decides what to act on. The controller does not block, kill, or auto-recover.

### Suppression mechanism

Some invariants legitimately need to be relaxed for a specific session (e.g., a doc-only `/dev` agent). The orchestrator can `SendMessage(to: "controller", message: "suppress: <invariant>")` for the remainder of the session. Suppressions reset when the controller exits.

### Per-dispatch notification

**Every** Agent dispatch (regardless of skill: /dev, /multitask, /update-docs, /review, /test-ui, etc.) is preceded by a `SendMessage` to the controller with the agent ID, skill, task, and expected file scope. The controller filters its checks based on the skill field. See Step 3 "Spawning Sub-Agents" rule 6 below for the canonical pattern.

### Session-end notification

On `/orchestrator stop` or graceful shutdown, send `SendMessage(to: "controller", "session ending")`. The controller produces a final session summary, sends it to team-lead, archives its own log, and exits.

### Fallback when no controller exists

If the controller spawn fails at Step 1.5 (agent-team capacity exhausted, harness gate, or mid-session crash without re-spawn), the orchestrator's existing checks at the Anti-Patterns table row "Not verifying agent created session log + acquired locks" are the fallback. Controller failure is itself a Tier-2 issue but does NOT block dev work — the orchestrator re-attempts spawn at the next Step 1.5 opportunity.

---

## Dev Agent Rules Reference
```

---

## Patch 22 — orchestrator.md: Step 3 Spawning Sub-Agents — controller notification rule

**File:** `D:\repos\PianoidInstall\.claude\commands\orchestrator.md`
**Anchor reasoning:** The numbered "CRITICAL RULES" list at line 422 has duplicate `5.` numbering (line 455 and line 457 are both numbered "5."). The forward-reference rule at line 455 ("Controller agent. The team should include...") is unique. We REPLACE that stub with the new full rule 5 (controller notification per dispatch) and renumber the auto-commit rule to 6.

### old_string
```
5. **Controller agent.** The team should include a permanent controller agent whose job is to monitor /dev workflow compliance. See "Controller Agent" section below.

5. **Never let dev agents auto-commit.** Dev agents must STOP before Step 10 (wrap-up/commit) and report their changes. The orchestrator relays the report to the user. Only after explicit user approval does the orchestrator instruct the agent to proceed with Step 10.

   The only exception is if the user explicitly says "commit without asking" or "auto-wrap-up" for a specific task.
```

### new_string
```
5. **Controller agent.** The team includes a permanent controller agent spawned at orchestrator startup (Step 1.5) and alive for the full session. See the "Controller Agent" section above for the spawn template, lifecycle, and tier rules.

6. **Per-dispatch controller notification.** Every Agent dispatch (regardless of skill: /dev, /multitask, /update-docs, /review, /test-ui, /pianoid-ui, /analyse, /diagnose, /sync) MUST be preceded by a `SendMessage` to the controller. Send BEFORE spawning the agent so the controller is armed for the Step-0 SLA timer:

   ```
   SendMessage({
     to: "controller",
     summary: "New agent dispatched",
     message: "Add dev-<new-id> to watch list.
               Skill: /dev
               Task: <one-line>
               Expected file scope (best guess): <list>
               Spawn timestamp: <ISO 8601 UTC>"
   })
   ```

   Then spawn the agent as today. The controller filters its checks based on the `Skill:` field. Even non-editing skills (`/test-ui`, `/pianoid-ui`) are notified — this catches accidental source mutations during their execution.

7. **Never let dev agents auto-commit.** Dev agents must STOP before Step 10 (wrap-up/commit) and report their changes. The orchestrator relays the report to the user. Only after explicit user approval does the orchestrator instruct the agent to proceed with Step 10.

   The only exception is if the user explicitly says "commit without asking" or "auto-wrap-up" for a specific task.

8. **Approval-relay marker (controller gate signal).** After relaying user approval to a dev agent, also send `SendMessage(to: "controller", "approval-relayed agent=<id>")`. This is the gating signal the controller uses to detect premature Phase 2 actions (Phase 2 markers in the agent log preceding the approval-relay timestamp are a Tier-2 escalate).
```

---

## Patch 23 — orchestrator.md: Graceful shutdown — controller session-end notification

**File:** `D:\repos\PianoidInstall\.claude\commands\orchestrator.md`
**Anchor reasoning:** The "Graceful shutdown" subsection at line 741 with its numbered list (List active sub-agents, Warn user, Send final status) is unique. We append the controller notification step.

### old_string
```
### Graceful shutdown

On `/orchestrator stop` or user saying "stop" / "done for now":
1. List any active sub-agents still running
2. Warn user about in-progress work
3. Send final status summary via Telegram
```

### new_string
```
### Graceful shutdown

On `/orchestrator stop` or user saying "stop" / "done for now":
1. List any active sub-agents still running
2. Warn user about in-progress work
3. Send final status summary via Telegram
4. **Notify the controller:** `SendMessage(to: "controller", "session ending")`. The controller produces a final compliance summary, sends it to team-lead, archives its own log, and exits.
```

---

## Patch 24 — orchestrator.md: Anti-Patterns — update :782 row + add stalled-agent recovery row + dispatch-without-notify row

**File:** `D:\repos\PianoidInstall\.claude\commands\orchestrator.md`
**Anchor reasoning:** The unique row "Not verifying agent created session log + acquired locks | The controller agent handles this. If no controller, check within ~2 min..." at line 782 has identifying text ("controller agent handles this"). We rewrite it to clarify the always-alive lifecycle and add two NEW rows after it (dispatching without notifying, declaring stalled without checking stale-scan output).

### old_string
```
| Not verifying agent created session log + acquired locks | The controller agent handles this. If no controller, check within ~2 min that docs/development/logs/dev-*.md exists and MODULE_LOCKS.md has the agent's entry. Kill and respawn if not. SEVERE VIOLATION. |
```

### new_string
```
| Not verifying agent created session log + acquired locks | Controller (always alive once orchestrator is running, spawned at Step 1.5) handles this via the Step-0 SLA invariant. If controller-spawn fails at Step 1.5, fallback to orchestrator polling check at +2min, +5min that `docs/development/logs/dev-*.md` exists and `MODULE_LOCKS.md` has the agent's entry. Kill and respawn if not. SEVERE VIOLATION. |
| Dispatching an agent without notifying the controller | Every Agent dispatch is preceded by `SendMessage(to: "controller", ...)` with the agent ID, skill, task, and expected file scope (Step 3 rule 6). The controller cannot enforce Step-0 SLA on agents it does not know about. SEVERE. |
| Declaring a dev agent stalled without checking the controller's stale-scan output | The controller runs a 30-minute periodic stale-agent scan and reports candidates with their last marker (`[BASH-CALL]`, `[MCP-CALL]`, narrative, or final marker). Read the controller's most recent stale-scan SendMessage before declaring stalled — see "Stalled Agent Recovery" subsection below. |
```

---

## Patch 25 — orchestrator.md: Add Stalled Agent Recovery subsection

**File:** `D:\repos\PianoidInstall\.claude\commands\orchestrator.md`
**Anchor reasoning:** The Anti-Patterns table closes with the unique row "Sending hold message after agent completes | Send 'stop before Step 10' in the initial spawn prompt, not reactively" at line 795. We append the new "## Stalled Agent Recovery" section right after the Anti-Patterns table.

### old_string
```
| Sending hold message after agent completes | Send "stop before Step 10" in the initial spawn prompt, not reactively |
```

### new_string
```
| Sending hold message after agent completes | Send "stop before Step 10" in the initial spawn prompt, not reactively |

---

## Stalled Agent Recovery

When the controller reports a stalled-agent candidate via its 30-minute periodic stale-scan, follow this recovery protocol. The controller is the **detector**; the orchestrator is the **actor**.

### 1. Read the controller's stale-scan report

The controller's report names each candidate, its last log entry, the entry type, and a tier classification:

```
Stalled candidates:
  - dev-md01: last entry [BASH-CALL] 2026-05-05T12:30:22Z 'cmd //c start-pianoid.bat' (52 min ago)
              Type: unmatched BASH-CALL — Tier-2 likely permission stall (suspicion: high)
              Recommended: check CLI for pending prompt; if visible, approve. Else kill+respawn.
```

### 2. Identify the gating tool from the unmatched marker

For unmatched `[BASH-CALL]` or `[MCP-CALL]` markers, the command/tool name is the smoking gun. Match against the failure-mode catalogue in `docs/proposals/controller-role.md` Section 12:

| Pattern in last marker | Class | Reference |
|---|---|---|
| `cmd //c start*`, `cmd //c *start-pianoid.bat*`, `npm run dev*`, `Start-Process` without `-WindowStyle Hidden` | Long-running starter | Section 12a |
| `git rebase -i*`, `git add -i*`, `^python\s*$`, `gcloud auth login*`, `aws configure` | TTY-opening | Section 12b |
| `taskkill //F //PID <high-PID>` | taskkill on system PIDs | Section 12c |
| MCP `tool=*authenticate*\|*auth_init*\|*pair*` | MCP re-auth flow | Section 12d |
| `chrome-devtools__*` MCP tools | Browser-dependent MCP stdio drift | Section 12e |

### 3. Apply mitigation per pattern

- **Long-running starter** — instruct agent (or respawn) to use `PowerShell Start-Process -WindowStyle Hidden -RedirectStandardOutput ...` per `.claude/CLAUDE.md` known-gap workaround. For backend, prefer the launcher REST API (`POST http://127.0.0.1:3001/api/start-backend`).
- **TTY-opening** — instruct agent to use the non-interactive equivalent (e.g., `git rebase HEAD~3` non-interactive, pipe an answer file). For genuinely interactive operations, route via the `! <command>` prefix so the user runs it directly in the CLI.
- **taskkill on system PIDs** — instruct agent to scope by image name (`taskkill //F //IM <name>`) where possible, or `//T` (kill tree). Last resort: orchestrator runs the kill in its own context (its bash calls render as deltas the orchestrator can see).
- **MCP re-auth** — tell the user via Telegram: "Agent dev-XXXX needs OAuth re-auth for <server>. Please open the URL in your CLI and complete the flow, then send 'continue'." Once user confirms, `SendMessage` the agent to retry.
- **Chrome-devtools / MCP stdio drift** — instruct the user via Telegram to reload VS Code (orchestrator must be restarted afterward). The MCP server processes respawn fresh on reload.

### 4. Recovery actions in order of preference

1. **Inline recovery** — if the orchestrator can see the gating prompt directly (some prompts surface as harness deltas), approve there.
2. **User-side recovery** — if the orchestrator cannot see the prompt, tell the user via Telegram: "Check the CLI window for a pending permission prompt on agent dev-XXXX. Last attempted operation: `<command>`."
3. **Kill + respawn with adjusted approach** — if neither user nor orchestrator can recover, `TaskStop` the agent and respawn with the mitigation pattern from Section 12 (e.g., switch from `cmd //c start-pianoid.bat` to `PowerShell Start-Process -WindowStyle Hidden`). The respawned agent reuses the original agent ID per the persistence rule. Run Post-Kill Cleanup before respawn (release locks, archive log, clean WIP).

### 5. Notify controller after recovery

On successful recovery: `SendMessage(to: "controller", "stall recovered: agent=<id> action=<inline\|user-prompt\|kill-respawn>")`. The controller updates its watch list and resumes normal monitoring.

### Boundary

The controller never invokes `TaskStop`, never respawns, never auto-approves CLI prompts, never opens browser tabs to complete OAuth flows. Recovery authority lives entirely with the orchestrator — granting it to the controller would expand its surface area beyond the read-only-monitor design.
```

---

## Patch 26 — multitask.md: Phase 3.3a controller notification

**File:** `D:\repos\PianoidInstall\.claude\commands\multitask.md`
**Anchor reasoning:** The "All sub-agents for a wave are spawned in a SINGLE message" sentence at line 156 is unique to Phase 3.3a. We insert the controller notification rule immediately before it.

### old_string
```
- **DOCS-only tasks** → invoke `/update-docs <scope>` instead of `/dev`.

**All sub-agents for a wave are spawned in a SINGLE message** (parallel Agent tool calls). Use `run_in_background: true` if there are other tasks to coordinate.
```

### new_string
```
- **DOCS-only tasks** → invoke `/update-docs <scope>` instead of `/dev`.

**Controller notification (MANDATORY).** Before each wave's spawns, send `SendMessage(to: "controller", ...)` for every agent in the wave with the wave plan and conflict matrix. The controller pre-arms cross-agent invariant checks for the named file scopes. Notification format: `"Add <agent-id> to watch list. Skill: /dev. Task: <one-line>. Wave: <N>. Expected file scope: <list>. Conflict matrix: <pairs>. Spawn timestamp: <ISO>"`.

**All sub-agents for a wave are spawned in a SINGLE message** (parallel Agent tool calls). Use `run_in_background: true` if there are other tasks to coordinate.
```

---

## Patch 27 — fn.md: Step 2 lock-check controller note

**File:** `D:\repos\PianoidInstall\.claude\commands\fn.md`
**Anchor reasoning:** The Step 2 "Lock check" paragraph at line 112 is unique (only paragraph in fn.md mentioning `held_locks` + `parent_agent` together). We append the controller verification note.

### old_string
```
**Lock check:** If `held_locks` is provided, verify that `target_file` is in the list. If not, and a `parent_agent` exists, **stop and report** — the parent must acquire the lock first. If standalone (no parent), check `docs/development/MODULE_LOCKS.md` directly and acquire a lock if needed.

Log the edit: what changed, line numbers, rationale.
```

### new_string
```
**Lock check:** If `held_locks` is provided, verify that `target_file` is in the list. If not, and a `parent_agent` exists, **stop and report** — the parent must acquire the lock first. If standalone (no parent), check `docs/development/MODULE_LOCKS.md` directly and acquire a lock if needed.

The controller verifies parent-lock inheritance: if `target_file` is not in `held_locks` and no `parent_agent` is set, that's a Tier-2 escalate. Always verify before editing.

Log the edit: what changed, line numbers, rationale.
```

---

## Patch 28 — fn.md: Step 0 marker discipline (Bash, MCP, Read, Grep)

**File:** `D:\repos\PianoidInstall\.claude\commands\fn.md`
**Anchor reasoning:** The Step 0 "Logging Rule" subsection at line 76 ends with the unique line "Keep entries terse — this log will be incorporated into the parent's log." right before the "## Step 1" heading. We append a new "### Marker Discipline (cross-cutting)" subsection.

### old_string
```
Keep entries terse — this log will be incorporated into the parent's log.

## Step 1: Read Context
```

### new_string
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

The `[BASH-CALL]` / `[MCP-CALL]` pairs feed the controller's stale-agent monitoring (an unmatched call older than 30 minutes is a Tier-2 stall). The `[READ]` / `[GREP]` markers feed the Documentation-First compliance check. Failure to emit is itself a Tier-2 violation.

## Step 1: Read Context
```

---

## Verification

After all patches are applied, run the following grep commands. The expected match counts assume all patches landed cleanly.

```
grep -nE "Controller Agent|controller-role.md|stalled agent|periodic stale|\[BASH-CALL\]|\[MCP-CALL\]|\[READ\]|\[GREP\]|Documentation-First.*controller|stall-report" D:/repos/PianoidInstall/.claude/commands/orchestrator.md
# expect: 30+ matches (Controller Agent section + Stalled Agent Recovery + Step 3 rules + Anti-Patterns rows + controller-role.md cross-references)

grep -nE "Controller Agent|controller-role.md|stalled agent|periodic stale|\[BASH-CALL\]|\[MCP-CALL\]|\[READ\]|\[GREP\]|Documentation-First.*controller|stall-report" D:/repos/PianoidInstall/.claude/commands/dev.md
# expect: 40+ matches (Marker Convention catalogue lists every marker once; Bash/MCP/Read/Grep Discipline subsections; per-Step marker rules use [BASH-CALL] / [MCP-CALL] / [READ] / [GREP] in Discipline subsections only — per-Step bodies use other markers like [STEP-0-COMPLETE], [LOCK ACQUIRED], etc.)

grep -nE "Controller Agent|controller-role.md|stalled agent|periodic stale|\[BASH-CALL\]|\[MCP-CALL\]|\[READ\]|\[GREP\]|Documentation-First.*controller|stall-report" D:/repos/PianoidInstall/.claude/commands/multitask.md
# expect: 1 match (Phase 3.3a controller notification — references controller; no inline mention of "Controller Agent" section)

grep -nE "Controller Agent|controller-role.md|stalled agent|periodic stale|\[BASH-CALL\]|\[MCP-CALL\]|\[READ\]|\[GREP\]|Documentation-First.*controller|stall-report" D:/repos/PianoidInstall/.claude/commands/fn.md
# expect: 6 matches (one [BASH-CALL], one [MCP-CALL], one [READ], one [GREP] in Marker Discipline subsection + one controller-role.md mention if cross-referenced + lock-check controller note)
```

---

## Anchor Uniqueness Notes

All 28 `old_string` blocks were chosen to be unique within their target file based on:
- Distinctive trailing punctuation / closing line of a section
- Multi-line context spanning the boundary into the next subsection
- Unique adjacent headings as anchors

No anchor was ambiguous in the analysis.

## Cascading Issues / Flags for Orchestrator

1. **Patch 22 — duplicate `5.` numbering in orchestrator.md.** The current file has TWO list items numbered `5.` (lines 455 and 457). The patch replaces the first `5.` (the controller stub) AND renumbers the second `5.` (auto-commit) to `7.`, with a new `6.` (per-dispatch notification) inserted between, and a new `8.` (approval-relay marker) appended. Verify the renumbering doesn't conflict with any external doc that cites "rule 5" by line.

2. **Patch 16 — Step 10a Phase 1 step renumbering.** Adding a new step "5. Phase 1 marker" pushes the existing Phase-2 numbered actions (Archive log, Clean WIP, Merge — currently numbered 5, 6, 7) by one. The patch leaves them as 5, 6, 7 in their original block but the user-visible "phase 1 has steps 1-4, phase 2 has 5-7" semantics is now phase 1 steps 1-5, phase 2 steps 5-7 (number conflict). Recommend the orchestrator rewrites Phase 2 steps as 6, 7, 8 OR re-letters Phase 1 step 5 as "5a" — flagging for orchestrator decision before applying.

3. **Patch 21 — Controller Agent section is the largest patch (~140 lines new).** Anchor `\n---\n\n## Dev Agent Rules Reference\n` could in principle match elsewhere if a future patch were applied first. Recommend applying patches in order (1 through 28) without parallelism on orchestrator.md.

4. **Patch 5 / Patch 16 lock-marker overlap.** Patch 5 introduces `[LOCK ACQUIRED]` / `[LOCK RELEASED]` rules in Step 4. Patch 16 references `[LOCK RELEASED]` in Step 10a Phase 1 step 4. Both should land for consistency — Patch 5 BEFORE Patch 16 (the implementation order already does this).

5. **Patch 24 / Patch 25 ordering.** Patch 24 adds three new rows to the Anti-Patterns table; Patch 25 inserts the Stalled Agent Recovery section after the LAST row of the table. Apply Patch 24 first — Patch 25's anchor (the "Sending hold message" row) is the last row of the table both before and after Patch 24, so Patch 25's anchor remains valid regardless of order, but applying 24 first keeps the diff clean.

6. **Backwards compatibility for archived dev logs.** The Marker Convention block notes that archived logs predating the convention are exempt. The controller spec assumes a `controller_marker_baseline_date` configurable. Section 16 of the proposal does not require this date to be set in dev.md itself — the controller agent's spawn prompt will reference proposal Section 5e.6, so no additional dev.md edit is needed for backwards compatibility.

7. **Phase 1 marker timestamp typo risk.** Patches 1, 2, 6, 7, 9, 11, 12, 13, 15, 16, 17, 18, 19 use the literal example timestamp `2026-05-05T12:30:22Z`. This is intended as a format example, not a hard-coded value — readers replace it with `$(date -u +%Y-%m-%dT%H:%M:%SZ)` at emission time. The Marker Convention block (Patch 1) states this in the format-rules paragraph; verify by reading the rendered markdown post-application.
