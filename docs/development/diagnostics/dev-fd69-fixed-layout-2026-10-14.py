"""dev-fd69 2026-10-14: full fixed-layout capture, 7 exciters x 7 piezos (voltage-referenced).

Output map (user, 2026-10-14): E1 -> Out 9, E2 -> Out 10, E3..E7 -> Out 3..7; Out 8 -> In 8 sync
reference (loopback marker, alignment); Out 1/2 monitor only (never driven). Piezos P1..P7 on In 1..7.
No coil-current channels -> FRFs are per drive volt (V-ref).

capture: silence 3 s, then per exciter 3 x ESS 20 s 20 Hz - 2 kHz (+3 s tail). Level guard: if the
first repeat peaks above -6 dBFS on any piezo the exciter is redone 6 dB lower (until <= -6 dBFS);
a later repeat above -3 dBFS is flagged. Sessions under <out>/sessions/<E>_m<lvl>_r<k>/.
analyse: FRFs (3 repeats, F <= 1200 Hz, rows P1..P7, refs E1..E7), QC (repeat SNR, level per
exciter, Out 6 dropout check), PolyMAX on all 49 paths (hum lines 50/100/150 Hz excluded), LSFD
residues, cross-exciter MAC (21 pairs, noise-whitened rows), chance level, participation, AutoMAC,
damping, board-map shapes (layout-20261014/board_layout.json) and a comparison with the roving
placements 0-2 (P0+P1 analysis) and the 2026-10-12 consensus modes.

Usage: python <this> capture <out_dir> [--only=E1,E2] [--levels=E1:-48,E2:-48]  |  python <this> analyse <out_dir> [--fmax 1100]
"""
import itertools
import json
import os
import sys
import time

import numpy as np

FS = 48000
F1, F2, T, POST = 20.0, 2000.0, 20.0, 3.0
EXC = {"E1": "Out 9", "E2": "Out 10", "E3": "Out 3", "E4": "Out 4", "E5": "Out 5", "E6": "Out 6", "E7": "Out 7"}
LEVEL0 = {"E1": -42, "E2": -42, "E3": -36, "E4": -30, "E5": -36, "E6": -42, "E7": -36}
PIEZO = [f"In {k}" for k in range(1, 8)]
GUARD, STOP, NREP = -6.0, -3.0, 3
NIR, PRE, FMAX = 4 * FS, 30, 1200.0
HUM = (50.0, 100.0, 150.0)
RC = r"D:\modal_measurements\rig_checks"
LAYOUT = os.path.join(RC, "layout-20261014", "board_layout.json")
P01 = os.path.join(RC, "rove-20261013", "analysis_p01_noP01In5_coilsP0", "report.json")
CONSENSUS_1012 = [33.0, 57.9, 59.1, 67.8, 81.4, 118.3]


def capture(out, only=None, levels=None):
    """only: subset of exciters (e.g. ["E1", "E2"]); levels: {E: dBFS} overriding LEVEL0."""
    from pianoid_middleware.modal_adapter.measurement.ess import exp_sweep
    from pianoid_middleware.modal_adapter.swept_discovery.audio_io import SessionAudioIO
    os.makedirs(out, exist_ok=True)
    io = SessionAudioIO(os.path.join(out, "sessions"), loopback=("Out 8", "In 8"))
    cfg = {"time": time.strftime("%Y-%m-%dT%H:%M:%S"), "exciter_outputs": EXC, "piezo_inputs": dict(zip([f"P{k}" for k in range(1, 8)], PIEZO)),
           "sync": "Out 8 -> In 8 (loopback marker)", "monitor_only": ["Out 1", "Out 2"],
           "ess": [F1, F2, T, POST], "repeats": NREP, "guard_dbfs": GUARD, "stop_dbfs": STOP,
           "layout": LAYOUT, "levels": {}, "flags": []}
    io.record(3.0, PIEZO, "silence")
    t0 = time.time()
    for e, o in EXC.items():
        if only and e not in only:
            continue
        lv = (levels or {}).get(e, LEVEL0[e])
        while True:
            y, m = io.play_record(exp_sweep(F1, F2, T, FS, lv), o, PIEZO, 0.0, POST, f"{e}_m{-lv}_r1")
            pk = float(20 * np.log10(np.abs(y).max() + 1e-12))
            print(f"{e} ({o}) {lv} dBFS r1 peak {pk:.1f} xruns {m.get('xruns')} onset {(m.get('loopback') or {}).get('onset_frames')}", flush=True)
            if pk <= GUARD or lv <= -60:
                break
            lv -= 6
        for r in range(2, NREP + 1):
            y, m = io.play_record(exp_sweep(F1, F2, T, FS, lv), o, PIEZO, 0.0, POST, f"{e}_m{-lv}_r{r}")
            pk = float(20 * np.log10(np.abs(y).max() + 1e-12))
            if pk > STOP or m.get("xruns") or m.get("status") != "ok":
                cfg["flags"].append({"exciter": e, "rep": r, "peak": pk, "status": m.get("status"), "xruns": m.get("xruns")})
            print(f"{e} r{r} peak {pk:.1f} xruns {m.get('xruns')} ({time.time() - t0:.0f} s)", flush=True)
        cfg["levels"][e] = lv
    cfg["sessions"] = io.sessions
    json.dump(cfg, open(os.path.join(out, "config.json"), "w"), indent=1, default=str)


