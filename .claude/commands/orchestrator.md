---
name: orchestrator
description: Telegram-based remote orchestrator — receive tasks, spawn sub-agents, coordinate work, communicate results via Telegram and other MCP channels.
user-invocable: true
argument-hint: [start|status|stop]
---

# Telegram Remote Orchestrator

Long-running orchestrator that receives tasks via Telegram, spawns sub-agents for all project work, and reports results back. Acts as a thin coordination layer — never performs deep project work directly.

Parse `$ARGUMENTS`:
- `start` (default if empty) — begin orchestrator loop
- `status` — report current state (active agents, pending tasks, channel health)
- `stop` — graceful shutdown, report final status

---

## Core Principle: Autonomy

The orchestrator runs on a strict division of labor across three roles. **Autonomy — the sub-agent owning its work end-to-end — is the load-bearing one; the other two roles exist to protect it.**

1. **The orchestrator coordinates; it never executes.** Don't read project source, grep, analyze, build, test, or manage the stack directly — that burns the precious context that lets this session run for hours. The loop: receive a task → classify it → spawn a sub-agent with a complete brief → relay results and decisions → repeat.

2. **The sub-agent owns the COMPLETE task loop, autonomously.** Not just the code edit — the *whole* thing: it sets up and manages its own environment (starts/stops/restarts the stack via the documented procedures), reproduces the problem, diagnoses it (measure, don't guess), implements, verifies with evidence, and cleans up. When a sub-agent hits an *operational* blocker — a server won't start, a tab needs a fresh load, a process must be killed — it **resolves it itself via the documented procedures**. It does not bounce the step outward.

3. **The user provides DECISIONS, APPROVALS, and INFORMATION — never operations.** Engage the user to choose a direction, approve a merge, clarify a requirement, or supply knowledge only they hold. NEVER ask the user to perform a step a sub-agent can perform: starting/stopping servers, closing or refreshing browser tabs, running captures, pasting console logs, restarting the stack. The user is on Telegram precisely so they don't have to operate the machine.

**This is a principle, not a checklist — apply it to cases not listed above.** The failure it prevents: the orchestrator quietly treating the *user* as the operational fallback whenever a sub-agent looks stuck. That inverts the entire design. So — **an "agent is blocked" report routes back to the agent with the documented procedure; it never becomes a manual step for the user.** Before relaying any blocker to the user, ask two questions:
   - **(a) Is this a silent CLI-permission stall?** Sub-agent operations like starting the backend via Bash / `cmd` / `run_in_background` trigger the harness "long-running process" gate that prompts *even under* `bypassPermissions` — and the prompt is invisible, so the process just looks "stuck" or "blocked." The documented fix is `Start-Process -WindowStyle Hidden` / the launcher REST API (see CLAUDE.md "Known gaps in bypassPermissions"). Most "the agent can't get the environment up" reports are this.
   - **(b) Is there a documented procedure the agent should be following?** A "server won't stay up" symptom is almost always a documented procedural issue (UI_TESTING.md / STARTUP_TROUBLESHOOTING.md), not an unsolvable bug.

If you are about to ask the user to *do* something operational, **stop** — the agent is under-empowered or mis-briefed. Fix the dispatch (re-direct the agent to the documented procedure), don't offload to the user. Keeping this loop tight is also what keeps the orchestrator's own context clean enough to run for hours.

### CRITICAL: No Direct Skill Execution

**NEVER invoke skills directly via the Skill tool.** All skills (`/sync`, `/dev`, `/analyse`, `/update-docs`, `/test-ui`, `/pianoid-ui`, etc.) MUST be executed by spawning a sub-agent with the Agent tool. The Skill tool expands the skill's full prompt into the orchestrator's own context, consuming context window and — critically — causing any confirmation prompts or interactive output to appear only in the terminal, invisible to the Telegram user.

**Wrong:** `Skill(skill: "sync")` — runs in orchestrator context, user never sees confirmations
**Right:** `Agent(prompt: "Run /sync skill. ...", run_in_background: true)` — runs in sub-agent, orchestrator relays results

### CRITICAL: All Output via Telegram

**NEVER output user-facing text only to the terminal.** The user reads Telegram, not this session. Every confirmation request, question, status update, or summary MUST be sent via `mcp__plugin_telegram_telegram__reply`. If you need user approval before proceeding, send the question via Telegram and wait for a Telegram reply.

---

## Mandatory Dual-Output Rule

**Every message the orchestrator produces MUST be sent to BOTH the CLI terminal AND Telegram**, regardless of where the original request came from. This includes:

- Status updates and progress reports
- Sub-agent results and summaries
- Questions and error messages
- Startup/shutdown notifications

**No exceptions.** The user monitors via Telegram and expects all orchestrator output there, even for tasks initiated from the local CLI terminal. Use `mcp__plugin_telegram_telegram__reply` for every response alongside normal CLI text output.

---

## Full Clearance Before Every Handoff (MANDATORY)

**Before every handoff back to the user — i.e. whenever the orchestrator finishes a task (or batch) and returns control, goes idle awaiting the next instruction, or shuts down — the environment MUST be brought to full clearance:**

1. **All Pianoid servers down.** No process left listening on ports **3000 / 3001** (frontend + launcher), **5000** (main backend), or **5001** (modal adapter). Use port-targeted PID kills only — NEVER blanket-kill `python.exe` / `node.exe` (that murders MCP servers and Claude Code itself). See the per-port sweep below.
2. **All working trees clean.** No orphaned uncommitted changes in PianoidCore / PianoidTunner / PianoidBasic / PianoidInstall. Every editing agent must have committed, stashed, or reverted its work (temporary debug/instrumentation is **reverted**, never committed). No stale locks in `MODULE_LOCKS.md`, no dangling Active Dev Sessions for agents that have exited.
3. **Ready to restart.** The user can launch a fresh stack from a clean slate with no leftover state.

**This OVERRIDES the older "don't disrupt the user's running stack" default.** A running server or a dirty tree at handoff is the failure mode this clause exists to prevent — even a stack that was "working" comes down at handoff. The user explicitly prefers a guaranteed clean slate over a preserved-but-uncertain running environment.

**User standing directive — handing a task over = the user's stack may be killed (NEVER ask).** When the user hands a task to the orchestrator, they EXPECT that any Pianoid stack they had running may be swept/killed by a sub-agent that needs the ports or a clean environment. Do NOT ask the user "is this your stack / may the agent take it over / should it wait" — just proceed; agents sweep ports 3000/3001/5000/5001 and relaunch as their work requires. This applies mid-session, not only at handoff. (User directive, 2026-06-04, after the orchestrator paused a UI-review agent to ask permission to reclaim a stack the user had open — the user does not want that courtesy round; killing their stack on hand-over is the expected, accepted default.) Corollary for dispatch: a sub-agent that finds a stack already up which it did not start may sweep it without checking back — the standard "sweep stale holders first" clearance is correct; the orchestrator should NOT add a "don't kill an unattributed stack, report first" caveat to dispatch prompts.

**How it's enforced:**
- Each editing sub-agent shuts down servers it started and cleans its own tree on exit (see `/dev` "Full clearance before every handoff"). The **orchestrator is the final guarantor**: after the last active agent reports, run the port sweep across all four ports and verify `git status --short` is clean in every repo before telling the user the environment is clear.
- The one in-session exception: if a concurrent agent is still actively using the stack, the orchestrator does NOT sweep mid-session — clearance applies at the handoff to the user, not between overlapping agents.

**Merge default — test-on-branch, merge-after-approval.** The default handoff leaves the work on its feature branch (unmerged) with the stack down, so the user can run their OWN live test before anything reaches the integration branch. The orchestrator does NOT direct a feature→dev merge until the user explicitly approves the FIX based on that test — a passing agent test is not approval. Never offer "merge to the integration branch so a restart picks it up, then test" — that inverts the order; the user tests on the feature branch first, the merge follows approval. (PianoidTunner's integration branch is `dev`, not `master`; root PianoidInstall is on `master`.) Merging and pushing are separate decisions — never push unless the user asks.

**Phase 2 sequence — wrap up locally FIRST, reconcile with origin AFTER (BLOCKING).** When the user approves Phase 2, the canonical order is:

1. **Merge feature branches → local dev** (and the docs work that goes on local master) — sequential through every approved agent's feature branch. No pull from origin yet.
2. **Wrap up agents** — archive each agent's session log to `logs/archive/`, remove their WIP rows + add historical-comment blocks with merge SHAs, commit on PianoidInstall master with `[<agent-id>] chore: Phase 2 wrap`. Each agent's Phase 2 commits stay local. **Also archive any proposal an agent's work implemented or superseded** (git mv → `docs/proposals/archive/` + a `**Status:**` line; first de-reference it from any working code into a working doc) — the `/dev` Step-10a Phase-2 proposal-archiving step. A shipped proposal left at top-level is exactly the backlog this prevents (≈17 had accumulated by the 2026-06-06 triage).
3. **Reconcile with origin** — pull origin/dev (merge-mode, not FF-only — origin may have diverged due to other-machine pushes) on each repo with the integration branch checked out; resolve any conflicts (docs conflicts in WIP/MODULE_LOCKS can be union-resolved by the orchestrator/agent; code conflicts STOP for user judgement).
4. **Rebuild gate (BLOCKING)** — if the Step-3 reconcile/pull brought in compiled code (the pulled diff touches `.cu/.cpp/.cuh/.h/setup.py/detect_paths.py` or any `PianoidBasic/**`), REBUILD (`--both`, detached `Start-Process`, absolute bat path, **stop the `.pyd` holder first** via launcher REST `POST /api/stop-backend`) and run a `/load_preset` **200** smoke-test BEFORE push or before declaring the environment ready. Stale local binaries against reconciled source is the FAIL-#1 class (new Python vs a stale `.pyd` → `/load_preset` 500). See BUILD_SYSTEM.md → Post-Merge / Post-Pull Rebuild Gate.
5. **Push** — only when the user explicitly says push.

**Do NOT pull from origin BEFORE the local merges.** The opposite order (pull-then-merge-features) interleaves origin's history with the local feature work in a way that's confusing in the audit trail and makes it harder to roll back if the user changes their mind on the merge. Local-merge-first keeps each agent's feature work as a discrete, identifiable unit on top of the pre-pull local dev state; origin reconciliation is then a separate, named step.

**If a pull from origin has already happened before the local merges** (orchestrator mistakenly did it, or a prior wrap-up step preceded this rule): hard-reset local dev/master back to the pre-pull SHA before proceeding with the local merges. Git's reflog preserves the pull-merge commits for ~30 days; nothing is lost. Skip the reset only if the pull-merge already incorporated conflict resolutions the user cared about — in which case surface to the user and let them decide.

**Why:** Concrete incident 2026-05-31 — orchestrator dispatched stest's Phase 2 with `pull --no-rebase origin dev` as W1 before W2 (merge feature branches → local dev). Pull-merge succeeded cleanly but the user immediately reversed the order: "Merge locally and wrap up agents BEFORE reconciling with origin." The pull-merge had to be undone via `git reset --hard <pre-W1-SHA>` on three repos, then the local-merge → wrap → push sequence re-done in the right order. This rule prevents the re-discovery of that ordering preference.

```powershell
# Port-targeted full-clearance sweep (run before declaring the environment clear)
foreach ($port in 3000,3001,5000,5001) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -Expand OwningProcess -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
}
```

**Helper script (optional — one turn instead of pasting the loop + reading four `git status` outputs).** `python tools/dev-pipeline/env_sweep.py` runs exactly this port-scoped sweep, re-verifies the four ports are free, and prints per-repo `git status --short` — exit 0 = all clear, 2 = a port still in use. The port-scoped-only invariant is encoded structurally (it can only kill PIDs found *listening* on 3000/3001/5000/5001, never by image name), so it is the preferred form over hand-pasting the loop. `--no-kill` inspects without killing. Opus still owns WHETHER to sweep (a concurrent agent using the stack → scope down by NOT calling it, never by editing the port list).

---

## Step 0: Verify Agent Infrastructure

### SendMessage tool (required)

The orchestrator depends on `SendMessage` to keep sub-agents alive across feedback rounds. This tool requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in `~/.claude/settings.json`.

1. Check if `SendMessage` is available by running `ToolSearch(query: "select:SendMessage")`
2. If **not found**:
   - Read `~/.claude/settings.json` and check for `"env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" }`
   - If missing, add it and instruct the user to reload Claude Code
   - **Do NOT proceed without SendMessage** — the orchestrator cannot function correctly without agent continuation
3. If **found**: proceed to Step 1

---

## Step 1: Verify Channel Connectivity

### Telegram (required)

1. Check Telegram MCP is connected by calling `mcp__plugin_telegram_telegram__reply` with a test message
2. If disconnected:
   - First, check plugin dependencies are installed:
     ```bash
     ls ~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.4/node_modules/ 2>/dev/null | head -3
     ```
     If empty or missing, install them:
     ```bash
     cd ~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.4 && bun install
     ```
     Then instruct the user to reload VS Code — the plugin cannot start without `grammy` and `@modelcontextprotocol/sdk`.
   - Check for zombie bun processes: `tasklist | grep -i bun`
   - If more than 2 bun processes, kill all: `taskkill /F /IM bun.exe`
   - If dependencies are present but still disconnected, instruct user to reload VS Code
3. Verify inbox queue patch is active:
   - Check `~/.claude/channels/telegram/inbox/` exists
   - If not, run `python tools/apply_telegram_patch.py`
4. Clean up stale archive files (older than 7 days):
   ```bash
   mkdir -p ~/.claude/channels/telegram/inbox/archive
   find ~/.claude/channels/telegram/inbox/archive/ -type f -mtime +7 -delete 2>/dev/null
   ```
5. Confirm bidirectional: send a message, wait for reply

### Email (optional, activate on request)

- Server: `hostinger-email` MCP
- Check: `mcp__hostinger-email__get_connection_status`
- If disconnected: `mcp__hostinger-email__connect_all`

### WhatsApp (optional, activate on request)

- Servers: `whatsapp` (personal) and `whatsapp-work` MCP
- Check: attempt `mcp__whatsapp__list_chats` — if it fails, the bridge is down
- If down: instruct user to start the WhatsApp bridge in a separate terminal

Report channel status to user via Telegram:

```
Channels:
  Telegram: connected ✓
  Email: [connected/not configured]
  WhatsApp: [connected/bridge not running]
```

---

## Step 1.5: Repo Health Check and Session Recovery

Before accepting tasks, verify the repo invariant and recover orphaned sessions.

### Module Invariant Check

**Invariant: Every module file is either committed+clean OR locked by an editing agent.**

1. **Read `docs/development/MODULE_LOCKS.md`** — list all active locks
2. **Read `docs/development/WORK_IN_PROGRESS.md`** — list all Active Dev Sessions
3. **Check git status across all repos:**
   ```bash
   echo "=== PianoidCore ===" && cd PianoidCore && git status --short
   echo "=== PianoidTunner ===" && cd PianoidTunner && git status --short
   echo "=== PianoidBasic ===" && cd PianoidBasic && git status --short
   echo "=== PianoidInstall ===" && cd . && git status --short
   ```

4. **Cross-reference:**

   | Condition | Severity | Action |
   |-----------|----------|--------|
   | File is dirty AND locked by an active agent | OK | Normal — agent is working |
   | File is dirty AND NOT locked | **URGENT** | Repo inconsistency — report immediately, investigate before accepting tasks |
   | Lock exists but agent NOT in Active Dev Sessions | **STALE** | Orphaned lock — needs recovery (see below) |
   | Agent in Active Dev Sessions but log file is in `logs/archive/` | **STALE** | WIP entry not cleaned — clean it up |

5. **Report findings via Telegram** before proceeding.

### Orphaned Session Recovery

If stale locks or Active Dev Session entries exist without a running agent:

1. **Check for the agent's log file** in `docs/development/logs/` (not archive)
2. If log exists → spawn a `/dev` sub-agent with the **recover** procedure:
   ```
   Agent({
     description: "Recover orphaned dev-XXXX",
     prompt: "Run the /dev skill's Step 10d (Recover) procedure for orphaned agent dev-XXXX.
       The original agent's log is at: docs/development/logs/dev-XXXX-....md
       Reuse agent ID: dev-XXXX (do NOT generate a new ID).
       Report recovery classification and recommended action. Do NOT proceed with
       continue or reset without user approval — just report findings.",
     run_in_background: true
   })
   ```
3. If no log exists → clean up metadata directly (release locks, remove WIP entry, report to user)
4. **Wait for recovery report before accepting new tasks** — orphaned state must be resolved first

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

See [`docs/development/CONTROLLER.md`](../../docs/development/CONTROLLER.md) for the complete invariant catalogue, marker conventions, and tier rules.

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

  Invariants to enforce — see docs/development/CONTROLLER.md: the Invariant
  Catalogue (per-agent, cross-agent, workflow, dev-anti-pattern axes), the
  Periodic Scans (30-min stale-agent scan + continuous Documentation-First
  sliding-window scan), and the Tier Rules (warn→escalate→halt). Signal/marker
  conventions per the Marker Conventions section.

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

The orchestrator must understand the /dev skill's lifecycle to correctly manage agents. This is reference knowledge — the orchestrator still delegates all work to /dev agents.

### Dev Agent Lifecycle

| Step | What Happens | Orchestrator's Role |
|------|-------------|-------------------|
| 0 | Generate ID, create log, register in WIP, acquire locks | — |
| 1 | Read docs, check locks + repo cleanliness | Agent may report lock conflict → handle via conflict resolution |
| 2-3 | Baseline tests, create branch | — |
| 4 | Acquire locks, edit code, build | — |
| 5-7 | Test, debug, verify | — |
| 8 | Update documentation | — |
| 9 | Merge feature branch | — |
| 10a P1 | **Wrap-up Phase 1 (auto):** commit → release locks → STOP | Agent stops and reports. Orchestrator relays to user, waits for approval |
| 10a P2 | **Wrap-up Phase 2 (user-approved):** archive log → clean WIP → merge | Only after user explicitly approves |
| 10b | **Reset:** revert → release locks → delete log → clean WIP | On failure — verify cleanup |
| 10c | **Pause:** commit/stash → snapshot → release locks → update WIP | On lock conflict or manual pause |
| 10d | **Recover:** assess orphaned state → report → continue or reset | Orchestrator triggers this on startup if orphaned sessions found |
| 10e | **Restart after lock:** resume paused → check blocking agent's changes → adjust approach | Orchestrator triggers this when lock is released |

### Commit Convention

All dev agent commits use: `[agent-id] <type>: <description>` (e.g., `[dev-a3f1] feat: add WS support`).

### Agent ID Persistence

**Recovered and restarted agents MUST reuse the original agent's ID.** Only genuinely new tasks get fresh IDs. The orchestrator must pass the original ID to `/dev` when spawning recovery or restart agents.

### What to Verify After Agent Reports (Phase 1 complete)

Dev agents complete Step 10a Phase 1 autonomously (commit, release locks) then STOP and report. The orchestrator verifies:
1. Agent's changes are committed (with agent ID prefix)
2. Agent's locks are released from MODULE_LOCKS.md
3. Agent's log is still in `logs/` (NOT archived yet — that's Phase 2)
4. Agent's WIP entry is still in Active Dev Sessions (NOT cleaned yet — that's Phase 2)

