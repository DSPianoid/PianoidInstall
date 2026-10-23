"""exp07 - drive N keyboard-wide (n88) gauss writes (+restores) while py-spy samples the backend."""
import sys, time, latlib as L
N = int(sys.argv[1]) if len(sys.argv) > 1 else 6
KIND = sys.argv[2] if len(sys.argv) > 2 else "gauss"
ws = L.WS()
g = L.get("/get_parameter/gauss/from21to108"); h = L.get("/get_parameter/hammer/from21to108")
ks = [k for k in g]
if KIND == "gauss":
    new = {"parameter": "excitation", "key": "from21to108", "values": {k: {"127": {"2": {"volume": g[k]["127"]["2"]["volume"] * 0.5}}} for k in ks}}
    old = {"parameter": "excitation", "key": "from21to108", "values": {k: {"127": {"2": {"volume": g[k]["127"]["2"]["volume"]}}} for k in ks}}
else:
    new = {"parameter": "hammer", "key": "from21to108", "values": {k: {"hammer": {"hammer_position": 0.25}} for k in h}}
    old = {"parameter": "hammer", "key": "from21to108", "values": {k: {"hammer": {"hammer_position": h[k]["hammer"]["hammer_position"]}} for k in h}}
for i in range(N):
    a = ws.emit_ack("set_parameter", new, timeout=60); b = ws.emit_ack("set_parameter", old, timeout=60)
    print(i, round((a[2]-a[1])*1e3), round((b[2]-b[1])*1e3), flush=True)
ws.close()
