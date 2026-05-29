"""dev-liveui-3a08 — per-pitch LIVE capture + overflow reconstruction for the 55/56/57 trichotomy.

Triggered AFTER the on-screen Virtual Piano plays each note (the UI canvas dispatches /play via playNote).
This script does NOT play notes itself when --capture-only is set; it only reads the LIVE rawSoundBuffer
('sound' chart -> getRawSoundRecord -> dev_soundFloat = the raw PRE-volume `output`) and reconstructs the
LITERAL driver samples soundInt = int32(output * main_volume_coefficient) to expose overflow.

Why this is the real path (not the float trap): `output` (float) is the INPUT to the kernel's
  soundInt[i] = Sint32(output * main_volume_coefficient);   (SYNTHESIS_ENGINE.md:484, NO limiter)
The prior agents' error was stopping at `output` without applying the cast. There is NO Python/REST path to
dev_soundInt and NO mic loopback (_MIC_LOOPBACK_CONFIGURED=False), so reconstruction from captured `output` +
the measured coefficient is the faithful way to see what the driver actually receives.

Two phases controlled by argv:
  --play-and-capture P : (used by the harness when NOT driving the canvas) plays pitch P via /play, holds,
                         captures DURING sustain and AFTER note-off, prints envelope + overflow stats. JSON line.
  --capture P TAG      : capture-only of the current live ring for pitch P with a label (used right after a
                         canvas-driven note while it still rings). JSON line.

main_volume_coefficient: computed from the documented formula in pianoid.py:
  legacy:  max_volume = exp((volume+64)/8) ** (127/64)
  coeff(level) = volume_center * volume_range^((level-64)/63),  volume_center = max_volume^(64/127),
                 volume_range default 10  ->  at level=64, coeff = volume_center.
Pass --volume V --level L --mvc M to override; if --mvc given it is used verbatim (preferred = measured).

Usage:
  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-liveui-3a08-perpitch-capture.py \
      --play-and-capture 56 --volume 120 --level 127
"""
import sys, json, time, math, base64, struct
import urllib.request, urllib.error

BASE = "http://127.0.0.1:5000"
VOLUME = 120.0     # preset init 'volume' (dialog showed 120)
LEVEL = 127        # toolbar Level ff -> velocity 127; volume slider level (separate) defaults 64
VRANGE = 10.0
MVC_OVERRIDE = None
MODE = None
PITCH = None
TAG = ""

argv = sys.argv[1:]
i = 0
while i < len(argv):
    a = argv[i]
    if a == "--play-and-capture":
        MODE = "play"; PITCH = int(argv[i+1]); i += 2; continue
    if a == "--capture":
        MODE = "capture"; PITCH = int(argv[i+1]); TAG = argv[i+2]; i += 3; continue
    if a == "--volume": VOLUME = float(argv[i+1]); i += 2; continue
    if a == "--level": LEVEL = float(argv[i+1]); i += 2; continue
    if a == "--mvc": MVC_OVERRIDE = float(argv[i+1]); i += 2; continue
    i += 1


def compute_mvc(volume, vol_slider_level, vrange):
    # legacy main_volume -> max_volume
    legacy_coeff_at_64 = math.exp((volume + 64) / 8.0)
    max_volume = legacy_coeff_at_64 ** (127.0 / 64.0)
    volume_center = max_volume ** (64.0 / 127.0)
    coeff = volume_center * (vrange ** ((vol_slider_level - 64.0) / 63.0))
    return coeff, max_volume


def _post(path, payload, timeout=60):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:
        return -1, str(e)


def play(pitch, command, velocity=127):
    return _post("/play", {"pitch": pitch, "command": command, "velocity": velocity})


def capture_output(length=72000, channel=0):
    """Live rawSoundBuffer via the 'sound' chart = dev_soundFloat = raw PRE-volume `output`."""
    st, body = _post("/get_chart_test", {"chartType": "sound", "length": length, "channel": channel})
    try:
        d = json.loads(body)
    except Exception:
        return []
    data = d.get("data")
    if isinstance(data, list) and data and isinstance(data[0], list):
        return [x for x in data[0] if isinstance(x, (int, float))]
    return []