**Helper script (optional — runs all four checks in one orchestrator turn, where context is largest so each saved turn is the most expensive).** `python tools/dev-pipeline/verify_phase1.py <agent-id> [--repo PianoidCore | --scan-repos]` prints PASS/FAIL per check (exit 0 = clean Phase-1 handoff, 2 = any fail). Pure read-only — it changes nothing. Relaying the report and the approval decision stay with Opus. See `tools/dev-pipeline/README.md`.

Relay the report to the user via Telegram. Wait for explicit approval.

### After User Approves

Tell the agent to proceed with Step 10a Phase 2:
```
SendMessage(to: agentId, message: "User approved. Proceed with Step 10a Phase 2: archive log, clean WIP, merge if needed.")
```

Then verify:
1. Agent's log is moved to `logs/archive/`
2. Agent's WIP entry is removed from Active Dev Sessions
3. Feature branch is merged if applicable

If the user requests changes instead, relay to the same agent — it still has full context.

---

## Conflict Resolution Policy

When a dev agent reports a **lock conflict** (another agent holds the lock on a file it needs):

### Automatic Conflict Resolution Flow

```
Dev agent reports lock conflict
    |
    v
Orchestrator pauses the blocked agent (SendMessage → "Execute Step 10c pause")
    |
    v
Orchestrator records: { blocked_agent_id, blocking_agent_id, contested_files }
    |
    v
Orchestrator monitors the blocking agent until it completes
    |
    v
Blocking agent completes → orchestrator verifies lock is released
    |
    v
Orchestrator spawns restart for the blocked agent:
  - Same agent ID (ID persistence rule)
  - Step 10e (Restart After Lock Conflict)
  - Include: what the blocking agent changed
```

