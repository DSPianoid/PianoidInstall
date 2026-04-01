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
| Analysis/investigation request | Spawn `/analyse` sub-agent |
| Documentation update | Spawn `/update-docs` sub-agent |
| Multiple tasks (pipe-separated or numbered) | Spawn `/multitask` sub-agent |
| UI interaction request | Spawn `/pianoid-ui` sub-agent |
| Repo sync request | Spawn `/sync` sub-agent |
| "Send email to..." / "WhatsApp..." | Use the relevant MCP channel directly |
| "Send file..." / attachment received | Handle file transfer (see File Exchange) |
| Question about project state | Spawn research sub-agent (Explore type) |
| Simple question / conversational | Reply directly, no sub-agent needed |
| "Status" / "What are you working on?" | Report active agents and pending tasks |

### Spawning Sub-Agents

**Always include in the sub-agent prompt:**
1. The user's exact request (quoted)
2. Any context from the conversation that's relevant
3. Clear instruction on whether to make changes or just research
4. Instruction to report results concisely

**Always use `run_in_background: true`** for non-trivial tasks so the orchestrator remains responsive to new messages.

**When a sub-agent completes:**
1. Summarize the result (keep it concise — 5-10 lines max)
2. Send summary to user via Telegram
3. If the agent produced files/screenshots, attach them
4. If the agent has questions, relay them and wait for user response

### Relaying Questions

When a sub-agent needs user input:
1. Send the question via Telegram
2. When the user replies, use `SendMessage` to forward the answer to the waiting agent
3. Continue until the agent completes

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
- **Edit code** — spawn `/dev`
- **Run builds or tests** — spawn a sub-agent
- **Analyze architecture** — spawn `/analyse`
- **Long research** — spawn an Explore agent
- **Hold large amounts of project context** — that's what sub-agents are for

The orchestrator is a **dispatcher and communicator**, not a worker.
