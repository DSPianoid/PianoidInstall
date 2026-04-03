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
4. Confirm bidirectional: send a message, wait for reply

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

### Voice Message Detection

If the inbound `<channel>` tag contains `attachment_file_id` and `attachment_mime` starts with `audio/` (e.g., `audio/ogg`), it is a voice message:

1. Download the audio file:
   ```
   mcp__plugin_telegram_telegram__download_attachment(file_id=<attachment_file_id>)
   ```
   This returns the local file path (e.g., `~/.claude/channels/telegram/inbox/12345.ogg`).

2. Transcribe using faster-whisper:
   ```bash
   cd D:/repos/PianoidInstall/PianoidCore && .venv/Scripts/python D:/repos/PianoidInstall/tools/transcribe_voice.py "<downloaded_path>"
   ```
   The transcribed text is printed to stdout. Stderr shows timing info.

3. Acknowledge to the user:
   ```
   Voice message received. Transcription: "<text>"
   ```

4. Process the transcribed text as if the user had typed it (continue to classification below).

**First-run note:** The `small` model (~500MB) downloads automatically on first use. Pre-download with `--preload` flag if needed.

### Text Message Classification

Classify and dispatch:

### Task Classification

| Pattern | Action |
|---------|--------|
| Development task (fix, feature, refactor, build) | Spawn `/dev` sub-agent |
| Testing + debugging (run tests, verify, debug failures) | Spawn `/dev` sub-agent — testing that may need debugging IS development |
| UI testing + verification (check feature works in browser) | Spawn `/test-ui` sub-agent |
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

3. **Keep agents alive until user approves.** Do NOT consider a sub-agent's work done until the user confirms the result is acceptable. Save the agent ID so you can send follow-up instructions via `SendMessage` if the user reports issues.

4. **Continue agents, don't replace them.** When a research agent builds context that is needed for implementation, use `SendMessage(to: agentId)` to transition that same agent to implementation — do NOT spawn a fresh agent that loses the context. Similarly, if the user requests fixes to work done by an agent, relay the fix request to the same agent.

**Include in the sub-agent prompt:**
1. The user's exact request (quoted)
2. Any context from the conversation that's relevant
3. Clear instruction on whether to make changes or just research

**Use `run_in_background: true`** for non-trivial tasks so the orchestrator remains responsive to new messages.

### Agent Lifecycle

```
User sends task via Telegram
    |
    v
Orchestrator classifies task → selects skill
    |
    v
Spawn sub-agent with skill (save agentId)
    |
    v
Agent completes → orchestrator summarizes to user via Telegram
    |
    v
User approves?
    |-- YES → agent is done
    |-- NO / issues → SendMessage(to: agentId) with fix instructions
                          |
                          v
                      Agent fixes → orchestrator relays result → repeat
```

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
2. Process any unread `msg-*.json` files
3. Delete processed files after handling

### Sub-agent fails

1. Report the failure to user via Telegram (include error summary)
2. Ask if they want to retry, adjust approach, or skip

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
| Editing code directly because "it's just one line" | Spawn `/dev` sub-agent — even for one line |
| Spawning fresh agent after research agent found context | `SendMessage` to continue the same agent |
| Reporting task complete before user confirms | Wait for explicit approval on Telegram |
| Giving agent raw instructions instead of a skill | Always invoke `/dev`, `/analyse`, etc. |
| Classifying "test and debug" as simple verification | Testing that may need debugging IS `/dev` — always use a skill |
| Running curl/commands directly in orchestrator | Spawn a sub-agent — even for "just checking something" |
| Asking user to restart backend or kill processes | Agent kills stale processes, starts launcher, clicks APPLY itself |
| Asking user to "test manually and report back" | Agent runs all tests end-to-end — curl, UI interaction, verification |
