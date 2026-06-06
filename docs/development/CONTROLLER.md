# Controller Agent — Working Reference

The **controller** is a permanent, read-only compliance monitor spawned once per
orchestrator session. It watches the four authoritative state files
(`MODULE_LOCKS.md`, `WORK_IN_PROGRESS.md`, `docs/development/logs/*`, repo
`git status`) plus the marker stream in each dev-agent session log, and reports
graduated alerts (warn → escalate → halt) to the orchestrator. It never edits
source, never spawns or kills agents, never invokes a skill, never messages the
user, and never auto-recovers a stalled agent.

This is the operational reference the live orchestrator and controller follow.
It is the working home of the controller spec — the orchestrator's "Controller
Agent" section (`.claude/commands/orchestrator.md`) points here, and the
dev-agent marker discipline lives in `.claude/commands/dev.md`.

> Where this doc and the dev/orchestrator skills disagree, the **skills are
> authoritative** — they are what the live agents execute. This doc tracks them.

---

## Role, Lifecycle, and Non-Goals

### Role

The controller exists for one purpose: enforce the workflow invariants documented
in `orchestrator.md`, `dev.md`, `multitask.md`, and `fn.md` while dev agents run
in parallel or in sequence. It is a **detector**, not an **actor** — every action
on its findings is taken by the orchestrator.

| Concern | Owner |
|---|---|
| Communication with the user | Orchestrator only |
| Spawning, killing, pausing dev agents | Orchestrator only |
| Approving user requests | Orchestrator only |
| Invoking any skill (`/dev`, `/test-ui`, …) | Orchestrator only — the controller invokes none |
| Reading lock / WIP / log files | Either |
| Detecting invariant violations | **Controller** (primary); orchestrator is the fallback if no controller |
| Detecting stalled agents (periodic sweep) | **Controller** |
| Acting on violations / stalls (relay to user, instruct or kill agent, approve a CLI prompt) | Orchestrator |
| Final compliance summary | Controller |

### Lifecycle

- **Spawned once** at orchestrator startup, as the last action of Step 1.5 (Repo
  Health Check) — a single `Agent` call with `name: "controller"`,
  `run_in_background: true`, `mode: "bypassPermissions"`. Spawn is per session,
  not per dispatch.
- **Boots** by generating a controller ID `ctrl-$(openssl rand -hex 2)`, creating
  its own session log at `docs/development/logs/controller-<id>-<timestamp>.md`,
  reading `MODULE_LOCKS.md` + `WORK_IN_PROGRESS.md`, `Glob`-ing non-archive
  `dev-*.md` logs to pick up any orphaned sessions, subscribing via `Monitor` to
  each, and sending an initial boot pulse to `team-lead`.
- **Lives** for the full orchestrator session, event-driven (near-zero idle
  cost). It wakes on: a `SendMessage` from the orchestrator (new dispatch /
  `suppress` / `session ending`), a `Monitor` notification (a watched log gained
  a line), the pulse timer (5 min while ≥1 dev agent is alive; 15 min idle), and
  the periodic stale-agent scan timer (30 min).
- **Notified** on every dispatch: the orchestrator sends `SendMessage(to: "controller", …)`
  with the agent ID, skill, task, and expected file scope before each Agent
  dispatch (any skill). The controller filters its checks on the skill field.
- **Exits** when the orchestrator sends `SendMessage(to: "controller", "session ending")` —
  it writes a final session summary, sends it to `team-lead`, archives its own
  log to `logs/archive/`, and exits.
