"""dev-midifit: GPU-free mock backend for the MIDI panel layout (no engine import).

Serves captured read-only GET bodies of a live backend (midi_mappings.json, midi_ports.json,
midi_input.json, midi_broadcast.json, controller.json — named after the route, "/" -> "_")
so the MIDI panel renders the user's real controls / mappings / ports. Writes are accepted
and logged, never applied. Everything else answers {}.

Usage (PianoidCore venv):  python -u dev-midifit-mock-midi-backend.py <capture-dir> [port=5080]
Point the page at it with the dev-2d06 URL rewrite (:5000|:5001|:3001|:3002 -> :<port>).
"""
import json
import os
import sys
import time

from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_socketio import SocketIO

CAPTURE = sys.argv[1]
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 5080

app = Flask(__name__)
CORS(app)
sio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")


def captured(route):
    path = os.path.join(CAPTURE, route.strip("/").replace("/", "_") + ".json")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@app.route("/health")
@app.route("/ping")
def health():
    return jsonify({"status": "healthy", "pianoid_loaded": True, "backend_thread_running": True,
                    "cpp_module_responsive": True, "exception": False, "gpu_initialized": True,
                    "audio_driver_active": False, "lifecycle": {"state": "running"}})


@app.route("/", defaults={"path": ""}, methods=["GET", "POST"])
@app.route("/<path:path>", methods=["GET", "POST"])
def any_route(path):
    if request.method == "POST":
        print(f"WRITE {time.time():.3f} /{path} {request.get_data(as_text=True)[:160]}", flush=True)
    body = captured(path) if request.method == "GET" else None
    return jsonify(body if body is not None else {})


if __name__ == "__main__":
    sio.run(app, host="127.0.0.1", port=PORT, allow_unsafe_werkzeug=True)
