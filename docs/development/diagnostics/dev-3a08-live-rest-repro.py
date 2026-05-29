"""dev-3a08 — live REST reproduction of the length->dx regression (a558cb3).

Drives the ACTUAL UI path against a running realtime engine (backend on :5000,
realtime OnlinePlaybackEngine active): edits `length` via POST /set_parameter,
plays notes via POST /play, and measures the realtime ring buffer via the `sound`
chart. This is the path the user's repro exercises — NOT an offline render.

Sequence:
  baseline:  play pitch P -> capture -> measure (expect clean)
  for each treble pitch and each small length edit:
    POST /set_parameter/string/<P> {length: edited}   (live granular path)
    play P -> capture -> measure                       (noise? NaN?)
    POST /set_parameter/string/<P> {length: original}  (restore)
    play P -> capture -> measure                       (recovered?)
    play a DIFFERENT safe pitch -> capture -> measure   (engine-wide poison?)

Requires the stack already running (launcher 3001 + backend 5000 + preset loaded).
Run:  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-3a08-live-rest-repro.py
"""
import json
import math
import time
import urllib.request

BASE = "http://127.0.0.1:5000"


def _post(path, payload=None, timeout=20):
    data = json.dumps(payload or {}).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def get_string_params(pitch):
    """GET /get_parameter/string/<pitch> -> the inner per-pitch dict.

    The endpoint returns {"<pitch>": {param: value, ...}}; unwrap one level so
    callers see the parameter dict directly (this is the value the UI displays
    and edits — including the unit-mismatched `length`).
    """
    req = urllib.request.Request(f"{BASE}/get_parameter/string/{pitch}", method="GET")
    with urllib.request.urlopen(req, timeout=10) as r:
        raw = json.loads(r.read().decode())
    # unwrap {"<pitch>": {...}}
    if str(pitch) in raw and isinstance(raw[str(pitch)], dict):
        return raw[str(pitch)]
    return raw


def play(pitch, vel, cmd):
    return _post("/play", {"pitch": pitch, "velocity": vel, "command": cmd})


def measure_sound(channel=0, length=12000, label=""):
    """Capture the realtime ring and return noise diagnostics."""
    _post("/capture", {}, timeout=15)
    time.sleep(0.2)
    d = _post("/get_chart_test",
              {"chartType": "sound", "length": length, "channel": channel},
              timeout=20)
    arr = (d.get("data") or [[]])[0] or []
    finite = [x for x in arr if isinstance(x, (int, float)) and math.isfinite(x)]
    nan = len(arr) - len(finite)
    rms = (sum(x * x for x in finite) / len(finite)) ** 0.5 if finite else 0.0
    peak = max((abs(x) for x in finite), default=0.0)
    # zero-crossing rate as a broadband-noise proxy
    zcr = 0.0
    if len(finite) > 2:
        s = [1 if x >= 0 else -1 for x in finite]
        zcr = sum(1 for a, b in zip(s, s[1:]) if a != b) / (len(s) - 1)
    print(f"  [{label}] n={len(arr)} nan/inf={nan} rms={rms:.6g} "
          f"peak={peak:.6g} zcr={zcr:.4f}")
    return {"nan": nan, "rms": rms, "peak": peak, "zcr": zcr}


def play_and_measure(pitch, label, hold_ms=600):
    """Play a note, capture during the sustain, release."""
    play(pitch, 110, 144)
    time.sleep(0.15)
    res = measure_sound(label=label)
    time.sleep(hold_ms / 1000.0)
    play(pitch, 0, 128)
    time.sleep(0.2)
    return res


def main():
    h = _post("/health", {}, timeout=10) if False else None
    print("=== dev-3a08 LIVE REST reproduction (realtime engine) ===")

    SAFE = 60
    treble = [84, 90, 96, 100]
    edit_pcts = (0.98, 0.95, 0.90, 1.02, 1.05, 1.10)

    # warm up + baseline on the safe pitch
    print("\n-- baseline: safe pitch --")
    r_base = play_and_measure(SAFE, f"baseline safe pitch {SAFE}")

    any_break = False
    for pitch in treble:
        try:
            orig = get_string_params(pitch)
        except Exception as e:
            print(f"  (skipping pitch {pitch}: get_parameter failed: {e})")
            continue
        # the geometry length is exposed under the string params; find the key
        length_key = None
        for k in ("length", "string_length", "geometry_length"):
            if k in orig:
                length_key = k
                break
        if length_key is None:
            print(f"  pitch {pitch}: string params keys = {list(orig.keys())}")
            print(f"  (no length key found — the editor may POST 'length' directly)")
        base_len = orig.get(length_key) if length_key else None
        print(f"\n=== PITCH {pitch}  (length key={length_key} value={base_len}) ===")

        rc = play_and_measure(pitch, f"clean pitch {pitch}")

        for pct in edit_pcts:
            if base_len is not None:
                edited = base_len * pct
            else:
                # editor sends 'length' directly; we still send a relative edit
                # by reading whatever 'length' the GET returned (may be absent)
                edited = None
            payload = {str(pitch): {"length": edited if edited is not None
                                    else pct}}
            # POST the granular length edit through the real REST route
            resp = _post(f"/set_parameter/string/{pitch}", payload, timeout=20)
            time.sleep(0.3)

            r_edit = play_and_measure(pitch, f"  after length x{pct:.2f}")

            # restore
            if base_len is not None:
                _post(f"/set_parameter/string/{pitch}",
                      {str(pitch): {"length": base_len}}, timeout=20)
                time.sleep(0.3)
            r_restore = play_and_measure(pitch, "  after restore")

            # check a DIFFERENT safe pitch for engine-wide poisoning
            r_safe = play_and_measure(SAFE, f"  safe pitch {SAFE} after edit")

            broke = (r_edit["nan"] > 0 or r_restore["nan"] > 0 or r_safe["nan"] > 0
                     or (rc["rms"] > 0 and r_edit["rms"] > 12 * rc["rms"])
                     or (r_base["rms"] > 0 and r_safe["rms"] > 12 * r_base["rms"])
                     or r_edit["zcr"] > 0.40 or r_safe["zcr"] > 0.40)
            tag = "  *** BROKE ***" if broke else ""
            print(f"  VERDICT pitch {pitch} x{pct:.2f}: broke={broke}{tag}")
            any_break = any_break or broke

    print(f"\n=== LIVE SWEEP SUMMARY: any break = {any_break} ===")


if __name__ == "__main__":
    main()
