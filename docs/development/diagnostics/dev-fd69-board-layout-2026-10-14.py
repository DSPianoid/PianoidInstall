"""dev-fd69 2026-10-14: board layout from the user's photo (piezos green 1-8 on the visible face,
exciters red 1-7 on the back, labels visible through/next to them) -> normalised coordinates,
overlay plot, and a distance-vs-level consistency check of the 7-exciter burst table
(which piezo could each live input In 5-8 be?).

Pixel positions are read by eye from the 1280x960 photo (piezo = disc centre, exciter = red label).
Normalised: x = 0 left .. 1 right, y = 0 top .. 1 bottom of the inner board outline (photo frame,
camera not square-on -> approximate, perspective not corrected).

Usage: python dev-fd69-board-layout-2026-10-14.py <layout_dir containing board_photo_20261014.jpg> <id_bursts.json>
"""
import json
import os
import sys

import numpy as np

D, BURSTS = sys.argv[1], sys.argv[2]
X0, X1, Y0, Y1 = 30.0, 1170.0, 15.0, 890.0          # inner board outline bbox (px)
PIEZO_PX = {1: (345, 270), 2: (665, 218), 3: (830, 305), 4: (983, 472),
            5: (240, 413), 6: (743, 528), 7: (247, 686), 8: (535, 635)}
EXC_PX = {1: (983, 712), 2: (866, 558), 3: (893, 310), 4: (352, 535),
          5: (215, 330), 6: (350, 185), 7: (517, 647)}


def norm(p):
    return [round((p[0] - X0) / (X1 - X0), 3), round((p[1] - Y0) / (Y1 - Y0), 3)]


layout = {"source": "user photo 2026-10-14 (Telegram), 1280x960; approximate, no perspective correction",
          "frame": "x 0=left..1=right, y 0=top..1=bottom of the inner board outline as photographed (piezo face)",
          "aspect_w_over_h": round((X1 - X0) / (Y1 - Y0), 3),
          "piezos_green": {str(k): norm(v) for k, v in PIEZO_PX.items()},
          "exciters_red": {str(k): norm(v) for k, v in EXC_PX.items()},
          "pixels": {"piezos": PIEZO_PX, "exciters": EXC_PX, "bbox": [X0, X1, Y0, Y1]},
          "open": ["green piezo number -> input (In 5-8)", "red number == Out number?"]}
json.dump(layout, open(os.path.join(D, "board_layout.json"), "w"), indent=1)

# distance (board units, aspect kept) vs burst level per input and candidate piezo
asp = layout["aspect_w_over_h"]
P = {k: np.array([v[0] * asp, v[1]]) for k, v in ((int(k), v) for k, v in layout["piezos_green"].items())}
E = {k: np.array([v[0] * asp, v[1]]) for k, v in ((int(k), v) for k, v in layout["exciters_red"].items())}
b = json.load(open(BURSTS))["per_output"]
res = {}
for inp in ("In 5", "In 6", "In 7", "In 8"):
    lv = np.array([b[f"Out {e}"][inp]["rms_dbfs"] for e in range(1, 8)])
    row = {}
    for p, xy in P.items():
        d = np.array([np.linalg.norm(xy - E[e]) for e in range(1, 8)])
        row[p] = round(float(np.corrcoef(-np.log(d), lv)[0, 1]), 2)     # +1: louder when closer
    res[inp] = dict(sorted(row.items(), key=lambda kv: -kv[1]))
json.dump(res, open(os.path.join(D, "burst_distance_consistency.json"), "w"), indent=1)
for inp, row in res.items():
    print(inp, " ".join(f"P{p}:{c:+.2f}" for p, c in row.items()))

import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
img = plt.imread(os.path.join(D, "board_photo_20261014.jpg"))
fig, ax = plt.subplots(1, 2, figsize=(17, 6.5), gridspec_kw={"width_ratios": [1.33, 1]})
ax[0].imshow(img)
for k, (x, y) in PIEZO_PX.items():
    ax[0].plot(x, y, "o", ms=16, mfc="none", mec="#0c8", mew=2.5)
    ax[0].annotate(f"P{k}", (x, y), (x + 14, y - 14), color="#0c8", fontsize=12, weight="bold")
for k, (x, y) in EXC_PX.items():
    ax[0].plot(x, y, "^", ms=13, mfc="none", mec="#e22", mew=2.5)
    ax[0].annotate(f"E{k}", (x, y), (x + 12, y + 26), color="#e22", fontsize=12, weight="bold")
ax[0].set_title("Photo + digitised markers (P = piezo green, E = exciter red, back side)"); ax[0].axis("off")
for k, xy in P.items():
    ax[1].plot(*xy, "o", color="#0a7", ms=11); ax[1].annotate(f"P{k}", xy, (xy[0] + .02, xy[1] - .02), color="#0a7")
for k, xy in E.items():
    ax[1].plot(*xy, "^", color="#d22", ms=11); ax[1].annotate(f"E{k}", xy, (xy[0] + .02, xy[1] + .05), color="#d22")
ax[1].set_xlim(0, asp); ax[1].set_ylim(1, 0); ax[1].set_aspect("equal")
ax[1].set_title("Normalised board coordinates (y down, x scaled by aspect)")
plt.tight_layout(); plt.savefig(os.path.join(D, "board_layout_overlay.png"), dpi=80)
