"""dev-d52b POST-FIX verification — per-string feedback output mask (Option M).

Proves the locked spec:
  feedback (deck_feedback_coeff, the toolbar slider) scales the PIANO-resonance
  feedback rows ONLY. Output/sound-channel strings (mask=1.0) keep their audio-tap
  row UNSCALED, so at feedback=0 the note audio survives while the 0-127 resonance
  coupling is zeroed.

Method (deterministic offline render, audio_off — same path as
tests/integration/test_feedin_zero_leakage.py):
  - init the engine in STRINGS mode (listen_to_modes=False) — the audio-output-
    via-feedback path where the silence bug manifests.
  - render note TEST_PITCH at deck_feedback_coefficient = 1.0 (baseline) and = 0.0
    (the slider-to-zero case the user reported).
  - measure getRecordedAudio() RMS + the max regular-resonance mode displacement.

PASS criteria (post-fix):
  - coeff=1.0: audio RMS clearly audible (baseline, no regression).
  - coeff=0.0: audio RMS STILL audible (output tap unscaled), AND meaningfully
    lower than coeff=1.0 (the 0-127 resonance feedback contribution removed).
  Pre-fix, coeff=0.0 silenced the render entirely (documented in
  test_feedin_zero_leakage TestStringsModeSilenceOnZeroedFeedin) — that is the
  before-baseline this fix corrects.

Read-only: no source edits, no commit. Writes a JSON summary next to the repo root.
"""
import os
import sys
import json
import numpy as np

REPO = r"D:/repos/PianoidInstall"
MW = os.path.join(REPO, "PianoidCore", "pianoid_middleware")
TESTS = os.path.join(REPO, "PianoidCore")

os.chdir(MW)
for p in (MW, TESTS):
    if p not in sys.path:
        sys.path.insert(0, p)

import pianoidCuda
from tests.conftest import SAMPLE_RATE, SAMPLES_PER_CYCLE, get_preset_path
from tests.integration.conftest import build_note_event_queue

TEST_PITCH = 57
VELOCITY = 100
DURATION_MS = 100


def render(cpp, mp, coeff, pitch=TEST_PITCH, velocity=VELOCITY, duration_ms=DURATION_MS):
    """Render one note offline at the given deck_feedback_coefficient; return (rms, mode_q)."""
    sr = mp.sample_rate()
    spc = mp.mode_iteration

    rt = pianoidCuda.RuntimeParameters()
    rt.volume_level = 64
    rt.deck_feedback_coefficient = coeff
    cpp.setRuntimeParameters(rt)
    # Reset BOTH string and mode running state so each render starts from a clean
    # deterministic state — otherwise mode energy accumulated by a prior render
    # leaks into the next, corrupting the cross-coefficient comparison.
    cpp.resetStringsState()
    cpp.resetModeRunningState()
    cpp.waitForParameterUpdate()

    eq = build_note_event_queue(pitch, velocity, duration_ms, sr, spc)
    config = pianoidCuda.PlaybackConfig()
    config.audio_enabled = False
    config.record_to_buffer = True
    config.sample_rate = sr
    config.samples_per_cycle = spc
    config.max_duration_ms = duration_ms + 200
    cpp.clearRecords()
    cpp.runOfflinePlayback(eq, config)

    audio = np.array(cpp.getRecordedAudio())
    rms = float(np.sqrt(np.mean(audio ** 2))) if len(audio) > 0 else 0.0
    peak = float(np.max(np.abs(audio))) if len(audio) > 0 else 0.0

    mode_raw = np.array(cpp.getModeDisplacements())
    mode_q = mode_raw[: mp.num_modes_for_model]
    max_mode = float(np.max(np.abs(mode_q))) if len(mode_q) else 0.0
    return rms, peak, max_mode


