"""dev-pedal1 live checks against a backend on a spare port (realtime, ASIO, low volume): smoke load, pedal REST,
moving-pedal cycle stats, /rig/preset_add_thump. Usage: python dev-pedal1-live.py [base_url] [--load path] [--notes]"""
import json
import math
import os
import shutil
import sys
import time
import urllib.error
import urllib.request

BASE = 'http://127.0.0.1:5012'
PRESETS = r'D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\presets'


def call(path, body=None, timeout=240):
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:300]


def load(path, iters, array, audio):
    t = time.time()
    code, body = call('/load_preset', {'path': path, 'listen_to_midi': 0, 'midi_port': 0, 'use_simulation': 0, 'debug_mode': 0,
                                       'audio_driver_type': 4, 'cycle_iterations': 64, 'audio_buffer_size': 4, 'array_size': array,
                                       'sample_rate': 48, 'string_iterations': iters, 'volume': 20, 'audio_on': audio,
                                       'start_right_away': audio, 'listen_to_modes': 0, 'use_cuda': 1})
    print('load', path, code, round(time.time() - t, 1), str(body)[:160], flush=True)
    return code


def stats():
    code, s = call('/playback_stats')
    return s


def play(cmd, pitch, vel):
    return call('/play', {'pitch': pitch, 'velocity': vel, 'command': cmd, 'delay_ms': 0.0, 'source': 'midi'})


def pick(s):
    return {k: v for k, v in s.items() if isinstance(v, (int, float))} if isinstance(s, dict) else s


step = sys.argv[1]
if step == 'realtime':
    assert load('presets/F15_measured_20261030_belarusfit_thump_assistant_3.json', 16, 512, 1) == 200
    time.sleep(2)
    print('GET pedal', call('/get_parameter/pedal/all'), flush=True)
    print('set', call('/set_parameter/pedal/all', {'register_spread': 12}), flush=True)
    print('after set', call('/get_parameter/pedal/all')[1]['config'], flush=True)
    print('bad', call('/set_parameter/pedal/all', {'patch_width': 0.9}), flush=True)
    print('undo', str(call('/history/undo', {}))[:160], flush=True)
    print('after undo', call('/get_parameter/pedal/all')[1]['config'], flush=True)
    print('summary pedal', call('/preset/summary')[1]['model_parameters'].get('pedal', 'absent'), flush=True)
    notes = [36, 43, 48, 55, 60, 64, 67, 72, 76, 84]
    for q in notes:
        play(144, q, 30)
    time.sleep(1)
    s0 = stats()
    time.sleep(15)
    s1 = stats()
    t0 = time.time()
    n = 0
    while time.time() - t0 < 15:
        v = int(63.5 + 63.5 * math.sin(2 * math.pi * 0.5 * (time.time() - t0)))
        play(176, 64, v)
        time.sleep(0.008)
        n += 1
    wall = time.time() - t0
    s2 = stats()
    play(176, 64, 0)
    for q in notes:
        play(128, q, 0)
    print('sent', n, 'CC in', round(wall, 1), 's', flush=True)
    keys = sorted(set(pick(s0)) & set(pick(s2)))
    print('stats still', {k: (s0[k], s1[k]) for k in keys if s0[k] != s1[k]}, flush=True)
    print('stats moving', {k: (s1[k], s2[k]) for k in keys if s1[k] != s2[k]}, flush=True)
    print('health', str(call('/health')[1].get('audio_health'))[:400], flush=True)
elif step == 'moving':
    notes = [36, 43, 48, 55, 60, 64, 67, 72, 76, 84]
    play(176, 64, 127)
    for q in notes:
        play(144, q, 30)

    def snap():
        h = call('/health')[1]['audio_health']
        e = stats()['unified']
        return {'produce_timeouts': h['produce_timeouts'], 'recovery': h['recovery_count'], 'state': h['state'],
                'events': e['engine']['total_events_processed'], 'avg_ms': round(e['engine']['avg_event_latency_ms'], 3),
                'peak_buf': e['buffer']['peak_buffer_size']}
    a = snap()
    time.sleep(12)
    b = snap()
    t0 = time.time()
    n = 0
    while time.time() - t0 < 12:
        play(176, 64, int(63.5 + 63.5 * math.sin(2 * math.pi * 0.5 * (time.time() - t0))))
        n += 1
        time.sleep(0.006)
    w = time.time() - t0
    c = snap()
    play(176, 64, 0)
    for q in notes:
        play(128, q, 0)
    print('start', a, 'still', b, 'moving', c, 'CC/s', round(n / w, 1), flush=True)
elif step == 'old':
    for path, it, ar in (('presets/Tuning18-10-26ver1.json', 8, 512), ('presets/BaselinePreset1.json', 4, 384)):
        print(load(path, it, ar, 0))
        print(call('/get_parameter/pedal/all')[1]['config'] == call('/get_parameter/pedal/all')[1]['defaults'],
              call('/get_parameter/pedal/all')[1]['engine_supported'], flush=True)
elif step == 'thump':
    src, out = 'zz_pedal1_src', 'zz_pedal1_thump_out'
    shutil.copy(os.path.join(PRESETS, 'Tuning18-10-26ver1.json'), os.path.join(PRESETS, src + '.json'))
    before = os.path.getmtime(os.path.join(PRESETS, src + '.json'))
    print('POST', call('/rig/preset_add_thump', {'source': src, 'name': out}), flush=True)
    path = os.path.join(PRESETS, out + '.json')
    for _ in range(60):
        if os.path.exists(path):
            break
        time.sleep(1)
    time.sleep(1)
    print('jobs', str(call('/rig/runs?limit=1'))[:200], flush=True)
    print('exists', os.path.exists(path), os.path.getsize(path) if os.path.exists(path) else None, flush=True)
    if os.path.exists(path):
        d = json.load(open(path, encoding='utf-8'))
        print('thump', d['model_parameters'].get('thump'), d.get('thump_string'), flush=True)
    print('source untouched', os.path.getmtime(os.path.join(PRESETS, src + '.json')) == before, flush=True)
    print('second POST (must refuse overwrite)', call('/rig/preset_add_thump', {'source': src, 'name': out}), flush=True)
    time.sleep(3)
    print('size unchanged', os.path.getsize(path) if os.path.exists(path) else None, flush=True)
