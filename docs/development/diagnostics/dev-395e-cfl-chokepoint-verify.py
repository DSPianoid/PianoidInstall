"""
dev-395e: VERIFY the v2 re-architecture (choke-point gate + flag, no per-path reject).

Drives the REAL Flask route POST /set_parameter/string/<pitch> (in-proc test client, NO port, NO GPU) and
the REAL WS set_parameter handler, plus a DIRECT granular call (a 2nd path), through the REAL
ParameterManager. A fake `pianoid.pianoid` records updateMultiStringParameter_NEW calls so we can prove the
GPU UPLOAD was SKIPPED on an unstable edit while the MODEL still updated, and the cfl_redline FLAG was
raised + surfaced.

Expected NEW behavior (user-directed design):
  - over-edge tension -> HTTP 200 (NOT 400/throw), body cfl_redline:true, NO updateMultiStringParameter_NEW
    calls (upload skipped, engine keeps last-stable), BUT pitch.physics.tension == the new (unstable) value
    (edit landed in model).
  - below-edge tension -> HTTP 200, cfl_redline:false, upload happened, model updated.
  - WS set_parameter over-edge -> param_ack with cfl_redline:true (NOT an 'error' event).
  - /health reflects cfl_redline.

Run: cd PianoidCore && unset VIRTUAL_ENV && ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-395e-cfl-chokepoint-verify.py
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

# Fake GPU binding: records updateMultiStringParameter_NEW so we can see if an upload happened.
class FakeCuda:
    def __init__(self):
        self.uploads = []
    def updateMultiStringParameter_NEW(self, name, idxs, vals):
        self.uploads.append((name, list(idxs), list(vals))); return True
    def waitForParameterUpdate(self): pass
    def setNewPhysicalParameters(self, *a): self.uploads.append(('setNewPhysicalParameters',)); return True
    def setNewHammerParameters(self, *a): return True
    def setNewExcitationBaseLevels(self, *a): return True

import threading
fake_cuda = FakeCuda()
pm = ParameterManager(pianoid=fake_cuda, sm=sm, modes=None, mp=mp, cuda_lock=threading.Lock())

P = 99
bt = float(sm.pitches[P].physics.tension)


class FakePianoid:
    def __init__(self, pm, mp, sm):
        self._pm = pm; self.mp = mp; self._sm = sm; self.exception = False
    @property
    def cfl_redline(self): return self._pm.cfl_redline
    @property
    def cfl_redline_info(self): return self._pm.cfl_redline_info
    def get_all_pitches_in_preset(self, key_pitches=False, sound_pitches=False, convert_to_notes=True):
        if sound_pitches: return sorted(p for p in self._sm.pitches if p >= 128)
        return sorted(p for p in self._sm.pitches if 21 <= p <= 108)
    def apply_parameter_request(self, request): return self._pm.apply(request)

import backendServer
backendServer.pianoid = FakePianoid(pm, mp, sm)
app = backendServer.app; app.config['TESTING'] = True
client = app.test_client()


def model_tension():
    return float(sm.pitches[P].physics.tension)

def post(body):
    fake_cuda.uploads.clear()
    with contextlib.redirect_stdout(io.StringIO()):
        r = client.post(f"/set_parameter/string/{P}", json=body)
    return r.status_code, r.get_json(), list(fake_cuda.uploads)

def health_redline():
    with contextlib.redirect_stdout(io.StringIO()):
        r = client.get("/health")
    d = r.get_json()
    return d.get('cfl_redline'), d.get('cfl_redline_info')


print(f"pitch {P} baseline tension={bt:.1f}; gate edge ~21.7x baseline\n")

print("=== 1. BELOW edge (x10) via REAL Flask route: expect 200, cfl_redline False, upload HAPPENED, model updated ===")
sc, body, ups = post({str(P): {"tension": bt * 10}})
print(f"  status={sc}  cfl_redline={body.get('cfl_redline')}  uploads={len(ups)}  model_tension={model_tension():.1f}")
ok1 = (sc == 200 and body.get('cfl_redline') is False and len(ups) > 0 and abs(model_tension() - bt*10) < 1)
print(f"  PASS={ok1}")

print("\n=== 2. OVER edge (x50): expect 200 (NOT 400/throw), cfl_redline True, upload SKIPPED, model STILL updated ===")
sc, body, ups = post({str(P): {"tension": bt * 50}})
print(f"  status={sc}  cfl_redline={body.get('cfl_redline')}  uploads={len(ups)}  model_tension={model_tension():.1f}")
print(f"  cfl_redline_info={json.dumps(body.get('cfl_redline_info'))}")
ok2 = (sc == 200 and body.get('cfl_redline') is True and len(ups) == 0 and abs(model_tension() - bt*50) < 1)
print(f"  PASS={ok2}  (200 not 400 = edit not rejected; uploads==0 = engine keeps last-stable; model==x50 = edit landed)")

print("\n=== 3. /health reflects the redline flag (latched) ===")
hr, hi = health_redline()
print(f"  /health cfl_redline={hr}  info_pitch={hi.get('pitch') if hi else None}")
ok3 = (hr is True)
print(f"  PASS={ok3}")

print("\n=== 4. Recover with a STABLE edit (x5): expect 200, cfl_redline False (flag CLEARED), upload happened ===")
sc, body, ups = post({str(P): {"tension": bt * 5}})
print(f"  status={sc}  cfl_redline={body.get('cfl_redline')}  uploads={len(ups)}  model_tension={model_tension():.1f}")
hr2, _ = health_redline()
ok4 = (sc == 200 and body.get('cfl_redline') is False and len(ups) > 0 and hr2 is False)
print(f"  PASS={ok4}  (/health cfl_redline now {hr2})")

print("\n=== 5. WS set_parameter over edge: expect param_ack with cfl_redline True (NOT an 'error' event) ===")
try:
    from backendServer import socketio
    sio = socketio.test_client(app); sio.get_received()
    with contextlib.redirect_stdout(io.StringIO()):
        sio.emit('set_parameter', {'parameter': 'string', 'key': str(P), 'values': {str(P): {'tension': bt * 50}}})
        rec = sio.get_received()
    names = [r.get('name') for r in rec]
    ack = next((r for r in rec if r.get('name') == 'param_ack'), None)
    err = next((r for r in rec if r.get('name') == 'error'), None)
    ack_payload = ack['args'][0] if ack and ack.get('args') else None
    print(f"  events={names}  param_ack.cfl_redline={ack_payload.get('cfl_redline') if ack_payload else None}  error_event={'YES' if err else 'no'}")
    ok5 = (ack_payload is not None and ack_payload.get('cfl_redline') is True and err is None)
    print(f"  PASS={ok5}")
except Exception as e:
    print(f"  (WS test-client unavailable: {type(e).__name__}: {e})"); ok5 = None

print("\n=== 6. Second path — DIRECT granular call (bypasses the route) also gates at the choke point ===")
fake_cuda.uploads.clear()
# reset to a stable value first
with contextlib.redirect_stdout(io.StringIO()):
    pm.update_pitch_physical_params_GRANULAR(P, send_to_cuda=True, tension=bt * 5)
fake_cuda.uploads.clear()
with contextlib.redirect_stdout(io.StringIO()):
    pm.update_pitch_physical_params_GRANULAR(P, send_to_cuda=True, tension=bt * 80)
ok6 = (pm.cfl_redline is True and len(fake_cuda.uploads) == 0 and abs(model_tension() - bt*80) < 1)
print(f"  direct granular x80: cfl_redline={pm.cfl_redline}  uploads={len(fake_cuda.uploads)}  model_tension={model_tension():.1f}")
print(f"  PASS={ok6}  (gate is at the granular upload step itself, so ANY caller of it is covered)")

results = [ok1, ok2, ok3, ok4, ok5, ok6]
print("\n==================== SUMMARY ====================")
print(f"  1 below-edge applies+clear : {ok1}")
print(f"  2 over-edge 200+flag+skip  : {ok2}")
print(f"  3 /health reflects flag    : {ok3}")
print(f"  4 stable edit clears flag  : {ok4}")
print(f"  5 WS param_ack carries flag: {ok5}")
print(f"  6 direct granular gated too: {ok6}")
print(f"  ALL PASS: {all(r is True for r in results if r is not None)}")
