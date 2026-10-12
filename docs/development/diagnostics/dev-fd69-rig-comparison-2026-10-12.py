"""dev-fd69 cross-exciter + cross-method comparison on the 2026-10-12 rig data.

A swept (rig4b: 20 s coarse ESS, quasi-stationary fine sweeps), B PolyMAX (60 s coarse ESS FRF
of the sweep-speed test; + leave-one-exciter-out), C ESPRIT on the live CHIRP collection
(ASIO-chirp-2026-10-12_p1, 1 s IRs), D impulse ESPRIT (ASIO-rig-2026-10-11b_p1, 100 ms cycles).
Output: D:/modal_measurements/analysis/dev-fd69-2026-10-12/comparison.log + .json + plots.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, r"D:\repos\wt-fd69-core")
from pianoid_middleware.modal_adapter import mode_comparison as C  # noqa: E402
from pianoid_middleware.modal_adapter.polymax.identify import PolymaxConfig, identify  # noqa: E402
from pianoid_middleware.modal_adapter.polymax.report import write_report  # noqa: E402

OUT = r"D:\modal_measurements\analysis\dev-fd69-2026-10-12"
os.makedirs(OUT, exist_ok=True)
SPEED = r"D:\modal_measurements\rig_checks\20261012T161018-sweep_speed"
SWEPT = r"D:\modal_measurements\swept_discovery\20261012-rig4b"
EX = [f"Out {i}" for i in range(1, 5)]
RC = [f"In {i}" for i in range(1, 8)]
CH = slice(1, 7)
LOG = []


def log(*a):
    s = " ".join(str(x) for x in a)
    print(s, flush=True)
    LOG.append(s)


d = np.load(os.path.join(SPEED, "coarse_frf_T60.npz"))
loo = {}
for e in range(4):
    r = identify(d["freqs"], d["H3"], PolymaxConfig(), d["noise_power3"],
                 exciters=[k for k in range(4) if k != e])
    write_report(r, os.path.join(SPEED, "polymax_T60", f"loo_without_Out{e + 1}"), EX, RC)
    loo[e] = [C.mk(m["f_hz"], m["zeta"], m["shape"]) for m in r["modes"]]
M = {
    "A swept rig4b (SNR>=10/exc)": C.from_modes_npz(os.path.join(SWEPT, "modes.npz"), snr_min=10),
    "B PolyMAX T60 (SNR>=10/exc)": C.from_modes_npz(os.path.join(SPEED, "polymax_T60", "modes.npz"), snr_min=10),
    "B PolyMAX leave-one-out (group = subset)": loo,
    "C chirp-ESPRIT live collection": C.from_esprit_dir(r"D:\modal_projects\ASIO-chirp-2026-10-12_p1\modal_adapter\esprit"),
    "D impulse-ESPRIT (2026-10-11)": C.from_esprit_dir(r"D:\modal_projects\ASIO-rig-2026-10-11b_p1\modal_adapter\esprit"),
}
REP = {
    "B PolyMAX across sweep durations 8/30/60 s": {
        i: [C.mk(f, z, s) for f, z, s in zip(*(lambda n: (n["e0_frequencies"], n["e0_damping_ratios"], n["e0_mode_shapes"]))(
            np.load(os.path.join(SPEED, f"polymax_T{T}", "modes.npz"))))] for i, T in enumerate((8, 30, 60))},
    "C chirp-ESPRIT live vs offline-chirp rig3 (Out 3)": {
        0: C.from_esprit_dir(r"D:\modal_projects\ASIO-chirp-2026-10-12_p1\modal_adapter\esprit")[2],
        1: C.from_esprit_dir(r"D:\modal_measurements\analysis\dev-fd69-2026-10-11\chirp_esprit\20261011-rig3")[2]},
}
S = {}
log("## cross-exciter consistency (group = exciter unless noted)")
for name, L in M.items():
    S[name] = C.summarize(L)
    log("\n".join(C.format_summary(name, S[name])))
    log(f"  chance MAC: median {np.median(C.null_mac(L)):.2f}")
log("\n## repeatability")
for name, L in REP.items():
    S[name] = C.summarize(L)
    log("\n".join(C.format_summary(name, S[name])[:6]))
col = {"A": C.collapse(M["A swept rig4b (SNR>=10/exc)"], shape_slice=CH),
       "B": C.collapse(M["B PolyMAX T60 (SNR>=10/exc)"], shape_slice=CH),
       "C": C.collapse(M["C chirp-ESPRIT live collection"], prefer_snr=False),
       "D": C.collapse(M["D impulse-ESPRIT (2026-10-11)"], prefer_snr=False)}
cross = {}
log("\n## cross-method (collapsed, shapes In 2..In 7)")
for a, b in (("A", "B"), ("A", "C"), ("A", "D"), ("B", "C"), ("B", "D"), ("C", "D")):
    cross[f"{a}-{b}"] = C.cross_method(col[a], col[b])
    log("\n".join(C.format_cross(f"{a} vs {b}", cross[f"{a}-{b}"])))
json.dump({"summaries": {k: {kk: vv for kk, vv in v.items() if kk != "clusters"} for k, v in S.items()},
           "cross": {k: {kk: vv for kk, vv in v.items() if kk != "rows"} for k, v in cross.items()}},
          open(os.path.join(OUT, "comparison.json"), "w"), indent=1, default=float)
open(os.path.join(OUT, "comparison.log"), "w", encoding="utf-8").write("\n".join(LOG))

import matplotlib  # noqa: E402
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
COL = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"]
fig, axes = plt.subplots(len(M), 1, figsize=(15, 2.3 * len(M)), sharex=True)
for ax, name in zip(axes, M):
    for r in S[name]["clusters"]:
        for g in sorted(set(g for g, _ in r["members"])):
            ax.plot(r["f"], 4 - g, "o", ms=4 if r["k"] >= 2 else 3,
                    mfc=COL[g] if r["k"] >= 2 else "none", mec=COL[g], mew=0.9)
    ax.set_xscale("log")
    ax.set_yticks([4, 3, 2, 1])
    ax.set_yticklabels(["Out 1", "Out 2", "Out 3", "Out 4"] if "leave" not in name else ["w/o 1", "w/o 2", "w/o 3", "w/o 4"])
    ax.set_ylim(0.4, 4.6)
    ax.grid(True, color="#e4e3df")
    ax.set_title(f"{name}: found per group (filled = matched by >= 2 groups)", loc="left", fontsize=9)
axes[-1].set_xlabel("Frequency (Hz)")
fig.tight_layout()
fig.savefig(os.path.join(OUT, "modes_per_exciter_by_method.png"), dpi=100)
plt.close(fig)
fig, ax = plt.subplots(figsize=(9, 4.5))
pairs = list(cross)
ax.bar(np.arange(len(pairs)) - 0.2, [cross[p]["matched"] for p in pairs], 0.4, color="#2a78d6", label="matched")
ax.bar(np.arange(len(pairs)) + 0.2, [cross[p]["null"] for p in pairs], 0.4, color="#c9c8c4", label="chance")
ax.set_xticks(np.arange(len(pairs)))
ax.set_xticklabels(pairs)
ax.legend(frameon=False, fontsize=8)
ax.set_title("cross-method matches vs chance (2026-10-12 rig data)", loc="left", fontsize=10)
fig.tight_layout()
fig.savefig(os.path.join(OUT, "cross_method_vs_chance.png"), dpi=100)
log(OUT)
