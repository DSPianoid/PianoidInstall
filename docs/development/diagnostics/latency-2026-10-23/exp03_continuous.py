"""exp03 - continuous-sound parameters: change sent at t=1.0 s while p60 (v100) sustains; latency =
first sample where the capture departs from a bit-exact reference capture (no change), anchored on
the WS NOTE_ON of the same capture. Transport: WS emitWithAck ('ws'), REST ('rest').

usage: python exp03_continuous.py [reps] [filter-substring] [transport ws|rest|both]
"""
import json
import sys
import time

import numpy as np

import latlib as L

L.SCHED_TO_IN8_S = 0.0203125
REPS = int(sys.argv[1]) if len(sys.argv) > 1 else 3
FILT = sys.argv[2] if len(sys.argv) > 2 else ""
TRANSPORTS = {"both": ["ws", "rest"]}.get(sys.argv[3] if len(sys.argv) > 3 else "ws",
                                          [sys.argv[3] if len(sys.argv) > 3 else "ws"])
NOTE, VEL = 60, 100
ws = L.WS()

PIANO = list(range(21, 109))


def g(path):
    return L.get(path)


# ---- current values
s60 = g("/get_parameter/string/60")["60"]
s_all = g("/get_parameter/string/from21to108")
m0 = g("/get_parameter/mode/0")["0"]
m_all = g("/get_parameter/mode/all")
fi60 = g("/get_parameter/feedin/60")["60"]
fb128 = g("/get_parameter/feedback/128")["128"]
rt = g("/get_runtime_parameters")
NM = len(fi60)


def P(kind, key, values):          # set_parameter payload
    return ("set_parameter", {"parameter": kind, "key": key, "values": values}, f"/set_parameter/{kind}/{key}", values)


def R(values):                      # runtime payload
    return ("set_runtime_parameters", values, "/set_runtime_parameters", values)


def string_one(field, f):
    return (P("string", "60", {"60": {field: s60[field] * f}}), P("string", "60", {"60": {field: s60[field]}}))


def string_range(field, f, lo, hi):
    ks = [str(p) for p in range(lo, hi + 1) if str(p) in s_all]
    new = {k: {field: s_all[k][field] * f} for k in ks}
    old = {k: {field: s_all[k][field]} for k in ks}
    key = f"from{lo}to{hi}" if hi > lo else str(lo)
    return (P("string", key, new), P("string", key, old))


def mode_range(field, f, lo, hi):
    ks = [str(m) for m in range(lo, hi + 1)]
    new = {k: {field: m_all[k][field] * f} for k in ks}
    old = {k: {field: m_all[k][field]} for k in ks}
    key = f"from{lo}to{hi}" if hi > lo else str(lo)
    return (P("mode", key, new), P("mode", key, old))


CASES = {
    # runtime (toolbar sliders / coefficient field)
    "runtime.volume_64to90": (R({"volume": 90}), R({"volume": rt["volume_level"]})),
    "runtime.feedback_coeff_x0.5": (R({"feedback_coeff": rt["deck_feedback_coefficient"] * 0.5}),
                                    R({"feedback_coeff": rt["deck_feedback_coefficient"]})),
    "runtime.volume_center_x2": (R({"volume_center": rt["volume_center"] * 2}), R({"volume_center": rt["volume_center"]})),
    # strings panel, p60
    "string.tension_x1.02": string_one("tension", 1.02),
    "string.gamma_x3": string_one("gamma", 3.0),
    "string.jung_x1.5": string_one("jung", 1.5),
    "string.rho_x1.02": string_one("rho", 1.02),
    "string.r_x1.05": string_one("r", 1.05),
    "string.length_x1.02": string_one("length", 1.02),
    "string.detuning_x4": string_one("detuning", 4.0),
    "string.dispersion_damping_x100": string_one("dispersion_damping", 100.0),
    # strings range edits (Workbench / multi-select): tension
    "string_range12.tension_x1.02": string_range("tension", 1.02, 55, 66),
    "string_range88.tension_x1.02": string_range("tension", 1.02, 21, 108),
    # modes panel
    "mode0.frequency_x1.05": mode_range("frequency", 1.05, 0, 0),
    "mode0.decrement_x3": mode_range("decrement", 3.0, 0, 0),
    "mode0.mass_inv_x2": mode_range("mass_inv", 2.0, 0, 0),
    "mode_all.frequency_x1.02": mode_range("frequency", 1.02, 0, NM - 1),
    # deck / sound channels (REST default in the FE)
    "feedin60.row_x0.5": (P("feedin", "60", {"60": [v * 0.5 for v in fi60]}), P("feedin", "60", {"60": fi60})),
    "feedin_mask60.mute": (P("feedin_mask", "60", {"60": [0.0] * NM}), P("feedin_mask", "60", {"60": [1.0] * NM})),
    "sc_strings.feedback128_row_x0.5": (P("feedback", "128", {"128": [v * 0.5 for v in fb128]}), P("feedback", "128", {"128": fb128})),
    "sc_strings.feedback_mask128.mute": (P("feedback_mask", "128", {"128": [0.0] * NM}), P("feedback_mask", "128", {"128": [1.0] * NM})),
}


