"""dev-midiux: live check of the socket provisioning on the REAL "Pianoid" controller (user-approved
2026-11-05), through the LIVE backend's existing /controller routes.

The live backend runs the merged code, which has no /provision route yet, so this runs the branch's
controller_provision.provision / restore against an HTTP adapter whose get_input / inputs /
set_message / set_calibration are the live GET /controller/inputs/<i>, GET /controller,
POST /controller/inputs/<i>/message|calibration: the same SysEx the new route sends.

Steps: snapshot the whole device -> pick ONE switched-off, idle socket (never X12) -> provision it
(switch, no calibration: nothing to press) -> SAVE -> verify -> restore -> SAVE -> verify the device equals
the snapshot (every input + the link). Nothing is played; the CC goes nowhere (no mapping, no pedal).

Usage: python dev-midiux-device-check.py <core pianoid_middleware dir> [base=http://127.0.0.1:5000]
"""
import json
import sys
import urllib.request

sys.path.insert(0, sys.argv[1])
BASE = sys.argv[2] if len(sys.argv) > 2 else 'http://127.0.0.1:5000'

import controller_provision as cp  # noqa: E402


def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())


class LiveDevice:
    """The controller client's interface, over the live backend's routes."""

    def get_input(self, i):
        return call('GET', f'/controller/inputs/{i}')

    def inputs(self):
        return call('GET', '/controller')['inputs']

    def set_message(self, i, type_, message, number, channel, polarity):
        return call('POST', f'/controller/inputs/{i}/message',
                    {'type': type_, 'message': message, 'number': number, 'channel': channel, 'polarity': polarity})

    def set_calibration(self, i, curve, lo, mid, hi):
        return call('POST', f'/controller/inputs/{i}/calibration', {'curve': curve, 'min': lo, 'mid': mid, 'max': hi})


CONFIG = ('type', 'message', 'number', 'channel', 'polarity', 'curve', 'min', 'mid', 'max')


def config(st):
    return {d['index']: {k: d[k] for k in CONFIG} for d in st['inputs']}


def main():
    health = call('GET', '/health')['status']
    before = call('GET', '/controller')
    assert before['present'], 'no Pianoid controller'
    free = [d for d in before['inputs']
            if d['type'] == 'off' and d['presence'] == 'idle' and not d['connector'].startswith('X12')]
    assert free, 'no switched-off idle socket'
    i = free[-1]['index']
    controls = call('GET', '/midi/controls')['controls']
    dev = LiveDevice()
    out = cp.provision(dev, i, 'switch', controls)
    call('POST', '/controller/save')
    after_save = dev.get_input(i)
    restored = cp.restore(dev, out['previous'])
    call('POST', '/controller/save')
    final = call('GET', '/controller')
    report = {
        'health_before': health, 'health_after': call('GET', '/health')['status'],
        'socket': before['inputs'][i]['connector'], 'cc': out['number'],
        'previous': {k: out['previous'][k] for k in CONFIG},
        'provisioned_saved': {k: after_save[k] for k in CONFIG},
        'restored': {k: restored[k] for k in CONFIG},
        'device_equal_to_snapshot': config(final) == config(before) and final['link'] == before['link'],
        'x12_before': next({k: d[k] for k in CONFIG} for d in before['inputs'] if d['connector'].startswith('X12')),
        'x12_after': next({k: d[k] for k in CONFIG} for d in final['inputs'] if d['connector'].startswith('X12')),
    }
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
