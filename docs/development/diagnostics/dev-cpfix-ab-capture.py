#!/usr/bin/env python3
# dev-cpfix A/B capture: load user preset, run a continuous string_shape chart
# inducer, capture a long sound_test online sequence with profiling, report the
# synthesis full-cycle spike distribution + sync-wait + underruns. Run identically
# against the CLEAN (before) and FIXED (after) builds.
import sys, json, time, threading, statistics
import urllib.request

BASE = "http://localhost:5000"
LABEL = sys.argv[1] if len(sys.argv) > 1 else "run"

def post(path, body, timeout=200):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def health():
    try:
        return json.loads(urllib.request.urlopen(BASE + "/health", timeout=8).read())
    except Exception:
        return {}

def ensure_loaded():
    h = health()
    if h.get("pianoid_loaded"):
        return True
    body = {"path": "presets/Belarus_196modesC_Fanera6exc.json", "use_simulation": 0,
            "debug_mode": 1, "audio_driver_type": 4, "audio_on": 1, "listen_to_midi": 0,
            "sample_rate": 48000, "string_iterations": 12, "cycle_iterations": 64,
            "audio_buffer_size": 4, "start_right_away": 1}
    post("/load_preset", body, timeout=200)
    for _ in range(30):
        if health().get("pianoid_loaded"):
            return True
        time.sleep(2)
    return False

def capture(tag):
    stop = threading.Event(); cnt = [0]
    def loop():
        while not stop.is_set():
            try:
                post("/get_chart_test", {"chartType": "string_shape"}, 30); cnt[0] += 1
            except Exception:
                pass
    th = threading.Thread(target=loop, daemon=True); th.start()
    time.sleep(0.3)
    # long sequence (30 notes) for many cycles
    pitches = "48,52,55,60,64,67,72,76,79,84,55,60,64,67,72,48,52,55,60,64,67,72,76,79,84,55,60,64,67,72"
    body = {"chartType": "sound_test", "mode": "online", "include_kernel": "true",
            "play_kind": "sequence", "pitches": pitches, "velocities": "100",
            "durations_ms": "900", "tail_ms": "300", "include_profiling": "true"}
    raw = post("/get_chart_test", body, timeout=200)
    stop.set(); time.sleep(0.3)
    r = json.loads(raw)
    tf = r.get("text_fields", {})
    print(f"\n===== [{tag}] =====")
    print("  inducer string_shape iters:", cnt[0])
    print("  checkpoint:", tf.get("Cycle checkpoint breakdown (us, median)"))
    print("  full-cycle :", tf.get("Full-cycle host span (us)"))
    print("  underruns  :", tf.get("Underruns"))
    print("  add-kernel :", tf.get("Add-kernel device time"))
    # per-cycle full-cycle series distribution
    for i, a in enumerate(r.get("data", [])):
        if isinstance(a, list) and len(a) > 200:
            b = a[2:]
            real = [x for x in b if x < 1e7]
            over5 = sum(1 for x in real if x > 5000)
            over10 = sum(1 for x in real if x > 10000)
            over20 = sum(1 for x in real if x > 20000)
            over40 = sum(1 for x in real if x > 40000)
            print(f"    data[{i}] n={len(a)} med={statistics.median(b):.0f}us "
                  f"realmax={max(real) if real else 0:.0f}us >5ms={over5} >10ms={over10} >20ms={over20} >40ms={over40}")
    return r

if __name__ == "__main__":
    if not ensure_loaded():
        print("FAILED to load preset"); sys.exit(1)
    # run capture twice (N>=2 per build) for stability
    capture(LABEL + "-1")
    time.sleep(1)
    capture(LABEL + "-2")
