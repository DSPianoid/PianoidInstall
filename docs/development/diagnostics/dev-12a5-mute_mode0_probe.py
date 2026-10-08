"""dev-12a5: measure the live output level under strings-axis SC mute masks.

Reproduces the 2026-10-08 07:55 report ("unmuted first mode -> silent, reversible"):
mute every mode on the Sound-Channels strings axis (feedback_mask rows 128..131),
then unmute mode 0 only, and compare the per-channel output peak (the /health
limiter clip-hold peak, Sint32 units, full scale 2^31) for one played note.

Usage: python dev-12a5-mute_mode0_probe.py [pitch] [velocity]
Live engine only (no offline render). Restores the original masks at the end.
"""
import json
import math
import sys
import time
import urllib.request

B = "http://127.0.0.1:5000"
FS = 2147483647.0


def rq(m, p, body=None):
    r = urllib.request.Request(B + p, data=None if body is None else json.dumps(body).encode(),
                               method=m, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=60) as x:
        return json.loads(x.read().decode())


def set_masks(masks):
    for k, row in masks.items():
        rq("POST", f"/set_parameter/feedback_mask/{k}", {k: row})


def measure(pitch, vel, hold=1.5):
    rq("POST", "/clear_limiting")
    time.sleep(0.3)
    rq("POST", "/play", {"pitch": pitch, "velocity": vel, "command": 144, "delay_ms": 0})
    time.sleep(hold)
    rq("POST", "/play", {"pitch": pitch, "velocity": 0, "command": 128, "delay_ms": 0})
    time.sleep(0.2)
    h = rq("GET", "/health")
    ch = h["limiter"]["channels"]
    return [c["latched_peak"] for c in ch], h.get("gate_trip_count")


def db(x):
    return 20 * math.log10(x / FS) if x > 0 else float("-inf")


def main():
    pitch = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    vel = int(sys.argv[2]) if len(sys.argv) > 2 else 127
    orig = rq("GET", "/get_parameter/feedback_mask/output")
    sc = rq("GET", "/get_parameter/feedback/output")
    n = len(next(iter(orig.values())))
    loud = max(range(n), key=lambda m: abs(sc["128"][m]))
    conds = [
        ("all unmuted", {k: [1.0] * n for k in orig}),
        ("all muted", {k: [0.0] * n for k in orig}),
        ("only mode 0", {k: [1.0] + [0.0] * (n - 1) for k in orig}),
        (f"only mode {loud} (largest SC coeff)", {k: [1.0 if m == loud else 0.0 for m in range(n)] for k in orig}),
        ("all unmuted again", {k: [1.0] * n for k in orig}),
    ]
    print(f"pitch {pitch} vel {vel}; SC coeff mode0 ch0={sc['128'][0]:.4g}, mode{loud} ch0={sc['128'][loud]:.4g}")
    try:
        for label, masks in conds:
            set_masks(masks)
            time.sleep(0.3)
            peaks, gates = measure(pitch, vel)
            print(f"{label:38s} " + "  ".join(f"ch{i} {db(p):7.1f} dBFS" for i, p in enumerate(peaks))
                  + f"  gate_trips={gates}")
    finally:
        set_masks(orig)


if __name__ == "__main__":
    main()
