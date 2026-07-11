"""dev-scr1 — analyze captured mic buffers from a calibration run.

For each dumped buffer (logs/cal_debug_dump/buf_*.npy + cap_*.npy metadata):
  * envelope: lock-in amplitude at the drive freq in successive time windows
    (start->end) -> reveals ring-up transient / cross-tone contamination / stationarity
  * spectrum: fundamental vs harmonic content -> tone purity
  * total capture length vs hold
"""
import glob
import os

import numpy as np

DUMP = os.path.join(os.path.dirname(__file__), "..", "..", "..", "logs", "cal_debug_dump")
DUMP = os.path.abspath(DUMP)


def lockin_amp(x, f, sr):
    n = len(x)
    if n == 0:
        return 0.0
    t = np.arange(n) / sr
    ref = np.exp(-2j * np.pi * f * t)
    return 2.0 * np.abs(np.dot(x, ref)) / n


def main():
    bufs = sorted(glob.glob(os.path.join(DUMP, "buf_*.npy")))
    print(f"{len(bufs)} buffers in {DUMP}\n")
    for bf in bufs:
        cf = bf.replace("buf_", "cap_")
        meta = np.load(cf)
        freq, hold, sr, nsamp = meta
        x = np.load(bf)
        n = len(x)
        dur = n / sr
        # overall
        amp_all = lockin_amp(x, freq, sr)
        # windowed envelope: 6 equal windows
        w = n // 6
        env = [lockin_amp(x[k * w:(k + 1) * w], freq, sr) for k in range(6)] if w > 0 else []
        # steady tail (last 40%) vs full
        tail = x[int(n * 0.6):]
        amp_tail = lockin_amp(tail, freq, sr)
        # spectrum purity: energy at fundamental vs total, + 2nd/3rd harmonic
        X = np.abs(np.fft.rfft(x * np.hanning(n)))
        fr = np.fft.rfftfreq(n, 1 / sr)
        def bandmax(fc, bw=15):
            m = (fr > fc - bw) & (fr < fc + bw)
            return X[m].max() if m.any() else 0.0
        f0 = bandmax(freq)
        h2 = bandmax(2 * freq)
        h3 = bandmax(3 * freq)
        total = X.sum() + 1e-12
        rms = np.sqrt(np.mean(x ** 2))
        print(f"{os.path.basename(bf)[:24]:24} dur={dur*1000:5.0f}ms n={n:5d} rms={rms:9.1f}")
        print(f"   lockin full={amp_all:9.1f}  tail={amp_tail:9.1f}  "
              f"tail/full={amp_tail/(amp_all+1e-9):.2f}")
        if env:
            e = np.array(env)
            print(f"   envelope(6win)={np.round(e,0)}  "
                  f"rise={e[-1]/(e[0]+1e-9):.2f}x  cv={e.std()/(e.mean()+1e-9):.2f}")
        print(f"   spectrum: f0@{freq:.0f}={f0:.0f}  h2={h2:.0f}({100*h2/(f0+1e-9):.0f}%)  "
              f"h3={h3:.0f}({100*h3/(f0+1e-9):.0f}%)  fund/total={f0/total:.3f}")
        print()


if __name__ == "__main__":
    main()
