"""dev-psafe1 live verification of the parameter safety net on an ISOLATED backend (spare port, audio off).

Surface: the note_playback offline render (audio_off). Back-to-back renders of the same state differ by
~2e-4 relative (measured: max|diff| / max|x|), so "render unchanged" = within NOISE_X x the measured
render-to-render noise. For each bad write: HTTP 400 parameter_out_of_range, GET model value unchanged,
render unchanged (engine unchanged).
A good write: 200, GET changed, render changed; then restored. A bad preset load: 400, the loaded
preset keeps running (health + render unchanged).

Usage: python dev-psafe1-live-verify.py http://127.0.0.1:5017 <bad_preset_path>
"""
import json
import sys

import numpy as np
import urllib.error
import urllib.request

BASE = sys.argv[1]
BAD_PRESET = sys.argv[2]


def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return r.status, json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw.decode(errors='replace')[:300]


def render():
    s, r = call('POST', '/get_chart_test', {'chartType': 'note_playback', 'pitch': 60, 'velocity': 100,
                                             'duration_ms': 300, 'display_length_ms': 300})
    assert s == 200, (s, str(r)[:300])
    return np.asarray(r['data'][0], dtype=float)


NOISE_X = 5.0


def rel(a, b):
    return float(np.abs(a - b).max() / max(np.abs(b).max(), 1e-300))


def get(param, key):
    s, r = call('GET', f'/get_parameter/{param}/{key}')
    assert s == 200, (s, r)
    return r


results = []


def check(name, ok, detail=''):
    results.append((name, ok, detail))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''), flush=True)


base_render = render()
noise = max(rel(render(), base_render), rel(render(), base_render))
TOL = NOISE_X * noise
check('render noise floor measured', noise < 1e-2, f'rel noise {noise:.3g}, tolerance {TOL:.3g}')


def same():
    d = rel(render(), base_render)
    return d <= TOL, d

BAD = [
    ('mode/0', {'0': {'decrement': -1}}, 'mode', '0', 'decrement'),
    ('mode/0', {'0': {'frequency': 20000}}, 'mode', '0', 'frequency'),
    ('mode/0', {'0': {'mass_inv': 0}}, 'mode', '0', 'mass_inv'),
    ('string/60', {'60': {'gamma': -1}}, 'string', '60', 'gamma'),
    ('string/60', {'60': {'rho': 0}}, 'string', '60', 'rho'),
    ('string/60', {'60': {'tension': float('nan')}}, 'string', '60', 'tension'),
    ('gauss/60', {'60': {'31': {'0': {'sigma': 0}}}}, 'gauss', '60', 'sigma'),
    ('hammer/60', {'60': {'hammer_sharpness': 1}}, 'hammer', '60', 'hammer_sharpness'),
]
for url, body, gparam, gkey, field in BAD:
    before = get(gparam, gkey)
    s, r = call('POST', f'/set_parameter/{url}', json.loads(json.dumps(body).replace('NaN', '"nan"')))
    after = get(gparam, gkey)
    same_render, d = same()
    ok = (s == 400 and isinstance(r, dict) and r.get('error') == 'parameter_out_of_range'
          and r.get('field') == field and before == after and same_render)
    check(f'bad {url} {field}', ok, f"status={s} field={r.get('field') if isinstance(r, dict) else r} "
                                    f"model_same={before == after} render_rel_diff={d:.3g}")

s, r = call('POST', '/set_string_excitation/60', {'level': 31, 'curves': {'0': {'sigma': -1}}})
ok, d = same()
check('bad set_string_excitation sigma', s == 400 and r.get('field') == 'sigma' and ok, f'status={s} rel={d:.3g}')
s, r = call('POST', '/excitation_energy', {'hammer_speeds': [0, 0.3, 'nan', 1.8, 3.2, 5.5]})
ok, d = same()
check('bad excitation_energy NaN speed', s == 400 and r.get('field') == 'hammer_speeds.2' and ok, f'status={s} rel={d:.3g}')

# good write applies, then restore
g0 = get('string', '60')['60']['gamma']
s, _ = call('POST', '/set_parameter/string/60', {'60': {'gamma': g0 * 3}})
d_good = rel(render(), base_render)
check('good string gamma x3 applies', s == 200 and get('string', '60')['60']['gamma'] == g0 * 3
      and d_good > 10 * TOL, f'status={s} rel={d_good:.3g} (> 10 x tolerance)')
s, _ = call('POST', '/set_parameter/string/60', {'60': {'gamma': g0}})
ok, d = same()
check('restore gamma -> render back to baseline', s == 200 and ok, f'status={s} rel={d:.3g}')

# bad preset load: refused, engine keeps running the loaded preset
_, h0 = call('GET', '/health')
s, r = call('POST', '/load_preset', {'path': BAD_PRESET, 'sample_rate': 48000, 'string_iterations': 4,
                                      'samples_in_cycle': 64, 'array_size': 384, 'audio_on': 0,
                                      'start_right_away': 0, 'audio_driver_type': 0})
_, h1 = call('GET', '/health')
ok, d = same()
check('bad preset load refused, engine untouched',
      s == 400 and r.get('error') == 'parameter_out_of_range' and ok and h1.get('status') == h0.get('status'),
      f"status={s} field={r.get('field') if isinstance(r, dict) else r} mode={r.get('mode') if isinstance(r, dict) else ''} "
      f"render_rel={d:.3g} health_status {h0.get('status') if isinstance(h0, dict) else h0} -> {h1.get('status') if isinstance(h1, dict) else h1}")

print(json.dumps({'passed': sum(ok for _, ok, _ in results), 'total': len(results)}))
