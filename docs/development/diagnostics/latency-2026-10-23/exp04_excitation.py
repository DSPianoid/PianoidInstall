"""exp04 - excitation (strike-time) parameters. A change is sent (WS, async) at t=0.3 s and p60 v127
is struck d ms later; the strike is classified bit-exactly against two references (old value / new
value). P(new | d) gives the excitation latency; 'mixed' = matches neither (a partially-applied
upload, e.g. unison strings or the coefficient table landing in separate swaps).

usage: python exp04_excitation.py [reps] [filter] [delays-csv]
"""
import json
import sys
import threading
import time

import numpy as np

import latlib as L

L.SCHED_TO_IN8_S = 0.0203125
REPS = int(sys.argv[1]) if len(sys.argv) > 1 else 3
FILT = sys.argv[2] if len(sys.argv) > 2 else ""
DELAYS = [int(v) for v in sys.argv[3].split(",")] if len(sys.argv) > 3 else [0, 2, 5, 10, 20, 40, 80, 160, 320, 640, 1280]
NOTE, VEL = 60, 127
ws = L.WS()

gauss = L.get("/get_parameter/gauss/from21to108")
ham = L.get("/get_parameter/hammer/from21to108")
energy = L.get("/excitation_energy")


def P(kind, key, values):
    return ("set_parameter", {"parameter": kind, "key": key, "values": values}, f"/set_parameter/{kind}/{key}", values)


def gauss_range(lo, hi, curve, field, f, level="127"):
    ks = [str(p) for p in range(lo, hi + 1) if str(p) in gauss]
    key = f"from{lo}to{hi}" if hi > lo else str(lo)
    new = {k: {level: {curve: {field: gauss[k][level][curve][field] * f}}} for k in ks}
    old = {k: {level: {curve: {field: gauss[k][level][curve][field]}}} for k in ks}
    return P("excitation", key, new), P("excitation", key, old)


def hammer_range(lo, hi, field, newv):
    ks = [str(p) for p in range(lo, hi + 1) if str(p) in ham]
    key = f"from{lo}to{hi}" if hi > lo else str(lo)
    new = {k: {"hammer": {field: newv(ham[k]["hammer"][field])}} for k in ks}
    old = {k: {"hammer": {field: ham[k]["hammer"][field]}} for k in ks}
    return P("hammer", key, new), P("hammer", key, old)


def energy_mass(f):
    m = energy["hammer_mass"]["60"]
    return (("rest", None, "/excitation_energy", {"hammer_mass": {"60": m * f}}),
            ("rest", None, "/excitation_energy", {"hammer_mass": {"60": m}}))


CASES = {
    "gauss.c2.volume_x0.5|n1": gauss_range(60, 60, "2", "volume", 0.5),
    "gauss.c2.sigma_x1.5|n1": gauss_range(60, 60, "2", "sigma", 1.5),
    "gauss.c2.volume_x0.5|n8": gauss_range(57, 64, "2", "volume", 0.5),
    "gauss.c2.volume_x0.5|n9": gauss_range(56, 64, "2", "volume", 0.5),
    "gauss.c2.volume_x0.5|n12": gauss_range(55, 66, "2", "volume", 0.5),
    "gauss.c2.volume_x0.5|n88": gauss_range(21, 108, "2", "volume", 0.5),
    "hammer.position_0.25|n1": hammer_range(60, 60, "hammer_position", lambda v: 0.25),
    "hammer.width_x1.5|n1": hammer_range(60, 60, "hammer_width", lambda v: v * 1.5),
    "hammer.sharpness_0.8|n1": hammer_range(60, 60, "hammer_sharpness", lambda v: 0.8),
    "hammer.position_0.25|n12": hammer_range(55, 66, "hammer_position", lambda v: 0.25),
    "hammer.position_0.25|n88": hammer_range(21, 108, "hammer_position", lambda v: 0.25),
    "energy.hammer_mass_x0.5|n1": energy_mass(0.5),
    "energy.calibration_x0.5": (("rest", None, "/excitation_energy", {"excitation_impulse_calibration": energy["excitation_impulse_calibration"] * 0.5}),
                                ("rest", None, "/excitation_energy", {"excitation_impulse_calibration": energy["excitation_impulse_calibration"]})),
    "energy.speeds_x0.5": (("rest", None, "/excitation_energy", {"hammer_speeds": [v * 0.5 for v in energy.get("hammer_speeds", [])]}),
                           ("rest", None, "/excitation_energy", {"hammer_speeds": energy.get("hammer_speeds", [])})),
}


def send_sync(spec):
    ev, wsp, path, body = spec
    if ev == "rest":
        a = time.time(); code, resp = L.post(path, body, timeout=120)
        return {"t_send": a, "t_ack": time.time(), "ok": code == 200}
    ack, a, b = ws.emit_ack(ev, wsp, timeout=120)
    return {"t_send": a, "t_ack": b, "ok": ack.get("ok") if isinstance(ack, dict) else ack}