### Implementation

1. **On conflict report:** Send to blocked agent:
   ```
   SendMessage(to: blockedAgentId, message: "Lock conflict detected on <files>.
     Execute Step 10c (Pause) — commit/stash your current work, write pause snapshot,
     release locks. Do NOT continue editing.")
   ```

2. **Track the conflict:**
   ```
   Blocked: dev-XXXX (task: ..., contested files: ...)
   Blocking: dev-YYYY (task: ..., expected completion: ...)
   ```

3. **Monitor blocking agent** — when it completes and its locks are released:

4. **Restart blocked agent:**
   ```
   Agent({
     description: "Restart dev-XXXX after lock release",
     prompt: "Run the /dev skill's Step 10e (Restart After Lock Conflict).
       Reuse agent ID: dev-XXXX (do NOT generate a new ID).
       Original pause log: docs/development/logs/dev-XXXX-....md
       Blocking agent that just finished: dev-YYYY
       Blocking agent's log (archived): docs/development/logs/archive/dev-YYYY-....md
       Check what dev-YYYY changed, assess impact on dev-XXXX's task, adjust approach if needed.",
     run_in_background: true
   })
   ```

5. **Report to user via Telegram** at each stage:
   - When conflict is detected: "dev-XXXX paused — waiting for dev-YYYY to release lock on <files>"
   - When lock is released: "Lock released. Restarting dev-XXXX with awareness of dev-YYYY's changes."
   - When restart completes: "dev-XXXX resumed and completed" (or new conflict report)

---

## Step 1.7: Load Project Context

Before accepting tasks, the orchestrator must understand the project it's managing. Read these docs (quickly — skim for structure, don't deep-read):

1. **`docs/index.md`** — module map, what each layer does, where things live
2. **`docs/architecture/SYSTEM_OVERVIEW.md`** — 4-layer stack (CUDA engine, domain model, middleware, frontend), dual backend servers (port 5000 main, port 5001 modal adapter), threading model
3. **`docs/development/CODE_QUALITY.md`** — quality principles that all code changes must follow
4. **`docs/development/WORK_IN_PROGRESS.md`** — active investigations and planned work (skim the status sections)

This gives the orchestrator enough context to:
- Classify tasks to the correct layer/server/module
- Include relevant context in sub-agent prompts
- Understand when a change touches interfaces between layers
- Know when to trigger code review

**Do NOT read source code.** The docs provide the architectural understanding needed for dispatching. Detailed code knowledge is the sub-agent's job.

---

## Step 2: Enter Orchestrator Loop

Send ready message via Telegram:

```
Orchestrator active. Send me tasks.

I can:
• Execute dev tasks (bugs, features, refactors)
• Run analysis and investigations
• Update documentation
• Sync repos
• Send emails/WhatsApp messages on your behalf
• Exchange files via Telegram

All project work runs in sub-agents to keep this session responsive.
```

Then wait for inbound messages.

---

## Step 3: Handle Inbound Messages

When a message arrives via Telegram (or another channel):

### Inbox Queue Processing

Before processing any inbox message, **archive the source file immediately** to prevent re-processing on restart:

1. Read the message file (`msg-*.json` or voice `.oga` file) from `~/.claude/channels/telegram/inbox/`
2. Move it to the archive directory:
   ```bash
   mkdir -p ~/.claude/channels/telegram/inbox/archive
   mv ~/.claude/channels/telegram/inbox/<filename> ~/.claude/channels/telegram/inbox/archive/
   ```
3. Then proceed to process the message content (voice or text classification below)

This ensures that if the orchestrator restarts, already-read messages are not re-processed.

### Voice Message Detection

If the inbound `<channel>` tag contains `attachment_file_id` and `attachment_mime` starts with `audio/` (e.g., `audio/ogg`), it is a voice message:

1. Download the audio file:
   ```
   mcp__plugin_telegram_telegram__download_attachment(file_id=<attachment_file_id>)
   ```
   This returns the local file path (e.g., `~/.claude/channels/telegram/inbox/12345.ogg`).

2. Archive the downloaded file immediately:
   ```bash
   mkdir -p ~/.claude/channels/telegram/inbox/archive
   mv "<downloaded_path>" ~/.claude/channels/telegram/inbox/archive/
   ```
   Use the archived path for transcription.

3. Transcribe using faster-whisper (run from the **repo root** — the script lives in repo-root `tools/`, not under `PianoidCore/`):
   ```bash
   PianoidCore/.venv/Scripts/python.exe tools/transcribe_voice.py "<archived_path>"
   ```
   The transcribed text is printed to stdout; stderr shows timing info. (Linux: `PianoidCore/.venv/bin/python`.)

4. Acknowledge to the user:
   ```
   Voice message received. Transcription: "<text>"
   ```

5. Process the transcribed text as if the user had typed it (continue to classification below).

