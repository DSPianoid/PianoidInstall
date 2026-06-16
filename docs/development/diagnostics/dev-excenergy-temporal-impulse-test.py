"""dev-excenergy — TEST-FIRST gate for StringExcitation.temporal_curve_impulse (B2).

PianoidBasic has no pytest tree (bare imports resolve only from inside Pianoid/),
so this is the runnable test-first gate for the temporal point-sum, executed via:
    cd PianoidBasic/Pianoid && \
      ../../PianoidCore/.venv/Scripts/python.exe \
      ../../docs/development/diagnostics/dev-excenergy-temporal-impulse-test.py

Contract (proposal D1/§2.1-2.2): temporal_curve_impulse(level_params, length,
excitation_factor) returns the discrete point-SUM of the force curve using the
GPU formula — per-component ReLU max(exp(-0.5*((x-mu)/sigma)^2) - shift, 0) * vol,
summed over the 5 Gaussians, summed over samples. level_params is a (4,5) array
[mu;sigma;volume;shift] x 5 (the levels_matrix[level] layout).
"""
import sys, os, math
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "PianoidBasic", "Pianoid"))

from StringExcitation import temporal_curve_impulse  # noqa: E402

FAILS = []
def check(name, cond):
    print(("PASS" if cond else "FAIL"), name)
    if not cond:
        FAILS.append(name)

def gpu_reference(level_params, length, ef):
    """Independent re-implementation of the GPU formula for cross-check."""
    mu, sigma, vol, shift = level_params
    total = 0.0
    for i in range(length):
        x = i * ef / length
        s = 0.0
        for k in range(5):
            g = math.exp(-0.5 * ((x - mu[k]) / sigma[k]) ** 2)
            g = max(g - shift[k], 0.0)
            s += g * vol[k]
        total += s
    return total

# A representative level: 5 gaussians (mu, sigma, volume, shift)
lp = np.array([
    [1.0, 2.0, 2.0, 2.5, 6.0],     # mu
    [0.3, 0.4, 0.6, 1.0, 0.4],     # sigma
    [10.0, 3.0, 2.0, 1.0, 5.0],    # volume
    [0.1, 0.2, 0.1, 0.2, 0.0],     # shift
])
LEN, EF = 576, 8

val = temporal_curve_impulse(lp, LEN, EF)
ref = gpu_reference(lp, LEN, EF)
check("matches independent GPU-formula reference (rel<1e-9)", abs(val - ref) <= 1e-9 * max(1.0, abs(ref)))
check("returns a positive float for a non-trivial curve", isinstance(float(val), float) and val > 0)

# Linearity in volume: scaling all 5 vols by k scales the impulse by k (impulse ∝ vol)
lp2 = lp.copy(); lp2[2, :] *= 3.0
check("linear in volume (x3 vol -> x3 impulse)", abs(temporal_curve_impulse(lp2, LEN, EF) - 3.0 * val) <= 1e-6 * 3.0 * val)

# Degenerate: a curve entirely below the ReLU floor -> 0 impulse
lp0 = lp.copy(); lp0[3, :] = 2.0  # shift > peak (exp<=1) so max(g-shift,0)=0 everywhere
check("all-below-floor -> 0 impulse", temporal_curve_impulse(lp0, LEN, EF) == 0.0)

# Per-component ReLU (GPU) differs from post-sum clip (Python get_curve): a component
# whose shift kills it must NOT contribute even if the summed curve is positive.
lpA = lp.copy()
lpB = lp.copy(); lpB[3, 0] = 2.0  # kill component 0 via its own shift
check("per-component ReLU (killing one comp reduces impulse)", temporal_curve_impulse(lpB, LEN, EF) < temporal_curve_impulse(lpA, LEN, EF))

print()
if FAILS:
    print("GATE FAILED:", FAILS); sys.exit(1)
print("GATE PASSED — temporal_curve_impulse matches the GPU formula"); sys.exit(0)
