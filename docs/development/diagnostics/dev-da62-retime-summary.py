"""dev-da62 (2026-10-04) -- summarise dev-da62-retime-probe.py sweeps (no GPU).

    python dev-da62-retime-summary.py BASE.json label=VARIANT.json [label=VARIANT.json ...]

Per sweep: equal-mass level spread (m_all, dB rel. p60): max-min / p95-p5 / std, the top octave (p96+) and
bass (p<=35) medians, the implied mass range (m ∝ 10^(-L/20), the dev-168c equaliser's answer) and its
bass/treble medians; vs BASE: delivered-impulse ratio (max |dB|), and per --wave pitch the level delta,
f0 shift (cents), fundamental decay change, centroid shift (sustain and attack).
"""
import json
import math
import sys

import numpy as np


def load(path):
    d = json.load(open(path))
    return {int(k): v for k, v in d["pitches"].items() if v["m_all"] is not None}   # p23 renders silent in BP1


def spread(r):
    p = sorted(r)
    ref = r[60]["m_all"]
    L = np.array([r[k]["m_all"] - ref for k in p])
    top = [r[k]["m_all"] - ref for k in p if k >= 96]
    bass = [r[k]["m_all"] - ref for k in p if k <= 35]
    m = 10 ** (-L / 20)
    m = m / np.median(m) * 10.0                                  # implied mass, median pinned to 10 g
    g = dict(zip(p, m))
    return {"max-min": L.max() - L.min(), "p95-p5": np.percentile(L, 95) - np.percentile(L, 5), "std": L.std(),
            "top_med": float(np.median(top)), "top_min": float(min(top)), "bass_med": float(np.median(bass)),
            "mass_min": m.min(), "mass_med": float(np.median(m)), "mass_max": m.max(),
            "mass_bass_med": float(np.median([g[k] for k in p if k <= 35])),
            "mass_treble_med": float(np.median([g[k] for k in p if k >= 84])), "L": dict(zip(p, L))}


def main():
    base = load(sys.argv[1])
    runs = [("base", base)] + [(a.split("=", 1)[0], load(a.split("=", 1)[1])) for a in sys.argv[2:]]
    print("== equal-mass keyboard (m_all dB rel p60, velocity 95, 10 g everywhere)")
    print(f"{'run':>8} {'max-min':>8} {'p95-p5':>7} {'std':>5} {'bass med':>8} {'top med':>8} {'top min':>8}"
          f" | implied mass g: {'min':>5} {'med':>5} {'max':>6} {'bass':>5} {'treble':>6} {'range dB':>8}")
    S = {}
    for lab, r in runs:
        s = S[lab] = spread(r)
        print(f"{lab:>8} {s['max-min']:8.1f} {s['p95-p5']:7.1f} {s['std']:5.1f} {s['bass_med']:8.1f} {s['top_med']:8.1f}"
              f" {s['top_min']:8.1f} | {s['mass_min']:15.2f} {s['mass_med']:5.2f} {s['mass_max']:6.1f}"
              f" {s['mass_bass_med']:5.1f} {s['mass_treble_med']:6.1f} {20 * math.log10(s['mass_max'] / s['mass_min']):8.1f}")
    print("\n== per-pitch level (dB rel p60) at sampled pitches")
    sample = [24, 30, 36, 45, 48, 55, 60, 66, 72, 78, 84, 90, 96, 100, 103, 105]
    print(f"{'pitch':>5} " + " ".join(f"{lab:>8}" for lab, _ in runs))
    for p in sample:
        if p in base:
            print(f"{p:>5} " + " ".join(f"{S[lab]['L'].get(p, float('nan')):8.1f}" for lab, _ in runs))
    print("\n== invariants vs base (velocity 95)")
    for lab, r in runs[1:]:
        imp = [abs(20 * math.log10(r[k]["impulse"] / base[k]["impulse"])) for k in base if k in r]
        print(f"{lab:>8}: delivered impulse max |delta| {max(imp):.2e} dB over {len(imp)} pitches; "
              f"absolute level p60 {r[60]['m_all'] - base[60]['m_all']:+.1f} dB")
        print(f"{'pitch':>5} {'tau ms':>13} {'dL dB':>6} {'df0 c':>6} {'decay f0 dB/s':>15} {'centroid Hz (sustain)':>22} {'attack':>15}")
        for k in sorted(base):
            b, v = base[k], r.get(k)
            if v is None or "f0" not in b or "f0" not in v:
                continue
            print(f"{k:>5} {b['tau_ms']:5.2f}->{v['tau_ms']:5.2f} {v['m_all'] - b['m_all']:6.1f} "
                  f"{1200 * math.log2(v['f0'] / b['f0']):6.1f} {b['decay_f0_db_per_s']:7.1f}->{v['decay_f0_db_per_s']:6.1f} "
                  f"{b['centroid']:9.0f}->{v['centroid']:6.0f} ({1200 * math.log2(v['centroid'] / b['centroid']) / 1200:+.2f} oct) "
                  f"{b['centroid_attack']:6.0f}->{v['centroid_attack']:6.0f}")


if __name__ == "__main__":
    main()
