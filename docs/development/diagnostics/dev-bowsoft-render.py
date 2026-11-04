"""dev-bowsoft: softer bow = a wider contact with steeper edges. SILENT (offline render, audio off).

Variants = (hair ribbon max_width, edge taper p of the contact weights (1 - x^2)^p); "bow3" = the dev-bow3
setting (0.035, parabola p = 1). Notes C2 / A2 / C3 / C4 at tilt 0.15 (as the bow3 listening set), keys 87 / 91
at their default parameters. For every note and variant: a 16-bit WAV bow_<note>_<variant>_w<N>.wav (N = contact
points; one gain per note, so the variants keep their relative level: -3 dBFS on the loudest) and the metrics:
spectral centroid, roll-off, noise between the partials (the noise floor, dB re the partials), the energy above
3 kHz (dB re the total), the level re a velocity-80 hammer note. Optional --ref-dir: the correlation of the
"bow3" render with the dev-bow3 WAV of the same note (bow_<note>_tilt0.15_width<N>.wav, bow_<key>_default.wav).

Usage: python dev-bowsoft-render.py --core <core> --pyd-dir <dir with pianoidCuda> --out <dir>
       [--variants '{"bow3": [0.035, 1], "soft1": [0.07, 1]}'] [--ref-dir <bow3 wav dir>[,<dir>...]]
"""
import argparse
import importlib.util
import json
import os
import sys
import wave

import numpy as np

SR = 48000
NOTES = {"C2": 36, "A2": 45, "C3": 48, "C4": 60}
KEYS = (87, 91)
MAIN_LEN = {"C2": 268, "A2": 190, "C3": 166, "C4": 58}   # main-string points (dev-bow2-dump-coeffs.py)
TILT_NOTES = 0.15
TILT = 3                                                  # BowParam field (BowController.h)
VARIANTS = {"bow3": (0.035, 1.0), "soft1": (0.07, 1.0), "soft2": (0.0875, 2.0), "soft3": (0.105, 3.0)}


def load(here, name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(here, file))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def points(main_len, tilt, ribbon):
    return int(min(32, max(3, round(ribbon * (1 - 0.7 * tilt) * main_len))))


def hf_db(x, cut=3000.0):
    st = x[int(1.5 * SR):int(2.8 * SR)]
    sp = np.abs(np.fft.rfft(st * np.hanning(len(st)))) ** 2
    f = np.fft.rfftfreq(len(st), 1 / SR)
    return round(float(10 * np.log10(sp[f > cut].sum() / sp[f > 20].sum())), 1)


