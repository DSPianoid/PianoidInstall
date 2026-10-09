"""dev-1cda — forced-shortage test of the ONLINE pre-flight (post-startAudioDriver re-check).

Init passes (real SM count); then PIANOID_COOP_SM_BUDGET is set so the online re-check sees
fewer SMs than the grid needs. Expect: the realtime engine runs 0 cycles and stops, and the
module report says phase=online ok=False. Audio off (no driver) — the check is driver-agnostic.

Run from PianoidCore/pianoid_middleware with PYTHONPATH=<cap bin dir>:
    python dev-1cda-online-shortage.py <preset> <sm_budget>
"""
import json
import os
import sys
import time

sys.path.insert(0, os.getcwd())
from pianoid import initialize  # noqa: E402

PRESET, BUDGET = sys.argv[1], sys.argv[2]
KW = {"F15_Elyashev_array512": dict(string_iteration=16, array_size=512, listen_to_modes=False,
                                    sound_derivative_order=1),
      "Belarus_8band_196modes": dict(string_iteration=4, array_size=384, listen_to_modes=False,
                                     sound_derivative_order=2)}[PRESET]

pw = initialize(f"presets/{PRESET}.json", filterlen=48 * 128 * 3, buffer_size=4, sample_rate=48000,
                samples_in_cycle=64, audio_on=False, audio_driver_type=0, use_debug_build=os.environ.get("DEV1CDA_DEBUG") == "1", **KW)
pc = sys.modules["pianoidCuda_debug" if os.environ.get("DEV1CDA_DEBUG") == "1" else "pianoidCuda"]
print("INIT REPORT:", json.dumps(dict(pc.getCoopOccupancyReport())))
DEBUG = os.environ.get("DEV1CDA_DEBUG") == "1"       # debug variant (debug realtime path)
if BUDGET != "none":                                 # "none" = control run: no shortage expected
    os.environ["PIANOID_COOP_SM_BUDGET"] = BUDGET
pw.start_pianoid()
time.sleep(3)
rep = dict(pc.getCoopOccupancyReport())
print("ONLINE REPORT:", json.dumps(rep))
print("isApplicationRunning:", pw.pianoid.isApplicationRunning(), "pw.exception:", getattr(pw, "exception", None))
try:
    pw.stop_playback()
except Exception as e:
    print("stop_playback:", e)
pw.pianoid.shutdownGpu()
expect_fail = BUDGET != "none"
passed = rep["phase"] == "online" and rep["ok"] is (not expect_fail) and bool(pw.exception) is expect_fail
print("RESULT:", "PASS" if passed else "FAIL")
