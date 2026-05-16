"""dev-cal-twice diagnostic — confirm whether SynthesisTuner.calibrate_synthesis
runs the per-pitch loop ONCE or TWICE, and WHY.

Uses the mocked CalibrationController harness from tests/unit/test_tune_pipeline.py
(no GPU, no mic). Instruments _synthesis_correct_once call count and the
clipping-readjustment branch.

Run:  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-cal-twice-loop-pass-probe.py
"""
import os
import sys

# Make the test harness importable
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(REPO, "PianoidCore"))
sys.path.insert(0, os.path.join(REPO, "PianoidCore", "pianoid_middleware"))
sys.path.insert(0, os.path.join(REPO, "PianoidCore", "tests", "unit"))

from test_tune_pipeline import _make_pipeline_controller  # noqa: E402


def probe(label, target_rms, gain_k=0.01, initial_amplitude=1.0,
          volume_coeff=1.0, n_pitches=5):
    """Run calibrate_synthesis and report loop-pass count + progress trace."""
    controller, model, state = _make_pipeline_controller(
        gain_k=gain_k, initial_amplitude=initial_amplitude, transfer_ratio=0.9)
    controller.pw.get_current_volume_coefficient = lambda: volume_coeff

    # Multi-pitch StringMap (reuse the single mock pitch object)
    pitches = [60 + 12 * i for i in range(n_pitches)]
    base = controller.pw.sm.pitches[60]
    controller.pw.sm.pitches = {p: base for p in pitches}
    controller.pw.sm.pitch_index = list(pitches)
    controller.pw.sm.sound_pitches = lambda: []

    def mock_synth_measure(pitch, velocity):
        synth_rms = model.gain_k * state["amplitude"]
        peak = synth_rms * 1e9 * 0.5
        return {"rms": synth_rms, "rms_db": -40.0, "peak": peak,
                "samples_rendered": 24000}

    controller._synthesis_only_measure = mock_synth_measure
    controller.synthesis_tuner._synthesis_only_measure = mock_synth_measure

    # Instrument _synthesis_correct_once on the SynthesisTuner
    st = controller.synthesis_tuner
    correct_calls = []
    real_correct = st._synthesis_correct_once

    def counting_correct(pitch, velocity, t_rms, level_idx):
        correct_calls.append((pitch, t_rms))
        return real_correct(pitch, velocity, t_rms, level_idx)

    st._synthesis_correct_once = counting_correct

    # Instrument progress emissions
    progress_trace = []
    real_emit = controller._emit_step_progress

    def trace_emit(step, frac, msg, current_pitch=None):
        progress_trace.append(round(frac, 3))
        return real_emit(step, frac, msg, current_pitch)

    controller._emit_step_progress = trace_emit
    st._emit_step_progress = trace_emit

    result = controller.calibrate_synthesis(
        pitches=pitches, velocity=95, target_rms=target_rms)

    passes = len(correct_calls) / len(pitches)
    print(f"\n=== {label} ===")
    print(f"  pitches               : {pitches}")
    print(f"  target_rms            : {target_rms}")
    print(f"  volume_coeff          : {volume_coeff}")
    print(f"  _synthesis_correct_once total calls : {len(correct_calls)}"
          f"  ({passes:.0f} full pass(es) over {len(pitches)} pitches)")
    print(f"  clipping_adjusted     : {result.get('clipping_adjusted')}")
    if result.get("clipping_adjusted"):
        print(f"  original_target_rms   : {result.get('original_target_rms')}")
        print(f"  reduced  target_rms   : {result.get('target_rms'):.4e}")
        print(f"  clipping_pitches      : {result.get('clipping_pitches')}")
    print(f"  progress trace        : {progress_trace}")
    # A progress trace that climbs to ~1.0 then DROPS = visible 'restart'
    drops = [i for i in range(1, len(progress_trace))
             if progress_trace[i] < progress_trace[i - 1] - 0.1]
    if drops:
        print(f"  >>> PROGRESS RESETS at trace idx {drops} "
              f"-- user sees this as 'starts all over' <<<")
    return result, correct_calls


if __name__ == "__main__":
    print("dev-cal-twice :: SynthesisTuner.calibrate_synthesis loop-pass probe")
    print("=" * 68)

    # Scenario A: normal target, no clipping -> expect ONE pass
    probe("A. Normal target (no clipping expected)",
          target_rms=0.02, gain_k=0.01, initial_amplitude=1.0,
          volume_coeff=1.0)

    # Scenario B: target so high every pitch clips -> clipping rerun
    probe("B. High target -> clipping rerun (full second pass)",
          target_rms=5.0, gain_k=0.01, initial_amplitude=1.0,
          volume_coeff=1.0)

    # Scenario C: moderate target, but high volume_coeff pushes est_peak
    # over threshold even though applied correction is modest
    probe("C. Moderate correction + high volume_coeff",
          target_rms=0.05, gain_k=0.01, initial_amplitude=1.0,
          volume_coeff=40.0)

    print("\n" + "=" * 68)
    print("INTERPRETATION:")
    print("  - Exactly 1 pass + clipping_adjusted=False  => single pass, OK")
    print("  - 2 passes + clipping_adjusted=True         => clipping-rerun")
    print("    branch fired; the per-pitch loop ran a 2nd time. The progress")
    print("    bar resets 0->1 again => user perceives 'starts all over'.")
