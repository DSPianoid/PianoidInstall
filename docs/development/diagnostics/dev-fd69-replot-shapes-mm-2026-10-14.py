"""dev-fd69 2026-10-14: re-plot the consensus mode shapes of a fixed-layout 7x7 run on the board in mm
(layout-20261014/board_layout.json *_mm fields; x 0-1200 left->right, y 0-1000 bottom->top) from the
saved modes.npz - no re-identification.
Usage: python <this> <run_dir> [fmax]
"""
import json
import os
import sys

import numpy as np

LAYOUT = r"D:\modal_measurements\rig_checks\layout-20261014\board_layout.json"


def main(run, fmax=400.0):
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    z = np.load(os.path.join(run, "modes.npz")); fm, zm, psi, M = z["f"], z["zeta"], z["psi"], z["pair_mac"]
    L = json.load(open(LAYOUT))
    P = np.array([L["piezos_green_mm"][str(k)] for k in range(1, 8)], float)
    Ex = np.array([L["exciters_red_mm"][str(k)] for k in range(1, 8)], float)
    idx = list(np.flatnonzero(fm < fmax))[:20]
    fig, axs = plt.subplots(4, 5, figsize=(20, 14), squeeze=False)
    for a_, r in zip(axs.ravel(), idx):
        v = psi[r] * np.exp(-1j * 0.5 * np.angle(np.sum(psi[r] ** 2))); re = v.real / max(np.abs(v).max(), 1e-300)
        a_.scatter(P[:, 0], P[:, 1], c=re, s=80 + 400 * np.abs(re), cmap="coolwarm", vmin=-1, vmax=1, edgecolors="k")
        a_.plot(Ex[:, 0], Ex[:, 1], "k^", ms=6)
        for k in range(7):
            a_.annotate(f"P{k + 1}", P[k], (P[k][0] + 25, P[k][1] + 25), fontsize=6)
            a_.annotate(f"E{k + 1}", Ex[k], (Ex[k][0] + 25, Ex[k][1] - 45), fontsize=6, color="0.3")
        a_.set_xlim(0, L["board_mm"]["width"]); a_.set_ylim(0, L["board_mm"]["height"]); a_.set_aspect("equal"); a_.tick_params(labelsize=6)
        a_.set_title(f"{fm[r]:.1f} Hz  z {100 * zm[r]:.1f}%  MAC {np.median(M[r]):.2f}", fontsize=8)
    for a_ in axs.ravel()[len(idx):]:
        a_.axis("off")
    fig.suptitle(f"Consensus mode shapes (real part) on the board, mm (origin bottom-left, front side; exciters on the reverse; position uncertainty {L['uncertainty_mm']})", fontsize=9)
    plt.tight_layout(); out = os.path.join(run, "shapes_board_mm.png"); plt.savefig(out, dpi=75); print(out)


if __name__ == "__main__":
    main(sys.argv[1], *(float(x) for x in sys.argv[2:3]))
