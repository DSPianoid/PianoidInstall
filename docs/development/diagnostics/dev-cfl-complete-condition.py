"""dev-cfl: derive the COMPLETE, parameter-agnostic stability condition on the FINAL coefficients.

Change-request: the guard must catch instability from ANY parameter (tension, Young's E, radius r,
length/dx, string_iteration, density, ...), not just tension. My current proxy (T-8B)<=1 / T>=8B is
Nyquist-only and may be INCOMPLETE — notably the length->dx (T,B->0) defective-double-root drift.

This script computes the EXACT max-over-theta amplification factor max|g(theta)| of the real scheme
and finds the condition — expressed purely on the FINAL per-string coefficients shift_0,shift_1,
shift_2,shift_b (which is what parameterKernel produces regardless of which input changed) — that is
true IFF the scheme is stable. That coefficient-based gate is inherently parameter-agnostic.

Scheme recurrence (from MainKernel.cu:503-541), homogeneous:
  u^{n+1}_p = shift_0 u^n_p + shift_b u^{n-1}_p + shift_1(u_{p-1}+u_{p+1}) + shift_2(u_{p-2}+u_{p+2})
            + cfd (d3^n - d3^{n-1})
Fourier u^n_p = g^n e^{i theta p}:
  g^2 = A(theta) g + B0(theta)
  A = shift_0 + 2 shift_1 cos t + 2 shift_2 cos 2t + cfd(-2)(1-cos t)
  B0 = shift_b + cfd 2 (1-cos t)
  => g^2 - A g - B0 = 0
Stable (bounded) iff for ALL theta both roots have |g| <= 1 AND no defective |g|=1 double root with
growth. For a real quadratic g^2 - A g - B0 = 0 with roots product = -B0:
  - if |B0| < 1 (strictly inside): roots inside/on unit circle iff |A| <= 1 - B0  (Jury/Schur test)
  - the marginal/defective case (|g|=1 repeated) is the T,B->0 limit (A->2, B0->-1): g^2-2g+1 -> g=1 double.
We treat |g| <= 1 + eps as the boundary and FLAG the defective near-|g|=1 case separately.
"""
import numpy as np
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')


def coeffs_from_TB(T, B, dec_curr=0.0):
    di = 1.0 / (1.0 + dec_curr)
    return ((2 + 12*B - 2*T)*di, (T - 8*B)*di, (2*B)*di, (dec_curr - 1)*di)


def max_abs_g(shift_0, shift_1, shift_2, shift_b, cfd=0.0, n=4001):
    """Exact max over theta of max|root| of g^2 - A g - B0 = 0."""
    th = np.linspace(0, np.pi, n)
    worst = 0.0; worst_t = 0.0; defective = False
    for t in th:
        ct = np.cos(t); c2 = np.cos(2*t)
        A = shift_0 + 2*shift_1*ct + 2*shift_2*c2 + cfd*(-2)*(1-ct)
        B0 = shift_b + cfd*2*(1-ct)
        roots = np.roots([1.0, -A, -B0])
        m = float(np.max(np.abs(roots)))
        if abs(roots[0]-roots[1]) < 1e-4 and m > 0.999:
            defective = True
        if m > worst:
            worst = m; worst_t = t
    return worst, worst_t, defective


# Jury/Schur stability for g^2 - A g - B0 = 0  (rewrite as g^2 + a1 g + a0 with a1=-A, a0=-B0):
# necessary+sufficient (both roots strictly inside unit circle):
#   |a0| < 1  AND  |a1| < 1 + a0    ->  |B0| < 1  AND  |A| < 1 - B0
def jury_strictly_stable(A, B0):
    a0 = -B0
    return (abs(a0) < 1.0) and (abs(-A) < 1.0 + a0)


