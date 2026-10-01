#!/usr/bin/env python3
"""dev-cpseg3 per-segment over-budget attribution capture.

Copies dev-cpemp-capture.py's PROVEN mechanism (full stack up, sustained
string_shape inducer loops to create CUDA contention, one armed online Sound
Test profiling capture), but arms ALL the per-segment profiling checkboxes so
the sound_test response ships EVERY "Segment:" array. For each over-budget
(Full cycle > BUDGET_US) cycle, finds the dominant (argmax) checkpoint segment
and tabulates the over-budget cycles by dominant segment + magnitudes.

Usage: python dev-cpseg3-capture.py <LABEL> <N_CAPTURES> <INDUCER_LOOPS>
Writes per-capture response JSON to dev-cpseg3-<LABEL>-<i>.json.
Writes an attribution summary JSON to dev-cpseg3-<LABEL>-attrib.json.
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
N_LOOP = int(sys.argv[3]) if len(sys.argv) > 3 else 12
BUDGET_US = 1333.33

# Exact headers emitted by chartFunctions._sound_test_checkpoint_spans_us / handler
H_KERNEL = "Segment: kernel cp0→cp1 (us)"
H_AUDIO  = "Segment: FIR/audio-prep cp1→cp2 (us)"
H_SYNC   = "Segment: sync wait cp2→cp3 (us)"
H_TAIL   = "Segment: host tail cp3→cp4 (us)"
H_FULL   = "Full cycle incl. sync (us)"
H_GPU    = "Add-kernel device time (us)"

SEG_HDRS = [("kernel", H_KERNEL), ("audio_prep", H_AUDIO),
            ("sync_wait", H_SYNC), ("host_tail", H_TAIL)]


def post(path, body, timeout=300):
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

    def loop(k):
        while not stop.is_set():
            try:
                post("/get_chart_test", {"chartType": "string_shape"}, 30)
                counts[k] += 1
            except Exception:
                pass

    threads = [threading.Thread(target=loop, args=(k,), daemon=True) for k in range(N_LOOP)]
    for th in threads:
        th.start()
    time.sleep(0.5)  # let contention build

    pitches = ("48,52,55,60,64,67,72,76,79,84,55,60,64,67,72,"
               "48,52,55,60,64,67,72,76,79,84,55,60,64,67,72")
    # ARM ALL segment profiling checkboxes (dev-cpemp armed only defaults).
    body = {"chartType": "sound_test", "mode": "online", "include_kernel": "true",
            "play_kind": "sequence", "pitches": pitches, "velocities": "100",
            "durations_ms": "900", "tail_ms": "300", "include_profiling": "true",
            "prof_kernel": "true", "prof_audio_prep": "true", "prof_sync_wait": "true",
            "prof_host_tail": "true", "prof_full_cycle": "true", "prof_add_kernel": "true"}
    raw = post("/get_chart_test", body, timeout=300)
    stop.set()
    time.sleep(0.4)

    r = json.loads(raw)
    out = f"dev-cpseg3-{tag}-{idx}.json"
    with open(out, "w", encoding="utf-8") as f:
        f.write(raw.decode("utf-8", "replace"))

    headers = r.get("chart_headers", [])
    data = r.get("data", [])
    by_h = {h: data[i] for i, h in enumerate(headers) if i < len(data)}

    present = {name: (h in by_h) for name, h in SEG_HDRS}
    present["full"] = H_FULL in by_h
    print(f"\n===== [{tag}-{idx}] inducer iters/loop total={sum(counts)} =====")
    print("  headers present:", present)
    print("  all headers:", [h for h in headers])

    full = by_h.get(H_FULL) or []
    segs = {name: (by_h.get(h) or []) for name, h in SEG_HDRS}
    gpu = by_h.get(H_GPU) or []

    # Trim leading idle-gap artifacts consistently across all series (first 2).
    def trim(s):
        return s[2:] if len(s) > 4 else s
    full_t = trim(full)
    segs_t = {k: trim(v) for k, v in segs.items()}

    n = len(full_t)
    over = []  # list of dicts per over-budget cycle
    seg_keys = [k for k, _ in SEG_HDRS]
    for i in range(n):
        fv = full_t[i]
        if fv is None or fv > 1e7 or fv <= BUDGET_US:
            continue
        # gather this cycle's segment values (guard index)
        sv = {}
        for k in seg_keys:
            arr = segs_t.get(k, [])
            sv[k] = arr[i] if i < len(arr) and arr[i] is not None and arr[i] < 1e7 else 0.0
        dom = max(sv, key=lambda k: sv[k]) if sv else None
        over.append({"cycle": i, "full": round(fv, 1),
                     "dom": dom, "dom_us": round(sv.get(dom, 0.0), 1),
                     "segs": {k: round(v, 1) for k, v in sv.items()}})

    # tabulate
    by_dom = {}
    for o in over:
        d = o["dom"]
        by_dom.setdefault(d, []).append(o)

    print(f"  cycles(after trim) n={n}  over-budget(>{BUDGET_US:.0f}us)={len(over)}")
    for d, items in sorted(by_dom.items(), key=lambda kv: -len(kv[1])):
        mags = [it["dom_us"] for it in items]
        fulls = [it["full"] for it in items]
        print(f"    dom={d:11s} count={len(items):4d}  "
              f"dom_us med={statistics.median(mags):.0f} max={max(mags):.0f}  "
              f"full med={statistics.median(fulls):.0f} max={max(fulls):.0f}")

    # segment distribution stats
    def dist(name, s):
        real = [x for x in s if x is not None and x < 1e7]
        if not real:
            return f"    {name}: EMPTY"
        return (f"    {name}: n={len(s)} med={statistics.median(real):.0f} "
                f"p99={pct(real,0.99):.0f} max={max(real):.0f}")
    print(dist("kernel cp0->cp1", segs_t.get("kernel", [])))
    print(dist("audio cp1->cp2 ", segs_t.get("audio_prep", [])))
    print(dist("sync  cp2->cp3 ", segs_t.get("sync_wait", [])))
    print(dist("tail  cp3->cp4 ", segs_t.get("host_tail", [])))
    print(dist("FULL  cp0->cp5 ", full_t))
    print(dist("add-kernel dev ", trim(gpu)))

    return {
        "tag": tag, "idx": idx, "n_cycles": n, "n_over": len(over),
        "headers_present": present,
        "by_dom_counts": {d: len(v) for d, v in by_dom.items()},
        "over": over,
        "seg_stats": {
            k: {
                "n": len([x for x in segs_t.get(k, []) if x is not None and x < 1e7]),
                "med": statistics.median([x for x in segs_t.get(k, []) if x is not None and x < 1e7]) if any(x is not None and x < 1e7 for x in segs_t.get(k, [])) else 0,
                "max": max([x for x in segs_t.get(k, []) if x is not None and x < 1e7], default=0),
            } for k in seg_keys
        },
        "full_stats": {
            "n": len([x for x in full_t if x is not None and x < 1e7]),
            "med": statistics.median([x for x in full_t if x is not None and x < 1e7]) if any(x is not None and x < 1e7 for x in full_t) else 0,
            "max": max([x for x in full_t if x is not None and x < 1e7], default=0),
        },
    }


if __name__ == "__main__":
    h = health()
    print("HEALTH pianoid_loaded=", h.get("pianoid_loaded"),
          "audio_active=", h.get("lifecycle", {}).get("audio_driver_active"),
          "gpu_init=", h.get("lifecycle", {}).get("gpu_initialized"))
    if not h.get("lifecycle", {}).get("gpu_initialized"):
        print("ENGINE NOT INITIALIZED -- aborting"); sys.exit(1)
    results = []
    for i in range(1, N_CAP + 1):
        results.append(capture(LABEL, i))
        time.sleep(1)
    with open(f"dev-cpseg3-{LABEL}-attrib.json", "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)
    print(f"\nWROTE dev-cpseg3-{LABEL}-attrib.json")
