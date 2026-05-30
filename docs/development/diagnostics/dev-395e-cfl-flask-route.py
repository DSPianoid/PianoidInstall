"""
dev-395e: DEFINITIVE offline test of the LIVE HTTP path. Drives the REAL Flask route
POST /set_parameter/string/<pitch> via Flask's test client (in-process, NO port bind, NO GPU) with an
over-edge tension, and checks the HTTP status. This exercises: the real route handler + parse_range +
_apply_parameter_request + ParameterUpdateRequest + pianoid.apply_parameter_request -> the REAL
ParameterManager gate -> CflRejected -> the real @app.errorhandler(CflRejected) -> 400.

A minimal fake `pianoid` provides exactly what the route needs (get_all_pitches_in_preset, mp,
apply_parameter_request) and delegates apply_parameter_request to a REAL ParameterManager (GPU upload
no-op'd; the gate runs BEFORE upload). This is the closest possible reproduction of the user's live
Strings-panel tension edit WITHOUT bringing up a server.

If this returns 400 -> the gate IS wired on the real HTTP route (the user's live backend must have been
running pre-gate code = stale process). If it returns 200/416 -> a real wiring bug in the route path.

Run: cd PianoidCore && unset VIRTUAL_ENV && ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-395e-cfl-flask-route.py
"""
import os, sys, json, io, contextlib
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(REPO, "PianoidBasic", "Pianoid"))
sys.path.insert(0, os.path.join(REPO, "PianoidBasic"))
sys.path.insert(0, os.path.join(REPO, "PianoidCore", "pianoid_middleware"))

from StringMap import StringMap
from ModelParams import ModelParameters
from parameter_manager import ParameterManager

PRESET = os.path.join(REPO, "PianoidCore", "pianoid_middleware", "presets", "Belarus_8band_196modes-MFeq.json")
with open(PRESET) as f:
    save = json.load(f)
mp = ModelParameters(); mp.update_params(**save['model_parameters'])
with contextlib.redirect_stdout(io.StringIO()):
    sm = StringMap(mp, **save)
pm = ParameterManager(pianoid=None, sm=sm, modes=None, mp=mp, cuda_lock=None)
# GPU upload no-op (gate runs before this; we only want the gate's verdict on the real route)
applied = []
pm.update_pitch_physical_params_GRANULAR = lambda pitchID, send_to_cuda=True, **p: applied.append((int(pitchID), dict(p)))

P = 99
bt = float(sm.pitches[P].physics.tension)
piano_pitches = sorted(p for p in sm.pitches if 21 <= p <= 108)


class FakePianoid:
    """Minimal surface the set_parameter route + parse_range need; delegates to the REAL gate."""
    def __init__(self, pm, mp, sm):
        self._pm = pm; self.mp = mp; self._sm = sm
        self.exception = False
    def get_all_pitches_in_preset(self, key_pitches=False, sound_pitches=False):
        if sound_pitches:
            return sorted(p for p in self._sm.pitches if p >= 128)
        return piano_pitches
    def apply_parameter_request(self, request):
        # mirror Pianoid.apply_parameter_request (minus _assert_active_editable, which only BLOCKS earlier)
        return self._pm.apply(request)


# Import the real Flask app and inject the fake pianoid
import backendServer
backendServer.pianoid = FakePianoid(pm, mp, sm)
app = backendServer.app
app.config['TESTING'] = True
client = app.test_client()


def post(pitch, body):
    with contextlib.redirect_stdout(io.StringIO()):
        resp = client.post(f"/set_parameter/string/{pitch}", json=body)
    try:
        data = resp.get_json()
    except Exception:
        data = resp.data.decode(errors='replace')[:200]
    return resp.status_code, data


print(f"REAL Flask route POST /set_parameter/string/<pitch> (in-proc test client, no port, no GPU)")
print(f"pitch {P} baseline tension={bt:.1f}; gate edge ~21.7x\n")

print("--- BELOW edge (x10): expect 200 OK, applied ---")
applied.clear()
sc, data = post(P, {str(P): {"tension": bt * 10}})
print(f"  status={sc}  body={data}  applied={len(applied)}")

print("\n--- OVER edge (x50): expect 400 cfl_unstable IF the route is gated ---")
applied.clear()
sc, data = post(P, {str(P): {"tension": bt * 50}})
print(f"  status={sc}  applied={len(applied)}")
print(f"  body={json.dumps(data) if isinstance(data, dict) else data}")
if sc == 400 and isinstance(data, dict) and data.get('code') == 'cfl_unstable':
    print("  => GATE FIRES on the real HTTP route. (User's live backend must have run PRE-gate code.)")
elif sc in (200, 416) and len(applied):
    print("  => ★GATE BYPASSED on the real route — the over-edge edit was APPLIED. REAL WIRING BUG.")
else:
    print(f"  => unexpected: status={sc}, applied={len(applied)} — inspect.")

print("\n--- WS handler path (set_parameter event) over edge: expect emitted error code cfl_unstable ---")
# socketio test client
try:
    from backendServer import socketio
    sio = socketio.test_client(app)
    sio.get_received()  # drain connect
    with contextlib.redirect_stdout(io.StringIO()):
        sio.emit('set_parameter', {'parameter': 'string', 'key': str(P), 'values': {str(P): {'tension': bt * 50}}})
        rec = sio.get_received()
    errs = [r for r in rec if r.get('name') == 'error']
    print(f"  received events: {[r.get('name') for r in rec]}")
    if errs:
        print(f"  error payload: {json.dumps(errs[0]['args'][0]) if errs[0].get('args') else errs[0]}")
    else:
        print("  ★NO error event emitted over WS for an over-edge tension — WS path may bypass the gate.")
except Exception as e:
    print(f"  (WS test-client unavailable: {type(e).__name__}: {e})")
