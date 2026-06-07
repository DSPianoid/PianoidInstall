# dev-pipeline — bookkeeping helpers for the `/dev` workflow

Pure-Python, stdlib-only helper scripts that automate the **deterministic, zero-judgment**
bookkeeping steps of `.claude/commands/dev.md`. Each one collapses several Opus reasoning turns into
a single scripted call. Rationale + cost model:
`docs/proposals/minimize-opus-calls-dev-pipeline-2026-06-06.md` (Q3 rows 1, 2, 3, 8, 9).

> **Why these exist.** Every Opus turn re-reads the agent's entire accumulated context as a
> cache-read before doing anything. A bookkeeping turn late in a `/dev` session (when context is
> largest) costs the most. Replacing it with a script removes that whole turn. These scripts target
> the **safest** ops (no branch-on-meaning) at the **most expensive** point (late session).

> **Naming note (orchestrator reconcile):** the team-lead brief specified the directory
> `tools/dev-pipeline/` (hyphen); the proposal §2.3/§3 wrote `tools/dev_pipeline/` (underscore).
> This dir uses the **hyphen** per the brief. The scripts are invoked by absolute path (so a hyphen
> is fine — they are not an importable package). If `dev.md` Phase 3 prose is added that references
> these by path, it must use `tools/dev-pipeline/...`. Flag for the orchestrator to keep consistent.

## The line these scripts never cross

Scripts do **plumbing and gather evidence**; Opus owns **every branch-on-meaning** (proposal §2.3).
Concretely: these scripts never decide whether to branch, never acquire a lock, never classify a
test failure, never resolve a conflict, never write a commit message, never certify a Data Model
Card. They do the git/file moves and registry edits once those decisions are made.

All scripts: **deterministic**, **loud-and-local failure** (non-zero exit + clear stderr on any
inconsistency — never silently corrupt registry state), **stdlib-only**.

Run with the project venv Python:

```bash
# Windows
PianoidCore/.venv/Scripts/python tools/dev-pipeline/<script>.py ...
# Linux
PianoidCore/.venv/bin/python tools/dev-pipeline/<script>.py ...
```

Tests: `… -m pytest tools/dev-pipeline/tests -q` (145 tests; never touch the real repo, never run a
real CUDA build, never kill a real process — they build a throwaway tree under `tmp_path`, point the
scripts at it via `PIANOID_REPO_ROOT`, and monkeypatch every subprocess/git/launch/poll primitive).

---

## `dev_init.py` — Step-0 scaffold  (Q3 rows 1 + 7)

Generates the agent ID, writes the session-log header (byte-faithful to dev.md Step 0, with
`[STEP-0-COMPLETE] <ts>` as the first line under `## Actions`), adds the `## Active Dev Sessions`
row to `WORK_IN_PROGRESS.md`, optionally creates the feature branch, and prints the agent ID + log
path + `[STEP-0-COMPLETE]`.

```bash
python tools/dev-pipeline/dev_init.py "<task description>" \
    [--agent-id dev-xxxx]            # reuse an existing ID on restart/recovery
    [--branch feature/x --repo PianoidCore]   # create the branch (both required together)
    [--plan docs/proposals/x.md]     # plan file the session follows
    [--no-wip]                       # skip the WIP row
```

Opus still owns: the decision to branch-vs-work-on-dev, lock acquisition, the Data Model Card.

## `dev_wrap_phase2.py` — Step-10a Phase-2 wrap  (Q3 row 2)

Fires LATE (max context) — the highest $/turn row. **Run only after user approval** (the approval
is judgment and stays upstream; this is the deterministic *moves* only):

1. `git mv` session log → `logs/archive/`
2. remove the agent's `## Active Dev Sessions` row from `WORK_IN_PROGRESS.md`
3. (optional) `git mv` a shipped proposal → `docs/proposals/archive/` + prepend a
   `**Status:** … — Archived <date>.` line (dev.md Step 10a #9)

```bash
python tools/dev-pipeline/dev_wrap_phase2.py <agent-id> \
    [--proposal docs/proposals/<name>.md --status "IMPLEMENTED <agent> <sha>"]  # both required together
    [--no-git]    # move/edit in place without git (non-git tree / dry test)
```

Opus still owns: WHICH proposal shipped, and whether it's fully vs partially implemented (the script
refuses to archive unless told, and you supply the evidence text).

