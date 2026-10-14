"""dev-960f: measure Sound-Channel editing EXACTLY as the frontend does it, on any backend.

The FE (PianoidTunner usePreset.js + useSoundChannels.js) edits the two Sound-Channel axes with
these REST calls (their PARAM_TRANSPORT is 'rest'); this script replays them byte-for-byte:

  strings axis (listen_to_modes=0) value  POST /set_parameter/feedback/<128+ch>       {"<128+ch>": [num_modes]}
  strings axis mute (F6 mask)             POST /set_parameter/feedback_mask/<128+ch>  {"<128+ch>": [0/1 x num_modes]}
  strings axis whole matrix               POST /set_parameter/feedback/output         {"128": [...], ...}
  modes axis (listen_to_modes=1) value    POST /set_parameter/sound_channel/<pitch>   {"<pitch>": [num_channels]}
  modes axis mute                         POST /set_parameter/sound_channel_mask/<pitch>

Per step: HTTP code, GET read-back == written, and (when the backend broadcasts) the state events.
Then save -> full reload of the saved file -> every edit read back again, and a note_playback render
of p60 (saved to <out>.npz for a dev-vs-branch comparison). Also probes the SEPARATE
`string_sound_channel` parameter (per-output-channel strings-mode gain table) that the FE never uses.

Usage: python dev-960f-sc-edit.py <base_url> <saved_preset_abs_path> <out_prefix>
"""
import json
import sys
import time
import urllib.error
import urllib.request

import numpy as np
import socketio

BASE, SAVED, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
LOAD = {"path": "presets/BaselinePreset1.json", "listen_to_midi": 0, "use_simulation": 0,
        "debug_mode": 0, "audio_driver_type": 0, "cycle_iterations": 64, "audio_buffer_size": 4,
        "array_size": 384, "sample_rate": 48, "string_iterations": 4, "volume": 100,
        "audio_on": 0, "start_right_away": 0, "listen_to_modes": 0}
EVENTS = ('state_changed', 'preset_changed', 'session_changed', 'domain_invalidated')
received = []


def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw.decode(errors="replace")[:160]


def get(param, key):
    code, body = call("GET", f"/get_parameter/{param}/{key}")
    assert code == 200, (param, key, code, body)
    return body


def drain():
    time.sleep(0.25)
    got = [(n, p.get('domain') or p.get('kind'), p.get('keys'), p.get('after')) for n, p in received]
    received.clear()
    return got


results = {}


