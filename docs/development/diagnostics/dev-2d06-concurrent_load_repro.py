"""dev-2d06: reproduce / regress the concurrent /load_preset crash.

Fires N /load_preset requests at the SAME instant (threading.Barrier) at a running
backend, the way N open FE tabs auto-load the last preset on a backend (re)start,
then probes /health to see whether the backend process survived.

Usage:
  python dev-2d06-concurrent_load_repro.py [--url http://127.0.0.1:5000] [--n 4]
         [--preset presets/BaselinePreset1.json] [--mixed] [--rounds 1]

--mixed  makes every other request differ (array_size 384 vs 512) so a fixed backend
         must answer 409 for the non-identical ones instead of coalescing them.
Exit code 0 = backend alive after every round, 1 = backend died (connection refused).
"""
import argparse
import json
import threading
import time
import urllib.error
import urllib.request


def fe_default_body(preset, array_size=384):
    # = PianoidTunner useSettings DEFAULT_PRESET_LOAD_SETTINGS + path
    return {
        'path': preset, 'volume': 100, 'sample_rate': 48, 'string_iterations': 4,
        'number_of_modes': 64, 'use_simulation': 0, 'debug_mode': 0,
        'cycle_iterations': 64, 'start_right_away': 1, 'audio_on': 1,
        'listen_to_midi': 0, 'use_cuda': 1, 'audio_driver_type': 4,
        'audio_buffer_size': 4, 'array_size': array_size, 'listen_to_modes': 1,
        'sound_derivative_order': 1,
    }


def post(url, body, timeout=180):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b'{}'), time.time() - t0
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read() or b'{}')
        except Exception:
            payload = {}
        return e.code, payload, time.time() - t0
    except Exception as e:  # connection reset / refused = backend died mid-request
        return None, {'exception': f'{type(e).__name__}: {e}'}, time.time() - t0


def health(url):
    try:
        with urllib.request.urlopen(url + '/health', timeout=5) as r:
            d = json.loads(r.read())
            return d.get('status'), d.get('pianoid_loaded')
    except Exception as e:
        return f'DEAD ({type(e).__name__})', None


def one_round(url, n, preset, mixed):
    barrier = threading.Barrier(n)
    results = [None] * n

    def worker(i):
        body = fe_default_body(preset, 512 if (mixed and i % 2) else 384)
        barrier.wait()
        results[i] = post(url + '/load_preset', body)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    for i, (code, payload, dt) in enumerate(results):
        brief = {k: payload.get(k) for k in ('reinit', 'code', 'error', 'coalesced', 'exception') if k in payload}
        print(f'  req{i}: status={code} t={dt:5.1f}s {brief}')
    time.sleep(3)
    st = health(url)
    print(f'  /health after 3 s: status={st[0]} pianoid_loaded={st[1]}')
    return not str(st[0]).startswith('DEAD'), results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default='http://127.0.0.1:5000')
    ap.add_argument('--n', type=int, default=4)
    ap.add_argument('--preset', default='presets/BaselinePreset1.json')
    ap.add_argument('--mixed', action='store_true')
    ap.add_argument('--rounds', type=int, default=1)
    a = ap.parse_args()
    alive = True
    for r in range(a.rounds):
        print(f'round {r + 1}/{a.rounds}: {a.n} concurrent /load_preset ({"mixed" if a.mixed else "identical"} bodies)')
        ok, _ = one_round(a.url, a.n, a.preset, a.mixed)
        alive = alive and ok
        if not ok:
            break
    print('RESULT:', 'backend ALIVE' if alive else 'backend DIED')
    raise SystemExit(0 if alive else 1)


if __name__ == '__main__':
    main()
