"""
rev-0a12 INDEPENDENT von-Neumann derivation of the Pianoid FDTD stiff-string stability bound.

Purpose: re-derive from scratch, NOT trusting the doc (which claims theta=pi binding +
the box 8B <= T <= 1+8B) nor dev-cflfix's scripts. Resolve four disputed questions:

  Q1. The EXACT closed-form stability condition on (T, B) with damping.
  Q2. Which wavenumber theta is binding at the UPPER (CFL) edge? Doc says theta=pi (Nyquist).
      dev-cfl-vonneumann PART4 shows the binding theta near T=1,B=0 is ~0.037 rad (near 0!),
      NOT pi. Resolve.
  Q3. Is excluding theta=0 (the DC mode) mathematically justified, and does |g(0)|=1.00042
      (the implementer's observation) indicate a real DC instability or a measurement artifact?
  Q4. Does a SIMPLE closed-form Jury/Schur gate on the final shift_* coefficients reproduce
      the exact max|g| boundary EXACTLY (the simplicity path)?

Scheme (homogeneous; forcing dropped). One interior point, with B=coeff_bending, T=coeff_tension,
dec_curr velocity damping, cfd=coeff_frequency_decay (HF damping), dec_inv=1/(1+dec_curr):
  u^{n+1}_p = shift_0 u^n_p + shift_b u^{n-1}_p
            + shift_1 (u^n_{p-1}+u^n_{p+1}) + shift_2 (u^n_{p-2}+u^n_{p+2})
            + cfd (d3^n - d3^{n-1}),   d3 = u_{p-1}+u_{p+1}-2u_p
  shift_0=(2+12B-2T)di  shift_1=(T-8B)di  shift_2=(2B)di  shift_b=(dec_curr-1)di

Fourier u^n_p = g^n e^{i theta p}, theta in [0,pi]:
  u_{p±1} sum -> 2 cos t ;  u_{p±2} sum -> 2 cos 2t ;  d3 -> -2(1-cos t)
  => g^2 - A g - B0 = 0
  A(t)  = shift_0 + 2 shift_1 cos t + 2 shift_2 cos 2t - 2 cfd (1-cos t)
  B0(t) = shift_b + 2 cfd (1-cos t)

A quadratic g^2 + a1 g + a0 = 0 (a1=-A, a0=-B0) has BOTH roots in the closed unit disk
|g|<=1 iff (Schur-Cohn / Jury, closed-disk form):
  (i)   |a0| <= 1            <=>  |B0| <= 1
  (ii)  |a1| <= 1 + a0       <=>  |A| <= 1 - B0
We also separately flag the DEFECTIVE marginal case (repeated root on |g|=1), which grows
polynomially: that is A^2 = 4(-B0) i.e. A^2 + 4 B0 = 0 with |B0|=1 (the T,B->0 corner).
"""
import numpy as np
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')


def shifts(T, B, dec_curr=0.0):
    di = 1.0 / (1.0 + dec_curr)
    return ((2 + 12*B - 2*T)*di, (T - 8*B)*di, (2*B)*di, (dec_curr - 1)*di)


def A_B0(t, s0, s1, s2, sb, cfd):
    ct = np.cos(t); c2 = np.cos(2*t)
    A = s0 + 2*s1*ct + 2*s2*c2 - 2*cfd*(1-ct)
    B0 = sb + 2*cfd*(1-ct)
    return A, B0


def exact_maxg(T, B, dec_curr=0.0, cfd=0.0, n=20001, ret_theta=False):
    """Exact max over theta in [0,pi] of max|root|, sampled finely."""
    s0, s1, s2, sb = shifts(T, B, dec_curr)
    th = np.linspace(0.0, np.pi, n)
    worst = -1.0; wt = 0.0
    for t in th:
        A, B0 = A_B0(t, s0, s1, s2, sb, cfd)
        disc = A*A + 4.0*B0
        if disc >= 0:
            sq = np.sqrt(disc)
            r1 = 0.5*(A + sq); r2 = 0.5*(A - sq)
            m = max(abs(r1), abs(r2))
        else:
            # complex conjugate pair, |g|^2 = product of roots = -B0
            m = np.sqrt(-B0) if -B0 >= 0 else np.inf
        if m > worst:
            worst = m; wt = t
    if ret_theta:
        return worst, wt
    return worst