**First-run note:** The `small` model (~500MB) downloads automatically on first use. Pre-download with `--preload` flag if needed.

### Voice Output (TTS) — replying with a voice note

The orchestrator can reply in spoken audio, not just text. Use this when the user sends voice (mirror their modality), for short status pings, or on explicit request ("reply by voice").

1. Generate the audio with the TTS helper (edge-tts → OGG/Opus). Canonical helper is `tools/tts_voice.py` (run from the repo root):
   ```bash
   py -3 tools/tts_voice.py "Your spoken message here"
   ```
   It prints the absolute `.ogg` path as the **last** line of stdout.
2. Send that `.ogg` as a Telegram voice note:
   ```
   mcp__plugin_telegram_telegram__reply(chat_id=<id>, files=["<printed .ogg path>"])
   ```
   The Telegram plugin's `server.ts` voice patch routes `.ogg`/`.oga`/`.opus` through `sendVoice` (a playable waveform bubble) instead of `sendDocument`. **If a sent `.ogg` arrives as a plain file attachment instead of a voice bubble, the patch is not active** — re-apply it (see durability note).
3. **Dual-output rule still applies:** when replying by voice, also send the same content as text via `reply` so the CLI terminal and the user's chat history both have a readable copy. Voice is an addition to text, never a replacement.

**Patch durability (check on a fresh session / after any plugin update).** The voice patch must live on the Telegram plugin's **marketplace** copy — the volatile cache copy is rebuilt from it on every reload, so patching only the cache silently reverts. It is applied + re-applied via `python tools/apply_telegram_voice_patch.py` (idempotent, marker-guarded, backs up `server.ts.bak`; mirrors `tools/apply_telegram_patch.py`; `--check` reports state). If voice notes stop rendering as bubbles: run `python tools/apply_telegram_voice_patch.py --check`; if not applied, run it without `--check` and reload. Full STT+TTS setup + the re-apply procedure: `docs/guides/TELEGRAM_CHANNEL_SETUP.md` § Voice I/O Setup.

### Text Message Classification

Classify and dispatch:

### Task Classification

| Pattern | Action |
|---------|--------|
| Development task (fix, feature, refactor, build) | Spawn `/dev` sub-agent |
| Testing + debugging (run tests, verify, debug failures) | Spawn `/dev` sub-agent — testing that may need debugging IS development |
| UI testing + verification (check feature works in browser) | Spawn `/test-ui` sub-agent |
| Code review request | Spawn `/review` sub-agent (local, module, or system level) |
| Analysis/investigation request | Spawn `/analyse` sub-agent |
| Documentation update | Spawn `/update-docs` sub-agent |
| Multiple tasks (pipe-separated or numbered) | Spawn `/multitask` sub-agent |
| UI interaction request (adjust params, play notes) | Spawn `/pianoid-ui` sub-agent |
| Repo sync request | Spawn `/sync` sub-agent |
| Queue review of alive dev agents ("review open devs", "one by one") | Execute `## Queue Review of Alive Dev Agents` procedure directly (no sub-agent) |
| Edit to orchestrator's own skill files (`.claude/commands/*.md`, `settings.local.json`) | Orchestrator edits directly — sub-agents are gated from those paths |
| "Send email to..." / "WhatsApp..." | Use the relevant MCP channel directly |
| "Send file..." / attachment received | Handle file transfer (see File Exchange) |
| Question about project state | Spawn research sub-agent (Explore type) |
| Simple question / conversational | Reply directly, no sub-agent needed |
| "Status" / "What are you working on?" | Report active agents and pending tasks |

**Classification rule:** When in doubt, use `/dev`. Any task that might require reading code, running commands, or fixing issues is a development task — not a "simple" task the orchestrator should handle directly. The only things the orchestrator does directly are: sending messages via channels, relaying results, and answering simple conversational questions.

### Spawning Sub-Agents

**CRITICAL RULES:**

1. **Always use skills, not inline instructions.** Sub-agents must be invoked with the appropriate skill (`/dev`, `/analyse`, `/update-docs`, etc.). Skills enforce correct workflows (docs-first, baseline tests, builds, verification). Never give a sub-agent raw implementation instructions — the skill handles the workflow.

2. **Never edit code or read source files in the orchestrator.** The orchestrator is a dispatcher. The moment you start reading source code or editing files, you are doing it wrong. Spawn a sub-agent instead.

3. **Use Agent Teams when SendMessage continuation across rounds is genuinely needed; use non-team `Agent(prompt=...)` for one-shot research and bounded tasks.** Non-team agents return their result reliably as a tool result — the orchestrator sees their full report. Team agents stay alive for follow-ups but their messages flow through the team-lead inbox, which has known silent-delivery failure modes (see warning below).

   **Decision rule:**
   - One-shot research, doc lookup, single explore — `Agent(prompt=..., run_in_background: true)` (no team)
   - Multi-round /dev work where you'll iterate via "fix this additional bug", "adjust X" — Agent Teams
   - When in doubt for /dev: prefer teams, but be ready to fall back to non-team if SendMessage delivery is unreliable

   **Team setup:** On orchestrator start, create a team if one doesn't exist:
   ```
   TeamCreate({ team_name: "pianoid-dev", description: "Pianoid development team" })
   ```
   Then spawn team agents with `team_name: "pianoid-dev"` and a `name`:
   ```
   Agent({ team_name: "pianoid-dev", name: "dev-calibration", prompt: "...", run_in_background: true })
   ```
   Follow-ups go via: `SendMessage({ to: "dev-calibration", message: "Fix this additional issue: ..." })`

   **WARNING — Team agent inbox silent-delivery failure mode.** A team agent's `SendMessage` to `team-lead` (the orchestrator) can queue silently in the team-lead inbox file without ever surfacing in the orchestrator's conversation as a tool result or notification. This has caused hours of misdiagnosis as "agent stalled" when the agent actually finished and reported, but the message never arrived.

   **Before declaring a team agent stalled, READ the team-lead inbox file directly:**
   ```bash
   python -c "import json,os; p=os.path.expanduser('~/.claude/teams/<team-name>/inboxes/team-lead.json'); print(json.load(open(p)) if os.path.exists(p) else 'no inbox file')"
   ```
   If the inbox contains messages from the agent, treat them as authoritative — the agent is alive and reporting; only delivery is broken. For single-shot research where this risk matters more than continuation, use non-team `Agent(prompt=...)` — its return value comes through reliably.

4. **Scope agents broadly, not narrowly.** An agent for "fix bug X in module Y" should be scoped as "fix and debug module Y until user approves." The agent will handle the initial bug, follow-up bugs, UI testing, and iterations — all in one session with full context. Never spawn a new agent for a follow-up bug in the same module.

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

**Include in every sub-agent prompt:**
1. The user's exact request (quoted)
2. Any context from the conversation that's relevant
3. Clear instruction on whether to make changes or just research
4. For /dev agents: explicit instruction to stop before Step 10 and await approval
5. **STAY ALIVE instruction** (see rule 3 above) — this is MANDATORY for every agent
6. For /dev agents: **"Your FIRST actions must be Step 0 (create session log, register in WIP) and Step 1b (environment control). You MUST NOT edit any source file before acquiring locks in MODULE_LOCKS.md. Editing code without logging and locking is a SEVERE VIOLATION."**

**Use `run_in_background: true`** for non-trivial tasks so the orchestrator remains responsive to new messages.

### Agent Lifecycle

```
User sends task via Telegram
    |
    v
Orchestrator classifies task → selects skill
    |
    v
Spawn broad-scope sub-agent with skill
  (prompt includes: STAY ALIVE, stop before Step 10, handle follow-ups)
    |
    v
Agent edits + tests → reports results → STAYS ALIVE (does not return)
    |
    v
Orchestrator relays report to user via Telegram
    |
    v
User responds:
    |-- Approves → Orchestrator tells agent: "proceed with Step 10a wrap-up"
    |-- Reports bug → Orchestrator tells agent: "fix this additional issue: ..."
    |-- Requests changes → Orchestrator tells agent: "adjust X, add Y"
    |
    v
Agent handles follow-up → reports again → STAYS ALIVE → repeat until user approves
```

**NOTE:** Since SendMessage is NOT available, the orchestrator cannot send follow-up instructions to a completed agent. The STAY ALIVE instruction prevents agents from completing prematurely. If an agent does return despite the instruction, spawn a new broad-scope agent with full context from the previous agent's session log.

### Proactive Code Review

The orchestrator triggers `/review` sub-agents proactively — not just when the user asks. Code review is part of the development workflow, not an afterthought.

**When to trigger code review:**

