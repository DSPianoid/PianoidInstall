"""dev-624c — T1 equivalence report: base-vs-base (float atomic-order floor) vs base-vs-T1.

Usage: python dev-624c-t1-compare.py <dir> [<dir> ...]
Collects every <label>_<preset>_{audio,modes,probe}.npy under the dirs (one file per run dir, written by
dev-624c-t1-harness.py) and prints, per preset and artefact, the distribution over all pairs of each kind
(base-base, base-t1, t1-t1): relative RMS diff, max|d|/peak, correlation.
For modes/probe only the running state [q x N][q_prev x N] (first 2N of 5N) is compared; the config
[dec|omega|mass_inv] must be bit-identical (checked). T1 is "indistinguishable" when the base-t1
distribution sits inside the base-base band.
"""
import glob
import itertools
import os
import sys

import numpy as np


def metrics(a, b):
    d = a - b
    na = np.linalg.norm(a)
    return (float(np.linalg.norm(d) / na) if na else float(np.linalg.norm(d)),
            float(np.abs(d).max() / max(np.abs(a).max(), 1e-300)),
            float(np.corrcoef(a, b)[0, 1]) if np.std(a) > 0 and np.std(b) > 0 else float("nan"))


def load(kind, f):
    x = np.load(f)
    if kind == "audio":
        return x, None
    n = len(x) // 5
    return x[:2 * n], x[2 * n:]


def main():
    by = {}
    for d in sys.argv[1:]:
        for f in glob.glob(os.path.join(d, "*_*.npy")):
            base = os.path.basename(f)[:-4]
            label, rest = base.split("_", 1)
            preset, kind = rest.rsplit("_", 1)
            by.setdefault((preset, kind), []).append((label, f))
    for (preset, kind), items in sorted(by.items()):
        print(f"\n== {preset} / {kind}  ({len(items)} runs: "
              f"{sum(l == 'base' for l, _ in items)} base, {sum(l != 'base' for l, _ in items)} other)")
        data = [(l, *load(kind, f)) for l, f in items]
        cfg_ok = all(c is None or np.array_equal(c, data[0][2]) for _, _, c in data)
        stats = {}
        for (la, a, _), (lb, b, _) in itertools.combinations(data, 2):
            stats.setdefault("-".join(sorted([la, lb])), []).append(metrics(a, b))
        print("pair       |  n | relRMS median (max)      | max|d|/peak median (max)  | corr min")
        for k, v in sorted(stats.items()):
            v = np.array(v)
            print(f"{k:10s} | {len(v):2d} | {np.median(v[:, 0]):.3e} ({v[:, 0].max():.3e}) | "
                  f"{np.median(v[:, 1]):.3e} ({v[:, 1].max():.3e}) | {np.nanmin(v[:, 2]):.10f}")
        if kind != "audio":
            print(f"config [dec|omega|mass_inv] identical across runs: {cfg_ok}")


if __name__ == "__main__":
    main()
