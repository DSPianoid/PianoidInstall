"""dev-cfl-3: WHY does the baseline preset have rejected strings [220,221,222,223]?

test_baseline_all_strings_stable failed on the fresh K=48/eps3e-4 build: the last 4 strings of the
224-string Preset_test5 array are flagged unstable (flag=1) at baseline — a false-positive rejection of
a WORKING preset, OR these are dummy/sentinel tail strings with garbage coeffs.

Measure-first (high-stakes — axis/index/stored-vs-effective semantics): for the rejected strings AND a
known-good string, report:
  - which pitch each string index maps to (string_index -> pitch)
  - the authoritative physics (tension, rho, r, jung, length, dx) and coeff_tension/coeff_bending
  - the kernel's read-back ratio (max|g|) + flag
  - the locally-recomputed max|g| at K=48 and K=8001 (truth)
so we can tell: real marginal instability vs sentinel/dummy string vs gate-too-tight.

Run: PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-cfl-baseline-reject-probe.py
"""
import os, sys, math
import numpy as np

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
MIDDLEWARE_DIR = os.path.join(REPO_ROOT, "PianoidCore", "pianoid_middleware")
sys.path.insert(0, MIDDLEWARE_DIR)
sys.path.insert(0, os.path.join(REPO_ROOT, "PianoidCore"))
import pianoidCuda  # noqa

SR = 48000
SPC = 64
STRING_ITER = 4


def maxg(s0, s1, s2, sb, cfd, K):
    worst = 0.0
    for k in range(K + 1):
        t = math.pi * k / K
        ct = math.cos(t); c2 = math.cos(2 * t)
        A = s0 + 2 * s1 * ct + 2 * s2 * c2 + cfd * (-2) * (1 - ct)
        B0 = sb + cfd * 2 * (1 - ct)
        disc = A * A + 4 * B0
        if disc >= 0:
            sq = math.sqrt(disc); mag = max(abs((A + sq) / 2), abs((A - sq) / 2))
        else:
            mag = math.sqrt(abs(B0))
        worst = max(worst, mag)
    return worst


def main():
    os.chdir(MIDDLEWARE_DIR)
    from pianoid import initialize

    def pp(name):
        for c in (os.path.join(MIDDLEWARE_DIR, "presets", name),
                  os.path.join(REPO_ROOT, "PianoidCore", "tests", "presets", name)):
            if os.path.exists(c):
                return c
        raise FileNotFoundError(name)

    preset = pp("Preset_test5.json")
    print(f"preset: {preset}")
    pw = initialize(preset, filterlen=48*128*3, string_iteration=STRING_ITER, array_size=384,
                    sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, max_volume=5e18,
                    audio_on=False, audio_driver_type=0)
    cpp = pw.pianoid
    cpp.waitForParameterUpdate(); cpp.runSynthesisKernel(); cpp.waitForParameterUpdate()

    flags = list(cpp.getStringStableFlags())
    ratios = list(cpp.getStringStabilityRatios())
    print(f"\ntotal strings (len flags) = {len(flags)}; rejected = {[i for i,f in enumerate(flags) if f]}")
    print(f"num pitches = {len(pw.sm.pitches)}; len(string_index) = {len(pw.sm.string_index)}")

    dt = 1.0 / (SR * STRING_ITER)

    # Build string_index -> pitch map
    sid_to_pitch = {}
    for pid, pitch in pw.sm.pitches.items():
        try:
            for sid in pitch.get_strings():
                sid_to_pitch[sid] = pid
        except Exception:
            pass

    def describe(si, label):
        print(f"\n--- string_index {si} ({label}) ---")
        print(f"  kernel: ratio(max|g|)={ratios[si]:.6f}  flag={flags[si]}")
        # map back to a string id and pitch
        try:
            sid = pw.sm.string_index[si]
        except Exception:
            sid = None
        pid = sid_to_pitch.get(sid, None)
        print(f"  string_id={sid}  pitch={pid}")
        if pid is None:
            print("  >>> NO PITCH owns this string_index — likely a DUMMY/padding tail slot (sentinel).")
            return
        p = pw.sm.pitches[pid].physics
        dx = p.geometry.dx()
        T = (p.tension / p.rho) * dt**2 / dx**2
        B = (math.pi * p.r**4 / (4 * p.rho)) * p.jung * dt**2 / dx**4
        s0 = 2 + 12*B - 2*T; s1 = T - 8*B; s2 = 2*B; sb = -1.0  # dec_curr=0 baseline
        g48 = maxg(s0, s1, s2, sb, 0.0, 48)
        g8001 = maxg(s0, s1, s2, sb, 0.0, 8001)
        print(f"  physics: tension={p.tension:.4g} rho={p.rho:.4g} r={p.r:.4g} jung={p.jung:.4g} dx={dx:.4g}")
        print(f"  >>> PITCH {pid}: {'PIANO STRING (0-127)' if pid is not None and pid < 128 else 'OUTPUT PITCH (128-139) — NOT a physical FDTD string'}")
        print(f"  coeff_tension(T)={T:.6f}  coeff_bending(B)={B:.6e}  (T-8B)={T-8*B:.6f}")
        print(f"  recomputed max|g| K=48={g48:.6f}  K=8001(truth)={g8001:.6f}  (gate rejects if >1+3e-4=1.0003)")

    for si in [i for i, f in enumerate(flags) if f]:
        describe(si, "REJECTED")
    # a couple of known-good references
    for si in [0, 60, 150]:
        if si < len(flags):
            describe(si, "reference")

    try:
        cpp.shutdownGpu()
    except Exception:
        pass


if __name__ == "__main__":
    main()