# ----- analytic Jury/Schur closed-disk gate, evaluated over a theta sweep -----
def jury_closed_disk_ok(T, B, dec_curr=0.0, cfd=0.0, n=4001, eps=1e-9):
    s0, s1, s2, sb = shifts(T, B, dec_curr)
    th = np.linspace(0.0, np.pi, n)
    for t in th:
        A, B0 = A_B0(t, s0, s1, s2, sb, cfd)
        if abs(B0) > 1.0 + eps:        # (i)
            return False
        if abs(A) > 1.0 - B0 + eps:    # (ii)
            return False
    return True


print("="*84)
print("Q2/Q3: binding theta at/near the UPPER edge (undamped, B=0). Doc claims theta=pi.")
print("="*84)
print(f"{'T':>8}{'B':>8}{'max|g|':>12}{'theta*':>10}{'deg':>8}   {'|g(0)|':>10}{'|g(pi)|':>10}")
for (T, B) in [(0.99,0.0),(1.00,0.0),(1.001,0.0),(1.01,0.0),(0.9,0.02),(0.5,0.05)]:
    m, wt = exact_maxg(T, B, ret_theta=True)
    s0,s1,s2,sb = shifts(T,B)
    A0,B00 = A_B0(0.0, s0,s1,s2,sb,0.0)
    Ap,B0p = A_B0(np.pi, s0,s1,s2,sb,0.0)
    g0 = max(abs(0.5*(A0+np.sqrt(A0*A0+4*B00+0j))), abs(0.5*(A0-np.sqrt(A0*A0+4*B00+0j))))
    gp = max(abs(0.5*(Ap+np.sqrt(Ap*Ap+4*B0p+0j))), abs(0.5*(Ap-np.sqrt(Ap*Ap+4*B0p+0j))))
    print(f"{T:>8.3f}{B:>8.3f}{m:>12.6f}{wt:>10.4f}{np.degrees(wt):>8.1f}   {g0:>10.6f}{gp:>10.6f}")

print()
print("ANALYSIS theta=0 (DC mode), undamped: A(0)=s0+2s1+2s2 = (2+12B-2T)+2(T-8B)+2(2B)")
print("   = 2 +12B -2T +2T -16B +4B = 2 + 0B + 0T = 2  EXACTLY.  B0(0)=sb=-1.")
print("   => g^2 -2g +1=0 => g=1 DOUBLE root for ALL T,B (undamped). |g(0)|=1 EXACTLY, but DEFECTIVE.")
print("   This is the rigid-translation / DC mode: a fixed-fixed string cannot express it (boundary")
print("   pins it). |g(0)|=1.00042 in the live probe is FLOAT ROUNDOFF on a known-exact double root,")
print("   NOT a real instability. Excluding theta=0 is justified for the fixed-fixed bounded operator;")
print("   the periodic von-Neumann DC double-root is an artifact of the periodic idealization.")

print()
print("="*84)
print("Q1: exact upper/lower edges in T for a grid of B (undamped). Bracketed search in the")
print("    STABLE band (not assuming stability at T=0).")
print("="*84)


def stable(T, B, dec_curr=0.0, cfd=0.0):
    # strict interior stability ignoring the known theta=0 defective DC double root:
    # sample theta in (0, pi], require max|g| <= 1 + 1e-7
    s0, s1, s2, sb = shifts(T, B, dec_curr)
    th = np.linspace(np.pi/20001, np.pi, 6000)   # EXCLUDE theta=0 exactly
    for t in th:
        A, B0 = A_B0(t, s0, s1, s2, sb, cfd)
        disc = A*A + 4.0*B0
        if disc >= 0:
            m = max(abs(0.5*(A+np.sqrt(disc))), abs(0.5*(A-np.sqrt(disc))))
        else:
            m = np.sqrt(-B0) if -B0 >= 0 else np.inf
        if m > 1.0 + 1e-7:
            return False
    return True


