"""dev-cfl — LIVE CUDA-ENGINE validation of the derived CFL bound.

Derived (von-Neumann, exact): the explicit FDTD string scheme (addKernel,
MainKernel.cu:503-541) is stable iff, per string,
    8*coeff_bending <= coeff_tension <= 1 + 8*coeff_bending
i.e. the UPPER CFL invariant  (coeff_tension - 8*coeff_bending) <= 1, CFL_LIMIT=1.

This script drives the REAL GPU engine offline (pianoidCuda.runOfflinePlayback,
audio_off) and pushes a single string's coeff_tension BELOW / AT / ABOVE the
upper bound by scaling dx (coeff_tension ∝ 1/dx^2, coeff_bending ∝ 1/dx^4), then
checks the rendered buffer for NaN/Inf and broadband blow-up. Confirms:
  ratio < 1  -> finite, tonal (STABLE)
  ratio ~ 1  -> marginal (finite, near edge)
  ratio > 1  -> NaN / divergent (UNSTABLE)

Each trial resets string state first (independent trial — validating the BOUND,
not state-poisoning). Run from repo root with the PianoidCore venv:
  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-cfl-live-bound-validation.py
"""
import os, sys, math
import numpy as np

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
MIDDLEWARE_DIR = os.path.join(REPO_ROOT, "PianoidCore", "pianoid_middleware")
sys.path.insert(0, MIDDLEWARE_DIR)
sys.path.insert(0, os.path.join(REPO_ROOT, "PianoidCore"))

import pianoidCuda  # noqa: E402

TEST_PITCH = 60
TEST_VELOCITY = 100
DURATION_MS = 80
SAMPLE_RATE = 48000
SAMPLES_PER_CYCLE = 48
STRING_ITER = 4


def build_eq(pitch, vel, duration_ms, sr, spc):
    eq = pianoidCuda.EventQueue()
    on = pianoidCuda.PlaybackEvent()
    on.channel = 0; on.cycle_index = 0
    on.type = pianoidCuda.EventType.NOTE_ON
    on.data = (pitch << 8) | vel
    eq.addEvent(on)
    cycles = int((duration_ms / 1000.0) * sr / spc)
    off = pianoidCuda.PlaybackEvent()
    off.channel = 0; off.cycle_index = cycles
    off.type = pianoidCuda.EventType.NOTE_OFF
    off.data = (pitch << 8) | 0
    eq.addEvent(off)
    eq.sortByCycle()
    return eq


def render(pianoid, pitch, vel, duration_ms):
    cpp = pianoid.pianoid
    sr = pianoid.mp.sample_rate(); spc = pianoid.mp.mode_iteration
    cpp.waitForParameterUpdate()
    cpp.resetStringsState()            # independent trial: clean state each time
    eq = build_eq(pitch, vel, duration_ms, sr, spc)
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.sample_rate = sr; cfg.samples_per_cycle = spc
    cfg.max_duration_ms = duration_ms + 200
    cpp.clearRecords()
    cpp.runOfflinePlayback(eq, cfg)
    return np.array(cpp.getRecordedAudio(), dtype=np.float64)


def analyse(audio):
    n = audio.size
    if n == 0:
        return dict(n=0, nan=True, rms=float("nan"), peak=float("nan"), flat=float("nan"))
    nan = int(np.sum(~np.isfinite(audio)))
    fin = audio[np.isfinite(audio)]
    rms = float(np.sqrt(np.mean(fin**2))) if fin.size else float("nan")
    peak = float(np.max(np.abs(fin))) if fin.size else float("nan")
    flat = float("nan")
    if fin.size > 16:
        sp = np.abs(np.fft.rfft(fin))**2; sp = sp[sp > 0]
        if sp.size:
            flat = float(np.exp(np.mean(np.log(sp))) / np.mean(sp))
    return dict(n=n, nan=nan, rms=rms, peak=peak, flat=flat)


def coeff_TB(pitch_obj, dt, dx):
    phys = pitch_obj.physics
    T = (phys.tension / phys.rho) * dt**2 / dx**2
    B = (math.pi * phys.r**4 / (4*phys.rho)) * phys.jung * dt**2 / dx**4
    return T, B


