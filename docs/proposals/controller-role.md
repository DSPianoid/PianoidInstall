# Controller Agent Role Proposal

**Status:** Draft for review (2026-05-05, in response to Telegram msg 1682)
**Driver request:** "Review orchestrator + dev working pipeline. There is the controller role which is not defined clearly and never actually used. Controller should be involved in all significant development processes, especially when more then one dev agent involved. Propose and clarify the role"
**Scope:** Skill definitions in `.claude/commands/` — `orchestrator.md`, `dev.md`, `multitask.md`, `fn.md`. No source-code or runtime impact.

---

## TL;DR — Recommendation

Promote the controller from a stub mention to a first-class **read-only compliance monitor**, spawned exactly once per orchestrator session that touches `/dev` or `/multitask`, and kept alive until the last dev agent in that session reaches CLOSED. The controller never edits source, never spawns or kills agents, never messages the user — it watches `MODULE_LOCKS.md`, `WORK_IN_PROGRESS.md`, `docs/development/logs/`, and `git status` and sends graduated alerts (warn → escalate → halt) to the orchestrator. The orchestrator retains all authority for user communication and dispatch.

The only existing references in `orchestrator.md` (`:455` and `:782`) are forward-pointers to a "Controller Agent" section that does not exist. This proposal fills that gap.

---

## 1. Current State — Where "Controller" Already Appears

Two references in `orchestrator.md`, neither implemented:

| File:Line | Quote |
|---|---|
| `.claude/commands/orchestrator.md:455` | `5. **Controller agent.** The team should include a permanent controller agent whose job is to monitor /dev workflow compliance. See "Controller Agent" section below.` |
| `.claude/commands/orchestrator.md:782` | `\| Not verifying agent created session log + acquired locks \| The controller agent handles this. If no controller, check within ~2 min that docs/development/logs/dev-*.md exists and MODULE_LOCKS.md has the agent's entry. Kill and respawn if not. SEVERE VIOLATION. \|` |

There is no "Controller Agent" section in `orchestrator.md`, no controller block in `dev.md`, no controller mention in `multitask.md` or `fn.md`. The 2026-04-21 stalled sessions `dev-7a2b-...-STALLED-AFTER-STEP0.md` and `dev-e6b9-...-STALLED-ON-PHASE-E.md` are exactly the failure mode line :782 says the controller would catch — but the controller does not exist, and the orchestrator-side fallback ("check within ~2 min") is itself unimplemented because the orchestrator has no `Monitor` loop after dispatch.

This is a documentation hole AND an operational hole.

---

## 2. Evidence From Dev Session Logs

Sampled 7 sessions covering solo, paused-by-conflict, multi-agent-overlap, and stalled-pre-edit. In each, a controller would have caught a real issue early.

