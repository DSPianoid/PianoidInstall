"""dev-bowpanel (bug 44484e3a "G6 switched to bow is silent"): do the short treble strings sound when bowed with
the CURRENT defaults (dev-bowsoft ribbon 0.105 + edge taper 3, force x0.5 from 88)? SILENT (offline, audio off).
For each pitch: hammer level + peaks, then the bowed note with the defaults the preset load pushed, with the
dev-bow3 contact (ribbon 0.035, taper 1), with a one-point contact, and with force 0.5. Prints one JSON row per
pitch (steady RMS in dB re the hammer's attack RMS, peaks, contact points); WAVs bow_<pitch>_<case>.wav.
Usage: python dev-bowpanel-treble-check.py --core <core> --out <dir> [--pitches 84,87,89,91,93,96,99,103]
"""
import argparse
import importlib.util
import json
import os
import sys

import numpy as np

SR = 48000


def load(here, name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(here, file))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def db(x):
    return round(float(20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-30)), 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--pitches", default="84,87,89,91,93,96,99,103")
    ap.add_argument("--vel", type=int, default=90)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    here = os.path.dirname(os.path.abspath(__file__))
    w = load(here, "w", "dev-bow2-wavs.py")
    tc = load(here, "tc", "dev-bow3-treble-check.py")
    mw = os.path.join(args.core, "pianoid_middleware")
    sys.path.insert(0, mw)
    os.chdir(mw)
    import pianoidCuda as pc
    from pianoid import initialize
    import bow_config
    p = initialize(os.path.join(mw, "presets", "BaselinePreset1.json"), filterlen=48 * 128 * 3,
                   string_iteration=4, array_size=384, sample_rate=SR, samples_in_cycle=64,
                   buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0)
    eng = p.pianoid
    bow_config.push(p)                 # the preset's bow values (defaults) + ribbon + taper, as on a load
    width, taper = bow_config.max_width(p.mp), bow_config.edge_taper(p.mp)
    print(json.dumps({"ribbon": width, "edge_taper": taper, "status": list(eng.getBowStatus())}), flush=True)
    try:
        for P in [int(v) for v in args.pitches.split(",")]:
            hm = w.render(p, pc, P, args.vel)
            ref = db(hm[int(0.01 * SR):int(0.2 * SR)])
            base = eng.getBowParams(P)
            row = {"pitch": P, "nominal": round(440 * 2 ** ((P - 69) / 12), 1), "hammer_db": ref,
                   "hammer_peaks": tc.peaks(hm, 0.01, 0.4, 3), "bow_params": [round(float(v), 3) for v in base]}
            for case, setup, undo in (
                    ("default", None, None),
                    ("bow3_contact", lambda: (eng.setBowMaxWidth(0.035), eng.setBowEdgeTaper(1.0)),
                     lambda: (eng.setBowMaxWidth(width), eng.setBowEdgeTaper(taper))),
                    ("point", lambda: eng.setBowMaxWidth(0.0), lambda: eng.setBowMaxWidth(width)),
                    ("force0.5", lambda: eng.setBowParams([P], 1, [0.5]), lambda: eng.setBowParams([P], 1, [base[1]]))):
                if setup:
                    setup()
                p.set_pitch_excitation_mode(P, 1)
                x = w.render(p, pc, P, args.vel)
                p.set_pitch_excitation_mode(P, 0)
                if undo:
                    undo()
                steady = x[int(1.0 * SR):int(2.8 * SR)]
                row[case] = {"steady_db_re_hammer": round(db(steady) - ref, 1), "peaks": tc.peaks(x, 1.0, 2.8, 3)}
                w.write24(os.path.join(args.out, f"bow_{P}_{case}.wav"), x, w.norm_gain(x))
            print(json.dumps(row), flush=True)
    finally:
        eng.shutdownGpu()


if __name__ == "__main__":
    main()
