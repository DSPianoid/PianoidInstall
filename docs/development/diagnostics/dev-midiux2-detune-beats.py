"""dev-midiux2: SILENT beat-rate check of the unison-detune controller target (string.detuning).

Against an ISOLATED backend started from the feature worktree on a spare port (default :5100, audio_on=0,
driver 0, volume 0): loads BaselinePreset1, maps a fresh control (CC 20 ch 1, injected through REST /play)
to "Unison detune" drive 0..2 cents on the measured keys only, and renders each key offline
(`note_playback`, the audio_off verification surface) three times: the preset's stored detune, the control
at 0 (0 c: every unison string at the key's tension) and at 127 (2 c between neighbouring strings).

Beat rate: the fundamental band (+-15 Hz) of the render is isolated by an FFT mask, its Hilbert envelope
is taken, the exponential decay is removed (a straight-line fit of the log envelope) and the strongest
envelope component in 0.15-6 Hz is the beat. Expected for 3 strings at 0 / c / ~2c cents: the
neighbour beat f0 (2^(c/1200) - 1) and its double (strings 1-3); at 0 c no beat at all (any line = the
coupling / mode structure, the reference). Nothing is stored: the mapping is removed at the end.

usage: <venv python> dev-midiux2-detune-beats.py [--base http://127.0.0.1:5100] [--pitches 72 84]
       [--duration-ms 4000] [--cents 2]
Prints a JSON report.
"""
import argparse
import base64
import io
import json
import math
import time
import urllib.error
import urllib.request
import wave

import numpy as np
from scipy.signal import hilbert

ap = argparse.ArgumentParser()
ap.add_argument('--base', default='http://127.0.0.1:5100')
ap.add_argument('--pitches', type=int, nargs='+', default=[72, 84])
ap.add_argument('--duration-ms', type=int, default=4000)
ap.add_argument('--cents', type=float, default=2.0)
ap.add_argument('--no-load', action='store_true', help='the backend already has the preset loaded')
args = ap.parse_args()
BASE = args.base
BEAT_MIN_DB = 3.0                                  # envelope ripple (p5-p95) below this = no beat
HDR = {'Content-Type': 'application/json', 'X-Pianoid-Source': 'rest'}
LOAD = {'path': 'presets/BaselinePreset1.json', 'listen_to_midi': 0, 'midi_port': 0, 'use_simulation': 0,
        'debug_mode': 0, 'audio_driver_type': 0, 'cycle_iterations': 64, 'audio_buffer_size': 4,
        'array_size': 384, 'sample_rate': 48, 'string_iterations': 4, 'volume': 100, 'audio_on': 0,
        'start_right_away': 1, 'listen_to_modes': 1, 'use_cuda': 1}


def call(method, path, body=None, timeout=300):
    req = urllib.request.Request(BASE + path, method=method, headers=HDR,
                                 data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'null')


def cc(number, value, channel=1):
    status, _ = call('POST', '/play', {'command': 0xB0 | (channel - 1), 'pitch': number, 'velocity': value})
    time.sleep(0.3)                       # the overlay worker applies within a tick (+ one swap)
    return status


def render(pitch):
    _s, d = call('POST', '/get_chart_test', {'chartType': 'note_playback', 'pitch': pitch, 'velocity': 100,
                                             'duration_ms': args.duration_ms})
    with wave.open(io.BytesIO(base64.b64decode(d['audio_data'][0]))) as w:   # a base64 WAV
        sr = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(float)
        x = x.reshape(-1, w.getnchannels())[:, 0]
    return x, sr


