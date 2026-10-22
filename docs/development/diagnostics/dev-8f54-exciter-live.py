"""dev-8f54 live check of the exciter monitor on the rig (UMC1820, ASIO callback, normal playback).

Plumbing only (amps / sensors may be off): inputs metered at the sample rate during playback, the socket
telemetry stream, the limiter on a lowered limit (below the input noise) and on the injected test level
(attack steps, floor, release), the gain reaching the output meter, monitor off = untouched, callback cost.

Usage (backend :5000 up with a 7-channel preset on driver 4 and PIANOID_AUDIO_OUTPUT_MAP=8,9,2,3,4,5,6):
    PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-8f54-exciter-live.py [--out result.json]
Levels: velocity 40 notes at the preset's own volume (the user's normal playback level is higher).
"""
import argparse
import json
import math
import threading
import time

import requests
import socketio

B = "http://127.0.0.1:5000"


def get(path):
    r = requests.get(B + path, timeout=10)
    r.raise_for_status()
    return r.json()


def post(path, body=None):
    r = requests.post(B + path, json=body or {}, timeout=20)
    return r.status_code, r.json()


def play(pitch, vel=40, on=True):
    requests.post(B + "/play", json={"pitch": pitch, "velocity": vel if on else 0, "command": 144}, timeout=5)


class Stream:
    def __init__(self):
        self.events = []
        self.sio = socketio.Client(reconnection=False)
        self.sio.on("exciter_telemetry", lambda t: self.events.append((time.time(), t)))

    def __enter__(self):
        self.sio.connect(B, transports=["websocket"])
        return self

    def __exit__(self, *a):
        self.sio.disconnect()

    def since(self, t0):
        return [t for (ts, t) in self.events if ts >= t0]


def note_loop(stop, pitches=(48, 55, 60, 64, 67), period=0.35):
    i = 0
    while not stop.is_set():
        p = pitches[i % len(pitches)]
        play(p)
        time.sleep(period)
        play(p, on=False)
        i += 1


def ex(t, ch):
    return next(e for e in t["exciters"] if e["channel"] == ch)


def summary(ts, ch):
    gains = [ex(t, ch)["gain_db"] for t in ts]
    outs = [ex(t, ch)["output"]["peak_dbfs"] for t in ts if ex(t, ch)["output"]["peak_dbfs"] is not None]
    return {"gain_db_first": gains[0] if gains else None, "gain_db_last": gains[-1] if gains else None,
            "gain_db_min": min(gains) if gains else None, "out_peak_dbfs_max": max(outs) if outs else None,
            "attacks_last": ex(ts[-1], ch)["attacks"] if ts else None,
            "warnings_last": ex(ts[-1], ch)["warnings"] if ts else None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    args = ap.parse_args()
    res = {}
    dev = get("/audio/devices")["asio"]
    res["device"] = {k: dev.get(k) for k in ("driver", "sample_rate", "buffer_size", "input_latency", "output_latency")}
    res["device"]["n_inputs"] = len(dev.get("inputs", []))
    h0 = get("/health")
    res["audio_health_before"] = h0.get("audio_health")

    # 1) enable, In 1..8 metered (uncalibrated), E1..E7 sense In 1..7, E7 board In 8, no limits
    code, body = post("/audio/exciters/config", {"reset": True})
    code, body = post("/audio/exciters/config", {"enabled": True})
    res["enable"] = {"code": code, "enabled": body["config"]["enabled"]}

    stop = threading.Event()
    th = threading.Thread(target=note_loop, args=(stop,), daemon=True)
    with Stream() as s:
        t0 = time.time()
        th.start()
        time.sleep(4.0)
        ts = s.since(t0 + 1.0)
        rates = [t["rate"]["frames_per_s"] for t in ts if t.get("rate")]
        res["stream"] = {"events_per_s": round(len(ts) / 3.0, 1), "frames_per_s_mean": round(sum(rates) / len(rates), 1),
                         "frames_per_s_min": min(rates), "frames_per_s_max": max(rates),
                         "configured": all(t["configured"] for t in ts)}
        last = ts[-1]
        res["inputs_noise_dbfs"] = {i["name"]: (i["rms_dbfs"], i["peak_dbfs"]) for i in last["inputs"]}
        res["outputs_playing_dbfs"] = {e["name"]: max(ex(t, e["channel"])["output"]["peak_dbfs"] or -200 for t in ts)
                                       for e in last["exciters"]}
        res["unlimited"] = {e["name"]: summary(ts, e["channel"]) for e in last["exciters"][:3]}
        res["warnings_unlimited"] = sorted({w["code"] for t in ts for w in t["warnings"]})

        # 2) lowered limit on E1: 6 dB BELOW the measured noise peak of its sense input (In 1)
        noise_pk = 10 ** (max(i["peak_dbfs"] for i in last["inputs"] if i["index"] == 0) / 20)
        low = noise_pk / 2
        post("/audio/exciters/config", {"exciters": [{"channel": 0, "limit": low}]})
        t1 = time.time()
        time.sleep(2.5)
        ts1 = s.since(t1 + 0.1)
        res["lowered_limit"] = {"limit_fs": low, "E1": summary(ts1, 0), "E2_untouched": summary(ts1, 1)}
        post("/audio/exciters/config", {"exciters": [{"channel": 0, "limit": None}]})
        t1b = time.time()
        time.sleep(3.0)
        res["lowered_limit"]["E1_after_release"] = summary(s.since(t1b + 2.0), 0)

        # 3) injected test level on In 3 (E3's sense), limit 0.1 FS: attack steps every hold-off, floor, release
        post("/audio/exciters/clear")
        post("/audio/exciters/config", {"exciters": [{"channel": 2, "limit": 0.1}]})
        time.sleep(0.5)
        t2 = time.time()
        post("/debug/exciter_test_level", {"input": 2, "level_fs": 0.3})
        time.sleep(1.5)
        ts2 = s.since(t2)
        g = [(round(ts_ - t2, 3), ex(t, 2)["gain_db"], ex(t, 2)["attacks"]) for (ts_, t) in s.events if ts_ >= t2]
        res["test_level"] = {"first_samples": g[:6], "E3": summary(ts2, 2), "E4_untouched": summary(ts2, 3)}
        t3 = time.time()
        post("/debug/exciter_test_level", {"input": 2, "level_fs": 0.0})
        time.sleep(3.0)
        rel = [(round(ts_ - t3, 3), ex(t, 2)["gain_db"]) for (ts_, t) in s.events if ts_ >= t3]
        res["release"] = {"samples": rel[::6][:10], "final_gain_db": rel[-1][1] if rel else None}
        post("/audio/exciters/config", {"exciters": [{"channel": 2, "limit": None}]})

        # 4) monitor off: no telemetry, outputs untouched
        post("/audio/exciters/config", {"enabled": False})
        t4 = time.time()
        time.sleep(1.5)
        res["disabled"] = {"events": len(s.since(t4 + 0.3))}
        stop.set()
        th.join()
    h1 = get("/health")
    res["audio_health_after"] = h1.get("audio_health")
    res["health_status"] = h1.get("status")
    res["telemetry_get"] = get("/audio/exciters")["telemetry"]["enabled"]
    print(json.dumps(res, indent=1, default=str))
    if args.out:
        with open(args.out, "w") as fh:
            json.dump(res, fh, indent=1, default=str)


if __name__ == "__main__":
    main()