- **Singleton:** at most one controller per orchestrator session. If the spawn
  fails or the controller crashes mid-session, the orchestrator's existing
  Anti-Patterns fallback ("verify the agent created a session log + acquired
  locks") covers the Step-0 SLA; controller failure is a Tier-2 issue but does
  NOT block dev work, and the orchestrator re-attempts the spawn at the next
  Step 1.5 opportunity.

### Tools and permissions

Read-only on project source. `Read` / `Grep` / `Glob` (lock/WIP/log files,
`.claude/commands/*`), read-only `Bash` (`git status`, `git log`,
`git diff --name-only`, `tasklist`, `netstat`), `SendMessage` (to `team-lead`
and named dev agents), `Monitor` (the heartbeat mechanism — new log lines are
notifications, the controller does not poll). It may `Write` ONLY its own
session log. `Edit` / `Write` / `NotebookEdit` on any project file, and any
state-mutating `Bash` (`git commit`, `taskkill`, anything writing outside its
own log), are forbidden.

### Non-goals

The controller does NOT:

- **Spawn a controller per skill** — one per orchestrator session covers every
  dispatch (`/dev`, `/multitask`, `/fn`, and any other).
- **Change dev-agent or orchestrator discipline** — it enforces the existing
  rules; it introduces none, and the orchestrator's user-facing protocol is
  unchanged.
- **Add tools or MCP servers** — it uses existing harness primitives only.
- **Persist state across sessions** — each `/orchestrator start` gets a fresh
  controller; watch list, alert history, and suppressions reset on exit.
- **Block agents** — all enforcement is advisory; the orchestrator decides
  actions. The advisory message to a flagged dev agent is not a hard stop.
- **Invoke any skill.**
- **Auto-recover stalled agents.** The stale-agent sweep detects stalls and
  reports them; it never invokes `TaskStop`, never respawns, never auto-approves
  a CLI permission prompt, never opens a browser to complete an OAuth flow.
  Recovery is the orchestrator's job (see [Failure-Mode Catalogue](#failure-mode-catalogue)).
  This boundary is intentional — recovery authority would require actor-level
  permissions (Bash, TaskStop) that the read-only design deliberately withholds.

---

## Invariant Catalogue

The controller enforces invariants along **five functional axes**. The first
three (5a–5c) plus the dev anti-patterns (5d) are the substantive,
**event-driven** checks (catch *what the agent did wrong* the moment a watched
log file updates). The stale-agent axis is **periodic** (catches *what the agent
stopped doing* — silence produces no event). The Documentation-First axis is a
**continuous sliding-window** scan over a *sequence* of events (catches *how the
agent investigates*).

| Axis | Catches | Detection mode |
|---|---|---|
| 5a Per-agent lifecycle | Step-0 SLA, locks, commit prefix, premature Phase 2 | event-driven (`Monitor` on log file) |
| 5b Cross-agent | overlapping locks, sequential nvcc, untracked dirty files | event-driven + file-update of `MODULE_LOCKS.md` / `git status` |
| 5c Workflow-specific | multitask wave honesty, fn parent-lock inheritance, auto-trigger compliance | event-driven |
| 5d Dev anti-patterns | the per-step `/dev`-discipline checks | event-driven (log markers + `git status`) |
| **Stale-agent + permission-stall** | agents that stopped advancing — long-running bash, TTY-blocking, system-PID taskkill, MCP OAuth gates | **periodic 30-min sweep** over unmatched `[BASH-CALL]` / `[MCP-CALL]` markers |
| **Documentation-First** | agents grepping/reading source code without first consulting `docs/` | **continuous sliding-window** over `[READ]` / `[GREP]` markers |

### 5a. Per-agent lifecycle invariants

For each dev agent the orchestrator dispatches:

- **Step 0 within 120 s.** A log file `docs/development/logs/<agent-id>-*.md`
  must exist with the header block + a `[STEP-0-COMPLETE]` marker. *Tier-1 at
  +120 s, Tier-2 at +300 s.*
- **WIP registration within 120 s.** `WORK_IN_PROGRESS.md` `## Active Dev Sessions`
  must contain a row for the agent ID. *Same tiers.*
- **Lock acquisition before Step 4 edits.** Before any file the agent modifies
  appears dirty in `git status`, `MODULE_LOCKS.md` must list it under the agent
  ID. Detection: snapshot `git status --short` per repo, cross-reference dirty
  files against the locks table. *Tier-3 halt on an unlocked dirty file.*
- **Commit prefix discipline.** Every commit made during the session starts with
  `[<agent-id>]`. *Tier-1 warn (first occurrence), Tier-2 on repeat.*
- **No premature Phase 2.** If the log shows Step 10a Phase 2 actions (log moved
  to `logs/archive/`, WIP row removed) without an orchestrator-relayed user
  approval since the corresponding Phase 1 stop. *Tier-2 escalate.*
- **Cleanup on exit.** On CLOSED / KILLED / RESET: locks released, WIP row
  removed (or paused-marked), log appropriately archived/preserved. *Tier-2 on
  residue.*

### 5b. Cross-agent invariants (active when ≥2 dev agents are alive)

- **No overlapping locks.** No two agents may list the same file in
  `MODULE_LOCKS.md`. *Tier-3 halt — repo invariant.*
- **No untracked dirty files.** A dirty file in `git status` whose path is in no
  active agent's lock list. *Tier-3 halt.*
- **Sequential nvcc.** If two active agents both need a `--heavy` CUDA build, the
  multitask conflict rules should have prevented parallelism — if it slipped
  through, *Tier-3 halt* before either runs `build_pianoid_cuda.bat`.
- **File-proximity surprise.** Two agents lock different files in the same module
  (same directory, `.cu` family, or Python class graph). *Tier-1 informational —
  not a violation*, so the orchestrator can surface the coordination need.

### 5c. Workflow-specific invariants

- **`/multitask` wave honesty.** Wave-N agents must be CLOSED before wave-N+1
  spawns. *Tier-2 escalate.*
- **`/fn` parent-lock inheritance.** A file edited by a `/fn` sub-agent must be in
  the *parent* dev agent's lock list — `/fn` does not acquire its own locks.
  *Tier-2 escalate* if a `fn-*` ID appears in `MODULE_LOCKS.md`.
- **Auto-trigger compliance.** If a non-`/dev` skill (e.g. `/update-docs`) edits
  `.cu` / `.cpp` / `.cuh` / `.h` / `setup.py`, *Tier-2 escalate* — the explicit
  violation called out in `.claude/CLAUDE.md` "Auto-Trigger Rules".

### 5d. Dev anti-patterns (per-step `/dev` discipline)

These govern the dev agent's internal `/dev` workflow. The controller enforces
them by reading the agent's session-log markers (live, via `Monitor`) and
cross-referencing `git status`, `MODULE_LOCKS.md`, `WORK_IN_PROGRESS.md`, and
`git log`. High-stakes invariants (lock-before-edit, no overlapping locks,
sequential nvcc) use ground-truth file-system state, not log-pattern matching.

| Step | Rule | Severity | Signal |
|---|---|---|---|
| 0 | Session log created within 120 s | T1 +120 s / T2 +300 s | `[STEP-0-COMPLETE]` + log file `Glob` |
| 0 | WIP entry added | T1 +120 s / T2 +300 s | `WORK_IN_PROGRESS.md` row |
| 0 | Recovered agent reuses original ID | T1 warn | new `dev-*` ID vs a Paused WIP entry / `**Resuming:**` line |
| 1b | NEVER blanket-kill `python.exe` / `node.exe` | T3 halt | absence of `[STEP-1B-KILL] port=… pid=…` around a `taskkill` (heuristic) |
| 1b | Use venv python, never system Python | T2 | `[STEP-1B-VENV-CHECK]` interpreter prefix |
| 1b | Servers cleaned up before exit | T2 | unmatched `[SERVER-START]` / `[SERVER-STOP]` pair at CLOSED |
| 1b | Backend startup ≤ 3 retries | T1 | count of `[SERVER-START] port=5000` in <5 min |
| 4 | **Lock-before-edit** | T3 halt | `git status --short` dirty file vs `MODULE_LOCKS.md`; `[LOCK ACQUIRED]`/`[LOCK RELEASED]` divergence |
| 4 | Data Model Card before fix code | T2 | `## Data Model Card` + `[DMC-COMPLETE]` before first `[EDIT]` on source |
| 4 | C4 file-size watch (500/1000 LOC) | T1 | `[FILE-LOC] before=… after=…` crossing a threshold |
| 4 | Pre-build hygiene (kill `.pyd` holders) | T2 | `[BUILD-PRECHECK]` before `[BUILD STARTED]` |
| 4 | Canonical `build_pianoid_cuda.bat`, never `pip install --force-reinstall` | T2 | `pip install …pianoid_cuda/` with no paired `[BUILD STARTED]` |
| 4 | Verify the rebuild landed | T1 | `[BUILD OK] … verified=yes` before Step 5 |
| 4b | Tests written FIRST (by the dev agent) | T1 | `[TEST-WRITTEN]` before `[FN-SPAWNED]` |
| 4b | `/fn` inherits parent locks | T2 | no `fn-*` rows in `MODULE_LOCKS.md` |
| 4b | Parent archives `fn-*` logs; handles fn failures | T1 / T2 | `[FN-RESULT] status=…` vs Step 5 entry |
| 5/6 | Baseline test before any edit | T1 | `[BASELINE-TEST] result=pass` before Step 4 |
| 5/6 | Hard-fail regression → Step 6, not commit | T2 | `[REGRESSION-DETECTED]` → `[STEP-10A-PHASE-1]` with no intervening `[STEP-6-DEBUG]` |
| 5/6 | Debug loop ≤ 5 iterations | T1 iter 6 / T2 iter 8 | `[STEP-6-DEBUG iter=N]` count |
| 7 | Audio-affecting change → `/test-ui` (audio_off) or `/diagnose` (audio_on) per strict-A1 | T2 wrong/missing mode | `[VERIFY-INVOKE] skill=… mode=…` vs touched-file class |
| 8 | Step 8 before any 10a/b/c exit | T2 | `[STEP-8-COMPLETE]` before the exit marker |
| 8 | Doc-gap closed (or WIP item filed) | T1 | `[DOC-GAP] resolution=…` populated before commit |
| 8 | C4 God Objects list updated on threshold cross | T1 | `[FILE-LOC]` cross + `CODE_QUALITY.md` in commit |
| 9 | Feature branch must merge to dev | T2 | `git log dev..feature/*` non-empty at CLOSED |
| 10 | Commit `[<agent-id>]` prefix | T1 / T2 | `git log` since spawn |
| 10 | Phase 1 stops; Phase 2 only after approval | T2 | `[STEP-10A-PHASE-2]` timestamp vs orchestrator approval-relay |
| 10 | 10b reset = revert + release locks + delete log + clean WIP | T2 | `[STEP-10B-RESET] phase=start/done` completeness |
| 10 | 10c pause writes a Pause Snapshot | T2 | `[STEP-10C-PAUSE]` + `## Pause Snapshot` section |
| 10 | 10e restart-after-lock acknowledges the blocking agent | T1 | `[STEP-10E-RESTART] blocking_agent=…` + section |

**Detection limitations.** Log-pattern checks are reliable because the agents are
mandatory logging citizens (`dev.md`), but they are not adversarially robust. A
few checks (e.g. blanket `taskkill //F //IM python.exe`) are heuristic — they
catch the common form but a determined misuse can evade. The orchestrator's own
source-read anti-pattern is not directly observable to the controller (the
orchestrator's tool-use is in its own conversation, not a file) — the controller
catches the consequence (an unlocked dirty file via the lock-before-edit check),
not the act.

---

## Marker Conventions

The controller's enforcement is only as reliable as the signals dev agents emit.
`dev.md` therefore mandates explicit **markers** at action boundaries:
short bracketed tags on their own line in the session log, additive to (never a
replacement for) the `### Step N` headings and the `## Data Model Card` /
`## Pause Snapshot` / `## Files Modified` structured sections.

**Format.** Each marker is on its own line at column 0; a carried timestamp
follows the closing bracket (`[BUILD STARTED] 2026-05-05T12:30:22Z mode=heavy
variant=release`); fields use space-separated `key=value`; values with spaces are
quoted. Markers are emitted by the agent's own `Edit`/`Write` to its log — no
special tooling. **Backwards compatibility:** archived logs predating the
convention lack these markers; only new sessions are checked against them.

### Signal grammar (the markers the controller reads)

| Marker | Emitted | Captures |
|---|---|---|
| `[STEP-0-COMPLETE] {ts}` | first line under `## Actions` once log + WIP + locks are set | Step-0 SLA gate |
| `[LOCK ACQUIRED] {file}` / `[LOCK RELEASED] {file}` | on adding/removing a file from the lock row | lock-acquire/release intent |
| `[STEP-1B-KILL] port=<N> pid=<N>` | before any port-scoped `taskkill` | port-scoped kill (its absence around a kill = blanket-kill smell) |
| `[STEP-1B-VENV-CHECK] interpreter=<path>` | once before first venv use | confirms venv interpreter |
| `[SERVER-START] role=<r> port=<N> pid=<N>` / `[SERVER-STOP] port=<N> pid=<N>` | starting / stopping a server | server lifecycle (every START needs a STOP before CLOSED) |
| `[DMC-COMPLETE]` | end of the Data Model Card | card-complete signal |
| `[EDIT] file=<path>` | each Edit/Write on a source file | edit-operation log |
| `[FILE-LOC] <path> before=<N> after=<N>` | after an edit batch on a file | C4 threshold tracking |
| `[BUILD-PRECHECK] holders=<pids\|none>` | before a build | pre-build hygiene ran |
| `[BUILD STARTED] {ts} mode=<heavy\|light> variant=<release\|debug>` | build start | canonical build start |
| `[BUILD OK] {ts} duration=<s> marker=<s> verified=<y\|n>` | build success | build success + rebuild verification |
| `[BUILD FAILED] {ts} code=<N> error_summary=<…>` | build failure | build failure |
| `[TEST-WRITTEN] path=<…>` | Step 4b before fn-spawn | test exists before sub-agent |
| `[FN-SPAWNED] id=<fn-…> target=<…>` / `[FN-RESULT] id=<fn-…> status=<ok\|fail>` | parent log at spawn / completion | fn lifecycle |
| `[BASELINE-TEST] {ts} result=<pass\|fail> …` | after Step 2 | baseline ran before Step 4 |
| `[REGRESSION-CHECK] {ts} … verdict=<v>` / `[REGRESSION-DETECTED] {ts} file=… metric=… delta=…` | after Step 5 | post-change perf verdict + per-metric regression |
| `[STEP-6-DEBUG iter=<N>]` | each debug iteration | debug-iteration counter |
| `[VERIFY-INVOKE] skill=<test-ui\|diagnose> mode=<audio_off\|audio_on>` | Step 7 | audio-mode routing record |
| `[STEP-8-COMPLETE] {ts} docs_touched=<…>` | end of Step 8 | doc update done |
| `[DOC-GAP] description=<…> resolution=<doc-edit\|wip-deferred> ref=<…>` | Step 8 if a gap is found | doc-gap closure record |
| `[STEP-10A-PHASE-1] {ts} commit=<sha>` / `[STEP-10A-PHASE-2] {ts}` | Phase 1 complete / Phase 2 start | Phase boundaries (Phase-2 timestamp is checked against the orchestrator's approval relay) |
| `[STEP-10B-RESET] {ts} phase=<start\|done>` | 10b boundaries | reset completeness |
| `[STEP-10C-PAUSE] {ts}` | start of 10c | pause-start marker |
| `[STEP-10E-RESTART] {ts} blocking_agent=<id>` | start of 10e | restart-after-lock marker |
| `[BASH-CALL] {ts} {cmd_summary}` / `[BASH-RETURN] {ts} duration_ms=<N> exit_code=<N>` | before / after every `Bash` invocation | Bash-call boundary (the primary stall signal) |
| `[MCP-CALL] {ts} server=<name> tool=<name> args_summary=<…>` / `[MCP-RETURN] {ts} duration_ms=<N> status=<ok\|error>` | before / after every MCP tool invocation | MCP-call boundary (secondary stall signal) |
| `[READ] {ts} path=<path>` | before every `Read` on a project file | feeds the Documentation-First check |
| `[GREP] {ts} pattern=<pattern> path=<path>` | before every `Grep`/`Glob` on project files | feeds the Documentation-First check |
| `[PROGRESS] {ts} step=<N> note=<…>` | at every step heading AND ≥ every 3 min during any long op | liveness heartbeat (a fresh `[PROGRESS]` resets the stall clock) |
| `[PERM-RISK] {ts} action=<…> method=<…> gate-risk=<…>` | before any gate-risky action (process-spawn, taskkill, MCP-auth) | permission-risk pre-marker (a trailing `[PERM-RISK]` on a stale log escalates immediately) |

**Load-bearing pairs.** `[BASH-CALL]`/`[BASH-RETURN]`, `[MCP-CALL]`/`[MCP-RETURN]`,
and the `[PROGRESS]` heartbeat are what make stall detection possible. Failure to
emit the `*-CALL`/`*-RETURN` markers, or the `[READ]`/`[GREP]` markers, is itself
a **Tier-2** violation — without them the controller cannot detect a CLI
permission stall or enforce Documentation-First.

---

## Periodic Scans

### Stale-agent sweep (every 30 minutes)

The event-driven axes never catch an agent that simply STOPS writing — e.g. one
stuck on a CLI permission prompt invisible to the Telegram user (the **dominant
stall pattern** per `.claude/CLAUDE.md` "Known gaps in `bypassPermissions`"). The
controller runs a **30-minute** sweep while ≥1 dev/fn agent is alive (it may also
fire out-of-band on an orchestrator `freshness-tick` poke when the orchestrator
independently suspects an agent has gone quiet).

**Per-agent procedure.** For each watched agent: read the session log, find the
**last non-blank line** and its timestamp (from a `### Step N … — <ISO ts>`
heading or a marker's `{ts}`; fall back to file mtime and flag that as a Tier-1
logging-discipline issue), classify the last-entry type, and compute the stall
duration `now − last_entry_timestamp`.

The unmatched-marker freshness thresholds the dev agents are told to expect
(`dev.md`): an unmatched `[BASH-CALL]`/`[MCP-CALL]` or a `[PROGRESS]` heartbeat
older than `STALL_THRESHOLD = 8 minutes` is the primary stall signal; older than
20 minutes is the hard-stall signal; a trailing `[PERM-RISK]` escalates
immediately. At the controller's sweep granularity, the tier mapping the
orchestrator enforces is:

| Last-entry signal | Age | Tier |
|---|---|---|
| fresh `[PROGRESS]` heartbeat | any | none — heartbeat proves liveness mid-operation |
| `[PERM-RISK]` newest line | stale | **T2 — almost-certain permission stall, escalate now** |
| final marker (`[STEP-10A-PHASE-1/2]`, `[STEP-10B-RESET phase=done]`, pause) | any | none — legitimately idle pending orchestrator follow-up |
| normal narration / step heading | 30+ min | T2 escalate |
| unmatched `[BASH-CALL]` / `[MCP-CALL]` | 30+ min | **T2 escalate** |
| unmatched `[BASH-CALL]` / `[MCP-CALL]`, stale `[PROGRESS]`, or `[PERM-RISK]` | 60+ min | **T3 halt** |

The controller finishes the sweep with one `SendMessage` to `team-lead` listing
each stalled candidate (last entry, type, tier, suspicion, recommended action),
or a one-line "no stalls". **It never wakes the agent** — it reports candidates;
the orchestrator acts (approve a visible CLI prompt, tell the user via Telegram,
or kill + respawn with the documented workaround). See
[Failure-Mode Catalogue](#failure-mode-catalogue).

### Documentation-First sliding-window scan (continuous)

The CLAUDE.md "Documentation-First Rule (MANDATORY)" requires dev agents to
consult `docs/` BEFORE grepping/reading source — at session start, mid-task, and
especially during debugging. The check runs in the event-driven loop: whenever an
agent's log gains a `[READ]` or `[GREP]` line, the controller re-evaluates the
trailing window for that agent.

**Procedure.** Classify each marker target:
- **Doc-read** — `path` under `docs/` (any sub-tree). Satisfies the rule, resets
  the docs-skipping counter for that phase.
- **Source-read** — `path` under `PianoidCore/`, `PianoidBasic/`,
  `PianoidTunner/`, or `tests/` and NOT under `docs/`. A skip candidate.
- **Doc-internal navigation** — `Grep` of `^# ` headings within `docs/`, or a
  `Glob` restricted to `docs/`. Satisfies.
- **Other** — `.claude/`, `tools/`, etc. Neutral; ignored by the window.

Within an in-scope investigation phase (Step 1 primary; Steps 5/6/7 secondary —
the "ESPECIALLY during debugging" directive), maintain a sliding window over the
last **N = 3** non-neutral events. If all three are source-reads with no doc-read
or doc-internal-navigation in the window → **violation**.

**Exemptions** (applied before flagging): (A) syntactic/mechanical tasks (rename,
replace-everywhere, move-file, import-path update, lint fix) — the rule does not
apply; (B) Step-1 doc-read carryover — a `docs/` read earlier in the same Step 1
satisfies subsequent reads in that step; (C) single-source-file deep-dive — after
one doc-read in the phase, drilling into the specific source file the doc pointed
to is exempt for its next ~5 reads.

**Severity.** First violation in a session → **Tier-1 warn**. Recurring (≥2
across phases) → **Tier-2 escalate** (controller messages both orchestrator and
agent: "re-read the relevant module doc before continuing"). **Never Tier-3** —
the check is intentionally lenient because an agent can legitimately consult docs
*from memory* without a `[READ]` marker (an irreducible false-positive source).

---

## Tier Rules

| Tier | Trigger examples | Controller action | Orchestrator's expected response |
|---|---|---|---|
| **Tier-1 (warn)** | Late Step 0 by 2 min; commit missing `[agent-id]` prefix; cross-agent file proximity; first occurrence of a soft-convention break; first Documentation-First skip | Single `SendMessage` to `team-lead`. No message to the dev agent. | Note in Telegram if relevant, else log internally and continue. |
| **Tier-2 (escalate)** | Late Step 0 by 5 min; agent edited an unlocked file; premature Phase 2; `/fn` agent edited a file outside the parent's lock; `/update-docs` touched a `.cu`/`.cpp` file; unmatched `[BASH-CALL]` 30+ min; recurring Documentation-First skip | `SendMessage` to `team-lead` AND to the dev agent ("pause edits and check with orchestrator"). The dev-agent message is advisory, not a hard stop. | Decide: restart, pause, kill, or approve retroactively. To approve retroactively, instruct the controller to `suppress` the invariant for the session. |
| **Tier-3 (halt)** | Two agents holding a lock on the same file; an unlocked dirty source file; concurrent `--heavy` CUDA builds; an agent reaching commit with no locks present; unmatched `[BASH-CALL]` 60+ min | `SendMessage` to `team-lead` with a "HALT" prefix; ALSO `SendMessage` to every alive dev agent: "Repo invariant violated. Stop all edits. Await orchestrator instruction." | Immediate intervention — pause every dev agent (Step 10c), resolve, then restart or reset. |

**The controller never blocks, kills, or auto-recovers.** Every tier is a report;
the orchestrator is the sole actor.

**Suppression.** Some invariants legitimately need relaxing for a session (e.g. a
doc-only `/dev` agent that never edits source). The orchestrator sends
`SendMessage(to: "controller", message: "suppress: <invariant>")`; the controller
logs it and stops alerting on that invariant for the rest of the session. Never
permanent — suppressions reset when the controller exits.

### Reporting formats

- **Compliance pulse** (informational, every 5 min while ≥1 dev agent is alive;
  drops to 15 min after 3 consecutive `Issues: none` pulses, restores on any
  non-`none` issue or new dispatch): agents alive + their step, lock map, repo
  dirty-matching-locks count, repo dirty-UNLOCKED count, issues.
- **Violation alert** (immediate, on any tier): agent, invariant, evidence
  (a `git status` excerpt or log line), recommended action. Tier-2/3 also
  message the named dev agent.
- **Final session summary** (on `session ending`): agents observed, total alerts
  by tier, invariants violated with timestamps, recommendations — written to the
  controller's own log and sent to `team-lead` before it archives + exits.

---

## Failure-Mode Catalogue

The catalogue of known stall patterns the 30-minute sweep classifies and the
mitigation the orchestrator applies. Drawn from `.claude/CLAUDE.md`
"Known gaps in `bypassPermissions`" and incident history. Each new failure mode
discovered should be appended here and to the controller's pattern list.

### 12a. Long-running Bash starters

**Pattern.** Commands that spawn detached/long-running children
(`cmd //c start-pianoid.bat`, `cmd //c start *.exe`, foreground `npm run dev`)
trip the harness's "long-running process" detector regardless of
`bypassPermissions` — the agent emits the call and waits forever for the gate.
The dominant stall. (Incidents: `dev-modal-b3` 2026-05-01 backend startup;
`dev-833f` 2026-04-30 chrome-devtools session loss.)

**Controller flag.** An unmatched `[BASH-CALL]` whose command matches the
starter-pattern list, past the sweep threshold → Tier-2 (then Tier-3); also a
**pre-emptive Tier-2** the moment a `[BASH-CALL]` is emitted whose summary matches
a pattern, before it goes silent. Pattern list: `^cmd //c\s+(start|.*start-pianoid)`,
`^npm run dev`, `Start-Process(?!.*-WindowStyle Hidden)`, `python …backendserver.py`
without `run_in_background: true`.

**Mitigation.** Orchestrator instructs the agent (or respawns) to use the
CLAUDE.md workaround — `PowerShell Start-Process -WindowStyle Hidden …` with
redirected output, or the launcher REST API (`POST /api/start-backend` on
port 3001).

### 12b. TTY-opening Bash

**Pattern.** Commands expecting interactive keyboard input (`git rebase -i`,
`git add -i`, bare `python` REPL, `gcloud auth login`, `aws configure`,
`npm init` without `-y`) gate regardless of permission mode and should never run
in agent context.

**Controller flag.** Pre-emptive — `[BASH-CALL]` text matches the forbidden list
(`git rebase -i`, `git add -i`, `^python\s*$`, `gcloud auth login`,
`aws configure`).

**Mitigation.** Orchestrator instructs a non-interactive equivalent (e.g.
`git rebase HEAD~3`), or routes a genuinely interactive op via the
`! <command>` prefix (the user runs it in their CLI; output lands in the
conversation).

### 12c. taskkill on system / high PIDs

**Pattern.** `taskkill //F //PID <high-PID>` or `taskkill //F //IM <name>` on
certain processes trips a UAC/harness gate — the exact trigger is inconsistent
(system-range PIDs, service-owned processes).

**Controller flag.** An unmatched `[BASH-CALL] taskkill //F //PID <4+-digit pid>`
past the threshold (pre-emptive is unreliable here because the gate is
inconsistent — primary detection is via the unmatched-call sweep).

**Mitigation.** Orchestrator scopes the kill by image name (`taskkill //F //IM
<name>`) or uses `//T` (kill tree); last resort it runs the kill in its own
context (its Bash renders as deltas it can see).

### 12d. MCP re-auth flows

**Pattern.** An MCP server gates when its session expires and it needs a browser
OAuth round-trip (`*_authenticate` on Google Calendar/Gmail, Telegram `grammy`
re-init on token change, chrome-devtools stdio-pipe loss requiring a VS Code
reload).

**Controller flag.** An unmatched `[MCP-CALL]` whose `tool=` matches
`*auth*|*authenticate*|*init*|*pair*` past a short threshold; pre-emptive Tier-1
informational the moment such a call is emitted ("agent is opening an auth flow —
be ready to relay user-side action").

**Mitigation.** Orchestrator tells the user via Telegram to complete the OAuth
URL in their CLI and reply "continue", then `SendMessage`s the agent to retry.
For stdio drift (not an auth flow), the remediation is a VS Code reload, not user
OAuth — the orchestrator distinguishes by the server name + the absence of an
auth flow.

### 12e. Other harness-gated operations

- **`Bash run_in_background: true` first-call-of-session** can trip the
  long-running-process gate even under `bypassPermissions` (the decision is
  harness-internal). Escalate to the orchestrator on first failure — do NOT
  retry.
- **MCP stdio drift in long sessions** — servers spawned via `npx -y X@latest`
  (chrome-devtools, context7, google-drive) can lose stdio mid-session; their
  tool calls hang as a stale `[MCP-CALL]`. Same controller flag as the auth case,
  different remediation (VS Code reload).

---

## See Also

- `.claude/commands/orchestrator.md` — "Controller Agent" section (spawn
  template, per-dispatch notification, fallback). Points here.
- `.claude/commands/dev.md` — the dev-agent marker discipline (Markers section)
  that produces the signals this doc consumes.
- `docs/development/MODULE_LOCKS.md`, `docs/development/WORK_IN_PROGRESS.md` — two
  of the four authoritative state files the controller watches.
- `.claude/CLAUDE.md` — "Orchestrator Sub-Agent Permission Rule" and "Known gaps
  in `bypassPermissions`" (the source of the failure-mode catalogue).
