"""dev-3d2c — T4 report over the interleaved timing rounds (D:/scratch/dev-3d2c/timing.sh -> runs/timing/r*/).

Usage: python dev-3d2c-t4-compare.py <timing_dir>
Each round directory holds, per (binary label, preset), the dev-5bf7-t3-harness outputs: <label>_<preset>_audio.npy
(3 s chord), _modes.npy, _probe.npy and <label>_<preset>_<pid>.json (addKernel CUDA-event timing). Prints:
  * timing: per config the run-means (one per fresh process) -> median / min / max over rounds, vs the 1.333 ms budget;
  * equivalence (legacy presets unchanged): relRMS of audio / mode state / probe for base-base, t4-t4 and base-t4 pairs
    (all cross-round pairs; median and max) — base-t4 must sit inside the base-base / t4-t4 band.
"""
import glob
import itertools
import json
import os
import sys

import numpy as np

BUDGET_MS = 64 / 48.0


def rel(a, b):
    n = min(a.size, b.size)
    a, b = a[:n], b[:n]
    return float(np.linalg.norm(a - b) / max(np.linalg.norm(a), 1e-300))


def main():
    root = sys.argv[1]
    rounds = sorted(glob.glob(os.path.join(root, "r*")))
    timing = {}
    for r in rounds:
        for js in glob.glob(os.path.join(r, "*.json")):
            d = json.load(open(js))
            if "add_ms" not in d:
                continue
            key = (d["label"], os.path.splitext(os.path.basename(d["preset"]))[0])
            timing.setdefault(key, []).append(d["add_ms"]["mean"] * 1000)
    print("TIMING (addKernel us per 64-sample cycle, run means; budget %.0f us)" % (BUDGET_MS * 1000))
    for (lab, pr), v in sorted(timing.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        v = np.array(v)
        print(f"  {pr:40s} {lab:5s} n={len(v)} median {np.median(v):7.1f}  min {v.min():7.1f}  max {v.max():7.1f}"
              f"  = {100 * np.median(v) / (BUDGET_MS * 1000):4.1f} % of budget   runs {np.round(np.sort(v), 1).tolist()}")
    presets = sorted({pr for _, pr in timing})
    print("EQUIVALENCE (relRMS, all cross-round pairs: median / max)")
    for pr in presets:
        for art in ("audio", "modes", "probe"):
            runs = {lab: [np.load(f) for f in sorted(glob.glob(os.path.join(root, "r*", f"{lab}_{pr}_{art}.npy")))]
                    for lab in ("base", "t4")}
            if art != "audio":                       # mode state / probe: compare the common [q, q_prev] slots
                n = min(len(x) // 5 for xs in runs.values() for x in xs) if all(runs.values()) else 0
                runs = {lab: [x[:2 * (len(x) // 5)].reshape(2, -1)[:, :n].ravel() for x in xs] for lab, xs in runs.items()}
            out = []
            for a_lab, b_lab in (("base", "base"), ("t4", "t4"), ("base", "t4")):
                A, B = runs[a_lab], runs[b_lab]
                pairs = list(itertools.combinations(range(len(A)), 2)) if a_lab == b_lab else \
                    [(i, j) for i in range(len(A)) for j in range(len(B))]
                vals = [rel(A[i], B[j]) for i, j in pairs]
                if vals:
                    out.append(f"{a_lab}-{b_lab} {np.median(vals):.3e} / {np.max(vals):.3e}")
            if out:
                print(f"  {pr:40s} {art:5s} " + " | ".join(out))


if __name__ == "__main__":
    main()
