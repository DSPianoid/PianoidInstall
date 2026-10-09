"""dev-19be live verification: ASIO reset request / callback stall -> /health + recovery.

In-process (no Flask port): imports the WORKTREE middleware's backendServer and drives
it through app.test_client(), so the user's launcher/tab on :5000 is never touched.
The engine binary comes from --pyd-dir (a fresh worktree build, never installed) or,
with --pyd-dir installed, from the venv's site-packages (baseline).

Usage (cwd = <worktree>/pianoid_middleware, venv python):
  python dev-19be-asio-fault-live.py --pyd-dir D:/tmp/19be/lib --mode scenarios
  python dev-19be-asio-fault-live.py --pyd-dir installed --mode timing --runs 3
"""
import argparse
import json
import os
import sys
import time

ap = argparse.ArgumentParser()
ap.add_argument('--pyd-dir', required=True)
ap.add_argument('--mode', choices=['scenarios', 'timing'], required=True)
ap.add_argument('--runs', type=int, default=3)
ap.add_argument('--window-s', type=float, default=10.0)
ap.add_argument('--driver', type=int, default=4)
ap.add_argument('--preset', default='presets/BaselinePreset1.json')
args = ap.parse_args()

if args.pyd_dir != 'installed':
    sys.path.insert(0, args.pyd_dir)
import pianoidCuda  # noqa: E402
print('pianoidCuda from', pianoidCuda.__file__, 'has getAudioHealth:',
      hasattr(pianoidCuda.Pianoid, 'getAudioHealth') if hasattr(pianoidCuda, 'Pianoid') else '?')

sys.path.insert(0, os.getcwd())
import backendServer as B  # noqa: E402

C = B.app.test_client()
T0 = time.time()


def ts():
    return f'{time.time() - T0:7.2f}s'


def health():
    return C.get('/health').get_json()


def stats():
    b = C.get('/playback_stats').get_json().get('unified', {}).get('buffer', {})
    return b.get('total_events_pushed'), b.get('total_events_drained'), b.get('current_size')


def play_peak(pitch=60, hold=0.8):
    C.post('/clear_limiting', json={})
    time.sleep(0.15)
    C.post('/play', json={'pitch': pitch, 'velocity': 110, 'command': 144})
    time.sleep(hold)
    C.post('/play', json={'pitch': pitch, 'velocity': 0, 'command': 128})
    h = health()
    return h.get('peak_level'), stats()


def audio(h):
    a = h.get('audio_health') or {}
    return {k: a.get(k) for k in ('state', 'message', 'last_recovery', 'recovery_count',
                                  'recovery_failures', 'asio_reset_requests', 'produce_timeouts',
                                  'ms_since_last_callback', 'ms_since_last_cycle', 'alert')}


def load():
    # REST_API.md /load_preset default body (volume 100 = calibration base).
    body = {'path': args.preset, 'listen_to_midi': 0, 'midi_port': 0, 'use_simulation': 0,
            'debug_mode': 0, 'audio_driver_type': args.driver, 'cycle_iterations': 64,
            'audio_buffer_size': 4, 'array_size': 384, 'sample_rate': 48, 'string_iterations': 4,
            'volume': 100, 'audio_on': 1, 'start_right_away': 1, 'listen_to_modes': 1, 'use_cuda': 1}
    r = C.post('/load_preset', json=body)
    print(ts(), 'load_preset', r.status_code)
    for _ in range(60):
        h = health()
        if h.get('status') in ('healthy', 'degraded', 'error') and h['lifecycle'].get('main_loop_should_continue'):
            break
        time.sleep(0.5)
    time.sleep(1.5)
    h = health()
    print(ts(), 'after load:', h.get('status'), '| driver', h.get('audio_driver_fallback'))
    return h


def poll_until(pred, timeout_s, every=0.1, label=''):
    t = time.time()
    trace = []
    while time.time() - t < timeout_s:
        h = health()
        a = audio(h)
        trace.append((round(time.time() - t, 2), h.get('status'), a.get('state'), a.get('recovery_count')))
        if pred(h):
            return h, round(time.time() - t, 2), trace
        time.sleep(every)
    return None, None, trace


def compact(trace):
    out, last = [], None
    for row in trace:
        if row[1:] != last:
            out.append(row)
            last = row[1:]
    return out


