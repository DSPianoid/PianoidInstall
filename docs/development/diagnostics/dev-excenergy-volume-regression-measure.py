"""dev-excenergy — VOLUME REGRESSION MEASURE on the MERGED build (OFFLINE ONLY, audio_off, NO speaker emission).

PURPOSE (team-lead, 2026-06-18): user on another system reports the merged build is FAR TOO LOUD.
Measure the ACTUAL rendered output level for the reference case on THIS system's merged build to
decide code-vs-build, and confirm the c=2.2e-05 calibration is EFFECTIVE in the rendered output
(i.e. the incremental coeff fix 74d62b2 did not drop c).

KEY DIFFERENCE from the earlier calibration harness: this reads the ENGINE'S ACTUAL sint output via
the PRODUCTION extractor result.load_sint_audio_from_kernel(mvc) (same formula MainKernel.cu uses,
mvc from pianoid.get_current_volume_coefficient()) — NOT a hand-computed raw*mvc. (Earlier lesson:
never re-derive the engine's output myself.)

REFERENCE: Belarus_196modesC, pitch 60, velocity 127, init max_volume 100, slider level 64.
  Expected if calibration intact: sint peak ~ -3 dBFS vs INT32 rail. If grossly loud / clipping the
  rail (>= 0 dBFS, or >>R before clip) => regressed.

CALIBRATION-EFFECTIVE CHECK: render at c=2.2e-05 (installed) AND at c=1.0 (the pre-calibration value)
  via the FULL upload path, and confirm peak(c=1.0)/peak(c=2.2e-05) ~ 1/2.2e-05 (output linear in c).
  If the ratio is ~1 instead, c is NOT reaching the rendered output (calibration dropped).

★SAFETY: audio_on=False, audio_driver_type=0, start_right_away=0. OfflinePlaybackEngine render buffer
  only. No realtime engine, no audio driver, no speaker emission.

RUN: PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-excenergy-volume-regression-measure.py
"""
import os, sys, json, math

MIDDLEWARE = r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware"
os.chdir(MIDDLEWARE)
sys.path.insert(0, MIDDLEWARE)
import numpy as np
import pianoidCuda
from pianoid import initialize
from excitation_coefficients import upload_excitation_coefficients

SR, SPC = 48000, 64
R = 2**31 - 1
PRESET = "Belarus_196modesC"
PITCH, VEL = 60, 127
MAX_VOL = 100.0
LEVEL = 64
RING_CYC = 90

_cand = os.path.join(MIDDLEWARE, "presets", PRESET)
PRESET_PATH = _cand if os.path.isfile(_cand) else _cand + ".json"


def dbfs(x):
    return 20 * math.log10(x / R) if x > 0 else float("-inf")


print(f"=== VOLUME REGRESSION MEASURE (OFFLINE, audio_off) {PRESET} p{PITCH} v{VEL} "
      f"max_vol={MAX_VOL} level={LEVEL} ===", flush=True)
print(f"    pianoidCuda: {pianoidCuda.__file__}", flush=True)

p = initialize(PRESET_PATH, filterlen=48 * 128 * 3, string_iteration=12, array_size=384,
               sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, max_volume=MAX_VOL,
               audio_on=False, audio_driver_type=0, start_right_away=0, listen_to_midi=0)
cpp = p.pianoid
c_installed = float(getattr(p.mp, "excitation_impulse_calibration", 1.0))
print(f"    installed excitation_impulse_calibration c = {c_installed}", flush=True)

# set the reference slider level and read the ENGINE's mvc (the production value)
p.set_volume_level(LEVEL)
mvc = p.get_current_volume_coefficient()
print(f"    engine mvc = get_current_volume_coefficient() = {mvc:.6f}  (expected ~{MAX_VOL**(LEVEL/127.0):.4f})", flush=True)


