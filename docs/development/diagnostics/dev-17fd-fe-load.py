"""dev-17fd -- replay the FE's background REST traffic against the LIVE backend for N seconds.

Mirrors what the user's tab was sending in the 2026-10-04 session log (backend_stdout.log):
GET /health + /midi/ports (~1-4 Hz), POST /get_chart_test cfl_ratio (bursts on pitch select),
GET /get_hammer_shape/<p>, and (optionally) runtime feedback writes at the current value
(idempotent: re-sends the value read at start). Used to correlate engine timing spikes /
clicks with FE activity while dev-17fd-live-click-hunt.py runs.

    python dev-17fd-fe-load.py SECONDS [--writes]
"""
import json
import sys
import threading
import time
import urllib.request

B = "http://127.0.0.1:5000"


def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(B + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return json.loads(resp.read() or b"null")
    except Exception as e:  # noqa: BLE001 - load generator: count, don't crash
        return {"error": str(e)}


def main():
    secs = float(sys.argv[1])
    writes = "--writes" in sys.argv
    rt = req("GET", "/get_runtime_parameters") or {}
    fb = rt.get("deck_feedback_coefficient")
    stop = time.time() + secs
    counts = {"health": 0, "cfl": 0, "hammer": 0, "write": 0}

    def poll():
        while time.time() < stop:
            req("GET", "/health"); req("GET", "/midi/ports"); counts["health"] += 1
            time.sleep(0.25)

    def ui():
        p = 33
        while time.time() < stop:
            for _ in range(3):
                req("POST", "/get_chart_test", {"chartType": "cfl_ratio", "key_range": "all"}); counts["cfl"] += 1
            req("GET", f"/get_hammer_shape/{p}"); counts["hammer"] += 1
            if writes and fb is not None:
                req("POST", "/set_runtime_parameters", {"feedback_coeff": fb}); counts["write"] += 1
            p = 33 + (p - 32) % 60
            time.sleep(0.3)

    ts = [threading.Thread(target=poll), threading.Thread(target=ui)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    print(json.dumps(counts))


if __name__ == "__main__":
    main()