| Log (in `logs/archive/`) | What happened | What a controller would have caught |
|---|---|---|
| `dev-7a2b-2026-04-21-123010-STALLED-AFTER-STEP0.md` | Agent registered Step 0, then never logged Step 1. No locks acquired, no edits, but WIP entry persisted. | **Tier-1 warn at +2 min:** "dev-7a2b registered in WIP, no Step-1 entry in log, no locks acquired. Heartbeat stale." Orchestrator could have respawned or marked orphaned before user noticed. |
| `dev-e6b9-2026-04-21-143819-STALLED-ON-PHASE-E.md` | Same pattern — Step 0 done, then silence. Filename baked the diagnosis in. | Same as above. |
| `dev-833f-2026-04-30-193055.md` | Phase A produced two consecutive wrong fixes (axis semantics + value scale) before measurement-based diagnosis succeeded on a recovery instance with `bypassPermissions`. | **Tier-2 escalate** when the agent edited code paths whose Data Model Card had inferred-only rows. The CLAUDE.md "High-stakes inference categories" rule postdates this incident; controller could enforce it going forward by gating Step 4 on a non-empty Data Model Card. |
| `dev-0d64-2026-04-18-184348.md` (W4-B refactor) | Coexisted with dev-c59a doing W4-A on the same file (`modal_adapter.py`) — disjoint regions but same file. dev-0d64 noted dev-c59a's "unstaged routes.py error-classification changes" leaked into post-change tests. | **Tier-1 warn:** "dev-c59a has unstaged changes in `routes.py` that fall outside its declared lock list — file in repo is dirty without lock match." Would have surfaced the leak before dev-0d64's Step 5 picked it up. |
| `dev-md01-2026-05-03-234854.md` (MIDI dedup) | Parallel safety-net agent dev-9a47 dispatched simultaneously. dev-md01 needed `backendServer.py`; dev-9a47 had it. dev-md01 waited until dev-9a47 wrapped before locking. | **Tier-1 informational pulse** when both agents are on the same file (one held lock, the other queued). Would let the orchestrator schedule the queued one's first edit immediately after lock release without manual polling. |
| `dev-3st1-2026-05-04-184115.md` (nuclei-merge tracking) | Wanted to wire a 1-line dispatcher edit in `esprit_runner.py`, which dev-ir01 held the lock on for an unrelated band-config change. dev-3st1 chose to defer rather than block. | **Tier-1 warn:** "Cross-agent file proximity — dev-3st1's plan touches `esprit_runner.py` held by dev-ir01. Different sections, but same file." Orchestrator could surface this to the user as a coordination decision instead of dev-3st1 deciding alone. |
| `dev-tm-8d62-2026-04-28-171541.md` (test-mode contract) | Phase-A investigation, no locks, no edits — by design. Agent ran 4+ hours, surfacing decisions to orchestrator only at phase boundaries. | **Tier-1 informational:** "dev-tm-8d62 in WIP, no locks acquired, log advancing — confirmed investigation mode." This is the *quiet* case the controller should NOT flag as stale. The pulse logic must distinguish "investigating without locks" (OK, log advancing) from "stalled at Step 0" (alert, log frozen). |

---

## 3. Anti-Pattern Coverage (from `orchestrator.md` table at `:765–:795`)

Of the 22 rows in that table, **9 are directly controller-monitorable**:

| Row | Controller check |
|---|---|
| Reading source files to "quickly check" something | Periodic `git log` on the orchestrator's session-since-start; if the orchestrator's process touches `Read` on PianoidCore / PianoidBasic / PianoidTunner source files, controller reports. (Detection is heuristic — see Section 9 limitations.) |
| Editing code directly because "it's just one line" | Controller diff on `git status` between dispatches: if any source file becomes dirty without a corresponding agent's lock, **Tier-3 halt**. |
| Making a "quick fix" directly after noticing a problem | Same Tier-3 — unlocked dirty file is the unconditional invariant break. |
| Reporting task complete before user confirms | Controller reads dev-agent log; if `Status: Complete` and Phase 2 actions ran (log archived, WIP cleaned) without an orchestrator-recorded approval message, **Tier-2 escalate**. |
| Not verifying agent created session log + acquired locks | The `:782` row already attributes this to the controller. **Tier-1 warn at +2 min, Tier-2 escalate at +5 min.** |
| Skipping post-completion verification | Controller checks the four post-completion invariants from `orchestrator.md` "What to Verify After Agent Reports": commit prefix, locks released, log not archived yet, WIP entry present. |
| Skipping post-kill cleanup | If TaskStop fires on a dev agent and the agent's locks/WIP/log are still present 30s later, **Tier-2 escalate**. |
| Generating new agent ID for recovered/restarted agent | Controller knows all agent IDs in the session; if a new ID appears with task description matching a paused agent's, **Tier-1 warn**. |
| Ignoring stale locks/WIP on startup | Already in orchestrator Step 1.5; controller re-runs the same scan periodically (every 5 min) and pulses results, so a session-long drift is caught even though Step 1.5 only runs at start. |

The remaining 13 rows are about orchestrator dispatch decisions (skill choice, team-vs-non-team, ID persistence, kill scope) — not the controller's domain.

---

## 4. Role Definition

The **controller** is a permanent, read-only sub-agent of the orchestrator. It exists for one purpose: enforce the workflow invariants documented in `dev.md`, `multitask.md`, and `fn.md` while dev agents run in parallel. It watches the four authoritative state files (`MODULE_LOCKS.md`, `WORK_IN_PROGRESS.md`, `docs/development/logs/*`, repo `git status`) and reports compliance pulses + violation alerts to the orchestrator. It has no authority to edit, dispatch, kill, or message the user. All actions on its findings are taken by the orchestrator.