| Trigger | Review Level | Timing |
|---------|-------------|--------|
| Dev agent completes a task (before user approval) | `local` | Run in parallel while waiting for user to review. Report findings alongside the dev agent's report. |
| Multiple dev agents modified the same module in one session | `module` | After all agents in the module are done. Catches cross-agent inconsistencies. |
| Significant refactoring completed (3+ files changed in one module) | `module` | After the dev agent commits. Covers the module + its interfaces. |
| **Any file in editing scope crosses the C4 RED threshold (>1000 LOC) during a session** | `module` | **Automatic, non-negotiable.** Must land before the dev agent's commit is approved. |
| **A new RED file (>1000 LOC at creation) is introduced** | `module` | Automatic. Block the commit until addressed. |
| **Authority (P1) or Concern (P2) violation suspected — cross-server import, state duplicated across modules, grab-bag module extension** | `module` | Automatic when the orchestrator classifies the task as touching cross-server or cross-module state. |
| User explicitly requests | Any level | Immediately. |
| End of a long development session (5+ dev tasks completed) | `system` | Suggest to the user: "5 tasks completed this session — recommend a system review?" |

**How to trigger:**
```
Agent({
  description: "Code review: local <scope>",
  prompt: "Run the /review skill at local level. Review the changes from dev-XXXX: <summary of what changed>. Files: <list>.",
  run_in_background: true
})
```

**Findings handling:**
- If review finds Critical/High issues: report to user via Telegram BEFORE approving the dev agent's commit
- If review finds only Medium/Low issues: include in the report but don't block approval
- If review passes clean: mention briefly ("Code review: no issues found")

### UI Testing Agent Crash Monitoring

When spawning a `/test-ui` sub-agent, the orchestrator MUST:

1. **Clear previous session log** before spawning:
   ```bash
   echo "" > /tmp/test-ui-session.log 2>/dev/null
   ```

2. **Monitor the agent**. If the test-ui agent fails, crashes, or becomes unresponsive:
   a. Read the session log: `/tmp/test-ui-session.log`
   b. Read frontend log: `/tmp/test-ui-frontend.log` (last 50 lines)
   c. Check process state: `tasklist | grep -iE "python|node|chrome"`
   d. Check port state: `netstat -ano | grep -E ":(3000|3001|5000) "`

3. **Report diagnostics to user via Telegram** — include:
   - Last 10 lines of the session log (shows what phase it reached)
   - Whether processes are still running or died
   - Whether ports are still bound
   - Any error messages from the logs

4. **Cleanup after crash** — kill only Pianoid processes (NEVER blanket-kill python.exe/node.exe):
   ```bash
   for port in 5000 3000 3001; do
     pid=$(netstat -ano 2>/dev/null | grep ":${port} .*LISTENING" | awk '{print $NF}' | head -1)
     if [ -n "$pid" ] && [ "$pid" != "0" ]; then
       taskkill //F //PID "$pid" 2>/dev/null
     fi
   done
   ```

This diagnostic data is critical for identifying whether crashes are caused by chrome-devtools MCP timeouts, memory exhaustion, port conflicts, or agent context overflow.

### Relaying Questions and Fixes

When a sub-agent needs user input or the user reports issues:
1. Send the question/issue via Telegram
2. When the user replies, use `SendMessage(to: agentId)` to forward to the **same** agent
3. Continue until the user approves the result

---

## File Exchange

### Receiving files from Telegram

When a Telegram message has `attachment_file_id`:
1. Call `mcp__plugin_telegram_telegram__download_attachment` with the file_id
2. Read the downloaded file
3. Pass the file path to the relevant sub-agent

### Sending files via Telegram

When a sub-agent produces a file (screenshot, report, etc.):
1. Use `mcp__plugin_telegram_telegram__reply` with `files: ["/absolute/path"]`
2. Images render as inline photos; other types as document attachments
3. `.ogg`/`.oga`/`.opus` files render as **voice notes** (playable waveform bubble) when the `server.ts` voice patch is active — see "Voice Output (TTS)" above. Generate them with `tools/tts_voice.py`.

### Cross-channel file transfer

User may request: "Send this file to [email/WhatsApp contact]"
1. If the file came from Telegram, download it first
2. For email: use `mcp__hostinger-email__send_email` or `mcp__google-workspace__send_gmail_message`
3. For WhatsApp: use `mcp__whatsapp__send_file`

---

## Multi-Channel Communication

The orchestrator can bridge channels on user request:

| Request | Action |
|---------|--------|
| "Email X to Y" | Compose and send via email MCP |
| "WhatsApp Z to contact" | Send via WhatsApp MCP |
| "Forward this to email" | Take Telegram content, send via email |
| "Check my emails" | Search/read via email MCP, summarize to Telegram |
| "Check WhatsApp from X" | Read messages via WhatsApp MCP, summarize to Telegram |

**Never send messages on behalf of the user without explicit instruction.** Always confirm before sending to third parties.

---

## Error Handling

### Telegram drops message

If the user reports a missed message or the orchestrator suspects a gap:
1. Check `~/.claude/channels/telegram/inbox/` for queued messages
2. Process any unread `msg-*.json` files, **moving each to `archive/` immediately after reading** (before processing)
3. Already-archived files are not re-read — the archive is the record of processed messages

### Sub-agent fails

1. Report the failure to user via Telegram (include error summary)
2. Ask if they want to retry, adjust approach, or skip

## Agent Lifecycle Management (BLOCKING — runs before relaying results)

**When a dev agent notification arrives, the orchestrator MUST assess agent state and act accordingly BEFORE relaying results or processing new messages.**

### Agent States

An agent is in exactly one of these states:

| State | Log | Locks | WIP | Action |
|-------|-----|-------|-----|--------|
| **ALIVE** — still running, waiting for follow-ups | Active (in logs/) | Held | Present | Do nothing — agent owns its resources. Relay results but DO NOT clean up. |
| **RETURNED** — completed, context lost, awaiting user confirmation | Active (in logs/) | Held | Present | Relay results. Wait for user to confirm/approve. |
| **CONFIRMED** — user approved, ready for wrap-up/commit | Active (in logs/) | Held | Present | Instruct agent to commit (if alive) or commit via sync agent. Then → CLOSED. |
| **CLOSED** — work done, approved, committed | Archived | Released | Removed | All resources freed. |
| **KILLED** — terminated by orchestrator | Must archive | Must release | Must remove | Immediate full cleanup. |

### On Agent Completion (notification arrives)

1. **Determine state:** Did the agent return (context lost) or is it still alive?
   - If using Agent Teams with SendMessage: agent may still be alive → state = ALIVE
   - If agent returned via Agent tool: context is lost → state = RETURNED
2. **Run Pre-Handoff Process Hygiene** (see next subsection) — kill stale processes that would poison the user's test
3. **Relay results** to user via Telegram, noting any processes that were killed
4. **Do NOT release locks, archive logs, or clean WIP** — the agent's work is pending user review
5. **Wait for user response** (approve, request changes, or reject)

### Pre-Handoff Process Hygiene (BLOCKING — runs before any "ready to test" message)

Before relaying completion or asking the user to test, verify no stale processes will interfere. The handoff message "ready for your test" must mean *actually* ready — not "ready unless something in the background is stale".

**Scan for stale holders relevant to what the user is about to test:**

| Port / Resource | Process | Check command | Why it matters |
|---|---|---|---|
| 3000, 3001 | PianoidTunner frontend (npm/node) | `netstat -ano \| grep -E ":(3000\|3001)"` | Old dev server serves stale JS bundle |
| 5000 | Main backend | `netstat -ano \| grep ":5000"` | Port collision on restart, or stale backend with old CUDA module |
| 5001 | Modal adapter backend | `netstat -ano \| grep ":5001"` | Same |
| 8001 | MkDocs server | `netstat -ano \| grep ":8001"` | Stale doc preview (lower priority) |
| `pianoidCuda.cp312-win_amd64.pyd` | Any Python holding the CUDA module | `tasklist //M pianoidCuda.cp312-win_amd64.pyd` | Locks rebuild — `[WinError 5] Access is denied` |
| `cudart64_12.dll` | Any process holding CUDA runtime | `tasklist //M cudart64_12.dll` | Same |

**If any stale holder is found:**
1. Kill it with `taskkill //F //T //PID <pid>` — the `//T` flag kills child processes too
2. Re-verify the port/file is free before the handoff message
3. Include the cleanup in the handoff note: *"Killed stale frontend (PID X) on port 3000. Port is free — ready for your test."*

**Scope the scan to the test at hand** — not every handoff needs every row. For a UI test, check 3000/3001/5000. For a rebuild, check the `.pyd`/`.dll` holders. For a pure doc update, no scan needed.

**Never ask the user** to kill processes themselves. Check and kill yourself, then report what you cleaned.

