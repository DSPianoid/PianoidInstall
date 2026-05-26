"""dev-cfl realtime-halt reproduction (the showstopper).

Reproduces the user-reported regression: with the CFL guard build, a string
parameter change — EVEN a stabilizing one (tension REDUCTION) — silently halts
synthesis in the LIVE/realtime engine.

Hypothesis under test (measure-first, NOT assumed): the halt is caused by the
host R1 read in parameter_manager._raise_if_cfl_rejected, which calls
pianoid.runSynthesisKernel() from the REST/param thread (UNLOCKED — no cuda_lock),
while the engine thread (OnlinePlaybackEngine.run()) is already driving
runSynthesisKernel() every cycle. Two concurrent unsynchronized drivers of the
engine's exclusive per-cycle kernel call -> race on the GPU stream + the engine's
cycle accounting (new_notes_ind / double buffer / output ring) -> audio halts.

This faithfully reproduces the live backend's threading (per
docs/architecture/SYSTEM_OVERVIEW.md "Threading Model" +
docs/modules/pianoid-cuda/PLAYBACK_SYSTEM.md "OnlinePlaybackEngine"):
  * background daemon thread runs OnlinePlaybackEngine.run() (= the engine thread)
  * main thread acts as the REST thread and issues update_parameter('string', ...)

audio_enabled=False so we DON'T grab the audio device (contention-safe vs other
agents); record_to_buffer=True so the engine appends each cycle's audio to the
host ring, which we read back to detect halt/silence/NaN.

Run (no backend, no ports, no audio device):
    cd PianoidCore
    .venv/Scripts/python ../docs/development/diagnostics/dev-cfl-realtime-halt-repro.py
"""
import os
import sys
import time
import threading
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CORE = os.path.normpath(os.path.join(HERE, "..", "..", "..", "PianoidCore"))
MIDDLEWARE_DIR = os.path.join(CORE, "pianoid_middleware")
TESTS_DIR = os.path.join(CORE, "tests")
for p in (MIDDLEWARE_DIR, CORE, TESTS_DIR):
    if p not in sys.path:
        sys.path.insert(0, p)

import pianoidCuda  # noqa: E402

# Import the SAME canonical values the system test uses — a samples_per_cycle
# mismatch vs filterlen overruns the FIR filter buffers and crashes natively at
# registration (learned the hard way: hardcoded 48 vs conftest's 64).
from tests.conftest import get_preset_path, SAMPLE_RATE, SAMPLES_PER_CYCLE  # noqa: E402

TEST_PITCH = 60
TEST_VELOCITY = 80

# AUDIO_ON=1 -> open the REAL audio driver (audio_on init + engine audio_enabled),
# which adds the audio-callback thread + driver ring back-pressure that the
# audio_off path omits. This is the live-faithful configuration the user hit.
AUDIO_ON = os.environ.get("AUDIO_ON", "0") == "1"


def _preset_path():
    return get_preset_path("Preset_test5.json")


def _make_pianoid():
    cwd = os.getcwd()
    os.chdir(MIDDLEWARE_DIR)
    try:
        from pianoid import initialize
        return initialize(
            _preset_path(),
            filterlen=48 * 128 * 3,
            string_iteration=4, array_size=384,
            sample_rate=SAMPLE_RATE, samples_in_cycle=SAMPLES_PER_CYCLE,
            buffer_size=4, max_volume=5e18,
            audio_on=AUDIO_ON, audio_driver_type=0,
        )
    finally:
        os.chdir(cwd)


def _note_on(pitch, velocity, cycle):
    ev = pianoidCuda.PlaybackEvent()
    ev.type = pianoidCuda.EventType.NOTE_ON
    ev.channel = 0
    ev.cycle_index = cycle
    ev.data = (pitch << 8) | velocity
    return ev


def _note_off(pitch, cycle):
    ev = pianoidCuda.PlaybackEvent()
    ev.type = pianoidCuda.EventType.NOTE_OFF
    ev.channel = 0
    ev.cycle_index = cycle
    ev.data = (pitch << 8)
    return ev


def _start_engine_thread(pw, max_ms):
    """Start OnlinePlaybackEngine.run() in a background thread = the engine thread.
    Mirrors tests/system/test_playback.py::test_chord_playback EXCEPT audio_enabled=False
    (no audio device → contention-safe). A sustained note is PRE-LOADED via loadEvents
    (no perform_midi_command, which needs PLAYBACK_ACTIVE lifecycle state we don't set).
    The engine appends each cycle to the Pianoid raw-sound ring (getRawSoundRecord)."""
    cycles_per_ms = SAMPLE_RATE / SAMPLES_PER_CYCLE / 1000.0
    eq = pianoidCuda.EventQueue()
    eq.addEvent(_note_on(TEST_PITCH, TEST_VELOCITY, int(100 * cycles_per_ms)))     # onset ~100ms
    eq.addEvent(_note_off(TEST_PITCH, int((max_ms - 200) * cycles_per_ms)))         # sustain almost the whole window
    eq.sortByCycle()

    cfg = pianoidCuda.PlaybackConfig()
    cfg.sample_rate = SAMPLE_RATE
    cfg.samples_per_cycle = SAMPLES_PER_CYCLE
    cfg.audio_enabled = AUDIO_ON     # AUDIO_ON=1 -> real driver (live-faithful); else no device
    cfg.record_to_buffer = True      # append each cycle to host ring so we can read it
    cfg.max_duration_ms = max_ms     # finite so the thread exits on its own
    cfg.keep_audio_on_stop = True

    engine = pianoidCuda.OnlinePlaybackEngine()
    engine.initialize(pw.pianoid, cfg)
    engine.loadEvents(eq)

    state = {"error": None, "done": False}

    def run():
        try:
            engine.run()
        except Exception as e:  # noqa: BLE001
            import traceback
            state["error"] = f"{e}\n{traceback.format_exc()}"
        finally:
            state["done"] = True

    th = threading.Thread(target=run, name="ReproEngineThread", daemon=True)
    th.start()
    return engine, None, th, state


