"""dev-f27f -- tail-damper offline render (one preset/config per process; never the live backend).

    <venv>/Scripts/python docs/development/diagnostics/dev-f27f-tail-damper-render.py \
        PRESET.json LABEL OUT_DIR --core CORE_DIR [--tail stored|zero|x1000|set=V] [--coeffs]

Renders A1/C4/C7 (33/60/96) at v64/v110, key held HOLD_MS then released, and records per note:
level (RMS 0-500 ms, peak), decay while held (0.2..HOLD-0.05 s), decay after key release
(release+0.05 .. release+0.5 s and .. +1.2 s, 50 ms RMS envelope, floor-guarded), pitch (cents, first 1 s),
non-finite count. Saves channel-0 float32 .npy per note for paired WAVs.
--tail rewrites every pitch's physics.damper_tail in a temp copy of the preset (stored = untouched).
--coeffs (debug variant only, PIANOID_DEBUG_DATA) dumps the parameterKernel output dev_parameters to
coeffs.npy after initialize (bit-identity check of the kernel coefficients).
"""
import argparse
import json
import os
import sys

import numpy as np

NOTES = (33, 60, 96)
VELOCITIES = (64, 110)
HOLD_MS, RENDER_MS = 1000, 2600
SR, SPC = 48000, 64


def render(p, pitch, vel):
    import pianoidCuda
    from PanoidResult import PianoidResult
    eq = pianoidCuda.EventQueue()
    for cyc, typ, v in ((0, pianoidCuda.EventType.NOTE_ON, vel),
                        (int(HOLD_MS / 1000 * SR / SPC), pianoidCuda.EventType.NOTE_OFF, 0)):
        ev = pianoidCuda.PlaybackEvent()
        ev.channel, ev.cycle_index, ev.type, ev.data = 0, cyc, typ, (pitch << 8) | v
        eq.addEvent(ev)
    eq.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled, cfg.record_to_buffer = False, True
    cfg.sample_rate, cfg.samples_per_cycle, cfg.max_duration_ms = SR, SPC, RENDER_MS
    cpp = p.pianoid
    with p.cuda_lock:
        cpp.waitForParameterUpdate()
        cpp.resetStringsState()
        cpp.runSynthesisKernel()
        cpp.clearRecords()
        stats = cpp.runOfflinePlayback(eq, cfg)
        if not stats.completed_successfully:
            raise RuntimeError(stats.error_message)
        res = PianoidResult(cpp, p.mp)
        res.load_offline_sound_from_pianoid()
    return np.asarray(res.sound, dtype=np.float64)


def envelope(x, win=0.05):
    n = int(win * SR)
    env = np.array([np.sqrt(np.mean(x[i:i + n] ** 2)) for i in range(0, len(x) - n, n)])
    return (np.arange(len(env)) + 0.5) * win, env


def fit_db_per_s(t, env, t0, t1):
    floor = env.max() * 1e-5
    sel = (t > t0) & (t < t1) & (env > floor)
    if sel.sum() < 4:
        return None
    return float(np.polyfit(t[sel], 20 * np.log10(env[sel]), 1)[0])


def db(v):
    return float(20 * np.log10(v)) if v > 0 else None


