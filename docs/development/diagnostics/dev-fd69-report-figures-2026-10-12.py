"""Figures for the mode-discovery progress report (2026-10-12).

    python <this>

Reads saved rig data only (no rig runs):
  60 s ESS FRF + PolyMAX of rig_checks/20261012T161018-sweep_speed, swept run 20261012-rig4b,
  E1 stepped-sine data rig_checks/20261012T172442-e1, E3 analysis json, linearity report.
Writes PNGs to docs/development/report-mode-discovery-2026-10-12/.
"""
import json
import os
import shutil
import sys

import numpy as np

sys.path.insert(0, r"D:\repos\wt-fd69-core")
from pianoid_middleware.modal_adapter.polymax.identify import PolymaxConfig, identify  # noqa: E402

import matplotlib  # noqa: E402
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap  # noqa: E402

ROOT = r"D:\modal_measurements"
SW = os.path.join(ROOT, "rig_checks", "20261012T161018-sweep_speed")
E1 = os.path.join(ROOT, "rig_checks", "20261012T172442-e1")
AN = os.path.join(ROOT, "analysis", "dev-fd69-2026-10-12")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "report-mode-discovery-2026-10-12")
os.makedirs(OUT, exist_ok=True)

EX = [f"Out {i}" for i in range(1, 5)]
RX = [f"In {i}" for i in range(1, 8)]
C = {"blue": "#2a78d6", "orange": "#eb6834", "aqua": "#1baf7a", "yellow": "#eda100",
     "text": "#0b0b0b", "text2": "#52514e", "muted": "#8a8984", "grid": "#e4e3df", "light": "#c9c8c4"}
EXC = [C["blue"], C["orange"], C["aqua"], C["yellow"]]
SEQ = LinearSegmentedColormap.from_list("seqblue", ["#fcfcfb", "#cfe0f6", "#7fb0ea", "#2a78d6", "#123e78"])
plt.rcParams.update({"font.size": 9, "axes.edgecolor": C["light"], "axes.labelcolor": C["text2"],
                     "xtick.color": C["text2"], "ytick.color": C["text2"], "axes.titlesize": 10,
                     "axes.titlelocation": "left", "figure.facecolor": "white"})


def style(ax, grid=True):
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    if grid:
        ax.grid(True, color=C["grid"], lw=0.6)
        ax.set_axisbelow(True)


def mac(a, b):
    a, b = np.ravel(a), np.ravel(b)
    return float(abs(np.vdot(a, b)) ** 2 / max(np.vdot(a, a).real * np.vdot(b, b).real, 1e-300))


def macmat(A, B):
    return np.array([[mac(a, b) for b in B] for a in A])


def cvec(v):
    return np.array([complex(*c) for c in v])


def shape_from_dict(d):
    return np.array([complex(*d[r]) for r in RX])


def save(fig, name):
    p = os.path.join(OUT, name)
    fig.savefig(p, dpi=130, bbox_inches="tight")
    plt.close(fig)
    print(p)


# ---------------------------------------------------------------- shared data
e3 = json.load(open(os.path.join(AN, "e3_analysis.json")))
e1rep = json.load(open(os.path.join(E1, "report.json")))
ref = e1rep["modes"]                                   # 25 reference modes < 200 Hz
ref_f = np.array([m["f"] for m in ref])
agree_all = [r["f"] for r in e3["modes"] if r["min_corr"] is not None and r["min_corr"] >= 0.9]
near = [r["f"] for r in e3["modes"] if r["min_corr"] is not None and r["min_corr"] < 0.9
        and np.median(list(r["mac_corrected"].values())) >= 0.9]


def category(f):
    if any(abs(f - x) < 1e-6 for x in agree_all):
        return "agree"
    if any(abs(f - x) < 1e-6 for x in near):
        return "near"
    return "disagree"


CAT_STYLE = {"agree": (C["blue"], "all 6 exciter pairs MAC >= 0.9"),
             "near": (C["aqua"], "median pair >= 0.9 (one pair 0.75-0.9)"),
             "disagree": (C["light"], "exciters disagree")}

