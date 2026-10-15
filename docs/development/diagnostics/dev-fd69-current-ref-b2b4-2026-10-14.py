"""dev-fd69 2026-10-14: current-referenced measurements B2-B4 (rig: In 1-7 = coil currents of E1-E7,
In 8 = piezo P8 collocated with E7; E1 -> Out 9, E2 -> Out 10, E3..E7 -> Out 3..7; NO loopback - Out 8
not driven; Out 1/2 monitor only).

Alignment: current-referenced quantities (P8/I, distortion in I) need none; per-volt quantities use the
session's capture as is (own-coil onset was identical, 6 samples, for all exciters in the wiring check).

B2 (32 Hz): per exciter 2 x ESS 20 s 15-200 Hz (E1/E2 -42, E3-E7 -36 dBFS). Outputs: coil admittance
  I_k/V per exciter (relative units: current-sense scale unknown) -> its minimum (impedance max) in
  15-80 Hz = suspension resonance fs; P8/V and P8/I_k for every exciter; 32-33 Hz peak test.
B3 (electrical vs mechanical nonlinearity): E1, E2, E3, E4, E7 at -42 / -36 / -30 dBFS (E1/E2 <= -36):
  ESS 8 s 20 Hz-5 kHz + 1 s tones 60 / 100 / 200 Hz. H2/H3 of the OWN COIL CURRENT (ESS harmonic IRs
  re linear; tones by lock-in, raw - the current has no board FRF in between) and of the motion at P8
  (tones FRF-equalised to the force domain with the P8/V FRF of the same session).
B4 (below 30 Hz): E3, E6, E7, E1: ESS 20 s 15-150 Hz (E1 -42, others -36) and a single-exciter
  multisine 15-150 Hz (Tp 4 s, 1 transient + 3 periods) at matched rms and +6 dB. Compare I/V, P8/V,
  P8/I below 35 Hz between ESS and multisine.
Guards: any input > -6 dBFS -> that exciter / level is not raised further (B3 ladder stops); > -3 dBFS
  -> stop the step.
Usage: python <this> b2|b3|b4 capture <out> ; python <this> b2|b3|b4 analyse <out> ;
       python <this> e4p8 <wiring_run_dir>   (E4 -> P8 delay verdict from the wiring-check chirps)
"""
import json
import os
import sys
import time

import numpy as np

FS = 48000
EXC = {"E1": "Out 9", "E2": "Out 10", "E3": "Out 3", "E4": "Out 4", "E5": "Out 5", "E6": "Out 6", "E7": "Out 7"}
INS = [f"In {k}" for k in range(1, 9)]          # In k = coil current Ek (k<=7), In 8 = P8 (at E7)
MAP = {"exciter_outputs": EXC, "inputs": {**{f"In {k}": f"coil current E{k}" for k in range(1, 8)}, "In 8": "piezo P8 (collocated with E7)"},
       "loopback": None, "alignment": "current-referenced quantities need none; per-volt use the session capture (own-coil onset identical for all exciters)",
       "do_not_drive": ["Out 8", "Out 1", "Out 2"]}
GUARD, STOP = -6.0, -3.0
LAYOUT = r"D:\modal_measurements\rig_checks\layout-20261014\board_layout.json"


def io_(out):
    from pianoid_middleware.modal_adapter.swept_discovery.audio_io import SessionAudioIO
    os.makedirs(out, exist_ok=True)
    return SessionAudioIO(os.path.join(out, "sessions"), loopback=None)


def pk_db(y):
    return (20 * np.log10(np.abs(y).max(axis=0) + 1e-12)).round(1).tolist()


def dump(out, cfg):
    json.dump({**MAP, **cfg}, open(os.path.join(out, "run_config.json"), "w"), indent=1, default=str)


