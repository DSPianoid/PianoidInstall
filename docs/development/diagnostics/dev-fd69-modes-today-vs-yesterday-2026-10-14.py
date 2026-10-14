"""dev-fd69 2026-10-14: match today's modes (fixed layout 7x7 [+ LF run]) to yesterday's (10-13 roving
P0 / P0+P1) and the 2026-10-12 cross-exciter list (E1-E3, < 200 Hz).

Matching: nearest frequency, |df| <= 2 % (3 % below 100 Hz), one-to-one (greedy by |df|).
Shape MAC across days: only possible on a common sensor position. Tested by measurement: log-|H|
correlation (25 Hz-1 kHz, hum lines excluded) of every 10-13 piezo FRF vs every 10-14 piezo FRF for
the exciters on the same outputs both days (Out 3, Out 4). A coincident position would give ~0.95+;
the cross-position level is the max between today's own different piezos.

Usage: python <this> <today_report.json> [<lf_report.json>] <out_dir>
"""
import json
import os
import sys

import numpy as np

RC = r"D:\modal_measurements\rig_checks"
Y_P01 = os.path.join(RC, "rove-20261013", "analysis_p01_noP01In5_coilsP0", "report.json")
Y_P0 = os.path.join(RC, "rove-20261013", "analysis_validation_p0", "report.json")
E3 = r"D:\modal_measurements\analysis\dev-fd69-2026-10-12\e3_analysis.json"
args = sys.argv[1:]
out = args[-1]; today_paths = args[:-1]
os.makedirs(out, exist_ok=True)


def load_today():
    modes = []
    for p in today_paths:
        r = json.load(open(p)); src = "LF" if "lf" in os.path.basename(os.path.dirname(p)).lower() else "7x7"
        for m in r["modes"]:
            modes.append({"f": m["f"], "z": m["zeta_pct"], "mac": m.get("median_pair_mac"), "src": src})
    if len(today_paths) > 1:      # LF run replaces the 7x7 modes inside its band
        lf = [m for m in modes if m["src"] == "LF"]
        if lf:
            hi = max(m["f"] for m in lf) * 1.02
            modes = [m for m in modes if m["src"] == "LF" or m["f"] > hi]
    return sorted(modes, key=lambda m: m["f"])


def match(a, b, tol_hi=0.02, tol_lo=0.03):
    cand = []
    for i, x in enumerate(a):
        for j, y in enumerate(b):
            d = (y["f"] - x["f"]) / x["f"]
            if abs(d) <= (tol_lo if x["f"] < 100 else tol_hi):
                cand.append((abs(d), i, j))
    used_a, used_b, pairs = set(), set(), {}
    for _, i, j in sorted(cand):
        if i not in used_a and j not in used_b:
            used_a.add(i); used_b.add(j); pairs[i] = j
    return pairs


today = load_today()
yp01 = [{"f": m["f"], "z": m["zeta_pct"]} for m in json.load(open(Y_P01))["modes"]]
yp0 = [{"f": m["f"], "z": m["zeta_pct"]} for m in json.load(open(Y_P0))["modes"]]
e3 = [{"f": m["f"], "z": 100 * m["zeta_model"], "src": m["src"], "agree": m.get("min_corr")} for m in json.load(open(E3))["modes"]]
m01, m0, me3 = match(today, yp01), match(today, yp0), match(today, e3)
rows = []
for i, t in enumerate(today):
    r = {"f_today": t["f"], "z_today": t["z"], "src": t["src"], "mac_today": t["mac"]}
    for key, ref, mm in (("p01", yp01, m01), ("p0", yp0, m0), ("e3_1012", e3, me3)):
        if i in mm:
            y = ref[mm[i]]
            r[key] = {"f": y["f"], "z": round(y["z"], 2), "df_pct": round(100 * (t["f"] - y["f"]) / y["f"], 2), "dz_pp": round(t["z"] - y["z"], 2)}
    rows.append(r)
only_yesterday = {"p01": [y for j, y in enumerate(yp01) if j not in m01.values() and y["f"] < 1100],
                  "e3_1012": [y for j, y in enumerate(e3) if j not in me3.values()]}
only_today = [r["f_today"] for r in rows if "p01" not in r and "p0" not in r and "e3_1012" not in r]

