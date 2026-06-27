"""dev-37f6 A3 measurement: where does hammer-POSITION-shift latency live?

A3: shifting hammer position causes a big delay in BOTH chart AND sound. The coeff-consolidation
factor cache is already on dev and makes the COEFFICIENT recompose fast (~spatial scalar). The
suspects that remain are the BULK dev_hammer upload (pack_hammers over ALL blocks +
setNewHammerParameters) and the FE /get_hammer_shape refetch. This measures the BACKEND segments:

  1. end-to-end POST /set_parameter/hammer/<pitch> {hammer_position} round-trip (what the engine takes)
  2. GET /get_hammer_shape/<pitch> round-trip (what the chart refetch costs)
  3. a single-pitch vs a wide range (from21to108) hammer POST, to see if pack_hammers-all-blocks
     makes a single-pitch edit pay the full-table cost.

Measure, don't guess. Run several times for stable numbers (N>=5).

Usage: PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-37f6-a3-position-latency.py
"""
import json, time, urllib.request, statistics

BASE = "http://localhost:5000"
PITCH = 60
N = 8

def post(path, payload, timeout=60):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=data, headers={"Content-Type": "application/json"})
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        r.read()
    return (time.perf_counter() - t0) * 1000.0

def get(path, timeout=30):
    t0 = time.perf_counter()
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        r.read()
    return (time.perf_counter() - t0) * 1000.0

def stat(name, samples):
    print(f"  {name:<46} n={len(samples)} mean={statistics.mean(samples):8.2f}ms "
          f"median={statistics.median(samples):8.2f}ms min={min(samples):7.2f} max={max(samples):7.2f}")

def main():
    print("# dev-37f6 A3 hammer-position latency (backend segments, ms)")
    # warm up
    post(f"/set_parameter/hammer/{PITCH}", {str(PITCH): {"hammer_position": 0.15}})
    get(f"/get_hammer_shape/{PITCH}")

    # 1. single-pitch position POST (alternate position so it's a real change each time)
    s_post = []
    for i in range(N):
        pos = 0.10 + 0.02 * (i % 5)
        s_post.append(post(f"/set_parameter/hammer/{PITCH}", {str(PITCH): {"hammer_position": pos}}))
    stat("POST /set_parameter/hammer/<pitch> [position]", s_post)

    # 2. GET /get_hammer_shape round-trip (the FE chart refetch)
    s_get = [get(f"/get_hammer_shape/{PITCH}") for _ in range(N)]
    stat("GET /get_hammer_shape/<pitch>", s_get)

    # 3. wide-range hammer POST (from21to108) — does single-pitch pay the all-blocks pack cost?
    lo, hi = 21, 108
    rng = f"from{lo}to{hi}"
    payload = {}
    for i in range(N):
        pos = 0.10 + 0.02 * (i % 5)
        body = {str(p): {"hammer_position": pos} for p in range(lo, hi+1)}
        payload = body
    s_rng = []
    for i in range(N):
        pos = 0.10 + 0.02 * (i % 5)
        body = {str(p): {"hammer_position": pos} for p in range(lo, hi+1)}
        s_rng.append(post(f"/set_parameter/hammer/{rng}", body))
    stat(f"POST /set_parameter/hammer/{rng} [all-pitch pos]", s_rng)

    # restore
    post(f"/set_parameter/hammer/{PITCH}", {str(PITCH): {"hammer_position": 0.15}})
    print("\n# Interpretation:")
    print("#  - If single-pitch POST ~= range POST => pack_hammers(all blocks)+setNewHammerParameters")
    print("#    dominates (single-pitch edit pays full-table GPU upload). Fix: scope hammer upload to")
    print("#    the edited pitch's strings (incremental setter), like the granular physics path.")
    print("#  - If GET /get_hammer_shape is the big one => the FE chart refetch is the bottleneck.")
    print("#  - The FE also adds debounce (50ms WS/300ms REST) + 150ms zoom refetch + (width) 120ms sleep.")

if __name__ == "__main__":
    main()
