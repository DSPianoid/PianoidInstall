"""dev-19be live verification: the 2026-10-08 device-loss incident, replayed.

POST /debug/audio_fault {"kind": "device_loss"} = the active ASIO callback stops + the
driver sends kAsioResetRequest + every ASIO open fails (like an unplugged UMC1820) until
{"kind": "device_return"}. Expected: watchdog recovery -> ASIO open fails -> SDL3 fallback,
/health degraded (audio_health.state "fallback"), events still drained, sound on SDL3;
/audio/reopen while absent keeps the fallback; after device_return /audio/reopen re-opens
ASIO -> healthy.

(The UMC1820 ASIO driver is multi-client, so a 2nd process holding the device does NOT
emulate absence — hence the hook.) In-process (app.test_client(), no port); run from
<worktree>/pianoid_middleware with the venv python:
  python dev-19be-asio-fallback-live.py --pyd-dir D:/tmp/19be/lib3
"""
import argparse
import json
import os
import sys
import time

ap = argparse.ArgumentParser()
ap.add_argument('--pyd-dir', required=True)
args = ap.parse_args()
if args.pyd_dir != 'installed':
    sys.path.insert(0, args.pyd_dir)
sys.path.insert(0, os.getcwd())
import backendServer as B  # noqa: E402

C = B.app.test_client()
T0 = time.time()
BODY = {'path': 'presets/BaselinePreset1.json', 'listen_to_midi': 0, 'midi_port': 0, 'use_simulation': 0,
        'debug_mode': 0, 'audio_driver_type': 4, 'cycle_iterations': 64, 'audio_buffer_size': 4,
        'array_size': 384, 'sample_rate': 48, 'string_iterations': 4, 'volume': 100, 'audio_on': 1,
        'start_right_away': 1, 'listen_to_modes': 1, 'use_cuda': 1}


def ts():
    return f'{time.time() - T0:7.2f}s'


def health():
    return C.get('/health').get_json()


def brief(h):
    a = h.get('audio_health') or {}
    fb = h.get('audio_driver_fallback') or {}
    return {'status': h.get('status'), 'message': h.get('message'), 'state': a.get('state'),
            'recoveries': a.get('recovery_count'), 'failures': a.get('recovery_failures'),
            'last_fault': a.get('last_fault'), 'last_recovery': a.get('last_recovery'),
            'fallback': fb.get('occurred'), 'active': fb.get('active'), 'alert': a.get('alert')}


def play_peak(pitch=60):
    C.post('/clear_limiting', json={})
    time.sleep(0.15)
    C.post('/play', json={'pitch': pitch, 'velocity': 110, 'command': 144})
    time.sleep(0.8)
    C.post('/play', json={'pitch': pitch, 'velocity': 0, 'command': 128})
    b = C.get('/playback_stats').get_json()['unified']['buffer']
    return health().get('peak_level'), (b['total_events_pushed'], b['total_events_drained'])


def timeline(seconds):
    seen, t = [], time.time()
    while time.time() - t < seconds:
        b = brief(health())
        row = (b['status'], b['state'], b['recoveries'], b['active'])
        if not seen or seen[-1][1:] != row:
            seen.append((round(time.time() - t, 2),) + row)
        time.sleep(0.05)
    return seen


def fault(kind, **kw):
    return C.post('/debug/audio_fault', json=dict(kind=kind, **kw)).get_json().get('result')


try:
    print(ts(), 'load_preset', C.post('/load_preset', json=BODY).status_code)
    time.sleep(2)
    print(ts(), 'after load', json.dumps(brief(health())))
    print(ts(), 'p60 on ASIO:', play_peak())

    print(ts(), 'INJECT device_loss:', fault('device_loss', duration_ms=3000))
    print(ts(), 'timeline (t, status, state, recoveries, active):', timeline(4))
    print(ts(), 'after device loss:', json.dumps(brief(health())))
    print(ts(), 'p60 on SDL3 fallback:', play_peak())

    print(ts(), 'POST /audio/reopen while absent:', C.post('/audio/reopen', json={'reason': 'still unplugged'}).status_code)
    time.sleep(2)
    print(ts(), 'after reopen (absent):', json.dumps(brief(health())))

    print(ts(), 'INJECT device_return:', fault('device_return'))
    print(ts(), 'POST /audio/reopen:', C.post('/audio/reopen', json={'reason': 'device reconnected'}).status_code)
    time.sleep(2)
    print(ts(), 'after reopen (returned):', json.dumps(brief(health())))
    print(ts(), 'p60 back on ASIO:', play_peak())
finally:
    try:
        fault('device_return')
        B.pianoid.stop_playback()
    except Exception as e:
        print('cleanup:', e)
    print(ts(), 'done')
    os._exit(0)
