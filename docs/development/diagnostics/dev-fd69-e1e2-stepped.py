"""dev-fd69 rig experiments E1 / E2 (< 200 Hz): stepped-sine FRF + per-exciter resonance dwells.

E1: per exciter ALONE (Out 3 at -30 dBFS, others at -24): stepped sine over the union of
    +-3 bandwidth windows (15 pts) of every mode < 200 Hz (PolyMAX 60 s + swept-only modes;
    50 Hz mains-hum poles excluded), settle >= 10 tau, 50-cycle lock-in; local multi-mode fit
    (poles free, seeded by the mode list, + constant / j w residual terms) -> per-exciter
    resonance; then a long dwell at each per-exciter resonance (complex 7-sensor response).
E2: 6 modes, every exciter at -42 / -36 / -30 dBFS: stepped +-2 B (9 pts) -> same fit.
Output: D:/modal_measurements/rig_checks/<ts>-E1E2/ (npz + json), sessions persisted.

    python <this> e1 | e2
"""
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, r"D:\repos\wt-fd69-core")
from pianoid_middleware.modal_adapter.swept_discovery.audio_io import SessionAudioIO  # noqa: E402
from pianoid_middleware.modal_adapter.swept_discovery.fit import _fit_poles, pole_f_zeta  # noqa: E402
from pianoid_middleware.modal_adapter.swept_discovery.stepped import (  # noqa: E402
    SteppedConfig, mode_grid, run_stepped)

EX = [f"Out {i}" for i in range(1, 5)]
RC = [f"In {i}" for i in range(1, 8)]
LEVEL = {"Out 1": -24.0, "Out 2": -24.0, "Out 3": -30.0, "Out 4": -24.0}
PM = r"D:\modal_measurements\rig_checks\20261012T161018-sweep_speed\polymax_T60\modes.npz"
SW = r"D:\modal_measurements\swept_discovery\20261012-rig4b\modes.npz"
E2_MODES = (59.1, 75.7, 94.3, 107.2, 141.2, 182.6)


def mode_list(fmax=200.0):
    p = np.load(PM)
    s = np.load(SW)
    ms = [{"f": float(f), "zeta": float(z), "src": "polymax"} for f, z in zip(p["e0_frequencies"], p["e0_damping_ratios"])
          if f < fmax and not (49.0 < f < 51.0)]                    # 50 Hz = mains hum, not a mode
    for f, z in zip(s["e0_frequencies"], s["e0_damping_ratios"]):
        if f < fmax and not (49.0 < f < 51.0) and min(abs(m["f"] - f) / f for m in ms) > 0.02:
            ms.append({"f": float(f), "zeta": float(min(z, 0.05)), "src": "swept"})
    return sorted(ms, key=lambda m: m["f"])


