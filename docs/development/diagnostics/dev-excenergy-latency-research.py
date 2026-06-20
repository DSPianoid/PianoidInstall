"""dev-excenergy DEEP LATENCY RESEARCH (OFFLINE, audio_off, NO speaker emission).

Team-lead/user directive: edits >50ms unacceptable. Measure per-param the coefficient-recompute
latency (the code-deterministic dominant cost) + breakdown, confirm which params hit the full
~800ms rebuild vs the incremental ~ms path, and check the POSITION correctness concern.

Measures (in-process, engine inited audio_off, no realtime driver — the coeff recompute + GPU
upload are the same code regardless of cycling; the waitForParameterUpdate floor is characterized
separately/analytically: 1 audio cycle = 64/48000 = 1.33ms when cycling, vs ~2s idle timeout):

  A. pack_excitation_coefficients()              — the model-side rebuild (the ~800ms claim), + per-pitch.
  B. upload_excitation_coefficients(full)        — pack + extrapolate + setNewExcitationCoefficients (mass/speed/calibration path, /excitation_energy).
  C. update_excitation_coefficients_for_hammer   — the incremental ratio path (width/sharpness, /set_hammer_shape).
  D. setNewExcitationCoefficients alone          — the GPU upload.
  E. POSITION correctness: does hammer_spatial_impulse change on a position-only edit?
     (if ratio ~ 1, the incremental updater applies ~no change -> position appears to do nothing.)
  F. update_hammer_shape() model cost (the per-pitch shape recompute on a hammer edit).

RUN: PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-excenergy-latency-research.py
"""
import os, sys, time, json, statistics

MW = r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware"
os.chdir(MW); sys.path.insert(0, MW)
import numpy as np
import pianoidCuda
from pianoid import initialize
from excitation_coefficients import (upload_excitation_coefficients,
                                     update_excitation_coefficients_for_hammer,
                                     build_excitation_coefficients_flat)

SR, SPC = 48000, 64
PRESET = os.path.join(MW, "presets", "Belarus_196modesC")


def ms(fn, n=5):
    ts = []
    for _ in range(n):
        t0 = time.perf_counter(); fn(); ts.append((time.perf_counter() - t0) * 1000)
    return min(ts), statistics.median(ts), max(ts)


print("=== DEEP LATENCY RESEARCH (offline, audio_off) ===", flush=True)
print(f"    pianoidCuda: {pianoidCuda.__file__}", flush=True)
p = initialize(PRESET, filterlen=48 * 128 * 3, string_iteration=12, array_size=384,
               sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, max_volume=100.0,
               audio_on=False, audio_driver_type=0, start_right_away=0, listen_to_midi=0)
cpp = p.pianoid
sm = p.sm
n_key = len(sm.keyPitches)
n_str = len(sm.string_index)
print(f"    Belarus: {n_key} key pitches, {n_str} strings", flush=True)
res = {"n_key_pitches": n_key, "n_strings": n_str,
       "waitForParameterUpdate_floor_cycling_ms": SPC / SR * 1000,  # 1.33ms
       "waitForParameterUpdate_floor_idle_ms": "~2000 (measured earlier, timeout)"}

# --- A. pack_excitation_coefficients (model rebuild) ---
lo, med, hi = ms(lambda: sm.pack_excitation_coefficients(), n=5)
print(f"\n  A. sm.pack_excitation_coefficients()        : {med:8.1f} ms (min {lo:.1f}, max {hi:.1f})  [all {n_key} pitches]", flush=True)
res["A_pack_excitation_coefficients_ms"] = med
res["A_per_pitch_ms"] = med / n_key if n_key else None

# --- A2. build_excitation_coefficients_flat (pack + extrapolate to 128) ---
lo, med2, hi = ms(lambda: build_excitation_coefficients_flat(sm), n=5)
print(f"  A2. build_excitation_coefficients_flat()     : {med2:8.1f} ms  [pack + 6->128 extrapolate + flatten]", flush=True)
res["A2_build_flat_ms"] = med2

# --- D. setNewExcitationCoefficients alone (GPU upload) ---
flat = build_excitation_coefficients_flat(sm)
if hasattr(cpp, 'setNewExcitationCoefficients'):
    lo, medD, hi = ms(lambda: cpp.setNewExcitationCoefficients(flat), n=5)
    print(f"  D. setNewExcitationCoefficients(flat)         : {medD:8.3f} ms  [GPU upload of {len(flat)} reals]", flush=True)
    res["D_gpu_upload_ms"] = medD
else:
    print("  D. setNewExcitationCoefficients: NOT PRESENT (pre-B2 engine)", flush=True)
    res["D_gpu_upload_ms"] = None