def _recorded(cpp):
    """Read the ONLINE engine's output. The engine's run() loop calls
    runCycle({Online, record_to_host=true}) which appends each cycle to the
    Pianoid raw-sound ring (getRawSoundRecord) — NOT OnlinePlaybackEngine.
    getRecordedAudio() (that is the OFFLINE engine's buffer, empty here)."""
    try:
        return np.array(cpp.getRawSoundRecord(), dtype=np.float64)
    except Exception:
        return np.array([], dtype=np.float64)


def main():
    print(f"=== dev-cfl REALTIME-HALT repro (guard build) | AUDIO_ON={AUDIO_ON} ===")
    pw = _make_pianoid()
    cpp = pw.pianoid

    base_tension = pw.sm.pitches[TEST_PITCH].physics.tension
    print(f"baseline tension(pitch {TEST_PITCH}) = {base_tension}")

    def tail_rms():
        """RMS of the last ~0.5s of the engine's raw-sound RING (circular 5s
        buffer). If the engine halts, fresh audio stops and this collapses to
        ~0 as the ring drains. Returns (rms, n, nan_count)."""
        a = _recorded(cpp)
        if a.size == 0:
            return 0.0, 0, 0
        seg = a[-24000:] if a.size >= 24000 else a
        nan = int(np.sum(~np.isfinite(seg)))
        finite = seg[np.isfinite(seg)]
        rms = float(np.sqrt(np.mean(finite ** 2))) if finite.size else 0.0
        return rms, a.size, nan

    # Start the engine thread (6s window — long enough to observe ~2s post-edit).
    # A sustained note (pitch 60) is pre-loaded into the engine's queue (onset ~100ms).
    engine, rt_buffer, th, state = _start_engine_thread(pw, max_ms=6000)
    print("engine thread started (audio_enabled=False, record_to_host ring, note pre-loaded)")

    # Let the note sound and the ring fill before the edit.
    time.sleep(1.6)
    pre_rms, pre_n, pre_nan = tail_rms()
    print(f"[PRE-EDIT]  ring_tail_rms={pre_rms:.4e} ring_n={pre_n} nan={pre_nan} engine_running={engine.isRunning()}")

    # === THE EDIT: a STABILIZING change (tension REDUCTION x0.8) via the REST path. ===
    # update_parameter('string', ...) -> _raise_if_cfl_rejected -> runSynthesisKernel() UNLOCKED,
    # concurrently with the engine thread's per-cycle runCycle()/runSynthesisKernel().
    edit_err = None
    t_edit = time.time()
    try:
        pw.update_parameter(
            'string',
            {str(TEST_PITCH): {'tension': float(base_tension * 0.8)}},
            pitches=[TEST_PITCH])
        print("[EDIT] stabilizing tension x0.8 applied via update_parameter (no exception)")
    except Exception as e:  # noqa: BLE001
        edit_err = repr(e)
        print(f"[EDIT] update_parameter raised: {edit_err}")
    edit_ms = (time.time() - t_edit) * 1000
    print(f"[EDIT] update_parameter returned after {edit_ms:.0f} ms (engine_running={engine.isRunning()})")

    # Sample the ring tail at intervals AFTER the edit. A live engine keeps fresh
    # audio flowing (tail_rms stays > 0); a halted engine drains to ~0.
    post = []
    for i in range(4):
        time.sleep(0.4)
        r, n, nan = tail_rms()
        post.append((r, nan, engine.isRunning()))
        print(f"[POST-EDIT t+{(i + 1) * 0.4:.1f}s] ring_tail_rms={r:.4e} nan={nan} engine_running={engine.isRunning()} thread_err={state['error'] is not None}")

    post_rms = max(p[0] for p in post)
    post_nan = sum(p[1] for p in post)
    print(f"[ENGINE-THREAD] error={state['error']!r} done={state['done']}")

    # Stop the engine and join.
    try:
        engine.stop()
    except Exception:
        pass
    th.join(timeout=3.0)

    # ---- VERDICT ----
    produced_before = pre_rms > 1e-6 and pre_nan == 0
    continued_after = post_rms > 1e-6 and post_nan == 0
    # A halt = it WAS producing audible finite signal before the edit, but after the
    # edit the signal collapsed (ring drains to ~0) or went non-finite or the thread errored.
    halted = produced_before and (not continued_after or state["error"] is not None)
    print("\n=== VERDICT ===")
    print(f"  produced_signal_before_edit: {produced_before}  (pre_tail_rms={pre_rms:.4e})")
    print(f"  signal_continued_after_edit: {continued_after}  (max_post_tail_rms={post_rms:.4e}, post_nan={post_nan})")
    print(f"  engine_thread_error:         {state['error'] is not None}")
    print(f"  >>> REALTIME HALT REPRODUCED: {halted}")
    if not produced_before:
        print("  [WARN] engine produced no audible signal even BEFORE the edit -> repro INCONCLUSIVE "
              "(note injection / readback issue, not a halt).")

    try:
        cpp.shutdownGpu()
    except Exception:
        pass
    return 0 if True else 1


if __name__ == "__main__":
    sys.exit(main())