# ---------------------------------------------------------------- 1. stabilization < 200 Hz
d = np.load(os.path.join(SW, "coarse_frf_T60.npz"))
freqs, H3, N3 = d["freqs"], d["H3"], d["noise_power3"]
sel = (freqs >= 20) & (freqs <= 270)
res = identify(freqs[sel], H3[sel], PolymaxConfig(), N3[sel])
fig, (ax0, ax) = plt.subplots(2, 1, figsize=(12, 8.2), sharex=True,
                              gridspec_kw={"height_ratios": [1, 2.4], "hspace": 0.06})
fs = freqs[sel]
sv = np.linalg.svd(H3[sel], compute_uv=False)
ax0.plot(fs, 20 * np.log10(sv[:, 0]), color=C["text2"], lw=1.1, label="σ1 (CMIF)")
ax0.plot(fs, 20 * np.log10(sv[:, 1]), color=C["muted"], lw=0.8, ls="--", label="σ2")
ax0.axvspan(49.3, 50.7, color=C["orange"], alpha=0.18, lw=0)
ax0.text(50.9, ax0.get_ylim()[1] if False else 20 * np.log10(sv[:, 0]).max() - 2, "50 Hz hum (excluded)",
         color=C["orange"], fontsize=8, va="top")
ax0.set_ylabel("CMIF (dB re 1)")
ax0.legend(frameon=False, fontsize=8, loc="lower right", ncol=2)
style(ax0)
ax0.set_title("PolyMAX stabilization diagram below 200 Hz — 60 s ESS FRF (7 piezo sensors × 4 exciters), "
              "2026-10-12", fontsize=10)
STAT = {"o": ("new / unstable pole", C["light"], ".", 3),
        "f": ("stable in f", C["yellow"], "x", 4),
        "d": ("stable in f + ζ", C["orange"], "+", 5),
        "s": ("stable in f + ζ + participation vector", C["blue"], "o", 3.5)}
for st, (lab, col, mk, ms) in STAT.items():
    xs, ys = [], []
    for b in res["bands"]:
        lo, hi = b["band"][2], b["band"][3]
        for op in b["orders"]:
            for f_, s_ in zip(op.f, op.status):
                if s_ == st and lo <= f_ < hi and 20 <= f_ <= 205:
                    xs.append(f_)
                    ys.append(op.p)
    ax.plot(xs, ys, mk, color=col, ms=ms, mew=0.9, label=lab, mfc=col if mk == "o" else "none")
sel_modes = [m for m in res["modes"] if m["f_hz"] < 205]
for k, m in enumerate(sel_modes):
    hum = 49 < m["f_hz"] < 51
    ax.plot([m["f_hz"]], [41.6], "v", color=C["orange"] if hum else C["text"], ms=6,
            label="PolyMAX selected pole" if k == 0 else None)
for k, m in enumerate(ref):
    cat = category(m["f"])
    col = CAT_STYLE[cat][0]
    for a in (ax0, ax):
        a.axvline(m["f"], color=col, lw=1.4 if cat != "disagree" else 0.8, alpha=0.9 if cat != "disagree" else 0.7,
                  zorder=0)
    close = k > 0 and m["f"] - ref[k - 1]["f"] < 2.0
    ax.text(m["f"] + (1.0 if close else 0), 43.2, f"{m['f']:.1f}", rotation=90, fontsize=7, ha="center", va="bottom",
            color=C["text"] if cat != "disagree" else C["muted"])
ax.axvspan(49.3, 50.7, color=C["orange"], alpha=0.18, lw=0)
for cat, (col, lab) in CAT_STYLE.items():
    ax.plot([], [], color=col, lw=1.6, label=f"reference mode: {lab}")
ax.set_xlim(25, 202)
ax.set_ylim(1, 49)
ax.set_xlabel("frequency (Hz)")
ax.set_ylabel("model order p")
style(ax)
ax.legend(frameon=True, framealpha=0.95, edgecolor=C["grid"], fontsize=7.5, loc="lower left", ncol=2,
          bbox_to_anchor=(0.0, -0.33))
