"""dev-1b6c rig acceptance: ASIO play_record sessions through the NEW REST API on real hardware.

In-process (no Flask port, same pattern as dev-19be): imports the WORKTREE middleware's
backendServer and drives it through app.test_client(); the engine binary comes from
--pyd-dir (worktree build, never installed). Rig: UMC1820, exciters Out 1-4, receivers
In 1-7, electrical loopback Out 5 -> In 8.

Usage (cwd = <worktree>/pianoid_middleware, venv python):
  python dev-1b6c-asio-session-acceptance.py --pyd-dir D:/scratch/dev-1b6c/bin --out D:/scratch/dev-1b6c/acc
"""
import argparse
import json
import os
import sys
import threading
import time

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--pyd-dir', required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--repeats', type=int, default=3)
ap.add_argument('--preset', default='presets/BaselinePreset1.json')
ap.add_argument('--timing-runs', type=int, default=3)
args = ap.parse_args()

if args.pyd_dir != 'installed':
    sys.path.insert(0, args.pyd_dir)
import pianoidCuda  # noqa: E402
print('pianoidCuda from', pianoidCuda.__file__, 'session API:', hasattr(pianoidCuda, 'asio_play_record'))
sys.path.insert(0, os.getcwd())
import backendServer as B  # noqa: E402

C = B.app.test_client()
SR = 48000
DBFS = -30.0
AMP = 10 ** (DBFS / 20)
TONES = (200.0, 1000.0)
TONE_S, GAP_S = 1.0, 0.1
RECEIVERS = [f'In {i}' for i in range(1, 8)]
LOOP = {'output': 'Out 5', 'input': 'In 8'}
os.makedirs(args.out, exist_ok=True)
REPORT = {}
T0 = time.time()


def log(*a):
    print(f'{time.time() - T0:7.2f}s', *a, flush=True)


def health():
    return C.get('/health').get_json()


def load():
    body = {'path': args.preset, 'listen_to_midi': 0, 'midi_port': 0, 'use_simulation': 0,
            'debug_mode': 0, 'audio_driver_type': 4, 'cycle_iterations': 64,
            'audio_buffer_size': 4, 'array_size': 384, 'sample_rate': 48, 'string_iterations': 4,
            'volume': 100, 'audio_on': 1, 'start_right_away': 1, 'listen_to_modes': 1, 'use_cuda': 1}
    r = C.post('/load_preset', json=body)
    log('load_preset', r.status_code)
    for _ in range(80):
        h = health()
        if h.get('status') in ('healthy', 'degraded', 'error') and (h.get('lifecycle') or {}).get('main_loop_should_continue'):
            return h
        time.sleep(0.25)
    return health()


def play_peak(pitch=60, hold=0.8):
    C.post('/clear_limiting', json={})
    time.sleep(0.15)
    C.post('/play', json={'pitch': pitch, 'velocity': 110, 'command': 144})
    time.sleep(hold)
    C.post('/play', json={'pitch': pitch, 'velocity': 0, 'command': 128})
    return health().get('peak_level')


def timing(tag):
    cpp = B.pianoid.pianoid
    rows = []
    for i in range(args.timing_runs):
        cpp.resetCallbackStats()
        c0 = C.get('/playback_stats').get_json()['unified']['engine']['calibration_count']
        time.sleep(10.0)
        cb = cpp.getCallbackStats()
        c1 = C.get('/playback_stats').get_json()['unified']['engine']['calibration_count']
        ah = health().get('audio_health') or {}
        rows.append({'run': i + 1, 'callbacks': cb.callbackCount, 'cb_avg_us': round(cb.avgIntervalUs, 1),
                     'cb_max_us': round(cb.maxIntervalUs, 1), 'underruns': cb.underrunCount,
                     'cycles_per_s': round((c1 - c0) * 100 / 10.0, 1),
                     'produce_timeouts': ah.get('produce_timeouts')})
        log(tag, json.dumps(rows[-1]))
    REPORT['timing_' + tag] = rows


def tone_signal(n_out=1):
    """200 Hz then 1 kHz, each 1 s at -30 dBFS peak, 5 ms raised-cosine fades, 0.1 s gap."""
    seg = int(TONE_S * SR)
    fade = int(0.005 * SR)
    w = np.ones(seg)
    w[:fade] = 0.5 - 0.5 * np.cos(np.pi * np.arange(fade) / fade)
    w[-fade:] = w[:fade][::-1]
    t = np.arange(seg) / SR
    parts = []
    for f in TONES:
        parts += [AMP * w * np.sin(2 * np.pi * f * t), np.zeros(int(GAP_S * SR))]
    x = np.concatenate(parts).astype(np.float32)
    return np.repeat(x[:, None], n_out, axis=1)


def tone_windows(pre):
    """Analysis window (frames, raw capture timeline) per tone: skip 0.2 s, 0.6 s long."""
    seg, gap = int(TONE_S * SR), int(GAP_S * SR)
    out = {}
    for i, f in enumerate(TONES):
        start = pre + i * (seg + gap) + int(0.2 * SR)
        out[f] = (start, start + int(0.6 * SR))
    return out


