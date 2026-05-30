"""
dev-395e: final confirmatory checks.
(1) Does the gate's dec_curr=gamma*dt term materially shift the reject border (could damping MASK a blowup)?
(2) Confirm a sub-edge tension increase yields a STABLE engine (gate-pass is correct), so a real "break"
    needs either a >~20x tension edit OR a non-blowup (out-of-scope) mechanism.
IN-PROC, no GPU, no ports.
Run: cd PianoidCore && unset VIRTUAL_ENV && ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-395e-cfl-deccurr-check.py
"""
import os, sys, json, io, contextlib, math
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(REPO, "PianoidBasic", "Pianoid"))
sys.path.insert(0, os.path.join(REPO, "PianoidBasic"))
sys.path.insert(0, os.path.join(REPO, "PianoidCore", "pianoid_middleware"))
from StringMap import StringMap
from ModelParams import ModelParameters
from parameter_manager import ParameterManager
import cfl_stability as cfl

PRESET = os.path.join(REPO, "PianoidCore", "pianoid_middleware", "presets", "Belarus_8band_196modes-MFeq.json")
with open(PRESET) as f:
    save = json.load(f)
mp = ModelParameters(); mp.update_params(**save['model_parameters'])
with contextlib.redirect_stdout(io.StringIO()):
    sm = StringMap(mp, **save)
pm = ParameterManager(pianoid=None, sm=sm, modes=None, mp=mp, cuda_lock=None)

P = 99
(tension, r, rho, jung, dx, dt_, dec_curr, cfd, num_strings, toff) = pm._prospective_string_coeffs(P, {})
print(f"pitch {P}: dt={dt_:.4g}  gamma={sm.pitches[P].physics.gamma:.4g}  dec_curr=gamma*dt={dec_curr:.4g}  "
      f"cfd={cfd:.4g}  tension_offset={toff}")
print(f"dec_inv = 1/(1+dec_curr) = {1.0/(1.0+dec_curr):.8f}  (≈1 means damping does NOT shift the edge)")
print()

# max|g| with dec_curr=cfd=0 (undamped) vs the gate's actual dec_curr/cfd, swept in tension
print(f"{'tmult':>6}{'coeff_T':>10}{'maxg(undamped)':>16}{'maxg(gate dec/cfd)':>20}")
bt = tension
for m in [1, 10, 20, 22, 25, 50]:
    T, B = cfl._coeffs(bt * m, r, rho, jung, dx, dt_)
    g_undamped = cfl.max_amplification(T, B, 0.0, 0.0)
    g_gate = cfl.max_amplification(T, B, dec_curr, cfd)
    print(f"{m:>6}{T:>10.4f}{g_undamped:>16.5f}{g_gate:>20.5f}")
print()
print("If the two max|g| columns agree, the dec_curr/cfd terms do NOT mask a blowup (matches plan §2.2:")
print("velocity damping doesn't move the edge; the gate uses the undamped baseline as the loosest edge).")
