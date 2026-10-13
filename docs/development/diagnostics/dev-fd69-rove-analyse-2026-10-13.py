"""Roving-piezo stitching + 4-reference PolyMAX (2026-10-13).

Assembles every placement_NN (rove_capture.py) into one FRF set:
  rows = 3 piezos x N placements (each normalised by ITS OWN session's coil current -> current-referenced,
         interface latency and any drive drift cancel) + 4 coil currents (mean over placements),
  refs = Out 1-4.
Runs PolyMAX on the piezo rows (hum lines 50/100/150 Hz excluded), LSFD residues on all rows,
cross-exciter shape agreement per mode (6 exciter pairs; rows = all piezo points + the 2 coils not
belonging to the pair), chance level, AutoMAC of the consensus shapes, mode-shape plots (board
coordinates from placement.json / rig.json when given).

Usage: python rove_analyse.py [--root DIR] [--placements 0,1,2] [--ref I|V] [--fmax 1100] [--no-prune]
Output: <root>/analysis_<time>/  (report.json, modes.npz, stabilization*.png, cross_exciter_mac.png,
        automac.png, shapes_*.png) and a one-line summary on stdout.
"""
import argparse, glob, itertools, json, os, sys, time
import numpy as np

sys.path.insert(0, r"D:\repos\wt-fd69-core")
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from pianoid_middleware.modal_adapter.polymax.identify import PolymaxConfig, identify
from pianoid_middleware.modal_adapter.polymax.lsfd import lsfd
from pianoid_middleware.modal_adapter.polymax.report import write_stabilization_plot

HERE = os.path.dirname(os.path.abspath(__file__))
OUTS = ["Out 1", "Out 2", "Out 3", "Out 4"]
PAIRS = list(itertools.combinations(range(4), 2))
HUM = (50.0, 100.0, 150.0)


def mac(a, b):
    return float(np.abs(np.vdot(a, b)) ** 2 / (np.vdot(a, a).real * np.vdot(b, b).real + 1e-300))


def load(root, which):
    dirs = sorted(glob.glob(os.path.join(root, "placement_*")))
    P = []
    for d in dirs:
        n = int(d[-2:])
        if which and n not in which:
            continue
        mp = os.path.join(d, "placement.json")
        if not os.path.exists(mp) or not os.path.exists(os.path.join(d, "frf.npz")):
            continue
        meta = json.load(open(mp)); z = np.load(os.path.join(d, "frf.npz"))
        if not meta["qc"]["pass"]:
            print(f"WARNING placement {n:02d} QC FAIL - included, check report", flush=True)
        P.append({"n": n, "meta": meta, "f": z["f"], "Hv": z["Hv"]})
    if not P:
        raise SystemExit("no placements found")
    return P