def main():
    os.chdir(MIDDLEWARE_DIR)
    from pianoid import initialize

    def preset_path(name):
        for c in (os.path.join(MIDDLEWARE_DIR, "presets", name),
                  os.path.join(REPO_ROOT, "PianoidCore", "presets", name),
                  os.path.join(REPO_ROOT, "PianoidCore", "tests", "presets", name)):
            if os.path.exists(c):
                return c
        raise FileNotFoundError(name)

    print("=== dev-cfl LIVE CUDA-engine bound validation ===")
    # use a preset known to load cleanly in offline harness (dev-3a08 used Preset_test5)
    preset = None
    for cand in ("Preset_test5.json", "BaselinePreset1.json", "Belarus_8band_196modes.json"):
        try:
            preset = preset_path(cand); break
        except FileNotFoundError:
            continue
    print(f"preset: {preset}")
    p = initialize(preset, filterlen=48*128*3, string_iteration=STRING_ITER,
                   array_size=384, sample_rate=SAMPLE_RATE,
                   samples_in_cycle=SAMPLES_PER_CYCLE, buffer_size=4,
                   max_volume=5e18, audio_on=False, audio_driver_type=0)

    dt = 1.0 / (p.mp.sample_rate() * p.mp.string_iteration)
    pitch_obj = p.sm.pitches[TEST_PITCH]
    geom = pitch_obj.geometry
    base_len = geom.length
    base_dx = geom.dx()
    T0, B0 = coeff_TB(pitch_obj, dt, base_dx)
    print(f"\nbaseline pitch {TEST_PITCH}: dx={base_dx:.6g}  coeff_T={T0:.6f}  coeff_B={B0:.6e}")
    print(f"baseline upper-CFL ratio (T-8B)/1 = {T0 - 8*B0:.6f}  (should be <1, stable)\n")

    # We push coeff_tension to target ratios by scaling dx: T ∝ 1/dx^2.
    # ratio ≈ (T - 8B); since B is tiny, ratio ≈ T. To hit target T*, dx* = base_dx*sqrt(T0/T*).
    targets = [0.25, 0.6, 0.9, 0.98, 1.0, 1.02, 1.1, 1.5, 3.0]
    print(f"{'target_ratio':>13}{'dx':>12}{'coeff_T':>10}{'coeff_B':>11}"
          f"{'ratio=T-8B':>11}{'nan':>6}{'peak':>12}{'flat':>8}{'verdict':>10}")
    results = []
    for tgt in targets:
        # Drive via LENGTH (the clean documented path): dx = length / p_main, so
        # length_new = base_len * sqrt(T0/tgt) gives dx_new = base_dx*sqrt(T0/tgt)
        # => coeff_tension ≈ tgt (coeff_bending follows ∝ 1/dx^4). Reading geom.dx()
        # afterward is EXACTLY the dx the GPU received (no raw-dx mismatch).
        target_T = tgt
        length_new = base_len * math.sqrt(T0 / target_T)
        p.update_pitch_physical_params_GRANULAR(TEST_PITCH, length=float(length_new))
        p.pianoid.waitForParameterUpdate()
        dx_new = pitch_obj.geometry.dx()
        T, B = coeff_TB(pitch_obj, dt, dx_new)
        ratio = T - 8*B
        a = render(p, TEST_PITCH, TEST_VELOCITY, DURATION_MS)
        r = analyse(a)
        unstable = r["nan"] > 0 or (not math.isfinite(r["peak"])) or r["peak"] > 1e25
        verdict = "UNSTABLE" if unstable else "stable"
        print(f"{tgt:>13.3f}{dx_new:>12.6g}{T:>10.5f}{B:>11.3e}{ratio:>11.5f}"
              f"{r['nan']:>6}{r['peak']:>12.4g}{r['flat']:>8.4f}{verdict:>10}")
        results.append((tgt, ratio, unstable))
        # restore + clean for next independent trial
        p.update_pitch_physical_params_GRANULAR(TEST_PITCH, length=float(base_len))
        p.pianoid.waitForParameterUpdate()
        p.pianoid.resetStringsState()

    print("\n--- VALIDATION VERDICT ---")
    below = [u for (t, ra, u) in results if ra < 0.95]
    above = [u for (t, ra, u) in results if ra > 1.05]
    print(f"  ratio<0.95 trials: {sum(below)}/{len(below)} unstable "
          f"(expect 0 — all stable below the bound)")
    print(f"  ratio>1.05 trials: {sum(above)}/{len(above)} unstable "
          f"(expect {len(above)} — all diverge above the bound)")
    ok = (sum(below) == 0) and (len(above) > 0 and sum(above) == len(above))
    print(f"  BOUND CONFIRMED BY LIVE ENGINE: {ok}")

    try:
        p.pianoid.shutdownGpu()
    except Exception:
        pass
    print("=== done ===")


if __name__ == "__main__":
    main()