def reset_ring():
    _post("/capture", {})
    time.sleep(0.15)


def analyze(out, mvc):
    n = len(out)
    if n == 0:
        return {"n": 0, "empty": True}
    finite = [x for x in out if math.isfinite(x)]
    nan = n - len(finite)
    peak = max((abs(x) for x in finite), default=0.0)
    rms = (sum(x * x for x in finite) / len(finite)) ** 0.5 if finite else 0.0
    seg = max(1, n // 10)
    peak_attack = max((abs(x) for x in finite[:seg]), default=0.0)
    peak_tail = max((abs(x) for x in finite[-seg:]), default=0.0)
    rms_attack = (sum(x*x for x in finite[:seg]) / seg) ** 0.5
    rms_tail = (sum(x*x for x in finite[-seg:]) / seg) ** 0.5
    sustain_ratio = (peak_tail / peak_attack) if peak_attack > 0 else 0.0
    # zero-crossing rate (broadband-noise / click proxy)
    zcr = 0.0
    if len(finite) > 2:
        s = [1 if x >= 0 else -1 for x in finite]
        zcr = sum(1 for a, b in zip(s, s[1:]) if a != b) / (len(s) - 1)
    # ---- overflow reconstruction: the LITERAL driver samples ----
    INT32_MAX = 2**31 - 1
    INT32_MIN = -(2**31)
    scaled_peak = peak * mvc
    overflow_frac = 0.0
    wrapped_frac = 0.0
    if finite:
        ov = 0; wr = 0
        for x in finite:
            v = x * mvc
            if v > INT32_MAX or v < INT32_MIN:
                ov += 1
                # emulate C++ (Sint32) truncation wraparound on the 64-bit->32-bit cast
                iv = int(v) & 0xFFFFFFFF
                if iv >= 2**31:
                    iv -= 2**32
                # sign flip vs intended => audible wrap
                if (iv >= 0) != (v >= 0):
                    wr += 1
        overflow_frac = ov / len(finite)
        wrapped_frac = wr / len(finite)
    return {
        "n": n, "nan": nan,
        "peak_output": peak, "rms_output": rms,
        "peak_attack": peak_attack, "peak_tail": peak_tail,
        "rms_attack": rms_attack, "rms_tail": rms_tail,
        "sustain_ratio": round(sustain_ratio, 4),
        "zcr": round(zcr, 4),
        "mvc": mvc,
        "scaled_peak_x_int32max": round(scaled_peak / INT32_MAX, 3),  # >1.0 => clips/overflows
        "overflow_frac": round(overflow_frac, 4),       # fraction of samples beyond int32 range
        "sign_wrapped_frac": round(wrapped_frac, 4),    # fraction whose sign FLIPS on cast (audible garbage)
    }


def main():
    mvc = MVC_OVERRIDE if MVC_OVERRIDE is not None else compute_mvc(VOLUME, 64.0, VRANGE)[0]
    if MODE == "capture":
        out = capture_output()
        res = analyze(out, mvc)
        res["pitch"] = PITCH; res["tag"] = TAG
        print(json.dumps(res))
        return
    if MODE == "play":
        # full play+capture cycle (used when NOT driving the canvas)
        reset_ring()
        play(PITCH, 144, int(LEVEL))
        time.sleep(1.2)
        on = capture_output()
        r_on = analyze(on, mvc)
        play(PITCH, 128, 0)
        time.sleep(2.2)
        off = capture_output()
        r_off = analyze(off, mvc)
        decay_ratio = (r_off.get("rms_output", 0) / r_on["rms_output"]) if r_on.get("rms_output", 0) > 0 else 0.0
        verdict = {
            "pitch": PITCH,
            "DURING": r_on,
            "AFTER_OFF": r_off,
            "after_off_rms_over_during_rms": round(decay_ratio, 4),
            "note_off_decays": decay_ratio < 0.25,
            "is_click": (r_on.get("sustain_ratio", 1) < 0.05),
        }
        print(json.dumps(verdict))
        return
    print(json.dumps({"error": "no MODE; pass --play-and-capture P or --capture P TAG"}))


if __name__ == "__main__":
    main()