def lockin(x, f, start, stop):
    """Amplitude (dBFS rms) + phase (deg) of tone f vs the emitted sine of the same window,
    referenced to the session timeline (frame index -> emitted phase)."""
    n = np.arange(start, stop)
    seg = np.asarray(x[start:stop], dtype=np.float64)
    ref_c = np.exp(-2j * np.pi * f * n / SR)
    z = 2 * np.mean(seg * ref_c)
    amp = abs(z)
    rms = amp / np.sqrt(2)
    return (20 * np.log10(rms) if rms > 0 else -300.0), np.degrees(np.angle(z))


def session(outputs, sig, tag, **extra):
    path = os.path.join(args.out, f'sig_{len(outputs)}ch.npy')
    np.save(path, sig)
    body = {'mode': 'play_record', 'outputs': outputs, 'inputs': RECEIVERS, 'loopback': LOOP,
            'signal': {'npy': path}, 'pre_roll_s': 0.1, 'post_roll_s': 0.3, 'tag': tag,
            'out_dir': os.path.join(args.out, tag)}
    body.update(extra)
    r = C.post('/audio/session', json=body)
    j = r.get_json()
    if r.status_code != 200:
        log('SESSION FAIL', tag, r.status_code, json.dumps(j)[:400])
        return None
    return j


