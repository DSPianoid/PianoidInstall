"""dev-mute2 — mute/unmute ROUND-TRIP on the live engine.

The fix must not only silence on mute; unmute must restore the level BIT-FOR-BIT (the F6
contract: the mask is a pure 0/1 multiply, raw coefficients untouched), and the cycle must be
IDEMPOTENT — mute -> unmute -> mute -> unmute lands on the same two levels every time.

Pre-fix BOTH directions were rejected 416, so the panel could neither mute nor unmute.
"""
import time

import requests

BASE = "http://127.0.0.1:5000"
OUT = [128, 129, 130, 131]


def set_mask(value):
    codes = [
        requests.post(f"{BASE}/set_parameter/feedback_mask/{p}", json={str(p): [value] * 196}, timeout=10).status_code
        for p in OUT
    ]
    return codes


def measure(label):
    time.sleep(3.0)
    requests.post(f"{BASE}/clear_limiting", timeout=10)
    time.sleep(0.3)
    requests.post(f"{BASE}/play", json={"pitch": 60, "velocity": 127, "command": 144}, timeout=10)
    peaks = [0.0] * 4
    t0 = time.time()
    while time.time() - t0 < 3.0:
        h = requests.get(f"{BASE}/health", timeout=10).json()
        for c in h["limiter"]["channels"]:
            peaks[c["channel"]] = max(peaks[c["channel"]], float(c["pre_limit_peak"]))
        time.sleep(0.12)
    requests.post(f"{BASE}/play", json={"pitch": 60, "velocity": 100, "command": 128}, timeout=10)
    print(f"  {label:<22} peaks={[round(p) for p in peaks]}")
    return peaks


print("=== mute/unmute round-trip (live ASIO) ===")
results = []
for cycle in (1, 2):
    print(f"\n-- cycle {cycle} --")
    print(f"  unmute POST -> {set_mask(1)}")
    up = measure(f"UNMUTED (cycle {cycle})")
    print(f"  mute   POST -> {set_mask(0)}")
    mp = measure(f"MUTED   (cycle {cycle})")
    results.append((up, mp))

print(f"\n  unmute POST -> {set_mask(1)}")
final = measure("UNMUTED (restored)")

print("\n=== VERDICT ===")
u1, m1 = results[0]
u2, m2 = results[1]
silent = all(p == 0.0 for p in m1) and all(p == 0.0 for p in m2)
restored = all(p > 0 for p in final)
# idempotence: the two unmuted levels agree within run-to-run noise (< 1%)
drift = max(abs(a - b) / max(a, 1e-9) for a, b in zip(u1, u2))
print(f"  mute silences every cycle        : {silent}   (muted peaks {[round(p) for p in m1]} / {[round(p) for p in m2]})")
print(f"  unmute restores audible output   : {restored} (peaks {[round(p) for p in final]})")
print(f"  unmute level idempotent          : {drift < 0.01}  (max drift {drift * 100:.3f}% between cycles)")
print(f"  RESULT: {'PASS' if (silent and restored and drift < 0.01) else 'FAIL'}")