One controller per orchestrator session, regardless of how many dev agents the session spawns. Lifecycle is bounded by the first `/dev` or `/multitask` dispatch and the closing of the last dev agent in that session.

---

## 5. Responsibilities — Concrete Checks

### 5a. Per-agent lifecycle invariants

For each dev agent the orchestrator dispatches, the controller verifies:

- **Step 0 within 120 seconds.** Within 2 minutes of spawn, a log file matching `docs/development/logs/<agent-id>-*.md` must exist with at least the header block and "Step 0: Initialize Session" entry. *Tier-1 warn at +120s, Tier-2 escalate at +300s.*
- **WIP registration within 120 seconds.** `docs/development/WORK_IN_PROGRESS.md` `## Active Dev Sessions` table must contain a row for the agent ID. *Same tiers as above.*
- **Lock acquisition before Step 4 edits.** Before any source file modified by the agent appears in `git status`, `MODULE_LOCKS.md` must contain a row for the agent ID listing that file. Detection: snapshot `git status --short` on each repo; cross-reference dirty files against the locks table. *Tier-3 halt if an unlocked dirty file is found.*
- **Commit prefix discipline.** All commits made during the session must start with `[<agent-id>]`. *Tier-1 warn on any commit by an active agent that violates this.*
- **No premature Phase 2.** If the agent's log shows Step 10a Phase 2 actions (log archived to `logs/archive/`, WIP row removed) and the orchestrator has not relayed user approval since the corresponding Phase 1 stop, *Tier-2 escalate.*
- **Cleanup on exit.** When the agent transitions to CLOSED, KILLED, or RESET: locks released, WIP row removed (or paused-marked), log appropriately archived/preserved. *Tier-2 escalate on residue.*

### 5b. Cross-agent invariants (active when ≥2 dev agents are alive)

- **No overlapping locks.** No two agents may have the same file in their `MODULE_LOCKS.md` rows. *Tier-3 halt — repo invariant.*
- **No file-proximity surprise.** When two agents lock different files in the same module (same directory, same `.cu` file family, same Python class graph), informational pulse to orchestrator so it can flag the coordination need. *Tier-1 informational, not a violation.*
- **No untracked dirty files.** A dirty file in `git status` whose path is in *no* active agent's lock list is a repo-invariant break. *Tier-3 halt.*
- **Sequential nvcc.** If two active agents both classified as needing `--heavy` CUDA build, the multitask conflict rules should have prevented parallelism — if it slipped through, *Tier-3 halt* before either runs `build_pianoid_cuda.bat`.

### 5c. Workflow-specific invariants

- **`/multitask` wave honesty.** When `/multitask` is the dispatcher, controller verifies wave-N agents are CLOSED before wave-N+1 spawns. *Tier-2 escalate.*
- **`/fn` parent-lock inheritance.** When a `/fn` sub-agent edits a file, the file must be in the *parent dev agent's* lock list (not the fn agent's own — fn does not acquire locks per `fn.md`). *Tier-2 escalate.*
- **Auto-trigger compliance.** If a non-`/dev` skill (e.g., `/update-docs`) edits `.cu`, `.cpp`, `.cuh`, `.h`, or `setup.py`, *Tier-2 escalate* — that is the explicit violation called out in `.claude/CLAUDE.md` "Auto-Trigger Rules".

---

## 6. Triggers — When the Controller Is Spawned

User's stated requirement: "Controller should be involved in all significant development processes, especially when more than one dev agent involved." Mapped concretely:

| Trigger | Action |
|---|---|
| Orchestrator spawns its first `/dev` agent in a session | **Spawn controller alongside the dev agent** (single message, parallel Agent calls). The controller boots first because of alphabetical ordering in the message; it begins watching before the dev agent's Step 0 timer starts. |
| Orchestrator dispatches `/multitask` | **Spawn controller before the wave-1 dev agents.** Mandatory regardless of how many tasks are in the multitask invocation — even single-task multitask gets a controller, because the user's wording explicitly named multi-agent as the priority case but did not exclude single-agent. |
| Orchestrator dispatches `/dev` while a controller already exists in the session | **Reuse the existing controller.** Send a `SendMessage` to it noting the new agent ID; do not spawn a second controller. |
| Last alive dev agent in the session transitions to CLOSED | **Controller produces final session summary**, then exits. The next `/dev` dispatch will spawn a fresh controller. |
| Orchestrator session ends (`/orchestrator stop`) | Controller exits without summary if no dev agents ran; with summary otherwise. |