def frf_ess(y, x, band, nir_s, pre=30):
    from pianoid_middleware.modal_adapter.measurement.ess import deconvolve
    nir = int(nir_s * FS)
    win = np.ones(nir); nf = int(0.1 * nir); win[-nf:] = 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, nf))
    h = np.roll(deconvolve(y, x, FS, band), pre, axis=0)[:nir] * win[:, None]
    return np.fft.rfftfreq(nir, 1 / FS), np.fft.rfft(h, axis=0)


# ------------------------------------------------------------------ B2
B2_LV = {"E1": -42, "E2": -48, "E3": -36, "E4": -36, "E5": -36, "E6": -36, "E7": -36}


def b2_capture(out):
    from pianoid_middleware.modal_adapter.measurement.ess import exp_sweep
    io = io_(out); log = []
    for e, o in EXC.items():
        x = exp_sweep(15.0, 200.0, 20.0, FS, B2_LV[e])
        for r in (1, 2):
            y, m = io.play_record(x, o, INS, 0.0, 4.0, f"{e}_r{r}")
            log.append({"exciter": e, "rep": r, "level": B2_LV[e], "peaks": pk_db(y), "xruns": m.get("xruns"), "status": m.get("status")})
            print(e, r, "max peak", max(log[-1]["peaks"]), "xruns", m.get("xruns"), flush=True)
            if max(log[-1]["peaks"]) > STOP:
                print("STOP: peak above -3 dBFS"); dump(out, {"step": "B2", "log": log}); return
    dump(out, {"step": "B2", "ess": [15, 200, 20], "levels": B2_LV, "log": log})


def b2_analyse(out):
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    from pianoid_middleware.modal_adapter.measurement.ess import exp_sweep
    cfg = json.load(open(os.path.join(out, "run_config.json")))
    res = {"fs_admittance_min_hz": {}, "p8_per_ampere": {}, "peak_32": {}}
    Y, P8I, P8V = {}, {}, {}
    for e in EXC:
        x = exp_sweep(15.0, 200.0, 20.0, FS, cfg["levels"][e])
        Hs = []
        for r in (1, 2):
            y = np.load(os.path.join(out, "sessions", f"{e}_r{r}", "data.npy")).astype(float)
            f, H = frf_ess(y, x, (15.0, 200.0), 8.0)
            Hs.append(H)
        H = np.mean(Hs, axis=0); k = int(e[1]) - 1
        Y[e] = H[:, k]; P8V[e] = H[:, 7]; P8I[e] = H[:, 7] / H[:, k]
    s = (f >= 18) & (f <= 80)
    hum = lambda ff: np.all([np.abs(ff - h) > 1.0 for h in (50.0, 100.0, 150.0)], axis=0)
    for e in EXC:
        a = np.abs(Y[e]); m = s & hum(f)
        i = np.flatnonzero(m)[np.argmin(a[m])]
        res["fs_admittance_min_hz"][e] = {"f": round(float(f[i]), 2), "depth_db": round(float(20 * np.log10(np.median(a[m]) / a[i])), 1)}
        # 32-33 Hz test: is there a local max of P8/I and P8/V in 30-35 Hz, and its prominence
        for nm, Hx in (("P8_per_ampere", P8I[e]), ("P8_per_volt", P8V[e])):
            w = (f >= 26) & (f <= 40)
            d = 20 * np.log10(np.abs(Hx[w])); j = int(np.argmax(d))
            res["peak_32"].setdefault(e, {})[nm] = {"f_max_26_40": round(float(f[w][j]), 2),
                                                    "prominence_db": round(float(d[j] - 0.5 * (d[0] + d[-1])), 1)}
    json.dump(res, open(os.path.join(out, "b2_report.json"), "w"), indent=1)
    np.savez(os.path.join(out, "b2_frf.npz"), f=f, **{f"Y_{e}": Y[e] for e in EXC}, **{f"P8I_{e}": P8I[e] for e in EXC}, **{f"P8V_{e}": P8V[e] for e in EXC})
    fig, ax = plt.subplots(1, 3, figsize=(19, 5))
    for e in EXC:
        g = (f >= 15) & (f <= 200)
        ax[0].plot(f[g], 20 * np.log10(np.abs(Y[e][g]) / np.median(np.abs(Y[e][g]))), label=e)
        ax[1].plot(f[g], 20 * np.log10(np.abs(P8V[e][g])), label=e)
        ax[2].plot(f[g], 20 * np.log10(np.abs(P8I[e][g])), label=e)
    for a_, t in zip(ax, ("coil admittance I/V (dB re median) - minimum = suspension resonance", "P8 per volt (dB)", "P8 per ampere (dB, current-referenced)")):
        a_.set_xscale("log"); a_.set_title(t, fontsize=9); a_.axvline(32.7, color="k", ls=":", lw=.8); a_.grid(alpha=.3); a_.legend(fontsize=7); a_.set_xlabel("Hz")
    plt.tight_layout(); plt.savefig(os.path.join(out, "b2_admittance_p8.png"), dpi=85)
    print(json.dumps(res, indent=0))


