"""dev-1cda — addKernel register-cap A/B: per-cycle GPU timing + offline-render output capture.

One run = one fresh process = one (binary, preset) sample. The binary under test is selected
WITHOUT touching the shared venv: put a directory holding `pianoidCuda*.pyd` + `cudart64_12.dll`
first on PYTHONPATH (PYTHONPATH precedes site-packages). The middleware Python is the main
checkout's (identical for both binaries), so the only variable is the compiled engine.

Usage (from PianoidCore/pianoid_middleware, venv python):
    PYTHONPATH=<bin dir> python dev-1cda-coop-timing.py <preset> <label> <out_dir> [--render-s 8]

Writes <out_dir>/<label>_<preset-stem>_<pid>.json (timing stats) and, on the first run of a
(label, preset) pair, <out_dir>/<label>_<preset-stem>_audio.npy (deterministic 3 s render).

Timing source = `getGpuProfilingData()` (CUDA events, PIANOID_ENABLE_PROFILING=1 in both binaries):
columns [cycle, parameter_ms, gauss_ms, add_ms, filter_ms]; add_ms = the cooperative addKernel.
"""
import json
import os
import sys
import time

import numpy as np

PRESETS = {
    # preset stem: initialize() kwargs = each preset's stored output_scale_load_settings, so the
    # load does NOT re-calibrate (output_scale is the stored constant -> raw A/B audio compare is clean)
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


def run_offline(p, pc, seconds, record):
    q = pc.EventQueue()
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


def main():
    preset, label, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    render_s = float(sys.argv[sys.argv.index("--render-s") + 1]) if "--render-s" in sys.argv else 8.0
    os.makedirs(out_dir, exist_ok=True)
    sys.path.insert(0, os.getcwd())                 # run from pianoid_middleware
    import pianoidCuda as pc
    from pianoid import initialize
    kw = PRESETS[preset]
    pw = initialize(f"presets/{preset}.json", filterlen=48 * 128 * 3, buffer_size=4,
                    audio_on=False, audio_driver_type=0, use_debug_build=False, **kw)
    p = pw.pianoid

    audio_path = os.path.join(out_dir, f"{label}_{preset}_audio.npy")
    if not os.path.exists(audio_path):
        run_offline(p, pc, 3.0, record=True)
        np.save(audio_path, np.asarray(p.getRecordedAudio(), dtype=np.float64))

    run_offline(p, pc, 1.0, record=False)          # warm-up (discarded)
    p.resetProfiling()
    p.startProfiling()
    t0 = time.perf_counter()
    run_offline(p, pc, render_s, record=False)
    wall = time.perf_counter() - t0
    p.stopProfiling()
    g = np.asarray(p.getGpuProfilingData(), dtype=np.float64)
    add = g[:, 3]
    tot = g[:, 1] + g[:, 2] + g[:, 3] + g[:, 4]
    res = {
        "label": label, "preset": preset, "pyd": pc.__file__, "pid": os.getpid(),
        "cycles": int(len(add)), "wall_s": wall,
        "add_ms": {"mean": float(add.mean()), "median": float(np.median(add)),
                   "p99": float(np.percentile(add, 99)), "max": float(add.max())},
        "gpu_total_ms": {"mean": float(tot.mean()), "p99": float(np.percentile(tot, 99))},
    }
    if hasattr(pc, "getCoopOccupancyReport"):          # cap binary only (module-level report)
        res["coop"] = dict(pc.getCoopOccupancyReport())
    with open(os.path.join(out_dir, f"{label}_{preset}_{os.getpid()}.json"), "w") as f:
        json.dump(res, f, indent=1)
    print(json.dumps(res))
    try:
        p.shutdownGpu()
    except Exception:
        pass


if __name__ == "__main__":
    main()
