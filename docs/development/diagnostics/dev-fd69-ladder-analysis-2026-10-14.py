"""dev-fd69 2026-10-14: level-dependence ladder (full 7x7 ESS at 0 / -6 / -12 dB re the 7x7 levels).

1. FRF change per volt vs the 0 dB run, per exciter and band (lines within 20 dB of each path's peak),
   incl. a 20-32 Hz band (where ESS and MIMO disagreed) and the same metrics for the 0 dB run vs the
   morning 7x7 run (time-drift control).
2. Mode tracking, model-free: CMIF (sv1 over all 49 paths) peaks per level, parabolic-interpolated
   frequency, half-power (-3 dB) damping estimate on sv1; peaks matched across levels (<= 0.5 %).
3. Mode tracking, PolyMAX: per-run fits (report.json from the 7x7 analysis), modes matched in all three
   levels (<= 1 %): df, dzeta vs level.
Usage: python <this> <ladder_prefix> <morning_7x7_run> <out_dir>
       (runs <prefix>-ladder-7x7-m0, -m6, -m12 must have been captured; PolyMAX reports are optional)
"""
import importlib.util
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("lc", os.path.join(HERE, "dev-fd69-level-compare-2026-10-14.py"))
lc = importlib.util.module_from_spec(spec); spec.loader.exec_module(lc)
fl = lc.fl
BANDS = ((20, 32, "20-32"), (32, 60, "32-60"), (60, 250, "60-250"), (250, 1000, "250-1k"), (1000, 2000, "1-2k"))
OFFS = (0, 6, 12)


def band_diff(f, a, b):
    out = {}
    for lo, hi, nm in BANDS:
        s = (f >= lo) & (f < hi)
        for hz in fl.HUM:
            s &= np.abs(f - hz) > 1.0
        A, B = a[s], b[s]
        use = 20 * np.log10(np.abs(A) / np.abs(A).max(axis=0, keepdims=True)) >= -20
        d = 20 * np.log10(np.abs(B) / np.abs(A))
        out[nm] = {"median_db": round(float(np.median(d[use])), 2), "median_abs_db": round(float(np.median(np.abs(d[use]))), 2)}
    return out


def cmif_peaks(f, H, lo=25, hi=1000):
    S = np.array([np.linalg.svd(H[i], compute_uv=False)[0] for i in range(len(f))])
    db = 20 * np.log10(S)
    from scipy.signal import find_peaks
    s = (f >= lo) & (f <= hi)
    idx = np.flatnonzero(s)
    pk, pr = find_peaks(db[idx], prominence=1.0)
    res = []
    for p in idx[pk]:
        if any(abs(f[p] - hz) <= 1.0 for hz in fl.HUM):
            continue
        y0, y1, y2 = db[p - 1], db[p], db[p + 1]
        dx = 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2) if (y0 - 2 * y1 + y2) != 0 else 0.0
        fp = f[p] + dx * (f[1] - f[0])
        # half-power width on sv1 (linear magnitude), interpolated
        target = y1 - 3.0
        l = p
        while l > 0 and db[l] > target:
            l -= 1
        r = p
        while r < len(f) - 1 and db[r] > target:
            r += 1
        if l == 0 or r == len(f) - 1:
            continue
        fl_ = np.interp(target, [db[l], db[l + 1]], [f[l], f[l + 1]])
        fr_ = np.interp(target, [db[r], db[r - 1]], [f[r], f[r - 1]])
        res.append((float(fp), float(100 * (fr_ - fl_) / (2 * fp))))
    return res


