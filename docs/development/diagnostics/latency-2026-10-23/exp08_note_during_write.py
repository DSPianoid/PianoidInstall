"""exp08 - does a parameter write delay a concurrent note? WS NOTE_ON p72 sent X ms after a WS
write (gauss n8 / n88, hammer n88) is in flight; note latency (send -> In 8 onset) vs idle baseline.
Anchor = the capture's own in-handler marker? No: the note IS the measured event, so the capture
is anchored on an earlier WS NOTE_ON p48 (idle, t=0.3 s) whose latency is the baseline."""
import sys, threading, time
import numpy as np
import latlib as L

L.SCHED_TO_IN8_S = 0.0203125
REPS = int(sys.argv[1]) if len(sys.argv) > 1 else 4
ws = L.WS()
g = L.get("/get_parameter/gauss/from21to108"); h = L.get("/get_parameter/hammer/from21to108")


def gcase(lo, hi):
    ks = [str(p) for p in range(lo, hi + 1) if str(p) in g]
    key = f"from{lo}to{hi}"
    return ({"parameter": "excitation", "key": key, "values": {k: {"127": {"2": {"volume": g[k]["127"]["2"]["volume"] * 0.5}}} for k in ks}},
            {"parameter": "excitation", "key": key, "values": {k: {"127": {"2": {"volume": g[k]["127"]["2"]["volume"]}}} for k in ks}})


CASES = {"idle": None, "gauss_n8": gcase(57, 64), "gauss_n88": gcase(21, 108),
         "hammer_n88": ({"parameter": "hammer", "key": "from21to108", "values": {k: {"hammer": {"hammer_position": 0.25}} for k in h}},
                        {"parameter": "hammer", "key": "from21to108", "values": {k: {"hammer": {"hammer_position": h[k]["hammer"]["hammer_position"]}} for k in h}})}
res = {}
for name, spec in CASES.items():
    for X in ([0] if spec is None else [10, 50, 150]):
        lats = []
        for rep in range(REPS):
            box = {}
            def write():
                if spec is None:
                    return {}
                def run():
                    a = ws.emit_ack("set_parameter", spec[0], timeout=60); box["ack"] = (a[2] - a[1]) * 1e3
                th = threading.Thread(target=run, daemon=True); th.start(); box["th"] = th
                return {"t_send": time.time()}
            def note():
                return {"t_send": ws.play(72, 110)}
            t = L.run_capture(ws, [(1.0, write), (1.0 + X / 1000.0, note)], note=48, vel=100, length_s=2.5, tag=f"exp08_{name}_{X}_{rep}")
            ws.play(72, 0, 128)
            if spec is not None:
                box["th"].join(60); ws.emit_ack("set_parameter", spec[1], timeout=60)
            x = t["x"]; i48 = L.onset(x, int(0.25 * L.FS), noise_win=1200)
            # onset of p72 on top of the decaying p48: high-passed energy jump
            tn = t["acts"][-1]["t_send"]
            i_exp = i48 + int((tn - t["t_note_send"]) * L.FS)
            y = np.diff(x.astype(np.float64)); e = L.env_rms(y, 48)
            base = float(np.median(e[i_exp - 2400:i_exp - 240]))
            k = np.nonzero(e[i_exp - 240:] > 6 * base + 2e-4)[0]
            i72 = i_exp - 240 + int(k[0]) if k.size else None
            lat = (L.epoch_of_index(t, i72, i48) - tn) * 1e3 if i72 else None
            lats.append(lat)
            print(name, X, rep, None if lat is None else round(lat, 1), "ack", round(box.get("ack", 0), 1), flush=True)
        res[f"{name}|X{X}"] = {"lat": L.stats(lats), "raw": lats}
        print("SUMMARY", name, X, res[f"{name}|X{X}"]["lat"], flush=True)
L.save_json("exp08_note_during_write.json", res)
ws.close()
