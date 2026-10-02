"""dev-f27f: compare two tail-damper renders (A vs B) note by note.

    python dev-f27f-compare.py DIR_A DIR_B [DIR_A2 DIR_B2 ...]

Per note: waveform difference rel = rms(b - a) / rms(a) over the whole render and over the release part
(after HOLD), and the metric deltas (rms dB, decay while held, decay after release, cents).
"""
import json
import os
import sys

import numpy as np

SR = 48000


def load(d):
    with open(os.path.join(d, "results.json")) as f:
        return json.load(f)


def compare(da, db_):
    ra, rb = load(da), load(db_)
    rel_s = int(ra["hold_ms"] / 1000 * SR)
    print(f"\n== {os.path.basename(da)}  vs  {os.path.basename(db_)}")
    print("  note      wav_rel  rel_part  dRMS_dB  decay_hold A/B      decay_rel(0.05-0.5s) A/B   cents A/B")
    for na, nb in zip(ra["notes"], rb["notes"]):
        tag = f"p{na['pitch']}_v{na['velocity']}"
        a = np.load(os.path.join(da, tag + "_ch0.npy")).astype(np.float64)
        b = np.load(os.path.join(db_, tag + "_ch0.npy")).astype(np.float64)
        rms = lambda v: float(np.sqrt(np.mean(v ** 2))) or 1e-300
        w = rms(b - a) / rms(a)
        wr = rms(b[rel_s:] - a[rel_s:]) / rms(a[rel_s:])
        f = lambda v: "   -  " if v is None else f"{v:7.2f}"
        print(f"  {tag:9s} {w:8.2e} {wr:8.2e}  {nb['rms_db'] - na['rms_db']:+6.2f}  "
              f"{f(na['decay_hold'])}/{f(nb['decay_hold'])}  {f(na['decay_rel_05'])}/{f(nb['decay_rel_05'])}  "
              f"{f(na['cents'])}/{f(nb['cents'])}")


if __name__ == "__main__":
    args = sys.argv[1:]
    for i in range(0, len(args), 2):
        compare(args[i], args[i + 1])
