"""Probe string-state energy + mode displacements after a render to localize
where recon-512 goes silent: does the string move at all?"""
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

def render_and_probe(p, label, ncycles_to_event=120):
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
    # post-render string state energy (after full render the note has decayed somewhat
    # but with a struck note there should be residual energy)
    state = np.array(p.pianoid.getPianoidState(), dtype=np.float64)
    modes = np.array(p.pianoid.getModeDisplacements(), dtype=np.float64)
    print(f"  [{label}] peak={peak:.3e} | string_state: n={len(state)} "
          f"max_abs={np.max(np.abs(state)) if len(state) else 0:.3e} "
          f"energy={np.sum(state**2):.3e} nonzero={np.count_nonzero(state)}", flush=True)
    print(f"  [{label}] mode_disp: n={len(modes)} max_abs={np.max(np.abs(modes)) if len(modes) else 0:.3e} "
          f"nonzero={np.count_nonzero(modes)}", flush=True)
    # volume coeff check
    try:
        rp = p.pianoid.getRuntimeParameters()
        print(f"  [{label}] runtime: volume_level={rp.volume_level} center={rp.volume_center} "
              f"range={rp.volume_range} feedback={rp.deck_feedback_coefficient}", flush=True)
    except Exception as e:
        print(f"  [{label}] runtime read err {e}", flush=True)
    return peak

def main():
    print("=== FRESH 512 ===", flush=True)
    pf = initialize(PRESET, filterlen=48*128*3, string_iteration=4, array_size=512,
                    sample_rate=SR, samples_in_cycle=SPC, buffer_size=4,
                    max_volume=5e18, audio_on=False, audio_driver_type=0)
    render_and_probe(pf, "fresh-512")
    try: pf.pianoid.shutdownGpu()
    except Exception: pass
    del pf; settle()

    print("=== RECON 512 ===", flush=True)
    pr = initialize(PRESET, filterlen=48*128*3, string_iteration=4, array_size=384,
                    sample_rate=SR, samples_in_cycle=SPC, buffer_size=4,
                    max_volume=5e18, audio_on=False, audio_driver_type=0)
    render_and_probe(pr, "recon-base-384")
    settle()
    pr.reinitialize_cuda_engine({"array_size": 512})
    render_and_probe(pr, "recon-512")
    try: pr.pianoid.shutdownGpu()
    except Exception: pass

if __name__ == "__main__":
    main()
