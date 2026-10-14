"""dev-fd69 2026-10-14: coil currents as 7 extra response points - analysis of the all-inputs 7x7 capture.

Capture (`...-7x7-coils-p8`): In 1-7 = coil currents of E1-E7, In 8 = P8 (at E7); per exciter 3 x ESS
20 s 20 Hz-2 kHz (E1 -42, E2 -48, E3 -36, E4 -30, E5 -36, E6 -42, E7 -36 dBFS); no loopback.
Morning run (`...144226-fixed-layout-7x7`): P1-P7 on In 1-7, same exciters / outputs / levels (E2 -42).

1. Crosstalk model:
   * In 1-4 harness: I_k|j = c_kj * I_j + r_kj for j, k in 1..4 (complex scalar c_kj fitted on 600-2000 Hz,
     where back-EMF is weakest); spread of c_kj vs c_jk reported.
   * In 5-7 <- P8 line: I_k|j = a_k * P8|j + r_kj, a_k fitted per drive on 600-2000 Hz; the spread of a_k
     over drives tests "constant coupling = crosstalk".
   r_kj = residual = candidate back-EMF.
2. Broadband reciprocity on all 21 pairs (j, k): T_kj = r_kj / I_j vs T_jk = r_jk / I_k. Per band
   (25-200, 200-600, 600-2000 Hz): roughness of log|T_kj / T_jk| vs the individual transfers, and the
   correlation of their modal peak patterns. PASS = ratio roughness <= 0.6 x individual AND correlation >= 0.8.
3. Combined model (per volt): rows = morning P1-P7 + P8 + coil residuals r_k (only pairs/bands that pass);
   LSFD with the consensus poles < 200 Hz (20) and the morning 7x7 poles 200 Hz-1.1 kHz; per-row noise
   whitening; cross-exciter MAC (21 pairs) and AutoMAC with 7 rows vs all usable rows; 32.5 Hz shape on the
   board in mm. Cross-session check: pole consistency of the new rows (LSFD fit residual with the fixed poles).
Usage: python <this> <capture_dir> <morning_7x7_dir> <out_dir>
"""
import itertools
import json
import os
import sys

import numpy as np

FS = 48000
EXC = ["E1", "E2", "E3", "E4", "E5", "E6", "E7"]
NIR, PRE = 4 * FS, 30
CONS = r"D:\modal_measurements\rig_checks\consensus-lt200-20261014\consensus_lt200.json"
LAYOUT = r"D:\modal_measurements\rig_checks\layout-20261014\board_layout.json"
BANDS = ((25.0, 200.0), (200.0, 600.0), (600.0, 2000.0))
HUM = (50.0, 100.0, 150.0)


def frfs(run, fmax=2100.0):
    from pianoid_middleware.modal_adapter.measurement.ess import deconvolve, exp_sweep
    cfg = json.load(open(os.path.join(run, "config.json")))
    win = np.ones(NIR); nf = int(0.1 * NIR); win[-nf:] = 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, nf))
    f = np.fft.rfftfreq(NIR, 1 / FS); keep = f <= fmax
    Hs = None
    for j, e in enumerate(EXC):
        lv = cfg["levels"][e]; x = exp_sweep(20.0, 2000.0, 20.0, FS, lv)
        for r in range(3):
            y = np.load(os.path.join(run, "sessions", f"{e}_m{-lv}_r{r + 1}", "data.npy")).astype(float)
            h = np.roll(deconvolve(y, x, FS, (20.0, 2000.0)), PRE, axis=0)[:NIR] * win[:, None]
            Hr = np.fft.rfft(h, axis=0)[keep]
            if Hs is None:
                Hs = np.zeros((3, int(keep.sum()), Hr.shape[1], 7), complex)
            Hs[r, :, :, j] = Hr
    return f[keep], Hs


def hum_ok(f):
    return np.all([np.abs(f - h) > 1.0 for h in HUM], axis=0)


