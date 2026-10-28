"""dev-late1: does a string-parameter edit reach the LIVE engine's derived per-point coefficients
(dev_parameters, written only by parameterKernel) while the realtime thread is running?

ONE Pianoid, DEBUG variant (PIANOID_USE_DEBUG=1, getParameters() needs PIANOID_DEBUG_DATA).
OnlinePlaybackEngine runs in a thread (audio_enabled=False -> free-running cycles; the realtime
loop/runSynthesisKernel path is the live one). Per trial: edit tension of PITCH -> sleep 1 s (the
swap has long landed and the engine has adopted the new pointers) -> read dev_parameters (A);
then processSustain(same value) [= any note/pedal event: raises new_notes_ind] -> sleep 0.3 s -> read (B).
Late-in-live <=> A unchanged vs before and B changed.
usage: python dev-late1-live-apply.py <core_dir>
"""
import os, sys, time, json, threading, numpy as np
os.environ['PIANOID_USE_DEBUG'] = '1'
core = sys.argv[1]; mw = os.path.join(core, 'pianoid_middleware'); os.chdir(mw); sys.path.insert(0, mw)
from pianoid import initialize
import pianoidCuda
PITCH = 60
p = initialize('presets/BaselinePreset1.json', 48*128*3, string_iteration=8, array_size=512, sample_rate=48000,
               samples_in_cycle=64, buffer_size=4, audio_on=False, audio_driver_type=0, listen_to_modes=False,
               sound_derivative_order=2, volume=100)
pp = p.pianoid
print('VARIANT', pianoidCuda.__name__, flush=True)
cfg = pianoidCuda.PlaybackConfig()
cfg.sample_rate = p.mp.sample_rate(); cfg.samples_per_cycle = p.mp.mode_iteration
cfg.audio_enabled = False; cfg.record_to_buffer = False; cfg.max_duration_ms = 0
eng = pianoidCuda.OnlinePlaybackEngine(); eng.initialize(pp, cfg)
rtb = pianoidCuda.RealTimeEventBuffer(); eng.setRealTimeBuffer(rtb)
th = threading.Thread(target=eng.run, daemon=True); th.start()
time.sleep(1.0)
print('ONLINE running', eng.isRunning(), flush=True)

def params():
    with p.cuda_lock:
        return np.array(pp.getParameters(), dtype=np.float64)

base = float(p.pack_for_interface('string', pitches=[PITCH])[0][PITCH]['tension'])
trials = []
for i, m in enumerate([1.10, 1.0, 1.10, 1.0, 1.10, 1.0]):
    before = params()
    t0 = time.perf_counter()
    p.update_parameter('string', {str(PITCH): {'tension': base * m}}, pitches=[PITCH])
    time.sleep(1.0)
    a = params()
    pp.processSustain(0)                  # any engine event that raises new_notes_ind (note / pedal)
    time.sleep(0.3)
    b = params()
    trials.append({'i': i, 'mult': m, 'changed_after_edit_1s': int(np.sum(a != before)),
                   'changed_after_next_event': int(np.sum(b != before))})
    print('TRIAL', trials[-1], flush=True)
eng.stop(); th.join(timeout=10)
late = sum(1 for t in trials if t['changed_after_edit_1s'] == 0 and t['changed_after_next_event'] > 0)
print('RESULT', json.dumps({'late_until_next_event': late, 'n': len(trials), 'trials': trials}))
os._exit(0)