# ------------------------------------------------------------------ B3
B3_EXC = ["E1", "E2", "E3", "E4", "E7"]
B3_LV = {"E1": (-42, -36), "E2": (-42, -36), "E3": (-42, -36, -30), "E4": (-42, -36, -30), "E7": (-42, -36, -30)}
TONES = (60.0, 100.0, 200.0)


def b3_signal(lv):
    from pianoid_middleware.modal_adapter.measurement.ess import exp_sweep
    a = 10 ** (lv / 20); t = np.arange(FS) / FS; nf = int(0.02 * FS)
    parts = [exp_sweep(20.0, 5000.0, 8.0, FS, lv), np.zeros(int(1.5 * FS))]
    for fr in TONES:
        s = a * np.sin(2 * np.pi * fr * t); s[:nf] *= np.linspace(0, 1, nf); s[-nf:] *= np.linspace(1, 0, nf)
        parts += [s, np.zeros(int(0.3 * FS))]
    return np.concatenate(parts)


def b3_capture(out):
    io = io_(out); log = []
    io.record(10.0, INS, "noise")
    for e in B3_EXC:
        for lv in B3_LV[e]:
            y, m = io.play_record(b3_signal(lv), EXC[e], INS, 0.0, 1.5, f"{e}_m{-lv}")
            p = pk_db(y)
            log.append({"exciter": e, "level": lv, "peaks": p, "xruns": m.get("xruns"), "status": m.get("status")})
            print(e, lv, "max peak", max(p), "(P8", p[7], ") xruns", m.get("xruns"), flush=True)
            if max(p) > GUARD:
                print(f"  guard: {e} not raised further"); break
    dump(out, {"step": "B3", "levels": B3_LV, "tones": TONES, "ess": [20, 5000, 8], "log": log})


def lockin(x, fr):
    t = np.arange(len(x)) / FS
    return 2 * np.abs(np.mean(x * np.exp(-2j * np.pi * fr * t)[:, None], axis=0))


