"""
dev-steinway-preset: FAST two-pass analytic frequency tuner (replaces the hung GRANULAR-loop tuner).

Same physics as the engine FrequencyTuner (f ∝ √tension, MeasurementEngine.measure_frequency oracle),
but NO per-note GRANULAR upload loop (that async-swap loop is what hung). One pass:
  - load <preset>, render each piano note ONCE offline (MeasurementEngine.render_note),
    measure f0 (MeasurementEngine.measure_frequency — same as the engine tuner),
  - compute T_new = T_old * (target_hz / measured_hz)**2 (one analytic Newton-exact step for f∝√T),
  - write {pitch: {tension_before, tension_after, measured_hz, cents_before}} to <out_json>.
Run TWICE (apply between passes) to converge: pass-1 measures the derived preset, we apply, pass-2
measures the tuned preset to confirm residual cents. Foreground, bounded — no Bash run_in_background.

Usage: python dev-steinway-preset-tune-fast.py <preset_name> <out_json> [velocity]
"""
import sys, os, json, math
sys.path.insert(0, r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware")
os.chdir(r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware")
import pianoidCuda  # noqa
from pianoid import initialize  # noqa
from auto_tuner import MeasurementEngine, FrequencyTuner, measurement_window  # noqa

def main():
    preset = sys.argv[1]
    out_json = sys.argv[2]
    velocity = int(sys.argv[3]) if len(sys.argv) > 3 else 20
    d = json.load(open("presets/" + preset, encoding="utf-8"))
    mp = d["model_parameters"]
    targets = FrequencyTuner()._load_default_frequencies()   # ET, {pitch: hz}
    piano = sorted(int(k) for k in d["pitches"] if int(k) < 128)

    p = initialize("presets/" + preset, filterlen=48*128*3, string_iteration=mp["string_iteration"],
                   array_size=mp["array_size"], buffer_size=mp.get("buffer_size", 2),
                   sample_rate=mp["sr"], samples_in_cycle=mp["mode_iteration"],
                   max_volume=5e18, audio_on=False, audio_driver_type=0)
    eng = MeasurementEngine()
    sr = p.mp.sample_rate()
    out = {}
    print(f"Measuring {len(piano)} notes of {preset} (vel={velocity})...")
    for pid in piano:
        tgt = targets.get(pid)
        if tgt is None:
            continue
        skip_ms, window_ms = measurement_window(tgt)
        dur_ms = int(skip_ms + window_ms + 100)
        sig = eng.render_note(p, pid, velocity, dur_ms)
        meas = eng.measure_frequency(sig, sr, tgt)
        T_old = p.sm.pitches[pid].physics.tension
        if meas.hz > 0:
            T_new = T_old * (tgt / meas.hz) ** 2
            cents = meas.cents_error
        else:
            T_new = T_old
            cents = None
        out[str(pid)] = dict(tension_before=T_old, tension_after=round(T_new, 6),
                             measured_hz=round(meas.hz, 3), target_hz=round(tgt, 3),
                             cents_before=round(cents, 1) if cents is not None else None)
    with open(out_json, "w") as f:
        json.dump(out, f, indent=2)
    # summary
    valid = [v for v in out.values() if v["cents_before"] is not None]
    dTs = [(v["tension_after"]/v["tension_before"]-1)*100 for v in valid if v["tension_before"]]
    cb = [v["cents_before"] for v in valid]
    print(f"\nMeasured {len(out)} notes; {len(valid)} valid f0.")
    if cb:
        print(f"  cents-before: min {min(cb):.0f}, max {max(cb):.0f}, abs-mean {sum(abs(c) for c in cb)/len(cb):.1f}")
    if dTs:
        print(f"  implied dT: {min(dTs):+.1f}% .. {max(dTs):+.1f}% (mean {sum(dTs)/len(dTs):+.1f}%)")
    failed = [k for k, v in out.items() if v["cents_before"] is None]
    print(f"  measurement-failed pitches: {failed if failed else 'NONE'}")
    print(f"WROTE {out_json}")
    try:
        p.pianoid.shutdownGpu()
    except Exception:
        pass

if __name__ == "__main__":
    main()
