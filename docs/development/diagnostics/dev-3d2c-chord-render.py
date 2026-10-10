"""dev-3d2c — render ONLY the C2-C6 chord (dev-5bf7-t3-harness CHORD, velocity 100, note-on 0.2 s, note-off 2.6 s)
from silence in a fresh process, through the full decay; save the raw per-cycle output + the final mode state.

Usage (PYTHONPATH = scratch bin + Basic, run from pianoid_middleware):
    python dev-3d2c-chord-render.py <preset.json> <kw: Belarus|F15> <label> <out_dir> [--seconds 6]
    -> <out_dir>/<label>_<preset stem>_chord.npy (+ _modes.npy); prints RESULT {finite, absmax, ...}
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
H = __import__("dev-5bf7-t3-harness")


def main():
    preset, kw, label, out_dir = sys.argv[1:5]
    secs = float(sys.argv[sys.argv.index("--seconds") + 1]) if "--seconds" in sys.argv else 6.0
    os.makedirs(out_dir, exist_ok=True)
    stem = f"{label}_{os.path.splitext(os.path.basename(preset))[0]}"
    sys.path.insert(0, os.getcwd())
    from pianoid import initialize
    pw = initialize(preset, filterlen=48 * 128 * 3, buffer_size=4, audio_on=False, audio_driver_type=0,
                    use_debug_build=False, **H.KW[kw])
    p = pw.pianoid
    import pianoidCuda as pc
    p.resetStringsState()
    p.resetModeRunningState()
    H.run_offline(p, pc, 0.1, record=False)
    t0 = 0.2
    evs = [H.ev(pc, x, t0 * H.CPS) for x in H.CHORD] + [H.ev(pc, x, (t0 + 2.4) * H.CPS, on=False) for x in H.CHORD]
    H.run_offline(p, pc, secs, record=True, events=evs)
    a = np.asarray(p.getRecordedAudio(), dtype=np.float64)
    np.save(os.path.join(out_dir, f"{stem}_chord.npy"), a)
    md = np.asarray(p.getModeDisplacements(), dtype=np.float64)
    np.save(os.path.join(out_dir, f"{stem}_modes.npy"), md)
    d = pw.mp.pack_as_dict_for_cuda()
    print("RESULT " + json.dumps({"label": label, "preset": preset, "pyd": pc.__file__, "n": int(a.size),
          "finite": bool(np.isfinite(a).all()), "absmax": float(np.nanmax(np.abs(a))), "num_modes": d["num_modes"],
          "flat_tier": [d.get("flat_tier_num_shaped"), d.get("flat_tier_num_flat")],
          "modes_finite": bool(np.isfinite(md).all())}))
    try:
        p.shutdownGpu()
    except Exception:
        pass


if __name__ == "__main__":
    main()
