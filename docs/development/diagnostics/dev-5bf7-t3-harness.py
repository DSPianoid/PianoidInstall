"""dev-5bf7 — 4000-modes T3 (uniform flat tier) render / timing harness (one run = one fresh process).

Binary + PianoidBasic under test are selected WITHOUT touching the shared venv: put a directory holding
`pianoidCuda*.pyd` + `cudart64_12.dll` AND the scratch PianoidBasic install (pip --target) first on PYTHONPATH.
Run from the Core worktree's pianoid_middleware (pattern: dev-624c-t1-harness.py).

Usage:
    PYTHONPATH=<bin>;<basic> python dev-5bf7-t3-harness.py <preset.json> <kw: Belarus|F15> <label> <out_dir>
        [--render-s 8] [--listen] [--no-timing] [--debug] [--stem NAME]

Writes <label>_<stem>_{audio,modes,probe}.npy (3 s chord C2-C6 x2 as in T1, mode state, all-mode probe), with
--listen also <label>_<stem>_listen.npy (single notes across the range + chords, all output channels), and
<label>_<stem>_<pid>.json (addKernel CUDA-event timing, coop report, flat-tier fields seen by the engine).
"""
import json
import os
import sys
import time

import numpy as np

KW = {  # initialize() kwargs = each preset's stored output_scale_load_settings (as T1)
    "Belarus": dict(string_iteration=4, array_size=384, sample_rate=48000, samples_in_cycle=64,
                    listen_to_modes=False, sound_derivative_order=2),
    "F15": dict(string_iteration=16, array_size=512, sample_rate=48000, samples_in_cycle=64,
                listen_to_modes=False, sound_derivative_order=1),
}
CHORD = [36, 48, 55, 60, 64, 67, 72, 84]
VELOCITY = 100
CPS = 48000 / 64                                   # cycles per second
LISTEN_NOTES = [28, 40, 52, 60, 69, 79, 88, 100]   # single notes, 1.5 s each
LISTEN_CHORDS = [[36, 43, 48, 52], [60, 64, 67, 72], [72, 76, 79, 84, 88], CHORD]   # 3 s each


def ev(pc, pitch, cycle, on=True):
    e = pc.PlaybackEvent()
    e.type = pc.EventType.NOTE_ON if on else pc.EventType.NOTE_OFF
    e.channel = 0
    e.cycle_index = int(cycle)
    e.data = (pitch << 8) | (VELOCITY if on else 0)
    return e


def run_offline(p, pc, seconds, record, events=()):
    q = pc.EventQueue()
    for e in events:
        q.addEvent(e)
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


def chord_events(pc, seconds):
    return [ev(pc, pitch, c) for c in (100, 100 + int(seconds * CPS) // 2) for pitch in CHORD]


def listen_events(pc):
    evs, t = [], 0.2
    for pitch in LISTEN_NOTES:
        evs += [ev(pc, pitch, t * CPS), ev(pc, pitch, (t + 1.2) * CPS, on=False)]
        t += 1.5
    for chord in LISTEN_CHORDS:
        evs += [ev(pc, pitch, t * CPS) for pitch in chord]
        evs += [ev(pc, pitch, (t + 2.4) * CPS, on=False) for pitch in chord]
        t += 3.0
    return evs, t + 0.5


def mode_probe(p, pc, num_modes):
    p.resetStringsState()
    run_offline(p, pc, 0.05, record=False)
    p.resetModeRunningState()
    for m in range(num_modes):
        p.exciteMode(m, 1e-3 * (1 + m % 7), 0.0)
    run_offline(p, pc, 0.25, record=False)
    return np.asarray(p.getModeDisplacements(), dtype=np.float64)


def main():
    preset, kw_key, label, out_dir = sys.argv[1:5]
    render_s = float(sys.argv[sys.argv.index("--render-s") + 1]) if "--render-s" in sys.argv else 8.0
    debug = "--debug" in sys.argv
    os.makedirs(out_dir, exist_ok=True)
    sys.path.insert(0, os.getcwd())
    from pianoid import initialize
    pw = initialize(preset, filterlen=48 * 128 * 3, buffer_size=4, audio_on=False, audio_driver_type=0,
                    use_debug_build=debug, **KW[kw_key])
    p = pw.pianoid
    if debug:
        import pianoidCuda_debug as pc
    else:
        import pianoidCuda as pc
    name = sys.argv[sys.argv.index("--stem") + 1] if "--stem" in sys.argv else os.path.splitext(os.path.basename(preset))[0]
    stem = f"{label}_{name}"
    run_offline(p, pc, 3.0, record=True, events=chord_events(pc, 3.0))
    np.save(os.path.join(out_dir, f"{stem}_audio.npy"), np.asarray(p.getRecordedAudio(), dtype=np.float64))
    disp = np.asarray(p.getModeDisplacements(), dtype=np.float64)
    np.save(os.path.join(out_dir, f"{stem}_modes.npy"), disp)
    num_modes = len(disp) // 5
    np.save(os.path.join(out_dir, f"{stem}_probe.npy"), mode_probe(p, pc, num_modes))
    if "--listen" in sys.argv:
        p.resetStringsState()
        p.resetModeRunningState()
        run_offline(p, pc, 0.1, record=False)
        evs, dur = listen_events(pc)
        run_offline(p, pc, dur, record=True, events=evs)
        np.save(os.path.join(out_dir, f"{stem}_listen.npy"), np.asarray(p.getRecordedAudio(), dtype=np.float64))
    d = pw.mp.pack_as_dict_for_cuda()
    res = {"label": label, "preset": preset, "pyd": getattr(pc, "__file__", "?"), "pid": os.getpid(),
           "num_modes": num_modes, "debug": debug,
           "flat_tier": [d.get("flat_tier_num_shaped"), d.get("flat_tier_num_flat")]}
    if not debug and "--no-timing" not in sys.argv:
        p.resetStringsState()
        p.resetModeRunningState()
        run_offline(p, pc, 1.0, record=False, events=chord_events(pc, 1.0))
        p.resetProfiling()
        p.startProfiling()
        t0 = time.perf_counter()
        run_offline(p, pc, render_s, record=False, events=chord_events(pc, render_s))
        wall = time.perf_counter() - t0
        p.stopProfiling()
        add = np.asarray(p.getGpuProfilingData(), dtype=np.float64)[:, 3]
        res.update({"cycles": int(len(add)), "wall_s": wall,
                    "add_ms": {"mean": float(add.mean()), "median": float(np.median(add)),
                               "p99": float(np.percentile(add, 99)), "max": float(add.max())}})
    if hasattr(pc, "getCoopOccupancyReport"):
        res["coop"] = dict(pc.getCoopOccupancyReport())
    with open(os.path.join(out_dir, f"{stem}_{os.getpid()}.json"), "w") as f:
        json.dump(res, f, indent=1)
    print("RESULT " + json.dumps(res))
    try:
        p.shutdownGpu()
    except Exception:
        pass


if __name__ == "__main__":
    main()
