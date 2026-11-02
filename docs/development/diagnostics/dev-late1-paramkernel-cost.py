"""dev-late1 (a) perf note: host wall time of a synthesis cycle that runs parameterKernel (new_notes_ind=1,
the path a swap-adoption cycle now takes) vs a plain cycle. Engine stopped, cycles driven by hand.
usage: python dev-late1-paramkernel-cost.py <core_dir> [array_size string_iteration]"""
import os, sys, time, json, numpy as np
core = sys.argv[1]; mw = os.path.join(core, 'pianoid_middleware'); os.chdir(mw); sys.path.insert(0, mw)
a = int(sys.argv[2]) if len(sys.argv) > 2 else 512; si = int(sys.argv[3]) if len(sys.argv) > 3 else 8
from pianoid import initialize
p = initialize('presets/BaselinePreset1.json', 48*128*3, string_iteration=si, array_size=a, sample_rate=48000,
               samples_in_cycle=64, buffer_size=4, audio_on=False, audio_driver_type=0, listen_to_modes=False,
               sound_derivative_order=2, volume=100)
pp = p.pianoid
for _ in range(200): pp.runSynthesisKernel()          # warm up
runs = []
for r in range(3):
    plain, withpk = [], []
    for i in range(1000):
        if i % 2: pp.processSustain(0)                 # raises new_notes_ind = 1 (cudaMemcpy outside timing)
        t0 = time.perf_counter(); pp.runSynthesisKernel(); dt = (time.perf_counter() - t0) * 1e3
        (withpk if i % 2 else plain).append(dt)
    runs.append({'plain_median_ms': float(np.median(plain)), 'pk_median_ms': float(np.median(withpk)),
                 'plain_p99_ms': float(np.percentile(plain, 99)), 'pk_p99_ms': float(np.percentile(withpk, 99))})
print('RESULT', json.dumps({'array_size': a, 'string_iteration': si, 'runs': runs}))
os._exit(0)
