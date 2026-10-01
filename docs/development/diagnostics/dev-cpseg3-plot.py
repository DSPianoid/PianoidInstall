#!/usr/bin/env python3
"""Plot per-segment duration over cycles for FIXED and CLEAN captures, marking
over-budget (Full>1333us) cycles. Reads dev-cpseg3-<LABEL>-1.json (the first
capture of each build). Saves dev-cpseg3-segments-<LABEL>.png.

Usage: python dev-cpseg3-plot.py <LABEL> [json_idx]
"""
import sys, json
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

LABEL = sys.argv[1] if len(sys.argv) > 1 else "FIXED"
IDX = sys.argv[2] if len(sys.argv) > 2 else "1"
BUDGET = 1333.33

H = {
    "kernel": "Segment: kernel cp0→cp1 (us)",
    "audio_prep": "Segment: FIR/audio-prep cp1→cp2 (us)",
    "sync_wait": "Segment: sync wait cp2→cp3 (us)",
    "host_tail": "Segment: host tail cp3→cp4 (us)",
    "full": "Full cycle incl. sync (us)",
}
COLOR = {"kernel": "#42a5f5", "audio_prep": "#26a69a",
         "sync_wait": "#ffa726", "host_tail": "#ab47bc", "full": "#888888"}

path = f"dev-cpseg3-{LABEL}-{IDX}.json"
r = json.load(open(path, encoding="utf-8"))
headers = r.get("chart_headers", [])
data = r.get("data", [])
by_h = {h: data[i] for i, h in enumerate(headers) if i < len(data)}


def trim(s):
    return s[2:] if s and len(s) > 4 else (s or [])


series = {k: trim(by_h.get(v) or []) for k, v in H.items()}
full = series["full"]
# clamp insane artifacts for plotting
def clean(s):
    return [x if (x is not None and x < 1e7) else None for x in s]


for k in series:
    series[k] = clean(series[k])
full = series["full"]
over_idx = [i for i, v in enumerate(full) if v is not None and v > BUDGET]

fig, axes = plt.subplots(5, 1, figsize=(16, 14), sharex=True)
order = ["kernel", "audio_prep", "sync_wait", "host_tail", "full"]
titles = {
    "kernel": "kernel cp0→cp1 (synthesis host-wall) — the fix's target segment",
    "audio_prep": "audio-prep cp1→cp2 (FIR + channel map)",
    "sync_wait": "sync-wait cp2→cp3 (blocking driver-push / audio back-pressure)",
    "host_tail": "host-tail cp3→cp4 (record/append)",
    "full": "FULL cycle cp0→cp5 (incl. sync) — over-budget diamonds in red",
}
for ax, k in zip(axes, order):
    s = series[k]
    x = list(range(len(s)))
    ax.plot(x, s, color=COLOR[k], lw=0.5)
    ax.axhline(BUDGET, color="#ef5350", ls="--", lw=0.8, label=f"budget {BUDGET:.0f}us")
    # mark over-budget cycles on each segment at the full-cycle's over indices
    ov_x = [i for i in over_idx if i < len(s) and s[i] is not None]
    ov_y = [s[i] for i in ov_x]
    ax.scatter(ov_x, ov_y, s=6, color="#ef5350", zorder=3)
    ax.set_ylabel("us")
    ax.set_title(f"[{LABEL}] {titles[k]}", fontsize=9, loc="left")
    ax.legend(loc="upper right", fontsize=7)
    ax.grid(alpha=0.2)
axes[-1].set_xlabel("synthesis cycle")
fig.suptitle(f"Per-segment checkpoint durations over cycles — {LABEL} build "
             f"({len(over_idx)} over-budget of {len(full)} cycles)", fontsize=12)
fig.tight_layout(rect=[0, 0, 1, 0.98])
out = f"dev-cpseg3-segments-{LABEL}.png"
fig.savefig(out, dpi=90)
print("WROTE", out, "| over-budget", len(over_idx), "of", len(full))
