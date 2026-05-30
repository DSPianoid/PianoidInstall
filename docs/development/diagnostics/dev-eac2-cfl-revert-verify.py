"""
dev-eac2: VERIFY the Directive-A REVERT — gate is GRANULAR-ONLY; the two BULK paths are NO LONGER gated.

PURE PYTHON — NO GPU, NO Flask, NO socketio, NO engine. Builds the REAL StringMap model (CPU-only) from the
Belarus preset, constructs the REAL ParameterManager with a RECORDING mock CUDA binding, and drives all three
physical-parameter upload paths directly. This is the behavioral proof that the revert did what the user asked:

  EXPECTED POST-REVERT:
  (1) GRANULAR update_pitch_physical_params_GRANULAR : over-edge -> SKIP upload + raise cfl_redline (gate KEPT)
  (2) BULK update_pitch_physical_params              : over-edge -> UPLOADS anyway, flag NOT raised (gate REMOVED)
  (3) BULK send_updated_params_to_CUDA               : one-unstable -> UPLOADS anyway, flag NOT raised (gate REMOVED)

Adapted from dev-395e-cfl-allpath-gate.py (same harness; flipped expectations for paths 2/3).
Run: cd PianoidCore && unset VIRTUAL_ENV && ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-eac2-cfl-revert-verify.py
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
    def __init__(self):
        self.uploads = []
    def updateMultiStringParameter_NEW(self, name, idxs, vals):
        self.uploads.append(('updateMultiStringParameter_NEW', name)); return True
    def setNewPhysicalParameters(self, *a):
        self.uploads.append(('setNewPhysicalParameters',)); return True
    def setUpdatedParameters(self, *a):
        self.uploads.append(('setUpdatedParameters',)); return None
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

# ---- Path 1: GRANULAR — gate KEPT ----
print("=== PATH 1  GRANULAR update_pitch_physical_params_GRANULAR (Strings panel) — gate KEPT ===")
ups = run(pm.update_pitch_physical_params_GRANULAR, P, send_to_cuda=True, tension=bt * 10)
ok1a = (len(ups) > 0 and pm.cfl_redline is False)
print(f"  x10 below-edge : uploads={ups} cfl_redline={pm.cfl_redline} model={model_tension():.0f}  PASS={ok1a}")
ups = run(pm.update_pitch_physical_params_GRANULAR, P, send_to_cuda=True, tension=bt * 50)
ok1b = (len(ups) == 0 and pm.cfl_redline is True and abs(model_tension() - bt*50) < 1)
print(f"  x50 OVER-edge  : uploads={ups} cfl_redline={pm.cfl_redline} model={model_tension():.0f} (kept) PASS={ok1b}  (expect SKIP+flag)")
results += [ok1a, ok1b]

run(pm.update_pitch_physical_params_GRANULAR, P, send_to_cuda=True, tension=bt * 3)  # recover + clears flag

# ---- Path 2: BULK update_pitch_physical_params — gate REMOVED ----
print("\n=== PATH 2  BULK update_pitch_physical_params (MIDI-CC/auto-tune) — gate REMOVED ===")
ups = run(pm.update_pitch_physical_params, P, send_to_cuda=True, tension=bt * 8)
ok2a = any(u[0] == 'setNewPhysicalParameters' for u in ups)
print(f"  x8 below-edge  : uploads={ups} cfl_redline={pm.cfl_redline}  PASS={ok2a}  (expect UPLOAD)")
flag_before = pm.cfl_redline
ups = run(pm.update_pitch_physical_params, P, send_to_cuda=True, tension=bt * 60)
# POST-REVERT: the bulk path must UPLOAD even over-edge, and must NOT raise the flag (it no longer calls the gate)
ok2b = (any(u[0] == 'setNewPhysicalParameters' for u in ups) and pm.cfl_redline == flag_before)
print(f"  x60 OVER-edge  : uploads={ups} cfl_redline={pm.cfl_redline} model={model_tension():.0f}  PASS={ok2b}  (expect UPLOAD anyway, NO flag — ungated)")
results += [ok2a, ok2b]

run(pm.update_pitch_physical_params_GRANULAR, P, send_to_cuda=True, tension=bt * 3)  # recover

# ---- Path 3: BULK send_updated_params_to_CUDA — gate REMOVED ----
print("\n=== PATH 3  BULK send_updated_params_to_CUDA (all-strings) — gate REMOVED ===")
ups = run(pm.send_updated_params_to_CUDA)
ok3a = any(u[0] == 'setUpdatedParameters' for u in ups)
print(f"  all-stable     : uploads={ups} cfl_redline={pm.cfl_redline}  PASS={ok3a}  (expect UPLOAD)")
with contextlib.redirect_stdout(io.StringIO()):
    sm.pitches[P].physics.set_params(tension=bt * 60)   # make one pitch unstable in the model
flag_before = pm.cfl_redline
ups = run(pm.send_updated_params_to_CUDA)
# POST-REVERT: must UPLOAD even with an unstable pitch, and must NOT raise the flag
ok3b = (any(u[0] == 'setUpdatedParameters' for u in ups) and pm.cfl_redline == flag_before)
print(f"  one-unstable   : uploads={ups} cfl_redline={pm.cfl_redline} (pitch {P} x60)  PASS={ok3b}  (expect UPLOAD anyway, NO flag — ungated)")
results += [ok3a, ok3b]

print("\n==================== SUMMARY (POST-REVERT expectations) ====================")
labels = ["P1 GRANULAR below uploads+clear (gate kept)",
          "P1 GRANULAR OVER skip+flag+keep (gate kept)",
          "P2 BULK below uploads (ungated)",
          "P2 BULK OVER still uploads + NO flag (gate REMOVED)",
          "P3 all-strings stable uploads (ungated)",
          "P3 all-strings one-unstable still uploads + NO flag (gate REMOVED)"]
for lab, r in zip(labels, results):
    print(f"  {'PASS' if r else 'FAIL'}  {lab}")
print(f"\n  ALL PASS: {all(results)}")
sys.exit(0 if all(results) else 1)
