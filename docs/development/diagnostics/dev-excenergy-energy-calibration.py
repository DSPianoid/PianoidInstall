"""dev-excenergy — ENERGY LOUDNESS CALIBRATION (OFFLINE ONLY, audio_off, NO speaker emission).

PURPOSE
  The physics-energy (B2) model's absolute loudness is too high (default
  excitation_impulse_calibration c = 1.0). Calibrate c so the user's reference loud case lands
  WITHIN the clipping range — just under the INT32 rail with headroom, no clip.

★SAFETY: 100% OFFLINE. audio_on=False, audio_driver_type=0, start_right_away=0. Uses ONLY the
  OfflinePlaybackEngine render buffer (runOfflinePlayback → getRecordedAudio) + numeric measurement.
  It NEVER starts the realtime/online engine and NEVER opens a live audio driver — no sound is
  emitted to the speakers.

REFERENCE (user-specified):
  preset = Belarus_196modesC ; pitch 60 ; velocity 127 (fff) ; init max_volume = 100 ; slider level = 64.
  Output INT sample = output_raw * main_volume_coefficient, mvc = max_volume^(level/127) = 100^(64/127).
  INT32 rail R = 2^31 - 1 = 2147483647.

MEASUREMENT TRICK (limiter-independent): the soft-limiter (back on the energy-only branch) shapes the
  INT-domain sample s = output_raw*mvc only above 0.8*R; getRecordedAudio() returns soundFloat = s_lim/mvc,
  which equals output_raw ONLY when transparent. So we render at a LOW level (mvc≈1, transparent) to read
  the TRUE raw output peak, then compute the reference int peak analytically:
      peak_int(reference) = raw_peak * mvc_reference        (output_raw is independent of mvc; linear)
  This reads the true overshoot even when the reference would clip. We also sanity-check by reporting the
  raw peak and the implied dBFS vs R.

CALIBRATION (linear): amplitude ∝ c, so
      c_new = c_old * target_peak_int / measured_peak_int(reference)
  target_peak_int = HEADROOM_DBFS below R (default -3 dBFS → 10^(-3/20) ≈ 0.708 * R).

RUN (inside PianoidCore/.venv):
  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-excenergy-energy-calibration.py
      [--preset=Belarus_196modesC] [--pitch=60] [--vel=127] [--max-vol=100] [--level=64]
      [--headroom-db=3] [--measure-level=1] [--apply-c=<float>]
  --apply-c : if given, re-render the reference at this c (via the model setter + upload) and report the
              resulting int peak (the AFTER check). Otherwise the script SOLVES c and prints it (no edit).
"""
import os, sys, json, math

MIDDLEWARE = r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware"
os.chdir(MIDDLEWARE)
sys.path.insert(0, MIDDLEWARE)
import numpy as np
import pianoidCuda
from pianoid import initialize

SR, SPC = 48000, 64
R = 2**31 - 1   # INT32 rail

PRESET = "Belarus_196modesC"
PITCH, VEL = 60, 127
MAX_VOL = 100.0
LEVEL = 64
HEADROOM_DB = 3.0
MEASURE_LEVEL = 1     # render at this (low) level so the limiter is transparent → raw peak readable
RING_CYC = 90
APPLY_C = None
for a in sys.argv[1:]:
    if a.startswith("--preset="): PRESET = a.split("=", 1)[1]
    elif a.startswith("--pitch="): PITCH = int(a.split("=", 1)[1])
    elif a.startswith("--vel="): VEL = int(a.split("=", 1)[1])
    elif a.startswith("--max-vol="): MAX_VOL = float(a.split("=", 1)[1])
    elif a.startswith("--level="): LEVEL = int(a.split("=", 1)[1])
    elif a.startswith("--headroom-db="): HEADROOM_DB = float(a.split("=", 1)[1])
    elif a.startswith("--measure-level="): MEASURE_LEVEL = int(a.split("=", 1)[1])
    elif a.startswith("--apply-c="): APPLY_C = float(a.split("=", 1)[1])

# Belarus_196modesC is a valid-JSON preset file WITHOUT a .json extension. Resolve robustly:
# prefer the literal name, fall back to name+.json.
_cand = os.path.join(MIDDLEWARE, "presets", PRESET)
PRESET_PATH = _cand if os.path.isfile(_cand) else _cand + ".json"
mvc_ref = MAX_VOL ** (LEVEL / 127.0)
mvc_meas = MAX_VOL ** (MEASURE_LEVEL / 127.0)
target_int = (10 ** (-HEADROOM_DB / 20.0)) * R


def pk(a):
    a = np.asarray(a, np.float64)
    return float(np.max(np.abs(a))) if a.size else 0.0


def rms(a):
    a = np.asarray(a, np.float64)
    return float(np.sqrt(np.mean(a * a))) if a.size else 0.0


def dbfs(x):
    return 20 * math.log10(x / R) if x > 0 else float("-inf")


print(f"=== ENERGY CALIBRATION (OFFLINE, audio_off) preset={PRESET} p{PITCH} v{VEL} "
      f"max_vol={MAX_VOL} level={LEVEL} ===", flush=True)
