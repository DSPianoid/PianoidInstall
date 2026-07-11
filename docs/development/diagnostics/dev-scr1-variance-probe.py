"""dev-scr1 — quantify run-to-run variance of sound-channel calibration.

Hits POST /modal/calibrate_sound_channel on the LIVE engine (:5000) N times with
identical params and reports the coefficient of variation (CV = std/mean) of the
per-channel self_loudness (magnitude pass) and the normalized row, plus the
superposition residual (parallelogram_rel) spread. This is the operator's exact
complaint surface ("very high variance between two measurements with the same
parameters").

Usage:  python dev-scr1-variance-probe.py <mode_no> <pitch> <N>
"""
import json
import sys
import time
import urllib.request

import numpy as np

URL = "http://127.0.0.1:5000/modal/calibrate_sound_channel"


def one_run(mode_no, pitch):
    body = json.dumps({"mode_no": mode_no, "pitch": pitch}).encode()
    req = urllib.request.Request(URL, data=body,
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.loads(r.read().decode())
    dt = time.time() - t0
    return d.get("review", d), dt


def cv(rows):
    a = np.asarray(rows, dtype=float)
    mean = np.nanmean(a, axis=0)
    std = np.nanstd(a, axis=0)
    with np.errstate(divide="ignore", invalid="ignore"):
        cvv = np.where(np.abs(mean) > 1e-12, std / np.abs(mean), np.nan)
    return mean, std, cvv


def main():
    mode_no = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    pitch = int(sys.argv[2]) if len(sys.argv) > 2 else 60
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 6

    selfs, rows, confs, paras, holds, times = [], [], [], [], [], []
    for k in range(n):
        rv, dt = one_run(mode_no, pitch)
        selfs.append(rv["self_loudness"])
        rows.append(rv["row_normalized"])
        confs.append(rv["confirmation_loudness"])
        paras.append([np.nan if v is None else v
                      for v in rv["residuals"]["parallelogram_rel"]])
        holds.append(rv["hold_seconds"])
        times.append(dt)
        print(f"run {k}: ref={rv['reference']} self={np.round(rv['self_loudness'],4)} "
              f"row={np.round(rv['row_normalized'],3)} conf={rv['confirmation_loudness']:.4f} "
              f"dt={dt:.1f}s")

    print("\n=== self_loudness (magnitude pass) ===")
    m, s, c = cv(selfs)
    print("mean :", np.round(m, 5))
    print("std  :", np.round(s, 5))
    print("CV   :", np.round(c, 3), " <- coefficient of variation per channel")
    dom = int(np.nanargmax(m))
    print(f"dominant channel = {dom}, CV_dominant = {c[dom]:.3f}")

    print("\n=== row_normalized (persisted row) ===")
    m, s, c = cv(rows)
    print("mean :", np.round(m, 4))
    print("std  :", np.round(s, 4))
    print("CV   :", np.round(c, 3))
    # max abs deviation of any coeff across runs
    a = np.asarray(rows)
    print("max |row_i - mean_i| across runs:", np.round(np.nanmax(np.abs(a - m), axis=0), 4))

    print("\n=== confirmation_loudness ===")
    cc = np.asarray(confs)
    print(f"mean={cc.mean():.4f} std={cc.std():.4f} CV={cc.std()/cc.mean():.3f}")

    print("\n=== superposition residual |parallelogram_rel| (want < 0.1) ===")
    pa = np.abs(np.asarray(paras))
    print("per-run max:", np.round(np.nanmax(pa, axis=1), 3))
    print(f"overall mean-max={np.nanmean(np.nanmax(pa,axis=1)):.3f}")

    print(f"\nhold_seconds={holds[0]:.4f}  mean_wallclock={np.mean(times):.1f}s")


if __name__ == "__main__":
    main()