**Singleton rule:** at most one controller per orchestrator session. The orchestrator tracks its lifecycle in the same way it tracks dev-agent lifecycle.

**Skipped for:** pure `/sync`, `/analyse`, `/review`, `/update-docs`, `/test-ui`, `/pianoid-ui` invocations that do *not* touch source code. Those are dispatched without a controller because the invariants (locks, WIP, agent IDs, prefixed commits) do not apply. If `/test-ui` ends up needing to `/dev` something to fix a test, the orchestrator spawns a controller at that escalation point.

---

## 7. Tools and Permissions

Controller is read-only on project source. Required tools:

| Tool | Purpose |
|---|---|
| `Read` | `MODULE_LOCKS.md`, `WORK_IN_PROGRESS.md`, dev-agent session logs, `.claude/commands/*` |
| `Grep` | Search log files for step markers, status transitions |
| `Glob` | Enumerate `docs/development/logs/*.md` |
| `Bash` (read-only) | `git status`, `git log`, `git diff --name-only`, `tasklist`, `netstat` |
| `SendMessage` | Reach orchestrator (`team-lead`) and named dev agents |
| `Monitor` | Watch agent log files for new entries; this is the heartbeat mechanism. Each new line in a dev-agent's log is a notification — the controller does not poll. |

Explicitly forbidden: `Edit`, `Write`, `NotebookEdit` on any project file. `Bash` invocations that mutate state (e.g., `git commit`, `taskkill`, anything that writes outside `/tmp` or the controller's own log).

The controller's own session log lives at `docs/development/logs/controller-<orchestrator-session-id>-<timestamp>.md` and IS write-allowed (controller owns its own log). When the controller exits, its log is archived to `docs/development/logs/archive/` like a dev log.

---

## 8. Reporting Protocol

### 8a. Compliance pulse (informational)

Every 5 minutes while at least one dev agent is alive, controller sends:

```
SendMessage(to: "team-lead", summary: "Pulse N", message: "Pulse N at HH:MM
  Agents alive: dev-XXXX (Step 4), dev-YYYY (Step 1)
  Locks: dev-XXXX: pianoid.py, backendServer.py | dev-YYYY: mode_tracking.py
  Repo dirty (matching locks): 2 files in PianoidCore
  Repo dirty (UNLOCKED): 0 files
  Issues: none")
```

If "Issues" is `none` for 3 consecutive pulses, frequency drops to every 15 minutes — pulses are rate-limited so they do not flood the orchestrator's Telegram view. Frequency restores to 5 minutes on any non-`none` issue or new dispatch.

### 8b. Violation alert (immediate)

On any Tier-1/2/3 finding:

```
SendMessage(to: "team-lead", summary: "Tier-N alert: <short>", message: "Tier-N <category>
  Agent: dev-XXXX
  Invariant: <which one>
  Evidence: <git status excerpt or log line>
  Recommended action: <what orchestrator should do>")
```

For Tier-2/3 on a specific agent, ALSO:

```
SendMessage(to: "dev-XXXX", summary: "Compliance flag", message: "Controller flagged: <invariant>.
  Pause edits and check with orchestrator before continuing.")
```

The orchestrator has discretion to override (e.g., approve a retroactive lock add). Controller does not block the agent — the message to the dev agent is advisory; the orchestrator decides enforcement.

### 8c. Final session summary

When the last alive dev agent transitions to CLOSED, controller writes a summary to its own log AND sends to orchestrator:

```
SendMessage(to: "team-lead", summary: "Controller closing", message: "Session summary:
  Agents: dev-XXXX, dev-YYYY, dev-ZZZZ
  Total alerts: 3 (Tier-1: 2, Tier-2: 1, Tier-3: 0)
  Invariants violated: <list with timestamps>
  Recommendations for future sessions: <if any pattern emerged>")
```

Then the controller exits.

---

## 9. Violation Handling — Graduated Response

| Tier | Trigger examples | Controller action | Orchestrator's expected response |
|---|---|---|---|
| **Tier-1 (warn)** | Late Step 0 by 2 min; commit missing `[agent-id]` prefix; cross-agent file proximity; `Status: In Progress` flagged stale (no log lines for 10+ min); first occurrence of a soft-convention break | Single `SendMessage` to orchestrator. No message to dev agent. | Note in Telegram if relevant; otherwise log internally and continue. Pulse history accumulates context. |
| **Tier-2 (escalate)** | Late Step 0 by 5 min; agent edited unlocked file (now caught); premature Phase 2 actions; `/fn` agent edited file outside parent's lock; `/update-docs` touched a `.cu`/`.cpp` file | `SendMessage` to orchestrator AND to the dev agent ("pause edits and check with orchestrator"). Dev-agent message is advisory, not a hard stop. | Decide: restart, pause, kill, or approve retroactively. If approving retroactively, instruct controller to mark this invariant suppressed for this session via a follow-up `SendMessage`. |
| **Tier-3 (halt)** | Two agents holding lock on same file; unlocked dirty source file; concurrent `--heavy` CUDA builds detected; agent reaches Step 10b (commit) without locks present | `SendMessage` to orchestrator with "HALT" prefix; ALSO `SendMessage` to all alive dev agents: "Repo invariant violated. Stop all edits. Await orchestrator instruction." | Immediate orchestrator intervention. Pause every dev agent (Step 10c), resolve, then either restart or reset. |

**Suppression mechanism.** Some invariants legitimately need to be relaxed for a specific session (e.g., a doc-only `/dev` agent that never edits source). The orchestrator can `SendMessage(to: "controller", message: "suppress: <invariant>")` for the remainder of the session. Controller logs the suppression and stops alerting on it for that session only — never permanent. Suppressions reset when the controller exits.

---

## 10. Coordination With Orchestrator

Boundary contract:

| Concern | Owner |
|---|---|
| Communication with the user | Orchestrator only |
| Spawning, killing, pausing dev agents | Orchestrator only |
| Approving user requests | Orchestrator only |
| Reading lock/WIP/log files | Either |
| Detecting invariant violations | Controller (primary), orchestrator (fallback if no controller) |
| Acting on violations (e.g., relaying to user, instructing dev agent to stop) | Orchestrator |
| Repo `git status` health checks | Either; controller does periodically, orchestrator does at Step 1.5 |
| Final compliance summary | Controller |
| Final session summary to the user | Orchestrator (may quote the controller's summary) |

**Fallback when no controller exists.** The controller is mandatory for `/dev` and `/multitask`, but the orchestrator must remain capable of running its existing workflow if controller spawn fails (e.g., agent-team capacity exhausted, harness gate). The orchestrator's existing checks at `:782` ("check within ~2 min") are the fallback. Controller failure is itself a Tier-2 issue but does NOT block dev work.

---

## 11. Lifecycle

```
Orchestrator spawns first /dev or /multitask
    |
    v
Orchestrator spawns controller IN THE SAME MESSAGE as the first dev agent
    |
    v
Controller initializes:
  - Creates own session log at docs/development/logs/controller-<orch-id>-<timestamp>.md
  - Reads MODULE_LOCKS.md, WORK_IN_PROGRESS.md, scans logs/ for active sessions
  - Sends initial pulse to team-lead
  - Sets up Monitor subscriptions to all known dev-agent log files
    |
    v
Controller active loop (event-driven, NOT polling):
  - Wakes on:
      * SendMessage from orchestrator (new agent dispatched, suppression, query)
      * Monitor notification (dev-agent log line added)
      * 5-min pulse timer
  - On wake:
      * Re-scan locks + WIP if relevant
      * Cross-reference against current invariants
      * Send pulses / alerts as needed
  - Between wakes: idle, no CPU usage
    |
    v
Last alive dev agent transitions to CLOSED:
  - Orchestrator notifies controller via SendMessage("session ending")
  - Controller produces final summary, sends to orchestrator
  - Controller archives own log to logs/archive/
  - Controller exits
    |
    v
Next /dev or /multitask dispatch spawns a fresh controller
```

**Reuse vs respawn.** Within one orchestrator session, the controller is reused across multiple `/dev` dispatches. Across orchestrator sessions (VS Code reload, `/orchestrator stop`/`start` cycle), each session gets its own controller.

---

## 12. Concrete Spawn Pattern

The orchestrator's existing dev-agent dispatch becomes a 2-element parallel `Agent` block. Example for the first `/dev` of a session:

```javascript
// Single message, two Agent calls — controller boots concurrently with dev agent
Agent({
  team_name: "pianoid-dev",
  name: "controller",
  subagent_type: "general-purpose",
  run_in_background: true,
  mode: "bypassPermissions",
  description: "Compliance controller for this orchestrator session",
  prompt: `Run as the dev pipeline controller for this orchestrator session.

  Your job is to monitor /dev and /multitask workflow compliance. You are
  read-only on project source — never use Edit or Write on PianoidCore,
  PianoidBasic, PianoidTunner, or any docs/ file. You may write only to
  your own session log at docs/development/logs/controller-<id>-<timestamp>.md.

  Initial actions:
    1. Generate controller ID: ctrl-$(openssl rand -hex 2)
    2. Create your session log
    3. Read docs/development/MODULE_LOCKS.md, WORK_IN_PROGRESS.md
    4. Glob docs/development/logs/dev-*.md (non-archive) to enumerate active sessions
    5. Subscribe via Monitor to each active dev-agent log file
    6. Send initial pulse to team-lead

  Invariants to enforce — see proposal at docs/proposals/controller-role.md
  sections 5, 9. Tier-1 warn, Tier-2 escalate, Tier-3 halt with the SendMessage
  patterns from section 8.

  Active dev agents at controller spawn: dev-<id> (just spawned alongside you).
  Add this to your watch list immediately.

  STAY ALIVE until orchestrator sends "session ending". Do not exit on your
  own.`
}),
Agent({
  team_name: "pianoid-dev",
  name: "dev-<id>",
  subagent_type: "general-purpose",
  run_in_background: true,
  mode: "bypassPermissions",
  description: "<task description>",
  prompt: `Execute the /dev skill. <full prompt as today>`
})
```

For subsequent `/dev` dispatches in the same orchestrator session:

```javascript
// Notify existing controller, then spawn just the dev agent
SendMessage({
  to: "controller",
  summary: "New dev agent",
  message: "Adding dev-<new-id> to watch list. Task: <one line>."
})
Agent({
  team_name: "pianoid-dev",
  name: "dev-<new-id>",
  // ... rest as today
})
```

---

## 13. Worked Example — 2-Dev-Agent Session With Controller

Scenario: User dispatches "Fix MIDI dedup AND add backend parameter safety net" — orchestrator decides to run both in parallel because the conflict matrix says they're file-disjoint.

```
T+0:00  User: "Fix MIDI dedup. Also add backend param safety net."
        Orchestrator classifies as 2-task /multitask, conflict matrix clean
T+0:01  Orchestrator spawns 3 agents in one message:
          - controller   (read-only)
          - dev-md01     (MIDI dedup, /dev skill)
          - dev-9a47     (param safety net, /dev skill)
        All with bypassPermissions, run_in_background: true

T+0:02  Controller boots, reads MODULE_LOCKS.md (empty), WORK_IN_PROGRESS.md
        (empty), glob logs/ finds nothing recent
        Controller sends pulse #1 to team-lead:
        "Pulse 1: 2 agents alive (dev-md01, dev-9a47), locks: empty,
         dirty files: 0 unlocked, 0 locked. Issues: none."

T+0:30  dev-md01 has not written its Step 0 log yet (slow Telegram inbox)
        dev-9a47 wrote its Step 0 log at T+0:15
        Controller's Monitor subscription to dev-md01's log file: still no file

T+2:00  Controller fires Tier-1 warn:
          SendMessage(to: "team-lead",
            summary: "Tier-1: dev-md01 late Step 0",
            message: "dev-md01 spawned 120s ago, no log file yet under
                      docs/development/logs/. dev-9a47 logged Step 0 normally.")
        Orchestrator sees this, decides to wait one more minute before respawning

T+2:30  dev-md01 finally writes its Step 0 — Telegram inbox lag was the cause
        Controller's Monitor delivers the new log line, controller updates state

T+0:05  dev-md01 enters Step 4: locks backendServer.py
        Controller observes MODULE_LOCKS.md update: dev-md01 row added with
        backendServer.py listed
        No conflict with dev-9a47 (which locked a different file: pianoid.py)
        Controller sends Tier-1 informational pulse:
        "Pulse 2: dev-md01 acquired lock on backendServer.py"

T+0:08  dev-9a47 starts a Step 4b /fn sub-agent for the safety-net helper
        /fn agent edits a NEW file safety_net.py — not in dev-9a47's lock list
        Controller detects: git status shows safety_net.py dirty, no lock match
        Tier-3 halt:
          SendMessage(to: "team-lead",
            summary: "Tier-3 HALT: unlocked dirty file",
            message: "safety_net.py is dirty in PianoidCore but no agent locks
                      it. Either dev-9a47 needs to add it to its lock row
                      (NEW-file lock) or this is invariant break.")
          SendMessage(to: "dev-9a47",
            summary: "Compliance flag",
            message: "Repo invariant: unlocked dirty file safety_net.py. Pause
                      edits.")
        Orchestrator decides this is a NEW-file case — instructs dev-9a47 to
        retroactively add safety_net.py to its lock row. dev-9a47 does so.
        Controller observes the update, retracts the alert:
          SendMessage(to: "team-lead", summary: "Tier-3 cleared",
            message: "dev-9a47 added safety_net.py to lock row. Invariant
                      restored.")

T+0:35  dev-md01 reaches Step 10a Phase 1: commits with prefix [dev-md01]
        Controller verifies: commit prefix matches, locks released, log not
        archived (Phase 2 not yet), WIP entry still present (Phase 2 not yet)
        Controller sends Tier-1 pulse: "dev-md01 Phase 1 done, awaiting
        approval"
        Orchestrator relays results to user, waits for "approve"

T+0:40  User: "approve"
        Orchestrator: SendMessage(to: "dev-md01", "User approved. Proceed with
        Step 10a Phase 2.")
        dev-md01 archives log, removes WIP row.
        Controller observes: log moved to logs/archive/, WIP row gone.
        State: dev-md01 = CLOSED.

T+0:45  dev-9a47 finishes similarly. State: dev-9a47 = CLOSED.

T+0:46  No alive dev agents. Orchestrator sends:
          SendMessage(to: "controller", "session ending — all agents CLOSED")
        Controller produces final summary:
          "Session summary:
            Agents: dev-md01, dev-9a47
            Alerts: 1 Tier-3 (resolved retroactively), 1 Tier-1 (late Step 0)
            Suppressions: none
            Recommendation: Step 0 SLA may need to be 180s when Telegram
                            inbox lag is observed."
        Sends summary to team-lead, archives own log, exits.
```

The key value: in this example the controller surfaced the unlocked `safety_net.py` immediately. Without a controller, it would have been caught only at dev-9a47's own Step 10a "Audit locks vs. dirty files" — by which point dev-9a47 had committed the file under a retroactive lock with only a session-log warning. The controller surfaced the issue the instant the dirty file appeared, in front of the orchestrator AND the dev agent, while the change was small enough to either re-lock cleanly or revert cheaply.

---

## 14. Edits Required to Existing Skills

Read-only proposal. Patches not written. Below is the change list with one-line summaries — to be implemented by the user (orchestrator-level Edit) per the sub-agent permission constraint documented in the user's auto-memory `feedback_subagent_perms.md`.

| File | Section / Line | One-line change |
|---|---|---|
| `.claude/commands/orchestrator.md` | After `:455` (the existing "Controller agent" reference in the CRITICAL RULES list) | Insert a full "## Controller Agent" section spanning ~80 lines: definition, lifecycle, spawn pattern, invariant list, tier rules, suppression mechanism. Pull from sections 4, 5, 9, 11, 12 of this proposal. |
| `.claude/commands/orchestrator.md` | Step 1.5 ("Repo Health Check and Session Recovery") | Add a sub-bullet: "If session will dispatch /dev or /multitask, controller is spawned alongside the first such agent (see Controller Agent section)." |
| `.claude/commands/orchestrator.md` | Step 3 "Spawning Sub-Agents" | Add rule 6: "Controller spawn rule — when dispatching the first /dev or /multitask of a session, include the controller in the same message (parallel Agent calls). For subsequent dispatches in the same session, SendMessage the existing controller; do not spawn a second one." |
| `.claude/commands/orchestrator.md` | Anti-Patterns table at `:765` | Update the existing `:782` row from "If no controller, check within ~2 min..." to "Controller (mandatory for /dev and /multitask) handles this. If controller spawn fails, fallback to orchestrator polling check at +2min, +5min." |
| `.claude/commands/orchestrator.md` | New row in Anti-Patterns table | "Spawning /dev without spawning controller alongside" → "Always include controller in first /dev/multitask dispatch of session. SEVERE — controller is the primary lock-invariant guard." |
| `.claude/commands/dev.md` | Step 0 (Initialize Session) | Add note at end: "If a controller is active in this orchestrator session, your log file MUST be created within 120s of spawn, your WIP entry MUST be added within 120s, and your locks MUST be acquired before the first source-file edit. The controller will Tier-1 warn at +120s, Tier-2 escalate at +300s. These are not new requirements — they are the existing requirements with explicit timing." |
| `.claude/commands/dev.md` | Step 4 (Acquire Module Locks and Edit Code), under "Lock-before-edit invariant" | Add: "When a controller is active, an unlocked dirty file is detected within seconds — not at Step 10a's audit. Treat lock-before-edit as a hard precondition, not a wrap-up reconciliation." |
| `.claude/commands/multitask.md` | Phase 3.3a (Spawn Sub-Agents in Parallel) | Add: "Before any wave-1 dev agent is spawned, the multitask agent (or its parent orchestrator) spawns the controller. The controller watches all wave agents simultaneously." |
| `.claude/commands/fn.md` | Step 0 / Step 2 (Lock check) | Add: "When parent /dev is in a controller-monitored session, the controller will Tier-2 escalate if you edit a file outside the parent's lock list. Always verify held_locks contains target_file before editing." |

Total estimated effort: ~150 lines of new/changed text in `orchestrator.md`, ~10 lines each in the other three skills. Achievable in 1-2 hours of orchestrator-level editing.

---

## 15. Implementation Order

If this proposal is approved:

1. **Land the orchestrator.md "Controller Agent" section.** Largest change; everything else references it.
2. **Add the spawn pattern to Step 3.** Once the orchestrator can spawn a controller, the system is operational at minimum-viable level (no dev-skill changes needed yet).
3. **Add the dev.md / multitask.md / fn.md notes.** These are hints for the dev agents about controller existence; the controller works without them but the dev agents will be confused by Tier-2 messages otherwise.
4. **Update Anti-Patterns table.**
5. **Live-test on a 2-agent /multitask session.** Pick a low-risk pair (one /dev, one /update-docs) to validate spawn, pulse, summary, and archive.

---

## 16. Open Questions

1. **Controller log archival scope.** Today only dev-agent logs go to `logs/archive/`. Should controller logs go alongside, or to a separate `logs/controller-archive/`? Proposal: same `logs/archive/`, prefix `controller-` already disambiguates.
2. **Controller for `/analyse` sessions that turn into `/dev`?** Today the orchestrator transitions `/analyse` → `/dev` mid-session. Proposal: controller spawns at the `/dev` transition point, not at `/analyse` start.
3. **Pulse cadence under low load.** 5 minutes is the minimum. Should idle pulses (3 consecutive `none`s) drop to 15 min as proposed, or should they suspend entirely until the next dev-agent log line? Proposal: drop to 15 min — full suspension makes the controller's "I'm alive" signal disappear, which becomes its own debugging burden.
4. **Tier-3 enforcement strength.** Today the proposal says "advisory" message to dev agents — they can ignore the SendMessage. Should Tier-3 instead trigger an orchestrator-side automatic Step 10c pause via SendMessage to the violating agent? Proposal: keep advisory; orchestrator owns enforcement decisions. Auto-pause from controller would blur the boundary in section 10.

---

## 17. Non-Goals

This proposal does NOT:

- Add a controller for `/test-ui`, `/pianoid-ui`, `/sync`, `/diagnose` sessions (no source edits, no locks, no need).
- Change the dev-agent's own discipline (Steps 0/1b/4/10 stay as defined).
- Change the orchestrator's user-facing protocol (Telegram, dual-output rule, classification table all unchanged).
- Add new tools or MCP servers — controller uses existing harness primitives.
- Persist state across orchestrator sessions — each session gets a fresh controller.
- Block agents — all enforcement is advisory; orchestrator decides actions.
