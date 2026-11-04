"""dev-bow2: timbre cost and scope of the bowed-string high-frequency loss (offline, in-process).

One process, pitch 48 (BaselinePreset1, perf-suite engine config):
  hammer_ref   hammer vel 80, sustain pedal down, key 0.1-2.6 s, render 4.5 s
  bow_xL       bow vel 90 force 0.5 angle 0.3 at string-loss factor L (1 = v1, 10, 20, 40 = v2),
               pedal down, key 0.1-2.6 s: after key-up the string rings under the pedal
  hammer_after the hammer_ref note again, after the bow notes and the switch back to hammer
Per render: partial levels re the fundamental (steady 1.5-2.5 s), spectral centroid, and the decay
rate (dB/s) of the fundamental and of the 1-2.5 kHz band in 2.9-4.3 s (free ring under the pedal; for
the bow: the bow lifted and its extra loss gone 50 ms after key-up).
"""
import argparse
import json
import os
import sys

import numpy as np

SR = 48000
SPC = 64


def ev(pc, kind, data, t):
    e = pc.PlaybackEvent()
    e.type = kind
    e.channel = 0
    e.cycle_index = int(round(t * SR / SPC))
    e.data = data
    return e


def render(p, pc, pitch, vel, dur=4.5):
    from PanoidResult import PianoidResult
    eng = p.pianoid
    eng.resetStringsState()
    q = pc.EventQueue()
    q.addEvent(ev(pc, pc.EventType.SUSTAIN, 127, 0.02))
    q.addEvent(ev(pc, pc.EventType.NOTE_ON, (pitch << 8) | vel, 0.1))
    q.addEvent(ev(pc, pc.EventType.NOTE_OFF, pitch << 8, 2.6))
    q.addEvent(ev(pc, pc.EventType.SUSTAIN, 0, dur - 0.05))
    q.sortByCycle()
    cfg = pc.PlaybackConfig()
    cfg.audio_enabled = False
    cfg.record_to_buffer = True
    cfg.max_duration_ms = int(dur * 1000)
    cfg.sample_rate = SR
    cfg.samples_per_cycle = SPC
    stats = eng.runOfflinePlayback(q, cfg)
    assert stats.completed_successfully, stats.error_message
    res = PianoidResult(eng, p.mp)
    res.load_offline_sound_from_pianoid()
    return np.asarray(res.sound[0], dtype=np.float64)


def seg(x, a, b):
    return x[int(a * SR):int(b * SR)]


def partials(x, f0, n=16):
    sp = np.abs(np.fft.rfft(x * np.hanning(len(x)), 4 * len(x)))
    f = np.fft.rfftfreq(4 * len(x), 1 / SR)
    lv = []
    for h in range(1, n + 1):
        band = (f > f0 * (h - 0.4)) & (f < f0 * (h + 0.4))
        lv.append(sp[band].max())
    return [round(20 * np.log10(v / lv[0]), 1) for v in lv]


def centroid(x):
    sp = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    f = np.fft.rfftfreq(len(x), 1 / SR)
    return float((sp * f).sum() / sp.sum())


def band_decay(x, lo, hi, a, b):
    """dB/s slope of the band energy over [a, b] s (100 ms frames, least squares)."""
    ts, lv = [], []
    for t in np.arange(a, b - 0.1, 0.1):
        s = seg(x, t, t + 0.1)
        sp = np.abs(np.fft.rfft(s * np.hanning(len(s)))) ** 2
        f = np.fft.rfftfreq(len(s), 1 / SR)
        e = sp[(f >= lo) & (f < hi)].sum()
        ts.append(t)
        lv.append(10 * np.log10(e + 1e-40))
    return round(float(np.polyfit(ts, lv, 1)[0]), 1)


def analyse(x, f0):
    st = seg(x, 1.5, 2.5)
    return {"nan": int(np.isnan(x).sum()),
            "partials_db_re_h1": partials(st, f0),
            "centroid_hz": round(centroid(st), 0),
            "decay_fund_db_s": band_decay(x, f0 * 0.7, f0 * 1.3, 2.9, 4.3),
            "decay_1_2.5k_db_s": band_decay(x, 1000, 2500, 2.9, 4.3)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", required=True)
    ap.add_argument("--pitch", type=int, default=48)
    ap.add_argument("--out", default="dev-bow2-timbre.json")
    args = ap.parse_args()
    mw = os.path.join(args.core, "pianoid_middleware")
    sys.path.insert(0, mw)
    os.chdir(mw)
    import pianoidCuda as pc
    from pianoid import initialize
    p = initialize(os.path.join(mw, "presets", "BaselinePreset1.json"), filterlen=48 * 128 * 3,
                   string_iteration=4, array_size=384, sample_rate=SR, samples_in_cycle=SPC,
                   buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0)
    eng = p.pianoid
    P = args.pitch
    f0 = 129.6
    out = {}
    try:
        h0 = render(p, pc, P, 80)
        out["hammer_ref"] = analyse(h0, f0)
        p.set_pitch_excitation_mode(P, 1)
        eng.setBowForce(0.5)
        eng.setBowSoftness(0.3)
        for loss in (1, 10, 20, 40):
            eng.setBowStringLoss(float(loss))
            out[f"bow_x{loss}"] = analyse(render(p, pc, P, 90), f0)
        eng.setBowStringLoss(40.0)
        p.set_pitch_excitation_mode(P, 0)
        h1 = render(p, pc, P, 80)
        out["hammer_after"] = analyse(h1, f0)
        out["hammer_after_vs_ref_maxdiff_rel"] = float(np.abs(h1 - h0).max() / np.abs(h0).max())
        h2 = render(p, pc, P, 80)
        out["hammer_rerun_vs_after_maxdiff_rel"] = float(np.abs(h2 - h1).max() / np.abs(h1).max())
    finally:
        eng.shutdownGpu()
    print(json.dumps(out, indent=1))
    with open(args.out, "w") as f:
        json.dump(out, f, indent=1)


if __name__ == "__main__":
    main()