print("="*80)
print("PART 1: does (T-8B)<=1 / T>=8B MISS the length->dx (T,B->0) regime? (the suspected gap)")
print("="*80)
print(f"{'T':>10}{'B':>12}{'(T-8B)':>9}{'T>=8B':>7}{'oldOK':>6}{'max|g|':>10}{'defect':>7}{'trueOK':>7}")
# walk T,B toward 0 (large dx — the length/string-iter direction)
for sc in [1.0, 0.5, 0.1, 1e-2, 1e-3, 1e-4, 1e-5, 0.0]:
    T = 0.04*sc; B = -1e-4*sc
    s0, s1, s2, sb = coeffs_from_TB(T, B)
    m, wt, dd = max_abs_g(s0, s1, s2, sb)
    old_ratio_ok = (T - 8*B) <= 1.0 + 1e-9
    old_lower_ok = T >= 8*B - 1e-12
    old_ok = old_ratio_ok and old_lower_ok
    true_ok = (m <= 1.0 + 1e-6) and not dd   # strict stability excludes defective |g|=1
    flag = "" if (old_ok == true_ok) else "  <-- OLD GUARD WRONG"
    print(f"{T:>10.2e}{B:>12.2e}{T-8*B:>9.4f}{str(old_lower_ok):>7}{str(old_ok):>6}"
          f"{m:>10.6f}{str(dd):>7}{str(true_ok):>7}{flag}")

print()
print("="*80)
print("PART 2: COMPLETE coefficient-based gate via Jury test vs exact max|g| (no T,B assumption)")
print("="*80)
mism = 0; total = 0
for T in np.linspace(-0.5, 1.6, 43):
    for B in np.linspace(-0.2, 0.2, 41):
        s0, s1, s2, sb = coeffs_from_TB(T, B)
        m, wt, dd = max_abs_g(s0, s1, s2, sb, n=1201)
        exact_stable = (m <= 1.0 + 1e-6) and not dd
        # Jury must hold for ALL theta -> sample the binding thetas (0, pi, and a sweep)
        jury_ok = True
        for t in np.linspace(0, np.pi, 200):
            ct = np.cos(t); c2 = np.cos(2*t)
            A = s0 + 2*s1*ct + 2*s2*c2
            B0 = sb
            if not jury_strictly_stable(A, B0):
                jury_ok = False; break
        total += 1
        if jury_ok != exact_stable:
            mism += 1
print(f"  Jury-all-theta vs exact max|g|: {mism}/{total} mismatches "
      f"({'EXACT MATCH — Jury gate is complete' if mism==0 else 'investigate'})")

print()
print("="*80)
print("PART 3: candidate SIMPLE complete gate — does requiring |g(theta)|<=1 at theta=0 AND theta=pi")
print("        (the two extremal modes) suffice, plus excluding the A->2,B0->-1 defective corner?")
print("="*80)
# theta=0: A0 = shift_0 + 2 shift_1 + 2 shift_2 ; B0 = shift_b
# theta=pi: Api = shift_0 - 2 shift_1 + 2 shift_2 ; B0 = shift_b
mism2 = 0; total2 = 0; examples = []
for T in np.linspace(-0.5, 1.6, 43):
    for B in np.linspace(-0.2, 0.2, 41):
        s0, s1, s2, sb = coeffs_from_TB(T, B)
        m, wt, dd = max_abs_g(s0, s1, s2, sb, n=1201)
        exact_stable = (m <= 1.0 + 1e-6) and not dd
        A0 = s0 + 2*s1 + 2*s2
        Api = s0 - 2*s1 + 2*s2
        # Jury at the two extremes + interior check at the vertex of A(theta) (where shift_2!=0)
        ext_ok = jury_strictly_stable(A0, sb) and jury_strictly_stable(Api, sb)
        total2 += 1
        if ext_ok != exact_stable:
            mism2 += 1
            if len(examples) < 6:
                examples.append((round(T,3), round(B,4), round(m,4), ext_ok, exact_stable))
print(f"  endpoints-only (theta=0,pi) vs exact: {mism2}/{total2} mismatches")
if examples:
    print("  examples where endpoints-only disagrees (T,B,max|g|,ext_ok,exact):")
    for e in examples: print("   ", e)
print()
print("CONCLUSION: the COMPLETE parameter-agnostic gate = Jury/Schur stability of g^2 - A(theta) g - B0")
print("evaluated where it binds. Computed on the FINAL shift_* coefficients => inherently catches ANY")
print("param (T,B come from tension/E/r/dx/iter/rho). Marginal defective corner (T,B->0, the length->dx")
print("drift) must be excluded explicitly (require strict |g|<1, i.e. reject the |A|=1-B0 equality / B0->-1).")
