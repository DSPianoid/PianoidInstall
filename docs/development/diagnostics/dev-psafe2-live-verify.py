"""dev-psafe2 live verification of the MUTABLE rule table on an ISOLATED backend (spare port, audio off,
PIANOID_PARAM_RULES pointing at a scratch overrides file, BaselinePreset1 loaded).

Rule under test: string.r (default r >= 0). r < 0 is numerically the same as |r| (r^4), so relaxing it is
harmless to the engine. Surface: HTTP status + rule id + the GET model value, plus the note_playback
render (bad write = render unchanged within NOISE_X x the render-to-render noise).

  phase1: bad write -> 400 naming string.r, model + render unchanged; PUT relax -> the same write is 200
          and lands; restore; reset -> rejected again; PUT relax again and leave it persisted (restart next)
  phase2: (after a backend restart) GET shows string.r overridden; the write is 200; restore; reset-all
          -> rejected again; PUT validation (min > max, NaN) -> 400; finite disabled -> warning; reset-all

Usage: python dev-psafe2-live-verify.py http://127.0.0.1:5012 phase1|phase2
"""
import json
import sys
import urllib.error
import urllib.request

import numpy as np

BASE, PHASE = sys.argv[1], sys.argv[2]
NOISE_X = 5.0
BAD = {'60': {'r': -0.0005}}
results = []


def call(method, path, body=None, raw=None):
    data = raw.encode() if raw is not None else (None if body is None else json.dumps(body).encode())
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return r.status, json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            return e.code, json.loads(body)
        except ValueError:
            return e.code, body.decode(errors='replace')[:300]


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''), flush=True)


def r60():
    s, body = call('GET', '/get_parameter/string/60')
    assert s == 200, (s, body)
    return body['60']['r']


def render():
    s, r = call('POST', '/get_chart_test', {'chartType': 'note_playback', 'pitch': 60, 'velocity': 100,
                                             'duration_ms': 300, 'display_length_ms': 300})
    assert s == 200, (s, str(r)[:300])
    return np.asarray(r['data'][0], dtype=float)


def rel(a, b):
    return float(np.abs(a - b).max() / max(np.abs(b).max(), 1e-300))


def write_bad():
    return call('POST', '/set_parameter/string/60', BAD)


def rejected(tag):
    before = r60()
    s, body = write_bad()
    check(f'{tag}: bad write 400 naming the rule', s == 400 and isinstance(body, dict)
          and body.get('rule') == 'string.r' and "rule 'string.r'" in body.get('message', '') and r60() == before,
          f"status={s} rule={body.get('rule') if isinstance(body, dict) else body} r {before} -> {r60()}")


def accepted(tag, r0):
    s, body = write_bad()
    check(f'{tag}: same write 200 and lands', s == 200 and r60() == -0.0005, f'status={s} r={r60()}')
    s, _ = call('POST', '/set_parameter/string/60', {'60': {'r': r0}})
    check(f'{tag}: restore r', s == 200 and r60() == r0, f'status={s} r={r60()}')


def relax():
    s, body = call('PUT', '/param_rules/string.r', {'min': -1.0})
    check('PUT relax string.r min -1', s == 200 and body['rule']['overridden'] and body['rule']['current']['min'] == -1.0,
          f'status={s}')


if PHASE == 'phase1':
    s, t = call('GET', '/param_rules')
    check('GET /param_rules', s == 200 and t['overridden'] == [] and len(t['rules']) > 80, f"{len(t['rules'])} rules")
    r0 = r60()
    base = render()
    noise = max(rel(render(), base), rel(render(), base))
    rejected('default')
    d = rel(render(), base)
    check('rejected write left the engine unchanged', d <= NOISE_X * noise, f'render rel {d:.3g} <= {NOISE_X * noise:.3g}')
    relax()
    accepted('relaxed', r0)
    s, body = call('POST', '/param_rules/string.r/reset')
    check('POST reset string.r', s == 200 and not body['rule']['overridden'], f'status={s}')
    rejected('after reset')
    relax()   # left persisted for the restart
    print('NOW restart the backend (same PIANOID_PARAM_RULES), reload the preset, then run phase2')
elif PHASE == 'phase2':
    s, t = call('GET', '/param_rules?id=string.r')
    rule = t['rules'][0]
    check('override survived the restart', s == 200 and rule['overridden'] and rule['current']['min'] == -1.0,
          f"current={rule['current']} default={rule['default']}")
    accepted('after restart', r60())
    s, t = call('POST', '/param_rules/reset')
    check('POST reset all', s == 200 and t['overridden'] == [], f'status={s}')
    rejected('after reset all')
    s, b = call('PUT', '/param_rules/string.r', {'min': 2, 'max': 1})
    check('PUT min > max -> 400', s == 400 and b.get('code') == 'invalid_rule_change', f'status={s} {b}')
    s, b = call('PUT', '/param_rules/string.r', raw='{"min": NaN}')
    check('PUT NaN bound -> 400', s == 400 and b.get('code') == 'invalid_rule_change', f'status={s}')
    s, b = call('PUT', '/param_rules/finite', {'enabled': False})
    check('disable finite -> warned', s == 200 and b['warnings'] and 'finite' in b['warnings'][0], f'{b.get("warnings")}')
    s, t = call('POST', '/param_rules/reset')
    check('reset all (clean)', s == 200 and t['overridden'] == [] and t['warnings'] == [], f'status={s}')

print(json.dumps({'phase': PHASE, 'passed': sum(ok for _, ok in results), 'total': len(results)}))
