"""dev-eac2 — Directive C exactness check (PURE PYTHON, no engine/GPU/Flask). FAST rewrite.

Question: is the shipped K=24 grid gate (cfl_stability.max_amplification) PERMISSIVE vs the engine's
true FDTD boundary? Engine recurrence: g^2 - A(theta) g - B0(theta) = 0, stable iff max_theta|g| <= 1.

Key idea: for the cfd=0 (undamped) case there is an EXACT, GRID-FREE criterion. With x = cos(theta):
    A(x) = (s0 - 2 s2) + 2 s1 x + 4 s2 x^2     (since cos2t = 2x^2 - 1)  -- quadratic in x in [-1,1]
    B0   = sb = -1 (undamped)  => roots multiply to 1 => |g|<=1 iff |A(x)| <= 2 for all x in [-1,1].
So max|A| over x in [-1,1] (endpoints + vertex of the quadratic) gives the EXACT stability test with
NO theta grid. For cfd>0 the same x-substitution makes A and B0 quadratics in x; we still only need to
check the parabola endpoints+vertex of |g|(x) -> but |g| is not polynomial, so for cfd>0 we use a fine
dense grid as truth. (Real presets run cfd~0; cfd only TIGHTENS the bound, so cfd=0 is the loosest =
the case where a permissive gate matters most.)

Run: PianoidCore/.venv/Scripts/python.exe docs/development/diagnostics/dev-eac2-cfl-exactness-check.py
"""
import math
import numpy as np

EPS = 1e-6   # CFL_STABILITY_EPS in cfl_stability.py


# ---- shipped K=24 grid (copy of cfl_stability.max_amplification, vectorized over (T,B) arrays) ----
def amp_grid_vec(T, B, dec_curr=0.0, cfd=0.0, K=24):
    T = np.asarray(T, float); B = np.asarray(B, float)
    dec_inv = 1.0 / (1.0 + dec_curr)
    s0 = (2.0 + 12.0 * B - 2.0 * T) * dec_inv
    s1 = (T - 8.0 * B) * dec_inv
    s2 = (2.0 * B) * dec_inv
    sb = (dec_curr - 1.0) * dec_inv
    ks = np.arange(1, K + 1)
    th = math.pi * ks / K
    ct = np.cos(th)[None, :]; c2 = np.cos(2.0 * th)[None, :]
    A = s0[:, None] + 2.0 * s1[:, None] * ct + 2.0 * s2[:, None] * c2 - 2.0 * cfd * (1.0 - ct)
    B0 = sb + 2.0 * cfd * (1.0 - ct)
    disc = A * A + 4.0 * B0
    sq = np.sqrt(np.abs(disc))
    real_mag = np.maximum(np.abs((A + sq) * 0.5), np.abs((A - sq) * 0.5))
    cplx_mag = np.sqrt(np.abs(B0))
    mag = np.where(disc >= 0.0, real_mag, cplx_mag)
    return np.max(mag, axis=1)


def amp_dense_vec(T, B, dec_curr=0.0, cfd=0.0, N=20000):
    """Dense theta truth (excludes DC theta=0). Vectorized over (T,B) arrays."""
    T = np.asarray(T, float); B = np.asarray(B, float)
    dec_inv = 1.0 / (1.0 + dec_curr)
    s0 = (2.0 + 12.0 * B - 2.0 * T) * dec_inv
    s1 = (T - 8.0 * B) * dec_inv
    s2 = (2.0 * B) * dec_inv
    sb = (dec_curr - 1.0) * dec_inv
    th = np.linspace(0.0, math.pi, N + 1)[1:]
    ct = np.cos(th)[None, :]; c2 = np.cos(2.0 * th)[None, :]
    A = s0[:, None] + 2.0 * s1[:, None] * ct + 2.0 * s2[:, None] * c2 - 2.0 * cfd * (1.0 - ct)
    B0 = sb + 2.0 * cfd * (1.0 - ct)
    disc = A * A + 4.0 * B0
    sq = np.sqrt(np.abs(disc))
    real_mag = np.maximum(np.abs((A + sq) * 0.5), np.abs((A - sq) * 0.5))
    cplx_mag = np.sqrt(np.abs(B0))
    mag = np.where(disc >= 0.0, real_mag, cplx_mag)
    return np.max(mag, axis=1)