def main(prefix, morning, out):
    os.makedirs(out, exist_ok=True)
    runs = {o: f"{prefix}-ladder-7x7-m{o}" for o in OFFS}
    E = list(fl.EXC)
    F, M = {}, {}
    for o, r in runs.items():
        f, Hv, _ = lc.run_frfs(r, E)
        F[o] = f; M[o] = Hv.mean(0)
    fm_, Hm_, _ = lc.run_frfs(morning, E); Mm = Hm_.mean(0)
    f = F[0]
    rep = {"runs": runs, "frf_vs_m0": {}, "drift_m0_vs_morning": {}}
    for o in (6, 12):
        rep["frf_vs_m0"][f"-{o} dB"] = {e: band_diff(f, M[0][:, :, j], M[o][:, :, j]) for j, e in enumerate(E)}
    rep["drift_m0_vs_morning"] = {e: band_diff(f, Mm[:, :, j], M[0][:, :, j]) for j, e in enumerate(E)}
    # summary over exciters
    summ = {}
    for key, block in list(rep["frf_vs_m0"].items()) + [("drift", rep["drift_m0_vs_morning"])]:
        summ[key] = {nm: {"median_db_over_exciters": round(float(np.median([block[e][nm]["median_db"] for e in E])), 2),
                          "median_abs_db_over_exciters": round(float(np.median([block[e][nm]["median_abs_db"] for e in E])), 2)}
                     for _, _, nm in BANDS}
    rep["summary"] = summ
    # CMIF tracking
    pk = {o: cmif_peaks(f, M[o]) for o in OFFS}
    track = []
    for fp, z in pk[0]:
        row = {"f_0dB": round(fp, 3), "zeta_hp_0dB": round(z, 2)}
        okk = True
        for o in (6, 12):
            c = min(pk[o], key=lambda x: abs(x[0] - fp)) if pk[o] else None
            if c is None or abs(c[0] - fp) / fp > 0.005:
                okk = False; break
            row[f"df_pct_m{o}"] = round(100 * (c[0] - fp) / fp, 3); row[f"dz_pp_m{o}"] = round(c[1] - z, 2)
        if okk:
            track.append(row)
    rep["cmif_tracking"] = {"n_peaks_0dB": len(pk[0]), "tracked_all_levels": len(track),
                            "df_pct_m12_median": round(float(np.median([t["df_pct_m12"] for t in track])), 3) if track else None,
                            "abs_df_pct_m12_median": round(float(np.median([abs(t["df_pct_m12"]) for t in track])), 3) if track else None,
                            "dz_pp_m12_median": round(float(np.median([t["dz_pp_m12"] for t in track])), 2) if track else None,
                            "peaks": track}
    # PolyMAX tracking (if per-run reports exist)
    reps = {o: os.path.join(r, "report.json") for o, r in runs.items()}
    if all(os.path.exists(p) for p in reps.values()):
        mods = {o: [(m["f"], m["zeta_pct"]) for m in json.load(open(p))["modes"]] for o, p in reps.items()}
        pt = []
        for fa, za in mods[0]:
            row = {"f_0dB": fa, "z_0dB": za}; okk = True
            for o in (6, 12):
                c = min(mods[o], key=lambda x: abs(x[0] - fa))
                if abs(c[0] - fa) / fa > 0.01:
                    okk = False; break
                row[f"df_pct_m{o}"] = round(100 * (c[0] - fa) / fa, 3); row[f"dz_pp_m{o}"] = round(c[1] - za, 2)
            if okk:
                pt.append(row)
        rep["polymax_tracking"] = {"n_modes": {f"-{o}": len(v) for o, v in mods.items()}, "tracked_all_levels": len(pt),
                                   "abs_df_pct_m12_median": round(float(np.median([abs(t["df_pct_m12"]) for t in pt])), 3) if pt else None,
                                   "df_pct_m12_median": round(float(np.median([t["df_pct_m12"] for t in pt])), 3) if pt else None,
                                   "dz_pp_m12_median": round(float(np.median([t["dz_pp_m12"] for t in pt])), 2) if pt else None,
                                   "modes": pt,
                                   "lt200_lists": {f"-{o}": [round(x, 1) for x, _ in v if x < 200] for o, v in mods.items()}}
    json.dump(rep, open(os.path.join(out, "ladder_report.json"), "w"), indent=1)
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    fig, ax = plt.subplots(1, 3, figsize=(18, 4.8))
    for j, e in enumerate(E):
        for o, mk in ((6, "o-"), (12, "s--")):
            ax[0].plot(range(len(BANDS)), [rep["frf_vs_m0"][f"-{o} dB"][e][nm]["median_db"] for _, _, nm in BANDS], mk, ms=4, label=f"{e} -{o} dB" if o == 6 else None)
    ax[0].plot(range(len(BANDS)), [summ["drift"][nm]["median_db_over_exciters"] for _, _, nm in BANDS], "k:", lw=2, label="drift (0 dB vs morning)")
    ax[0].set_xticks(range(len(BANDS))); ax[0].set_xticklabels([nm for _, _, nm in BANDS]); ax[0].axhline(0, color="k", lw=.5)
    ax[0].set_ylabel("median dB (per volt) re 0 dB run"); ax[0].set_title("FRF change with drive level"); ax[0].legend(fontsize=6, ncol=2)
    if track:
        ax[1].semilogx([t["f_0dB"] for t in track], [t["df_pct_m6"] for t in track], "o", ms=4, label="-6 dB")
        ax[1].semilogx([t["f_0dB"] for t in track], [t["df_pct_m12"] for t in track], "s", ms=4, label="-12 dB")
        ax[2].semilogx([t["f_0dB"] for t in track], [t["dz_pp_m6"] for t in track], "o", ms=4, label="-6 dB")
        ax[2].semilogx([t["f_0dB"] for t in track], [t["dz_pp_m12"] for t in track], "s", ms=4, label="-12 dB")
    ax[1].axhline(0, color="k", lw=.5); ax[1].set(xlabel="Hz", ylabel="df % re 0 dB", title="CMIF peak frequency shift vs level")
    ax[2].axhline(0, color="k", lw=.5); ax[2].set(xlabel="Hz", ylabel="d zeta (pp, half-power)", title="CMIF peak damping change vs level")
    for a_ in ax[1:]:
        a_.legend(fontsize=7); a_.grid(alpha=.3)
    plt.tight_layout(); plt.savefig(os.path.join(out, "ladder.png"), dpi=85)
    print(json.dumps(summ, indent=0))
    print(json.dumps({k: v for k, v in rep["cmif_tracking"].items() if k != "peaks"}))
    if "polymax_tracking" in rep:
        print(json.dumps({k: v for k, v in rep["polymax_tracking"].items() if k != "modes"}))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
