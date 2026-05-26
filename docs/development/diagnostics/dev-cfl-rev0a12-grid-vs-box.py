"""
rev-0a12 design-authority check: for the GATE DECISION, compare three forms against dense truth
(K=4000 swept max|g|, exclude theta=0), across T x B x dec_curr x cfd:
  (1) K=24 theta-grid max|g| > 1+eps      (dev-cflfix's proposed decision)
  (2) Nyquist-only box: Jury at theta=pi only (|B0(pi)|<=1 AND |A(pi)|<=1-B0(pi))  (my plan's option A, naive)
  (3) two-sided closed-form box WITHOUT HF re-derivation: 8B<=T<=1+8B  (undamped box; ignores cfd tightening)
Goal: see which forms give ZERO false-accept (dangerous) and ZERO false-reject (annoying) vs truth,
ESPECIALLY in the cfd>0 (HF-damped) cases where the upper edge tightens below 1+8B. This decides
whether the grid is the right call vs a hand-derived HF box.
"""
import numpy as np, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
EPS = 1e-6
TH_DENSE = np.linspace(0, np.pi, 4001)[1:]
TH_24 = np.linspace(0, np.pi, 25)[1:]          # K=24 grid, k=1..24 (exclude k=0)
CD, C2D = np.cos(TH_DENSE), np.cos(2*TH_DENSE)
C24, C224 = np.cos(TH_24), np.cos(2*TH_24)


def shifts(T, B, dec):
    di = 1.0/(1.0+dec); return (2+12*B-2*T)*di, (T-8*B)*di, (2*B)*di, (dec-1)*di


def maxg(T, B, dec, cfd, cos, cos2):
    s0, s1, s2, sb = shifts(T, B, dec)
    A = s0 + 2*s1*cos + 2*s2*cos2 - 2*cfd*(1-cos); B0 = sb + 2*cfd*(1-cos)
    disc = A*A + 4*B0
    mag = np.where(disc >= 0, np.maximum(np.abs((A+np.sqrt(np.abs(disc)))*0.5), np.abs((A-np.sqrt(np.abs(disc)))*0.5)), np.sqrt(np.abs(B0)))
    return float(np.max(mag))


def truth_unstable(T, B, dec, cfd):
    return maxg(T, B, dec, cfd, CD, C2D) > 1+EPS


def grid24_unstable(T, B, dec, cfd):
    return maxg(T, B, dec, cfd, C24, C224) > 1+EPS


def nyquist_box_unstable(T, B, dec, cfd):
    s0, s1, s2, sb = shifts(T, B, dec)
    Ap = s0 - 2*s1 + 2*s2 - 2*cfd*2.0; B0p = sb + 2*cfd*2.0   # theta=pi: 1-cos=2
    stable = (abs(B0p) <= 1+EPS) and (abs(Ap) <= 1 - B0p + EPS)
    return not stable


def undamped_box_unstable(T, B, dec, cfd):
    # ignores cfd tightening entirely
    return not (8*B - EPS <= T <= 1 + 8*B + EPS)


def scan(cfds):
    rows = []
    for cfd in cfds:
        g_fa = g_fr = n_fa = n_fr = u_fa = u_fr = tot = 0
        for T in np.arange(0.0, 1.301, 0.01):
            for B in np.arange(-0.05, 0.1001, 0.0075):
                for dec in (0.0, 0.3, 1.0):
                    tru = truth_unstable(T, B, dec, cfd); tot += 1
                    for fn, fa, fr in ((grid24_unstable,'g',None),):
                        pass
                    gu = grid24_unstable(T, B, dec, cfd)
                    nu = nyquist_box_unstable(T, B, dec, cfd)
                    uu = undamped_box_unstable(T, B, dec, cfd)
                    if gu and not tru: g_fa += 1
                    if tru and not gu: g_fr += 1
                    if nu and not tru: n_fa += 1
                    if tru and not nu: n_fr += 1
                    if uu and not tru: u_fa += 1
                    if tru and not uu: u_fr += 1
        rows.append((cfd, tot, g_fa, g_fr, n_fa, n_fr, u_fa, u_fr))
    return rows


print("Decision-form comparison vs dense max|g| truth (exclude theta=0). FA=false-accept (DANGEROUS,")
print("misses a real blowup), FR=false-reject (annoying, refuses a stable edit). Grid over T,B,dec.")
print(f"{'cfd':>5}{'cells':>7} | {'grid24 FA':>10}{'grid24 FR':>10} | {'nyqBox FA':>10}{'nyqBox FR':>10} | {'undBox FA':>10}{'undBox FR':>10}")
for (cfd, tot, gfa, gfr, nfa, nfr, ufa, ufr) in scan([0.0, 0.05, 0.1, 0.25]):
    print(f"{cfd:>5}{tot:>7} | {gfa:>10}{gfr:>10} | {nfa:>10}{nfr:>10} | {ufa:>10}{ufr:>10}")

print()
print("READ: grid24 should be 0/0 everywhere (dev-cflfix's claim). nyqBox tests whether the EXACT")
print("theta=pi Jury (with the cfd term) is decision-equivalent — if 0/0, a closed-form box IS viable")
print("WITHOUT a separate HF derivation (the cfd term is already in A(pi)/B0(pi)). undBox (ignores cfd)")
print("should FALSE-ACCEPT at cfd>0 (it allows T up to 1+8B but truth tightens lower) — showing why a")
print("naive undamped box is unsafe and the cfd term MUST be included whichever form is chosen.")
