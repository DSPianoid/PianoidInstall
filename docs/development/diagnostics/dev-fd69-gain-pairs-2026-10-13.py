"""dev-fd69 2026-10-13: did the unequal input gains bias the cross-exciter comparison ("Out 1/2 vs Out 3/4")?

1. Gain invariance, measured: placement 1 and placement 2 are the same piezo positions captured
   before / after the user equalised the input gains (coil-current channels In 1-4 included). Per
   exciter, the ratio H_P2 / H_P1 of the healthy piezo (In 7) is computed voltage-referenced
   (piezo / drive) and current-referenced (piezo / own coil current). A gain change is a
   frequency-flat complex scalar per exciter column: flat ratio = MAC-invariant.
2. Pair-group table: median cross-exciter pair MAC below 200 Hz for the within-group pairs
   (1-2, 3-4) vs the cross-group pairs (1-3, 1-4, 2-3, 2-4), for the 2026-10-12 E3 stepped-sine
   shapes (raw, residual-corrected), the frf4ref run (I / V) and the roving analyses.

Usage: python dev-fd69-gain-pairs-2026-10-13.py  (paths below; writes gain_pairs.json next to the rove root)
"""
import json
import os

import numpy as np

RC = r"D:\modal_measurements\rig_checks"
ROVE = os.path.join(RC, "rove-20261013")
E3 = r"D:\modal_measurements\analysis\dev-fd69-2026-10-12\e3_analysis.json"
PAIRS = [(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)]
WITHIN = [0, 5]          # 1-2, 3-4
CROSS = [1, 2, 3, 4]     # 1-3, 1-4, 2-3, 2-4
OUT = {}

# ---- 1. gain invariance (P1 vs P2, same positions)
z1, z2 = np.load(os.path.join(ROVE, "placement_01", "frf.npz")), np.load(os.path.join(ROVE, "placement_02", "frf.npz"))
f = z1["f"]; H1, H2 = z1["Hv"].mean(0), z2["Hv"].mean(0)          # (F, 7 rows, 4 exc); rows In5,6,7,1,2,3,4
s = (f >= 40) & (f <= 1000)
for hz in (50, 100, 150):
    s &= np.abs(f - hz) > 1.0
inv = {}
for e in range(4):
    for ref in ("V", "I"):
        a = H1[:, 2, e] / (H1[:, 3 + e, e] if ref == "I" else 1)
        b = H2[:, 2, e] / (H2[:, 3 + e, e] if ref == "I" else 1)
        r = b[s] / a[s]
        db = 20 * np.log10(np.abs(r)); ph = np.degrees(np.angle(r * np.conj(np.median(r.real) + 1j * np.median(r.imag)) / np.abs(np.median(r))))
        inv[f"Out {e + 1} {ref}"] = {"median_db": round(float(np.median(db)), 2),
                                     "iqr_db": round(float(np.subtract(*np.percentile(db, [75, 25]))), 2),
                                     "phase_iqr_deg": round(float(np.subtract(*np.percentile(ph, [75, 25]))), 2)}
    c = H2[:, 3 + e, e][s] / H1[:, 3 + e, e][s]
    inv[f"Out {e + 1} own-coil P2/P1"] = round(float(np.median(20 * np.log10(np.abs(c)))), 2)
OUT["gain_invariance_In7_P2_over_P1"] = inv


def groups(M, fm, lim=200.0):
    M = np.asarray(M, float); sel = np.asarray(fm) < lim
    M = M[sel]
    return {"n": int(sel.sum()), "within_12_34": round(float(np.nanmedian(M[:, WITHIN])), 3),
            "cross": round(float(np.nanmedian(M[:, CROSS])), 3),
            "per_pair": {f"{i + 1}-{j + 1}": round(float(np.nanmedian(M[:, k])), 3) for k, (i, j) in enumerate(PAIRS)}}


def m44_to_pairs(m):
    return [m.get(f"{i + 1}-{j + 1}", np.nan) if m else np.nan for i, j in PAIRS]


# ---- 2. pair groups
tab = {}
e3 = json.load(open(E3))
fm = [m["f"] for m in e3["modes"]]
for key in ("mac_raw", "mac_corrected", "mac_corrected_no_nearfield"):
    tab[f"10-12 E3 stepped ({key})"] = groups([m44_to_pairs(m[key]) for m in e3["modes"]], fm)
fr = os.path.join(RC, "20261013T135846-frf4ref")
fmI = np.load(os.path.join(fr, "modes_I.npz"))["f"]
for ref in ("I", "V"):
    p = os.path.join(fr, f"pairmac_{ref}.npy")
    if os.path.exists(p):
        M = np.load(p)
        if len(M) == len(fmI):
            tab[f"10-13 frf4ref P0 ({ref}-ref, 5 rows)"] = groups(M, fmI)
for d in ("analysis_validation_p0", "analysis_p0_V", "analysis_p01_noP01In5_coilsP0", "analysis_p2", "analysis_p2_V",
          "analysis_p02_In7only_coilsP2", "analysis_p012_good_coilsP2"):
    z = os.path.join(ROVE, d, "modes.npz")
    if os.path.exists(z):
        q = np.load(z)
        tab[f"rove {d}"] = groups(q["pair_mac"], q["f"])
OUT["pair_groups_lt200"] = tab
json.dump(OUT, open(os.path.join(ROVE, "gain_pairs.json"), "w"), indent=1)
print(json.dumps(inv, indent=0))
for k, v in tab.items():
    print(f"{k:55s} n={v['n']:2d} within(1-2,3-4) {v['within_12_34']:.3f}  cross {v['cross']:.3f}  {v['per_pair']}")

# ---- 3. per-exciter level re Out 1 (In 7 piezo, own coil admittance) before / after the gain change
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
fig, axs = plt.subplots(1, 2, figsize=(13, 4.5), sharey=True)
for ax, (lo, hi) in zip(axs, ((25, 200), (200, 1000))):
    s = (f >= lo) & (f < hi)
    for hz in (50, 100, 150):
        s &= np.abs(f - hz) > 1.0
    bars = {}
    for nm, H in (("P1 old gains", H1), ("P2 equal gains", H2)):
        coil = np.array([np.median(20 * np.log10(np.abs(H[s, 3 + e, e]))) for e in range(4)])
        V = np.array([np.median(20 * np.log10(np.abs(H[s, 2, e]))) for e in range(4)])
        I = np.array([np.median(20 * np.log10(np.abs(H[s, 2, e] / H[s, 3 + e, e]))) for e in range(4)])
        bars[f"coil I/V ({nm})"] = coil - coil[0]
        bars[f"In 7 / V ({nm})"] = V - V[0]
        bars[f"In 7 / I ({nm})"] = I - I[0]
    w = 0.13
    for k, (lab, v) in enumerate(bars.items()):
        ax.bar(np.arange(4) + (k - 2.5) * w, v, w, label=lab,
               color=["#888", "#36c", "#c33", "#bbb", "#8af", "#f99"][k])
    ax.axhline(0, color="k", lw=.6); ax.set_xticks(range(4)); ax.set_xticklabels(["Out 1", "Out 2", "Out 3", "Out 4"])
    ax.set_title(f"{lo}-{hi} Hz: level re Out 1 (dB, median over lines)")
axs[0].set_ylabel("dB re Out 1"); axs[1].legend(fontsize=7)
plt.tight_layout(); plt.savefig(os.path.join(ROVE, "gain_levels_per_exciter.png"), dpi=90)