def apply_tail(preset, mode):
    for pv in preset["pitches"].values():
        ph = pv.get("physics")
        if not ph or "damper_tail" not in ph:
            continue
        if mode == "zero":
            ph["damper_tail"] = 0.0
        elif mode == "x1000":
            ph["damper_tail"] = ph["damper_tail"] * 1000.0
        elif mode.startswith("set="):
            ph["damper_tail"] = float(mode[4:])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("preset"); ap.add_argument("label"); ap.add_argument("out_dir")
    ap.add_argument("--core", required=True)
    ap.add_argument("--tail", default="stored")
    ap.add_argument("--notes", default=None)
    ap.add_argument("--velocities", default=None)
    ap.add_argument("--coeffs", action="store_true")
    a = ap.parse_args()
    notes = tuple(int(x) for x in a.notes.split(",")) if a.notes else NOTES
    vels = tuple(int(x) for x in a.velocities.split(",")) if a.velocities else VELOCITIES
    a.out_dir, a.preset = os.path.abspath(a.out_dir), os.path.abspath(a.preset)
    od = os.path.join(a.out_dir, a.label)
    os.makedirs(od, exist_ok=True)
    with open(a.preset) as f:
        preset = json.load(f)
    path = a.preset
    if a.tail != "stored":
        apply_tail(preset, a.tail)
        path = os.path.join(od, "preset.json")
        with open(path, "w") as f:
            json.dump(preset, f)
    lp = dict(preset.get("fpga_conversion", {}).get("load_params", {}))
    mw = os.path.abspath(os.path.join(a.core, "pianoid_middleware"))
    sys.path.insert(0, mw)
    os.chdir(mw)
    from pianoid import initialize
    from auto_tuner import MeasurementEngine
    p = initialize(path, filterlen=48 * 128 * 3, string_iteration=lp.get("string_iteration", 4),
                   array_size=lp.get("array_size", 384), sample_rate=SR, samples_in_cycle=SPC, buffer_size=4,
                   audio_on=False, audio_driver_type=0, listen_to_modes=False,
                   sound_derivative_order=lp.get("sound_derivative_order", 1),
                   use_debug_build=True if a.coeffs else None)
    import pianoidCuda
    if a.coeffs:
        with p.cuda_lock:
            p.pianoid.waitForParameterUpdate()
            p.pianoid.resetStringsState()
            p.pianoid.runSynthesisKernel()      # parameterKernel runs with the synthesis launch
            c = np.asarray(p.pianoid.getParameters(), dtype=np.float32)
        np.save(os.path.join(od, "coeffs.npy"), c)
        print("coeffs", c.size, "nonzero", int(np.count_nonzero(c)))
        return
    me = MeasurementEngine()
    tails = {str(n): preset["pitches"][str(n)]["physics"].get("damper_tail") for n in notes
             if str(n) in preset["pitches"]}
    res = {"preset": a.preset, "tail_mode": a.tail, "pyd": pianoidCuda.__file__, "damper_tail_played": tails,
           "load_params": {"string_iteration": int(p.mp.string_iteration), "array_size": int(p.mp.array_size)},
           "hold_ms": HOLD_MS, "render_ms": RENDER_MS, "notes": []}
    rel = HOLD_MS / 1000
    for pitch in notes:
        for vel in vels:
            snd = render(p, pitch, vel)
            fin = np.isfinite(snd)
            s = np.where(fin, snd, 0.0)
            x = s[0]
            t, env = envelope(x)
            mm = me.measure_frequency(x[:SR], SR, 440.0 * 2 ** ((pitch - 69) / 12), search_semitones=2.0)
            r = {"pitch": pitch, "velocity": vel, "nonfinite": int((~fin).sum()),
                 "peak_db": db(float(np.max(np.abs(x)))),
                 "rms_db": db(float(np.sqrt(np.mean(x[: int(0.5 * SR)] ** 2)))),
                 "decay_hold": fit_db_per_s(t, env, 0.2, rel - 0.05),
                 "decay_rel_05": fit_db_per_s(t, env, rel + 0.05, rel + 0.5),
                 "decay_rel_12": fit_db_per_s(t, env, rel + 0.05, rel + 1.2),
                 "level_db_rel_05": db(float(np.sqrt(np.mean(x[int((rel + 0.45) * SR): int((rel + 0.55) * SR)] ** 2)))),
                 "cents": float(mm.cents_error), "conf": float(mm.confidence)}
            res["notes"].append(r)
            np.save(os.path.join(od, f"p{pitch}_v{vel}_ch0.npy"), x.astype(np.float32))
            print(json.dumps(r))
    with open(os.path.join(od, "results.json"), "w") as f:
        json.dump(res, f, indent=1)


if __name__ == "__main__":
    main()