save(fig, "fig01_stabilization_below_200Hz.png")
stab_summary = [(round(m["f_hz"], 1), round(m["zeta"] * 100, 2)) for m in sel_modes]
print("PolyMAX selected < 205 Hz:", stab_summary)

# ---------------------------------------------------------------- E1 shapes
fits = {ex: e1rep["exciters"][ex]["fits"] for ex in EX}
dw = {ex: np.load(os.path.join(E1, f"e1_{ex.replace(' ', '')}.npz"))["dwell_Y"] for ex in EX}


def corr_shapes(i):
    return [cvec(fits[ex][i]["residue"]) if fits[ex][i] else None for ex in EX]


def align(v):
    v = v / np.max(np.abs(v))
    k = int(np.argmax(np.abs(v)))
    return v * np.exp(-1j * np.angle(v[k]))


# ---------------------------------------------------------------- 2. best cross-exciter MAC + shapes
BEST = [33.0, 67.8, 81.4, 118.3]
idx = [int(np.argmin(np.abs(ref_f - f))) for f in BEST]
fig, axes = plt.subplots(2, 4, figsize=(15, 7.4), gridspec_kw={"height_ratios": [1, 1.05], "hspace": 0.42,
                                                                 "wspace": 0.32})
for c, i in enumerate(idx):
    vs = corr_shapes(i)
    M = macmat(vs, vs)
    ax = axes[0, c]
    im = ax.imshow(M, cmap=SEQ, vmin=0, vmax=1)
    for a in range(4):
        for b in range(4):
            ax.text(b, a, f"{M[a, b]:.2f}", ha="center", va="center", fontsize=8,
                    color="white" if M[a, b] > 0.6 else C["text"])
    ax.set_xticks(range(4), EX, fontsize=8)
    ax.set_yticks(range(4), EX, fontsize=8)
    r = e3["modes"][i]
    ax.set_title(f"{ref_f[i]:.1f} Hz — cross-exciter MAC\nmin pair: raw {r['min_raw']:.2f} → corrected "
                 f"{r['min_corr']:.2f}", fontsize=9)
    ax = axes[1, c]
    ref_v = align(vs[int(np.argmax([np.linalg.norm(v) for v in vs]))])
    w = 0.2
    for e, v in enumerate(vs):
        a = align(v)
        # rotate each exciter's vector to best match the reference (phase only), plot real part
        a = a * np.exp(1j * np.angle(np.vdot(a, ref_v)))
        ax.bar(np.arange(7) + (e - 1.5) * w, a.real / np.max(np.abs(a)), width=w * 0.9, color=EXC[e],
               label=EX[e])
    ax.axhline(0, color=C["muted"], lw=0.6)
    ax.set_xticks(range(7), RX, fontsize=8)
    ax.set_ylim(-1.1, 1.1)
    ax.set_ylabel("normalised real part (phase-aligned)", fontsize=8)
    ax.set_title(f"{ref_f[i]:.1f} Hz — shape seen by each exciter", fontsize=9)
    style(ax)
axes[1, 0].legend(frameon=False, fontsize=8, ncol=4, loc="lower left", bbox_to_anchor=(0, -0.32))
fig.colorbar(im, ax=axes[0, :].tolist(), shrink=0.75, label="MAC")
fig.suptitle("Best-agreeing modes below 200 Hz: residual-corrected 7-sensor residues of each exciter "
             "(E1 stepped sine, 2026-10-12)", x=0.07, ha="left", fontsize=11)
save(fig, "fig02_best_modes_cross_exciter_mac.png")

# ---------------------------------------------------------------- 3. AutoMAC of the 25 reference modes
cons = []
for i in range(len(ref)):
    vs = [v for v in corr_shapes(i) if v is not None]
    A = np.stack([v / np.linalg.norm(v) for v in vs], axis=1)     # 7 x n_exc, unit columns
    U, s, Vh = np.linalg.svd(A, full_matrices=False)
    cons.append(U[:, 0])
AM = macmat(cons, cons)
fig, ax = plt.subplots(figsize=(8.6, 7.6))
im = ax.imshow(AM, cmap=SEQ, vmin=0, vmax=1)
labs = [f"{f:.1f}" for f in ref_f]
ax.set_xticks(range(len(ref)), labs, rotation=90, fontsize=7)
ax.set_yticks(range(len(ref)), labs, fontsize=7)
for t, f in zip(ax.get_xticklabels(), ref_f):
    t.set_color(C["blue"] if category(f) == "agree" else C["text2"])
