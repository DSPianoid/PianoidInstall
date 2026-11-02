"""lat-3636 tuning-latency study - shared harness (measurement only, no app changes).

Clock: everything is epoch seconds from time.time() (Windows system clock, same clock the
browser's performance.timeOrigin + now() uses). Audio: the engine's own mic capture of ASIO
input 7 (In 8, physical loopback from Out 9) via POST /play_keyboard capture_mic, which arms
startMicCapture, schedules its marker note (delay 0) in the SAME handler, sleeps, stops and
writes a 16-bit WAV to D:/tmp. Capture sample 0 ~= the handler's startMicCapture call.
"""
import json
import os
import shutil
import threading
import time

import numpy as np
import requests
import soundfile as sf

B = "http://127.0.0.1:5000"
FS = 48000
DATA_DIR = "D:/modal_measurements/latency-2026-10-23"
os.makedirs(DATA_DIR, exist_ok=True)
SESSION = requests.Session()


def post(path, body=None, timeout=60):
    r = SESSION.post(B + path, json=body if body is not None else {}, timeout=timeout)
    return r.status_code, (r.json() if r.content and r.headers.get('content-type', '').startswith('application/json') else r.text)


def get(path, timeout=30):
    r = SESSION.get(B + path, timeout=timeout)
    return r.json()


def play_rest(pitch, vel=100, cmd=144):
    return post("/play", {"pitch": pitch, "velocity": vel, "command": cmd})


def sustain(on):
    return post("/play", {"pitch": 64, "velocity": 127 if on else 0, "command": 176})


def reset():
    return SESSION.get(B + "/reset", timeout=30).status_code


# ---------------------------------------------------------------- WS client
class WS:
    """python-socketio client; emit_ack returns (ack, t_send, t_ack) in epoch seconds."""

    def __init__(self):
        import socketio
        self.sio = socketio.Client(reconnection=True)
        self.events = []
        self.sio.on('state_changed', lambda d: self.events.append((time.time(), 'state_changed', d)))
        self.sio.on('param_ack', lambda d: self.events.append((time.time(), 'param_ack', d)))
        self.sio.on('error', lambda d: self.events.append((time.time(), 'error', d)))
        self.sio.connect(B, transports=['websocket'], wait_timeout=10)

    def emit_ack(self, event, payload, timeout=30):
        t0 = time.time()
        ack = self.sio.call(event, payload, timeout=timeout)
        return ack, t0, time.time()

    def emit(self, event, payload):
        t0 = time.time()
        self.sio.emit(event, payload)
        return t0

    def play(self, pitch, vel=100, cmd=144):
        return self.emit('play', {'pitch': pitch, 'velocity': vel, 'command': cmd})

    def close(self):
        self.sio.disconnect()


# ---------------------------------------------------------------- capture
class Capture:
    """Background /play_keyboard capture. start() returns t_req (epoch s, just before the POST)."""

    def __init__(self, marker_pitch=60, marker_vel=100, speed_ms=2000, tail_ms=1000, tag="cap"):
        self.body = {"mode": "online", "pitches": [marker_pitch], "velocity": marker_vel,
                     "speed_ms_per_note": speed_ms, "capture_mic": True, "tail_ms": tail_ms}
        self.tag = tag
        self.result = None
        self.t_req = None
        self.t_resp = None

    def _run(self):
        self.t_req = time.time()
        r = requests.post(B + "/play_keyboard", json=self.body, timeout=120)
        self.t_resp = time.time()
        self.result = r.json()

    def start(self):
        self.th = threading.Thread(target=self._run, daemon=True)
        self.th.start()
        while self.t_req is None:
            time.sleep(0.0005)
        return self.t_req

    def wait(self):
        self.th.join()
        src = self.result.get("mic_wav_path")
        dst = os.path.join(DATA_DIR, f"{self.tag}_{int(self.t_req * 1000)}.wav")
        shutil.move(src, dst)
        self.path = dst
        x, fs = sf.read(dst, dtype='float32')
        assert fs == FS
        self.x = x
        return x


# ---------------------------------------------------------------- analysis
def env_rms(x, win=48):
    """RMS envelope, window `win` samples, hop 1 (cumsum)."""
    c = np.concatenate([[0.0], np.cumsum(x.astype(np.float64) ** 2)])
    e = np.sqrt(np.maximum(c[win:] - c[:-win], 0) / win)
    return np.concatenate([e, np.full(win - 1, e[-1])])


def onset(x, start=0, k=20.0, noise_win=2400):
    """First sample >= start where |x| exceeds k x the noise RMS of the first noise_win samples
    after `start` (or an absolute floor of 3 LSB16)."""
    seg = x[start:start + noise_win]
    nz = max(float(np.sqrt(np.mean(seg ** 2))), 3 / 32768)
    idx = np.nonzero(np.abs(x[start:]) > k * nz)[0]
    return (start + int(idx[0])) if idx.size else None


def align(ref, sig, i_ref, i_sig, n=4800, search=256):
    """Integer lag that maps ref onto sig around the two onsets (xcorr over n samples)."""
    best, best_lag = -1e30, 0
    a = sig[i_sig:i_sig + n]
    for lag in range(-search, search + 1):
        j = i_ref + lag
        if j < 0:
            continue
        b = ref[j:j + n]
        if len(b) < n:
            continue
        c = float(np.dot(a, b))
        if c > best:
            best, best_lag = c, lag
    return (i_sig - (i_ref + best_lag))   # sig index = ref index + shift


