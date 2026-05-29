"""dev-cflfix — MINIMAL in-proc: does an UN-GATED destabilizing length edit blow up the engine?
ONE build, ONE bypass-apply, ONE short render. Bypasses the gate via update_pitch_physical_params_GRANULAR
(which set_params + uploads WITHOUT _raise_if_cfl_unstable) — works on any branch. Answers "is the gate NECESSARY".
Units match tests/conftest (sample_rate=48000 Hz, spc=64). NO fix.
"""
import sys, os, math
MW = r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware"
sys.path.insert(0, MW); os.chdir(MW)
import numpy as np, pianoidCuda
from pianoid import initialize
SR, SPC, P = 48000, 64, 62
pw = initialize(os.path.join("presets", "Belarus_8band_196modes.json"), filterlen=48*128*3,
                string_iteration=4, array_size=384, sample_rate=SR, samples_in_cycle=SPC,
                buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0)
cpp = pw.pianoid; pm = pw.param_manager
base_len = pw.sm.pitches[P].geometry.length
print(f"PRESET length pitch {P} = {base_len:.4f}")

def render(ms=200):
    eq = pianoidCuda.EventQueue()
    on = pianoidCuda.PlaybackEvent(); on.type = pianoidCuda.EventType.NOTE_ON
    on.channel = 0; on.cycle_index = 0; on.data = (P << 8) | 90; eq.addEvent(on); eq.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig(); cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.max_duration_ms = ms; cfg.sample_rate = SR; cfg.samples_per_cycle = SPC
    cpp.resetStringsState(); cpp.clearRecords(); cpp.runOfflinePlayback(eq, cfg)
    return np.array(cpp.getRecordedAudio(), dtype=np.float64)

def desc(a, tag):
    if a.size == 0: return f"{tag}: EMPTY"
    nan = int(np.sum(~np.isfinite(a))); fin = a[np.isfinite(a)]
    pk = float(np.max(np.abs(fin))) if fin.size else float('nan')
    return f"{tag}: n={a.size} nan/inf={nan} peak={pk:.4e}"

a0 = render(); print(desc(a0, "[baseline note-on, preset length]"))
DESTAB = round(base_len*0.1, 4)
print(f"\nBYPASS gate: update_pitch_physical_params_GRANULAR length={DESTAB} (NO gate), then render:")
pm.update_pitch_physical_params_GRANULAR(int(P), send_to_cuda=True, length=float(DESTAB))
a1 = render(); print(desc(a1, f"[UN-GATED length={DESTAB} render]"))
nan = int(np.sum(~np.isfinite(a1))); fin = a1[np.isfinite(a1)]
pk = float(np.max(np.abs(fin))) if fin.size else float('inf')
print(f"\n>>> {'ENGINE DESTABILIZED (NaN/Inf or blowup) — un-gated length edit BLOWS UP -> gate NECESSARY' if (nan>0 or pk>1e3) else 'engine finite at this length'}")
try: cpp.shutdownGpu()
except Exception: pass
print("DONE")
