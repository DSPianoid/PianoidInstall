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
   - If not, run `python D:/repos/PianoidInstall/tools/apply_telegram_patch.py`
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
   echo "=== PianoidCore ===" && cd D:/repos/PianoidInstall/PianoidCore && git status --short
   echo "=== PianoidTunner ===" && cd D:/repos/PianoidInstall/PianoidTunner && git status --short
   echo "=== PianoidBasic ===" && cd D:/repos/PianoidInstall/PianoidBasic && git status --short
   echo "=== PianoidInstall ===" && cd D:/repos/PianoidInstall && git status --short
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
   cd D:/repos/PianoidInstall/PianoidCore && .venv/Scripts/python D:/repos/PianoidInstall/tools/transcribe_voice.py "<archived_path>"
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

3. **NEVER spawn single-task agents that die on return.** SendMessage is NOT available — once an agent returns, its context is lost FOREVER. Every agent must be instructed to STAY ALIVE and wait for follow-up instructions or explicit confirmation to wrap up. **Always include in every agent prompt:**
   ```
   STAY ALIVE after completing this task. Do NOT return or exit. After reporting your results,
   wait for follow-up instructions — the orchestrator will relay user feedback, additional bugs
   to fix, or approval to commit. You will handle ALL follow-up work on this module until the
   user explicitly approves wrap-up.
   ```

4. **Scope agents broadly, not narrowly.** An agent for "fix bug X in module Y" should be scoped as "fix and debug module Y until user approves." The agent will handle the initial bug, follow-up bugs, UI testing, and iterations — all in one session with full context. Never spawn a new agent for a follow-up bug in the same module.

5. **Never let dev agents auto-commit.** Dev agents must STOP before Step 10 (wrap-up/commit) and report their changes. The orchestrator relays the report to the user. Only after explicit user approval does the orchestrator instruct the agent to proceed with Step 10.

   The only exception is if the user explicitly says "commit without asking" or "auto-wrap-up" for a specific task.

**Include in every sub-agent prompt:**
1. The user's exact request (quoted)
2. Any context from the conversation that's relevant
3. Clear instruction on whether to make changes or just research
4. For /dev agents: explicit instruction to stop before Step 10 and await approval
5. **STAY ALIVE instruction** (see rule 3 above) — this is MANDATORY for every agent

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
   echo "" > D:/tmp/test-ui-session.log 2>/dev/null
   ```

2. **Monitor the agent**. If the test-ui agent fails, crashes, or becomes unresponsive:
   a. Read the session log: `D:/tmp/test-ui-session.log`
   b. Read frontend log: `D:/tmp/test-ui-frontend.log` (last 50 lines)
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

### Post-Agent Verification (MANDATORY after EVERY dev agent completion)

After every dev agent completes (success or failure), the orchestrator MUST:

1. **Read the agent's session log** from `docs/development/logs/` (NOT the output file — the session log is the authoritative record):
   ```bash
   ls docs/development/logs/dev-XXXX-*.md
   ```
   This tells you what the agent actually did, what files it modified, and whether it completed cleanup.

2. **Check MODULE_LOCKS.md** — verify the agent's locks are released. If not, release them.

3. **Check WORK_IN_PROGRESS.md** — verify the agent's entry is still appropriate:
   - If agent completed and user approved commit: entry should remain until user approves wrap-up
   - If agent was killed or failed: remove the entry immediately

4. **Check for dirty files** — if the agent was killed mid-edit:
   ```bash
   git status --short
   ```
   If there are uncommitted changes from the killed agent, report to user and ask: keep or revert?

5. **Archive the log** — only after user approves wrap-up and the agent has committed:
   ```bash
   mv docs/development/logs/dev-XXXX-*.md docs/development/logs/archive/
   ```

**Never skip this.** Ghost entries accumulate fast and confuse future agents.

### Post-Kill Cleanup (MANDATORY when orchestrator kills an agent)

When the orchestrator kills a dev agent (TaskStop), immediately:

1. **Read the agent's session log** to understand what it did
2. **Release locks** in MODULE_LOCKS.md (the agent can't do it itself — it's dead)
3. **Remove WIP entry** from WORK_IN_PROGRESS.md
4. **Check git status** for uncommitted changes:
   - If changes are partial/broken: `git checkout -- <files>` to revert
   - If changes look complete but uncommitted: report to user, ask whether to commit or revert
5. **Archive the session log** to `docs/development/logs/archive/`
6. **Report to user** what was cleaned up

### Channel disconnects

1. Detect via failed tool calls
2. Report to user via any working channel
3. Attempt reconnection (see Step 1)

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

- **Read source files** — spawn a sub-agent
- **Edit code** — spawn `/dev` sub-agent
- **Run builds or tests** — spawn a sub-agent
- **Analyze architecture** — spawn `/analyse` sub-agent
- **Long research** — spawn an Explore agent
- **Hold large amounts of project context** — that's what sub-agents are for
- **Give sub-agents raw inline instructions** — always invoke via a skill
- **Spawn a new agent when an existing one has the context** — use `SendMessage`
- **Declare work complete without user approval** — keep the agent alive

The orchestrator is a **dispatcher and communicator**, not a worker.

### Anti-Patterns (learned from incidents)

| Mistake | Correct Approach |
|---------|-----------------|
| Reading source files to "quickly check" something | Spawn Explore agent or ask sub-agent |
| Editing code directly because "it's just one line" | Spawn `/dev` sub-agent — even for one line. SEVERE VIOLATION — no exceptions |
| Making a "quick fix" directly after noticing a problem | Always spawn /dev. The orchestrator's "quick fix" was wrong AND bypassed logging/locking |
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
