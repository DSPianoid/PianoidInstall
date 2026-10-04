"""dev-17fd -- LIVE click/underrun hunt on the RUNNING backend (REST only; never instantiates Pianoid).

Runs N consecutive online `sound_test` windows on the live engine (ASIO, whatever preset/variant is
loaded), each playing a note sequence at a typical rate, with include_profiling + Sint capture.
Per window: callback underrunCount, callback interval max, full-cycle / add-kernel max + over-budget
count, and an isolated-click detector on the post-volume Sint stream (sample-to-sample jump vs the
local signal slope, flagged when > K x the local p99 of |diff|). Writes one JSON line per window.

    python dev-17fd-live-click-hunt.py OUT.jsonl WINDOWS WINDOW_S [VELOCITY]
"""
import json
import sys
import time
import urllib.request

import numpy as np

URL = "http://127.0.0.1:5000/get_chart_test"
SR = 48000


def post(body, timeout):
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def clicks(y, k=8.0, win=480):
    """Isolated discontinuities: |d2| (second difference) far above its local robust level."""
    y = np.asarray(y, dtype=float)
    if y.size < 3 * win:
        return []
    d2 = np.abs(np.diff(y, 2))
    d2[:8] = 0  # capture-start edge (record begins mid-signal), not a click
    out = []
    for s in range(0, d2.size - win, win):
        seg = d2[s:s + win]
        ref = np.percentile(seg, 99) + 1e-12
        # neighbourhood reference excluding the window's own top sample
        nb = d2[max(0, s - win):s + 2 * win]
        nref = np.median(nb) * 20 + 1e-12
        i = int(np.argmax(seg))
        if seg[i] > k * max(np.percentile(np.delete(seg, i), 99), 1e-12) and seg[i] > nref:
            out.append({"sample": s + i + 1, "ms": round((s + i + 1) * 1000 / SR, 2), "d2": float(seg[i]),
                        "ref_p99": float(ref), "level": float(np.max(np.abs(y[max(0, s):s + win])))})
    return out


def main():
    out_path, windows, win_s = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
    vel = int(sys.argv[4]) if len(sys.argv) > 4 else 70
    pitches = [48, 52, 55, 60, 64, 67, 72, 76, 79, 84, 60, 57, 53, 50, 45, 40]
    n = max(1, int(win_s / 0.5))
    seq = [pitches[i % len(pitches)] for i in range(n)]
    body = {"chartType": "sound_test", "mode": "online", "play_kind": "sequence",
            "pitches": ",".join(map(str, seq)), "velocities": str(vel), "note_durations_ms": "500",
            "tail_ms": "1000", "include_sint": True, "include_kernel": False, "include_profiling": True,
            "include_all_channels": True}
    with open(out_path, "a") as f:
        for w in range(windows):
            t0 = time.time()
            d = post(body, timeout=win_s + 120)
            tf = d.get("text_fields", {})
            rec = {"window": w, "utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t0)), "dur_s": round(time.time() - t0, 1),
                   **{k: tf.get(k) for k in ("Underruns", "Callback interval (us)", "Add-kernel device time",
                                              "Full-cycle host span (us)", "Cycle checkpoint breakdown (us, median)",
                                              "Profiling note", "Error")}}
            hint_by_header = dict(zip(d.get("chart_headers", []), d.get("render_hints", [])))
            full = hint_by_header.get("Full cycle incl. sync (us)", {}).get("point_meta") or []
            if full:
                us = np.array([p["us"] for p in full], dtype=float)
                rec["full_cycle"] = {"n": int(us.size), "max": float(us.max()), "p999": float(np.percentile(us, 99.9)),
                                     "over_1333": int((us > 1333).sum()), "over_2000": int((us > 2000).sum()),
                                     "worst_cycles": [int(i) for i in np.argsort(us)[-5:][::-1]]}
            rec["clicks"] = {}
            for h, s in zip(d.get("chart_headers", []), d.get("data", [])):
                if h.startswith("Sint") and isinstance(s, list):
                    c = clicks(s)
                    rec["clicks"][h] = {"count": len(c), "first": c[:5], "peak": float(np.max(np.abs(s))) if s else 0.0}
            f.write(json.dumps(rec) + "\n")
            f.flush()
            print(json.dumps({k: rec[k] for k in ("window", "utc", "Underruns", "Callback interval (us)")}),
                  rec.get("full_cycle", {}).get("max"), {h: v["count"] for h, v in rec["clicks"].items()}, flush=True)


if __name__ == "__main__":
    main()
