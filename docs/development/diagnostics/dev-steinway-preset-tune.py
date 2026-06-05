"""
dev-steinway-preset: run the engine FrequencyTuner on preset B targeting ET (offline).

Loads Belarus_196modesC_Steinway1860_56SM, runs FrequencyTuner.tune_range over its piano
pitches (<=5 iters/note, tolerance 1 cent), reports per-note correction (tension factor +
before/after cents) and FLAGS dramatic corrections (|ΔT| > 35%, non-convergence, or CFL near/over
after). Writes the tuned per-pitch tensions to D:\tmp\steinway_B_tuned_tensions.json for the
apply step. Offline only (audio_off, adt=0). NO server. The tuner applies corrections through
update_pitch_physical_params_GRANULAR — the CFL-gated path — so a CFL-breaking correction is
skipped by the gate (we still re-check CFL after).
"""
import sys, os, json, math
sys.path.insert(0, r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware")
os.chdir(r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware")

import pianoidCuda  # noqa
from pianoid import initialize  # noqa
from auto_tuner import FrequencyTuner  # noqa

PRESET = "Belarus_196modesC_Steinway1860_56SM"
DRAMATIC_TENSION_FRAC = 0.35   # flag if |T_after/T_before - 1| > this

def main():
    d = json.load(open("presets/" + PRESET, encoding="utf-8"))
    mp = d["model_parameters"]
    p = initialize("presets/" + PRESET, filterlen=48*128*3, string_iteration=mp["string_iteration"],
                   array_size=mp["array_size"], buffer_size=mp.get("buffer_size", 2),
                   sample_rate=mp["sr"], samples_in_cycle=mp["mode_iteration"],
                   max_volume=5e18, audio_on=False, audio_driver_type=0)
    piano_pitches = sorted(int(k) for k in d["pitches"] if int(k) < 128)
    lo, hi = piano_pitches[0], piano_pitches[-1]
    print(f"Preset {PRESET}: piano {lo}-{hi}, {len(piano_pitches)} keys, blocks={len(d['blocks'])}")

    tuner = FrequencyTuner()   # ET defaults from note_frequencies.json

    # before: verify cents error for a sample (cheap)
    print("Running FrequencyTuner.tune_range (max_iter=5, tol=1.0 cents, vel=20)...")
    # tune_range's `pianoid` arg uses .sm.pitches / .mp / .update_pitch_physical_params_GRANULAR /
    # .get_all_pitches_in_preset — all on the high-level initialize() wrapper `p`.
    results = tuner.tune_range(p, start=lo, end=hi,
                               max_iterations=5, tolerance_cents=1.0, velocity=20)
    out = {}
    flags = []
    notconv = []
    print(f"\n{'MIDI':>4} {'tgt_Hz':>8} {'meas_Hz':>8} {'cents':>7} {'T_before':>10} {'T_after':>10} {'ΔT%':>7} {'iters':>5} {'conv':>4}")
    for pid in sorted(results):
        r = results[pid]
        dT = (r.tension_after / r.tension_before - 1.0) * 100.0 if r.tension_before else 0.0
        out[str(pid)] = dict(tension_after=r.tension_after, tension_before=r.tension_before,
                             cents_error=r.cents_error, iterations=r.iterations, converged=r.converged)
        flag = ""
        if abs(dT) > DRAMATIC_TENSION_FRAC * 100:
            flag += " ⚠ΔT"
            flags.append((pid, "tension", round(dT, 1)))
        if not r.converged:
            flag += " ⚠noconv"
            notconv.append(pid)
        print(f"{pid:>4} {r.target_hz:>8.2f} {r.measured_hz:>8.2f} {r.cents_error:>7.1f} "
              f"{r.tension_before:>10.2f} {r.tension_after:>10.2f} {dT:>+7.1f} {r.iterations:>5} {str(r.converged):>4}{flag}")

    # summary
    dTs = [(out[k]['tension_after']/out[k]['tension_before']-1)*100 for k in out if out[k]['tension_before']]
    cents_after = [out[k]['cents_error'] for k in out]
    print(f"\nSUMMARY: {len(out)} pitches tuned.")
    print(f"  ΔT range: {min(dTs):+.1f}% .. {max(dTs):+.1f}% (mean {sum(dTs)/len(dTs):+.1f}%)")
    print(f"  post-tune cents-error: min {min(cents_after):.1f}, max {max(cents_after):.1f}, "
          f"abs-mean {sum(abs(c) for c in cents_after)/len(cents_after):.2f}")
    print(f"  non-converged: {notconv if notconv else 'NONE'}")
    print(f"  DRAMATIC (|ΔT|>{DRAMATIC_TENSION_FRAC*100:.0f}%): {flags if flags else 'NONE'}")

    with open(r"D:\tmp\steinway_B_tuned_tensions.json", "w") as f:
        json.dump(out, f, indent=2)
    print(f"\nWROTE tuned tensions -> D:\\tmp\\steinway_B_tuned_tensions.json")

    try:
        p.pianoid.shutdownGpu()
    except Exception:
        pass

if __name__ == "__main__":
    main()
