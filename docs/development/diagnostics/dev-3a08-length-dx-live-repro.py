"""dev-3a08 — live-engine reproduction of the length->dx regression (commit a558cb3).

The prior agent's offline test (`test_length_dx_propagation.py`) calls
`resetStringsState()` before EVERY render, so it starts from clean string state
each time — a persistent-state corruption is invisible to it.

This script models the LIVE UI sequence: it does NOT reset string state between
the length edit and the subsequent render. `runOfflinePlayback` does not reset
string state internally (only the event queue), so consecutive renders on the
same Pianoid instance retain the per-string displacement field — exactly the
live-engine behaviour.

Sequence (mirrors the user's repro):
  1. render note  (clean)            -> measure RMS / NaN / broadband
  2. edit length via the GRANULAR path (update_pitch_physical_params_GRANULAR)
  3. render note  (NO reset)         -> measure: noise? NaN? instability?
  4. restore the original length via the granular path
  5. render note  (NO reset)         -> measure: recovered?

Run from the repo root with the PianoidCore venv:
  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-3a08-length-dx-live-repro.py
"""
import os
import sys

import numpy as np

# this file: <repo>/docs/development/diagnostics/dev-3a08-...py  -> 4 levels up = <repo>
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
MIDDLEWARE_DIR = os.path.join(REPO_ROOT, "PianoidCore", "pianoid_middleware")
sys.path.insert(0, MIDDLEWARE_DIR)
sys.path.insert(0, os.path.join(REPO_ROOT, "PianoidCore"))

import pianoidCuda  # noqa: E402

TEST_PITCH = 60
TEST_VELOCITY = 100
DURATION_MS = 60
SAMPLE_RATE = 48000
SAMPLES_PER_CYCLE = 48


def build_note_event_queue(pitch, velocity, duration_ms, sample_rate, samples_per_cycle):
    eq = pianoidCuda.EventQueue()
    note_on = pianoidCuda.PlaybackEvent()
    note_on.channel = 0
    note_on.cycle_index = 0
    note_on.type = pianoidCuda.EventType.NOTE_ON
    note_on.data = (pitch << 8) | velocity
    eq.addEvent(note_on)
    cycles = int((duration_ms / 1000.0) * sample_rate / samples_per_cycle)
    note_off = pianoidCuda.PlaybackEvent()
    note_off.channel = 0
    note_off.cycle_index = cycles
    note_off.type = pianoidCuda.EventType.NOTE_OFF
    note_off.data = (pitch << 8) | 0
    eq.addEvent(note_off)
    eq.sortByCycle()
    return eq


def render_note_LIVE(pianoid, pitch, velocity, duration_ms, reset_first):
    """Render one note. If reset_first is False, retains string state from the
    previous render (models the live engine)."""
    cpp = pianoid.pianoid
    sr = pianoid.mp.sample_rate()
    spc = pianoid.mp.mode_iteration

    cpp.waitForParameterUpdate()
    if reset_first:
        cpp.resetStringsState()

    eq = build_note_event_queue(pitch, velocity, duration_ms, sr, spc)
    config = pianoidCuda.PlaybackConfig()
    config.audio_enabled = False
    config.record_to_buffer = True
    config.sample_rate = sr
    config.samples_per_cycle = spc
    config.max_duration_ms = duration_ms + 200

    cpp.clearRecords()
    cpp.runOfflinePlayback(eq, config)
    return np.array(cpp.getRecordedAudio(), dtype=np.float64)


def analyse(label, audio):
    """Print RMS / NaN / clipping / broadband-ratio diagnostics for one render."""
    n = audio.size
    if n == 0:
        print(f"  [{label}] EMPTY render (0 samples)")
        return {"rms": 0.0, "nan": True, "broadband": None}
    nan_count = int(np.sum(~np.isfinite(audio)))
    finite = audio[np.isfinite(audio)]
    rms = float(np.sqrt(np.mean(finite ** 2))) if finite.size else float("nan")
    peak = float(np.max(np.abs(finite))) if finite.size else float("nan")
    # Broadband-noise proxy: zero-crossing rate. A clean tone crosses zero ~2x
    # per period; broadband noise crosses far more often. Normalise to [0,1].
    if finite.size > 2:
        signs = np.sign(finite)
        signs[signs == 0] = 1
        zcr = float(np.mean(signs[1:] != signs[:-1]))
    else:
        zcr = float("nan")
    # Spectral flatness (geometric mean / arithmetic mean of power spectrum):
    # ~1.0 for white noise, near 0 for a pure tone.
    flatness = float("nan")
    if finite.size > 16:
        spec = np.abs(np.fft.rfft(finite)) ** 2
        spec = spec[spec > 0]
        if spec.size:
            flatness = float(np.exp(np.mean(np.log(spec))) / np.mean(spec))
    print(f"  [{label}] samples={n} nan/inf={nan_count} rms={rms:.6g} "
          f"peak={peak:.6g} zcr={zcr:.4f} spectral_flatness={flatness:.4f}")
    return {"rms": rms, "nan": nan_count > 0, "zcr": zcr, "flatness": flatness,
            "peak": peak}