# common-sensor test (measured)
t7 = os.path.join(os.path.dirname(today_paths[0]), "frf.npz")
sensor = None
if os.path.exists(t7):
    t = np.load(t7); ft = t["f"]; Ht = t["Hv"].mean(0)
    s = (ft >= 25) & (ft <= 1000)
    for hz in (50, 100, 150):
        s &= np.abs(ft - hz) > 1
    lm = lambda h: 20 * np.log10(np.abs(h[s]) + 1e-15)
    best = []
    for P in ("placement_00", "placement_01", "placement_02"):
        z = np.load(os.path.join(RC, "rove-20261013", P, "frf.npz")); Hy = z["Hv"].mean(0)
        for k, nm in enumerate(("In5", "In6", "In7")):
            c = [np.mean([np.corrcoef(lm(Hy[:, k, e]), lm(Ht[:, p, e]))[0, 1] for e in (2, 3)]) for p in range(7)]
            best.append((P, nm, f"P{int(np.argmax(c)) + 1}", round(float(np.max(c)), 2)))
    own = max(np.mean([np.corrcoef(lm(Ht[:, a, e]), lm(Ht[:, b, e]))[0, 1] for e in (2, 3)]) for a in range(7) for b in range(7) if a != b)
    sensor = {"best_match_per_yesterday_piezo": best, "today_cross_position_max": round(float(own), 2),
              "coincident": [b for b in best if b[3] >= 0.95]}
json.dump({"rows": rows, "only_today": only_today, "only_yesterday": only_yesterday, "sensor_test": sensor},
          open(os.path.join(out, "modes_today_vs_yesterday.json"), "w"), indent=1)

# markdown table
L = ["| today f (Hz) | ζ % | src | 10-13 P0+P1 f / ζ | Δf % | Δζ pp | 10-13 P0 f / ζ | 10-12 E1-E3 f / ζ (agree) | Δf % |",
     "|---|---|---|---|---|---|---|---|---|"]
for r in rows:
    p01, p0, e = r.get("p01"), r.get("p0"), r.get("e3_1012")
    L.append(f"| {r['f_today']:.1f} | {r['z_today']:.2f} | {r['src']} | "
             + (f"{p01['f']:.1f} / {p01['z']:.2f} | {p01['df_pct']:+.2f} | {p01['dz_pp']:+.2f} | " if p01 else "— | | | ")
             + (f"{p0['f']:.1f} / {p0['z']:.2f} | " if p0 else "— | ")
             + (f"{e['f']:.1f} / {e['z']:.2f} | {e['df_pct']:+.2f} |" if e else "— | |"))
open(os.path.join(out, "modes_today_vs_yesterday.md"), "w", encoding="utf-8").write("\n".join(L) + "\n")

import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
fig, ax = plt.subplots(1, 2, figsize=(15, 5))
for r in rows:
    for key, mk, c in (("p01", "o", "#36c"), ("e3_1012", "s", "#c33")):
        if key in r:
            ax[0].plot(r[key]["f"], r[key]["df_pct"], mk, color=c, ms=5)
            ax[1].plot(r[key]["z"], r["z_today"], mk, color=c, ms=5)
ax[0].plot([], [], "o", color="#36c", label="vs 10-13 roving P0+P1"); ax[0].plot([], [], "s", color="#c33", label="vs 10-12 E1-E3")
ax[0].set_xscale("log"); ax[0].axhline(0, color="k", lw=.6); ax[0].set(xlabel="yesterday f (Hz)", ylabel="Δf today − yesterday (%)", title="Frequency shift of matched modes")
ax[0].legend(fontsize=8); ax[0].grid(alpha=.3)
ax[1].plot([0.5, 6], [0.5, 6], "k-", lw=.6); ax[1].set(xlabel="yesterday ζ %", ylabel="today ζ %", title="Damping of matched modes"); ax[1].grid(alpha=.3)
plt.tight_layout(); plt.savefig(os.path.join(out, "modes_today_vs_yesterday.png"), dpi=85)
n = len(rows)
print(f"today {n} modes; matched P0+P1 {len(m01)}/{len([y for y in yp01 if y['f'] < 1100])}, P0 {len(m0)}/{len(yp0)}, 10-12 E1-E3 {len(me3)}/{len(e3)}")
d = [r["p01"]["df_pct"] for r in rows if "p01" in r]; dz = [r["p01"]["dz_pp"] for r in rows if "p01" in r]
print("vs P0+P1: df median %.2f %% (|df| median %.2f %%), dzeta median %+.2f pp" % (np.median(d), np.median(np.abs(d)), np.median(dz)))
print("only today:", only_today)
print("only yesterday P0+P1:", [y["f"] for y in only_yesterday["p01"]])
print("only 10-12 E1-E3:", [round(y["f"], 1) for y in only_yesterday["e3_1012"]])
print("sensor test:", sensor)
