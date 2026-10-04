"""dev-da62 (2026-10-04) -- measure the excitation-curve TIME AXIS against the engine. OFFLINE, own process.

NOT the live surface: audio off, no ASIO, no realtime thread; never touches the running backend.
One preset + one load config per process (never two Pianoid instances in one process).

    PianoidCore/.venv/Scripts/python dev-da62-xunit-probe.py MIDDLEWARE_DIR PRESET.json ARRAY SI PITCH VEL OUT.json

Plays one note, then reads the GPU force function back (pianoid.fetchExcitation, one segment per
cycleIndex 0..7) for every string whose force is non-zero (a fresh process: only PITCH's strings were
excited). Reports: segment length (sub-steps), dt, the duration of one x-unit (= segment length * dt),
the peak position and the equivalent width (area/peak) of the GPU curve in x-units and in ms, and the
same numbers from the Python GPU-formula curve (temporal_curve_impulse grid) for comparison.
"""
import json
import os
import sys

import numpy as np

SR, SPC = 48000, 64


def main():
    mw, preset, array_size, si, pitch, vel, out = sys.argv[1:8]
    array_size, si, pitch, vel = int(array_size), int(si), int(pitch), int(vel)
    preset = os.path.abspath(preset)
    sys.path.insert(0, os.path.abspath(mw))
    os.chdir(mw)
    d = json.load(open(preset))
    d["model_parameters"]["output_scale_calibrated"] = True     # no load-time render
    tmp = os.path.join(os.environ.get("TEMP", "."), "dev-da62-xunit-preset.json")
    json.dump(d, open(tmp, "w"))
    from pianoid import initialize
    import pianoidCuda
    p = initialize(tmp, filterlen=48 * 128 * 3, string_iteration=si, array_size=array_size, sample_rate=SR,
                   samples_in_cycle=SPC, buffer_size=4, audio_on=False, audio_driver_type=0,
                   listen_to_modes=True, sound_derivative_order=1, use_debug_build=False)
    eq = pianoidCuda.EventQueue()
    ev = pianoidCuda.PlaybackEvent()
    ev.channel, ev.cycle_index, ev.type, ev.data = 0, 0, pianoidCuda.EventType.NOTE_ON, (pitch << 8) | vel
    eq.addEvent(ev)
    eq.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled, cfg.record_to_buffer = False, True
    cfg.sample_rate, cfg.samples_per_cycle, cfg.max_duration_ms = SR, SPC, 50
    cpp = p.pianoid
    with p.cuda_lock:
        cpp.waitForParameterUpdate()
        cpp.resetStringsState()
        cpp.runSynthesisKernel()
        cpp.clearRecords()
        stats = cpp.runOfflinePlayback(eq, cfg)
        assert stats.completed_successfully, stats.error_message
        strings = {}
        for s in range(len(p.sm.string_index)):
            segs = [np.asarray(cpp.fetchExcitation(s, c), dtype=np.float64) for c in range(p.mp.excitation_factor)]
            f = np.concatenate(segs)
            if np.abs(f).max() > 0:
                strings[s] = f
    mp = p.mp
    seg_len = int(len(segs[0]))
    dt = float(mp.dt())
    x_unit_ms = seg_len * dt * 1e3
    lm = p.sm.pitches[pitch].excitation.levels_matrix[vel]
    length = mp.excitation_length()
    k = np.arange(length, dtype=np.float64)
    x = k * (mp.excitation_factor / length)
    z = (x[:, None] - lm[0][None, :]) / lm[1][None, :]
    fpy = (np.maximum(np.exp(-0.5 * z * z) - lm[3][None, :], 0.0) * lm[2][None, :]).sum(axis=1)

    def stats_of(f):
        a = np.abs(f)
        ipk = int(a.argmax())
        return {"peak_x": ipk / seg_len, "peak_ms": ipk * dt * 1e3,
                "eqw_x": float(a.sum() / a.max() / seg_len), "eqw_ms": float(a.sum() / a.max() * dt * 1e3),
                "last_nonzero_x": float(np.nonzero(a > 1e-6 * a.max())[0].max() / seg_len)}

    res = {"preset": os.path.basename(preset), "pitch": pitch, "vel": vel,
           "mode_iteration": int(mp.mode_iteration), "string_iteration": int(mp.string_iteration),
           "sr": int(mp.sr), "segment_len_substeps": seg_len, "dt_s": dt, "x_unit_ms": x_unit_ms,
           "x_unit_ms_from_mp": 1e3 * mp.mode_iteration / mp.sr,
           "python_curve": stats_of(fpy), "levels_row": np.asarray(lm).tolist(),
           "gpu_strings": {}}
    for s, f in strings.items():
        st = stats_of(f)
        # shape agreement with the Python GPU formula (normalised curves)
        g = np.abs(f) / np.abs(f).max()
        h = np.abs(fpy) / np.abs(fpy).max()
        st["shape_max_abs_dev"] = float(np.abs(g - h).max())
        res["gpu_strings"][str(s)] = st
    json.dump(res, open(out, "w"), indent=1)
    print(json.dumps({k: v for k, v in res.items() if k != "levels_row"}, indent=1))


if __name__ == "__main__":
    main()