def exact_maxabsA_undamped(T, B):
    """EXACT max|A(theta)| over theta (undamped). A(x)=4 s2 x^2 + 2 s1 x + (s0-2 s2), x=cos t in [-1,1].
    Returns scalar. Stable iff <= 2. Vectorizable via the elementwise version below."""
    s0 = 2.0 + 12.0 * B - 2.0 * T
    s1 = T - 8.0 * B
    s2 = 2.0 * B
    a = 4.0 * s2; b = 2.0 * s1; c = s0 - 2.0 * s2
    cands = [abs(a + b + c), abs(a - b + c)]   # x = +1, -1
    if a != 0.0:
        xv = -b / (2.0 * a)
        if -1.0 <= xv <= 1.0:
            cands.append(abs(a * xv * xv + b * xv + c))
    return max(cands)


def exact_amp_undamped_vec(T, B):
    """EXACT |g|max (undamped) from max|A|: |g|=1 if |A|<=2 else (|A|+sqrt(A^2-4))/2."""
    T = np.asarray(T, float); B = np.asarray(B, float)
    s0 = 2.0 + 12.0 * B - 2.0 * T
    s1 = T - 8.0 * B
    s2 = 2.0 * B
    a = 4.0 * s2; b = 2.0 * s1; c = s0 - 2.0 * s2
    A_p1 = np.abs(a + b + c)       # x=+1
    A_m1 = np.abs(a - b + c)       # x=-1
    maxA = np.maximum(A_p1, A_m1)
    with np.errstate(divide='ignore', invalid='ignore'):
        xv = np.where(a != 0.0, -b / (2.0 * a), np.nan)
        inrange = np.isfinite(xv) & (xv >= -1.0) & (xv <= 1.0)
        A_v = np.abs(a * xv * xv + b * xv + c)
        maxA = np.where(inrange, np.maximum(maxA, A_v), maxA)
    g = np.where(maxA > 2.0, (maxA + np.sqrt(np.maximum(maxA * maxA - 4.0, 0.0))) / 2.0, 1.0)
    return g, maxA


def stable(a):
    return np.isfinite(a) & (a <= 1.0 + EPS)


print("=" * 92)
print("TEST 1 — K=24 grid vs DENSE(N=20000) max|g| over the (T,B) regime incl. fine sweep across the edge")
print("=" * 92)
Bs = np.linspace(-0.01, 0.12, 53)
fa = fr = samples = 0
maxd = 0.0; worst_fa = None
for B in Bs:
    edge = 1.0 + 8.0 * B
    Ts = np.concatenate([np.linspace(0.0, max(edge * 1.05, 0.05), 600),
                         np.linspace(edge - 0.02, edge + 0.02, 600)])
    Barr = np.full_like(Ts, B)
    a24 = amp_grid_vec(Ts, Barr, K=24)
    ad = amp_dense_vec(Ts, Barr, N=20000)
    samples += Ts.size
    maxd = max(maxd, float(np.max(np.abs(a24 - ad))))
    s24 = stable(a24); sd = stable(ad)
    fa_mask = s24 & ~sd       # K24 stable but dense unstable = PERMISSIVE
    fr_mask = sd & ~s24       # conservative
    fa += int(np.sum(fa_mask)); fr += int(np.sum(fr_mask))
    if np.any(fa_mask):
        idx = np.argmax(np.where(fa_mask, ad - a24, -1))
        if worst_fa is None or (ad[idx] - a24[idx]) > worst_fa[2]:
            worst_fa = (Ts[idx], B, ad[idx] - a24[idx], a24[idx], ad[idx])