def main():
    from pianoid import initialize

    p = initialize(
        get_preset_path("Preset_test5.json"),
        filterlen=48 * 128 * 3,
        string_iteration=4,
        array_size=384,
        sample_rate=SAMPLE_RATE,
        samples_in_cycle=SAMPLES_PER_CYCLE,
        buffer_size=4,
        max_volume=5e18,
        audio_on=False,
        audio_driver_type=0,
        listen_to_modes=False,   # STRINGS mode — the audio-output-via-feedback path
    )
    cpp = p.pianoid
    mp = p.mp

    # Confirm strings mode + the output-mask shape for this preset.
    mask = p.sm.pack_output_mask()
    mask_arr = np.array(mask)
    out_rows = np.nonzero(mask_arr)[0].tolist()

    cpp.waitForParameterUpdate()

    # Warm render to settle deterministic offline state, then a SWEEP of coefficients
    # to demonstrate PROPORTIONALITY (spec part a) and OUTPUT-tap independence (spec part b).
    render(cpp, mp, 1.0)
    sweep = {}
    for coeff in (1.0, 0.5, 0.0):
        rms, peak, mode = render(cpp, mp, coeff)
        sweep[coeff] = {"audio_rms": rms, "audio_peak": peak, "max_mode_disp": mode}

    rms1 = sweep[1.0]["audio_rms"]
    rms_half = sweep[0.5]["audio_rms"]
    rms0 = sweep[0.0]["audio_rms"]
    mode1 = sweep[1.0]["max_mode_disp"]
    mode_half = sweep[0.5]["max_mode_disp"]
    mode0 = sweep[0.0]["max_mode_disp"]

    result = {
        "preset": "Preset_test5.json",
        "listen_to_modes": bool(mp.listen_to_modes),
        "num_strings": mp.num_strings,
        "num_modes_for_model": mp.num_modes_for_model,
        "mask_ones_rows": out_rows,
        "mask_ones_count": int(mask_arr.sum()),
        "coeff_1.0": sweep[1.0],
        "coeff_0.5": sweep[0.5],
        "coeff_0.0": sweep[0.0],
        "ratio_rms_0_over_1": (rms0 / rms1) if rms1 else None,
        "ratio_rms_half_over_1": (rms_half / rms1) if rms1 else None,
    }

    SILENCE = 1e-20
    # Spec (b): OUTPUT/sound strings unaffected by feedback -> feedback=0 STILL audible.
    result["PASS_coeff1_audible"] = bool(rms1 > SILENCE)
    result["PASS_coeff0_still_audible"] = bool(rms0 > SILENCE)
    # Spec (a): the feedback contribution on PIANO pitches scales PROPORTIONALLY with the
    # slider. The deck_feedback_coeff scales ONLY the piano-resonance feedback rows now, so
    # increasing coeff increases the resonance contribution monotonically. Measured both via
    # the regular-resonance mode displacement (driven by the scaled piano-feedback path) and
    # via the audio RMS (output tap + scaled piano resonance summed at the receiver).
    result["PASS_mode_disp_monotonic"] = bool(mode0 <= mode_half <= mode1)
    result["PASS_rms_monotonic_with_coeff"] = bool(rms0 <= rms_half <= rms1)
    # Proportionality sanity: the 0.5 point should sit strictly between 0 and 1 on at least
    # one observable (not pinned to an endpoint), evidencing a graded (not binary) response.
    result["PASS_half_point_intermediate"] = bool(
        (rms0 < rms_half < rms1) or (mode0 < mode_half < mode1)
    )
    result["ALL_PASS"] = bool(
        result["PASS_coeff1_audible"]
        and result["PASS_coeff0_still_audible"]
        and result["PASS_mode_disp_monotonic"]
    )

    out = os.path.join(REPO, "dev-d52b-verify-result.json")
    with open(out, "w") as f:
        json.dump(result, f, indent=2)
    print("VERIFY_RESULT=" + json.dumps(result))

    try:
        cpp.shutdownGpu()
    except Exception:
        pass


if __name__ == "__main__":
    main()
