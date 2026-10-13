"""dev-fd69 rig probe 2026-10-13: which inputs carry sensors after the new piezos were connected.

Records silence on every ASIO input (loopback In 8 excluded), then one 8 s ESS per exciter
(Out 1-4, -30 dBFS) captured on all of them. Per input: noise rms, sweep-response rms, broadband
SNR of the deconvolved IR (peak vs the noise record's IR), first-arrival sample per exciter and
the correlation between inputs (duplicated / bridged channels).

Run (Core venv, integration worktree on the path, live :5000 with ASIO open):
  PYTHONPATH=D:/repos/wt-fd69-core PianoidCore/.venv/Scripts/python.exe \
      docs/development/diagnostics/dev-fd69-rig-probe-2026-10-13.py <out_dir>
"""
import json
import os
import sys

import numpy as np

from pianoid_middleware.modal_adapter.measurement.ess import deconvolve, exp_sweep
from pianoid_middleware.modal_adapter.swept_discovery.audio_io import SessionAudioIO

FS = 48000.0
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
io = SessionAudioIO(os.path.join(OUT, "sessions"))
INPUTS = ([f"In {i}" for i in range(1, 8)] + ["SPDIF 1", "SPDIF 2"]
          + [f"ADAT {i}" for i in range(1, 9)])  # every ASIO input except the loopback In 8
EXC = ["Out 1", "Out 2", "Out 3", "Out 4"]
F1, F2, T, LVL = 20.0, 10000.0, 8.0, -30.0


def db(v):
    return float(20 * np.log10(max(float(v), 1e-12)))


noise, _ = io.record(T + 3.0, INPUTS, "noise")
x = exp_sweep(F1, F2, T, FS, LVL)
hn = deconvolve(noise, x, FS, (F1, F2))
rep = {"inputs": INPUTS, "level_dbfs": LVL, "noise_rms_dbfs": {}, "per_exciter": {}}
for k, n in enumerate(INPUTS):
    rep["noise_rms_dbfs"][n] = db(np.sqrt(np.mean(noise[:, k] ** 2)))
caps = {}
for e in EXC:
    y, _ = io.play_record(x, e, INPUTS, 0.0, 3.0, f"probe_{e.replace(' ', '').lower()}")
    caps[e] = y
    h = deconvolve(y, x, FS, (F1, F2))
    m = int(0.5 * FS)
    rows = {}
    for k, n in enumerate(INPUTS):
        hk = h[:m, k] if h.ndim == 2 else h[k, :m]
        nk = hn[:m, k] if hn.ndim == 2 else hn[k, :m]
        pk = np.max(np.abs(hk))
        thr = 0.1 * pk
        rows[n] = {"resp_rms_dbfs": db(np.sqrt(np.mean(y[:, k] ** 2))),
                   "ir_peak_snr_db": db(pk) - db(np.max(np.abs(nk))),
                   "ir_energy_snr_db": 10 * np.log10(np.sum(hk ** 2) / max(np.sum(nk ** 2), 1e-30)),
                   "first_arrival_samples": int(np.argmax(np.abs(hk) > thr))}
    rep["per_exciter"][e] = rows
allc = np.concatenate([caps[e] for e in EXC], axis=0)
live = [k for k, n in enumerate(INPUTS)
        if max(rep["per_exciter"][e][n]["ir_energy_snr_db"] for e in EXC) > 20]
c = np.corrcoef(allc[:, live].T) if len(live) > 1 else np.ones((1, 1))
rep["live_inputs"] = [INPUTS[k] for k in live]
rep["corr_live"] = {INPUTS[a]: {INPUTS[b]: round(float(c[i, j]), 3) for j, b in enumerate(live)}
                    for i, a in enumerate(live)}
with open(os.path.join(OUT, "probe.json"), "w", encoding="utf-8") as fh:
    json.dump(rep, fh, indent=1)
print(f"{'input':10s} {'noise':>7s} " + " ".join(f"{e:>16s}" for e in EXC))
for n in INPUTS:
    print(f"{n:10s} {rep['noise_rms_dbfs'][n]:7.1f} " + " ".join(
        f"{rep['per_exciter'][e][n]['ir_energy_snr_db']:6.1f}dB@{rep['per_exciter'][e][n]['first_arrival_samples']:5d}"
        for e in EXC))
print("live:", rep["live_inputs"])
