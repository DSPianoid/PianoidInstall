"""analyse-loudphys (2026-10-04) -- write single-factor preset VARIANTS (pure JSON edit, no engine).

    python analyse-loudphys-variants.py SRC.json DST.json VARIANT [ARGS]

VARIANT
  rhoT_x:F:P1,P2     rho, tension, jung of the listed pitches x F   (same c, f0, bending/rho, CFL; Z x sqrt F)
  rho_eq:REF         every key pitch: rho -> rho(REF); tension, jung scaled by rho(REF)/rho(p)  (same f0 per pitch)
  main_x:F:P1,P2     geometry.main of the listed pitches x F  (dx = length/main -> dx / F; length fixed)
  width_x:F:P1,P2    hammer_width of the listed pitches x F
  tension_x:F:P1,P2  tension only (f0 x sqrt F)
  curve_time_x:F:P1,P2  every excitation curve (all 128 levels, 5 gaussians) mu and sigma x F  (pulse F x longer)
  hammer_off:P1,P2   hammer_offset = 10 -> the hammer lands beyond the string end on strings 2..n (unstruck,
                     still coupled); only string 1 of the pitch is struck  (unison-count test)
"""
import base64
import json
import sys

import numpy as np


def decode(blob):
    return np.frombuffer(base64.b64decode(blob["data"]), np.dtype(blob["type"])).reshape(blob["shape"]).copy()


def encode(arr):
    return {"data": base64.b64encode(arr.tobytes()).decode("utf-8"), "shape": list(arr.shape), "type": str(arr.dtype)}


def key_pitches(d):
    return [k for k in d["pitches"] if int(k) < 128]


def main():
    src, dst, variant = sys.argv[1:4]
    d = json.load(open(src))
    parts = variant.split(":")
    kind = parts[0]
    if kind == "rho_eq":
        ref = d["pitches"][parts[1]]["physics"]["rho"]
        for k in key_pitches(d):
            ph = d["pitches"][k]["physics"]
            f = ref / ph["rho"]
            ph["rho"] = ref; ph["tension"] *= f; ph["jung"] *= f
    elif kind == "hammer_off":
        for k in parts[1].split(","):
            d["pitches"][k]["hammer_offset"] = 10.0
    else:
        f = float(parts[1])
        for k in parts[2].split(","):
            ph = d["pitches"][k]["physics"]
            if kind == "curve_time_x":
                lm = decode(d["pitches"][k]["excitation"])      # (128, 4, 5): [level][mu,sigma,vol,shift][gauss]
                lm[:, 0, :] *= f
                lm[:, 1, :] *= f
                d["pitches"][k]["excitation"] = encode(lm)
            elif kind == "rhoT_x":
                ph["rho"] *= f; ph["tension"] *= f; ph["jung"] *= f
            elif kind == "main_x":
                g = d["pitches"][k]["geometry"]
                g["main"] = max(4, int(round(g["main"] * f)))
            elif kind == "width_x":
                ph["hammer"]["hammer_width"] *= f
            elif kind == "tension_x":
                ph["tension"] *= f
            else:
                raise SystemExit("unknown variant " + kind)
    d["model_parameters"]["output_scale_calibrated"] = True   # never trigger a load-time render
    json.dump(d, open(dst, "w"))
    print("wrote", dst, variant)


if __name__ == "__main__":
    main()
