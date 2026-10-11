"""dev-fd69 offline re-analysis of the 2026-10-11 rig recordings (no audio device needed).

Inputs (read-only): swept runs D:/modal_measurements/swept_discovery/20261011-rig{1,2,3}
(coarse ESS sessions per exciter, noise record, coarse_frf.npz, swept modes.npz), the impulse
ESPRIT result of ASIO-rig-2026-10-11b_p1 and the 2026-10-11 swept replay (independent fits).

Outputs: D:/modal_measurements/analysis/dev-fd69-2026-10-11/
  rig_checks_offline.json   harmonic distortion, early arrival, interface crosstalk, repeat
                            coherence (rig1-3), SNR, sigma2/sigma1 at peaks, ESS quasi-stationarity
  chirp_esprit/<run>/       ESPRIT (project params, GPU) on IRs deconvolved from the coarse ESS
  polymax/<run>/            PolyMAX joint fit (+ loo_without_* on rig3)
  comparison.log / .json    cross-exciter, cross-run and cross-method tables
  *.png                     plots

Run:  D:/repos/PianoidInstall/PianoidCore/.venv/Scripts/python.exe <this file> [--core D:/repos/wt-fd69-core]
"""
import argparse
import json
import os
import pickle
import sys
import time

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("--core", default=r"D:\repos\wt-fd69-core")
ap.add_argument("--out", default=r"D:\modal_measurements\analysis\dev-fd69-2026-10-11")
ap.add_argument("--skip-esprit", action="store_true")
A = ap.parse_args()
sys.path.insert(0, A.core)

from pianoid_middleware.modal_adapter import mode_comparison as C  # noqa: E402
from pianoid_middleware.modal_adapter.esprit_runner import EspritRunner  # noqa: E402
from pianoid_middleware.modal_adapter.measurement.ess import deconvolve, split_ess_irs  # noqa: E402
from pianoid_middleware.modal_adapter.polymax.identify import PolymaxConfig, identify  # noqa: E402
from pianoid_middleware.modal_adapter.polymax.report import write_report as pm_write  # noqa: E402
from pianoid_middleware.modal_adapter.swept_discovery import rig_checks as RC  # noqa: E402
from pianoid_middleware.modal_adapter.swept_discovery.signals import (  # noqa: E402
    ess_rate_hz_s, quasi_stationarity)

FS = 48000.0
ROOT = r"D:\modal_measurements\swept_discovery"
RUNS = ["20261011-rig1", "20261011-rig2", "20261011-rig3"]
REF = "20261011-rig3"
ESP_IMPULSE = r"D:\modal_projects\ASIO-rig-2026-10-11b_p1\modal_adapter\esprit"
REPLAY = r"D:\scratch\xexc-2026-10-11\analysis.pkl"
EX = ["Out 1", "Out 2", "Out 3", "Out 4"]
RC_NAMES = [f"In {i}" for i in range(1, 8)]
SWEEP = (20.0, 10000.0, 8.0)
ESPRIT_CH = slice(1, 7)          # In 2..In 7 = the project's response channels (In 1 = reference)
CHIRP_IR_S = 0.85                # < the 8 s ESS 2nd-harmonic advance (0.89 s); >= band configs' 600 ms
OUT = A.out
os.makedirs(OUT, exist_ok=True)
LOG = []


def log(*a):
    s = " ".join(str(x) for x in a)
    print(s, flush=True)
    LOG.append(s)


def session(run, tag):
    d = os.path.join(ROOT, run, "sessions", tag)
    meta = json.load(open(os.path.join(d, "meta.json"), encoding="utf-8"))
    data = np.load(os.path.join(d, "data.npy")).astype(np.float64)
    sig = np.load(os.path.join(d, "signal.npy")).ravel().astype(np.float64) if os.path.exists(
        os.path.join(d, "signal.npy")) else None
    return meta, data, sig


def coarse_capture(run, e):
    meta, data, x = session(run, f"coarse_e{e + 1}")
    return data[meta["pre_roll_frames"]:], x