print(f"    pianoidCuda: {pianoidCuda.__file__}", flush=True)
print(f"    INT32 rail R={R}  mvc_reference(level {LEVEL})={mvc_ref:.4f}  "
      f"mvc_measure(level {MEASURE_LEVEL})={mvc_meas:.4f}", flush=True)
print(f"    headroom={HEADROOM_DB} dBFS  -> target_int_peak={target_int:.4e} ({dbfs(target_int):.2f} dBFS)", flush=True)

p = initialize(PRESET_PATH, filterlen=48 * 128 * 3, string_iteration=12, array_size=384,
               sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, max_volume=MAX_VOL,
               audio_on=False, audio_driver_type=0, start_right_away=0, listen_to_midi=0)
cpp = p.pianoid
c_current = float(getattr(p.mp, "excitation_impulse_calibration", 1.0))
print(f"    current excitation_impulse_calibration c = {c_current}", flush=True)


def render_raw_peak():
    """Render the reference note at MEASURE_LEVEL (transparent limiter); return raw output peak/rms."""
    # set the runtime volume level low so output*mvc stays below the limiter knee
    try:
        p.set_volume_level(MEASURE_LEVEL)
    except Exception as e:
        print(f"    (set_volume_level failed: {e})", flush=True)
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
        audio = np.asarray(cpp.getRecordedAudio(), np.float64)
    return pk(audio), rms(audio), len(audio)


# ---- BEFORE: measure raw peak at current c, project to the reference int peak ----
raw_peak, raw_rms, n = render_raw_peak()
# soundFloat at MEASURE_LEVEL == raw output (transparent) since output*mvc_meas << 0.8R for level 1
# (verify: raw_peak * mvc_meas should be << 0.8R; if not, lower --measure-level)
meas_int = raw_peak * mvc_meas
ref_int = raw_peak * mvc_ref     # the int peak the driver WOULD see at the reference level
print(f"\n  [BEFORE c={c_current}] raw output peak={raw_peak:.4e} rms={raw_rms:.4e} (n={n})", flush=True)
print(f"    measure-level int peak = {meas_int:.4e} ({dbfs(meas_int):.2f} dBFS) "
      f"{'[transparent OK]' if meas_int < 0.8*R else '[!! above knee — lower --measure-level]'}", flush=True)
print(f"    >>> REFERENCE (level {LEVEL}) int peak = {ref_int:.4e}  ({dbfs(ref_int):.2f} dBFS vs R)", flush=True)
over = ref_int / R
print(f"    >>> vs INT32 rail: {over:.2f}x the rail "
      f"({'OVER — CLIPS' if ref_int > R else 'within rail'})", flush=True)

# ---- SOLVE c ----
c_new = c_current * target_int / ref_int if ref_int > 0 else float("nan")
print(f"\n  SOLVE: c_new = c_old * target/measured = {c_current} * {target_int:.3e}/{ref_int:.3e} "
      f"= {c_new:.6g}", flush=True)
print(f"    -> predicted reference int peak at c_new = {target_int:.4e} ({-HEADROOM_DB:.1f} dBFS)", flush=True)

result = {
    "preset": PRESET, "pitch": PITCH, "vel": VEL, "max_volume": MAX_VOL, "level": LEVEL,
    "R": R, "mvc_reference": mvc_ref, "headroom_db": HEADROOM_DB, "target_int": target_int,
    "c_current": c_current, "raw_peak": raw_peak,
    "reference_int_peak_before": ref_int, "reference_dbfs_before": dbfs(ref_int),
    "over_rail_x": over, "c_new_solved": c_new,
}

# ---- AFTER (optional): apply a c and re-render to confirm ----
if APPLY_C is not None:
    try:
        from excitation_coefficients import upload_excitation_coefficients
        p.mp.excitation_impulse_calibration = float(APPLY_C)
        with p.cuda_lock:
            upload_excitation_coefficients(cpp, p.sm)
        raw_peak2, raw_rms2, _ = render_raw_peak()
        ref_int2 = raw_peak2 * mvc_ref
        print(f"\n  [AFTER c={APPLY_C}] raw peak={raw_peak2:.4e} -> REFERENCE int peak={ref_int2:.4e} "
              f"({dbfs(ref_int2):.2f} dBFS)  {'WITHIN RANGE' if ref_int2 <= R else 'STILL OVER'}", flush=True)
        result["c_applied"] = float(APPLY_C)
        result["reference_int_peak_after"] = ref_int2
        result["reference_dbfs_after"] = dbfs(ref_int2)
        result["within_range_after"] = bool(ref_int2 <= R)
        # spot-check a mid velocity so we didn't make it inaudible
        for spv in (31, 63):
            globals()["VEL"] = spv
            rpv, _, _ = render_raw_peak()
            print(f"    spot-check v{spv}: reference int peak={rpv*mvc_ref:.4e} ({dbfs(rpv*mvc_ref):.2f} dBFS)", flush=True)
        globals()["VEL"] = VEL
    except Exception as e:
        print(f"  AFTER apply error: {e}", flush=True)
        result["after_error"] = str(e)

print("\n===== JSON =====\n" + json.dumps(result, indent=2,
      default=lambda o: round(o, 6) if isinstance(o, float) else o), flush=True)
try:
    cpp.stopApplication(True)
except Exception:
    pass
print("done", flush=True)
