"""dev-1e95: per-N tables, BEFORE (float: kg/, thr/, flt/, abl/, dev-a480 substep_sweep) vs AFTER (<dir>/)."""
import json, glob, os, sys
after = sys.argv[1] if len(sys.argv) > 1 else "dbl"
def load(path):
    return {n["pitch"]: n for n in json.load(open(path))["notes"]} if os.path.exists(path) else {}
f = lambda v, w=6, d=1: ("-" if v is None else f"{v:+{w}.{d}f}")
print(f"=== Belarus template @384 v110 — pitch: cents(conf) decay dB/s cycle_ms  [BEFORE float / AFTER {after}]")
for N in (4, 8, 12, 16):
    b = {}
    b.update(load(f"kg/Belarus_8band_196modes_a384_N{N}/results.json"))
    b.update(load(f"thr/thr_N{N}/results.json")); b.update(load(f"flt/tmpl_N{N}/results.json"))
    a = load(f"{after}/tmpl_N{N}/results.json")
    for p in (24, 26, 29, 33, 45, 52, 60):
        bb, aa = b.get(p), a.get(p)
        if bb is None and aa is None: continue
        bs = f"{f(bb['cents'])}({bb['pitch_confidence']:.2f}) {f(bb['decay_db_per_s'])} {bb.get('cycle_ms', float('nan')):.2f}" if bb else "-"
        as_ = f"{f(aa['cents'])}({aa['pitch_confidence']:.2f}) {f(aa['decay_db_per_s'])} {aa.get('cycle_ms', float('nan')):.2f}" if aa else "-"
        print(f"N={N:2d} p{p:3d} | {bs:32s} | {as_}")
print(f"\n=== F_15 (converted, array 512) v110 — cents vs FPGA prediction(conf) decay dB/s rms dB cycle_ms  [BEFORE float / AFTER {after}]")
sweep = "D:/repos/wt-a480-root/docs/development/diagnostics/dev-a480-renders/substep_sweep/"
for N in (4, 8, 16):
    b = {}
    if N == 8: b.update(load(sweep + "iter8.results.json"))
    if N == 16: b.update(load(sweep + "iter16.results.json"))
    b.update(load(f"abl/full_N{N}/results.json")); b.update(load(f"flt/f15_N{N}/results.json"))
    a = load(f"{after}/f15_N{N}/results.json")
    for p in (21, 22, 24, 28, 33, 60, 96):
        bb, aa = b.get(p), a.get(p)
        if bb is None and aa is None: continue
        bs = f"{f(bb.get('cents_vs_pred'))}({bb['pitch_confidence']:.2f}) {f(bb['decay_db_per_s'])} {bb['rms_db']:6.1f} {bb.get('cycle_ms', float('nan')):.2f}" if bb else "-"
        as_ = f"{f(aa.get('cents_vs_pred'))}({aa['pitch_confidence']:.2f}) {f(aa['decay_db_per_s'])} {aa['rms_db']:6.1f} {aa.get('cycle_ms', float('nan')):.2f}" if aa else "-"
        print(f"N={N:2d} p{p:3d} | {bs:38s} | {as_}")
