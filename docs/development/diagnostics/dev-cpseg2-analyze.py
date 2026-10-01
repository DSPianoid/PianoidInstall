#!/usr/bin/env python
"""dev-cpseg2 per-segment over-budget attribution.

Takes a sound_test get_chart_test JSON response and, for every over-budget
synthesis cycle (full cp0->cp5 > BUDGET_US), attributes the cycle to the
segment that dominates it. Tabulates the attribution and renders per-segment
PNG charts (each segment over cycles, over-budget cycles marked).

The segments come directly from the engine's cp0..cp5 host checkpoints, which
chartFunctions.py already decomposes and ships as named series:
  kernel      cp0->cp1  (synthesis kernel host-wall; holds the COOP_SYNC wait)
  audio_prep  cp1->cp2  (FIR + channel-map secondary kernels)
  sync_wait   cp2->cp3  (blocking driver push = audio-clock back-pressure)
  host_tail   cp3->cp4  (post-push host record/append)
  full        cp0->cp5  (whole cycle incl. the sync wait)

Usage: python dev-cpseg2-analyze.py <response.json> <label> <out_prefix>
"""
import sys, json, os

BUDGET_US = 1333.0  # one ASIO 64-sample @ 44.1kHz audio cycle ~= 1451us; project budget 1333us

SEG_HEADERS = {
    "kernel":     "Segment: kernel cp0→cp1 (us)",
    "audio_prep": "Segment: FIR/audio-prep cp1→cp2 (us)",
    "sync_wait":  "Segment: sync wait cp2→cp3 (us)",
    "host_tail":  "Segment: host tail cp3→cp4 (us)",
}
FULL_HEADER = "Full cycle incl. sync (us)"
ADD_HEADER  = "Add-kernel device time (us)"

# The first 1-2 cycles can be a spurious idle-gap (engine idles in
# canProduce.wait before the first note) showing as a huge "max"; the repro
# doc says EXCLUDE it. We drop any leading cycle whose full span is absurd
# (> IDLE_GAP_US) AND only at the very start of the series.
IDLE_GAP_US = 30000.0


def _series_by_header(resp):
    headers = resp.get("chart_headers") or []
    data = resp.get("data") or []
    out = {}
    for i, h in enumerate(headers):
        if i < len(data):
            out[h] = data[i]
    return out