def smooth_oct(f, v, frac=3):
    return np.array([np.mean(v[(f >= fi * 2 ** (-0.5 / frac)) & (f <= fi * 2 ** (0.5 / frac))]) for fi in f])


def mac(a, b):
    return float(np.abs(np.vdot(a, b)) ** 2 / (np.vdot(a, a).real * np.vdot(b, b).real + 1e-300))


def lam_of(fz, z):
    w = 2 * np.pi * fz
    return -z * w + 1j * w * np.sqrt(1 - z * z)


def main(cap, morning, out):
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    from pianoid_middleware.modal_adapter.polymax.lsfd import lsfd
    os.makedirs(out, exist_ok=True)
    f, Hs = frfs(cap)                                  # (3, F, 8, 7): rows In1..In8
    H = Hs.mean(0); V = np.maximum(Hs.var(0) / 3, 1e-30)
    fit = (f >= 600) & (f <= 2000) & hum_ok(f)
    rep = {"crosstalk": {}, "reciprocity": {}, "combined": {}}
    R = H.copy()                                       # residual "back-EMF" rows (coil rows modified below)
    # 1a: In1-4 harness
    for j in range(4):
        for k in range(4):
            if k == j:
                continue
            c = np.vdot(H[fit, j, j], H[fit, k, j]) / np.vdot(H[fit, j, j], H[fit, j, j])
            R[:, k, j] = H[:, k, j] - c * H[:, j, j]
            rep["crosstalk"][f"I{k + 1}<-I{j + 1}"] = {"c_db": round(float(20 * np.log10(abs(c))), 1), "c_deg": round(float(np.degrees(np.angle(c))), 1)}
    # 1b: In5-7 <- P8 line, per drive
    for k in (4, 5, 6):
        al = {}
        for j in range(7):
            if j == k:
                continue
            a = np.vdot(H[fit, 7, j], H[fit, k, j]) / np.vdot(H[fit, 7, j], H[fit, 7, j])
            R[:, k, j] = H[:, k, j] - a * H[:, 7, j]
            al[EXC[j]] = (round(float(20 * np.log10(abs(a))), 1), round(float(np.degrees(np.angle(a))), 1))
        mags = [v[0] for v in al.values()]
        rep["crosstalk"][f"I{k + 1}<-P8"] = {"per_drive_db_deg": al, "mag_spread_db": round(float(max(mags) - min(mags)), 1)}
    # residual level vs raw and vs noise, per band (off-diagonal coil rows)
    lev = {}
    for lo, hi in BANDS:
        s = (f >= lo) & (f < hi) & hum_ok(f)
        raw, res, nz = [], [], []
        for j in range(7):
            for k in range(7):
                if k == j:
                    continue
                raw.append(np.median(20 * np.log10(np.abs(H[s, k, j]) / np.abs(H[s, j, j]))))
                res.append(np.median(20 * np.log10(np.abs(R[s, k, j]) / np.abs(H[s, j, j]))))
                nz.append(np.median(10 * np.log10(np.abs(R[s, k, j]) ** 2 / V[s, k, j])))
        lev[f"{lo:.0f}-{hi:.0f}"] = {"raw_re_drive_current_db": round(float(np.median(raw)), 1), "residual_re_drive_current_db": round(float(np.median(res)), 1),
                                     "residual_repeat_snr_db": round(float(np.median(nz)), 1)}
    rep["offdiag_levels"] = lev
    # 2: reciprocity
    passing = {}
    for a, b in itertools.combinations(range(7), 2):
        Tab = R[:, b, a] / H[:, a, a]; Tba = R[:, a, b] / H[:, b, b]
        row = {}
        for lo, hi in BANDS:
            s = (f >= lo) & (f < hi) & hum_ok(f)
            lr = 20 * np.log10(np.abs(Tab[s] / Tba[s])); la = 20 * np.log10(np.abs(Tab[s])); lb = 20 * np.log10(np.abs(Tba[s]))
            ra = la - smooth_oct(f[s], la); rb = lb - smooth_oct(f[s], lb)
            rr = float(np.std(lr - smooth_oct(f[s], lr))); ri = 0.5 * (np.std(ra) + np.std(rb)); c = float(np.corrcoef(ra, rb)[0, 1])
            ok = rr <= 0.6 * ri and c >= 0.8
            row[f"{lo:.0f}-{hi:.0f}"] = {"ratio_rough_db": round(rr, 2), "indiv_rough_db": round(float(ri), 2), "peak_corr": round(c, 2), "pass": bool(ok)}
            if ok:
                passing.setdefault(f"{lo:.0f}-{hi:.0f}", []).append((a, b))
        rep["reciprocity"][f"E{a + 1}<->E{b + 1}"] = row
    rep["reciprocity_pass_counts"] = {k: len(v) for k, v in passing.items()}
    # 3: combined model < 200 Hz with consensus poles, and 200-1100 with morning poles
    fm_, Hm_s = frfs(morning, fmax=2100.0) if os.path.exists(os.path.join(morning, "sessions")) else (None, None)
    Hm = Hm_s.mean(0); Vm = np.maximum(Hm_s.var(0) / 3, 1e-30)
    assert np.allclose(fm_, f)
    cons = json.load(open(CONS))["consensus"]
    mrep = json.load(open(os.path.join(morning, "report.json")))["modes"]
    sets = {"lt200": ([lam_of(x["f"], x["zeta_pct"] / 100) for x in cons], [x["f"] for x in cons], (25.0, 200.0)),
            "200-1100": ([lam_of(x["f"], x["zeta_pct"] / 100) for x in mrep if 200 <= x["f"] <= 1100], [x["f"] for x in mrep if 200 <= x["f"] <= 1100], (200.0, 1100.0))}
    L = json.load(open(LAYOUT))
    pos = {**{f"P{k}": L["piezos_green_mm"][str(k)] for k in range(1, 9)}, **{f"C{k}": L["exciters_red_mm"][str(k)] for k in range(1, 8)}}
    pairs = list(itertools.combinations(range(7), 2))
    for name, (lams, fz, (lo, hi)) in sets.items():
        s = (f >= lo) & (f <= hi) & hum_ok(f)
        band_key = "25-200" if name == "lt200" else None
        # coil rows usable: driving column of the own exciter excluded (driving current, not a sensor); columns of
        # exciters whose reciprocity with that coil did not pass are masked (zeroed with huge variance)
        rows = {"P1..P7": (Hm[s], Vm[s])}
        Cm = np.zeros((int(s.sum()), 7, 7), complex); Cv = np.full((int(s.sum()), 7, 7), 1e30)
        okpairs = set(passing.get(band_key, [])) if band_key else set()
        for k in range(7):
            for j in range(7):
                if j == k:
                    continue
                if (min(j, k), max(j, k)) in okpairs:
                    Cm[:, k, j] = R[s, k, j]; Cv[:, k, j] = V[s, k, j]
        used_coils = sorted({k for (a, b) in okpairs for k in (a, b)})
        P8 = H[s, 7:8, :]; P8v = V[s, 7:8, :]
        variants = {"7 piezos (morning)": (Hm[s], Vm[s], [f"P{k}" for k in range(1, 8)]),
                    "7 piezos + P8": (np.concatenate([Hm[s], P8], 1), np.concatenate([Vm[s], P8v], 1), [f"P{k}" for k in range(1, 9)])}
        if used_coils:
            Cu = Cm[:, used_coils, :]; Cuv = Cv[:, used_coils, :]
            variants["7 piezos + P8 + coils"] = (np.concatenate([Hm[s], P8, Cu], 1), np.concatenate([Vm[s], P8v, Cuv], 1),
                                                 [f"P{k}" for k in range(1, 9)] + [f"C{k + 1}" for k in used_coils])
        res = {}
        for vn, (Hx, Vx, labels) in variants.items():
            valid = Vx < 1e29                                   # masked coil paths (own drive / failed reciprocity)
            Vm_ = np.where(valid, Vx, np.nan)
            rowvar = np.nanmean(Vm_, axis=2)                      # per line, per row, over VALID columns only
            W = 1 / np.sqrt(rowvar)
            ft = lsfd(f[s], np.where(valid, Hx, 0), np.array(lams), W)   # LSFD residues are per path given the poles
            Rr = np.array(ft.residues)
            rs = np.sqrt(np.nanmedian(rowvar, axis=0)); Rw = Rr / rs[None, :, None]
            Rw = np.where(valid[0][None], Rw, 0)
            Mx = []
            for r in range(len(lams)):
                ms = []
                for i, j in pairs:
                    rr_ = [q for q in range(Rw.shape[1]) if Vx[0, q, i] < 1e29 and Vx[0, q, j] < 1e29]
                    ms.append(mac(Rw[r, rr_, i], Rw[r, rr_, j]))
                Mx.append(ms)
            Mx = np.array(Mx)
            # consensus shape per mode: rows weighted equally; masked paths are zero (SVD over the valid entries)
            psi = np.array([np.linalg.svd(Rw[r], full_matrices=False)[0][:, 0] for r in range(len(lams))])
            A = np.array([[mac(psi[i], psi[j]) for j in range(len(lams))] for i in range(len(lams))])
            offd = A[~np.eye(len(lams), dtype=bool)]
            res[vn] = {"rows": labels, "median_pair_mac": round(float(np.median(Mx)), 3),
                       "automac_offdiag_median_p95": [round(float(np.median(offd)), 3), round(float(np.percentile(offd, 95)), 3)],
                       "per_mode_median_pair_mac": {f"{x:.1f}": round(float(np.median(Mx[r])), 2) for r, x in enumerate(fz)}}
            if name == "lt200" and vn == list(variants)[-1]:
                r32 = int(np.argmin(np.abs(np.array(fz) - 32.67)))
                v = psi[r32] * np.exp(-1j * 0.5 * np.angle(np.sum(psi[r32] ** 2))); re = v.real / np.abs(v).max()
                xy = np.array([pos[lb] for lb in labels], float)
                fig, ax = plt.subplots(figsize=(7.5, 6.3))
                sc = ax.scatter(xy[:, 0], xy[:, 1], c=re, s=80 + 500 * np.abs(re), cmap="coolwarm", vmin=-1, vmax=1, edgecolors="k")
                for lb, (x0, y0) in zip(labels, xy):
                    ax.annotate(lb, (x0 + 20, y0 + 20), fontsize=7)
                Ex = np.array([L["exciters_red_mm"][str(k)] for k in range(1, 8)], float); ax.plot(Ex[:, 0], Ex[:, 1], "k^", ms=5, alpha=.5)
                ax.set_xlim(0, 1200); ax.set_ylim(0, 1000); ax.set_aspect("equal"); plt.colorbar(sc)
                ax.set_title(f"{fz[r32]:.2f} Hz consensus shape, {vn} (P = piezo, C = coil back-EMF)", fontsize=9)
                plt.tight_layout(); plt.savefig(os.path.join(out, "shape_32Hz_mm.png"), dpi=85); plt.close()
                res[vn]["shape_32Hz_real_norm"] = dict(zip(labels, np.round(re, 2).tolist()))
        rep["combined"][name] = {"band": [lo, hi], "used_coil_rows": [f"C{k + 1}" for k in used_coils], "variants": res}
    json.dump(rep, open(os.path.join(out, "coils_as_sensors.json"), "w"), indent=1)
    print(json.dumps({k: v for k, v in rep.items() if k not in ("reciprocity",)}, indent=0)[:12000])


if __name__ == "__main__":
    main(*sys.argv[1:4])
