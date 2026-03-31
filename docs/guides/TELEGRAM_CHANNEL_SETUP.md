# Telegram Channel Setup

Connect a Telegram bot to Claude Code for remote task orchestration via the `/orchestrator` skill.

## Prerequisites

| Requirement | Notes |
|---|---|
| Claude Code | v2.1+ with plugin support (VS Code extension or CLI) |
| Bun runtime | Telegram plugin runs on Bun (bundled with the plugin) |
| Telegram bot token | Create via [@BotFather](https://t.me/BotFather) |
| Your Telegram user ID | Get from [@userinfobot](https://t.me/userinfobot) |

## Step 1: Install the Telegram Plugin

In Claude Code:

```
/install-plugin telegram
```

The plugin files land in:

| Location | Path | Notes |
|---|---|---|
| Marketplace (source of truth) | `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram/` | Patch here |
| Cache (runtime copy) | `~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.4/` | Overwritten from marketplace on restart |

## Step 2: Configure the Bot Token

```
/telegram:configure <your-bot-token>
```

This writes `~/.claude/channels/telegram/.env`:

```
TELEGRAM_BOT_TOKEN=123456789:AAH...
```

Restart the session or run `/reload-plugins` for the token to take effect.

## Step 3: Pair Your Telegram Account

1. DM your bot on Telegram — it replies with a pairing code
2. Approve the pairing:
   ```
   /telegram:access pair <code>
   ```
3. Lock down to allowlist (recommended):
   ```
   /telegram:access policy allowlist
   ```

Result in `~/.claude/channels/telegram/access.json`:

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["<your-user-id>"],
  "groups": {},
  "pending": {}
}
```

## Step 4: Apply the Inbox Queue Patch

The plugin delivers messages via MCP notifications, which are **silently dropped** when the session is busy (rendering, awaiting tool approval, waiting for CLI input). The inbox queue patch writes every inbound message to disk as a backup.

See [anthropics/claude-code#40612](https://github.com/anthropics/claude-code/issues/40612) for the upstream bug report.

Apply the patch:

```bash
python D:/repos/PianoidInstall/tools/apply_telegram_patch.py
```

Check-only (no modifications):

```bash
python D:/repos/PianoidInstall/tools/apply_telegram_patch.py --check
```

After patching, reload Claude Code (`Ctrl+Shift+P` > "Developer: Reload Window").

### What the Patch Does

Inserts code in `handleInbound` (server.ts) that writes every inbound message to `~/.claude/channels/telegram/inbox/msg-{timestamp}-{msgId}.json` before the MCP notification. This provides a file-based backup delivery path.

## Step 5: Install Voice Transcription (Optional)

Enable voice message support using faster-whisper (local CUDA-accelerated transcription):

```bash
cd D:/repos/PianoidInstall/PianoidCore
.venv/Scripts/pip install faster-whisper
.venv/Scripts/python ../tools/transcribe_voice.py --preload
```

This downloads the `small` model (~500MB, ~2GB VRAM). Transcription takes <2 seconds per message on CUDA.

The `/orchestrator` skill automatically detects voice messages and transcribes them.

## Step 6: Verify

1. Send a text message to your bot from Telegram
2. Check it appears in the Claude Code conversation
3. Check `~/.claude/channels/telegram/inbox/` for a backup `msg-*.json` file
4. Reply from Claude Code to confirm bidirectional communication
5. (Optional) Send a voice message and verify transcription

## Step 7: Start the Orchestrator

```
/orchestrator start
```

This activates the remote task coordination loop. You can now:
- Send development tasks via text or voice
- Receive results, screenshots, and files
- Control sub-agents for analysis, coding, documentation
- Bridge to email and WhatsApp channels

## Known Issues (Windows)

### Zombie Bun Processes

Claude Code on Windows does not terminate plugin processes when sessions end or VS Code reloads. Zombie processes compete for Telegram `getUpdates`, stealing messages.

**Diagnosis:**

```bash
tasklist | grep -i bun
```

Each session should have exactly 2 bun processes (parent + child). More than 2 = zombies.

**Fix:**

```bash
taskkill //F //IM bun.exe
```

Then reload VS Code to spawn a fresh pair.

**Root cause:** Claude Code doesn't close the stdio pipe or send SIGTERM on Windows. Reported as [anthropics/claude-code#40612](https://github.com/anthropics/claude-code/issues/40612).

### MCP Notification Drops

Inbound messages are silently dropped when the session is busy. The inbox queue patch (Step 4) mitigates this. A polling loop can be added to pick up missed messages from the inbox directory.

## File Locations

| File | Purpose |
|---|---|
| `~/.claude/channels/telegram/.env` | Bot token |
| `~/.claude/channels/telegram/access.json` | Access policy and allowlist |
| `~/.claude/channels/telegram/inbox/` | Backup message queue (patch) |
| `~/.claude/plugins/marketplaces/.../telegram/server.ts` | Plugin source (patch here) |
| `~/.claude/plugins/cache/.../telegram/0.0.4/server.ts` | Runtime copy (overwritten on restart) |
| `PianoidInstall/tools/apply_telegram_patch.py` | Inbox queue patch script |
| `PianoidInstall/tools/transcribe_voice.py` | Voice message transcription |
| `PianoidInstall/.claude/commands/orchestrator.md` | Orchestrator skill |

## Quick Setup Checklist

```
[ ] Install plugin: /install-plugin telegram
[ ] Configure token: /telegram:configure <token>
[ ] DM bot, pair: /telegram:access pair <code>
[ ] Lock policy: /telegram:access policy allowlist
[ ] Apply patch: python tools/apply_telegram_patch.py
[ ] Reload VS Code
[ ] (Optional) Install voice: pip install faster-whisper && python tools/transcribe_voice.py --preload
[ ] Kill zombie bun processes if any: taskkill //F //IM bun.exe
[ ] Verify: send message, check inbox, check reply
[ ] Start orchestrator: /orchestrator start
```
