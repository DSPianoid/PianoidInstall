"""analyse-voleq (2026-10-04) -- automatic volume-equalization review probe. OFFLINE, own process.

NOT the live surface: audio off, no ASIO, no realtime thread; never touches the running backend.
One preset + one load config per process (never two Pianoid instances in one process).

    PianoidCore/.venv/Scripts/python docs/development/diagnostics/analyse-voleq-probe.py \
        PRESET.json ARRAY_SIZE STRING_ITERATION DERIV LISTEN_TO_MODES MODE

MODE:
  level   -- only the load-time calibration (bare p60 v127 peak + output_scale)
  full    -- level + per-pitch keyboard sweep + velocity sweep + chords + per-channel balance
             + the mic/synthesis-equalizer write-path test (levels_matrix[:,2,:] scaling)

All levels are reported in dBFS of the INT32 rail at init-volume 100 / slider 64 (main volume
coefficient = output_scale x 1.0), i.e. exactly the point calibrate_output_scale targets (-2 dBFS).
"""
import json
import math
import os
import sys

import numpy as np

SR, SPC = 48000, 64
INT32 = 2147483647.0


def render(p, notes, hold_ms=1000, total_ms=2000):
    """notes: list of (pitch, velocity), all struck at cycle 0. Returns (channels, samples) float."""
    import pianoidCuda
    from PanoidResult import PianoidResult
    eq = pianoidCuda.EventQueue()
    off = int(hold_ms / 1000 * SR / SPC)
    for pitch, vel in notes:
        for cyc, typ, v in ((0, pianoidCuda.EventType.NOTE_ON, vel), (off, pianoidCuda.EventType.NOTE_OFF, 0)):
            ev = pianoidCuda.PlaybackEvent()
            ev.channel, ev.cycle_index, ev.type, ev.data = 0, cyc, typ, (pitch << 8) | v
            eq.addEvent(ev)
    eq.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled, cfg.record_to_buffer = False, True
    cfg.sample_rate, cfg.samples_per_cycle, cfg.max_duration_ms = SR, SPC, total_ms
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


def dbfs(x, scale):
    x = abs(float(x)) * scale
    return round(20 * math.log10(x / INT32), 2) if x > 0 else None


def stats(snd, scale):
    fin = np.where(np.isfinite(snd), snd, 0.0)
    pk = np.max(np.abs(fin), axis=1)
    rms = np.sqrt(np.mean(fin ** 2, axis=1))
    return {"peak_dbfs_per_ch": [dbfs(v, scale) for v in pk],
            "rms_dbfs_per_ch": [dbfs(v, scale) for v in rms],
            "peak_dbfs_max": dbfs(pk.max(), scale),
            "nonfinite": int((~np.isfinite(snd)).sum())}


def main():
    preset, array_size, si, deriv, ltm, mode = (sys.argv[1], int(sys.argv[2]), int(sys.argv[3]),
                                                 int(sys.argv[4]), bool(int(sys.argv[5])), sys.argv[6])
    preset = os.path.abspath(preset)
    mw = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "PianoidCore", "pianoid_middleware"))
    sys.path.insert(0, mw)
    os.chdir(mw)
    from pianoid import initialize
    p = initialize(preset, filterlen=48 * 128 * 3, string_iteration=si, array_size=array_size, sample_rate=SR,
                   samples_in_cycle=SPC, buffer_size=4, audio_on=False, audio_driver_type=0, listen_to_modes=ltm,
                   sound_derivative_order=deriv, use_debug_build=False)
    scale = float(p.mp.output_scale)  # x center 1.0 (init-volume 100, slider 64)
    out = {"preset": os.path.basename(preset), "array_size": array_size, "string_iteration": si, "deriv": deriv,
           "listen_to_modes": ltm, "num_channels": int(p.mp.num_channels), "output_scale": scale}
    ref = render(p, [(60, 127)], hold_ms=2000, total_ms=5000)  # == _measure_bare_synthesis_peak window
    out["bare_p60v127_peak"] = float(np.max(np.abs(ref[np.isfinite(ref)])))
    out["p60v127"] = stats(ref, scale)
    if mode == "full":
        keys = sorted(p.sm.keyPitches)
        lo, hi = min(keys), max(keys)
        sweep = list(range(lo, hi + 1, 3))
        out["keyboard_v127"] = {str(k): stats(render(p, [(k, 127)]), scale) for k in sweep}
        out["velocity_p60"] = {str(v): stats(render(p, [(60, v)]), scale) for v in (8, 16, 32, 48, 64, 80, 96, 112, 127)}
        chords = {"33-45-60-72": [33, 45, 60, 72], "60-64-67-72": [60, 64, 67, 72],
                  "48-52-55-60-64-67-72-76": [48, 52, 55, 60, 64, 67, 72, 76]}
        out["chords_v127"] = {n: stats(render(p, [(k, 127) for k in c if lo <= k <= hi]), scale)
                              for n, c in chords.items()}
        # Mic/synthesis equalizer write path (calibration_controller._apply_single_correction +
        # _upload_excitations): scale levels_matrix[127,2,:] of p60 x2, upload base levels ONLY.
        exc = p.sm.pitches[60].excitation
        before = render(p, [(60, 127)])
        exc.levels_matrix[127, 2, :] *= 2.0
        with p.cuda_lock:
            p.pianoid.waitForParameterUpdate()
            p.pianoid.setNewExcitationBaseLevels(p.sm.pack_base_excitations())
            p.pianoid.waitForParameterUpdate()
        after_upload = render(p, [(60, 127)])
        # Then the full coefficient rebuild every preset load / save->load performs.
        with p.cuda_lock:
            p._upload_excitation_coefficients()
            p.pianoid.waitForParameterUpdate()
        after_recompose = render(p, [(60, 127)])
        pk = lambda s: float(np.max(np.abs(s[np.isfinite(s)])))
        out["equalizer_x2_test"] = {
            "before_peak": pk(before), "after_base_level_upload": pk(after_upload),
            "after_coefficient_recompose": pk(after_recompose),
            "gain_in_session_db": round(20 * math.log10(pk(after_upload) / pk(before)), 2),
            "gain_after_reload_db": round(20 * math.log10(pk(after_recompose) / pk(before)), 2)}
    print("RESULT " + json.dumps(out))


if __name__ == "__main__":
    main()
