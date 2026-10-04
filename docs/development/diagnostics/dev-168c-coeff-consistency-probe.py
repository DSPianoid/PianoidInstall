"""dev-168c: is the live excitation-coefficient table consistent with the model after load?

Own process, offline. Loads PRESET, measures a few pitches (SynthesisTuner metric, v95), forces the
full coefficient rebuild (what a reload does), measures again, and reports the coefficient-table
difference between the live cache and a fresh build.

    python dev-168c-coeff-consistency-probe.py MIDDLEWARE_DIR PRESET ARRAY SI DERIV LTM
"""
import math
import os
import sys

import numpy as np


def main():
    mw, preset, a, si, d, ltm = sys.argv[1:7]
    preset = os.path.abspath(preset)
    sys.path.insert(0, os.path.abspath(mw)); os.chdir(os.path.abspath(mw))
    from pianoid import initialize
    from calibration_controller import CalibrationController
    from excitation_coefficients import build_excitation_coefficients_flat
    p = initialize(preset, filterlen=48 * 128 * 3, string_iteration=int(si), array_size=int(a), sample_rate=48000,
                   samples_in_cycle=64, buffer_size=4, audio_on=False, audio_driver_type=0,
                   listen_to_modes=bool(int(ltm)), sound_derivative_order=int(d), use_debug_build=False)
    cc = CalibrationController(p)
    keys = sorted(p.sm.keyPitches)
    probe = [int(x) for x in os.environ.get("PROBE_PITCHES", "").split(",") if x] or [keys[1], keys[len(keys) // 2], keys[-8], keys[-3]]
    live = np.asarray(p.param_manager._coeff_cache.flat or [], dtype=np.float64)
    fresh = np.asarray(build_excitation_coefficients_flat(p.sm), dtype=np.float64)
    if live.size == fresh.size and live.size:
        nz = fresh != 0
        print("RESULT coeff live/fresh ratio range:", float((live[nz] / fresh[nz]).min()), float((live[nz] / fresh[nz]).max()))
    else:
        print("RESULT live cache size", live.size, "fresh", fresh.size)
    m0 = {k: 20 * math.log10(cc._synthesis_only_measure(k, 95)['rms']) for k in probe}
    with p.cuda_lock:
        p._upload_excitation_coefficients()
        p.pianoid.waitForParameterUpdate()
    m1 = {k: 20 * math.log10(cc._synthesis_only_measure(k, 95)['rms']) for k in probe}
    print("RESULT levels dB:", {k: round(m0[k], 3) for k in probe})
    print("RESULT rebuild delta dB:", {k: round(m1[k] - m0[k], 3) for k in probe})
    print("RESULT output_scale_calibrated:", p.mp.output_scale_calibrated)


if __name__ == "__main__":
    main()
