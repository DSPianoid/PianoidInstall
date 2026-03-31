#!/usr/bin/env python3
"""
Transcribe a Telegram voice message (OGG/OPUS) to text using faster-whisper.

Usage:
    python transcribe_voice.py <path-to-ogg-file>
    python transcribe_voice.py --preload       # Pre-download model, exit

Prints the transcribed text to stdout. Errors go to stderr.

Model: "small" (~500MB download on first run, ~2GB VRAM)
Device: CUDA if available, else CPU.
"""

import sys
import os
import time

# Suppress noisy library logging
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

MODEL_SIZE = "small"
COMPUTE_TYPE = "float16"  # float16 for CUDA, int8 for CPU


def get_device():
    """Detect CUDA availability."""
    try:
        import ctranslate2
        supported = ctranslate2.get_supported_compute_types("cuda")
        if supported:  # non-empty set means CUDA works
            return "cuda", COMPUTE_TYPE
    except Exception:
        pass
    return "cpu", "int8"


def transcribe(file_path: str) -> str:
    """Transcribe an audio file to text."""
    from faster_whisper import WhisperModel

    device, compute = get_device()
    model = WhisperModel(MODEL_SIZE, device=device, compute_type=compute)

    segments, info = model.transcribe(
        file_path,
        beam_size=5,
        vad_filter=True,  # skip silence
    )

    text = " ".join(seg.text.strip() for seg in segments)
    return text.strip()


def main():
    if len(sys.argv) < 2:
        print("Usage: python transcribe_voice.py <audio-file>", file=sys.stderr)
        sys.exit(1)

    if sys.argv[1] == "--preload":
        print("Pre-downloading model...", file=sys.stderr)
        from faster_whisper import WhisperModel
        device, compute = get_device()
        WhisperModel(MODEL_SIZE, device=device, compute_type=compute)
        print(f"Model '{MODEL_SIZE}' ready on {device}.", file=sys.stderr)
        sys.exit(0)

    file_path = sys.argv[1]
    if not os.path.isfile(file_path):
        print(f"File not found: {file_path}", file=sys.stderr)
        sys.exit(1)

    t0 = time.time()
    text = transcribe(file_path)
    elapsed = time.time() - t0

    print(text)
    print(f"[{elapsed:.1f}s, {MODEL_SIZE}]", file=sys.stderr)


if __name__ == "__main__":
    main()
