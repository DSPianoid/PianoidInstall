"""dev-cfl-3: positive confirmation that the realtime engine KEEPS ADVANCING across a string edit
(both fixes installed: isSoundString skip + passive/branched R1).

dev-cfl-2's halt-repro already shows HALT=False on the fixed build. This sharpens the evidence:
distinguishes "engine still cycling (fresh samples written)" from "residual decay of a frozen ring"
by checking that the ring's TOTAL sample count keeps GROWING after the edit, and confirms the edited
string's flag=0 (stabilizing edit not rejected) and the sound strings (220-223) flag=0 (Defect #2).

Run: cd PianoidCore && unset VIRTUAL_ENV && ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-cfl-realtime-continue-confirm.py
"""
import os, sys, time, threading
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CORE = os.path.normpath(os.path.join(HERE, "..", "..", "..", "PianoidCore"))
MIDDLEWARE_DIR = os.path.join(CORE, "pianoid_middleware")
TESTS_DIR = os.path.join(CORE, "tests")
for p in (MIDDLEWARE_DIR, CORE, TESTS_DIR):
    if p not in sys.path:
        sys.path.insert(0, p)
import pianoidCuda  # noqa
from tests.conftest import get_preset_path, SAMPLE_RATE, SAMPLES_PER_CYCLE  # noqa

TEST_PITCH = 60
VEL = 80


def note_ev(t, pitch, vel, cycle):
    ev = pianoidCuda.PlaybackEvent()
    ev.type = t; ev.channel = 0; ev.cycle_index = cycle
    ev.data = (pitch << 8) | vel
    return ev


def main():
    os.chdir(MIDDLEWARE_DIR)
    from pianoid import initialize
    pw = initialize(get_preset_path("Preset_test5.json"), filterlen=48*128*3, string_iteration=4,
                    array_size=384, sample_rate=SAMPLE_RATE, samples_in_cycle=SAMPLES_PER_CYCLE,
                    buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0)
    cpp = pw.pianoid
    cpc = SAMPLE_RATE / SAMPLES_PER_CYCLE / 1000.0
    sidx = [pw.sm.string_index.index(s) for s in pw.sm.pitches[TEST_PITCH].get_strings()]
    sound_idx = []
    for pid in (128, 129, 130, 131):
        if pid in pw.sm.pitches:
            sound_idx += [pw.sm.string_index.index(s) for s in pw.sm.pitches[pid].get_strings()]

    eq = pianoidCuda.EventQueue()
    eq.addEvent(note_ev(pianoidCuda.EventType.NOTE_ON, TEST_PITCH, VEL, int(100 * cpc)))
    eq.addEvent(note_ev(pianoidCuda.EventType.NOTE_OFF, TEST_PITCH, 0, int(5800 * cpc)))
    eq.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig()
    cfg.sample_rate = SAMPLE_RATE; cfg.samples_per_cycle = SAMPLES_PER_CYCLE
    cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.max_duration_ms = 6000; cfg.keep_audio_on_stop = True
    engine = pianoidCuda.OnlinePlaybackEngine()
    engine.initialize(cpp, cfg); engine.loadEvents(eq)
    state = {"err": None}

    def run():
        try:
            engine.run()
        except Exception as e:
            import traceback; state["err"] = f"{e}\n{traceback.format_exc()}"
    th = threading.Thread(target=run, daemon=True); th.start()

    def ring_len():
        try:
            return int(np.asarray(cpp.getRawSoundRecord()).size)
        except Exception:
            return -1

    time.sleep(1.6)
    n_pre = ring_len()
    print(f"[PRE]  ring_len={n_pre} engine_running={engine.isRunning()}")

    base_t = pw.sm.pitches[TEST_PITCH].physics.tension
    err = None
    try:
        pw.update_parameter('string', {str(TEST_PITCH): {'tension': float(base_t * 0.8)}}, pitches=[TEST_PITCH])
    except Exception as e:
        err = repr(e)
    print(f"[EDIT] tension x0.8 (stabilizing); raised={err}; engine_running={engine.isRunning()}")

    # Sample ring length growth post-edit — a LIVE engine keeps writing, so total samples keep rising.
    lens = []
    for i in range(4):
        time.sleep(0.4)
        lens.append(ring_len())
    print(f"[POST] ring_len progression = {lens}")
    flags = list(cpp.getStringStableFlags())
    edited_flags = [flags[s] for s in sidx]
    sound_flags = [flags[s] for s in sound_idx]
    print(f"[FLAGS] edited pitch {TEST_PITCH} strings {sidx} flags={edited_flags} (expect all 0 = stabilizing not rejected)")
    print(f"[FLAGS] sound strings {sound_idx} flags={sound_flags} (expect all 0 = Defect #2 skip)")

    try:
        engine.stop()
    except Exception:
        pass
    th.join(timeout=3.0)

    # Verdict: ring kept growing (engine cycling) AND no thread error AND flags correct.
    grew = all(b >= a for a, b in zip([n_pre] + lens, lens)) and lens[-1] > n_pre
    advancing = lens[-1] > lens[0]  # still adding samples between first and last post-edit read
    print("\n=== VERDICT (in-proc realtime regression) ===")
    print(f"  ring kept advancing post-edit (engine cycling, not frozen): {advancing}  (delta={lens[-1]-lens[0]})")
    print(f"  total ring grew vs pre-edit: {grew}")
    print(f"  engine_thread_error: {state['err'] is not None}")
    print(f"  edited-string flags all 0 (stabilizing not rejected): {all(f == 0 for f in edited_flags)}")
    print(f"  sound-string flags all 0 (Defect #2 fixed): {all(f == 0 for f in sound_flags)}")
    ok = advancing and state["err"] is None and all(f == 0 for f in edited_flags) and all(f == 0 for f in sound_flags)
    print(f"  >>> SYNTHESIS CONTINUES ACROSS THE EDIT (no halt): {ok}")

    try:
        cpp.shutdownGpu()
    except Exception:
        pass


if __name__ == "__main__":
    main()
