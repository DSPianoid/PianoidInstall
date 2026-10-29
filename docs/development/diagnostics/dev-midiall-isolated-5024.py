"""dev-midiall: "Listen to All" on an ISOLATED backend (:5024, no engine, no audio, no real port).

Runs the real Flask app (backendServer: /midi/start, /midi/select_port, /midi/ports, /midi/input,
/midi/stop) and the real listener loop (Pianoid.MIDI_listener_unified -> PortController ->
MergedInputs -> MidiInputHub) over HTTP on 127.0.0.1:5024. Only two things are stand-ins:
  * rtmidi.MidiIn -> a virtual MIDI bus in this process (winmm has no virtual ports and
    loopMIDI / teVirtualMIDI are not installed). NO real MIDI port is ever opened, so the user's
    live backend keeps its input.
  * the engine -> a recorder of schedule_event (the GPU is not touched: the user is measuring
    on the live stack). The engine side of a MIDI event is covered by test_kernel_midi_batch.
The pedal settings live in a temp copy of the machine's midi_input_settings.json, migrated with
tools/migrate_midi_port_sustain.py (the real file is never written).

    PianoidCore/.venv/Scripts/python -u dev-midiall-isolated-5024.py <core checkout>
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.request
from collections import deque

CORE = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')
MW = os.path.join(CORE, 'pianoid_middleware')
sys.path[:0] = [MW, os.path.join(CORE, 'tools')]
os.chdir(MW)                      # as the backend: keyboards/*.yaml are relative to the cwd
PORT = 5024
LIVE_SETTINGS = os.path.normpath(os.path.join(CORE, '..', 'PianoidInstall', 'midi',
                                              'midi_input_settings.json'))
if not os.path.exists(LIVE_SETTINGS):
    LIVE_SETTINGS = r'D:\repos\PianoidInstall\midi\midi_input_settings.json'

tmp = tempfile.mkdtemp(prefix='dev-midiall-')
settings = os.path.join(tmp, 'midi_input_settings.json')
shutil.copy(LIVE_SETTINGS, settings)
os.environ['PIANOID_MIDI_SETTINGS'] = settings
os.environ.setdefault('PIANOID_COMMANDS_DIR', r'D:\repos\wt-midiall-install\schemas\commands')

import migrate_midi_port_sustain as mig  # noqa: E402
import rtmidi  # noqa: E402


class Bus:
    """Virtual MIDI inputs (rtmidi order); messages queued per device."""
    def __init__(self, names):
        self.names, self.q = list(names), {}
        self.lock = threading.Lock()

    def base(self, name):
        return name.rsplit(' ', 1)[0]

    def send(self, base, *msgs):
        with self.lock:
            self.q.setdefault(base, deque()).extend((list(m), 0.0) for m in msgs)

    def unplug(self, base):
        with self.lock:
            self.names = [f'{self.base(n)} {i}' for i, n in
                          enumerate(n for n in self.names if self.base(n) != base)]

    def plug(self, base):
        with self.lock:
            self.names.append(f'{base} {len(self.names)}')


BUS = Bus(['UMC1820 MIDI In 0', 'AMC-10 1', 'MIDIIN2 (AMC-10) 2', 'Pianoid 3'])


class VirtualMidiIn:
    def __init__(self, *a, **k):
        self.dev = None

    def get_ports(self):
        with BUS.lock:
            return list(BUS.names)

    def get_port_count(self):
        return len(self.get_ports())

    def open_port(self, idx, *a):
        self.dev = BUS.base(self.get_ports()[idx])

    def ignore_types(self, **k):
        pass

    def get_message(self):
        with BUS.lock:
            q = BUS.q.get(self.dev)
            return q.popleft() if q else None

    def close_port(self):
        self.dev = None


rtmidi.MidiIn = VirtualMidiIn            # before any middleware import touches a port

import backendServer as B  # noqa: E402
import pianoid as P  # noqa: E402


class EngineStub:
    """The Pianoid surface the MIDI routes + listener use; schedule_event is recorded."""
    MIDI_listener_unified = P.Pianoid.MIDI_listener_unified
    start_midi_listener_unified = P.Pianoid.start_midi_listener_unified
    stop_midi_listener = P.Pianoid.stop_midi_listener
    request_port_switch = P.Pianoid.request_port_switch
    list_midi_ports = P.Pianoid.list_midi_ports

    def __init__(self):
        self.listen = False
        self.exception = False
        self._midi_thread = None
        self._midi_port_lock = threading.Lock()
        self._midi_port_request = None
        self._emit_midi_callback = None
        self._midi_active_port = None
        self.scheduled = []

    def get_all_pitches_in_preset(self, convert_to_notes=False):
        return list(range(21, 109))

    def get_midi_broadcast_enabled(self):
        return True

    def schedule_event(self, status, d1, d2):
        self.scheduled.append((status, d1, d2))
        return True


def http(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f'http://127.0.0.1:{PORT}{path}', data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def until(cond, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end and not cond():
        time.sleep(0.01)
    return cond()


def main():
    out = {}
    with open(settings, encoding='utf-8') as fh:
        before = json.load(fh)
    mig.main(['--file', settings])
    with open(settings, encoding='utf-8') as fh:
        out['settings_before'], out['settings_after_migration'] = before, json.load(fh)

    stub = EngineStub()
    B.pianoid = stub
    from werkzeug.serving import make_server
    server = make_server('127.0.0.1', PORT, B.app, threaded=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f'[SERVER-START] isolated backend on :{PORT} pid={os.getpid()}')
    try:
        out['start'] = http('POST', '/midi/start', {})
        until(lambda: stub._midi_active_port is not None)
        out['select_all'] = http('POST', '/midi/select_port', {'port': 'all'})
        until(lambda: http('GET', '/midi/ports')[1]['port_state']['mode'] == 'all')
        out['ports_all'] = http('GET', '/midi/ports')[1]

        # two keyboards + both pedal maps
        BUS.send('Pianoid', [0x90, 60, 80], [0x90, 64, 81], [0xB0, 64, 127])      # FATAR, CC64
        BUS.send('MIDIIN2 (AMC-10)', [0x90, 60, 70], [0xB1, 0, 5], [0xB2, 0, 41])  # AMC, CC0 ch2
        until(lambda: len(stub.scheduled) >= 6)
        BUS.send('Pianoid', [0x80, 60, 0], [0x80, 64, 0], [0xB0, 64, 0])          # off + pedal up
        time.sleep(0.2)
        out['engine_after_two_sources'] = list(stub.scheduled)
        out['input_after_two_sources'] = {k: http('GET', '/midi/input')[1][k] for k in
                                          ('port_counts', 'sustain_down', 'port_sustain')}

        # hot-plug: the AMC-10 is unplugged while it holds 60 + its pedal; a keyboard arrives
        n0 = len(stub.scheduled)
        BUS.unplug('MIDIIN2 (AMC-10)')
        BUS.unplug('AMC-10')
        BUS.plug('Roland A-49')
        until(lambda: 'Roland A-49 2' in http('GET', '/midi/ports')[1]['port_state']['ports'])
        time.sleep(0.1)
        out['hotplug_release'] = stub.scheduled[n0:]
        out['ports_after_hotplug'] = http('GET', '/midi/ports')[1]['port_state']
        BUS.send('Roland A-49', [0x90, 48, 60])
        until(lambda: (0x90, 48, 60) in stub.scheduled)
        out['new_port_plays'] = (0x90, 48, 60) in stub.scheduled
        out['sustain_down_end'] = http('GET', '/midi/input')[1]['sustain_down']
        out['back_to_one_port'] = http('POST', '/midi/select_port', {'port': 1})
        until(lambda: http('GET', '/midi/ports')[1]['port_state']['mode'] == 'manual')
        out['ports_manual'] = http('GET', '/midi/ports')[1]['port_state']
        out['stop'] = http('POST', '/midi/stop', {})[1]['listening']
    finally:
        stub.listen = False
        server.shutdown()
        print(f'[SERVER-STOP] :{PORT} pid={os.getpid()}')
        shutil.rmtree(tmp, ignore_errors=True)
    print(json.dumps(out, indent=1, default=str))


if __name__ == '__main__':
    main()