def mac(a, b):
    return float(np.abs(np.vdot(a, b)) ** 2 / (np.vdot(a, a).real * np.vdot(b, b).real + 1e-300))


def frfs(out, cfg):
    from pianoid_middleware.modal_adapter.measurement.ess import deconvolve, exp_sweep
    win = np.ones(NIR); nf = int(0.1 * NIR); win[-nf:] = 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, nf))
    f = np.fft.rfftfreq(NIR, 1 / FS); keep = f <= FMAX
    Hv = np.zeros((NREP, int(keep.sum()), 7, 7), complex)
    for j, e in enumerate(EXC):
        lv = cfg["levels"][e]; x = exp_sweep(F1, F2, T, FS, lv)      # H per unit (full-scale) drive
        for r in range(NREP):
            y = np.load(os.path.join(out, "sessions", f"{e}_m{-lv}_r{r + 1}", "data.npy")).astype(float)
            h = np.roll(deconvolve(y, x, FS, (F1, F2)), PRE, axis=0)[:NIR] * win[:, None]
            Hv[r, :, :, j] = np.fft.rfft(h, axis=0)[keep]
    return f[keep], Hv


def band_med(f, v, lo, hi):
    s = (f >= lo) & (f < hi)
    for hz in HUM:
        s &= np.abs(f - hz) > 1.0
    return float(np.median(v[s]))


