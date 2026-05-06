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

## Core Principle: Orchestrate, Don't Execute

The orchestrator's context window is precious. **NEVER** read project source files, grep codebases, or perform analysis directly. Instead:

1. Receive task from user via Telegram (or other channel)
2. Classify the task
3. Spawn a sub-agent with a detailed prompt
4. Relay results/questions back to user
5. Repeat

This keeps the orchestrator's context clean and able to run for extended sessions.

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

3. Transcribe using faster-whisper:
   ```bash
   cd PianoidCore && .venv/Scripts/python tools/transcribe_voice.py "<archived_path>"
   ```
   The transcribed text is printed to stdout. Stderr shows timing info.

4. Acknowledge to the user:
   ```
   Voice message received. Transcription: "<text>"
   ```

5. Process the transcribed text as if the user had typed it (continue to classification below).

**First-run note:** The `small` model (~500MB) downloads automatically on first use. Pre-download with `--preload` flag if needed.

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

5. **Controller agent.** The team should include a permanent controller agent whose job is to monitor /dev workflow compliance. See "Controller Agent" section below.

5. **Never let dev agents auto-commit.** Dev agents must STOP before Step 10 (wrap-up/commit) and report their changes. The orchestrator relays the report to the user. Only after explicit user approval does the orchestrator instruct the agent to proceed with Step 10.

   The only exception is if the user explicitly says "commit without asking" or "auto-wrap-up" for a specific task.

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

## Session Lifecycle

### Constraints

- The orchestrator lives only as long as the Claude Code session
- If VS Code reloads, the orchestrator must be restarted (`/orchestrator start`)
- Sub-agents spawned in background survive independently but results won't be relayed if the orchestrator dies

### Graceful shutdown

On `/orchestrator stop` or user saying "stop" / "done for now":
1. List any active sub-agents still running
2. Warn user about in-progress work
3. Send final status summary via Telegram

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
| Not verifying agent created session log + acquired locks | The controller agent handles this. If no controller, check within ~2 min that docs/development/logs/dev-*.md exists and MODULE_LOCKS.md has the agent's entry. Kill and respawn if not. SEVERE VIOLATION. |
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
