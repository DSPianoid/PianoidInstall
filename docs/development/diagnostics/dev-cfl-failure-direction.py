"""
dev-cfl: resolve the ACTUAL instability direction of the length->dx regression
and reconcile it with the CFL bound.

length->dx regression: dx was ~84-196x TOO LARGE (1.0 m vs ~0.007-0.012 m).
Since coeff_tension ∝ 1/dx^2 and coeff_bending ∝ 1/dx^4, larger dx => SMALLER
T,B (toward 0), NOT larger. So the failure is the dx-DECREASES-coupling end,
not the T+4B-exceeds-bound end. This script confirms both ends with the exact
von-Neumann amplification factor, and quantifies the marginal double-root at
T=B=0.
"""
import numpy as np

def max_root_mag_and_defect(T, B, dec_curr=0.0, cfd=0.0, n_theta=4001):
    dec_inv = 1.0/(1.0+dec_curr)
    s0=(2+12*B-2*T)*dec_inv; s1=(T-8*B)*dec_inv; s2=(2*B)*dec_inv
    sb=(dec_curr-1)*dec_inv
    th=np.linspace(0,np.pi,n_theta)
    worst=0.0; worst_t=0.0; near_double=False
    for t in th:
        ct=np.cos(t); c2=np.cos(2*t)
        A=s0+2*s1*ct+2*s2*c2+cfd*(-2.0)*(1.0-ct)
        B0=sb+cfd*2.0*(1.0-ct)
        roots=np.roots([1.0,-A,-B0])
        m=np.max(np.abs(roots))
        # detect near-equal roots on/near unit circle (defective -> linear growth)
        if abs(roots[0]-roots[1])<1e-3 and m>0.999:
            near_double=True
        if m>worst:
            worst=m; worst_t=t
    return worst, worst_t, near_double

print("="*78)
print("ACTUAL failure direction test: large dx => T,B -> 0 (loss of coupling)")
print("="*78)
print(f"{'T':>10}{'B':>12}{'max|g|':>12}{'theta*':>9}{'defective?':>12}{'verdict':>12}")
# Walk T,B down toward 0 (as dx grows) — keep B/T ~ realistic small ratio.
for scale in [1.0, 0.5, 0.1, 0.01, 1e-3, 1e-4, 1e-5, 0.0]:
    T = 0.04*scale          # realistic T ~0.04 at scale 1
    B = -1e-4*scale         # realistic small negative B
    m, wt, dd = max_root_mag_and_defect(T, B)
    verdict = "STABLE" if m<=1+1e-7 else ("MARGINAL" if m<=1+1e-4 else "DIVERGE")
    print(f"{T:>10.2e}{B:>12.2e}{m:>12.7f}{wt:>9.4f}{str(dd):>12}{verdict:>12}")

print()
print("Note: at T=B=0 the recurrence is g^2-2g+1=0 => g=1 DOUBLE root (defective):")
print("  bounded-input bounded-output FAILS -> linear (polynomial) growth in n.")
print("  This is the 'string with no restoring force drifts' mode = the noise the")
print("  length->dx regression produced (dx too large => coupling -> 0).")

print()
print("="*78)
print("OTHER end: T+4B EXCEEDS bound (dx too SMALL => T,B grow) — classic CFL")
print("="*78)
print(f"{'T':>10}{'B':>12}{'T+4B':>10}{'max|g|':>12}{'verdict':>12}")
for T in [0.5, 0.9, 0.99, 1.0, 1.01, 1.1, 1.5, 2.0]:
    B = 0.0
    m, wt, dd = max_root_mag_and_defect(T, B)
    verdict = "STABLE" if m<=1+1e-7 else ("MARGINAL" if m<=1+1e-4 else "DIVERGE")
    print(f"{T:>10.4f}{B:>12.4f}{T+4*B:>10.4f}{m:>12.6f}{verdict:>12}")

print()
print("CONCLUSION on the (T+4B) numerator:")
print("  * The UPPER tension-CFL boundary IS exactly T = 1 at B=0 (max|g| crosses 1).")
print("  * For B>0 the boundary moves; for the realistic B≈0/neg regime the operative")
print("    bound is the tension CFL ~ coeff_tension <= 1.")
print("  * (coeff_tension + 4*coeff_bending) <= 1 is a CONSERVATIVE upper-CFL proxy in the")
print("    realistic regime (B small), but it does NOT detect the OTHER failure (T,B->0).")
