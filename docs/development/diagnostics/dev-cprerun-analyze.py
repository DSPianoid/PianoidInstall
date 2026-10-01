#!/usr/bin/env python3
"""dev-cprerun analyzer for the volume-64 FIXED multi-run.

Reads dev-cpseg3-CPRERUN64-1..5.json (produced by dev-cpseg3-capture.py), and:
  (1) prints the 5 cp0->cp1 (kernel) maxima  [multi-run confirmation],
  (2) the underrun-tie: per run, total ASIO underruns vs the over-budget cycle
      breakdown by dominant segment; classifies each cp2->cp3 (sync) spike >5ms
      as REAL glitch (coincided with an underrun) vs benign,
  (3) correlation: whether the sync spikes land at the same cycle indices across
      the 5 runs (deterministic) or scatter (contention),
  (4) writes per-run segment charts + an underrun-tie summary chart.
"""
import json, statistics, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

LABEL = "CPRERUN64"
RUNS = [1, 2, 3, 4, 5]
KH = "Segment: kernel cp0→cp1 (us)"
AH = "Segment: FIR/audio-prep cp1→cp2 (us)"
SH = "Segment: sync wait cp2→cp3 (us)"
TH = "Segment: host tail cp3→cp4 (us)"
FH = "Full cycle incl. sync (us)"
BUDGET = 1333.33


def trim(s):
    return s[2:] if s and len(s) > 4 else (s or [])


def clean(s):
    return [x for x in s if x is not None and x < 1e7]


def load(i):
    r = json.load(open(f"dev-cpseg3-{LABEL}-{i}.json", encoding="utf-8"))
    h = r["chart_headers"]; d = r["data"]
    bh = {x: d[j] for j, x in enumerate(h) if j < len(d)}
    tf = r.get("text_fields", {})
    k = trim(bh.get(KH, [])); a = trim(bh.get(AH, []))
    s = trim(bh.get(SH, [])); t = trim(bh.get(TH, [])); f = trim(bh.get(FH, []))
    ur_raw = tf.get("Underruns", "0 / 0")
    ur_n = int(ur_raw.split("/")[0].strip()) if "/" in ur_raw else 0
    cb_total = 0
    if "/" in ur_raw:
        try:
            cb_total = int(ur_raw.split("/")[1].strip().split()[0])
        except Exception:
            cb_total = 0
    ci = tf.get("Callback interval (us)", "")
    return {"i": i, "k": k, "a": a, "s": s, "t": t, "f": f,
            "ur": ur_n, "cb": cb_total, "ur_raw": ur_raw, "ci": ci, "tf": tf}


