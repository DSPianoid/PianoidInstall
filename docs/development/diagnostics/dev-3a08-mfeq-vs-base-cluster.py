"""
dev-3a08 — Option A measurement.

Render `note_playback`-style offline buffers for pitches 53-60 on
`Belarus_8band_196modes.json` (base) and `Belarus_8band_196modes-MFeq.json`
(user variant), in-process, on the currently-installed release pianoidCuda
.pyd. Report per-pitch peak / RMS / per-window energy so I can isolate
whether the user's pitch-57 near-silence is explained by preset data alone
(no code regression).

Runs in-process — no backend / no frontend / no HTTP. Stack should be down
before invocation. Uses the proven `pianoid.initialize(...)` factory.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import numpy as np

REPO = Path("D:/repos/PianoidInstall/PianoidCore")
MIDDLEWARE = REPO / "pianoid_middleware"
PRESETS = MIDDLEWARE / "presets"

sys.path.insert(0, str(MIDDLEWARE))
os.chdir(MIDDLEWARE)

# Mirror conftest.pianoid_audio_off constants. SAMPLE_RATE is in Hz
# (the conftest's `SAMPLE_RATE = 48000`). `mp.sr` consumes it raw — using
# 48 (kHz) collapses NOTE_OFF onto NOTE_ON and renders 0 cycles.
SAMPLE_RATE = 48000
SAMPLES_PER_CYCLE = 64


def measure_preset(preset_path: Path, pitches: list[int], dur_ms: int = 600,
                   tail_ms: int = 600, velocity: int = 100) -> dict:
    """Use pianoid.initialize() (the conftest path); render each pitch offline."""
    print(f"\n=== Loading {preset_path.name} ===", flush=True)
    from pianoid import initialize

    p = initialize(
        str(preset_path),
        filterlen=48 * 128 * 3,
        string_iteration=4,
        array_size=384,
        sample_rate=SAMPLE_RATE,
        samples_in_cycle=SAMPLES_PER_CYCLE,
        buffer_size=4,
        max_volume=5e18,
        audio_on=False,
        audio_driver_type=0,
        use_debug_build=False,
    )

    import pianoidCuda
    from chartFunctions import _load_offline_sound_to_result

    sr_hz = p.mp.sample_rate()
    spc = p.mp.mode_iteration
    cycles_dur = int((dur_ms / 1000.0) * sr_hz / spc)
    cycles_tail = int((tail_ms / 1000.0) * sr_hz / spc)
    print(f"  sr={sr_hz} Hz, samples/cycle={spc}, dur_cycles={cycles_dur}, "
          f"tail_cycles={cycles_tail}", flush=True)

    rows: dict[int, dict] = {}
    for pitch in pitches:
        available = p.get_all_pitches_in_preset(convert_to_notes=False)
        if pitch not in available:
            print(f"  pitch {pitch}: NOT IN PRESET, skipping", flush=True)
            continue

        eq = pianoidCuda.EventQueue()
        on = pianoidCuda.PlaybackEvent()
        on.channel = 0
        on.cycle_index = 0
        on.type = pianoidCuda.EventType.NOTE_ON
        on.data = (pitch << 8) | velocity
        eq.addEvent(on)

        off = pianoidCuda.PlaybackEvent()
        off.channel = 0
        off.cycle_index = cycles_dur
        off.type = pianoidCuda.EventType.NOTE_OFF
        off.data = (pitch << 8) | 0
        eq.addEvent(off)
        eq.sortByCycle()

        cfg = pianoidCuda.PlaybackConfig()
        cfg.audio_enabled = False
        cfg.record_to_buffer = True
        cfg.max_duration_ms = dur_ms + tail_ms + 100
        cfg.sample_rate = sr_hz
        cfg.samples_per_cycle = spc

        with p.cuda_lock:
            p.pianoid.resetStringsState()
            p.pianoid.runSynthesisKernel()
            p.pianoid.clearRecords()

            t0 = time.time()
            stats = p.pianoid.runOfflinePlayback(eq, cfg)
            elapsed = time.time() - t0

            _load_offline_sound_to_result(p)
            sound = p.result.get_sound(channel=0)

        snd = np.asarray(sound, dtype=np.float64)
        attack_n = int(0.200 * sr_hz)
        sustain_a = int(0.200 * sr_hz)
        sustain_b = int(dur_ms / 1000.0 * sr_hz)
        post_a = sustain_b
        post_b = min(len(snd), int((dur_ms + tail_ms) / 1000.0 * sr_hz))

        def stats_of(seg: np.ndarray) -> tuple[float, float]:
            if seg.size == 0:
                return 0.0, 0.0
            return float(np.max(np.abs(seg))), float(np.sqrt(np.mean(seg * seg)))

        pk_all, rms_all = stats_of(snd)
        pk_att, rms_att = stats_of(snd[:attack_n])
        pk_sus, rms_sus = stats_of(snd[sustain_a:sustain_b])
        pk_pst, rms_pst = stats_of(snd[post_a:post_b])

        rows[pitch] = dict(
            len=len(snd), elapsed_s=elapsed, total_cycles=stats.total_cycles,
            pk_all=pk_all, rms_all=rms_all,
            pk_att=pk_att, rms_att=rms_att,
            pk_sus=pk_sus, rms_sus=rms_sus,
            pk_pst=pk_pst, rms_pst=rms_pst,
        )
        print(f"  pitch {pitch:3d}: pk={pk_all:11.4e} rms_all={rms_all:11.4e} "
              f"att={rms_att:11.4e} sus={rms_sus:11.4e} post={rms_pst:11.4e} "
              f"(t={elapsed:.3f}s)", flush=True)

    try:
        p.pianoid.shutdownGpu()
    except Exception as e:
        print(f"  (shutdown warning: {e})", flush=True)

    return rows


def main() -> int:
    pitches = list(range(53, 61))
    presets = {
        "base": PRESETS / "Belarus_8band_196modes.json",
        "MFeq": PRESETS / "Belarus_8band_196modes-MFeq.json",
    }

    print(f"### dev-3a08 Option-A measurement ###", flush=True)
    print(f"  cwd: {os.getcwd()}", flush=True)
    import pianoidCuda
    pyd_path = pianoidCuda.__file__
    pyd_mtime = time.ctime(os.path.getmtime(pyd_path))
    print(f"  pianoidCuda from: {pyd_path}", flush=True)
    print(f"  pianoidCuda mtime: {pyd_mtime}", flush=True)

    results: dict[str, dict] = {}
    for tag, path in presets.items():
        results[tag] = measure_preset(path, pitches)
        print(f"=== {tag} DONE ===\n", flush=True)

    print("### SUMMARY ###", flush=True)
    print(f"  pyd: {pyd_path}", flush=True)
    print(f"  pyd_mtime: {pyd_mtime}\n", flush=True)
    print(f"{'pitch':>5}  "
          f"{'base_rms_all':>12} {'base_rms_sus':>12} {'base_pk':>10}  "
          f"{'MFeq_rms_all':>12} {'MFeq_rms_sus':>12} {'MFeq_pk':>10}  "
          f"{'MFeq/base_sus':>13}", flush=True)
    for pitch in pitches:
        b = results.get("base", {}).get(pitch)
        m = results.get("MFeq", {}).get(pitch)
        if not b or not m:
            print(f"{pitch:>5}  ---", flush=True)
            continue
        ratio = (m["rms_sus"] / b["rms_sus"]) if b["rms_sus"] else float("inf")
        print(f"{pitch:>5}  "
              f"{b['rms_all']:>12.4e} {b['rms_sus']:>12.4e} {b['pk_all']:>10.4e}  "
              f"{m['rms_all']:>12.4e} {m['rms_sus']:>12.4e} {m['pk_all']:>10.4e}  "
              f"{ratio:>13.4f}", flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
