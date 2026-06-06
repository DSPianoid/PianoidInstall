"""dev-fbsl probe: does the feedback coefficient affect strings-mode output, and
is the dev-d52b output mask keeping output rows at 1.0?

Run: cd PianoidCore && .venv/Scripts/python ../docs/development/diagnostics/dev-fbsl-sc-coupling-probe.py
"""
import os, sys, time, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
CORE = os.path.abspath(os.path.join(HERE, "..", "..", "..", "PianoidCore"))
MW = os.path.join(CORE, "pianoid_middleware")
sys.path.insert(0, MW)
sys.path.insert(0, CORE)  # so `tests.conftest` resolves
os.chdir(MW)
import pianoidCuda
from pianoid import initialize
from tests.conftest import get_preset_path, SAMPLE_RATE, SAMPLES_PER_CYCLE

pw = initialize(get_preset_path("Preset_test5.json"), filterlen=48*128*3,
                string_iteration=4, array_size=384, sample_rate=SAMPLE_RATE,
                samples_in_cycle=SAMPLES_PER_CYCLE, buffer_size=4, max_volume=5e18,
                audio_on=False, audio_driver_type=0, listen_to_modes=False)

def rec():
    cpp = pw.pianoid
    eq = pianoidCuda.EventQueue(); e = pianoidCuda.PlaybackEvent()
    e.type = pianoidCuda.EventType.NOTE_ON; e.channel = 0; e.cycle_index = 0
    e.data = (60 << 8) | 80; eq.addEvent(e); eq.sortByCycle()
    c = pianoidCuda.PlaybackConfig(); c.audio_enabled = False; c.record_to_buffer = True
    c.max_duration_ms = 1000; c.sample_rate = SAMPLE_RATE; c.samples_per_cycle = SAMPLES_PER_CYCLE
    cpp.resetStringsState(); cpp.runSynthesisKernel(); cpp.clearRecords()
    s = cpp.runOfflinePlayback(eq, c)
    return np.array(cpp.getRecordedAudio(), dtype=np.float64), s.completed_successfully

# Inspect the output mask the engine holds (if a getter exists).
print("PROBE has pack_output_mask:", hasattr(pw.sm, "pack_output_mask"))
try:
    mask = pw.sm.pack_output_mask()
    mask = np.asarray(mask)
    print("PROBE mask shape:", mask.shape, "unique:", np.unique(mask)[:8],
          "n_output_rows(==1.0? depends on convention):", int(np.sum(mask == 1.0)),
          "n_zero:", int(np.sum(mask == 0.0)))
except Exception as ex:
    print("PROBE mask error:", ex)

pw.set_deck_feedback_coefficient(1.0); time.sleep(0.05)
a, ok1 = rec(); b, ok2 = rec()
print(f"PROBE two renders @1.0: ok={ok1},{ok2} len={len(a)},{len(b)} "
      f"same={np.allclose(a,b,atol=1e-12) if len(a)==len(b) else 'LENDIFF'} "
      f"maxd={float(np.max(np.abs(a-b))) if len(a)==len(b) else -1}")
for coeff in (0.0, 0.5, 2.0, 8.0):
    pw.set_deck_feedback_coefficient(coeff); time.sleep(0.05)
    c8, ok = rec()
    md = float(np.max(np.abs(c8 - b))) if len(c8) == len(b) else -1
    print(f"PROBE @{coeff}: ok={ok} len={len(c8)} rms={float(np.sqrt(np.mean(c8*c8))):.6f} "
          f"maxd_vs_1.0={md:.3e}")
pw.pianoid.shutdownGpu()
print("PROBE done")
