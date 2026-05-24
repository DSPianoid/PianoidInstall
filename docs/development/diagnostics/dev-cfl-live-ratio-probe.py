"""
dev-cfl Part C2: compute REAL per-pitch (coeff_tension, coeff_bending) for a
production preset using PianoidBasic's OWN authoritative get_coefficients()
(Pitch.py:294-323). Determines which stability regime is operative in practice:
  - the upper tension CFL (coeff_tension <= 1 + 8B), for which (T+4B)<=L is a
    reasonable proxy, OR
  - the lower bending-Nyquist (coeff_tension >= 8B), which (T+4B) does NOT capture.

Also reports min/max margin so we can quantify how close real strings sit to
each boundary (the proposal: short treble strings have the least CFL margin).
"""
import os, sys, json
sys.path.insert(0, os.path.abspath("PianoidBasic/Pianoid"))

import numpy as np
from StringMap import StringMap
from ModelParams import ModelParameters

PRESET = sys.argv[1] if len(sys.argv) > 1 else \
    "PianoidCore/pianoid_middleware/presets/Belarus_8band_196modes.json"

with open(PRESET) as f:
    save = json.load(f)

mp = ModelParameters()
mp.update_params(**save['model_parameters'])
mp.set_num_modes(mp.num_modes if hasattr(mp, 'num_modes') else 196)
sm = StringMap(mp, **save)

print(f"preset: {PRESET}")
print(f"sample_rate={mp.sample_rate()}  string_iteration={mp.string_iteration}")
dt = 1.0 / (mp.sample_rate() * mp.string_iteration)
print(f"dt = {dt:.6e} s\n")

rows = []
for pid, pitch in sorted(sm.pitches.items()):
    try:
        c0, c1, c2, c_1, c_2, ct, cf, c2dec = pitch.get_coefficients()
    except Exception as e:
        continue
    # Recover coeff_tension (T) and coeff_bending (B) from the c-coefficients.
    # With dec_inv≈1 at probe (damper default): c2 = 2 B dec_inv -> B = c2/(2 dec_inv).
    # Easier: recompute directly from physics, same formulas as get_coefficients.
    phys = pitch.physics
    dx = phys.geometry.dx()
    T = (phys.tension / phys.rho) * dt**2 / dx**2
    import math
    B = (math.pi * phys.r**4 / (4*phys.rho)) * phys.jung * dt**2 / dx**4
    rows.append((pid, T, B))

if not rows:
    print("No pitches produced coefficients — check preset/model load.")
    sys.exit(1)

arrT = np.array([r[1] for r in rows]); arrB = np.array([r[2] for r in rows])
print(f"{'pitch':>6}{'coeff_T':>12}{'coeff_B':>12}{'T+4B':>10}{'8B':>10}"
      f"{'T>=8B?':>8}{'T<=1+8B?':>10}{'max|g|stable?':>14}")

# import the exact von-Neumann checker
def max_root_mag(T, B, n_theta=1501):
    s0=(2+12*B-2*T); s1=(T-8*B); s2=(2*B); sb=-1.0
    th=np.linspace(0,np.pi,n_theta); worst=0.0
    for t in th:
        ct=np.cos(t); c2=np.cos(2*t)
        A=s0+2*s1*ct+2*s2*c2
        r=np.roots([1.0,-A,-sb*1.0 if False else 1.0])  # g^2 - A g + 1 = 0
        m=np.max(np.abs(r))
        worst=max(worst,m)
    return worst

n_print = 0
worst_margin_lower = 1e9; worst_margin_upper = 1e9
any_unstable = False
for (pid, T, B) in rows:
    lower_ok = T >= 8*B
    upper_ok = T <= 1 + 8*B
    m = max_root_mag(T, B)
    stab = m <= 1.0 + 1e-6
    any_unstable = any_unstable or (not stab)
    worst_margin_lower = min(worst_margin_lower, T - 8*B)
    worst_margin_upper = min(worst_margin_upper, (1 + 8*B) - T)
    if n_print < 40 or not stab:
        print(f"{pid:>6}{T:>12.6f}{B:>12.6f}{T+4*B:>10.5f}{8*B:>10.6f}"
              f"{str(lower_ok):>8}{str(upper_ok):>10}{('OK' if stab else 'UNSTABLE'):>14}")
        n_print += 1

print(f"\nSUMMARY ({len(rows)} pitches):")
print(f"  coeff_tension range: [{arrT.min():.6f}, {arrT.max():.6f}]")
print(f"  coeff_bending range: [{arrB.min():.6e}, {arrB.max():.6f}]")
print(f"  T+4B range:          [{(arrT+4*arrB).min():.6f}, {(arrT+4*arrB).max():.6f}]")
print(f"  worst (smallest) lower-margin (T - 8B): {worst_margin_lower:.6f}  "
      f"({'OK, lower never binds' if worst_margin_lower>0 else 'LOWER BINDS — bending-Nyquist active'})")
print(f"  worst (smallest) upper-margin (1+8B - T): {worst_margin_upper:.6f}")
print(f"  ratio B/T max: {(arrB/np.maximum(arrT,1e-12)).max():.4f}  "
      f"(if << 1/8=0.125 everywhere, lower bound 8B<=T has margin)")
print(f"  any pitch unstable at default damper: {any_unstable}")
