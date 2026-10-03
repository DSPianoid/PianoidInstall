"""dev-f27f: L2 smoke test against a running backend (:5000): POST /load_preset for each preset, expect 200
and an engine that reports healthy. Usage: python dev-f27f-l2-smoke.py"""
import json
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:5000"
COMMON = {"listen_to_midi": 0, "midi_port": 0, "use_simulation": 0, "debug_mode": 0, "audio_driver_type": 0,
          "cycle_iterations": 64, "audio_buffer_size": 4, "sample_rate": 48, "volume": 120, "audio_on": 0,
          "start_right_away": 0, "use_cuda": 1}
PRESETS = [
    {"path": "presets/BaselinePreset1.json", "array_size": 384, "string_iterations": 4, "listen_to_modes": 1},
    {"path": "presets/Belarus_8band_196modes_FPGAexc.json", "array_size": 384, "string_iterations": 4,
     "listen_to_modes": 0},
    {"path": "presets/F15_Elyashev_array512.json", "array_size": 512, "string_iterations": 16, "listen_to_modes": 0,
     "sound_derivative_order": 1},
]


def call(method, path, body=None, timeout=600):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


def main():
    ok = True
    for p in PRESETS:
        t0 = time.time()
        st, txt = call("POST", "/load_preset", dict(COMMON, **p))
        hs, htxt = call("GET", "/health", timeout=30)
        print(json.dumps({"preset": p["path"], "status": st, "secs": round(time.time() - t0, 1), "health": hs,
                          "body": txt[:300], "health_body": htxt[:300]}))
        ok &= st == 200 and hs == 200
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
