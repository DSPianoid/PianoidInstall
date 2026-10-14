"""dev-fd69 2026-10-14: MIMO superposition test - all 7 exciters at once, orthogonal random-phase multisines.

Design (Dobrowiecki orthogonal multisines): period Tp = 4 s (0.25 Hz lines = the 7x7 ESS FRF grid),
excited lines 20 Hz-2 kHz, pink amplitude (|U| ~ 1/sqrt(f), like the ESS). Per realisation r a random
phase phi_r(k) per exciter; 7 blocks b, in block b exciter e gets phase phi_r,e(k) + 2 pi e b / 7
(the 7x7 DFT matrix -> U(k) is invertible at every line). Each block = 1 transient + 2 measured periods.
One /audio/session per realisation (7 x 3 x 4 s = 84 s + 1 s), loopback marker Out 8 -> In 8.
Per-exciter amplitude keeps the 7x7 run's relative levels; the common scale is set so the PREDICTED
summed piezo peak (measured 7x7 FRFs x the actual signals) is <= TARGET dBFS.
H(k) = Y(k) U(k)^-1 per realisation; mean over realisations, variance -> noise + nonlinear distortion
(random-phase realisations turn nonlinear contributions into variance).
Usage: python <this> plan <out> | capture <out> | analyse <out>
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
FS, TP, NB, NPER, NREAL = 48000, 4.0, 7, 3, 3
NP = int(TP * FS)
FLO, FHI = 20.0, 2000.0
TARGET = -12.0
REF7 = r"D:\modal_measurements\rig_checks\20261014T144226-fixed-layout-7x7"
E = list(fl.EXC)
LINES = np.arange(int(FLO * TP), int(FHI * TP) + 1)                  # FFT bins of one period


def signals(scale_db, seed):
    rng = np.random.default_rng(seed)
    rel = np.array([10 ** ((fl.LEVEL0[e] - max(fl.LEVEL0.values())) / 20) for e in E])
    amp = 1 / np.sqrt(LINES / TP)
    phi = rng.uniform(0, 2 * np.pi, (7, len(LINES)))
    blocks, U = [], np.zeros((NB, len(LINES), 7), complex)          # U[b, k, e]
    for b in range(NB):
        X = np.zeros((7, NP // 2 + 1), complex)
        for e in range(7):
            ph = phi[e] + 2 * np.pi * e * b / NB
            X[e, LINES] = rel[e] * amp * np.exp(1j * ph)
        x = np.fft.irfft(X, n=NP, axis=1)
        U[b] = X[:, LINES].T
        blocks.append(x)
    peak = max(np.abs(x).max() for x in blocks)
    g = 10 ** (scale_db / 20) / peak                                 # scale_db = drive peak of the hottest output
    sig = np.concatenate([np.tile(x * g, (1, NPER)) for x in blocks], axis=1).T   # (samples, 7)
    return sig.astype(np.float32), U * g


def predict_peak(sig, f7, H7):
    """Piezo time signals from the measured 7x7 FRFs (per unit drive): y_p = sum_e h_pe * x_e."""
    n = sig.shape[0]; F = np.fft.rfft(sig, axis=0); fr = np.fft.rfftfreq(n, 1 / FS)
    Y = np.zeros((len(fr), 7), complex)
    for e in range(7):
        He = np.array([np.interp(fr, f7, H7[:, p, e].real) + 1j * np.interp(fr, f7, H7[:, p, e].imag) for p in range(7)]).T
        He[fr > f7[-1]] = 0
        Y += He * F[:, e:e + 1]
    y = np.fft.irfft(Y, n=n, axis=0)
    return float(20 * np.log10(np.abs(y).max() + 1e-12)), y


def ref_frf():
    z = np.load(os.path.join(REF7, "frf.npz"))
    return z["f"], z["Hv"].mean(0)


def plan(out):
    os.makedirs(out, exist_ok=True)
    f7, H7 = ref_frf()
    res = []
    for s in (-30.0, -24.0, -18.0, -12.0):
        sig, _ = signals(s, 0)
        pk, _ = predict_peak(sig[:NP * NPER], f7, H7)
        res.append({"drive_peak_dbfs": s, "drive_rms_dbfs_per_output": [round(float(20 * np.log10(np.sqrt(np.mean(sig[:, e] ** 2)))), 1) for e in range(7)],
                    "predicted_piezo_peak_dbfs": round(pk, 1)})
        print(res[-1], flush=True)
    ok = [r for r in res if r["predicted_piezo_peak_dbfs"] <= TARGET]
    choice = max(ok, key=lambda r: r["drive_peak_dbfs"]) if ok else res[0]
    json.dump({"options": res, "choice": choice, "target": TARGET}, open(os.path.join(out, "plan.json"), "w"), indent=1)
    print("choice", choice)


def capture(out):
    from pianoid_middleware.modal_adapter.swept_discovery.audio_io import SessionAudioIO
    p = json.load(open(os.path.join(out, "plan.json")))
    s = p["choice"]["drive_peak_dbfs"]
    io = SessionAudioIO(os.path.join(out, "sessions"), loopback=("Out 8", "In 8"))
    cfg = {"time": time.strftime("%Y-%m-%dT%H:%M:%S"), "exciter_outputs": fl.EXC, "piezos": fl.PIEZO, "drive_peak_dbfs": s,
           "tp_s": TP, "blocks": NB, "periods_per_block": NPER, "realisations": NREAL, "band": [FLO, FHI], "sessions": []}
    for r in range(NREAL):
        sig, _ = signals(s, 1000 + r)
        y, m = io.play_record_multi(sig, [fl.EXC[e] for e in E], fl.PIEZO, 1.0, f"mimo_r{r + 1}")
        pk = float(20 * np.log10(np.abs(y).max() + 1e-12))
        cfg["sessions"].append({"r": r + 1, "peak_dbfs": pk, "xruns": m.get("xruns"), "status": m.get("status"),
                                "onset": (m.get("loopback") or {}).get("onset_frames")})
        print(cfg["sessions"][-1], flush=True)
        if pk > fl.STOP:
            print("peak above stop -> abort", flush=True); break
    json.dump(cfg, open(os.path.join(out, "config.json"), "w"), indent=1, default=str)


def analyse(out):
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    cfg = json.load(open(os.path.join(out, "config.json"))); s = cfg["drive_peak_dbfs"]
    Hs = []
    for ses in cfg["sessions"]:
        r = ses["r"]
        y = np.load(os.path.join(out, "sessions", f"mimo_r{r}", "data.npy")).astype(float)
        _, U = signals(s, 1000 + r - 1)
        Y = np.zeros((NB, len(LINES), 7), complex)
        for b in range(NB):
            s0 = (b * NPER + 1) * NP                                       # skip the transient period
            seg = y[s0:s0 + 2 * NP].reshape(2, NP, 7).mean(0)
            Y[b] = np.fft.rfft(seg, axis=0)[LINES]
        H = np.zeros((len(LINES), 7, 7), complex)                          # [k, piezo, exciter]
        for k in range(len(LINES)):
            H[k] = np.linalg.solve(U[:, k, :], Y[:, k, :]).T                # Y = U H^T
        Hs.append(H)
    Hs = np.array(Hs); Hm = Hs.mean(0); var = Hs.var(0) / len(Hs)
    fm = LINES / TP
    f7, H7 = ref_frf()
    idx = np.searchsorted(f7, fm); idx = np.clip(idx, 0, len(f7) - 1)
    ok = np.abs(f7[idx] - fm) < 1e-6
    A = H7[idx] * np.exp(2j * np.pi * fm * fl.PRE / FS)[:, None, None]    # ESS one-at-a-time, same lines; undo its PRE-sample roll
    rep = {"drive_peak_dbfs": s, "sessions": cfg["sessions"], "bands": {}}
    for lo, hi, nm in ((25, 250, "<250"), (250, 1000, "250-1k"), (1000, 2000, "1-2k")):
        sb = ok & (fm >= lo) & (fm < hi)
        for hz in fl.HUM:
            sb &= np.abs(fm - hz) > 1.0
        a, b = A[sb], Hm[sb]
        use = 20 * np.log10(np.abs(a) / np.abs(a).max(axis=0, keepdims=True)) >= -20
        ddb = 20 * np.log10(np.abs(b) / np.abs(a)); dph = np.degrees(np.angle(b / a))
        snr = 10 * np.log10(np.abs(b) ** 2 / np.maximum(var[sb], 1e-30))
        # "coherence" between methods: |<a b*>|^2 / (<|a|^2><|b|^2>) over lines, per path, median
        coh = np.abs(np.sum(a * b.conj(), axis=0)) ** 2 / (np.sum(np.abs(a) ** 2, axis=0) * np.sum(np.abs(b) ** 2, axis=0))
        rep["bands"][nm] = {"median_abs_db": round(float(np.median(np.abs(ddb[use]))), 3), "p90_abs_db": round(float(np.percentile(np.abs(ddb[use]), 90)), 3),
                            "median_db": round(float(np.median(ddb[use])), 3), "median_abs_deg": round(float(np.median(np.abs(dph[use]))), 2),
                            "mimo_snr_db_median": round(float(np.median(snr[use])), 1), "path_coherence_median": round(float(np.median(coh)), 4),
                            "path_coherence_min": round(float(np.min(coh)), 4),
                            "per_exciter_median_abs_db": [round(float(np.median(np.abs(ddb[:, :, e][use[:, :, e]]))), 3) for e in range(7)]}
    # modes: PolyMAX on the MIMO FRFs, matched to the 7x7 ESS modes
    from pianoid_middleware.modal_adapter.polymax.identify import PolymaxConfig, identify
    sel = (fm >= 25) & (fm <= 1100)
    for hz in fl.HUM:
        sel &= np.abs(fm - hz) > 1.0
    fit = identify(fm[sel], Hm[sel], PolymaxConfig(band_edges=(25.0, 60.0, 120.0, 200.0, 350.0, 600.0, 1100.0), p_max=40, prune=True), np.maximum(var[sel], 1e-30))
    mm = [(x["f_hz"], 100 * x["zeta"]) for x in fit["modes"]]
    ref = json.load(open(os.path.join(REF7, "report.json")))["modes"]
    pairs, used = [], set()
    for fa, za in [(x["f"], x["zeta_pct"]) for x in ref]:
        k = min(((abs(fb - fa) / fa, i) for i, (fb, zb) in enumerate(mm) if i not in used), default=None)
        if k and k[0] <= 0.01:
            used.add(k[1]); fb, zb = mm[k[1]]
            pairs.append({"f_ess": fa, "f_mimo": round(fb, 2), "df_pct": round(100 * (fb - fa) / fa, 3), "z_ess": za, "z_mimo": round(zb, 2), "dz_pp": round(zb - za, 3)})
    rep["modes"] = {"n_ess": len(ref), "n_mimo": len(mm), "matched": len(pairs),
                    "abs_df_pct_median": round(float(np.median([abs(p["df_pct"]) for p in pairs])), 3) if pairs else None,
                    "dz_pp_median": round(float(np.median([p["dz_pp"] for p in pairs])), 3) if pairs else None,
                    "abs_dz_pp_median": round(float(np.median([abs(p["dz_pp"]) for p in pairs])), 3) if pairs else None, "pairs": pairs}
    json.dump(rep, open(os.path.join(out, "report.json"), "w"), indent=1)
    np.savez(os.path.join(out, "frf_mimo.npz"), f=fm, H=Hm, var=var, Hr=Hs)
    fig, axs = plt.subplots(2, 2, figsize=(15, 8))
    for a_, (p, e) in zip(axs.ravel(), ((0, 0), (3, 2), (5, 5), (6, 6))):
        a_.semilogx(fm[ok], 20 * np.log10(np.abs(A[ok][:, p, e])), lw=1, label="ESS one-at-a-time")
        a_.semilogx(fm, 20 * np.log10(np.abs(Hm[:, p, e])), lw=.8, alpha=.8, label="MIMO 7 at once")
        a_.semilogx(fm, 10 * np.log10(np.maximum(var[:, p, e], 1e-30)), lw=.6, color="0.6", label="MIMO noise+NL")
        a_.set_title(f"P{p + 1} <- E{e + 1}"); a_.set_xlim(20, 2000); a_.legend(fontsize=7); a_.grid(alpha=.3)
    plt.tight_layout(); plt.savefig(os.path.join(out, "mimo_vs_ess.png"), dpi=85); plt.close()
    print(json.dumps({k: v for k, v in rep.items() if k != "modes"}, indent=0)[:5000])
    print(json.dumps({k: v for k, v in rep["modes"].items() if k != "pairs"}))


if __name__ == "__main__":
    {"plan": plan, "capture": capture, "analyse": analyse}[sys.argv[1]](sys.argv[2])
