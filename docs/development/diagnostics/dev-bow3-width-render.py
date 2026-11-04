"""dev-bow3: width WAVs + numbers, short treble strings, hammer unchanged. SILENT (offline, audio off).

  --stage before : on the installed build BEFORE dev-bow3 -> hammer 91 / 99 buffers (.npy), bowed 91 / 99
                   (expected silent there: no contact point), and width-1 WAVs as the "before"
  --stage after  : on the dev-bow3 build -> WAVs bow_<note>_width<N>.wav for N in --widths, harshness
                   metrics (centroid, roll-off, noise between partials, level), bowed 91 / 99 at f0,
                   hammer 91 / 99 compared with the before buffers (correlation, max difference)
Usage: python dev-bow3-width-render.py --core <core> --stage before|after --out <dir> [--widths 1,2,3]
"""
import argparse
import importlib.util
import json
import os
import sys

import numpy as np

SR = 48000
NOTES = {"C2": 36, "A2": 45, "C3": 48, "C4": 60}


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", required=True)
    ap.add_argument("--stage", choices=("before", "after"), required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--widths", default="1,2,3")
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
    has_width = hasattr(eng, "setBowWidth")
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
        widths = [1] if args.stage == "before" else [int(v) for v in args.widths.split(",")]
        for name, P in NOTES.items():
            f0 = 440.0 * 2 ** ((P - 69) / 12) * 2 ** (-16 / 1200)
            hm = w.render(p, pc, P, 80)
            ref = float(np.sqrt(np.mean(hm[int(0.02 * SR):int(0.22 * SR)] ** 2)))
            for W in widths:
                if has_width:
                    eng.setBowWidth(W)
                p.set_pitch_excitation_mode(P, 1)
                x = w.render(p, pc, P, 90)
                p.set_pitch_excitation_mode(P, 0)
                tag = "before" if args.stage == "before" else f"width{W}"
                w.write24(os.path.join(args.out, f"bow_{name}_{tag}.wav"), x, w.norm_gain(x))
                rows.append({"case": f"{name} {tag}", **h.metrics(x, f0, ref)})
        if has_width:
            eng.setBowWidth(2)
    finally:
        eng.shutdownGpu()
    for r in rows:
        print(json.dumps(r), flush=True)
    with open(os.path.join(args.out, f"dev-bow3-width-{args.stage}.json"), "w") as f:
        json.dump(rows, f, indent=1)


if __name__ == "__main__":
    main()
