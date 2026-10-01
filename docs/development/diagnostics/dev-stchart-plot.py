"""Render the two requested Sound Test profiling series from the captured
online response JSON into a single PNG (matplotlib), exactly mirroring the
backend chart semantics: budget markLine + per-point over/under-budget colour.
"""
import json
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

RESP = r"D:\repos\PianoidInstall\dev-stchart-response.json"
OUT = r"D:\repos\PianoidInstall\dev-stchart-online-profiling.png"
BUDGET_US = 1333.33  # samples_per_cycle * 1e6 / sample_rate (64 @ 48k)

GPU_HDR = "Add-kernel device time (us)"
CP_HDR = "Segment: kernel cp0→cp1 (us)"  # cp0->cp1

with open(RESP, "r", encoding="utf-8-sig") as f:
    r = json.load(f)

headers = r["chart_headers"]
data = r["data"]
by_header = {h: data[i] for i, h in enumerate(headers)}

gpu = by_header.get(GPU_HDR)
cp = by_header.get(CP_HDR)
if gpu is None or cp is None:
    print("MISSING SERIES. headers:", headers)
    sys.exit(1)


def med(a):
    s = sorted(a)
    return s[len(s) // 2]


fig, axes = plt.subplots(2, 1, figsize=(13, 8.5), sharex=True)
fig.suptitle(
    "Pianoid Sound Test — ONLINE (ASIO Callback) profiling\n"
    "preset Belarus_196modesC_Fanera6exc · note pitch 60 vel 100 · "
    f"{len(gpu)} cycles · 48 kHz, 64 samples/cycle (budget {BUDGET_US:.0f} µs)",
    fontsize=12,
)

# (1) KERNEL GPU TIME -- addKernel device time (CUDA-event measured)
ax0 = axes[0]
x0 = list(range(len(gpu)))
ax0.plot(x0, gpu, color="#26a69a", lw=0.8, label="add-kernel device time")
over0 = [v > BUDGET_US for v in gpu]
ax0.scatter([i for i, o in zip(x0, over0) if o],
            [v for v, o in zip(gpu, over0) if o],
            s=12, color="#ef5350", zorder=3, label="over budget")
ax0.axhline(BUDGET_US, color="#ef5350", ls="--", lw=1.2,
            label=f"budget {BUDGET_US:.0f} µs")
ax0.set_title(
    f"(1) KERNEL GPU TIME — addKernel DEVICE time   "
    f"[median {med(gpu):.0f} µs, max {max(gpu):.0f} µs, "
    f"{sum(over0)}/{len(gpu)} over budget]",
    fontsize=11, loc="left")
ax0.set_ylabel("GPU device time (µs)")
ax0.grid(True, alpha=0.25)
ax0.legend(loc="upper right", fontsize=8)

# (2) KERNEL cp0->cp1 -- synthesis-kernel host-wall span
ax1 = axes[1]
x1 = list(range(len(cp)))
ax1.plot(x1, cp, color="#42a5f5", lw=0.8, label="cp0→cp1 host-wall span")
over1 = [v > BUDGET_US for v in cp]
ax1.scatter([i for i, o in zip(x1, over1) if o],
            [v for v, o in zip(cp, over1) if o],
            s=12, color="#ef5350", zorder=3, label="over budget")
ax1.axhline(BUDGET_US, color="#ef5350", ls="--", lw=1.2,
            label=f"budget {BUDGET_US:.0f} µs")
ax1.set_title(
    f"(2) KERNEL cp0→cp1 — synthesis-kernel host-wall span   "
    f"[median {med(cp):.0f} µs, max {max(cp):.0f} µs, "
    f"{sum(over1)}/{len(cp)} over budget]",
    fontsize=11, loc="left")
ax1.set_xlabel("cycle")
ax1.set_ylabel("host-wall span (µs)")
ax1.grid(True, alpha=0.25)
ax1.legend(loc="upper right", fontsize=8)

fig.tight_layout(rect=(0, 0, 1, 0.94))
fig.savefig(OUT, dpi=120)
print("WROTE", OUT)
print(f"GPU device time: n={len(gpu)} median={med(gpu):.0f} max={max(gpu):.0f}")
print(f"cp0->cp1 span : n={len(cp)} median={med(cp):.0f} max={max(cp):.0f}")
