"""dev-excenergy TASK B — recalibrate c so init-vol 100 (working slider) = the user's reasonable level.

OFFLINE ONLY, audio_off, NO speaker emission. Measures the ENGINE's ACTUAL output via the production
sint extractor result.load_sint_audio_from_kernel(mvc), mvc from pianoid.get_current_volume_coefficient()
— NOT a hand-computed raw*mvc, and the mvc is MEASURED at each init-vol (not assumed from a formula).

USER (team-lead TASK B): init-vol 100 is too loud; init-vol 1 gives a reasonable level but at max_volume=1
the slider is DEAD (mvc=1 regardless of slider). They want init-vol 100 (a WORKING slider) AT the
reasonable level, with room up/down.

PROCEDURE:
  1. Render Belarus p60 v127 at (init-vol 1,  slider 64, c=2.2e-05) -> X dBFS  (the reasonable level).
  2. Render at                (init-vol 100, slider 64, c=2.2e-05) -> too-loud level.
  3. amplitude is LINEAR in c, so new_c = c_old * X_int / (init100_int)  to make init-100 slider-64 == X.
  4. Apply new_c, re-render at init-vol 100 across sliders {32,64,96,127} to verify the slider spans a
     usable range (down=quieter, up->toward rail=louder, with headroom — no instant rail clip at 64).

Each init-vol = a SEPARATE engine init (max_volume is an init param). mvc read from the engine each time.

RUN: PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-excenergy-recalibrate-initvol100.py
"""
import os, sys, json, math

MW = r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware"
os.chdir(MW); sys.path.insert(0, MW)
import numpy as np
import pianoidCuda
from pianoid import initialize
from excitation_coefficients import upload_excitation_coefficients

SR, SPC = 48000, 64
R = 2**31 - 1
PRESET = os.path.join(MW, "presets", "Belarus_196modesC")
PITCH, VEL = 60, 127
C_OLD = 2.2e-05
RING_CYC = 90


def dbfs(x):
    return 20 * math.log10(x / R) if x > 0 else float("-inf")


def render_sint_peak(p, cpp, level, c=None):
    """Set slider level, optionally apply c (full upload), render, return (sint_peak, mvc, float_peak)."""
    if c is not None:
        p.mp.excitation_impulse_calibration = float(c)
        with p.cuda_lock:
            upload_excitation_coefficients(cpp, p.sm)
    p.set_volume_level(level)
    mvc = p.get_current_volume_coefficient()
    q = pianoidCuda.EventQueue()
    on = pianoidCuda.PlaybackEvent(); on.channel = 0; on.cycle_index = 1
    on.type = pianoidCuda.EventType.NOTE_ON; on.data = (PITCH << 8) | VEL; q.addEvent(on); q.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig(); cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.max_duration_ms = int(RING_CYC * SPC * 1000 / SR); cfg.sample_rate = SR; cfg.samples_per_cycle = SPC
    with p.cuda_lock:
        cpp.resetStringsState(); cpp.runSynthesisKernel(); cpp.clearRecords(); cpp.runOfflinePlayback(q, cfg)
    p.result.load_offline_sound_from_pianoid()
    fpk = float(np.max(np.abs(np.asarray(p.result.sound, np.float64)))) if p.result.sound.size else 0.0
    p.result.load_sint_audio_from_kernel(mvc)
    s = np.asarray(p.result.sint_sound, np.float64)
    spk = float(np.max(np.abs(s))) if s.size else 0.0
    return spk, mvc, fpk


def make(max_vol):
    p = initialize(PRESET, filterlen=48 * 128 * 3, string_iteration=12, array_size=384,
                   sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, max_volume=float(max_vol),
                   audio_on=False, audio_driver_type=0, start_right_away=0, listen_to_midi=0)
    return p, p.pianoid


print(f"=== TASK B recalibrate (OFFLINE, audio_off) Belarus p{PITCH} v{VEL} c_old={C_OLD} ===", flush=True)
print(f"    pianoidCuda: {pianoidCuda.__file__}  R={R}", flush=True)
res = {"c_old": C_OLD, "R": R}

# 1. init-vol 1, slider 64 -> reasonable level X
p1, c1 = make(1)
x_int, mvc1, x_f = render_sint_peak(p1, c1, 64)
print(f"\n  [init-vol 1,  slider 64, c={C_OLD}] mvc={mvc1:.4f}  sint peak={x_int:.4e} ({dbfs(x_int):.2f} dBFS)  <-- REASONABLE (X)", flush=True)
res.update({"initvol1_slider64_mvc": mvc1, "initvol1_slider64_int": x_int, "initvol1_slider64_dbfs": dbfs(x_int)})
try: c1.stopApplication(True)
except Exception: pass

# 2. init-vol 100, slider 64 -> too loud
p100, c100 = make(100)
loud_int, mvc100, loud_f = render_sint_peak(p100, c100, 64)
print(f"  [init-vol 100,slider 64, c={C_OLD}] mvc={mvc100:.4f}  sint peak={loud_int:.4e} ({dbfs(loud_int):.2f} dBFS)  <-- TOO LOUD", flush=True)
res.update({"initvol100_slider64_mvc": mvc100, "initvol100_slider64_int": loud_int, "initvol100_slider64_dbfs": dbfs(loud_int)})

gap_db = dbfs(loud_int) - dbfs(x_int)
print(f"\n  GAP: init-vol-100 is {gap_db:+.2f} dB louder than init-vol-1 (both slider 64)", flush=True)

# 3. solve new_c (amplitude linear in c): make init-100 slider-64 == X
new_c = C_OLD * (x_int / loud_int) if loud_int > 0 else float("nan")
print(f"  SOLVE: new_c = c_old * X/loud = {C_OLD} * {x_int:.3e}/{loud_int:.3e} = {new_c:.6g}", flush=True)
res.update({"gap_db": gap_db, "c_new": new_c})

# 4. apply new_c at init-vol 100, sweep slider to verify usable range
print(f"\n  [init-vol 100, c_new={new_c:.4g}] slider sweep (verify usable range):", flush=True)
sweep = {}
for lvl in (1, 32, 64, 96, 127):
    spk, mvc, fpk = render_sint_peak(p100, c100, lvl, c=(new_c if lvl == 1 else None))  # apply c once on first
    sweep[lvl] = {"mvc": mvc, "int": spk, "dbfs": dbfs(spk), "clips": spk >= R}
    print(f"    slider {lvl:3d}: mvc={mvc:8.4f}  sint peak={spk:.4e} ({dbfs(spk):7.2f} dBFS){'  CLIPS' if spk>=R else ''}", flush=True)
res["initvol100_cnew_sweep"] = {str(k): v for k, v in sweep.items()}

s64 = sweep[64]
print(f"\n  VERIFY: init-vol-100 slider-64 now {s64['dbfs']:.2f} dBFS (target X={dbfs(x_int):.2f}); "
      f"match={'OK' if abs(s64['dbfs']-dbfs(x_int))<0.3 else 'OFF'}", flush=True)
print(f"  range: slider 1 -> {sweep[1]['dbfs']:.1f} dBFS (quietest), slider 127 -> {sweep[127]['dbfs']:.1f} dBFS "
      f"({'clips' if sweep[127]['clips'] else 'headroom to rail'})", flush=True)
try: c100.stopApplication(True)
except Exception: pass

print("\n===== JSON =====\n" + json.dumps(res, indent=2,
      default=lambda o: round(o, 6) if isinstance(o, float) else o), flush=True)
print("done", flush=True)