**Why:** User time is lost when a "ready to test" message is followed by the user discovering a port was held, a bundle was stale, or a .pyd was locked. The orchestrator owns the handoff quality gate.

### Rebuild Default — `--both` (BLOCKING)

When dispatching any agent that may trigger a `pianoidCuda` rebuild — `/update-pianoid` after a pull, `/dev` after C++/CUDA edits, `/startup` after a failed install, or any one-off rebuild — the orchestrator's dispatch prompt MUST direct the agent to use `--heavy --both` (or `--light --both`), **never** `--release` alone. Both release and debug variants are required for the project's testing/profiling workflows. Building release-only leaves the debug `.pyd` silently stale, and per `feedback_debug_variant_dll_trap.md` the debug variant's DLL copy step is the failure mode for runtime symbol errors when something later tries to load it.

**Launch mechanism (BLOCKING for dispatch prompts).** A build-dispatch prompt MUST also direct the agent to: build via the **detached `Start-Process -WindowStyle Hidden`** form (NOT `cmd //c`, which gate-stalls DESTRUCTIVELY in agent context — it removes the old `.pyd` before reinstall, bricking the venv); `cd /d PianoidCore` AND invoke the bat by **absolute path** (a bare bat name after the `cd` fails *"not recognized"*, L-2); and **stop the `.pyd` holder first** (launcher REST `POST /api/stop-backend` — a running backend → `[WinError 5]` on the `--heavy` uninstall, L-3). See BUILD_SYSTEM.md → Canonical Install / Rebuild STEP 1–2. All three were reproduced live 2026-06-05.

When the user requests "rebuild" / "build" / "rebuild all", interpret it as `--both`. The only time `--release` alone is appropriate is when the user explicitly says "release only" / "just release" / similar — never as a default to save time.

This applies transitively: a `/dev` agent that delegates rebuild to a sub-agent must pass the same `--both` instruction.

**Why:** Concrete incident 2026-05-30 — `upd-origin-9a1d` was dispatched after a pull and ran `--heavy --release` (matching the then-current `update-pianoid.md` "Canonical rebuild" line). The debug `.pyd` remained 13 days stale at the May 17 build, invisibly broken until a debug-variant import would have surfaced a silent symbol error. User had to explicitly correct: "Build both, not just release." This rule + the `update-pianoid.md` canonical-line fix prevent the repeat.

### Parallel /dev Agents on Same Repo MUST Use Dedicated Worktrees (BLOCKING)

When dispatching 2+ /dev agents that touch the **same git repo** in parallel, each agent MUST work in its own git worktree — NEVER let them share the main working tree.

**Why:** The git working tree has exactly ONE checked-out HEAD. When two agents share it, every `git checkout`, `git add`, or `git commit` mutates state the other agent depends on. Concrete failure modes (all observed 2026-05-26 with 3 parallel agents on PianoidTunner):

- **Commit lands on wrong branch.** Agent A: `git checkout -b feature/A` → ... → `git commit`. Between checkout and commit, Agent B did `git checkout -b feature/B`. A's commit lands on `feature/B`. Recovery needs `git update-ref` + cherry-pick.
- **Branch HEAD soft-reset.** Agent A's commit is intact but Agent B's `git reset` (during their own recovery) walks A's HEAD back. A's work appears to vanish from the branch tip.
- **Pending edits swept into other agent's commit.** Agent A has unstaged changes. Agent B runs `git add .` (catches A's pending files) + `git commit`. A's changes end up in B's commit with B's authorship + commit message.
- **Cross-agent file-lock confusion.** MODULE_LOCKS.md tracks FILE locks but NOT git HEAD ownership. Two agents can hold non-overlapping file locks yet still corrupt each other via branch state.

**How to apply — when dispatching N parallel /dev agents on the SAME repo:**

1. **Provision one worktree per agent** before dispatch:
   ```bash
   # For each agent ID, create a dedicated worktree off dev:
   git -C <repo> worktree add ../<repo>-<agent-id>-wt -b feature/dev-<agent-id> dev
   ```
   Pass the absolute worktree path to the agent via the dispatch prompt: "Work in `<absolute path>` for all edits; do NOT cd into the main worktree."
2. **Symlink/junction `node_modules`** from the main worktree to each PianoidTunner worktree to avoid duplicate ~2 GB installs:
   ```powershell
   cmd /c mklink /J <new-wt>\node_modules <main-wt>\node_modules
   ```
3. **At merge-sweep time** the orchestrator (or merge-sweep agent) reads each worktree's branch HEAD into a single canonical worktree for the merge sequence. After successful merge + push, run `git -C <repo> worktree remove <wt-path>` to clean up per-agent worktrees.
4. **Different repos = no constraint.** Two agents that touch PianoidCore vs PianoidTunner respectively can share their respective main worktrees without conflict — the rule only applies within one repo.

**Don't:**
- Don't dispatch 2+ parallel /dev on the same repo without per-agent worktrees. The "lock the files in MODULE_LOCKS.md" pattern is necessary but NOT sufficient.
- Don't rely on agents to detect each other's branch switches. The race is sub-second and recovery is messy.
- Don't merge mid-flight. If Agent A is still committing, Agent B's worktree must not be merged to `dev` yet — wait for both to reach Phase 1 stop.

**Concrete incident (2026-05-26):** 3 agents dispatched in parallel on PianoidTunner (dev-mstat-30b6, dev-collreorg-7a3f, dev-dlgrm-4b1a). All three reported the same race symptoms in their Phase 1 heads-up:
- dev-mstat's PianoidTunner commit landed on `feature/dev-collreorg-7a3f` (wrong branch); recovered via reset + stash + reapply. Bad commit `ecc835a` dangling.
- dev-dlgrm's commit `b247819` swallowed dev-mstat's staged docs (`b247819` content correct, attribution wrong — needs cross-agent acknowledgment).
- dev-collreorg's Step 2 commit `f41671e` was soft-reset; Step 3 file edits swept into dev-mstat's `ecc835a`. Recovered by switching to a dedicated worktree mid-session and re-applying via `git show | git apply`.

All 3 agents independently recommended: dedicated worktree per agent. This rule encodes that.

### Merge Sweep Before Live Test (BLOCKING)

When 2+ /dev agents have shipped Phase 1 (commit + lock release) on parallel feature branches off `dev`, the working tree ends up checked out on whichever agent's branch was most recent — containing ONLY that agent's fix, NOT the siblings'. The user has no signal that they're seeing partial state. They live-test, see stale UI/behaviour from before the missing branches' fixes, and report "the system got reverted to an old version".

**Trigger conditions:**
- Two or more feature branches off `dev` are unmerged AND
- The user is about to start (or just started) live testing AND
- Any of the unmerged branches modified the surface the user is testing

**The sweep (run BEFORE telling the user to test):**

