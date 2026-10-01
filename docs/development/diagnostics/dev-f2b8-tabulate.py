"""dev-f2b8: tabulate level vs N. Usage: python dev-f2b8-tabulate.py RENDER_SUBDIR [prefix ...]
Per (config, note): RMS(0-500ms, ch0) dB and peak dB at N=2/4/8/16, plus the fitted exponent
k in level ∝ N^k (least squares of dB vs 20*log10 N), and decay/cents at each N."""
import glob
import json
import os
import sys

import numpy as np

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dev-f2b8-renders", sys.argv[1])
runs = {}
for f in glob.glob(os.path.join(root, "*", "results.json")):
    r = json.load(open(f))
    lab = os.path.basename(os.path.dirname(f))
    cfg = lab.replace(f"_N{r['N']}_", "_")
    runs.setdefault(cfg, {})[r["N"]] = r
prefixes = sys.argv[2:]
for cfg in sorted(runs):
    if prefixes and not any(cfg.startswith(p) for p in prefixes):
        continue
    byN = runs[cfg]
    Ns = sorted(byN)
    print(f"\n== {cfg}   (N: {Ns})")
    for i, note in enumerate(byN[Ns[0]]["notes"]):
        p = note["pitch"]
        rms = [byN[n]["notes"][i]["rms_db_ch0"] for n in Ns]
        pk = [byN[n]["notes"][i]["peak_db"] for n in Ns]
        dec = [byN[n]["notes"][i]["decay_db_per_s"] for n in Ns]
        cen = [byN[n]["notes"][i]["cents"] for n in Ns]
        x = 20 * np.log10(np.array(Ns, float))
        ok = [j for j, v in enumerate(rms) if v is not None]
        k_rms = np.polyfit(x[ok], np.array(rms, float)[ok], 1)[0] if len(ok) > 1 else float("nan")
        ok2 = [j for j, v in enumerate(pk) if v is not None]
        k_pk = np.polyfit(x[ok2], np.array(pk, float)[ok2], 1)[0] if len(ok2) > 1 else float("nan")
        fmt = lambda a: " ".join("   -  " if v is None else f"{v:6.1f}" for v in a)
        print(f"  p{p:3d} rms[{fmt(rms)}] k={k_rms:+.2f} | peak[{fmt(pk)}] k={k_pk:+.2f} | "
              f"decay[{fmt(dec)}] | cents[{fmt(cen)}]")
