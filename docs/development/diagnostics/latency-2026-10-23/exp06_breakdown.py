"""exp06 - backend stage breakdown with the timing shim (backend started with PYTHONPATH=shim,
LAT_TIMING_LOG=...). Each case: N WS edits (emitWithAck) + restores; the shim records per-stage
epoch intervals; stages inside [t_send, t_ack] on the handler thread are attributed to the edit.

usage: python exp06_breakdown.py [reps]
"""
import collections
import json
import sys
import time

import latlib as L

REPS = int(sys.argv[1]) if len(sys.argv) > 1 else 5
LOG = "D:/modal_measurements/latency-2026-10-23/timing.jsonl"
ws = L.WS()

s_all = L.get("/get_parameter/string/from21to108")
m_all = L.get("/get_parameter/mode/all")
gauss = L.get("/get_parameter/gauss/from21to108")
ham = L.get("/get_parameter/hammer/from21to108")
fi60 = L.get("/get_parameter/feedin/60")["60"]
fb128 = L.get("/get_parameter/feedback/128")["128"]
NM = len(fi60)


def sp(kind, key, values):
    return {"parameter": kind, "key": key, "values": values}


def rng(lo, hi):
    return f"from{lo}to{hi}" if hi > lo else str(lo)


def string_case(field, f, lo, hi):
    ks = [str(p) for p in range(lo, hi + 1) if str(p) in s_all]
    return (sp("string", rng(lo, hi), {k: {field: s_all[k][field] * f} for k in ks}),
            sp("string", rng(lo, hi), {k: {field: s_all[k][field]} for k in ks}))


def gauss_case(lo, hi):
    ks = [str(p) for p in range(lo, hi + 1) if str(p) in gauss]
    return (sp("excitation", rng(lo, hi), {k: {"127": {"2": {"volume": gauss[k]["127"]["2"]["volume"] * 0.5}}} for k in ks}),
            sp("excitation", rng(lo, hi), {k: {"127": {"2": {"volume": gauss[k]["127"]["2"]["volume"]}}} for k in ks}))


def hammer_case(lo, hi):
    ks = [str(p) for p in range(lo, hi + 1) if str(p) in ham]
    return (sp("hammer", rng(lo, hi), {k: {"hammer": {"hammer_position": 0.25}} for k in ks}),
            sp("hammer", rng(lo, hi), {k: {"hammer": {"hammer_position": ham[k]["hammer"]["hammer_position"]}} for k in ks}))


def mode_case(lo, hi):
    ks = [str(m) for m in range(lo, hi + 1)]
    return (sp("mode", rng(lo, hi), {k: {"frequency": m_all[k]["frequency"] * 1.02} for k in ks}),
            sp("mode", rng(lo, hi), {k: {"frequency": m_all[k]["frequency"]} for k in ks}))


CASES = {
    "string.tension|n1": string_case("tension", 1.02, 60, 60),
    "string.tension|n12": string_case("tension", 1.02, 55, 66),
    "string.tension|n88": string_case("tension", 1.02, 21, 108),
    "string.rho|n1": string_case("rho", 1.02, 60, 60),
    "gauss|n1": gauss_case(60, 60), "gauss|n8": gauss_case(57, 64), "gauss|n9": gauss_case(56, 64),
    "gauss|n12": gauss_case(55, 66), "gauss|n88": gauss_case(21, 108),
    "hammer|n1": hammer_case(60, 60), "hammer|n12": hammer_case(55, 66), "hammer|n88": hammer_case(21, 108),
    "mode|n1": mode_case(0, 0), "mode|n196": mode_case(0, NM - 1),
    "feedin60": (sp("feedin", "60", {"60": [v * 0.5 for v in fi60]}), sp("feedin", "60", {"60": fi60})),
    "sc_feedback128": (sp("feedback", "128", {"128": [v * 0.5 for v in fb128]}), sp("feedback", "128", {"128": fb128})),
    "runtime.volume": ({"volume": 90}, {"volume": 64}),
}

edits = []
for name, (new, old) in CASES.items():
    ev = "set_runtime_parameters" if name.startswith("runtime") else "set_parameter"
    for rep in range(REPS):
        ack, a, b = ws.emit_ack(ev, new, timeout=120)
        edits.append({"case": name, "kind": "edit", "t_send": a, "t_ack": b, "ok": isinstance(ack, dict) and ack.get("ok")})
        time.sleep(0.4)
        ack, a, b = ws.emit_ack(ev, old, timeout=120)
        edits.append({"case": name, "kind": "restore", "t_send": a, "t_ack": b})
        time.sleep(0.4)
    print(name, "ack ms", [round((e["t_ack"] - e["t_send"]) * 1e3, 1) for e in edits if e["case"] == name and e["kind"] == "edit"], flush=True)
ws.close()
time.sleep(1.5)  # let the shim flush

recs = [json.loads(l) for l in open(LOG)]
out = {}
for name in CASES:
    rows = []
    for e in [x for x in edits if x["case"] == name and x["kind"] == "edit"]:
        inside = [r for r in recs if r["t0"] >= e["t_send"] - 0.001 and r["t1"] <= e["t_ack"] + 0.001
                  and not r["th"].startswith("lat-")]
        agg = collections.defaultdict(lambda: [0.0, 0])
        for r in inside:
            agg[r["n"]][0] += (r["t1"] - r["t0"]) * 1e3
            agg[r["n"]][1] += 1
        rows.append({"ack_ms": (e["t_ack"] - e["t_send"]) * 1e3, "stages": {k: [round(v[0], 2), v[1]] for k, v in agg.items()}})
    # median per stage
    names = sorted({k for r in rows for k in r["stages"]})
    med = {}
    for k in names:
        vals = sorted(r["stages"].get(k, [0, 0])[0] for r in rows)
        cnts = sorted(r["stages"].get(k, [0, 0])[1] for r in rows)
        med[k] = {"ms_median": vals[len(vals) // 2], "ms_max": vals[-1], "calls_median": cnts[len(cnts) // 2]}
    out[name] = {"ack": L.stats([r["ack_ms"] for r in rows]), "stages_median": med, "rows": rows}
    print("\n==", name, "ack median", round(out[name]["ack"]["median"], 1))
    for k, v in sorted(med.items(), key=lambda kv: -kv[1]["ms_median"]):
        if v["ms_median"] >= 0.5 or v["calls_median"] > 1:
            print(f"   {k:48s} {v['ms_median']:8.2f} ms (max {v['ms_max']:8.2f})  calls {v['calls_median']}")
L.save_json("exp06_breakdown.json", out)
