#!/usr/bin/env python3
"""Apply the voice-note (sendVoice) patch to the Telegram plugin's server.ts.

Patches the marketplace copy so it survives cache rebuilds on restart. The
plugin cache is rebuilt from the marketplace copy on every Claude Code restart,
so a patch applied only to the cache silently reverts. This applier targets the
version-less marketplace source instead — the durable fix.

The patch teaches the file-send handler to send .ogg/.oga/.opus files as
Telegram *voice notes* (playable waveform bubble) via `bot.api.sendVoice`,
rather than as plain documents. This is what makes the orchestrator's TTS
output (see tools/tts_voice.py) render as a true voice note.

Companion to tools/apply_telegram_patch.py (the inbox-queue patch), which uses
the same marker-check + string-anchor + idempotent pattern. The raw patch is
mirrored in tools/server.ts.voicepatch.diff for reference.

Usage:
    python apply_telegram_voice_patch.py [--check]

    --check   Print whether the patch is already applied, don't modify anything.
              Exit 0 if applied, exit 1 if not.

Safety:
    - Idempotent: re-running after a successful apply is a no-op (marker-guarded).
    - Backs up the marketplace server.ts to server.ts.bak before the first apply.
    - Verifies both patch hunks landed (anchors matched) before declaring success.
    - Does NOT touch the volatile cache copy (voice already works there; the
      marketplace patch takes effect on the next Claude Code reload).

Re-run this after every Telegram plugin update — an update overwrites the
marketplace server.ts with the upstream (unpatched) version.
"""

import sys
from pathlib import Path

MARKETPLACE_PATH = (
    Path.home()
    / ".claude/plugins/marketplaces/claude-plugins-official"
    / "external_plugins/telegram/server.ts"
)

BACKUP_PATH = MARKETPLACE_PATH.with_name("server.ts.bak")

# The marker we search for to determine if the patch is already applied.
# VOICE_EXTS is the token unique to this patch.
PATCH_MARKER = "VOICE_EXTS"

# --- Patch content (mirrors tools/server.ts.voicepatch.diff) ---

# Hunk 1a: a comment line inserted between the two existing comment lines that
# describe how files are routed (photos vs documents).
OLD_COMMENT = (
    "// .jpg/.jpeg/.png/.gif/.webp go as photos (Telegram compresses + shows inline);\n"
    "// everything else goes as documents (raw file, no compression)."
)
NEW_COMMENT = (
    "// .jpg/.jpeg/.png/.gif/.webp go as photos (Telegram compresses + shows inline);\n"
    "// .ogg/.oga/.opus go as voice notes (playable waveform bubble);\n"
    "// everything else goes as documents (raw file, no compression)."
)

# Hunk 1b: the VOICE_EXTS Set, inserted right after the PHOTO_EXTS Set.
OLD_PHOTO_EXTS = "const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])"
NEW_PHOTO_EXTS = (
    "const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])\n"
    "const VOICE_EXTS = new Set(['.ogg', '.oga', '.opus'])"
)

# Hunk 2: the sendVoice branch, inserted between the PHOTO_EXTS branch and the
# sendDocument `else`. The sendDocument line is included in the match to keep
# the anchor unique (a bare `} else {` appears elsewhere in the file).
OLD_SEND_BRANCH = (
    "          } else {\n"
    "            const sent = await bot.api.sendDocument(chat_id, input, opts)"
)
NEW_SEND_BRANCH = (
    "          } else if (VOICE_EXTS.has(ext)) {\n"
    "            const sent = await bot.api.sendVoice(chat_id, input, opts)\n"
    "            sentIds.push(sent.message_id)\n"
    "          } else {\n"
    "            const sent = await bot.api.sendDocument(chat_id, input, opts)"
)


def main():
    check_only = "--check" in sys.argv

    if not MARKETPLACE_PATH.exists():
        print(f"ERROR: Plugin not found at {MARKETPLACE_PATH}")
        print("Install the Telegram plugin first: /install-plugin telegram")
        sys.exit(1)

    content = MARKETPLACE_PATH.read_text(encoding="utf-8")

    if PATCH_MARKER in content:
        print("Voice patch is already applied (APPLIED).")
        sys.exit(0)

    if check_only:
        print("Voice patch is NOT applied.")
        sys.exit(1)

    # Verify both anchors are present before touching anything — fail fast if
    # the upstream file changed shape (don't corrupt the orchestrator's
    # Telegram lifeline).
    if OLD_PHOTO_EXTS not in content:
        print(f"ERROR: Cannot find anchor: {OLD_PHOTO_EXTS!r}")
        print("The marketplace server.ts may have changed shape; aborting (no edits made).")
        sys.exit(1)
    if OLD_SEND_BRANCH not in content:
        print("ERROR: Cannot find the sendDocument-else anchor for the sendVoice branch.")
        print("The marketplace server.ts may have changed shape; aborting (no edits made).")
        sys.exit(1)

    # Back up the original before the first apply (revertible).
    if not BACKUP_PATH.exists():
        BACKUP_PATH.write_text(content, encoding="utf-8")
        print(f"  Backed up original to {BACKUP_PATH}")

    # Hunk 1a: routing comment (optional — only if the exact comment pair is
    # present; a divergent comment is non-fatal, the functional hunks below
    # are what matter).
    if OLD_COMMENT in content:
        content = content.replace(OLD_COMMENT, NEW_COMMENT)
        print("  Added .ogg/.oga/.opus routing comment")

    # Hunk 1b: VOICE_EXTS Set.
    content = content.replace(OLD_PHOTO_EXTS, NEW_PHOTO_EXTS)
    print("  Added VOICE_EXTS constant")

    # Hunk 2: sendVoice branch.
    content = content.replace(OLD_SEND_BRANCH, NEW_SEND_BRANCH)
    print("  Inserted sendVoice branch")

    # Post-patch sanity check: both functional markers must now be present,
    # and the file must still contain its surrounding anchors intact.
    if "VOICE_EXTS" not in content or "bot.api.sendVoice" not in content:
        print("ERROR: Post-patch verification failed — markers missing after edit.")
        print(f"Restore from {BACKUP_PATH} and investigate; NOT writing the patched file.")
        sys.exit(1)
    if "bot.api.sendDocument" not in content or "bot.api.sendPhoto" not in content:
        print("ERROR: Post-patch verification failed — original send branches lost.")
        print(f"Restore from {BACKUP_PATH} and investigate; NOT writing the patched file.")
        sys.exit(1)

    # Write back.
    MARKETPLACE_PATH.write_text(content, encoding="utf-8")
    print(f"\nVoice patch applied to {MARKETPLACE_PATH}")
    print("Reload Claude Code for changes to take effect.")


if __name__ == "__main__":
    main()
