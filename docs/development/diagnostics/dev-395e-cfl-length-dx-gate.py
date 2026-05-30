"""
dev-395e: does the REAL CFL gate catch the OTHER destabilizing physics edits the user named
("tension ... length, string iterations, etc.")? Tension is confirmed gated+correct (other scripts).
This tests LENGTH (length down -> dx down -> coeff_T ~ 1/dx^2, coeff_B ~ 1/dx^4 EXPLODE), a RAW dx edit,
and string_iteration, through the REAL ParameterManager gate. IN-PROC, no GPU, no ports.

Key suspicion (from WIP + reading _prospective_string_coeffs):
  - `length` IS handled by the gate (recomputes dx = length/p_main).
  - a RAW `dx` key is NOT overridden by _prospective_string_coeffs (only `length` recomputes dx) -> a raw
    dx edit would be checked against the OLD dx = GATE BYPASS for raw dx. (WIP notes raw-dx granular writes
    are dropped + dx isn't frontend-exposed, so this may be moot — confirm.)
  - string_iteration is a MODEL param (mp.string_iteration via dt), NOT in the per-pitch pending dict at all
    -> is it even gated on a per-pitch string edit? It changes dt -> coeff_T ~ dt^2. Confirm path.

Run:
  cd PianoidCore && unset VIRTUAL_ENV && \
    ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-395e-cfl-length-dx-gate.py [PITCH]
"""
import os, sys, json, math, io, contextlib
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(REPO, "PianoidBasic", "Pianoid"))
sys.path.insert(0, os.path.join(REPO, "PianoidBasic"))
sys.path.insert(0, os.path.join(REPO, "PianoidCore", "pianoid_middleware"))

import numpy as np
from StringMap import StringMap
from ModelParams import ModelParameters
from parameter_manager import ParameterManager, CflRejected
import cfl_stability as cfl

PRESET = os.path.join(REPO, "PianoidCore", "pianoid_middleware", "presets", "Belarus_8band_196modes-MFeq.json")
PITCH = int(sys.argv[1]) if len(sys.argv) > 1 else 99   # most-vulnerable pitch from the all-pitch scan

with open(PRESET) as f:
    save = json.load(f)
mp = ModelParameters(); mp.update_params(**save['model_parameters'])
with contextlib.redirect_stdout(io.StringIO()):
    sm = StringMap(mp, **save)
pm = ParameterManager(pianoid=None, sm=sm, modes=None, mp=mp, cuda_lock=None)

phys = sm.pitches[PITCH].physics
base_dx = phys.geometry.dx()
p_main = sm.pitches[PITCH].geometry.p_main()
print(f"preset           : {os.path.basename(PRESET)}   pitch={PITCH}")
print(f"baseline         : tension={phys.tension:.2f}  dx={base_dx:.6g}  p_main={p_main}  "
      f"length(=dx*p_main)={base_dx*p_main:.6g}")
print(f"string_iteration : {mp.string_iteration}   sr={mp.sample_rate()}")
print()


def gate(pending):
    """Run the REAL gate with a pending edit dict. Return (rejected, info, prospective coeff_T/B/maxg)."""
    try:
        pm._raise_if_cfl_unstable([PITCH], {str(PITCH): dict(pending)})
        rej, info = False, "PASS"
    except CflRejected as e:
        rej, info = True, f"REJECT |g|={e.amplification:.4f} (string {e.string_index})"
    # what coeffs did the gate SEE for this pending?
    (tension, r, rho, jung, dx, dt_, dec_curr, cfd, num_strings,
     toff) = pm._prospective_string_coeffs(PITCH, dict(pending))
    T, B = cfl._coeffs(tension, r, rho, jung, dx, dt_)
    g = cfl.max_amplification(T, B, dec_curr, cfd)
    return rej, info, T, B, g, dx


print("LENGTH edit (length down => dx down => coeff_T,B explode). Gate handles length->dx.")
print(f"  {'length_factor':>14}{'prosp_dx':>10}{'coeff_T':>10}{'coeff_B':>12}{'maxg':>9}  verdict")
for lf in [1.0, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01]:
    new_len = base_dx * p_main * lf
    rej, info, T, B, g, dx = gate({"length": new_len})
    print(f"  {lf:>14.3f}{dx:>10.5g}{T:>10.4f}{B:>12.3e}{g:>9.4f}  {info}")

print()
print("RAW dx edit (key 'dx' directly). _prospective_string_coeffs does NOT override raw dx ->")
print("the gate would check against the OLD dx = BYPASS. Confirm:")
print(f"  {'dx_factor':>14}{'gate_saw_dx':>12}{'coeff_T':>10}{'maxg':>9}  verdict")
for df in [1.0, 0.5, 0.1, 0.02]:
    new_dx = base_dx * df
    rej, info, T, B, g, dxseen = gate({"dx": new_dx})
    flag = "  <-- gate used OLD dx (BYPASS)" if abs(dxseen - base_dx) < 1e-12 and df != 1.0 else ""
    print(f"  {df:>14.3f}{dxseen:>12.6g}{T:>10.4f}{g:>9.4f}  {info}{flag}")

print()
print("Sanity: tension edit on this pitch (should reject ~21.7x per the all-pitch scan):")
for m in [1, 10, 20, 25, 50]:
    rej, info, T, B, g, dx = gate({"tension": phys.tension * m})
    print(f"  tension x{m:<4} coeff_T={T:.4f}  maxg={g:.4f}  {info}")