# =========================================================================== 1. rig checks
t0 = time.time()
checks = {"harmonics": {}, "early_arrival": {}, "interface_crosstalk_in8_db": {}}
for run in RUNS:
    _, noise, _ = session(run, "noise")
    for e in range(4):
        y, x = coarse_capture(run, e)
        hd = RC.harmonic_distortion(y[:, :7], x, SWEEP, noise[:, :7])
        checks["harmonics"].setdefault(EX[e], {})[run] = hd
        if run == REF:
            h = deconvolve(y[:, :7], x, FS, SWEEP[:2])
            checks["early_arrival"][EX[e]] = RC.early_arrival(h)
            lb = y[:, 7].copy()
            pk = int(np.argmax(np.abs(lb[:2000])))
            lb[max(0, pk - 200):pk + 400] = 0            # remove the loopback marker
            h8 = deconvolve(np.c_[y[:, :7], lb], x, FS, SWEEP[:2])[:int(2.5 * FS)]
            P = np.abs(np.fft.rfft(h8, axis=0)) ** 2
            f = np.fft.rfftfreq(h8.shape[0], 1 / FS)
            rel = 10 * np.log10(P[:, 7] / np.maximum(np.median(P[:, :7], axis=1), 1e-300))
            checks["interface_crosstalk_in8_db"][EX[e]] = RC.band_table(f, rel)
frf = {run: np.load(os.path.join(ROOT, run, "coarse_frf.npz")) for run in RUNS}
freqs = frf[REF]["freqs"]
checks["repeat_coherence_rig1_3"] = RC.coherence_report(freqs, [frf[r]["H3"] for r in RUNS])
checks["snr_db_rig3"] = RC.snr_report(freqs, frf[REF]["H3"], frf[REF]["noise_power3"])
checks["peak_sigma2_ratio"] = {r: RC.peak_rank_ratio(freqs, frf[r]["H3"]) for r in RUNS}
sw = np.load(os.path.join(ROOT, REF, "modes.npz"))
fz = list(zip(sw["e0_frequencies"], sw["e0_damping_ratios"]))
qs = [(f, float(quasi_stationarity(ess_rate_hz_s(f, *SWEEP), 2 * z * f))) for f, z in fz]
checks["ess8s_quasi_stationarity_at_swept_modes"] = {
    bn: float(np.median([q for f, q in qs if lo <= f < hi])) for lo, hi, bn in RC.BANDS
    if any(lo <= f < hi for f, _ in qs)}
json.dump(checks, open(os.path.join(OUT, "rig_checks_offline.json"), "w"), indent=1, default=float)
log(f"## rig checks (offline, {time.time() - t0:.0f} s)")
for ex_, runs in checks["harmonics"].items():
    for run, hd in runs.items():
        log(f"  {ex_} {run[-4:]}: H2 med {np.median(hd['h2_db']):.1f} dB (noise {np.median(hd['h2_noise_db']):.1f})"
            f"  H3 med {np.median(hd['h3_db']):.1f} dB (noise {np.median(hd['h3_noise_db']):.1f})")
for ex_, ea in checks["early_arrival"].items():
    log(f"  early arrival {ex_}: t0 {ea['t0_db']} dB re peak | t<0 {ea['neg_db']} | first {ea['first_arrival_samples']}")
for ex_, b in checks["interface_crosstalk_in8_db"].items():
    log(f"  interface crosstalk {ex_} -> In 8 (re median receiver): " + ", ".join(f"{k} {v:.1f}" for k, v in b.items()))
log("  repeat coherence rig1-3 gamma2 median:", {k: round(v, 4) for k, v in checks["repeat_coherence_rig1_3"]["gamma2_median"].items()})
log("  repeat coherence gamma2 p10:", {k: round(v, 4) for k, v in checks["repeat_coherence_rig1_3"]["gamma2_p10"].items()})
log("  repeat SNR dB median:", {k: round(v, 1) for k, v in checks["repeat_coherence_rig1_3"]["repeat_snr_db_median"].items()})
log("  noise SNR dB median rig3:", {k: round(v, 1) for k, v in checks["snr_db_rig3"].items()})
log("  sigma2/sigma1 at CMIF peaks:", {r[-4:]: {k: v["ratio_median"] and round(v["ratio_median"], 2) for k, v in d.items()}
                                       for r, d in checks["peak_sigma2_ratio"].items()})
log("  8 s ESS quasi-stationarity r/(pi B^2) at the swept modes:", {k: round(v, 3) for k, v in checks["ess8s_quasi_stationarity_at_swept_modes"].items()})

