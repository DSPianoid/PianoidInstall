"""dev-a709 2026-10-15: per-mode residue scale of the 45 board modes of 10-15 (weights on the exciters), for the
measured-modes preset (docs/development/measured-plywood-preset-2026-10-15.md).

Reuses dev-fd69's appropriation prep (dev-fd69-appropriation-live-2026-10-15.py): the same three 7x7 runs, the same
45 poles (prep.json, no re-fit), the same LSFD residues per band, the same coil admittance -> residues per AMPERE
R_I = R_V diag(1/Y). prep.json stores only the unit vectors u, v; this script adds what the modal-mass derivation
needs:
  sigma1      top singular value of R_I (8 piezos x 7 exciters, unwhitened)   ~ |phi_P| |phi_E| / m
  dp          |R_I[P8, E7]| (P8 is glued at E7: the driving point)             ~ phi(E7)^2 / m
  u8_rel      |u_P8| / max |u| of the unwhitened top left vector (E7's share of the sampled shape)
  u_max, v_max  max |.| of the unwhitened unit singular vectors (1/u_max = |phi_P| of the shape scaled to max 1)
  repeat_sigma_db  spread of sigma1 over the three runs (dB, max - min)
the coil admittance |Y_e(f_m)| (current per volt, for the per-channel voltage trim note) and the real-normal drive
vector v_real (v_current rotated by its dominant phase, real part, max |.| = 1).
No rig access: reads the recorded sessions only.

Usage: python <this> <prep.json> <out.json>   (run with PYTHONPATH = the dev-fd69 Core worktree, D:/repos/wt-fd69-core)
"""
import importlib.util
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BANDS = [(25.0, 200.0), (200.0, 600.0), (600.0, 1100.0)]
HUM = (50.0, 100.0, 150.0)


def _mod(name, fn):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, fn))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def residues(f, Hx, Vx, modes, lam, lsfd):
    """dev-fd69 prep: LSFD per band (same bands, weights and band ownership)."""
    hum = np.all([np.abs(f - h) > 1.0 for h in HUM], axis=0)
    R = np.zeros((len(modes), 8, 7), complex)
    for lo, hi in BANDS:
        ss = (f >= lo) & (f <= hi) & hum
        use = np.array([lo * 0.98 <= m["f"] <= hi * 1.02 for m in modes])
        if not use.any():
            continue
        ft = lsfd(f[ss], Hx[ss], lam[use], 1 / np.sqrt(Vx[ss].mean(axis=2)))
        for k, i in enumerate(np.flatnonzero(use)):
            if lo <= modes[i]["f"] < hi or (hi == 1100.0 and modes[i]["f"] <= hi):
                R[i] = ft.residues[k]
    return R


def real_normal(v):
    """Complex drive vector -> real signed coefficients: rotate by the phase of the largest entry (real-normal-mode
    projection), take the real part, scale to max |.| = 1."""
    v = np.asarray(v, complex)
    r = (v * np.exp(-1j * np.angle(v[np.argmax(np.abs(v))]))).real
    return r / np.abs(r).max()


def main(prep_path, out_path):
    from pianoid_middleware.modal_adapter.polymax.lsfd import lsfd
    ap = _mod("ap", "dev-fd69-appropriation-live-2026-10-15.py")
    cr = _mod("cr", "dev-fd69-coils-as-sensors-2026-10-14.py")
    prep = json.load(open(prep_path))
    modes = [{"f": m["f"], "zeta": m["zeta_pct"] / 100} for m in prep["modes"]]
    lam = np.array([ap.lam_of(m["f"], m["zeta"]) for m in modes])
    F, M, V = None, [], []
    for r in prep["runs"]:
        f, Hs, _ = ap.frfs8(r)
        F = f
        M.append(Hs.mean(0))
        V.append(np.maximum(Hs.var(0) / 3, 1e-30))
    f = F
    Hm, Vm = np.mean(M, axis=0), np.mean(V, axis=0) / 3
    R = residues(f, Hm, Vm, modes, lam, lsfd)
    Rr = [residues(f, M[k], V[k], modes, lam, lsfd) for k in range(3)]
    fc, Hc = cr.frfs(prep["coil_run"])
    Hc = Hc.mean(0)
    Y = np.stack([np.interp(f, fc, Hc[:, k, k].real) + 1j * np.interp(f, fc, Hc[:, k, k].imag) for k in range(7)], axis=1)
    rows = []
    for i, (m, pm) in enumerate(zip(modes, prep["modes"])):
        Yk = Y[int(np.argmin(np.abs(f - m["f"])))]
        RI = R[i] / Yk[None, :]
        U, S, Vh = np.linalg.svd(RI)
        s_runs = [np.linalg.svd(Rr[q][i] / Yk[None, :], compute_uv=False)[0] for q in range(3)]
        v_cur = np.array([a * np.exp(1j * np.radians(p)) for a, p in pm["v_current"]])
        rows.append({"f": pm["f"], "zeta_pct": pm["zeta_pct"], "sigma1": float(S[0]),
                     "rank1_unwhitened": float(S[0] ** 2 / np.sum(S ** 2)),
                     "repeat_sigma_db": float(20 * np.log10(max(s_runs) / min(s_runs))),
                     "dp": float(abs(RI[7, 6])), "u8_rel": float(abs(U[7, 0]) / np.abs(U[:, 0]).max()),
                     "u_max": float(np.abs(U[:, 0]).max()), "v_max": float(np.abs(Vh[0]).max()),
                     "coil_admittance_abs": [float(abs(y)) for y in Yk],
                     "v_real": [round(float(x), 4) for x in real_normal(v_cur)],
                     "v_real_energy": float(np.sum(real_normal(v_cur) ** 2) / np.sum(np.abs(v_cur / np.abs(v_cur).max()) ** 2))})
        print(f"{pm['f']:8.2f}  sigma1 {S[0]:.3e}  dp {abs(RI[7, 6]):.3e}  u8 {rows[-1]['u8_rel']:.2f}  rep {rows[-1]['repeat_sigma_db']:.1f} dB")
    json.dump({"prep": prep_path, "coil_run": prep["coil_run"], "runs": prep["runs"], "modes": rows}, open(out_path, "w"), indent=1)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