def send_async(spec):
    box = {}
    ev, wsp, path, body = spec
    t = time.time()
    box["t_send"] = t
    def run():
        r = send_sync(spec)
        box["t_ack"] = r["t_ack"]; box["ok"] = r["ok"]
    th = threading.Thread(target=run, daemon=True); th.start()
    box["_th"] = th
    return box


def strike_capture(actions, tag, length=2.5):
    return L.run_capture(ws, actions, note=NOTE, vel=VEL, t_note=None, length_s=length, tag=tag)  # no anchor note


def strike_onsets(x, start):
    return L.onset(x, start, noise_win=1200)


def compare(xa, ia, xb, ib, n=9600):
    sh = L.align(xa, xb, ia, ib, n=2400, search=128)
    a = xa[ib - sh: ib - sh + n].astype(np.float64)
    b = xb[ib: ib + n].astype(np.float64)
    m = min(len(a), len(b))
    d = b[:m] - a[:m]
    return float(np.sqrt(np.mean(d ** 2)) / (np.sqrt(np.mean(b[:m] ** 2)) + 1e-12)), sh


def classify(x, i, refs):
    eo, _ = compare(refs["old"][0], refs["old"][1], x, i)
    en, _ = compare(refs["new"][0], refs["new"][1], x, i)
    cls = "old" if eo < 1e-3 else ("new" if en < 1e-3 else "mixed")
    return cls, eo, en


results = {}
for name, (new, old) in CASES.items():
    if FILT and not (FILT == name or (FILT.endswith("*") and name.startswith(FILT[:-1]))):
        continue
    # references (strike at 0.3 s; 'new' strike 1.5 s after the change was acked)
    def ref(kind):
        acts = []
        if kind == "new":
            acts.append((0.05, lambda: send_sync(new)))
        acts.append((0.3 if kind == "old" else 1.6, lambda: {"t_send": ws.play(NOTE, VEL)}))
        t = strike_capture(acts, f"exp04_{name}_ref{kind}".replace("|", "_"), length=2.5)
        ws.play(NOTE, 0, 128)
        if kind == "new":
            send_sync(old)
        i = strike_onsets(t["x"], int((0.25 if kind == "old" else 1.55) * L.FS))
        return t["x"], i
    refs = {"old": ref("old"), "new": ref("new")}
    sep, _ = compare(refs["old"][0], refs["old"][1], refs["new"][0], refs["new"][1])
    print(name, "old/new separation (rel rms diff)", round(sep, 4), flush=True)
    rows = []
    for rep in range(REPS):
        for d in DELAYS:
            box = {}
            def chg():
                b = send_async(new); box["b"] = b; return {"t_send": b["t_send"]}
            def strike():
                return {"t_send": ws.play(NOTE, VEL)}
            length = 2.5 if d < 1500 else 0.6 + d / 1000 + 0.6
            t = strike_capture([(0.3, chg), (0.3 + d / 1000.0, strike)], f"exp04_{name}_d{d}_r{rep}".replace("|", "_"), length)
            ws.play(NOTE, 0, 128)
            box = box["b"]
            box["_th"].join(timeout=120)
            send_sync(old)
            t_strike = t["acts"][1]["t_send"]
            i = strike_onsets(t["x"], int((0.3 + d / 1000.0 - 0.05) * L.FS))
            cls, eo, en = classify(t["x"], i, refs)
            row = {"d_ms": d, "rep": rep, "class": cls, "err_old": eo, "err_new": en,
                   "strike_minus_send_ms": (t_strike - box["t_send"]) * 1e3,
                   "ack_ms": (box.get("t_ack", np.nan) - box["t_send"]) * 1e3, "ok": box.get("ok"),
                   "strike_before_ack": bool(t_strike < box.get("t_ack", 1e18)), "wav": t["wav"]}
            rows.append(row)
            print(name, rep, d, cls, round(eo, 4), round(en, 4), "ack", round(row["ack_ms"], 1), flush=True)
    by_d = {}
    for r in rows:
        by_d.setdefault(r["d_ms"], []).append(r["class"])
    # latency: smallest d from which every strike is 'new'
    lat = None
    for d in sorted(by_d):
        if all(c == "new" for dd in sorted(by_d) if dd >= d for c in by_d[dd]):
            lat = d
            break
    results[name] = {"separation": sep, "by_delay": by_d, "first_all_new_delay_ms": lat,
                     "ack": L.stats([r["ack_ms"] for r in rows]), "rows": rows}
    print("SUMMARY", name, json.dumps({k: v for k, v in results[name].items() if k != "rows"}, default=float), flush=True)
    L.save_json(f"exp04_excitation_{FILT or 'all'}.json".replace("|", "_"), results)
ws.close()
