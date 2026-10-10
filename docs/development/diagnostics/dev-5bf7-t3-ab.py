"""dev-5bf7 — T3 listening A/B: full deck (source preset) vs 56 shaped + 140 uniform flat (flattened preset, split).

Usage: python dev-5bf7-t3-ab.py <run_dir> <wav_dir> <stem_A> <label_A> <stem_B> <label_B> <name>
Reads <label>_<stem>_listen.npy (dev-5bf7-t3-harness.py --listen; raw per-cycle [ch][64] float output) for A and B,
writes <wav_dir>/<name>_{A,B}_stereo.wav (L = out ch 1, R = out ch 2; A and B share ONE normalisation gain so their
levels compare) + 4-channel float WAVs, and prints objective diffs: per-channel level, octave-band levels and
per-segment (note / chord) levels B vs A in dB, waveform relRMS and spectral correlation.
"""
import json
import os
import sys
import wave

import numpy as np

SR = 48000
SPC = 64
NCH = 4
OCTAVES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
# segments of the --listen script (harness LISTEN_NOTES 1.5 s each from 0.2 s, then 4 chords 3 s each)
NOTES = [28, 40, 52, 60, 69, 79, 88, 100]
CHORDS = ["C2 chord", "C4 chord", "C5 chord", "C2-C6 chord"]


def load(run_dir, label, stem):
    raw = np.load(os.path.join(run_dir, f"{label}_{stem}_listen.npy"))
    cyc = raw.size // (SPC * NCH)
    return raw[:cyc * SPC * NCH].reshape(cyc, NCH, SPC).swapaxes(0, 1).reshape(NCH, -1)


def write_wav16(path, x, gain):
    y = np.clip(x * gain, -1, 1)
    pcm = (y.T * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(x.shape[0])
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def db(a, b):
    return float(20 * np.log10(np.sqrt(np.mean(b ** 2)) / np.sqrt(np.mean(a ** 2)))) if np.any(a) and np.any(b) else None


def band_levels(x):
    spec = np.abs(np.fft.rfft(x * np.hanning(x.size))) ** 2
    f = np.fft.rfftfreq(x.size, 1 / SR)
    return [float(10 * np.log10(spec[(f >= fc / np.sqrt(2)) & (f < fc * np.sqrt(2))].sum() + 1e-30)) for fc in OCTAVES]


def segments():
    segs, t = [], 0.2
    for p in NOTES:
        segs.append((f"note {p}", t, t + 1.5))
        t += 1.5
    for c in CHORDS:
        segs.append((c, t, t + 3.0))
        t += 3.0
    return segs


def main():
    run_dir, wav_dir, stem_a, la, stem_b, lb, name = sys.argv[1:8]
    os.makedirs(wav_dir, exist_ok=True)
    a, b = load(run_dir, la, stem_a), load(run_dir, lb, stem_b)
    n = min(a.shape[1], b.shape[1])
    a, b = a[:, :n], b[:, :n]
    gain = 0.89 / max(np.abs(a[:2]).max(), np.abs(b[:2]).max())
    for tag, x in (("A_fulldeck", a), ("B_flat56", b)):
        write_wav16(os.path.join(wav_dir, f"{name}_{tag}_stereo.wav"), x[:2], gain)
        write_wav16(os.path.join(wav_dir, f"{name}_{tag}_4ch.wav"), x, 0.89 / max(np.abs(a).max(), np.abs(b).max()))
    rep = {"name": name, "samples": n, "seconds": n / SR, "norm_gain_stereo": gain,
           "channel_level_db_B_vs_A": [db(a[c], b[c]) for c in range(NCH)],
           "waveform_relRMS": [float(np.linalg.norm(b[c] - a[c]) / np.linalg.norm(a[c])) for c in range(NCH)],
           "octave_centres_hz": OCTAVES}
    bl_a = np.array([band_levels(a[c]) for c in range(2)])
    bl_b = np.array([band_levels(b[c]) for c in range(2)])
    rep["octave_level_db_B_vs_A_ch1_ch2"] = np.round(bl_b - bl_a, 2).tolist()
    sa = np.abs(np.fft.rfft(a[0])); sb = np.abs(np.fft.rfft(b[0]))
    rep["log_spectrum_corr_ch1"] = float(np.corrcoef(np.log10(sa + 1e-12), np.log10(sb + 1e-12))[0, 1])
    seg = []
    for lab, t0, t1 in segments():
        i0, i1 = int(t0 * SR), min(int(t1 * SR), n)
        seg.append({"segment": lab, "level_db_B_vs_A_ch1": db(a[0, i0:i1], b[0, i0:i1]),
                    "level_db_B_vs_A_ch2": db(a[1, i0:i1], b[1, i0:i1]),
                    "relRMS_ch1": float(np.linalg.norm(b[0, i0:i1] - a[0, i0:i1]) / np.linalg.norm(a[0, i0:i1]))})
    rep["segments"] = seg
    with open(os.path.join(wav_dir, f"{name}_ab_report.json"), "w") as f:
        json.dump(rep, f, indent=1)
    print(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
