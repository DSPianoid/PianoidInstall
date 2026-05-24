"""
dev-cfl: trace the UPPER edge of the stable interval in T for each B, and test
which linear form (T + k*B) is constant along that upper edge. This pins the
exact CFL_LIMIT and the coefficient k (the user fixed k=4; we confirm/contrast).

From the analytic Nyquist result the stable interval in T (at dec=cfd=0) is
   8B <= T <= 1 + 8B.
The UPPER edge is therefore T_upper(B) = 1 + 8B, i.e.  T - 8B = 1 constant.
=> Along the UPPER (CFL) boundary the invariant is (T - 8B), NOT (T + 4B).
This script verifies that numerically with the exact amplification factor and
also checks interior-theta (not just Nyquist) so the box result is validated
on the upper edge specifically.
"""
import numpy as np
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

def max_root_mag(T, B, dec_curr=0.0, cfd=0.0, n_theta=6001):
    dec_inv=1.0/(1.0+dec_curr)
    s0=(2+12*B-2*T)*dec_inv; s1=(T-8*B)*dec_inv; s2=(2*B)*dec_inv
    sb=(dec_curr-1)*dec_inv
    th=np.linspace(0,np.pi,n_theta); worst=0.0
    for t in th:
        ct=np.cos(t); c2=np.cos(2*t)
        A=s0+2*s1*ct+2*s2*c2+cfd*(-2.0)*(1.0-ct)
        B0=sb+cfd*2.0*(1.0-ct)
        m=np.max(np.abs(np.roots([1.0,-A,-B0])))
        if m>worst: worst=m
    return worst

def stable(T,B,**k): return max_root_mag(T,B,**k)<=1.0+1e-9

def upper_T(B, dec_curr=0.0, cfd=0.0):
    """largest T that is still stable, searching upward from a known-stable T."""
    # start just above the lower edge 8B (or 0)
    lo = max(8*B, 0.0) + 1e-6
    if not stable(lo,B,dec_curr=dec_curr,cfd=cfd):
        # whole interval may be empty for this B; scan
        for Tt in np.linspace(0,2,400):
            if stable(Tt,B,dec_curr=dec_curr,cfd=cfd):
                lo=Tt; break
        else:
            return None
    hi = lo + 2.0
    for _ in range(60):
        mid=0.5*(lo+hi)
        if stable(mid,B,dec_curr=dec_curr,cfd=cfd): lo=mid
        else: hi=mid
    return lo

print("UPPER CFL boundary T_upper(B) and candidate invariants (dec=0, cfd=0):")
print(f"{'B':>10}{'T_upper':>12}{'T_up-8B':>10}{'T_up+4B':>10}{'T_up+8B':>10}")
for B in [0.0,0.005,0.01,0.02,0.05,0.1,0.15,0.2,0.25]:
    Tu=upper_T(B)
    if Tu is None:
        print(f"{B:>10.4f}   (no stable T)"); continue
    print(f"{B:>10.4f}{Tu:>12.6f}{Tu-8*B:>10.6f}{Tu+4*B:>10.6f}{Tu+8*B:>10.6f}")

print("\n=> The column that stays ~1.0 identifies the exact upper-CFL invariant.")

print("\nEffect of velocity damping dec_curr on the UPPER boundary (B=0.01):")
for dec in [0.0,0.01,0.1,0.5,1.0,2.0]:
    Tu=upper_T(0.01,dec_curr=dec)
    print(f"  dec_curr={dec:>5}: T_upper={Tu:.6f}  (T_up-8B={Tu-0.08:.6f})  "
          f"=> damping {'RELAXES' if Tu>1.08+1e-4 else 'no-relax' } upper bound")

print("\nEffect of HF damping cfd on the UPPER boundary (B=0.01):")
for c in [0.0,0.05,0.1,0.25,0.5,1.0]:
    Tu=upper_T(0.01,cfd=c)
    print(f"  cfd={c:>5}: T_upper={Tu:.6f}  (T_up-8B={Tu-0.08:.6f})")
