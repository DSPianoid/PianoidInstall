"""dev-f2b8 -- output LEVEL vs string_iteration (N) offline render (one config per process).

    PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-f2b8-level-vs-n.py \
        PRESET.json LABEL OUT_DIR --n 4 [--deriv 1] [--ltm 0] [--core CORE] [--exc-mult X]

Never two Pianoid instances in one process; never the live backend. Renders A1/C4/C7 (v110, held 1.4 s)
and records the BARE soundFloat peak / RMS (pre-volume, independent of output_scale), decay, pitch, plus
the excitation-coefficient + temporal-impulse factors the middleware composed at this N.
--exc-mult X multiplies the uploaded excitation-coefficient table by X (counter-test of the impulse factor).
"""
import argparse
import json
import os
import sys

import numpy as np

NOTES = (33, 60, 96)
VEL = 110
HOLD_MS, RENDER_MS = 1400, 1600
SR, SPC = 48000, 64


def render(p, pitch, vel):
    import pianoidCuda
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
        from PanoidResult import PianoidResult
        res = PianoidResult(cpp, p.mp)
        res.load_offline_sound_from_pianoid()
    return np.asarray(res.sound, dtype=np.float64)


def decay_db_per_s(x):
    n = int(0.05 * SR)
    env = np.array([np.sqrt(np.mean(x[i:i + n] ** 2)) for i in range(0, len(x) - n, n)])
    t = (np.arange(len(env)) + 0.5) * 0.05
    sel = (t > 0.2) & (t < 1.3) & (env > 0)
    return float(np.polyfit(t[sel], 20 * np.log10(env[sel]), 1)[0]) if sel.sum() >= 4 else None


def db(v):
    return float(20 * np.log10(v)) if v > 0 else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("preset"); ap.add_argument("label"); ap.add_argument("out_dir")
    ap.add_argument("--core", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "PianoidCore"))
    ap.add_argument("--n", type=int, required=True)
    ap.add_argument("--array-size", type=int, default=384)
    ap.add_argument("--deriv", type=int, default=1)
    ap.add_argument("--ltm", type=int, default=0)
    ap.add_argument("--exc-mult", type=float, default=None)
    ap.add_argument("--notes", default=None)
    a = ap.parse_args()
    notes = tuple(int(x) for x in a.notes.split(",")) if a.notes else NOTES
    a.out_dir, a.preset = os.path.abspath(a.out_dir), os.path.abspath(a.preset)
    mw = os.path.abspath(os.path.join(a.core, "pianoid_middleware"))
    sys.path.insert(0, mw)
    os.chdir(mw)
    from pianoid import initialize
    from auto_tuner import MeasurementEngine
    import pianoidCuda
    p = initialize(a.preset, filterlen=48 * 128 * 3, string_iteration=a.n, array_size=a.array_size,
                   sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, audio_on=False, audio_driver_type=0,
                   listen_to_modes=bool(a.ltm), sound_derivative_order=a.deriv)
    from excitation_coefficients import build_excitation_coefficients_flat
    flat = build_excitation_coefficients_flat(p.sm)
    if a.exc_mult is not None and flat:
        with p.cuda_lock:
            ok = p.pianoid.setNewExcitationCoefficients([v * a.exc_mult for v in flat])
        print("exc-mult upload", a.exc_mult, ok)
    fac = {}
    try:
        packed = p.sm.pack_excitation_coefficients()
        for n_ in notes:
            pm = p.sm.pitches[n_]
            fac[str(n_)] = {"coef6": [float(x) for x in packed[n_]],
                            "temporal_v110": float(pm.excitation.level_impulse(VEL)),
                            "excitation_length": int(p.mp.excitation_length())}
    except Exception as e:  # noqa
        fac["error"] = repr(e)
    me = MeasurementEngine()
    res = {"preset": a.preset, "N": a.n, "array_size": a.array_size, "deriv": a.deriv, "ltm": a.ltm,
           "exc_mult": a.exc_mult, "pyd": pianoidCuda.__file__,
           "mp_string_iteration": int(p.mp.string_iteration), "output_scale": float(getattr(p.mp, "output_scale", 1.0) or 1.0),
           "factors": fac, "notes": []}
    for pitch in notes:
        snd = render(p, pitch, VEL)
        fin = np.isfinite(snd)
        s = np.where(fin, snd, 0.0)
        x = s[0]
        head = s[:, : int(0.5 * SR)]
        ch_rms = np.sqrt(np.mean(head ** 2, axis=1))
        ch_peak = np.max(np.abs(s), axis=1)
        mm = me.measure_frequency(x[: SR], SR, 440.0 * 2 ** ((pitch - 69) / 12), search_semitones=2.0)
        r = {"pitch": pitch, "nonfinite": int((~fin).sum()),
             "peak_all": float(ch_peak.max()), "peak_db": db(float(ch_peak.max())),
             "rms_db_ch0": db(float(ch_rms[0])), "rms_db_max": db(float(ch_rms.max())),
             "ch_rms_db": [db(float(v)) for v in ch_rms],
             "decay_db_per_s": decay_db_per_s(x), "cents": float(mm.cents_error), "conf": float(mm.confidence)}
        res["notes"].append(r)
        print(json.dumps(r))
    od = os.path.join(a.out_dir, a.label)
    os.makedirs(od, exist_ok=True)
    with open(os.path.join(od, "results.json"), "w") as f:
        json.dump(res, f, indent=1)
    print("factors", json.dumps(fac))


if __name__ == "__main__":
    main()
