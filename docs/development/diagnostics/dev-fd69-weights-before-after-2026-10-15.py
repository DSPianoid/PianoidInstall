"""dev-fd69 2026-10-15: what changed when weights were put on the exciters? + 32.5 Hz model test.

Data: B2 runs (15-200 Hz ESS x 2 per exciter, In 1-7 = coil currents, In 8 = P8 at E7), 10-14 (before)
`20261014T172451-B2-32hz-currents` and 10-15 (after) `20261015T114739-B2-weights` (b2_frf.npz: Y_E = I/V,
P8I_E = P8/I, P8V_E = P8/V, 0.125 Hz lines). Broadband before/after levels from the 7x7 coil captures
`20261014T183122-7x7-coils-p8` / `20261015T115434-7x7-coils-p8-weights`.

1. Inventory per exciter: every local minimum of |Y| and maximum of |P8/I| and |P8/V| in 18-200 Hz
   (prominence >= 1 dB), matched before -> after; level changes per band above 60 Hz.
2. Model test (inertial exciter on a board point; weights on the reaction mass):
     magnet M on suspension K_s = k_s + c_s s, coil force F = Bl I between board point and magnet,
     board point receptance R_b(s);  rho = M R_b,  kap = K_s / M:
       X_b/F = R_b s^2 / (s^2 + kap (1 + rho s^2)),   F_net/F = s^2 / (s^2 + kap (1 + rho s^2))
       Y = I/V = G / (1 + beta * s * [ (X_b/F) M s^2 + 1 ] / (s^2 + kap))     (beta = Bl^2 / (Re M))
       P8/I = F_net/F * s^2 * [ A_e * R_mode + D_e * R_res ]   (A_e, D_e complex, linear LS)
   Model A (no board mode near 32 Hz): R_b = c1 (complex constant: residual of all other modes).
   Model B: R_b = c1 + 1 / (m_b (w_b^2 - w^2 + 2j z_b w_b w))  with w_b, z_b SHARED by all exciters and
   both days. Day 2 = day 1 with M -> lam * M (k_s, c_s, Bl, Re, board unchanged):
   kap -> kap / lam, beta -> beta / lam, rho -> lam * rho.
   Per exciter (shared by both days): w_s1, z_s, beta1, c1 M1 (complex), mu = M1 / m_b (model B), lam,
   G (complex). Fit band 18-48 Hz (50 Hz hum excluded); profile over f_b (22-44 Hz) and z_b grid;
   SSR summed over exciters; AIC = n ln(SSR/n) + 2k.
Usage: python <this> <before_B2> <after_B2> <out_dir>
"""
import json
import os
import sys

import numpy as np
from scipy.optimize import least_squares
from scipy.signal import find_peaks

EXC = [f"E{k}" for k in range(1, 8)]
F_LO, F_HI = 18.0, 48.0


def load(run):
    z = np.load(os.path.join(run, "b2_frf.npz"))
    return z["f"], {e: (z[f"Y_{e}"], z[f"P8I_{e}"], z[f"P8V_{e}"]) for e in EXC}


def features(f, x, kind, lo=18.0, hi=200.0):
    s = (f >= lo) & (f <= hi) & (np.abs(f - 50) > 1.5) & (np.abs(f - 100) > 1.5) & (np.abs(f - 150) > 1.5)
    d = 20 * np.log10(np.abs(x[s]) + 1e-15)
    d = d if kind == "max" else -d
    k, p = find_peaks(d, prominence=1.0)
    return [(round(float(f[s][i]), 2), round(float(p["prominences"][j]), 1)) for j, i in enumerate(k)]


def match(a, b, tol=0.35):
    out, used = [], set()
    for fa, pa in a:
        c = [(abs(fb - fa) / fa, i) for i, (fb, pb) in enumerate(b) if i not in used]
        if c:
            d, i = min(c)
            if d <= tol:
                used.add(i); out.append((fa, b[i][0], round(100 * (b[i][0] - fa) / fa, 1), pa, b[i][1]))
                continue
        out.append((fa, None, None, pa, None))
    out += [(None, fb, None, None, pb) for i, (fb, pb) in enumerate(b) if i not in used]
    return out