def send(spec, transport):
    ev, wsp, path, body = spec
    if transport == "ws":
        ack, a, b = ws.emit_ack(ev, wsp, timeout=60)
        ok = ack.get("ok") if isinstance(ack, dict) else ack
        return {"t_send": a, "t_ack": b, "ok": ok, "err": (ack.get("error") if isinstance(ack, dict) else None)}
    a = time.time()
    code, resp = L.post(path, body, timeout=120)
    return {"t_send": a, "t_ack": time.time(), "ok": code == 200, "err": None if code == 200 else str(resp)[:200]}


def analyse(ref, t, act):
    xr, x = ref["x"], t["x"]
    ir = L.onset(xr, int(0.25 * L.FS), noise_win=1200)
    it = L.onset(x, int(0.25 * L.FS), noise_win=1200)
    sh = L.align(xr, x, ir, it)
    n = len(x)
    r = np.zeros(n)
    lo, hi = max(0, sh), min(n, len(xr) + sh)
    r[lo:hi] = xr[lo - sh:hi - sh]
    d = x.astype(np.float64) - r
    i_send = it + int(round((act["t_send"] - t["t_note_send"]) * L.FS))
    pre = d[it:i_send - 240]
    pre_nonzero = int(np.count_nonzero(np.abs(pre) > 4.0 / 32768))
    # first sustained non-zero difference after (send - 50 ms)
    nz = np.abs(d) > 1.5 / 32768
    first = None
    i = max(it, i_send - 2400)
    while i < n - 480:
        if nz[i] and nz[i:i + 480].mean() > 0.1:
            first = i
            break
        i += 1
    # perceptual: diff envelope > -40 dB re the signal RMS of the 100 ms before send
    sig = float(np.sqrt(np.mean(x[i_send - 4800:i_send].astype(np.float64) ** 2)))
    e = L.env_rms(d, 96)
    above = np.nonzero(e[max(it, i_send - 2400):] > sig * 0.01)[0]
    perc = (max(it, i_send - 2400) + int(above[0])) if above.size else None
    lat = lambda i: (L.epoch_of_index(t, i, it) - act["t_send"]) * 1e3 if i is not None else None
    return {"shift": sh, "pre_nonzero": pre_nonzero, "lat_first_ms": lat(first), "lat_m40dB_ms": lat(perc),
            "ack_ms": (act["t_ack"] - act["t_send"]) * 1e3, "ok": act.get("ok"), "err": act.get("err"),
            "sig_dbfs": 20 * np.log10(sig + 1e-12), "diff_after_dbfs": 20 * np.log10(float(e[first:first + 4800].max()) + 1e-12) if first else None}


results = {}
for name, (new, old) in CASES.items():
    if FILT and FILT not in name:
        continue
    for tr in TRANSPORTS:
        key = f"{name}|{tr}"
        ref = L.run_capture(ws, [], note=NOTE, vel=VEL, length_s=2.5, tag=f"exp03_{name}_ref")
        rows = []
        for rep in range(REPS):
            t = L.run_capture(ws, [(1.0, lambda: send(new, tr))], note=NOTE, vel=VEL, length_s=2.5,
                              tag=f"exp03_{name}_{tr}_r{rep}")
            rest = send(old, "ws")
            row = analyse(ref, t, t["acts"][0])
            row["restore_ack_ms"] = (rest["t_ack"] - rest["t_send"]) * 1e3
            row["wav"] = t["wav"]
            rows.append(row)
            print(key, rep, {k: (round(v, 2) if isinstance(v, float) else v) for k, v in row.items() if k != "wav"}, flush=True)
        # restore integrity: a fresh reference must equal the first one bit-exactly
        ref2 = L.run_capture(ws, [], note=NOTE, vel=VEL, length_s=2.5, tag=f"exp03_{name}_ref2")
        chk = analyse(ref, ref2, {"t_send": ref2["t_note_send"] + 0.7, "t_ack": ref2["t_note_send"] + 0.7})
        results[key] = {"rows": rows, "restore_check_first_diff_ms": chk["lat_first_ms"],
                        "lat_first": L.stats([r["lat_first_ms"] for r in rows]),
                        "lat_m40": L.stats([r["lat_m40dB_ms"] for r in rows]),
                        "ack": L.stats([r["ack_ms"] for r in rows])}
        print("SUMMARY", key, json.dumps({k: v for k, v in results[key].items() if k != "rows"}, default=float), flush=True)
        L.save_json(f"exp03_continuous_{FILT or 'all'}_{'-'.join(TRANSPORTS)}.json", results)
ws.close()
