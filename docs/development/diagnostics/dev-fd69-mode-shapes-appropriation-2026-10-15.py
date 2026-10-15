"""dev-fd69 2026-10-15: mode shapes for all measured modes + predicted appropriation gains (analysis only).

Data: the four 10-14 full 7x7 runs with P1-P7 on In 1-7 (same positions, same exciters, no weights yet):
morning `20261014T144226-fixed-layout-7x7` (reference) and ladder `20261014T161215-ladder-7x7-m0/-m6/-m12`.
Poles: consensus set < 200 Hz (consensus-lt200-20261014) + the morning 200 Hz-1.1 kHz PolyMAX list.
Per mode m (LSFD residues R_m, 7 sensors x 7 exciters, per volt, noise-whitened rows):
  rank-1 split R_m ~ s u v^H: u = response shape over P1-P7 (mm positions), v = drive-side participation
  over E1-E7 (|v|, phase); rank-1 share s1^2 / sum s^2; cross-exciter MAC (median over 21 exciter pairs of
  MAC of the columns); repeat MAC (median MAC of u between the 4 runs).
Appropriation prediction at f_m from the measured FRF matrix H(f_m) (7 x 7, per volt), unit-norm drive
vectors (equal drive RMS): gain ||H F|| for (a) F = v_m (mode-derived), (b) top right singular vector of
H(f_m) (optimum), (c) best single exciter, (d) uniform in-phase, (e) random (median of 2000); dB re (b);
MAC(a, b). Also the modal-energy view: response projected on u_m.
Usage: python <this> <out_dir>
"""
import itertools
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RC = r"D:\modal_measurements\rig_checks"
RUNS = {"morning": os.path.join(RC, "20261014T144226-fixed-layout-7x7"),
        "ladder_0": os.path.join(RC, "20261014T161215-ladder-7x7-m0"),
        "ladder_m6": os.path.join(RC, "20261014T161215-ladder-7x7-m6"),
        "ladder_m12": os.path.join(RC, "20261014T161215-ladder-7x7-m12")}
CONS = os.path.join(RC, "consensus-lt200-20261014", "consensus_lt200.json")
LAYOUT = os.path.join(RC, "layout-20261014", "board_layout.json")
import importlib.util
spec = importlib.util.spec_from_file_location("cs", os.path.join(HERE, "dev-fd69-consensus-lt200-2026-10-14.py"))
cs = importlib.util.module_from_spec(spec); spec.loader.exec_module(cs)


def mac(a, b):
    return float(np.abs(np.vdot(a, b)) ** 2 / (np.vdot(a, a).real * np.vdot(b, b).real + 1e-300))


def lam_of(fz, z):
    w = 2 * np.pi * fz
    return -z * w + 1j * w * np.sqrt(1 - z * z)