# ---------------------------------------------------------------- model
def curves(p, s, wb, zb, model, day):
    ws, zs, beta1, c1r, c1i, mu, lam, gr, gi = p
    lam_d = 1.0 if day == 0 else lam
    kap = (ws ** 2 + 2 * zs * ws * s) / lam_d
    beta = beta1 / lam_d
    Rres = (c1r + 1j * c1i) * lam_d                       # M * c1  (scaled by M)
    Rmod = (mu * lam_d) / (wb ** 2 + s ** 2 + 2 * zb * wb * s) if model == "B" else 0 * s   # M / m_b * mode
    rho = Rres + Rmod
    den = s ** 2 + kap * (1 + rho * s ** 2)
    XbM = rho * s ** 2 / den                               # (X_b/F) * M
    Fnet = s ** 2 / den
    Hu = s * (XbM * s ** 2 + 1) / (s ** 2 + kap)
    Y = (gr + 1j * gi) / (1 + beta * Hu)
    return Y, Fnet, Rmod, Rres


def residual(p, s, data, wb, zb, model):
    out = []
    P8cols = []
    for day in (0, 1):
        Yd, Pd = data[day]
        Y, Fnet, Rmod, Rres = curves(p, s, wb, zb, model, day)
        ry = (Y - Yd) / np.median(np.abs(Yd))
        out += [ry.real, ry.imag]
        basis = [Fnet * s ** 2 * Rres] + ([Fnet * s ** 2 * Rmod] if model == "B" else [])
        P8cols.append((np.stack(basis, 1), Pd))
    Bm = np.concatenate([b for b, _ in P8cols]); Pv = np.concatenate([d for _, d in P8cols])
    coef, *_ = np.linalg.lstsq(Bm, Pv, rcond=None)
    rp = (Bm @ coef - Pv) / np.median(np.abs(Pv))
    out += [rp.real, rp.imag]
    return np.concatenate(out)


def fit_exciter(s, data, wb, zb, model, fs1_guess, lam_guess):
    best = None
    for zs0 in (0.1, 0.3):
        for b0 in (0.1,):
            p0 = [2 * np.pi * fs1_guess, zs0, b0 * 2 * np.pi * fs1_guess, 0.0, 0.0, 0.3, lam_guess,
                  float(np.median(np.abs(data[0][0]))), 0.0]
            lo = [2 * np.pi * 15, 0.01, 0, -50, -50, 0, 0.8, -np.inf, -np.inf]
            hi = [2 * np.pi * 70, 2.0, 1e4, 50, 50, 50, 4.0, np.inf, np.inf]
            try:
                r = least_squares(residual, p0, bounds=(lo, hi), args=(s, data, wb, zb, model), max_nfev=4000)
            except Exception:
                continue
            if best is None or r.cost < best.cost:
                best = r
    return best


