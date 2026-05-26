"""dev-cfl-3 REALTIME regression (B) repro + A/B.

User report (regression B): with the realtime/online engine running, ANY string parameter
change — even a STABILIZING one (e.g. a tension REDUCTION) — silently STOPS synthesis.

Diagnosis (to confirm here, measure-first): the host R1 hook
parameter_manager._raise_if_cfl_rejected() calls self.pianoid.runSynthesisKernel() DIRECTLY
(parameter_manager.py:466) on every string/physics edit. The online engine (OnlinePlaybackEngine.run(),
pianoid.py:1468 background thread) is ALREADY looping runCycle({Online}) -> runSynthesisKernel().
Two threads launching the cooperative-grid synthesis kernel against shared GPU state stalls the loop.
The codebase already documents this constraint at chartFunctions.py:505
("Stop online engine -- direct runSynthesisKernel conflicts with it"); every other forced-cycle caller
first _stop_online_engine(). _raise_if_cfl_rejected does NOT.

This script:
  PHASE R (repro):   start the online engine (audio_off / SDL3 hardware-free), play a note, sample the
                     online ring buffer (getSoundRecords) liveness BEFORE and AFTER a STABILIZING
                     string edit (tension reduction). If synthesis advances before but freezes after,
                     and/or the engine thread sets an exception -> regression reproduced.
  PHASE A (A/B):     restart the engine, monkeypatch _raise_if_cfl_rejected to SKIP the runSynthesisKernel()
                     call (the proposed fix's behavior), repeat the same stabilizing edit. Synthesis should
                     KEEP advancing -> isolates the runSynthesisKernel() call as the cause.

Run from repo root with the PianoidCore venv:
  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-cfl-realtime-repro.py
"""
import os, sys, time
import numpy as np

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
MIDDLEWARE_DIR = os.path.join(REPO_ROOT, "PianoidCore", "pianoid_middleware")
sys.path.insert(0, MIDDLEWARE_DIR)
sys.path.insert(0, os.path.join(REPO_ROOT, "PianoidCore"))
import pianoidCuda  # noqa

TEST_PITCH = 60
SR = 48000
SPC = 64


def pp(name):
    for c in (os.path.join(MIDDLEWARE_DIR, "presets", name),
              os.path.join(REPO_ROOT, "PianoidCore", "tests", "presets", name)):
        if os.path.exists(c):
            return c
    raise FileNotFoundError(name)


def sample_liveness(pw, label, settle=0.4, window=0.5, n=5):
    """Sample the online ring buffer over `window` sec; return (advanced_bool, detail).

    'advanced' = the buffer's last-nonzero index moved OR fresh nonzero energy appeared
    across the window — i.e. the synthesis loop is still producing samples.
    """
    time.sleep(settle)
    sigs = []
    for _ in range(n):
        try:
            raw = np.asarray(pw.pianoid.getSoundRecords(SR), dtype=np.float64)  # ~1s of ring
        except Exception as e:
            sigs.append(("ERR", str(e)))
            time.sleep(window / n)
            continue
        nz = np.nonzero(np.abs(raw) > 1e-12)[0]
        last_nz = int(nz[-1]) if nz.size else -1
        energy = float(np.sum(raw[max(0, raw.size-2048):] ** 2)) if raw.size else 0.0
        finite = bool(np.all(np.isfinite(raw))) if raw.size else True
        sigs.append((last_nz, energy, finite))
        time.sleep(window / n)
    # advanced if the last-nonzero index changed across samples (ring is being written)
    idxs = [s[0] for s in sigs if isinstance(s[0], int)]
    advanced = len(set(idxs)) > 1
    print(f"  [{label}] ring last_nz over time = {idxs}  advanced={advanced}")
    print(f"  [{label}] tail-energy samples = {[round(s[1],3) if not isinstance(s[0],str) else s for s in sigs]}")
    allfin = all(s[2] for s in sigs if not isinstance(s[0], str))
    return advanced, allfin, sigs