def local_fit(freqs, H, modes, target, span_bw=3.0):
    """Per-exciter multi-mode fit around ``target``: poles seeded by every listed mode in the
    window, free (f, zeta), shared by the 7 sensors, + constant / j w residual terms."""
    B = 2 * target["zeta"] * target["f"]
    lo, hi = target["f"] - span_bw * B, target["f"] + span_bw * B
    sel = (freqs >= lo) & (freqs <= hi)
    if sel.sum() < 6:
        return None
    seeds = [m for m in modes if lo - B <= m["f"] <= hi + B]
    f0 = np.array([m["f"] for m in seeds])
    z0 = np.array([m["zeta"] for m in seeds])
    if 2 * len(seeds) + 2 > sel.sum():
        keep = np.argsort(np.abs(f0 - target["f"]))[: max(1, (sel.sum() - 2) // 2)]
        f0, z0 = f0[keep], z0[keep]
    H3 = H[sel][:, :, None]
    w = np.ones((H.shape[1], 1))
    try:
        lam, res, extra, rel = _fit_poles(freqs[sel], H3, f0, z0, w, lo - 2 * B, hi + 2 * B)
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}
    fr, zr = pole_f_zeta(lam)
    i = int(np.argmin(np.abs(fr - target["f"])))
    return {"f": float(fr[i]), "zeta": float(zr[i]), "residue": res[i, :, 0], "rel_residual": rel,
            "n_poles": len(lam), "all_f": fr.tolist(), "all_zeta": zr.tolist()}


def cplx(v):
    return [[float(np.real(c)), float(np.imag(c))] for c in np.ravel(v)]


def main(which):
    out = os.path.join(r"D:\modal_measurements\rig_checks", time.strftime("%Y%m%dT%H%M%S") + f"-{which}")
    os.makedirs(out, exist_ok=True)
    io = SessionAudioIO(os.path.join(out, "sessions"))
    modes = mode_list()
    rep = {"modes": modes, "levels": LEVEL, "exciters": {}}
    print("modes < 200 Hz:", [(round(m["f"], 1), round(m["zeta"] * 100, 2), m["src"]) for m in modes], flush=True)
    if which == "e1":
        grid = mode_grid(modes)
        print("grid points:", len(grid), flush=True)
        for e, ex in enumerate(EX):
            t0 = time.time()
            cfg = SteppedConfig(level_dbfs=LEVEL[ex])
            st = run_stepped(io, [ex], grid, RC, cfg, f"e1_step_{ex.replace(' ', '')}")
            fits = [local_fit(st["freqs"], st["H"], modes, m) for m in modes]
            fr = [f["f"] if f and "f" in f and abs(f["f"] / m["f"] - 1) < 0.05 else m["f"]
                  for f, m in zip(fits, modes)]
            dw = run_stepped(io, [ex], fr, RC, cfg, f"e1_dwell_{ex.replace(' ', '')}")
            np.savez(os.path.join(out, f"e1_{ex.replace(' ', '')}.npz"), step_f=st["freqs"], step_H=st["H"],
                     step_Y=st["Y"], dwell_f=dw["freqs"], dwell_H=dw["H"], dwell_Y=dw["Y"])
            rep["exciters"][ex] = {"stepped_sessions": st["sessions"], "dwell_sessions": dw["sessions"],
                                   "fits": [None if not f or "f" not in f else
                                            {k: (cplx(v) if k == "residue" else v) for k, v in f.items()}
                                            for f in fits], "dwell_f": fr, "elapsed_s": time.time() - t0}
            print(f"{ex}: {len(grid)} steps + {len(fr)} dwells in {time.time() - t0:.0f} s", flush=True)
            json.dump(rep, open(os.path.join(out, "report.json"), "w"), indent=1, default=float)
    else:
        sub = [min(modes, key=lambda m: abs(m["f"] - f)) for f in E2_MODES]
        grid = mode_grid(sub, n_points=9, span_bw=2.0)
        for lvl in (-42.0, -36.0, -30.0):
            for ex in EX:
                t0 = time.time()
                st = run_stepped(io, [ex], grid, RC, SteppedConfig(level_dbfs=lvl),
                                 f"e2_{int(-lvl)}_{ex.replace(' ', '')}")
                fits = [local_fit(st["freqs"], st["H"], modes, m, span_bw=2.0) for m in sub]
                np.savez(os.path.join(out, f"e2_{int(-lvl)}_{ex.replace(' ', '')}.npz"),
                         step_f=st["freqs"], step_H=st["H"], step_Y=st["Y"])
                rep["exciters"].setdefault(ex, {})[f"{lvl:+.0f}"] = {
                    "sessions": st["sessions"],
                    "fits": [None if not f or "f" not in f else
                             {k: (cplx(v) if k == "residue" else v) for k, v in f.items()} for f in fits]}
                print(f"E2 {lvl:+.0f} dBFS {ex}: {len(grid)} steps in {time.time() - t0:.0f} s", flush=True)
                json.dump(rep, open(os.path.join(out, "report.json"), "w"), indent=1, default=float)
        rep["e2_modes"] = sub
    rep["io_sessions"] = io.sessions
    json.dump(rep, open(os.path.join(out, "report.json"), "w"), indent=1, default=float)
    print(out)


if __name__ == "__main__":
    main(sys.argv[1])
