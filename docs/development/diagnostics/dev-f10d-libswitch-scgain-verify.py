"""dev-f10d #1 verification — library-switch string_coefficients restore.

Reproduces, WITHOUT GPU/ASIO (zero risk to the live stack), the exact
sound-channel restore sequence that pianoid.load_preset_to_library performs
on the domain model (StringMap), and measures the data-model signature of the
bug + fix:

  - add_pitch defaults string_coefficients[pitch] to np.zeros(nc)   (the bug baseline)
  - the fix mirrors the main load path: read_from_preset + (NEW)
    read_string_coefficients_from_preset  -> string_coefficients == preset values
  - downstream: StringMap.pack_pitch_feedin(outputPitch) for an outerSound pitch
    scales effective_deck('feedback') by sc_gain = string_coefficients[p][ch];
    zero sc_gain -> silent output. We show it goes zero -> non-zero.

Run from PianoidCore venv:
  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-f10d-libswitch-scgain-verify.py
"""
import json
import os
import sys

import numpy as np

PRESET = os.path.join(
    os.path.dirname(__file__), "..", "..", "..",
    "PianoidCore", "pianoid_middleware", "presets", "BaselinePreset1.json",
)

from Pianoid import StringMap, ModelParameters
from Pianoid.Mode import ModeMap


def build_sm(preset_dict):
    """Mirror pianoid.load_preset_to_library lines 3170-3196 (model build)."""
    mp = ModelParameters()
    if "model_parameters" in preset_dict:
        mp.update_params(**preset_dict["model_parameters"])
    # mode_channel_index/num_channels/listen_to_modes are matched from the running
    # instance in the real path; the preset's own values are equivalent for the
    # string_coefficients restore under test.
    sm = StringMap(model_params=mp, **preset_dict)
    modes = ModeMap(mp, preset_dict["modes"], num_modes="define",
                    num_modes_for_model=mp.num_strings)
    return mp, sm, modes


def outer_pitches(sm):
    return [p for p, pitch in sm.pitches.items() if getattr(pitch, "outerSound", False)]


def main():
    with open(PRESET) as f:
        preset_dict = json.load(f)

    assert "string_sound_channels" in preset_dict, "test preset must carry string_sound_channels"

    mp, sm, modes = build_sm(preset_dict)
    scm = sm.soundChannelModes
    outs = outer_pitches(sm)
    print(f"outerSound (output/sound-channel) pitches: {outs[:8]}{' ...' if len(outs) > 8 else ''} (n={len(outs)})")
    assert outs, "no outerSound pitches — cannot exercise sc_gain path"
    probe = outs[0]

    # --- BASELINE (the bug): add_pitch left string_coefficients at zeros ---
    before = np.array(scm.string_coefficients[probe]).copy()
    before_feedin = np.array(sm.pack_pitch_feedin(probe)).copy()
    print(f"\n[BEFORE restore] pitch {probe} string_coefficients = {before}")
    print(f"[BEFORE restore] pitch {probe} pack_pitch_feedin nonzero-count = "
          f"{int(np.count_nonzero(before_feedin))} max|feedin| = {np.max(np.abs(before_feedin)):.6g}")

    # --- THE FIX (exact sequence load_preset_to_library now runs) ---
    sc_data = {k: v for k, v in preset_dict["mode_sound_channels"].items() if k != "num_channels"}
    scm.read_from_preset(sc_data)
    ssc_data = {k: v for k, v in preset_dict["string_sound_channels"].items()}
    scm.read_string_coefficients_from_preset(ssc_data)   # <-- the added call

    after = np.array(scm.string_coefficients[probe]).copy()
    after_feedin = np.array(sm.pack_pitch_feedin(probe)).copy()
    expected = np.array(preset_dict["string_sound_channels"][str(probe)])
    print(f"\n[AFTER restore]  pitch {probe} string_coefficients = {after}")
    print(f"[AFTER restore]  preset string_sound_channels[{probe}] = {expected}")
    print(f"[AFTER restore]  pitch {probe} pack_pitch_feedin nonzero-count = "
          f"{int(np.count_nonzero(after_feedin))} max|feedin| = {np.max(np.abs(after_feedin)):.6g}")

    # Assertions
    n_probe_zero = 0
    n_probe_restored = 0
    for p in outs:
        b = np.array(scm.string_coefficients[p])  # already restored now; recompute baseline check below
    ok_before_zero = np.allclose(before, 0.0)
    ok_after_matches = np.allclose(after, expected)
    ok_after_nonzero = np.max(np.abs(after)) > 0.0
    ok_feedin_silenced = np.max(np.abs(before_feedin)) == 0.0 or np.count_nonzero(before_feedin) < np.count_nonzero(after_feedin)
    ok_feedin_restored = np.max(np.abs(after_feedin)) > 0.0

    print("\n=== VERDICT ===")
    print(f"  BEFORE string_coefficients all-zero (bug baseline)        : {ok_before_zero}")
    print(f"  AFTER  string_coefficients == preset values              : {ok_after_matches}")
    print(f"  AFTER  string_coefficients non-zero (sound not silenced)  : {ok_after_nonzero}")
    print(f"  AFTER  pack_pitch_feedin non-zero (output not silent)     : {ok_feedin_restored}")
    passed = ok_before_zero and ok_after_matches and ok_after_nonzero and ok_feedin_restored
    print(f"\nRESULT: {'PASS' if passed else 'FAIL'}")
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
