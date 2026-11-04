"""dev-midictl: SILENT live check that a bow drive mapping reaches the engine (isolated backend, audio_on=0).

Pitch 60 is switched to the bow (POST /set_excitation_mode, restored at the end). The preset's default
mapping "Mod wheel" -> bow.force (drive 0..1) is moved with simulated CC 1 messages (REST /play). The bowed
note_playback offline render must change with the force: Generated Sound RMS at CC 1 = 0 vs 127, and the
same again at 0 (repeatable). The stored bow parameters (GET /get_parameter/bow/60) must not move.
usage: <venv python> dev-midictl-live-bow.py [--base http://127.0.0.1:5024]
"""
import argparse
import json
import time
import urllib.error
import urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('--base', default='http://127.0.0.1:5024')
BASE = ap.parse_args().base
HDR = {'Content-Type': 'application/json', 'X-Pianoid-Source': 'rest'}


def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, headers=HDR,
                                 data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'null')


def rms():
    _s, d = call('POST', '/get_chart_test', {'chartType': 'note_playback', 'pitch': 60, 'velocity': 100,
                                             'duration_ms': 600})
    return float(str(d['text_fields']['Generated Sound RMS']).split()[0])


def force(value):
    call('POST', '/play', {'command': 0xB0, 'pitch': 1, 'velocity': value})
    time.sleep(0.2)


out = {'set_bow': call('POST', '/set_excitation_mode', {'pitch': 60, 'mode': 'bow'})[0],
       'stored_before': call('GET', '/get_parameter/bow/60')[1]}
force(0)
out['rms_force0'] = rms()
force(127)
out['rms_force127'] = rms()
force(0)
out['rms_force0_again'] = rms()
out['stored_after'] = call('GET', '/get_parameter/bow/60')[1]
out['restore_hammer'] = call('POST', '/set_excitation_mode', {'pitch': 60, 'mode': 'hammer'})[0]
print(json.dumps(out, indent=1))