for t, f in zip(ax.get_yticklabels(), ref_f):
    t.set_color(C["blue"] if category(f) == "agree" else C["text2"])
fig.colorbar(im, ax=ax, shrink=0.8, label="MAC")
off = AM[~np.eye(len(ref), dtype=bool)]
ax.set_title(f"AutoMAC of the 25 reference modes < 200 Hz (consensus shape over the 4 exciters)\n"
             f"off-diagonal median {np.median(off):.2f}, {int(np.sum(off >= 0.8) / 2)} pairs ≥ 0.8 "
             f"(7-sensor chance ≈ 0.14); blue labels = all exciters agree", fontsize=9)
save(fig, "fig03_automac_reference_modes.png")
hi_pairs = sorted({(round(ref_f[a], 1), round(ref_f[b], 1), round(AM[a, b], 2))
                   for a in range(len(ref)) for b in range(a + 1, len(ref)) if AM[a, b] >= 0.8})
print("AutoMAC off-diag median", np.median(off), "pairs>=0.8", hi_pairs)

# ---------------------------------------------------------------- 4. swept vs PolyMAX cross-MAC
sw = json.load(open(os.path.join(ROOT, "swept_discovery", "20261012-rig4b", "report.json")))
pm = json.load(open(os.path.join(SW, "polymax_T60", "report.json")))
fig, axes = plt.subplots(1, 2, figsize=(15, 7), gridspec_kw={"width_ratios": [1, 1.25], "wspace": 0.25})
summary4 = {}
for ax, fmax, labelled in ((axes[0], 200, True), (axes[1], 1000, False)):
    S = [m for m in sw["modes"] if m["f_hz"] < fmax]
    P = [m for m in pm["modes"] if float(m["f_hz"]) < fmax and not (49 < float(m["f_hz"]) < 51)]
    Sf = np.array([m["f_hz"] for m in S])
    Pf = np.array([float(m["f_hz"]) for m in P])
    Sv = [shape_from_dict(m["shape"]) for m in S]
    Pv = [shape_from_dict(m["shape"]) for m in P]
    X = macmat(Sv, Pv)
    im = ax.imshow(X, cmap=SEQ, vmin=0, vmax=1, aspect="auto")
    # frequency-matched pairs (|df| < max(half-power width, 1 %))
    nm, macs = 0, []
    for a, fa in enumerate(Sf):
        for b, fb in enumerate(Pf):
            zeta = float(P[b]["zeta"])
            if abs(fa - fb) / fb < max(zeta, 0.01):
                ax.add_patch(plt.Rectangle((b - 0.5, a - 0.5), 1, 1, fill=False, ec=C["orange"], lw=1.4))
                nm += 1
                macs.append(X[a, b])
    summary4[fmax] = (len(S), len(P), nm, float(np.median(macs)) if macs else None)
    if labelled:
        ax.set_xticks(range(len(Pf)), [f"{f:.1f}" for f in Pf], rotation=90, fontsize=7)
        ax.set_yticks(range(len(Sf)), [f"{f:.1f}" for f in Sf], fontsize=7)
        for a in range(len(Sf)):
            for b in range(len(Pf)):
                if X[a, b] >= 0.8:
                    ax.text(b, a, f"{X[a, b]:.2f}"[1:], ha="center", va="center", fontsize=6,
                            color="white" if X[a, b] > 0.6 else C["text"])
    else:
        tk = np.arange(0, len(Pf), 5)
        ax.set_xticks(tk, [f"{Pf[k]:.0f}" for k in tk], rotation=90, fontsize=7)
        tk = np.arange(0, len(Sf), 4)
        ax.set_yticks(tk, [f"{Sf[k]:.0f}" for k in tk], fontsize=7)
    ax.set_xlabel("PolyMAX 60 s modes (Hz)")
    ax.set_ylabel("swept-sine joint-fit modes, run rig4b (Hz)")
    ax.set_title(f"< {fmax if fmax < 1000 else '1 k'} Hz: {len(S)} swept × {len(P)} PolyMAX modes\n"
                 f"{nm} frequency-matched pairs (orange boxes), median MAC {np.median(macs):.2f}", fontsize=9)
