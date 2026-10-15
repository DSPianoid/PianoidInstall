"""dev-fd69 2026-10-15: live check of mode-shape-driven excitation (force appropriation) at equal current RMS.

Rig (10-15): E1 -> Out 9, E2 -> Out 10, E3..E7 -> Out 3..7 (weights on the exciters); P1-P7 on In 1-7 (10-14
positions), P8 (at E7) on In 8; no loopback - one backend session; latency from the E7 -> P8 driving point.

prep:  FRFs (per volt, 8 sensors x 7 exciters) from the three 7x7 runs <prefix>-7x7-piezos-weights-r{1,2,3};
       poles: consensus < 200 Hz (bootstrap / settings grid, >= 2 of 3 runs, >= 25 % of fits) + PolyMAX 200-1100 Hz
       on the mean FRF; LSFD residues; per mode u (response over P1-P8), v (drive over E1-E7), rank-1 share,
       repeat MAC (u across the 3 runs), cross-exciter MAC.
       Force frame: today's coil admittance Y_e(f) = I_e / V_e from <coil run> (10-15 11:54, weights on; current-
       sense channels assumed equal sensitivity). H_I = H_V diag(1/Y) is the response per ampere.
       Mode selection: repeat MAC >= 0.9 and rank-1 share >= 0.6 (>= 0.5 below 200 Hz), up to 18 spread over the band.
       Vectors per mode at f_m in the CURRENT domain, unit ||I||: mode (v_I from R_I = R_V diag(1/Y)), optimum
       (top right singular vector of H_I(f_m)), best single exciter, uniform, 3 random. Drive voltages
       V = I / Y(f_m); one common scale per mode so that every output stays <= CAP dBFS peak (E2 <= CAP_E2).
       Predicted ||H_I I|| (8 sensors) and modal projection |u^H H_I I| per vector.
live:  per mode one session: 7 dwells (one per vector), each 2.0 s settle + 1.0 s measure + 0.2 s gap, 20 ms fades,
       all 7 outputs, In 1-8 recorded; guard: stop if any input > -3 dBFS.
eval:  lock-in at f_m on the measure windows -> measured ||y|| and modal projection per vector, dB re the optimum
       vector; live vs predicted; MAC(mode vector, optimum).
Usage: python <this> prep <prefix> <coil_run> <out> [--only=f1,f2,..] [--reuse=<prep.json>] | live <out> | eval <out>
"""
import itertools
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
FS = 48000
EXC = [f"E{k}" for k in range(1, 8)]
OUTS = ["Out 9", "Out 10", "Out 3", "Out 4", "Out 5", "Out 6", "Out 7"]
INS = [f"In {k}" for k in range(1, 9)]
CAP, CAP_E2 = -36.0, -42.0
SETTLE, MEAS, GAP, FADE = 2.0, 1.0, 0.2, 0.02
HUM = (50.0, 100.0, 150.0)


def _mod(name, fn):
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, fn)); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


def mac(a, b):
    return float(np.abs(np.vdot(a, b)) ** 2 / (np.vdot(a, a).real * np.vdot(b, b).real + 1e-300))


def lam_of(fz, z):
    w = 2 * np.pi * fz
    return -z * w + 1j * w * np.sqrt(1 - z * z)


def frfs8(run, fmax=1150.0):
    from pianoid_middleware.modal_adapter.measurement.ess import deconvolve, exp_sweep
    NIR = 4 * FS
    win = np.ones(NIR); nf = int(0.1 * NIR); win[-nf:] = 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, nf))
    cfg = json.load(open(os.path.join(run, "config.json")))
    f = np.fft.rfftfreq(NIR, 1 / FS); keep = f <= fmax
    Hs = np.zeros((3, int(keep.sum()), 8, 7), complex); onset = []
    for j, e in enumerate(EXC):
        lv = cfg["levels"][e]; x = exp_sweep(20.0, 2000.0, 20.0, FS, lv)
        for r in range(3):
            y = np.load(os.path.join(run, "sessions", f"{e}_m{-lv}_r{r + 1}", "data.npy")).astype(float)
            hh = deconvolve(y, x, FS, (20.0, 2000.0))
            if e == "E7":
                onset.append(int(np.argmax(np.abs(hh[:4800, 7]))))      # E7 -> P8 driving-point IR peak (latency tracker)
            h = np.roll(hh, 30, axis=0)[:NIR] * win[:, None]
            Hs[r, :, :, j] = np.fft.rfft(h, axis=0)[keep]
    return f[keep], Hs, onset


