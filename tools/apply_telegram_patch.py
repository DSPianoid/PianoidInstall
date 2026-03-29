#!/usr/bin/env python3
"""
Apply the inbox queue patch to the Telegram plugin's server.ts.

Patches the marketplace copy so it survives cache rebuilds on restart.
Run after installing the Telegram plugin for the first time.

Usage:
    python apply_telegram_patch.py [--check]

    --check   Print whether the patch is already applied, don't modify anything.
"""

import sys
import os
from pathlib import Path

MARKETPLACE_PATH = (
    Path.home()
    / ".claude/plugins/marketplaces/claude-plugins-official"
    / "external_plugins/telegram/server.ts"
)

# The marker we search for to determine if the patch is already applied
PATCH_MARKER = "msg-${Date.now()}-${msgId"

# --- Patch content ---
# This block is inserted right after the `downloadImage` call and before
# the `mcp.notification()` call in the handleInbound function.
# It writes every inbound message to a JSON file in INBOX_DIR as a backup.

ANCHOR_LINE = "const imagePath = downloadImage ? await downloadImage() : undefined"

PATCH_BLOCK = r"""
  // Write inbound message to file queue as backup delivery path.
  // Claude can poll INBOX_DIR/msg-*.json to recover messages that the
  // MCP notification didn't deliver (e.g. session was busy).
  const msgMeta = {
    chat_id,
    ...(msgId != null ? { message_id: String(msgId) } : {}),
    user: from.username ?? String(from.id),
    user_id: String(from.id),
    ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
    ...(imagePath ? { image_path: imagePath } : {}),
    ...(attachment ? {
      attachment_kind: attachment.kind,
      attachment_file_id: attachment.file_id,
      ...(attachment.size != null ? { attachment_size: String(attachment.size) } : {}),
      ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
      ...(attachment.name ? { attachment_name: attachment.name } : {}),
    } : {}),
  }
  try {
    mkdirSync(INBOX_DIR, { recursive: true })
    const queueFile = join(INBOX_DIR, `msg-${Date.now()}-${msgId ?? '0'}.json`)
    writeFileSync(queueFile, JSON.stringify({ content: text, meta: msgMeta }) + '\n')
  } catch (e) {
    process.stderr.write(`telegram channel: failed to write inbox queue: ${e}\n`)
  }
"""

# The original notification block starts with building meta inline.
# We replace it so it uses the msgMeta variable instead.
OLD_NOTIFICATION = """  // image_path goes in meta only — an in-content "[image attached — read: PATH]"
  // annotation is forgeable by any allowlisted sender typing that string.
  mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text,
      meta: {
        chat_id,
        ...(msgId != null ? { message_id: String(msgId) } : {}),
        user: from.username ?? String(from.id),
        user_id: String(from.id),
        ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
        ...(imagePath ? { image_path: imagePath } : {}),
        ...(attachment ? {
          attachment_kind: attachment.kind,
          attachment_file_id: attachment.file_id,
          ...(attachment.size != null ? { attachment_size: String(attachment.size) } : {}),
          ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
          ...(attachment.name ? { attachment_name: attachment.name } : {}),
        } : {}),
      },
    },
  }).catch(err => {
    process.stderr.write(`telegram channel: failed to deliver inbound to Claude: ${err}\\n`)
  })"""

NEW_NOTIFICATION = """  // image_path goes in meta only — an in-content "[image attached — read: PATH]"
  // annotation is forgeable by any allowlisted sender typing that string.
  mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text,
      meta: msgMeta,
    },
  }).catch(err => {
    process.stderr.write(`telegram channel: failed to deliver inbound to Claude: ${err}\\n`)
  })"""

# We also need to ensure INBOX_DIR is defined near the top of the file.
INBOX_DIR_LINE = "const INBOX_DIR = join(STATE_DIR, 'inbox')"
INBOX_DIR_ANCHOR = "const ENV_FILE = join(STATE_DIR, '.env')"


def main():
    check_only = "--check" in sys.argv

    if not MARKETPLACE_PATH.exists():
        print(f"ERROR: Plugin not found at {MARKETPLACE_PATH}")
        print("Install the Telegram plugin first: /install-plugin telegram")
        sys.exit(1)

    content = MARKETPLACE_PATH.read_text(encoding="utf-8")

    if PATCH_MARKER in content:
        print("Patch is already applied.")
        sys.exit(0)

    if check_only:
        print("Patch is NOT applied.")
        sys.exit(1)

    # Step 1: Add INBOX_DIR constant if missing
    if INBOX_DIR_LINE not in content:
        if INBOX_DIR_ANCHOR not in content:
            print(f"ERROR: Cannot find anchor line: {INBOX_DIR_ANCHOR}")
            sys.exit(1)
        content = content.replace(
            INBOX_DIR_ANCHOR,
            INBOX_DIR_ANCHOR + "\n" + INBOX_DIR_LINE,
        )
        print("  Added INBOX_DIR constant")

    # Step 2: Insert the file-queue block after the downloadImage line
    if ANCHOR_LINE not in content:
        print(f"ERROR: Cannot find anchor line: {ANCHOR_LINE}")
        sys.exit(1)

    content = content.replace(
        ANCHOR_LINE,
        ANCHOR_LINE + "\n" + PATCH_BLOCK,
    )
    print("  Inserted inbox queue write block")

    # Step 3: Replace inline meta in mcp.notification with msgMeta reference
    if OLD_NOTIFICATION in content:
        content = content.replace(OLD_NOTIFICATION, NEW_NOTIFICATION)
        print("  Replaced inline meta with msgMeta reference")
    else:
        print("  WARNING: Could not find original notification block to simplify.")
        print("           The patch block was inserted but notification still uses inline meta.")

    # Write back
    MARKETPLACE_PATH.write_text(content, encoding="utf-8")
    print(f"\nPatch applied to {MARKETPLACE_PATH}")
    print("Reload Claude Code for changes to take effect.")


if __name__ == "__main__":
    main()