fig.colorbar(im, ax=axes.tolist(), shrink=0.8, label="MAC")
fig.suptitle("Cross-method MAC: swept-sine joint fit vs PolyMAX (two independent algorithms, 2026-10-12 FRFs)",
             x=0.07, ha="left", fontsize=11)
save(fig, "fig04_crossmac_swept_vs_polymax.png")
print("swept vs polymax", summary4)

# ---------------------------------------------------------------- 5. raw vs residual-corrected MAC
rows = e3["modes"]
fig, axes = plt.subplots(1, 2, figsize=(15, 5.2), gridspec_kw={"width_ratios": [2.4, 1], "wspace": 0.18})
ax = axes[0]
x = np.arange(len(rows))
for k, r in enumerate(rows):
    rv = list(r["mac_raw"].values())
    cv = list(r["mac_corrected"].values())
    ax.plot([k - 0.15] * 2, [min(rv), max(rv)], color=C["light"], lw=3, solid_capstyle="round")
    ax.plot([k + 0.15] * 2, [min(cv), max(cv)], color="#9cc0ec", lw=3, solid_capstyle="round")
ax.plot(x - 0.15, [np.median(list(r["mac_raw"].values())) for r in rows], "o", color=C["text2"], ms=6,
        label="raw dwell response at each exciter's own resonance (median pair; bar = range)")
ax.plot(x + 0.15, [np.median(list(r["mac_corrected"].values())) for r in rows], "s", color=C["blue"], ms=6,
        label="residual-corrected residue from the local multi-mode fit (median pair; bar = range)")
ax.axhline(0.9, color=C["orange"], lw=0.9, ls="--")
ax.text(len(rows) - 0.5, 0.91, "agreement threshold 0.9", color=C["orange"], fontsize=8, ha="right", va="bottom")
ax.set_xticks(x, [f"{r['f']:.1f}" for r in rows], rotation=70, fontsize=8)
for t, r in zip(ax.get_xticklabels(), rows):
    t.set_color(C["blue"] if category(r["f"]) == "agree" else C["text2"])
ax.set_ylim(0, 1.03)
ax.set_xlabel("reference mode (Hz)")
ax.set_ylabel("MAC between exciter pairs")
ax.legend(frameon=False, fontsize=8, loc="lower left", bbox_to_anchor=(0, -0.38))
ax.set_title("Per mode: 6 exciter pairs, raw vs residual-corrected shapes (E1, < 200 Hz)")
style(ax)
ax = axes[1]
allr = [v for r in rows for v in r["mac_raw"].values()]
allc = [v for r in rows for v in r["mac_corrected"].values()]
bins = np.linspace(0, 1, 21)
ax.hist(allr, bins=bins, color=C["light"], label=f"raw (median {np.median(allr):.2f})", rwidth=0.9)
ax.hist(allc, bins=bins, color=C["blue"], alpha=0.75, label=f"corrected (median {np.median(allc):.2f})",
        rwidth=0.9)
ax.axvline(0.14, color=C["muted"], ls=":", lw=1)
ax.text(0.15, ax.get_ylim()[1] * 0.6, "chance\n≈ 0.14", fontsize=7.5, color=C["muted"], va="top")
ax.set_xlabel("pair MAC")
ax.set_ylabel("number of exciter pairs (25 modes × 6)")
ax.legend(frameon=False, fontsize=8, loc="upper left")
ax.set_title("All 150 pairs")
style(ax)
save(fig, "fig05_raw_vs_corrected_mac.png")

