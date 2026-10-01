"""dev-applyc-arraysize minimal repro: reconstruct-512 silent vs fresh-512 sound.
Run from PianoidCore/pianoid_middleware with the venv python."""
import os, sys, gc, time
import numpy as np
MID = os.getcwd()
if MID not in sys.path:
    sys.path.insert(0, MID)
import pianoidCuda
from pianoid import initialize

SR, SPC, PITCH, VEL = 48000, 48, 60, 80
PRESET = "presets/Preset_test5.json"

def settle():
    gc.collect()
    try:
        import cupy
        cupy.cuda.Stream.null.synchronize(); cupy.cuda.Device().synchronize()
    except Exception: pass
    time.sleep(0.2)

def render(p, label):
    eq = pianoidCuda.EventQueue()
    ev = pianoidCuda.PlaybackEvent()
    ev.type = pianoidCuda.EventType.NOTE_ON; ev.channel = 0; ev.cycle_index = 100
    ev.data = (PITCH << 8) | VEL
    eq.addEvent(ev); eq.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.max_duration_ms = 1500; cfg.sample_rate = SR; cfg.samples_per_cycle = SPC
    p.pianoid.resetStringsState()
    st = p.pianoid.runOfflinePlayback(eq, cfg)
    snd = np.array(p.pianoid.getRecordedAudio(), dtype=np.float64)
    peak = float(np.max(np.abs(snd))) if len(snd) else 0.0
    print(f"  [{label}] ok={st.completed_successfully} peak={peak:.3e} n={len(snd)}", flush=True)
    return peak

def main():
    print("=== RECONSTRUCT path (384 -> reinit 512) ===", flush=True)
    p = initialize(PRESET, filterlen=48*128*3, string_iteration=4, array_size=384,
                   sample_rate=SR, samples_in_cycle=SPC, buffer_size=4,
                   max_volume=5e18, audio_on=False, audio_driver_type=0)
    render(p, "recon: base-384")
    settle()
    p.reinitialize_cuda_engine({"array_size": 512})
    print(f"  reinit done; array_size={p.mp.array_size}", flush=True)
    recon_peak = render(p, "recon: 512")
    try: p.pianoid.shutdownGpu()
    except Exception: pass
    del p; settle()

    print("=== FRESH path (init 512) ===", flush=True)
    p2 = initialize(PRESET, filterlen=48*128*3, string_iteration=4, array_size=512,
                    sample_rate=SR, samples_in_cycle=SPC, buffer_size=4,
                    max_volume=5e18, audio_on=False, audio_driver_type=0)
    fresh_peak = render(p2, "fresh: 512")
    try: p2.pianoid.shutdownGpu()
    except Exception: pass
    print(f"\nRESULT recon_512_peak={recon_peak:.3e} fresh_512_peak={fresh_peak:.3e} "
          f"BUG_REPRODUCED={recon_peak==0 and fresh_peak>0}", flush=True)

if __name__ == "__main__":
    main()