def main(before, after, out):
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    os.makedirs(out, exist_ok=True)
    f, B = load(before); f2, A = load(after)
    assert np.allclose(f, f2)
    rep = {"inventory": {}, "levels_above_60": {}}
    # 1. inventory
    for e in EXC:
        inv = {}
        for nm, idx, kind in (("admittance_dips", 0, "min"), ("P8_per_ampere_peaks", 1, "max"), ("P8_per_volt_peaks", 2, "max")):
            inv[nm] = match(features(f, B[e][idx], kind), features(f, A[e][idx], kind))
        rep["inventory"][e] = inv
        lv = {}
        for lo, hi in ((60, 100), (100, 200)):
            s = (f >= lo) & (f < hi) & (np.abs(f - 100) > 1.5) & (np.abs(f - 150) > 1.5)
            lv[f"{lo}-{hi}"] = {q: round(float(np.median(20 * np.log10(np.abs(A[e][i][s]) / np.abs(B[e][i][s])))), 2)
                                for q, i in (("Y", 0), ("P8/I", 1), ("P8/V", 2))}
        rep["levels_above_60"][e] = lv
    # 2. model test
    s_mask = (f >= F_LO) & (f <= F_HI)
    ff = f[s_mask]; s = 2j * np.pi * ff
    data = {e: {0: (B[e][0][s_mask], B[e][1][s_mask]), 1: (A[e][0][s_mask], A[e][1][s_mask])} for e in EXC}
    fs_before = {"E1": 37.8, "E2": 31.8, "E3": 34.8, "E4": 37.6, "E5": 40.6, "E6": 37.0, "E7": 45.0}
    fs_after = {"E1": 28.0, "E2": 27.1, "E3": 32.6, "E4": 30.0, "E5": 28.6, "E6": 30.5, "E7": 34.9}
    resA = {e: fit_exciter(s, data[e], 0, 0, "A", fs_before[e], (fs_before[e] / fs_after[e]) ** 2) for e in EXC}
    ssrA = sum(2 * r.cost for r in resA.values()); kA = 7 * (9 - 1) + 7 * 2
    prof = []
    for fb in np.arange(22.0, 44.01, 1.0):
        for zb in (0.01, 0.02, 0.03, 0.05):
            rs = {e: fit_exciter(s, data[e], 2 * np.pi * fb, zb, "B", fs_before[e], (fs_before[e] / fs_after[e]) ** 2) for e in EXC}
            prof.append((fb, zb, sum(2 * r.cost for r in rs.values()), rs))
            print(f"f_b {fb:.1f} z_b {zb}: SSR {prof[-1][2]:.3f}  (model A {ssrA:.3f})", flush=True)
    fb_best, zb_best, ssrB, rsB = min(prof, key=lambda t: t[2])
    kB = 7 * 9 + 7 * 4 + 2
    nres = sum(len(residual(resA[e].x, s, data[e], 0, 0, "A")) for e in EXC)
    aic = lambda ssr, k: nres * np.log(ssr / nres) + 2 * k
    rep["model_test"] = {"band_hz": [F_LO, F_HI], "n_residuals": int(nres),
                         "A_no_board_mode": {"SSR": round(ssrA, 4), "k": kA, "AIC": round(float(aic(ssrA, kA)), 1),
                                             "lam_fit": {e: round(float(r.x[6]), 2) for e, r in resA.items()},
                                             "fs_before_fit": {e: round(float(r.x[0] / 2 / np.pi), 2) for e, r in resA.items()}},
                         "B_shared_board_mode": {"f_b": fb_best, "z_b": zb_best, "SSR": round(ssrB, 4), "k": kB, "AIC": round(float(aic(ssrB, kB)), 1),
                                                 "mu_fit": {e: round(float(r.x[5]), 3) for e, r in rsB.items()},
                                                 "lam_fit": {e: round(float(r.x[6]), 2) for e, r in rsB.items()},
                                                 "fs_before_fit": {e: round(float(r.x[0] / 2 / np.pi), 2) for e, r in rsB.items()}},
                         "profile": [(a, b, round(c, 4)) for a, b, c, _ in prof]}
    # per-exciter SSR A vs B at best f_b
    rep["model_test"]["per_exciter_SSR_A_vs_B"] = {e: (round(2 * resA[e].cost, 4), round(2 * rsB[e].cost, 4)) for e in EXC}
    json.dump(rep, open(os.path.join(out, "weights_before_after.json"), "w"), indent=1, default=str)
    # plots: data vs both models
    fig, axs = plt.subplots(4, 7, figsize=(26, 12), sharex=True)
    for i, e in enumerate(EXC):
        for day, col, lab in ((0, "C0", "10-14"), (1, "C3", "10-15")):
            Yd, Pd = data[e][day]
            axs[0, i].plot(ff, 20 * np.log10(np.abs(Yd) / np.median(np.abs(data[e][0][0]))), col, lw=1.2, label=f"{lab} data")
            axs[2, i].plot(ff, 20 * np.log10(np.abs(Pd)), col, lw=1.2, label=f"{lab} data")
            for mdl, r, ls in (("A", resA[e], ":"), ("B", rsB[e], "--")):
                wb = 2 * np.pi * fb_best if mdl == "B" else 0
                Y, Fnet, Rmod, Rres = curves(r.x, s, wb, zb_best, mdl, day)
                axs[0, i].plot(ff, 20 * np.log10(np.abs(Y) / np.median(np.abs(data[e][0][0]))), col, ls=ls, lw=.9, label=f"{lab} model {mdl}")
            axs[1, i].plot(ff, np.degrees(np.angle(Yd)), col, lw=1)
        axs[3, i].axis("off")
        axs[0, i].set_title(f"{e}: |I/V| (dB)", fontsize=8); axs[1, i].set_title("phase I/V (deg)", fontsize=8); axs[2, i].set_title("|P8/I| (dB)", fontsize=8)
        for a_ in axs[:3, i]:
            a_.axvline(32.5, color="k", ls=":", lw=.6); a_.grid(alpha=.3)
    axs[0, 0].legend(fontsize=6)
    pf = np.array([[a, b, c] for a, b, c, _ in prof])
    ax = axs[3, 0]; ax.axis("on")
    for zb in (0.01, 0.02, 0.03, 0.05):
        m = pf[:, 1] == zb; ax.plot(pf[m, 0], pf[m, 2], label=f"B, z_b {zb}")
    ax.axhline(ssrA, color="k", ls="--", label="A (no board mode)"); ax.set_xlabel("shared board-mode f_b (Hz)"); ax.set_ylabel("SSR"); ax.legend(fontsize=6)
    ax.set_title("profile: SSR vs f_b", fontsize=8)
    plt.tight_layout(); plt.savefig(os.path.join(out, "weights_model_test.png"), dpi=70)
    print(json.dumps({k: v for k, v in rep["model_test"].items() if k != "profile"}, indent=0))


if __name__ == "__main__":
    main(*sys.argv[1:4])
