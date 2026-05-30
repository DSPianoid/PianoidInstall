"""
dev-eac2: AUDIT the cfl_redline flag set/clear LIFECYCLE (user 2720: "flag never resets").

PURE PYTHON — NO GPU/Flask/socketio/engine. Real StringMap + ParameterManager + recording mock CUDA.
Reproduces the user's exact scenario and checks every clear path:

  A. raise over-edge tension          -> flag SET
  B. then upload a SAFE under-edge val -> flag MUST CLEAR  (the never-reset bug)
  C. raise again, then a MARGIN-zone value (courant in [0.99,1)) -> still SET (correctly rejected by margin)
  D. then a clearly-safe value         -> CLEAR
  E. (after fix) preset-load while flag SET -> CLEAR

Run: cd PianoidCore && unset VIRTUAL_ENV && ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-eac2-cfl-flag-lifecycle.py
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
import cfl_stability as C

PRESET = os.path.join(REPO, "PianoidCore", "pianoid_middleware", "presets", "Belarus_8band_196modes-MFeq.json")
with open(PRESET) as f:
    save = json.load(f)
mp = ModelParameters(); mp.update_params(**save['model_parameters'])
with contextlib.redirect_stdout(io.StringIO()):
    sm = StringMap(mp, **save)


class FakeCuda:
    def __init__(self): self.uploads = []
    def updateMultiStringParameter_NEW(self, name, idxs, vals):
        self.uploads.append(('updateMultiStringParameter_NEW', name)); return True
    def setNewPhysicalParameters(self, *a): self.uploads.append(('setNewPhysicalParameters',)); return True
    def setUpdatedParameters(self, *a): self.uploads.append(('setUpdatedParameters',)); return None
    def setNewHammerParameters(self, *a): return True
    def setNewExcitationBaseLevels(self, *a): return True
    def waitForParameterUpdate(self): pass


fake = FakeCuda()
pm = ParameterManager(pianoid=fake, sm=sm, modes=None, mp=mp, cuda_lock=threading.Lock())

P = 99
print(f"CFL_MARGIN = {C.CFL_MARGIN}\n")

# Invert tension -> target worst-string Courant (so we can pick under/over-edge precisely).
(t0, r, rho, jung, dx, dt, dec_curr, cfd, num_strings, tension_offset) = pm._prospective_string_coeffs(P, {})
n = max(1, int(num_strings))
wf = max(1.0 + i * tension_offset for i in range(n))
_, B = C._coeffs(t0, r, rho, jung, dx, dt)
k = (wf / rho) * dt * dt / (dx * dx)
def tension_for_courant(target): return (target + 8.0 * B) / k

def gran(tension):
    fake.uploads.clear()
    with contextlib.redirect_stdout(io.StringIO()):
        pm.update_pitch_physical_params_GRANULAR(P, send_to_cuda=True, tension=tension)
    return len(fake.uploads) > 0, pm.cfl_redline

results = []
def check(label, expect_flag, expect_upload, got_upload, got_flag):
    ok = (got_flag == expect_flag) and (got_upload == expect_upload)
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}: uploaded={got_upload} cfl_redline={got_flag} "
          f"(expect upload={expect_upload}, flag={expect_flag})")
    results.append(ok)

print("=== A: SAFE start (courant 0.5) -> upload, flag clear ===")
up, fl = gran(tension_for_courant(0.5)); check("A safe start", False, True, up, fl)

print("=== B: OVER-edge (courant 1.5) -> SKIP, flag SET ===")
up, fl = gran(tension_for_courant(1.5)); check("B over-edge sets flag", True, False, up, fl)

print("=== C: ★the never-reset test — SAFE under-edge (courant 0.5) -> MUST upload + flag CLEAR ===")
up, fl = gran(tension_for_courant(0.5)); check("C safe value CLEARS flag", False, True, up, fl)

print("=== D: OVER margin but |g|=1 (courant 0.995) -> SKIP, flag SET (margin) ===")
up, fl = gran(tension_for_courant(0.995)); check("D margin-zone sets flag", True, False, up, fl)

print("=== E: SAFE (courant 0.8) -> upload + flag CLEAR ===")
up, fl = gran(tension_for_courant(0.8)); check("E safe clears margin-flag", False, True, up, fl)

print(f"\n  Flag set/clear lifecycle (granular gate, in isolation): ALL PASS = {all(results)}")
if all(results):
    print("  => The accept path DOES clear the flag in pure Python. If the user still sees 'never resets',")
    print("     the cause is in the CALL PATH (e.g. the safe value is still >= margin, or the frontend) —")
    print("     OR the preset-switch path (Task 2) which has NO clear yet.")
else:
    print("  => The clear path is BROKEN in the gate itself — fix _skip_unstable_physical_upload accept branch.")
sys.exit(0 if all(results) else 1)
