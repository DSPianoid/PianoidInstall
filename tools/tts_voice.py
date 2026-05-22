#!/usr/bin/env python3
"""Text-to-speech helper: text -> Telegram-ready OGG/Opus voice note.

Pipeline:
  1. edge-tts  (Microsoft neural voice)  text -> MP3
  2. ffmpeg    (libopus, mono, 48 kHz)   MP3  -> OGG/Opus

Usage:
  py -3 tts_voice.py "Hello, this is a test."
  py -3 tts_voice.py --voice en-GB-RyanNeural "Some text"
  echo "piped text" | py -3 tts_voice.py
  py -3 tts_voice.py --out C:\\path\\msg.ogg "Custom output path"

On success, prints the absolute path of the produced .ogg as the LAST line
of stdout (so a caller can capture it). Exits non-zero on any failure.
"""

import argparse
import asyncio
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

import edge_tts

DEFAULT_VOICE = "en-US-AriaNeural"

# WinGet installs ffmpeg but the PATH update only applies to new shells.
# Resolve PATH first, then fall back to the known WinGet package location.
_WINGET_FFMPEG = (
    Path.home()
    / "AppData" / "Local" / "Microsoft" / "WinGet" / "Packages"
    / "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
    / "ffmpeg-8.1.1-full_build" / "bin" / "ffmpeg.exe"
)


def resolve_ffmpeg() -> str:
    """Return a usable ffmpeg path, or exit with a clear message."""
    on_path = shutil.which("ffmpeg")
    if on_path:
        return on_path
    if _WINGET_FFMPEG.is_file():
        return str(_WINGET_FFMPEG)
    # Last resort: scan the WinGet Packages tree for any ffmpeg.exe.
    pkg_root = Path.home() / "AppData" / "Local" / "Microsoft" / "WinGet" / "Packages"
    if pkg_root.is_dir():
        for cand in pkg_root.rglob("ffmpeg.exe"):
            return str(cand)
    sys.exit("ERROR: ffmpeg not found on PATH or in the WinGet package dir.")


async def synth_mp3(text: str, voice: str, mp3_path: Path) -> None:
    """Render text to an MP3 file via edge-tts."""
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(str(mp3_path))


def convert_to_ogg(ffmpeg: str, mp3_path: Path, ogg_path: Path) -> None:
    """Convert MP3 to OGG/Opus suitable for a Telegram voice note."""
    cmd = [
        ffmpeg, "-y",
        "-i", str(mp3_path),
        "-c:a", "libopus",
        "-b:a", "32k",
        "-ar", "48000",
        "-ac", "1",
        "-application", "voip",
        str(ogg_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        sys.exit(f"ERROR: ffmpeg conversion failed (exit {proc.returncode}).")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert text to a Telegram-ready OGG/Opus voice note."
    )
    parser.add_argument(
        "text", nargs="?",
        help="Text to speak. If omitted, text is read from stdin.",
    )
    parser.add_argument(
        "--voice", default=DEFAULT_VOICE,
        help=f"edge-tts voice name (default: {DEFAULT_VOICE}).",
    )
    parser.add_argument(
        "--out", default=None,
        help="Output .ogg path. Default: a unique file in the temp dir.",
    )
    args = parser.parse_args()

    text = args.text if args.text is not None else sys.stdin.read()
    text = (text or "").strip()
    if not text:
        sys.exit("ERROR: no text provided (empty argument and empty stdin).")

    if args.out:
        ogg_path = Path(args.out).expanduser().resolve()
        ogg_path.parent.mkdir(parents=True, exist_ok=True)
    else:
        ogg_path = Path(tempfile.gettempdir()) / f"tts_voice_{uuid.uuid4().hex}.ogg"

    ffmpeg = resolve_ffmpeg()

    with tempfile.TemporaryDirectory() as tmp:
        mp3_path = Path(tmp) / "tts.mp3"
        asyncio.run(synth_mp3(text, args.voice, mp3_path))
        if not mp3_path.is_file() or mp3_path.stat().st_size == 0:
            sys.exit("ERROR: edge-tts produced no audio (empty MP3).")
        convert_to_ogg(ffmpeg, mp3_path, ogg_path)

    if not ogg_path.is_file() or ogg_path.stat().st_size == 0:
        sys.exit("ERROR: output OGG missing or empty after conversion.")

    print(str(ogg_path))


if __name__ == "__main__":
    main()