def prep(prefix, coil_run, out, only=None, reuse=None):
    """only: list of mode frequencies to plan (nearest pole); reuse: prep.json whose pole list is reused (no re-fit)."""
    os.makedirs(out, exist_ok=True)
    from pianoid_middleware.modal_adapter.polymax.identify import PolymaxConfig, identify
    from pianoid_middleware.modal_adapter.polymax.lsfd import lsfd
    cs = _mod("cs", "dev-fd69-consensus-lt200-2026-10-14.py")
    runs = [f"{prefix}-7x7-piezos-weights-r{k}" for k in (1, 2, 3)]
    F, M, V, ON = None, [], [], {}
    for r in runs:
        f, Hs, on = frfs8(r); F = f; M.append(Hs.mean(0)); V.append(np.maximum(Hs.var(0) / 3, 1e-30)); ON[os.path.basename(r)] = on
    f = F
    hum = np.all([np.abs(f - h) > 1.0 for h in HUM], axis=0)
    if reuse:
        modes = [{"f": m["f"], "zeta": m["zeta_pct"] / 100, "src": m["src"]} for m in json.load(open(reuse))["modes"]]
        cons = [m for m in modes if m["src"].startswith("consensus")]
    else:
        modes = None
    # consensus < 200 Hz (3 runs, 12 fits each)
    rng = np.random.default_rng(3); allp = []; nf = {}
    for k, r in enumerate([] if reuse else runs):
        fr, reps = cs.load_run(r)
        P = cs.fits_for_run(fr, reps, 200.0, 1, rng); nf[k] = len(P)
        allp += [(fz, z, lam, k, i) for i, fit in enumerate(P) for fz, z, lam in fit]
    tot = sum(nf.values()) or 1
    cons = cons if reuse else []
    for c in ([] if reuse else cs.cluster(allp)):
        if len({p[3] for p in c}) >= 2 and len({(p[3], p[4]) for p in c}) / tot >= 0.25:
            cons.append((float(np.median([p[0] for p in c])), float(np.median([p[1] for p in c]))))
    # 200-1100 Hz single PolyMAX on the mean of the 3 runs
    Hm = np.mean(M, axis=0); Vm = np.mean(V, axis=0) / 3
    s = (f >= 200) & (f <= 1100) & hum
    if not reuse:
        fit = identify(f[s], Hm[s], PolymaxConfig(band_edges=(200.0, 350.0, 600.0, 1100.0), p_max=40, prune=True), Vm[s])
        modes = [{"f": a, "zeta": b, "src": "consensus <200"} for a, b in cons] + [{"f": x["f_hz"], "zeta": x["zeta"], "src": "PolyMAX 200-1100"} for x in fit["modes"]]
    lam = np.array([lam_of(m["f"], m["zeta"]) for m in modes])
    bands = [(25.0, 200.0), (200.0, 600.0), (600.0, 1100.0)]

    def residues(Hx, Vx):
        R = np.zeros((len(modes), 8, 7), complex)
        for lo, hi in bands:
            ss = (f >= lo) & (f <= hi) & hum
            u = np.array([lo * 0.98 <= m["f"] <= hi * 1.02 for m in modes])
            if not u.any():
                continue
            ft = lsfd(f[ss], Hx[ss], lam[u], 1 / np.sqrt(Vx[ss].mean(axis=2)))
            for k, i in enumerate(np.flatnonzero(u)):
                if lo <= modes[i]["f"] < hi or (hi == 1100.0 and modes[i]["f"] <= hi):
                    R[i] = ft.residues[k]
        return R
    Rr = [residues(M[k], V[k]) for k in range(3)]; R = residues(Hm, Vm)
    # admittance today (per volt current of each exciter, 10-15 coil run)
    cr = _mod("cr", "dev-fd69-coils-as-sensors-2026-10-14.py")
    fc, Hc = cr.frfs(coil_run); Hc = Hc.mean(0)
    Y = np.stack([np.interp(f, fc, Hc[:, k, k].real) + 1j * np.interp(f, fc, Hc[:, k, k].imag) for k in range(7)], axis=1)   # (F, 7)
    rows, plan = [], []
    rs = np.sqrt(np.median(Vm[(f >= 25) & hum].mean(axis=2), axis=0))
    for i, m in enumerate(modes):
        k = int(np.argmin(np.abs(f - m["f"])))
        Yk = Y[k]
        RI = R[i] / Yk[None, :]                                     # residues per ampere
        Uu, Ss, Vh = np.linalg.svd(RI / rs[:, None]); u = Uu[:, 0]; vI = Vh[0].conj()
        r1 = float(Ss[0] ** 2 / np.sum(Ss ** 2))
        reps_u = []
        for q in range(3):
            Uq, _, _ = np.linalg.svd((Rr[q][i] / Yk[None, :]) / rs[:, None]); reps_u.append(Uq[:, 0])
        rep = float(np.median([mac(reps_u[a], reps_u[b]) for a, b in itertools.combinations(range(3), 2)]))
        xm = float(np.median([mac(RI[:, a], RI[:, b]) for a, b in itertools.combinations(range(7), 2)]))
        HI = Hm[k] / Yk[None, :]
        _, sv, Vh2 = np.linalg.svd(HI); vopt = Vh2[0].conj()
        gains = {j: np.linalg.norm(HI[:, j]) for j in range(7)}; jbest = max(gains, key=gains.get)
        rg = np.random.default_rng(int(m["f"] * 10))
        vecs = {"mode": vI, "optimum": vopt, "single": np.eye(7)[jbest].astype(complex), "uniform": np.ones(7, complex)}
        for q in range(3):
            vecs[f"random{q + 1}"] = rg.normal(size=7) + 1j * rg.normal(size=7)
        vecs = {kk: vv / np.linalg.norm(vv) for kk, vv in vecs.items()}
        pred = {kk: {"norm_db": float(20 * np.log10(np.linalg.norm(HI @ vv))), "modal_db": float(20 * np.log10(np.abs(np.vdot(u, (HI @ vv) / rs)) + 1e-30))}
                for kk, vv in vecs.items()}
        rows.append({"f": round(m["f"], 2), "zeta_pct": round(100 * m["zeta"], 2), "src": m["src"], "rank1": round(r1, 2), "repeat_mac": round(rep, 2),
                     "cross_exciter_mac": round(xm, 2), "mac_mode_vs_opt": round(mac(vI, vopt), 2), "best_single": f"E{jbest + 1}",
                     "pred_norm_db_re_opt": {kk: round(v["norm_db"] - pred["optimum"]["norm_db"], 2) for kk, v in pred.items()},
                     "pred_modal_db_re_opt": {kk: round(v["modal_db"] - pred["optimum"]["modal_db"], 2) for kk, v in pred.items()},
                     "u": [[round(float(abs(x)), 3), round(float(np.degrees(np.angle(x))), 1)] for x in u],
                     "v_current": [[round(float(abs(x)), 3), round(float(np.degrees(np.angle(x))), 1)] for x in vI]})
        rows[-1]["_vecs"] = vecs; rows[-1]["_Y"] = Yk; rows[-1]["_u"] = u; rows[-1]["_rs"] = rs
    sel = [r for r in rows if r["repeat_mac"] >= 0.9 and 40 <= r["f"] <= 1100 and (r["rank1"] >= 0.6 or (r["f"] < 200 and r["rank1"] >= 0.5))]
    if only:
        sel = [min(rows, key=lambda r: abs(r["f"] - q)) for q in only]
    elif len(sel) > 18:
        idx = np.round(np.linspace(0, len(sel) - 1, 18)).astype(int); sel = [sel[i] for i in idx]
    for r in sel:
        # drive voltages V = I / Y, common scale per mode so that all outputs stay under the caps (peak = |V|)
        caps = np.array([10 ** ((CAP_E2 if e == "E2" else CAP) / 20) for e in EXC])
        need = max(np.max(np.abs(vv / r["_Y"]) / caps) for vv in r["_vecs"].values())
        sc = 1.0 / need
        plan.append({"f": r["f"], "vectors": {kk: [[float((sc * vv[e] / r["_Y"][e]).real), float((sc * vv[e] / r["_Y"][e]).imag)] for e in range(7)] for kk, vv in r["_vecs"].items()},
                     "current_norm": sc, "u": [[float(x.real), float(x.imag)] for x in r["_u"]], "rs": r["_rs"].tolist(),
                     "predicted": {"norm_db_re_opt": r["pred_norm_db_re_opt"], "modal_db_re_opt": r["pred_modal_db_re_opt"]},
                     "max_drive_dbfs": float(20 * np.log10(max(np.max(np.abs(sc * vv / r["_Y"])) for vv in r["_vecs"].values())))})
    for r in rows:
        for kk in ("_vecs", "_Y", "_u", "_rs"):
            r.pop(kk, None)
    json.dump({"runs": runs, "coil_run": coil_run, "latency_E7_P8_ir_peak_samples": ON, "n_consensus_lt200": len(cons), "modes": rows,
               "selected": [p["f"] for p in plan]}, open(os.path.join(out, "prep.json"), "w"), indent=1)
    json.dump(plan, open(os.path.join(out, "plan.json"), "w"), indent=1)
    print("latency E7->P8 IR peak per run (samples):", ON)
    print(f"modes {len(rows)} ({len(cons)} consensus <200); selected {len(plan)}:", [p["f"] for p in plan])
    for r in rows:
        if r["f"] in [p["f"] for p in plan]:
            print(f"{r['f']:7.1f} r1 {r['rank1']:.2f} rep {r['repeat_mac']:.2f} xMAC {r['cross_exciter_mac']:.2f} MAC(mode,opt) {r['mac_mode_vs_opt']:.2f} "
                  f"pred norm {r['pred_norm_db_re_opt']} max drive {[p['max_drive_dbfs'] for p in plan if p['f'] == r['f']][0]:.1f} dBFS")


