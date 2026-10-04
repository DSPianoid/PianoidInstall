"""dev-17fd -- probe one preset at one load config, OFFLINE, in its own process (audio off).

NOT the live surface: no ASIO, no realtime thread. Measures what the engine does with the load
config itself (layout, Sound Channels row length, level, stability, ms/cycle vs the 1.333 ms budget).

    PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-17fd-f15-config-probe.py \
        PRESET.json ARRAY_SIZE STRING_ITERATION DERIV_ORDER DEBUG(0|1)

One preset per process (never two Pianoid instances in one process; never the live backend).
"""
import json
import os
import sys
import time

import numpy as np

SR, SPC = 48000, 64
HOLD_MS, RENDER_MS = 1400, 3000


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
        cpp.resetStringsState()
        cpp.runSynthesisKernel()
        cpp.clearRecords()
        t0 = time.perf_counter()
        stats = cpp.runOfflinePlayback(eq, cfg)
        elapsed = time.perf_counter() - t0
        if not stats.completed_successfully:
            raise RuntimeError(stats.error_message)
        res = PianoidResult(cpp, p.mp)
        res.load_offline_sound_from_pianoid()
    cycles = RENDER_MS / 1000 * SR / SPC
    return np.asarray(res.sound, dtype=np.float64), elapsed * 1000 / cycles


def main():
    preset, array_size, si, deriv, debug = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), bool(int(sys.argv[5]))
    preset = os.path.abspath(preset)
    mw = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "PianoidCore", "pianoid_middleware"))
    sys.path.insert(0, mw)
    os.chdir(mw)
    from pianoid import initialize
    p = initialize(preset, filterlen=48 * 128 * 3, string_iteration=si, array_size=array_size, sample_rate=SR,
                   samples_in_cycle=SPC, buffer_size=4, audio_on=False, audio_driver_type=0, listen_to_modes=False,
                   sound_derivative_order=deriv, use_debug_build=debug)
    out = {"preset": os.path.basename(preset), "array_size": array_size, "string_iteration": si, "deriv": deriv,
           "debug": debug, "num_modes": p.mp.num_modes, "num_strings": p.mp.num_strings,
           "output_scale": float(p.mp.output_scale), "output_scale_calibrated": bool(p.mp.output_scale_calibrated)}
    # Sound Channels strings-axis row (what GET /get_parameter/feedback/output returns)
    outs = p.get_all_pitches_in_preset(sound_pitches=True)
    params, status = p.pack_for_interface("feedback", pitches=outs, modes=list(range(p.mp.num_modes)))
    out["sc_feedback_row_len"] = {str(k): len(v) for k, v in params.items() if isinstance(v, (list, tuple))}
    out["notes"] = []
    for pitch, vel in ((33, 127), (60, 127), (96, 127)):
        snd, ms = render(p, pitch, vel)
        x = snd[0]
        fin = np.isfinite(snd)
        seg = [float(np.max(np.abs(np.where(np.isfinite(x[i:i + SR // 2]), x[i:i + SR // 2], 0))))
               for i in range(0, x.size - SR // 2 + 1, SR // 2)]
        out["notes"].append({"pitch": pitch, "vel": vel, "nonfinite": int((~fin).sum()),
                             "peak": float(np.max(np.abs(snd[fin]))) if fin.any() else None,
                             "peak_per_500ms": seg, "ms_per_cycle": ms})
    print("RESULT " + json.dumps(out))


if __name__ == "__main__":
    main()
