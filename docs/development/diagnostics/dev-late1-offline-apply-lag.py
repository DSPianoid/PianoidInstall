"""dev-late1: does a parameter edit reach the VERY NEXT offline render? (engine stopped, ONE Pianoid)

Per class: alternate the parameter between v0 and v1 N times, ONE production offline render
(chartFunctions.play_note_offline_chart_function) after each edit. Applied => consecutive renders
differ (rel >> 1e-4) and each render matches the reference render of its own value; late => the
render equals the previous one. Also records the double-buffer state right before each render.
usage: python dev-late1-offline-apply-lag.py <core_dir> [preset] [out.json]
"""
import os, sys, json, time, numpy as np
core = sys.argv[1]; mw = os.path.join(core, 'pianoid_middleware'); os.chdir(mw); sys.path.insert(0, mw)
preset = sys.argv[2] if len(sys.argv) > 2 else 'presets/BaselinePreset1.json'
outp = sys.argv[3] if len(sys.argv) > 3 else None
import chartFunctions
from pianoid import initialize
PITCH = 60
p = initialize(preset, 48*128*3, string_iteration=8, array_size=512, sample_rate=48000, samples_in_cycle=64,
               buffer_size=4, audio_on=False, audio_driver_type=0, listen_to_modes=False, sound_derivative_order=2, volume=100)
pp = p.pianoid
pk = lambda *a, **kw: p.pack_for_interface(*a, **kw)[0]

def render():
    chartFunctions.play_note_offline_chart_function(p, pitch=PITCH, velocity=100, duration_ms=300)
    s = np.array(p.result.sound, dtype=np.float64)
    return s.reshape(-1)[: 48000]          # first second of the buffer (layout-independent comparison)

def rel(a, b):
    return float(np.linalg.norm(a - b) / max(np.linalg.norm(a), 1e-30))

# ---- per-class setters: set(k) with k in {0,1} writes value v_k ----
def string_cls(field, m):
    base = float(pk('string', pitches=[PITCH])[PITCH][field])
    return lambda k: p.update_parameter('string', {str(PITCH): {field: base * (m if k else 1.0)}}, pitches=[PITCH])

GAUSS_FIELD = os.environ.get('LATE1_GAUSS_FIELD', 'mu')
def gauss_cls(m):
    d0 = pk('gauss', pitches=[PITCH])[PITCH]          # {curve: {mu, sigma, volume, ...}} (base level)
    def s(k):
        d = {str(lv): {str(c): {kk: (vv * (m if k else 1.0) if kk == GAUSS_FIELD else vv) for kk, vv in cd.items()}
                       for c, cd in curves.items()} for lv, curves in d0.items()}   # {level: {curve: {...}}}
        p.update_parameter('gauss', {str(PITCH): d}, pitches=[PITCH])
    return s

def mode_cls(field, m, modes):
    rows = pk('mode', modes=modes)
    print('MODE-ROW', {k: type(v).__name__ for k, v in rows[modes[0]].items()} if isinstance(rows[modes[0]], dict) else rows[modes[0]], flush=True)
    def s(k):
        vals = {str(mo): {field: float(rows[mo][field]) * (m if k else 1.0)} for mo in modes}
        p.update_parameter('mode', vals, modes=modes)
    return s

def deck_cls(m):
    row = pk('feedin', pitches=[PITCH])[PITCH]
    return lambda k: p.update_parameter('feedin', {str(PITCH): [x * (m if k else 1.0) for x in row]}, pitches=[PITCH])

def volume_cls():
    return lambda k: p.set_volume_level(100 if k == 0 else 60)

def fbcoef_cls():
    c0 = float(p.get_deck_feedback_coefficient())
    return lambda k: p.set_deck_feedback_coefficient(c0 if k == 0 else c0 * 0.25)

CLASSES = {
    'string.tension': lambda: string_cls('tension', 1.10),
    'string.dispersion_damping': lambda: string_cls('dispersion_damping', 100.0),
    'gauss(excitation)': lambda: gauss_cls(1.5),
    'hammer.position': lambda: (lambda pos: (lambda k: p.update_parameter('hammer', {str(PITCH): {'position': pos * (1.3 if k else 1.0)}}, pitches=[PITCH])))(float(p.sm.pitches[PITCH].physics.hammer.pos_ratio)),
    'mode.frequency': lambda: mode_cls('frequency', 1.3, list(range(p.mp.num_modes))),
    'deck.feedin': lambda: deck_cls(5.0),
    'runtime.volume_level': volume_cls,
    'runtime.deck_feedback_coefficient': fbcoef_cls,
}
only = os.environ.get('LATE1_CLASSES')
N = int(os.environ.get('LATE1_N', '6'))
WAIT = os.environ.get('LATE1_WAIT') == '1'
results = {}
for name, mk in CLASSES.items():
    if only and name not in only.split(','):
        continue
    try:
        setter = mk()
        # reference renders: each value rendered TWICE, keep the second (settled) one
        setter(0); render(); ref0 = render()
        setter(1); render(); ref1 = render()
        sep = rel(ref0, ref1)
        seq = []
        for i in range(N):
            k = (i + 1) % 2          # starts from settled v0 -> v1, v0, v1 ...
            t0 = time.perf_counter(); setter(k); t1 = time.perf_counter()
            busy = bool(pp.isParameterUpdateInProgress())
            swap_ms = None
            if WAIT:                 # experiment: wait for the double buffer to go IDLE before rendering
                pp.waitForParameterUpdate(); swap_ms = round((time.perf_counter() - t1) * 1e3, 2)
            r = render()
            d_own = rel(ref1 if k else ref0, r); d_other = rel(ref0 if k else ref1, r)
            seq.append({'i': i, 'value': k, 'edit_ms': round((t1 - t0) * 1e3, 2), 'busy_before_render': busy, 'wait_ms': swap_ms,
                        'rel_to_own_ref': d_own, 'rel_to_other_ref': d_other,
                        'applied': d_own < 0.1 * sep, 'late': d_other < 0.1 * sep})
        setter(0); render()
        late = sum(s['late'] for s in seq)
        results[name] = {'ref_separation': sep, 'late': late, 'n': N, 'seq': seq}
        print(f"RESULT-CLASS {name}: sep={sep:.3g} late={late}/{N} busy={[s['busy_before_render'] for s in seq]} "
              f"applied={[s['applied'] for s in seq]}", flush=True)
    except Exception as e:
        import traceback; traceback.print_exc()
        results[name] = {'error': repr(e)}
        print(f"RESULT-CLASS {name}: ERROR {e!r}", flush=True)
print('RESULT', json.dumps({k: {kk: vv for kk, vv in v.items() if kk != 'seq'} for k, v in results.items()}))
if outp:
    json.dump(results, open(outp, 'w'), indent=1)
os._exit(0)
