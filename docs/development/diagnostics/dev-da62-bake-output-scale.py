"""dev-da62 (2026-10-04) -- OFFLINE one-time output_scale bake for a level-changed preset (own process).

A re-timed preset is written with output_scale_calibrated = false (its per-pitch level changed). Loading it
in the LIVE backend would re-derive output_scale with an offline render inside the live engine, which is
forbidden (0xC0000006, memory project_no_offline_render_in_live_backend). This script does that load in a
separate offline process instead and writes the derived output_scale + output_scale_calibrated = true back
into the preset, so a live load never renders.

    PianoidCore/.venv/Scripts/python dev-da62-bake-output-scale.py MIDDLEWARE_DIR PRESET.json ARRAY SI
"""
import json
import os
import sys

SR, SPC = 48000, 64


def main():
    mw, preset, array_size, si = sys.argv[1:5]
    preset = os.path.abspath(preset)
    d = json.load(open(preset))
    assert d["model_parameters"].get("output_scale_calibrated") is False, "nothing to bake"
    sys.path.insert(0, os.path.abspath(mw))
    os.chdir(os.path.abspath(mw))
    from pianoid import initialize
    p = initialize(preset, filterlen=48 * 128 * 3, string_iteration=int(si), array_size=int(array_size),
                   sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, audio_on=False, audio_driver_type=0,
                   listen_to_modes=True, sound_derivative_order=1, use_debug_build=False)
    assert p.mp.output_scale_calibrated, "load did not calibrate output_scale"
    old = d["model_parameters"].get("output_scale")
    d["model_parameters"]["output_scale"] = float(p.mp.output_scale)
    d["model_parameters"]["output_scale_calibrated"] = True
    with open(preset, "w") as f:
        json.dump(d, f)
    print(f"BAKED output_scale {old} -> {float(p.mp.output_scale)} into {preset}")


if __name__ == "__main__":
    main()
