"""
dev-steinway-preset: compute GUARDED tuned tensions from the pass-1 measurements.

Reads D:\tmp\steinway_B_pass1.json (pass-1 measure: tension_before, measured_hz, target_hz, cents_before).
Applies the user's "not dramatically off" guard BY CONSTRUCTION:
  - SKIP a note (keep derived tension) if measurement failed (hz<=0) or |cents_before| > CENTS_SKIP (octave/
    harmonic-lock error — the engine's autocorr refinement, not a real pitch).
  - else CLAMP the correction factor (target/measured)^2 so |dT| <= DT_CLAMP.
Writes D:\tmp\steinway_B_tuned_tensions.json {pitch: {tension_after, tension_before, action, dT_pct,
cents_before}} for the apply step, and prints a transparent per-note table + skip list.
Pure CPU (no GPU). f∝√tension is the engine tuner's own law (one analytic step).
"""
import json

PASS1 = r"D:\tmp\steinway_B_pass1.json"
OUT = r"D:\tmp\steinway_B_tuned_tensions.json"
CENTS_SKIP = 250.0     # |cents| beyond this = octave/harmonic measurement error -> skip (keep derived)
DT_CLAMP = 0.25        # clamp |tension change| to +-25% (absurd-tension guard, by construction)

def main():
    p1 = json.load(open(PASS1))
    out = {}
    applied = []; clamped = []; skipped = []
    print(f"{'MIDI':>4} {'cents_b':>8} {'raw_dT%':>8} {'final_dT%':>9} {'action':>8}")
    for pk in sorted(p1, key=lambda x: int(x)):
        v = p1[pk]
        T0 = v["tension_before"]
        c = v["cents_before"]
        meas = v["measured_hz"]; tgt = v["target_hz"]
        if c is None or meas <= 0 or abs(c) > CENTS_SKIP:
            out[pk] = dict(tension_after=round(T0, 6), tension_before=T0, action="skip",
                           dT_pct=0.0, cents_before=c)
            skipped.append(int(pk))
            print(f"{int(pk):>4} {str(c):>8} {'--':>8} {0.0:>+9.1f} {'SKIP':>8}")
            continue
        factor = (tgt / meas) ** 2
        raw_dT = (factor - 1) * 100
        # clamp
        lo, hi = 1 - DT_CLAMP, 1 + DT_CLAMP
        cf = max(lo, min(hi, factor))
        T1 = T0 * cf
        final_dT = (cf - 1) * 100
        act = "apply"
        if cf != factor:
            act = "clamp"; clamped.append(int(pk))
        else:
            applied.append(int(pk))
        out[pk] = dict(tension_after=round(T1, 6), tension_before=T0, action=act,
                       dT_pct=round(final_dT, 2), cents_before=c)
        print(f"{int(pk):>4} {c:>8.1f} {raw_dT:>+8.1f} {final_dT:>+9.1f} {act.upper():>8}")

    json.dump(out, open(OUT, "w"), indent=2)
    print(f"\nSUMMARY: applied={len(applied)} clamped={len(clamped)} skipped(keep-derived)={len(skipped)}")
    print(f"  clamped notes (|raw_dT|>{DT_CLAMP*100:.0f}%): {clamped if clamped else 'NONE'}")
    print(f"  skipped notes (|cents|>{CENTS_SKIP:.0f} or failed meas): {skipped}")
    dts = [out[k]['dT_pct'] for k in out if out[k]['action'] != 'skip']
    if dts:
        print(f"  applied/clamped dT range: {min(dts):+.1f}% .. {max(dts):+.1f}%")
    print(f"WROTE {OUT}")

if __name__ == "__main__":
    main()
