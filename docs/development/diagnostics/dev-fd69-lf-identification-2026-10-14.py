"""dev-fd69 2026-10-14: dedicated low-frequency identification (18-110 Hz), 7 exciters x 7 piezos.

Targets: the < 60 Hz modes the 7x7 run missed (32.6/33.0, 35.6/36.2, 47.8, 57.9/58.7/59.1 Hz).
capture: silence 12 s; per exciter an 8 s LF ESS precheck ramp -36 / -30 / -24 dBFS (peak + ESS H2/H3,
  the LF harmonic windows carry a level-independent floor, so the ramp stops on GROWTH: H2 or H3 up
  >= 4 dB for a 6 dB step while above -26 dB re linear, or peak > -12 dBFS); then 3 x ESS 30 s
  15-150 Hz (+4 s tail) at the final level. Loopback marker Out 8 -> In 8; output map as the 7x7 run.
analyse: FRFs from 8 s IRs (0.125 Hz lines, 18-110 Hz, 50/100 Hz +-1.5 Hz excluded);
  fit 1 = PolyMAX on LF sub-bands; fit 2 = CMIF peak-picking + single-mode fit (pole + residual
  terms) on each peak's enhanced FRF; shapes (7 piezos), cross-exciter MAC, chance; targets table.
Usage: python <this> capture <out>  |  python <this> analyse <out>
"""
import itertools
import json
import os
import sys
import time

import numpy as np

FS = 48000
F1, F2, T, POST, TCHK = 15.0, 150.0, 30.0, 4.0, 8.0
EXC = {"E1": "Out 9", "E2": "Out 10", "E3": "Out 3", "E4": "Out 4", "E5": "Out 5", "E6": "Out 6", "E7": "Out 7"}
RAMP = (-36, -30, -24)          # precheck ramp, every exciter; the highest passing level is used
PIEZO = [f"In {k}" for k in range(1, 8)]
GUARD, STOP, HMAX, GROW_STOP, NREP = -12.0, -3.0, -26.0, 4.0, 3   # stop the ramp if H2/H3 grow >= 4 dB per 6 dB step and exceed -26 dB
NIR, PRE = 8 * FS, 30
FLO, FHI = 18.0, 110.0
HUM = ((50.0, 1.5), (100.0, 1.5))
TARGETS = [32.6, 33.0, 35.6, 36.2, 47.8, 57.9, 58.7, 59.1, 62.4, 64.7, 67.8, 72.0, 76.2, 80.8, 85.6, 94.7]
LAYOUT = r"D:\modal_measurements\rig_checks\layout-20261014\board_layout.json"


def capture(out):
    from pianoid_middleware.modal_adapter.measurement.ess import exp_sweep
    from pianoid_middleware.modal_adapter.swept_discovery.audio_io import SessionAudioIO
    from pianoid_middleware.modal_adapter.swept_discovery.rig_checks import harmonic_distortion
    os.makedirs(out, exist_ok=True)
    io = SessionAudioIO(os.path.join(out, "sessions"), loopback=("Out 8", "In 8"))
    cfg = {"time": time.strftime("%Y-%m-%dT%H:%M:%S"), "exciter_outputs": EXC, "piezos": PIEZO, "sync": "Out 8 -> In 8",
           "monitor_only": ["Out 1", "Out 2"], "ess": [F1, F2, T, POST], "precheck_s": TCHK, "levels": {}, "precheck": [], "flags": []}
    sil, _ = io.record(12.0, PIEZO, "silence")
    t0 = time.time()
    for e, o in EXC.items():
        lv, prev = None, None
        for cand in RAMP:
            x = exp_sweep(F1, F2, TCHK, FS, cand)
            y, m = io.play_record(x, o, PIEZO, 0.0, 2.0, f"{e}_chk_m{-cand}")
            pk = float(20 * np.log10(np.abs(y).max() + 1e-12))
            hd = harmonic_distortion(y, x, (F1, F2, TCHK), noise=sil, ir_s=1.5, win_s=0.5)
            h2, h3 = float(np.median(hd["h2_db"])), float(np.median(hd["h3_db"]))
            # at LF the harmonic windows hold a LEVEL-INDEPENDENT floor (band-edge ringing / FRF tilt, measured:
            # E1 H2 -19.9 at -36 and -19.1 at -42 dBFS); real distortion GROWS with drive -> stop only on growth
            grow = None if prev is None else max(h2 - prev[0], h3 - prev[1])
            ok = pk <= GUARD and not (grow is not None and grow >= GROW_STOP and max(h2, h3) > HMAX)
            cfg["precheck"].append({"exciter": e, "level": cand, "peak": pk, "h2_median_db": h2, "h3_median_db": h3,
                                    "h2_noise_median_db": float(np.median(hd["h2_noise_db"])), "growth_db": grow, "ok": ok, "xruns": m.get("xruns")})
            print(f"{e} ({o}) check {cand} dBFS: peak {pk:.1f}, H2 {h2:.1f}, H3 {h3:.1f} dB (noise {np.median(hd['h2_noise_db']):.1f}), growth {grow} -> {'ok' if ok else 'STOP'}", flush=True)
            if not ok:
                break
            lv, prev = cand, (h2, h3)
        if lv is None:
            lv = RAMP[0] - 6
        for r in range(1, NREP + 1):
            y, m = io.play_record(exp_sweep(F1, F2, T, FS, lv), o, PIEZO, 0.0, POST, f"{e}_m{-lv}_r{r}")
            pk = float(20 * np.log10(np.abs(y).max() + 1e-12))
            if pk > STOP or m.get("xruns") or m.get("status") != "ok":
                cfg["flags"].append({"exciter": e, "rep": r, "peak": pk, "xruns": m.get("xruns"), "status": m.get("status")})
            print(f"{e} r{r} {lv} dBFS peak {pk:.1f} xruns {m.get('xruns')} ({time.time() - t0:.0f} s)", flush=True)
        cfg["levels"][e] = lv
    cfg["sessions"] = io.sessions
    json.dump(cfg, open(os.path.join(out, "config.json"), "w"), indent=1, default=str)


