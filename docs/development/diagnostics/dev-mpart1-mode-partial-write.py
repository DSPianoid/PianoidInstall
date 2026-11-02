"""dev-mpart1: partial key_no=all write -> model vs engine (REST, isolated backend, audio off).

usage: python dev-mpart1-mode-partial-write.py [base_url] [preset]
Loads the preset (audio_on 0, start_right_away 0), renders note_playback, sends a param.set
whose values cover only part of the key range for each branch, and reports: status, body,
how many keys changed in the model (GET), and the render delta vs the pre-edit render.
Run against dev (before) and the fix branch (after).
"""
import json
import sys

import numpy as np
import requests

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5017'
PRESET = sys.argv[2] if len(sys.argv) > 2 else 'presets/BaselinePreset1.json'


def get(param, key='all'):
    r = requests.get(f'{BASE}/get_parameter/{param}/{key}', timeout=120)
    r.raise_for_status()
    return {k: v for k, v in r.json().items() if str(k).isdigit()}


def post(param, key, values):
    r = requests.post(f'{BASE}/set_parameter/{param}/{key}', json=values, timeout=120)
    try:
        body = r.json()
    except ValueError:
        body = r.text
    return r.status_code, body


def render(pitch=60):
    out = []
    for _ in range(2):   # an edit lands at the next cycle boundary: keep the 2nd render
        r = requests.post(f'{BASE}/get_chart_test', json={'chartType': 'note_playback', 'pitch': pitch,
                          'velocity': 100, 'duration_ms': 400, 'display_length_ms': 400}, timeout=300)
        r.raise_for_status()
        out.append(np.asarray(r.json()['data'][0], dtype=float))
    return out[-1]


def rel(a, b):
    return float(np.abs(a - b).max() / np.abs(a).max())


def changed(before, after):
    return sorted(int(k) for k in before if before[k] != after.get(k))


def short(body):
    s = json.dumps(body) if not isinstance(body, str) else body
    return s[:220]


def main():
    r = requests.post(f'{BASE}/load_preset', json={
        'path': PRESET, 'audio_on': 0, 'start_right_away': 0, 'audio_driver_type': 0,
        'listen_to_midi': 0, 'use_simulation': 0, 'debug_mode': 0, 'cycle_iterations': 64,
        'audio_buffer_size': 4, 'array_size': 384, 'sample_rate': 48, 'string_iterations': 4,
        'volume': 100, 'listen_to_modes': 1, 'use_cuda': 1}, timeout=600)
    print('load_preset', r.status_code)
    res = {}
    base = render()
    noise = rel(base, render())
    res['render_noise'] = noise

    # 1. mode, key_no=all, values for the first 25 modes only (the reported bug)
    m0 = get('mode')
    part = {str(i): {'decrement': float(m0[str(i)]['decrement']) * 3.0} for i in range(25)}
    st, body = post('mode', 'all', part)
    m1 = get('mode')
    r1 = render()
    res['mode_all_partial'] = {'status': st, 'body': short(body), 'model_modes_changed': len(changed(m0, m1)),
                               'render_rel_vs_base': rel(base, r1)}
    # 2. mode, explicit range covering exactly the payload (must apply)
    st, body = post('mode', 'from0to24', part)
    m2 = get('mode')
    r2 = render()
    res['mode_range_complete'] = {'status': st, 'model_modes_changed': len(changed(m0, m2)),
                                  'render_rel_vs_base': rel(base, r2)}
    restore = {str(i): {'decrement': float(m0[str(i)]['decrement'])} for i in range(25)}
    res['mode_restore'] = post('mode', 'from0to24', restore)[0]

    # 3. feedin, key_no=from58to61 without 60 (atomic already; status shape)
    f0 = get('feedin', 'from58to61')
    row = [0.0] * len(f0['58'])
    st, body = post('feedin', 'from58to61', {'58': row, '59': row, '61': row})
    res['feedin_partial'] = {'status': st, 'body': short(body),
                             'model_rows_changed': len(changed(f0, get('feedin', 'from58to61')))}

    # 4. sound_channel_mask, 2 pitches, 2nd row has the wrong length
    s0 = get('sound_channel_mask', 'from59to60')
    n = len(s0['59'])
    st, body = post('sound_channel_mask', 'from59to60', {'59': [0.0] * n, '60': [0.0] * (n + 1)})
    res['sc_mask_bad_row'] = {'status': st, 'body': short(body),
                              'model_rows_changed': len(changed(s0, get('sound_channel_mask', 'from59to60')))}

    # 5. string, 2 pitches, 2nd value non-numeric (mid-loop failure after pitch 59 is written)
    g0 = get('string', 'from59to60')
    st, body = post('string', 'from59to60', {'59': {'damper_string': float(g0['59']['damper_string']) * 2},
                                             '60': {'damper_string': 'abc'}})
    res['string_bad_value'] = {'status': st, 'body': short(body),
                               'model_pitches_changed': len(changed(g0, get('string', 'from59to60')))}

    # 6. mode, 2 modes, 2nd value non-numeric
    m3 = get('mode')
    st, body = post('mode', 'from0to1', {'0': {'decrement': float(m3['0']['decrement']) * 2},
                                         '1': {'decrement': 'abc'}})
    res['mode_bad_value'] = {'status': st, 'body': short(body),
                             'model_modes_changed': len(changed(m3, get('mode')))}
    print('RESULT', json.dumps(res, indent=1))


if __name__ == '__main__':
    main()
