"""dev-cfl-3: Is cflMaxAmplification OVER-computing |g| under damping? (team-lead/user hypothesis)

A real string that sounds without diverging HAS true |g| <= 1. Damped -> <1, lossless -> =1. NEITHER
exceeds 1. String 185 reads |g|=1.0 OFFLINE (no note) but 1.00042 ONLINE (note sounding). The only thing
that changes online is DAMPING (dump_coeff from sustain/note-state raises dec_curr). So either:
  (a) my A(theta)/B0(theta) formula mis-handles damping → |g| spuriously > 1 as damping rises (FORMULA BUG), or
  (b) the true |g| really exceeds 1 (would mean the SCHEME is unstable there — but the string sounds fine).

This probe takes string 185's base physics (coeff_tension, coeff_bending) and SWEEPS dec_curr (the damping
that the sounding note adds) from 0 upward, computing for each:
  - my formula's max|g| (the cflMaxAmplification mirror: A,B0 as in Kernels.cu)
  - the TRUE spectral radius of the 2-step recurrence via the COMPANION MATRIX eigenvalues (ground truth,
    independent of my A/B0 algebra) at the SAME thetas
If my-formula rises above 1 while the companion-matrix truth stays <=1 as damping increases => FORMULA BUG
localized to the damping terms.

Run: cd PianoidCore && unset VIRTUAL_ENV && ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-cfl-damping-formula-probe.py
"""
import os, sys, math
import numpy as np

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
MIDDLEWARE_DIR = os.path.join(REPO_ROOT, "PianoidCore", "pianoid_middleware")
sys.path.insert(0, MIDDLEWARE_DIR)
sys.path.insert(0, os.path.join(REPO_ROOT, "PianoidCore"))
import pianoidCuda  # noqa

SR, SPC, SITER = 48000, 64, 4


def shifts(T, B, dec_curr, cfd_raw):
    """parameterKernel's shift_* (Kernels.cu:205-208) for given coeff_tension T, coeff_bending B,
    damping dec_curr, and raw coeff_frequency_decay cfd_raw. Returns (s0,s1,s2,sb, cfd_applied).
    NOTE the kernel applies dec_inv to s0/s1/s2/sb but coeff_frequency_decay is used RAW in the recurrence
    (MainKernel: target += (d3-d3_1)*coeff_frequency_decay — not scaled by dec_inv)."""
    di = 1.0 / (dec_curr + 1.0)
    s0 = (2 + 12 * B - 2 * T) * di
    s1 = (T - 8 * B) * di
    s2 = (2 * B) * di
    sb = (dec_curr - 1) * di
    return s0, s1, s2, sb, cfd_raw


def my_formula_maxg(s0, s1, s2, sb, cfd, K=48):
    """EXACT mirror of cflMaxAmplification (Kernels.cu:100-124)."""
    worst = 0.0
    for k in range(K + 1):
        t = math.pi * k / K
        ct = math.cos(t); c2 = math.cos(2 * t)
        A = s0 + 2 * s1 * ct + 2 * s2 * c2 + cfd * (-2.0) * (1.0 - ct)
        B0 = sb + cfd * 2.0 * (1.0 - ct)
        disc = A * A + 4.0 * B0
        if disc >= 0:
            sq = math.sqrt(disc); mag = max(abs((A + sq) / 2), abs((A - sq) / 2))
        else:
            mag = math.sqrt(abs(B0))
        worst = max(worst, mag)
    return worst


def companion_maxg(s0, s1, s2, sb, cfd, K=8001):
    """GROUND TRUTH: spectral radius of the recurrence g^2 = A g + B0 via the companion matrix
    [[A, B0],[1,0]] eigenvalues, swept over K thetas. Independent of my A/B0 root algebra.
    A,B0 are derived DIRECTLY from MainKernel.cu:523-531 (see analysis in the log)."""
    worst = 0.0
    for k in range(K + 1):
        t = math.pi * k / K
        ct = math.cos(t); c2 = math.cos(2 * t)
        # MainKernel recurrence: g^2 = A g + B0 with
        A = s0 + 2 * s1 * ct + 2 * s2 * c2 + cfd * (2 * ct - 2)
        B0 = sb - cfd * (2 * ct - 2)
        M = np.array([[A, B0], [1.0, 0.0]])
        ev = np.linalg.eigvals(M)
        worst = max(worst, float(np.max(np.abs(ev))))
    return worst


def main():
    os.chdir(MIDDLEWARE_DIR)
    from pianoid import initialize
    pw = initialize(os.path.join(MIDDLEWARE_DIR, "presets", "Preset_test5.json"),
                    filterlen=48*128*3, string_iteration=SITER, array_size=384,
                    sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, max_volume=5e18,
                    audio_on=False, audio_driver_type=0)
    # string 185 -> need its pitch's physics. From earlier probe: string_index 185 belongs to pitch 60.
    p = pw.sm.pitches[60].physics
    dt = 1.0 / (SR * SITER)
    dx = p.geometry.dx()
    T = (p.tension / p.rho) * dt**2 / dx**2
    B = (math.pi * p.r**4 / (4 * p.rho)) * p.jung * dt**2 / dx**4
    # raw coeff_frequency_decay (Kernels.cu:197): frequency_dependent_damping * 1e12 / (2*dxMm2); dxMm2=(dx*1000)^2
    fdd = getattr(p, "frequency_dependent_damping", 0.0) or 0.0
    dxMm2 = (dx * 1000.0) ** 2
    cfd_raw = fdd * 1e12 / (2 * dxMm2)
    print(f"pitch 60 physics: T(coeff_tension)={T:.6f} B(coeff_bending)={B:.3e} fdd={fdd:.3e} cfd_raw={cfd_raw:.6f} dx={dx:.5f}")
    print(f"{'dec_curr':>9} {'myK48':>12} {'myK8001':>12} {'companion(truth)':>18} {'my>1?':>7} {'truth>1?':>9}")
    for dec in [0.0, 0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0]:
        s0, s1, s2, sb, cfd = shifts(T, B, dec, cfd_raw)
        m48 = my_formula_maxg(s0, s1, s2, sb, cfd, 48)
        m8001 = my_formula_maxg(s0, s1, s2, sb, cfd, 8001)
        truth = companion_maxg(s0, s1, s2, sb, cfd, 2001)
        print(f"{dec:>9.3f} {m48:>12.6f} {m8001:>12.6f} {truth:>18.6f} {str(m48>1+1e-9):>7} {str(truth>1+1e-9):>9}")
    print("\nINTERPRETATION:")
    print("  If 'truth' STAYS <=1 as dec_curr rises but 'myK48/myK8001' goes >1 => FORMULA BUG in my A/B0 (damping).")
    print("  If BOTH rise >1 with damping => the recurrence as I transcribed it is genuinely unstable there")
    print("     (then I've mis-transcribed the kernel's actual update — re-check MainKernel cfd term sign).")
    try:
        pw.pianoid.shutdownGpu()
    except Exception:
        pass


if __name__ == "__main__":
    main()
