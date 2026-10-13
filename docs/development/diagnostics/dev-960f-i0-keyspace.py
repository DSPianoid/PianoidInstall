"""dev-960f I0: measure the parameter key spaces + stored-vs-effective rules against a LIVE backend.

Usage: python dev-960f-i0-keyspace.py [base_url]   (default http://127.0.0.1:5002)
Edits the ACTIVE (working-copy) preset and restores every value it touched. Prints one PASS/FAIL
line per measured fact (the evidence for the Data Model Card in the dev-960f session log).
"""
import json
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5002"


def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw.decode(errors="replace")


def get(param, key):
    return call("GET", f"/get_parameter/{param}/{key}")[1]


def post(param, key, values):
    return call("POST", f"/set_parameter/{param}/{key}", values)[0]


def report(fact, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {fact}  {detail}")


def changed_keys(before, after):
    return sorted(int(k) for k in before if k != "_meta" and before[k] != after.get(k))


health = call("GET", "/health")[1]
num_modes = len(get("mode", "all"))
pitches = sorted(int(k) for k in get("feedin", "all") if k != "_meta")
outputs = sorted(int(k) for k in get("feedback", "output") if k != "_meta")
print(f"preset={health.get('preset') or health.get('active_preset')} num_modes={num_modes} "
      f"piano pitches {pitches[0]}..{pitches[-1]} ({len(pitches)}) output pitches {outputs}")

# 1. feedin / feedback key_no = PITCH, row index = MODE
for matrix in ("feedin", "feedback"):
    before = get(matrix, "all")
    row = list(before["57"])
    edited = [v * 1.5 + 0.25 for v in row]
    code = post(matrix, "57", {"57": edited})
    after = get(matrix, "all")
    keys = changed_keys(before, after)
    report(f"{matrix}: key_no=57 addresses PITCH 57 (only row 57 changed), row length = num_modes",
           code == 200 and keys == [57] and len(row) == num_modes,
           f"code={code} changed={keys} row_len={len(row)}")
    post(matrix, "57", {"57": row})
    report(f"{matrix}: restore", get(matrix, "57")["57"] == row)

# 2. a mode number that is NOT a piano pitch is rejected for feedin (proves key != mode)
lo_mode = 3 if 3 not in pitches else None
if lo_mode is not None:
    code, body = call("POST", f"/set_parameter/feedin/{lo_mode}", {str(lo_mode): [1.0] * num_modes})
    report(f"feedin: key_no={lo_mode} (a valid MODE, not a piano pitch) -> 416", code == 416, f"code={code}")

# 3. output pitch key space: feedback/128 accepted, feedin/128 rejected
code, _ = call("POST", "/set_parameter/feedback/128", {"128": get("feedback", "128")["128"]})
report("feedback: output pitch 128 accepted (OUTPUT_PITCH_RAW_PARAMS)", code == 200, f"code={code}")
code, _ = call("POST", "/set_parameter/feedin/128", {"128": [0.0] * num_modes})
report("feedin: output pitch 128 rejected 416", code == 416, f"code={code}")
code, _ = call("GET", "/get_parameter/string_sound_channel/128")
report("string_sound_channel: output pitch 128 NOT addressable via /get_parameter/<p>/128 (only 'output')",
       code == 416, f"code={code}")

# 4. mode key_no = MODE number
before = get("mode", "all")
m5 = dict(before["5"])
code = post("mode", "5", {"5": {"frequency": m5["frequency"] * 1.01}})
after = get("mode", "all")
keys = changed_keys(before, after)
report("mode: key_no=5 addresses MODE 5 only", code == 200 and keys == [5], f"code={code} changed={keys}")
post("mode", "5", {"5": {"frequency": m5["frequency"]}})
report("mode: restore", abs(get("mode", "5")["5"]["frequency"] - m5["frequency"]) < 1e-9)

# 5. mask = stored independently; raw row untouched (stored vs effective)
raw = get("feedback", "57")["57"]
mask = get("feedback_mask", "57")["57"]
muted = [0.0] * len(mask)
code = post("feedback_mask", "57", {"57": muted})
raw_after = get("feedback", "57")["57"]
mask_after = get("feedback_mask", "57")["57"]
report("feedback_mask: write stores the mask; GET feedback (raw) unchanged",
       code == 200 and raw_after == raw and mask_after == muted, f"code={code}")
post("feedback_mask", "57", {"57": mask})
report("feedback_mask: restore", get("feedback_mask", "57")["57"] == mask)
code = post("feedback_mask", "128", {"128": get("feedback_mask", "128")["128"]})
report("feedback_mask: output pitch 128 accepted (derived key space)", code == 200, f"code={code}")

# 6. string: length in metres, tail derived = length/10 (not independently stored)
s = get("string", "60")["60"]
report("string: tail == length/10 (derived)", abs(s["tail"] - s["length"] / 10) < 1e-12,
       f"length={s['length']} tail={s['tail']}")
code = post("string", "60", {"60": {"length": s["length"] * 1.05}})
s2 = get("string", "60")["60"]
report("string: a length edit re-derives tail = length/10",
       code == 200 and abs(s2["tail"] - s2["length"] / 10) < 1e-12 and abs(s2["length"] - s["length"] * 1.05) < 1e-6,
       f"code={code} length={s2['length']} tail={s2['tail']}")
post("string", "60", {"60": {"length": s["length"]}})
report("string: restore length", abs(get("string", "60")["60"]["length"] - s["length"]) < 1e-9)

# 7. hammer: stored width vs effective; radius derived
h = get("hammer", "60")["60"]["hammer"]
report("hammer: hammer_width (stored) != hammer_width_effective (rendered) possible",
       "hammer_width_effective" in h and "hammer_radius" in h,
       f"stored={h['hammer_width']} effective={h['hammer_width_effective']} radius={h['hammer_radius']}")

# 8. sound_channel keyed by piano pitch (row = output channel)
sc = get("sound_channel", "60")
report("sound_channel: key = piano pitch, row length = num_channels",
       len(sc["60"]) == sc["_meta"]["num_channels"], f"meta={sc['_meta']}")

# 9. runtime volume_center: bare on the API, engine = bare x output_scale
rp = call("GET", "/get_runtime_parameters")[1]
report("runtime: effective_volume_center == volume_center x output_scale",
       abs(rp["effective_volume_center"] - rp["volume_center"] * rp["output_scale"]) / rp["effective_volume_center"] < 1e-6,
       f"bare={rp['volume_center']} scale={rp['output_scale']} eff={rp['effective_volume_center']}")
