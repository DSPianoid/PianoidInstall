# Telegram Channel Setup

Connect a Telegram bot to Claude Code so you can send tasks and receive results remotely.

## Prerequisites

| Requirement | Notes |
|---|---|
| Claude Code | v2.1+ with plugin support |
| Bun runtime | Telegram plugin runs on Bun — **must be on PATH** (see note below) |
| Telegram bot token | Create via [@BotFather](https://t.me/BotFather) |
| Your Telegram user ID | Get from [@userinfobot](https://t.me/userinfobot) |

## Bun PATH Setup (Windows)

The Telegram MCP server invokes `bun` by name, so Bun must be on your system PATH. The default Bun installer places the binary at `~/.bun/bin/bun` but does **not** always add it to PATH — especially on Windows.

**Check if Bun is on PATH:**

```bash
bun --version
```

If this fails but `~/.bun/bin/bun --version` works, Bun is installed but not on PATH.

**Add to PATH permanently (PowerShell):**

```powershell
[Environment]::SetEnvironmentVariable('PATH', [Environment]::GetEnvironmentVariable('PATH', 'User') + ';' + $env:USERPROFILE + '\.bun\bin', 'User')
```

**Restart your terminal** after this — the updated PATH is not picked up by the current session. Without Bun on PATH, the Telegram MCP server will silently fail to start and no messages will be received.

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

### Missing Plugin Dependencies (node_modules)

**Symptom:** Bun is on PATH, bot token is configured, `access.json` exists — but the `mcp__plugin_telegram_telegram__reply` tool never appears. No error is shown. Messages sent to the bot are queued in `inbox/` but never processed by the session.

**Cause:** The plugin's `package.json` start script runs `bun install --no-summary && bun server.ts`. On first install (or after a cache wipe), `bun install` may fail silently — e.g., due to a network issue or permissions — leaving the `node_modules/` directory empty. Without `grammy` and `@modelcontextprotocol/sdk`, the server crashes immediately on startup. Claude Code does not surface plugin startup errors.

**Diagnosis:**

```bash
ls ~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.4/node_modules/
```

If this directory is empty or missing, dependencies were never installed.

**Fix:**

```bash
cd ~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.4
bun install
```

Then reload VS Code (`Ctrl+Shift+P` > "Developer: Reload Window"). The plugin will start successfully on the next session.

**Note:** The cache directory is overwritten from the marketplace copy on restart. If the marketplace copy also lacks `node_modules`, the problem will recur. To fix permanently, also install in the marketplace copy:

```bash
cd ~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram
bun install
```

### Bun Not on PATH

**Symptom:** Claude Code launches with `--channels` but no messages arrive. No `bun` process visible in `tasklist`. No error is shown — the MCP server silently fails to start.

**Cause:** Bun is installed at `~/.bun/bin/bun` but not on the system PATH. The MCP config calls `bun` without a full path.

**Fix:** See [Bun PATH Setup](#bun-path-setup-windows) above.

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
