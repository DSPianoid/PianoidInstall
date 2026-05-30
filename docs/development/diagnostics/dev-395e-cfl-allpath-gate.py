"""
dev-395e: VERIFY the ALL-PATH CFL choke gate (v3, user-directed 2026-05-30/31).

PURE PYTHON — NO GPU, NO Flask, NO socketio, NO engine. Builds the REAL StringMap model (CPU-only) from the
Belarus preset, constructs the REAL ParameterManager with a RECORDING mock CUDA binding, and drives ALL THREE
physical-parameter upload paths directly:
  (1) update_pitch_physical_params_GRANULAR  -> updateMultiStringParameter_NEW   (the Strings-panel path)
  (2) update_pitch_physical_params (BULK)     -> setNewPhysicalParameters         (MIDI-CC knob / auto-tune path)
  (3) send_updated_params_to_CUDA (BULK)      -> setUpdatedParameters             (all-strings repack)

For each: assert that an OVER-edge edit (a) raises cfl_redline, (b) performs ZERO uploads (engine keeps
last-stable), while the Python model STILL holds the edited value; and that a BELOW-edge edit uploads + clears
the flag. This proves the unstable coefficient is NEVER written to the engine by ANY path — which is the fix.

Run: cd PianoidCore && unset VIRTUAL_ENV && ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-395e-cfl-allpath-gate.py
"""
import os, sys, json, io, contextlib, threading

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


class FakeCuda:
    """Records every GPU-write so we can prove whether an upload happened."""
    def __init__(self):
        self.uploads = []
    def updateMultiStringParameter_NEW(self, name, idxs, vals):
        self.uploads.append(('updateMultiStringParameter_NEW', name)); return True
    def setNewPhysicalParameters(self, *a):
        self.uploads.append(('setNewPhysicalParameters',)); return True
    def setUpdatedParameters(self, *a):
        self.uploads.append(('setUpdatedParameters',)); return None  # void => success
    def setNewHammerParameters(self, *a): return True
    def setNewExcitationBaseLevels(self, *a): return True
    def waitForParameterUpdate(self): pass


fake = FakeCuda()
pm = ParameterManager(pianoid=fake, sm=sm, modes=None, mp=mp, cuda_lock=threading.Lock())

P = 99
bt = float(sm.pitches[P].physics.tension)


def model_tension():
    return float(sm.pitches[P].physics.tension)


def run(callable_, *args, **kwargs):
    fake.uploads.clear()
    with contextlib.redirect_stdout(io.StringIO()):
        try:
            callable_(*args, **kwargs)
        except Exception as e:
            return ('EXC', type(e).__name__, str(e))
    return list(fake.uploads)


print(f"pitch {P} baseline tension={bt:.1f}; gate edge ~21.7x baseline\n")
results = []

# ---- Path 1: GRANULAR (Strings-panel path) ----
print("=== PATH 1  GRANULAR update_pitch_physical_params_GRANULAR (Strings panel) ===")
ups = run(pm.update_pitch_physical_params_GRANULAR, P, send_to_cuda=True, tension=bt * 10)  # below edge -> upload
ok1a = (len(ups) > 0 and pm.cfl_redline is False)
print(f"  x10 below-edge : uploads={ups} cfl_redline={pm.cfl_redline} model={model_tension():.0f}  PASS={ok1a}")
ups = run(pm.update_pitch_physical_params_GRANULAR, P, send_to_cuda=True, tension=bt * 50)  # over edge -> SKIP
ok1b = (len(ups) == 0 and pm.cfl_redline is True and abs(model_tension() - bt*50) < 1)
print(f"  x50 OVER-edge  : uploads={ups} cfl_redline={pm.cfl_redline} model={model_tension():.0f} (kept) PASS={ok1b}")
print(f"  redline_info={json.dumps(pm.cfl_redline_info)}")
results += [ok1a, ok1b]

# recover to stable so model isn't left unstable for the next path's baseline read
run(pm.update_pitch_physical_params_GRANULAR, P, send_to_cuda=True, tension=bt * 3)

# ---- Path 2: BULK update_pitch_physical_params (MIDI-CC knob / auto-tune) ----
print("\n=== PATH 2  BULK update_pitch_physical_params (setNewPhysicalParameters; MIDI-CC/auto-tune path) ===")
ups = run(pm.update_pitch_physical_params, P, send_to_cuda=True, tension=bt * 8)  # below edge
# bulk path emits setNewPhysicalParameters + setNewHammerParameters + setNewExcitationBaseLevels; only the
# physical one is recorded by the fake; below-edge -> at least the physical upload present
ok2a = (any(u[0] == 'setNewPhysicalParameters' for u in ups) and pm.cfl_redline is False)
print(f"  x8 below-edge  : uploads={ups} cfl_redline={pm.cfl_redline} model={model_tension():.0f}  PASS={ok2a}")
ups = run(pm.update_pitch_physical_params, P, send_to_cuda=True, tension=bt * 60)  # over edge -> SKIP whole upload
ok2b = (len(ups) == 0 and pm.cfl_redline is True and abs(model_tension() - bt*60) < 1)
print(f"  x60 OVER-edge  : uploads={ups} cfl_redline={pm.cfl_redline} model={model_tension():.0f} (kept) PASS={ok2b}")
results += [ok2a, ok2b]

run(pm.update_pitch_physical_params_GRANULAR, P, send_to_cuda=True, tension=bt * 3)  # recover

# ---- Path 3: BULK send_updated_params_to_CUDA (all-strings repack) ----
print("\n=== PATH 3  BULK send_updated_params_to_CUDA (setUpdatedParameters; all-strings) ===")
ups = run(pm.send_updated_params_to_CUDA)  # all stable -> upload happens
ok3a = (any(u[0] == 'setUpdatedParameters' for u in ups) and pm.cfl_redline is False)
print(f"  all-stable     : uploads={ups} cfl_redline={pm.cfl_redline}  PASS={ok3a}")
# now make ONE pitch unstable in the model directly, then the all-strings bulk must SKIP
with contextlib.redirect_stdout(io.StringIO()):
    sm.pitches[P].physics.set_params(tension=bt * 60)
ups = run(pm.send_updated_params_to_CUDA)  # one unstable pitch -> SKIP the whole bulk upload
ok3b = (len(ups) == 0 and pm.cfl_redline is True)
print(f"  one-unstable   : uploads={ups} cfl_redline={pm.cfl_redline} (pitch {P} x60) PASS={ok3b}")
print(f"  redline_info pitch={pm.cfl_redline_info.get('pitch') if pm.cfl_redline_info else None}")
results += [ok3a, ok3b]

print("\n==================== SUMMARY ====================")
labels = ["P1 granular below uploads+clear", "P1 granular OVER skip+flag+keep",
          "P2 bulk below uploads+clear",     "P2 bulk OVER skip+flag+keep",
          "P3 all-strings stable uploads",   "P3 all-strings one-unstable skip+flag"]
for lab, r in zip(labels, results):
    print(f"  {'PASS' if r else 'FAIL'}  {lab}")
print(f"\n  ALL PASS: {all(results)}")
sys.exit(0 if all(results) else 1)
