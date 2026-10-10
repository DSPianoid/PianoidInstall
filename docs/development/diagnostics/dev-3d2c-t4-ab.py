"""dev-3d2c — T4 listening A/B: WAVs + objective levels for several renders of the SAME material at ONE gain.

Usage:
    python dev-3d2c-t4-ab.py <listen|chord> <wav_dir> <name> TAG=<raw.npy> [TAG=<raw.npy> ...]
<raw.npy> = raw per-cycle [ch][64] float output (dev-5bf7-t3-harness --listen `*_listen.npy`, or dev-3d2c-chord-render
`*_chord.npy`). The first TAG is the reference. Writes <wav_dir>/<name>_<TAG>_stereo.wav (L = out ch 1, R = out ch 2,
16-bit) and <name>_<TAG>_4ch.wav, ALL tags sharing one normalisation gain (peak of all renders -> -1 dBFS), and
<name>_report.json: per tag peak / RMS dBFS, clipped samples (before normalisation: |x| >= the engine int32 rail is
not visible here, so 'clipped' = samples at the common normalisation ceiling), channel level vs the reference,
octave-band levels (31.5 Hz-16 kHz) and their difference, waveform relRMS, and per-segment levels (listen material:
the 8 single notes + 4 chords; chord material: 0.5 s envelope).
"""
import json
import os
import sys
import wave

import numpy as np

SR, SPC, NCH = 48000, 64, 4
OCTAVES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
NOTES = [28, 40, 52, 60, 69, 79, 88, 100]                 # dev-5bf7-t3-harness LISTEN_NOTES (1.5 s from 0.2 s)
CHORDS = ["C2 chord", "C4 chord", "C5 chord", "C2-C6 chord"]   # then 3 s each


def load(path):
    raw = np.load(path)
    cyc = raw.size // (SPC * NCH)
    return raw[:cyc * SPC * NCH].reshape(cyc, NCH, SPC).swapaxes(0, 1).reshape(NCH, -1)


def write_wav16(path, x, gain):
    pcm = (np.clip(x * gain, -1, 1).T * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(x.shape[0])
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def dbfs(v):
    return float(20 * np.log10(v + 1e-30))


def rms(x):
    return float(np.sqrt(np.mean(x ** 2)))


def band_levels(x):
    spec = np.abs(np.fft.rfft(x * np.hanning(x.size))) ** 2
    f = np.fft.rfftfreq(x.size, 1 / SR)
    return np.array([10 * np.log10(spec[(f >= fc / np.sqrt(2)) & (f < fc * np.sqrt(2))].sum() + 1e-30)
                     for fc in OCTAVES])


def listen_segments():
    segs, t = [], 0.2
    for p in NOTES:
        segs.append((f"note {p}", t, t + 1.5))
        t += 1.5
    for c in CHORDS:
        segs.append((c, t, t + 3.0))
        t += 3.0
    return segs


def main():
    kind, wav_dir, name = sys.argv[1:4]
    tags = [a.split("=", 1) for a in sys.argv[4:]]
    os.makedirs(wav_dir, exist_ok=True)
    xs = {t: load(p) for t, p in tags}
    n = min(x.shape[1] for x in xs.values())
    xs = {t: x[:, :n] for t, x in xs.items()}
    peak = max(np.abs(x).max() for x in xs.values())
    gain = 0.89 / peak                                       # -1 dBFS for the loudest render, shared by all
    ref_tag = tags[0][0]
    ref = xs[ref_tag]
    ref_bands = np.array([band_levels(ref[c] * gain) for c in range(2)])
    rep = {"name": name, "kind": kind, "seconds": n / SR, "gain": gain, "reference": ref_tag,
           "octave_centres_hz": OCTAVES, "tags": {}}
    for tag, x in xs.items():
        st = os.path.join(wav_dir, f"{name}_{tag}_stereo.wav")
        write_wav16(st, x[:2], gain)
        write_wav16(os.path.join(wav_dir, f"{name}_{tag}_4ch.wav"), x, gain)
        y = x * gain
        b = np.array([band_levels(y[c]) for c in range(2)])
        e = {"wav_stereo": st, "finite": bool(np.isfinite(x).all()),
             "peak_dbfs_ch1..4": [round(dbfs(np.abs(y[c]).max()), 2) for c in range(NCH)],
             "rms_dbfs_ch1..4": [round(dbfs(rms(y[c])), 2) for c in range(NCH)],
             "samples_at_ceiling": int((np.abs(y) >= 0.999).sum()),
             "level_db_vs_ref_ch1..4": [round(dbfs(rms(x[c])) - dbfs(rms(ref[c])), 2) for c in range(NCH)],
             "octave_db_ch1": np.round(b[0], 1).tolist(), "octave_db_ch2": np.round(b[1], 1).tolist(),
             "octave_db_vs_ref_ch1": np.round(b[0] - ref_bands[0], 2).tolist(),
             "octave_db_vs_ref_ch2": np.round(b[1] - ref_bands[1], 2).tolist(),
             "waveform_relRMS_vs_ref_ch1..4": [round(float(np.linalg.norm(x[c] - ref[c]) / np.linalg.norm(ref[c])), 4)
                                               for c in range(NCH)]}
        if kind == "listen":
            seg = []
            for lab, t0, t1 in listen_segments():
                i0, i1 = int(t0 * SR), min(int(t1 * SR), n)
                seg.append({"segment": lab, "level_db_vs_ref_ch1": round(dbfs(rms(x[0, i0:i1])) - dbfs(rms(ref[0, i0:i1])), 2),
                            "level_db_vs_ref_ch2": round(dbfs(rms(x[1, i0:i1])) - dbfs(rms(ref[1, i0:i1])), 2),
                            "rms_dbfs_ch1": round(dbfs(rms(y[0, i0:i1])), 1)})
            e["segments"] = seg
        else:
            e["envelope_rms_dbfs_per_0p5s_L+R"] = [round(dbfs(rms(y[:2, int(t * SR):int((t + 0.5) * SR)])), 1)
                                                   for t in np.arange(0, n / SR - 0.49, 0.5)]
        rep["tags"][tag] = e
    with open(os.path.join(wav_dir, f"{name}_report.json"), "w") as f:
        json.dump(rep, f, indent=1)
    print(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
