"""
rev-0a12 EMPIRICAL crash-limit study (Part 3). GUARD-INDEPENDENT ground truth.

The live kernel guard PREVENTS blowup (shadow fallback), so a live sweep cannot reveal the TRUE
NaN border. Instead, simulate the ACTUAL FDTD interior-point recurrence (addKernel, MainKernel.cu
503-541) forward in pure numpy from the physics-derived coefficients, and find where the field
ACTUALLY diverges to Inf/NaN. This IS the real numerical scheme (not the stability predictor), so
its blowup border is objective ground truth. Then compute the gate's predictors at that border:
  - max|g| swept (the kernel's cflMaxAmplification, k>=1, the current reject decision)
  - closed-form Jury/Schur (the candidate simple gate)
  - the (T-8B) closed form (the documented ratio)
and report whether each FLAGS exactly AT / BEFORE / AFTER the empirical border.

ALSO distinguishes the two failure modes:
  - BLOWUP: |field| -> Inf/NaN, exponential growth. (CFL target.)
  - COLLAPSE/CLICK: energy decays to ~0 (over-damping or degenerate near-defective drift). NOT CFL.

Physics->coeff (Kernels.cu parameterKernel, exact):
  dxMm2 = (dx*1000)^2 ; iterPerMs = sample_rate*string_iter/1000
  coeff_tension = tension / (dxMm2 * rho * iterPerMs^2)
  coeff_bending = (pi*250000*r^4*E) / (rho * dxMm2^2 * iterPerMs^2)
  cfd = freq_damp * 1e12 / (2*dxMm2)
  dec_curr = gamma/(iterPerMs*1000) + damper*dump ; di=1/(1+dec_curr)
  shift_0=(2+12B-2T)di shift_1=(T-8B)di shift_2=(2B)di shift_b=(dec_curr-1)di
"""
import numpy as np, math, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

PI = math.pi
SR = 48000
TH = np.linspace(0, PI, 4001); THp = TH[1:]
COSp, COS2p = np.cos(THp), np.cos(2*THp)


def phys_to_TBcfd(tension, r, rho, E, dx, freq_damp=0.0, gamma=0.0, string_iter=4):
    dxMm2 = (dx*1000.0)**2
    ipm = SR*string_iter/1000.0
    T = tension/(dxMm2*rho*ipm*ipm)
    B = (PI*250000.0*r**4*E)/(rho*dxMm2*dxMm2*ipm*ipm)
    cfd = freq_damp*1e12/(2*dxMm2)
    dec = gamma/(ipm*1000.0)
    return T, B, cfd, dec


def shifts(T, B, dec=0.0):
    di = 1.0/(1.0+dec)
    return (2+12*B-2*T)*di, (T-8*B)*di, (2*B)*di, (dec-1)*di


def maxg_swept(s0, s1, s2, sb, cfd):
    A = s0 + 2*s1*COSp + 2*s2*COS2p - 2*cfd*(1-COSp)
    B0 = sb + 2*cfd*(1-COSp)
    disc = A*A + 4*B0
    mag = np.where(disc >= 0,
                   np.maximum(np.abs((A+np.sqrt(np.abs(disc)))*0.5), np.abs((A-np.sqrt(np.abs(disc)))*0.5)),
                   np.sqrt(np.abs(B0)))
    return float(np.max(mag))


def jury_ok(s0, s1, s2, sb, cfd, eps=1e-9):
    A = s0 + 2*s1*COSp + 2*s2*COS2p - 2*cfd*(1-COSp)
    B0 = sb + 2*cfd*(1-COSp)
    return bool(np.all(np.abs(B0) <= 1+eps) and np.all(np.abs(A) <= 1-B0+eps))


