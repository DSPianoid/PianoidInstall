"""dev-midictl: SILENT live check of the MIDI controls + mappings on an isolated backend (audio_on=0).

Drives the real Flask routes of a backend started from the feature worktree on a spare port (default
:5024, BaselinePreset1 loaded with audio_on=0) and measures the effect on the engine through its own
output: the `note_playback` offline render (the audio_off verification surface), f0 of pitch 60.
MIDI messages are injected through REST /play (command 176 = CC on channel 1), the same path WS / REST
MIDI bytes take into Pianoid.schedule_event -> ControllerMap.match; no hardware, nothing audible.

  1. learn a NEW control from a simulated CC 20
  2. a tension-scale mapping on it (0.95..1.05), move it to 127 -> live.applied = 1.05; f0 x sqrt(1.05)
  3. bake -> stored tension x 1.05, live factor back to 1, f0 unchanged; undo -> stored back, f0 baseline
  4. bow: a drive mapping (Mod wheel -> bow.force) and the velocity map (bow_settings readback)
Prints a JSON report. usage: <venv python> dev-midictl-live-check.py [--base http://127.0.0.1:5024]
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

ap = argparse.ArgumentParser()
ap.add_argument('--base', default='http://127.0.0.1:5024')
args = ap.parse_args()
BASE = args.base
HDR = {'Content-Type': 'application/json', 'X-Pianoid-Source': 'rest'}


def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, headers=HDR,
                                 data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'null')


def cc(number, value, channel=1):
    status, _ = call('POST', '/play', {'command': 0xB0 | (channel - 1), 'pitch': number, 'velocity': value})
    time.sleep(0.15)                       # the overlay worker applies within a tick (+ one swap)
    return status


def f0(pitch=60):
    """f0 (Hz) of a note_playback render: FFT peak (Hann, zero-padded) + parabolic interpolation."""
    _s, d = call('POST', '/get_chart_test', {'chartType': 'note_playback', 'pitch': pitch, 'velocity': 100,
                                             'duration_ms': 600})
    with wave.open(io.BytesIO(base64.b64decode(d['audio_data'][0]))) as w:   # a base64 WAV
        sr = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(float)
        x = x.reshape(-1, w.getnchannels())[:, 0]
    seg = x[int(0.1 * sr):int(0.6 * sr)]
    seg = seg - seg.mean()
    n = 1 << 20
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), n))
    lo, hi = int(150 * n / sr), int(600 * n / sr)        # C4 fundamental region
    k = lo + int(np.argmax(spec[lo:hi]))
    a, b, c = np.log(spec[k - 1:k + 2] + 1e-30)
    return (k + 0.5 * (a - c) / (a - 2 * b + c)) * sr / n


def mapping(mid):
    _s, d = call('GET', '/midi/mappings')
    return next(m for m in d['mappings'] if m['id'] == mid), d


def stored_tension(pitch=60):
    _s, d = call('GET', f'/get_parameter/string/{pitch}')
    return float(d[str(pitch)]['tension'])


report = {}
_s, d = call('GET', '/midi/mappings')
report['start'] = {'defaults': d['defaults'], 'controls': [c['name'] for c in d['controls']]}
report['f0_base'] = f0()
report['tension_base'] = stored_tension()

# 1. learn a new control
call('POST', '/midi/controls/learn', {'id': 'new'})
cc(20, 64)
_s, d = call('GET', '/midi/controls')
report['learned'] = [c for c in d['controls'] if c['source'].get('number') == 20]
name = report['learned'][0]['name']

# 2. tension scale
status, d = call('POST', '/midi/mappings', {'control': name, 'target': {'domain': 'string', 'param': 'tension'},
                                             'lo': 0.95, 'hi': 1.05, 'smooth_ms': 0})
report['mapping_add'] = status
mid = d.get('id')
cc(20, 127)
m, _ = mapping(mid)
report['live_after_cc127'] = m['live']
report['f0_scaled'] = f0()
report['f0_ratio_scaled'] = report['f0_scaled'] / report['f0_base']
report['f0_ratio_expected'] = math.sqrt(1.05)
report['tension_while_scaled'] = stored_tension()          # the stored value must not move

# 3. bake + undo
status, d = call('POST', f'/midi/mappings/{mid}/bake')
report['bake'] = {'status': status, 'baked': d.get('baked')}
m, _ = mapping(mid)
report['live_after_bake'] = m['live']
report['tension_after_bake'] = stored_tension()
report['f0_after_bake_ratio'] = f0() / report['f0_base']
status, d = call('POST', '/history/undo', {})
report['undo'] = status
report['tension_after_undo'] = stored_tension()
report['f0_after_undo_ratio'] = f0() / report['f0_base']

# 4. bow: drive + the velocity map
status, d = call('POST', '/midi/mappings', {'control': 'Mod wheel', 'target': {'domain': 'bow', 'param': 'force'},
                                             'mode': 'drive', 'lo': 0.0, 'hi': 1.0, 'smooth_ms': 0})
report['bow_mapping_add'] = status
bow_mid = d.get('id')
cc(1, 100)
m, _ = mapping(bow_mid)
report['bow_live'] = m['live']
_s, d = call('GET', '/get_parameter/bow_settings/all')
report['bow_engine_velocity'] = d.get('velocity')
status, d = call('POST', '/midi/mappings', {'control': 'velocity', 'target': {'domain': 'bow', 'param': 'force'},
                                             'mode': 'drive', 'lo': 0.2, 'hi': 0.8})
report['second_velocity_mapping'] = status                  # 400: one velocity mapping at a time
vel = next(m for m in mapping(bow_mid)[1]['mappings'] if m['control'] == 'velocity')
status, _d = call('POST', f"/midi/mappings/{vel['id']}", {'target': {'domain': 'bow', 'param': 'force'}})
report['velocity_to_force'] = status
time.sleep(0.2)
_s, d = call('GET', '/get_parameter/bow_settings/all')
report['bow_engine_velocity_after'] = d.get('velocity')

# cleanup: remove what this script added (undoable preset edits; the preset is not saved)
for x in (bow_mid, mid):
    if x:
        call('DELETE', f'/midi/mappings/{x}')
call('POST', f"/midi/mappings/{vel['id']}", {'target': {'domain': 'bow', 'param': 'speed'}})
print(json.dumps(report, indent=1))
