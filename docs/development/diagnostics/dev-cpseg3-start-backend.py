#!/usr/bin/env python3
"""Start the clean backend identically to the FIXED capture: launch
backendServer.py detached, wait for /health, then POST /load_preset with the
Belarus_196modesC_Fanera6exc preset, ASIO_CALLBACK (type 4), audio_on=1,
start_right_away=1 — matching the FIXED backend health we captured against.
Exits 0 when audio_driver_active && gpu_initialized.
"""
import json, os, subprocess, sys, time
import urllib.request

ROOT = r"D:\repos\PianoidInstall\PianoidCore"
MW = os.path.join(ROOT, "pianoid_middleware")
PY = os.path.join(ROOT, ".venv", "Scripts", "python.exe")
SERVER = os.path.join(MW, "backendServer.py")
OUT = r"D:\repos\PianoidInstall\dev-cpseg3-clean-backend.out.log"
ERR = r"D:\repos\PianoidInstall\dev-cpseg3-clean-backend.err.log"
BASE = "http://localhost:5000"


def health():
    try:
        return json.loads(urllib.request.urlopen(BASE + "/health", timeout=5).read())
    except Exception:
        return {}


def post(path, body, timeout=120):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def main():
    env = dict(os.environ)
    env["VIRTUAL_ENV"] = ""
    with open(OUT, "w") as o, open(ERR, "w") as e:
        p = subprocess.Popen([PY, SERVER], cwd=MW, stdout=o, stderr=e,
                             creationflags=0x00000008)  # DETACHED_PROCESS
    print("backend pid", p.pid)
    with open(r"D:\repos\PianoidInstall\dev-cpseg3-clean-backend.pid", "w") as f:
        f.write(str(p.pid))

    # wait for server to answer /health (gpu may not be init yet)
    for _ in range(60):
        if health():
            break
        time.sleep(1)
    else:
        print("HEALTH never came up"); sys.exit(2)

    body = {
        "path": "presets/Belarus_196modesC_Fanera6exc.json",
        "listen_to_midi": 0, "midi_port": 0, "use_simulation": 0, "debug_mode": 0,
        "audio_driver_type": 4, "cycle_iterations": 64, "audio_buffer_size": 4,
        "array_size": 384, "sample_rate": 48, "string_iterations": 4,
        "volume": 120, "audio_on": 1, "start_right_away": 1,
        "listen_to_modes": 1, "use_cuda": 1,
    }
    print("posting /load_preset ...")
    try:
        raw = post("/load_preset", body, timeout=180)
        print("load_preset resp:", raw.decode("utf-8", "replace")[:400])
    except Exception as ex:
        print("load_preset FAILED:", ex); sys.exit(3)

    for _ in range(30):
        h = health()
        lc = h.get("lifecycle", {})
        if lc.get("gpu_initialized") and lc.get("audio_driver_active"):
            print("READY gpu_init+audio_active=True pianoid_loaded=", h.get("pianoid_loaded"))
            sys.exit(0)
        time.sleep(1)
    print("NOT READY after load_preset; health=", json.dumps(health())[:300])
    sys.exit(4)


if __name__ == "__main__":
    main()
