"""dev-3a08 — live verification of the Option-A length GET-unit fix.

Runs the exact play -> edit -> play -> restore -> play sequence the team-lead
asked for, against the running realtime engine, through the REAL UI path:
  - GET /get_parameter/string/<p>   (post-fix: returns `length` in metres)
  - POST /set_parameter/string/<p>  (the granular update route the UI uses)
  - POST /play  +  /capture + `sound` chart  (measure the realtime ring)

Pass criteria (per pitch, per edit):
  (1) the length edit CHANGES the sound (a real edit is audible);
  (2) NO explosion — post-edit RMS bounded, no NaN/Inf;
  (3) restoring `length` returns the sound to ~baseline;
  (4) a never-edited safe pitch stays clean (no engine-wide poisoning).

Requires the stack already running (launcher 3001 + backend 5000 + preset).
Run:  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-3a08-live-verify-fix.py
"""
import json
import math
import time
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:5000"
SAFE = 60
TREBLE = [84, 96]            # short treble strings — worst case for the bug
EDITS = [0.98, 1.05]         # a small (2%) and a moderate (5%) nudge
EXPLOSION_RATIO = 20.0       # post-edit RMS > 20x baseline => instability


def _post(path, payload=None, timeout=25):
    data = json.dumps(payload or {}).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _get(path, timeout=10):
    req = urllib.request.Request(BASE + path, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def get_ui_length(pitch):
    """The `length` the UI sees — via GET /get_parameter/string/<p>."""
    raw = _get(f"/get_parameter/string/{pitch}")
    d = raw.get(str(pitch), raw)
    return float(d["length"])


def set_length(pitch, value):
    _post(f"/set_parameter/string/{pitch}", {str(pitch): {"length": float(value)}})
    time.sleep(0.35)


def play(pitch, vel, cmd):
    _post("/play", {"pitch": pitch, "velocity": vel, "command": cmd})


def measure(label):
    """Capture the realtime ring and return noise diagnostics."""
    try:
        _post("/capture", {}, timeout=15)
    except Exception:
        pass
    time.sleep(0.2)
    d = _post("/get_chart_test",
              {"chartType": "sound", "length": 12000, "channel": 0}, timeout=20)
    arr = (d.get("data") or [[]])[0] or []
    finite = [x for x in arr if isinstance(x, (int, float)) and math.isfinite(x)]
    nan = len(arr) - len(finite)
    rms = (sum(x * x for x in finite) / len(finite)) ** 0.5 if finite else 0.0
    peak = max((abs(x) for x in finite), default=0.0)
    print(f"  [{label}] n={len(arr)} nan/inf={nan} rms={rms:.6g} peak={peak:.6g}")
    return {"nan": nan, "rms": rms, "peak": peak}


def play_and_measure(pitch, label, hold_ms=600):
    play(pitch, 110, 144)
    time.sleep(0.15)
    res = measure(label)
    time.sleep(hold_ms / 1000.0)
    play(pitch, 0, 128)
    time.sleep(0.25)
    return res


def main():
    print("=== dev-3a08 LIVE verification of the length GET-unit fix ===")
    h = _get("/health")
    print(f"engine: status={h.get('status')} lifecycle={h.get('lifecycle')}")

    r_safe_base = play_and_measure(SAFE, f"baseline safe pitch {SAFE}")

    all_pass = True
    for pitch in TREBLE:
        ui_len = get_ui_length(pitch)
        print(f"\n=== PITCH {pitch}  (GET length = {ui_len:.6g}) ===")
        # post-fix, ui_len must be a small metres value (~0.08-0.2), NOT a
        # block count (12, 21). Flag if it still looks like a count.
        if ui_len > 2.0:
            print(f"  !! WARNING: GET length {ui_len} looks like a block "
                  f"count, not metres — fix may not be active")
            all_pass = False

        r_clean = play_and_measure(pitch, f"clean pitch {pitch}")

        for pct in EDITS:
            try:
                set_length(pitch, ui_len * pct)
                r_edit = play_and_measure(pitch, f"  after length x{pct:.2f}")
                set_length(pitch, ui_len)  # restore
                r_restore = play_and_measure(pitch, "  after restore")
                r_safe = play_and_measure(SAFE, f"  safe pitch {SAFE} after edit")
            except urllib.error.HTTPError as e:
                print(f"  HTTP error during pitch {pitch} x{pct}: {e} — FAIL")
                all_pass = False
                continue

            no_explosion = (
                r_edit["nan"] == 0 and r_restore["nan"] == 0
                and r_safe["nan"] == 0
                and (r_clean["rms"] == 0
                     or r_edit["rms"] < EXPLOSION_RATIO * r_clean["rms"])
                and (r_safe_base["rms"] == 0
                     or r_safe["rms"] < EXPLOSION_RATIO * r_safe_base["rms"]))
            changed = (r_clean["rms"] > 0
                       and abs(r_edit["rms"] - r_clean["rms"])
                       > 0.10 * r_clean["rms"])
            recovered = (r_clean["rms"] > 0
                         and abs(r_restore["rms"] - r_clean["rms"])
                         < 0.6 * r_clean["rms"])
            safe_clean = (r_safe_base["rms"] > 0
                          and abs(r_safe["rms"] - r_safe_base["rms"])
                          < 0.8 * r_safe_base["rms"])

            ok = no_explosion and changed and recovered and safe_clean
            all_pass = all_pass and ok
            print(f"  VERDICT pitch {pitch} x{pct:.2f}: "
                  f"no_explosion={no_explosion} sound_changed={changed} "
                  f"restored={recovered} safe_pitch_clean={safe_clean} "
                  f"=> {'PASS' if ok else 'FAIL'}")

    print(f"\n=== LIVE VERIFICATION: {'ALL PASS' if all_pass else 'FAILURES'} ===")
    return 0 if all_pass else 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
