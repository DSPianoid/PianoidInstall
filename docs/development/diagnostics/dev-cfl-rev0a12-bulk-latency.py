"""
rev-0a12: prove the host-side CFL check is NEGLIGIBLE on the BULK path (preset load / all-~220-string
edit) when VECTORISED over strings (the user's reservation on v2). Two implementations benchmarked:
  (A) closed-form two-sided box + HF-correction — per-string SCALAR, vectorised to array ops.
  (B) Jury over a small fixed theta-set — adds an inner theta axis.
Both must allow/reject identically; (A) should be ~an order faster. Compares vs a naive per-string
Python loop (the WRONG impl the plan rules out).

This is pure numpy (no GPU); it measures only the GATE arithmetic for N strings, which is what the
bulk path adds on top of the (unchanged) GPU upload.
"""
import numpy as np, time, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

N = 224                      # full string count (Preset_test5 num_strings)
RUNS = 200

rng = np.random.default_rng(0)
# realistic-ish coeff ranges (Belarus: coeff_T in [0,0.05], coeff_B in [-0.005,0]); add a few hot rows
T = rng.uniform(0.0, 0.05, N); B = rng.uniform(-0.005, 0.0, N)
dec = rng.uniform(0.0, 0.5, N); cfd = rng.uniform(0.0, 0.05, N)
T[5] = 1.2; B[5] = 0.0          # one unstable (upper edge)
T[9] = 0.01; B[9] = 0.01        # one unstable (lower/bending edge — the discriminating case)

THETA = np.array([np.pi, 0.75*np.pi, 0.9*np.pi, 0.5*np.pi, 0.99*np.pi])  # small interior+Nyquist set
COS = np.cos(THETA); COS2 = np.cos(2*THETA)
EPS = 1e-6


def shifts(T, B, dec):
    di = 1.0/(1.0+dec)
    return (2+12*B-2*T)*di, (T-8*B)*di, (2*B)*di, (dec-1)*di


# ---- (A) closed-form box, vectorised over strings (N,) ----
def gate_box(T, B, dec, cfd):
    s0, s1, s2, sb = shifts(T, B, dec)
    # Nyquist theta=pi binds the box edges in the physical regime: A(pi)=s0-2s1+2s2, B0(pi)=sb+4cfd.
    Ap = s0 - 2*s1 + 2*s2 - 2*cfd*2.0   # (1-cos pi)=2
    B0p = sb + 2*cfd*2.0
    # closed-disk Jury at pi: |B0p|<=1 AND |Ap|<=1-B0p ; plus isfinite
    finite = np.isfinite(T) & np.isfinite(B) & np.isfinite(s0) & np.isfinite(sb)
    stable = finite & (np.abs(B0p) <= 1+EPS) & (np.abs(Ap) <= 1 - B0p + EPS)
    return ~stable   # reject mask


# ---- (B) Jury over a small theta-set, vectorised over strings x theta (N,K) ----
def gate_jury(T, B, dec, cfd):
    s0, s1, s2, sb = shifts(T, B, dec)
    A = s0[:, None] + 2*s1[:, None]*COS[None, :] + 2*s2[:, None]*COS2[None, :] - 2*cfd[:, None]*(1-COS[None, :])
    B0 = sb[:, None] + 2*cfd[:, None]*(1-COS[None, :])
    ok = (np.abs(B0) <= 1+EPS) & (np.abs(A) <= 1 - B0 + EPS)
    finite = np.isfinite(T) & np.isfinite(B)
    stable = finite & np.all(ok, axis=1)
    return ~stable


# ---- naive per-string Python loop (the WRONG impl) ----
def gate_loop(T, B, dec, cfd):
    rej = np.zeros(N, dtype=bool)
    for i in range(N):
        s0, s1, s2, sb = shifts(T[i], B[i], dec[i])
        worst = 0.0
        for t in np.linspace(np.pi/49, np.pi, 48):   # k=1..48 sweep, the kernel's K
            ct = np.cos(t); c2 = np.cos(2*t)
            A = s0 + 2*s1*ct + 2*s2*c2 - 2*cfd[i]*(1-ct); B0 = sb + 2*cfd[i]*(1-ct)
            disc = A*A+4*B0
            m = max(abs((A+np.sqrt(disc))/2), abs((A-np.sqrt(disc))/2)) if disc >= 0 else np.sqrt(abs(B0))
            worst = max(worst, m)
        rej[i] = worst > 1+EPS
    return rej


rb = gate_box(T, B, dec, cfd); rj = gate_jury(T, B, dec, cfd); rl = gate_loop(T, B, dec, cfd)
print(f"decisions agree: box==jury {np.array_equal(rb,rj)}  box==loop {np.array_equal(rb,rl)}")
print(f"rejected strings: box={list(np.where(rb)[0])} jury={list(np.where(rj)[0])} loop={list(np.where(rl)[0])}")
print(f"  (expect 5 [upper-edge] and 9 [lower/bending edge] rejected — the discriminating cases)")


def bench(fn, runs=RUNS):
    fn(T, B, dec, cfd)  # warmup
    t0 = time.perf_counter()
    for _ in range(runs):
        fn(T, B, dec, cfd)
    return (time.perf_counter()-t0)/runs*1e6   # us per full-N call


print(f"\nper-call latency for ALL {N} strings (mean of {RUNS}):")
print(f"  (A) box   (vectorised scalar) : {bench(gate_box):.1f} us")
print(f"  (B) jury  (vectorised NxK)    : {bench(gate_jury):.1f} us")
print(f"  naive per-string Python loop  : {bench(gate_loop, 20):.1f} us  (the WRONG impl)")
print("\nINTERPRETATION: the vectorised box is the bulk-path cost the user worried about. If it is")
print("~single-digit microseconds for all 224 strings, it is utterly negligible vs the preset-load GPU")
print("upload (ms+) it precedes. The naive loop (per-string x 48-theta in Python) is ~1000x slower —")
print("that is the implementation the v2 plan explicitly rules out.")
