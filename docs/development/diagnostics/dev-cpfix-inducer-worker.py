#!/usr/bin/env python3
# A single inducer worker process: hammers string_shape (all-strings => full
# get_pianoid_state D2H) as fast as it can for DURATION seconds. Run many of
# these as separate PROCESSES (no GIL) to build a deep default-stream GPU queue.
import sys, json, time, urllib.request

BASE = "http://localhost:5000"
DURATION = float(sys.argv[1]) if len(sys.argv) > 1 else 15.0

def post(path, body, timeout=30):
    data = json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

body = {"chartType": "string_shape"}  # all strings => heaviest GPU readback
n = 0
t_end = time.time() + DURATION
while time.time() < t_end:
    try:
        post("/get_chart_test", body, timeout=30)
        n += 1
    except Exception:
        pass
print(n)