# =========================================================================== 2. chirp ESPRIT
params = json.load(open(os.path.join(ESP_IMPULSE, "config.json"), encoding="utf-8"))
params = {**params, "use_gpu": True}   # the project setting (CPU: ~minutes per band)
runner = EspritRunner()
chirp_dirs = {}
for run in RUNS:
    d = os.path.join(OUT, "chirp_esprit", run)
    chirp_dirs[run] = d
    if A.skip_esprit or os.path.exists(os.path.join(d, "scenario_3.json")):
        continue
    os.makedirs(d, exist_ok=True)
    for e in range(4):
        t1 = time.time()
        y, x = coarse_capture(run, e)
        h = deconvolve(y[:, :7], x, FS, SWEEP[:2])
        ir = split_ess_irs(h, FS, SWEEP[2], SWEEP[0], SWEEP[1], CHIRP_IR_S)["linear"][:, ESPRIT_CH]
        ir = ir / np.abs(ir).max()
        np.save(os.path.join(d, f"ir_e{e}.npy"), ir.astype(np.float32))
        r = runner.run_single_point(ir, FS, params)
        json.dump({"scenario_index": e, "frequencies": np.asarray(r["frequencies"]).tolist(),
                   "damping_ratios": np.asarray(r["damping_ratios"]).tolist(),
                   "n_raw": r.get("n_raw"), "n_merged": len(r["frequencies"])},
                  open(os.path.join(d, f"scenario_{e}.json"), "w"))
        np.save(os.path.join(d, f"scenario_{e}_shapes.npy"), np.asarray(r["mode_shapes"]))
        log(f"  chirp-ESPRIT {run[-4:]} {EX[e]}: {len(r['frequencies'])} modes ({time.time() - t1:.0f} s)")

# =========================================================================== 3. PolyMAX
pm = {}
cfg = PolymaxConfig()
for run in RUNS:
    d = os.path.join(OUT, "polymax", run)
    c = frf[run]
    res = identify(c["freqs"], c["H3"], cfg, c["noise_power3"])
    pm_write(res, d, EX, RC_NAMES, c["freqs"], c["H3"])
    pm[run] = res
    log(f"  PolyMAX {run[-4:]}: {len(res['modes'])} modes, per band " +
        ", ".join(f"{b['band'][2]:.0f}-{b['band'][3]:.0f}:{len(b['modes'])}" for b in res["bands"]))
loo = {}
for e in range(4):
    sub = [k for k in range(4) if k != e]
    r = identify(frf[REF]["freqs"], frf[REF]["H3"], cfg, frf[REF]["noise_power3"], exciters=sub)
    pm_write(r, os.path.join(OUT, "polymax", REF, f"loo_without_Out{e + 1}"), EX, RC_NAMES)
    loo[e] = r
    log(f"  PolyMAX LOO without {EX[e]}: {len(r['modes'])} modes")

# =========================================================================== 4. comparison
M = {}
M["A swept joint (SNR>=10/exc)"] = C.from_modes_npz(os.path.join(ROOT, REF, "modes.npz"), snr_min=10)
rp = pickle.load(open(REPLAY, "rb"))["methods"] if os.path.exists(REPLAY) else None
if rp:
    M["A' swept indep coarse fits"] = rp["swept_indep_coarse"]
M["B PolyMAX joint (SNR>=10/exc)"] = C.from_records(pm[REF]["modes"], range(4), snr_min=10)
M["B PolyMAX leave-one-out (group = subset)"] = {
    e: [C.mk(m["f_hz"], m["zeta"], m["shape"]) for m in loo[e]["modes"]] for e in range(4)}
M["C chirp-ESPRIT rig3"] = C.from_esprit_dir(chirp_dirs[REF])
M["D impulse-ESPRIT (old)"] = C.from_esprit_dir(ESP_IMPULSE)
REPEAT = {"B PolyMAX across runs (group = run)": {
    i: [C.mk(m["f_hz"], m["zeta"], m["shape"]) for m in pm[r]["modes"]] for i, r in enumerate(RUNS)}}
for e in range(4):
    REPEAT[f"C chirp-ESPRIT {EX[e]} across runs (group = run)"] = {
        i: C.from_esprit_dir(chirp_dirs[r])[e] for i, r in enumerate(RUNS)}

