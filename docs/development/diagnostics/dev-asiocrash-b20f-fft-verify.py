"""dev-asiocrash-b20f: FFT-verify mic capture for pitches 60/67/72 at vel=100.

Each note plays for 1.0s; mic capture is 1+1+1+1.5s tail = 4.5s.
For each pitch, accept the recording if EITHER the fundamental OR any of
the first 4 harmonics shows SNR > 6x over the noise floor.
"""

import numpy as np
import wave
import sys

EXPECTED = {
    60: 261.626,  # C4
    67: 391.995,  # G4
    72: 523.251,  # C5
}

PATH = sys.argv[1] if len(sys.argv) > 1 else 'D:/tmp/keyboard_mic_20260527_133516.wav'

with wave.open(PATH, 'rb') as wf:
    n_ch = wf.getnchannels()
    sr = wf.getframerate()
    sw = wf.getsampwidth()
    n_frames = wf.getnframes()
    raw = wf.readframes(n_frames)

print(f"File: {PATH}")
print(f"  channels={n_ch}, sample_rate={sr}, samples_per_frame={sw}, n_frames={n_frames}")

samples = np.frombuffer(raw, dtype=np.int16).astype(np.float64) / 32768.0
if n_ch > 1:
    samples = samples.reshape(-1, n_ch).mean(axis=1)
print(f"  duration={len(samples) / sr:.3f}s, peak={np.max(np.abs(samples)):.4f}")
print()

pitches = [60, 67, 72]
print(f"{'Pitch':>6} {'F0 Hz':>7} {'h1 SNR':>7} {'h2 SNR':>7} {'h3 SNR':>7} {'h4 SNR':>7} {'best':>6} {'Result':>8}")
print("-" * 70)

ok_count = 0
for i, pitch in enumerate(pitches):
    start_n = int((i + 0.03) * sr)
    end_n = int((i + 0.97) * sr)
    window = samples[start_n:end_n]
    if len(window) < 4096:
        print(f"  pitch {pitch}: window too short")
        continue
    win = window * np.hanning(len(window))
    spec = np.abs(np.fft.rfft(win))
    freqs = np.fft.rfftfreq(len(win), 1.0 / sr)

    expected_hz = EXPECTED[pitch]
    nm = (freqs >= 100) & (freqs <= 8000)
    median = float(np.median(spec[nm]))

    snrs = []
    for h in (1, 2, 3, 4):
        target = expected_hz * h
        if target >= sr / 2:
            snrs.append(0.0)
            continue
        bin_idx = int(np.argmin(np.abs(freqs - target)))
        lo = max(0, bin_idx - 3)
        hi = min(len(spec), bin_idx + 4)
        bin_mag = float(np.max(spec[lo:hi]))
        snr = bin_mag / max(median, 1e-12)
        snrs.append(snr)

    best = max(snrs)
    ok = best > 6.0
    if ok:
        ok_count += 1
    result = "PASS" if ok else "FAIL"
    print(f"{pitch:>6} {expected_hz:>7.2f} {snrs[0]:>6.1f}x {snrs[1]:>6.1f}x {snrs[2]:>6.1f}x {snrs[3]:>6.1f}x {best:>5.1f}x {result:>8}")

print()
print(f"Result: {ok_count}/{len(pitches)} pitches verified at SNR > 6x (fundamental OR any harmonic 1-4)")
sys.exit(0 if ok_count == len(pitches) else 1)
