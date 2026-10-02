"""dev-f27f: before/after table + paired WAVs.
    python dev-f27f-tabulate.py RENDERS_DIR WAV_DIR
Table per preset/note/velocity: level (RMS 0-0.5 s dB), decay held / after release (dB/s), pitch (FFT peak of
the first 1 s, cents vs 12-TET), waveform difference after/before (whole render and release part).
WAVs: A1/C4 at v110, before+after normalised to ONE gain per pair (peak of the louder = 0.9 FS)."""
import json
import os
import sys
import wave

import numpy as np

SR = 48000
PRESETS = [("tmpl", "Belarus_8band_196modes"), ("bp1", "BaselinePreset1"),
           ("fpgaexc", "Belarus_8band_196modes_FPGAexc"), ("f15", "F15_Elyashev_array512")]


def fft_cents(x, midi):
    f0 = 440.0 * 2 ** ((midi - 69) / 12)
    seg = x[:SR] * np.hanning(SR)
    spec = np.abs(np.fft.rfft(seg, 4 * SR))
    fr = np.fft.rfftfreq(4 * SR, 1 / SR)
    sel = np.where((fr > f0 * 2 ** (-1 / 12)) & (fr < f0 * 2 ** (1 / 12)))[0]
    k = sel[np.argmax(spec[sel])]
    a, b, c = np.log(spec[k - 1:k + 2] + 1e-300)
    f = fr[k] + 0.5 * (a - c) / (a - 2 * b + c) * (fr[1] - fr[0])
    return 1200 * np.log2(f / f0)


def write_pair(path_b, path_a, xb, xa):
    g = 0.9 / max(np.max(np.abs(xb)), np.max(np.abs(xa)), 1e-300)
    for p, x in ((path_b, xb), (path_a, xa)):
        with wave.open(p, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
            w.writeframes((x * g * 32767).astype(np.int16).tobytes())


def main():
    root, wav_dir = sys.argv[1], sys.argv[2]
    os.makedirs(wav_dir, exist_ok=True)
    print("| preset | note | v | RMS dB before/after | decay held dB/s b/a | decay after release dB/s b/a | "
          "pitch c b/a | wav diff all / release |")
    print("|---|---|---|---|---|---|---|---|")
    for lab, name in PRESETS:
        rb = json.load(open(os.path.join(root, "before", lab + "_stored", "results.json")))
        ra = json.load(open(os.path.join(root, "after", lab + "_stored", "results.json")))
        rel = int(rb["hold_ms"] / 1000 * SR)
        for nb, na in zip(rb["notes"], ra["notes"]):
            tag = f"p{nb['pitch']}_v{nb['velocity']}"
            xb = np.load(os.path.join(root, "before", lab + "_stored", tag + "_ch0.npy")).astype(np.float64)
            xa = np.load(os.path.join(root, "after", lab + "_stored", tag + "_ch0.npy")).astype(np.float64)
            r = lambda v: np.sqrt(np.mean(v ** 2))
            f = lambda v: "-" if v is None else f"{v:.2f}"
            name_n = {33: "A1", 60: "C4", 96: "C7"}[nb["pitch"]]
            print(f"| {name} | {name_n} | {nb['velocity']} | {nb['rms_db']:.2f} / {na['rms_db']:.2f} | "
                  f"{f(nb['decay_hold'])} / {f(na['decay_hold'])} | {f(nb['decay_rel_05'])} / {f(na['decay_rel_05'])} | "
                  f"{fft_cents(xb, nb['pitch']):+.1f} / {fft_cents(xa, na['pitch']):+.1f} | "
                  f"{r(xa - xb) / r(xb):.1e} / {r(xa[rel:] - xb[rel:]) / r(xb[rel:]):.1e} |")
            if nb["pitch"] in (33, 60) and nb["velocity"] == 110:
                write_pair(os.path.join(wav_dir, f"{name}_{name_n}_v110_before.wav"),
                           os.path.join(wav_dir, f"{name}_{name_n}_v110_after.wav"), xb, xa)


if __name__ == "__main__":
    main()
