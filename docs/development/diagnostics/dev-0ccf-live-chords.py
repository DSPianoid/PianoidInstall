"""dev-0ccf live REST probe: latched peak (max over channels, /health) of p60 and chords at v127.
Usage: live_chords.py <label> <slider_level> [n_runs] [chord names...]"""
import json, math, os, sys, time, threading, urllib.request

B = os.environ.get("PROBE_B", "http://127.0.0.1:5000")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "live_results.jsonl")
MW = r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware"
sys.path.insert(0, MW)
import output_headroom as oh  # noqa: E402  (pure module: the chord set)

FS = 2147483647.0


def req(path, body=None):
    r = urllib.request.Request(B + path, data=None if body is None else json.dumps(body).encode(),
                               method="POST" if body is not None else "GET",
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=120) as f:
        return json.loads(f.read() or b"null")


def strike(pitches, hold=1.0):
    req("/clear_limiting", {}); time.sleep(0.3)
    ts = [threading.Thread(target=req, args=("/play", {"pitch": p, "velocity": 127, "command": 144, "delay_ms": 60}))
          for p in pitches]
    [t.start() for t in ts]; [t.join() for t in ts]
    time.sleep(hold)
    ts = [threading.Thread(target=req, args=("/play", {"pitch": p, "velocity": 0, "command": 128})) for p in pitches]
    [t.start() for t in ts]; [t.join() for t in ts]
    time.sleep(0.6)
    h = req("/health")
    pk = max(c["latched_peak"] for c in h["limiter"]["channels"])
    return {"dbfs": round(20 * math.log10(pk / FS), 3) if pk > 0 else None, "clipping": h["clipping"],
            "limiting": h["limiting"], "max_gr_db": h["limiter"]["latched_max_gain_reduction_db"]}


if __name__ == "__main__":
    label, level = sys.argv[1], int(sys.argv[2])
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    names = sys.argv[4:] or ["dim7_2hand_10"]
    prev = req("/get_runtime_parameters")["volume_level"]
    req("/set_runtime_parameters", {"volume": level}); time.sleep(0.3)
    rec = {"label": label, "slider": level, "p60": [strike([60]) for _ in range(n)]}
    for nm in names:
        rec[nm] = [strike(list(oh.CANONICAL_CHORDS[nm])) for _ in range(n)]
    req("/set_runtime_parameters", {"volume": prev})
    rec["restored_slider"] = req("/get_runtime_parameters")["volume_level"]
    rec["output_scale"] = {k: v for k, v in req("/health")["output_scale"].items() if k in ("value", "target_dbfs", "target_source", "stale")}
    print(json.dumps(rec))
    open(OUT, "a").write(json.dumps(rec) + "\n")