## `env_sweep.py` — port-scoped environment clearance  (Q3 rows 3 + 10)

**This script's entire reason to exist is to make the SAFE kill the only available path.** It encodes
the port-scoped, PID-targeted sweep once so an agent can never regress into a blanket
`taskkill //IM python.exe` / `Stop-Process -Name python` (which has killed MCP servers, Chrome
DevTools, and Claude Code itself — see `feedback_no_blanket_taskkill`).

**Safety invariant (structural):** the only processes ever killed are those discovered as LISTENERS
on the four Pianoid ports `3000/3001/5000/5001`. Never by image name. Never a fixed PID. Discovery +
kill are coupled per port, so there is no code path to kill anything else. Cross-platform
(Windows `Get-NetTCPConnection`→`Stop-Process`; Linux `lsof`/`ss`→`kill`).

```bash
python tools/dev-pipeline/env_sweep.py            # sweep + verify free + per-repo git status
python tools/dev-pipeline/env_sweep.py --no-kill  # inspect only (kill nothing)
python tools/dev-pipeline/env_sweep.py --json
```

Exit 0 = all swept ports free; 2 = one or more still in use. Opus still owns: WHETHER to sweep
(e.g. "a concurrent agent is using the stack" → scope down by **not calling it**, never by editing
the port list).

## `verify_phase1.py` — orchestrator Phase-1 verification  (Q3 row 9)

Pure verification (changes nothing). Runs the orchestrator's 4 boolean checks after a `/dev` agent
reports Phase-1 done, in the long-lived orchestrator context (so each saved turn is expensive there
too):

1. **commit_prefix** — HEAD commit subject in the work repo starts with `[<agent-id>]`
2. **locks_released** — `<agent-id>` holds no active row in `MODULE_LOCKS.md`
3. **log_in_logs** — session log still in `logs/` (NOT archived — archiving is Phase 2)
4. **wip_row_present** — agent still has its `## Active Dev Sessions` row (removed only in Phase 2)

```bash
python tools/dev-pipeline/verify_phase1.py <agent-id> \
    [--repo PianoidCore]   # which repo's HEAD to check (default PianoidCore)
    [--scan-repos]         # check the prefix against ALL repos' HEAD (PASS if any matches)
    [--json]
```

Exit 0 = all four PASS (a clean Phase-1 handoff); 2 = any FAIL.

---

## Phase 3 — test / build wrappers with a SPLIT verdict (correctness + cost)

The Phase-2 scripts above are zero-judgment plumbing. The three Phase-3 scripts wrap genuinely fiddly
procedures (perf parsing, the CUDA build discipline, the commit prefix). Each is deliberately
**split**: the script takes the *deterministic half* (run + parse + format + git plumbing) and Opus
keeps *every branch-on-meaning* (the regression verdict, the build-failure diagnosis, the message
wording). Rationale: proposal §2.2 rows 4/5/6, §2.3 "what must STAY Opus", §3 Phase 3.

### `run_perf.py` — perf-test runner + metric parser + delta table + verdict_hint  (Q3 row 4)

Runs the perf pytest, PARSES the metrics from its `-s` output (there is no junit/json — the metrics
are printed lines), prints the dev.md Step-5 markdown **delta table**, and emits the marker fields +
a `verdict_hint` computed from the STATIC dev.md Step-5 thresholds. **Opus still makes the regression
verdict** — the script only computes deltas + the hint (a perf-tradeoff change may legitimately
regress, which is judgment).

