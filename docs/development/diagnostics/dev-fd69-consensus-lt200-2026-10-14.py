"""dev-fd69 2026-10-14: consensus pole set below 200 Hz across the full 7x7 runs (analysis only).

Sources: morning fixed-layout 7x7 + ladder 0 / -6 / -12 dB (20 Hz-2 kHz ESS, 4 s IRs) and the LF run
(15-150 Hz ESS, 8 s IRs, used below 110 Hz). Per run: PolyMAX fits over a grid of settings (3 band-edge
sets x p_max 30/40) and bootstrap resamples of the 3 repeats (B per setting) -> pooled pole cloud.
Poles are clustered in frequency (single linkage, gap <= 0.6 %); a cluster is CONSENSUS if it is found
in >= MIN_RUNS of the 4 broadband runs (LF run counted separately) and in >= MIN_FRAC of all fits.
Shapes: LSFD with the consensus poles on each broadband run's mean FRF -> residues; cross-exciter MAC
(21 pairs, whitened rows) per run and median over runs; AutoMAC of consensus shapes; shape repeatability
across runs (MAC of the consensus shape between runs).
Usage: python <this> <out_dir> <run7x7> <ladder_m0> <ladder_m6> <ladder_m12> [--lf <lf_run>] [--B 2]
"""
import importlib.util
import itertools
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("fl", os.path.join(HERE, "dev-fd69-fixed-layout-2026-10-14.py"))
fl = importlib.util.module_from_spec(spec); spec.loader.exec_module(fl)
FLO, FHI = 25.0, 200.0
EDGES = ((25.0, 60.0, 120.0, 200.0), (25.0, 45.0, 90.0, 140.0, 200.0), (25.0, 70.0, 105.0, 160.0, 200.0))
PMAX = (30, 40)
GAP, MIN_RUNS, MIN_FRAC = 0.006, 3, 0.25


def load_run(run, nir=None, lf=False):
    from pianoid_middleware.modal_adapter.measurement.ess import deconvolve, exp_sweep
    cfg = json.load(open(os.path.join(run, "config.json")))
    if lf:
        F1, F2, T, NIR, fmax = 15.0, 150.0, 30.0, 8 * fl.FS, 160.0
    else:
        F1, F2, T, NIR, fmax = fl.F1, fl.F2, fl.T, fl.NIR, 260.0
    win = np.ones(NIR); nf = int(0.1 * NIR); win[-nf:] = 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, nf))
    f = np.fft.rfftfreq(NIR, 1 / fl.FS); keep = f <= fmax
    bad = {(x["exciter"], x["rep"]) for x in cfg.get("flags", []) if x.get("xruns")}
    reps = [[] for _ in range(7)]
    for j, e in enumerate(fl.EXC):
        lv = cfg["levels"][e]; x = exp_sweep(F1, F2, T, fl.FS, lv)
        for r in range(3):
            if (e, r + 1) in bad:
                continue
            y = np.load(os.path.join(run, "sessions", f"{e}_m{-lv}_r{r + 1}", "data.npy")).astype(float)
            h = np.roll(deconvolve(y, x, fl.FS, (F1, F2)), fl.PRE, axis=0)[:NIR] * win[:, None]
            reps[j].append(np.fft.rfft(h, axis=0)[keep])
    return f[keep], reps


def sel_mask(f, lo, hi):
    s = (f >= lo) & (f <= hi)
    for hz in fl.HUM:
        s &= np.abs(f - hz) > 1.0
    return s


def mean_var(reps, idx=None):
    m = np.stack([np.mean([reps[j][i] for i in (idx[j] if idx else range(len(reps[j])))], axis=0) for j in range(7)], axis=-1)
    v = np.stack([np.var([reps[j][i] for i in range(len(reps[j]))], axis=0) / len(reps[j]) for j in range(7)], axis=-1)
    return m, np.maximum(v, 1e-30)


def fits_for_run(f, reps, hi, B, rng):
    from pianoid_middleware.modal_adapter.polymax.identify import PolymaxConfig, identify
    s = sel_mask(f, FLO, hi)
    poles = []
    for b in range(B + 1):
        idx = None if b == 0 else [list(rng.integers(0, len(reps[j]), len(reps[j]))) for j in range(7)]
        m, v = mean_var(reps, idx)
        for edges in EDGES:
            ed = tuple(x for x in edges if x < hi) + (hi,)
            for pm in PMAX:
                fit = identify(f[s], m[s], PolymaxConfig(band_edges=ed, p_max=pm, prune=True), v[s])
                poles.append([(x["f_hz"], x["zeta"], x["pole"]) for x in fit["modes"]])
    return poles


