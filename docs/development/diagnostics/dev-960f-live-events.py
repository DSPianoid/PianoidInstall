"""dev-960f: live-server verification of the SSOT I1 state broadcast (a real backend process + a
real socket.io client, the transport the frontend uses).

Usage: python dev-960f-live-events.py [base_url]   (default http://127.0.0.1:5002)

Per step: perform ONE write (REST or WS), wait for the broadcast, print the received state events
and PASS/FAIL against the expected list; restores every edited value. Also checks the stream: seq
strictly increasing with no gaps, one event per write. Covers the preset LOAD kinds (full / hot /
structural-inplace) that the in-process integration test cannot run.
"""
import json
import sys
import time
import urllib.error
import urllib.request

import socketio

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5002"
EVENTS = ('state_changed', 'preset_changed', 'session_changed', 'domain_invalidated', 'engine_busy')
LOAD = {"path": "presets/BaselinePreset1.json", "listen_to_midi": 0, "use_simulation": 0,
        "debug_mode": 0, "audio_driver_type": 0, "cycle_iterations": 64, "audio_buffer_size": 4,
        "array_size": 384, "sample_rate": 48, "string_iterations": 4, "volume": 100,
        "audio_on": 0, "start_right_away": 0, "listen_to_modes": 1}

received = []
sio = socketio.Client()
for _name in EVENTS:
    sio.on(_name, (lambda n: lambda payload: received.append((n, payload)))(_name))


def call(method, path, body=None, headers=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")[:200]


def settle():
    time.sleep(0.25)            # > the 30 ms coalescing window + transport latency
    got = list(received)
    received.clear()
    return got


def label(evs):
    return [(n, p.get('domain') or p.get('kind') or p.get('phase')) for n, p in evs]


failures = []
all_events = []


def step(name, action, expected, check=None):
    settle()
    t0 = time.perf_counter()
    action()
    evs = settle()
    all_events.extend(evs)
    ok = label(evs) == expected and (check is None or check(evs))
    if not ok:
        failures.append(name)
    print(f"{'PASS' if ok else 'FAIL'}  {name:42s} {label(evs)}"
          f"{'' if ok else f'  expected {expected}'}  "
          f"src={[p['source'] for _, p in evs][:1]} seq={[p['seq'] for _, p in evs]}")
    return evs


sio.connect(BASE, transports=['websocket'])
H = {'X-Pianoid-Source': 'assistant', 'X-Pianoid-Client': 'live-check', 'X-Pianoid-Op': 'op-42'}

step('load_preset FULL (structural change)', lambda: call('POST', '/load_preset', dict(LOAD, listen_to_modes=0)),
     [('state_changed', 'output_level'), ('preset_changed', 'load_full')],
     lambda e: e[-1][1]['entry'].endswith('(working 1)'))
step('load_preset STRUCTURAL-INPLACE (string_iterations)', lambda: call('POST', '/load_preset', dict(LOAD, listen_to_modes=0, string_iterations=6)),
     [('state_changed', 'output_level'), ('preset_changed', 'load_structural')])
step('load_preset HOT (runtime feedback only)', lambda: call('POST', '/load_preset', dict(LOAD, listen_to_modes=0, string_iterations=6, feedback_coeff=1.1)),
     [('state_changed', 'runtime'), ('preset_changed', 'load_hot')])
step('load_preset FULL (back to the default body)', lambda: call('POST', '/load_preset', LOAD),
     [('state_changed', 'output_level'), ('preset_changed', 'load_full')])

row = call('GET', '/get_parameter/feedin/57')[1]['57']
step('REST feedin/57 (assistant headers)', lambda: call('POST', '/set_parameter/feedin/57', {'57': [v * 2 for v in row]}, H),
     [('state_changed', 'feedin')],
     lambda e: e[0][1]['keys'] == [57] and e[0][1]['source'] == {'kind': 'assistant', 'clientId': 'live-check', 'opId': 'op-42'}
     and e[0][1]['after']['57'] == [v * 2 for v in row])
step('REST feedin/57 restore', lambda: call('POST', '/set_parameter/feedin/57', {'57': row}), [('state_changed', 'feedin')])

m5 = call('GET', '/get_parameter/mode/5')[1]['5']
step('WS set_parameter mode/5 (+ack)', lambda: sio.call('set_parameter', {'parameter': 'mode', 'key': '5', 'values': {'5': {'frequency': m5['frequency'] * 1.02}}, 'clientId': 'tabX', 'opId': 'w1'}),
     [('state_changed', 'mode')], lambda e: e[0][1]['source'] == {'kind': 'ws', 'clientId': 'tabX', 'opId': 'w1'})
step('WS set_parameter mode/5 restore', lambda: sio.call('set_parameter', {'parameter': 'mode', 'key': '5', 'values': {'5': {'frequency': m5['frequency']}}}),
     [('state_changed', 'mode')])

mass = call('GET', '/excitation_energy')[1]['hammer_mass']['60']
step('REST /excitation_energy mass 60', lambda: call('POST', '/excitation_energy', {'hammer_mass': {'60': mass * 1.2}}),
     [('state_changed', 'excitation_energy')], lambda e: e[0][1]['keys'] == [60])
step('REST /excitation_energy restore', lambda: call('POST', '/excitation_energy', {'hammer_mass': {'60': mass}}),
     [('state_changed', 'excitation_energy')])
step('WS set_runtime_parameters feedback_coeff', lambda: sio.call('set_runtime_parameters', {'feedback_coeff': 1.0}),
     [('state_changed', 'runtime')])
step('REST set_fix_velocity', lambda: call('POST', '/set_fix_velocity', {'enabled': False, 'level': 64}),
     [('session_changed', 'fix_velocity')])
step('REST /midi/broadcast (generic session)', lambda: call('POST', '/midi/broadcast', {'enabled': False}),
     [('session_changed', 'midi')])
step('REST note_playback chart (transient)', lambda: call('POST', '/get_chart_test', {'chartType': 'note_playback', 'pitch': 60, 'velocity': 100, 'duration_ms': 200, 'display_length_ms': 200}),
     [('engine_busy', 'start'), ('engine_busy', 'end')])
active = call('GET', '/preset/list')[1]['active']
code, body = 0, None


def spawn():
    global code, body
    code, body = call('POST', '/preset/spawn_working_copy', {'source': active})


step('REST spawn working copy', spawn, [('preset_changed', 'spawn'), ('preset_changed', 'switch')])
step('REST switch back', lambda: call('POST', '/preset/switch', {'name': active}), [('preset_changed', 'switch')])
step('REST unload spawned', lambda: call('POST', '/preset/unload', {'name': body['name']}), [('preset_changed', 'unload')])
step('REST /set_mode_parameters retired', lambda: call('POST', '/set_mode_parameters', []), [],
     lambda e: True)

seqs = [p['seq'] for _, p in all_events]
gapless = seqs == list(range(seqs[0], seqs[0] + len(seqs))) if seqs else False
print(f"{'PASS' if gapless else 'FAIL'}  stream: {len(seqs)} events, seq {seqs[:1]}..{seqs[-1:]} strictly +1, no gaps")
if not gapless:
    failures.append('seq stream')
print("RESULT:", "ALL PASS" if not failures else f"FAILURES {failures}")
sio.disconnect()
sys.exit(1 if failures else 0)
