"""dev-midictl: latency + cost of a keyboard-wide string-tension write at controller rate (SILENT).

ONE Pianoid per process (in-process harness, release variant, audio_on=False, the realtime loop
free-running in a thread like tests/system/live_edit_probe.py). Nothing is audible. Three paths:

  M1  the edit path today: Pianoid.update_parameter('string', {p: {tension}} for every key)
      (edit_commit -> model -> CFL indication -> one swap -> journal + undo entry)
  M2  the dev-midictl overlay path: ControllerMap.match (what the listener calls per CC; a scratch
      control 'Harness CC20' + a tension mapping, never saved) ->
      ControllerOverlay worker -> ParameterManager.reupload_string_param (stored x factor, one swap,
      no model / journal / undo write)
  M3  the split of one M2 upload: waitForParameterUpdate (previous swap) / updateMultiStringParameter_NEW
      (D2H read + modify + H2D + double-buffer arm) / the swap wait after it

Per path: N single writes 150 ms apart (latency = call -> swap complete, i.e. waitForParameterUpdate
returns; the engine adopts it at the next cycle, <= 1.33 ms more), then a 100 Hz stream for 5 s
(achieved write rate, lag of the last write behind the last message). A probe thread asks for a 1 ms
sleep in a loop the whole time: its oversleep is the GIL / scheduling delay a MIDI note on the
listener thread would see.

usage: <Core venv python> dev-midictl-latency.py <core_dir> <preset_path> [--runs 3] [--json out.json]
"""
import argparse
import json
import os
import statistics
import sys
import threading
import time

ap = argparse.ArgumentParser()
ap.add_argument('core_dir')
ap.add_argument('preset')
ap.add_argument('--runs', type=int, default=3)
ap.add_argument('--singles', type=int, default=30)
ap.add_argument('--stream_s', type=float, default=5.0)
ap.add_argument('--json', default=None)
args = ap.parse_args()

MW = os.path.join(os.path.abspath(args.core_dir), 'pianoid_middleware')
os.chdir(MW)
sys.path.insert(0, MW)
CONTROLS_FILE = os.path.join(os.path.dirname(os.path.abspath(args.json or __file__)),
                             'dev-midictl-latency-controls.json')   # a scratch rig table, not the machine's

from pianoid import initialize  # noqa: E402
import pianoidCuda  # noqa: E402
import controller_controls  # noqa: E402
import controller_map  # noqa: E402
import controller_overlay  # noqa: E402

p = initialize(os.path.abspath(args.preset), 48 * 128 * 3, string_iteration=4, array_size=384,
               sample_rate=48000, samples_in_cycle=64, buffer_size=4, max_volume=5e18,
               audio_on=False, audio_driver_type=0)
pp = p.pianoid
cfg = pianoidCuda.PlaybackConfig()
cfg.sample_rate = p.mp.sample_rate()
cfg.samples_per_cycle = p.mp.mode_iteration
cfg.audio_enabled = False
cfg.record_to_buffer = False
cfg.max_duration_ms = 0
eng = pianoidCuda.OnlinePlaybackEngine()
eng.initialize(pp, cfg)
rtb = pianoidCuda.RealTimeEventBuffer()
eng.setRealTimeBuffer(rtb)
threading.Thread(target=eng.run, daemon=True).start()
time.sleep(1.0)

pm = p.param_manager
KEYS = [k for k in sorted(int(x) for x in p.sm.pitches) if k < 128]
BASE = {k: float(p.sm.pitches[k].physics.tension) for k in KEYS}


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))] if xs else None


def summary(xs):
    return {'n': len(xs), 'p50_ms': round(pct(xs, 0.5), 3), 'p99_ms': round(pct(xs, 0.99), 3),
            'max_ms': round(max(xs), 3), 'mean_ms': round(statistics.mean(xs), 3)} if xs else None


class GilProbe:
    """Oversleep of a 1 ms sleep loop (ms): the delay a Python listener thread would see."""

    def __init__(self):
        self.samples, self.stop = [], False
        self.t = threading.Thread(target=self.run, daemon=True)

    def run(self):
        while not self.stop:
            t0 = time.perf_counter()
            time.sleep(0.001)
            self.samples.append((time.perf_counter() - t0) * 1000.0 - 1.0)

    def __enter__(self):
        self.t.start()
        return self

    def __exit__(self, *exc):
        self.stop = True
        self.t.join()


def swap_done():
    pp.waitForParameterUpdate()


# ---- M1: edit path ------------------------------------------------------------------------------
def m1_write(m):
    values = {str(k): {'tension': BASE[k] * m} for k in KEYS}
    t0 = time.perf_counter()
    p.update_parameter('string', values, pitches=KEYS)
    swap_done()
    return (time.perf_counter() - t0) * 1000.0


