"""dev-midiux: GPU-free mock backend for the MIDI panel's Controls cards + Add-control wizard.

Runs the REAL controller routes (controller_routes: /midi/controls*, /midi/mappings*, the detect
session) over a real ControlTable (a temp midi_controls.json) and a real ControllerMap whose preset is
a fake Pianoid (mp.controller_mappings, edit_commit + undo journal as in the unit tests); the overlay
computes and broadcasts the live values (Socket.IO controllers_changed) but writes no engine.
Phase 2: the fake "Pianoid" controller of the unit tests (tests/unit/test_pianoid_controller.FakeDevice,
the SysEx protocol) behind the REAL /controller routes (status, calibration, stream, provision /
restore, save) and the detect session's socket reader (LIST).

Mock-only routes:
  POST /mock/midi   {"status", "d1", "d2", "port"}  one MIDI message through ControlTable.match
                    (the listener path); {"sweep": [values], "number", "channel", "port", "gap_ms"}
                    sends a CC sweep
  POST /mock/socket {"index", "raws": [...], "gap_ms"}  move the pedal in a socket: its raw ADC, and the
                    CC the device would send (calibrated position, when the socket is switched on)
  GET  /mock/device the fake device's config + raw + EEPROM saves
  GET  /preset/list, POST /preset/spawn_working_copy, POST /preset/switch   a 2-entry library
                    (original "Grand_A" read-only, its working copy)
Everything else: GET -> {} (the Tunner boots from it), POST logged.

Usage (PianoidCore venv):  python -u dev-midiux-mock-backend.py <core pianoid_middleware dir> [port=5090]
Point the page at it with the dev-2d06 URL rewrite (:5000|:5001|:3001 -> :<port>).
"""
import os
import sys
import tempfile
import threading
import time
from types import SimpleNamespace

MIDDLEWARE = sys.argv[1]
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 5090
sys.path.insert(0, MIDDLEWARE)

from flask import Flask, jsonify, request  # noqa: E402
from flask_cors import CORS  # noqa: E402
from flask_socketio import SocketIO  # noqa: E402

import controller_controls as cc  # noqa: E402
import controller_map as cm  # noqa: E402
import controller_overlay as co  # noqa: E402
from controller_routes import create_controller_blueprint  # noqa: E402
from pianoid_controller_routes import create_controller_blueprint as create_device_blueprint  # noqa: E402

sys.path.insert(0, os.path.join(MIDDLEWARE, '..', 'tests', 'unit'))
import test_pianoid_controller as tpc  # noqa: E402  (the fake device of the unit tests)

app = Flask(__name__)
CORS(app)
sio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")
emit = lambda event, payload: sio.emit(event, payload)  # noqa: E731

LIBRARY = [{'name': 'Grand_A', 'kind': 'original'}]
STATE = {'active': 'Grand_A (working 1)'}
LIBRARY.append({'name': 'Grand_A (working 1)', 'kind': 'working'})


class FakePianoid(SimpleNamespace):
    def _assert_active_editable(self):
        entry = next((p for p in LIBRARY if p['name'] == STATE['active']), None)
        if entry is None or entry['kind'] != 'working':
            from preset_library import PresetReadOnlyError
            raise PresetReadOnlyError(STATE['active'])

    def note_level_edit(self, kind, keys=None):
        pass

    def get_active_preset(self):
        return STATE['active']


MAPPINGS = [
    {'id': 'm1', 'control': 'velocity', 'target': {'domain': 'bow', 'param': 'speed', 'keys': None},
     'mode': 'drive', 'lo': 0.0, 'hi': 1.0, 'smooth_ms': 0.0, 'name': 'Bow speed'},
    {'id': 'm2', 'control': 'Mod wheel', 'target': {'domain': 'bow', 'param': 'force', 'keys': None},
     'mode': 'drive', 'lo': 0.0, 'hi': 1.0, 'smooth_ms': 0.0, 'name': 'Bow force'},
    {'id': 'm3', 'control': 'Joystick X', 'target': {'domain': 'bow', 'param': 'tilt', 'keys': None},
     'mode': 'drive', 'lo': 0.0, 'hi': 1.0, 'smooth_ms': 0.0, 'name': 'Bow tilt'},
    {'id': 'm4', 'control': 'Pedal X9', 'target': {'domain': 'string', 'param': 'tension', 'keys': None},
     'mode': 'scale', 'lo': 0.94, 'hi': 1.06, 'name': 'String tension'},
    {'id': 'm5', 'control': 'Expression', 'target': {'domain': 'bow', 'param': 'position', 'keys': None},
     'mode': 'drive', 'lo': 0.5, 'hi': 3.0, 'name': 'Bow position'},
]
pw = FakePianoid(mp=SimpleNamespace(controller_mappings=[dict(m) for m in MAPPINGS]), sm=SimpleNamespace(pitches={}))

