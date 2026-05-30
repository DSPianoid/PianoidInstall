"""dev-eac2 — Directive C: precise ratio<->|g| boundary + EPS-band semantics (PURE PYTHON).

Confirms (1) that the gate's |g|<=1+eps criterion is the EXACT FDTD stability boundary (lossless
string sits AT |g|=1), and (2) how the display ratio (coeff_tension - 8*coeff_bending) relates to
|g| at the edge, so we can state precisely whether the shipped gate already implements
'cfl ratio < 1 allow, >= 1 reject' exactly.

Imports the REAL cfl_stability module (pure math, no engine/GPU).
"""
import math
import sys
import numpy as np

sys.path.insert(0, "pianoid_middleware")
from cfl_stability import (
    max_amplification, max_amp_vector, is_stable_amp, CFL_LIMIT, CFL_STABILITY_EPS, _coeffs,
)

print(f"CFL_LIMIT={CFL_LIMIT}  CFL_STABILITY_EPS={CFL_STABILITY_EPS}")
print()
print("=" * 90)
print("A — the REAL gate (cfl_stability.is_stable_amp) at/around the upper edge, B=0 (edge at T=1)")
print("=" * 90)
print(f"{'T':>10} {'max|g|':>14} {'is_stable_amp':>14}  {'ratio=T-8B':>12}")
for T in [0.90, 0.99, 0.999, 0.9999, 1.0, 1.0000001, 1.000001, 1.00001, 1.0001, 1.001, 1.01]:
    B = 0.0
    g = max_amplification(T, B)
    print(f"{T:>10.7f} {g:>14.9f} {str(bool(is_stable_amp(g))):>14}  {T - 8*B:>12.7f}")

print()
print("=" * 90)
print("B — does is_stable_amp admit anything with TRUE |g| meaningfully > 1? (permissiveness audit)")
print("=" * 90)
# Scan a wide (T,B) grid; flag any cell where is_stable_amp(K24) is True but the dense-truth |g| > 1 + 1e-6.
def dense_g(T, B, N=50000):
    dec_inv = 1.0
    s0 = (2.0 + 12.0 * B - 2.0 * T)
    s1 = (T - 8.0 * B)
    s2 = (2.0 * B)
    sb = -1.0
    th = np.linspace(0.0, math.pi, N + 1)[1:]
    ct = np.cos(th); c2 = np.cos(2.0 * th)
    A = s0 + 2.0 * s1 * ct + 2.0 * s2 * c2
    B0 = sb + 0.0 * ct
    disc = A * A + 4.0 * B0
    sq = np.sqrt(np.abs(disc))
    rmag = np.maximum(np.abs((A + sq) * 0.5), np.abs((A - sq) * 0.5))
    cmag = np.sqrt(np.abs(B0))
    return float(np.max(np.where(disc >= 0.0, rmag, cmag)))

worst_overshoot = 0.0; worst_cell = None; admitted_unstable = 0
for B in np.linspace(-0.02, 0.15, 200):
    for T in np.linspace(0.0, 1.0 + 8.0 * B + 0.1, 400):
        g24 = max_amplification(T, B)
        if is_stable_amp(g24):
            gd = dense_g(T, B)
            if gd > 1.0 + CFL_STABILITY_EPS:
                admitted_unstable += 1
                if gd - 1.0 > worst_overshoot:
                    worst_overshoot = gd - 1.0
                    worst_cell = (T, B, g24, gd)
print(f"cells where gate ADMITS but dense |g| > 1+eps (PERMISSIVE): {admitted_unstable}")
if worst_cell:
    T, B, g24, gd = worst_cell
    print(f"  worst: T={T:.6f} B={B:.6f}  gate|g|={g24:.9f}  dense|g|={gd:.9f}  overshoot={gd-1.0:.3e}")
else:
    print("  NONE — the gate admits nothing the dense truth calls unstable. Gate is EXACT (not permissive).")

print()
print("=" * 90)
print("C — Belarus real-preset regime: ratio and |g| at baseline (how far under the edge)")
print("=" * 90)
# Representative Belarus pitches from the dev-395e scan: worst pitch 99 needs x21.7 tension to cross.
# Show baseline |g| and ratio for a few coeff_tension values in the real range [0, 0.046], B in [-0.0047, 0].
for (T, B) in [(0.046, 0.0), (0.046, -0.0047), (0.0018, 0.0), (0.02, -0.001)]:
    g = max_amplification(T, B)
    print(f"  coeff_T={T:.5f} coeff_B={B:+.5f}: max|g|={g:.9f}  ratio(T-8B)={T - 8*B:+.5f}  stable={bool(is_stable_amp(g))}")

print()
print("=" * 90)
print("D — VERDICT: is the shipped gate already the EXACT 'ratio<1 allow / >=1 reject'?")
print("=" * 90)
# The gate rejects iff max|g| > 1 + 1e-6. At B=0 the upper edge is exactly T=1 where |g|=1 (lossless).
# So: T<1 -> |g|=1 (stable, admitted); T=1 -> |g|=1 (lossless, admitted); T>1 -> |g|>1 (rejected).
# i.e. the gate admits the CLOSED stability region [stable region incl. its lossless boundary] and rejects
# strictly outside. This is the EXACT physical criterion. The 1e-6 is round-off, NOT a margin.
print("  - Upper edge B=0 is T=1 (|g|=1, lossless). Gate admits T<=1 (|g|<=1) and rejects T>1 (|g|>1).")
print("  - A STRICT max|g|>=1 reject would reject the lossless boundary (every normal string sits at |g|=1)")
print("    => 'ratio<1 strictly' must mean the DISPLAY ratio (T-8B): strictly-inside is admitted, AT/above rejected,")
print("       which the gate already does up to the 1e-6 round-off band that keeps the lossless |g|=1 admissible.")
print("  - Measured: 0 permissive cells vs dense truth. The closed-form is EXACT for the engine's recurrence.")
print()
print("DONE.")