def main():
    log('GET /audio/devices (no engine):', json.dumps(C.get('/audio/devices').get_json())[:300])
    h = load()
    log('health', h.get('status'), (h.get('audio_driver_fallback') or {}).get('active'))
    dev = C.get('/audio/devices').get_json()
    REPORT['devices'] = dev
    a = dev['asio']
    log('devices:', a['driver'], a['sample_rate'], a['buffer_size'], 'lat', a['input_latency'],
        a['output_latency'], 'rates', a['supported_sample_rates'], 'in', [c['name'] for c in a['inputs']][:8],
        'types', sorted({c['type_name'] for c in a['inputs'] + a['outputs']}))
    REPORT['play_peak_before'] = play_peak()
    log('p60 peak before', REPORT['play_peak_before'])
    timing('before')

    sig = tone_signal()
    pre = int(0.1 * SR)
    wins = tone_windows(pre)
    matrix = {}
    sync = {}
    for k in range(1, 5):
        out = f'Out {k}'
        reps = []
        for rep in range(args.repeats):
            j = session([out], sig, f'exc{k}_r{rep + 1}')
            if j is None:
                continue
            data = np.load(j['data_path'])
            names = [c['name'] for c in j['inputs']]
            row = {'loopback': j['loopback'], 'xruns': j['xruns'], 'switches': j['switches'],
                   'start_sample_position': j['start_sample_position'], 'synthesis': j['synthesis'],
                   'tones': {}}
            for f, (s0, s1) in wins.items():
                row['tones'][f] = {nm: lockin(data[:, ci], f, s0, s1) for ci, nm in enumerate(names)}
            reps.append(row)
            log(f'{out} r{rep + 1}: loop onset {j["loopback"].get("onset_frames")} peak '
                f'{j["loopback"].get("peak_frames")} xruns {j["xruns"]} paused/resumed '
                f'{j["synthesis"]["paused"]}/{bool(j["synthesis"]["resumed"])} '
                + ' '.join(f'{nm}:{row["tones"][1000.0][nm][0]:.1f}' for nm in names))
        matrix[out] = {f: {nm: round(float(np.mean([r['tones'][f][nm][0] for r in reps])), 2)
                           for nm in RECEIVERS + ['In 8']} for f in TONES}
        sync[out] = {
            'loopback_onsets': [r['loopback'].get('onset_frames') for r in reps],
            'loopback_peaks': [r['loopback'].get('peak_frames') for r in reps],
            'xruns': [r['xruns'] for r in reps],
            'phase_spread_deg': {f: {nm: round(float(np.ptp([r['tones'][f][nm][1] for r in reps])), 3)
                                     for nm in RECEIVERS} for f in TONES},
        }
    REPORT['matrix_dbfs_rms'] = matrix
    REPORT['sync'] = sync

    # Output isolation controls on the electrical loopback: the tone on Out 5 must reach
    # In 8; the tone on Out 6 (not patched) must not. (Marker loopback disabled here.)
    ctl = {}
    for out in ('Out 5', 'Out 6'):
        j = session([out], sig, f'ctl_{out.replace(" ", "")}', loopback=None, inputs=['In 8'])
        data = np.load(j['data_path'])
        ctl[out] = {f: round(lockin(data[:, 0], f, *wins[f])[0], 2) for f in TONES}
        log(f'control: tone on {out} -> In 8 {ctl[out]}')
    REPORT['isolation_controls_in8'] = ctl

    # record + play modes
    jr = C.post('/audio/session', json={'mode': 'record', 'inputs': RECEIVERS + ['In 8'], 'seconds': 1.0,
                                        'out_dir': os.path.join(args.out, 'record')}).get_json()
    REPORT['record_mode'] = {'status': jr.get('status'), 'levels': jr.get('levels')}
    log('record mode', jr.get('status'), jr.get('data_shape'))
    np.save(os.path.join(args.out, 'sig_play.npy'), sig[:, :1])
    jp = C.post('/audio/session', json={'mode': 'play', 'outputs': ['Out 5'],
                                        'signal': {'npy': os.path.join(args.out, 'sig_play.npy')},
                                        'out_dir': os.path.join(args.out, 'play')}).get_json()
    REPORT['play_mode'] = {'status': jp.get('status'), 'frames': jp.get('frames')}
    log('play mode', jp.get('status'))

    # Fault: kAsioResetRequest injected mid-session -> clean abort (502), watchdog recovers.
    def inject():
        time.sleep(0.5)
        log('inject reset_request ->', C.post('/debug/audio_fault', json={'kind': 'reset_request'}).status_code)
    th = threading.Thread(target=inject)
    th.start()
    np.save(os.path.join(args.out, 'sig_long.npy'), np.zeros((int(3 * SR), 1), np.float32))
    rf = C.post('/audio/session', json={'outputs': ['Out 6'], 'inputs': ['In 8'],
                                        'signal': {'npy': os.path.join(args.out, 'sig_long.npy')},
                                        'out_dir': os.path.join(args.out, 'fault')})
    th.join()
    jf = rf.get_json()
    REPORT['fault_abort'] = {'http': rf.status_code, 'code': jf.get('code'), 'error': jf.get('error'),
                             'synthesis': (jf.get('session') or {}).get('synthesis')}
    log('fault session ->', rf.status_code, jf.get('code'), jf.get('error'))
    for _ in range(40):
        ah = health().get('audio_health') or {}
        if ah.get('state') == 'ok' and (ah.get('recovery_count') or 0) >= 1:
            break
        time.sleep(0.25)
    h = health()
    REPORT['after_fault_health'] = {'status': h.get('status'), 'audio_state': (h.get('audio_health') or {}).get('state'),
                                    'recovery_count': (h.get('audio_health') or {}).get('recovery_count'),
                                    'main_loop': (h.get('lifecycle') or {}).get('main_loop_should_continue')}
    log('after fault health', REPORT['after_fault_health'])
    j = session(['Out 1'], sig, 'post_fault_exc1')
    REPORT['post_fault_session'] = None if j is None else {'status': j['status'], 'loop_onset': j['loopback'].get('onset_frames')}
    log('post-fault session', REPORT['post_fault_session'])

    # Legacy mic capture (startMicCapture: input 0 = In 1) scale fix, same drive as Out 1 / 1 kHz.
    p = B.pianoid
    p.enter_calibration_mode(keep_audio=True)
    try:
        cpp = p.pianoid
        mono = tone_signal()[:, 0]
        # playRecordedAudio de-interleaves with the ENGINE channel count (preset sound
        # channels, 4 for BaselinePreset1), not 8 - a wrong stride plays at the wrong speed.
        nch = int(p.param_manager.mp.num_channels)
        inter = np.zeros((mono.size, nch), np.float32)
        inter[:, 0] = mono
        cpp.startMicCapture(int(mono.size / SR * 1000) + 600)
        cpp.playRecordedAudio(inter.reshape(-1).tolist(), float(2 ** 31 - 1))
        mic = np.asarray(cpp.stopMicCapture(), dtype=np.float64)
    finally:
        p.exit_calibration_mode()
    # find the 1 kHz segment by envelope (capture start is not frame-locked to the drive)
    lvl = {}
    for f in TONES:
        seg_db = []
        step = int(0.05 * SR)
        for s0 in range(0, mic.size - step, step):
            seg_db.append(lockin(mic, f, s0, s0 + step)[0])
        lvl[f] = round(float(np.max(seg_db)), 2) if seg_db else None
    REPORT['legacy_mic_capture_in1'] = {'samples': int(mic.size), 'peak_abs': float(np.max(np.abs(mic))) if mic.size else None,
                                       'tone_dbfs_rms_max_50ms': lvl,
                                       'session_in1_out1': {f: matrix['Out 1'][f]['In 1'] for f in TONES}}
    log('legacy mic capture In 1', REPORT['legacy_mic_capture_in1'])

    REPORT['play_peak_after'] = play_peak()
    log('p60 peak after', REPORT['play_peak_after'])
    timing('after')
    h = health()
    REPORT['final_health'] = {'status': h.get('status'), 'audio': (h.get('audio_health') or {}).get('state'),
                              'driver': (h.get('audio_driver_fallback') or {}).get('active')}


try:
    main()
finally:
    with open(os.path.join(args.out, 'report.json'), 'w') as f:
        json.dump(REPORT, f, indent=1, default=str)
    log('report ->', os.path.join(args.out, 'report.json'))
    try:
        B.pianoid.stop_playback()
    except Exception as e:
        print('stop_playback:', e)
