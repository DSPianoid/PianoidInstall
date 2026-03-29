# Telegram Channel Setup

Connect a Telegram bot to Claude Code so you can send tasks and receive results remotely.

## Prerequisites

| Requirement | Notes |
|---|---|
| Claude Code | v2.1+ with plugin support |
| Bun runtime | Telegram plugin runs on Bun |
| Telegram bot token | Create via [@BotFather](https://t.me/BotFather) |
| Your Telegram user ID | Get from [@userinfobot](https://t.me/userinfobot) |

## Step 1: Install the Telegram Plugin

In Claude Code, install the official Telegram plugin:

```
/install-plugin telegram
```

Or, if using VS Code extension, go to the plugins marketplace and install "Telegram".

The plugin files land in:
- **Marketplace:** `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram/`
- **Cache (runtime copy):** `~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.4/`

On restart, the cache is overwritten from the marketplace copy.

## Step 2: Configure the Bot Token

Run the configure skill in Claude Code:

```
/telegram:configure <your-bot-token>
```

This writes the token to `~/.claude/channels/telegram/.env`:

```
TELEGRAM_BOT_TOKEN=123456789:AAH...
```

Restart the session or reload plugins for the token to take effect.

## Step 3: Pair Your Telegram Account

1. DM your bot on Telegram — it replies with a pairing code
2. In Claude Code, approve the pairing:
   ```
   /telegram:access pair <code>
   ```
3. Lock down the access policy:
   ```
   /telegram:access policy allowlist
   ```

This writes `~/.claude/channels/telegram/access.json`:

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["<your-user-id>"],
  "groups": {},
  "pending": {}
}
```

## Step 4: Apply the Inbox Queue Patch

The official plugin delivers messages via MCP notifications, which can be silently dropped when the session is busy. The inbox queue patch writes every inbound message to a JSON file as a backup.

Apply the patch:

```bash
cd ~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram
# Windows (Git Bash)
git apply /path/to/PianoidInstall/tools/telegram-inbox-queue.patch
```

Or run the patch script:

```bash
python /path/to/PianoidInstall/tools/apply_telegram_patch.py
```

After patching, reload Claude Code (VS Code: `Ctrl+Shift+P` > "Developer: Reload Window").

### What the Patch Does

Inserts code in the `handleInbound` function (around line 921 of `server.ts`) that:

1. Builds a `msgMeta` object with chat_id, message_id, username, timestamp, and attachment info
2. Writes it as JSON to `~/.claude/channels/telegram/inbox/msg-{timestamp}-{msgId}.json`
3. The existing `mcp.notification()` call continues unchanged

Messages are backed up to disk before the MCP notification is attempted.

## Step 5: Verify

1. Send a message to your bot from Telegram
2. Check that it appears in the Claude Code conversation
3. Check that a file was created in `~/.claude/channels/telegram/inbox/`
4. Reply from Claude Code to confirm two-way communication

## Known Issues (Windows)

### Zombie Bun Processes

Claude Code on Windows does not reliably terminate plugin processes when sessions end or VS Code reloads. This leaves zombie `bun` processes that compete for Telegram `getUpdates`, stealing messages.

**Diagnosis:**

```bash
tasklist | grep -i bun
```

Each session spawns 2 bun processes (parent + child). If you see more than 2, you have zombies.

**Fix:**

```bash
taskkill //F //IM bun.exe
```

Then reload VS Code to spawn a fresh pair.

**Root cause:** Claude Code doesn't close the stdio pipe or send SIGTERM on Windows when a conversation tab closes. The plugin has proper shutdown handlers (`process.stdin.on('end')`) but they never fire. This is a Claude Code platform bug.

## File Locations

| File | Purpose |
|---|---|
| `~/.claude/channels/telegram/.env` | Bot token |
| `~/.claude/channels/telegram/access.json` | Access policy and allowlist |
| `~/.claude/channels/telegram/inbox/` | Backup message queue (patch) |
| `~/.claude/plugins/marketplaces/.../telegram/server.ts` | Plugin source (patch here) |
| `~/.claude/plugins/cache/.../telegram/0.0.4/server.ts` | Runtime copy (overwritten on restart) |
