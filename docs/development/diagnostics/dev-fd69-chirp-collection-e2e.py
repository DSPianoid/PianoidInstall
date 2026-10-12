"""dev-fd69 rig test 5: chirp collection end to end through the modal adapter REST (:5001).

New Measurement (chirp = the new default excitation), ASIO channels as on the rig (Out 1-4,
In 1-7, loopback Out 5 -> In 8), 5 measurements per exciter -> project (1 s averaged IRs) ->
mapping (ch0 reference, 1-6 response, 7 skipped, as ASIO-rig-2026-10-11b_p1) -> ESPRIT with the
same band config. Prints the per-scenario mode counts; results land in D:/modal_projects/<name>.
"""
import json
import sys
import time

import requests

B = "http://127.0.0.1:5001/modal"
MID = sys.argv[1] if len(sys.argv) > 1 else "ASIO-chirp-2026-10-12"
OLD_CFG = r"D:\modal_projects\ASIO-rig-2026-10-11b_p1\modal_adapter\esprit\config.json"


def call(method, path, **kw):
    r = requests.request(method, B + path, timeout=kw.pop("timeout", 600), **kw)
    try:
        js = r.json()
    except ValueError:
        js = {"text": r.text[:300]}
    print(method, path, r.status_code, json.dumps(js)[:300], flush=True)
    if r.status_code >= 400:
        raise SystemExit(f"{path} failed")
    return js


audio = json.load(open(r"D:\modal_measurements\ASIO-rig-2026-10-11b\setup\audio_config.json"))
call("POST", "/measurements", json={"measurement_id": MID, "audio_config": audio,
                                    "series_config": {"num_measurements": 5,
                                                      "measurement_interval_s": 0.3}})
m = call("GET", f"/measurements/{MID}")
t0 = time.time()
call("POST", f"/measurements/{MID}/collect/start", json={"scenario_number": 0})
while True:
    time.sleep(3)
    st = requests.get(f"{B}/measurements/{MID}/collect/status", timeout=30).json()
    ph = st.get("phase")
    if ph in ("done", "error", "cancelled", "idle"):
        print("collect", ph, round(time.time() - t0), "s", (st.get("error") or ""), flush=True)
        break
if ph != "done":
    raise SystemExit("collection did not finish")
proj = f"{MID}_p1"
call("POST", "/projects", json={"name": proj, "measurement_id": MID, "signal_length_ms": 1000})
call("POST", "/projects/open", json={"name": proj})
call("POST", "/mapping", json={"channel_roles": {"0": "reference", **{str(i): "response" for i in range(1, 7)}},
                               "skipped_channels": [7], "layout_type": "line"})
cfg = json.load(open(OLD_CFG))
t1 = time.time()
res = call("POST", "/run_esprit", json=cfg, timeout=1800)
print("ESPRIT", round(time.time() - t1), "s", flush=True)
