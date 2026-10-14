"""dev-fd69 2026-10-14: compare 7x7 fixed-layout FRFs / fitted modes between two drive levels.

For every exciter present in BOTH runs: per-volt FRFs (same processing as the 7x7 analysis),
per band (25-250, 250-1k, 1-2k Hz) the median |dB| and |phase| difference on lines within 20 dB of
each path's peak, plus PolyMAX (25 Hz-1.1 kHz, hum excluded) on the common columns of each run and a
1:1 mode match (|df| <= 1 %): df %, d-zeta pp.
Usage: python <this> <run_ref> <run_test> <out_dir> [--label name]
"""
import importlib.util
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("fl", os.path.join(HERE, "dev-fd69-fixed-layout-2026-10-14.py"))
fl = importlib.util.module_from_spec(spec); spec.loader.exec_module(fl)
BANDS = ((25, 250, "<250"), (250, 1000, "250-1k"), (1000, 2000, "1-2k"))


def run_frfs(run, exciters, fmax=2100.0):
    from pianoid_middleware.modal_adapter.measurement.ess import deconvolve, exp_sweep
    cfg = json.load(open(os.path.join(run, "config.json")))
    win = np.ones(fl.NIR); nf = int(0.1 * fl.NIR); win[-nf:] = 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, nf))
    f = np.fft.rfftfreq(fl.NIR, 1 / fl.FS); keep = f <= fmax
    Hv = np.zeros((fl.NREP, int(keep.sum()), 7, len(exciters)), complex)
    for j, e in enumerate(exciters):
        lv = cfg["levels"][e]; x = exp_sweep(fl.F1, fl.F2, fl.T, fl.FS, lv)
        for r in range(fl.NREP):
            y = np.load(os.path.join(run, "sessions", f"{e}_m{-lv}_r{r + 1}", "data.npy")).astype(float)
            h = np.roll(deconvolve(y, x, fl.FS, (fl.F1, fl.F2)), fl.PRE, axis=0)[:fl.NIR] * win[:, None]
            Hv[r, :, :, j] = np.fft.rfft(h, axis=0)[keep]
    return f[keep], Hv, {e: cfg["levels"][e] for e in exciters}


def fit(f, Hv, fmax=1100.0):
    from pianoid_middleware.modal_adapter.polymax.identify import PolymaxConfig, identify
    m = Hv.mean(0); var = np.maximum(Hv.var(0) / Hv.shape[0], 1e-30)
    s = (f >= 25) & (f <= fmax)
    for hz in fl.HUM:
        s &= np.abs(f - hz) > 1.0
    r = identify(f[s], m[s], PolymaxConfig(band_edges=(25.0, 60.0, 120.0, 200.0, 350.0, 600.0, fmax), p_max=40, prune=True), var[s])
    return [(x["f_hz"], 100 * x["zeta"]) for x in r["modes"]]


def main(ref, test, out, label):
    os.makedirs(out, exist_ok=True)
    cr, ct = json.load(open(os.path.join(ref, "config.json"))), json.load(open(os.path.join(test, "config.json")))
    ex = [e for e in fl.EXC if e in cr["levels"] and e in ct["levels"]]
    f, Hr, lr = run_frfs(ref, ex); _, Ht, lt = run_frfs(test, ex)
    mr, mt = Hr.mean(0), Ht.mean(0)
    rep = {"exciters": ex, "levels_ref": lr, "levels_test": lt, "frf_diff": {}}
    for j, e in enumerate(ex):
        row = {}
        for lo, hi, nm in BANDS:
            s = (f >= lo) & (f < hi)
            for hz in fl.HUM:
                s &= np.abs(f - hz) > 1.0
            a, b = mr[s, :, j], mt[s, :, j]
            use = 20 * np.log10(np.abs(a) / np.abs(a).max(axis=0, keepdims=True)) >= -20
            ddb = 20 * np.log10(np.abs(b) / np.abs(a)); dph = np.degrees(np.angle(b / a))
            row[nm] = {"median_db": round(float(np.median(ddb[use])), 3), "median_abs_db": round(float(np.median(np.abs(ddb[use]))), 3),
                       "p90_abs_db": round(float(np.percentile(np.abs(ddb[use]), 90)), 3),
                       "median_abs_deg": round(float(np.median(np.abs(dph[use]))), 2)}
        rep["frf_diff"][e] = row
    a, b = fit(f, Hr), fit(f, Ht)
    pairs = []
    used = set()
    for fa, za in a:
        k = min(((abs(fb - fa) / fa, i) for i, (fb, zb) in enumerate(b) if i not in used), default=None)
        if k and k[0] <= 0.01:
            used.add(k[1]); fb, zb = b[k[1]]
            pairs.append({"f_ref": round(fa, 2), "f_test": round(fb, 2), "df_pct": round(100 * (fb - fa) / fa, 3),
                          "z_ref": round(za, 2), "z_test": round(zb, 2), "dz_pp": round(zb - za, 3)})
    rep["modes"] = {"n_ref": len(a), "n_test": len(b), "matched": len(pairs),
                    "df_pct_median": round(float(np.median([p["df_pct"] for p in pairs])), 3) if pairs else None,
                    "abs_df_pct_median": round(float(np.median([abs(p["df_pct"]) for p in pairs])), 3) if pairs else None,
                    "dz_pp_median": round(float(np.median([p["dz_pp"] for p in pairs])), 3) if pairs else None,
                    "abs_dz_pp_median": round(float(np.median([abs(p["dz_pp"]) for p in pairs])), 3) if pairs else None,
                    "pairs": pairs}
    json.dump(rep, open(os.path.join(out, f"compare_{label}.json"), "w"), indent=1)
    print(json.dumps({k: v for k, v in rep.items() if k != "modes"}, indent=0))
    print(json.dumps({k: v for k, v in rep["modes"].items() if k != "pairs"}))
    return rep


if __name__ == "__main__":
    lab = sys.argv[sys.argv.index("--label") + 1] if "--label" in sys.argv else "levels"
    main(sys.argv[1], sys.argv[2], sys.argv[3], lab)
