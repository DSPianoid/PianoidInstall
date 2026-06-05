"""dev-d52b RUNAWAY DIAGNOSIS — is the coeff=0 explosion bounded-but-loud or unstable?

User decision (Option A): lower feedback = louder is CORRECT and intended. BUT the
coeff=0 explosion (peak 42, ~1000x) must be a BUG if it is unbounded — the control
should get louder smoothly yet stay BOUNDED/STABLE across the whole range incl. 0.

This probe MEASURES (does not assume) the mechanism:
  - Render a LONG note (longer than the verify probe) at coeff 1.0/0.5/0.1/0.01/0.0.
  - Slice the recorded audio into time windows and report per-window RMS + peak, so we
    can see whether the signal PLATEAUS (bounded, just loud) or GROWS monotonically to
    the end of the render (divergent / unstable).
  - Also track max |mode displacement| at end-of-render per coeff.

Interpretation:
  * If late-window RMS <= early-window RMS (signal decays after the hammer, like a real
    note) at every coeff incl. 0 -> BOUNDED. The loudness is real physics (less soundboard
    coupling = less damping = louder/longer ring), NOT a runaway. Report to team-lead;
    do NOT clamp without sign-off.
  * If late-window RMS >> early-window RMS and keeps climbing to the final window at low
    coeff -> DIVERGENT / unstable -> genuine BUG; a damping floor / clamp is justified.

Read-only: no source edits. Writes a JSON summary at repo root.
"""
import os
import sys
import json
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
TEST_PITCH = 57
VELOCITY = 100
DURATION_MS = 800           # long enough to see decay-vs-grow after the 100ms note
NOTE_MS = 100
N_WINDOWS = 8               # slice the render into 8 equal time windows
COEFFS = [1.0, 0.5, 0.1, 0.01, 0.0]


def render(cpp, mp, coeff):
    sr = mp.sample_rate()
    spc = mp.mode_iteration

    rt = pianoidCuda.RuntimeParameters()
    rt.volume_level = 64
    rt.deck_feedback_coefficient = coeff
    cpp.setRuntimeParameters(rt)
    cpp.resetStringsState()
    cpp.resetModeRunningState()
    cpp.waitForParameterUpdate()

    eq = build_note_event_queue(TEST_PITCH, VELOCITY, NOTE_MS, sr, spc)
    config = pianoidCuda.PlaybackConfig()
    config.audio_enabled = False
    config.record_to_buffer = True
    config.sample_rate = sr
    config.samples_per_cycle = spc
    config.max_duration_ms = DURATION_MS
    cpp.clearRecords()
    cpp.runOfflinePlayback(eq, config)

    audio = np.array(cpp.getRecordedAudio(), dtype=np.float64)
    mode_raw = np.array(cpp.getModeDisplacements())
    mode_q = mode_raw[: mp.num_modes_for_model]
    max_mode = float(np.max(np.abs(mode_q))) if len(mode_q) else 0.0

    # per-window rms/peak
    win = []
    if len(audio) >= N_WINDOWS:
        chunks = np.array_split(audio, N_WINDOWS)
        for c in chunks:
            win.append({
                "rms": float(np.sqrt(np.mean(c ** 2))),
                "peak": float(np.max(np.abs(c))),
            })
    total_rms = float(np.sqrt(np.mean(audio ** 2))) if len(audio) else 0.0
    total_peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
    return {
        "total_rms": total_rms,
        "total_peak": total_peak,
        "max_mode_disp_end": max_mode,
        "n_samples": int(len(audio)),
        "windows": win,
    }


def main():
    from pianoid import initialize
    p = initialize(
        get_preset_path(PRESET),
        filterlen=48 * 128 * 3,
        string_iteration=4,
        array_size=384,
        sample_rate=SAMPLE_RATE,
        samples_in_cycle=SAMPLES_PER_CYCLE,
        buffer_size=4,
        max_volume=5e18,
        audio_on=False,
        audio_driver_type=0,
        listen_to_modes=False,
    )
    cpp = p.pianoid
    mp = p.mp
    cpp.waitForParameterUpdate()

    render(cpp, mp, 1.0)  # warm

    results = {}
    verdict = {}
    for coeff in COEFFS:
        r = render(cpp, mp, coeff)
        results[f"{coeff}"] = r
        w = r["windows"]
        if w:
            early = w[0]["rms"]
            late = w[-1]["rms"]
            peak_late = w[-1]["peak"]
            # divergent if the LAST window is still substantially louder than the first
            # (a real note decays: late should be < early once the hammer is gone)
            verdict[f"{coeff}"] = {
                "early_win_rms": early,
                "late_win_rms": late,
                "late_over_early": (late / early) if early else None,
                "late_win_peak": peak_late,
                "decays": bool(late < early),     # True = bounded/decaying note
            }

    out = {
        "preset": PRESET,
        "pitch": TEST_PITCH,
        "note_ms": NOTE_MS,
        "render_ms": DURATION_MS,
        "n_windows": N_WINDOWS,
        "results": results,
        "verdict": verdict,
    }
    with open(os.path.join(REPO, "dev-d52b-runaway-diagnosis.json"), "w") as f:
        json.dump(out, f, indent=2)
    # compact stdout
    print("RUNAWAY_DIAGNOSIS:")
    for coeff in COEFFS:
        r = results[f"{coeff}"]
        v = verdict.get(f"{coeff}", {})
        wl = " ".join(f"{x['rms']:.3g}" for x in r["windows"])
        print(f"  coeff={coeff}: total_rms={r['total_rms']:.4g} total_peak={r['total_peak']:.4g} "
              f"mode_end={r['max_mode_disp_end']:.4g} decays={v.get('decays')} "
              f"late/early={v.get('late_over_early')}")
        print(f"      win_rms=[{wl}]")

    try:
        cpp.shutdownGpu()
    except Exception:
        pass


if __name__ == "__main__":
    main()
