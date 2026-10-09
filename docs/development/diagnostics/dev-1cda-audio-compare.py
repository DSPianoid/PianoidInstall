"""dev-1cda — output equivalence of the addKernel register cap: compare offline renders.

Usage: python dev-1cda-audio-compare.py <dir> [<dir> ...]
Collects every <label>_<preset>_audio.npy under the given dirs and prints, per preset, the
pairwise relative RMS difference / max|diff|/peak / correlation for base-base (the float
non-determinism floor: atomicAdd order differs run-to-run), cap-cap and base-cap pairs.
The cap is "within float noise" when base-cap differences sit inside the base-base band.
"""
import glob
import itertools
import os
import sys

import numpy as np


def metrics(a, b):
    d = a - b
    return (float(np.linalg.norm(d) / np.linalg.norm(a)), float(np.abs(d).max() / np.abs(a).max()),
            float(np.corrcoef(a, b)[0, 1]), bool(np.array_equal(a, b)))


def main():
    files = []
    for d in sys.argv[1:]:
        files += glob.glob(os.path.join(d, "*_audio.npy"))
    by_preset = {}
    for f in files:
        label, rest = os.path.basename(f).split("_", 1)
        by_preset.setdefault(rest[:-len("_audio.npy")], []).append((label, f))
    for preset, items in sorted(by_preset.items()):
        print(f"\n== {preset} ({len(items)} renders)")
        print("pair       | relRMS diff | max|d|/peak | corr        | identical")
        for (la, fa), (lb, fb) in itertools.combinations(items, 2):
            a, b = np.load(fa), np.load(fb)
            r, m, c, eq = metrics(a, b)
            kind = "-".join(sorted([la, lb]))
            print(f"{kind:10s} | {r:.3e}   | {m:.3e}   | {c:.9f} | {eq}")


if __name__ == "__main__":
    main()
