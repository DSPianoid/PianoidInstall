"""
rev-0a12 INDEPENDENT von-Neumann derivation (VECTORIZED — fast). Resolves Q1-Q4.

Scheme: u^{n+1}_p = shift_0 u^n_p + shift_b u^{n-1}_p + shift_1(u_{p-1}+u_{p+1})
                  + shift_2(u_{p-2}+u_{p+2}) + cfd(d3^n - d3^{n-1}),  d3=u_{p-1}+u_{p+1}-2u_p
  shift_0=(2+12B-2T)di  shift_1=(T-8B)di  shift_2=(2B)di  shift_b=(dec_curr-1)di  di=1/(1+dec_curr)
Fourier u^n_p=g^n e^{i t p}:  g^2 - A(t) g - B0(t) = 0
  A = shift_0 + 2 shift_1 cos t + 2 shift_2 cos 2t - 2 cfd (1-cos t)
  B0= shift_b + 2 cfd (1-cos t)
Closed-disk (Schur/Jury) for g^2+a1 g+a0, a1=-A,a0=-B0: |g|<=1 both roots iff
  |a0|<=1 (|B0|<=1)  AND  |a1|<=1+a0 (|A|<=1-B0).
"""
import numpy as np
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

TH = np.linspace(0.0, np.pi, 4001)          # full sweep incl. theta=0
TH_POS = TH[1:]                              # exclude theta=0 (DC)
COS = np.cos(TH); COS2 = np.cos(2*TH)
COSp = np.cos(TH_POS); COS2p = np.cos(2*TH_POS)


def shifts(T, B, dec_curr=0.0):
    di = 1.0/(1.0+dec_curr)
    return (2+12*B-2*T)*di, (T-8*B)*di, (2*B)*di, (dec_curr-1)*di


def maxg(T, B, dec_curr=0.0, cfd=0.0, exclude_dc=True):
    s0, s1, s2, sb = shifts(T, B, dec_curr)
    cos = COSp if exclude_dc else COS
    cos2 = COS2p if exclude_dc else COS2
    A = s0 + 2*s1*cos + 2*s2*cos2 - 2*cfd*(1-cos)
    B0 = sb + 2*cfd*(1-cos)
    disc = A*A + 4*B0
    mag = np.empty_like(A)
    pos = disc >= 0
    sq = np.sqrt(np.abs(disc))
    mag[pos] = np.maximum(np.abs((A[pos]+sq[pos])*0.5), np.abs((A[pos]-sq[pos])*0.5))
    mag[~pos] = np.sqrt(np.abs(B0[~pos]))
    k = int(np.argmax(mag))
    return float(mag[k]), float((cos if False else (TH_POS if exclude_dc else TH))[k])


def jury_ok(T, B, dec_curr=0.0, cfd=0.0, eps=1e-9, exclude_dc=True):
    s0, s1, s2, sb = shifts(T, B, dec_curr)
    cos = COSp if exclude_dc else COS
    cos2 = COS2p if exclude_dc else COS2
    A = s0 + 2*s1*cos + 2*s2*cos2 - 2*cfd*(1-cos)
    B0 = sb + 2*cfd*(1-cos)
    return bool(np.all(np.abs(B0) <= 1+eps) and np.all(np.abs(A) <= 1-B0+eps))


print("="*86)
print("Q2/Q3: theta=0 (DC mode), undamped. A(0)=s0+2s1+2s2, B0(0)=sb. Symbolically:")
print("  A(0) = (2+12B-2T)+2(T-8B)+2(2B) = 2+12B-2T+2T-16B+4B = 2  (exactly, all T,B)")
print("  B0(0) = sb = -1 (undamped). => g^2-2g+1=0 => g=1 DOUBLE root. |g(0)|=1 EXACT but DEFECTIVE.")
print("  The live |g(0)|=1.00042 is FLOAT ROUNDOFF on this exact double root (disc=A^2+4B0 flips +eps).")
print("  Physically: theta=0 is rigid translation; a FIXED-FIXED string pins it (not a free mode).")
print("  => excluding theta=0 is JUSTIFIED. It is NOT a damping-discretization error at DC.")
print("  Numeric confirmation (undamped):")
for (T, B) in [(0.5, 0.0), (0.04, -1e-4), (0.8, 0.05)]:
    s0, s1, s2, sb = shifts(T, B)
    A0 = s0+2*s1+2*s2; B00 = sb
    print(f"    T={T} B={B}: A(0)={A0:.10f} B0(0)={B00:.6f} disc(0)={A0*A0+4*B00:.3e}")

print()
print("="*86)
print("Q2: binding theta NEAR upper edge (undamped, exclude DC). Doc says Nyquist theta=pi.")
print("="*86)
print(f"{'T':>8}{'B':>8}{'maxg(excl DC)':>14}{'theta*':>9}{'deg':>7}{'maxg@pi':>10}")
for (T, B) in [(0.99,0.0),(1.0,0.0),(1.001,0.0),(1.01,0.0),(0.9,0.02),(0.5,0.05),(0.2,0.1)]:
    m, t = maxg(T, B)
    s0,s1,s2,sb = shifts(T,B)
    Ap = s0-2*s1+2*s2; gp = max(abs(0.5*(Ap+np.sqrt(Ap*Ap+4*sb+0j))),abs(0.5*(Ap-np.sqrt(Ap*Ap+4*sb+0j))))
    print(f"{T:>8.3f}{B:>8.3f}{m:>14.6f}{t:>9.4f}{np.degrees(t):>7.1f}{gp:>10.6f}")