def b3_analyse(out):
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    from pianoid_middleware.modal_adapter.measurement.ess import exp_sweep
    from pianoid_middleware.modal_adapter.swept_discovery.rig_checks import harmonic_distortion
    cfg = json.load(open(os.path.join(out, "run_config.json")))
    nz = np.load(os.path.join(out, "sessions", "noise", "data.npy")).astype(float)
    res = {}
    for r in cfg["log"]:
        e, lv = r["exciter"], r["level"]; k = int(e[1]) - 1
        y = np.load(os.path.join(out, "sessions", f"{e}_m{-lv}", "data.npy")).astype(float)
        x = exp_sweep(20.0, 5000.0, 8.0, FS, lv)
        ess = y[:int(9.0 * FS)]
        hd = harmonic_distortion(ess, x, (20.0, 5000.0, 8.0), noise=nz[:len(ess)])
        f, H = frf_ess(ess, x, (20.0, 5000.0), 1.0)
        row = {"ess_current_h2_db": hd["h2_db"][k], "ess_current_h3_db": hd["h3_db"][k],
               "ess_current_h2_noise_db": hd["h2_noise_db"][k], "ess_p8_h2_db": hd["h2_db"][7], "ess_p8_h3_db": hd["h3_db"][7], "tones": {}}
        s0 = int((8.0 + 1.5) * FS)
        for i, fr in enumerate(TONES):
            w = y[s0 + i * int(1.3 * FS) + int(0.25 * FS): s0 + i * int(1.3 * FS) + int(0.85 * FS)]
            a = np.array([lockin(w, n * fr) for n in (1, 2, 3)])                       # (3, 8)
            hP = [np.abs(H[np.argmin(np.abs(f - n * fr)), 7]) for n in (1, 2, 3)]
            row["tones"][fr] = {"current_h2_db": round(float(20 * np.log10(a[1, k] / a[0, k])), 1),
                                "current_h3_db": round(float(20 * np.log10(a[2, k] / a[0, k])), 1),
                                "p8_force_domain_h2_db": round(float(20 * np.log10((a[1, 7] / hP[1]) / (a[0, 7] / hP[0]))), 1),
                                "p8_force_domain_h3_db": round(float(20 * np.log10((a[2, 7] / hP[2]) / (a[0, 7] / hP[0]))), 1),
                                "p8_raw_h2_db": round(float(20 * np.log10(a[1, 7] / a[0, 7])), 1)}
        res.setdefault(e, {})[lv] = row
    json.dump(res, open(os.path.join(out, "b3_report.json"), "w"), indent=1)
    fig, ax = plt.subplots(1, 2, figsize=(14, 4.8))
    for e, rows in res.items():
        L = sorted(rows)
        ax[0].plot(L, [rows[l]["ess_current_h2_db"] for l in L], "o-", label=f"{e} current H2")
        ax[0].plot(L, [rows[l]["ess_p8_h2_db"] for l in L], "s:", label=f"{e} P8 H2")
        ax[1].plot(L, [rows[l]["tones"][100.0]["current_h2_db"] for l in L], "o-", label=f"{e} current")
        ax[1].plot(L, [rows[l]["tones"][100.0]["p8_force_domain_h2_db"] for l in L], "s:", label=f"{e} P8 force-domain")
    ax[0].set(xlabel="drive dBFS", ylabel="dB re linear IR", title="ESS H2: coil current vs motion at P8")
    ax[1].set(xlabel="drive dBFS", ylabel="H2 at 200 Hz re 100 Hz (dB)", title="100 Hz tone H2: current vs P8 (force domain)")
    for a_ in ax:
        a_.grid(alpha=.3); a_.legend(fontsize=6)
    plt.tight_layout(); plt.savefig(os.path.join(out, "b3_nonlin_current_vs_motion.png"), dpi=85)
    for e, rows in res.items():
        for lv, r in sorted(rows.items()):
            print(e, lv, "ESS I H2/H3", round(r["ess_current_h2_db"], 1), round(r["ess_current_h3_db"], 1), "(noise", round(r["ess_current_h2_noise_db"], 1), ") P8 H2", round(r["ess_p8_h2_db"], 1),
                  "| 100Hz I H2", r["tones"][100.0]["current_h2_db"], "P8fd H2", r["tones"][100.0]["p8_force_domain_h2_db"], "| 60Hz I H2", r["tones"][60.0]["current_h2_db"], "P8fd", r["tones"][60.0]["p8_force_domain_h2_db"])


# ------------------------------------------------------------------ B4
B4_EXC = {"E3": -36, "E6": -36, "E7": -36, "E1": -42}
TP, NPER = 4.0, 3


