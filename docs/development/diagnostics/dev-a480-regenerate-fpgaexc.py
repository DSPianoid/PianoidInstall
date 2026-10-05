"""dev-a480 -- regenerate the excitation of the two presets built with the old SWAPPED FPGA decode.

User decision M5 (2026-10-01): "Regenerate and replace". Only the FPGA-derived field (each piano pitch's
`excitation`) is rebuilt with the converter's corrected decode (mu <- centre d, sigma <- width e, host
send-all formulas, 96-clock exciter, Gaussians 0-3, 6 engine anchors) from the SAME source dump; every
other field is copied unchanged. The original is backed up next to it as <name>.pre-a480-swapped.json.
dev-da62 (2026-10-05): mu/sigma are written in the preset's curve x-units (ms / x_unit_ms, x_unit_ms =
1000*mode_iteration/sr); before, the ms were written 1:1 and the pulses played x1.333 long at 64/48 kHz.

    PYTHONPATH=<PianoidBasic build with fpga_*> PianoidCore/.venv/Scripts/python \
        docs/development/diagnostics/dev-a480-regenerate-fpgaexc.py PRESET.json FPGA_DIR [--source-note TEXT]
"""
import argparse
import base64
import json
import os
import shutil

import numpy as np

from Pianoid.fpga_preset_converter import ConverterOptions, build_excitation
from Pianoid.fpga_tables import load_fpga_tables
from Pianoid.StringExcitation import curve_x_unit_ms


def enc(a):
    a = np.ascontiguousarray(a, dtype=np.float64)
    return {"data": base64.b64encode(a.tobytes()).decode("ascii"), "shape": list(a.shape), "type": "float64"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("preset")
    ap.add_argument("fpga_dir")
    ap.add_argument("--source-note", default="")
    ap.add_argument("--by", default="dev-a480")
    ap.add_argument("--date", default="2026-10-01")
    ap.add_argument("--reason", default="the previous excitation came from the old FPGA loader, which put the "
                    "Gaussian WIDTH into mu and the CENTRE into sigma (swapped); rebuilt with the corrected decode")
    a = ap.parse_args()
    backup = os.path.splitext(a.preset)[0] + ".pre-a480-swapped.json"
    if not os.path.exists(backup):
        shutil.copy2(a.preset, backup)
    with open(backup) as f:
        preset = json.load(f)
    opts = ConverterOptions()
    mp = preset["model_parameters"]
    x_unit_ms = curve_x_unit_ms(int(mp["mode_iteration"]), float(mp.get("sr", 48000)))
    mats = build_excitation(load_fpga_tables(a.fpga_dir), opts, x_unit_ms)[0]
    wired = []
    for pid, pv in preset["pitches"].items():
        p = int(pid)
        if p in mats:
            pv["excitation"] = enc(mats[p])
            wired.append(p)
    preset["excitation_provenance"] = {
        "regenerated_by": a.by, "date": a.date, "reason": a.reason,
        "x_unit_ms": x_unit_ms, "time_axis": "mu/sigma in curve x-units = ms / x_unit_ms (exact at this "
                                             "preset's mode_iteration/sr)",
        "converter": "Pianoid.fpga_preset_converter.build_excitation",
        "source_fpga_dir": os.path.abspath(a.fpga_dir), "source_note": a.source_note,
        "options": {"exc_clocks": opts.exc_clocks, "clock_hz": opts.clock_hz, "volume_sign": opts.volume_sign},
        "pitches_regenerated": sorted(wired),
        "only_field_changed": "pitches[*].excitation (all other fields as in the backup)",
        "backup": os.path.basename(backup),
    }
    with open(a.preset, "w") as f:
        json.dump(preset, f)
    print(f"regenerated {len(wired)} pitches; backup {backup}")


if __name__ == "__main__":
    main()
