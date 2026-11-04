"""dev-bow3: tilt / wide-contact WAVs + numbers, short treble strings, hammer unchanged. SILENT (offline, audio off).

  --stage before : on the installed build BEFORE dev-bow3 -> hammer 91 / 99 buffers (.npy), bowed 91 / 99
                   (silent there: no contact point on the short main string), and the default bow WAVs as
                   the "before" (bow_<note>_before.wav)
  --stage after  : on the dev-bow3 build -> for every note and tilt: WAV bow_<note>_tilt<T>_width<N>.wav
                   (N = the contact points, round(ribbon x (1 - 0.7 tilt) x main length), min 3, max 16) and
                   the harshness metrics (centroid, roll-off, noise between partials, level); bowed 91 / 99
                   at f0; hammer 91 / 99 compared with the before buffers (correlation, max difference)
Usage: python dev-bow3-width-render.py --core <core> --stage before|after --out <dir> [--tilts 0,0.3,0.6,0.9]
"""
import argparse
import importlib.util
import json
import os
import sys

import numpy as np

SR = 48000
NOTES = {"C2": 36, "A2": 45, "C3": 48, "C4": 60}
MAIN_LEN = {"C2": 268, "A2": 190, "C3": 166, "C4": 58}   # main-string points (dev-bow2-dump-coeffs.py)
TILT = 3                                                  # BowParam field (BowController.h)


def load(here, name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(here, file))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def f0_of(x):
    st = x[int(1.0 * SR):int(2.8 * SR)]
    st = st - st.mean()
    n = 1 << int(np.ceil(np.log2(2 * len(st))))
    X = np.fft.rfft(st, n)
    ac = np.fft.irfft(X * np.conj(X))[:len(st)]
    lo, hi = int(SR / 4500), int(SR / 25)
    k = lo + int(np.argmax(ac[lo:hi]))
    return SR / k


def points(name, tilt, ribbon):
    return int(min(16, max(3, round(ribbon * (1 - 0.7 * tilt) * MAIN_LEN[name]))))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", required=True)
    ap.add_argument("--stage", choices=("before", "after"), required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tilts", default="0,0.3,0.6,0.9")
    args = ap.parse_args()
    here = os.path.dirname(os.path.abspath(__file__))
    w = load(here, "w", "dev-bow2-wavs.py")
    h = load(here, "h", "dev-bow2-harshness.py")
    mw = os.path.join(args.core, "pianoid_middleware")
    sys.path.insert(0, mw)
    os.chdir(mw)
    import pianoidCuda as pc
    from pianoid import initialize
    p = initialize(os.path.join(mw, "presets", "BaselinePreset1.json"), filterlen=48 * 128 * 3,
                   string_iteration=4, array_size=384, sample_rate=SR, samples_in_cycle=64,
                   buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0)
    eng = p.pianoid
    new = hasattr(eng, "setBowParams")
    ribbon = float(eng.getBowStatus()[1]) if new else 0.0
    rows = []
    try:
        for P in (91, 99):                                   # short treble strings
            hm = w.render(p, pc, P, 80)
            npy = os.path.join(args.out, f"dev-bow3-hammer{P}-{args.stage}.npy")
            if args.stage == "before":
                np.save(npy, hm)
                rows.append({"case": f"hammer {P}", "rms": float(np.sqrt(np.mean(hm ** 2)))})
            else:
                ref = np.load(npy.replace("-after", "-before"))
                n = min(len(ref), len(hm))
                rows.append({"case": f"hammer {P} vs before", "corr": float(np.corrcoef(ref[:n], hm[:n])[0, 1]),
                             "max_diff_rel": float(np.abs(ref[:n] - hm[:n]).max() / np.abs(ref).max())})
            p.set_pitch_excitation_mode(P, 1)
            x = w.render(p, pc, P, 90)
            p.set_pitch_excitation_mode(P, 0)
            rms = float(np.sqrt(np.mean(x[int(1.0 * SR):int(2.8 * SR)] ** 2)))
            nominal = 440.0 * 2 ** ((P - 69) / 12)
            rows.append({"case": f"bow {P}", "steady_rms": rms,
                         "f0": round(f0_of(x), 1) if rms > 0 else None, "nominal": round(nominal, 1),
                         "nan": int(np.isnan(x).sum())})
        tilts = [None] if args.stage == "before" or not new else [float(v) for v in args.tilts.split(",")]
        for name, P in NOTES.items():
            f0 = 440.0 * 2 ** ((P - 69) / 12) * 2 ** (-16 / 1200)
            hm = w.render(p, pc, P, 80)
            ref = float(np.sqrt(np.mean(hm[int(0.02 * SR):int(0.22 * SR)] ** 2)))
            default_tilt = float(eng.getBowParams(P)[TILT]) if new else None
            for t in tilts:
                if t is not None:
                    eng.setBowParams([P], TILT, [t])
                p.set_pitch_excitation_mode(P, 1)
                x = w.render(p, pc, P, 90)
                p.set_pitch_excitation_mode(P, 0)
                tag = "before" if t is None else f"tilt{t:g}_width{points(name, t, ribbon)}"
                w.write24(os.path.join(args.out, f"bow_{name}_{tag}.wav"), x, w.norm_gain(x))
                rows.append({"case": f"{name} {tag}", **h.metrics(x, f0, ref)})
            if default_tilt is not None:
                eng.setBowParams([P], TILT, [default_tilt])
    finally:
        eng.shutdownGpu()
    for r in rows:
        print(json.dumps(r), flush=True)
    with open(os.path.join(args.out, f"dev-bow3-width-{args.stage}.json"), "w") as f:
        json.dump(rows, f, indent=1)


if __name__ == "__main__":
    main()
