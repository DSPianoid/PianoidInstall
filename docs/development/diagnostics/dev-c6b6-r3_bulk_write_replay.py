"""dev-c6b6 R3 replay: the 2026-10-20 bulk-write pattern against a loaded backend, while
/health is polled every 200 ms. Reports the max /health gap (time between consecutive
successful /health completions) and the per-request latency.

Pattern (from bugreport-2026-10-20T12..13*.json actionHistory): per round, over Socket.IO
`set_parameter` (fire-and-forget like the FE, acks collected):
  - 7x feedback rows (pitches 128..134, 196 values each)
  - 7x feedback_mask rows (pitches 128..134)
  - 1x mode from0to<N-1> (mass_inv for every mode)
  - 1x excitation from21to108 (level 127, gaussian 2 sigma, every pitch)
Values are the backend's CURRENT values (read once via GET), scaled by 1+-1e-4 alternately
so each write is a real (tiny) edit and the preset is left as found.

usage: python dev-c6b6-r3_bulk_write_replay.py [--url http://127.0.0.1:5012] [--rounds 6]
       [--gap 0.5] [--label before]
"""
import argparse
import json
import threading
import time

import requests
import socketio


def fetch(url, q):
    r = requests.get(f"{url}/get_parameter/{q}", timeout=60)
    r.raise_for_status()
    return r.json()


def build_payloads(url):
    fb = fetch(url, "feedback/from128to134")
    mask = fetch(url, "feedback_mask/from128to134")
    modes = fetch(url, "mode/all")
    n_modes = len(modes)
    gauss = {}
    for p in range(21, 109):
        g = fetch(url, f"gauss/{p}")[str(p)]
        lvl = "127" if "127" in g else sorted(g, key=int)[-1]
        gauss[p] = (lvl, g[lvl]["2"]["sigma"])
    return fb, mask, modes, n_modes, gauss


def round_events(fb, mask, modes, n_modes, gauss, k):
    s = 1.0 + (1e-4 if k % 2 == 0 else 0.0)
    ev = []
    for p, row in fb.items():
        ev.append({"parameter": "feedback", "key": p, "values": {p: [v * s for v in row]}})
    for p, row in mask.items():
        ev.append({"parameter": "feedback_mask", "key": p, "values": {p: row}})
    ev.append({"parameter": "mode", "key": f"from0to{n_modes - 1}",
               "values": {m: {"mass_inv": d["mass_inv"] * s} for m, d in modes.items()}})
    ev.append({"parameter": "excitation", "key": "from21to108",
               "values": {str(p): {lvl: {"2": {"sigma": sig * s}}} for p, (lvl, sig) in gauss.items()}})
    return ev


class HealthPoller(threading.Thread):
    def __init__(self, url, period=0.2):
        super().__init__(daemon=True)
        self.url, self.period = url, period
        self.ok_times, self.lat, self.fail = [], [], 0
        self.stop = False

    def run(self):
        while not self.stop:
            t0 = time.perf_counter()
            try:
                requests.get(f"{self.url}/health", timeout=30)
                t1 = time.perf_counter()
                self.ok_times.append(t1)
                self.lat.append(t1 - t0)
            except Exception:
                self.fail += 1
            time.sleep(max(0.0, self.period - (time.perf_counter() - t0)))

    def max_gap(self):
        g = [b - a for a, b in zip(self.ok_times, self.ok_times[1:])]
        return max(g) if g else float("nan")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:5012")
    ap.add_argument("--rounds", type=int, default=6)
    ap.add_argument("--gap", type=float, default=0.5, help="s between rounds")
    ap.add_argument("--label", default="run")
    a = ap.parse_args()

    payload = build_payloads(a.url)
    sio = socketio.Client(reconnection=False)
    sio.connect(a.url, transports=["websocket"])
    acks, lock = [], threading.Lock()

    hp = HealthPoller(a.url)
    hp.start()
    time.sleep(1.0)
    t_start = time.perf_counter()
    sent = 0
    for k in range(a.rounds):
        for e in round_events(*payload, k):
            t0 = time.perf_counter()

            def cb(resp, t0=t0, e=e):
                with lock:
                    acks.append((e["parameter"], e["key"], time.perf_counter() - t0,
                                 bool(resp and resp.get("ok"))))
            sio.emit("set_parameter", e, callback=cb)
            sent += 1
        time.sleep(a.gap)
    deadline = time.time() + 600
    while len(acks) < sent and time.time() < deadline:
        time.sleep(0.2)
    t_writes = time.perf_counter() - t_start
    time.sleep(1.0)
    hp.stop = True
    hp.join(timeout=35)
    sio.disconnect()

    by_kind = {}
    for kind, key, lat, ok in acks:
        d = by_kind.setdefault(kind, [])
        d.append(lat)
    res = {
        "label": a.label, "rounds": a.rounds, "sent": sent, "acked": len(acks),
        "acks_ok": sum(1 for x in acks if x[3]),
        "writes_wall_s": round(t_writes, 2),
        "health_max_gap_s": round(hp.max_gap(), 3),
        "health_max_latency_s": round(max(hp.lat), 3) if hp.lat else None,
        "health_p50_latency_s": round(sorted(hp.lat)[len(hp.lat) // 2], 4) if hp.lat else None,
        "health_samples": len(hp.lat), "health_failures": hp.fail,
        "ack_max_latency_s": {k: round(max(v), 2) for k, v in by_kind.items()},
    }
    print(json.dumps(res))


if __name__ == "__main__":
    main()
