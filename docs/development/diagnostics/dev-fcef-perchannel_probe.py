"""dev-fcef: per-channel live output peaks (/health limiter clip-hold, Sint32, FS 2^31) of p60 / p71 and
the canonical chords at v127, at a given BARE volume_center + slider level, N runs.

Snapshots the runtime parameters first and restores volume_center / volume_level at the end.
Usage: python dev-fcef-perchannel_probe.py <label> <bare_center> <slider> [n_runs] [chord names...]
REST only (no UI, no offline render)."""
import json, math, os, sys, time, threading, urllib.request

B = os.environ.get("PROBE_B", "http://127.0.0.1:5000")
FS = 2147483647.0
MW = r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware"
sys.path.insert(0, MW)
import output_headroom as oh  # noqa: E402  (pure module: the chord set)


def req(path, body=None):
    r = urllib.request.Request(B + path, data=None if body is None else json.dumps(body).encode(),
                               method="POST" if body is not None else "GET",
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=120) as f:
        return json.loads(f.read() or b"null")


def db(x):
    return round(20 * math.log10(x / FS), 2) if x > 0 else None


def strike(pitches, hold=1.2):
    req("/clear_limiting", {}); time.sleep(0.3)
    ts = [threading.Thread(target=req, args=("/play", {"pitch": p, "velocity": 127, "command": 144, "delay_ms": 60}))
          for p in pitches]
    [t.start() for t in ts]; [t.join() for t in ts]
    time.sleep(hold)
    ts = [threading.Thread(target=req, args=("/play", {"pitch": p, "velocity": 0, "command": 128})) for p in pitches]
    [t.start() for t in ts]; [t.join() for t in ts]
    time.sleep(0.6)
    h = req("/health")
    return [db(c["latched_peak"]) for c in h["limiter"]["channels"]]


def main():
    label, center, level = sys.argv[1], float(sys.argv[2]), int(sys.argv[3])
    n = int(sys.argv[4]) if len(sys.argv) > 4 else 3
    names = sys.argv[5:]
    snap = req("/get_runtime_parameters")
    try:
        req("/set_runtime_parameters", {"volume_center": center, "volume": level}); time.sleep(0.3)
        rp = req("/get_runtime_parameters")
        h = req("/health")
        rec = {"label": label, "bare_center": rp["volume_center"], "slider": rp["volume_level"],
               "output_scale": h["output_scale"]["value"], "target_dbfs": h["output_scale"]["target_dbfs"],
               "impulse_level_db": h["output_scale"].get("impulse_level_db"),
               "load_settings": h["output_scale"]["load_settings"]}
        for name, ps in [("p60", [60]), ("p71", [71])] + [(nm, list(oh.CANONICAL_CHORDS[nm])) for nm in names]:
            rec[name] = [strike(ps) for _ in range(n)]
            worst = max(max(x for x in run if x is not None) for run in rec[name])
            print(f"{name:20s} worst-ch {worst:+7.2f} dBFS  runs(ch0..3)={rec[name]}", flush=True)
    finally:
        req("/set_runtime_parameters", {"volume_center": snap["volume_center"], "volume": snap["volume_level"]})
        after = req("/get_runtime_parameters")
        print("restored", {k: after[k] for k in ("volume_center", "volume_level")},
              "snapshot", {k: snap[k] for k in ("volume_center", "volume_level")})
    print(json.dumps(rec))


if __name__ == "__main__":
    main()
