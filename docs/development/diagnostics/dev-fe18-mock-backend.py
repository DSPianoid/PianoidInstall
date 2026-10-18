"""dev-fe18: mock Pianoid backend for live FE verification without a GPU.

Serves the editor state captured in a manual bug report (configSnapshot) over the
same REST + socket.io surface the Tunner FE bootstraps from, on a spare port. Writes
are accepted (and applied to the in-memory state, so a re-fetch sees them) and logged
with a timestamp, so the edit -> write path can be timed in a real browser.

Usage (PianoidCore venv, no engine import):
  python -u dev-fe18-mock-backend.py <bug-report.json> [port=5013]
The FE page must be loaded with an init script that rewrites 127.0.0.1:5000 / :3001 /
:5001 / :3002 to this port (see dev-fe18 session log).
"""
import json
import sys
import time

from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_socketio import SocketIO

report = json.load(open(sys.argv[1], encoding="utf-8"))
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 5013
cs = report["configSnapshot"]
P = cs["params"]
meta = cs["meta"]
HAMMER_KEYS = ("hammer_position", "hammer_radius", "hammer_shape", "hammer_sharpness",
               "hammer_width", "hammer_width_effective")

hammer = {p: {"hammer": {k: v for k, v in e.items() if k in HAMMER_KEYS}} for p, e in P["excitation"].items()}
gauss = {p: {k: v for k, v in e.items() if k not in HAMMER_KEYS} for p, e in P["excitation"].items()}
WRITES = []
LAST_REPORT = {}

app = Flask(__name__)
CORS(app)
sio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")


def log_write(src, kind, key, values):
    WRITES.append({"t": time.time(), "src": src, "kind": kind, "key": key})
    print(f"WRITE {time.time():.3f} {src} {kind}/{key} {json.dumps(values)[:160]}", flush=True)
    if kind == "hammer" and isinstance(values, dict):
        for p, frag in values.items():
            if p in hammer and isinstance(frag, dict):
                hammer[p]["hammer"].update(frag)


@app.route("/health")
@app.route("/ping")
def health():
    h = cs["health"]
    return jsonify({
        "status": "healthy", "pianoid_loaded": True, "backend_thread_running": True,
        "cpp_module_responsive": True, "exception": False, "listen_mode": False,
        "message": h.get("message"), "available_notes_count": len(meta["availableNotes"]),
        "gpu_initialized": True, "main_loop_should_continue": True, "audio_driver_active": True,
        "single_deck_matrix": h.get("singleDeckMatrix", True), "stored_feedback_coeff": 1,
        "gpu_available": True, "modulation_constants": h.get("modulationConstants"),
        "lifecycle": {"state": "running"},
    })


@app.route("/get_available_notes")
def notes():
    return jsonify(meta["availableNotes"] + [128 + c for c in meta["availableOutputChanels"]])


GET_MAP = {
    ("string", "all"): lambda: P["strings"],
    ("mode", "all"): lambda: P["modes"],
    ("hammer", "all"): lambda: hammer,
    ("gauss", "all"): lambda: gauss,
    ("feedin", "all"): lambda: P["feedInMatrix"],
    ("feedback", "all"): lambda: P["feedbackMatrix"],
    ("feedin_mask", "all"): lambda: P["masks"]["feedIn"],
    ("feedback_mask", "all"): lambda: P["masks"]["feedback"],
    ("sound_channel", "all"): lambda: P["soundChannelData"],
    ("feedback", "output"): lambda: P["soundChannelFeedbackMatrix"],
    ("sound_channel_mask", "all"): lambda: P["masks"]["soundChannel"],
    ("feedback_mask", "output"): lambda: P["masks"]["soundChannelFeedback"],
}


@app.route("/get_parameter/<param>/<key>")
def get_parameter(param, key):
    fn = GET_MAP.get((param, key))
    if fn:
        return jsonify(fn())
    if param == "excitation" and key in gauss:
        return jsonify({key: {**gauss[key], "hammer": hammer[key]["hammer"]}})
    return jsonify({"message": "mock: unsupported"}), 416


@app.route("/set_parameter/<param>/<key>", methods=["POST"])
def set_parameter(param, key):
    log_write("rest", param, key, request.get_json(silent=True))
    return jsonify({"message": "OK", "cfl_redline": False})


@app.route("/get_runtime_parameters")
def runtime():
    return jsonify(cs["runtimeParams"])


@app.route("/preset/list")
def preset_list():
    return jsonify({"presets": cs["preset"]["libraryPresets"], "active": cs["preset"]["activePreset"]})


@app.route("/get_settings")
def get_settings():
    return jsonify(cs["preset"].get("presetLoadSettings") or {})


@app.route("/graph_names")
def graph_names():
    return jsonify({"graphs": [], "actions": []})


@app.route("/bug_report", methods=["POST"])
def bug_report():
    r = request.get_json(silent=True) or {}
    rid = r.get("reportId", "x")
    print(f"BUG_REPORT {rid} {len(json.dumps(r))} bytes", flush=True)
    LAST_REPORT.clear()
    LAST_REPORT.update(r)
    return jsonify({"ok": True, "saved": f"bugreport-{r.get('createdAt','')}-manual-{rid}.json"})


@app.route("/mock/last_report_actions")
def last_report_actions():
    return jsonify(LAST_REPORT.get("actionHistory", []))


@app.route("/mock/writes")
def writes():
    return jsonify(WRITES)


@app.route("/", defaults={"path": ""}, methods=["GET", "POST"])
@app.route("/<path:path>", methods=["GET", "POST"])
def fallback(path):
    print(f"UNHANDLED {request.method} /{path}", flush=True)
    if request.method == "POST":
        return jsonify({"ok": True, "message": "OK"})
    return jsonify({}), 200


@sio.on("hello")
def on_hello(data):
    return {"ok": True, "resync": True, "boot": "mock", "seq": 0, "events": []}


@sio.on("set_parameter")
def on_set_parameter(data):
    data = data or {}
    log_write("ws", data.get("parameter"), data.get("key"), data.get("values"))
    return {"ok": True}


@sio.on_error_default
def on_error(e):
    print("SIO error", e, flush=True)


@sio.on("*")
def any_event(event, data=None):
    print(f"SIO {event}", flush=True)
    return {"ok": True}


if __name__ == "__main__":
    sio.run(app, host="127.0.0.1", port=PORT, allow_unsafe_werkzeug=True)
