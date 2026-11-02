"""dev-late1: wall time from an async TUNABLE upload returning to the double buffer going IDLE (engine stopped)."""
import os, sys, time, json, numpy as np
core = sys.argv[1]; mw = os.path.join(core, 'pianoid_middleware'); os.chdir(mw); sys.path.insert(0, mw)
from pianoid import initialize
p = initialize('presets/BaselinePreset1.json', 48*128*3, string_iteration=8, array_size=512, sample_rate=48000,
               samples_in_cycle=64, buffer_size=4, audio_on=False, audio_driver_type=0, listen_to_modes=False,
               sound_derivative_order=2, volume=100)
pp = p.pianoid
lat = []
for i in range(20):
    pp.waitForParameterUpdate()
    t0 = time.perf_counter()
    ok = pp.updateMultiStringParameter_NEW('tension', [10], [1000.0 + i])
    t1 = time.perf_counter()
    while pp.isParameterUpdateInProgress():
        pass
    t2 = time.perf_counter()
    lat.append(((t1 - t0) * 1e3, (t2 - t1) * 1e3))
a = np.array(lat)
print('RESULT', json.dumps({'call_ms_median': float(np.median(a[:, 0])), 'to_idle_ms_median': float(np.median(a[:, 1])),
                            'to_idle_ms_min': float(a[:, 1].min()), 'to_idle_ms_max': float(a[:, 1].max()),
                            'to_idle_ms': [round(x, 2) for x in a[:, 1]]}))
os._exit(0)