controls_path = os.path.join(tempfile.mkdtemp(prefix='dev-midiux-'), 'midi_controls.json')
table = cc.ControlTable(path=controls_path, seed=lambda: [
    {'name': 'Pedal X9', 'source': {'type': 'cc', 'number': 11, 'channel': 1, 'port': 'Pianoid'}},
    {'name': 'Mod wheel', 'source': {'type': 'cc', 'number': 1, 'channel': None, 'port': None}},
    {'name': 'Joystick X', 'source': {'type': 'cc', 'number': 16, 'channel': None, 'port': None}},
    {'name': 'Knob 1', 'source': {'type': 'cc', 'number': 21, 'channel': 1, 'port': 'Launchkey Mini'}},
])
cmap = cm.ControllerMap(table, lambda: pw)
cm._MAP = cmap
ov = co.ControllerOverlay(cmap, lambda: pw, emit=emit, admissible=lambda *a: True)
ov._apply = lambda target: None                      # no engine: values are computed + broadcast only
ov._compile_velocity = lambda: None
app.register_blueprint(create_controller_blueprint(cmap, ov, lambda: pw, emit))

DEVICE = tpc.FakeDevice()
DEVICE.raw = [1023, 1023, 320, 400, 1023, 1023, 1023, 1023]   # X12 sustain + X9 expression plugged in
DEVICE_CTL, _BUS = tpc.make(DEVICE)
app.register_blueprint(create_device_blueprint(DEVICE_CTL, controls=lambda: table.controls().values()))
table.detector.socket_reader = DEVICE_CTL.inputs
STREAM = {'input': None}                  # the real device streams the raw ADC every few ms
_receive = DEVICE.receive


def _device_receive(msg):
    if list(msg[:4]) == [0xF0, 0x7D, 0x10, 0x09]:
        STREAM['input'] = None if msg[4] == 0x7F else msg[4]
    _receive(msg)


DEVICE.receive = _device_receive


def _stream():
    while True:
        i = STREAM['input']
        if i is not None:
            DEVICE.reply_to([0xF0, 0x7D, 0x13, i, *tpc.pc._put14(DEVICE.raw[i]), 0, 0b011, 0xF7])
        time.sleep(0.05)


threading.Thread(target=_stream, daemon=True).start()


SEQ = {'n': 0}


@sio.on('hello')
def hello(_data=None):
    """The Tunner's sync handshake: a new boot id makes it resync once (it reads the active preset, library included)."""
    return {'ok': True, 'resync': False, 'boot': 'dev-midiux-mock', 'seq': SEQ['n']}


@app.route('/health')
@app.route('/ping')
def health():
    return jsonify({'status': 'healthy', 'pianoid_loaded': True, 'backend_thread_running': True,
                    'cpp_module_responsive': True, 'exception': False, 'gpu_initialized': True,
                    'audio_driver_active': False, 'lifecycle': {'state': 'running'}})


@app.route('/commands')
def commands():
    from command_registry import Registry
    return jsonify(Registry(os.environ.get('PIANOID_COMMANDS_DIR')).listing())


@app.route('/preset/list')
def preset_list():
    return jsonify({'presets': LIBRARY, 'active': STATE['active']})


def spawn_impl(source):
    source = source or STATE['active']
    name = f"{source} (working {sum(p['kind'] == 'working' for p in LIBRARY) + 1})"
    LIBRARY.append({'name': name, 'kind': 'working'})
    return {'presets': LIBRARY, 'name': name}


def switch_impl(name):
    STATE['active'] = name or STATE['active']
    cmap.changed()
    SEQ['n'] += 1
    emit('preset_changed', {'seq': SEQ['n'], 'kind': 'switch', 'entry': STATE['active'], 'source': {}})
    return {'presets': LIBRARY, 'active': STATE['active']}


