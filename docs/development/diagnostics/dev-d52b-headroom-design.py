"""dev-d52b HEADROOM DESIGN probe — measure the |output| distribution per feedback
coeff so the soft-limiter threshold/ceiling can be chosen from data, not guessed.

Option 1 (user): keep louder-with-lower but bound the peak <= ~1.0, preferring a
soft-limiter that leaves the note BODY (and the coeff=1 nominal) untouched and only
compresses the loud ATTACK transient.

For each coeff we report on the RAW float output (getRecordedAudio = soundFloat = raw
`output = feedback - s_b`, pre-volume):
  - peak (max |x|)
  - percentiles of |x| (50/90/99/99.9) — shows where the bulk of the signal sits vs the
    rare attack spikes
  - fraction of samples with |x| > 1.0 (how much would a >1.0 threshold even touch)
  - RMS

This tells us: (i) the coeff=1 nominal peak (so the soft-knee threshold sits at/above it
=> baseline untouched), and (ii) that the explosion is a tiny fraction of high-amplitude
attack samples (so a soft limiter preserves the body / louder-with-lower while taming peaks).

Read-only. No source edits. Writes JSON at repo root.
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
PITCH = 57
VEL = 100
NOTE_MS = 100
RENDER_MS = 400
COEFFS = [1.0, 0.5, 0.25, 0.1, 0.0]


def render(cpp, mp, coeff):
    sr = mp.sample_rate(); spc = mp.mode_iteration
    rt = pianoidCuda.RuntimeParameters(); rt.volume_level = 64
    rt.deck_feedback_coefficient = coeff
    cpp.setRuntimeParameters(rt)
    cpp.resetStringsState(); cpp.resetModeRunningState(); cpp.waitForParameterUpdate()
    eq = build_note_event_queue(PITCH, VEL, NOTE_MS, sr, spc)
    c = pianoidCuda.PlaybackConfig()
    c.audio_enabled = False; c.record_to_buffer = True
    c.sample_rate = sr; c.samples_per_cycle = spc; c.max_duration_ms = RENDER_MS
    cpp.clearRecords(); cpp.runOfflinePlayback(eq, c)
    a = np.abs(np.array(cpp.getRecordedAudio(), dtype=np.float64))
    if len(a) == 0:
        return None
    return {
        "peak": float(a.max()),
        "rms": float(np.sqrt(np.mean(a ** 2))),
        "p50": float(np.percentile(a, 50)),
        "p90": float(np.percentile(a, 90)),
        "p99": float(np.percentile(a, 99)),
        "p999": float(np.percentile(a, 99.9)),
        "frac_over_1": float(np.mean(a > 1.0)),
        "n": int(len(a)),
    }


def main():
    from pianoid import initialize
    p = initialize(get_preset_path(PRESET), filterlen=48 * 128 * 3, string_iteration=4,
                   array_size=384, sample_rate=SAMPLE_RATE, samples_in_cycle=SAMPLES_PER_CYCLE,
                   buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0,
                   listen_to_modes=False)
    cpp = p.pianoid; mp = p.mp
    cpp.waitForParameterUpdate()
    render(cpp, mp, 1.0)  # warm
    out = {}
    for coeff in COEFFS:
        out[f"{coeff}"] = render(cpp, mp, coeff)
    with open(os.path.join(REPO, "dev-d52b-headroom-design.json"), "w") as f:
        json.dump({"preset": PRESET, "pitch": PITCH, "results": out}, f, indent=2)
    print("HEADROOM_DESIGN:")
    for coeff in COEFFS:
        r = out[f"{coeff}"]
        print(f"  coeff={coeff}: peak={r['peak']:.3g} rms={r['rms']:.3g} "
              f"p50={r['p50']:.3g} p90={r['p90']:.3g} p99={r['p99']:.3g} p999={r['p999']:.3g} "
              f"frac>1={r['frac_over_1']:.4f}")
    try:
        cpp.shutdownGpu()
    except Exception:
        pass


if __name__ == "__main__":
    main()
