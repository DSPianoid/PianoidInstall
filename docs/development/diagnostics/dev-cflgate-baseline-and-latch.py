"""
dev-cflgate: AUDIT the CFL gate for (a) over-conservative false-positives on realistic edits and
(b) latch behaviour (does a valid edit apply after a trip?).

PURE PYTHON — NO GPU/Flask/socketio. Real StringMap (Belarus preset) + real ParameterManager + recording
mock CUDA, exactly like dev-eac2-cfl-margin-verify.py.

Reports:
  1. BASELINE courant per pitch (default preset physics) — how close real strings already sit to CFL_MARGIN=0.8.
     For each pitch: baseline worst-string courant, baseline max|g|, and the tension MULTIPLIER that would
     take the worst string to courant 0.8 (the gate edge) vs 1.0 (the true stability edge). The ratio
     (mult@1.0 / mult@0.8) is the headroom the 0.8 margin throws away.
  2. LATCH test: trip the gate on pitch P (unstable), then make a clearly-VALID small edit on the SAME P and
     on a DIFFERENT pitch Q; report whether each uploads and whether cfl_redline clears.

Run: cd PianoidCore && unset VIRTUAL_ENV && ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-cflgate-baseline-and-latch.py
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

print(f"CFL_MARGIN = {C.CFL_MARGIN}   (doc says default 0.99; exact stability edge = 1.0)\n")

# ---- 1. BASELINE courant per pitch ---------------------------------------------------------------
phys_pitches = sorted(p for p in sm.pitches if p < 128)
print("=== BASELINE per-pitch courant @ default preset physics ===")
print(f"{'pitch':>5} {'baseCourant':>12} {'base|g|':>9} {'mult@0.8':>9} {'mult@1.0':>9} {'headroomLost%':>13} {'gatedAtBase?':>12}")
n_close = 0
for P in phys_pitches:
    (tension0, r, rho, jung, dx, dt, dec_curr, cfd, num_strings, tension_offset) = pm._prospective_string_coeffs(P, {})
    n = max(1, int(num_strings))
    wf = max(1.0 + i * tension_offset for i in range(n))
    _, B = C._coeffs(tension0, r, rho, jung, dx, dt)
    k = (wf / rho) * dt * dt / (dx * dx) if (rho and dx) else float('nan')
    base_courant = k * tension0 - 8.0 * B
    amp, wstr, courant = pm._pitch_upload_amp(P)
    # tension multiplier to reach a target worst-string courant: t = (target+8B)/k ; mult = t/tension0
    def mult_for(target):
        if not (k and tension0):
            return float('nan')
        return ((target + 8.0 * B) / k) / tension0
    m08 = mult_for(0.8); m10 = mult_for(1.0)
    headroom_lost = (1.0 - (m08 - 1.0) / (m10 - 1.0)) * 100.0 if (m10 > 1.0 and math.isfinite(m08) and math.isfinite(m10)) else float('nan')
    gated = not C.is_stable_with_margin(amp, courant)
    if base_courant > 0.6:
        n_close += 1
    print(f"{P:>5} {base_courant:>12.4f} {amp:>9.4f} {m08:>9.3f} {m10:>9.3f} {headroom_lost:>13.1f} {str(gated):>12}")

print(f"\npitches with baseline courant > 0.6 (small edit could trip 0.8): {n_close}/{len(phys_pitches)}")

# ---- 2. LATCH test -------------------------------------------------------------------------------
print("\n=== LATCH test: trip the gate, then make a clearly-VALID edit ===")
P = 99   # high pitch (short string, sensitive)
Q = 60   # different pitch

def coeffs_helpers(pid):
    (t0, r, rho, jung, dx, dt, dec_curr, cfd, nstr, toff) = pm._prospective_string_coeffs(pid, {})
    n = max(1, int(nstr)); wf = max(1.0 + i * toff for i in range(n))
    _, B = C._coeffs(t0, r, rho, jung, dx, dt)
    k = (wf / rho) * dt * dt / (dx * dx)
    return t0, B, k

def tension_for_courant(pid, target):
    _, B, k = coeffs_helpers(pid)
    return (target + 8.0 * B) / k

def edit(pid, target_courant):
    bt = tension_for_courant(pid, target_courant)
    fake.uploads.clear()
    with contextlib.redirect_stdout(io.StringIO()):
        pm.update_pitch_physical_params_GRANULAR(pid, send_to_cuda=True, tension=bt)
    amp, wstr, courant = pm._pitch_upload_amp(pid)
    return bt, amp, courant, (len(fake.uploads) > 0), pm.cfl_redline

# Start clean: stable edit on both pitches
for pid in (P, Q):
    with contextlib.redirect_stdout(io.StringIO()):
        pm.update_pitch_physical_params_GRANULAR(pid, send_to_cuda=True, tension=tension_for_courant(pid, 0.5))

print(f"step 0  pitch{P} stable courant 0.5 ............ cfl_redline={pm.cfl_redline}")

# Trip P with an unstable edit (courant 1.05 -> |g|>1)
bt, amp, c, up, rl = edit(P, 1.05)
print(f"step 1  pitch{P} UNSTABLE courant {c:.3f} ...... uploaded={up} cfl_redline={rl}  (expect uploaded=False, redline=True)")

# Now a clearly-VALID small edit on the SAME pitch P (courant 0.4, far below the true edge)
bt, amp, c, up, rl = edit(P, 0.4)
print(f"step 2  pitch{P} VALID    courant {c:.3f} ...... uploaded={up} cfl_redline={rl}  (does the valid edit apply?)")

# Re-trip P, then valid edit on a DIFFERENT pitch Q
edit(P, 1.05)
bt, amp, c, up, rl = edit(Q, 0.4)
print(f"step 3  pitch{Q} VALID    courant {c:.3f} ...... uploaded={up} cfl_redline={rl}  (cross-pitch: does Q apply + clear?)")

# A VALID-but-in-margin edit (courant 0.9, exactly stable |g|=1.0) -> the over-conservative case
edit(P, 0.5)  # reset
bt, amp, c, up, rl = edit(P, 0.9)
print(f"step 4  pitch{P} courant {c:.3f} |g|={amp:.4f} .. uploaded={up} cfl_redline={rl}  (exactly STABLE but in 0.8 margin)")

print("\nDONE")
