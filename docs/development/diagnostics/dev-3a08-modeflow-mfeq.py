"""
dev-3a08 — Mode-flow instrumentation on -MFeq.

In-process (no backend HTTP needed) on the DEBUG pyd so SOUND_REC_MODE_STATE
records are populated. For pitches 55, 56, 57 (and the user's "play 55-56-57
in sequence" pattern):

  1. Render single isolated note offline (600 ms attack + 600 ms tail).
  2. Pull get_sound(0) — the synthesis output. Compute attack / sustain /
     post-noteoff RMS and the envelope shape (50 ms bins).
  3. Pull get_record(1, mode_no) for the modes that pitch couples to most
     strongly (top-10 by mode_dec excitation). This is dev_mode_state, the
     per-mode displacement.
  4. Report mode-bank "running" magnitudes at attack peak, sustain mid, post-
     noteoff: are 57's mode amplitudes near zero, or are they normal but
     routed to a muted channel? Are 56's modes high-Q sustaining past noteoff?

ALSO: read the per-pitch mode_dec, mode_amp, mode_freq via
`pianoid.modes.get_mode_state_for_pitch(pitch)` (or pack_for_interface) —
flag any anomaly that distinguishes 57 from neighbours.

Requires: debug pyd installed (PIANOID_USE_DEBUG=1 picks it up).
Stack must be down before invocation.
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
os.environ["PIANOID_USE_DEBUG"] = "1"

SAMPLE_RATE = 48000
SAMPLES_PER_CYCLE = 64


def envelope_bins(snd: np.ndarray, sr_hz: int, bin_ms: int = 50) -> list[float]:
    """RMS in `bin_ms` windows over the buffer."""
    bin_n = int(bin_ms / 1000.0 * sr_hz)
    if bin_n <= 0 or snd.size == 0:
        return []
    n_bins = snd.size // bin_n
    rms = []
    for i in range(n_bins):
        seg = snd[i * bin_n:(i + 1) * bin_n]
        rms.append(float(np.sqrt(np.mean(seg * seg))) if seg.size else 0.0)
    return rms


def stats_of(seg: np.ndarray) -> tuple[float, float]:
    if seg.size == 0:
        return 0.0, 0.0
    return float(np.max(np.abs(seg))), float(np.sqrt(np.mean(seg * seg)))


def render_and_capture(p, pitch: int, dur_ms: int = 600, tail_ms: int = 600,
                       velocity: int = 100) -> dict:
    import pianoidCuda
    from chartFunctions import _load_offline_sound_to_result

    sr_hz = p.mp.sample_rate()
    spc = p.mp.mode_iteration
    cycles_dur = int((dur_ms / 1000.0) * sr_hz / spc)

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

        # Pull the records buffer from C++ → numpy. This is the step the
        # chart function does at chartFunctions.py:1486 and that I missed
        # on first attempt. Records exist only on debug builds
        # (PIANOID_DEBUG_DATA gate); release builds keep them zero.
        try:
            p.result.get_sound_records_from_pianoid(dur_ms + tail_ms + 100)
        except Exception as _e:
            print(f"  (get_sound_records failed: {_e})", flush=True)

        # Per-mode state extraction (debug build only)
        # SOUND_REC_MODE_STATE = record_no 1
        # Stored as [num_modes, num_samples_total_cycles]; get_record(1, mode_no)
        # returns a flat array (samples). Mode index 0 = first registered mode.
        # We grab a handful of modes — the top mode_dec contributors for this
        # pitch — and report their post-noteoff RMS as a proxy for "running"
        # state at end-of-render.
        mode_records = {}
        # Grab modes 0..min(num_modes, 200) post-noteoff RMS samples — the
        # mode_amp/dec set carries the per-mode coupling, but extracting
        # per-pitch modes requires the soundChannel matrix; we just dump
        # raw mode records for now and compute aggregate energy + envelope.
        nm = min(getattr(p.mp, "num_modes", 196), 196)
        all_mode_post = []
        all_mode_attack = []
        all_mode_sust = []
        for m in range(nm):
            try:
                rec = p.result.get_record(1, m)
            except Exception:
                continue
            if rec is None:
                continue
            arr = np.asarray(rec, dtype=np.float64)
            if arr.size < 2:
                continue
            attack_n = int(0.200 * sr_hz)
            sus_b = int(dur_ms / 1000.0 * sr_hz)
            tail_b = min(arr.size, int((dur_ms + tail_ms) / 1000.0 * sr_hz))
            _, rms_a = stats_of(arr[:attack_n])
            _, rms_s = stats_of(arr[attack_n:sus_b])
            _, rms_p = stats_of(arr[sus_b:tail_b])
            all_mode_attack.append(rms_a)
            all_mode_sust.append(rms_s)
            all_mode_post.append(rms_p)

        mode_records = {
            "n_modes_extracted": len(all_mode_attack),
            "attack_rms_max": float(max(all_mode_attack)) if all_mode_attack else 0.0,
            "attack_rms_p50": float(np.median(all_mode_attack)) if all_mode_attack else 0.0,
            "attack_rms_p90": float(np.quantile(all_mode_attack, 0.9)) if all_mode_attack else 0.0,
            "sustain_rms_max": float(max(all_mode_sust)) if all_mode_sust else 0.0,
            "sustain_rms_p50": float(np.median(all_mode_sust)) if all_mode_sust else 0.0,
            "post_rms_max": float(max(all_mode_post)) if all_mode_post else 0.0,
            "post_rms_p50": float(np.median(all_mode_post)) if all_mode_post else 0.0,
            "post_rms_p90": float(np.quantile(all_mode_post, 0.9)) if all_mode_post else 0.0,
            "n_modes_active_sustain": int(sum(1 for r in all_mode_sust if r > 1e-6)),
            "n_modes_running_post": int(sum(1 for r in all_mode_post if r > 1e-6)),
        }

    snd = np.asarray(sound, dtype=np.float64)
    attack_n = int(0.200 * sr_hz)
    sus_b = int(dur_ms / 1000.0 * sr_hz)
    tail_b = min(snd.size, int((dur_ms + tail_ms) / 1000.0 * sr_hz))

    pk_all, rms_all = stats_of(snd)
    pk_a, rms_a = stats_of(snd[:attack_n])
    pk_s, rms_s = stats_of(snd[attack_n:sus_b])
    pk_p, rms_p = stats_of(snd[sus_b:tail_b])

    return {
        "pitch": pitch,
        "elapsed_s": elapsed,
        "total_cycles": stats.total_cycles,
        "sound_len": snd.size,
        "snd_pk": pk_all, "snd_rms_all": rms_all,
        "snd_pk_attack": pk_a, "snd_rms_attack": rms_a,
        "snd_pk_sustain": pk_s, "snd_rms_sustain": rms_s,
        "snd_pk_post": pk_p, "snd_rms_post": rms_p,
        "envelope_50ms": envelope_bins(snd, sr_hz, 50),
        "modes": mode_records,
    }


def main() -> int:
    # Switch to the debug variant BEFORE the first pianoidCuda import — the
    # select_cuda_variant alias in sys.modules is irreversible.
    from pianoid import select_cuda_variant, initialize
    select_cuda_variant(use_debug=True)

    import pianoidCuda  # now resolves to pianoidCuda_debug
    pyd_path = pianoidCuda.__file__
    pyd_mtime = time.ctime(os.path.getmtime(pyd_path))
    print(f"### dev-3a08 mode-flow probe ###", flush=True)
    print(f"  pyd: {pyd_path}", flush=True)
    print(f"  pyd_mtime: {pyd_mtime}", flush=True)
    print(f"  is debug? {'_debug' in pyd_path}", flush=True)

    preset_path = PRESETS / "Belarus_8band_196modes-MFeq.json"

    p = initialize(
        str(preset_path),
        filterlen=48 * 128 * 3,
        string_iteration=4, array_size=384,
        sample_rate=SAMPLE_RATE, samples_in_cycle=SAMPLES_PER_CYCLE,
        buffer_size=4, max_volume=5e18,
        audio_on=False, audio_driver_type=0,
        listen_to_modes=True,
        use_debug_build=True,
    )

    pitches = [55, 56, 57]
    results = {}
    for pitch in pitches:
        print(f"\n--- Rendering pitch {pitch} ---", flush=True)
        r = render_and_capture(p, pitch)
        results[pitch] = r
        print(f"  sound: pk={r['snd_pk']:.4e} rms_all={r['snd_rms_all']:.4e} "
              f"att={r['snd_rms_attack']:.4e} sus={r['snd_rms_sustain']:.4e} "
              f"post={r['snd_rms_post']:.4e}", flush=True)
        m = r["modes"]
        print(f"  modes ({m['n_modes_extracted']} extracted): "
              f"attack max={m['attack_rms_max']:.4e} p90={m['attack_rms_p90']:.4e}; "
              f"sustain max={m['sustain_rms_max']:.4e} p50={m['sustain_rms_p50']:.4e} "
              f"active(>1e-6)={m['n_modes_active_sustain']}; "
              f"post max={m['post_rms_max']:.4e} p90={m['post_rms_p90']:.4e} "
              f"running(>1e-6)={m['n_modes_running_post']}", flush=True)

    print("\n### Envelope shape (50 ms bins, 0-1200 ms) ###", flush=True)
    for pitch in pitches:
        env = results[pitch]["envelope_50ms"]
        sample = env[:24]  # 24 bins x 50 ms = 1200 ms
        line = " ".join(f"{v:.2e}" for v in sample)
        print(f"  P{pitch}: {line}", flush=True)

    print("\n### SUMMARY ###", flush=True)
    print(f"  pyd_mtime: {pyd_mtime}", flush=True)
    print(f"  preset: {preset_path.name}", flush=True)
    print(f"{'pitch':>5} {'snd_pk':>10} {'snd_sus':>10} {'snd_post':>10}  "
          f"{'mode_att_max':>12} {'mode_sus_max':>12} {'mode_post_max':>13} "
          f"{'mode_run_post':>13}", flush=True)
    for pitch in pitches:
        r = results[pitch]
        m = r["modes"]
        print(f"{pitch:>5} {r['snd_pk']:>10.3e} {r['snd_rms_sustain']:>10.3e} "
              f"{r['snd_rms_post']:>10.3e}  "
              f"{m['attack_rms_max']:>12.3e} {m['sustain_rms_max']:>12.3e} "
              f"{m['post_rms_max']:>13.3e} {m['n_modes_running_post']:>13d}", flush=True)

    try:
        p.pianoid.shutdownGpu()
    except Exception:
        pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
