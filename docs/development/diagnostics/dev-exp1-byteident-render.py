"""dev-exp1 — byte-identical verification harness for the universal-excitation Phase-1 refactor.

Renders a spread of notes offline (audio_off, deterministic offline engine) and saves the raw
recorded-audio float arrays. Renders each note TWICE (run A / run B) in the same process so the
engine's OWN run-to-run noise floor (float atomicAdd order non-determinism in the feedin/feedback/
force reductions — MainKernel.cu:479/622/646) is measured, which defines what "no behavior change"
means for the Phase-1 gate.

Usage:
  render  <out.npz>                  render all notes twice, save a_<key>/b_<key>, print determinism
  compare <baseline.npz> <after.npz> report after-vs-baseline diff against the intrinsic noise floor
"""
import os
import sys
import argparse
import numpy as np

MIDDLEWARE_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
    "PianoidCore", "pianoid_middleware",
)
sys.path.insert(0, MIDDLEWARE_DIR)

SAMPLE_RATE = 48000
SAMPLES_PER_CYCLE = 64
PRESET = os.path.join("presets", "Preset_test5.json")

# Spread across the keyboard + velocity range. Pitches present with a hammer in Preset_test5.
PITCHES = [40, 52, 60, 72, 84, 96]
VELOCITIES = [40, 100, 127]
DURATION_MS = 60


def build_eq(pcuda, pitch, velocity, duration_ms, sample_rate, samples_per_cycle):
    eq = pcuda.EventQueue()
    on = pcuda.PlaybackEvent()
    on.channel = 0
    on.cycle_index = 0
    on.type = pcuda.EventType.NOTE_ON
    on.data = (pitch << 8) | velocity
    eq.addEvent(on)
    cycles = int((duration_ms / 1000.0) * sample_rate / samples_per_cycle)
    off = pcuda.PlaybackEvent()
    off.channel = 0
    off.cycle_index = cycles
    off.type = pcuda.EventType.NOTE_OFF
    off.data = (pitch << 8) | 0
    eq.addEvent(off)
    eq.sortByCycle()
    return eq


def render_note(pcuda, p, pitch, velocity, duration_ms=DURATION_MS):
    cpp = p.pianoid
    sr = p.mp.sample_rate()
    spc = p.mp.mode_iteration
    cpp.waitForParameterUpdate()
    cpp.resetStringsState()
    eq = build_eq(pcuda, pitch, velocity, duration_ms, sr, spc)
    cfg = pcuda.PlaybackConfig()
    cfg.audio_enabled = False
    cfg.record_to_buffer = True
    cfg.sample_rate = sr
    cfg.samples_per_cycle = spc
    cfg.max_duration_ms = duration_ms + 200
    cpp.clearRecords()
    cpp.runOfflinePlayback(eq, cfg)
    return np.array(cpp.getRecordedAudio(), dtype=np.float64)


def do_render(out_path):
    os.chdir(MIDDLEWARE_DIR)
    import pianoidCuda
    print("pianoidCuda:", pianoidCuda.__file__)
    from pianoid import initialize
    p = initialize(
        PRESET,
        filterlen=48 * 128 * 3,
        string_iteration=4,
        array_size=384,
        sample_rate=SAMPLE_RATE,
        samples_in_cycle=SAMPLES_PER_CYCLE,
        buffer_size=4,
        max_volume=5e18,
        audio_on=False,
        audio_driver_type=0,
    )
    data = {}
    worst = 0.0
    for pitch in PITCHES:
        for vel in VELOCITIES:
            key = f"{pitch}_{vel}"
            a = render_note(pianoidCuda, p, pitch, vel)
            b = render_note(pianoidCuda, p, pitch, vel)
            n = min(len(a), len(b))
            d = float(np.max(np.abs(a[:n] - b[:n]))) if n else 0.0
            exact = bool(len(a) == len(b) and np.array_equal(a, b))
            worst = max(worst, d)
            data[f"a_{key}"] = a
            data[f"b_{key}"] = b
            print(f"  {key:>8}  len={len(a):6d}  A-vs-B maxdiff={d:.6g}  exact={exact}")
    np.savez(out_path, **data)
    try:
        p.pianoid.shutdownGpu()
    except Exception:
        pass
    print(f"\nSaved {out_path}")
    print(f"INTRINSIC RUN-TO-RUN NOISE FLOOR (max A-vs-B over all notes): {worst:.6g}")


def do_compare(baseline_path, after_path):
    base = np.load(baseline_path)
    aft = np.load(after_path)
    noise = 0.0
    change = 0.0
    n_exact = 0
    n_total = 0
    rows = []
    for pitch in PITCHES:
        for vel in VELOCITIES:
            key = f"{pitch}_{vel}"
            ba = base[f"a_{key}"]
            bb = base[f"b_{key}"]
            aa = aft[f"a_{key}"]
            # intrinsic noise floor from each build's own A-vs-B
            nb = min(len(ba), len(bb))
            nf_base = float(np.max(np.abs(ba[:nb] - bb[:nb]))) if nb else 0.0
            ab = aft[f"b_{key}"]
            na = min(len(aa), len(ab))
            nf_aft = float(np.max(np.abs(aa[:na] - ab[:na]))) if na else 0.0
            nf = max(nf_base, nf_aft)
            # after-vs-baseline (primary A run of each)
            nc = min(len(ba), len(aa))
            ch = float(np.max(np.abs(ba[:nc] - aa[:nc]))) if nc else 0.0
            exact = bool(len(ba) == len(aa) and np.array_equal(ba, aa))
            n_exact += int(exact)
            n_total += 1
            noise = max(noise, nf)
            change = max(change, ch)
            rows.append((key, len(ba), len(aa), nf, ch, exact))
    print(f"{'note':>8} {'baseLen':>8} {'aftLen':>8} {'noiseFloor':>12} {'after-vs-base':>14} {'exact':>6}")
    for key, lb, la, nf, ch, ex in rows:
        print(f"{key:>8} {lb:>8} {la:>8} {nf:>12.6g} {ch:>14.6g} {str(ex):>6}")
    print(f"\nBYTE-EXACT notes: {n_exact}/{n_total}")
    print(f"MAX intrinsic noise floor (A-vs-B): {noise:.6g}")
    print(f"MAX after-vs-baseline change:       {change:.6g}")
    if n_exact == n_total:
        print("VERDICT: BYTE-IDENTICAL (every note bit-exact vs baseline)")
    elif change <= noise:
        print("VERDICT: WITHIN-NOISE (after-vs-baseline <= engine's own run-to-run noise floor)")
    else:
        print("VERDICT: DIVERGENT (after-vs-baseline EXCEEDS the intrinsic noise floor) — refactor changed behavior")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("render")
    r.add_argument("out")
    c = sub.add_parser("compare")
    c.add_argument("baseline")
    c.add_argument("after")
    args = ap.parse_args()
    if args.cmd == "render":
        do_render(args.out)
    else:
        do_compare(args.baseline, args.after)
