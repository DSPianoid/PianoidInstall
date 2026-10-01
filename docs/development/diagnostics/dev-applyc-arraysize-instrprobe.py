"""Instrumented probe: dumps stringMapKernel's computed mode-channel routing
(via DEVAPPLYC_DUMP env) for fresh-512 vs recon-512."""
import os, sys, gc, time
import numpy as np
MID = os.getcwd()
if MID not in sys.path: sys.path.insert(0, MID)
import pianoidCuda
from pianoid import initialize
SR, SPC, PITCH, VEL = 48000, 48, 60, 80
PRESET = "presets/Preset_test5.json"
def settle():
    gc.collect()
    try:
        import cupy; cupy.cuda.Stream.null.synchronize(); cupy.cuda.Device().synchronize()
    except Exception: pass
    time.sleep(0.2)
def render(p,label):
    eq=pianoidCuda.EventQueue(); ev=pianoidCuda.PlaybackEvent()
    ev.type=pianoidCuda.EventType.NOTE_ON; ev.channel=0; ev.cycle_index=100; ev.data=(PITCH<<8)|VEL
    eq.addEvent(ev); eq.sortByCycle()
    cfg=pianoidCuda.PlaybackConfig(); cfg.audio_enabled=False; cfg.record_to_buffer=True
    cfg.max_duration_ms=1500; cfg.sample_rate=SR; cfg.samples_per_cycle=SPC
    p.pianoid.resetStringsState()
    st=p.pianoid.runOfflinePlayback(eq,cfg)
    snd=np.array(p.pianoid.getRecordedAudio(),dtype=np.float64)
    print(f"  [{label}] peak={np.max(np.abs(snd)) if len(snd) else 0:.3e}",flush=True)
print("=== FRESH 512 ===",flush=True)
pf=initialize(PRESET,filterlen=48*128*3,string_iteration=4,array_size=512,sample_rate=SR,samples_in_cycle=SPC,buffer_size=4,max_volume=5e18,audio_on=False,audio_driver_type=0)
render(pf,"fresh-512")
try: pf.pianoid.shutdownGpu()
except: pass
del pf; settle()
print("=== RECON 512 ===",flush=True)
pr=initialize(PRESET,filterlen=48*128*3,string_iteration=4,array_size=384,sample_rate=SR,samples_in_cycle=SPC,buffer_size=4,max_volume=5e18,audio_on=False,audio_driver_type=0)
render(pr,"recon-base-384")
settle()
pr.reinitialize_cuda_engine({"array_size":512})
render(pr,"recon-512")
try: pr.pianoid.shutdownGpu()
except: pass
