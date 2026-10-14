"""dev-fbcb (I2): count the backend's state events by source for a while (feedback-loop check).

A remote edit must cause ZERO writes from the open editor tabs (no event with source.kind 'fe'
other than the ones the test itself makes). Usage: python dev-fbcb-observer.py <seconds> [out.json]
"""
import collections
import json
import sys
import time

import socketio

DURATION = float(sys.argv[1]) if len(sys.argv) > 1 else 30
OUT = sys.argv[2] if len(sys.argv) > 2 else None
counts = collections.Counter()
events = []
sio = socketio.Client()
for name in ('state_changed', 'preset_changed', 'session_changed', 'domain_invalidated'):
    def handler(p, name=name):
        src = p.get('source', {})
        counts[(name, p.get('domain') or p.get('kind'), src.get('kind'), src.get('clientId'))] += 1
        events.append({'event': name, 'seq': p.get('seq'), 'domain': p.get('domain') or p.get('kind'),
                       'keys': p.get('keys'), 'source': src, 't': time.time()})
    sio.on(name, handler)
sio.connect('http://127.0.0.1:5000', transports=['websocket'])
time.sleep(DURATION)
sio.disconnect()
summary = [{'event': k[0], 'domain': k[1], 'source': k[2], 'clientId': k[3], 'n': n} for k, n in counts.items()]
print(json.dumps(summary, indent=1))
if OUT:
    json.dump({'summary': summary, 'events': events}, open(OUT, 'w'), indent=1)
