"""dev-624c — 4000-modes T1 (quarter-fork mode re-index) equivalence + timing harness.

One run = one fresh process = one (binary, preset) sample. The binary under test is selected
WITHOUT touching the shared venv: put a directory holding `pianoidCuda*.pyd` + `cudart64_12.dll`
first on PYTHONPATH (PYTHONPATH precedes site-packages). The middleware Python is the main
checkout's (identical for both binaries), so the only variable is the compiled engine.
(Pattern: dev-1cda-coop-timing.py.)

Usage (from PianoidCore/pianoid_middleware, venv python):
    PYTHONPATH=<bin dir> python dev-624c-t1-harness.py <preset> <label> <out_dir> [--render-s 8] [--debug]

Per run writes into <out_dir>:
  <label>_<preset>_audio.npy   3 s chord render (record_to_buffer, all output channels)
  <label>_<preset>_modes.npy   getModeDisplacements() after the chord render ([q|q_prev|dec|omega|mass_inv] x N)
  <label>_<preset>_probe.npy   MODE-OWNERSHIP PROBE: strings + modes reset, EVERY mode m excited with
                               q = 1e-3 * (1 + m % 7) (no string excitation), 0.25 s offline, then
                               getModeDisplacements(). A mode that no thread advances (or two threads
                               advance) diverges from the base binary here, independent of the chord.
  <label>_<preset>_<pid>.json  addKernel CUDA-event timing (getGpuProfilingData col 3) over --render-s

--debug loads the debug .pyd (use_debug_build=True) and skips timing.
"""
import json
import os
import sys
import time

import numpy as np

PRESETS = {
    # initialize() kwargs = each preset's stored output_scale_load_settings (no re-calibration on load)
    "Belarus_8band_196modes": dict(string_iteration=4, array_size=384, sample_rate=48000,
                                   samples_in_cycle=64, listen_to_modes=False,
                                   sound_derivative_order=2),
    "F15_Elyashev_array512": dict(string_iteration=16, array_size=512, sample_rate=48000,
                                  samples_in_cycle=64, listen_to_modes=False,
                                  sound_derivative_order=1),
}
CHORD = [36, 48, 55, 60, 64, 67, 72, 84]   # piano pitches, struck twice per render
VELOCITY = 100


def note_on(pc, pitch, cycle):
    ev = pc.PlaybackEvent()
    ev.type = pc.EventType.NOTE_ON
    ev.channel = 0
    ev.cycle_index = cycle
    ev.data = (pitch << 8) | VELOCITY
    return ev


def run_offline(p, pc, seconds, record, chord=True):
    q = pc.EventQueue()
    if chord:
        for c in (100, 100 + int(seconds * 48000 / 64) // 2):
            for pitch in CHORD:
                q.addEvent(note_on(pc, pitch, c))
        q.sortByCycle()
    cfg = pc.PlaybackConfig()
    cfg.audio_enabled = False
    cfg.record_to_buffer = record
    cfg.max_duration_ms = int(seconds * 1000)
    cfg.sample_rate = 48000
    cfg.samples_per_cycle = 64
    stats = p.runOfflinePlayback(q, cfg)
    if not stats.completed_successfully:
        raise RuntimeError(f"offline render failed: {stats.error_message}")


def mode_probe(p, pc, num_modes):
    p.resetStringsState()                           # sets resetFlag -> next kernel zeroes strings + s_mode
    run_offline(p, pc, 0.05, record=False, chord=False)   # consume the reset cycle BEFORE exciting
    p.resetModeRunningState()
    for m in range(num_modes):
        p.exciteMode(m, 1e-3 * (1 + m % 7), 0.0)
    run_offline(p, pc, 0.25, record=False, chord=False)
    return np.asarray(p.getModeDisplacements(), dtype=np.float64)


def main():
    preset, label, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    render_s = float(sys.argv[sys.argv.index("--render-s") + 1]) if "--render-s" in sys.argv else 8.0
    debug = "--debug" in sys.argv
    os.makedirs(out_dir, exist_ok=True)
    sys.path.insert(0, os.getcwd())                 # run from pianoid_middleware
    from pianoid import initialize                  # import the engine module only AFTER initialize():
    kw = PRESETS[preset]
    pw = initialize(f"presets/{preset}.json", filterlen=48 * 128 * 3, buffer_size=4,
                    audio_on=False, audio_driver_type=0, use_debug_build=debug, **kw)
    p = pw.pianoid
    if debug:                                       # importing pianoidCuda first would pin the release variant
        import pianoidCuda_debug as pc
    else:
        import pianoidCuda as pc
    stem = f"{label}_{preset}"

    run_offline(p, pc, 3.0, record=True)
    np.save(os.path.join(out_dir, f"{stem}_audio.npy"), np.asarray(p.getRecordedAudio(), dtype=np.float64))
    disp = np.asarray(p.getModeDisplacements(), dtype=np.float64)
    np.save(os.path.join(out_dir, f"{stem}_modes.npy"), disp)
    num_modes = len(disp) // 5
    np.save(os.path.join(out_dir, f"{stem}_probe.npy"), mode_probe(p, pc, num_modes))

    res = {"label": label, "preset": preset, "pyd": getattr(pc, "__file__", "?"), "pid": os.getpid(),
           "num_modes": num_modes, "debug": debug}
    if not debug:
        p.resetStringsState()
        p.resetModeRunningState()
        run_offline(p, pc, 1.0, record=False)          # warm-up (discarded)
        p.resetProfiling()
        p.startProfiling()
        t0 = time.perf_counter()
        run_offline(p, pc, render_s, record=False)
        wall = time.perf_counter() - t0
        p.stopProfiling()
        g = np.asarray(p.getGpuProfilingData(), dtype=np.float64)
        add = g[:, 3]
        res.update({"cycles": int(len(add)), "wall_s": wall,
                    "add_ms": {"mean": float(add.mean()), "median": float(np.median(add)),
                               "p99": float(np.percentile(add, 99)), "max": float(add.max())}})
    if hasattr(pc, "getCoopOccupancyReport"):
        res["coop"] = dict(pc.getCoopOccupancyReport())
    with open(os.path.join(out_dir, f"{stem}_{os.getpid()}.json"), "w") as f:
        json.dump(res, f, indent=1)
    print(json.dumps(res))
    try:
        p.shutdownGpu()
    except Exception:
        pass


if __name__ == "__main__":
    main()