COMMANDS = {'preset.list': lambda a: {'presets': LIBRARY, 'active': STATE['active']},
            'preset.spawn_working_copy': lambda a: spawn_impl(a.get('source')),
            'preset.switch': lambda a: switch_impl(a.get('name'))}


@sio.on('command')
def command(payload):
    """The Tunner's command bus over the socket (utils/commandBus.js): the preset commands only."""
    fn = COMMANDS.get((payload or {}).get('name'))
    if fn is None:
        return {'ok': True, 'status': 200, 'result': {}}
    return {'ok': True, 'status': 200, 'result': fn((payload or {}).get('args') or {})}


@app.route('/preset/spawn_working_copy', methods=['POST'])
def spawn():
    return jsonify(spawn_impl((request.get_json(silent=True) or {}).get('source')))


@app.route('/preset/switch', methods=['POST'])
def switch():
    return jsonify(switch_impl((request.get_json(silent=True) or {}).get('name')))


@app.route('/midi/ports')
def midi_ports():
    return jsonify({'ports': ['UMC1820 MIDI In 0', 'Launchkey Mini 1', 'AMC-10 2', 'Pianoid 3'],
                    'active_port': None, 'listening': True})


@app.route('/midi/input')
def midi_input():
    return jsonify({'sustain_cc': 64, 'sustain_channel': None, 'polarity': 'normal', 'show_realtime': False,
                    'monitor_all_ports': True, 'input_port': 'all', 'port_sustain': {}, 'all_exclude': [],
                    'sustain_down': False, 'sustain_value': None, 'counts': {},
                    'port_state': {'mode': 'all', 'ports': ['Launchkey Mini', 'AMC-10', 'Pianoid'],
                                   'detecting': False, 'waiting': None}})


@app.route('/midi/broadcast')
def midi_broadcast():
    return jsonify({'enabled': True})


def send(status, d1, d2, port):
    table_hit = cmap.match(int(status), int(d1), int(d2), port)
    return table_hit


def device_value(i, raw):
    """What the device sends for a raw value: its calibrated position (min -> 0, max -> 127)."""
    c = DEVICE.cfg[i]
    lo, hi = c['lo'], c['hi']
    if c['curve'] == 0 or lo == hi:
        return max(0, min(127, int(raw / 8)))
    return max(0, min(127, round((raw - lo) / (hi - lo) * 127)))


@app.route('/mock/socket', methods=['POST'])
def mock_socket():
    body = request.get_json(silent=True) or {}
    i = int(body['index'])

    def run():
        for raw in body['raws']:
            DEVICE.raw[i] = int(raw)
            c = DEVICE.cfg[i]
            if c['type'] != 0 and c['msg'] == 0:
                send(0xB0 | c['ch'], c['num'], device_value(i, raw), 'Pianoid')
            time.sleep(body.get('gap_ms', 60) / 1000.0)
    threading.Thread(target=run, daemon=True).start()
    return jsonify({'moves': len(body['raws'])})


@app.route('/mock/device')
def mock_device():
    return jsonify({'cfg': DEVICE.cfg, 'raw': DEVICE.raw, 'saved': DEVICE.saved})


@app.route('/mock/midi', methods=['POST'])
def mock_midi():
    body = request.get_json(silent=True) or {}
    if 'sweep' in body:
        status = 0xB0 | (int(body.get('channel', 1)) - 1)

        def run():
            for v in body['sweep']:
                send(status, body['number'], v, body.get('port'))
                time.sleep(body.get('gap_ms', 20) / 1000.0)
        threading.Thread(target=run, daemon=True).start()
        return jsonify({'sweep': len(body['sweep'])})
    return jsonify({'hit': send(body['status'], body['d1'], body['d2'], body.get('port'))})


@app.route('/', defaults={'path': ''}, methods=['GET', 'POST'])
@app.route('/<path:path>', methods=['GET', 'POST'])
def any_route(path):
    if request.method == 'POST':
        print(f"WRITE {time.time():.3f} /{path} {request.get_data(as_text=True)[:160]}", flush=True)
    return jsonify({})


if __name__ == '__main__':
    print(f"[dev-midiux mock] :{PORT}, controls file {controls_path}", flush=True)
    sio.run(app, host='127.0.0.1', port=PORT, allow_unsafe_werkzeug=True)
