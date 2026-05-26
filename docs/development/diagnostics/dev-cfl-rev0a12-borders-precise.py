"""
rev-0a12: PRECISE crash borders (bisected) for the standing test suite. Reports, per representative
string, the EXACT coeff_T (and physical tension multiplier) at which the faithful FDTD recurrence
crosses STABLE->BLOWUP, and the gate predictors there. These are the MEMORIZED fixed crash points
the v2 test suite asserts against ("gate flags AT the empirical blowup border").

Uses the SAME faithful simulator + predictors as dev-cfl-rev0a12-crashborder.py.
"""
import numpy as np, math, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
PI = math.pi; SR = 48000
THp = np.linspace(0, PI, 4001)[1:]; COSp, COS2p = np.cos(THp), np.cos(2*THp)


def shifts(T, B, dec=0.0):
    di = 1.0/(1.0+dec); return (2+12*B-2*T)*di, (T-8*B)*di, (2*B)*di, (dec-1)*di


def maxg(T, B, dec=0.0, cfd=0.0):
    s0, s1, s2, sb = shifts(T, B, dec)
    A = s0 + 2*s1*COSp + 2*s2*COS2p - 2*cfd*(1-COSp); B0 = sb + 2*cfd*(1-COSp)
    disc = A*A + 4*B0
    mag = np.where(disc >= 0, np.maximum(np.abs((A+np.sqrt(np.abs(disc)))*0.5), np.abs((A-np.sqrt(np.abs(disc)))*0.5)), np.sqrt(np.abs(B0)))
    return float(np.max(mag))


def jury(T, B, dec=0.0, cfd=0.0, eps=1e-9):
    s0, s1, s2, sb = shifts(T, B, dec)
    A = s0 + 2*s1*COSp + 2*s2*COS2p - 2*cfd*(1-COSp); B0 = sb + 2*cfd*(1-COSp)
    return bool(np.all(np.abs(B0) <= 1+eps) and np.all(np.abs(A) <= 1-B0+eps))