```bash
python tools/dev-pipeline/run_perf.py --baseline [--out baseline.json]   # Step 2: write a baseline
python tools/dev-pipeline/run_perf.py --compare baseline.json            # Step 5: diff + verdict_hint
    [--test-path tests/system/test_performance_audio_off.py]  # what to run (default audio_off perf)
    [--audio-on]        # also run the audio_on perf file (real driver; auto-skips without hardware)
    [--from-log <log>]  # parse an existing pytest log instead of running pytest
    [--json]
```

Parsed fields (a metric absent from the run — e.g. `gpu_p99`/`underrun` need the audio_on suite — is
recorded as null and skipped, never guessed): `gpu_mean`, `gpu_p99`, `total_mean`, `sound_corr`,
`underrun`. Static thresholds (dev.md Step 5 verbatim): **fail** on GPU mean +>10% OR sound_corr
< 0.95 OR any test failure; **warn** on GPU p99 +>20% OR underrun +>50%. `--baseline` prints
`[BASELINE-TEST]`; `--compare` prints the table + `[REGRESSION-CHECK] … verdict=<hint>` (+ a
`[REGRESSION-DETECTED]` per offender when the hint is `fail`). Exit mirrors the hint (0 pass/warn,
2 fail) — but the **authoritative verdict is Opus's**.

### `build_pianoid.py` — the BUILD_SYSTEM.md build discipline as ONE call  (Q3 row 6)

A pure-Python wrapper that encodes the `BUILD_SYSTEM.md` "Canonical Install / Rebuild" procedure once:
precheck `.pyd` holders → **stop the holder FIRST** (launcher REST `POST .../api/stop-backend`, else
PID-targeted `taskkill //F //PID`, **NEVER** `//IM python.exe`) → launch **DETACHED** via
`Start-Process -WindowStyle Hidden` with the bat invoked by **absolute path** after `cd /d <CORE>`
(Linux: the `.sh` directly) → poll the build log for `[SUCCESS] Build completed.` → grep-verify the
freshly-built binary for a marker → emit `[BUILD-PRECHECK]`/`[BUILD STARTED]`/`[BUILD OK]`/`[BUILD
FAIL]`. **It NEVER falls back to `pip install … pianoid_cuda/`** (the documented stale-`.pyd` trap).

```bash
python tools/dev-pipeline/build_pianoid.py [--heavy|--light] [--both|--release|--debug]
    [--core <PianoidCore abs path>] [--log <path>]
    [--marker "<string from your edit>"]   # post-build grep-verify (a stale pyd → marker absent → fail)
    [--no-stop] [--timeout 1200] [--poll 3] [--dry-run]
```

Default = `--heavy --both` (BUILD_SYSTEM.md mandates `--both`; `--release` leaves the debug pyd
stale). It also encodes the **destructive-uninstall guard**: if a holder survives the stop step it
ABORTS before launching (a held `.pyd` → uninstall `[WinError 5]` → bricked venv). **Build-failure
diagnosis STAYS Opus** — on failure the script detects the exit code (incl. `3221225794` =
0xC0000142) and tails the log; Opus reads the tail and applies the right documented recovery. Exit
0 = `[SUCCESS]` reached (+ marker present if given); 2 = failed/timed-out/marker-absent.

### `dev_commit.py` — commit with an ENFORCED `[agent-id]` prefix  (Q3 row 5)

`git add <files>` + `git commit -m "[<agent-id>] <type>: <msg>"`. Its one job beyond the git plumbing
is to GUARANTEE the dev.md `[<agent-id>] <type>: <subject>` convention every time — closing the
Tier-1 "missing/incorrect prefix" violation the controller currently catches by hand. It stages
**exactly** the given files (never `git add -A`), validates the type against the conventional-commit
set, and refuses an empty message / no files / a bad agent-id.

```bash
python tools/dev-pipeline/dev_commit.py <agent-id> <type> "<subject>" <file> [<file> ...]
    [--repo PianoidCore]   # repo the commit lands in (default: the Install repo root)
    [--body "<body>"] [--allow-empty] [--dry-run]
```