def metrics(x, f0, ref_rms):
    """dev-bow2-harshness.py metrics, with the partials limited to those below 20 kHz (short treble strings)."""
    nh = int(max(2, min(24, 20000 // f0)))
    st = x[int(1.5 * SR):int(2.8 * SR)]
    n = len(st)
    sp = np.abs(np.fft.rfft(st * np.hanning(n), 4 * n)) ** 2
    f = np.fft.rfftfreq(4 * n, 1 / SR)
    cen = float((np.sqrt(sp) * f).sum() / np.sqrt(sp).sum())
    harm = []
    on = np.zeros_like(f, bool)
    for k in range(1, nh + 1):
        band = (f > f0 * (k - 0.15)) & (f < f0 * (k + 0.15))
        on |= band
        harm.append(sp[band].max())
    lv = 10 * np.log10(np.array(harm) / harm[0])
    slope = float(np.polyfit(np.log2(np.arange(1, nh + 1)), lv, 1)[0])
    region = f < f0 * (nh + 0.5)
    steady = np.sqrt(np.mean(st ** 2))
    return {"centroid_hz": round(cen), "rolloff_db_per_octave": round(slope, 1), "partials": nh,
            "between_partials_db": round(float(10 * np.log10(sp[region & ~on].sum() / sp[region & on].sum())), 1),
            "level_db_re_hammer": round(float(20 * np.log10(steady / ref_rms)), 1), "nan": int(np.isnan(x).sum())}


def write16(path, x, gain):
    y = np.clip(x * gain, -1, 1)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((y * 32767).astype("<i2").tobytes())


def read_wav(path):
    with wave.open(path, "rb") as w:
        n, sw = w.getnframes(), w.getsampwidth()
        b = np.frombuffer(w.readframes(n), np.uint8)
    if sw == 2:
        return b.view("<i2").astype(np.float64)
    b = b.reshape(-1, 3).astype(np.int32)
    v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
    return np.where(v >= 1 << 23, v - (1 << 24), v).astype(np.float64)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", required=True)
    ap.add_argument("--pyd-dir", default=None, help="directory holding the pianoidCuda build to test (first on sys.path)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--variants", default=None)
    ap.add_argument("--ref-dir", default=None)
    args = ap.parse_args()
    variants = {k: tuple(v) for k, v in json.loads(args.variants).items()} if args.variants else VARIANTS
    os.makedirs(args.out, exist_ok=True)
    here = os.path.dirname(os.path.abspath(__file__))
    w = load(here, "w", "dev-bow2-wavs.py")
    t = load(here, "t", "dev-bow3-width-render.py")
    mw = os.path.join(args.core, "pianoid_middleware")
    sys.path.insert(0, mw)
    if args.pyd_dir:
        sys.path.insert(0, args.pyd_dir)
    os.chdir(mw)
    import pianoidCuda as pc
    from pianoid import initialize
    print("pianoidCuda:", pc.__file__, flush=True)
    p = initialize(os.path.join(mw, "presets", "BaselinePreset1.json"), filterlen=48 * 128 * 3,
                   string_iteration=4, array_size=384, sample_rate=SR, samples_in_cycle=64,
                   buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0)
    eng = p.pianoid
    assert hasattr(eng, "setBowEdgeTaper"), "this pianoidCuda has no edge taper (not a dev-bowsoft build)"
    status0 = list(eng.getBowStatus())
    refs = args.ref_dir.split(",") if args.ref_dir else []
    rows = []
    try:
        cases = [(name, P, TILT_NOTES, MAIN_LEN[name]) for name, P in NOTES.items()] + [(str(P), P, None, None) for P in KEYS]
        for name, P, tilt, main_len in cases:
            hm = w.render(p, pc, P, 80)
            ref_rms = float(np.sqrt(np.mean(hm[int(0.02 * SR):int(0.22 * SR)] ** 2)))
            default_tilt = float(eng.getBowParams(P)[TILT])
            if tilt is not None:
                eng.setBowParams([P], TILT, [tilt])
            renders = {}
            for vname, (ribbon, taper) in variants.items():
                eng.setBowMaxWidth(ribbon)
                eng.setBowEdgeTaper(taper)
                p.set_pitch_excitation_mode(P, 1)
                renders[vname] = w.render(p, pc, P, 90)
                p.set_pitch_excitation_mode(P, 0)
            eng.setBowParams([P], TILT, [default_tilt])
            gain = w.norm_gain(*renders.values())
            f0 = (440.0 * 2 ** ((P - 69) / 12) * 2 ** (-16 / 1200)) if tilt is not None else t.f0_of(renders["bow3"] if "bow3" in renders else next(iter(renders.values())))
            for vname, x in renders.items():
                ribbon, taper = variants[vname]
                tag = f"_w{points(main_len, tilt, ribbon)}" if main_len else ""
                path = os.path.join(args.out, f"bow_{name}_{vname}{tag}.wav")
                write16(path, x, gain)
                row = {"case": f"{name} {vname}", "ribbon": ribbon, "edge_taper": taper, "wav": path,
                       **metrics(x, f0, ref_rms), "hf_above_3k_db": hf_db(x)}
                if vname == "bow3" and refs:
                    pat = (f"bow_{name}_tilt{tilt:g}_width{points(main_len, tilt, ribbon)}.wav" if tilt is not None
                           else f"bow_{name}_default.wav")
                    for d in refs:
                        rp = os.path.join(d, pat)
                        if os.path.exists(rp):
                            r = read_wav(rp)
                            n = min(len(r), len(x))
                            row["corr_vs_dev_bow3_wav"] = round(float(np.corrcoef(r[:n], x[:n])[0, 1]), 6)
                            break
                rows.append(row)
                print("\n" + json.dumps(row), flush=True)
    finally:
        eng.setBowMaxWidth(status0[1])
        eng.setBowEdgeTaper(status0[4])
        eng.shutdownGpu()
    with open(os.path.join(args.out, "dev-bowsoft-metrics.json"), "w") as f:
        json.dump(rows, f, indent=1)


if __name__ == "__main__":
    main()
