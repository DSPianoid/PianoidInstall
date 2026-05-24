"""
dev-cfl von-Neumann stability derivation for the Pianoid FDTD stiff-string scheme.

Goal: derive the EXACT stability boundary of the explicit update used in
MainKernel.cu:503-541 / Kernels.cu:133-148, and determine the constant CFL_LIMIT
such that the user-fixed ratio  (coeff_tension + 4*coeff_bending) / CFL_LIMIT <= 1
is equivalent to stability.

Scheme (homogeneous, forcing dropped for linear stability):
  u^{n+1}_p = shift_0 * u^n_p + shift_b * u^{n-1}_p
            + shift_1 * (u^n_{p-1} + u^n_{p+1})
            + shift_2 * (u^n_{p-2} + u^n_{p+2})
            + cfd * (d3^n - d3^{n-1})
  d3^n = u^n_{p-1} + u^n_{p+1} - 2 u^n_p

with (dec_inv = 1/(1+dec_curr); B = coeff_bending; T = coeff_tension):
  shift_0 = (2 + 12 B - 2 T) * dec_inv
  shift_1 = (T - 8 B)        * dec_inv
  shift_2 = (2 B)            * dec_inv
  shift_b = (dec_curr - 1)   * dec_inv
  cfd     = coeff_frequency_decay   (HF damping; iter-invariant)

Von-Neumann: u^n_p = g^n e^{i k p}, theta = k*dx in [0, pi].
  cos-substitutions:
    u_{p-1}+u_{p+1} -> 2 cos(theta)
    u_{p-2}+u_{p+2} -> 2 cos(2 theta)
    d3              -> -2 (1 - cos theta)

Characteristic quadratic in g:
  g^2 - A(theta) g - C(theta) = 0
where (moving level n and n-1 terms):
  level-n coeff  A = shift_0 + 2 shift_1 cos t + 2 shift_2 cos 2t + cfd*(-2)(1-cos t)
  level-(n-1)    : g^2 = A g + shift_b - cfd*(-2)(1-cos t)
  => g^2 - A g - B0 = 0   with  B0 = shift_b + cfd*2*(1-cos t)

Stability: BOTH roots satisfy |g| <= 1 for ALL theta in [0, pi].
"""
import numpy as np

def coeffs(T, B, dec_curr=0.0, cfd=0.0):
    dec_inv = 1.0 / (1.0 + dec_curr)
    shift_0 = (2 + 12*B - 2*T) * dec_inv
    shift_1 = (T - 8*B) * dec_inv
    shift_2 = (2*B) * dec_inv
    shift_b = (dec_curr - 1) * dec_inv
    return shift_0, shift_1, shift_2, shift_b, cfd

def max_root_mag(T, B, dec_curr=0.0, cfd=0.0, n_theta=4001):
    """Return max over theta of max(|g1|,|g2|) for the 2-level recurrence."""
    s0, s1, s2, sb, c = coeffs(T, B, dec_curr, cfd)
    thetas = np.linspace(0.0, np.pi, n_theta)
    worst = 0.0
    worst_theta = 0.0
    for t in thetas:
        cost = np.cos(t)
        cos2t = np.cos(2*t)
        A = s0 + 2*s1*cost + 2*s2*cos2t + c*(-2.0)*(1.0 - cost)
        B0 = sb + c*2.0*(1.0 - cost)        # the n-1 level total: g^2 - A g - B0 = 0
        # roots of g^2 - A g - B0 = 0
        roots = np.roots([1.0, -A, -B0])
        m = np.max(np.abs(roots))
        if m > worst:
            worst = m
            worst_theta = t
    return worst, worst_theta

def is_stable(T, B, dec_curr=0.0, cfd=0.0, tol=1e-9):
    m, _ = max_root_mag(T, B, dec_curr, cfd)
    return m <= 1.0 + tol, m

# ---------------------------------------------------------------------------
# PART 1: Pure scheme, no damping (dec_curr=0, cfd=0). Find the exact boundary
#         in the (T, B) plane and test the (T + 4B) <= L hypothesis.
# ---------------------------------------------------------------------------
print("="*78)
print("PART 1: undamped scheme (dec_curr=0, cfd=0) — exact stability boundary")
print("="*78)

# For a grid of B values, bisect on T to find the max stable T (the boundary).
def max_stable_T(B, dec_curr=0.0, cfd=0.0, lo=0.0, hi=4.0, iters=60):
    # find largest T with is_stable True; assume stability is monotone decreasing in T
    if not is_stable(lo, B, dec_curr, cfd)[0]:
        return 0.0
    for _ in range(iters):
        mid = 0.5*(lo+hi)
        if is_stable(mid, B, dec_curr, cfd)[0]:
            lo = mid
        else:
            hi = mid
    return lo

print(f"{'B':>10} {'T_max(boundary)':>16} {'T_max+4B':>10} {'T_max+8B':>10} {'T_max+12B':>11}")
for B in [0.0, 0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.125, 0.2, 0.25]:
    Tm = max_stable_T(B)
    print(f"{B:>10.4f} {Tm:>16.6f} {Tm+4*B:>10.6f} {Tm+8*B:>10.6f} {Tm+12*B:>11.6f}")

print()
print("Interpretation: whichever column (T_max + kB) is ~CONSTANT across B rows")
print("identifies the correct linear combination and the CFL_LIMIT constant.")

# ---------------------------------------------------------------------------
# PART 2: effect of velocity damping dec_curr (does it relax the bound?)
# ---------------------------------------------------------------------------
print()
print("="*78)
print("PART 2: velocity damping dec_curr — does it relax the (T,B) bound?")
print("="*78)
B_test = 0.01
for dec in [0.0, 0.001, 0.01, 0.1, 0.5, 1.0]:
    Tm = max_stable_T(B_test, dec_curr=dec)
    print(f"  B={B_test}, dec_curr={dec:>5}: T_max boundary = {Tm:.6f}  (T_max+4B={Tm+4*B_test:.6f})")

# ---------------------------------------------------------------------------
# PART 3: effect of HF damping cfd (coeff_frequency_decay)
# ---------------------------------------------------------------------------
print()
print("="*78)
print("PART 3: HF damping cfd (coeff_frequency_decay) — relax or tighten?")
print("="*78)
for cfd in [0.0, 0.01, 0.05, 0.1, 0.25, 0.5]:
    Tm = max_stable_T(B_test, cfd=cfd)
    print(f"  B={B_test}, cfd={cfd:>5}: T_max boundary = {Tm:.6f}  (T_max+4B={Tm+4*B_test:.6f})")

# ---------------------------------------------------------------------------
# PART 4: spot-check the simple closed-form candidates at the Nyquist mode
# ---------------------------------------------------------------------------
print()
print("="*78)
print("PART 4: which theta is binding, and closed-form check")
print("="*78)
for (T, B) in [(1.0, 0.0), (0.9, 0.02), (0.5, 0.05), (0.2, 0.1)]:
    m, wt = max_root_mag(T, B)
    print(f"  T={T}, B={B}: max|g|={m:.6f} at theta={wt:.4f} rad ({np.degrees(wt):.1f} deg); T+4B={T+4*B:.4f}")
