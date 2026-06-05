"""dev-d52b FULL-SCALE measurement — find M, the real digital clip point in output-amplitude units.

Limiter redesign (user): anchor the soft-knee to the REAL int32/driver full-scale, NOT arbitrary
internal units. The driver consumes dev_soundInt = Sint32(output * main_volume_coefficient)
(Pianoid_synthesis.cu pushes dev_soundInt; ASIOAudioDriver clamps at ±INT32). So the float `output`
hard-clips when |output * mvc| >= INT32_MAX, i.e.

    M  =  INT32_MAX / mvc          (output-amplitude units at which the int path rails)

This probe MEASURES mvc directly (no formula assumption) as the ratio soundInt/soundFloat sample-by-
sample (both are host-readable: getRawSoundRecord = float `output`, getRawSoundRecordInt = the post-volume
Sint32), then reports M, 0.8*M, and where the known feedback peaks (nominal 1.30, low-feedback up to 19.5)
land relative to M and 0.8*M. Production-default config (matches backendServer init).

Read-only. No source edits. Writes JSON at repo root.
"""
import os, sys, json
import numpy as np

REPO = r"D:/repos/PianoidInstall"
MW = os.path.join(REPO, "PianoidCore", "pianoid_middleware")
os.chdir(MW)
for p in (MW, os.path.dirname(MW)):
    if p not in sys.path:
        sys.path.insert(0, p)

import pianoidCuda
from tests.conftest import SAMPLE_RATE, SAMPLES_PER_CYCLE, get_preset_path
from tests.integration.conftest import build_note_event_queue

PRESET = "Belarus_8band_196modes.json"
INT32_MAX = 2147483647.0


def main():
    from pianoid import initialize
    # Production-default init (matches backendServer.py defaults: max_volume 5e18, vol 64).
    p = initialize(get_preset_path(PRESET), filterlen=48 * 128 * 3, string_iteration=4,
                   array_size=384, sample_rate=SAMPLE_RATE, samples_in_cycle=SAMPLES_PER_CYCLE,
                   buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0,
                   listen_to_modes=False)
    cpp = p.pianoid; mp = p.mp
    cpp.waitForParameterUpdate()

    # Render a normal note at default feedback (coeff=1.0, vol 64) and read BOTH the float `output`
    # record and the post-volume Sint32 record; mvc = soundInt / soundFloat where soundFloat != 0.
    rt = pianoidCuda.RuntimeParameters(); rt.volume_level = 64; rt.deck_feedback_coefficient = 1.0
    cpp.setRuntimeParameters(rt)
    cpp.resetStringsState(); cpp.resetModeRunningState()
    try:
        cpp.resetLimiterPeaks()
    except Exception:
        pass
    cpp.waitForParameterUpdate()
    eq = build_note_event_queue(57, 100, 100, mp.sample_rate(), mp.mode_iteration)
    c = pianoidCuda.PlaybackConfig()
    c.audio_enabled = False; c.record_to_buffer = True
    c.sample_rate = mp.sample_rate(); c.samples_per_cycle = mp.mode_iteration; c.max_duration_ms = 300
    cpp.clearRecords(); cpp.runOfflinePlayback(eq, c)

    flt = np.array(cpp.getRawSoundRecord(), dtype=np.float64)
    sint = np.array(cpp.getRawSoundRecordInt(), dtype=np.float64)
    n = min(len(flt), len(sint))
    flt, sint = flt[:n], sint[:n]
    # ratio only where float is non-trivial (avoid 0/0 and uninitialised tail)
    mask = np.abs(flt) > 1e-6
    ratios = sint[mask] / flt[mask]
    ratios = ratios[np.isfinite(ratios)]
    mvc = float(np.median(np.abs(ratios))) if len(ratios) else float("nan")
    mvc_std = float(np.std(np.abs(ratios))) if len(ratios) else float("nan")

    M = INT32_MAX / mvc if mvc and np.isfinite(mvc) else float("nan")
    knee = 0.8 * M

    # Where do the known feedback-sweep float-output peaks land? (from dev-d52b-headroom-design)
    known_peaks = {"coeff_1.0_nominal": 1.303, "coeff_0.5": 1.957, "coeff_0.25": 3.976,
                   "coeff_0.1": 11.016, "coeff_0.0": 19.538}
    placement = {k: {"peak": v, "frac_of_M": v / M, "above_knee_0.8M": v > knee,
                     "above_M_clips": v > M} for k, v in known_peaks.items()}

    result = {
        "preset": PRESET, "volume_level": 64, "max_volume": 5e18,
        "INT32_MAX": INT32_MAX,
        "measured_mvc_median": mvc, "measured_mvc_std": mvc_std, "n_ratio_samples": int(len(ratios)),
        "M_fullscale_output_units": M,
        "knee_0.8M": knee,
        "placement": placement,
        "note": "M = INT32_MAX / mvc; driver consumes dev_soundInt = Sint32(output*mvc); clip at |output|>=M",
    }
    with open(os.path.join(REPO, "dev-d52b-fullscale-measure.json"), "w") as f:
        json.dump(result, f, indent=2)
    print("FULLSCALE: mvc=%.6g (std %.3g, n=%d)  M=%.4g  0.8M=%.4g" % (mvc, mvc_std, len(ratios), M, knee))
    for k, v in placement.items():
        print("  %-22s peak=%.3f  = %.1f%% of M   above_0.8M=%s  clips(>M)=%s"
              % (k, v["peak"], 100 * v["frac_of_M"], v["above_knee_0.8M"], v["above_M_clips"]))
    try:
        cpp.shutdownGpu()
    except Exception:
        pass


if __name__ == "__main__":
    main()
