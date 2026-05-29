"""dev-soundint-live — POST-VOLUME soundInt capture + overflow analysis for the 55/56/57 trichotomy.

WHY: every readout available before this session reads dev_soundFloat = PRE-volume (the displacement-
derived `output`). The signal the audio DRIVER actually receives is dev_soundInt = Sint32(output *
main_volume_coefficient), written UNCLAMPED at MainKernel.cu:492 (strings) / :627 (modes). When
main_volume_coefficient is large (user runs volume=120 → mvc can be ~1e9+), output*mvc can exceed the
Sint32 range (+/-2,147,483,647) and the static_cast wraps → sign-flipped / garbage samples = the
"incorrectly rendered" note the user hears. soundFloat never shows this (it's pre-volume), which is why
every prior "engine clean" reading missed it.

This script reads the NEW post-volume ring via the `sound_int` chart (chartFunctions.sound_int_function ->
getRawSoundRecordInt) AND the existing pre-volume `sound` chart (-> getRawSoundRecord), for the SAME
capture window, and computes the overflow signature: scaled_peak vs INT32_MAX, % of samples at/over the
INT32 rail, and sign-flip count (samples whose soundInt sign disagrees with soundFloat*mvc sign = the
proof of a wrapped cast).

MEASUREMENT ONLY — it does NOT trigger notes. Notes are triggered by GENUINE LIVE-UI Virtual Piano clicks
in a real browser (the hard constraint of this task; REST /play is the contamination that made every prior
reading miss the bug). The browser is driven separately (chrome-devtools / Playwright). This script:
  1. POST /capture                 -> reset BOTH rings (clearRecords zeroes float + int ring)
  2. (operator clicks pitch in UI) -> waits the configured hold/observe window
  3. reads `sound_int` + `sound`   -> computes per-window stats
Use --window to set the post-click observe seconds; call once per (pitch, phase) with a /capture reset
between every window (the dev-cflfix-live-ab-repro.py reset_records discipline — avoids the 5s ring-wrap
artifact that wrecked prior sessions, memory feedback_ring_buffer_wrap_artifact).

Usage:
  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-soundint-live-capture.py reset
      -> POST /capture, print mvc + driver/preset state. Run BEFORE each live click.
  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-soundint-live-capture.py measure --tag="p56-attack"
      -> read both rings NOW, print overflow stats for the current ring contents. Run AFTER the click+hold.
  [--port=5000] [--channel=0]
"""
import sys, os, json, time, base64, struct, math
import urllib.request, urllib.error

PORT = "5000"
CHANNEL = 0
TAG = ""
CMD = sys.argv[1] if len(sys.argv) > 1 else "measure"
for a in sys.argv[2:]:
    if a.startswith("--port="):    PORT = a.split("=", 1)[1]
    elif a.startswith("--channel="): CHANNEL = int(a.split("=", 1)[1])
    elif a.startswith("--tag="):   TAG = a.split("=", 1)[1]
BASE = f"http://127.0.0.1:{PORT}"
INT32_MAX = 2147483647


def _post(path, payload, timeout=120):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:
        return -1, str(e)


def _get(path, timeout=30):
    try:
        with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, {"_http_error": e.code, "body": e.read().decode()[:200]}
    except Exception as e:
        return -1, {"_err": str(e)}


def health_and_mvc():
    st, d = _get("/health")
    loaded = isinstance(d, dict) and d.get("pianoid_loaded")
    drv = isinstance(d, dict) and d.get("lifecycle", {}).get("audio_driver_active")
    lm = d.get("listen_mode") if isinstance(d, dict) else "?"
    print(f"/health: {st} pianoid_loaded={loaded} audio_driver_active={drv} listen_mode={lm}")
    # main_volume_coefficient — READ the live value (do NOT infer it). Exposed via /get_parameter.
    for key in ("volume_coefficient", "current_volume_coefficient", "main_volume_coefficient"):
        sst, sd = _get(f"/get_parameter/{key}/0")
        if sst == 200 and isinstance(sd, dict):
            print(f"/get_parameter/{key}: {sd}")
            break
    return bool(loaded)


def reset():
    """POST /capture — clearRecords zeroes BOTH the float ring and (after the hook) the int ring."""
    st, body = _post("/capture", {})
    print(f"POST /capture: {st} {body[:120]}")