# --- B. FULL upload (mass/speed/calibration path = /excitation_energy) ---
lo, medB, hi = ms(lambda: upload_excitation_coefficients(cpp, sm), n=5)
print(f"\n  B. upload_excitation_coefficients (FULL)      : {medB:8.1f} ms  <== MASS / SPEED / CALIBRATION / GAUSS path", flush=True)
print(f"     (this is what /excitation_energy POST and the gauss/excitation branch call)", flush=True)
res["B_full_upload_ms"] = medB

# --- C. INCREMENTAL hammer path (width/sharpness = /set_hammer_shape) ---
PID = sm.keyPitches[len(sm.keyPitches) // 2]
prev_flat = build_excitation_coefficients_flat(sm)
old_spatial = sm.hammer_spatial_impulse(int(PID))
# simulate a width change so spatial actually moves
def incr_call():
    update_excitation_coefficients_for_hammer(cpp, sm, [int(PID)], {int(PID): old_spatial}, prev_flat)
lo, medC, hi = ms(incr_call, n=5)
print(f"\n  C. update_excitation_coefficients_for_hammer  : {medC:8.3f} ms  <== WIDTH / SHARPNESS path (incremental)", flush=True)
res["C_incremental_hammer_ms"] = medC

# --- F. update_hammer_shape model cost (per-pitch shape recompute) ---
try:
    cur = sm.pitches[int(PID)].physics.hammer
    w = getattr(cur, 'width', 0.012)
    lo, medF, hi = ms(lambda: sm.update_hammer_shape(int(PID), width=float(w)), n=5)
    print(f"  F. sm.update_hammer_shape(1 pitch)            : {medF:8.3f} ms  [model-side hammer shape recompute]", flush=True)
    res["F_update_hammer_shape_ms"] = medF
except Exception as e:
    print(f"  F. update_hammer_shape probe error: {e}", flush=True)

# --- E. POSITION correctness: does hammer_spatial_impulse move on a position-only edit? ---
print(f"\n  E. POSITION correctness check (pitch {int(PID)}):", flush=True)
try:
    spatial_before = sm.hammer_spatial_impulse(int(PID))
    # read current hammer params
    h = sm.pitches[int(PID)].physics.hammer
    pos0 = getattr(h, 'position', None)
    w0 = getattr(h, 'width', 0.012)
    # shift position by a clear amount (e.g. +0.03 m) keeping width fixed
    new_pos = (pos0 if pos0 is not None else 0.05) + 0.03
    sm.update_hammer_shape(int(PID), position=float(new_pos), width=float(w0))
    spatial_after = sm.hammer_spatial_impulse(int(PID))
    ratio = spatial_after / spatial_before if spatial_before else float('nan')
    print(f"     spatial_impulse before pos-edit = {spatial_before:.6e}", flush=True)
    print(f"     spatial_impulse after  pos-edit = {spatial_after:.6e}  (pos {pos0} -> {new_pos})", flush=True)
    print(f"     incremental RATIO = {ratio:.6f}  -> {'~1: POSITION EFFECTIVELY A NO-OP via incremental (CORRECTNESS BUG)' if abs(ratio-1.0)<0.02 else 'ratio != 1: position does scale the coeff'}", flush=True)
    res["E_pos_spatial_before"] = spatial_before
    res["E_pos_spatial_after"] = spatial_after
    res["E_pos_ratio"] = ratio
    res["E_position_noop_via_incremental"] = bool(abs(ratio - 1.0) < 0.02)
    # also: does the full rebuild reflect the position change? (compare a coeff row before/after full)
except Exception as e:
    print(f"     position probe error: {e}", flush=True)
    res["E_error"] = str(e)

# --- SUMMARY: which params exceed 50ms (coeff component, cycling floor +1.33ms) ---
floor = SPC / SR * 1000
print(f"\n  === PER-PARAM coeff-recompute latency (+ {floor:.2f}ms cycling buffer-wait) ===", flush=True)
full = res.get("B_full_upload_ms", 0)
incr = res.get("C_incremental_hammer_ms", 0)
rows = [
    ("hammer width",     incr, "incremental"),
    ("hammer sharpness", incr, "incremental"),
    ("hammer position",  incr, "incremental (but see E: may be a no-op!)"),
    ("hammer mass",      full, "FULL rebuild (/excitation_energy)"),
    ("energy speed",     full, "FULL rebuild (/excitation_energy)"),
    ("gauss/excitation", full, "FULL rebuild"),
]
for name, t, path in rows:
    total = t + floor
    print(f"     {name:18s}: {total:8.1f} ms  [{'OVER 50ms' if total > 50 else 'ok'}]  ({path})", flush=True)
res["summary_rows"] = [{"param": n, "coeff_ms": t, "total_with_floor_ms": t + floor, "over_50ms": (t + floor) > 50, "path": pth} for n, t, pth in rows]

print("\n===== JSON =====\n" + json.dumps(res, indent=2, default=lambda o: round(o, 6) if isinstance(o, float) else o), flush=True)
try: cpp.stopApplication(True)
except Exception: pass
print("done", flush=True)