def build(p):
    n_on, n_meas, n_gap = int(SETTLE * FS), int(MEAS * FS), int(GAP * FS)
    t = np.arange(n_on + n_meas) / FS; nf = int(FADE * FS)
    env = np.ones_like(t); env[:nf] = np.linspace(0, 1, nf); env[-nf:] = np.linspace(1, 0, nf)
    segs, order = [], list(p["vectors"])
    for kk in order:
        c = np.array([complex(a, b) for a, b in p["vectors"][kk]])
        sig = np.stack([env * np.abs(c[e]) * np.cos(2 * np.pi * p["f"] * t + np.angle(c[e])) for e in range(7)], 1)
        segs += [sig, np.zeros((n_gap, 7))]
    return np.concatenate(segs).astype(np.float32), order


def live(out):
    from pianoid_middleware.modal_adapter.swept_discovery.audio_io import SessionAudioIO
    plan = json.load(open(os.path.join(out, "plan.json")))
    io = SessionAudioIO(os.path.join(out, "sessions"), loopback=None)
    log = []
    for p in plan:
        sig, order = build(p)
        y, m = io.play_record_multi(sig, OUTS, INS, 0.5, f"f{p['f']:.2f}")
        pk = float(20 * np.log10(np.abs(y).max() + 1e-12))
        log.append({"f": p["f"], "order": order, "peak": pk, "xruns": m.get("xruns"), "status": m.get("status")})
        print(f"{p['f']:.1f} Hz peak {pk:.1f} dBFS xruns {m.get('xruns')}", flush=True)
        if pk > -3.0:
            print("STOP: input above -3 dBFS"); break
    json.dump(log, open(os.path.join(out, "live_log.json"), "w"), indent=1)