def main(out):
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    from pianoid_middleware.modal_adapter.polymax.lsfd import lsfd
    os.makedirs(out, exist_ok=True)
    cons = json.load(open(CONS))["consensus"]
    hi = [m for m in json.load(open(os.path.join(RUNS["morning"], "report.json")))["modes"] if 200 <= m["f"] <= 1100]
    modes = [{"f": x["f"], "zeta_pct": x["zeta_pct"], "src": "consensus <200"} for x in cons] + \
            [{"f": x["f"], "zeta_pct": x["zeta_pct"], "src": "7x7 single fit"} for x in hi]
    lam = np.array([lam_of(m["f"], m["zeta_pct"] / 100) for m in modes])
    bands = [(25.0, 200.0), (200.0, 600.0), (600.0, 1100.0)]
    U, V, S1, XM = {}, {}, {}, {}
    # full-band loader
    from pianoid_middleware.modal_adapter.measurement.ess import deconvolve, exp_sweep
    FS = 48000; NIR = 4 * FS
    win = np.ones(NIR); nf = int(0.1 * NIR); win[-nf:] = 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, nf))
    allH = {}
    for rn, run in RUNS.items():
        cfg = json.load(open(os.path.join(run, "config.json")))
        fr = np.fft.rfftfreq(NIR, 1 / FS); keep = fr <= 1150
        Hs = np.zeros((3, int(keep.sum()), 7, 7), complex)
        for j, e in enumerate([f"E{k}" for k in range(1, 8)]):
            lv = cfg["levels"][e]; x = exp_sweep(20.0, 2000.0, 20.0, FS, lv)
            for r in range(3):
                y = np.load(os.path.join(run, "sessions", f"{e}_m{-lv}_r{r + 1}", "data.npy")).astype(float)
                h = np.roll(deconvolve(y, x, FS, (20.0, 2000.0)), 30, axis=0)[:NIR] * win[:, None]
                Hs[r, :, :, j] = np.fft.rfft(h, axis=0)[keep][:, :7]
        allH[rn] = (fr[keep], Hs.mean(0), np.maximum(Hs.var(0) / 3, 1e-30))
    f = allH["morning"][0]
    hum = np.all([np.abs(f - h) > 1.0 for h in (50.0, 100.0, 150.0)], axis=0)
    for rn, (f_, Hm, Vm) in allH.items():
        R = np.zeros((len(modes), 7, 7), complex)
        for lo, hi_ in bands:
            s = (f_ >= lo) & (f_ <= hi_) & hum
            u = np.array([(lo * 0.98 <= m["f"] <= hi_ * 1.02) for m in modes])
            W = 1 / np.sqrt(Vm[s].mean(axis=2))
            ft = lsfd(f_[s], Hm[s], lam[u], W)
            for k, i in enumerate(np.flatnonzero(u)):
                if lo <= modes[i]["f"] < hi_ or (hi_ == 1100.0 and modes[i]["f"] <= hi_):
                    R[i] = ft.residues[k]
        rs = np.sqrt(np.median(Vm[(f_ >= 25) & hum].mean(axis=2), axis=0))
        Rw = R / rs[None, :, None]
        U[rn], V[rn], S1[rn], XM[rn] = [], [], [], []
        for i in range(len(modes)):
            Uu, Ss, Vh = np.linalg.svd(Rw[i])
            uu = Uu[:, 0]; vv = Vh[0].conj()
            ph = np.exp(-1j * np.angle(uu[np.argmax(np.abs(uu))]))
            U[rn].append(uu * ph); V[rn].append(vv / ph)
            S1[rn].append(float(Ss[0] ** 2 / np.sum(Ss ** 2)))
            XM[rn].append(float(np.median([mac(Rw[i][:, a], Rw[i][:, b]) for a, b in itertools.combinations(range(7), 2)])))
    L = json.load(open(LAYOUT))
    P = np.array([L["piezos_green_mm"][str(k)] for k in range(1, 8)], float)
    Ex = np.array([L["exciters_red_mm"][str(k)] for k in range(1, 8)], float)
    # appropriation prediction from the morning FRF matrix (per volt)
    fm_, Hm_, _ = allH["morning"]
    rng = np.random.default_rng(0)
    rows = []
    for i, m in enumerate(modes):
        k = int(np.argmin(np.abs(fm_ - m["f"]))); Hk = Hm_[k]                       # 7 sensors x 7 exciters
        g = lambda F: float(np.linalg.norm(Hk @ (F / np.linalg.norm(F))))
        _, sv, Vh = np.linalg.svd(Hk); vopt = Vh[0].conj()
        va = V["morning"][i]
        single = max(g(np.eye(7)[j]) for j in range(7)); best_j = int(np.argmax([g(np.eye(7)[j]) for j in range(7)]))
        rnd = np.median([g(rng.normal(size=7) + 1j * rng.normal(size=7)) for _ in range(2000)])
        # modal response: projection of the response on u_m (how much of THIS mode is excited)
        um = U["morning"][i]
        proj = lambda F: float(np.abs(np.vdot(um, Hk @ (F / np.linalg.norm(F)))))
        topt = sv[0]
        rep_mac = [mac(U[a][i], U[b][i]) for a, b in itertools.combinations(RUNS, 2)]
        rows.append({"f": round(m["f"], 2), "zeta_pct": m["zeta_pct"], "src": m["src"],
                     "rank1_share": round(S1["morning"][i], 2), "cross_exciter_mac": round(XM["morning"][i], 2),
                     "repeat_mac": round(float(np.median(rep_mac)), 2),
                     "shape_u_P1_P7": [[round(float(abs(x)), 3), round(float(np.degrees(np.angle(x))), 1)] for x in um],
                     "drive_v_E1_E7": [[round(float(abs(x)), 3), round(float(np.degrees(np.angle(x))), 1)] for x in va],
                     "gain_db_re_optimum": {"mode_vector": round(20 * np.log10(g(va) / topt), 2), "optimum": 0.0,
                                            "best_single": round(20 * np.log10(single / topt), 2), "best_single_exciter": f"E{best_j + 1}",
                                            "uniform": round(20 * np.log10(g(np.ones(7)) / topt), 2), "random_median": round(20 * np.log10(rnd / topt), 2)},
                     "modal_projection_db_re_optimum_vector": {"mode_vector": round(20 * np.log10(proj(va) / max(proj(vopt), 1e-300)), 2),
                                                                "uniform": round(20 * np.log10(proj(np.ones(7)) / max(proj(vopt), 1e-300)), 2)},
                     "mac_mode_vector_vs_optimum": round(mac(va, vopt), 2),
                     "svd_sigma2_over_sigma1_db": round(float(20 * np.log10(sv[1] / sv[0])), 1)})
    for r in rows:
        q = r["cross_exciter_mac"] >= 0.5 and r["repeat_mac"] >= 0.9 and r["rank1_share"] >= 0.6
        r["reliability"] = "good" if q else ("fair" if r["repeat_mac"] >= 0.8 and r["rank1_share"] >= 0.45 else "unreliable")
    json.dump({"note": "per volt, 10-14 (before weights); u = response shape at P1-P7, v = exciter participation E1-E7; positions in mm (layout-20261014)",
               "piezo_mm": P.tolist(), "exciter_mm": Ex.tolist(), "modes": rows}, open(os.path.join(out, "mode_shapes.json"), "w"), indent=1)
    # figures: 16 modes per page
    for page in range(0, len(rows), 16):
        sub = rows[page:page + 16]
        fig, axs = plt.subplots(4, 4, figsize=(20, 17), squeeze=False)
        for a_, (i, r) in zip(axs.ravel(), [(page + j, x) for j, x in enumerate(sub)]):
            u = U["morning"][i]; v = V["morning"][i]
            ure = (u * np.exp(-1j * 0.5 * np.angle(np.sum(u ** 2)))).real; ure /= max(np.abs(ure).max(), 1e-300)
            a_.scatter(P[:, 0], P[:, 1], c=ure, s=60 + 500 * np.abs(ure), cmap="coolwarm", vmin=-1, vmax=1, edgecolors="k", zorder=3)
            vv = v / max(np.abs(v).max(), 1e-300)
            for k in range(7):
                ang = np.angle(vv[k]); rad = 140 * np.abs(vv[k])
                a_.annotate("", xy=(Ex[k, 0] + rad * np.cos(ang), Ex[k, 1] + rad * np.sin(ang)), xytext=Ex[k], arrowprops=dict(arrowstyle="->", color="k", lw=1.2))
                a_.plot(*Ex[k], "k^", ms=5)
                a_.annotate(f"E{k + 1}", Ex[k] + [10, -45], fontsize=6, color="0.35")
            for k in range(7):
                a_.annotate(f"P{k + 1}", P[k] + [15, 15], fontsize=6)
            a_.set_xlim(0, 1200); a_.set_ylim(0, 1000); a_.set_aspect("equal"); a_.tick_params(labelsize=5)
            a_.set_title(f"{r['f']:.1f} Hz z{r['zeta_pct']:.1f}% | xMAC {r['cross_exciter_mac']:.2f} rep {r['repeat_mac']:.2f} | {r['reliability']}", fontsize=8,
                         color="k" if r["reliability"] == "good" else ("0.3" if r["reliability"] == "fair" else "r"))
        for a_ in axs.ravel()[len(sub):]:
            a_.axis("off")
        fig.suptitle("Mode shapes (10-14, per volt): colour/size = response at piezos P1-P7 (real part, phase-aligned); arrows at exciters = drive participation (length = |v|, angle = phase). mm, origin bottom-left, front side", fontsize=10)
        plt.tight_layout(); plt.savefig(os.path.join(out, f"mode_shapes_p{page // 16 + 1}.png"), dpi=70); plt.close()
    for r in rows:
        print(f"{r['f']:7.1f} z{r['zeta_pct']:4.1f} {r['reliability']:10s} r1 {r['rank1_share']:.2f} xMAC {r['cross_exciter_mac']:.2f} rep {r['repeat_mac']:.2f} | "
              f"mode-vec {r['gain_db_re_optimum']['mode_vector']:+.2f} single {r['gain_db_re_optimum']['best_single']:+.2f}({r['gain_db_re_optimum']['best_single_exciter']}) "
              f"unif {r['gain_db_re_optimum']['uniform']:+.2f} rnd {r['gain_db_re_optimum']['random_median']:+.2f} MAC(a,b) {r['mac_mode_vector_vs_optimum']:.2f} s2/s1 {r['svd_sigma2_over_sigma1_db']}")


if __name__ == "__main__":
    main(sys.argv[1])
