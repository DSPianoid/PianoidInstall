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
- **Marketplace (durable, version-less):** `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram/`
- **Cache (runtime copy, versioned):** `~/.claude/plugins/cache/claude-plugins-official/telegram/<ver>/` (`<ver>` is the installed plugin version, e.g. `0.0.6`)

On restart, the cache is rebuilt from the marketplace copy. **This is why all patches must target the marketplace copy** — a patch applied only to the versioned cache silently reverts on the next restart.

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

## Voice I/O Setup (optional)

The orchestrator supports **two-way voice** on top of the text channel:

- **STT (speech-to-text):** transcribe inbound Telegram voice notes so you can dictate tasks.
- **TTS (text-to-speech):** send replies back as Telegram voice notes.

Both are optional — the text channel works without them. Set up STT and TTS independently.

### STT — Transcribe Inbound Voice

When a `<channel>` message carries `attachment_kind="voice"`, the orchestrator downloads the
`.ogg` and transcribes it via `tools/transcribe_voice.py` (uses `faster-whisper`, `small`
model, CUDA). The transcript prints to stdout.

**Install** (into the project venv, same interpreter the orchestrator tools use):

```bash
# From the repo root
PianoidCore/.venv/Scripts/pip install -r tools/requirements-orchestrator.txt   # Windows
PianoidCore/.venv/bin/pip install -r tools/requirements-orchestrator.txt       # Linux
```

`faster-whisper` is pinned in `tools/requirements-orchestrator.txt`. The `small` Whisper model
(~480 MB) auto-downloads to the HuggingFace cache on first transcription — no manual download.
If a venv rebuild drops the package, re-run the install above.

**Run** (the orchestrator skill's "Voice Message Detection" flow already wires this in):

```bash
PianoidCore/.venv/Scripts/python tools/transcribe_voice.py "<abs-path-to.ogg>"   # Windows
PianoidCore/.venv/bin/python      tools/transcribe_voice.py "<abs-path-to.ogg>"  # Linux
```

### TTS — Send Voice Notes

Generate speech with `tools/tts_voice.py` (edge-tts → MP3 → ffmpeg → OGG/Opus), then attach
the produced `.ogg` to a reply. The plugin's voice patch (below) makes Telegram render it as a
playable voice note rather than a document.

**Install dependencies:**

```bash
# edge-tts (Microsoft neural voices) — into the project venv
PianoidCore/.venv/Scripts/pip install edge-tts          # Windows
PianoidCore/.venv/bin/pip install edge-tts              # Linux

# ffmpeg (Opus encoder) — Windows via WinGet; tts_voice.py also auto-resolves the WinGet path
winget install Gyan.FFmpeg                               # Windows
sudo apt install ffmpeg                                  # Linux
```

**The helper** lives at `tools/tts_voice.py` (beside `transcribe_voice.py` — the repo is the
canonical source). It prints the absolute path of the produced `.ogg` as the last line of
stdout:

```bash
py -3 tools/tts_voice.py "Hello, this is a test."
py -3 tools/tts_voice.py --voice en-GB-RyanNeural "Some text"
echo "piped text" | py -3 tools/tts_voice.py
```

The orchestrator captures that path and sends it via `reply(files:["<...>.ogg"])`.

### Apply the Voice Patch (sendVoice)

By default the plugin sends every non-image file as a *document*. The voice patch teaches the
file-send handler to send `.ogg`/`.oga`/`.opus` files as Telegram **voice notes** via
`bot.api.sendVoice`. Like the inbox-queue patch, it must target the **marketplace** copy so it
survives cache rebuilds.

Apply the patch:

```bash
python tools/apply_telegram_voice_patch.py
```

Confirm it landed:

```bash
python tools/apply_telegram_voice_patch.py --check    # prints "APPLIED", exits 0
```

The applier is idempotent (re-running is a no-op), backs up the marketplace `server.ts` to
`server.ts.bak` before the first apply, and verifies both hunks landed before writing. The raw
diff is mirrored at `tools/server.ts.voicepatch.diff` for reference.

After patching, reload Claude Code (VS Code: `Ctrl+Shift+P` > "Developer: Reload Window").

> **Re-apply after every plugin update.** A Telegram plugin update overwrites the marketplace
> `server.ts` with the upstream (unpatched) version. Re-run `python
> tools/apply_telegram_voice_patch.py` (and `tools/apply_telegram_patch.py` for the inbox
> queue) after any plugin update. Both are idempotent, so re-running when already patched is
> harmless.

## Known Issues (Windows)

### Missing Plugin Dependencies (node_modules)

**Symptom:** Bun is on PATH, bot token is configured, `access.json` exists — but the `mcp__plugin_telegram_telegram__reply` tool never appears. No error is shown. Messages sent to the bot are queued in `inbox/` but never processed by the session.

**Cause:** The plugin's `package.json` start script runs `bun install --no-summary && bun server.ts`. On first install (or after a cache wipe), `bun install` may fail silently — e.g., due to a network issue or permissions — leaving the `node_modules/` directory empty. Without `grammy` and `@modelcontextprotocol/sdk`, the server crashes immediately on startup. Claude Code does not surface plugin startup errors.

**Diagnosis:**

```bash
ls ~/.claude/plugins/cache/claude-plugins-official/telegram/<ver>/node_modules/
```

(`<ver>` is the installed plugin version directory — e.g. `0.0.6`.) If this directory is empty or missing, dependencies were never installed.

**Fix:**

```bash
cd ~/.claude/plugins/cache/claude-plugins-official/telegram/<ver>
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
| `~/.claude/channels/telegram/inbox/` | Backup message queue (inbox patch) |
| `~/.claude/plugins/marketplaces/.../telegram/server.ts` | Plugin source — **patch target** (durable, version-less) |
| `~/.claude/plugins/marketplaces/.../telegram/server.ts.bak` | Backup of the marketplace source (created by the voice applier before first apply) |
| `~/.claude/plugins/cache/.../telegram/<ver>/server.ts` | Runtime copy (rebuilt from marketplace on restart; `<ver>` e.g. `0.0.6`) |
| `tools/apply_telegram_patch.py` | Applies the inbox-queue patch to the marketplace `server.ts` (idempotent, `--check`) |
| `tools/apply_telegram_voice_patch.py` | Applies the voice-note (`sendVoice`) patch to the marketplace `server.ts` (idempotent, `--check`) |
| `tools/server.ts.voicepatch.diff` | Reference raw diff for the voice patch |
| `tools/tts_voice.py` | TTS helper — text → OGG/Opus voice note (edge-tts + ffmpeg) |
| `tools/transcribe_voice.py` | STT helper — inbound voice `.ogg` → transcript (faster-whisper) |
| `tools/requirements-orchestrator.txt` | Pinned orchestrator deps (incl. `faster-whisper` for STT) |
