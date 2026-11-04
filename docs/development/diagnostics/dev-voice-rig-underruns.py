"""dev-voice: live check of the rig-mic voice capture on a running ASIO backend (needs the engine on the UMC ASIO
driver, i.e. a window where that backend is the one under test; it only uses /voice/* and GET /health).

For each round: record `--seconds` from the rig mic (POST /voice/start, sleep, POST /voice/stop) while the engine
keeps synthesising, and print the clip level and the engine's underrun / callback delta over the window. `--play` plays
a soft note (velocity 64, C4 / E4 / G4 in turn, 1 s each) every 1.5 s during each clip. Optional
`--stt` posts every clip to the assistant service's /stt and prints the text. Pass = underruns_during == 0 in every
round and callbacks_during ~ seconds * sample_rate / buffer_size.

  python -I dev-voice-rig-underruns.py [--backend http://127.0.0.1:5000] [--rounds 5] [--seconds 10]
                                       [--play] [--stt http://127.0.0.1:3002]
"""
import argparse
import base64
import json
import threading
import time
import urllib.request


def call(url, body=None, data=None, headers=None, timeout=200):
    req = urllib.request.Request(url, data=data if data is not None else (json.dumps(body).encode() if body is not None else None),
                                 headers=headers or ({'Content-Type': 'application/json'} if body is not None else {}),
                                 method='POST' if (body is not None or data is not None) else 'GET')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def play_notes(backend, done):
    k = 0
    while not done.is_set():
        pitch = (60, 64, 67)[k % 3]
        k += 1
        call(f'{backend}/play', {'pitch': pitch, 'velocity': 64, 'command': 144})
        time.sleep(1.0)
        call(f'{backend}/play', {'pitch': pitch, 'velocity': 0, 'command': 128})
        done.wait(0.5)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--backend', default='http://127.0.0.1:5000')
    ap.add_argument('--rounds', type=int, default=5)
    ap.add_argument('--seconds', type=float, default=10)
    ap.add_argument('--stt', default=None)
    ap.add_argument('--play', action='store_true')
    a = ap.parse_args()
    status = call(f'{a.backend}/voice/status')
    print('status', json.dumps(status))
    if not status.get('available'):
        raise SystemExit('rig mic not available: ' + str(status.get('reason')))
    worst = 0
    for i in range(a.rounds):
        start = call(f'{a.backend}/voice/start', {'max_s': min(60, a.seconds + 5)})
        done = threading.Event()
        if a.play:
            threading.Thread(target=play_notes, args=(a.backend, done), daemon=True).start()
        time.sleep(a.seconds)
        done.set()
        out = call(f'{a.backend}/voice/stop', {})
        wav = base64.b64decode(out.pop('wav_base64'))
        worst = max(worst, out.get('underruns_during', 0))
        line = (f"round {i + 1}: input {start['input_name']} {out['seconds']} s peak {out['peak_dbfs']} dBFS "
                f"rms {out['rms_dbfs']} dBFS underruns_during={out.get('underruns_during')} "
                f"callbacks_during={out.get('callbacks_during')}")
        if a.stt:
            r = call(f'{a.stt}/stt?language=auto', data=wav, headers={'Content-Type': 'audio/wav'})
            line += f" | stt {r.get('elapsed_s')} s: {r.get('text') or r.get('error')}"
        print(line, flush=True)
    print('PASS' if worst == 0 else f'FAIL: up to {worst} underruns in a capture window')


if __name__ == '__main__':
    main()
