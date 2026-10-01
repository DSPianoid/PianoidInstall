"""dev-chord — FRESH-ENGINE checks that isolate two questions with zero
inter-render string residue (each render = its own freshly-initialised engine):

  Q1 SCHEDULE-HONOUR: one note scheduled to start at 800ms. Its fundamental
     must be SILENT before 800ms and LOUD after -> offline honours cycle_index.
  Q2 COINCIDENT vs STAGGERED (clean): a 4-note coincident chord vs the same 4
     notes staggered 350ms apart, each in a fresh engine. Report each
     fundamental's band energy in an EARLY window (150-330ms) — coincident =>
     all four present; staggered => only the first.

Run arg: "schedule" | "coincident" | "staggered" (one render per process so
the engine is pristine). Prints machine-readable RESULT: lines.
"""
from __future__ import annotations
import os, sys, time
from pathlib import Path
import numpy as np

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

REPO_ROOT = Path(__file__).resolve().parents[3]
MIDDLEWARE_DIR = REPO_ROOT / "PianoidCore" / "pianoid_middleware"
PRESET_PATH = MIDDLEWARE_DIR / "presets" / "Preset_test5.json"
sys.path.insert(0, str(MIDDLEWARE_DIR))
os.chdir(MIDDLEWARE_DIR)

import pianoidCuda  # noqa: E402
from pianoid import initialize  # noqa: E402
import chartFunctions  # noqa: E402

PITCHES = [61, 66, 70, 75]           # non-colliding fundamentals 277/370/466/622 Hz
VEL = 100


def midi_to_hz(m):
    return 440.0 * (2.0 ** ((m - 69) / 12.0))


def _no(p, v, c):
    e = pianoidCuda.PlaybackEvent(); e.channel = 0; e.cycle_index = c
    e.type = pianoidCuda.EventType.NOTE_ON; e.data = (int(p) << 8) | int(v); return e


def _nf(p, c):
    e = pianoidCuda.PlaybackEvent(); e.channel = 0; e.cycle_index = c
    e.type = pianoidCuda.EventType.NOTE_OFF; e.data = (int(p) << 8); return e


def _init():
    return initialize(str(PRESET_PATH), filterlen=48 * 128 * 3, string_iteration=4,
                      array_size=384, buffer_size=4, sample_rate=48000,
                      samples_in_cycle=64, max_volume=5e18, audio_on=False,
                      audio_driver_type=0)


def _render(pn, eq, total_ms):
    sr = pn.mp.sample_rate(); spc = pn.mp.mode_iteration
    cpp = pn.pianoid
    cpp.resetStringsState(); cpp.runSynthesisKernel(); cpp.clearRecords()
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.sample_rate = sr; cfg.samples_per_cycle = spc
    cfg.max_duration_ms = int(total_ms)
    cpp.runOfflinePlayback(eq, cfg)
    return np.array(cpp.getRecordedAudio(), dtype=np.float64), sr, spc


def _band_peak(audio, sr, f0, win, half_bw=8.0):
    i0 = int(win[0] * sr / 1000.0); i1 = min(len(audio), int(win[1] * sr / 1000.0))
    s = audio[i0:i1]
    if s.size < 128:
        return 0.0
    sp = np.abs(np.fft.rfft(s * np.hanning(len(s))))
    fr = np.fft.rfftfreq(len(s), d=1.0 / sr)
    mk = (fr >= f0 - half_bw) & (fr <= f0 + half_bw)
    return float(np.max(sp[mk])) if np.any(mk) else 0.0


def cps(ms, sr, spc):
    return max(1, int(round((ms / 1000.0) * sr / spc)))


def main(mode):
    pn = _init()
    try:
        sr = pn.mp.sample_rate(); spc = pn.mp.mode_iteration
        f0s = {m: midi_to_hz(m) for m in PITCHES}
        if mode == "schedule":
            pB = PITCHES[-1]; f0B = f0s[pB]
            eq = pianoidCuda.EventQueue()
            eq.addEvent(_no(pB, VEL, cps(800, sr, spc)))    # ON at 800ms
            eq.addEvent(_nf(pB, cps(1100, sr, spc)))        # OFF at 1100ms
            eq.sortByCycle()
            audio, sr, spc = _render(pn, eq, 1500)
            pre = _band_peak(audio, sr, f0B, (200.0, 500.0))   # before onset
            post = _band_peak(audio, sr, f0B, (850.0, 1080.0)) # after onset
            db = 20 * np.log10(post / pre) if pre > 0 else 120.0
            print(f"RESULT: mode=schedule pitch={pB} f0={f0B:.1f} "
                  f"pre200-500={pre:.3e} post850-1080={post:.3e} post_over_pre_db={db:+.1f} "
                  f"honors_cycle_index={db >= 12.0}")
        elif mode in ("coincident", "staggered"):
            eq = pianoidCuda.EventQueue()
            if mode == "coincident":
                q, _ = chartFunctions._sound_test_build_event_queue(
                    "chord", PITCHES, [VEL] * 4, [1400] * 4, sr, spc)
                eq = q; total = 1800
            else:
                step = cps(350, sr, spc); sus = cps(1400, sr, spc)
                for i, p in enumerate(PITCHES):
                    eq.addEvent(_no(p, VEL, i * step)); eq.addEvent(_nf(p, i * step + sus))
                eq.sortByCycle(); total = 350 * 3 + 1400 + 400
            audio, sr, spc = _render(pn, eq, total)
            ew = (150.0, 330.0)
            peaks = {m: _band_peak(audio, sr, f0s[m], ew) for m in PITCHES}
            loud = max(peaks.values()) or 1e-12
            parts = []
            for m in PITCHES:
                rel = 20 * np.log10(peaks[m] / loud) if peaks[m] > 0 else -120
                parts.append(f"{m}:{rel:+.0f}dB{'/on' if rel >= -30 else '/OFF'}")
            present = [m for m in PITCHES if (20*np.log10(peaks[m]/loud) if peaks[m] > 0 else -120) >= -30]
            print(f"RESULT: mode={mode} early_window={ew} "
                  f"rel_db=[{', '.join(parts)}] present_early={present}")
        else:
            print(f"unknown mode {mode!r}")
    finally:
        try:
            pn.pianoid.shutdownGpu()
        except Exception:
            pass


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "schedule")
