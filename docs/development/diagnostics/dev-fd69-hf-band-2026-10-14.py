"""dev-fd69 2026-10-14: 1-2 kHz analysis of a 7x7 fixed-layout run (no capture).

Reuses dev-fd69-fixed-layout-2026-10-14.py (FRFs from the saved sessions, F <= 2100 Hz), PolyMAX on
1-2 kHz sub-bands (hum not relevant), LSFD residues, cross-exciter MAC (21 pairs, whitened rows),
chance level, AutoMAC, damping. Outputs <run>/hf_1-2k/{report.json, modes.npz, stabilization.png,
cross_exciter_mac.png, automac.png}.
Usage: python <this> <run_dir> [fmin fmax]
"""
import importlib.util
import itertools
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("fl", os.path.join(HERE, "dev-fd69-fixed-layout-2026-10-14.py"))
fl = importlib.util.module_from_spec(spec); spec.loader.exec_module(fl)


def main(run, fmin=1000.0, fmax=2000.0):
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    from pianoid_middleware.modal_adapter.polymax.identify import PolymaxConfig, identify
    from pianoid_middleware.modal_adapter.polymax.lsfd import lsfd
    from pianoid_middleware.modal_adapter.polymax.report import write_stabilization_plot
    out = os.path.join(run, f"hf_{int(fmin)}-{int(fmax)}")
    os.makedirs(out, exist_ok=True)
    fl.FMAX = fmax + 100.0
    cfg = json.load(open(os.path.join(run, "config.json")))
    f, Hv = fl.frfs(run, cfg)
    m = Hv.mean(0); var = np.maximum(Hv.var(0) / Hv.shape[0], 1e-30)
    snr = 10 * np.log10(np.abs(m) ** 2 / var)
    sel = (f >= fmin) & (f <= fmax)
    fr, Hm, Nm = f[sel], m[sel], var[sel]
    edges = tuple(np.linspace(fmin, fmax, 6))
    fit = identify(fr, Hm, PolymaxConfig(band_edges=edges, p_max=40, prune=True), Nm)
    write_stabilization_plot(fit, out, fr, Hm)
    modes = fit["modes"]
    fm = np.array([x["f_hz"] for x in modes]); zm = np.array([x["zeta"] for x in modes]); lam = np.array([x["pole"] for x in modes])
    W = 1 / np.sqrt(Nm.mean(axis=2)); R = np.zeros((len(modes), 7, 7), complex)
    for b in fit["bands"]:
        lo, hi, clo, chi = b["band"]; s = (fr >= lo) & (fr <= hi); u = (fm >= lo * 0.98) & (fm <= hi * 1.02)
        if not u.any():
            continue
        ft = lsfd(fr[s], Hm[s], lam[u], W[s])
        for k, i in enumerate(np.flatnonzero(u)):
            if clo <= fm[i] < chi:
                R[i] = ft.residues[k]
    rs = np.sqrt(np.median(Nm.mean(axis=2), axis=0)); Rw = R / rs[None, :, None]
    pairs = list(itertools.combinations(range(7), 2))
    M = np.array([[fl.mac(Rw[r, :, i], Rw[r, :, j]) for i, j in pairs] for r in range(len(modes))])
    psi = np.array([np.linalg.svd(Rw[r], full_matrices=False)[0][:, 0] for r in range(len(modes))])
    A = np.array([[fl.mac(psi[i], psi[j]) for j in range(len(modes))] for i in range(len(modes))])
    rng = np.random.default_rng(0); ch = []
    for _ in range(4000):
        a, b2 = rng.choice(len(modes), 2, replace=False); i, j = pairs[rng.integers(21)]
        ch.append(fl.mac(Rw[a, :, i], Rw[b2, :, j]))
    offd = A[~np.eye(len(modes), dtype=bool)]
    # CMIF rank: fraction of lines where sv2/sv1 > -6 dB (several modes active at once)
    S = np.array([np.linalg.svd(Hm[i], compute_uv=False) for i in range(len(fr))])
    rep = {"band": [fmin, fmax], "n_modes": len(modes), "modes_per_100Hz": round(100 * len(modes) / (fmax - fmin), 2),
           "zeta_pct_median": round(100 * float(np.median(zm)), 2) if len(zm) else None,
           "repeat_snr_db_median": round(float(np.median(snr[sel])), 1),
           "median_pair_mac": round(float(np.median(M)), 3), "modes_median_mac_ge_0.9": [round(float(x), 1) for x in fm[np.median(M, axis=1) >= 0.9]],
           "chance_median_p90": [round(float(np.median(ch)), 3), round(float(np.percentile(ch, 90)), 3)],
           "automac_offdiag_median_p95": [round(float(np.median(offd)), 3), round(float(np.percentile(offd, 95)), 3)],
           "automac_pairs_ge_0.8": int(np.sum(np.triu(A, 1) >= 0.8)),
           "cmif_sv2_over_sv1_db_median": round(float(np.median(20 * np.log10(S[:, 1] / S[:, 0]))), 1),
           "modes": [{"f": round(float(fm[r]), 2), "zeta_pct": round(100 * float(zm[r]), 2), "stab": round(modes[r]["stability"], 2),
                      "median_pair_mac": round(float(np.median(M[r])), 2)} for r in range(len(modes))]}
    json.dump(rep, open(os.path.join(out, "report.json"), "w"), indent=1)
    np.savez(os.path.join(out, "modes.npz"), f=fm, zeta=zm, R=R, psi=psi, pair_mac=M, automac=A)
    fig, ax = plt.subplots(1, 2, figsize=(17, 5))
    ax[0].plot(np.repeat(fm, 21), M.ravel(), ".", ms=3, alpha=.4); ax[0].plot(fm, np.median(M, axis=1), "k_", ms=10)
    ax[0].axhline(rep["chance_median_p90"][1], color="r", ls="--", lw=.8); ax[0].set_title(f"Cross-exciter MAC {fmin:.0f}-{fmax:.0f} Hz (median: black)")
    im = ax[1].imshow(A, vmin=0, vmax=1, cmap="viridis"); plt.colorbar(im, ax=ax[1]); ax[1].set_title("AutoMAC of consensus shapes (7 piezos)")
    ax[1].set_xticks(range(len(fm))); ax[1].set_xticklabels([f"{x:.0f}" for x in fm], rotation=90, fontsize=5)
    plt.tight_layout(); plt.savefig(os.path.join(out, "mac_automac.png"), dpi=85); plt.close()
    print(json.dumps({k: v for k, v in rep.items() if k != "modes"}, indent=0))
    print("modes:", [(x["f"], x["zeta_pct"], x["median_pair_mac"]) for x in rep["modes"]])


if __name__ == "__main__":
    a = sys.argv[1:]
    main(a[0], *(float(x) for x in a[1:3]))
