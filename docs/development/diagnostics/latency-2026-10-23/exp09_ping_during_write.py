"""exp09 - WS handler dispatch delay during a write: ping_ws RTT every 20 ms while a keyboard-wide
gauss write (n88) / hammer n88 / gauss n8 runs (second socket.io client so the write's socket is not the probe's)."""
import json, threading, time, sys
import latlib as L
w = L.WS(); p = L.WS()
g = L.get("/get_parameter/gauss/from21to108"); h = L.get("/get_parameter/hammer/from21to108")
def gc(lo, hi, f):
    ks = [str(k) for k in range(lo, hi + 1) if str(k) in g]
    return {"parameter": "excitation", "key": f"from{lo}to{hi}", "values": {k: {"127": {"2": {"volume": g[k]["127"]["2"]["volume"] * f}}} for k in ks}}
CASES = {"gauss_n88": (gc(21, 108, 0.5), gc(21, 108, 1.0)), "gauss_n8": (gc(57, 64, 0.5), gc(57, 64, 1.0)),
         "hammer_n88": ({"parameter": "hammer", "key": "from21to108", "values": {k: {"hammer": {"hammer_position": 0.25}} for k in h}},
                        {"parameter": "hammer", "key": "from21to108", "values": {k: {"hammer": {"hammer_position": h[k]["hammer"]["hammer_position"]}} for k in h}})}
out = {}
for name, (new, old) in CASES.items():
    for rep in range(3):
        box = {}
        def run():
            a = w.emit_ack("set_parameter", new, timeout=60); box["w"] = (a[1], a[2])
        th = threading.Thread(target=run); t0 = time.time(); th.start()
        rtts = []
        while th.is_alive() or time.time() - t0 < 0.2:
            _, a, b = p.emit_ack("ping_ws", {}); rtts.append(((a - t0) * 1e3, (b - a) * 1e3)); time.sleep(0.02)
        th.join(); w.emit_ack("set_parameter", old, timeout=60); time.sleep(0.5)
        ws_ = box["w"]
        during = [r for s, r in rtts if s <= (ws_[1] - t0) * 1e3]
        out.setdefault(name, []).append({"write_ms": (ws_[1] - ws_[0]) * 1e3, "ping_max_ms": max(during), "ping_median_ms": sorted(during)[len(during)//2], "n": len(during), "rtts": rtts})
        print(name, rep, "write", round((ws_[1]-ws_[0])*1e3), "ping during: median", round(sorted(during)[len(during)//2], 1), "max", round(max(during), 1), "n", len(during), flush=True)
L.save_json("exp09_ping_during_write.json", out)
w.close(); p.close()
