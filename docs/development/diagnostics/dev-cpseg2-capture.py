#!/usr/bin/env python
"""dev-cpseg2 ONLINE capture under chart-render inducer.

Starts N parallel /get_chart_test chart-render loops (string_shape + feedin,
the two GPU-touching chart types the real browser frontend polls), then 0.5s
later fires ONE armed online sound_test capture (which arms initTimeRecord and
drives ~5800 synthesis cycles). Saves the full sound_test JSON response.

Usage: python dev-cpseg2-capture.py <out.json> <n_inducer_loops> <duration_s>
"""
import sys, json, time, threading
import urllib.request

BASE = "http://localhost:5005"

def post(path, body, timeout=120):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

_stop = threading.Event()

def inducer_loop(idx):
    charts = [{"chartType": "string_shape"}, {"chartType": "feedin"}]
    k = 0
    while not _stop.is_set():
        body = charts[k % 2]; k += 1
        try:
            post("/get_chart_test", body, timeout=30)
        except Exception:
            pass  # backend may briefly stall under load; keep hammering

def main():
    out = sys.argv[1]
    n_loops = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    dur = float(sys.argv[3]) if len(sys.argv) > 3 else 12.0

    threads = [threading.Thread(target=inducer_loop, args=(i,), daemon=True)
               for i in range(n_loops)]
    for t in threads:
        t.start()
    print(f"[capture] {n_loops} inducer loops started; waiting 0.5s for contention")
    time.sleep(0.5)

    # Build a long pitch sequence so the armed run lasts ~dur seconds.
    base = [48, 52, 55, 60, 64, 67, 72, 76, 79, 84, 55, 60, 64, 67, 72]
    reps = max(1, int(dur / (15 * 0.9)))  # 15 notes * 0.9s each per rep
    pitches = ",".join(str(p) for p in base * reps)
    body = {
        "chartType": "sound_test", "mode": "online",
        "play_kind": "sequence", "pitches": pitches, "velocities": "100",
        "durations_ms": "900", "tail_ms": "300", "include_profiling": "true",
        # dev-cpseg2: force ALL per-segment series ON so each cycle's
        # kernel/audio_prep/sync_wait/host_tail spans come back as per-cycle
        # arrays for attribution (they default OFF).
        "prof_kernel": "true", "prof_audio_prep": "true",
        "prof_sync_wait": "true", "prof_host_tail": "true",
        "prof_full_cycle": "true", "prof_add_kernel": "true",
    }
    print(f"[capture] firing armed sound_test ({len(base)*reps} notes, ~{dur:.0f}s)")
    t0 = time.time()
    try:
        raw = post("/get_chart_test", body, timeout=int(dur) + 90)
    except Exception as e:
        _stop.set()
        print(f"[capture] CAPTURE FAILED after {time.time()-t0:.1f}s: {e}")
        sys.exit(2)
    _stop.set()
    el = time.time() - t0
    with open(out, "wb") as f:
        f.write(raw)
    print(f"[capture] done in {el:.1f}s; wrote {out} ({len(raw)} bytes)")
    # quick sanity
    try:
        d = json.loads(raw)
        if "error" in d:
            print("[capture] RESPONSE ERROR:", d["error"])
            sys.exit(3)
        print("[capture] chart_headers:", d.get("chart_headers"))
    except Exception as e:
        print("[capture] parse warn:", e)

if __name__ == "__main__":
    main()
