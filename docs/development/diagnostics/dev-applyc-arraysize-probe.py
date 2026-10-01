"""dev-applyc-arraysize probe: compare kernel-computed dev_parameters + string state
between reconstruct-512 (silent) and fresh-512 (sounds). No rebuild needed."""
import os, sys, gc, time
import numpy as np
MID = os.getcwd()
if MID not in sys.path:
    sys.path.insert(0, MID)
import pianoidCuda
from pianoid import initialize

SR, SPC, PITCH, VEL = 48000, 48, 60, 80
PRESET = "presets/Preset_test5.json"
POINT_PARAMETERS_NO = 32

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
    print(f"  [{label}] peak={peak:.3e}", flush=True)
    return peak

def probe(p, label, array_size, num_strings):
    """Dump kernel-computed routing slots from dev_parameters for the target string's array."""
    params = np.array(p.pianoid.getParameters(), dtype=np.float64)
    print(f"  [{label}] getParameters len={len(params)} expect={POINT_PARAMETERS_NO*array_size*num_strings}", flush=True)
    # find the string index for PITCH
    sidx = p.pianoid.getStringIndicesForPitch(PITCH)
    print(f"  [{label}] string indices for pitch {PITCH}: {sidx}", flush=True)
    if not sidx:
        return
    s0 = sidx[0]
    # which array block holds s0? blocks are num_strings_in_array strings each; dev_parameters is per-block.
    nsia = p.mp.num_strings_in_array if hasattr(p.mp,'num_strings_in_array') else 4
    # dev_parameters layout: [block * array_size * POINT_PARAMETERS_NO + slot*array_size + idx]
    # We don't know exact block mapping; instead summarize routing slots 11 (stringNo),13(isStem),
    # 24(channel_num) across ALL blocks to find where stringNo==s0 and whether isStem/channel set.
    P = params.reshape(-1, POINT_PARAMETERS_NO, array_size)  # (numBlocks, slot, idx)
    nb = P.shape[0]
    stringNo_slot = P[:, 11, :]
    isStem_slot = P[:, 13, :]
    chan_slot = P[:, 24, :]
    onMain_slot = P[:, 18, :]
    # find blocks where target string appears
    mask = (stringNo_slot == s0)
    blocks_with = np.unique(np.where(mask.any(axis=1))[0])
    print(f"  [{label}] numBlocks={nb}; blocks containing stringNo {s0}: {blocks_with.tolist()}", flush=True)
    for b in blocks_with[:1]:
        idxs = np.where(stringNo_slot[b]==s0)[0]
        print(f"    block {b}: stringNo={s0} at idx [{idxs.min()}..{idxs.max()}] count={len(idxs)} "
              f"isStem_sum={isStem_slot[b].sum():.0f} onMain_sum={onMain_slot[b][idxs].sum():.0f} "
              f"chan_uniq={np.unique(chan_slot[b]).tolist()[:6]}", flush=True)
    # global tension coefficient sanity (slot 0 = some coeff); just report nonzero fraction
    nz = np.count_nonzero(params)
    print(f"  [{label}] dev_parameters nonzero fraction={nz/len(params):.4f}", flush=True)

def main():
    print("=== FRESH 512 ===", flush=True)
    pf = initialize(PRESET, filterlen=48*128*3, string_iteration=4, array_size=512,
                    sample_rate=SR, samples_in_cycle=SPC, buffer_size=4,
                    max_volume=5e18, audio_on=False, audio_driver_type=0)
    render(pf, "fresh-512")
    probe(pf, "fresh-512", 512, pf.mp.num_strings if hasattr(pf.mp,'num_strings') else len(pf.pianoid.getParameters())//(POINT_PARAMETERS_NO*512))
    try: pf.pianoid.shutdownGpu()
    except Exception: pass
    del pf; settle()

    print("=== RECON 512 (384->reinit) ===", flush=True)
    pr = initialize(PRESET, filterlen=48*128*3, string_iteration=4, array_size=384,
                    sample_rate=SR, samples_in_cycle=SPC, buffer_size=4,
                    max_volume=5e18, audio_on=False, audio_driver_type=0)
    render(pr, "recon-base-384")
    settle()
    pr.reinitialize_cuda_engine({"array_size": 512})
    render(pr, "recon-512")
    probe(pr, "recon-512", 512, pr.mp.num_strings if hasattr(pr.mp,'num_strings') else len(pr.pianoid.getParameters())//(POINT_PARAMETERS_NO*512))
    try: pr.pianoid.shutdownGpu()
    except Exception: pass

if __name__ == "__main__":
    main()
