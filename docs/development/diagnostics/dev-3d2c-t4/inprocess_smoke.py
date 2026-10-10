"""dev-3d2c in-process smoke (T4 scratch bins + branch Basic via PYTHONPATH): real Flask routes via app.test_client(),
no port bound; ASIO callback audio on. Legacy Belarus, then Belarus N2000 (flat tier), then legacy again."""
import json, os, sys, time
MW = r"D:\repos\wt-3d2c-core\pianoid_middleware"
os.chdir(MW); sys.path.insert(0, MW)
import backendServer as bs  # noqa: E402
import pianoidCuda
print("PYD", pianoidCuda.__file__)
c = bs.app.test_client()
COMMON = {"listen_to_midi": 0, "midi_port": 0, "use_simulation": 0, "debug_mode": 0, "audio_driver_type": 4,
          "cycle_iterations": 64, "audio_buffer_size": 4, "sample_rate": 48, "volume": 100, "audio_on": 1,
          "start_right_away": 1, "use_cuda": 1, "array_size": 384, "string_iterations": 4,
          "listen_to_modes": 0, "sound_derivative_order": 2}
def j(r):
    try: return r.get_json()
    except Exception: return r.data[:300]
def health():
    h = j(c.get("/health"))
    keys = ("status", "running", "peak_level", "audio_driver", "audio_health", "cooperative_launch")
    return {k: h.get(k) for k in keys if isinstance(h, dict) and k in h}
def play_p60():
    c.post("/clear_limiting"); time.sleep(0.3)
    r = c.post("/play", json={"pitch": 60, "velocity": 100, "command": 144}); time.sleep(1.5)
    c.post("/play", json={"pitch": 60, "velocity": 0, "command": 128})
    h = j(c.get("/health"))
    return r.status_code, h.get("peak_level"), (h.get("limiter") or {}).get("peak_levels")
def load(path, label):
    t0 = time.time(); r = c.post("/load_preset", json=dict(COMMON, path=path)); body = j(r)
    print(label, "load", r.status_code, round(time.time() - t0, 1), "s", json.dumps(body, default=str)[:300] if not isinstance(body, bytes) else body)
    time.sleep(2.0)
    print(label, "health", json.dumps(health(), default=str)[:700])
    print(label, "play", play_p60())
    print(label, "engine num_modes", bs.pianoid.mp.num_modes_for_model if getattr(bs, "pianoid", None) else "?")
    return r.status_code
ok = load("presets/Belarus_8band_196modes.json", "BELARUS") == 200
ok &= load(r"D:\scratch\dev-3d2c\presets\Belarus_8band_196modes_N2000.json", "BELARUS_N2000") == 200
ok &= load("presets/Belarus_8band_196modes.json", "BELARUS_AGAIN") == 200
print("SMOKE_OK", ok)
r = c.post("/shutdown"); print("shutdown", r.status_code)
os._exit(0)