# ---- M2: overlay path -----------------------------------------------------------------------------
controls = controller_controls.ControlTable(path=CONTROLS_FILE, seed=None)
controls.add({'name': 'Harness CC20', 'source': {'type': 'cc', 'number': 20}})
cmap = controller_map.ControllerMap(controls, lambda: p)
controller_map._MAP = cmap
saved_mappings = getattr(p.mp, 'controller_mappings', None)
overlay = controller_overlay.install(cmap, lambda: p, emit=None)
cid = 'm1'                     # written straight into the model (no edit_commit: the loaded preset may be read-only)
controller_map.write(p, [{'id': cid, **controller_map.validate_mapping(
    {'control': 'Harness CC20', 'target': {'domain': 'string', 'param': 'tension'},
     'lo': 0.98, 'hi': 1.02, 'smooth_ms': 0})}])
uploads = []        # (t_start, t_end) of every overlay upload, perf_counter
split = []          # M3: (wait_prev_ms, call_ms, wait_after_ms)
_orig_reupload = pm.reupload_string_param
_orig_gpu_upload = pm._gpu_upload


def timed_reupload(model_field, pitches):
    t0 = time.perf_counter()
    _orig_reupload(model_field, pitches)
    swap_done()
    uploads.append((t0, time.perf_counter()))


def timed_gpu_upload(method, *a):
    t0 = time.perf_counter()
    pp.waitForParameterUpdate()
    t1 = time.perf_counter()
    ok = method(*a)
    t2 = time.perf_counter()
    pp.waitForParameterUpdate()
    t3 = time.perf_counter()
    split.append(((t1 - t0) * 1e3, (t2 - t1) * 1e3, (t3 - t2) * 1e3))
    return ok


pm.reupload_string_param = timed_reupload
pm._gpu_upload = timed_gpu_upload


def m2_single(v):
    """One CC -> the swap of its upload complete (ms)."""
    n = len(uploads)
    t0 = time.perf_counter()
    cmap.match(0xB0, 20, v, None)
    while len(uploads) == n:
        time.sleep(0.0002)
    return (uploads[n][1] - t0) * 1000.0


def stream(send, seconds, rate_hz=100.0):
    sent, t_end = [], time.perf_counter() + seconds
    i = 0
    while time.perf_counter() < t_end:
        t = time.perf_counter()
        send(i)
        sent.append(t)
        i += 1
        time.sleep(max(0.0, 1.0 / rate_hz - (time.perf_counter() - t)))
    return sent


def run_once(run):
    out = {'run': run}
    # M1 singles + stream (the stream is synchronous: each write blocks the sender = the backlog)
    with GilProbe() as g:
        lat = [m1_write(1.01 if i % 2 else 1.0) for i in range(args.singles) if time.sleep(0.15) is None]
    out['m1_single'] = summary(lat)
    out['m1_single_gil'] = summary(g.samples)
    with GilProbe() as g:
        t0 = time.perf_counter()
        sent = stream(lambda i: m1_write(1.0 + 0.01 * ((i % 20) / 20.0)), args.stream_s)
        dur = time.perf_counter() - t0
    out['m1_stream'] = {'requested_hz': 100, 'achieved_hz': round(len(sent) / dur, 1)}
    out['m1_stream_gil'] = summary(g.samples)
    m1_write(1.0)
    # M2 singles + stream (the listener side returns at once; the worker coalesces)
    del split[:]
    with GilProbe() as g:
        lat = [m2_single(127 if i % 2 else 0) for i in range(args.singles) if time.sleep(0.15) is None]
    out['m2_single'] = summary(lat)
    out['m2_single_gil'] = summary(g.samples)
    out['m3_split'] = {k: summary([s[i] for s in split]) for i, k in
                       enumerate(('wait_prev', 'update_call', 'swap_wait'))}
    n0 = len(uploads)
    with GilProbe() as g:
        t0 = time.perf_counter()
        sent = stream(lambda i: cmap.match(0xB0, 20, i % 128, None), args.stream_s)
        last_sent = sent[-1]
        while not uploads or uploads[-1][0] < last_sent:
            time.sleep(0.001)
        dur = time.perf_counter() - t0
    ups = uploads[n0:]
    out['m2_stream'] = {'requested_hz': 100, 'messages': len(sent), 'uploads': len(ups),
                        'upload_hz': round(len(ups) / dur, 1),
                        'upload_ms': summary([(b - a) * 1e3 for a, b in ups]),
                        'last_lag_ms': round((ups[-1][1] - last_sent) * 1e3, 3)}
    out['m2_stream_gil'] = summary(g.samples)
    cmap.reset(cid)
    time.sleep(0.3)
    return out


results = {'preset': os.path.basename(args.preset), 'keys': len(KEYS),
           'variant': pianoidCuda.__name__, 'runs': [run_once(r) for r in range(args.runs)],
           'engine_running': bool(eng.isRunning())}
controller_map.write(p, saved_mappings)
overlay.stop()
os.remove(CONTROLS_FILE)
eng.stop()
print('RESULT ' + json.dumps(results), flush=True)
if args.json:
    with open(args.json, 'w', encoding='utf-8') as fh:
        json.dump(results, fh, indent=2)
os._exit(0)
