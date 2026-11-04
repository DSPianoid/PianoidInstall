"""dev-bow2: what makes a bowed note harsh? Offline renders with runtime bow settings, and C3 softening
candidates as WAVs.

Per render (key held 3 s, 1 s release; steady part 1.5-2.8 s):
  centroid (Hz) and centroid / f0 (harmonic number of the spectral centre of mass),
  roll-off: least-squares slope of partial level (dB) vs log2(harmonic number) over h1-h24, in dB/octave,
  noise: energy BETWEEN the partials relative to the partials (dB), the ripple / jitter / multi-slip noise,
  attack: time to reach -3 dB of the steady RMS (ms),
  level: steady RMS (dB re the hammer vel 80 attack RMS of the same pitch).

Usage: python dev-bow2-harshness.py --core D:/repos/wt-bow-core --cases <json list> [--wav-dir DIR]
  case = {"name":..., "pitch":48, "loss":60 (0 = register curve), "bow_position":1.6 (0 = hammer point),
          "force":0.5, "angle":0.3, "vel":90, "wav": optional file name}
"""
import argparse
import importlib.util
import json
import os
import sys

import numpy as np

SR = 48000


def metrics(x, f0, ref_rms):
    st = x[int(1.5 * SR):int(2.8 * SR)]
    n = len(st)
    sp = np.abs(np.fft.rfft(st * np.hanning(n), 4 * n)) ** 2
    f = np.fft.rfftfreq(4 * n, 1 / SR)
    cen = float((np.sqrt(sp) * f).sum() / np.sqrt(sp).sum())
    harm, between = [], 0.0
    on = np.zeros_like(f, bool)
    for h in range(1, 25):
        band = (f > f0 * (h - 0.15)) & (f < f0 * (h + 0.15))
        on |= band
        harm.append(sp[band].max())
    lv = 10 * np.log10(np.array(harm) / harm[0])
    slope = float(np.polyfit(np.log2(np.arange(1, 25)), lv, 1)[0])
    region = f < f0 * 24.5
    noise_db = float(10 * np.log10(sp[region & ~on].sum() / sp[region & on].sum()))
    env = np.array([np.sqrt(np.mean(x[i:i + 240] ** 2)) for i in range(0, int(1.0 * SR), 240)])
    steady = np.sqrt(np.mean(st ** 2))
    k = np.flatnonzero(env >= steady * 10 ** (-3 / 20))
    attack_ms = float(k[0] * 5) if len(k) else None
    return {"centroid_hz": round(cen), "centroid_over_f0": round(cen / f0, 1),
            "rolloff_db_per_octave": round(slope, 1), "between_partials_db": round(noise_db, 1),
            "attack_ms": attack_ms, "level_db_re_hammer": round(20 * np.log10(steady / ref_rms), 1),
            "nan": int(np.isnan(x).sum())}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", required=True)
    ap.add_argument("--cases", required=True, help="JSON list of cases, or @file")
    ap.add_argument("--wav-dir", default=None)
    args = ap.parse_args()
    cases = json.load(open(args.cases[1:])) if args.cases.startswith("@") else json.loads(args.cases)
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location("w", os.path.join(here, "dev-bow2-wavs.py"))
    w = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(w)
    mw = os.path.join(args.core, "pianoid_middleware")
    sys.path.insert(0, mw)
    os.chdir(mw)
    import pianoidCuda as pc
    from pianoid import initialize
    p = initialize(os.path.join(mw, "presets", "BaselinePreset1.json"), filterlen=48 * 128 * 3,
                   string_iteration=4, array_size=384, sample_rate=SR, samples_in_cycle=64,
                   buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0)
    eng = p.pianoid
    refs = {}
    out = []
    try:
        for c in cases:
            P = c.get("pitch", 48)
            f0 = 440.0 * 2 ** ((P - 69) / 12) * 2 ** (-16 / 1200)       # the preset sits ~-16 cents
            if P not in refs:
                h = w.render(p, pc, P, 80)
                refs[P] = float(np.sqrt(np.mean(h[int(0.02 * SR):int(0.22 * SR)] ** 2)))
            p.set_pitch_excitation_mode(P, 1)
            eng.setBowForce(c.get("force", 0.5))
            eng.setBowSoftness(c.get("angle", 0.3))
            eng.setBowStringLoss(float(c.get("loss", 0)))          # 0 = per-register curve
            if hasattr(eng, "setBowPosition"):
                eng.setBowPosition(float(c.get("bow_position", 0)))  # 0 = hammer point
            x = w.render(p, pc, P, c.get("vel", 90))
            p.set_pitch_excitation_mode(P, 0)
            m = metrics(x, f0, refs[P])
            out.append({**c, **m})
            print(json.dumps(out[-1]), flush=True)
            if args.wav_dir and c.get("wav"):
                w.write24(os.path.join(args.wav_dir, c["wav"]), x, w.norm_gain(x))
    finally:
        eng.shutdownGpu()


if __name__ == "__main__":
    main()
