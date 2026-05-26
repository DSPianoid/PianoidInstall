"""dev-cfl CHANGE-REQUEST repro: does the CFL guard catch a Young's-modulus (stiffness) edit?

User report: editing a string's Young's modulus to a prohibited value crashed the engine with NO
rejection. My guard exercised coeff_tension (tension) only. Young's modulus -> coeff_bending.

This probe drives `jung` (Young's modulus) to extreme values via the SAME path the UI uses
(update_parameter('string', {pitch:{jung:...}})), forces parameterKernel, and reports, per trial:
  - coeff_tension T, coeff_bending B (from authoritative physics)
  - the guard's ratio (T - 8B) and which guard condition (if any) fires
  - the kernel's read-back ratio + flag
  - whether an offline render is FINITE or produces NaN/Inf (= the crash the user saw)

Measure-first: do NOT assume the bug; observe which regime the instability lands in.

Run from repo root with the PianoidCore venv:
  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-cfl-young-repro.py
"""
import os, sys, math
import numpy as np

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
MIDDLEWARE_DIR = os.path.join(REPO_ROOT, "PianoidCore", "pianoid_middleware")
sys.path.insert(0, MIDDLEWARE_DIR)
sys.path.insert(0, os.path.join(REPO_ROOT, "PianoidCore"))
import pianoidCuda  # noqa

TEST_PITCH = 60
SR = 48000
SPC = 64


def render(cpp, pitch=TEST_PITCH, vel=80, dur_ms=200):
    eq = pianoidCuda.EventQueue()
    on = pianoidCuda.PlaybackEvent(); on.type = pianoidCuda.EventType.NOTE_ON
    on.channel = 0; on.cycle_index = 0; on.data = (pitch << 8) | vel
    eq.addEvent(on); eq.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.max_duration_ms = dur_ms; cfg.sample_rate = SR; cfg.samples_per_cycle = SPC
    cpp.resetStringsState(); cpp.clearRecords()
    cpp.runOfflinePlayback(eq, cfg)
    return np.array(cpp.getRecordedAudio(), dtype=np.float64)


def force_kernel(cpp):
    cpp.waitForParameterUpdate(); cpp.runSynthesisKernel(); cpp.waitForParameterUpdate()


def coeff_TB(pitch_obj, dt):
    p = pitch_obj.physics; dx = p.geometry.dx()
    T = (p.tension / p.rho) * dt**2 / dx**2
    B = (math.pi * p.r**4 / (4 * p.rho)) * p.jung * dt**2 / dx**4
    return T, B


def main():
    os.chdir(MIDDLEWARE_DIR)
    from pianoid import initialize
    def pp(name):
        for c in (os.path.join(MIDDLEWARE_DIR, "presets", name),
                  os.path.join(REPO_ROOT, "PianoidCore", "tests", "presets", name)):
            if os.path.exists(c): return c
        raise FileNotFoundError(name)
    preset = None
    for cand in ("Preset_test5.json", "BaselinePreset1.json"):
        try: preset = pp(cand); break
        except FileNotFoundError: continue
    print(f"preset: {preset}")
    pw = initialize(preset, filterlen=48*128*3, string_iteration=4, array_size=384,
                    sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, max_volume=5e18,
                    audio_on=False, audio_driver_type=0)
    cpp = pw.pianoid
    dt = 1.0 / (pw.mp.sample_rate() * pw.mp.string_iteration)
    pobj = pw.sm.pitches[TEST_PITCH]
    idxs = [pw.sm.string_index.index(sid) for sid in pobj.get_strings()]
    base_jung = pobj.physics.jung
    print(f"baseline pitch {TEST_PITCH}: jung={base_jung:.4g}  strings idx={idxs}")
    force_kernel(cpp)
    T0, B0 = coeff_TB(pobj, dt)
    print(f"baseline coeff_T={T0:.5f} coeff_B={B0:.6e}  (T-8B)={T0-8*B0:.5f}\n")

    # Test jung at extreme magnitudes, BOTH signs (preset jung is negative; the UI might send either).
    # Also a sign flip (negative->large positive) which inverts coeff_bending sign.
    trials = [base_jung*10, base_jung*100, base_jung*1000, base_jung*1e6,
              -base_jung,            # sign flip to positive (B flips sign)
              abs(base_jung)*100, abs(base_jung)*1e6,
              -abs(base_jung)*1e6]
    print(f"{'jung':>14}{'coeff_T':>10}{'coeff_B':>13}{'T-8B':>11}{'cond_fired':>26}"
          f"{'k_ratio':>11}{'k_flag':>7}{'render':>9}")
    for jung in trials:
        try:
            # SAME path as the UI: update_parameter('string', {pitch:{jung:val}})
            # update_parameter raises ValueError if the guard rejects (our R1 host hook).
            rejected_by_mw = False
            try:
                pw.update_parameter('string', {str(TEST_PITCH): {'jung': float(jung)}}, pitches=[TEST_PITCH])
            except ValueError:
                rejected_by_mw = True
            force_kernel(cpp)
            T, B = coeff_TB(pobj, dt)
            ratio = T - 8.0 * B
            # which guard condition SHOULD fire?
            conds = []
            if ratio > 1.0: conds.append("ratio>1")
            if T < 8.0 * B: conds.append("T<8B")
            cond_str = "+".join(conds) if conds else ("MW_reject" if rejected_by_mw else "NONE")
            kr = list(cpp.getStringStabilityRatios()); kf = list(cpp.getStringStableFlags())
            k_ratio = kr[idxs[0]] if idxs[0] < len(kr) else float('nan')
            k_flag = kf[idxs[0]] if idxs[0] < len(kf) else -1
            audio = render(cpp)
            nan = int(np.sum(~np.isfinite(audio))) if audio.size else -1
            rstat = "FINITE" if nan == 0 else (f"NaN×{nan}" if nan > 0 else "EMPTY")
            print(f"{jung:>14.3g}{T:>10.4f}{B:>13.4e}{ratio:>11.4f}{cond_str:>26}"
                  f"{k_ratio:>11.4f}{k_flag:>7}{rstat:>9}")
        except Exception as e:
            print(f"{jung:>14.3g}  EXCEPTION: {type(e).__name__}: {e}")
        # restore baseline + clean for next trial
        try:
            pw.update_parameter('string', {str(TEST_PITCH): {'jung': float(base_jung)}}, pitches=[TEST_PITCH])
        except Exception:
            pass
        force_kernel(cpp); cpp.resetStringsState()

    print("\nKEY QUESTION: any row with render=NaN AND cond_fired=NONE → the guard MISSED it (the bug).")
    try: cpp.shutdownGpu()
    except Exception: pass


if __name__ == "__main__":
    main()