def run_phase(phase, neuter_force):
    print(f"\n===== PHASE {phase} (neuter_force={neuter_force}) =====")
    os.chdir(MIDDLEWARE_DIR)
    from pianoid import initialize
    preset = None
    for cand in ("Preset_test5.json", "BaselinePreset1.json"):
        try:
            preset = pp(cand); break
        except FileNotFoundError:
            continue
    print(f"preset: {preset}")
    pw = initialize(preset, filterlen=48*128*3, string_iteration=4, array_size=384,
                    sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, max_volume=5e18,
                    audio_on=False, audio_driver_type=0)

    if neuter_force:
        # Simulate the proposed fix: read the flag WITHOUT forcing a competing synthesis cycle.
        pm = pw.parameter_manager if hasattr(pw, "parameter_manager") else pw
        orig = type(pm)._raise_if_cfl_rejected
        def patched(self, pitches):
            if self.pianoid is None:
                return
            self.pianoid.waitForParameterUpdate()  # drain async upload; NO runSynthesisKernel()
            flags = list(self.pianoid.getStringStableFlags())
            ratios = list(self.pianoid.getStringStabilityRatios())
            rejected = []
            for pitchID in pitches:
                pitch = self.sm.pitches[pitchID]
                for sid in pitch.get_strings():
                    si = self.sm.string_index.index(sid)
                    if 0 <= si < len(flags) and flags[si] != 0:
                        r = ratios[si] if si < len(ratios) else float('nan')
                        rejected.append((pitchID, si, r))
            if rejected:
                raise ValueError(f"string parameter rejected (neutered-repro): {rejected}")
        type(pm)._raise_if_cfl_rejected = patched

    try:
        pw.start_pianoid()
        print("[engine started]")
        # play a sustained note into the realtime buffer
        pw.schedule_event(144, TEST_PITCH, 100, validate_state=True, apply_fix_velocity=False)
        adv0, fin0, _ = sample_liveness(pw, "BEFORE-edit")
        exc0 = bool(getattr(pw, "exception", False))

        # STABILIZING edit: REDUCE tension on the played pitch (should NOT destabilize).
        pobj = pw.sm.pitches[TEST_PITCH]
        base_t = pobj.physics.tension
        new_t = base_t * 0.8  # 20% reduction = stabilizing
        print(f"  editing pitch {TEST_PITCH} tension {base_t:.3g} -> {new_t:.3g} (stabilizing reduction)")
        t_edit0 = time.time()
        edit_raised = None
        try:
            pw.update_parameter('string', {str(TEST_PITCH): {'tension': float(new_t)}}, pitches=[TEST_PITCH])
        except Exception as e:
            edit_raised = f"{type(e).__name__}: {e}"
        edit_dt = time.time() - t_edit0
        print(f"  update_parameter returned after {edit_dt*1000:.0f} ms  raised={edit_raised}")

        adv1, fin1, _ = sample_liveness(pw, "AFTER-edit")
        exc1 = bool(getattr(pw, "exception", False))
        thread_alive = pw._playback_thread.is_alive() if pw._playback_thread else False

        print(f"\n  RESULT phase {phase}:")
        print(f"    synthesis advancing BEFORE edit = {adv0} (finite={fin0}, engine_exc={exc0})")
        print(f"    synthesis advancing AFTER  edit = {adv1} (finite={fin1}, engine_exc={exc1})")
        print(f"    engine thread alive after edit  = {thread_alive}")
        halted = adv0 and (not adv1)
        print(f"    >>> SYNTHESIS HALTED BY THE EDIT = {halted}")
        return dict(phase=phase, adv_before=adv0, adv_after=adv1, halted=halted,
                    engine_exc_after=exc1, thread_alive=thread_alive, edit_raised=edit_raised)
    finally:
        try:
            pw.stop_playback()
        except Exception as e:
            print(f"  stop_playback err: {e}")
        try:
            pw.pianoid.shutdownGpu()
        except Exception:
            pass
        time.sleep(0.3)


def main():
    results = []
    # PHASE R: reproduce the regression with the SHIPPED _raise_if_cfl_rejected (forces runSynthesisKernel).
    results.append(run_phase("R-repro", neuter_force=False))
    # PHASE A: A/B — neuter the forced runSynthesisKernel; synthesis should survive the edit.
    results.append(run_phase("A-fix-sim", neuter_force=True))

    print("\n\n================= SUMMARY =================")
    for r in results:
        print(r)
    rep = results[0]
    fix = results[1]
    print("\nCONCLUSION:")
    print(f"  Regression reproduced (shipped path halts synthesis): {rep['halted'] or rep['engine_exc_after'] or (not rep['thread_alive'])}")
    print(f"  Fix-sim keeps synthesis alive across the same edit:   {fix['adv_after'] and not fix['engine_exc_after'] and fix['thread_alive']}")


if __name__ == "__main__":
    main()