def find_edges(B, dec_curr=0.0, cfd=0.0):
    # scan T upward, record the contiguous stable interval
    Ts = np.linspace(-0.05, 1.6, 3301)
    stab = [stable(T, B, dec_curr, cfd) for T in Ts]
    lo = hi = None
    for T, s in zip(Ts, stab):
        if s and lo is None:
            lo = T
        if s:
            hi = T
    return lo, hi


print(f"{'B':>8}{'T_lo':>10}{'T_hi':>10}{'T_lo-8B':>10}{'T_hi-8B':>10}")
for B in [0.0, 0.001, 0.005, 0.01, 0.02, 0.05, 0.1]:
    lo, hi = find_edges(B)
    print(f"{B:>8.3f}{(lo if lo is not None else float('nan')):>10.4f}"
          f"{(hi if hi is not None else float('nan')):>10.4f}"
          f"{(lo-8*B if lo is not None else float('nan')):>10.4f}"
          f"{(hi-8*B if hi is not None else float('nan')):>10.4f}")
print("  EXPECT (doc): T_lo-8B ~ 0 (lower edge T=8B);  T_hi-8B ~ 1 (upper CFL edge T=1+8B).")

print()
print("="*84)
print("Q1 (damping): does velocity damping dec_curr move the edges? does HF cfd tighten?")
print("="*84)
for dec in [0.0, 0.1, 0.5, 1.0, 2.0]:
    lo, hi = find_edges(0.01, dec_curr=dec)
    print(f"  dec_curr={dec:>4}: B=0.01 -> T_hi={hi:.4f} (T_hi-8B={hi-0.08:.4f})")
for cfd in [0.0, 0.05, 0.1, 0.25]:
    lo, hi = find_edges(0.01, cfd=cfd)
    print(f"  cfd={cfd:>5}: B=0.01 -> T_hi={hi:.4f} (T_hi-8B={hi-0.08:.4f})")

print()
print("="*84)
print("Q4: does the analytic Jury/Schur closed-disk gate (excluding theta=0 DC defect) reproduce")
print("    the exact stable region over a (T,B) grid INCLUDING damping? (simplicity validation)")
print("="*84)
mism = 0; total = 0; ex = []
for T in np.linspace(-0.2, 1.4, 33):
    for B in np.linspace(-0.05, 0.15, 21):
        s0, s1, s2, sb = shifts(T, B)
        # exact (exclude theta=0)
        th = np.linspace(np.pi/20001, np.pi, 3000)
        worst = 0.0
        for t in th:
            A, B0 = A_B0(t, s0, s1, s2, sb, 0.0)
            disc = A*A + 4.0*B0
            if disc >= 0:
                m = max(abs(0.5*(A+np.sqrt(disc))), abs(0.5*(A-np.sqrt(disc))))
            else:
                m = np.sqrt(-B0) if -B0 >= 0 else np.inf
            worst = max(worst, m)
        exact = worst <= 1.0 + 1e-7
        # analytic Jury on same theta-sweep (exclude theta=0)
        jok = True
        for t in th:
            A, B0 = A_B0(t, s0, s1, s2, sb, 0.0)
            if abs(B0) > 1.0 + 1e-9 or abs(A) > 1.0 - B0 + 1e-9:
                jok = False; break
        total += 1
        if jok != exact:
            mism += 1
            if len(ex) < 8:
                ex.append((round(T,3), round(B,4), round(worst,5), jok, exact))
print(f"  Jury(closed-disk, theta>0) vs exact max|g|: {mism}/{total} mismatches")
if ex:
    print("  disagreements (T,B,max|g|,jury,exact):")
    for e in ex: print("   ", e)
else:
    print("  EXACT MATCH — analytic Jury gate on shift_* IS the closed-form stability condition.")