def analyse(out, fmax=1100.0):
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    from pianoid_middleware.modal_adapter.polymax.identify import PolymaxConfig, identify
    from pianoid_middleware.modal_adapter.polymax.lsfd import lsfd
    from pianoid_middleware.modal_adapter.polymax.report import write_stabilization_plot
    cfg = json.load(open(os.path.join(out, "config.json")))
    f, Hv = frfs(out, cfg)
    np.savez(os.path.join(out, "frf.npz"), f=f, Hv=Hv, rows=np.array(PIEZO), refs=np.array(list(EXC)))
    m = Hv.mean(0); var = np.maximum(Hv.var(0) / NREP, 1e-30)
    snr = 10 * np.log10(np.abs(m) ** 2 / var)
    E = list(EXC)
    qc = {"repeat_snr_db_<200|200-1k": {e: {PIEZO[k]: [round(band_med(f, snr[:, k, j], 25, 200), 1), round(band_med(f, snr[:, k, j], 200, 1000), 1)]
                                            for k in range(7)} for j, e in enumerate(E)},
          "level_db_per_volt_median_25-1k": {e: round(band_med(f, 20 * np.log10(np.abs(m[:, :, j]).mean(1)), 25, 1000), 1) for j, e in enumerate(E)},
          "levels_dbfs": cfg["levels"], "flags": cfg["flags"]}
    # Out 6 (E6) dropout check: each repeat's level vs the mean of its repeats, per band
    rep_db = {e: [round(band_med(f, 20 * np.log10(np.abs(Hv[r, :, :, j]).mean(1) / np.abs(m[:, :, j]).mean(1)), 25, 1000), 2) for r in range(NREP)]
              for j, e in enumerate(E)}
    qc["repeat_level_dev_db"] = rep_db
    sel = (f >= 25) & (f <= fmax)
    for hz in HUM:
        sel &= np.abs(f - hz) > 1.0
    fr, Hm, Nm = f[sel], m[sel], var[sel]
    pcfg = PolymaxConfig(band_edges=(25.0, 60.0, 120.0, 200.0, 350.0, 600.0, fmax), p_max=40, prune=True)
    fit = identify(fr, Hm, pcfg, Nm)
    write_stabilization_plot(fit, out, fr, Hm)
    modes = fit["modes"]
    fm = np.array([x["f_hz"] for x in modes]); zm = np.array([x["zeta"] for x in modes]); lam = np.array([x["pole"] for x in modes])
    W = 1 / np.sqrt(Nm.mean(axis=2))
    R = np.zeros((len(modes), 7, 7), complex)
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
    M = np.array([[mac(Rw[r, :, i], Rw[r, :, j]) for i, j in pairs] for r in range(len(modes))])
    part = np.array([[np.linalg.norm(Rw[r, :, e]) for e in range(7)] for r in range(len(modes))])
    part = part / np.maximum(part.max(axis=1, keepdims=True), 1e-300)
    rng = np.random.default_rng(0); ch = []
    for _ in range(4000):
        a, b2 = rng.choice(len(modes), 2, replace=False); i, j = pairs[rng.integers(len(pairs))]
        ch.append(mac(Rw[a, :, i], Rw[b2, :, j]))
    chance = [round(float(np.median(ch)), 3), round(float(np.percentile(ch, 90)), 3)]
    psi = np.zeros((len(modes), 7), complex)
    for r in range(len(modes)):
        U, S_, Vh = np.linalg.svd(Rw[r], full_matrices=False)
        v = U[:, 0]; psi[r] = v * np.exp(-1j * np.angle(v[np.argmax(np.abs(v))]))
    A = np.array([[mac(psi[i], psi[j]) for j in range(len(modes))] for i in range(len(modes))])
    gated = []
    for r in range(len(modes)):
        q = [k for k, (i, j) in enumerate(pairs) if part[r, i] >= 0.3 and part[r, j] >= 0.3]
        gated.append(float(np.median(M[r, q])) if q else None)

    def bstats(lo, hi):
        s = (fm >= lo) & (fm < hi)
        offd = A[np.ix_(s, s)][~np.eye(int(s.sum()), dtype=bool)] if s.sum() > 1 else np.array([0.0])
        g = [gated[r] for r in np.flatnonzero(s) if gated[r] is not None]
        return {"n_modes": int(s.sum()), "median_pair_mac": round(float(np.median(M[s])), 3) if s.any() else None,
                "median_gated_pair_mac": round(float(np.median(g)), 3) if g else None,
                "modes_median_ge_0.9": [round(float(x), 1) for x in fm[s & (np.median(M, axis=1) >= 0.9)]],
                "modes_gated_ge_0.9": [round(float(fm[r]), 1) for r in np.flatnonzero(s) if gated[r] is not None and gated[r] >= 0.9],
                "zeta_pct_median": round(100 * float(np.median(zm[s])), 2) if s.any() else None,
                "automac_offdiag_median_p95": [round(float(np.median(offd)), 3), round(float(np.percentile(offd, 95)), 3)]}

    cmp = {}
    if os.path.exists(P01):
        p = json.load(open(P01)); pf = np.array([x["f"] for x in p["modes"]]); pz = np.array([x["zeta_pct"] for x in p["modes"]])
        hits = []
        for i, x in enumerate(fm[fm < 1000]):
            k = int(np.argmin(np.abs(pf - x)))
            if abs(pf[k] - x) / x <= 0.02:
                hits.append({"f": round(float(x), 2), "f_p01": float(pf[k]), "zeta": round(100 * float(zm[i]), 2), "zeta_p01": float(pz[k])})
        cmp["vs_rove_P0P1"] = {"n_now_lt1k": int((fm < 1000).sum()), "n_p01_lt1k": int((pf < 1000).sum()), "matched_2pct": len(hits),
                               "zeta_ratio_median": round(float(np.median([h["zeta"] / h["zeta_p01"] for h in hits])), 2) if hits else None,
                               "matches": hits}
    cmp["vs_1012_consensus"] = {str(c): (round(float(fm[np.argmin(np.abs(fm - c))]), 2) if len(fm) and np.min(np.abs(fm - c)) / c <= 0.03 else None)
                                for c in CONSENSUS_1012}
    rep = {"config": {k: cfg[k] for k in ("exciter_outputs", "levels", "flags", "sync")}, "qc": qc, "n_modes": len(modes),
           "chance_pair_mac_median_p90": chance, "lt200": bstats(0, 200), "200_1k": bstats(200, 1000), "comparison": cmp,
           "modes": [{"f": round(float(fm[r]), 2), "zeta_pct": round(100 * float(zm[r]), 2), "stab": round(modes[r]["stability"], 2),
                      "part": np.round(part[r], 2).tolist(), "median_pair_mac": round(float(np.median(M[r])), 2),
                      "gated_pair_mac": None if gated[r] is None else round(gated[r], 2)} for r in range(len(modes))]}
    json.dump(rep, open(os.path.join(out, "report.json"), "w"), indent=1)
    np.savez(os.path.join(out, "modes.npz"), f=fm, zeta=zm, R=R, psi=psi, pair_mac=M, automac=A, part=part)
    # plots
    lab = [f"{i + 1}-{j + 1}" for i, j in pairs]
    fig, ax = plt.subplots(1, 2, figsize=(17, 5))
    ax[0].semilogx(np.repeat(fm, len(pairs)), M.ravel(), ".", ms=3, alpha=.4, label="pair MAC (21 pairs)")
    ax[0].semilogx(fm, np.median(M, axis=1), "k_", ms=10, label="median")
    ax[0].semilogx(fm, [np.nan if g is None else g for g in gated], "g.", ms=8, label="median, participation-gated")
    ax[0].axhline(chance[1], color="r", ls="--", lw=.8, label="chance p90"); ax[0].set_xlim(25, fmax); ax[0].legend(fontsize=7)
    ax[0].set_title(f"Cross-exciter MAC, 7 exciters x 7 piezos (V-ref), {len(modes)} modes")
    im = ax[1].imshow(M.T, aspect="auto", vmin=0, vmax=1, cmap="viridis"); plt.colorbar(im, ax=ax[1])
    ax[1].set_xticks(range(len(fm))); ax[1].set_xticklabels([f"{x:.0f}" for x in fm], rotation=90, fontsize=5)
    ax[1].set_yticks(range(len(pairs))); ax[1].set_yticklabels(lab, fontsize=6)
    plt.tight_layout(); plt.savefig(os.path.join(out, "cross_exciter_mac.png"), dpi=85); plt.close()
    fig, ax = plt.subplots(figsize=(9, 8)); im = ax.imshow(A, vmin=0, vmax=1, cmap="viridis"); plt.colorbar(im)
    ax.set_xticks(range(len(fm))); ax.set_xticklabels([f"{x:.0f}" for x in fm], rotation=90, fontsize=5)
    ax.set_yticks(range(len(fm))); ax.set_yticklabels([f"{x:.0f}" for x in fm], fontsize=5); ax.set_title("AutoMAC of consensus shapes (7 piezos)")
    plt.tight_layout(); plt.savefig(os.path.join(out, "automac.png"), dpi=85); plt.close()
    L = json.load(open(LAYOUT)); asp = L["aspect_w_over_h"]
    P = np.array([L["piezos_green_mm"][str(k)] for k in range(1, 8)], float)          # mm, origin bottom-left
    Ex = np.array([L["exciters_red_mm"][str(k)] for k in range(1, 8)], float)
    idx = list(np.flatnonzero(fm < 400))[:20]
    fig, axs = plt.subplots(4, 5, figsize=(20, 13), squeeze=False)
    for a_, r in zip(axs.ravel(), idx):
        v = psi[r]; v = v * np.exp(-1j * 0.5 * np.angle(np.sum(v ** 2))); re = v.real / max(np.abs(v).max(), 1e-300)
        a_.scatter(P[:, 0], P[:, 1], c=re, s=80 + 400 * np.abs(re), cmap="coolwarm", vmin=-1, vmax=1, edgecolors="k")
        a_.plot(Ex[:, 0], Ex[:, 1], "k^", ms=6)
        for k in range(7):
            a_.annotate(f"P{k + 1}", P[k], fontsize=6)
        a_.set_xlim(0, L["board_mm"]["width"]); a_.set_ylim(0, L["board_mm"]["height"]); a_.set_aspect("equal"); a_.tick_params(labelsize=6)
        a_.set_title(f"{fm[r]:.1f} Hz  z {100 * zm[r]:.1f}%  MAC {np.median(M[r]):.2f}", fontsize=8)
    for a_ in axs.ravel()[len(idx):]:
        a_.axis("off")
    fig.suptitle("Consensus mode shapes on the board (real part; triangles = exciters)")
    plt.tight_layout(); plt.savefig(os.path.join(out, "shapes_board.png"), dpi=75); plt.close()
    l, h = rep["lt200"], rep["200_1k"]
    print(json.dumps({"qc": qc, "n_modes": len(modes), "chance": chance, "lt200": l, "200_1k": h,
                      "comparison": {k: (v if k != "vs_rove_P0P1" else {kk: vv for kk, vv in v.items() if kk != "matches"}) for k, v in cmp.items()}},
                     indent=0, default=str)[:7000])
    print("modes <400 Hz:", [(x["f"], x["zeta_pct"], x["median_pair_mac"]) for x in rep["modes"] if x["f"] < 400])


if __name__ == "__main__":
    if sys.argv[1] == "capture":
        only = next((a.split("=", 1)[1].split(",") for a in sys.argv if a.startswith("--only=")), None)
        lv = next((dict((k, int(v)) for k, v in (x.split(":") for x in a.split("=", 1)[1].split(","))) for a in sys.argv if a.startswith("--levels=")), None)
        capture(sys.argv[2], only, lv)
    else:
        fmx = float(sys.argv[sys.argv.index("--fmax") + 1]) if "--fmax" in sys.argv else 1100.0
        analyse(sys.argv[2], fmx)
