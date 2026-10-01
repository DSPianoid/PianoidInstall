#!/usr/bin/env python
"""dev-cpseg2 FIXED-vs-CLEAN comparison + combined chart.

Loads two attrib JSONs + two series JSONs (from dev-cpseg2-analyze.py), prints a
side-by-side table of over-budget attribution + segment stats, and renders a
comparison PNG showing full-cycle, kernel(cp0->cp1), and sync_wait(cp2->cp3)
for both builds so the fix's effect on cp0->cp1 is self-evident.

Usage:
  python dev-cpseg2-compare.py <fixed_prefix> <clean_prefix> <out.png>
  (each prefix has -attrib.json and -series.json)
"""
import sys, json


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def fmt_attrib(a, kind):
    d = a.get(kind, {})
    nob = max(1, a.get("n_over_budget", 1))
    return "  ".join(f"{k}={d.get(k,0)}({100.0*d.get(k,0)/nob:.0f}%)"
                     for k in ["kernel", "audio_prep", "sync_wait", "host_tail"])


def main():
    fixed_pref = sys.argv[1]
    clean_pref = sys.argv[2]
    out_png = sys.argv[3] if len(sys.argv) > 3 else "dev-cpseg2-compare.png"

    fixed = load(fixed_pref + "-attrib.json")
    clean = load(clean_pref + "-attrib.json")
    fser = load(fixed_pref + "-series.json")["series"]
    cser = load(clean_pref + "-series.json")["series"]

    print("=" * 80)
    print(f"{'METRIC':40s} {'CLEAN (pre-fix)':>19s} {'FIXED':>19s}")
    print("-" * 80)

    def line(name, cv, fv):
        print(f"{name:40s} {str(cv):>19s} {str(fv):>19s}")

    line("cycles", clean.get("n_cycles"), fixed.get("n_cycles"))
    line("over-budget count", clean.get("n_over_budget"), fixed.get("n_over_budget"))
    line("over-budget %", f"{clean.get('over_pct',0):.2f}", f"{fixed.get('over_pct',0):.2f}")
    line("underruns", clean.get("text_fields", {}).get("Underruns", "?"),
         fixed.get("text_fields", {}).get("Underruns", "?"))
    fs, cs = fixed.get("full_stats") or {}, clean.get("full_stats") or {}
    line("full-cycle median us", cs.get("median"), fs.get("median"))
    line("full-cycle p99 us", cs.get("p99"), fs.get("p99"))
    line("full-cycle max us", cs.get("max"), fs.get("max"))
    for seg in ["kernel", "audio_prep", "sync_wait", "host_tail"]:
        f = (fixed.get("seg_stats") or {}).get(seg) or {}
        c = (clean.get("seg_stats") or {}).get(seg) or {}
        line(f"{seg} median/max us", f"{c.get('median')}/{c.get('max')}",
             f"{f.get('median')}/{f.get('max')}")
    a = fixed.get("add_stats") or {}
    b = clean.get("add_stats") or {}
    line("add-kernel dev median/max us", f"{b.get('median')}/{b.get('max')}",
         f"{a.get('median')}/{a.get('max')}")
    print("-" * 80)
    print("OVER-BUDGET ATTRIBUTION (largest-absolute segment):")
    print("  CLEAN:", fmt_attrib(clean, "argmax_attrib"))
    print("  FIXED:", fmt_attrib(fixed, "argmax_attrib"))
    print("OVER-BUDGET ATTRIBUTION (excess driver = deviation-from-baseline):")
    print("  CLEAN:", fmt_attrib(clean, "excess_attrib"))
    print("  FIXED:", fmt_attrib(fixed, "excess_attrib"))
    print("=" * 80)

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception as e:
        print("[chart] matplotlib unavailable:", e)
        return

    budget = fixed.get("budget_us", 1333.0)
    rows = [("full", "Full cycle cp0→cp5 (us)"),
            ("kernel", "kernel cp0→cp1 (us)"),
            ("sync_wait", "sync wait cp2→cp3 (us)")]
    fig, axes = plt.subplots(len(rows), 2, figsize=(16, 8), sharex="col")
    cols = [("CLEAN (pre-fix, dev)", cser, clean), ("FIXED (stream-decouple)", fser, fixed)]
    for ci, (lbl, ser, a) in enumerate(cols):
        full = [float(x) for x in ser.get("full", [])]
        over = set(i for i, v in enumerate(full) if v > budget)
        for ri, (key, ytitle) in enumerate(rows):
            ax = axes[ri][ci]
            arr = [float(x) for x in ser.get(key, [])]
            ax.plot(range(len(arr)), arr, lw=0.5,
                    color={"full": "#ef5350", "kernel": "#42a5f5",
                           "sync_wait": "#ffa726"}[key])
            ax.axhline(budget, color="red", ls="--", lw=0.7)
            # mark over-budget cycles where this segment is the driver (for seg
            # rows) or all over-budget (for full row)
            if key == "full":
                mx = sorted(over)
            else:
                SEGS = ["kernel", "audio_prep", "sync_wait", "host_tail"]
                mx = []
                for i in over:
                    comp = {k: (float(ser[k][i]) if i < len(ser.get(k, [])) else 0.0) for k in SEGS}
                    if max(SEGS, key=lambda k: comp[k]) == key:
                        mx.append(i)
            my = [arr[i] for i in mx if i < len(arr)]
            mx = [i for i in mx if i < len(arr)]
            if mx:
                ax.scatter(mx, my, s=8, color="red", marker="D", zorder=3)
            if ri == 0:
                ax.set_title(f"{lbl}\nover-budget {a.get('n_over_budget')} ({a.get('over_pct',0):.1f}%) | "
                             f"underruns {a.get('text_fields',{}).get('Underruns','?')}", fontsize=9)
            if ci == 0:
                ax.set_ylabel(ytitle, fontsize=8)
            ax.grid(alpha=0.2)
            ax.set_ylim(bottom=0)
        axes[-1][ci].set_xlabel("synthesis cycle")
    fig.suptitle(f"dev-cpseg2 — per-segment over-budget attribution: CLEAN (pre-fix) vs FIXED  (budget {budget:.0f}us)",
                 fontsize=12)
    fig.tight_layout(rect=[0, 0, 1, 0.97])
    fig.savefig(out_png, dpi=110)
    print("[chart] wrote", out_png)


if __name__ == "__main__":
    main()