def main():
    os.chdir(MIDDLEWARE_DIR)
    from pianoid import initialize

    def preset_path(name):
        for cand in (
            os.path.join(MIDDLEWARE_DIR, "presets", name),
            os.path.join(REPO_ROOT, "PianoidCore", "presets", name),
            os.path.join(REPO_ROOT, "PianoidCore", "tests", "presets", name),
        ):
            if os.path.exists(cand):
                return cand
        raise FileNotFoundError(name)

    print("=== dev-3a08 length->dx LIVE reproduction ===")
    p = initialize(
        preset_path("Preset_test5.json"),
        filterlen=48 * 128 * 3,
        string_iteration=4,
        array_size=384,
        sample_rate=SAMPLE_RATE,
        samples_in_cycle=SAMPLES_PER_CYCLE,
        buffer_size=4,
        max_volume=5e18,
        audio_on=False,
        audio_driver_type=0,
    )

    # Pitch geometry overview — print dx for the full keyboard so we can see
    # which pitches sit near the explicit-FDTD stability edge (smallest dx).
    print("\n-- keyboard geometry (dx per pitch) --")
    keyb = []
    for pn in sorted(p.sm.pitches.keys()):
        g = p.sm.pitches[pn].geometry
        if pn > 108 or g.tail <= 0:
            continue
        keyb.append((pn, g.length, g.p_main(), g.tail, g.dx()))
    for pn, ln, pm, tl, dx in keyb[::8]:
        print(f"   pitch {pn:3d}: length={ln:.5g}  p_main={pm}  tail={tl}  dx={dx:.6g}")
    if keyb:
        dmin = min(keyb, key=lambda t: t[4])
        dmax = max(keyb, key=lambda t: t[4])
        print(f"   smallest dx: pitch {dmin[0]} dx={dmin[4]:.6g}   "
              f"largest dx: pitch {dmax[0]} dx={dmax[4]:.6g}")

    # Sweep a spread of pitches: bass, middle, and several treble pitches
    # (treble = short string = small dx = closest to the CFL bound).
    sweep_pitches = [pn for pn in (40, 60, 84, 96, 100, 104, 108)
                     if pn in p.sm.pitches and p.sm.pitches[pn].geometry.tail > 0]

    # edit sizes — note the asymmetry: a length DECREASE shrinks dx and inflates
    # coeff_bending (proportional to 1/dx^4), so negative edits are the dangerous
    # direction. Include very small steps (±2%) — the user said "even a SMALL amount".
    edit_pcts = (0.98, 0.95, 0.90, 1.02, 1.05, 1.10)

    any_break = False
    for pitch in sweep_pitches:
        geom = p.sm.pitches[pitch].geometry
        base_length = geom.length
        base_dx = geom.dx()
        print(f"\n=== PITCH {pitch}  (length={base_length:.6g}  p_main={geom.p_main()}  "
              f"tail={geom.tail}  dx={base_dx:.6g}) ===")

        # clean baseline render (reset once)
        a1 = render_note_LIVE(p, pitch, TEST_VELOCITY, DURATION_MS, reset_first=True)
        r1 = analyse("clean", a1)

        for pct in edit_pcts:
            new_len = base_length * pct
            p.update_pitch_physical_params_GRANULAR(pitch, length=float(new_len))
            p.pianoid.waitForParameterUpdate()
            new_dx = p.sm.pitches[pitch].geometry.dx()

            a2 = render_note_LIVE(p, pitch, TEST_VELOCITY, DURATION_MS, reset_first=False)
            r2 = analyse(f"  edit {pct:.0%} (dx x{new_dx/base_dx:.3f}, no reset)", a2)

            # restore
            p.update_pitch_physical_params_GRANULAR(pitch, length=float(base_length))
            p.pianoid.waitForParameterUpdate()
            a3 = render_note_LIVE(p, pitch, TEST_VELOCITY, DURATION_MS, reset_first=False)
            r3 = analyse("  after restore (no reset)", a3)

            broke = r2["nan"] or (r2["flatness"] is not None and r1["flatness"] is not None
                                  and r2["flatness"] > 5 * max(r1["flatness"], 1e-9))
            recovered = (not r3["nan"]) and r1["rms"] > 0 and (
                abs(r3["rms"] - r1["rms"]) / r1["rms"] < 0.5)
            tag = "  *** BROKE ***" if broke else ""
            print(f"  VERDICT pitch {pitch} edit {pct:.0%}: broke={broke} "
                  f"recovered_after_restore={recovered}{tag}")
            any_break = any_break or broke

            # independent trials
            p.pianoid.resetStringsState()
            render_note_LIVE(p, pitch, TEST_VELOCITY, 5, reset_first=False)

    print(f"\n=== SWEEP SUMMARY: any pitch broke on a length edit = {any_break} ===")

    try:
        p.pianoid.shutdownGpu()
    except Exception:
        pass
    print("=== done ===")


if __name__ == "__main__":
    main()
