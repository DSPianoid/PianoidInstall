"""exp05 - mechanism check for the bimodal string-physics latency (~15 ms or ~1 s).
Hypothesis (from Pianoid_parameters.cu:541 + Pianoid_synthesis.cu:300): a string-physics upload
raises new_notes_ind=1 right after QUEUING the async double-buffer upload; the engine drains the
flag at its next cycle and runs parameterKernel on the not-yet-swapped buffer, so the change is
heard only at the NEXT note event (which re-runs parameterKernel).
Test: tension x1.02 on held p60 at t=1.0 s; a silent event (pitch 127 NOTE_ON) at t=1.0+X s.
If the hypothesis holds, latency tracks X (when the race is lost) instead of the 2.0 s marker
note-off. X = none (marker only), 150, 400, 700 ms.
"""
import json
import sys
import time

import numpy as np

import latlib as L

L.SCHED_TO_IN8_S = 0.0203125
REPS = int(sys.argv[1]) if len(sys.argv) > 1 else 4
FIELD = sys.argv[2] if len(sys.argv) > 2 else "tension"
FACT = float(sys.argv[3]) if len(sys.argv) > 3 else 1.02
ws = L.WS()
s60 = L.get("/get_parameter/string/60")["60"]
new = {"parameter": "string", "key": "60", "values": {"60": {FIELD: s60[FIELD] * FACT}}}
old = {"parameter": "string", "key": "60", "values": {"60": {FIELD: s60[FIELD]}}}


def chg():
    ack, a, b = ws.emit_ack("set_parameter", new)
    return {"t_send": a, "t_ack": b}


def poke():
    t = ws.play(127, 1)
    return {"t_send": t}


analyse = L.analyse

res = {}
ref = L.run_capture(ws, [], note=60, vel=100, length_s=2.5, tag=f"exp05_{FIELD}_ref")
for X in [None, 150, 400, 700]:
    rows = []
    for rep in range(REPS):
        acts = [(1.0, chg)]
        if X is not None:
            acts.append((1.0 + X / 1000.0, poke))
        t = L.run_capture(ws, acts, note=60, vel=100, length_s=2.5, tag=f"exp05_{FIELD}_X{X}_r{rep}")
        if X is not None:
            ws.play(127, 0, 128)
        ws.emit_ack("set_parameter", old)
        r = analyse(ref, t, t["acts"][0])
        r["poke_rel_ms"] = (t["acts"][1]["t_send"] - t["acts"][0]["t_send"]) * 1e3 if X is not None else None
        rows.append(r)
        print(FIELD, X, rep, round(r["lat_first_ms"] or -1, 1), "poke", r["poke_rel_ms"], flush=True)
    res[str(X)] = {"rows": rows, "lat_first": L.stats([r["lat_first_ms"] for r in rows])}
    print("SUMMARY", X, json.dumps(res[str(X)]["lat_first"]), flush=True)
L.save_json(f"exp05_trigger_{FIELD}.json", res)
ws.close()