# ---------------------------------------------------------------- 6. linearity per exciter
lin = json.load(open(os.path.join(ROOT, "rig_checks", "20261012T160700-linearity", "report.json")))
lpe = json.load(open(os.path.join(ROOT, "rig_checks", "20261012T160700-linearity", "linearity_per_exciter.json")))
lv = [-36, -30, -24]
fig, axes = plt.subplots(1, 2, figsize=(13, 4.6), gridspec_kw={"wspace": 0.25})
ax = axes[0]
for e in range(4):
    h2 = [np.median(lin["harmonics"][str(l)][e]["h2_db"]) for l in lv]
    ax.plot(lv, h2, "o-", color=EXC[e], lw=2, ms=7, label=EX[e])
    ax.text(-23.6, h2[-1], f"{EX[e]} {h2[-1]:.0f} dB", color=C["text2"], fontsize=8, va="center")
ax.plot([-36, -24], [-36, -24], color=C["muted"], lw=0.8, ls=":")
ax.text(-30.5, -31.5, "slope 1 dB/dB\n(2nd-order distortion)", fontsize=7.5, color=C["muted"], rotation=0)
ax.set_xticks(lv)
ax.set_xlim(-37, -20.5)
ax.set_xlabel("drive level (dBFS)")
ax.set_ylabel("H2 re linear IR (dB, median of 7 sensors)")
ax.set_title("2nd-harmonic distortion vs drive level (ESS 8 s)")
ax.legend(frameon=False, fontsize=8, loc="upper left", bbox_to_anchor=(0.0, 0.9))
style(ax)
ax = axes[1]
bands = ["<250", "250-1k", "1-2k", "2k+"]
w = 0.2
for e in range(4):
    v = [lpe[EX[e]]["-24 vs -30 dBFS"].get(b, {}).get("abs_db_median") for b in bands]
    v = [np.nan if x is None else x for x in v]
    ax.bar(np.arange(4) + (e - 1.5) * w, v, width=w * 0.9, color=EXC[e], label=EX[e])
ax.set_xticks(range(4), [b + " Hz" for b in bands])
ax.set_ylabel("|FRF(−24) − FRF(−30)| median (dB)")
ax.set_title("Linear FRF change when the drive rises 6 dB")
ax.legend(frameon=False, fontsize=8, ncol=4, loc="upper left")
style(ax)
save(fig, "fig06_linearity_per_exciter.png")

# ---------------------------------------------------------------- 7. broadband CMIF overview (60 s FRF)
fig, ax = plt.subplots(figsize=(13, 4))
band = (freqs >= 30) & (freqs <= 9500)
svb = np.linalg.svd(H3[band][::4], compute_uv=False)
fb = freqs[band][::4]
ax.semilogx(fb, 20 * np.log10(svb[:, 0]), color=C["text2"], lw=0.8, label="σ1")
ax.semilogx(fb, 20 * np.log10(svb[:, 1]), color=C["muted"], lw=0.6, ls="--", label="σ2")
for k, m in enumerate(pm["modes"]):
    ax.axvline(float(m["f_hz"]), color=C["blue"], lw=0.6, alpha=0.6, label="PolyMAX mode" if k == 0 else None)
ax.axvspan(2000, 9500, color=C["orange"], alpha=0.07, lw=0)
ax.text(2100, ax.get_ylim()[1] - 3, "> 2 kHz: no MPF-stable pole\n(no consistent modal model)", fontsize=8,
        color=C["orange"], va="top")
ax.set_xlabel("frequency (Hz)")
ax.set_ylabel("CMIF (dB re 1)")
ax.set_xlim(30, 9500)
ax.legend(frameon=False, fontsize=8, loc="lower left", ncol=3)
ax.set_title(f"Broadband CMIF of the 60 s ESS FRF (7 × 4) with the {len(pm['modes'])} PolyMAX modes")
style(ax)
save(fig, "fig07_cmif_overview.png")

# ---------------------------------------------------------------- reuse existing analysis plots
for src, dst in ((os.path.join(AN, "damping_appropriation_vs_methods.png"), "fig08_damping_by_method.png"),
                 (os.path.join(AN, "cross_method_vs_chance.png"), "fig09_cross_method_vs_chance.png"),
                 (os.path.join(AN, "lf_chirp_esprit", "lf_esprit_vs_reference.png"), "fig10_lf_chirp_esprit.png")):
    shutil.copy(src, os.path.join(OUT, dst))
    print(os.path.join(OUT, dst))
