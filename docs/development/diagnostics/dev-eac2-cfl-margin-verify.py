"""
dev-eac2: VERIFY the CFL_MARGIN=0.99 acceptance threshold on the GRANULAR gate (user-directed 2026-05-30).

PURE PYTHON — NO GPU, NO Flask, NO socketio, NO engine. Real StringMap model (CPU) from the Belarus preset,
real ParameterManager + a RECORDING mock CUDA, drives the GRANULAR upload (the Strings-panel path) at
targeted CFL ratios (Courant numbers) and asserts:

  - courant ~0.98  (below CFL_MARGIN)        -> ACCEPT: uploads, cfl_redline=False           (allowed)
  - courant ~0.995 (between CFL_MARGIN and 1) -> REJECT: 0 uploads, cfl_redline=True           (was allowed
                                                pre-margin since |g|=1.0; the margin now rejects it)
  - boundary EXACTLY at 0.99: courant 0.9899 ACCEPT, 0.9901 REJECT.

We choose the tension that makes the worst-string Courant number hit a target. Courant for string i is
(coeff_tension_i - 8*coeff_bending), coeff_tension_i = (tension*(1+i*offset)/rho)*dt^2/dx^2. The worst string
is the highest-tension one. We invert for the base tension that puts the worst string's Courant at `target`.

Run: cd PianoidCore && unset VIRTUAL_ENV && ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-eac2-cfl-margin-verify.py
"""
import os, sys, json, io, contextlib, threading, math

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
print(f"CFL_MARGIN = {C.CFL_MARGIN}")

# Pull the pitch's CURRENT coeff inputs the gate uses, to invert tension->target Courant on the WORST string.
(tension0, r, rho, jung, dx, dt, dec_curr, cfd, num_strings, tension_offset) = pm._prospective_string_coeffs(P, {})
n = max(1, int(num_strings))
# worst string index = highest tension factor (1 + i*offset); offset may be 0 -> all equal -> i=0
factors = [1.0 + i * tension_offset for i in range(n)]
wf = max(factors)
# coeff_bending is tension-independent; compute it once
_, B = C._coeffs(tension0, r, rho, jung, dx, dt)
# courant_worst(base_tension) = (base_tension*wf/rho)*dt^2/dx^2 - 8B = k*base_tension - 8B, with
k = (wf / rho) * dt * dt / (dx * dx)


def base_tension_for_courant(target):
    # target = k*base_tension - 8B  ->  base_tension = (target + 8B)/k
    return (target + 8.0 * B) / k


def model_tension():
    return float(sm.pitches[P].physics.tension)


def drive_and_check(target_courant):
    """Set the base tension so the worst string's Courant == target, run the GRANULAR gate, report."""
    bt = base_tension_for_courant(target_courant)
    fake.uploads.clear()
    with contextlib.redirect_stdout(io.StringIO()):
        pm.update_pitch_physical_params_GRANULAR(P, send_to_cuda=True, tension=bt)
    # recompute the actual worst Courant + amp the gate saw (sanity)
    amp, wstr, courant = pm._pitch_upload_amp(P)
    uploaded = len(fake.uploads) > 0
    return bt, amp, courant, uploaded, pm.cfl_redline, pm.cfl_redline_info


print(f"pitch {P}: rho={rho:.1f} dx={dx:.6g} dt={dt:.3e} coeff_bending={B:+.5g} num_strings={n} tension_offset={tension_offset} worst_factor={wf}\n")
print(f"{'target courant':>16} {'base_tension':>14} {'max|g|':>10} {'actual courant':>16} {'uploaded?':>10} {'cfl_redline':>12}  verdict")
results = []
cases = [
    (0.95,  True),   # well below margin -> ACCEPT
    (0.98,  True),   # below margin      -> ACCEPT
    (0.9899, True),  # just below 0.99   -> ACCEPT
    (0.9901, False), # just above 0.99   -> REJECT
    (0.995, False),  # between 0.99 and 1 (|g| still 1.0) -> REJECT (was allowed pre-margin)
    (1.005, False),  # over the true edge -> REJECT (|g|>1 too)
]
for target, expect_accept in cases:
    bt, amp, courant, uploaded, redline, info = drive_and_check(target)
    accepted = uploaded and (redline is False)
    ok = (accepted == expect_accept)
    verdict = ('ACCEPT' if accepted else 'REJECT') + (' OK' if ok else '  <<< MISMATCH')
    print(f"{target:>16.4f} {bt:>14.1f} {amp:>10.5f} {courant:>16.5f} {str(uploaded):>10} {str(redline):>12}  {verdict}")
    results.append(ok)
    # restore a stable value so the next case's baseline is clean
    with contextlib.redirect_stdout(io.StringIO()):
        pm.update_pitch_physical_params_GRANULAR(P, send_to_cuda=True, tension=base_tension_for_courant(0.5))

# show the redline_info from a margin-rejected case (courant in [0.99,1), |g|=1.0)
print("\n--- redline_info for a MARGIN rejection (courant 0.995, |g|=1.0) ---")
with contextlib.redirect_stdout(io.StringIO()):
    pm.update_pitch_physical_params_GRANULAR(P, send_to_cuda=True, tension=base_tension_for_courant(0.995))
print(json.dumps(pm.cfl_redline_info, indent=2))
with contextlib.redirect_stdout(io.StringIO()):
    pm.update_pitch_physical_params_GRANULAR(P, send_to_cuda=True, tension=base_tension_for_courant(0.5))  # restore

print("\n==================== SUMMARY ====================")
labels = ["courant 0.95 ACCEPT", "courant 0.98 ACCEPT", "courant 0.9899 ACCEPT (just below 0.99)",
          "courant 0.9901 REJECT (just above 0.99)", "courant 0.995 REJECT (was allowed pre-margin)",
          "courant 1.005 REJECT (true divergence)"]
for lab, rr in zip(labels, results):
    print(f"  {'PASS' if rr else 'FAIL'}  {lab}")
print(f"\n  BOUNDARY confirmed at CFL_MARGIN={C.CFL_MARGIN}; ALL PASS: {all(results)}")
sys.exit(0 if all(results) else 1)