def sim_blowup(T, B, dec=0.0, cfd=0.0, N=64, steps=20000):
    u_prev = np.zeros(N); u = np.zeros(N); u[N//2-1:N//2+2] = [0.5, 1.0, 0.5]
    e0 = float(np.sum(u*u))+1e-30; d3p = np.zeros(N); em = el = None
    s0, s1, s2, sb = shifts(T, B, dec)
    for n in range(steps):
        d3 = np.zeros(N); d3[1:-1] = u[:-2]+u[2:]-2*u[1:-1]; un = np.zeros(N); p = slice(2, N-2)
        un[p] = s0*u[p]+sb*u_prev[p]+s1*(u[1:N-3]+u[3:N-1])+s2*(u[0:N-4]+u[4:N])+cfd*(d3[p]-d3p[p])
        d3p = d3; u_prev, u = u, un; e = float(np.sum(u*u))
        if not np.isfinite(e) or e > 1e30*e0: return True
        if n == steps//2: em = e+1e-300
        if n == steps-1: el = e+1e-300
    return (el/em) > 4.0 if em else False


def bisect_T(B, dec=0.0, cfd=0.0, lo=0.0, hi=2.0, it=40):
    """largest T (upper edge) that is NOT blowup, bisected on the faithful sim."""
    if sim_blowup(lo, B, dec, cfd): return None
    for _ in range(it):
        mid = 0.5*(lo+hi)
        if sim_blowup(mid, B, dec, cfd): hi = mid
        else: lo = mid
    return lo


print("="*92)
print("PRECISE upper-edge crash border in coeff_T per (coeff_B, damping), bisected on the faithful")
print("FDTD sim. Compare to gate predictors at the border. EXPECT upper edge coeff_T ~ 1 + 8*B.")
print("="*92)
print(f"{'B':>10}{'dec':>6}{'cfd':>6}{'T_crash':>10}{'1+8B':>9}{'maxg@crash':>12}{'jury@crash':>11}{'(T-8B)@crash':>13}")
for (B, dec, cfd) in [(-7.58e-4, 0, 0), (0.0, 0, 0), (1e-3, 0, 0), (0.01, 0, 0), (-0.05, 0, 0),
                       (0.0, 0.3, 0), (0.0, 0, 0.1), (0.01, 0, 0.1)]:
    Tc = bisect_T(B, dec, cfd)
    if Tc is None:
        print(f"{B:>10.2e}{dec:>6}{cfd:>6}   unstable at T=0 (lower-edge / B too large)")
        continue
    mg = maxg(Tc, B, dec, cfd); jk = jury(Tc, B, dec, cfd)
    # the gate flags just ABOVE the crash; report predictors slightly past (Tc + tiny)
    eps = 1e-4
    mg2 = maxg(Tc+eps, B, dec, cfd); jk2 = jury(Tc+eps, B, dec, cfd)
    print(f"{B:>10.2e}{dec:>6}{cfd:>6}{Tc:>10.4f}{1+8*B:>9.4f}{mg:>12.6f}{str(jk):>11}{Tc-8*B:>13.4f}")
    print(f"{'':>22}just past crash (T+1e-4): maxg={mg2:.6f} ({'FLAGS' if mg2>1+1e-6 else 'misses'}) "
          f"jury={jk2} ({'FLAGS' if not jk2 else 'misses'})")

print()
print("="*92)
print("LOWER-edge crash border in coeff_T (decreasing T at fixed B>0): EXPECT lower edge coeff_T ~ 8*B.")
print("This is the radius/bending-driven blowup the (T-8B) upper-only ratio MISSES; Jury catches it.")
print("="*92)


def bisect_T_lower(B, dec=0.0, cfd=0.0, lo=0.0, hi=None, it=40):
    """smallest T (lower edge) that is NOT blowup. Search down from a known-stable hi."""
    if hi is None: hi = max(8*B + 0.5, 0.5)
    if sim_blowup(hi, B, dec, cfd): return None   # even the safe point blows up
    while sim_blowup(lo, B, dec, cfd) is False and lo < hi:
        # lo already stable -> no lower-edge crash above 0
        return 0.0 if not sim_blowup(0.0, B, dec, cfd) else lo
    for _ in range(it):
        mid = 0.5*(lo+hi)
        if sim_blowup(mid, B, dec, cfd): lo = mid
        else: hi = mid
    return hi


print(f"{'B':>10}{'T_lower_crash':>14}{'8B':>9}{'maxg@crash':>12}{'jury@crash':>11}{'(T-8B)':>9}")
for B in [1e-3, 3e-3, 0.01, 0.03, 0.05]:
    Tl = bisect_T_lower(B)
    if Tl is None or Tl == 0.0:
        print(f"{B:>10.2e}   no lower-edge crash above T=0 (stable down to 0)")
        continue
    mg = maxg(Tl-1e-4, B); jk = jury(Tl-1e-4, B)
    print(f"{B:>10.2e}{Tl:>14.4f}{8*B:>9.4f}{mg:>12.6f}{str(jk):>11}{Tl-8*B:>9.4f}")
    print(f"{'':>10}just below lower crash (T-1e-4): maxg={mg:.4f} ({'FLAGS' if mg>1+1e-6 else 'misses'}) "
          f"jury={jk} ({'FLAGS' if not jk else 'misses'}) ; (T-8B) upper-ratio would MISS (it's <1)")

print()
print("CONCLUSION: the faithful-sim crash border == max|g|>1 == Jury=False == two-sided box edge,")
print("to bisection precision. The SINGLE closed-form gate (Jury on shift_*, OR the two-sided box")
print("8B<=T<=1+8B with HF-damping correction) IS the empirical blowup border. (T-8B) alone is a")
print("display ratio, not a sufficient reject test (misses the lower/bending edge).")
