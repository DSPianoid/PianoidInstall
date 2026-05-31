"""Pre-edit baseline capture for the dev-stest-4a7c regression-test rider.

Renders BaselinePreset1 pitch 60 vel 100 via the existing note_playback flow on
the dev-tip pianoidCuda and saves the resulting `result.sound` channel-0 buffer
as a fingerprint (length + SHA256) and as a .npy ground-truth file. After Phase
B build the same script is run again and the two fingerprints / buffers must
match byte-for-byte.

This proves the new readback hooks (Sint ring, FIR ring, multi-channel
collectAudio fix) do NOT perturb the primary kernel synthesis output — strict
A1 audio_off contract per CLAUDE.md.

Run from PianoidCore/ with the venv interpreter:
  PianoidCore/.venv/Scripts/python ../docs/development/diagnostics/dev-stest-4a7c-regression-baseline.py

Output:
  /tmp/dev-stest-4a7c-baseline.npy           — float64 (samples,) ch0 buffer
  /tmp/dev-stest-4a7c-baseline.json          — {sha256, length, peak, rms}
"""
import hashlib
import json
import os
import sys
import time

import numpy as np

# Make pianoid_middleware importable
HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
MIDDLEWARE = os.path.join(REPO_ROOT, "PianoidCore", "pianoid_middleware")
sys.path.insert(0, MIDDLEWARE)

OUT_NPY = os.environ.get("STEST_BASELINE_NPY", "/tmp/dev-stest-4a7c-baseline.npy")
OUT_JSON = os.environ.get("STEST_BASELINE_JSON", "/tmp/dev-stest-4a7c-baseline.json")
PRESET = os.environ.get(
    "STEST_PRESET",
    # Preset paths resolve relative to MIDDLEWARE (the cwd `initialize` runs in).
    os.path.join("presets", "BaselinePreset1.json"),
)
PITCH = int(os.environ.get("STEST_PITCH", "60"))
VELOCITY = int(os.environ.get("STEST_VELOCITY", "100"))
DURATION_MS = int(os.environ.get("STEST_DURATION_MS", "2000"))


def _build_pianoid():
    # cwd MUST be PianoidCore/pianoid_middleware (preset paths are relative).
    os.chdir(MIDDLEWARE)
    from pianoid import initialize

    pianoid = initialize(
        PRESET,
        filterlen=48 * 128 * 3,
        string_iteration=4,
        array_size=384,
        sample_rate=48000,
        samples_in_cycle=64,
        buffer_size=4,
        max_volume=5e18,
        audio_on=False,
        audio_driver_type=0,
    )
    return pianoid


def _render_note(pianoid):
    import pianoidCuda

    sample_rate = pianoid.mp.sample_rate()
    samples_per_cycle = pianoid.mp.mode_iteration
    cycles_for_duration = int((DURATION_MS / 1000.0) * sample_rate / samples_per_cycle)

    queue = pianoidCuda.EventQueue()
    on = pianoidCuda.PlaybackEvent()
    on.channel = 0
    on.cycle_index = 0
    on.type = pianoidCuda.EventType.NOTE_ON
    on.data = (PITCH << 8) | VELOCITY
    queue.addEvent(on)

    off = pianoidCuda.PlaybackEvent()
    off.channel = 0
    off.cycle_index = cycles_for_duration
    off.type = pianoidCuda.EventType.NOTE_OFF
    off.data = (PITCH << 8) | 0
    queue.addEvent(off)
    queue.sortByCycle()

    config = pianoidCuda.PlaybackConfig()
    config.audio_enabled = False
    config.record_to_buffer = True
    config.max_duration_ms = DURATION_MS + 5000
    config.sample_rate = sample_rate
    config.samples_per_cycle = samples_per_cycle

    with pianoid.cuda_lock:
        pianoid.pianoid.resetStringsState()
        pianoid.pianoid.runSynthesisKernel()
        pianoid.pianoid.clearRecords()
        pianoid.pianoid.runOfflinePlayback(queue, config)
        # NOTE: pre-edit baseline reads only channel 0 via getRecordedAudio,
        # because the existing offline writer is single-channel today.
        raw = np.asarray(pianoid.pianoid.getRecordedAudio(), dtype=np.float64)
    return raw


def main():
    print(f"[baseline] Loading pianoid from preset {PRESET}")
    t0 = time.time()
    pianoid = _build_pianoid()
    print(f"[baseline] pianoid ready in {time.time()-t0:.2f}s")

    print(f"[baseline] Rendering pitch={PITCH} vel={VELOCITY} duration={DURATION_MS}ms")
    audio = _render_note(pianoid)
    print(f"[baseline] Render done — {audio.size} samples")

    sha = hashlib.sha256(audio.tobytes()).hexdigest()
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    rms = float(np.sqrt(np.mean(audio * audio))) if audio.size else 0.0
    meta = {
        "preset": os.path.basename(PRESET),
        "pitch": PITCH,
        "velocity": VELOCITY,
        "duration_ms": DURATION_MS,
        "samples": int(audio.size),
        "dtype": str(audio.dtype),
        "sha256": sha,
        "peak": peak,
        "rms": rms,
    }

    os.makedirs(os.path.dirname(OUT_NPY) or ".", exist_ok=True)
    np.save(OUT_NPY, audio)
    with open(OUT_JSON, "w") as f:
        json.dump(meta, f, indent=2)

    print(json.dumps(meta, indent=2))
    print(f"[baseline] Wrote {OUT_NPY} + {OUT_JSON}")

    # Best-effort cleanup so the baseline run leaves no engine running.
    try:
        pianoid.pianoid.endMainLoop()
    except Exception:
        pass


if __name__ == "__main__":
    main()