def analyse(x, sr, f_nominal):
    """{f0, beat_hz, beat_depth_db, envelope peaks} of the fundamental band of a render."""
    seg = x[int(0.15 * sr):]                       # skip the attack transient
    seg = seg - seg.mean()
    n = len(seg)
    spec = np.fft.rfft(seg * np.hanning(n))
    freqs = np.fft.rfftfreq(n, 1 / sr)
    lo, hi = f_nominal * 0.9, f_nominal * 1.1
    band = (freqs > lo) & (freqs < hi)
    k = int(np.argmax(np.abs(spec) * band))
    f0 = freqs[k]
    mask = (freqs > f0 - 15) & (freqs < f0 + 15)
    y = np.fft.irfft(np.fft.rfft(seg) * mask, n)
    env = np.abs(hilbert(y))
    step = max(1, sr // 200)                       # envelope at 200 Hz
    env = env[::step]
    t = np.arange(len(env)) * step / sr
    good = env > env.max() * 1e-4
    logenv = np.log(env[good])
    a, b = np.polyfit(t[good], logenv, 1)
    resid = logenv - (a * t[good] + b)
    m = 1 << 16
    es = np.abs(np.fft.rfft(resid * np.hanning(len(resid)), m))
    ef = np.fft.rfftfreq(m, step / sr)
    win = (ef >= 0.15) & (ef <= 6.0)
    order = np.argsort(es * win)[::-1]
    peaks = []
    for j in order:
        if not win[j] or any(abs(ef[j] - p) < 0.3 for p, _ in peaks):
            continue
        peaks.append((float(ef[j]), float(es[j])))
        if len(peaks) == 3:
            break
    depth_db = 20 * (np.percentile(resid, 95) - np.percentile(resid, 5)) / math.log(10)
    beating = peaks and depth_db > BEAT_MIN_DB          # a flat envelope has no beat, whatever its FFT peak
    return {'f0': float(f0), 'beat_hz': peaks[0][0] if beating else None,
            'envelope_peaks_hz': [round(p, 3) for p, _ in peaks],
            'ripple_db_p5_p95': round(float(depth_db), 2), 'decay_db_per_s': round(float(a) * 20 / math.log(10), 2)}


report = {'pitches': args.pitches, 'cents': args.cents, 'duration_ms': args.duration_ms}
if not args.no_load:
    status, d = call('POST', '/load_preset', LOAD, timeout=600)
    report['load'] = status
    time.sleep(2)
_s, d = call('GET', '/midi/controls')
if not any(c['name'] == 'Beat test' for c in d['controls']):
    report['control_add'] = call('POST', '/midi/controls',
                                 {'name': 'Beat test', 'source': {'type': 'cc', 'number': 20, 'channel': 1}})[0]
keys = [min(args.pitches), max(args.pitches)]
status, d = call('POST', '/midi/mappings', {'control': 'Beat test', 'name': 'beat test',
                                             'target': {'domain': 'string', 'param': 'detuning', 'keys': keys},
                                             'mode': 'drive', 'lo': 0.0, 'hi': args.cents, 'smooth_ms': 0})
report['mapping_add'] = status
mid = (d or {}).get('id')
results = {}
try:
    for p in args.pitches:
        f_nom = 440.0 * 2 ** ((p - 69) / 12)
        _s, sd = call('GET', f'/get_parameter/string/{p}')
        stored_offset = float(sd[str(p)].get('detuning', 0.0) or 0.0) if isinstance(sd, dict) else None
        r = {'nominal_hz': round(f_nom, 2), 'stored_offset': stored_offset,
             'stored_cents': None if stored_offset is None else round(600 * math.log2(1 + stored_offset), 3)}
        call('POST', f'/midi/mappings/{mid}/reset')         # stored detune
        time.sleep(0.3)
        r['stored'] = analyse(*render(p), f_nom)
        cc(20, 0)
        r['0c'] = analyse(*render(p), f_nom)
        cc(20, 127)
        r[f'{args.cents:g}c'] = analyse(*render(p), f_nom)
        f0 = r['0c']['f0']
        r['expected_beat_hz'] = {'neighbour': round(f0 * (2 ** (args.cents / 1200) - 1), 3),
                                 'outer': round(f0 * (math.sqrt(1 + 2 * (2 ** (args.cents / 600) - 1)) - 1), 3)}
        if r['stored_cents'] is not None:
            r['expected_beat_hz']['stored_neighbour'] = round(f0 * (2 ** (r['stored_cents'] / 1200) - 1), 3)
        results[str(p)] = r
finally:
    if mid:
        report['mapping_remove'] = call('DELETE', f'/midi/mappings/{mid}')[0]
report['results'] = results
print(json.dumps(report, indent=1))
