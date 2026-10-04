"""dev-168c: is the offline single-note measurement history-dependent (reset leaves state)?

Own process, offline. Measures pitch A, then B, then A again; then renders SILENCE_MS of silence and
measures A again. Reports dB (SynthesisTuner._synthesis_only_measure, v95).

    python dev-168c-history-probe.py MIDDLEWARE_DIR PRESET ARRAY SI DERIV LTM A B SILENCE_MS
"""
import math
import os
import sys


def main():
    mw, preset, a, si, d, ltm, pa, pb, sil = sys.argv[1:10]
    preset = os.path.abspath(preset)
    sys.path.insert(0, os.path.abspath(mw)); os.chdir(os.path.abspath(mw))
    import pianoidCuda
    from pianoid import initialize
    from calibration_controller import CalibrationController
    p = initialize(preset, filterlen=48 * 128 * 3, string_iteration=int(si), array_size=int(a), sample_rate=48000,
                   samples_in_cycle=64, buffer_size=4, audio_on=False, audio_driver_type=0,
                   listen_to_modes=bool(int(ltm)), sound_derivative_order=int(d), use_debug_build=False)
    cc = CalibrationController(p)
    m = lambda k: round(20 * math.log10(cc._synthesis_only_measure(int(k), 95)['rms']), 3)
    seq = [("A", m(pa)), ("B", m(pb)), ("A again", m(pa)), ("A again 2", m(pa))]
    eq = pianoidCuda.EventQueue()
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled, cfg.record_to_buffer = False, True
    cfg.sample_rate, cfg.samples_per_cycle, cfg.max_duration_ms = 48000, 64, int(sil)
    with p.cuda_lock:
        p.pianoid.resetStringsState(); p.pianoid.runSynthesisKernel(); p.pianoid.clearRecords()
        p.pianoid.runOfflinePlayback(eq, cfg)
    seq.append((f"A after {sil} ms silence", m(pa)))
    print("RESULT", seq)


if __name__ == "__main__":
    main()
