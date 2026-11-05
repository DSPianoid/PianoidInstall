"""dev-midiux: cost of the Pianoid controller's config reads on the live link (read-only).

About 40 GET /controller (identify + LIST + GET_INPUT x inputs + link = 11 SysEx round trips) over
~20 s, rate ramped 2 -> 8 Hz, with GET /health sampled between them. Aborts at the first error, a 5xx
or a request slower than ABORT_S. Prints p50 / p95 of the whole GET and of /health. Writes nothing.

Usage: python dev-midiux-list-cost.py [base=http://127.0.0.1:5000]
"""
import json
import statistics
import sys
import time
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5000'
ABORT_S = 0.2
STAGES = [(2, 10), (4, 10), (8, 20)]          # (Hz, requests)


def get(path, timeout=2.0):
    t0 = time.perf_counter()
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        body = r.read()
        status = r.status
    return status, time.perf_counter() - t0, body


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))]


ctl, health, aborted = [], [], None
for hz, n in STAGES:
    for _ in range(n):
        start = time.perf_counter()
        try:
            status, dt, body = get('/controller')
        except Exception as exc:
            aborted = f'error {exc}'
            break
        if status >= 500 or not json.loads(body).get('present'):
            aborted = f'status {status} present={json.loads(body).get("present")}'
            break
        ctl.append(dt)
        if dt > ABORT_S:
            aborted = f'spike {dt * 1000:.0f} ms at {hz} Hz'
            break
        try:
            health.append(get('/health')[1])
        except Exception as exc:
            aborted = f'health error {exc}'
            break
        time.sleep(max(0.0, 1.0 / hz - (time.perf_counter() - start)))
    if aborted:
        break

ms = lambda xs, q: f'{pct(xs, q) * 1000:.1f}'
print(json.dumps({'controller_n': len(ctl), 'controller_p50_ms': ms(ctl, 0.5), 'controller_p95_ms': ms(ctl, 0.95),
                  'controller_max_ms': f'{max(ctl) * 1000:.1f}' if ctl else None,
                  'health_p50_ms': ms(health, 0.5), 'health_p95_ms': ms(health, 0.95),
                  'aborted': aborted, 'mean_ms': f'{statistics.mean(ctl) * 1000:.1f}' if ctl else None}))
