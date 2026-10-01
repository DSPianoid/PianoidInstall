#!/usr/bin/env python3
"""Two-panel before/after chart for the cp0->cp1 stream-decouple fix, mirroring
dev-stchart's panels:
  (top)    Full-cycle host span (us) -- the spike carrier (/data[3])
  (bottom) Add-kernel device time (us) -- GPU compute, stays flat (/data[4])
For both CLEAN (before) and FIXED (after) captures side by side.

Usage: python dev-cpemp-plot.py CLEAN-1 FIXED-1   (label stems -> dev-cpemp-<stem>.json)
"""
import sys, json
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

BUDGET_US = 1333.33
FC_IDX = 3   # Full cycle incl. sync (us)
GPU_IDX = 4  # Add-kernel device time (us)


def med(a):
    s = sorted(a); return s[len(s) // 2]


def load(stem):
    r = json.load(open(f"dev-cpemp-{stem}.json", encoding="utf-8-sig"))
    d = r["data"]
    fc = d[FC_IDX][2:]   # drop leading idle-gap artifact
    gpu = d[GPU_IDX][2:]
    fc = [x for x in fc if x < 1e7]
    gpu = [x for x in gpu if x < 1e7]
    return fc, gpu


stems = sys.argv[1:3] if len(sys.argv) >= 3 else ["CLEAN-1", "FIXED-1"]
titles = ["BEFORE (clean dev a5c4503)", "AFTER (fixed stream-decouple a38b02b)"]

fig, axes = plt.subplots(2, 2, figsize=(17, 9), sharey="row")
fig.suptitle(
    "cp0→cp1 spike fix — ONLINE Sound Test profiling under sustained string_shape "
    "chart-render contention\npreset Belarus_196modesC_Fanera6exc · ASIO Callback · "
    f"audio_on · budget {BUDGET_US:.0f}µs (64@48k)", fontsize=12)

for col, (stem, title) in enumerate(zip(stems, titles)):
    fc, gpu = load(stem)
    # top: full-cycle host span (spike carrier)
    ax = axes[0][col]
    x = list(range(len(fc)))
    ax.plot(x, fc, color="#42a5f5", lw=0.6)
    over = [(i, v) for i, v in zip(x, fc) if v > BUDGET_US]
    if over:
        ax.scatter([i for i, _ in over], [v for _, v in over], s=8, color="#ef5350", zorder=3)
    ax.axhline(BUDGET_US, color="#ef5350", ls="--", lw=1.0)
    o20 = sum(1 for v in fc if v > 20000)
    o40 = sum(1 for v in fc if v > 40000)
    ax.set_title(f"{title}\nFULL-CYCLE host span  [med {med(fc):.0f} max {max(fc):.0f}µs  "
                 f">20ms={o20} >40ms={o40}]", fontsize=10, loc="left")
    ax.set_ylabel("host-wall span (µs)")
    ax.grid(True, alpha=0.25)
    # bottom: add-kernel device time (GPU flat control)
    ax2 = axes[1][col]
    x2 = list(range(len(gpu)))
    ax2.plot(x2, gpu, color="#26a69a", lw=0.6)
    ax2.axhline(BUDGET_US, color="#ef5350", ls="--", lw=1.0)
    ax2.set_title(f"ADD-KERNEL device time (GPU)  [med {med(gpu):.0f} max {max(gpu):.0f}µs]",
                  fontsize=10, loc="left")
    ax2.set_xlabel("cycle"); ax2.set_ylabel("GPU device time (µs)")
    ax2.grid(True, alpha=0.25)

fig.tight_layout(rect=(0, 0, 1, 0.93))
out = "dev-cpemp-before-after.png"
fig.savefig(out, dpi=120)
print("WROTE", out)
for stem in stems:
    fc, gpu = load(stem)
    print(f"  {stem}: full-cycle med={med(fc):.0f} max={max(fc):.0f}  "
          f">5ms={sum(1 for v in fc if v>5000)} >20ms={sum(1 for v in fc if v>20000)} "
          f">40ms={sum(1 for v in fc if v>40000)} | GPU med={med(gpu):.0f} max={max(gpu):.0f}")