def _read_chart(chart_type, length=240000):
    """Read a chart's raw numeric array (data[channel]). For sound_int this is the post-volume Sint32 ring."""
    st, body = _post("/get_chart_test", {"chartType": chart_type, "length": length, "channel": CHANNEL})
    try:
        d = json.loads(body)
    except Exception:
        return None, f"non-json chart resp ({st}): {body[:160]}"
    if not isinstance(d, dict):
        return None, f"chart resp not dict ({st}): {str(d)[:160]}"
    data = d.get("data")
    if not data or not isinstance(data, list) or not data[0]:
        return None, f"chart {chart_type}: empty data ({st})"
    # data[0] is the first chart's array (channel already selected server-side via `channel` kwarg)
    return [float(x) for x in data[0]], None


def _stats(arr):
    if not arr:
        return dict(n=0)
    n = len(arr)
    peak = max(abs(x) for x in arr)
    rms = math.sqrt(sum(x * x for x in arr) / n)
    return dict(n=n, peak=peak, rms=rms)


def measure():
    print(f"=== soundInt live measure  tag={TAG!r}  ({time.strftime('%H:%M:%S')}) ===")
    int_arr, int_err = _read_chart("sound_int")
    flt_arr, flt_err = _read_chart("sound")

    if int_err:
        print(f"  [sound_int] {int_err}")
    if flt_err:
        print(f"  [sound]     {flt_err}")

    fs = _stats(flt_arr)
    print(f"  soundFloat (PRE-volume) : n={fs.get('n')} peak={fs.get('peak')!r} rms={fs.get('rms')!r}")

    if int_arr:
        n = len(int_arr)
        ipeak = max(abs(x) for x in int_arr)
        irms = math.sqrt(sum(x * x for x in int_arr) / n)
        # Overflow signature on the POST-volume ring:
        #  - samples sitting at/beyond the INT32 rail (saturation / pre-wrap clamp absent here)
        #  - peak as a MULTIPLE of INT32_MAX (the memory's "scaled_peak 25-167x INT32" signature)
        at_rail = sum(1 for x in int_arr if abs(x) >= INT32_MAX * 0.999)
        peak_x_int32 = ipeak / INT32_MAX if INT32_MAX else 0.0
        # Sign-flip proof: where soundFloat (pre-volume) is clearly non-zero, soundInt sign should match
        # sign(output*mvc) = sign(output). A DISAGREEMENT = the Sint32 cast wrapped (overflow).
        sign_flips = 0
        compared = 0
        if flt_arr and len(flt_arr) == n:
            for fi, ii in zip(flt_arr, int_arr):
                if abs(fi) > 1e-6:  # only where pre-volume signal is meaningful
                    compared += 1
                    if (fi > 0) != (ii > 0) and abs(ii) > 0:
                        sign_flips += 1
        flip_pct = (100.0 * sign_flips / compared) if compared else 0.0
        print(f"  soundInt  (POST-volume) : n={n} peak={ipeak!r} ({peak_x_int32:.3f}x INT32_MAX) rms={irms!r}")
        print(f"    at/over INT32 rail     : {at_rail}/{n} samples ({100.0*at_rail/n:.2f}%)")
        print(f"    SIGN-FLIPS vs soundFloat: {sign_flips}/{compared} compared ({flip_pct:.2f}%)  <-- overflow proof if >0")
        # Verdict heuristic
        if peak_x_int32 > 1.0 or sign_flips > 0:
            print(f"    >>> OVERFLOW DETECTED in post-volume soundInt (peak {peak_x_int32:.1f}x INT32 / {sign_flips} sign-flips)")
        else:
            print(f"    >>> no overflow in this window (post-volume signal within INT32 range, no sign-flips)")
    else:
        print("  soundInt  (POST-volume) : UNAVAILABLE — is the sound_int chart wired + backend rebuilt with the hook?")
    print("=" * 64)


if __name__ == "__main__":
    if CMD == "reset":
        health_and_mvc()
        reset()
    elif CMD == "measure":
        measure()
    elif CMD == "health":
        health_and_mvc()
    else:
        print(__doc__)
        print(f"Unknown command {CMD!r}. Use: reset | measure | health")