summ = {}
log("\n## cross-exciter consistency (group = exciter unless noted)")
for name, L in M.items():
    s = C.summarize(L)
    nm = C.null_mac(L)
    summ[name] = s
    log("\n".join(C.format_summary(name, s)))
    log(f"  chance MAC between random modes of different groups: median {np.median(nm):.2f}")
log("\n## repeatability across rig1/rig2/rig3 (same exciters, 11 min apart)")
for name, L in REPEAT.items():
    s = C.summarize(L)
    summ[name] = s
    log("\n".join(C.format_summary(name, s)[:6]))

col = {
    "A": C.collapse(M["A swept joint (SNR>=10/exc)"], shape_slice=ESPRIT_CH),
    "B": C.collapse(M["B PolyMAX joint (SNR>=10/exc)"], shape_slice=ESPRIT_CH),
    "C": C.collapse(M["C chirp-ESPRIT rig3"], prefer_snr=False),
    "D": C.collapse(M["D impulse-ESPRIT (old)"], prefer_snr=False),
}
B_multi = [m for m in col["B"] if m["k"] >= 2]
cross = {}
log("\n## cross-method agreement (collapsed lists, shapes In 2..In 7)")
for a, b in (("A", "B"), ("A", "C"), ("A", "D"), ("B", "C"), ("B", "D"), ("C", "D")):
    c = C.cross_method(col[a], col[b])
    cross[f"{a}-{b}"] = c
    log("\n".join(C.format_cross(f"{a} vs {b}", c)))

# half-power damping spot checks on isolated PolyMAX modes (< 1 kHz)
H3, f3 = frf[REF]["H3"], frf[REF]["freqs"]


def hp_zeta(fc, zc):
    """Half-power damping of the Sum_r |H_re|^2 peak near ``fc`` per exciter (peak within B/2,
    both -3 dB crossings within 3 B, B = 2 zc fc); median over exciters, None if not resolvable."""
    B = 2 * zc * fc
    out = []
    for e in range(4):
        p = np.sum(np.abs(H3[:, :, e]) ** 2, 1)
        jj = np.flatnonzero(np.abs(f3 - fc) <= B / 2)
        if not len(jj):
            continue
        j = jj[np.argmax(p[jj])]
        if j in (jj[0], jj[-1]):
            continue                                   # no local maximum near the mode
        lim = np.abs(f3 - f3[j]) <= 3 * B
        h = p[j] / 2
        a = j
        while a > 0 and p[a] > h and lim[a]:
            a -= 1
        b = j
        while b < len(p) - 1 and p[b] > h and lim[b]:
            b += 1
        if p[a] > h or p[b] > h:
            continue
        fa = f3[a] + (h - p[a]) / (p[a + 1] - p[a]) * (f3[a + 1] - f3[a])
        fb = f3[b - 1] + (h - p[b - 1]) / (p[b] - p[b - 1]) * (f3[b] - f3[b - 1])
        out.append((fb - fa) / (2 * f3[j]))
    return float(np.median(out)) if out else None


def nearest(lst, f):
    return min(lst, key=lambda m: abs(m["f"] - f)) if lst else None


spot = []
pmm = sorted(pm[REF]["modes"], key=lambda m: m["f_hz"])
for i, m in enumerate(pmm):
    nb = [abs(o["f_hz"] - m["f_hz"]) for j, o in enumerate(pmm) if j != i]
    if m["f_hz"] < 1000 and min(nb) > 4 * m["zeta"] * m["f_hz"]:
        zh = hp_zeta(m["f_hz"], m["zeta"])
        if zh is None:
            continue
        row = {"f": m["f_hz"], "zeta_polymax": m["zeta"], "zeta_half_power": zh}
        for k in ("A", "C", "D"):
            n = nearest(col[k], m["f_hz"])
            if n and abs(n["f"] - m["f_hz"]) <= C.tol(m["f_hz"], n["z"], m["zeta"]):
                row[f"zeta_{k}"] = n["z"]
        spot.append(row)
log("\n## half-power damping spot checks (isolated PolyMAX modes < 1 kHz)")
for r in spot:
    log(f"  {r['f']:7.1f} Hz  half-power {r['zeta_half_power'] * 100:.2f}%  PolyMAX {r['zeta_polymax'] * 100:.2f}%"
        + "".join(f"  {k[-1]} {r[k] * 100:.2f}%" for k in ("zeta_A", "zeta_C", "zeta_D") if k in r))

