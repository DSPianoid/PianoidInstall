"""dev-fd69 2026-10-15: damping / Q confidence for the 24 core modes (17 + 7 live-appropriated), analysis only.

Estimators per mode (all from data on disk, 10-15 configuration unless noted):
  E1 PolyMAX per run: zeta of the nearest pole (<= 1 %) in each of r1 / r2 / r3 (band set A, p_max 40).
  E2 PolyMAX settings spread on the 3-run mean FRF: 3 band sets x p_max 30/40/50.
  E3 half-power bandwidth of the enhanced FRF e(f) = u^H H(f) v (u, v = top singular vectors of H(f_m),
     the appropriated FRF), linear |e|^2 interpolation.
  E4 single-mode fit (pole + residual terms) on e(f) over f_m +- 6 %.
  E5 free decay: the 0.2 s gap after each live dwell (mode / optimum vectors) - modal-filtered (u^H y),
     band-passed around f_m, log-envelope slope -> zeta (only where >= 6 tau fit in the gap; else n/a).
  D  previous day (10-14, before weights): consensus zeta (< 200 Hz) / 7x7 morning PolyMAX (>= 200 Hz).
Biases quantified: frequency resolution vs bandwidth (0.25 Hz lines, 4 s IR window vs tau), modal overlap
factor M = (half-power bandwidth) / (distance to the nearest other pole), drift (10-14 morning vs ladder 0 dB,
same level, 1.7 h apart).
Usage: python <this> <out_dir>
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RC = r"D:\modal_measurements\rig_checks"
PREFIX = os.path.join(RC, "20261015T124849")
APP = [os.path.join(RC, "20261015T124849-appropriation"), os.path.join(RC, "20261015T135644-appropriation-extra7")]
FS = 48000


def _mod(name, fn):
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, fn)); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


def sdof_fit(f, e, f0):
    from scipy.optimize import least_squares
    s = (f > f0 * 0.94) & (f < f0 * 1.06)
    w = 2j * np.pi * f[s]; y = e[s]; sc = np.abs(y).max()

    def model(p):
        lam = -p[1] * 2 * np.pi * p[0] + 1j * 2 * np.pi * p[0] * np.sqrt(max(1 - p[1] ** 2, 1e-9))
        A = p[2] + 1j * p[3]
        return A / (w - lam) + np.conj(A) / (w - np.conj(lam)) + (p[4] + 1j * p[5]) + (p[6] + 1j * p[7]) * w
    p0 = [f0, 0.02, 0.0, -sc * 2 * np.pi * f0 * 0.02, 0, 0, 0, 0]
    r = least_squares(lambda p: np.concatenate([(model(p) - y).real, (model(p) - y).imag]) / sc, p0,
                      bounds=([f0 * 0.97, 0.002] + [-np.inf] * 6, [f0 * 1.03, 0.15] + [np.inf] * 6))
    return float(r.x[1])


def half_power(f, e, f0):
    s = (f > f0 * 0.85) & (f < f0 * 1.15); ff = f[s]; p = np.abs(e[s]) ** 2
    k = int(np.argmin(np.abs(ff - f0))); k = max(1, min(len(ff) - 2, k))
    k = k - 3 + int(np.argmax(p[max(0, k - 3):k + 4])) if k >= 3 else int(np.argmax(p))
    half = p[k] / 2
    l = k
    while l > 0 and p[l] > half:
        l -= 1
    r = k
    while r < len(p) - 1 and p[r] > half:
        r += 1
    if l == 0 or r == len(p) - 1:
        return None
    fl = np.interp(half, [p[l], p[l + 1]], [ff[l], ff[l + 1]]); fr = np.interp(half, [p[r], p[r - 1]], [ff[r], ff[r - 1]])
    return float((fr - fl) / (2 * ff[k]))


def decay_zeta(y, u, f0, t0, dur):
    from scipy.signal import butter, sosfiltfilt, hilbert
    seg = y[t0:t0 + dur] @ np.conj(u)                      # modal filter (complex sensor weights -> use real part)
    seg = np.real(seg)
    bw = max(4.0, 0.08 * f0)
    sos = butter(4, [max(1.0, f0 - bw), f0 + bw], btype="band", fs=FS, output="sos")
    x = sosfiltfilt(sos, seg)
    env = np.abs(hilbert(x)); t = np.arange(len(env)) / FS
    a = int(0.01 * FS); b = len(env) - int(0.03 * FS)       # skip edge effects of the filter
    e = env[a:b]; tt = t[a:b]
    good = e > e.max() * 10 ** (-30 / 20)                  # first 30 dB of decay
    if good.sum() < 20:
        return None
    sl = np.polyfit(tt[good][: int(good.sum())], np.log(e[good]), 1)[0]
    z = -sl / (2 * np.pi * f0)
    return float(z) if 0.001 < z < 0.2 else None


def main(out):
    os.makedirs(out, exist_ok=True)
    from pianoid_middleware.modal_adapter.polymax.identify import PolymaxConfig, identify
    al = _mod("al", "dev-fd69-appropriation-live-2026-10-15.py")
    prep = json.load(open(os.path.join(APP[0], "prep.json")))
    allmodes = [(m["f"], m["zeta_pct"]) for m in prep["modes"]]
    core = []
    for d in APP:
        core += [p["f"] for p in json.load(open(os.path.join(d, "plan.json")))]
    core = sorted(core)
    runs = [f"{PREFIX}-7x7-piezos-weights-r{k}" for k in (1, 2, 3)]
    Hs = []
    for r in runs:
        f, H, _ = al.frfs8(r); Hs.append(H)
    Hm = [h.mean(0) for h in Hs]; Vm = [np.maximum(h.var(0) / 3, 1e-30) for h in Hs]
    Hmean = np.mean(Hm, 0); Vmean = np.mean(Vm, 0) / 3
    hum = np.all([np.abs(f - h) > 1.0 for h in (50.0, 100.0, 150.0)], axis=0)
    BANDS = {"A": (25.0, 60.0, 120.0, 200.0, 350.0, 600.0, 1100.0), "B": (25.0, 45.0, 90.0, 140.0, 260.0, 450.0, 800.0, 1100.0),
             "C": (25.0, 70.0, 105.0, 160.0, 300.0, 500.0, 700.0, 950.0, 1100.0)}
    sel = (f >= 25) & (f <= 1100) & hum

    def poles(H, V, edges, pm):
        fit = identify(f[sel], H[sel], PolymaxConfig(band_edges=edges, p_max=pm, prune=True), V[sel])
        return [(x["f_hz"], x["zeta"]) for x in fit["modes"]]
    per_run = [poles(Hm[k], Vm[k], BANDS["A"], 40) for k in range(3)]
    settings = [poles(Hmean, Vmean, BANDS[b], pm) for b in BANDS for pm in (30, 40, 50)]
    near = lambda lst, f0: min(lst, key=lambda x: abs(x[0] - f0)) if lst else None
    pick = lambda lst, f0: (lambda q: q[1] if q and abs(q[0] - f0) / f0 <= 0.01 else None)(near(lst, f0))
    # previous day
    cons_prev = json.load(open(os.path.join(RC, "consensus-lt200-20261014", "consensus_lt200.json")))["consensus"]
    morn = json.load(open(os.path.join(RC, "20261014T144226-fixed-layout-7x7", "report.json")))["modes"]
    prev = [(x["f"], x["zeta_pct"] / 100) for x in cons_prev] + [(x["f"], x["zeta_pct"] / 100) for x in morn if x["f"] >= 200]
    # drift reference: 10-14 morning vs ladder 0 dB (same level, 1.7 h)
    lad = json.load(open(os.path.join(RC, "20261014T161215-ladder-7x7-m0", "report.json")))["modes"]
    dz = [abs(b["zeta_pct"] - a["zeta_pct"]) / a["zeta_pct"] for a in morn for b in lad if abs(b["f"] - a["f"]) / a["f"] < 0.005]
    # live decays
    live = {}
    for d in APP:
        log = json.load(open(os.path.join(d, "live_log.json"))); plan = {p["f"]: p for p in json.load(open(os.path.join(d, "plan.json")))}
        for L in log:
            y = np.load(os.path.join(d, "sessions", f"f{L['f']:.2f}", "data.npy")).astype(float)
            u = np.array([complex(a, b) for a, b in plan[L["f"]]["u"]])
            n_on, n_meas, n_gap = int(al.SETTLE * FS), int(al.MEAS * FS), int(al.GAP * FS)
            zs = []
            for q, kk in enumerate(L["order"]):
                if kk not in ("mode", "optimum"):
                    continue
                t0 = q * (n_on + n_meas + n_gap) + n_on + n_meas      # end of the dwell (incl. 20 ms fade-out)
                z = decay_zeta(y, u, L["f"], t0, n_gap)
                tau = 1 / (2 * np.pi * L["f"] * (z or 0.02))
                if z and n_gap / FS >= 3 * tau:
                    zs.append(z)
            live[L["f"]] = float(np.median(zs)) if zs else None
    rows = []
    allf = np.array([a for a, _ in allmodes])
    for f0 in core:
        k = int(np.argmin(np.abs(f - f0)))
        U, S, Vh = np.linalg.svd(Hmean[k]); u, v = U[:, 0], Vh[0].conj()
        e = np.einsum("i,fij,j->f", u.conj(), Hmean, v)
        zhp = half_power(f, e, f0)
        try:
            zsd = sdof_fit(f, e, f0)
        except Exception:
            zsd = None
        zr = [pick(p, f0) for p in per_run]
        zst = [pick(p, f0) for p in settings]
        zbase = dict(allmodes).get(f0)
        zp = pick(prev, f0)
        bw = 2 * (zbase or 1.5) / 100 * f0
        others = allf[np.abs(allf - f0) > 0.003 * f0]
        overlap = float(bw / np.min(np.abs(others - f0))) if len(others) else None
        tau = 1 / (2 * np.pi * f0 * (zbase or 1.5) / 100)
        est = {"polymax_core": zbase / 100 if zbase else None,
               "polymax_runs": [z for z in zr if z], "polymax_settings": [z for z in zst if z],
               "half_power": zhp, "sdof_fit": zsd, "free_decay": live.get(f0)}
        indep = [x for x in [np.median(est["polymax_runs"]) if est["polymax_runs"] else None, np.median(est["polymax_settings"]) if est["polymax_settings"] else None,
                             zhp, zsd, live.get(f0)] if x]
        zmed = float(np.median(indep)) if indep else None
        spread = float((max(indep) - min(indep)) / (2 * zmed)) if len(indep) >= 2 else None    # +- half-range relative
        run_sd = float(np.std(est["polymax_runs"]) / np.mean(est["polymax_runs"])) if len(est["polymax_runs"]) >= 2 else None
        cls = "tight" if spread is not None and spread <= 0.10 else ("moderate" if spread is not None and spread <= 0.25 else "poor")
        rows.append({"f": f0, "zeta_pct_median": round(100 * zmed, 2) if zmed else None, "Q_median": round(1 / (2 * zmed), 1) if zmed else None,
                     "pm_half_range_rel": round(spread, 2) if spread is not None else None, "class": cls,
                     "estimators_pct": {"polymax_core": round(zbase, 2) if zbase else None,
                                        "polymax_runs": [round(100 * z, 2) for z in est["polymax_runs"]],
                                        "polymax_settings_min_max": [round(100 * min(est["polymax_settings"]), 2), round(100 * max(est["polymax_settings"]), 2)] if est["polymax_settings"] else None,
                                        "half_power": round(100 * zhp, 2) if zhp else None, "sdof_fit": round(100 * zsd, 2) if zsd else None,
                                        "free_decay": round(100 * live[f0], 2) if live.get(f0) else None},
                     "run_to_run_cv": round(run_sd, 3) if run_sd is not None else None,
                     "prev_day_zeta_pct": round(100 * zp, 2) if zp else None,
                     "bandwidth_hz": round(bw, 2), "resolution_lines_in_bw": round(bw / 0.25, 1), "tau_s": round(tau, 3), "ir_window_over_tau": round(4.0 / tau, 0),
                     "overlap_factor": round(overlap, 2) if overlap else None})
    summ = {"n": len(rows), "class_counts": {c: sum(r["class"] == c for r in rows) for c in ("tight", "moderate", "poor")},
            "median_half_range_rel": round(float(np.median([r["pm_half_range_rel"] for r in rows if r["pm_half_range_rel"] is not None])), 2),
            "drift_10-14_morning_vs_ladder_rel_dzeta_median": round(float(np.median(dz)), 3),
            "prev_day_ratio_median": round(float(np.median([r["zeta_pct_median"] / r["prev_day_zeta_pct"] for r in rows if r["prev_day_zeta_pct"] and r["zeta_pct_median"]])), 2),
            "n_prev_matched": sum(1 for r in rows if r["prev_day_zeta_pct"]),
            "free_decay_available": sum(1 for r in rows if r["estimators_pct"]["free_decay"])}
    json.dump({"summary": summ, "modes": rows}, open(os.path.join(out, "q_confidence.json"), "w"), indent=1)
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(15, 5)); x = np.arange(len(rows))
    for key, mk in (("half_power", "s"), ("sdof_fit", "^"), ("free_decay", "D"), ("polymax_core", "o")):
        ax.plot(x, [r["estimators_pct"][key] if r["estimators_pct"][key] else np.nan for r in rows], mk, label=key, ms=6, mfc="none")
    for i, r in enumerate(rows):
        if r["estimators_pct"]["polymax_runs"]:
            ax.plot([i] * len(r["estimators_pct"]["polymax_runs"]), r["estimators_pct"]["polymax_runs"], "k.", ms=4)
        if r["estimators_pct"]["polymax_settings_min_max"]:
            ax.vlines(i + 0.15, *r["estimators_pct"]["polymax_settings_min_max"], color="0.5")
        if r["prev_day_zeta_pct"]:
            ax.plot(i, r["prev_day_zeta_pct"], "rx", ms=7)
    ax.plot([], [], "k.", label="PolyMAX r1/r2/r3"); ax.vlines([], 0, 0, color="0.5", label="PolyMAX settings range"); ax.plot([], [], "rx", label="10-14 (before weights)")
    ax.set_xticks(x); ax.set_xticklabels([f"{r['f']:.0f}\n{r['class'][0]}" for r in rows], fontsize=7); ax.set_ylabel("zeta %"); ax.grid(alpha=.3); ax.legend(fontsize=7, ncol=4)
    ax.set_title("Damping of the 24 core modes by estimator (class: t tight / m moderate / p poor)", fontsize=9)
    plt.tight_layout(); plt.savefig(os.path.join(out, "q_confidence.png"), dpi=85)
    print(json.dumps(summ, indent=0))
    for r in rows:
        print(f"{r['f']:7.1f} z {r['zeta_pct_median']}% Q {r['Q_median']} ±{r['pm_half_range_rel']} {r['class']:8s} est {r['estimators_pct']} prev {r['prev_day_zeta_pct']} M {r['overlap_factor']} lines/bw {r['resolution_lines_in_bw']} win/tau {r['ir_window_over_tau']}")


if __name__ == "__main__":
    main(sys.argv[1])
