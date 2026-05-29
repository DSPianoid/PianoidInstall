"""dev-8085 — REAL ONLINE PATH reproduction: WebSocket handle_ws_play vs REST /play.

The user reports the no-decay bug across ALL play methods (mouse/MIDI/space). The
frontend's playNote (usePreset.js:1308) sends every note via socket.emit('play')
FIRST (REST only as fallback) — so the real browser path is the WS handle_ws_play
handler, which has a per-sid DEDUP (backendServer.py:356-363) that REST /play lacks.
Prior passes drove REST or direct schedule_event and missed this.

This harness drives the SAME running backend two ways and compares decay:
  WS   : python-socketio Client emits the EXACT browser JSON 'play' events.
  REST : POST /play (the fallback path / what prior passes used).

Per pitch: /capture reset -> NOTE_ON -> hold -> /capture read (DURING) ->
NOTE_OFF -> wait -> /capture read (AFTER). Decay = after_tail / during. A stuck
note => after-energy persists. seg_stats also reports peak_attack/peak_tail
within each capture (robust to ring position).

REST-ONLY for measurement reads (chart@sound); note INPUT is WS or REST per leg.
Read-only w.r.t. the user's stack (just plays notes + reads charts, like the UI).

Usage: PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-8085-ws-vs-rest-repro.py
       [--port=5000] [--pitches=55,56,57] [--on-ms=1200] [--wait-ms=2500]
"""
import sys, json, time, base64, struct, math
import urllib.request, urllib.error
import socketio

PORT = "5000"
PITCHES = [55, 56, 57]
ON_MS = 1200
WAIT_MS = 2500
VEL = 100
for a in sys.argv[1:]:
    if a.startswith("--port="): PORT = a.split("=", 1)[1]
    elif a.startswith("--pitches="): PITCHES = [int(x) for x in a.split("=", 1)[1].split(",")]
    elif a.startswith("--on-ms="): ON_MS = int(a.split("=", 1)[1])
    elif a.startswith("--wait-ms="): WAIT_MS = int(a.split("=", 1)[1])
BASE = f"http://127.0.0.1:{PORT}"


def _post(path, payload, timeout=60):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def _get(path, timeout=30):
    try:
        with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, {}


def reset_records():
    _post("/capture", {}); time.sleep(0.2)


def capture_sound(length=240000, channel=0):
    st, body = _post("/get_chart_test", {"chartType": "sound", "length": length, "channel": channel})
    try:
        d = json.loads(body)
    except Exception:
        return []
    data = d.get("data")
    if isinstance(data, list) and data and isinstance(data[0], list):
        return data[0]
    return []


def rms(xs): return math.sqrt(sum(x*x for x in xs)/len(xs)) if xs else 0.0
def peak(xs): return max((abs(x) for x in xs), default=0.0)
def seg_stats(xs, label):
    n = len(xs)
    if n == 0: return f"{label}: EMPTY"
    seg = max(1, n//8)
    pa, pt = peak(xs[:seg]), peak(xs[-seg:])
    return (f"{label}: n={n} rms={rms(xs):.4e} peak={peak(xs):.4e} "
            f"peak_attack={pa:.4e} peak_tail={pt:.4e} tail/attack={(pt/pa if pa>0 else 0):.4f}")


# ---- Socket.IO client (the REAL browser play transport) ----
sio = socketio.Client(logger=False, engineio_logger=False)
ws_errors = []
@sio.event
def connect(): pass
@sio.event
def connect_error(data): ws_errors.append(f"connect_error: {data}")
@sio.on('error')
def on_err(data): ws_errors.append(f"server error: {data}")


def ws_play(pitch, command, velocity=VEL):
    # EXACT browser payload shape (usePreset.playNote -> socketEmit('play', payload))
    sio.emit('play', {"pitch": pitch, "velocity": velocity, "command": command, "delay_ms": 0})


def rest_play(pitch, command, velocity=VEL):
    _post("/play", {"pitch": pitch, "velocity": velocity, "command": command, "delay_ms": 0})


def run_leg(play_fn, leg_name):
    print(f"\n========== {leg_name} path ==========", flush=True)
    out = {}
    for pt in PITCHES:
        reset_records()
        play_fn(pt, 144, VEL)
        time.sleep(ON_MS/1000)
        during = capture_sound()
        play_fn(pt, 128, 0)
        time.sleep(WAIT_MS/1000)
        after = capture_sound()
        rd, ra = rms(during), rms(after)
        ratio = (ra/rd) if rd > 0 else 0.0
        verdict = "STUCK (no decay)" if ratio > 0.25 else "decays"
        print(f"  p{pt}: " + seg_stats(during, "DURING"), flush=True)
        print(f"  p{pt}: " + seg_stats(after, "AFTER "), flush=True)
        print(f"  p{pt}: >>> after/during RMS = {ratio:.3f}  ({verdict})", flush=True)
        out[pt] = {"during_rms": rd, "after_rms": ra, "ratio": ratio}
    return out


st, h = _get("/health")
print(f"/health {st} loaded={h.get('pianoid_loaded')} driver={h.get('lifecycle',{}).get('audio_driver_active')} listen={h.get('listen_mode')}", flush=True)

# connect WS
try:
    sio.connect(BASE, wait_timeout=10)
    print(f"WS connected sid={sio.sid}", flush=True)
except Exception as e:
    print(f"WS connect FAILED: {e}", flush=True); sys.exit(2)

res = {}
res["WS"] = run_leg(ws_play, "WEBSOCKET (real browser path, handle_ws_play + dedup)")
res["REST"] = run_leg(rest_play, "REST /play (fallback path / prior-pass surface)")

print("\n===== WS vs REST SUMMARY =====", flush=True)
for pt in PITCHES:
    w = res["WS"][pt]["ratio"]; r = res["REST"][pt]["ratio"]
    flag = "  <-- WS STUCK, REST OK = WS-path defect!" if (w > 0.25 and r <= 0.25) else ""
    print(f"  p{pt}: WS after/during={w:.3f}  REST after/during={r:.3f}{flag}", flush=True)
if ws_errors:
    print(f"WS errors: {ws_errors[:5]}", flush=True)
try:
    sio.disconnect()
except Exception:
    pass
print("\ndone", flush=True)