def diff_onset(ref, sig, shift, start, k=8.0, win=48, noise_span=(0.10, 0.40), hold=96):
    """Divergence onset of sig vs ref (ref shifted by `shift`), searching from `start`.
    Noise = RMS of the difference over noise_span (seconds after the marker region, before start).
    Returns (index, noise_rms, diff_env)."""
    n = len(sig)
    r = np.zeros(n, dtype=np.float64)
    lo, hi = max(0, shift), min(n, len(ref) + shift)
    r[lo:hi] = ref[lo - shift:hi - shift]
    d = sig.astype(np.float64) - r
    e = env_rms(d, win)
    a, b = int(noise_span[0] * FS), int(noise_span[1] * FS)
    noise = float(np.sqrt(np.mean(d[a:b] ** 2))) + 1e-9
    thr = k * max(noise, 1.5 / 32768)
    above = e > thr
    i = start
    while i < n - hold:
        if above[i] and above[i:i + hold].mean() > 0.9:
            # back off to the window start (env is centred on the trailing window)
            return max(start, i - win + 1), noise, e
        i += 1
    return None, noise, e


def save_json(name, obj):
    tag = os.environ.get("LAT_TAG")          # dev-elat1: keep before/after runs apart
    name = f"{tag}_{name}" if tag else name
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", name)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        json.dump(obj, f, indent=1, default=float)
    return p


def stats(v):
    v = np.asarray([x for x in v if x is not None], dtype=float)
    if v.size == 0:
        return {"n": 0}
    return {"n": int(v.size), "median": float(np.median(v)), "min": float(v.min()), "max": float(v.max()),
            "p90": float(np.percentile(v, 90))}


# ---------------------------------------------------------------- trial protocol
SCHED_TO_IN8_S = None   # measured by exp01 A (schedule_event -> In 8 onset), set by caller


def run_capture(ws, actions, note=60, vel=100, t_note=0.3, length_s=3.0, tag="trial", settle_s=1.0,
                do_reset=True, release=True):
    """One capture: quiet marker (p21 v1), WS NOTE_ON `note` at t_note (the anchor), then each
    action (t_rel, fn) is called at t_req + t_rel; fn() returns a dict of epoch timestamps.
    Returns dict(x, t_req, t_note_send, acts=[...])."""
    if do_reset:
        reset()
        time.sleep(settle_s)
    speed = 2000
    tail = max(0, int(length_s * 1000) - speed)
    cap = Capture(marker_pitch=127, marker_vel=1, speed_ms=speed, tail_ms=tail, tag=tag)
    tr = cap.start()
    plan = ([(t_note, lambda: {"t_send": ws.play(note, vel)}, "note")] if t_note is not None else []) +         [(a[0], a[1], "act") for a in actions]
    plan.sort(key=lambda p: p[0])
    rec = []
    for t_rel, fn, kind in plan:
        while time.time() < tr + t_rel:
            time.sleep(0.0002)
        r = fn() or {}
        r["kind"] = kind
        rec.append(r)
    x = cap.wait()
    if release and t_note is not None:
        ws.play(note, 0, 128)
    notes = [r for r in rec if r["kind"] == "note"]
    t_note_send = notes[0]["t_send"] if notes else None
    return {"x": x, "t_req": tr, "t_note_send": t_note_send, "acts": [r for r in rec if r["kind"] == "act"],
            "wav": cap.path}


def epoch_of_index(trial, i, i_note, ws_oneway_s=0.0013):
    """Epoch time at which capture sample i reached In 8, anchored on the WS note."""
    return trial["t_note_send"] + ws_oneway_s + SCHED_TO_IN8_S + (i - i_note) / FS


def analyse(ref, t, act):
    xr, x = ref["x"], t["x"]
    ir = onset(xr, int(0.25 * FS), noise_win=1200)
    it = onset(x, int(0.25 * FS), noise_win=1200)
    sh = align(xr, x, ir, it)
    n = len(x)
    r = np.zeros(n)
    lo, hi = max(0, sh), min(n, len(xr) + sh)
    r[lo:hi] = xr[lo - sh:hi - sh]
    d = x.astype(np.float64) - r
    i_send = it + int(round((act["t_send"] - t["t_note_send"]) * FS))
    pre = d[it:i_send - 240]
    pre_nonzero = int(np.count_nonzero(np.abs(pre) > 4.0 / 32768))
    # first sustained non-zero difference after (send - 50 ms)
    nz = np.abs(d) > 1.5 / 32768
    first = None
    i = max(it, i_send - 2400)
    while i < n - 480:
        if nz[i] and nz[i:i + 480].mean() > 0.1:
            first = i
            break
        i += 1
    # perceptual: diff envelope > -40 dB re the signal RMS of the 100 ms before send
    sig = float(np.sqrt(np.mean(x[i_send - 4800:i_send].astype(np.float64) ** 2)))
    e = env_rms(d, 96)
    above = np.nonzero(e[max(it, i_send - 2400):] > sig * 0.01)[0]
    perc = (max(it, i_send - 2400) + int(above[0])) if above.size else None
    lat = lambda i: (epoch_of_index(t, i, it) - act["t_send"]) * 1e3 if i is not None else None
    return {"shift": sh, "pre_nonzero": pre_nonzero, "lat_first_ms": lat(first), "lat_m40dB_ms": lat(perc),
            "ack_ms": (act["t_ack"] - act["t_send"]) * 1e3, "ok": act.get("ok"), "err": act.get("err"),
            "sig_dbfs": 20 * np.log10(sig + 1e-12), "diff_after_dbfs": 20 * np.log10(float(e[first:first + 4800].max()) + 1e-12) if first else None}