def assemble(P, ref):
    f = P[0]["f"]
    piezo_m, piezo_n, labels, coords, coil_m, coil_n = [], [], [], [], [], []
    for p in P:
        Hv = p["Hv"]
        own = np.stack([Hv[:, :, 3 + e, e] for e in range(4)], axis=-1)
        H = Hv / own[:, :, None, :] if ref == "I" else Hv
        m = H.mean(0); n = np.maximum(H.var(0) / 3, 1e-30)
        piezo_m.append(m[:, :3]); piezo_n.append(n[:, :3])
        coil_m.append(m[:, 3:]); coil_n.append(n[:, 3:])
        labels += [f"P{p['n']:02d}.In{k}" for k in (5, 6, 7)]
        c = p["meta"].get("coords")
        coords += c if c else [None] * 3
    Hp = np.concatenate(piezo_m, axis=1); Np = np.concatenate(piezo_n, axis=1)
    Hc = np.mean(coil_m, axis=0); Nc = np.mean(coil_n, axis=0) / len(P)
    H = np.concatenate([Hp, Hc], axis=1); N = np.concatenate([Np, Nc], axis=1)
    labels += ["coil1", "coil2", "coil3", "coil4"]
    return f, H, N, labels, coords


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.path.join(HERE, "rove-20261013"))
    ap.add_argument("--placements"); ap.add_argument("--ref", default="I", choices=["I", "V"])
    ap.add_argument("--fmax", type=float, default=1100.0); ap.add_argument("--no-prune", action="store_true")
    ap.add_argument("--p-max", type=int, default=40); ap.add_argument("--out")
    ap.add_argument("--drop", default="", help="comma list of piezo labels to leave out, e.g. P01.In5")
    a = ap.parse_args()
    which = [int(x) for x in a.placements.split(",")] if a.placements else None
    t0 = time.time()
    P = load(a.root, which)
    f, H, N, labels, coords = assemble(P, a.ref)
    drop = {d.strip() for d in a.drop.split(",") if d.strip()}
    if drop:
        keep = [k for k, l in enumerate(labels) if l not in drop]
        H, N = H[:, keep], N[:, keep]
        coords = [coords[k] for k in keep if k < len(coords)]
        labels = [labels[k] for k in keep]
    K = H.shape[1]; npz = K - 4; piezo = list(range(npz)); coil = list(range(npz, K))
    sel = (f >= 25) & (f <= a.fmax)
    for hz in HUM:
        sel &= np.abs(f - hz) > 1.0
    fr, Hm, Nm = f[sel], H[sel], N[sel]
    if a.ref == "I":
        for e in range(4):
            Hm[:, npz + e, e] = 0.0            # trivial I_e / I_e
    out = a.out or os.path.join(a.root, f"analysis_{time.strftime('%Y%m%dT%H%M%S')}")
    os.makedirs(out, exist_ok=True)
    cfg = PolymaxConfig(band_edges=(25.0, 60.0, 120.0, 200.0, 350.0, 600.0, a.fmax), p_max=a.p_max, prune=not a.no_prune)
    fit = identify(fr, Hm[:, piezo], cfg, Nm[:, piezo])
    write_stabilization_plot(fit, out, fr, Hm[:, piezo])
    modes = fit["modes"]
    fm = np.array([m["f_hz"] for m in modes]); zm = np.array([m["zeta"] for m in modes])
    lam = np.array([m["pole"] for m in modes])
    # LSFD on all rows per band
    W = 1 / np.sqrt(Nm.mean(axis=2))
    R = np.zeros((len(modes), K, 4), complex)
    for b in fit["bands"]:
        lo, hi, clo, chi = b["band"]; s = (fr >= lo) & (fr <= hi); u = (fm >= lo * 0.98) & (fm <= hi * 1.02)
        if not u.any():
            continue
        ft = lsfd(fr[s], Hm[s], lam[u], W[s])
        for k, i in enumerate(np.flatnonzero(u)):
            if clo <= fm[i] < chi:
                R[i] = ft.residues[k]
    rs = np.sqrt(np.median(Nm.mean(axis=2), axis=0)); Rw = R / rs[None, :, None]

    def rows_pair(i, j):
        return piezo + [npz + k for k in range(4) if k not in (i, j)]

    M = np.array([[mac(Rw[r, rows_pair(i, j), i], Rw[r, rows_pair(i, j), j]) for i, j in PAIRS] for r in range(len(modes))])
    part = np.array([[np.linalg.norm(Rw[r, piezo, e]) for e in range(4)] for r in range(len(modes))])
    part = part / np.maximum(part.max(axis=1, keepdims=True), 1e-300)
    rng = np.random.default_rng(0); ch = []
    for _ in range(4000):
        x, y = rng.choice(len(modes), 2, replace=False); i, j = PAIRS[rng.integers(6)]
        ch.append(mac(Rw[x, rows_pair(i, j), i], Rw[y, rows_pair(i, j), j]))
    chance = [round(float(np.median(ch)), 3), round(float(np.percentile(ch, 90)), 3)]
    # consensus shapes (piezo rows, whitened) + AutoMAC
    psi = np.zeros((len(modes), npz), complex)
    for r in range(len(modes)):
        U, S, Vh = np.linalg.svd(Rw[r][piezo], full_matrices=False)
        v = U[:, 0]; v = v * np.exp(-1j * np.angle(v[np.argmax(np.abs(v))]))
        psi[r] = v
    A = np.array([[mac(psi[i], psi[j]) for j in range(len(modes))] for i in range(len(modes))])

    def band_stats(lo, hi):
        s = (fm >= lo) & (fm < hi)
        gate_ok = []
        for r in np.flatnonzero(s):
            q = [k for k, (i, j) in enumerate(PAIRS) if part[r, i] >= 0.3 and part[r, j] >= 0.3]
            if q and M[r, q].min() >= 0.9:
                gate_ok.append(round(float(fm[r]), 1))
        offd = A[np.ix_(s, s)][~np.eye(int(s.sum()), dtype=bool)] if s.sum() > 1 else np.array([0.0])
        return {"n_modes": int(s.sum()),
                "median_pair_mac": round(float(np.median(M[s])), 3) if s.any() else None,
                "all6_ge_0.9": [round(float(x), 1) for x in fm[s & (M.min(axis=1) >= 0.9)]],
                "median6_ge_0.9": [round(float(x), 1) for x in fm[s & (np.median(M, axis=1) >= 0.9)]],
                "gated_all_ge_0.9": gate_ok,
                "automac_offdiag_median_p95": [round(float(np.median(offd)), 3), round(float(np.percentile(offd, 95)), 3)]}

    rep = {"placements": [p["n"] for p in P], "n_points_piezo": npz, "ref": a.ref, "fmax": a.fmax,
           "n_modes": len(modes), "zeta_pct_median_150_1k": round(100 * float(np.median(zm[(fm >= 150) & (fm < 1000)])), 2) if ((fm >= 150) & (fm < 1000)).any() else None,
           "chance_pair_mac_median_p90": chance, "lt200": band_stats(0, 200), "200_1k": band_stats(200, 1000),
           "qc": {p["n"]: p["meta"]["qc"]["pass"] for p in P},
           "modes": [{"f": round(float(fm[r]), 2), "zeta_pct": round(100 * float(zm[r]), 2), "stab": round(modes[r]["stability"], 2),
                      "part": np.round(part[r], 2).tolist(), "pair_mac": np.round(M[r], 2).tolist()} for r in range(len(modes))],
           "elapsed_s": None}
    np.savez(os.path.join(out, "modes.npz"), f=fm, zeta=zm, R=R, psi=psi, labels=np.array(labels), pair_mac=M, automac=A)
    # plots: MAC per mode, AutoMAC, shapes
    fig, ax = plt.subplots(1, 2, figsize=(16, 5))
    ax[0].semilogx(np.repeat(fm, 6), M.ravel(), ".", ms=4, alpha=.5, label="pair MAC")
    ax[0].semilogx(fm, np.median(M, axis=1), "k_", ms=10, label="median of 6")
    ax[0].axhline(chance[1], color="r", ls="--", lw=.8, label="chance p90"); ax[0].axhline(0.9, color="g", lw=.6)
    ax[0].set_xlim(25, a.fmax); ax[0].legend(fontsize=7)
    ax[0].set_title(f"Cross-exciter MAC, {len(P)} placements = {npz} piezo points + 2 coils ({a.ref}-ref)")
    im = ax[1].imshow(M.T, aspect="auto", vmin=0, vmax=1, cmap="viridis")
    ax[1].set_xticks(range(len(fm))); ax[1].set_xticklabels([f"{x:.0f}" for x in fm], rotation=90, fontsize=6)
    ax[1].set_yticks(range(6)); ax[1].set_yticklabels([f"{i+1}-{j+1}" for i, j in PAIRS]); plt.colorbar(im, ax=ax[1])
    plt.tight_layout(); plt.savefig(os.path.join(out, "cross_exciter_mac.png"), dpi=90); plt.close()
    fig, ax = plt.subplots(figsize=(9, 8))
    im = ax.imshow(A, vmin=0, vmax=1, cmap="viridis"); plt.colorbar(im)
    ax.set_xticks(range(len(fm))); ax.set_xticklabels([f"{x:.0f}" for x in fm], rotation=90, fontsize=6)
    ax.set_yticks(range(len(fm))); ax.set_yticklabels([f"{x:.0f}" for x in fm], fontsize=6)
    ax.set_title(f"AutoMAC of consensus shapes ({npz} piezo points)")
    plt.tight_layout(); plt.savefig(os.path.join(out, "automac.png"), dpi=90); plt.close()
    have_xy = all(c is not None for c in coords)
    rig = os.path.join(a.root, "rig.json"); exc = json.load(open(rig))["exciter_coords"] if os.path.exists(rig) else None
    sel_modes = list(np.flatnonzero(fm < 1000))
    for page in range(0, len(sel_modes), 20):
        idx = sel_modes[page:page + 20]
        fig, axs = plt.subplots(4, 5, figsize=(20, 14), squeeze=False)
        for ax, r in zip(axs.ravel(), idx):
            v = psi[r]; v = v * np.exp(-1j * 0.5 * np.angle(np.sum(v ** 2)))
            re = v.real / max(np.abs(v).max(), 1e-300)
            if have_xy:
                xy = np.array(coords)
                sc = ax.scatter(xy[:, 0], xy[:, 1], c=re, s=60 + 340 * np.abs(re), cmap="coolwarm", vmin=-1, vmax=1, edgecolors="k")
                if exc:
                    ex = np.array(exc); ax.plot(ex[:, 0], ex[:, 1], "k^", ms=8)
                    for k, (x, y) in enumerate(ex):
                        ax.annotate(f"E{k+1}", (x, y), fontsize=7)
                ax.set_aspect("equal")
            else:
                ax.bar(range(npz), re, color=["#c33" if x < 0 else "#36c" for x in re])
                ax.set_xticks(range(npz)); ax.set_xticklabels([l.split(".")[0][1:] + l[-1] for l in labels[:npz]], fontsize=5, rotation=90)
            ax.set_title(f"{fm[r]:.1f} Hz z{100 * zm[r]:.1f}% medMAC {np.median(M[r]):.2f}", fontsize=8)
        for ax in axs.ravel()[len(idx):]:
            ax.axis("off")
        fig.suptitle("Consensus mode shapes (real part, phase-aligned)" + ("" if have_xy else " - no coordinates: bars over piezo points"))
        plt.tight_layout(); plt.savefig(os.path.join(out, f"shapes_{page // 20 + 1}.png"), dpi=80); plt.close()
    rep["elapsed_s"] = round(time.time() - t0, 1)
    json.dump(rep, open(os.path.join(out, "report.json"), "w"), indent=1)
    l, h = rep["lt200"], rep["200_1k"]
    print(f"[{len(P)} placements, {npz} piezo pts + 4 coils, {a.ref}-ref] modes {len(modes)} (<200: {l['n_modes']}, 200-1k: {h['n_modes']}), "
          f"zeta 150-1k {rep['zeta_pct_median_150_1k']} % | <200 Hz: median pair MAC {l['median_pair_mac']}, all-6>=0.9 {len(l['all6_ge_0.9'])}/{l['n_modes']} {l['all6_ge_0.9']}, "
          f"median>=0.9 {len(l['median6_ge_0.9'])} | 200-1k: median {h['median_pair_mac']}, all-6>=0.9 {len(h['all6_ge_0.9'])}/{h['n_modes']}, median>=0.9 {len(h['median6_ge_0.9'])} | "
          f"chance {chance} | AutoMAC offdiag median/p95 <200 {l['automac_offdiag_median_p95']} | {rep['elapsed_s']} s -> {out}")


if __name__ == "__main__":
    main()
