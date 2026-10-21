"""dev-6f0c live acceptance: hardware-style sustain pedal (CC64) + the backend MIDI player,
measured in the engine's ONLINE output ring (rawSoundBuffer, pre-volume, every channel).

In-process (no Flask port): imports the WORKTREE middleware's backendServer and drives it with
app.test_client(); the realtime engine runs on the real audio driver (ASIO callback), so the
cycle clock is the live one. Audio may be muted at the rig - everything is read from the ring.

Pedal / note bytes go through `Pianoid.schedule_event(status, data1, data2)` - the exact call
MIDI_listener_unified makes for every rtmidi message (no virtual MIDI port exists on this box:
winmm has none and loopMIDI is not installed), with raw status bytes on channels 3 / 5 / 10.

Usage (cwd = <wt-core>/pianoid_middleware, venv python):
  python dev-6f0c-sustain-player-live.py --out D:/scratch/dev-6f0c
"""
import argparse
import json
import os
import sys
import tempfile
import time

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--out', required=True)
ap.add_argument('--preset', default='presets/BaselinePreset1.json')
ap.add_argument('--pitch', type=int, default=60)
ap.add_argument('--only', choices=['all', 'half_sweep'], default='all')
args = ap.parse_args()

sys.path.insert(0, os.getcwd())
import backendServer as B  # noqa: E402
import mido  # noqa: E402

C = B.app.test_client()
os.makedirs(args.out, exist_ok=True)
REPORT = {}
T0 = time.time()
WIN_MS = 20


def log(*a):
    print(f'{time.time() - T0:7.2f}s', *a, flush=True)


def load():
    body = {'path': args.preset, 'listen_to_midi': 0, 'midi_port': 0, 'use_simulation': 0,
            'debug_mode': 0, 'audio_driver_type': 4, 'cycle_iterations': 64,
            'audio_buffer_size': 4, 'array_size': 384, 'sample_rate': 48, 'string_iterations': 4,
            'volume': 100, 'audio_on': 1, 'start_right_away': 1, 'listen_to_modes': 1, 'use_cuda': 1}
    r = C.post('/load_preset', json=body)
    log('load_preset', r.status_code)
    for _ in range(120):
        h = C.get('/health').get_json()
        if (h.get('lifecycle') or {}).get('main_loop_should_continue'):
            return h
        time.sleep(0.25)
    return C.get('/health').get_json()


def P():
    return B.pianoid


def ring():
    """(channels, samples) of the online ring since the last clearRecords()."""
    p = P()
    spc, nch = p.mp.mode_iteration, p.mp.num_channels
    raw = np.asarray(p.pianoid.getRawSoundRecord(), dtype=np.float64)
    cycles = raw.size // (spc * nch)
    return raw[:cycles * spc * nch].reshape(cycles, nch, spc).swapaxes(0, 1).reshape(nch, -1)


