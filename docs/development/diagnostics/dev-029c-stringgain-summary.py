"""dev-029c (2026-10-04) -- summarise dev-029c-stringgain-probe.py outputs (no GPU, no engine).

    python dev-029c-stringgain-summary.py RUNS_DIR

Per equal-mass keyboard sweep: per-pitch level L (m_all, dB re p60), spread max-min / p95-p5 / std (all pitches
and f0 < 2 kHz), implied hammer-mass range (m ~ 10^(-L/20), median pinned to 10 g), unison steps at the 1->2 and
2->3 string boundaries, p60 absolute level; waveform identity legacy vs physical (normalised correlation, level
ratio vs 20 log G); single-pitch controls (variant - base). f0 = sqrt(T/rho)/(2 L) from the analysis renders.
"""
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
F0_SRC = {"BaselinePreset1.json": "bp1_base.json", "F15_Elyashev_array512.json": "f15_base.json"}


def load(d, name):
    p = os.path.join(d, name + ".json")
    return json.load(open(p)) if os.path.exists(p) else None


def f0_table(preset):
    src = os.path.join(HERE, "analyse-loudphys-renders", F0_SRC[preset])
    return {int(k): v["factors"]["f0_ideal"] for k, v in json.load(open(src))["pitches"].items()}


def spread(vals):
    v = np.asarray(vals, dtype=float)
    return f"{v.max() - v.min():5.1f} / {np.percentile(v, 95) - np.percentile(v, 5):5.1f} / {v.std():4.1f}"


def mass_range(levels):
    m = 10 ** (-np.asarray(levels) / 20.0)
    m *= 10.0 / np.median(m)
    return f"{m.min():5.2f} / {np.median(m):5.2f} / {m.max():6.1f} g"


def sweep_rows(run):
    pit = {int(k): v for k, v in run["pitches"].items() if v["m_all"] is not None}
    ref = pit[60]["m_all"]
    return {k: v["m_all"] - ref for k, v in pit.items()}, pit


def summarise_sweeps(d, prefix, labels):
    print(f"\n=== {prefix}: equal-mass keyboard sweep (10 g, v95) ===")
    print(f"{'config':28s} | {'n':>3s} | all: max-min / p95-p5 / std | f0<2kHz: max-min / p95-p5 / std | "
          f"implied mass f0<2k (min/med/max) | step 1->2 | step 2->3 | p60 abs dB")
    out = {}
    for name, label in labels:
        run = load(d, name)
        if run is None:
            continue
        L, pit = sweep_rows(run)
        f0 = f0_table(run["preset"])
        low = {k: v for k, v in L.items() if (f0.get(k) or 0) < 2000}
        ns = {k: pit[k]["n_strings"] for k in L}
        steps = []
        for a, b in ((1, 2), (2, 3)):
            last = max(k for k in L if ns[k] == a)
            first = min(k for k in L if ns[k] == b)
            steps.append(f"p{last}->{first} {L[first] - L[last]:+5.1f}")
        print(f"{label:28s} | {len(L):3d} | {spread(list(L.values())):27s} | {spread(list(low.values())):31s} | "
              f"{mass_range(list(low.values())):32s} | {steps[0]:>13s} | {steps[1]:>13s} | {pit[60]['m_all']:.3f}")
        out[name] = (L, pit)
    return out


def waveform_identity(d, a, b):
    pa, pb = os.path.join(d, a + "_waves.npz"), os.path.join(d, b + "_waves.npz")
    if not (os.path.exists(pa) and os.path.exists(pb)):
        return
    wa, wb = np.load(pa), np.load(pb)
    ra, rb = load(d, a), load(d, b)
    print(f"\n--- waveform identity {a} vs {b} (pitch/decay unchanged => corr = 1, level ratio = 20 log G) ---")
    for k in sorted(wa.files, key=int):
        x, y = wa[k].ravel(), wb[k].ravel()
        corr = float(np.dot(x, y) / math.sqrt(np.dot(x, x) * np.dot(y, y)))
        ratio = 20 * math.log10(math.sqrt(np.dot(y, y) / np.dot(x, x)))
        g = 20 * math.log10(rb["pitches"][k]["string_gain"] / ra["pitches"][k]["string_gain"])
        print(f"  p{k}: corr {corr:.9f}  level {ratio:+7.3f} dB  predicted {g:+7.3f} dB")


def controls(d, prefix, pitches):
    print(f"\n=== {prefix}: single-pitch controls, variant - base (m_all; peak) ===")
    for model in ("legacy", "physical"):
        base = load(d, f"{prefix}_ctl_{model}_base")
        if base is None:
            continue
        for var, label in (("rho4", "rho,T,jung x4"), ("dx2", "main x0.5 = dx x2")):
            v = load(d, f"{prefix}_ctl_{model}_{var}")
            if v is None:
                continue
            cells = []
            for k in pitches:
                b_, v_ = base["pitches"][str(k)], v["pitches"][str(k)]
                cells.append(f"p{k} {v_['m_all'] - b_['m_all']:+5.1f} ({v_['peak'] - b_['peak']:+5.1f})")
            print(f"  {model:8s} {label:18s}: " + "  ".join(cells))


def main():
    d = sys.argv[1]
    for prefix in ("bp1", "f15"):
        summarise_sweeps(d, prefix, [(f"{prefix}_eq_legacy", "legacy (before)"), (f"{prefix}_eq_r1", "physical k=0 (R1)"),
                                     (f"{prefix}_eq_r1r2h", "physical k=0.5 (R1+R2 sqrt)"),
                                     (f"{prefix}_eq_r1r2", "physical k=1 (R1+R2)")])
        waveform_identity(d, f"{prefix}_eq_legacy", f"{prefix}_eq_r1r2" if prefix == "bp1" else f"{prefix}_eq_r1")
        print(f"\n=== {prefix}: SHIPPED masses (impact on the preset as it is) ===")
        for name, label in ((f"{prefix}_ship_legacy", "legacy"), (f"{prefix}_ship_phys", "physical k=1 (default)"),
                            (f"{prefix}_ship_phys0", "physical k=0 (F15 declared)")):
            run = load(d, name)
            if run is None:
                continue
            L, pit = sweep_rows(run)
            f0 = f0_table(run["preset"])
            low = [v for k, v in L.items() if (f0.get(k) or 0) < 2000]
            print(f"  {label:28s}: all {spread(list(L.values()))} | f0<2k {spread(low)} | p60 abs {pit[60]['m_all']:.3f} | "
                  f"p24 {L.get(24, float('nan')):+.1f} p36 {L.get(36, float('nan')):+.1f} p84 {L.get(84, float('nan')):+.1f} "
                  f"p96 {L.get(96, float('nan')):+.1f} p105 {L.get(105, float('nan')):+.1f} (dB re p60)")
        controls(d, prefix, (36, 60, 84) if prefix == "bp1" else (36, 60, 94))


if __name__ == "__main__":
    main()