def render_sint_peak():
    """Render reference note offline; read ACTUAL sint output via production extractor.
    Returns (sint_peak, sint_rms, float_peak, n_samples)."""
    q = pianoidCuda.EventQueue()
    on = pianoidCuda.PlaybackEvent(); on.channel = 0; on.cycle_index = 1
    on.type = pianoidCuda.EventType.NOTE_ON; on.data = (PITCH << 8) | VEL; q.addEvent(on)
    q.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.max_duration_ms = int(RING_CYC * SPC * 1000 / SR); cfg.sample_rate = SR; cfg.samples_per_cycle = SPC
    with p.cuda_lock:
        cpp.resetStringsState(); cpp.runSynthesisKernel(); cpp.clearRecords()
        cpp.runOfflinePlayback(q, cfg)
    # production load path: float kernel buffer -> sint via the SAME mvc the kernel uses
    p.result.load_offline_sound_from_pianoid()
    fpk = float(np.max(np.abs(np.asarray(p.result.sound, np.float64)))) if p.result.sound.size else 0.0
    p.result.load_sint_audio_from_kernel(mvc)
    s = np.asarray(p.result.sint_sound, np.float64)
    spk = float(np.max(np.abs(s))) if s.size else 0.0
    srms = float(np.sqrt(np.mean(s * s))) if s.size else 0.0
    return spk, srms, fpk, s.size


# ---- MEASURE at installed c ----
spk, srms, fpk, n = render_sint_peak()
print(f"\n  [c={c_installed}] ACTUAL sint output (production extractor):", flush=True)
print(f"    float kernel peak = {fpk:.4e}", flush=True)
print(f"    sint peak = {spk:.4e}  ({dbfs(spk):.2f} dBFS vs INT32 rail)", flush=True)
print(f"    sint rms  = {srms:.4e}  ({dbfs(srms):.2f} dBFS)", flush=True)
clip = spk >= R
print(f"    >>> {'CLIPS the rail (>=0 dBFS)!' if clip else 'within rail'}  "
      f"peak/R = {spk/R:.4f}x", flush=True)

result = {
    "preset": PRESET, "pitch": PITCH, "vel": VEL, "max_volume": MAX_VOL, "level": LEVEL,
    "c_installed": c_installed, "mvc": mvc, "R": R,
    "float_peak": fpk, "sint_peak": spk, "sint_dbfs": dbfs(spk), "sint_rms": srms,
    "clips_rail": bool(clip), "peak_over_R": spk / R,
}

# ---- CALIBRATION-EFFECTIVE CHECK: render at c=1.0 and confirm peak scales 1/c ----
try:
    p.mp.excitation_impulse_calibration = 1.0
    with p.cuda_lock:
        upload_excitation_coefficients(cpp, p.sm)
    spk1, srms1, fpk1, _ = render_sint_peak()
    ratio = spk1 / spk if spk > 0 else float("nan")
    expected_ratio = 1.0 / c_installed if c_installed > 0 else float("nan")
    print(f"\n  [c=1.0 (pre-calibration)] sint peak = {spk1:.4e} ({dbfs(spk1):.2f} dBFS), float peak={fpk1:.4e}", flush=True)
    print(f"    peak(c=1.0)/peak(c={c_installed}) = {ratio:.4g}   expected ~1/c = {expected_ratio:.4g}", flush=True)
    eff = abs(ratio - expected_ratio) / expected_ratio < 0.05 if expected_ratio == expected_ratio else False
    print(f"    >>> calibration EFFECTIVE (output linear in c)? {'YES' if eff else 'NO — c not reaching output!'}", flush=True)
    result.update({"sint_peak_c1": spk1, "sint_dbfs_c1": dbfs(spk1),
                   "ratio_c1_over_cinstalled": ratio, "expected_ratio_1_over_c": expected_ratio,
                   "calibration_effective": bool(eff)})
    # restore installed c
    p.mp.excitation_impulse_calibration = c_installed
    with p.cuda_lock:
        upload_excitation_coefficients(cpp, p.sm)
except Exception as e:
    print(f"  calibration-effective check error: {e}", flush=True)
    result["cal_check_error"] = str(e)

print("\n===== JSON =====\n" + json.dumps(result, indent=2,
      default=lambda o: round(o, 6) if isinstance(o, float) else o), flush=True)
try:
    cpp.stopApplication(True)
except Exception:
    pass
print("done", flush=True)
