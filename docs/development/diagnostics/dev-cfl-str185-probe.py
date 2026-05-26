"""dev-cfl-3: WHY did string 185 (pitch 60) show flag=1 on a STABILIZING tension x0.8 in the realtime
continue-confirm? Pitch 60 = strings [187,186,185]; only 185 flagged. A real instability would trip all
three (same pitch/tension). One-of-three => suspect a transient flag read while the engine cycle and the
granular double-buffer update interleave (flag reflects a mid-update state, not the settled coeffs).

Measure-first: edit tension x0.8 with the engine running, then read ratio+flag for ALL of pitch 60's
strings REPEATEDLY over ~1.5s. If 185's flag CLEARS to 0 and ratio settles <=1 => transient (not a real
reject; the edit is correctly accepted once the cycle settles). If it PERSISTS with ratio>1 => real.

Run: cd PianoidCore && unset VIRTUAL_ENV && ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-cfl-str185-probe.py
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

PITCH = 60


def ev(t, pitch, vel, cycle):
    e = pianoidCuda.PlaybackEvent(); e.type = t; e.channel = 0; e.cycle_index = cycle
    e.data = (pitch << 8) | vel; return e


def main():
    os.chdir(MIDDLEWARE_DIR)
    from pianoid import initialize
    pw = initialize(get_preset_path("Preset_test5.json"), filterlen=48*128*3, string_iteration=4,
                    array_size=384, sample_rate=SAMPLE_RATE, samples_in_cycle=SAMPLES_PER_CYCLE,
                    buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0)
    cpp = pw.pianoid
    cpc = SAMPLE_RATE / SAMPLES_PER_CYCLE / 1000.0
    sidx = [pw.sm.string_index.index(s) for s in pw.sm.pitches[PITCH].get_strings()]
    print(f"pitch {PITCH} string_indices = {sidx}")

    eq = pianoidCuda.EventQueue()
    eq.addEvent(ev(pianoidCuda.EventType.NOTE_ON, PITCH, 80, int(100 * cpc)))
    eq.addEvent(ev(pianoidCuda.EventType.NOTE_OFF, PITCH, 0, int(5800 * cpc)))
    eq.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig()
    cfg.sample_rate = SAMPLE_RATE; cfg.samples_per_cycle = SAMPLES_PER_CYCLE
    cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.max_duration_ms = 7000; cfg.keep_audio_on_stop = True
    engine = pianoidCuda.OnlinePlaybackEngine(); engine.initialize(cpp, cfg); engine.loadEvents(eq)
    threading.Thread(target=engine.run, daemon=True).start()

    def snap(tag):
        fl = list(cpp.getStringStableFlags()); ra = list(cpp.getStringStabilityRatios())
        print(f"  [{tag}] " + " ".join(f"s{s}:flag={fl[s]},r={ra[s]:.4f}" for s in sidx))

    time.sleep(1.6)
    snap("PRE-EDIT")
    base_t = pw.sm.pitches[PITCH].physics.tension
    print(f"editing tension {base_t:.4g} -> {base_t*0.8:.4g} (x0.8 stabilizing)")
    try:
        pw.update_parameter('string', {str(PITCH): {'tension': float(base_t * 0.8)}}, pitches=[PITCH])
    except Exception as e:
        print(f"  raised: {e!r}")
    # Read repeatedly: does 185 clear?
    for i in range(8):
        time.sleep(0.2)
        snap(f"POST+{(i+1)*0.2:.1f}s")
    try:
        engine.stop()
    except Exception:
        pass
    time.sleep(0.3)
    try:
        cpp.shutdownGpu()
    except Exception:
        pass


if __name__ == "__main__":
    main()