def envelope_db(sound, sr):
    """Peak |x| of the loudest channel per WIN_MS window, in dB re the run's peak."""
    ch = int(np.argmax(np.max(np.abs(sound), axis=1)))
    x = np.abs(sound[ch])
    n = int(sr * WIN_MS / 1000)
    w = x[:x.size // n * n].reshape(-1, n).max(axis=1)
    ref = max(w.max(), 1e-30)
    return 20 * np.log10(np.maximum(w, ref * 1e-6) / ref), ch, float(ref)


def level_at(env, t_ms):
    i = int(t_ms / WIN_MS)
    return round(float(env[min(i, env.size - 1)]), 1)


def slope(env, t0, t1):
    a, b = int(t0 / WIN_MS), int(t1 / WIN_MS)
    t = np.arange(a, b) * WIN_MS / 1000.0
    return round(float(np.polyfit(t, env[a:b], 1)[0]), 1)  # dB/s


def capture(events, window_s):
    """Clear the ring, schedule raw MIDI bytes at their delay, wait, read the ring."""
    p = P()
    p.pianoid.clearRecords()
    time.sleep(0.05)
    t_sched = time.time()
    results = [p.schedule_event(st, d1, d2, delay_ms=t) for t, st, d1, d2 in events]
    time.sleep(window_s - (time.time() - t_sched))
    return ring(), results


def pedal_scenarios():
    k = args.pitch
    sr = P().mp.sample_rate()
    sc = {
        'no_pedal_ch3': [(200, 0x92, k, 100), (700, 0x82, k, 0)],
        'pedal_full_ch3': [(100, 0xB2, 64, 127), (200, 0x92, k, 100), (700, 0x82, k, 0), (2500, 0xB2, 64, 0)],
        'half_pedal_64_ch3': [(100, 0xB2, 64, 64), (200, 0x92, k, 100), (700, 0x82, k, 0), (2500, 0xB2, 64, 0)],
        'pedal_ch5_notes_ch10': [(100, 0xB4, 64, 127), (200, 0x99, k, 100), (700, 0x89, k, 0), (2500, 0xB4, 64, 0)],
        'restrike_sustained': [(100, 0xB2, 64, 127), (200, 0x92, k, 100), (400, 0x82, k, 0),
                               (1500, 0x92, k, 100), (1700, 0x82, k, 0), (3000, 0xB2, 64, 0)],
        'key_held_pedal_up': [(100, 0xB2, 64, 127), (200, 0x92, k, 100), (1000, 0xB2, 64, 0), (2500, 0x82, k, 0)],
    }
    out = {}
    for name, events in sc.items():
        sound, accepted = capture(events, 4.0)
        env, ch, ref = envelope_db(sound, sr)
        out[name] = {
            'accepted': accepted, 'channel': ch, 'peak': ref, 'samples': int(sound.shape[1]),
            'db_at_ms': {t: level_at(env, t) for t in (600, 1000, 1400, 1800, 2200, 2400, 2700, 3000, 3400, 3800)},
            'slope_db_s_900_2300': slope(env, 900, 2300),
            'slope_db_s_2600_3400': slope(env, 2600, 3400),
        }
        np.save(os.path.join(args.out, f'env_{name}.npy'), env)
        log(name, json.dumps(out[name]))
    return out


def half_pedal_sweep():
    """Pedal value -> level after the key release (700 ms): where the continuous pedal bites."""
    k, sr, out = args.pitch, P().mp.sample_rate(), {}
    for value in (0, 32, 64, 96, 110, 118, 122, 125, 127):
        sound, _ = capture([(100, 0xB2, 64, value), (200, 0x92, k, 100), (700, 0x82, k, 0),
                            (2500, 0xB2, 64, 0)], 3.0)
        env, _, _ = envelope_db(sound, sr)
        out[value] = {'db_at_ms': {t: level_at(env, t) for t in (600, 800, 1000, 1400, 2000)},
                      'slope_db_s_900_2300': slope(env, 900, 2300)}
        log('half sweep', value, out[value])
    return out


def cycle_clock():
    est = P().online_engine.getCycleEstimator()
    c0, t0 = est.getCurrentCycle(), time.time()
    time.sleep(3.0)
    c1, t1 = est.getCurrentCycle(), time.time()
    measured = (t1 - t0) * 1000.0 / (c1 - c0)
    p = P()
    assumed = 1000.0 * p.mp.mode_iteration / p.mp.sample_rate()
    return {'ms_per_cycle_measured': round(measured, 4), 'ms_per_cycle_assumed': round(assumed, 4),
            'error_pct': round(100 * (measured - assumed) / assumed, 3)}


def metronome_file(ioi_ms, n=8, pitch=None):
    pitch = pitch or args.pitch
    mid = mido.MidiFile(type=0, ticks_per_beat=480)
    tr = mido.MidiTrack()
    tick = lambda ms: int(round(ms / (500 / 480)))  # 120 bpm
    last = 0
    for i in range(n):
        for ms, msg in ((i * ioi_ms, 'note_on'), (i * ioi_ms + 80, 'note_off')):
            t = tick(ms)
            tr.append(mido.Message(msg, note=pitch, velocity=100 if msg == 'note_on' else 0, time=t - last))
            last = t
    mid.tracks.append(tr)
    path = os.path.join(tempfile.gettempdir(), f'dev-6f0c-metronome-{ioi_ms}.mid')
    mid.save(path)
    return path


def onsets_ms(sound, sr, min_gap_ms):
    env, _, _ = envelope_db(sound, sr)
    rise = np.diff(env)
    idx, last = [], -10 ** 9
    for i in np.where((rise > 12) & (env[1:] > -30))[0]:
        if (i - last) * WIN_MS >= min_gap_ms:
            idx.append(i + 1)
            last = i
    return [i * WIN_MS for i in idx]


def player_post(path, body):
    r = C.post(f'/midi_player/{path}', json=body)
    return r.status_code, r.get_json()


def player_tests():
    sr = P().mp.sample_rate()
    out = {}
    # (1) timing: a metronome file at speed 1.0 and 1.5 -> inter-onset intervals in the ring
    for ioi, speed in ((400, 1.0), (400, 1.5)):
        st, s = player_post('load', {'path': metronome_file(ioi)})
        player_post('options', {'speed': speed, 'loop': False})
        P().pianoid.clearRecords()
        player_post('transport', {'action': 'play'})
        time.sleep(4.3)
        sound = ring()
        on = onsets_ms(sound, sr, 150)
        iois = np.diff(on)
        out[f'metronome_{ioi}ms_x{speed}'] = {
            'expected_ioi_ms': round(ioi / speed, 1), 'onsets_ms': on,
            'ioi_mean': round(float(iois.mean()), 1) if iois.size else None,
            'ioi_std': round(float(iois.std()), 2) if iois.size else None,
            'state_after': C.get('/midi_player/status').get_json()['state']}
        log('metronome', ioi, speed, out[f'metronome_{ioi}ms_x{speed}'])
    player_post('options', {'speed': 1.0})
    # (2) a real file: play, position advances with the engine clock, pause silences
    elise = os.path.join(os.getcwd(), 'MIDI_records', 'elise.mid')
    st, s = player_post('load', {'path': elise})
    out['elise_load'] = {'status': st, 'events': s['song']['events'], 'duration_ms': s['duration_ms'],
                         'tracks': [(t['name'], t['notes'], t['pedal_events']) for t in s['song']['tracks']]}
    player_post('seek', {'position_ms': 10000})
    P().pianoid.clearRecords()
    t_play = time.time()
    player_post('transport', {'action': 'play'})
    time.sleep(3.0)
    pos_play = C.get('/midi_player/status').get_json()['position_ms']
    wall = (time.time() - t_play) * 1000
    playing_sound = ring()
    st, s = player_post('transport', {'action': 'pause'})
    pos_pause = s['position_ms']
    P().pianoid.clearRecords()
    time.sleep(2.5)
    after = ring()
    peak_play = float(np.max(np.abs(playing_sound))) if playing_sound.size else 0.0
    w = int(sr * 0.2)
    tail = after[:, int(sr * 2.0):int(sr * 2.0) + w]
    out['elise_play_pause'] = {
        'position_advance_ms': round(pos_play - 10000, 1), 'wall_ms': round(wall, 1),
        'paused_at_ms': pos_pause, 'peak_while_playing': peak_play,
        'peak_2.0-2.2s_after_pause': float(np.max(np.abs(tail))) if tail.size else None,
        'tail_db_re_play': round(20 * np.log10(max(float(np.max(np.abs(tail))), 1e-30) / max(peak_play, 1e-30)), 1)
        if tail.size else None}
    log('elise play/pause', out['elise_play_pause'])
    # (3) resume continues from the paused position; speed 2x advances twice as fast
    player_post('options', {'speed': 2.0})
    player_post('transport', {'action': 'play'})
    t1 = time.time()
    time.sleep(2.0)
    s = C.get('/midi_player/status').get_json()
    out['elise_resume_x2'] = {'advance_ms': round(s['position_ms'] - pos_pause, 1),
                              'wall_ms': round((time.time() - t1) * 1000, 1), 'state': s['state']}
    player_post('transport', {'action': 'stop'})
    player_post('options', {'speed': 1.0})
    log('elise resume x2', out['elise_resume_x2'])
    try:
        stats = P().realtime_buffer.getStats()
        out['buffer_stats'] = {k: getattr(stats, k, None) for k in
                               ('total_events_pushed', 'total_events_drained', 'peak_buffer_size', 'dropped_event_count')}
    except Exception as e:
        out['buffer_stats'] = str(e)
    return out


def main():
    h = load()
    REPORT['health'] = {'status': h.get('status'), 'driver': (h.get('audio_driver_fallback') or {}).get('active')}
    log('health', REPORT['health'])
    REPORT['pitches_in_preset'] = args.pitch in P().get_all_pitches_in_preset(convert_to_notes=False)
    if args.only == 'half_sweep':
        REPORT['half_pedal_sweep'] = half_pedal_sweep()
        return
    REPORT['cycle_clock'] = cycle_clock()
    log('cycle clock', REPORT['cycle_clock'])
    REPORT['pedal'] = pedal_scenarios()
    REPORT['player'] = player_tests()


try:
    main()
finally:
    with open(os.path.join(args.out, 'report.json'), 'w') as f:
        json.dump(REPORT, f, indent=1, default=str)
    log('report ->', os.path.join(args.out, 'report.json'))
    try:
        B.app.blueprints['midi_player'].player.shutdown()
    except Exception as e:
        print('player shutdown:', e)
    try:
        B.pianoid.stop_playback()
    except Exception as e:
        print('stop_playback:', e)
