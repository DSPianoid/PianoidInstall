"""dev-1cda — forced-shortage test of the INIT pre-flight through the real REST handlers.

In-process (no Flask port): imports the WORKTREE middleware's backendServer and drives it with
app.test_client(), so the user's stack on :5000 is never touched. Engine binary = --pyd-dir
(worktree build, never installed). audio_on=0 (no driver contention with the live stack).

Sequence (PIANOID_COOP_SM_BUDGET simulates SMs consumed by other GPU work):
  1. budget 57: F15_Elyashev_array512 (grid 58)  -> expect 500 coop_launch_shortage
  2. /health                                      -> cooperative_launch ok=False, phase=init
  3. budget 57: Belarus_8band_196modes (grid 56)  -> expect 200 (boundary: 56 <= 57)
  4. no budget: F15 again                         -> expect 200, capacity 128 (recovery in-process)

Usage (cwd = <worktree>/pianoid_middleware, venv python):
  python dev-1cda-shortage-rest.py --pyd-dir D:/scratch/dev-1cda/bin_cap
"""
import argparse
import json
import os
import sys

ap = argparse.ArgumentParser()
ap.add_argument('--pyd-dir', required=True)
args = ap.parse_args()
sys.path.insert(0, args.pyd_dir)
import pianoidCuda  # noqa: E402
print('pianoidCuda from', pianoidCuda.__file__)
sys.path.insert(0, os.getcwd())
import backendServer as B  # noqa: E402

C = B.app.test_client()
BODY = {"F15_Elyashev_array512": dict(array_size=512, string_iterations=16, listen_to_modes=0,
                                      sound_derivative_order=1),
        "Belarus_8band_196modes": dict(array_size=384, string_iterations=4, listen_to_modes=0,
                                       sound_derivative_order=2)}
results = []


def load(preset, budget):
    if budget is None:
        os.environ.pop("PIANOID_COOP_SM_BUDGET", None)
    else:
        os.environ["PIANOID_COOP_SM_BUDGET"] = str(budget)
    body = dict(path=f"presets/{preset}.json", cycle_iterations=64, sample_rate=48000, audio_on=0,
                audio_driver_type=0, start_right_away=0, listen_to_midi=0, **BODY[preset])
    r = C.post('/load_preset', json=body)
    h = C.get('/health').get_json()
    row = {"preset": preset, "sm_budget": budget, "load_status": r.status_code,
           "load_body": r.get_json(), "health_pianoid_loaded": h.get("pianoid_loaded"),
           "health_cooperative_launch": h.get("cooperative_launch")}
    results.append(row)
    print(json.dumps(row, indent=1))
    return row


r1 = load("F15_Elyashev_array512", 57)
r2 = load("Belarus_8band_196modes", 57)
r3 = load("F15_Elyashev_array512", None)
ok = (r1["load_status"] == 500 and r1["load_body"].get("code") == "coop_launch_shortage"
      and r1["health_cooperative_launch"]["ok"] is False
      and r2["load_status"] == 200 and r2["health_cooperative_launch"]["ok"] is True
      and r2["health_cooperative_launch"]["capacity"] == 57
      and r3["load_status"] == 200 and r3["health_cooperative_launch"]["capacity"] == 128)
try:
    B.pianoid.destroyPianoid()
except Exception as e:
    print("destroy:", e)
print("RESULT:", "PASS" if ok else "FAIL")
os._exit(0 if ok else 1)
