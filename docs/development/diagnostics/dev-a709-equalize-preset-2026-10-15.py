"""dev-a709 -- keyboard equalization of a preset OFFLINE (audio off, in-process, never a live backend).

    PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-a709-equalize-preset-2026-10-15.py \
        PRESET.json OUT_DIR --core CORE_DIR [--velocity 95] [--write]

The project's documented synthesis equalizer (CalibrationController.calibrate_synthesis = POST /calibrate_synthesis,
middleware OVERVIEW "CalibrationController"): per pitch, one offline render (note 300 ms, RMS over ALL output
channels 30-300 ms, SynthesisTuner._synthesis_only_measure), direct linear correction of the per-pitch hammer_mass
(RMS = K(pitch) x mass), then rescale_masses_to_physical_range (one factor into 2-20 g, output_scale compensated).
The engine is never started, so the semi-offline calibration mode is not needed (the controller's
_calibration_active guard is set instead of enter_calibration_mode, which requires a running engine).
Measures every key before and after with the same metric; --write patches the per-pitch hammer_mass and the Layer B
fields into PRESET.json (nothing else changes).
"""
import argparse
import json
import math
import os
import sys

import numpy as np


def measure_all(cc, pitches, velocity):
    return {p: cc.synthesis_tuner._synthesis_only_measure(p, velocity)["rms"] for p in pitches}


def spread(rms):
    db = np.array([20 * math.log10(v) for v in rms.values() if v > 0])
    med = float(np.median(db))
    return {"max_minus_min_db": float(db.max() - db.min()), "sd_db": float(db.std()),
            "p5_p95_db": [float(np.percentile(db, 5) - med), float(np.percentile(db, 95) - med)],
            "median_dbfs_bare": med, "n": int(db.size)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("preset")
    ap.add_argument("out_dir")
    ap.add_argument("--core", required=True)
    ap.add_argument("--velocity", type=int, default=95)
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    a.preset, a.out_dir = os.path.abspath(a.preset), os.path.abspath(a.out_dir)
    os.makedirs(a.out_dir, exist_ok=True)
    mw = os.path.abspath(os.path.join(a.core, "pianoid_middleware"))
    sys.path.insert(0, mw)
    os.chdir(mw)
    from pianoid import initialize
    from calibration_controller import CalibrationController
    import output_level
    preset = json.load(open(a.preset))
    lp = preset["fpga_conversion"]["load_params"]
    pw = initialize(a.preset, filterlen=48 * 128 * 3, string_iteration=lp["string_iteration"],
                    array_size=lp["array_size"], sample_rate=48000, samples_in_cycle=64, buffer_size=4,
                    audio_on=False, audio_driver_type=0, listen_to_modes=False, sound_derivative_order=1)
    assert not output_level.engine_is_live(pw), "engine is live - refusing"
    pitches = pw.get_all_pitches_in_preset(convert_to_notes=False, key_pitches=True)
    cc = CalibrationController(pw)
    before = measure_all(cc, pitches, a.velocity)
    target = float(np.exp(np.median(np.log([v for v in before.values() if v > 0]))))
    pw._calibration_active = True                     # offline engine: no run loop to stop
    try:
        res = cc.calibrate_synthesis(pitches, a.velocity, target_rms=target)
    finally:
        pw._calibration_active = False
    after = measure_all(cc, pitches, a.velocity)
    masses = {p: float(pw.sm.pitches[p].physics.hammer_mass) for p in pitches}
    layer_b = {k: getattr(pw.mp, k, None) for k in ("output_scale", "output_scale_calibrated",
                                                     "output_scale_reference_impulse", "output_scale_load_settings",
                                                     "output_scale_target_dbfs")}
    r = {"preset": a.preset, "velocity": a.velocity, "target_rms": target,
         "spread_before": spread(before), "spread_after": spread(after),
         "rms_before_db": {p: 20 * math.log10(v) for p, v in before.items()},
         "rms_after_db": {p: 20 * math.log10(v) for p, v in after.items()},
         "hammer_mass_g": {p: 1000 * m for p, m in masses.items()},
         "mass_rescale": res.get("mass_rescale"), "clipping_adjusted": res.get("clipping_adjusted"),
         "layer_b_after": layer_b}
    with open(os.path.join(a.out_dir, "equalize.json"), "w") as f:
        json.dump(r, f, indent=1, default=float)
    if a.write:
        for p, m in masses.items():
            preset["pitches"][str(p)]["physics"]["hammer_mass"] = m
        preset["model_parameters"].update(layer_b)
        preset.setdefault("measured_modes_build", {})["equalization"] = {
            "tool": "CalibrationController.calibrate_synthesis (offline, dev-a709 harness)", "velocity": a.velocity,
            "metric": "synthesis RMS over all output channels, 30-300 ms", "target_rms": target,
            "spread_before_db": r["spread_before"]["max_minus_min_db"],
            "spread_after_db": r["spread_after"]["max_minus_min_db"], "mass_rescale": r["mass_rescale"]}
        with open(a.preset, "w") as f:
            json.dump(preset, f)
    print(json.dumps({k: r[k] for k in ("spread_before", "spread_after", "mass_rescale", "clipping_adjusted",
                                        "layer_b_after")}, indent=1, default=float))


if __name__ == "__main__":
    main()