def report(name, ok, detail=""):
    results[name] = bool(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")


sio = socketio.Client()
for ev in EVENTS:
    sio.on(ev, (lambda n: lambda p: received.append((n, p)))(ev))
sio.connect(BASE, transports=['websocket'])

call("POST", "/load_preset", dict(LOAD, listen_to_modes=1))     # guarantee the next one is FULL
code, _ = call("POST", "/load_preset", LOAD)
assert code == 200
drain()

# ---- strings axis value: feedback row of output channel 1 (key 129) ---------------------------
row = get("feedback", 129)["129"]
new_row = [round(v * 0.5 + 3.0, 6) for v in row]
code, _ = call("POST", "/set_parameter/feedback/129", {"129": new_row})
ev = drain()
back = get("feedback", 129)["129"]
report("strings value  POST feedback/129", code == 200 and back == new_row,
       f"code={code} readback_equal={back == new_row} events={[(e[0], e[1], e[2]) for e in ev]}")
results['ev_strings_value'] = ev

# ---- strings axis mute: feedback_mask row 129 -------------------------------------------------
mask = get("feedback_mask", 129)["129"]
new_mask = [0.0 if i % 3 == 0 else 1.0 for i in range(len(mask))]
code, _ = call("POST", "/set_parameter/feedback_mask/129", {"129": new_mask})
ev = drain()
back = get("feedback_mask", 129)["129"]
raw_after = get("feedback", 129)["129"]
report("strings mute   POST feedback_mask/129", code == 200 and back == new_mask and raw_after == new_row,
       f"code={code} mask_equal={back == new_mask} raw_untouched={raw_after == new_row} events={[(e[0], e[1], e[2]) for e in ev]}")

# ---- strings axis whole matrix: feedback/output ----------------------------------------------
whole = {k: v for k, v in get("feedback", "output").items() if k.isdigit()}
whole2 = {k: [round(x * 1.1, 6) for x in v] for k, v in whole.items()}
code, _ = call("POST", "/set_parameter/feedback/output", whole2)
ev = drain()
back = {k: v for k, v in get("feedback", "output").items() if k.isdigit()}
report("strings whole  POST feedback/output", code == 200 and back == whole2,
       f"code={code} channels={sorted(whole2)} readback_equal={back == whole2} events={[(e[0], e[1], e[2]) for e in ev]}")
expect_feedback = back

# ---- modes axis value + mute: sound_channel / sound_channel_mask pitch 60 ---------------------
sc = get("sound_channel", 60)["60"]
new_sc = [round(v * 0.7 + 0.05, 6) for v in sc]
code, _ = call("POST", "/set_parameter/sound_channel/60", {"60": new_sc})
ev = drain()
back = get("sound_channel", 60)["60"]
report("modes value    POST sound_channel/60", code == 200 and back == new_sc,
       f"code={code} readback_equal={back == new_sc} events={[(e[0], e[1], e[2]) for e in ev]}")
scm = get("sound_channel_mask", 60)["60"]
new_scm = [0.0] + [1.0] * (len(scm) - 1)
code, _ = call("POST", "/set_parameter/sound_channel_mask/60", {"60": new_scm})
ev = drain()
back = get("sound_channel_mask", 60)["60"]
report("modes mute     POST sound_channel_mask/60", code == 200 and back == new_scm,
       f"code={code} readback_equal={back == new_scm} events={[(e[0], e[1], e[2]) for e in ev]}")

# ---- audible effect: render p60 with the edited channels -------------------------------------
code, body = call("POST", "/get_chart_test", {"chartType": "note_playback", "pitch": 60, "velocity": 100,
                                               "duration_ms": 600, "display_length_ms": 600})
assert code == 200, (code, body)
edited_render = np.asarray(body["data"][0], dtype=float)

# ---- save -> FULL reload of the saved file -> read back ---------------------------------------
code, body = call("POST", "/save_preset", {"path": SAVED})
report("save_preset", code == 200, f"code={code} path={body.get('path') if isinstance(body, dict) else body}")
code, body = call("POST", "/load_preset", dict(LOAD, path=SAVED))
report("reload saved preset (full)", code == 200 and body.get('reinit') == 'full', f"code={code} reinit={body.get('reinit')}")
drain()
fb = {k: v for k, v in get("feedback", "output").items() if k.isdigit()}
report("after reload: feedback output rows", fb == expect_feedback, f"equal={fb == expect_feedback}")
report("after reload: feedback_mask/129", get("feedback_mask", 129)["129"] == new_mask)
report("after reload: sound_channel/60", get("sound_channel", 60)["60"] == new_sc)
report("after reload: sound_channel_mask/60", get("sound_channel_mask", 60)["60"] == new_scm)

# ---- the SEPARATE string_sound_channel parameter (FE never sends it) -------------------------
code_g, _ = call("GET", "/get_parameter/string_sound_channel/129")
code_o, ssc = call("GET", "/get_parameter/string_sound_channel/output")
rows = {k: v for k, v in ssc.items() if k.isdigit()} if isinstance(ssc, dict) else {}
code_p, _ = call("POST", "/set_parameter/string_sound_channel/output", rows)
print(f"INFO  string_sound_channel: GET /129 -> {code_g} | GET /output -> {code_o} rows={sorted(rows)} "
      f"| POST /output (same values) -> {code_p}")

np.savez(OUT + ".npz", edited_render=edited_render)
json.dump({k: v for k, v in results.items() if isinstance(v, bool)}, open(OUT + ".json", "w"))
sio.disconnect()
print("RESULT:", "ALL PASS" if all(v for v in results.values() if isinstance(v, bool)) else "FAILURES")