def mac(a, b):
    return float(np.abs(np.vdot(a, b)) ** 2 / (np.vdot(a, a).real * np.vdot(b, b).real + 1e-300))


def sdof_fit(f, e, f0):
    """Single-mode fit on an enhanced FRF e(f): A/(jw - lam) + conj term + B + C/(jw)^2 over f0 +- 6 %."""
    from scipy.optimize import least_squares
    s = (f > f0 * 0.94) & (f < f0 * 1.06)
    w = 2j * np.pi * f[s]; y = e[s]

    def model(p):
        fn, z = p[0], p[1]
        lam = -z * 2 * np.pi * fn + 1j * 2 * np.pi * fn * np.sqrt(max(1 - z * z, 1e-9))
        A = p[2] + 1j * p[3]
        return A / (w - lam) + np.conj(A) / (w - np.conj(lam)) + (p[4] + 1j * p[5]) + (p[6] + 1j * p[7]) / w ** 2

    sc = np.abs(y).max()
    p0 = [f0, 0.03, 0.0, -sc * 2 * np.pi * f0 * 0.03, 0, 0, 0, 0]
    r = least_squares(lambda p: np.concatenate([(model(p) - y).real, (model(p) - y).imag]) / sc, p0,
                      bounds=([f0 * 0.96, 0.002, -np.inf, -np.inf, -np.inf, -np.inf, -np.inf, -np.inf],
                              [f0 * 1.04, 0.15, np.inf, np.inf, np.inf, np.inf, np.inf, np.inf]))
    res = np.linalg.norm(model(r.x) - y) / np.linalg.norm(y)
    return float(r.x[0]), float(r.x[1]), float(res)


