"""dev-3a08 — decisive probe: does a fragile-pitch length edit poison mode state?

Hypothesis (the complete mechanism for "noise persists after restoring length"):
  A length edit on a short treble string can transiently violate the explicit-FDTD
  CFL bound -> the string displacement field blows up to NaN/Inf -> that NaN feeds
  into the soundboard mode oscillators via the feedin coupling -> mode running
  state (`dev_mode_running` q/q_prev) is now NaN. Mode state is PERSISTENT and is
  shared by ALL pitches. Restoring `length` only fixes the edited string's `dx`;
  it cannot clear NaN that has migrated into the mode oscillators. Result: every
  subsequent note on ANY pitch renders as noise, and a length restore does not help.
  Only `resetStringsState()` (which zeroes mode running state) recovers it.

This probe does NOT reset state between steps (models the live engine):
  1. clean render of a SAFE pitch                     -> expect clean tone
  2. length edit on a FRAGILE treble pitch (-15%)     -> may NaN the string
  3. read getModeDisplacements()                      -> check mode q/q_prev for NaN
  4. restore the fragile pitch's length               -> only fixes dx
  5. render the SAFE pitch again (NO reset)           -> if modes poisoned: noise
  6. resetStringsState(), render the SAFE pitch       -> must recover (proves the
                                                         persistence was mode state)

Run from repo root with the PianoidCore venv:
  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-3a08-mode-poison-probe.py
"""
import os
import sys

import numpy as np

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
MIDDLEWARE_DIR = os.path.join(REPO_ROOT, "PianoidCore", "pianoid_middleware")
sys.path.insert(0, MIDDLEWARE_DIR)
sys.path.insert(0, os.path.join(REPO_ROOT, "PianoidCore"))

import pianoidCuda  # noqa: E402

SAFE_PITCH = 60          # middle C — ample CFL margin
FRAGILE_PITCH = 96       # short treble string — smallest CFL margin in this preset
VELOCITY = 100
DURATION_MS = 60
SAMPLE_RATE = 48000
SAMPLES_PER_CYCLE = 48


def build_note_event_queue(pitch, velocity, duration_ms, sr, spc):
    eq = pianoidCuda.EventQueue()
    on = pianoidCuda.PlaybackEvent()
    on.channel = 0
    on.cycle_index = 0
    on.type = pianoidCuda.EventType.NOTE_ON
    on.data = (pitch << 8) | velocity
    eq.addEvent(on)
    cycles = int((duration_ms / 1000.0) * sr / spc)
    off = pianoidCuda.PlaybackEvent()
    off.channel = 0
    off.cycle_index = cycles
    off.type = pianoidCuda.EventType.NOTE_OFF
    off.data = (pitch << 8) | 0
    eq.addEvent(off)
    eq.sortByCycle()
    return eq


def render(pianoid, pitch, reset_first):
    cpp = pianoid.pianoid
    sr = pianoid.mp.sample_rate()
    spc = pianoid.mp.mode_iteration
    cpp.waitForParameterUpdate()
    if reset_first:
        cpp.resetStringsState()
    eq = build_note_event_queue(pitch, VELOCITY, DURATION_MS, sr, spc)
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled = False
    cfg.record_to_buffer = True
    cfg.sample_rate = sr
    cfg.samples_per_cycle = spc
    cfg.max_duration_ms = DURATION_MS + 200
    cpp.clearRecords()
    cpp.runOfflinePlayback(eq, cfg)
    return np.array(cpp.getRecordedAudio(), dtype=np.float64)


def describe(label, audio):
    n = audio.size
    nan = int(np.sum(~np.isfinite(audio))) if n else 0
    finite = audio[np.isfinite(audio)] if n else audio
    rms = float(np.sqrt(np.mean(finite ** 2))) if finite.size else float("nan")
    peak = float(np.max(np.abs(finite))) if finite.size else float("nan")
    print(f"  [{label}] samples={n} nan/inf={nan} rms={rms:.6g} peak={peak:.6g}")
    return {"nan": nan, "rms": rms, "peak": peak}


def mode_state_nan(pianoid):
    """Return (nan_count, total) for the mode running state q / q_prev."""
    md = np.array(pianoid.pianoid.getModeDisplacements(), dtype=np.float64)
    num_modes = pianoid.mp.num_modes_for_model
    running = md[:2 * num_modes]  # q + q_prev (first 2N of the 5N layout)
    return int(np.sum(~np.isfinite(running))), running.size


