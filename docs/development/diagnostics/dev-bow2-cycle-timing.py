"""dev-bow2: GPU cycle timing for the bow (no bow / one bowed string / several bowed strings).

In-process, audio_off, offline render (the test_performance_audio_off.py fixture config:
BaselinePreset1, array_size 384, string_iteration 4, 64 samples / 48 kHz, budget 1.333 ms).
Each case is rendered N times (fresh note-on each run); per-cycle addKernel time comes from
getGpuProfilingData (CUDA events, columns [cycle, parameter_ms, gauss_ms, add_ms, filter_ms]).

The bow is selected with Pianoid.set_pitch_excitation_mode(pitch, 1) — the same call on the
old (WRAP loop) and the new (friction) engine, so one script measures both.

Usage (cwd anywhere):
    PianoidCore/.venv/Scripts/python dev-bow2-cycle-timing.py --core D:/repos/wt-bow-core --label before
"""
import argparse
import json
import os
import sys

import numpy as np

SAMPLE_RATE = 48000
SAMPLES_PER_CYCLE = 64
BUDGET_MS = SAMPLES_PER_CYCLE / SAMPLE_RATE * 1000

CASES = {
    # name: (bowed pitches, played pitches)
    "a_no_bow": ([], [60]),
    "b_one_bowed": ([36], [36]),
    "c_several_bowed": ([36, 43, 48, 55, 60, 67], [36, 43, 48, 55, 60, 67]),
}


def note_event(pc, pitch, velocity, cycle, on=True):
    ev = pc.PlaybackEvent()
    ev.type = pc.EventType.NOTE_ON if on else pc.EventType.NOTE_OFF
    ev.channel = 0
    ev.cycle_index = cycle
    ev.data = (pitch << 8) | (velocity if on else 0)
    return ev


def run_case(p, pc, bowed, played, duration_s):
    eng = p.pianoid
    strings = {}
    for pitch in set(bowed) | set(played):
        strings[pitch] = int(p.set_pitch_excitation_mode(pitch, 1 if pitch in bowed else 0))
    eng.resetStringsState()
    eng.resetProfiling()
    eng.startProfiling()
    q = pc.EventQueue()
    for pitch in played:
        q.addEvent(note_event(pc, pitch, 90, 20))
    q.sortByCycle()
    cfg = pc.PlaybackConfig()
    cfg.audio_enabled = False
    cfg.record_to_buffer = False
    cfg.max_duration_ms = int(duration_s * 1000)
    cfg.sample_rate = SAMPLE_RATE
    cfg.samples_per_cycle = SAMPLES_PER_CYCLE
    stats = eng.runOfflinePlayback(q, cfg)
    eng.stopProfiling()
    assert stats.completed_successfully, stats.error_message
    data = np.array(eng.getGpuProfilingData())
    add = data[50:, 3]          # skip warm-up and the note-on cycle
    total = data[50:, 1] + data[50:, 2] + data[50:, 3] + data[50:, 4]
    for pitch in bowed:
        p.set_pitch_excitation_mode(pitch, 0)
    return {
        "bowed_strings": sum(strings[x] for x in bowed),
        "cycles": int(len(add)),
        "add_median_ms": float(np.median(add)),
        "add_mean_ms": float(add.mean()),
        "add_mean_trim_ms": float(add[add < 10 * BUDGET_MS].mean()),   # without >13 ms host/WDDM stalls
        "add_p999_ms": float(np.percentile(add, 99.9)),
        "stalls_over_10x_budget": int((add >= 10 * BUDGET_MS).sum()),
        "add_p99_ms": float(np.percentile(add, 99)),
        "add_max_ms": float(add.max()),
        "total_mean_ms": float(total.mean()),
        "total_p99_ms": float(np.percentile(total, 99)),
        "over_budget": int((total > BUDGET_MS).sum()),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", required=True, help="PianoidCore checkout whose middleware to use")
    ap.add_argument("--label", required=True)
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--duration", type=float, default=3.0)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    mw = os.path.join(args.core, "pianoid_middleware")
    sys.path.insert(0, mw)
    os.chdir(mw)
    import pianoidCuda as pc
    from pianoid import initialize

    p = initialize(os.path.join(mw, "presets", "BaselinePreset1.json"), filterlen=48 * 128 * 3,
                   string_iteration=4, array_size=384, sample_rate=SAMPLE_RATE,
                   samples_in_cycle=SAMPLES_PER_CYCLE, buffer_size=4, max_volume=5e18,
                   audio_on=False, audio_driver_type=0)
    results = {"coop_occupancy": dict(pc.getCoopOccupancyReport())}
    print("coop occupancy:", results["coop_occupancy"], flush=True)
    try:
        for name, (bowed, played) in CASES.items():
            runs = [run_case(p, pc, bowed, played, args.duration) for _ in range(args.runs)]
            results[name] = runs
            for i, r in enumerate(runs):
                print(f"{args.label} {name} run{i}: " + " ".join(f"{k}={v:.4f}" if isinstance(v, float) else f"{k}={v}"
                                                             for k, v in r.items()), flush=True)
    finally:
        p.pianoid.shutdownGpu()
    out = args.out or f"dev-bow2-timing-{args.label}.json"
    with open(out, "w") as f:
        json.dump(results, f, indent=1)
    print("wrote", out)


if __name__ == "__main__":
    main()