def cluster(points):
    pts = sorted(points, key=lambda p: p[0])
    cl, cur = [], [pts[0]]
    for p in pts[1:]:
        if (p[0] - cur[-1][0]) / p[0] <= GAP:
            cur.append(p)
        else:
            cl.append(cur); cur = [p]
    cl.append(cur)
    return cl


def main(out, runs, lf=None, B=2):
    from pianoid_middleware.modal_adapter.polymax.lsfd import lsfd
    os.makedirs(out, exist_ok=True)
    rng = np.random.default_rng(7)
    data, allp, nfits = {}, [], {}
    t0 = time.time()
    for name, run in runs.items():
        f, reps = load_run(run)
        data[name] = (f, reps)
        P = fits_for_run(f, reps, FHI, B, rng)
        nfits[name] = len(P)
        for k, fit in enumerate(P):
            allp += [(fz, z, lam, name, k) for fz, z, lam in fit]
        print(name, "fits", len(P), "poles", sum(len(x) for x in P), f"{time.time() - t0:.0f} s", flush=True)
    lfp = []
    if lf:
        f_lf, reps_lf = load_run(lf, lf=True)
        P = fits_for_run(f_lf, reps_lf, 110.0, B, rng)
        nfits["LF"] = len(P)
        lfp = [(fz, z, lam, "LF", k) for k, fit in enumerate(P) for fz, z, lam in fit]
        print("LF fits", len(P), "poles", len(lfp), flush=True)
    total = sum(v for k, v in nfits.items() if k != "LF")
    cls = cluster(allp)
    cons = []
    for c in cls:
        rn = {p[3] for p in c}
        nf_ = len({(p[3], p[4]) for p in c})
        fz = np.array([p[0] for p in c]); zz = np.array([p[1] for p in c])
        med = float(np.median(fz))
        lf_hits = [p for p in lfp if abs(p[0] - med) / med <= 2 * GAP] if med < 110 else []
        entry = {"f": round(med, 2), "f_iqr_pct": round(float(100 * np.subtract(*np.percentile(fz, [75, 25])) / med), 3),
                 "zeta_pct": round(float(100 * np.median(zz)), 2), "zeta_iqr_pp": round(float(100 * np.subtract(*np.percentile(zz, [75, 25]))), 2),
                 "runs": sorted(rn), "n_runs": len(rn), "fit_frac": round(nf_ / total, 2),
                 "lf_run_frac": round(len({p[4] for p in lf_hits}) / nfits["LF"], 2) if lf and med < 110 else None,
                 "lam": complex(np.median([p[2].real for p in c]), np.median([p[2].imag for p in c]))}
        entry["consensus"] = entry["n_runs"] >= MIN_RUNS and entry["fit_frac"] >= MIN_FRAC
        cons.append(entry)
    # LF-only clusters below 60 Hz (poles the LF run finds but broadband runs do not)
    lf_only = []
    if lfp:
        for c in cluster([p for p in lfp if p[0] < 110]):
            med = float(np.median([p[0] for p in c]))
            if not any(abs(x["f"] - med) / med <= 2 * GAP for x in cons):
                lf_only.append({"f": round(med, 2), "zeta_pct": round(float(100 * np.median([p[1] for p in c])), 2),
                                "lf_fit_frac": round(len({p[4] for p in c}) / nfits["LF"], 2)})
    C = [x for x in cons if x["consensus"]]
    lam = np.array([x["lam"] for x in C])
    # shapes per run with the consensus poles
    pairs = list(itertools.combinations(range(7), 2))
    Ms, PS = [], []
    for name, (f, reps) in data.items():
        m, v = mean_var(reps); s = sel_mask(f, FLO, FHI)
        W = 1 / np.sqrt(v[s].mean(axis=2))
        R = np.array(lsfd(f[s], m[s], lam, W).residues)
        rs = np.sqrt(np.median(v[s].mean(axis=2), axis=0)); Rw = R / rs[None, :, None]
        Ms.append([[fl.mac(Rw[r, :, i], Rw[r, :, j]) for i, j in pairs] for r in range(len(C))])
        PS.append([np.linalg.svd(Rw[r], full_matrices=False)[0][:, 0] for r in range(len(C))])
    Ms = np.array(Ms); PS = np.array(PS)                      # (runs, modes, 21), (runs, modes, 7)
    rep_shape = [float(np.median([fl.mac(PS[a, r], PS[b, r]) for a, b in itertools.combinations(range(len(PS)), 2)])) for r in range(len(C))]
    psi = PS[0]
    A = np.array([[fl.mac(psi[i], psi[j]) for j in range(len(C))] for i in range(len(C))])
    rngc = np.random.default_rng(0); ch = []
    for _ in range(3000):
        a, b = rngc.choice(len(C), 2, replace=False); i, j = pairs[rngc.integers(21)]
        k = rngc.integers(len(PS))
        ch.append(float(np.median(Ms[k, a]) * 0 + fl.mac(PS[k, a], PS[k, b])))   # shape-vs-shape chance on 7 rows
    for r, x in enumerate(C):
        x["pair_mac_median_over_runs"] = round(float(np.median(Ms[:, r, :])), 2)
        x["shape_repeat_mac_across_runs"] = round(rep_shape[r], 2)
    offd = A[~np.eye(len(C), dtype=bool)] if len(C) > 1 else np.array([0.0])
    rep = {"runs": runs, "lf_run": lf, "fits_per_run": nfits, "gap_pct": 100 * GAP, "min_runs": MIN_RUNS, "min_fit_frac": MIN_FRAC,
           "n_clusters": len(cons), "n_consensus": len(C),
           "median_pair_mac_consensus": round(float(np.median(Ms)), 3),
           "median_shape_repeat_mac": round(float(np.median(rep_shape)), 3),
           "automac_offdiag_median_p95": [round(float(np.median(offd)), 3), round(float(np.percentile(offd, 95)), 3)],
           "shape_chance_mac_median_p90": [round(float(np.median(ch)), 3), round(float(np.percentile(ch, 90)), 3)],
           "consensus": [{k: v for k, v in x.items() if k != "lam"} for x in C],
           "non_consensus": [{k: v for k, v in x.items() if k != "lam"} for x in cons if not x["consensus"]],
           "lf_only_clusters": lf_only}
    json.dump(rep, open(os.path.join(out, "consensus_lt200.json"), "w"), indent=1)
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    fig, ax = plt.subplots(1, 2, figsize=(17, 5), gridspec_kw={"width_ratios": [2, 1]})
    names = list(runs) + (["LF"] if lf else [])
    for k, nm in enumerate(names):
        pts = [p for p in (allp if nm != "LF" else lfp) if p[3] == nm]
        ax[0].plot([p[0] for p in pts], [100 * p[1] for p in pts], ".", ms=3, alpha=.35, label=nm)
    for x in C:
        ax[0].axvline(x["f"], color="k", lw=.6)
    for t in (32.6, 35.6, 47.8, 57.9, 59.1):
        ax[0].axvline(t, color="r", lw=.6, ls=":")
    ax[0].set(xlim=(FLO, FHI), ylim=(0, 8), xlabel="Hz", ylabel="zeta %", title="Pooled poles (all fits); black = consensus, red dotted = 10-12/10-13 targets")
    ax[0].legend(fontsize=7, markerscale=3)
    im = ax[1].imshow(A, vmin=0, vmax=1, cmap="viridis"); plt.colorbar(im, ax=ax[1])
    ax[1].set_xticks(range(len(C))); ax[1].set_xticklabels([f"{x['f']:.0f}" for x in C], rotation=90, fontsize=7)
    ax[1].set_yticks(range(len(C))); ax[1].set_yticklabels([f"{x['f']:.0f}" for x in C], fontsize=7); ax[1].set_title("AutoMAC, consensus shapes")
    plt.tight_layout(); plt.savefig(os.path.join(out, "consensus_lt200.png"), dpi=85)
    print(json.dumps({k: v for k, v in rep.items() if k not in ("consensus", "non_consensus")}, indent=0, default=str))
    for x in rep["consensus"]:
        print(x)
    print("non-consensus:", [(x["f"], x["n_runs"], x["fit_frac"]) for x in rep["non_consensus"]])


if __name__ == "__main__":
    a = sys.argv[1:]
    out = a[0]; rr = a[1:5]
    lf = a[a.index("--lf") + 1] if "--lf" in a else None
    B = int(a[a.index("--B") + 1]) if "--B" in a else 2
    main(out, dict(zip(("7x7_morning", "ladder_0", "ladder_m6", "ladder_m12"), rr)), lf, B)