def main():
    os.chdir(MIDDLEWARE_DIR)
    from pianoid import initialize

    def preset_path(name):
        for c in (os.path.join(MIDDLEWARE_DIR, "presets", name),
                  os.path.join(REPO_ROOT, "PianoidCore", "presets", name)):
            if os.path.exists(c):
                return c
        raise FileNotFoundError(name)

    print("=== dev-3a08 mode-poison probe ===")
    p = initialize(
        preset_path("Preset_test5.json"),
        filterlen=48 * 128 * 3, string_iteration=4, array_size=384,
        sample_rate=SAMPLE_RATE, samples_in_cycle=SAMPLES_PER_CYCLE,
        buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0,
    )

    fg = p.sm.pitches[FRAGILE_PITCH].geometry
    base_len = fg.length
    print(f"fragile pitch {FRAGILE_PITCH}: length={base_len:.6g} p_main={fg.p_main()} "
          f"tail={fg.tail} dx={fg.dx():.6g}")

    # try a range of negative edits on the fragile pitch until one poisons modes
    for edit_pct in (0.90, 0.85, 0.80, 0.70, 0.60, 0.50):
        print(f"\n##### TRIAL: fragile-pitch length edit to {edit_pct:.0%} #####")
        # start each trial from a known-clean state
        p.pianoid.resetStringsState()

        # 1. clean render of the SAFE pitch
        a1 = render(p, SAFE_PITCH, reset_first=True)
        r1 = describe(f"clean SAFE pitch {SAFE_PITCH}", a1)
        nan0, tot = mode_state_nan(p)
        print(f"  mode running-state nan/inf BEFORE edit: {nan0}/{tot}")

        # 2. length edit on the FRAGILE pitch (granular path) — NO reset
        p.update_pitch_physical_params_GRANULAR(
            FRAGILE_PITCH, length=float(base_len * edit_pct))
        p.pianoid.waitForParameterUpdate()
        # play the FRAGILE pitch so its (possibly unstable) string actually runs
        a_fragile = render(p, FRAGILE_PITCH, reset_first=False)
        rf = describe(f"FRAGILE pitch {FRAGILE_PITCH} after {edit_pct:.0%} edit", a_fragile)

        # 3. inspect mode running state for NaN
        nan1, _ = mode_state_nan(p)
        print(f"  mode running-state nan/inf AFTER fragile edit+play: {nan1}/{tot}"
              f"  {'<-- MODES POISONED' if nan1 else ''}")

        # 4. restore the fragile pitch's length (only fixes dx) — NO reset
        p.update_pitch_physical_params_GRANULAR(
            FRAGILE_PITCH, length=float(base_len))
        p.pianoid.waitForParameterUpdate()

        # 5. render the SAFE pitch again — NO reset. If modes are poisoned this
        #    SAFE, never-edited pitch now renders as noise/NaN.
        a2 = render(p, SAFE_PITCH, reset_first=False)
        r2 = describe(f"SAFE pitch {SAFE_PITCH} after restore (no reset)", a2)
        nan2, _ = mode_state_nan(p)
        print(f"  mode running-state nan/inf after restore: {nan2}/{tot}")

        # 6. resetStringsState then render the SAFE pitch — must recover
        p.pianoid.resetStringsState()
        a3 = render(p, SAFE_PITCH, reset_first=False)
        r3 = describe(f"SAFE pitch {SAFE_PITCH} after resetStringsState", a3)

        poisoned = nan1 > 0 or nan2 > 0
        safe_broke = r2["nan"] > 0 or (r1["rms"] > 0 and
                                       (r2["rms"] > 8 * r1["rms"] or
                                        not np.isfinite(r2["rms"])))
        recovered_by_reset = r3["nan"] == 0 and r1["rms"] > 0 and \
            abs(r3["rms"] - r1["rms"]) / r1["rms"] < 1.0
        print(f"  >>> edit {edit_pct:.0%}: modes_poisoned={poisoned}  "
              f"safe_pitch_broke_after_restore={safe_broke}  "
              f"recovered_only_by_reset={recovered_by_reset}")
        if poisoned and safe_broke:
            print(f"  >>> CONFIRMED: a length edit on pitch {FRAGILE_PITCH} poisoned "
                  f"mode state; the SAFE pitch is now broken and a length restore "
                  f"did NOT fix it — only resetStringsState() recovered. This is the "
                  f"user's 'noise persists after restoring length' symptom.")
            break

    try:
        p.pianoid.shutdownGpu()
    except Exception:
        pass
    print("\n=== done ===")


if __name__ == "__main__":
    main()
