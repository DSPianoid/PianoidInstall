"""dev-scr1 — live verify BATCH calibration over a mode range (listen_to_modes=0).

POST /batch [start,end] -> poll status -> print per-mode result table -> read back
feedback/output and verify: each written mode's column == reported new_col AND its average
== A (preserved); skipped modes reported not written; a mode OUTSIDE the range untouched.
"""
import json
import sys
import time
import urllib.request

import numpy as np

BASE = "http://127.0.0.1:5000"


def get(ep):
    with urllib.request.urlopen(f"{BASE}/get_parameter/{ep}", timeout=8) as r:
        return json.loads(r.read().decode())


def get_raw(ep):
    with urllib.request.urlopen(f"{BASE}/{ep}", timeout=8) as r:
        return json.loads(r.read().decode())


def post(ep, body, timeout=30):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{BASE}/{ep}", data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def column(fb, m):
    keys = sorted(int(k) for k in fb if k != "_meta")
    return np.array([fb[str(k)][m] for k in keys])


def main():
    start = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    end = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    outside = end + 1

    fb_before = get("feedback/output")
    outside_before = column(fb_before, outside)

    r = post("modal/calibrate_sound_channel/batch", {"start": start, "end": end})
    print(f"batch started: range={r.get('range')} total={r.get('total')} "
          f"est={r.get('est_seconds'):.0f}s (~{r.get('est_per_mode_seconds'):.1f}s/mode)")

    last_done = -1
    while True:
        st = get_raw("modal/calibrate_sound_channel/batch/status")
        if st["done"] != last_done:
            print(f"  progress: mode {st['current_mode']} — {st['done']}/{st['total']} done "
                  f"({st['written']} written, {st['skipped']} skipped)")
            last_done = st["done"]
        if not st["running"]:
            break
        time.sleep(1.0)
    if st.get("error"):
        print("BATCH ERROR:", st["error"])

    print("\n=== per-mode results ===")
    print(f"{'mode':>4} {'freq':>7} {'SNR':>7}  {'status':<9} detail")
    for res in st["results"]:
        detail = (f"avg {res['average_preserved']:.1f} preserved"
                  f"{' (flipped)' if res.get('x_star_flipped') else ''}"
                  if res["status"] == "written" else f"reason={res['reason']}")
        print(f"{res['mode_no']:>4} {res.get('frequency_hz',0):>7.1f} {res['mode_snr']:>6.1f}x  "
              f"{res['status']:<9} {detail}")

    print("\n=== readback verification ===")
    fb_after = get("feedback/output")
    ok_all = True
    for res in st["results"]:
        m = res["mode_no"]
        if res["status"] != "written":
            print(f" mode {m}: skipped ({res['reason']}) -> not written (correct)")
            continue
        col = column(fb_after, m)
        matches = np.allclose(col, np.array(res["new_col"]), atol=1e-4)
        avg_ok = np.isclose(float(np.mean(col)), res["average_preserved"], atol=1e-3)
        print(f" mode {m}: readback==written {matches}  avg preserved {avg_ok} "
              f"(mean={np.mean(col):.3f} A={res['average_preserved']:.3f})")
        ok_all = ok_all and matches and avg_ok

    outside_after = column(fb_after, outside)
    untouched = np.allclose(outside_before, outside_after, atol=1e-6)
    print(f"\n mode {outside} (OUTSIDE range) untouched: {untouched}")
    print(f"\nSUMMARY: written+preserved OK={ok_all}, outside-untouched={untouched}, "
          f"total {st['written']} written / {st['skipped']} skipped of {st['total']}")


if __name__ == "__main__":
    main()
