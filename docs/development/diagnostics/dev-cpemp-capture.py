#!/usr/bin/env python3
"""dev-cpemp empirical A/B capture for the cp0->cp1 stream-decouple fix.

Replicates dev-stchart's spike-showing scenario: full stack up, sustained
concurrent chart-render CUDA contention (string_shape + feedin interleaved,
high concurrency to mimic the real browser's live chart panes), while an armed
online Sound Test profiling capture drives synthesis cycles. Reads the per-cycle
cp0->cp1 (Segment: kernel cp0->cp1) + add-kernel device-time series and reports
the spike distribution + over-budget + underruns.

Usage: python dev-cpemp-capture.py <LABEL> <N_CAPTURES> <INDUCER_LOOPS>
Writes per-capture response JSON to dev-cpemp-<LABEL>-<i>.json for plotting.
"""
import sys, json, time, threading, statistics
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

BASE = "http://localhost:5000"
LABEL = sys.argv[1] if len(sys.argv) > 1 else "run"
N_CAP = int(sys.argv[2]) if len(sys.argv) > 2 else 3
N_LOOP = int(sys.argv[3]) if len(sys.argv) > 3 else 6
BUDGET_US = 1333.33

CP_HDR = "Segment: kernel cp0→cp1 (us)"   # cp0->cp1 host-wall span
GPU_HDR = "Add-kernel device time (us)"


def post(path, body, timeout=240):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def health():
    try:
        return json.loads(urllib.request.urlopen(BASE + "/health", timeout=8).read())
    except Exception:
        return {}


def pct(a, p):
    if not a:
        return 0.0
    s = sorted(a)
    return s[min(len(s) - 1, int(len(s) * p))]


def capture(tag, idx):
    stop = threading.Event()
    counts = [0] * N_LOOP
    charts = ["string_shape"]  # feedin returns 416; string_shape is the heavy GPU-D2H inducer

    def loop(k):
        ct = charts[k % len(charts)]
        while not stop.is_set():
            try:
                post("/get_chart_test", {"chartType": ct}, 30)
                counts[k] += 1
            except Exception:
                pass

    threads = [threading.Thread(target=loop, args=(k,), daemon=True) for k in range(N_LOOP)]
    for th in threads:
        th.start()
    time.sleep(0.5)  # let contention build before the armed capture

    pitches = ("48,52,55,60,64,67,72,76,79,84,55,60,64,67,72,"
               "48,52,55,60,64,67,72,76,79,84,55,60,64,67,72")
    body = {"chartType": "sound_test", "mode": "online", "include_kernel": "true",
            "play_kind": "sequence", "pitches": pitches, "velocities": "100",
            "durations_ms": "900", "tail_ms": "300", "include_profiling": "true"}
    raw = post("/get_chart_test", body, timeout=240)
    stop.set()
    time.sleep(0.4)

    r = json.loads(raw)
    out = f"dev-cpemp-{tag}-{idx}.json"
    with open(out, "w", encoding="utf-8") as f:
        f.write(raw.decode("utf-8", "replace"))

    headers = r.get("chart_headers", [])
    data = r.get("data", [])
    by_h = {h: data[i] for i, h in enumerate(headers) if i < len(data)}
    cp = by_h.get(CP_HDR)
    gpu = by_h.get(GPU_HDR)
    tf = r.get("text_fields", {})

    def dist(series, name):
        if not series:
            return f"    {name}: MISSING"
        # drop the leading idle-gap artifact (first 2 entries can be huge)
        body_s = series[2:] if len(series) > 4 else series
        real = [x for x in body_s if x < 1e7]
        o5 = sum(1 for x in real if x > 5000)
        o10 = sum(1 for x in real if x > 10000)
        o20 = sum(1 for x in real if x > 20000)
        o40 = sum(1 for x in real if x > 40000)
        return (f"    {name}: n={len(series)} med={statistics.median(real):.0f}us "
                f"p99={pct(real,0.99):.0f} realmax={max(real) if real else 0:.0f}us "
                f">5ms={o5} >10ms={o10} >20ms={o20} >40ms={o40}")

    print(f"\n===== [{tag}-{idx}] inducer iters/loop={counts} (total {sum(counts)}) =====")
    print("  Underruns       :", tf.get("Underruns"))
    print("  Add-kernel dev  :", tf.get("Add-kernel device time"))
    print("  Checkpoint(med) :", tf.get("Cycle checkpoint breakdown (us, median)"))
    print("  Full-cycle host :", tf.get("Full-cycle host span (us)"))
    print(dist(cp, "cp0->cp1 (host-wall)"))
    print(dist(gpu, "add-kernel device"))
    return r


if __name__ == "__main__":
    h = health()
    print("HEALTH pianoid_loaded=", h.get("pianoid_loaded"),
          "audio_active=", h.get("lifecycle", {}).get("audio_driver_active"))
    if not h.get("lifecycle", {}).get("gpu_initialized"):
        print("ENGINE NOT INITIALIZED -- aborting"); sys.exit(1)
    for i in range(1, N_CAP + 1):
        capture(LABEL, i)
        time.sleep(1)