def evaluate(out):
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    plan = {p["f"]: p for p in json.load(open(os.path.join(out, "plan.json")))}
    log = json.load(open(os.path.join(out, "live_log.json")))
    n_on, n_meas, n_gap = int(SETTLE * FS), int(MEAS * FS), int(GAP * FS)
    res = []
    for L in log:
        p = plan[L["f"]]; y = np.load(os.path.join(out, "sessions", f"f{L['f']:.2f}", "data.npy")).astype(float)
        u = np.array([complex(a, b) for a, b in p["u"]]); rs = np.array(p["rs"])
        meas = {}
        for q, kk in enumerate(L["order"]):
            s0 = q * (n_on + n_meas + n_gap) + n_on
            w = y[s0:s0 + n_meas]; t = np.arange(len(w)) / FS
            Y = 2 * np.mean(w * np.exp(-2j * np.pi * L["f"] * t)[:, None], axis=0)      # complex amplitude per input
            meas[kk] = {"norm": float(20 * np.log10(np.linalg.norm(Y))), "modal": float(20 * np.log10(np.abs(np.vdot(u, Y / rs)) + 1e-30))}
        o = meas["optimum"]
        row = {"f": L["f"], "measured_norm_db_re_opt": {k: round(v["norm"] - o["norm"], 2) for k, v in meas.items()},
               "measured_modal_db_re_opt": {k: round(v["modal"] - o["modal"], 2) for k, v in meas.items()},
               "predicted_norm_db_re_opt": p["predicted"]["norm_db_re_opt"], "predicted_modal_db_re_opt": p["predicted"]["modal_db_re_opt"]}
        row["live_minus_pred_norm_db"] = {k: round(row["measured_norm_db_re_opt"][k] - row["predicted_norm_db_re_opt"][k], 2) for k in meas}
        res.append(row)
    json.dump(res, open(os.path.join(out, "eval.json"), "w"), indent=1)
    kinds = ["mode", "optimum", "single", "uniform", "random1", "random2", "random3"]
    fig, ax = plt.subplots(1, 2, figsize=(16, 5))
    x = np.arange(len(res))
    for q, k in enumerate(kinds):
        ax[0].plot(x, [r["measured_norm_db_re_opt"][k] for r in res], "o-" if k in ("mode", "optimum", "single", "uniform") else ".:", label=k)
        ax[1].plot(x, [r["measured_modal_db_re_opt"][k] for r in res], "o-" if k in ("mode", "optimum", "single", "uniform") else ".:", label=k)
    ax[0].plot(x, [r["predicted_norm_db_re_opt"]["mode"] for r in res], "k^", ms=7, mfc="none", label="mode (predicted)")
    for a_, ttl in zip(ax, ("total response ||y|| at P1-P8, dB re optimum vector (equal current RMS)", "response of the target mode (projection on its shape), dB re optimum vector")):
        a_.set_xticks(x); a_.set_xticklabels([f"{r['f']:.0f}" for r in res], rotation=60); a_.set_xlabel("mode (Hz)"); a_.set_title(ttl, fontsize=9); a_.grid(alpha=.3); a_.legend(fontsize=7)
    plt.tight_layout(); plt.savefig(os.path.join(out, "appropriation_live.png"), dpi=85)
    for r in res:
        print(f"{r['f']:7.1f} meas {r['measured_norm_db_re_opt']}  pred mode {r['predicted_norm_db_re_opt']['mode']:+.2f} live-pred(mode) {r['live_minus_pred_norm_db']['mode']:+.2f}")


if __name__ == "__main__":
    if sys.argv[1] == "prep":
        only = next(([float(x) for x in a.split("=", 1)[1].split(",")] for a in sys.argv if a.startswith("--only=")), None)
        reuse = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--reuse=")), None)
        prep(*sys.argv[2:5], only=only, reuse=reuse)
    elif sys.argv[1] == "live":
        live(sys.argv[2])
    else:
        evaluate(sys.argv[2])