def b4_multisine(rms_dbfs, seed=11):
    rng = np.random.default_rng(seed)
    n = int(TP * FS); lines = np.arange(int(15 * TP), int(150 * TP) + 1)
    X = np.zeros(n // 2 + 1, complex); X[lines] = (1 / np.sqrt(lines / TP)) * np.exp(1j * rng.uniform(0, 2 * np.pi, len(lines)))
    x = np.fft.irfft(X, n=n); x *= 10 ** (rms_dbfs / 20) / np.sqrt(np.mean(x ** 2))
    return np.tile(x, NPER + 1), lines


def b4_capture(out):
    from pianoid_middleware.modal_adapter.measurement.ess import exp_sweep
    io = io_(out); log = []
    for e, lv in B4_EXC.items():
        x = exp_sweep(15.0, 150.0, 20.0, FS, lv)
        y, m = io.play_record(x, EXC[e], INS, 0.0, 4.0, f"{e}_ess")
        log.append({"exciter": e, "kind": "ess", "level": lv, "peaks": pk_db(y), "xruns": m.get("xruns")})
        ess_rms = float(20 * np.log10(np.sqrt(np.mean(x ** 2))))
        for d in (0, 6):
            ms, _ = b4_multisine(ess_rms + d)
            if 20 * np.log10(np.abs(ms).max()) > -6:
                print(e, "multisine peak too high, skipped", d); continue
            y, m = io.play_record(ms, EXC[e], INS, 0.0, 1.0, f"{e}_ms_p{d}")
            log.append({"exciter": e, "kind": "multisine", "rms_dbfs": ess_rms + d, "plus_db": d, "peaks": pk_db(y), "xruns": m.get("xruns")})
        print(e, [(r["kind"], r.get("plus_db"), max(r["peaks"])) for r in log if r["exciter"] == e], flush=True)
    dump(out, {"step": "B4", "exciters": B4_EXC, "ess": [15, 150, 20], "multisine": {"tp": TP, "periods": NPER, "band": [15, 150]}, "log": log})


def b4_analyse(out):
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    from pianoid_middleware.modal_adapter.measurement.ess import exp_sweep
    cfg = json.load(open(os.path.join(out, "run_config.json")))
    res = {}
    fig, axs = plt.subplots(len(B4_EXC), 3, figsize=(17, 3.4 * len(B4_EXC)), squeeze=False)
    for row_i, (e, lv) in enumerate(B4_EXC.items()):
        k = int(e[1]) - 1
        x = exp_sweep(15.0, 150.0, 20.0, FS, lv)
        y = np.load(os.path.join(out, "sessions", f"{e}_ess", "data.npy")).astype(float)
        f, H = frf_ess(y, x, (15.0, 150.0), 4.0)
        ess = {"I/V": H[:, k], "P8/V": H[:, 7], "P8/I": H[:, 7] / H[:, k]}
        ms_res = {}
        for r in [r for r in cfg["log"] if r["exciter"] == e and r["kind"] == "multisine"]:
            d = r["plus_db"]; ms, lines = b4_multisine(r["rms_dbfs"])
            yy = np.load(os.path.join(out, "sessions", f"{e}_ms_p{d}", "data.npy")).astype(float)
            n = int(TP * FS); seg = yy[n:n * (NPER + 1)].reshape(NPER, n, 8).mean(0)
            Yf = np.fft.rfft(seg, axis=0)[lines]; Xf = np.fft.rfft(ms[:n])[lines]
            fm = lines / TP
            ms_res[d] = {"f": fm, "I/V": Yf[:, k] / Xf, "P8/V": Yf[:, 7] / Xf, "P8/I": Yf[:, 7] / Yf[:, k]}
        out_e = {}
        for q_i, q in enumerate(("I/V", "P8/V", "P8/I")):
            a_ = axs[row_i, q_i]
            g = (f >= 15) & (f <= 150)
            a_.plot(f[g], 20 * np.log10(np.abs(ess[q][g])), label="ESS")
            for d, mr in ms_res.items():
                a_.plot(mr["f"], 20 * np.log10(np.abs(mr[q])), lw=.8, label=f"multisine +{d} dB")
                ia = np.searchsorted(f, mr["f"]); ia = np.clip(ia, 0, len(f) - 1)
                for lo, hi, nm in ((18, 30, "18-30"), (30, 45, "30-45"), (45, 150, "45-150")):
                    s = (mr["f"] >= lo) & (mr["f"] < hi)
                    dd = 20 * np.log10(np.abs(mr[q][s]) / np.abs(ess[q][ia[s]]))
                    out_e.setdefault(q, {}).setdefault(f"ms+{d}", {})[nm] = round(float(np.median(dd)), 2)
            a_.set_xscale("log"); a_.set_title(f"{e} {q}"); a_.grid(alpha=.3); a_.legend(fontsize=6)
        res[e] = out_e
    plt.tight_layout(); plt.savefig(os.path.join(out, "b4_ess_vs_multisine.png"), dpi=80)
    json.dump(res, open(os.path.join(out, "b4_report.json"), "w"), indent=1)
    print(json.dumps(res, indent=0))


# ------------------------------------------------------------------ E4 -> P8 delay
def e4p8(run):
    from pianoid_middleware.modal_adapter.measurement.ess import deconvolve
    y = np.load(os.path.join(run, "sessions", "id_bursts", "data.npy")).astype(float)
    x = np.load(os.path.join(run, "sessions", "id_bursts", "signal.npy")).astype(float)
    L = json.load(open(LAYOUT)); asp = L["aspect_w_over_h"]
    p8 = np.array([L["exciters_red"]["7"][0] * asp, L["exciters_red"]["7"][1]])     # P8 collocated with E7
    rows = {}
    for i in range(7):
        s0 = int(i * 3 * FS); w = y[s0:s0 + int(1.5 * FS)]; xx = x[s0:s0 + FS, i]
        h = deconvolve(w, xx, FS, (100.0, 2000.0))
        # current-referenced P8 IR: P8 / I_i (latency-free)
        n = 8192; Hp = np.fft.rfft(h[:n, 7]); Hi = np.fft.rfft(h[:n, i])
        fr = np.fft.rfftfreq(n, 1 / FS); band = (fr >= 150) & (fr <= 1800)
        G = np.zeros_like(Hp); G[band] = Hp[band] / Hi[band]
        g = np.fft.irfft(G, n=n); g = np.roll(g, 200)
        env = np.abs(g); on = int(np.argmax(env > 0.2 * env.max())) - 200; pk = int(np.argmax(env)) - 200
        ex = np.array([L["exciters_red"][str(i + 1)][0] * asp, L["exciters_red"][str(i + 1)][1]])
        rows[f"E{i + 1}"] = {"dist_board_units": round(float(np.linalg.norm(ex - p8)), 3), "onset_samples": on, "peak_samples": pk,
                             "early_energy_frac_first_5": round(float(np.sum(g[200 - 2:200 + 5] ** 2) / np.sum(g ** 2)), 3)}
    tr = {k: v for k, v in rows.items() if k not in ("E4", "E7")}
    d = np.array([v["dist_board_units"] for v in tr.values()]); o = np.array([v["onset_samples"] for v in tr.values()])
    slope, icpt = np.polyfit(d, o, 1)
    pred = slope * rows["E4"]["dist_board_units"] + icpt
    verdict = {"fit_onset_vs_distance": {"samples_per_unit": round(float(slope), 1), "intercept": round(float(icpt), 1)},
               "E4_predicted_onset": round(float(pred), 1), "E4_measured_onset": rows["E4"]["onset_samples"], "rows": rows}
    json.dump(verdict, open(os.path.join(run, "e4p8_delay.json"), "w"), indent=1)
    print(json.dumps(verdict, indent=0))


if __name__ == "__main__":
    if sys.argv[1] == "e4p8":
        e4p8(sys.argv[2])
    else:
        {"b2": (b2_capture, b2_analyse), "b3": (b3_capture, b3_analyse), "b4": (b4_capture, b4_analyse)}[sys.argv[1]][0 if sys.argv[2] == "capture" else 1](sys.argv[3])