json.dump({"summaries": {k: {kk: vv for kk, vv in v.items() if kk != "clusters"} for k, v in summ.items()},
           "cross": {k: {kk: vv for kk, vv in v.items() if kk != "rows"} for k, v in cross.items()},
           "half_power_spot": spot, "collapsed_counts": {k: len(v) for k, v in col.items()},
           "B_multi_exciter_count": len(B_multi)},
          open(os.path.join(OUT, "comparison.json"), "w"), indent=1, default=float)
open(os.path.join(OUT, "comparison.log"), "w", encoding="utf-8").write("\n".join(LOG))

# =========================================================================== 5. plots
import matplotlib  # noqa: E402
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

COL = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"]
TEXT, MUTED, GRID = "#0b0b0b", "#52514e", "#e4e3df"


def style(ax, title):
    ax.set_title(title, color=TEXT, fontsize=9, loc="left")
    ax.grid(True, color=GRID, lw=0.6)
    for s in ax.spines.values():
        s.set_color(GRID)
    ax.tick_params(colors=MUTED, labelsize=8)


show = [k for k in M if not k.startswith("A'")]
fig, axes = plt.subplots(len(show), 1, figsize=(15, 2.3 * len(show)), sharex=True)
for ax, name in zip(axes, show):
    for r in summ[name]["clusters"]:
        for g in sorted(set(g for g, _ in r["members"])):
            ax.plot(r["f"], 4 - g, "o", ms=4 if r["k"] >= 2 else 3,
                    mfc=COL[g] if r["k"] >= 2 else "none", mec=COL[g], mew=0.9)
    ax.set_xscale("log")
    ax.set_yticks([4, 3, 2, 1])
    ax.set_yticklabels(["Out 1", "Out 2", "Out 3", "Out 4"] if "leave" not in name
                       else ["w/o 1", "w/o 2", "w/o 3", "w/o 4"])
    ax.set_ylim(0.4, 4.6)
    style(ax, f"{name}: found per group (filled = matched by >= 2 groups)")
axes[-1].set_xlabel("Frequency (Hz)", color=MUTED)
fig.tight_layout()
fig.savefig(os.path.join(OUT, "modes_per_exciter_by_method.png"), dpi=100)
plt.close(fig)

bands = [b[2] for b in C.BANDS]
fig, axes = plt.subplots(1, 2, figsize=(15, 4.5))
w = 0.8 / len(show)
for i, name in enumerate(show):
    bb = summ[name]["by_band"]
    axes[0].bar(np.arange(4) + i * w, [bb[b]["mac_med"] or 0 for b in bands], w, label=name, color=["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7"][i])
    G = len(summ[name]["groups"])
    axes[1].bar(np.arange(4) + i * w, [bb[b][f"k{G}"] / max(bb[b]["clusters"], 1) for b in bands], w,
                color=["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7"][i])
for ax, t in zip(axes, ("median shape MAC between groups (matched modes)", "fraction of modes found by ALL groups")):
    ax.set_xticks(np.arange(4) + 0.4 - w / 2)
    ax.set_xticklabels(bands)
    ax.set_ylim(0, 1)
    style(ax, t)
axes[0].legend(fontsize=7, frameon=False)
fig.tight_layout()
fig.savefig(os.path.join(OUT, "consistency_by_band.png"), dpi=100)
plt.close(fig)

fig, ax = plt.subplots(figsize=(9, 4.5))
pairs = list(cross)
ax.bar(np.arange(len(pairs)) - 0.2, [cross[p]["matched"] for p in pairs], 0.4, color="#2a78d6", label="matched")
ax.bar(np.arange(len(pairs)) + 0.2, [cross[p]["null"] for p in pairs], 0.4, color="#c9c8c4", label="chance (shifted +-2/3 %)")
ax.set_xticks(np.arange(len(pairs)))
ax.set_xticklabels(pairs)
ax.legend(fontsize=8, frameon=False)
style(ax, "cross-method matches vs chance (A swept, B PolyMAX, C chirp-ESPRIT, D impulse-ESPRIT)")
fig.tight_layout()
fig.savefig(os.path.join(OUT, "cross_method_vs_chance.png"), dpi=100)
plt.close(fig)
log(f"\noutputs: {OUT}")
open(os.path.join(OUT, "comparison.log"), "w", encoding="utf-8").write("\n".join(LOG))
