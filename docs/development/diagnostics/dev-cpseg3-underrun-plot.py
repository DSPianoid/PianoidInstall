#!/usr/bin/env python3
"""Underrun-tied A/B summary chart. For each capture (FIXED-1..3, CLEAN-1..3)
plot: (top) actual ASIO underruns, (mid) kernel cp0->cp1 spike count >1333us +
max, (bottom) sync cp2->cp3 max. Shows underruns track KERNEL spikes (the fix's
target), NOT sync-wait (which is large on both builds = benign engine-ahead
pacing). Saves dev-cpseg3-underrun-ab.png.
"""
import json
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

KH = "Segment: kernel cp0→cp1 (us)"
SH = "Segment: sync wait cp2→cp3 (us)"
FH = "Full cycle incl. sync (us)"
CAPS = ["FIXED-1", "FIXED-2", "FIXED-3", "CLEAN-1", "CLEAN-2", "CLEAN-3"]


def load(tag):
    r = json.load(open(f"dev-cpseg3-{tag}.json", encoding="utf-8"))
    h = r["chart_headers"]; d = r["data"]; bh = {x: d[i] for i, x in enumerate(h)}
    tf = r["text_fields"]
    def trim(s): return s[2:] if s and len(s) > 4 else (s or [])
    k = [x for x in trim(bh.get(KH, [])) if x is not None and x < 1e7]
    s = [x for x in trim(bh.get(SH, [])) if x is not None and x < 1e7]
    f = [x for x in trim(bh.get(FH, [])) if x is not None and x < 1e7]
    ur = tf.get("Underruns", "0")
    ur_n = int(ur.split("/")[0].strip()) if "/" in ur else 0
    return {"k": k, "s": s, "f": f, "ur": ur_n,
            "kmax": max(k) if k else 0, "smax": max(s) if s else 0,
            "k_ob": sum(1 for x in k if x > 1333.33)}


rows = {t: load(t) for t in CAPS}
x = np.arange(len(CAPS))
colors = ["#26a69a"] * 3 + ["#ef5350"] * 3  # FIXED green, CLEAN red

fig, axes = plt.subplots(3, 1, figsize=(11, 11), sharex=True)

axes[0].bar(x, [rows[t]["ur"] for t in CAPS], color=colors)
for i, t in enumerate(CAPS):
    axes[0].text(i, rows[t]["ur"] + 0.15, str(rows[t]["ur"]), ha="center", fontsize=10, weight="bold")
axes[0].set_ylabel("ASIO underruns")
axes[0].set_title("ACTUAL underruns (the real glitch metric) — FIXED=0 always; CLEAN glitches when kernel spikes", fontsize=10, loc="left")
axes[0].grid(alpha=0.2, axis="y")

axes[1].bar(x, [rows[t]["k_ob"] for t in CAPS], color=colors)
for i, t in enumerate(CAPS):
    axes[1].text(i, rows[t]["k_ob"] + 0.2, f"{rows[t]['k_ob']}\nmax {rows[t]['kmax']:.0f}us", ha="center", fontsize=8)
axes[1].set_ylabel("kernel cp0→cp1\ncycles >1333us")
axes[1].set_title("KERNEL cp0→cp1 spikes (the fix's target) — eliminated on FIXED; present on CLEAN. Tracks underruns.", fontsize=10, loc="left")
axes[1].grid(alpha=0.2, axis="y")

axes[2].bar(x, [rows[t]["smax"] / 1000.0 for t in CAPS], color="#ffa726")
for i, t in enumerate(CAPS):
    axes[2].text(i, rows[t]["smax"] / 1000.0 + 0.2, f"{rows[t]['smax']/1000.0:.1f}ms", ha="center", fontsize=8)
axes[2].set_ylabel("sync cp2→cp3\nMAX (ms)")
axes[2].set_title("SYNC-WAIT cp2→cp3 max — LARGE on BOTH builds (8-14ms) yet FIXED has 0 underruns = benign engine-ahead pacing, NOT a glitch", fontsize=10, loc="left")
axes[2].grid(alpha=0.2, axis="y")
axes[2].set_xticks(x)
axes[2].set_xticklabels(CAPS)

fig.suptitle("Underrun-tied A/B: underruns track KERNEL spikes (fixed), not SYNC-WAIT (benign on both)", fontsize=12)
fig.tight_layout(rect=[0, 0, 1, 0.98])
fig.savefig("dev-cpseg3-underrun-ab.png", dpi=100)
print("WROTE dev-cpseg3-underrun-ab.png")
for t in CAPS:
    print(f"  {t}: underruns={rows[t]['ur']} kernel>1333={rows[t]['k_ob']} kmax={rows[t]['kmax']:.0f} smax={rows[t]['smax']:.0f}")