def scenarios():
    h = load()
    print(ts(), 'baseline audio:', json.dumps(audio(h)))
    print(ts(), 'baseline play p60 -> peak, (pushed, drained, queued):', play_peak())

    # 1) Driver reset request through the REAL asioMessage handler.
    rc0 = audio(health()).get('recovery_count') or 0
    r = C.post('/debug/audio_fault', json={'kind': 'reset_request'}).get_json()
    print(ts(), 'INJECT reset_request:', r.get('result'))
    hr, dt, trace = poll_until(lambda h: (audio(h).get('recovery_count') or 0) > rc0
                               and audio(h).get('state') == 'ok', 10)
    print(ts(), f'reset_request recovered in {dt}s; trace', compact(trace))
    print(ts(), 'after reset recovery:', json.dumps(audio(hr or health())),
          '| fallback', (hr or health()).get('audio_driver_fallback'))
    print(ts(), 'post-reset play p60 -> peak, stats:', play_peak())

    # 2) Callback stall (device stops serving the ring) for 6 s.
    rc1 = audio(health()).get('recovery_count') or 0
    p0 = stats()
    r = C.post('/debug/audio_fault', json={'kind': 'stall', 'duration_ms': 6000}).get_json()
    t_inj = time.time()
    print(ts(), 'INJECT stall 6000 ms:', r.get('result'))
    time.sleep(0.3)
    C.post('/play', json={'pitch': 64, 'velocity': 100, 'command': 144})  # during the stall
    hd, dt_deg, trace1 = poll_until(lambda h: h.get('status') in ('degraded', 'error'), 5, every=0.05)
    print(ts(), f'/health degraded after {dt_deg}s (+0.3 s):', hd and hd.get('message'))
    print(ts(), '  audio_health at detection:', json.dumps(audio(hd)) if hd else None)
    hr2, dt_rec, trace2 = poll_until(lambda h: (audio(h).get('recovery_count') or 0) > rc1
                                     and audio(h).get('state') == 'ok' and h.get('status') == 'healthy', 15)
    print(ts(), f'stall recovered; healthy again {round(time.time() - t_inj, 2)}s after inject; trace',
          compact(trace1 + trace2))
    C.post('/play', json={'pitch': 64, 'velocity': 0, 'command': 128})
    print(ts(), 'events during stall: before', p0, 'after', stats())
    print(ts(), 'after stall recovery:', json.dumps(audio(hr2 or health())),
          '| fallback', (hr2 or health()).get('audio_driver_fallback'))
    print(ts(), 'post-stall play p60 -> peak, stats:', play_peak())

    # 3) Manual reopen endpoint.
    rc2 = audio(health()).get('recovery_count') or 0
    print(ts(), 'POST /audio/reopen:', C.post('/audio/reopen', json={'reason': 'live test'}).status_code)
    hm, dt_m, _ = poll_until(lambda h: (audio(h).get('recovery_count') or 0) > rc2, 10)
    print(ts(), f'manual reopen done in {dt_m}s:', json.dumps(audio(hm or health())))
    print(ts(), 'post-reopen play p60 -> peak, stats:', play_peak())


def timing():
    load()
    cpp = B.pianoid.pianoid
    for i in range(args.runs):
        cpp.resetCallbackStats()
        h0 = C.get('/playback_stats').get_json()['unified']['engine']['calibration_count']
        a0 = (audio(health()).get('produce_timeouts') or 0)
        time.sleep(args.window_s)
        cb = cpp.getCallbackStats()
        h1 = C.get('/playback_stats').get_json()['unified']['engine']['calibration_count']
        a1 = (audio(health()).get('produce_timeouts') or 0)
        cycles_per_s = (h1 - h0) * 100 / args.window_s  # calibration every 100 cycles
        print(json.dumps({'run': i + 1, 'callbacks': cb.callbackCount,
                          'cb_avg_us': round(cb.avgIntervalUs, 1), 'cb_max_us': round(cb.maxIntervalUs, 1),
                          'cb_std_us': round(cb.stdDevUs, 1), 'underruns': cb.underrunCount,
                          'cycles_per_s': round(cycles_per_s, 1), 'produce_timeouts': a1 - a0}))


try:
    scenarios() if args.mode == 'scenarios' else timing()
finally:
    try:
        B.pianoid.stop_playback()
    except Exception as e:
        print('stop_playback:', e)
    print(ts(), 'done')
    os._exit(0)
