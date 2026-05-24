"""
dev-cfl: map the EXACT 2D stability region in the (T, B) plane and compare to the
candidate single-ratio bound (T + 4B) <= L. Then evaluate where REAL preset
coefficients land relative to both the true boundary and the (T+4B) line.

Builds on dev-cfl-vonneumann-derivation.py. Key earlier finding: there are TWO
Nyquist constraints, not one:
   theta=pi (Nyquist):  8B <= T <= 1 + 8B   (upper needs T >= 8B; tension must
                                              dominate bending at grid scale)
plus interior-theta constraints. So a single (T+4B)<=L is NOT globally equivalent
to stability. This script quantifies that and finds the operative regime.
"""
import numpy as np

def coeffs(T, B, dec_curr=0.0, cfd=0.0):
    dec_inv = 1.0 / (1.0 + dec_curr)
    return ((2 + 12*B - 2*T)*dec_inv, (T - 8*B)*dec_inv, (2*B)*dec_inv,
            (dec_curr - 1)*dec_inv, cfd)

def max_root_mag(T, B, dec_curr=0.0, cfd=0.0, n_theta=2001):
    s0, s1, s2, sb, c = coeffs(T, B, dec_curr, cfd)
    thetas = np.linspace(0.0, np.pi, n_theta)
    worst = 0.0
    for t in thetas:
        cost = np.cos(t); cos2t = np.cos(2*t)
        A = s0 + 2*s1*cost + 2*s2*cos2t + c*(-2.0)*(1.0 - cost)
        B0 = sb + c*2.0*(1.0 - cost)
        roots = np.roots([1.0, -A, -B0])
        m = np.max(np.abs(roots))
        if m > worst:
            worst = m
    return worst

def stable(T, B, **kw):
    return max_root_mag(T, B, **kw) <= 1.0 + 1e-9

# ---- PART A: exact analytic Nyquist constraints (theta=pi) -----------------
# At theta=pi: cos=-1, cos2=1.  A = s0 - 2 s1 + 2 s2 ; with dec=cfd=0:
#   A = (2+12B-2T) - 2(T-8B) + 2(2B) = 2 + 32B - 4T  ; B0 = sb = -1
#   g^2 - A g + 1 = 0  => stable iff |A| <= 2  => -2 <= 2+32B-4T <= 2
#   => 8B <= T <= 1 + 8B
print("PART A — analytic Nyquist (theta=pi) constraint: 8B <= T <= 1 + 8B")
print("  Lower (T >= 8B): tension must dominate bending at the grid scale.")
print("  Upper (T <= 1 + 8B): the classic tension CFL, relaxed by bending.\n")

# ---- PART B: verify the FULL region against both Nyquist bounds -------------
# Sample (T,B) grid; classify true-stable vs predicted by analytic box, and vs (T+4B)<=1
print("PART B — true region vs analytic box [8B, 1+8B] vs (T+4B)<=1")
print(f"{'T':>6}{'B':>7}{'max|g|':>10}{'true':>6}{'box':>5}{'4B<=1':>7}{'T+4B':>7}")
mismatches_box = 0
mismatches_lin = 0
import itertools
Ts = np.linspace(0.0, 1.4, 29)
Bs = np.linspace(0.0, 0.18, 19)
for B in Bs:
    for T in Ts:
        m = max_root_mag(T, B)
        tru = m <= 1.0 + 1e-9
        box = (T >= 8*B - 1e-12) and (T <= 1 + 8*B + 1e-12)
        lin = (T + 4*B) <= 1.0 + 1e-12
        if tru != box: mismatches_box += 1
        if tru != lin: mismatches_lin += 1
print(f"  grid {len(Ts)}x{len(Bs)}: mismatches(analytic box)={mismatches_box}, "
      f"mismatches((T+4B)<=1)={mismatches_lin}")
# show a few representative rows
for (T,B) in [(0.99,0.0),(1.0,0.0),(1.05,0.0),(0.5,0.05),(0.39,0.05),(0.41,0.05),
              (0.2,0.1),(0.85,0.1),(1.0,0.1),(1.81,0.1)]:
    m = max_root_mag(T,B)
    print(f"{T:>6.2f}{B:>7.3f}{m:>10.4f}{str(m<=1+1e-9):>6}"
          f"{str((T>=8*B-1e-9)and(T<=1+8*B+1e-9)):>5}{str((T+4*B)<=1+1e-9):>7}{T+4*B:>7.3f}")

# ---- PART C: REAL preset coefficients across all pitches --------------------
print("\nPART C — real preset (T,B) per pitch: which regime is operative?")
import os, sys, json
sys.path.insert(0, os.path.abspath("PianoidBasic"))
import math
def compute_TB_for_preset(preset_path):
    """Recreate coeff_tension/coeff_bending exactly as Pitch.get_coefficients."""
    with open(preset_path) as f:
        preset = json.load(f)
    # We need per-pitch physics + model params. Use PianoidBasic to load.
    try:
        from Pianoid.Pianoid import Pianoid as PB
    except Exception as e:
        print("  (PianoidBasic import path differs; falling back to raw JSON parse)", e)
        return None
    return None

# Robust path: instead of importing the whole domain model, replicate the math from
# the physical parameters that the engine actually uses (same formulas as Kernels.cu).
# We pull them from a loaded backend instead (Part C2). Here just note the formulas.
print("  coeff_tension = (tension/rho) * dt^2 / dx^2")
print("  coeff_bending = (pi * E * r^4 / (4 rho)) * dt^2 / dx^4")
print("  dt = 1/(sample_rate * string_iteration)")
print("  -> computed live against the engine in dev-cfl-live-ratio-probe.py (Part C2).")
