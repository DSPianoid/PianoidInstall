"""dev-bow3: short treble strings bowed (87, 91, 99, 103) — do they sound the string's own partials?
SILENT (offline, audio off). For each pitch: the strongest spectral peaks of a hammer note and of the bowed
note (default bow, and tilt 0.9 / position 2), the harmonic match of the bowed peaks against the hammer's,
the steady level, and the WAVs bow_<pitch>_<case>.wav.
Usage: python dev-bow3-treble-check.py --core <core> --out <dir> [--pitches 87,91,99,103]
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


def peaks(x, a, b, n=5):
    s = x[int(a * SR):int(b * SR)]
    s = s - s.mean()
    X = np.abs(np.fft.rfft(s * np.hanning(len(s)), 1 << 18))
    f = np.fft.rfftfreq(1 << 18, 1 / SR)
    X[(f < 80) | (f > 12000)] = 0
    out = []
    for _ in range(n):
        i = int(np.argmax(X))
        if X[i] <= 0:
            break
        out.append((round(float(f[i]), 1), round(float(20 * np.log10(X[i] + 1e-30)), 1)))
        X[max(0, i - 60):i + 60] = 0          # +-11 Hz
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--pitches", default="87,91,99,103")
    args = ap.parse_args()
    here = os.path.dirname(os.path.abspath(__file__))
    w = load(here, "w", "dev-bow2-wavs.py")
    mw = os.path.join(args.core, "pianoid_middleware")
    sys.path.insert(0, mw)
    os.chdir(mw)
    import pianoidCuda as pc
    from pianoid import initialize
    p = initialize(os.path.join(mw, "presets", "BaselinePreset1.json"), filterlen=48 * 128 * 3,
                   string_iteration=4, array_size=384, sample_rate=SR, samples_in_cycle=64,
                   buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0)
    eng = p.pianoid
    try:
        for P in [int(v) for v in args.pitches.split(",")]:
            hm = w.render(p, pc, P, 80)
            hp = peaks(hm, 0.01, 0.4)
            base = eng.getBowParams(P)
            row = {"pitch": P, "nominal": round(440 * 2 ** ((P - 69) / 12), 1), "hammer_peaks": hp}
            ribbon = float(eng.getBowStatus()[1])
            for case, field, value in (("default", None, None), ("tilt0.9", 3, 0.9), ("position2", 2, 2.0),
                                       ("point", "ribbon", 0.0), ("force0.25", 1, 0.25), ("force0.15", 1, 0.15)):
                if field == "ribbon":                 # a one-point contact (ribbon 0), for comparison
                    eng.setBowMaxWidth(value)
                elif field is not None:
                    eng.setBowParams([P], field, [value])
                p.set_pitch_excitation_mode(P, 1)
                x = w.render(p, pc, P, 90)
                p.set_pitch_excitation_mode(P, 0)
                if field == "ribbon":
                    eng.setBowMaxWidth(ribbon)
                elif field is not None:
                    eng.setBowParams([P], field, [base[field]])
                bp = peaks(x, 1.0, 2.8)
                hf = [f for f, _ in hp]
                match = [min(abs(f - g) for g in hf) for f, _ in bp]
                row[case] = {"peaks": bp, "off_hammer_partials_hz": [round(m, 1) for m in match],
                             "steady_rms": float(np.sqrt(np.mean(x[int(1.0 * SR):int(2.8 * SR)] ** 2)))}
                w.write24(os.path.join(args.out, f"bow_{P}_{case}.wav"), x, w.norm_gain(x))
            print(json.dumps(row), flush=True)
    finally:
        eng.shutdownGpu()


if __name__ == "__main__":
    main()
