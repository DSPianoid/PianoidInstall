"""Compare pack_parameters() between fresh-512 and recon-512 to find the divergence.
The brief claims byte-identical; the blocks vs blocks_pitches loader divergence says otherwise."""
import os, sys, gc, time
import numpy as np
MID = os.getcwd()
if MID not in sys.path:
    sys.path.insert(0, MID)
import pianoidCuda
from pianoid import initialize

SR, SPC = 48000, 48
PRESET = "presets/Preset_test5.json"

def settle():
    gc.collect()
    try:
        import cupy
        cupy.cuda.Stream.null.synchronize(); cupy.cuda.Device().synchronize()
    except Exception: pass
    time.sleep(0.2)

def pack_summary(p, label):
    (sip, s0, s1, gauss, phys, hammer, vol, exct_ci, dec_open, stringMap) = p.sm.pack_parameters()
    phys = np.asarray(phys, dtype=np.float64)
    sm = np.asarray(stringMap, dtype=np.int64)
    sip_a = np.asarray(sip, dtype=np.int64)
    PPN = len(phys) // p.mp.num_strings  # physical params per string
    print(f"\n[{label}] num_strings={p.mp.num_strings} nsia={p.mp.num_strings_in_array} "
          f"array_size={p.mp.array_size} PHYS_PER_STRING={PPN}", flush=True)
    print(f"  stringMap len={len(sm)} sum={sm.sum()} first16={sm[:16].tolist()}", flush=True)
    print(f"  strings_in_pitches len={len(sip_a)} sum={sip_a.sum()} nonzero={np.count_nonzero(sip_a)}", flush=True)
    print(f"  phys sum={phys.sum():.6e} nonzero={np.count_nonzero(phys)}", flush=True)
    # per-string slot dump: slot0=string_length_points, slot1=tail, slot7=dx, slot9=position_in_array, slot11=outer_sound
    Ph = phys.reshape(p.mp.num_strings, PPN)
    for s in (185,186,187):
        if s < p.mp.num_strings:
            r = Ph[s]
            print(f"  string {s}: len_pts={r[0]:.2f} tail={r[1]:.2f} dx={r[7]:.6e} pos_in_arr={r[9]:.2f} outer_sound={r[11]:.2f}", flush=True)
    return {"sm": sm, "phys": phys, "sip": sip_a, "ppn": PPN}

def main():
    print("=== FRESH 512 ===", flush=True)
    pf = initialize(PRESET, filterlen=48*128*3, string_iteration=4, array_size=512,
                    sample_rate=SR, samples_in_cycle=SPC, buffer_size=4,
                    max_volume=5e18, audio_on=False, audio_driver_type=0)
    f = pack_summary(pf, "fresh-512")
    try: pf.pianoid.shutdownGpu()
    except Exception: pass
    del pf; settle()

    print("\n=== RECON 512 ===", flush=True)
    pr = initialize(PRESET, filterlen=48*128*3, string_iteration=4, array_size=384,
                    sample_rate=SR, samples_in_cycle=SPC, buffer_size=4,
                    max_volume=5e18, audio_on=False, audio_driver_type=0)
    pack_summary(pr, "recon-base-384")
    settle()
    pr.reinitialize_cuda_engine({"array_size": 512})
    r = pack_summary(pr, "recon-512")
    try: pr.pianoid.shutdownGpu()
    except Exception: pass

    print("\n=== DIFF fresh-512 vs recon-512 ===", flush=True)
    if f["sm"].shape == r["sm"].shape:
        print(f"  stringMap identical? {np.array_equal(f['sm'], r['sm'])} "
              f"first_diff_idx={np.where(f['sm']!=r['sm'])[0][:8].tolist() if not np.array_equal(f['sm'],r['sm']) else 'NONE'}", flush=True)
    else:
        print(f"  stringMap SHAPE differs {f['sm'].shape} vs {r['sm'].shape}", flush=True)
    if f["phys"].shape == r["phys"].shape:
        d = np.abs(f["phys"]-r["phys"])
        print(f"  phys identical? {np.array_equal(f['phys'],r['phys'])} maxdiff={d.max():.6e} "
              f"ndiff={np.count_nonzero(d>1e-9)}", flush=True)
    else:
        print(f"  phys SHAPE differs {f['phys'].shape} vs {r['phys'].shape}", flush=True)
    if f["sip"].shape == r["sip"].shape:
        print(f"  strings_in_pitches identical? {np.array_equal(f['sip'],r['sip'])}", flush=True)

if __name__ == "__main__":
    main()
