"""
dev-cflgate: RADIUS audit — does a MODEST radius (r) edit on a MIDDLE note wrongly trip the CFL gate?

PURE PYTHON (no GPU/Flask). Real StringMap (Belarus preset) + real ParameterManager.

For middle pitches, sweeps the radius MULTIPLIER (and tension) and reports the gate inputs (courant, max|g|)
and the decision at BOTH the buggy live margin 0.8 and the fixed 0.99. Key question: is a trip GENUINE
(max|g| > 1 -> engine would diverge) or a MARGIN-band false-positive (max|g| == 1.0, courant in [margin, 1.0))?

Run: cd PianoidCore && unset VIRTUAL_ENV && ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-cflgate-radius-sweep.py
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
    def updateMultiStringParameter_NEW(self, *a): self.uploads.append(a); return True
    def setNewPhysicalParameters(self, *a): return True
    def setUpdatedParameters(self, *a): return None
    def setNewHammerParameters(self, *a): return True
    def setNewExcitationBaseLevels(self, *a): return True
    def waitForParameterUpdate(self): pass

pm = ParameterManager(pianoid=FakeCuda(), sm=sm, modes=None, mp=mp, cuda_lock=threading.Lock())

def gate_inputs(pid, **overrides):
    """compute (courant, max|g|) the gate would see for pitch pid with pending overrides (no mutation)."""
    (tension, r, rho, jung, dx, dt, dec_curr, cfd, num_strings, toff) = pm._prospective_string_coeffs(pid, overrides)
    amp, wstr, courant = C.amp_and_courant_for_pitch_strings(tension, r, rho, jung, dx, dt, num_strings, toff,
                                                             dec_curr=dec_curr, cfd=cfd)
    return courant, amp

def thr_label(courant, amp):
    rej08 = not C.is_stable_amp(amp) or courant >= 0.8
    rej99 = not C.is_stable_amp(amp) or courant >= 0.99
    genuine = not C.is_stable_amp(amp)  # max|g|>1 -> engine truly diverges
    return rej08, rej99, genuine

MIDDLE = [50, 55, 60, 65]
print("=== RADIUS sweep on MIDDLE notes — gate inputs + decision @0.8 (buggy) / @0.99 (fixed) ===")
print("(rej=skip upload; GENUINE = max|g|>1 = engine truly diverges; else it's a margin-band call, |g|=1.0)\n")
for P in MIDDLE:
    phys = sm.pitches[P].physics
    r0 = phys.r
    c0, a0 = gate_inputs(P)
    print(f"--- pitch {P}: baseline r={r0:.5g} m, tension={phys.tension:.1f}, baseline courant={c0:.4f} |g|={a0:.4f} ---")
    print(f"{'r_mult':>7} {'r(m)':>9} {'courant':>9} {'max|g|':>9} {'rej@0.8':>8} {'rej@0.99':>9} {'GENUINE?':>9}")
    for m in (1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0):
        c, a = gate_inputs(P, r=r0 * m)
        r08, r99, gen = thr_label(c, a)
        print(f"{m:>7.2f} {r0*m:>9.5g} {c:>9.4f} {a:>9.4f} {str(r08):>8} {str(r99):>9} {str(gen):>9}")
    # find the radius multiplier crossing each threshold (bisection on courant; genuine = |g|>1)
    def mult_for_courant(target, lo=1.0, hi=50.0):
        for _ in range(60):
            mid = (lo + hi) / 2
            c, a = gate_inputs(P, r=r0 * mid)
            if c < target: lo = mid
            else: hi = mid
        return (lo + hi) / 2
    def mult_for_genuine(lo=1.0, hi=50.0):
        for _ in range(60):
            mid = (lo + hi) / 2
            c, a = gate_inputs(P, r=r0 * mid)
            if C.is_stable_amp(a): lo = mid
            else: hi = mid
        return (lo + hi) / 2
    m08 = mult_for_courant(0.8); m99 = mult_for_courant(0.99); mgen = mult_for_genuine()
    print(f"  -> radius xMULT to reach: courant0.8={m08:.3f}x  courant0.99={m99:.3f}x  |g|>1(true divergence)={mgen:.3f}x")
    print(f"  -> band wrongly-skipped ONLY by the 0.8 bug (now fixed): r in [{m08:.3f}x, {m99:.3f}x]\n")

# tension+radius together on pitch 60
print("=== TENSION + RADIUS together (pitch 60) ===")
P = 60; phys = sm.pitches[P].physics; r0 = phys.r; t0 = phys.tension
print(f"{'t_mult':>7} {'r_mult':>7} {'courant':>9} {'max|g|':>9} {'rej@0.8':>8} {'rej@0.99':>9} {'GENUINE?':>9}")
for tm, rm in [(1.0,1.0),(1.5,1.0),(1.0,1.5),(1.5,1.5),(2.0,1.25),(1.25,2.0)]:
    c, a = gate_inputs(P, tension=t0*tm, r=r0*rm)
    r08, r99, gen = thr_label(c, a)
    print(f"{tm:>7.2f} {rm:>7.2f} {c:>9.4f} {a:>9.4f} {str(r08):>8} {str(r99):>9} {str(gen):>9}")

print("\nDONE")
