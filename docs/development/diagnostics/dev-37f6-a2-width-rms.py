"""dev-37f6 A2 measurement: offline note_playback RMS vs hammer WIDTH (audio_off surface).

For a fixed pitch+velocity, set hammer width to several values, render note_playback offline,
read the engine-reported "Generated Sound RMS". If RMS scales with width => A2 confirmed (loudness
not width-independent = the spatial_impulse=sum(shape) bug). BEFORE baseline; re-run after fix to
show width-independence.

Usage: PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-37f6-a2-width-rms.py
"""
import json, time, math, urllib.request

BASE = "http://127.0.0.1:5000"
PITCH = 60
VELOCITY = 100
DURATION_MS = 600
DX = 0.0101
L_MAIN = 0.606
WIDTHS = [round(1*DX, 5), round(3*DX, 5), 0.06, 0.12, 0.24]

def post(path, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())

def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.loads(r.read().decode())

def main():
    print(f"# dev-37f6 A2 width->RMS sweep  pitch={PITCH} vel={VELOCITY} dur={DURATION_MS}ms")
    print(f"# dx={DX} l_main={L_MAIN}  widths(m)={WIDTHS}")
    rows = []
    for w in WIDTHS:
        post(f"/set_parameter/hammer/{PITCH}", {str(PITCH): {"hammer_width": w}})
        time.sleep(0.3)
        sh = get(f"/get_hammer_shape/{PITCH}")
        stored_w = sh["params"]["hammer_width"]
        vals = sh["values"]
        spatial = sum(abs(float(x)) for x in vals)
        nonzero = sum(1 for x in vals if abs(x) > 1e-12)
        resp = post("/get_chart_test", {"chartType":"note_playback","pitch":PITCH,
                                        "velocity":VELOCITY,"duration_ms":DURATION_MS})
        tf = resp.get("text_fields", {})
        rms = tf.get("Generated Sound RMS")
        smax = tf.get("Generated Sound Max")
        # parse leading float out of the field
        def f(s):
            try: return float(str(s).split()[0])
            except Exception: return None
        rms_v, max_v = f(rms), f(smax)
        rows.append((w, stored_w, spatial, nonzero, rms_v, max_v))
        print(f"width_set={w:<8} stored={stored_w:<8} spatial_sum={spatial:<10.4f} nz_nodes={nonzero:<3} "
              f"RMS={rms_v!r:<14} Max={max_v!r}")
    base = next((r[4] for r in rows if r[4]), None)
    print("\n# Summary: width  stored  spatial_sum  nz  RMS  RMS/RMS[0]  spatial/spatial[0]")
    base_sp = rows[0][2] if rows else None
    for w, sw, sp, nz, rms, mx in rows:
        rr = (rms/base) if (rms and base) else None
        sr = (sp/base_sp) if (sp and base_sp) else None
        print(f"  {w:<7} {sw:<7} {sp:<11.4f} {nz:<3} RMS={rms!r:<12} "
              f"RMS_ratio={rr if rr is None else round(rr,3)!r:<8} spatial_ratio={sr if sr is None else round(sr,3)!r}")
    print("\n# A2 verdict: if RMS_ratio tracks width/spatial_ratio (rises with width) => loudness NOT")
    print("#             width-independent => A2 CONFIRMED (spatial_impulse=sum(shape) scales loudness).")

if __name__ == "__main__":
    main()