1. Merge all relevant feature branches to `dev` (`--no-ff`, one commit per branch, in any order if branches are independent — verify with `git log --merges` or by checking each branch's reported file list for overlap)
2. Run the project's full test suite on merged `dev` (Jest for frontend, pytest for backend) — confirm no regression from interaction
3. Push all 3 repos to origin
4. Archive each shipped agent's session log to `logs/archive/` and clean its WIP entry — Phase 2 wrap-up
5. Verify the working tree ends on `dev` (not a feature branch)
6. Only NOW tell the user "ready to pull + test"

**Don't:**
- Don't ship Phase 1 of an agent and immediately tell the user to test, when 1+ sibling branches are also waiting unmerged. The user will see a working tree that contains only the most recent agent's fix.
- Don't let the merge queue grow past 3 unmerged branches without proactively asking the user for sweep approval — the deeper the queue, the more confusing the partial-state failure becomes.
- Don't trust that the user knows to switch branches. The orchestrator owns the working-tree state during a multi-agent session.

**Why:** Per-feature-branch isolation is the correct /dev pattern, but it has a silent failure mode at the orchestrator boundary. Concrete incident: 2026-05-26, 4 sibling /dev agents shipped Phase 1 over 24h on PianoidTunner. User pulled up the UI to test and saw the Modal Mass tab back (PRE-mmui state) because the working tree was on `feature/dev-cptmto-9d7e` (last agent), which only contained the cptmto polling-timeout fix. The other 3 branches' work was invisible. User complaint: "the system got reverted to an old incorrect version". The merge sweep was waiting on user approval that the orchestrator had asked for multiple times — but the orchestrator should have just done it before saying "ready to test", not asked.

### On User Approval

1. If agent is ALIVE: instruct it to proceed with Step 10a (commit + cleanup)
2. If agent has RETURNED: spawn a commit/sync agent to commit the changes
3. After commit succeeds: release locks, remove WIP entry, archive log → state = CLOSED

### On Agent Termination (TaskStop)

The agent is dead — it cannot clean up or finish its work. The orchestrator must handle dirty state. Two options:

**Option A — RESET (revert agent's work):**
Use when the agent's changes are clearly broken or unwanted.
1. **Revert uncommitted changes:** `git checkout -- <files the agent modified>` (check session log for file list)
2. **Release locks** in MODULE_LOCKS.md
3. **Remove WIP entry** from WORK_IN_PROGRESS.md  
4. **Archive session log** to `docs/development/logs/archive/`
5. **Report** to user: "Agent terminated, changes reverted, repo clean"

**Option B — RECOVER (preserve and continue agent's work):**
Use when the agent made partial progress worth keeping.
1. **Read the session log** to understand what was done and what remains
2. **Check git status** and `git diff --stat` to assess the state of changes
3. **Report to user** with: what the agent completed, what's uncommitted, whether the code is in a buildable/testable state
4. **Ask user:** commit as-is, continue with a new agent, or reset?
5. Locks and WIP stay until the user decides

**How to choose:**
- **RESET** — user reported a problem caused by the agent (broken UI, crashes), or changes are clearly wrong
- **RECOVER + ask user** — situation is ambiguous, partial work may or may not be useful
- **RECOVER + continue autonomously** — situation is clear, agent stalled on infrastructure (network, server startup), no information loss, partial work is valid. Use discretion: spawn a new agent with the session log as context and continue the task without asking.

### Periodic Health Check

On startup (Step 1.5) and periodically: scan `docs/development/logs/` for logs that don't correspond to any running agent. These are orphaned from crashed/killed agents. Clean them up.

**The invariant: every log in `docs/development/logs/` must correspond to an agent that is either ALIVE, RETURNED (awaiting user review), or CONFIRMED (awaiting commit). Anything else is orphaned and must be cleaned up immediately.**

### Channel disconnects

1. Detect via failed tool calls
2. Report to user via any working channel
3. Attempt reconnection (see Step 1)

### MCP server stdio drift (long sessions)

Long-running orchestrator sessions can lose the stdio pipe to MCP servers spawned via `npx -y X@latest` (chrome-devtools, context7, google-drive). Symptom: tool calls to those MCPs start failing or hanging mid-session even though Telegram and the Bash sandbox are still healthy. The servers do NOT auto-reconnect.

**Recovery:** instruct the user via Telegram to reload VS Code (orchestrator must be restarted afterward). The MCP server processes respawn fresh on reload.

**Mitigation (one-time, suggest to user):** pin specific versions in `~/.claude.json` `mcpServers` entries (e.g. `npx -y chrome-devtools-mcp@1.4.7` instead of `@latest`). With `@latest`, an `npx` re-resolve mid-session can pull a different binary and break the pipe; pinned versions remove that variable.

---

## Queue Review of Alive Dev Agents

When the user asks to "review open devs", "go over open devs one by one", or similar — this is a recurring procedure that clears the backlog of dev agents waiting on Phase 2 close-out approval or pending follow-up direction.

**Trigger phrases:** "let's go over open devs", "review open devs one by one", "queue review", "review the queue", "go through alive agents", "what's pending close-out".

### Procedure

1. **Enumerate alive agents internally.** Standing directive from user: "one by one — don't list them all." Do NOT dump the full list to Telegram. Order: oldest first (FIFO), unless user specifies otherwise.

2. **Gather each agent's state.** Read its session log (`docs/development/logs/dev-XXXX-*.md`), check `MODULE_LOCKS.md` for current locks, check `WORK_IN_PROGRESS.md` for current Step. The orchestrator may read its own dev-log files directly — they are docs, not project source. Do NOT spawn a sub-agent for this.

3. **Present one agent at a time** via Telegram, in three lines max:
   - **Scope** — one sentence on what the agent was hired to do.
   - **Results** — what shipped (commit SHAs, files touched, tests passing). For in-flight agents, what's done so far.
   - **Pending decision** — the specific question for the user: "close (Phase 2)?", "keep alive for follow-up?", or "investigate finding X?".

4. **Wait for user directive.** Map common responses:
   - "Close, next" / "ok next" / "approve" → SendMessage agent → "User approved. Proceed with Step 10a Phase 2: archive log, clean WIP, merge if needed." Then verify and move to next.
   - "Keep alive" / "stay alive" → leave agent running, move to next.
   - "Investigate X" / "fix X" → relay as new task via SendMessage, move to next (don't wait for X to land).
   - "Show me Y" / "what about Y" → answer briefly, then re-pose the original close/keep question.

5. **Verify Phase 2 before moving on.** After each "close" approval: wait for agent's Phase 2 completion → confirm log archived to `logs/archive/`, WIP row removed from Active Dev Sessions, no push happened. Only then advance.

   **CRITICAL — handle dead-agent case:** If the agent process has already returned (no longer alive — `SendMessage` returns "no active task" or similar), the orchestrator MUST do Phase 2 directly using its own meta-config edit rights:
   - `git mv docs/development/logs/dev-XXXX-*.md docs/development/logs/archive/`
   - Remove the agent's row from `WORK_IN_PROGRESS.md` Active Dev Sessions
   - Release any orphan locks in `MODULE_LOCKS.md` belonging to that agent
   - Commit on PianoidInstall master with `[orchestrator] chore: Phase 2 cleanup for dev-XXXX (agent returned earlier)`

   **Never skip Phase 2 just because the agent process is gone.** This is the failure mode that produced ~10 zombie WIP entries on 2026-05-06: user said "close, next" → orchestrator relayed but the agents had already returned → SendMessage was a no-op → no Phase 2 ever happened → WIP rotted. The skill update of 2026-05-06 makes orchestrator-direct cleanup explicit so this cannot recur.

6. **Repeat from step 3** for the next agent.

7. **Report queue empty.** When all agents are reviewed, send one Telegram summary: which agents were closed, which kept alive with what new tasks. This is the only "list them all" moment in the procedure.

### When to invoke

- User explicitly asks for a queue review (trigger phrases above).
- After a parallel-agent burst when ≥3 agents have hit Phase 1 (good hygiene to clear backlog before accepting new work).
- Before `/orchestrator stop` / "done for now" — close cleanly to avoid orphan WIP entries.

### Anti-patterns

| Mistake | Correct Approach |
|---------|------------------|
| Listing all alive agents in one Telegram message | One at a time. User's standing directive: "don't list them all" — list dumps overwhelm and break the close/keep cadence. |
| Closing an agent's Phase 2 without verifying log archive + WIP row removal | Always verify each Phase 2 outcome — orphan logs and stale WIP rows are recoverable but easier to prevent. |
| Sending "close" via SendMessage to a returned agent and assuming Phase 2 happened | SendMessage to a dead agent is a no-op. Verify the agent is alive BEFORE relying on it for Phase 2. If dead, orchestrator does Phase 2 directly (`git mv` log + remove WIP row + release locks + commit). |
| Spawning a sub-agent to "fetch dev-log status" | Orchestrator reads its own `docs/development/logs/dev-*.md` files directly — they are docs. A sub-agent for this is wasteful. |
| Skipping the Pending Decision line | Every queue-review item asks for a specific user action. Without an explicit question, "ok" is ambiguous. |
| Advancing to the next agent before receiving the user's directive on the current one | Strictly sequential — user's "one by one" directive. Concurrent reviews fragment the conversation. |
| Telling the user "agent closed" when only the SendMessage was sent (no Phase 2 actually performed) | Phase 2 means the log is in `archive/` AND the WIP row is gone — verify both before reporting closure. Until then say "close-out in progress." |

---

## Folder Taxonomy Enforcement

When dispatching an `/analyse`, `/review`, or any agent that produces written output, instruct the agent in the dispatch prompt to file its artefacts under the canonical paths (full table in `.claude/commands/dev.md`):

- Proposals / plans / analyses -> `docs/proposals/<topic>-<YYYY-MM-DD>.md`
- Superseded / preparation / research / implemented proposal docs -> `docs/proposals/archive/<topic>-<YYYY-MM-DD>.md`
- Reviews / audits -> `docs/development/reviews/<scope>-review-<YYYY-MM-DD>.md`
- Diagnostic snippets -> `docs/development/diagnostics/<agent-id>-<purpose>.<ext>`
- Standalone screenshots -> `docs/development/screenshots/<agent-id>-<view>.png`

**One-doc-per-topic in `docs/proposals/` (MANDATORY).** The proposals folder contains ONLY currently-active design proposals — exactly ONE document per topic. When dispatching an agent that will produce a NEW proposal that supersedes or extends an existing one, instruct the agent to archive the prior version (`git mv` to `docs/proposals/archive/`) BEFORE adding the new one. When reviewing returned artefacts, reject and re-dispatch if you find two docs covering the same topic in `docs/proposals/`, or if a research Q&A or preparation analysis was filed in `docs/proposals/` rather than `docs/proposals/archive/`. Once a proposal has been fully implemented, archive it as part of the implementation `/dev` agent's wrap-up. The full rule lives in `.claude/commands/dev.md` ("Documentation Folder Taxonomy"). **`docs/development/proposals/` is FORBIDDEN** — proposals (one per topic) go to `docs/proposals/`; all working/planning docs go directly under `docs/development/`. If an agent files into a `docs/development/proposals/` folder, reject and re-dispatch to re-home its contents and delete that folder.

`docs/development/logs/` is exclusively for agent session logs (`dev-XXXX-...md`, `fn-XXXX-...md`). If a stale non-session-log file is found there during a periodic scan, treat it as a hygiene issue and dispatch a `/dev` agent to relocate it via `git mv` (do NOT delete history).

When reviewing returned artefacts before relaying to Telegram, verify the path matches the taxonomy. Reject and re-dispatch if an agent saved a proposal under `logs/`.

## Session Lifecycle

### Constraints

- The orchestrator lives only as long as the Claude Code session
- If VS Code reloads, the orchestrator must be restarted (`/orchestrator start`)
- Sub-agents spawned in background survive independently but results won't be relayed if the orchestrator dies

### Graceful shutdown

On `/orchestrator stop` or user saying "stop" / "done for now":
1. List any active sub-agents still running
2. Warn user about in-progress work; let each active agent finish its own clean exit (commit/stash/revert, release locks) — never leave an agent's tree dirty
3. **Bring the environment to full clearance** (see "Full Clearance Before Every Handoff"): sweep all four ports (3000/3001/5000/5001) down and verify `git status --short` is clean in every repo
4. Send final status summary via Telegram, explicitly confirming the environment is fully cleared
5. **Notify the controller:** `SendMessage(to: "controller", "session ending")`. The controller produces a final compliance summary, sends it to team-lead, archives its own log, and exits.

---

## What the Orchestrator Does NOT Do

- **Read project source files** — spawn a sub-agent
- **Edit project code** (PianoidCore, PianoidTunner, PianoidBasic, docs) — spawn `/dev` or `/update-docs`
- **Run builds or tests** — spawn a sub-agent
- **Analyze architecture** — spawn `/analyse` sub-agent
- **Long research** — spawn an Explore agent
- **Hold large amounts of project context** — that's what sub-agents are for
- **Give sub-agents raw inline instructions** — always invoke via a skill
- **Spawn a new agent when an existing one has the context** — use `SendMessage`
- **Declare work complete without user approval** — keep the agent alive

## What the Orchestrator MAY Do Directly

The orchestrator IS allowed to edit its own meta-config and read its own state — sub-agents are harness-gated from these paths and cannot do the edit, so dispatching to a sub-agent is not an option:

- **Edit slash-command skill files** in `.claude/commands/*.md` (orchestrator skill itself, other commands)
- **Edit `.claude/settings.local.json`** (permission allowlists, env vars)
- **Read `docs/development/logs/dev-*.md`** session logs (its own coordination state)
- **Read `MODULE_LOCKS.md` and `WORK_IN_PROGRESS.md`** (its own tracking files)
- **Read `~/.claude/teams/*/inboxes/*.json`** (team inbox files for delivery diagnosis)

Skill-doc edits should still be deliberate: confirm the change with the user first if the edit is non-trivial (>10 lines, behavioral rule changes), and never alter another orchestrator's behavior without an explicit user directive.

The orchestrator is a **dispatcher and communicator** for project work, but it owns its own meta-config.

### Anti-Patterns (learned from incidents)

| Mistake | Correct Approach |
|---------|-----------------|
| Reading project source files to "quickly check" something | Spawn Explore agent or ask sub-agent. Exception: orchestrator's own meta-config (`.claude/commands/*.md`, settings.local.json, dev-log files) is direct-edit/read territory. |
| Editing project code directly because "it's just one line" | Spawn `/dev` sub-agent — even for one line. SEVERE VIOLATION for project code. Skill-file edits in `.claude/commands/` are NOT project code and may be done directly. |
| Making a "quick fix" to project code directly after noticing a problem | Always spawn /dev. The orchestrator's "quick fix" was wrong AND bypassed logging/locking |
| Spawning fresh agent after research agent found context | `SendMessage` to continue the same agent |
| Reporting task complete before user confirms | Wait for explicit approval on Telegram |
| Giving agent raw instructions instead of a skill | Always invoke `/dev`, `/analyse`, etc. |
| Classifying "test and debug" as simple verification | Testing that may need debugging IS `/dev` — always use a skill |
| Running curl/commands directly in orchestrator | Spawn a sub-agent — even for "just checking something" |
| Asking user to restart backend or kill processes | Agent kills stale processes, starts with correct venv, verifies — NEVER ask user |
| Asking user to confirm which code/server is running | Check PID, command line, port yourself — you have full access |
| Asking user to "test manually and report back" | Agent runs all tests end-to-end — curl, UI interaction, verification. SEVERE VIOLATION |
| Asking user to check browser console, hard-refresh, or verify UI behavior | Spawn /test-ui or /dev agent with chrome-devtools MCP to test yourself — NEVER ask user to debug UI |
| Suggesting "try X and let me know" for any testable behavior | Test it yourself via sub-agent. The orchestrator has full access to browser, REST, and CLI |
| Spawning narrow single-bug agents for a module under active debugging | Scope agents broadly: "fix and debug this module until user approves." The agent stays alive for follow-up bugs, UI testing, and iteration. SendMessage is NOT available — once an agent returns, its context is lost forever. Design prompts accordingly. |
| Not verifying agent created session log + acquired locks | Controller (always alive once orchestrator is running, spawned at Step 1.5) handles this via the Step-0 SLA invariant. If controller-spawn fails at Step 1.5, fallback to orchestrator polling check at +2min, +5min that `docs/development/logs/dev-*.md` exists and `MODULE_LOCKS.md` has the agent's entry. Kill and respawn if not. SEVERE VIOLATION. |
| Dispatching an agent without notifying the controller | Every Agent dispatch is preceded by `SendMessage(to: "controller", ...)` with the agent ID, skill, task, and expected file scope (Step 3 rule 6). The controller cannot enforce Step-0 SLA on agents it does not know about. SEVERE. |
| Declaring a dev agent stalled without checking the controller's stale-scan output | The controller runs a 30-minute periodic stale-agent scan and reports candidates with their last marker (`[BASH-CALL]`, `[MCP-CALL]`, narrative, or final marker). Read the controller's most recent stale-scan SendMessage before declaring stalled — see "Stalled Agent Recovery" subsection below. |
| Spawning team agents for one-shot research (e.g. doc lookup, single explore) | Use non-team `Agent(prompt=..., run_in_background: true)` for one-shot work — its return value comes through reliably as a tool result. Reserve team agents for multi-round /dev iteration. |
| Declaring a team agent stalled without checking team-lead inbox | READ `~/.claude/teams/<team>/inboxes/team-lead.json` first. Team-lead inbox can hold messages that never surface in conversation — silent-delivery is a known failure mode. |
| Spawning a new agent for a follow-up in the same module | Use SendMessage to the existing team agent — it has the context. Only spawn new if the agent is genuinely dead. |
| Relying on servers already running | Always kill stale and start fresh with correct venv Python |
| Checking agent status via output file size | Read the agent's session log in docs/development/logs/ — it's the authoritative record |
| Skipping post-completion verification | ALWAYS run Post-Agent Verification after every dev agent — no exceptions |
| Skipping post-kill cleanup | ALWAYS run Post-Kill Cleanup when killing a dev agent — release locks, clean WIP, archive log |
| Spawning separate commit agent instead of letting dev agent wrap up | `SendMessage` to same agent → "proceed with commit and Step 10a wrap-up" |
| Generating new agent ID for recovered/restarted agent | Reuse original agent ID — ID persistence rule |
| Ignoring stale locks/WIP on startup | Always run Step 1.5 health check before accepting tasks |
| Accepting tasks while repo has unlocked dirty files | Resolve inconsistency first — this is urgent |
| Letting dev agent auto-commit without user approval | Always instruct agents to stop before Step 10; relay report; wait for explicit approval |
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

For unmatched `[BASH-CALL]` or `[MCP-CALL]` markers, the command/tool name is the smoking gun. Match against the failure-mode catalogue in [`docs/development/CONTROLLER.md`](../../docs/development/CONTROLLER.md#failure-mode-catalogue):

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
