"""dev-ped1 live check without a physical pedal / loopMIDI: run the REAL backendServer with rtmidi
replaced at its module boundary (the lowest layer above the OS driver).

Everything above rtmidi is the shipped code: MIDI_listener_unified, MidiInputHub (pedal map +
monitor), schedule_event -> RealTimeEventBuffer, Socket.IO midi_message -> the Tunner MIDI panel.
Messages are injected by appending JSON lines to INBOX: {"port": 2, "bytes": [176, 64, 127]}.
Every event pushed to the engine (add_realtime_event) is appended to ENGINE_LOG.

Run (cwd = PianoidCore/pianoid_middleware, PianoidCore venv):
  python dev-ped1-fake-rtmidi-backend.py <inbox.jsonl> <engine_log.jsonl>
"""
import json
import os
import runpy
import sys
import threading
import time
import types
from collections import deque

INBOX, ENGINE_LOG = sys.argv[1], sys.argv[2]
PORTS = ['FAKE UMC1820 MIDI In 0', 'FAKE AMC-10 1', 'FAKE MIDIIN2 (AMC-10) 2']
_queues = {i: deque() for i in range(len(PORTS))}


def _feeder():
    pos = 0
    while True:
        try:
            with open(INBOX, encoding='utf-8') as fh:
                fh.seek(pos)
                for line in fh:
                    if line.strip():
                        msg = json.loads(line)
                        _queues[int(msg['port'])].append((list(msg['bytes']), 0.0))
                pos = fh.tell()
        except FileNotFoundError:
            pass
        time.sleep(0.02)


class FakeMidiIn:
    def __init__(self, *a, **k):
        self.port = None

    def get_ports(self):
        return list(PORTS)

    def open_port(self, idx):
        self.port = int(idx)

    def close_port(self):
        self.port = None

    def ignore_types(self, **kw):
        pass

    def get_message(self):
        q = _queues.get(self.port)
        return q.popleft() if q else None


fake = types.ModuleType('rtmidi')
fake.MidiIn = FakeMidiIn
sys.modules['rtmidi'] = fake
threading.Thread(target=_feeder, daemon=True).start()

sys.path.insert(0, os.getcwd())
import pianoid  # noqa: E402

_orig = pianoid.Pianoid.add_realtime_event


def _logged(self, event_type, data1, data2=0, delay_ms=0):
    with open(ENGINE_LOG, 'a', encoding='utf-8') as fh:
        fh.write(json.dumps({'t': time.time(), 'event': str(event_type), 'data1': int(data1),
                             'data2': int(data2)}) + '\n')
    return _orig(self, event_type, data1, data2, delay_ms=delay_ms)


pianoid.Pianoid.add_realtime_event = _logged
runpy.run_path(os.path.join(os.getcwd(), 'backendServer.py'), run_name='__main__')
