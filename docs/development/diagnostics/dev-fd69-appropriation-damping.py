"""dev-fd69 rig test 6 evaluation: appropriated free-decay damping vs swept / PolyMAX / ESPRIT.

Usage: python <this> <complex run dir> <real run dir> [out dir]
(runs = D:/modal_measurements/appropriation/<ts>/report.json written by the appropriation CLI).
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, r"D:\repos\wt-fd69-core")
from pianoid_middleware.modal_adapter import mode_comparison as C  # noqa: E402

CPLX, REAL = sys.argv[1], sys.argv[2]
OUT = sys.argv[3] if len(sys.argv) > 3 else r"D:\modal_measurements\analysis\dev-fd69-2026-10-12"
os.makedirs(OUT, exist_ok=True)
SWEPT = r"D:\modal_measurements\swept_discovery\20261012-rig4b\modes.npz"
PM = r"D:\modal_measurements\rig_checks\20261012T161018-sweep_speed\polymax_T60\modes.npz"
CHIRP_ESP = r"D:\modal_measurements\analysis\dev-fd69-2026-10-11\chirp_esprit\20261011-rig3"
IMP_ESP = r"D:\modal_projects\ASIO-rig-2026-10-11b_p1\modal_adapter\esprit"
cx = json.load(open(os.path.join(CPLX, "report.json")))["results"]
rl = json.load(open(os.path.join(REAL, "report.json")))["results"]
ref = {"swept": C.collapse(C.from_modes_npz(SWEPT, snr_min=10)),
       "polymax": C.collapse(C.from_modes_npz(PM, snr_min=10)),
       "chirp_esprit": C.collapse(C.from_esprit_dir(CHIRP_ESP), prefer_snr=False),
       "impulse_esprit": C.collapse(C.from_esprit_dir(IMP_ESP), prefer_snr=False)}


def near(lst, f, z):
    m = min(lst, key=lambda d: abs(d["f"] - f))
    return m if abs(m["f"] - f) <= C.tol(f, z, m["z"]) else None


rows = []
for a, b in zip(cx, rl):
    d, dr, s = a["decay_modal_filter"], b["decay_modal_filter"], a["single"]["decay_projection"]
    row = {"f_model": a["f_model_hz"], "zeta_model": a["zeta_model"],
           "f_decay": d["f_hz"], "zeta_cplx": d["zeta"], "env_cplx_db": d["envelope_rms_db"],
           "drop_db": d["fit_drop_db"], "zeta_real": dr["zeta"], "env_real_db": dr["envelope_rms_db"],
           "zeta_single": s["zeta"], "env_single_db": s["envelope_rms_db"],
           "mac_cplx": a["steady"]["mac_psi"], "mac_single": a["single"]["steady"]["mac_psi"],
           "purity_model": a["purity_model"]}
    for k, lst in ref.items():
        m = near(lst, d["f_hz"], d["zeta"])
        row[f"zeta_{k}"] = m["z"] if m else None
    rows.append(row)
json.dump(rows, open(os.path.join(OUT, "appropriation_damping.json"), "w"), indent=1, default=float)
hdr = ("f_decay  zeta: cplx(env)  real  single(env) | PolyMAX swept chirpESP impESP | MAC cplx/single")
print(hdr)
fmt = lambda v: "  -  " if v is None else f"{v * 100:5.2f}"  # noqa: E731
for r in rows:
    print(f"{r['f_decay']:7.1f}  {r['zeta_cplx']*100:5.2f}({r['env_cplx_db']:.1f})  {r['zeta_real']*100:5.2f}  "
          f"{r['zeta_single']*100:5.2f}({r['env_single_db']:.1f}) | {fmt(r['zeta_polymax'])} {fmt(r['zeta_swept'])} "
          f"{fmt(r['zeta_chirp_esprit'])} {fmt(r['zeta_impulse_esprit'])} | {r['mac_cplx']:.2f}/{r['mac_single']:.2f}")
good = [r for r in rows if r["env_cplx_db"] < 2.0]
print(f"\nclean decays (envelope residual < 2 dB): {len(good)}/{len(rows)}")
for k in ("zeta_real", "zeta_single", "zeta_polymax", "zeta_swept", "zeta_chirp_esprit", "zeta_impulse_esprit"):
    v = [r[k] / r["zeta_cplx"] for r in good if r[k] is not None]
    if v:
        print(f"  {k:22s} / appropriated: median {np.median(v):.2f}  (n {len(v)}, range {min(v):.2f}-{max(v):.2f})")
print("  appropriated zeta median %.2f %%" % (100 * np.median([r["zeta_cplx"] for r in good])))

import matplotlib  # noqa: E402
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
fig, ax = plt.subplots(figsize=(11, 5))
f = [r["f_decay"] for r in rows]
ax.plot(f, [r["zeta_cplx"] * 100 for r in rows], "o", color="#0b0b0b", ms=7, label="appropriated free decay (complex)")
ax.plot(f, [r["zeta_real"] * 100 for r in rows], "x", color="#52514e", ms=7, label="appropriated (real weights)")
for k, c, mk in (("zeta_polymax", "#1baf7a", "s"), ("zeta_swept", "#2a78d6", "^"),
                 ("zeta_chirp_esprit", "#eb6834", "v"), ("zeta_impulse_esprit", "#eda100", "D"),
                 ("zeta_single", "#e87ba4", ".")):
    pts = [(r["f_decay"], r[k] * 100) for r in rows if r[k] is not None]
    if pts:
        ax.plot(*zip(*pts), mk, color=c, ms=6, label=k.replace("zeta_", ""))
ax.set_xscale("log")
ax.set_xlabel("Frequency (Hz)")
ax.set_ylabel("damping ratio (%)")
ax.grid(True, color="#e4e3df")
ax.legend(fontsize=8, frameon=False, ncol=2)
ax.set_title("Damping: model-free appropriated decay vs identification methods", loc="left", fontsize=10)
fig.tight_layout()
fig.savefig(os.path.join(OUT, "damping_appropriation_vs_methods.png"), dpi=110)
print(os.path.join(OUT, "damping_appropriation_vs_methods.png"))
