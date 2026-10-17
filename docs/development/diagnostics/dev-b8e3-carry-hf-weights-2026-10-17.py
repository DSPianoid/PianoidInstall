"""dev-b8e3 2026-10-17 -- carry the output-row weights of the unchanged modes over from a reference preset.

    PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-b8e3-carry-hf-weights-2026-10-17.py \
        PRESET.json REFERENCE.json

Pianoid.measured_mode_preset draws the random channel signs of the modes above the boundary as one (n_ch, n_hi)
array, so a mode set with one mode fewer above the boundary re-draws every sign. For an A/B against REFERENCE
(user, 2026-10-17: "everything else stays the same"), every mode of PRESET at or above n_measured whose
(frequency, decrement, mass) is identical to a REFERENCE mode (k-th duplicate -> k-th) takes that mode's weight in every output row
(output pitches 128..). Run it on the freshly built preset, BEFORE the equalization. Records the carried mode
IDs in measured_modes_build.hf_weights_carried.
"""
import json
import sys

import numpy as np

from Pianoid.bytestream_encoding import decode_from_json, encode_for_json

OUTPUT_PITCH0 = 128


def main(preset_path, reference_path):
    p, ref = json.load(open(preset_path)), json.load(open(reference_path))
    key = lambda m: (m["frequency"], m["decrement"], m["mass"])
    ref_idx = {}                                # identical modes exist (FPGA frequency grid): k-th match -> k-th
    for i, m in enumerate(ref["modes"]):
        ref_idx.setdefault(key(m), []).append(i)
    n_meas = p["measured_modes_build"]["n_measured"]
    pairs = [(i, ref_idx[key(m)].pop(0)) for i, m in enumerate(p["modes"]) if i >= n_meas and ref_idx.get(key(m))]
    out_keys = sorted((k for k in p["pitches"] if int(k) >= OUTPUT_PITCH0), key=int)
    if out_keys != sorted((k for k in ref["pitches"] if int(k) >= OUTPUT_PITCH0), key=int):
        raise ValueError("PRESET and REFERENCE have different output pitches")
    new, old = [i for i, _ in pairs], [j for _, j in pairs]
    for k in out_keys:
        deck = np.array(decode_from_json(p["pitches"][k]["deck"]))
        deck[1, new] = decode_from_json(ref["pitches"][k]["deck"])[1, old]
        p["pitches"][k]["deck"] = encode_for_json(np.ascontiguousarray(deck, dtype=np.float64))
    p["measured_modes_build"]["hf_weights_carried"] = {
        "from": reference_path, "n": len(pairs), "mode_ids": new,
        "rule": "identical (frequency, decrement, mass) -> the reference's output-row weight, every channel"}
    json.dump(p, open(preset_path, "w"))
    print(f"carried {len(pairs)} of {len(p['modes']) - n_meas} modes above the boundary "
          f"(not carried: {sorted(set(range(n_meas, len(p['modes']))) - set(new))})")


if __name__ == "__main__":
    main(*sys.argv[1:3])