Opus still owns: the **message wording** (the agent supplies `<subject>`), WHICH files belong in the
commit, and WHETHER to commit / split. The script only assembles the prefix + does the `git`.

---

## Phase-1 marker hook — feasibility verdict + opt-in prototype

**Verdict: the proposal's row-8 hook (auto-append `[BASH-CALL]`/`[READ]`/`[MCP-CALL]`/… to the
CURRENT `/dev` agent's per-agent session log) is NOT cleanly feasible. It was NOT registered.**

### The blocker (measured against the Claude Code Hooks reference)

A `PostToolUse` hook's stdin carries: `session_id`, `transcript_path`, `cwd`, `tool_name`,
`tool_input`, `tool_response`, and — only inside a subagent — `agent_id` + `agent_type`. The
`agent_id` is the **harness subagent instance id**, NOT the `dev-XXXX` id the agent picks at Step 0
and uses to name its log `docs/development/logs/dev-XXXX-<ts>.md`.

**No hook event binds those two identifiers at a deterministic moment:**
- `SubagentStart` fires *before* the agent runs Step 0 / `dev_init.py`, so the `dev-XXXX` log doesn't
  exist yet — it can't record the mapping.
- `dev_init.py` runs *inside the agent's reasoning* and creates the log, but the agent's tool-call
  environment does **not** expose the harness `agent_id` — so it can't write a
  `harness_agent_id → log_path` mapping either.

The only concurrency-correct keys a hook actually has are `agent_id` (subagent) / `session_id`
(top-level) — neither of which the controller currently reads. A "just append to the
most-recently-modified log" heuristic is **rejected**: the orchestrator routinely runs 3+ `/dev` +
`/fn` agents at once (see `WORK_IN_PROGRESS.md`), so it would cross-attribute markers — *worse* than
a missing marker, because the controller's per-agent stall detection would read a stalled agent as
alive.

### Options (for the orchestrator/user to choose)

1. **Defer P1** (recommended). Agents keep hand-emitting markers (current behavior). Phases 0 + 2
   already capture the large majority of safe savings; the marker hook is the lowest-confidence item.
2. **Session-level variant** — `marker_hook.py` (built + tested here, **opt-in, unregistered**). A
   `PostToolUse` hook keyed by `agent_id`/`session_id` writes markers to
   `docs/development/logs/hook-markers/<key>.md` — deterministic + concurrency-safe, but NOT the
   per-agent dev log. Making it *useful* for stall-detection needs a controller-side change to also
   consult these files (orchestrator-owned). Until then it's a side-effect-only audit trail.
3. **Harness change** — if the harness later exposes the agent's own `agent_id` to its tool
   environment (or adds a `SessionStart`-per-subagent that carries both ids), the full row-8 hook
   becomes feasible. Infra dependency; out of scope here.

### `marker_hook.py` (prototype, NOT registered)

Built so option 2 is a real, testable artifact (not a sketch). Additive + non-fatal by contract:
**any error → silent exit 0 → agents fall back to hand-emitting** (current behavior); it never
blocks a tool call and never writes outside `docs/development/logs/hook-markers/`. Verified
mechanically with sample `PostToolUse` JSON (Bash/Read/Grep/MCP, concurrency, malformed-input).

**If option 2 is approved**, register it as a `PostToolUse` hook. Placement is a decision for the
orchestrator/user — **proposed, not assumed**:
- **`.claude/settings.json`** (committed, project-wide) — affects *every* session in the repo,
  including the user's own non-dev sessions. Choose this only if the audit trail is wanted globally.
- **`.claude/settings.local.json`** (machine-local, gitignored) — affects only this machine. Safer
  default for a prototype.

```jsonc
// PostToolUse hook config (do NOT add until option 2 is approved + placement chosen)
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash|Read|Grep|Glob|mcp__.*",
        "hooks": [
          { "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/PianoidCore/.venv/Scripts/python \"$CLAUDE_PROJECT_DIR\"/tools/dev-pipeline/marker_hook.py" }
        ]
      }
    ]
  }
}
```
