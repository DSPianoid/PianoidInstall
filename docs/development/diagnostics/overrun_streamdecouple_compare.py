"""dev-overrun stream-decouple standalone A/B comparison.

Compares cp0->cp1 spike + underrun distribution between:
  PRE-FIX   = a5c4503 (no synthesis_stream_, no lever A), RT-OFF (no env)
  STREAM-DECOUPLE = a38b02b RT-OFF hardening arm (already captured)
Both under the SAME conditions (12 inducers, 8s, ASIO=4, muted). Answers the
user's "does a38b02b measurably help vs clean?" with data.

Usage:
    .venv/Scripts/python tools/overrun_streamdecouple_compare.py \
        --prefix-dir .claude/scratch_overrun/prefix_rtoff \
        --decouple-combined .claude/scratch_overrun/harden_rtoff/harden_rtoff-combined.json
"""
import argparse, glob, json, os, statistics


def load_runs(d):
    runs = []
    for f in sorted(glob.glob(os.path.join(d, "*-run*.json"))):
        try:
            runs.append(json.load(open(f)))
        except Exception:
            pass
    return runs


def arm_stats(runs):
    spikes = [r["cp01_spikes_over_threshold"] for r in runs]
    cp01max = [r["cp01_us"]["max"] for r in runs]
    ur = [r["underrun_pct"] for r in runs]
    urc = [r["underrun_count"] for r in runs]
    return {
        "runs": len(runs),
        "spikes_total": sum(spikes),
        "spikes_runs": sum(1 for s in spikes if s > 0),
        "cp01_max_max": max(cp01max) if cp01max else 0,
        "cp01_max_median": statistics.median(cp01max) if cp01max else 0,
        "ur_mean": statistics.mean(ur) if ur else 0,
        "ur_max": max(ur) if ur else 0,
        "ur_total": sum(urc),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prefix-dir", required=True)
    ap.add_argument("--decouple-combined", required=True)
    args = ap.parse_args()

    pre = arm_stats(load_runs(args.prefix_dir))
    dd = json.load(open(args.decouple_combined))
    dec = {
        "runs": dd["runs"],
        "spikes_total": dd["cp01_spikes_total"],
        "cp01_max_max": dd["cp01_max_us"]["max"],
        "cp01_max_median": dd["cp01_max_us"]["median"],
        "ur_mean": dd["underrun_pct"]["mean"],
        "ur_max": dd["underrun_pct"]["max"],
        "ur_total": dd["underrun_total"],
    }

    print("\n===== STREAM-DECOUPLE STANDALONE A/B (both RT-OFF, muted, 12 inducers) =====")
    hdr = f"  {'metric':<22} {'PRE-FIX a5c4503':>18} {'a38b02b decouple':>18}"
    print(hdr)
    print("  " + "-" * (len(hdr) - 2))
    rows = [
        ("runs", "runs"), ("cp01 spikes>5ms total", "spikes_total"),
        ("cp01 max us", "cp01_max_max"), ("cp01 max median us", "cp01_max_median"),
        ("underrun mean %", "ur_mean"), ("underrun max %", "ur_max"),
        ("underrun total", "ur_total"),
    ]
    for label, key in rows:
        pv = pre.get(key, 0); dv = dec.get(key, 0)
        print(f"  {label:<22} {pv:>18.3f} {dv:>18.3f}" if isinstance(pv, float) or isinstance(dv, float)
              else f"  {label:<22} {pv:>18} {dv:>18}")

    # Verdict
    pre_rate = pre["spikes_total"] / max(pre["runs"], 1)
    dec_rate = dec["spikes_total"] / max(dec["runs"], 1)
    print(f"\n  spikes/run: PRE-FIX {pre_rate:.2f}  vs  decouple {dec_rate:.2f}")
    print(f"  cp01 max: PRE-FIX {pre['cp01_max_max']:.0f}us  vs  decouple {dec['cp01_max_max']:.0f}us")
    if pre_rate > dec_rate * 1.3 or pre["cp01_max_max"] > dec["cp01_max_max"] * 1.3:
        print("  VERDICT: a38b02b MEASURABLY HELPS (pre-fix materially worse) -> KEEP")
    elif dec_rate > pre_rate * 1.3 or dec["cp01_max_max"] > pre["cp01_max_max"] * 1.3:
        print("  VERDICT: pre-fix BETTER -> a38b02b may HURT, flag for revert")
    else:
        print("  VERDICT: INDISTINGUISHABLE within noise -> a38b02b not measurably helping (host-preemption dominates both); flag for separate decision")


if __name__ == "__main__":
    main()
