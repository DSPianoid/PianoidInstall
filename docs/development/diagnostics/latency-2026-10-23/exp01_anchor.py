"""exp01 - capture anchor + note-on latency baselines.
A: /play_keyboard marker note (scheduled in-handler right after startMicCapture) -> onset index
   = engine note latency (schedule -> In 8) + capture-arm offset.
B: quiet marker + WS 'play' NOTE_ON at t_req+0.5 s -> WS note latency, client clock.
C: same with REST /play.
Also /ping RTT (REST) and ping_ws RTT (WS)."""
import sys
import time

import numpy as np

from latlib import Capture, WS, reset, post, play_rest, onset, save_json, stats, FS, SESSION, B

N = int(sys.argv[1]) if len(sys.argv) > 1 else 5
ws = WS()
out = {"A": [], "B": [], "C": [], "ping_rest_ms": [], "ping_ws_ms": []}
for i in range(20):
    t = time.time(); SESSION.get(B + "/ping"); out["ping_rest_ms"].append((time.time() - t) * 1e3)
    _, a, b = ws.emit_ack('ping_ws', {}); out["ping_ws_ms"].append((b - a) * 1e3)

for rep in range(N):
    reset(); time.sleep(1.0)
    cap = Capture(marker_pitch=60, marker_vel=100, speed_ms=600, tail_ms=400, tag=f"exp01A_r{rep}")
    cap.start(); x = cap.wait()
    i0 = onset(x, 0, noise_win=240)
    out["A"].append({"onset_ms": i0 / FS * 1e3, "n": len(x), "t_req": cap.t_req, "resp_s": cap.t_resp - cap.t_req, "wav": cap.path})

    for mode in ("B", "C"):
        reset(); time.sleep(1.0)
        cap = Capture(marker_pitch=21, marker_vel=1, speed_ms=600, tail_ms=400, tag=f"exp01{mode}_r{rep}")
        tr = cap.start()
        while time.time() < tr + 0.5:
            time.sleep(0.0002)
        if mode == "B":
            ts = ws.play(72, 100)
        else:
            ts = time.time(); play_rest(72, 100)
        x = cap.wait()
        i1 = onset(x, int(0.45 * FS), noise_win=1200)
        out[mode].append({"onset_ms": i1 / FS * 1e3 if i1 else None, "t_send_rel_ms": (ts - tr) * 1e3,
                          "lat_vs_treq_ms": (i1 / FS - (ts - tr)) * 1e3 if i1 else None, "wav": cap.path})
        if mode == "B":
            ws.play(72, 0, 128)
        else:
            play_rest(72, 0, 128)
    print(rep, out["A"][-1]["onset_ms"], out["B"][-1]["lat_vs_treq_ms"], out["C"][-1]["lat_vs_treq_ms"], flush=True)

summary = {"A_marker_onset_ms": stats([r["onset_ms"] for r in out["A"]]),
           "B_ws_note_ms_vs_t0eqTreq": stats([r["lat_vs_treq_ms"] for r in out["B"]]),
           "C_rest_note_ms_vs_t0eqTreq": stats([r["lat_vs_treq_ms"] for r in out["C"]]),
           "ping_rest_ms": stats(out["ping_rest_ms"]), "ping_ws_ms": stats(out["ping_ws_ms"])}
out["summary"] = summary
print(save_json("exp01_anchor.json", out))
for k, v in summary.items():
    print(k, v)
ws.close()