def load(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def analyze(resp, label):
    sbh = _series_by_header(resp)
    full = [float(x) for x in (sbh.get(FULL_HEADER) or [])]
    segs = {}
    for key, hdr in SEG_HEADERS.items():
        segs[key] = [float(x) for x in (sbh.get(hdr) or [])]
    add = [float(x) for x in (sbh.get(ADD_HEADER) or [])]

    n = len(full)
    if n == 0:
        return {"label": label, "error": "no full-cycle series in response",
                "text_fields": resp.get("text_fields", {})}

    # CRITICAL ALIGNMENT: cp2/cp3/cp4 are recorded only on the Online audio path
    # (inside pushCycleAudioToDriver), so the audio_prep/sync_wait/host_tail
    # arrays can be 1 shorter than full/kernel and are misaligned at the HEAD.
    # Aligning all series to the common length from the TAIL makes
    # full == kernel+audio_prep+sync_wait+host_tail EXACTLY (verified median
    # |full-sum| == 0). Without this, segment values land on the wrong cycle.
    lens = [len(full)] + [len(segs[k]) for k in SEG_HEADERS]
    m = min(lens)
    full = full[-m:]
    segs = {k: v[-m:] for k, v in segs.items()}

    # Drop a leading idle-gap cycle (only at index 0/1) AFTER alignment.
    start = 0
    for i in range(min(2, m)):
        if full[i] > IDLE_GAP_US:
            start = i + 1
    full_r = full[start:]
    seg_r = {k: v[start:] for k, v in segs.items()}

    over_idx = [i for i, v in enumerate(full_r) if v > BUDGET_US]

    def stats(arr):
        if not arr:
            return None
        s = sorted(arr)
        return {"n": len(arr), "median": s[len(s)//2], "max": max(arr),
                "mean": sum(arr)/len(arr),
                "p99": s[min(len(s)-1, int(0.99*len(s)))]}

    seg_stats = {k: stats(v) for k, v in seg_r.items()}
    seg_median = {k: (seg_stats[k]["median"] if seg_stats[k] else 0.0) for k in SEG_HEADERS}

    SEGS = list(SEG_HEADERS.keys())

    # Two complementary attributions per over-budget cycle:
    #  (1) ARGMAX  — which segment is the LARGEST absolute contributor that cycle.
    #  (2) EXCESS  — which segment's DEVIATION from its own median contributes
    #      the most to this cycle's over-budget excess (full - its median sum).
    #      This is the "what makes THIS cycle slow vs a normal cycle" question.
    argmax_attrib = {k: 0 for k in SEGS}
    excess_attrib = {k: 0 for k in SEGS}
    # accumulate mean segment composition of over-budget cycles
    seg_sum_over = {k: 0.0 for k in SEGS}
    seg_dev_sum_over = {k: 0.0 for k in SEGS}
    per_cycle = []
    for i in over_idx:
        comp = {}
        dev = {}
        for k in SEGS:
            arr = seg_r.get(k) or []
            v = arr[i] if i < len(arr) else 0.0
            comp[k] = v
            dev[k] = v - seg_median[k]   # deviation from this segment's baseline
            seg_sum_over[k] += v
            seg_dev_sum_over[k] += max(0.0, dev[k])
        am = max(SEGS, key=lambda k: comp[k])
        ex = max(SEGS, key=lambda k: dev[k])
        argmax_attrib[am] += 1
        excess_attrib[ex] += 1
        per_cycle.append((i, full_r[i], am, comp[am], ex, dev[ex]))

    nb = max(1, len(over_idx))
    seg_mean_over = {k: seg_sum_over[k]/nb for k in SEGS}
    seg_mean_dev_over = {k: seg_dev_sum_over[k]/nb for k in SEGS}

    return {
        "label": label,
        "n_cycles": len(full_r),
        "budget_us": BUDGET_US,
        "n_over_budget": len(over_idx),
        "over_pct": 100.0*len(over_idx)/len(full_r) if full_r else 0.0,
        "argmax_attrib": argmax_attrib,
        "excess_attrib": excess_attrib,
        "seg_mean_over": seg_mean_over,         # avg us per segment on over-budget cycles
        "seg_mean_dev_over": seg_mean_dev_over, # avg positive deviation-from-median on over cycles
        "seg_median": seg_median,
        "full_stats": stats(full_r),
        "seg_stats": seg_stats,
        "add_stats": stats(add),
        "per_cycle_over": per_cycle,
        "idle_dropped": start,
        "text_fields": resp.get("text_fields", {}),
        "_series": {"full": full_r, **seg_r},
    }


def print_report(a):
    print(f"\n===== {a['label']} =====")
    if a.get("error"):
        print("  ERROR:", a["error"])
        for k, v in a.get("text_fields", {}).items():
            print("   TF:", k, "=", v)
        return
    print(f"  cycles (idle-gap dropped={a['idle_dropped']}): {a['n_cycles']}")
    fs = a["full_stats"]
    print(f"  full-cycle (cp0->cp5) us: median={fs['median']:.0f} p99={fs['p99']:.0f} max={fs['max']:.0f}")
    print(f"  OVER-BUDGET (>{a['budget_us']:.0f}us): {a['n_over_budget']} ({a['over_pct']:.2f}%)")
    nob = max(1, a['n_over_budget'])
    print(f"  ATTRIBUTION (a) by LARGEST-ABSOLUTE segment that cycle:")
    for k in ["kernel", "audio_prep", "sync_wait", "host_tail"]:
        c = a['argmax_attrib'][k]
        print(f"     {k:11s}: {c:5d} ({100.0*c/nob:5.1f}%)")
    print(f"  ATTRIBUTION (b) by which segment's DEVIATION-from-baseline drives the excess:")
    for k in ["kernel", "audio_prep", "sync_wait", "host_tail"]:
        c = a['excess_attrib'][k]
        print(f"     {k:11s}: {c:5d} ({100.0*c/nob:5.1f}%)")
    print(f"  MEAN segment composition of over-budget cycles (us | +dev-from-median):")
    for k in ["kernel", "audio_prep", "sync_wait", "host_tail"]:
        print(f"     {k:11s}: {a['seg_mean_over'][k]:7.0f}us | +{a['seg_mean_dev_over'][k]:6.0f}us  (baseline median {a['seg_median'][k]:.0f})")
    print(f"  per-segment all-cycle medians/p99/max us:")
    for k in ["kernel", "audio_prep", "sync_wait", "host_tail"]:
        st = a["seg_stats"].get(k)
        if st:
            print(f"     {k:11s}: median={st['median']:.0f} p99={st['p99']:.0f} max={st['max']:.0f}")
    if a["add_stats"]:
        st = a["add_stats"]
        print(f"  add-kernel DEVICE us: median={st['median']:.0f} max={st['max']:.0f} (GPU compute, should stay FLAT)")
    if a["per_cycle_over"]:
        print(f"  over-budget cycle detail (cycle, full, argmax-seg/us, excess-seg/+dev) [first 25]:")
        for (i, fv, am, amv, ex, exd) in a["per_cycle_over"][:25]:
            print(f"     cyc={i:5d} full={fv:7.0f}  argmax={am:10s}{amv:6.0f}  excess={ex:10s}+{exd:6.0f}")


def make_charts(a, out_prefix):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception as e:
        print("  [charts] matplotlib unavailable:", e)
        return []
    if a.get("error"):
        return []
    series = a["_series"]
    full = series["full"]
    over_idx = set(i for i, v in enumerate(full) if v > a["budget_us"])
    # which segment is the over-budget DRIVER per cycle (argmax over segments)
    SEGS = ["kernel", "audio_prep", "sync_wait", "host_tail"]
    driver = {}
    for i in over_idx:
        comp = {k: (series[k][i] if i < len(series[k]) else 0.0) for k in SEGS}
        driver[i] = max(SEGS, key=lambda k: comp[k])
    paths = []
    panels = [
        ("full", "Full cycle cp0→cp5 (us)", "#ef5350"),
        ("kernel", "kernel cp0→cp1 (us)", "#42a5f5"),
        ("sync_wait", "sync wait cp2→cp3 (us)", "#ffa726"),
        ("audio_prep", "FIR/audio-prep cp1→cp2 (us)", "#26a69a"),
        ("host_tail", "host tail cp3→cp4 (us)", "#ab47bc"),
    ]
    fig, axes = plt.subplots(len(panels), 1, figsize=(13, 2.1*len(panels)), sharex=True)
    for ax, (key, title, color) in zip(axes, panels):
        arr = series.get(key) or []
        x = list(range(len(arr)))
        ax.plot(x, arr, color=color, lw=0.6)
        ax.axhline(a["budget_us"], color="red", ls="--", lw=0.8, label=f"budget {a['budget_us']:.0f}us")
        if key == "full":
            ob_x = sorted(over_idx)
            ob_y = [arr[i] for i in ob_x]
            ax.scatter(ob_x, ob_y, s=10, color="red", marker="D", zorder=3,
                       label=f"over-budget ({len(ob_x)})")
        else:
            # mark only cycles where THIS segment is the over-budget driver
            dr_x = [i for i in over_idx if driver.get(i) == key and i < len(arr)]
            dr_y = [arr[i] for i in dr_x]
            if dr_x:
                ax.scatter(dr_x, dr_y, s=12, color="red", marker="D", zorder=3,
                           label=f"drives over-budget ({len(dr_x)})")
        ax.set_ylabel(title, fontsize=8)
        ax.legend(fontsize=7, loc="upper right")
        ax.grid(alpha=0.2)
    axes[-1].set_xlabel("synthesis cycle")
    am = a["argmax_attrib"]; nob = max(1, a["n_over_budget"])
    dom = max(SEGS, key=lambda k: am[k])
    sub = (f"{a['n_over_budget']} over-budget ({a['over_pct']:.1f}%) | driver: "
           f"{dom} {100.0*am[dom]/nob:.0f}% | underruns {a['text_fields'].get('Underruns','?')}")
    fig.suptitle(f"dev-cpseg2 per-segment over-budget attribution — {a['label']}\n{sub}", fontsize=10)
    fig.tight_layout(rect=[0, 0, 1, 0.98])
    p = out_prefix + "-segments.png"
    fig.savefig(p, dpi=110)
    plt.close(fig)
    paths.append(p)
    print("  [charts] wrote", p)
    return paths


if __name__ == "__main__":
    path = sys.argv[1]
    label = sys.argv[2] if len(sys.argv) > 2 else os.path.basename(path)
    out_prefix = sys.argv[3] if len(sys.argv) > 3 else os.path.splitext(path)[0]
    resp = load(path)
    a = analyze(resp, label)
    print_report(a)
    make_charts(a, out_prefix)
    # dump the analysis json next to the prefix
    with open(out_prefix + "-attrib.json", "w", encoding="utf-8") as f:
        slim = {k: v for k, v in a.items() if k != "_series"}
        json.dump(slim, f, indent=2, default=str)
    print("  [analysis] wrote", out_prefix + "-attrib.json")
    # Embed the aligned per-cycle series separately (for the comparison chart).
    with open(out_prefix + "-series.json", "w", encoding="utf-8") as f:
        json.dump({"label": a["label"], "budget_us": a["budget_us"],
                   "series": a["_series"]}, f, default=str)
    print("  [analysis] wrote", out_prefix + "-series.json")
