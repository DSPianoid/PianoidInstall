"""exp02 - determinism of the live engine (ref vs ref difference floor) + first volume step."""
import time

import numpy as np

import latlib as L

L.SCHED_TO_IN8_S = 0.0203125
ws = L.WS()
note = 60
refs = [L.run_capture(ws, [], note=note, tag=f"exp02_ref{i}") for i in range(3)]


def vol(v):
    def f():
        ack, a, b = ws.emit_ack('set_runtime_parameters', {"volume": v})
        return {"t_send": a, "t_ack": b, "ack": ack.get('ok') if isinstance(ack, dict) else ack}
    return f


trials = []
for i in range(3):
    t = L.run_capture(ws, [(1.0, vol(90))], note=note, tag=f"exp02_vol{i}")
    ws.emit_ack('set_runtime_parameters', {"volume": 64})
    trials.append(t)

r0 = refs[0]
i_r0 = L.onset(r0["x"], int(0.25 * L.FS), noise_win=1200)
res = {"ref_vs_ref": [], "vol": []}
for r in refs[1:]:
    i_r = L.onset(r["x"], int(0.25 * L.FS), noise_win=1200)
    sh = L.align(r0["x"], r["x"], i_r0, i_r)
    idx, noise, e = L.diff_onset(r0["x"], r["x"], sh, i_r + 4800, noise_span=(i_r / L.FS + 0.05, i_r / L.FS + 0.5))
    sigrms = float(np.sqrt(np.mean(r["x"][i_r:i_r + 24000] ** 2)))
    res["ref_vs_ref"].append({"i_note": i_r, "shift": sh, "diff_noise": noise, "sig_rms": sigrms,
                              "snr_db": 20 * np.log10(sigrms / noise), "spurious_onset": idx,
                              "max_diff_env_after": float(e[i_r:].max())})
for t in trials:
    x = t["x"]
    i_n = L.onset(x, int(0.25 * L.FS), noise_win=1200)
    sh = L.align(r0["x"], x, i_r0, i_n)
    a = t["acts"][0]
    i_send = i_n + int((a["t_send"] - t["t_note_send"]) * L.FS)
    idx, noise, e = L.diff_onset(r0["x"], x, sh, i_send - 2400, noise_span=(i_n / L.FS + 0.05, i_n / L.FS + 0.5))
    lat = (L.epoch_of_index(t, idx, i_n) - a["t_send"]) * 1e3 if idx else None
    res["vol"].append({"i_note": i_n, "shift": sh, "noise": noise, "idx": idx, "lat_ms": lat,
                       "ack_ms": (a["t_ack"] - a["t_send"]) * 1e3, "t_send_rel_note_ms": (a["t_send"] - t["t_note_send"]) * 1e3})
for k, v in res.items():
    for r in v:
        print(k, {kk: (round(vv, 3) if isinstance(vv, float) else vv) for kk, vv in r.items()})
L.save_json("exp02_determinism.json", res)
ws.close()
