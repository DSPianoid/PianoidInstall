"""dev-cfl-3: pitch 57 CLICKS (attack, no sustain) regression — measure-first, in-proc (NO live backend).

User live test on the guard build: pitch 57 produces a click (attack with instant decay = string not resonating).
Prime suspect to TEST (NOT assume): pitch 57's string gets flag=1 (CFL-rejected) at preset load, and the reject
path restores the ZERO-initialized shadow coefficients (Pianoid.cu zero-inits dev_string_shadow_coeffs) → zeroed
shift_* → the FDTD string can't propagate → silence/click. Connects to the θ=0/k=1 false-reject family.

This probe (deterministic offline render, no ports):
1. LEAD: pitch 57's stability flag + ratio in the loaded engine (forced kernel). flag=1 → guard is flagging it.
   - If flag=1: recompute pitch 57's TRUE max|g| from authoritative physics (companion matrix) — false positive?
2. Render pitch 57 offline, inspect the buffer: attack-then-instant-decay (click) vs sustained ring.
3. Compare vs a WORKING pitch (e.g. 60): flag/ratio, coeff_tension/coeff_bending/dec_curr, and the rendered envelope.
Run at BOTH the test's string_iteration=4 AND the preset's stored 6 (the user's preset value) to be faithful.

Run: cd PianoidCore && unset VIRTUAL_ENV && ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-cfl-pitch57-repro.py
"""
import os, sys, math
import numpy as np

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
MIDDLEWARE_DIR = os.path.join(REPO_ROOT, "PianoidCore", "pianoid_middleware")
sys.path.insert(0, MIDDLEWARE_DIR)
sys.path.insert(0, os.path.join(REPO_ROOT, "PianoidCore"))
import pianoidCuda  # noqa

SR, SPC = 48000, 64
WORKING = 60


def companion_maxg(s0, s1, s2, sb, cfd, K=2001, start=1):
    worst = 0.0
    for k in range(start, K + 1):
        t = math.pi * k / K
        ct = math.cos(t); c2 = math.cos(2 * t)
        A = s0 + 2 * s1 * ct + 2 * s2 * c2 + cfd * (2 * ct - 2)
        B0 = sb - cfd * (2 * ct - 2)
        ev = np.linalg.eigvals(np.array([[A, B0], [1.0, 0.0]]))
        worst = max(worst, float(np.max(np.abs(ev))))
    return worst


def coeffs_from_physics(pw, pitch, string_iter):
    p = pw.sm.pitches[pitch].physics
    dt = 1.0 / (SR * string_iter)
    dx = p.geometry.dx()
    T = (p.tension / p.rho) * dt**2 / dx**2
    B = (math.pi * p.r**4 / (4 * p.rho)) * p.jung * dt**2 / dx**4
    return T, B, p.tension, p.r, p.jung, dx


def render(cpp, pitch, dur_ms=400):
    eq = pianoidCuda.EventQueue()
    ev = pianoidCuda.PlaybackEvent(); ev.type = pianoidCuda.EventType.NOTE_ON
    ev.channel = 0; ev.cycle_index = 0; ev.data = (pitch << 8) | 90
    eq.addEvent(ev); eq.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.max_duration_ms = dur_ms; cfg.sample_rate = SR; cfg.samples_per_cycle = SPC
    cpp.resetStringsState(); cpp.clearRecords()
    cpp.runOfflinePlayback(eq, cfg)
    return np.array(cpp.getRecordedAudio(), dtype=np.float64)


def envelope_desc(a):
    if a.size == 0:
        return "EMPTY"
    n = a.size
    seg = max(1, n // 8)
    peak_attack = float(np.max(np.abs(a[:seg])))
    peak_tail = float(np.max(np.abs(a[-seg:])))
    rms_attack = float(np.sqrt(np.mean(a[:seg] ** 2)))
    rms_tail = float(np.sqrt(np.mean(a[-seg:] ** 2)))
    sust = (peak_tail / peak_attack) if peak_attack > 0 else 0.0
    return f"peak_attack={peak_attack:.3e} peak_tail={peak_tail:.3e} sustain_ratio={sust:.4f} ({'CLICK' if sust < 0.02 else 'SUSTAINED'})"


def run_at(string_iter):
    print(f"\n===== string_iteration={string_iter} =====")
    os.chdir(MIDDLEWARE_DIR)
    from pianoid import initialize
    from tests.conftest import get_preset_path  # noqa
    pw = initialize(get_preset_path("Preset_test5.json"), filterlen=48*128*3, string_iteration=string_iter,
                    array_size=384, sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, max_volume=5e18,
                    audio_on=False, audio_driver_type=0)
    cpp = pw.pianoid
    cpp.waitForParameterUpdate(); cpp.runSynthesisKernel(); cpp.waitForParameterUpdate()
    flags = list(cpp.getStringStableFlags())
    ratios = list(cpp.getStringStabilityRatios())
    print(f"GLOBAL: flagged strings = {[i for i,f in enumerate(flags) if f]} (count {sum(flags)})")
    for pitch in (57, WORKING):
        if pitch not in pw.sm.pitches:
            print(f"  pitch {pitch} NOT in preset"); continue
        idxs = [pw.sm.string_index.index(s) for s in pw.sm.pitches[pitch].get_strings()]
        T, B, tension, r, jung, dx = coeffs_from_physics(pw, pitch, string_iter)
        gmax = companion_maxg(2 + 12*B - 2*T, T - 8*B, 2*B, -1.0, 0.0)  # dec_curr=0, k>=1
        fl = [flags[i] for i in idxs]; ra = [round(ratios[i], 6) for i in idxs]
        aud = render(cpp, pitch)
        nan = int(np.sum(~np.isfinite(aud))) if aud.size else -1
        print(f"  PITCH {pitch}: strings idx={idxs} flags={fl} kernel_ratio={ra}")
        print(f"      physics: tension={tension:.4g} r={r:.4g} jung={jung:.4g} dx={dx:.5f} -> coeff_T={T:.5f} coeff_B={B:.4e}")
        print(f"      true max|g| (k>=1, dec=0) = {gmax:.6f}  | render: {envelope_desc(aud)} nan={nan}")
    try:
        cpp.shutdownGpu()
    except Exception:
        pass


def main():
    run_at(4)   # the test's value
    run_at(6)   # the preset's stored value (the user's faithful config)


if __name__ == "__main__":
    main()
