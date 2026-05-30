"""dev-7032 — verify the CFL ratio chart's Courant data VARIES per pitch on a REAL preset (pure-Python, no GPU).

The user reported the original max|g| chart was a flat 1.0 line. The fix plots the per-pitch worst-string
COURANT number instead. This script proves, against a REAL preset's physics (loaded host-side via the same
PianoidBasic StringMap path the engine uses — NO GPU, NO engine, NO Flask), that:
  - param_manager._pitch_upload_amp(pid) returns a per-pitch Courant that VARIES across the keyboard, and
  - the chart function cfl_ratio_function produces a varying (non-flat) data array.

Run: PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-7032-cfl-courant-varies.py
(uses a BASELINE preset, never the user's Belarus files.)
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MW = os.path.join(HERE, "..", "..", "..", "PianoidCore", "pianoid_middleware")
MW = os.path.abspath(MW)
sys.path.insert(0, MW)

from Pianoid import StringMap, ModelParameters          # noqa: E402  (pure-Python domain model)
from Pianoid.Mode import ModeMap                          # noqa: E402
from parameter_manager import ParameterManager            # noqa: E402
import cfl_stability as cfl                                # noqa: E402

PRESET = os.path.join(MW, "presets", "BaselinePreset1.json")


def build_sm():
    with open(PRESET) as f:
        preset = json.load(f)
    mp = ModelParameters()
    if "model_parameters" in preset:
        mp.update_params(**preset["model_parameters"])
    sm = StringMap(model_params=mp, **preset)
    try:
        modes = ModeMap(mp, preset["modes"], num_modes="define", num_modes_for_model=mp.num_strings)
    except Exception:
        modes = None
    return sm, modes, mp


def main():
    sm, modes, mp = build_sm()
    # _pitch_upload_amp only touches self.sm + self.mp -> the GPU + lock args are unused for this read.
    pman = ParameterManager(None, sm, modes, mp, None)

    key_pitches = sorted(p for p in sm.all_pitches(keyPitches=True) if p < 128)
    print(f"preset: {os.path.basename(PRESET)}   key pitches: {len(key_pitches)} "
          f"({key_pitches[0]}..{key_pitches[-1]})")
    print(f"CFL_LIMIT={cfl.CFL_LIMIT}  CFL_MARGIN={cfl.CFL_MARGIN}")

    courants = []
    sample = []
    for p in key_pitches:
        amp, wstr, courant = pman._pitch_upload_amp(int(p))
        courants.append(courant)
        sample.append((p, courant, amp))

    finite = [c for c in courants if c == c and abs(c) != float("inf")]
    distinct = len(set(round(c, 8) for c in finite))
    cmin, cmax = (min(finite), max(finite)) if finite else (None, None)

    # print a sparse sample across the keyboard
    idxs = [0, len(sample) // 4, len(sample) // 2, (3 * len(sample)) // 4, len(sample) - 1]
    print("\n  pitch    Courant       max|g|")
    for i in idxs:
        p, c, a = sample[i]
        print(f"  {p:5d}  {c:11.6f}  {a:11.6f}")

    print(f"\nCourant range: [{cmin:.6f}, {cmax:.6f}]   distinct values: {distinct} of {len(finite)}")
    spread = (cmax - cmin) if (cmin is not None) else 0.0
    print(f"Courant spread (max-min): {spread:.6f}")
    varies = distinct > 1 and spread > 1e-6
    print(f"\n==> Courant VARIES per pitch (not flat): {varies}")

    # Now exercise the actual chart function end-to-end (it reads param_manager._pitch_upload_amp).
    from chartFunctions import cfl_ratio_function

    class _Wrap:
        def __init__(self, sm, mp, pman):
            self.sm = sm
            self.mp = mp
            self.param_manager = pman

        def get_all_pitches_in_preset(self, key_pitches=False, sound_pitches=False, **k):
            if sound_pitches:
                return [p for p in self.sm.all_pitches() if p >= 128]
            return [p for p in self.sm.all_pitches(keyPitches=True) if p < 128]

    wrap = _Wrap(sm, mp, pman)
    charts, header, tf, extra = cfl_ratio_function(wrap, key_range="all")
    _, datas, _ = charts.get_data()
    arr = datas[0]
    arr_finite = [v for v in arr if v == v]
    arr_distinct = len(set(round(v, 8) for v in arr_finite))
    print(f"\nchart fn '{header}':")
    print(f"  data len={len(arr)}  distinct={arr_distinct}  "
          f"range=[{min(arr_finite):.6f}, {max(arr_finite):.6f}]")
    print(f"  text_fields['Plotted quantity'] = {tf.get('Plotted quantity')}")
    print(f"  rejected pitches (gate) = {tf.get('Rejected pitches (gate)')}")
    print(f"\n==> chart data array VARIES (not flat 1.0): "
          f"{arr_distinct > 1 and not all(abs(v - 1.0) < 1e-9 for v in arr_finite)}")


if __name__ == "__main__":
    main()
