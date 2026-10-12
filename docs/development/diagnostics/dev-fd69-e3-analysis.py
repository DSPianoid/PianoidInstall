"""dev-fd69 E3 analysis of the E1 / E2 stepped-sine data (< 200 Hz).

    python <this> <E1 dir> [<E2 dir>]

Per mode and exciter: (i) RAW dwell shape = complex 7-sensor response at that exciter's own
resonance; (ii) RESIDUAL-CORRECTED shape = residue of the target pole in the per-exciter local
multi-mode fit (free poles + constant / j w background terms). Cross-exciter agreement = pairwise
MAC; a mode AGREES if the min over the 6 exciter pairs >= 0.9. Near-field test: MAC recomputed
without the sensor(s) nearest each exciter of the pair (nearest = earliest acoustic arrival in
the 2026-10-11 deconvolved IRs, confirmed by the largest transfer magnitude below 200 Hz).
E2: frequency + MAC agreement vs drive level. Overlap: modal overlap factor per mode and the
per-exciter PolyMAX mode count < 200 Hz.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, r"D:\repos\wt-fd69-core")
from pianoid_middleware.modal_adapter.polymax.identify import PolymaxConfig, identify  # noqa: E402

E1 = sys.argv[1]
E2 = sys.argv[2] if len(sys.argv) > 2 else None
EX = [f"Out {i}" for i in range(1, 5)]
OUT = r"D:\modal_measurements\analysis\dev-fd69-2026-10-12"
os.makedirs(OUT, exist_ok=True)
LOG = []
# earliest acoustic arrival (samples) per exciter / sensor, 2026-10-11 rig3 deconvolved IRs
FIRST_ARRIVAL = {"Out 1": [7, 26, 52, 39, 23, 36, 46], "Out 2": [40, 57, 81, 55, 23, 23, 49],
                 "Out 3": [44, 47, 8, 22, 58, 50, 37], "Out 4": [17, 18, 34, 32, 36, 43, 46]}


def log(*a):
    s = " ".join(str(x) for x in a)
    print(s, flush=True)
    LOG.append(s)


def mac(a, b):
    a, b = np.ravel(a), np.ravel(b)
    return float(abs(np.vdot(a, b)) ** 2 / (np.vdot(a, a).real * np.vdot(b, b).real))


def pair_macs(vecs, drop=None):
    out = {}
    for i in range(4):
        for j in range(i + 1, 4):
            if vecs[i] is None or vecs[j] is None:
                continue
            keep = np.ones(7, bool)
            if drop:
                keep[list(drop[i]) + list(drop[j])] = False
            out[f"{i + 1}-{j + 1}"] = mac(vecs[i][keep], vecs[j][keep])
    return out


def cvec(v):
    return np.array([complex(*c) for c in v])


rep = json.load(open(os.path.join(E1, "report.json")))
modes = rep["modes"]
data = {ex: np.load(os.path.join(E1, f"e1_{ex.replace(' ', '')}.npz")) for ex in EX}
# nearest sensors: earliest arrival, + the largest |H| below 200 Hz from the E1 stepped FRFs
nearest = {}
for e, ex in enumerate(EX):
    fa = np.array(FIRST_ARRIVAL[ex])
    mag = np.median(np.abs(data[ex]["step_H"]), axis=0)
    nearest[e] = sorted(set([int(np.argmin(fa))] + list(np.flatnonzero(fa <= fa.min() + 2))))
    log(f"{ex}: nearest sensor(s) In {[k + 1 for k in nearest[e]]} (first arrival {fa.min()} samples); "
        f"largest median |H| < 200 Hz: In {int(np.argmax(mag)) + 1}")

scale = [float(np.median(np.abs(data[ex]["step_H"]))) for ex in EX]
rows = []
for i, m in enumerate(modes):
    fits = [rep["exciters"][ex]["fits"][i] for ex in EX]
    raw = [data[ex]["dwell_Y"][i] for ex in EX]
    corr = [cvec(f["residue"]) if f else None for f in fits]
    fr = [f["f"] if f else None for f in fits]
    zr = [f["zeta"] if f else None for f in fits]
    m_raw = pair_macs(raw)
    m_cor = pair_macs(corr)
    m_nf = pair_macs(corr, nearest)
    # participation gate: exciters whose residue norm (per unit drive, the FRF scale differs per
    # exciter so normalise by that exciter's median |H| < 200 Hz) is >= 30 % of the strongest
    part = np.array([np.linalg.norm(c) / scale[e] if c is not None else 0.0 for e, c in enumerate(corr)])
    part = part / max(part.max(), 1e-300)
    gated = [c if p >= 0.3 else None for c, p in zip(corr, part)]
    m_gate = pair_macs(gated)
    fv = np.array([x for x in fr if x is not None])
    row = {"f": m["f"], "zeta_model": m["zeta"], "src": m["src"], "f_per_exciter": fr, "zeta_per_exciter": zr,
           "f_spread_pct": float(np.ptp(fv) / np.median(fv) * 100) if len(fv) > 1 else None,
           "mac_raw": m_raw, "mac_corrected": m_cor, "mac_corrected_no_nearfield": m_nf,
           "min_raw": min(m_raw.values()), "min_corr": min(m_cor.values()) if m_cor else None,
           "min_nf": min(m_nf.values()) if m_nf else None,
           "participation": part.round(3).tolist(), "mac_gated": m_gate,
           "min_gated": min(m_gate.values()) if m_gate else None, "n_gated": int(np.sum(part >= 0.3)),
           "dwell_amp_norm": [list(np.round(np.abs(v) / np.max(np.abs(v)), 3)) for v in raw],
           "dwell_phase_deg": [list(np.round(np.degrees(np.angle(v * np.exp(-1j * np.angle(v[np.argmax(np.abs(v))])))), 0)) for v in raw]}
    rows.append(row)

log("\n## E1 cross-exciter shape agreement per mode (< 200 Hz) — min / median pairwise MAC")
log("   f (src)       f per exciter (fit)            spread  | raw dwell   | resid-corrected | corr w/o near-field")
for r in rows:
    fe = " ".join("  -   " if x is None else f"{x:6.1f}" for x in r["f_per_exciter"])
    md = lambda d: "  -  " if not d else f"{min(d.values()):.2f}/{np.median(list(d.values())):.2f}"  # noqa: E731
    log(f"  {r['f']:6.1f} ({r['src'][0]})  {fe}  {r['f_spread_pct'] or 0:5.2f}% | {md(r['mac_raw'])} | "
        f"{md(r['mac_corrected'])}     | {md(r['mac_corrected_no_nearfield'])}")
agree = [r for r in rows if r["min_corr"] is not None and r["min_corr"] >= 0.9]
agree_raw = [r for r in rows if r["min_raw"] >= 0.9]
agree_nf = [r for r in rows if r["min_nf"] is not None and r["min_nf"] >= 0.9]
log("\n## participation-gated (exciters with relative participation >= 0.3): min MAC / n exciters")
for r in rows:
    log(f"  {r['f']:6.1f}  participation {r['participation']}  gated min MAC "
        f"{'-' if r['min_gated'] is None else round(r['min_gated'], 2)} over {r['n_gated']} exciters")
agree_g = [r for r in rows if r["min_gated"] is not None and r["min_gated"] >= 0.9 and r["n_gated"] >= 2]
log(f"participation-gated agreement (MAC >= 0.9 among the exciters that drive the mode): {len(agree_g)} "
    f"{[(round(r['f'], 1), r['n_gated']) for r in agree_g]}")
log(f"\nall 4 exciters MAC >= 0.9: raw dwell {len(agree_raw)}/{len(rows)} "
    f"{[round(r['f'], 1) for r in agree_raw]}; residual-corrected {len(agree)} {[round(r['f'], 1) for r in agree]}; "
    f"without near-field sensors {len(agree_nf)} {[round(r['f'], 1) for r in agree_nf]}")
log(f"pairs: median MAC raw {np.median([v for r in rows for v in r['mac_raw'].values()]):.2f}, corrected "
    f"{np.median([v for r in rows for v in r['mac_corrected'].values()]):.2f}, no near-field "
    f"{np.median([v for r in rows for v in r['mac_corrected_no_nearfield'].values()]):.2f}")
log(f"per-exciter resonance spread: median {np.median([r['f_spread_pct'] for r in rows if r['f_spread_pct'] is not None]):.2f} %")
# which exciter is the odd one out: mean MAC of pairs containing it
for e in range(4):
    v = [val for r in rows for k, val in r["mac_corrected"].items() if str(e + 1) in k.split("-")]
    log(f"  pairs with {EX[e]}: median MAC {np.median(v):.2f}")

# overlap + per-exciter PolyMAX counts (< 200 Hz, 60 s FRF)
d = np.load(r"D:\modal_measurements\rig_checks\20261012T161018-sweep_speed\coarse_frf_T60.npz")
cfg = PolymaxConfig(band_edges=(30.0, 60.0, 120.0, 210.0))
sel = d["freqs"] <= 220
cnt = {}
for e in range(4):
    r = identify(d["freqs"][sel], d["H3"][sel], cfg, d["noise_power3"][sel], exciters=[e])
    cnt[EX[e]] = [round(m["f_hz"], 1) for m in r["modes"] if m["f_hz"] < 200]
rj = identify(d["freqs"][sel], d["H3"][sel], cfg, d["noise_power3"][sel])
cnt["joint"] = [round(m["f_hz"], 1) for m in rj["modes"] if m["f_hz"] < 200]
fs = np.array([m["f"] for m in modes])
zs = np.array([m["zeta"] for m in modes])
spacing = np.array([np.min(np.abs(np.delete(fs, i) - fs[i])) for i in range(len(fs))])
mof = 2 * zs * fs / spacing
log("\n## overlap / counts < 200 Hz")
log(f"modal overlap factor (half-power bandwidth / nearest spacing): median {np.median(mof):.2f}, "
    f"> 1 for {int(np.sum(mof > 1))}/{len(mof)} modes")
for k, v in cnt.items():
    log(f"  PolyMAX {k}: {len(v)} modes {v}")

e2rows = []
if E2:
    r2 = json.load(open(os.path.join(E2, "report.json")))
    log("\n## E2 level test: per-exciter resonance f and residual-corrected MAC (min over pairs) vs level")
    for i, m in enumerate(r2["e2_modes"]):
        line = []
        for lvl in ("-42", "-36", "-30"):
            fits = [r2["exciters"][ex][lvl]["fits"][i] for ex in EX]
            vec = [cvec(f["residue"]) if f else None for f in fits]
            fv = [f["f"] for f in fits if f]
            pm = pair_macs(vec)
            line.append(f"{lvl}: f {' '.join(f'{x:.2f}' for x in fv)} MACmin {min(pm.values()):.2f} med {np.median(list(pm.values())):.2f}")
            e2rows.append({"f": m["f"], "level": lvl, "f_per_exciter": fv, "mac": pm,
                           "zeta_per_exciter": [f["zeta"] for f in fits if f]})
        log(f"  {m['f']:6.1f} Hz  " + " | ".join(line))
json.dump({"modes": rows, "nearest": {EX[k]: v for k, v in nearest.items()}, "counts": cnt,
           "overlap_factor": mof.tolist(), "e2": e2rows},
          open(os.path.join(OUT, "e3_analysis.json"), "w"), indent=1, default=float)
open(os.path.join(OUT, "e3_analysis.log"), "w", encoding="utf-8").write("\n".join(LOG))

import matplotlib  # noqa: E402
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
fig, ax = plt.subplots(figsize=(12, 4.5))
x = np.arange(len(rows))
ax.plot(x, [r["min_raw"] for r in rows], "o-", color="#c9c8c4", label="raw dwell (min pair)")
ax.plot(x, [r["min_corr"] or 0 for r in rows], "s-", color="#2a78d6", label="residual-corrected (min pair)")
ax.plot(x, [r["min_nf"] or 0 for r in rows], "^-", color="#1baf7a", label="corrected, near-field sensors removed")
ax.plot(x, [np.median(list(r["mac_corrected"].values())) for r in rows], "s", mfc="none", color="#2a78d6", label="corrected (median pair)")
ax.axhline(0.9, color="#eb6834", lw=0.8, ls="--")
ax.set_xticks(x)
ax.set_xticklabels([f"{r['f']:.0f}" for r in rows], rotation=60, fontsize=8)
ax.set_ylim(0, 1.02)
ax.set_xlabel("mode (Hz)")
ax.set_ylabel("cross-exciter MAC")
ax.grid(True, color="#e4e3df")
ax.legend(fontsize=8, frameon=False)
ax.set_title("E1/E3: do the 4 exciters see the same shape? (< 200 Hz, stepped-sine dwells)", loc="left", fontsize=10)
fig.tight_layout()
fig.savefig(os.path.join(OUT, "e1_cross_exciter_mac.png"), dpi=110)
print(os.path.join(OUT, "e1_cross_exciter_mac.png"))
