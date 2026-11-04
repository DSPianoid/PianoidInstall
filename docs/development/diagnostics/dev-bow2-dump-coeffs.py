"""dev-bow2: dump the engine's per-point string coefficients at each string's hammer-centre point
(the bow contact) from the DEBUG build (getParameters is debug-only). Needs the slot like any
in-process engine run.

Output per string: lambda = sqrt(shift_1 + 4 shift_2) (point impedance in engine units), the HF
(Kelvin-Voigt) weight coeff_frequency_decay, dec2 and the ratio hf / lambda^2.
"""
import os
import sys

import numpy as np

core = sys.argv[1]
mw = os.path.join(core, "pianoid_middleware")
sys.path.insert(0, mw)
os.chdir(mw)
from pianoid import initialize

p = initialize(os.path.join(mw, "presets", "BaselinePreset1.json"), filterlen=48 * 128 * 3,
               string_iteration=4, array_size=384, sample_rate=48000, samples_in_cycle=64,
               buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0,
               use_debug_build=True)
eng = p.pianoid
import pianoidCuda as pc
cfg = pc.PlaybackConfig()
cfg.audio_enabled = False
cfg.record_to_buffer = False
cfg.max_duration_ms = 100
cfg.sample_rate = 48000
cfg.samples_per_cycle = 64
eng.runOfflinePlayback(pc.EventQueue(), cfg)   # runs stringMap + parameter kernels
par = np.array(eng.getParameters())
A = 384
blocks = len(par) // (A * 32)
rows = []
for b in range(blocks):
    blk = par[b * A * 32:(b + 1) * A * 32].reshape(32, A)
    centre = np.flatnonzero(blk[10] > 0.5)
    for i in centre:
        s1, s2, hf, d2, string_no = blk[1, i], blk[2, i], blk[7, i], blk[8, i], int(blk[11, i])
        lam = np.sqrt(max(s1 + 4 * s2, 0))
        n_main = int(np.sum((blk[18] > 0.5) & (blk[11] == blk[11, i])))
        rows.append((string_no, lam, hf, d2, hf / max(lam * lam, 1e-12), int(blk[20, i]), n_main))
rows.sort()
for r in rows:
    print("string %3d lambda=%.4f hf=%.3e dec2=%.3e hf/lam2=%.3e idx=%d main_points=%d" % r)
for pitch in (36, 48, 60, 72):
    print("pitch", pitch, "strings", list(eng.getStringIndicesForPitch(pitch)))
eng.shutdownGpu()
