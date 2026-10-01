#!/usr/bin/env python3
# dev-cpfix live proof: run the sound_test online capture with include_profiling
# under a concurrent string_shape chart-render inducer, and read the per-cycle
# cp0->cp1 / full-cycle / sync-wait series + underruns. With the stream-decouple
# fix, the synthesis cycle timing should stay flat under chart-render load.
import sys, json, time, threading, statistics
import urllib.request

BASE = "http://localhost:5000"

def post(path, body, timeout=180):
    data = json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()

def inducer_loop(stop_evt, counter, kinds):
    i = 0
    while not stop_evt.is_set():
        kind = kinds[i % len(kinds)]
        try:
            post("/get_chart_test", kind, timeout=30)
            counter[0] += 1
        except Exception:
            pass
        i += 1

def main():
    nloops = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    # inducer chart bodies — string_shape "all strings" is the heaviest GPU
    # readback (getPianoidState full extent); feedin is host-only (control).
    kinds = [
        {"chartType": "string_shape"},                 # all strings (default -1) -> full get_pianoid_state D2H
        {"chartType": "string_shape", "pitch_no": 60},  # a pitch slice
    ]
    stop_evt = threading.Event()
    counter = [0]
    threads = [threading.Thread(target=inducer_loop, args=(stop_evt, counter, kinds), daemon=True)
               for _ in range(nloops)]
    print(f"[live-proof] starting {nloops} chart-render inducer loops (string_shape)")
    for t in threads:
        t.start()
    time.sleep(0.5)  # let contention go live

    body = {
        "chartType": "sound_test", "mode": "online", "include_kernel": "true",
        "play_kind": "sequence",
        "pitches": "48,52,55,60,64,67,72,76,79,84,55,60,64,67,72",
        "velocities": "100", "durations_ms": "900", "tail_ms": "300",
        "include_profiling": "true",
    }
    print("[live-proof] running armed sound_test online capture (~9s)...")
    t0 = time.time()
    status, raw = post("/get_chart_test", body, timeout=180)
    dt = time.time() - t0
    stop_evt.set()
    time.sleep(0.3)
    print(f"[live-proof] sound_test returned status={status} in {dt:.1f}s; inducer iters={counter[0]}")

    try:
        resp = json.loads(raw)
    except Exception as e:
        print("[live-proof] could not parse response:", e)
        print(raw[:500])
        return

    tf = resp.get("text_fields", {}) or {}
    print("\n=== text_fields (profiling) ===")
    for k in ("Underruns", "Callback interval (us)", "Add-kernel device time",
              "Full-cycle host span (us)", "Cycle checkpoint breakdown",
              "Non-kernel delay attribution"):
        if k in tf:
            print(f"  {k}: {tf[k]}")

    # per-cycle numeric series: find arrays > 100 long
    data = resp.get("data", [])
    headers = resp.get("chart_headers", []) or resp.get("general_header", [])
    series = []
    for idx, arr in enumerate(data):
        if isinstance(arr, list) and len(arr) > 100 and all(isinstance(x, (int, float)) for x in arr[:5]):
            series.append((idx, arr))

    def summarize(name, arr, exclude_idlegap=True):
        a = list(arr)
        # exclude the leading idle-gap outlier(s): drop first 2 entries that are huge
        body = a[2:] if exclude_idlegap and len(a) > 4 else a
        # real-max excluding values > 10ms (10000us) if these are us
        real = [x for x in body if x < 10000]
        n = len(body)
        med = statistics.median(body) if body else 0
        mx_real = max(real) if real else 0
        over5 = sum(1 for x in body if x > 5000)
        over20 = sum(1 for x in body if x > 20000)
        print(f"  [{name}] n={n} median={med:.0f}us real-max(<10ms)={mx_real:.0f}us  >5ms={over5}  >20ms={over20}")

    print("\n=== per-cycle series (us) — /data[3]=full-cycle, /data[4]=add-kernel (per repro doc) ===")
    for idx, arr in series:
        label = f"data[{idx}]"
        # heuristic: typical add-kernel ~ hundreds us, full-cycle ~ 1000us
        summarize(label, arr)

    # save raw for archival
    with open("dev-cpfix-live-proof-result.json", "w") as f:
        # strip bulky audio_data to keep it small
        slim = {k: v for k, v in resp.items() if k != "audio_data"}
        json.dump(slim, f)
    print("\n[live-proof] full (audio-stripped) response saved to dev-cpfix-live-proof-result.json")

if __name__ == "__main__":
    main()
