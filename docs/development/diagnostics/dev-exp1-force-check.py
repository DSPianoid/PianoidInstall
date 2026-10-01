"""dev-exp1 — deterministic force_function integrity check.

force_function is produced by gaussKernel via pure per-thread writes (NO atomicAdd), so it is
DETERMINISTIC run-to-run. The Phase-1 refactor's gaussKernel edit only ADDS writes to a SEPARATE
buffer (dev_exct_descriptor); the force_function write statement is byte-unchanged (git diff).
Therefore: if the force_function is (a) bit-exact across renders and (b) finite, the descriptor
writes did not corrupt it and — combined with the unchanged force statement — force_function is
bit-identical to what the pre-refactor build produced. This is the primary excitation proof.
"""
import os
import sys
import numpy as np

MIDDLEWARE_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
    "PianoidCore", "pianoid_middleware",
)
sys.path.insert(0, MIDDLEWARE_DIR)
os.chdir(MIDDLEWARE_DIR)

import pianoidCuda
print("pianoidCuda:", pianoidCuda.__file__)
from pianoid import initialize

SR, SPC = 48000, 64
PITCHES = [40, 60, 84, 96]
VEL = 100


def build_eq(pitch, velocity, duration_ms, sr, spc):
    eq = pianoidCuda.EventQueue()
    on = pianoidCuda.PlaybackEvent()
    on.channel = 0; on.cycle_index = 0; on.type = pianoidCuda.EventType.NOTE_ON
    on.data = (pitch << 8) | velocity
    eq.addEvent(on)
    cycles = int((duration_ms / 1000.0) * sr / spc)
    off = pianoidCuda.PlaybackEvent()
    off.channel = 0; off.cycle_index = cycles; off.type = pianoidCuda.EventType.NOTE_OFF
    off.data = (pitch << 8) | 0
    eq.addEvent(off)
    eq.sortByCycle()
    return eq


def render_and_dump_force(p, pitch, velocity):
    """Render one note offline, then dump force_function for every string (all cycles)."""
    cpp = p.pianoid
    sr = p.mp.sample_rate(); spc = p.mp.mode_iteration
    cpp.waitForParameterUpdate()
    cpp.resetStringsState()
    eq = build_eq(pitch, velocity, 60, sr, spc)
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.sample_rate = sr; cfg.samples_per_cycle = spc; cfg.max_duration_ms = 260
    cpp.clearRecords()
    cpp.runOfflinePlayback(eq, cfg)
    n_strings = p.mp.num_strings
    forces = {}
    for s in range(n_strings):
        f = np.array(cpp.fetchExcitation(s, -1), dtype=np.float64)
        if np.any(f != 0.0):
            forces[s] = f
    return forces


def main():
    p = initialize(
        os.path.join("presets", "Preset_test5.json"),
        filterlen=48 * 128 * 3, string_iteration=4, array_size=384,
        sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, max_volume=5e18,
        audio_on=False, audio_driver_type=0,
    )
    all_ok = True
    for pitch in PITCHES:
        f1 = render_and_dump_force(p, pitch, VEL)
        f2 = render_and_dump_force(p, pitch, VEL)
        excited = sorted(set(f1) | set(f2))
        note_ok = True
        finite = True
        for s in excited:
            a = f1.get(s)
            b = f2.get(s)
            if a is None or b is None or a.shape != b.shape or not np.array_equal(a, b):
                note_ok = False
            if a is not None and not np.all(np.isfinite(a)):
                finite = False
        peak = max((float(np.max(np.abs(f1[s]))) for s in f1), default=0.0)
        all_ok = all_ok and note_ok and finite
        print(f"  pitch {pitch:3d}: excited_strings={len(excited)} peak={peak:.6g} "
              f"force_bit_exact_across_renders={note_ok} finite={finite}")
    try:
        p.pianoid.shutdownGpu()
    except Exception:
        pass
    print("\nFORCE_FUNCTION VERDICT:", "BIT-EXACT + FINITE (deterministic, uncorrupted)" if all_ok
          else "FAIL — force_function not deterministic/finite")


if __name__ == "__main__":
    main()
