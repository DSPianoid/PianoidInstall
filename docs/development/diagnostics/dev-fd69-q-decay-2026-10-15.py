"""dev-fd69 2026-10-15: focused Q measurement of the 24 core modes - appropriated stop-and-decay.

Rig (10-15 afternoon, unchanged): E1 -> Out 9, E2 -> Out 10, E3..E7 -> Out 3..7 (weights on); P1-P7 on
In 1-7, P8 (at E7) on In 8; no loopback. Drive vectors / sensor weights from the live-appropriation plans
(`20261015T124849-appropriation`, `20261015T135644-appropriation-extra7`), equal coil-current RMS,
max output -36 dBFS (E2 -42).

Per mode, two sessions in ONE backend:
  tune : stepped dwells at f_m * (1 + k * 0.5 %), k = -3..3, each max(0.6 s, 8 tau) settle + 0.3 s lock-in;
         f_tuned = parabolic peak of the modal response |u^H y|.
  decay: 3 repeats of [steady drive at f_tuned for max(2 s, 10 tau) -> 5 ms cosine stop -> silence
         max(1.0 s, 12 tau)]. Vector per mode = mode or optimum, whichever isolated the target mode better in
         the live test (modal projection minus total response).
Decay analysis: band-pass (+-max(5 Hz, 8 %)), analytic signals of P1-P8 combined with the mode shape
(z = sum conj(u_k) y_k^a / rs_k), log|z| fitted from 3 ms after the stop down to -30 dB or 8 tau (above
the noise); zeta = -slope / (2 pi f_d); f_d from the mean instantaneous frequency; purity = rms residual of
the log-envelope fit (dB) and the instantaneous-frequency spread (beating = a neighbour).
Electrical-damping estimate (no measurement): with the amps holding 0 V each coil is a shorted damper
c_e = Bl^2 / Re on the coil-vs-magnet velocity; its share of a board mode's damping at the exciter point is
about the fractional feature of that exciter's own coil admittance at f_m (|dY / Y_baseline|), from today's
admittance run `20261015T115434-7x7-coils-p8-weights`. Summed over the 7 exciters -> estimated delta-zeta / zeta.
Usage: python <this> capture <out> | analyse <out>
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RC = r"D:\modal_measurements\rig_checks"
APP = [os.path.join(RC, "20261015T124849-appropriation"), os.path.join(RC, "20261015T135644-appropriation-extra7")]
QCONF = os.path.join(RC, "q-confidence-20261015", "q_confidence.json")
COILS = os.path.join(RC, "20261015T115434-7x7-coils-p8-weights")
FS = 48000
OUTS = ["Out 9", "Out 10", "Out 3", "Out 4", "Out 5", "Out 6", "Out 7"]
INS = [f"In {k}" for k in range(1, 9)]
STEPS = np.arange(-3, 4) * 0.005


def load_plans():
    plans, evals = {}, {}
    for d in APP:
        for p in json.load(open(os.path.join(d, "plan.json"))):
            plans[p["f"]] = p
        for e in json.load(open(os.path.join(d, "eval.json"))):
            evals[e["f"]] = e
    zq = {m["f"]: m["estimators_pct"] for m in json.load(open(QCONF))["modes"]}
    return plans, evals, zq


def pick_vector(ev):
    iso = {k: ev["measured_modal_db_re_opt"][k] - ev["measured_norm_db_re_opt"][k] for k in ("mode", "optimum")}
    return max(iso, key=iso.get), iso


def tone(vec, f, n, fade_in=0.02, fade_out=0.005):
    t = np.arange(n) / FS
    env = np.ones(n); a = int(fade_in * FS); b = int(fade_out * FS)
    env[:a] = np.linspace(0, 1, a); env[-b:] = 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, b))
    return np.stack([env * np.abs(c) * np.cos(2 * np.pi * f * t + np.angle(c)) for c in vec], 1)


def zeta_guess(f, zq):
    z = [v for v in (zq.get("polymax_core"), zq.get("free_decay")) if v]
    return max(0.6, min(z)) / 100 if z else 0.01


def capture(out):
    from pianoid_middleware.modal_adapter.swept_discovery.audio_io import SessionAudioIO
    os.makedirs(out, exist_ok=True)
    plans, evals, zq = load_plans()
    io = SessionAudioIO(os.path.join(out, "sessions"), loopback=None)
    log = []
    for f0 in sorted(plans):
        p = plans[f0]; vk, iso = pick_vector(evals[f0])
        vec = np.array([complex(a, b) for a, b in p["vectors"][vk]])
        u = np.array([complex(a, b) for a, b in p["u"]]); rs = np.array(p["rs"])
        z0 = zeta_guess(f0, zq.get(f0, {})); tau = 1 / (2 * np.pi * f0 * z0)
        # tune
        dwell, meas = max(0.6, 8 * tau), 0.3
        segs = [np.concatenate([tone(vec, f0 * (1 + s), int((dwell + meas) * FS)), np.zeros((int(0.05 * FS), 7))]) for s in STEPS]
        y, m = io.play_record_multi(np.concatenate(segs).astype(np.float32), OUTS, INS, 0.3, f"tune_{f0:.2f}")
        resp = []
        for q, s in enumerate(STEPS):
            s0 = q * int((dwell + meas + 0.05) * FS) + int(dwell * FS); w = y[s0:s0 + int(meas * FS)]
            t = np.arange(len(w)) / FS
            Y = 2 * np.mean(w * np.exp(-2j * np.pi * f0 * (1 + s) * t)[:, None], axis=0)
            resp.append(abs(np.vdot(u, Y / rs)))
        resp = np.array(resp); k = int(np.argmax(resp))
        if 0 < k < len(STEPS) - 1:
            y0, y1, y2 = resp[k - 1:k + 2]; d = 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2)
        else:
            d = 0.0
        ft = f0 * (1 + STEPS[k] + d * 0.005)
        # decay x3
        n_ss, n_dec = int(max(2.0, 10 * tau) * FS), int(max(1.0, 12 * tau) * FS)
        rep = np.concatenate([tone(vec, ft, n_ss), np.zeros((n_dec, 7))])
        y2_, m2 = io.play_record_multi(np.tile(rep, (3, 1)).astype(np.float32), OUTS, INS, 0.3, f"decay_{f0:.2f}")
        pk = float(20 * np.log10(np.abs(y2_).max() + 1e-12))
        log.append({"f": f0, "vector": vk, "isolation_db": iso, "f_tuned": ft, "tune_resp_db": (20 * np.log10(resp / resp.max())).round(2).tolist(),
                    "n_ss": n_ss, "n_dec": n_dec, "tau_guess": tau, "peak_dbfs": pk, "xruns": [m.get("xruns"), m2.get("xruns")]})
        print(f"{f0:7.1f} vec {vk:8s} tuned {ft:8.2f} ({100 * (ft / f0 - 1):+.2f} %) peak {pk:.1f} xruns {m.get('xruns')},{m2.get('xruns')}", flush=True)
        if pk > -3.0:
            print("STOP: input above -3 dBFS"); break
    json.dump(log, open(os.path.join(out, "capture_log.json"), "w"), indent=1)


def analyse(out):
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    from scipy.signal import butter, sosfiltfilt, hilbert
    plans, evals, zq = load_plans()
    log = json.load(open(os.path.join(out, "capture_log.json")))
    # admittance (today, weights on) for the electrical-damping estimate
    import importlib.util
    spec = importlib.util.spec_from_file_location("cr", os.path.join(HERE, "dev-fd69-coils-as-sensors-2026-10-14.py")); cr = importlib.util.module_from_spec(spec); spec.loader.exec_module(cr)
    fc, Hc = cr.frfs(COILS); Hc = Hc.mean(0)
    noise_ref = None
    rows = []
    figs = []
    for L in log:
        f0 = L["f"]; p = plans[f0]
        u = np.array([complex(a, b) for a, b in p["u"]]); rs = np.array(p["rs"])
        y = np.load(os.path.join(out, "sessions", f"decay_{f0:.2f}", "data.npy")).astype(float)
        bw = max(5.0, 0.08 * f0)
        sos = butter(4, [max(5.0, L["f_tuned"] - bw), L["f_tuned"] + bw], btype="band", fs=FS, output="sos")
        yb = sosfiltfilt(sos, y, axis=0)
        za = (hilbert(yb, axis=0) / rs[None, :]) @ np.conj(u)
        per = L["n_ss"] + L["n_dec"]
        zs, fds, res_db, fsd = [], [], [], []
        for r in range(3):
            s0 = r * per + L["n_ss"] + int(0.003 * FS); seg = za[s0:s0 + L["n_dec"] - int(0.003 * FS)]
            env = np.abs(seg); t = np.arange(len(env)) / FS
            nf = np.median(env[-int(0.2 * FS):]) if len(env) > int(0.4 * FS) else env.min()
            top = env[0]; stop = top * 10 ** (-30 / 20)
            n_end = int(np.argmax(env < max(stop, 4 * nf))) if np.any(env < max(stop, 4 * nf)) else len(env)
            n_end = min(n_end, int(8 * L["tau_guess"] * 1.5 * FS) if L["tau_guess"] else len(env))
            if n_end < 30:
                continue
            ll = np.log(env[:n_end]); c = np.polyfit(t[:n_end], ll, 1)
            fit_res = ll - np.polyval(c, t[:n_end])
            ph = np.unwrap(np.angle(seg[:n_end])); fi = np.diff(ph) * FS / (2 * np.pi)
            fd = float(np.median(fi))
            zs.append(float(-c[0] / (2 * np.pi * fd))); fds.append(fd)
            res_db.append(float(20 / np.log(10) * np.std(fit_res))); fsd.append(float(np.std(fi[int(0.1 * len(fi)):]) / fd))
            if r == 0:
                figs.append((f0, t[:n_end], 20 * np.log10(env[:n_end] / top), np.polyval(c, t[:n_end]) * 20 / np.log(10) - 20 * np.log10(top)))
        zs_ = np.array(zs)
        e = zq.get(f0, {})
        # electrical damping estimate: fractional feature of each exciter's coil admittance at f0
        k = int(np.argmin(np.abs(fc - f0))); feat = []
        for j in range(7):
            a = np.abs(Hc[:, j, j]); s = (fc >= f0 / 2 ** (1 / 6)) & (fc <= f0 * 2 ** (1 / 6))
            base = np.median(a[s]); feat.append(abs(a[k] - base) / base)
        zmean = float(zs_.mean()) if len(zs_) else None
        pm_runs = e.get("polymax_runs") or []
        purity = "clean" if res_db and np.median(res_db) < 0.8 and np.median(fsd) < 0.01 else ("beating" if res_db and np.median(res_db) >= 0.8 else "drift")
        ref = [v for v in ([np.mean(pm_runs)] if pm_runs else []) + ([e["polymax_core"]] if e.get("polymax_core") else [])]
        pm = float(np.mean(pm_runs)) if pm_runs else e.get("polymax_core")
        rel = abs(100 * zmean - pm) / pm if zmean and pm else None
        sd_rel = float(zs_.std() / zs_.mean()) if len(zs_) > 1 else None
        conf = ("tight" if (sd_rel is not None and sd_rel <= 0.05 and purity == "clean" and rel is not None and rel <= 0.10) else
                "moderate" if (sd_rel is not None and sd_rel <= 0.15 and rel is not None and rel <= 0.25) else "poor")
        rows.append({"f": f0, "f_tuned": round(L["f_tuned"], 2), "f_damped_decay": round(float(np.mean(fds)), 2) if fds else None, "vector": L["vector"],
                     "zeta_decay_pct": round(100 * zmean, 3) if zmean else None, "zeta_decay_sd_pct": round(100 * float(zs_.std()), 3) if len(zs_) > 1 else None,
                     "Q_decay": round(1 / (2 * zmean), 1) if zmean else None, "zeta_polymax_runs_pct": pm_runs, "zeta_half_power_pct": e.get("half_power"),
                     "zeta_prev_free_decay_pct": e.get("free_decay"), "env_fit_resid_db": round(float(np.median(res_db)), 2) if res_db else None,
                     "inst_freq_rel_sd": round(float(np.median(fsd)), 4) if fsd else None, "purity": purity,
                     "decay_vs_polymax_rel": round(rel, 2) if rel is not None else None, "confidence": conf,
                     "electrical_share_est": round(float(np.sum(feat)), 3), "electrical_share_per_exciter": [round(x, 3) for x in feat]})
    json.dump(rows, open(os.path.join(out, "q_decay.json"), "w"), indent=1)
    n = len(figs); cols = 6; rr = int(np.ceil(n / cols))
    fig, axs = plt.subplots(rr, cols, figsize=(22, 3.2 * rr), squeeze=False)
    for a_, (f0, t, d, fit) in zip(axs.ravel(), figs):
        a_.plot(t * 1000, d, lw=.8); a_.plot(t * 1000, fit, "r--", lw=.8)
        r = [x for x in rows if x["f"] == f0][0]
        a_.set_title(f"{f0:.1f} Hz z {r['zeta_decay_pct']}% {r['purity']}", fontsize=8); a_.set_xlabel("ms", fontsize=7); a_.grid(alpha=.3)
    for a_ in axs.ravel()[n:]:
        a_.axis("off")
    plt.tight_layout(); plt.savefig(os.path.join(out, "q_decays.png"), dpi=70); plt.close()
    fig, ax = plt.subplots(figsize=(15, 5)); x = np.arange(len(rows))
    ax.errorbar(x, [r["zeta_decay_pct"] for r in rows], yerr=[r["zeta_decay_sd_pct"] or 0 for r in rows], fmt="ko", label="decay (3 repeats, mean +- sd)")
    ax.plot(x, [np.mean(r["zeta_polymax_runs_pct"]) if r["zeta_polymax_runs_pct"] else np.nan for r in rows], "bs", mfc="none", label="PolyMAX (3 runs)")
    ax.plot(x, [r["zeta_half_power_pct"] or np.nan for r in rows], "g^", mfc="none", label="half-power (upper bound)")
    ax.set_xticks(x); ax.set_xticklabels([f"{r['f']:.0f}\n{r['confidence'][0]}" for r in rows], fontsize=7); ax.set_ylabel("zeta %"); ax.grid(alpha=.3); ax.legend(fontsize=8)
    ax.set_title("Q remeasurement: appropriated stop-and-decay vs PolyMAX vs half-power (t/m/p = confidence)", fontsize=9)
    plt.tight_layout(); plt.savefig(os.path.join(out, "q_decay_summary.png"), dpi=85)
    for r in rows:
        print(f"{r['f']:7.1f} tuned {r['f_tuned']} fd {r['f_damped_decay']} {r['vector']:8s} z {r['zeta_decay_pct']}+-{r['zeta_decay_sd_pct']} Q {r['Q_decay']} | PM {r['zeta_polymax_runs_pct']} HP {r['zeta_half_power_pct']} | resid {r['env_fit_resid_db']} dB fsd {r['inst_freq_rel_sd']} {r['purity']} rel {r['decay_vs_polymax_rel']} {r['confidence']} elec {r['electrical_share_est']}")


if __name__ == "__main__":
    {"capture": capture, "analyse": analyse}[sys.argv[1]](sys.argv[2])