def analyse(out):
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    from scipy.signal import find_peaks
    from pianoid_middleware.modal_adapter.measurement.ess import deconvolve, exp_sweep
    from pianoid_middleware.modal_adapter.polymax.identify import PolymaxConfig, identify
    from pianoid_middleware.modal_adapter.polymax.lsfd import lsfd
    from pianoid_middleware.modal_adapter.polymax.report import write_stabilization_plot
    cfg = json.load(open(os.path.join(out, "config.json")))
    win = np.ones(NIR); nf = int(0.1 * NIR); win[-nf:] = 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, nf))
    f = np.fft.rfftfreq(NIR, 1 / FS); keep = (f >= 10) & (f <= 160)
    bad = {(fl["exciter"], fl["rep"]) for fl in cfg["flags"] if fl.get("xruns")}      # drop repeats with xruns
    nk = int(keep.sum()); m = np.zeros((nk, 7, 7), complex); var = np.zeros((nk, 7, 7)); Hv = np.full((NREP, nk, 7, 7), np.nan + 0j)
    for j, e in enumerate(EXC):
        lv = cfg["levels"][e]; x = exp_sweep(F1, F2, T, FS, lv); reps = []
        for r in range(NREP):
            y = np.load(os.path.join(out, "sessions", f"{e}_m{-lv}_r{r + 1}", "data.npy")).astype(float)
            h = np.roll(deconvolve(y, x, FS, (F1, F2)), PRE, axis=0)[:NIR] * win[:, None]
            Hv[r, :, :, j] = np.fft.rfft(h, axis=0)[keep]
            if (e, r + 1) not in bad:
                reps.append(Hv[r, :, :, j])
        reps = np.array(reps); m[:, :, j] = reps.mean(0); var[:, :, j] = np.maximum(reps.var(0) / len(reps), 1e-30)
    f = f[keep]
    np.savez(os.path.join(out, "frf.npz"), f=f, Hv=Hv, dropped=np.array(sorted(bad), dtype=object))
    snr = 10 * np.log10(np.abs(m) ** 2 / var)
    sel = (f >= FLO) & (f <= FHI)
    for hz, w_ in HUM:
        sel &= np.abs(f - hz) > w_
    fr, Hm, Nm = f[sel], m[sel], var[sel]
    qc = {"levels": cfg["levels"], "precheck": cfg["precheck"], "flags": cfg["flags"],
          "dropped_repeats_xruns": sorted(bad), "repeat_snr_db_median_per_exciter_18-110": {e: round(float(np.median(snr[sel][:, :, j])), 1) for j, e in enumerate(EXC)},
          "repeat_snr_db_median_25-45": round(float(np.median(snr[(f >= 25) & (f < 45)])), 1)}
    # fit 1: PolyMAX on LF sub-bands
    pcfg = PolymaxConfig(band_edges=(FLO, 30.0, 42.0, 55.0, 70.0, 90.0, FHI), p_max=30, prune=True)
    fit = identify(fr, Hm, pcfg, Nm)
    write_stabilization_plot(fit, out, fr, Hm)
    modes = fit["modes"]
    fm = np.array([x["f_hz"] for x in modes]); zm = np.array([x["zeta"] for x in modes]); lam = np.array([x["pole"] for x in modes])
    W = 1 / np.sqrt(Nm.mean(axis=2)); R = np.zeros((len(modes), 7, 7), complex)
    if len(modes):
        ft = lsfd(fr, Hm, lam, W)
        R = np.array(ft.residues)
    rs = np.sqrt(np.median(Nm.mean(axis=2), axis=0)); Rw = R / rs[None, :, None]
    pairs = list(itertools.combinations(range(7), 2))
    M = np.array([[mac(Rw[r, :, i], Rw[r, :, j]) for i, j in pairs] for r in range(len(modes))]) if len(modes) else np.zeros((0, 21))
    psi = np.array([np.linalg.svd(Rw[r], full_matrices=False)[0][:, 0] for r in range(len(modes))]) if len(modes) else np.zeros((0, 7))
    # fit 2: CMIF peaks + SDOF on enhanced FRFs
    S = np.array([np.linalg.svd(m[i], compute_uv=False) for i in range(len(f))])
    db1 = 20 * np.log10(S[:, 0]); band = (f >= FLO) & (f <= FHI)
    pk, prop = find_peaks(np.where(band, db1, -300), prominence=1.0)
    cm = []
    for p in pk:
        if any(abs(f[p] - hz) <= w_ for hz, w_ in HUM):
            continue
        U, s_, Vh = np.linalg.svd(m[p]); u, v = U[:, 0], Vh[0].conj()
        e_frf = np.einsum("i,fij,j->f", u.conj(), m, v)
        try:
            fn, z, res = sdof_fit(f, e_frf, f[p])
        except Exception:
            fn, z, res = float(f[p]), float("nan"), float("nan")
        cm.append({"f_peak": round(float(f[p]), 2), "f_fit": round(fn, 2), "zeta_pct": round(100 * z, 2), "fit_resid": round(res, 3),
                   "sv_ratio_db": round(float(20 * np.log10(S[p, 1] / S[p, 0])), 1), "prominence_db": round(float(prop["prominences"][list(pk).index(p)]), 1)})
    rng = np.random.default_rng(0); ch = []
    if len(modes) > 1:
        for _ in range(3000):
            a, b = rng.choice(len(modes), 2, replace=False); i, j = pairs[rng.integers(21)]
            ch.append(mac(Rw[a, :, i], Rw[b, :, j]))
    tgt = []
    for t in TARGETS:
        k = int(np.argmin(np.abs(fm - t))) if len(fm) else None
        c = min(cm, key=lambda x: abs(x["f_fit"] - t)) if cm else None
        tgt.append({"target": t,
                    "polymax": None if k is None or abs(fm[k] - t) / t > 0.03 else {"f": round(float(fm[k]), 2), "zeta_pct": round(100 * float(zm[k]), 2), "median_pair_mac": round(float(np.median(M[k])), 2)},
                    "cmif_sdof": None if c is None or abs(c["f_fit"] - t) / t > 0.03 else c})
    hum_near = [{"hum": hz, "modes_within_3Hz": [round(float(x), 2) for x in fm if abs(x - hz) < 3] + [c["f_fit"] for c in cm if abs(c["f_fit"] - hz) < 3]} for hz, _ in HUM]
    rep = {"qc": qc, "polymax_modes": [{"f": round(float(fm[r]), 2), "zeta_pct": round(100 * float(zm[r]), 2), "stab": round(modes[r]["stability"], 2),
                                        "median_pair_mac": round(float(np.median(M[r])), 2)} for r in range(len(modes))],
           "cmif_sdof": cm, "chance_pair_mac_median_p90": [round(float(np.median(ch)), 3), round(float(np.percentile(ch, 90)), 3)] if ch else None,
           "targets": tgt, "hum_proximity": hum_near}
    json.dump(rep, open(os.path.join(out, "report.json"), "w"), indent=1)
    rep_modes = [{"f": x["f"], "zeta_pct": x["zeta_pct"], "median_pair_mac": x["median_pair_mac"]} for x in rep["polymax_modes"]]
    json.dump({"modes": rep_modes}, open(os.path.join(out, "report_modes.json"), "w"), indent=1)
    np.savez(os.path.join(out, "modes.npz"), f=fm, zeta=zm, R=R, psi=psi, pair_mac=M)
    # plots: CMIF with picks, shapes on the board
    fig, ax = plt.subplots(figsize=(13, 4.5))
    for k in range(3):
        ax.plot(f, 20 * np.log10(S[:, k]), lw=1, label=f"sv{k + 1}")
    for c in cm:
        ax.axvline(c["f_fit"], color="g", lw=.6, ls="--")
    for x in fm:
        ax.plot(x, db1[np.argmin(np.abs(f - x))] + 2, "rv", ms=6)
    for hz, w_ in HUM:
        ax.axvspan(hz - w_, hz + w_, color="0.85")
    for t in (32.6, 35.6, 47.8, 57.9, 59.1):
        ax.axvline(t, color="k", lw=.5, ls=":")
    ax.set_xlim(FLO, FHI); ax.set_xlabel("Hz"); ax.set_ylabel("dB"); ax.legend(fontsize=7)
    ax.set_title("LF CMIF (7 x 7), red = PolyMAX poles, green = CMIF+SDOF fits, dotted = 10-12/10-13 targets, grey = hum excluded")
    plt.tight_layout(); plt.savefig(os.path.join(out, "lf_cmif.png"), dpi=85); plt.close()
    if len(fm):
        L = json.load(open(LAYOUT)); asp = L["aspect_w_over_h"]
        P = np.array([L["piezos_green_mm"][str(k)] for k in range(1, 8)], float)          # mm, origin bottom-left
        Ex = np.array([L["exciters_red_mm"][str(k)] for k in range(1, 8)], float)
        n = len(fm); cols = min(5, n); rows_ = int(np.ceil(n / cols))
        fig, axs = plt.subplots(rows_, cols, figsize=(4 * cols, 3.3 * rows_), squeeze=False)
        for a_, r in zip(axs.ravel(), range(n)):
            v = psi[r] * np.exp(-1j * 0.5 * np.angle(np.sum(psi[r] ** 2))); re = v.real / max(np.abs(v).max(), 1e-300)
            a_.scatter(P[:, 0], P[:, 1], c=re, s=80 + 400 * np.abs(re), cmap="coolwarm", vmin=-1, vmax=1, edgecolors="k")
            a_.plot(Ex[:, 0], Ex[:, 1], "k^", ms=5); a_.set_xlim(0, L["board_mm"]["width"]); a_.set_ylim(0, L["board_mm"]["height"]); a_.set_aspect("equal"); a_.tick_params(labelsize=6)
            a_.set_title(f"{fm[r]:.1f} Hz z {100 * zm[r]:.1f}% MAC {np.median(M[r]):.2f}", fontsize=8)
        for a_ in axs.ravel()[n:]:
            a_.axis("off")
        plt.tight_layout(); plt.savefig(os.path.join(out, "lf_shapes_board.png"), dpi=75); plt.close()
    print(json.dumps({"qc": qc, "polymax": rep["polymax_modes"], "cmif_sdof": cm, "chance": rep["chance_pair_mac_median_p90"],
                      "targets": tgt, "hum": hum_near}, indent=0, default=str)[:9000])


if __name__ == "__main__":
    {"capture": capture, "analyse": analyse}[sys.argv[1]](sys.argv[2])