print(f"samples={samples}  max|a24 - a_dense|={maxd:.3e}")
print(f"FALSE-ACCEPT (K24 stable, dense unstable = PERMISSIVE): {fa}")
print(f"FALSE-REJECT (K24 unstable, dense stable = conservative): {fr}")
if worst_fa:
    T, B, gap, a24v, adv = worst_fa
    print(f"  worst permissive: T={T:.6f} B={B:.6f}  a24={a24v:.8f}  a_dense={adv:.8f}  gap(dense-K24)={gap:.2e}")

print()
print("=" * 92)
print("TEST 2 — EXACT analytic |g| (grid-free, undamped) vs DENSE: do they agree to round-off?")
print("=" * 92)
Tgrid = np.linspace(0.0, 1.25, 2000)
mism = 0; maxdiff = 0.0
for B in np.linspace(-0.01, 0.12, 80):
    Barr = np.full_like(Tgrid, B)
    gex, _ = exact_amp_undamped_vec(Tgrid, Barr)
    gd = amp_dense_vec(Tgrid, Barr, N=20000)
    maxdiff = max(maxdiff, float(np.max(np.abs(gex - gd))))
    mism += int(np.sum(stable(gex) != stable(gd)))
print(f"EXACT-analytic vs DENSE: stability-mismatching cells={mism}  max||g|_exact-|g|_dense|={maxdiff:.3e}")
print("=> if mismatches==0 and diff~round-off, the analytic endpoints+vertex form is the EXACT grid-free criterion.")

print()
print("=" * 92)
print("TEST 3 — where does K=24 disagree with EXACT? (the permissiveness the user reports)")
print("=" * 92)
Tgrid = np.linspace(0.0, 1.25, 4000)
tot_fa = 0; tot_fr = 0; worst = None
for B in np.linspace(-0.01, 0.12, 120):
    Barr = np.full_like(Tgrid, B)
    a24 = amp_grid_vec(Tgrid, Barr, K=24)
    gex, _ = exact_amp_undamped_vec(Tgrid, Barr)
    s24 = stable(a24); sx = stable(gex)
    fa_mask = s24 & ~sx     # K24 says OK, exact says diverge = PERMISSIVE
    fr_mask = sx & ~s24
    tot_fa += int(np.sum(fa_mask)); tot_fr += int(np.sum(fr_mask))
    if np.any(fa_mask):
        idx = np.argmax(np.where(fa_mask, gex - a24, -1))
        if worst is None or (gex[idx] - a24[idx]) > worst[2]:
            worst = (Tgrid[idx], B, gex[idx] - a24[idx], a24[idx], gex[idx])
print(f"K24-vs-EXACT: PERMISSIVE cells (K24 stable, exact unstable)={tot_fa}; conservative cells={tot_fr}")
if worst:
    T, B, gap, a24v, gexv = worst
    print(f"  worst permissive: T={T:.6f} B={B:.6f}  a24={a24v:.8f}  exact|g|={gexv:.8f}  underestimate={gap:.3e}")
else:
    print("  (no permissive cells found vs exact in this regime)")

print()
print("=" * 92)
print("TEST 4 — the EPS question: lossless string sits at |g|=1. Does '>=1 reject' break lossless?")
print("=" * 92)
# A lossless interior-stable string (T<1, B=0, dec_curr=0): exact |g| should be EXACTLY 1.0.
for (T, B) in [(0.5, 0.0), (0.9, 0.0), (0.99, 0.0), (0.046, 0.0), (0.018, 0.00277)]:
    gex, _ = exact_amp_undamped_vec(np.array([T]), np.array([B]))
    a24 = amp_grid_vec(np.array([T]), np.array([B]), K=24)
    print(f"  T={T:.5f} B={B:.5f}: exact|g|={gex[0]:.10f}  K24|g|={a24[0]:.10f}  "
          f"stable(exact,eps)={bool(stable(gex)[0])}  would '>=1 strict reject' kill it? {gex[0] >= 1.0}")

print()
print("DONE.")