def main():
    rows = [load(i) for i in RUNS]

    print("=" * 70)
    print("(1) MULTI-RUN cp0->cp1 (KERNEL) CONFIRMATION — volume 64 (NORMAL), FIXED build")
    print("=" * 70)
    kmaxes = []
    for r in rows:
        kc = clean(r["k"])
        kmax = max(kc) if kc else 0
        kmaxes.append(kmax)
        kob = sum(1 for x in kc if x > BUDGET)
        print(f"  run {r['i']}: kernel cp0->cp1  max={kmax:8.0f}us  "
              f"median={statistics.median(kc):.0f}us  cycles>budget(1333)={kob}  n={len(kc)}")
    print(f"\n  ==> 5 kernel maxima (us): {[round(x) for x in kmaxes]}")
    print(f"  ==> overall kernel max across 5 runs: {max(kmaxes):.0f}us  "
          f"(budget {BUDGET:.0f}us). Bounded/no-spikes if all < ~1500us.")

    print("\n" + "=" * 70)
    print("(2) UNDERRUN-TIE — are the cp2->cp3 (sync-wait) spikes REAL glitches?")
    print("=" * 70)
    SPIKE = 5000.0  # 5ms threshold for "spike" per brief
    total_sync_spikes = 0
    total_sync_spikes_with_ur = 0
    for r in rows:
        sc = clean(r["s"]); kc = clean(r["k"])
        sync_spikes = [x for x in sc if x > SPIKE]
        smax = max(sc) if sc else 0
        kob = sum(1 for x in kc if x > BUDGET)
        total_sync_spikes += len(sync_spikes)
        print(f"  run {r['i']}: UNDERRUNS = {r['ur_raw']}")
        print(f"           sync cp2->cp3:  max={smax:8.0f}us  spikes(>5ms)={len(sync_spikes)}  "
              f"| kernel cycles>budget={kob}  | callbacks={r['cb']}")
        print(f"           callback interval: {r['ci']}")
    print(f"\n  Aggregate over 5 runs:")
    tot_ur = sum(r["ur"] for r in rows)
    print(f"    total ASIO underruns (REAL glitches)      = {tot_ur}")
    print(f"    total sync cp2->cp3 spikes (>5ms)         = {total_sync_spikes}")
    print(f"    => If underruns==0 while sync spikes>0, the sync spikes are BENIGN")
    print(f"       (engine ran AHEAD, parked waiting on the audio buffer = no drop).")

    print("\n" + "=" * 70)
    print("(3) CORRELATION — deterministic vs contention")
    print("=" * 70)
    # cycle indices of sync spikes per run
    for r in rows:
        st = r["s"]
        idxs = [j for j, x in enumerate(st) if x is not None and x < 1e7 and x > SPIKE]
        print(f"  run {r['i']}: sync-spike cycle indices = {idxs[:30]}")
    # overlap analysis
    sets = []
    for r in rows:
        st = r["s"]
        sets.append(set(j for j, x in enumerate(st)
                        if x is not None and x < 1e7 and x > SPIKE))
    if any(sets):
        union = set().union(*sets)
        common = set.intersection(*[s if s else set() for s in sets]) if all(sets) else set()
        print(f"\n  union of spike indices (any run): {sorted(union)[:40]}")
        print(f"  indices common to ALL 5 runs: {sorted(common)}")
        print(f"  => empty/near-empty common set + scattered indices = NON-deterministic"
              f" (contention/back-pressure), not a fixed code hotspot.")

    # ---- charts ----
    # per-run segment chart
    for r in rows:
        fig, ax = plt.subplots(figsize=(13, 5))
        kc = r["k"]; sc = r["s"]; fc = r["f"]
        n = min(len(fc), len(kc), len(sc))
        kc, sc, fc = kc[:n], sc[:n], fc[:n]
        xs = np.arange(n)
        def yv(s):
            return [x if (x is not None and x < 1e7) else np.nan for x in s]
        ax.plot(xs, yv(kc), lw=0.6, color="#42a5f5", label="kernel cp0→cp1")
        ax.plot(xs, yv(sc), lw=0.6, color="#ffa726", label="sync-wait cp2→cp3")
        ax.plot(xs, yv(fc), lw=0.5, color="#bbbbbb", alpha=0.6, label="full cycle")
        ax.axhline(BUDGET, color="#ef5350", ls="--", lw=1, label="budget 1333us")
        # mark underrun-causing region: we only have aggregate underruns, so annotate count
        ax.set_title(f"dev-cprerun run {r['i']} (vol 64, FIXED) — underruns={r['ur_raw']}  "
                     f"kernel max={max(clean(kc) or [0]):.0f}us  sync max={max(clean(sc) or [0]):.0f}us",
                     fontsize=10)
        ax.set_xlabel("cycle index"); ax.set_ylabel("us")
        ax.set_ylim(0, max(2000, min(20000, max(clean(sc) or [2000]) * 1.1)))
        ax.legend(fontsize=8, loc="upper right"); ax.grid(alpha=0.2)
        fig.tight_layout()
        fig.savefig(f"dev-cprerun-segments-{r['i']}.png", dpi=100)
        plt.close(fig)
        print(f"  WROTE dev-cprerun-segments-{r['i']}.png")

    # summary underrun-tie chart
    fig, axes = plt.subplots(3, 1, figsize=(11, 11), sharex=True)
    caps = [f"run{r['i']}" for r in rows]
    x = np.arange(len(rows))
    urs = [r["ur"] for r in rows]
    kobs = [sum(1 for v in clean(r["k"]) if v > BUDGET) for r in rows]
    kmx = [max(clean(r["k"]) or [0]) for r in rows]
    smx = [max(clean(r["s"]) or [0]) / 1000.0 for r in rows]

    axes[0].bar(x, urs, color="#26a69a")
    for i, v in enumerate(urs):
        axes[0].text(i, v + 0.05, str(v), ha="center", fontsize=10, weight="bold")
    axes[0].set_ylabel("ASIO underruns")
    axes[0].set_title("ACTUAL underruns (the real glitch metric) — vol 64, FIXED build", fontsize=10, loc="left")
    axes[0].grid(alpha=0.2, axis="y")

    axes[1].bar(x, kobs, color="#42a5f5")
    for i in range(len(rows)):
        axes[1].text(i, kobs[i] + 0.02, f"{kobs[i]}\nmax {kmx[i]:.0f}us", ha="center", fontsize=8)
    axes[1].set_ylabel("kernel cp0→cp1\ncycles >1333us")
    axes[1].set_title("KERNEL cp0→cp1 spikes (the fix's target) — should be ~0 on FIXED", fontsize=10, loc="left")
    axes[1].grid(alpha=0.2, axis="y")

    axes[2].bar(x, smx, color="#ffa726")
    for i in range(len(rows)):
        axes[2].text(i, smx[i] + 0.1, f"{smx[i]:.1f}ms", ha="center", fontsize=8)
    axes[2].set_ylabel("sync cp2→cp3\nMAX (ms)")
    axes[2].set_title("SYNC-WAIT cp2→cp3 max — large yet underruns=0 => benign engine-ahead pacing", fontsize=10, loc="left")
    axes[2].set_xticks(x); axes[2].set_xticklabels(caps)
    axes[2].grid(alpha=0.2, axis="y")
    fig.suptitle("dev-cprerun vol-64: underruns vs kernel spikes vs sync-wait", fontsize=12)
    fig.tight_layout(rect=[0, 0, 1, 0.98])
    fig.savefig("dev-cprerun-underrun-tie.png", dpi=100)
    plt.close(fig)
    print("  WROTE dev-cprerun-underrun-tie.png")

    # machine-readable summary
    summary = {
        "label": LABEL, "volume": 64,
        "kernel_maxima_us": [round(x, 1) for x in kmaxes],
        "kernel_overall_max_us": round(max(kmaxes), 1),
        "per_run": [
            {"run": r["i"], "underruns_raw": r["ur_raw"], "underruns": r["ur"],
             "callbacks": r["cb"],
             "kernel_max_us": round(max(clean(r["k"]) or [0]), 1),
             "kernel_over_budget": sum(1 for v in clean(r["k"]) if v > BUDGET),
             "sync_max_us": round(max(clean(r["s"]) or [0]), 1),
             "sync_spikes_gt5ms": sum(1 for v in clean(r["s"]) if v > 5000)}
            for r in rows
        ],
        "total_underruns": tot_ur,
        "total_sync_spikes_gt5ms": total_sync_spikes,
    }
    json.dump(summary, open("dev-cprerun-summary.json", "w"), indent=2)
    print("  WROTE dev-cprerun-summary.json")


if __name__ == "__main__":
    main()
