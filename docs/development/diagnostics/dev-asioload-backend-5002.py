"""dev-asioload — run the real backend Flask app on a SPARE port (5002) for
end-to-end /health fallback verification, WITHOUT editing backendServer.py and
WITHOUT touching the user's stack (3000/3001; 5000 left free).

Imports the actual `app` + `socketio` from backendServer (so every route,
including /health and /load_preset, is the real one) and serves on 5002.

Run (detached, via Start-Process):
    cd PianoidCore/pianoid_middleware
    ../.venv/Scripts/python.exe ../../docs/development/diagnostics/dev-asioload-backend-5002.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
MIDDLEWARE = os.path.join(REPO_ROOT, "PianoidCore", "pianoid_middleware")
if MIDDLEWARE not in sys.path:
    sys.path.insert(0, MIDDLEWARE)
os.chdir(MIDDLEWARE)

# Import the real backend module (case-sensitive filename is backendServer.py).
import importlib
bs = importlib.import_module("backendServer")

PORT = int(os.environ.get("PIANOID_TEST_PORT", "5002"))
print(f"[dev-asioload] Starting REAL backend app on port {PORT} (spare port; user 5000 untouched)")
sys.stdout.flush()

# Mirror backendServer.__main__: socketio.run on the chosen port.
bs.socketio.run(bs.app, debug=False, host="127.0.0.1", port=PORT,
                allow_unsafe_werkzeug=True)
