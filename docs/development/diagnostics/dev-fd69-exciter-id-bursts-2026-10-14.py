"""dev-fd69 2026-10-14: audible identification bursts, one exciter at a time (Out 1..7).

One ASIO session (POST /audio/session on :5000, synthesis paused for the session), no loopback.
Out k plays a 1 s log chirp 100 Hz - 2 kHz (20 ms fades, -30 dBFS peak) starting at t = 3 (k - 1) s.
In 1..8 are recorded; per output burst window: rms / peak per input and the level re the
input's noise (the 1.5 s gap before Out 1 is not available -> noise = quietest 0.5 s of the last gap).

Run: PYTHONPATH=D:/repos/wt-fd69-core PianoidCore/.venv/Scripts/python.exe <this> <out_dir> [--all-inputs] [--with-tone]
"""
import json
import os
import sys

import numpy as np

from pianoid_middleware.modal_adapter.swept_discovery.audio_io import SessionAudioIO

FS = 48000
OUTS = [f"Out {k}" for k in range(1, 8)]
INS = [f"In {k}" for k in range(1, 9)]
if "--all-inputs" in sys.argv:          # every enumerated ASIO input (SPDIF + ADAT / 2nd UMC1820)
    sys.argv.remove("--all-inputs")
    INS += ["SPDIF 1", "SPDIF 2"] + [f"ADAT {k}" for k in range(1, 9)]
STEP, DUR, LVL = 3.0, 1.0, -30.0
TONE = "--with-tone" in sys.argv        # per exciter: chirp 0-1 s, gap, 100 Hz sine 2-4 s, gap -> 6 s slots
if TONE:
    sys.argv.remove("--with-tone")
    STEP = 6.0
TONE_F, TONE_T0, TONE_DUR = 100.0, 2.0, 2.0
out_dir = sys.argv[1]
os.makedirs(out_dir, exist_ok=True)

t = np.arange(int(DUR * FS)) / FS
f1, f2 = 100.0, 2000.0
k = np.log(f2 / f1)
burst = np.sin(2 * np.pi * f1 * DUR / k * (np.exp(t / DUR * k) - 1))
nf = int(0.02 * FS)
burst[:nf] *= np.linspace(0, 1, nf); burst[-nf:] *= np.linspace(1, 0, nf)
burst *= 10 ** (LVL / 20)
tone = np.sin(2 * np.pi * TONE_F * np.arange(int(TONE_DUR * FS)) / FS)
tone[:nf] *= np.linspace(0, 1, nf); tone[-nf:] *= np.linspace(1, 0, nf)
tone *= 10 ** (LVL / 20)
total = int((STEP * (len(OUTS) - 1) + (STEP if TONE else DUR + 1.0)) * FS)
sig = np.zeros((total, len(OUTS)), np.float32)
for i in range(len(OUTS)):
    s0 = int(i * STEP * FS)
    sig[s0:s0 + len(burst), i] = burst
    if TONE:
        t0 = s0 + int(TONE_T0 * FS)
        sig[t0:t0 + len(tone), i] = tone

io = SessionAudioIO(os.path.join(out_dir, "sessions"), loopback=None)
y, meta = io.play_record_multi(sig, OUTS, INS, 1.0, "id_bursts")
print("session", meta.get("status"), "xruns", meta.get("xruns"), "frames", y.shape)


def db(v):
    return float(20 * np.log10(max(float(v), 1e-12)))


gap = y[int((STEP * 6 + (TONE_T0 + TONE_DUR + 0.5 if TONE else DUR + 0.3)) * FS):]  # after the last slot's ringdown
noise = [db(np.sqrt(np.mean(gap[:, j] ** 2))) for j in range(len(INS))]
rep = {"status": meta.get("status"), "xruns": meta.get("xruns"), "level_dbfs": LVL,
       "noise_rms_dbfs": dict(zip(INS, noise)), "per_output": {}}
print(f"{'':7s}" + "".join(f"{n:>9s}" for n in INS))
print(f"{'noise':7s}" + "".join(f"{v:9.1f}" for v in noise))
for i, o in enumerate(OUTS):
    s0 = int((i * STEP) * FS); w = y[s0:s0 + int((DUR + 0.3) * FS)]
    rms = [db(np.sqrt(np.mean(w[:, j] ** 2))) for j in range(len(INS))]
    pk = [db(np.max(np.abs(w[:, j]))) for j in range(len(INS))]
    rep["per_output"][o] = {n: {"rms_dbfs": r, "peak_dbfs": p, "over_noise_db": r - nz}
                            for n, r, p, nz in zip(INS, rms, pk, noise)}
    print(f"{o:7s}" + "".join(f"{r - nz:9.1f}" for r, nz in zip(rms, noise)) + "   (dB over noise)")
    print(f"{'  peak':7s}" + "".join(f"{p:9.1f}" for p in pk) + "   (dBFS)")
if TONE:
    # 100 Hz lock-in over the middle 1.5 s of each tone vs the same lock-in on the tail gap (hum has a 100 Hz line)
    n = int(1.5 * FS)

    def lockin(x):
        tt = np.arange(len(x)) / FS
        return 2 * np.abs(np.mean(x * np.exp(-2j * np.pi * TONE_F * tt[:, None]), axis=0))

    g = gap[:n] if len(gap) >= n else gap
    nz = lockin(g)
    rep["tone"] = {"f_hz": TONE_F, "level_dbfs": LVL, "noise_100hz_dbfs": dict(zip(INS, [db(v) for v in nz])), "per_output": {}}
    print("100 Hz amplitude, dBFS (dB over the gap's 100 Hz line)")
    for i, o in enumerate(OUTS):
        t0 = int((i * STEP + TONE_T0 + 0.25) * FS)
        a = lockin(y[t0:t0 + n])
        rep["tone"]["per_output"][o] = {nm: {"dbfs": db(v), "over_noise_db": db(v) - db(w)} for nm, v, w in zip(INS, a, nz)}
        print(f"{o:7s}" + "".join(f"{db(v):7.1f}({db(v) - db(w):4.1f})" for v, w in zip(a[:8], nz[:8])))
json.dump(rep, open(os.path.join(out_dir, "id_bursts.json"), "w"), indent=1)