print("  NOTE: as T->1- the binding theta -> 0+ (NOT pi). The growth onset is at LONG wavelengths")
print("  near DC, not Nyquist. The doc's 'binding wavenumber = Nyquist theta=pi' is the LOWER-edge")
print("  binding mode (T<8B self-amplifies at pi). For the UPPER (CFL) edge the binding theta->0+.")

print()
print("="*86)
print("Q1: exact stable band edges in T per B (undamped, exclude DC). EXPECT lower=8B, upper=1+8B.")
print("="*86)
Ts = np.linspace(-0.05, 1.6, 6601)
print(f"{'B':>8}{'T_lo':>10}{'T_hi':>10}{'T_lo-8B':>10}{'T_hi-8B':>10}")
for B in [0.0,0.001,0.005,0.01,0.02,0.05,0.1]:
    stab = np.array([maxg(T, B)[0] <= 1+1e-7 for T in Ts])
    if stab.any():
        lo = Ts[stab][0]; hi = Ts[stab][-1]
        print(f"{B:>8.3f}{lo:>10.4f}{hi:>10.4f}{lo-8*B:>10.4f}{hi-8*B:>10.4f}")
    else:
        print(f"{B:>8.3f}  (no stable T found)")

print()
print("="*86)
print("Q1 damping: does dec_curr move edges? does cfd tighten the upper edge?")
print("="*86)
for dec in [0.0,0.1,0.5,1.0,2.0]:
    stab = np.array([maxg(T, 0.01, dec_curr=dec)[0] <= 1+1e-7 for T in Ts])
    hi = Ts[stab][-1] if stab.any() else float('nan')
    print(f"  dec_curr={dec:>4}: B=0.01 upper T_hi={hi:.4f} (T_hi-8B={hi-0.08:.4f})")
for cfd in [0.0,0.05,0.1,0.25,0.5]:
    stab = np.array([maxg(T, 0.01, cfd=cfd)[0] <= 1+1e-7 for T in Ts])
    hi = Ts[stab][-1] if stab.any() else float('nan')
    print(f"  cfd={cfd:>5}: B=0.01 upper T_hi={hi:.4f} (T_hi-8B={hi-0.08:.4f})")

print()
print("="*86)
print("Q4: closed-form Jury gate (excl DC) vs exact maxg over (T,B) grid + damping. simplicity test.")
print("="*86)
for label, decc, cfdd in [("undamped", 0.0, 0.0), ("dec=0.3", 0.3, 0.0), ("cfd=0.1", 0.0, 0.1)]:
    mism = 0; total = 0; ex = []
    for T in np.linspace(-0.2, 1.4, 49):
        for B in np.linspace(-0.05, 0.15, 31):
            m, _ = maxg(T, B, decc, cfdd)
            exact = m <= 1+1e-7
            jok = jury_ok(T, B, decc, cfdd)
            total += 1
            if jok != exact:
                mism += 1
                if len(ex) < 4: ex.append((round(T,3),round(B,4),round(m,5),jok,exact))
    print(f"  [{label}] Jury vs exact: {mism}/{total} mismatches" + ("" if mism==0 else f"  examples={ex}"))

print()
print("="*86)
print("Q4b: does the SIMPLE 2-mode check (Jury at theta=pi only, + isfinite + lower-edge T>=8B)")
print("     reproduce stability over the PHYSICAL regime (B small, T in [0,~0.05])? + a wide grid?")
print("="*86)


def simple_gate(T, B, dec_curr=0.0):
    # closed form at Nyquist theta=pi: A(pi)=s0-2s1+2s2 ; B0(pi)=sb. Plus lower edge + nonstrict.
    s0, s1, s2, sb = shifts(T, B, dec_curr)
    Ap = s0 - 2*s1 + 2*s2          # = (2+32B-4T)*di
    # upper edge from |A(pi)|<=1-B0(pi): with sb=-1/(...) ... just test |Ap|<=1-sb (Jury at pi)
    return (abs(sb) <= 1+1e-9) and (abs(Ap) <= 1-sb+1e-9)


for label in ["physical (T<=0.05,B<=0.001)", "wide"]:
    if label.startswith("phys"):
        Tg = np.linspace(0, 0.06, 31); Bg = np.linspace(-0.005, 0.005, 21)
    else:
        Tg = np.linspace(-0.2, 1.4, 49); Bg = np.linspace(-0.05, 0.15, 31)
    mism = 0; total = 0; ex = []
    for T in Tg:
        for B in Bg:
            m, _ = maxg(T, B)
            exact = m <= 1+1e-7
            sg = simple_gate(T, B)
            total += 1
            if sg != exact:
                mism += 1
                if len(ex) < 5: ex.append((round(T,4),round(B,5),round(m,5),sg,exact))
    print(f"  [{label}] Nyquist-only Jury vs exact: {mism}/{total}" + ("" if mism==0 else f"  ex={ex}"))
print("  (If Nyquist-only mismatches in the WIDE grid but MATCHES physical, then the interior-theta")
print("   binding only matters far outside real presets — informs whether the 48-pt sweep is needed.)")
