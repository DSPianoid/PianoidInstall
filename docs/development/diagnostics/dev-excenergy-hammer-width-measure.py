"""dev-excenergy — HAMMER WIDTH bug measure (OFFLINE, audio_off, NO speaker emission).

User: "Hammer WIDTH does nothing — sound unchanged + zoomed shape unchanged." Measure the backend
chain for a width set on a pitch:
  1. RESIDENT shape (what /get_hammer_shape returns = pitch.physics.hammer.hammer_shape): does it
     CHANGE when width changes? (the zoomed view reads this)
  2. dev_hammer (sm.pack_hammers — the per-node spatial distribution uploaded to the engine).
  3. hammer_spatial_impulse (the coefficient L1 factor) — expected ~width-invariant (loudness).
  4. rendered SOUND (offline) at width-A vs width-B — spectrum/RMS, not just peak.

PRIME HYPOTHESIS (from Hammer.calculate_hammer_shape:148): width is FLOORED at max(width, 3*dx).
If the UI sends widths below 3*dx, they all clamp to the same shape -> "width does nothing". So sweep
widths BELOW and ABOVE 3*dx to localize.

RUN: PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-excenergy-hammer-width-measure.py
"""
import os, sys, json
MW = r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware"
os.chdir(MW); sys.path.insert(0, MW)
import numpy as np
import pianoidCuda
from pianoid import initialize

P = os.path.join(MW, "presets", "Belarus_196modesC")
SR, SPC = 48000, 64
PITCH, VEL = 60, 127


def resident_shape(sm, pid):
    """Exactly what /get_hammer_shape returns: the resident hammer_shape array."""
    return np.asarray(sm.pitches[pid].physics.hammer.hammer_shape, dtype=np.float64).copy()


def dev_hammer(sm):
    return np.asarray(sm.pack_hammers(), dtype=np.float64).ravel().copy()


def render_sound(p, cpp):
    q = pianoidCuda.EventQueue()
    on = pianoidCuda.PlaybackEvent(); on.channel = 0; on.cycle_index = 1
    on.type = pianoidCuda.EventType.NOTE_ON; on.data = (PITCH << 8) | VEL; q.addEvent(on); q.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig(); cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.max_duration_ms = int(90 * SPC * 1000 / SR); cfg.sample_rate = SR; cfg.samples_per_cycle = SPC
    with p.cuda_lock:
        cpp.resetStringsState(); cpp.runSynthesisKernel(); cpp.clearRecords(); cpp.runOfflinePlayback(q, cfg)
    p.result.load_offline_sound_from_pianoid()
    return np.asarray(p.result.sound, np.float64).ravel().copy()


print("=== HAMMER WIDTH measure (offline, audio_off) ===", flush=True)
p = initialize(P, filterlen=48*128*3, string_iteration=12, array_size=384, sample_rate=SR,
               samples_in_cycle=SPC, buffer_size=4, max_volume=100.0, audio_on=False,
               audio_driver_type=0, start_right_away=0, listen_to_midi=0)
sm = p.sm; cpp = p.pianoid
h = sm.pitches[PITCH].physics.hammer
geo = sm.pitches[PITCH].physics.geometry
dx = geo.dx(); l_main = geo.l_main(); floor = dx * 3
print(f"  pitch {PITCH}: dx={dx:.5f}  l_main={l_main:.4f}  width FLOOR (3*dx)={floor:.5f} m", flush=True)
print(f"  current width={h.width:.5f}  (UI hammer-chart width handle range is ~meters)", flush=True)
res = {"pitch": PITCH, "dx": dx, "l_main": l_main, "width_floor_3dx": floor, "sweep": []}

# Sweep widths below + around + above the 3*dx floor. Belarus dx~0.005 -> floor ~0.015 m.
widths = [0.003, 0.008, 0.012, 0.015, 0.020, 0.040, 0.080]
prev_shape = None; prev_sound = None
for w in widths:
    sm.update_hammer_shape(PITCH, width=float(w))
    sm.pitches[PITCH].physics.hammer.calculate_hammer_shape()  # ensure resident recompute (no-op if already)
    eff_width = sm.pitches[PITCH].physics.hammer.width
    shape = resident_shape(sm, PITCH)
    nz = int(np.count_nonzero(shape)); speak = float(np.max(np.abs(shape)))
    spatial = sm.hammer_spatial_impulse(PITCH)
    sound = render_sound(p, cpp)
    spk = float(np.max(np.abs(sound)))
    d_shape = "n/a" if prev_shape is None else f"{np.max(np.abs(shape-prev_shape)):.3e}"
    d_sound = "n/a" if prev_sound is None else f"{np.max(np.abs(sound-prev_sound)):.3e}"
    print(f"  width req={w:.3f} -> stored={eff_width:.5f} | resident_shape nz={nz:3d} peak={speak:.4e} "
          f"spatial(L1)={spatial:.4e} | Δshape_vs_prev={d_shape} | sound peak={spk:.3e} Δsound={d_sound}", flush=True)
    res["sweep"].append({"width_req": w, "width_stored": eff_width, "shape_nonzero": nz,
                         "shape_peak": speak, "spatial_L1": spatial, "sound_peak": spk,
                         "d_shape_vs_prev": None if prev_shape is None else float(np.max(np.abs(shape-prev_shape))),
                         "d_sound_vs_prev": None if prev_sound is None else float(np.max(np.abs(sound-prev_sound)))})
    prev_shape = shape; prev_sound = sound

# Verdict helpers
diffs_shape = [r["d_shape_vs_prev"] for r in res["sweep"][1:]]
print(f"\n  RESIDENT SHAPE changes across width sweep? {'YES' if any(d and d>1e-9 for d in diffs_shape) else 'NO — width does not move the shape'}", flush=True)
print(f"  (per-step Δshape: {['%.2e'%d if d is not None else 'n/a' for d in diffs_shape]})", flush=True)
print("\n===== JSON =====\n" + json.dumps(res, indent=2, default=lambda o: round(o,8) if isinstance(o,float) else o), flush=True)
try: cpp.stopApplication(True)
except Exception: pass
print("done", flush=True)