def simulate_fdtd(s0, s1, s2, sb, cfd, N=64, steps=20000, seed=1):
    """Faithful interior-point recurrence, fixed-fixed boundaries. Returns (status, late_growth_per_step).

    BLOWUP test = the LATE-WINDOW amplitude grows geometrically (ratio of energy over the last
    quarter > 1 per fixed block) OR overflows to Inf/NaN. STABLE = bounded (lossless |g|=1 stays
    bounded; the peak transient is irrelevant). COLLAPSE = late energy decays to ~0.
    For a TRUE exponential instability |g|=1+d, energy ~ (1+d)^{2n} grows without bound; sampling
    energy at n1 and n2=2*n1 in the LATE window gives ratio (1+d)^{2(n2-n1)} >> 1. A lossless |g|=1
    scheme keeps the late-window ratio ~1. This separates real blow-up from oscillatory transient."""
    u_prev = np.zeros(N); u = np.zeros(N)
    u[N//2-1:N//2+2] = np.array([0.5, 1.0, 0.5])
    e0 = float(np.sum(u*u)) + 1e-30
    d3_prev = np.zeros(N)
    e_mid = None; e_late = None
    n_mid = steps // 2; n_late = steps - 1
    for n in range(steps):
        d3 = np.zeros(N)
        d3[1:-1] = u[:-2] + u[2:] - 2*u[1:-1]
        unew = np.zeros(N)
        p = slice(2, N-2)
        unew[p] = (s0*u[p] + sb*u_prev[p]
                   + s1*(u[1:N-3] + u[3:N-1])
                   + s2*(u[0:N-4] + u[4:N])
                   + cfd*(d3[p] - d3_prev[p]))
        d3_prev = d3
        u_prev, u = u, unew
        e = float(np.sum(u*u))
        if not np.isfinite(e) or e > 1e30 * e0:
            return 'BLOWUP', float('inf')
        if n == n_mid:
            e_mid = e + 1e-300
        if n == n_late:
            e_late = e + 1e-300
    # geometric growth between mid and late windows (same step gap):
    ratio = (e_late / e_mid) if (e_mid and e_mid > 0) else 0.0
    if ratio > 4.0:                 # energy at least doubled in amplitude over the 2nd half -> growing
        return 'BLOWUP', ratio
    if e_late < 1e-10 * e0:         # decayed to ~nothing
        return 'COLLAPSE', e_late / e0
    return 'STABLE', ratio


def sweep_param(name, base, mult_lo, mult_hi, nsteps, **physkw):
    """Sweep one physical param multiplicatively; find the empirical FDTD blowup border + classify."""
    print(f"\n--- sweep {name}: base={base:.4g}, x[{mult_lo},{mult_hi}] ---")
    print(f"{'mult':>8}{'value':>12}{'T':>10}{'B':>11}{'maxg':>9}{'jury':>6}{'(T-8B)':>8}{'sim':>9}")
    border = None
    mults = np.geomspace(mult_lo, mult_hi, nsteps) if mult_lo > 0 else np.linspace(mult_lo, mult_hi, nsteps)
    prev_status = None
    for m in mults:
        kw = dict(physkw); kw[name] = base*m
        T, B, cfd, dec = phys_to_TBcfd(**kw)
        s0, s1, s2, sb = shifts(T, B, dec)
        mg = maxg_swept(s0, s1, s2, sb, cfd)
        jok = jury_ok(s0, s1, s2, sb, cfd)
        status, _ = simulate_fdtd(s0, s1, s2, sb, cfd)
        flag = ""
        if prev_status in ('STABLE', None) and status == 'BLOWUP' and border is None:
            border = (m, base*m, T, B, mg)
            flag = "  <== BLOWUP BORDER"
        print(f"{m:>8.3g}{base*m:>12.4g}{T:>10.4f}{B:>11.3e}{mg:>9.4f}{str(jok):>6}{T-8*B:>8.4f}{status:>9}{flag}")
        prev_status = status
    if border:
        m, v, T, B, mg = border
        print(f"  EMPIRICAL BLOWUP at {name}={v:.4g} (mult {m:.3g}): coeff_T={T:.4f} coeff_B={B:.3e}")
        print(f"    gate maxg={mg:.4f} ({'FLAGS' if mg>1+1e-6 else 'MISSES'}); (T-8B)={T-8*B:.4f} "
              f"({'FLAGS' if T-8*B>1 else 'MISSES'})")
    else:
        print(f"  no BLOWUP found in range (all STABLE/COLLAPSE).")
    return border


# Representative physics: pitch 57-like (from live probe): tension~662 r~4e-4 rho? E=-2e11 dx~0.0119
# Need rho. Derive rho so that coeff_T matches the live coeff_T=0.01776 at string_iter=4, dx=0.01193:
#   coeff_T = tension/(dxMm2*rho*ipm^2). dxMm2=(11.93)^2=142.3, ipm=192. => rho=tension/(142.3*192^2*0.01776)
def solve_rho(coeff_T, tension, dx, string_iter=4):
    dxMm2 = (dx*1000.0)**2; ipm = SR*string_iter/1000.0
    return tension/(dxMm2*ipm*ipm*coeff_T)


rho57 = solve_rho(0.01776, 661.9, 0.01193, 4)
print(f"derived rho (pitch57-like) = {rho57:.6g} (so coeff_T matches live 0.01776)")
# Use a POSITIVE small E for bending sweeps (preset stores E negative -> B<0; for the upper-edge blowup
# study we want to push B>0 too). We'll sweep with E sign as in preset for fidelity, and separately positive.
base = dict(tension=661.9, r=4e-4, rho=rho57, E=-2e11, dx=0.01193, freq_damp=0.0, gamma=0.0, string_iter=4)

print("\n" + "="*86)
print("EMPIRICAL CRASH BORDERS — pitch-57-like string, sweep each param toward instability")
print("="*86)
# tension up: coeff_T up -> cross upper CFL edge (blowup expected when coeff_T-8B ~ 1)
sweep_param('tension', base['tension'], 1.0, 200.0, 22, **{k:v for k,v in base.items() if k!='tension'})
# dx DOWN (shorter spacing) -> coeff_T up (1/dx^2), coeff_B up (1/dx^4): blowup
sweep_param('dx', base['dx'], 1.0, 0.05, 22, **{k:v for k,v in base.items() if k!='dx'})
# string_iter DOWN -> ipm down -> coeff_T up (1/ipm^2): blowup
sweep_param('string_iter', base['string_iter'], 1.0, 0.05, 20, **{k:v for k,v in base.items() if k!='string_iter'})
# radius up with POSITIVE E -> coeff_B up (r^4): test bending-driven instability (lower edge T<8B)
basePosE = dict(base); basePosE['E'] = 2e11
sweep_param('r', basePosE['r'], 1.0, 30.0, 22, **{k:v for k,v in basePosE.items() if k!='r'})
# density DOWN -> coeff_T up (1/rho): blowup
sweep_param('rho', base['rho'], 1.0, 0.005, 20, **{k:v for k,v in base.items() if k!='rho'})

print("\n" + "="*86)
print("COLLAPSE direction (length->dx regression family): dx UP -> T,B -> 0 (defective drift)")
print("="*86)
sweep_param('dx', base['dx'], 1.0, 100.0, 16, **{k:v for k,v in base.items() if k!='dx'})
