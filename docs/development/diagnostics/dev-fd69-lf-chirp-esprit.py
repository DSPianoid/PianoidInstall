"""dev-fd69: chirp-based ESPRIT restricted to < 200 Hz vs the E1-E3 mode list.

    python <this> collect        # fresh LF chirp: 15-300 Hz ESS, 2 s IRs, 3 repeats / exciter
    python <this> analyze <lf_collection_dir>

IR sources: (a) the live chirp collection ASIO-chirp-2026-10-12 (20 Hz-10 kHz ESS, 1 s IRs,
5 averages, -30 dBFS all exciters); (b) the fresh LF collection (chirp_excitation math, ESS
15-300 Hz, 2 s IRs, Out 3 -30 / others -24 dBFS). ESPRIT = the project pipeline
(EspritRunner.run_single_point, GPU, MAC band merging) with a dedicated < 200 Hz band set
(decimated, long windows). 49-51 Hz (mains hum) poles are dropped. Reference: the 25-mode
< 200 Hz list and the residual-corrected E1 shapes (In 2..In 7) of the same exciter.
"""
import glob
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, r"D:\repos\wt-fd69-core")
from pianoid_middleware.modal_adapter import mode_comparison as C  # noqa: E402

EX = [f"Out {i}" for i in range(1, 5)]
RC = [f"In {i}" for i in range(1, 8)]
LEVEL = {"Out 1": -24.0, "Out 2": -24.0, "Out 3": -30.0, "Out 4": -24.0}
E1 = r"D:\modal_measurements\rig_checks\20261012T172442-e1"
LIVE = r"D:\modal_measurements\ASIO-chirp-2026-10-12\scenarios"
OUT = r"D:\modal_measurements\analysis\dev-fd69-2026-10-12\lf_chirp_esprit"
FS = 48000.0
AGREE = (33.0, 57.9, 59.1, 67.8, 81.4, 118.3, 64.7, 126.9)


def lf_bands(ir_ms):
    common = dict(filter_order=4, exp_factor=0.15, use_multichannel=True)
    return [
        dict(f_min=25, f_max=80, decimation=40, model_order=24, name="LF1", ir_length_ms=ir_ms,
             skip_start_ms=20, start_fade_ms=10, end_fade_ms=50, window_length=None, **common),
        dict(f_min=60, f_max=140, decimation=24, model_order=30, name="LF2", ir_length_ms=min(ir_ms, 1500),
             skip_start_ms=15, start_fade_ms=5, end_fade_ms=40, window_length=None, **common),
        dict(f_min=110, f_max=210, decimation=16, model_order=30, name="LF3", ir_length_ms=min(ir_ms, 1000),
             skip_start_ms=10, start_fade_ms=5, end_fade_ms=30, window_length=None, **common),
    ]


def collect():
    from pianoid_middleware.modal_adapter.measurement.chirp_excitation import (
        build_signal, impulse_responses, resolve_chirp_config)
    from pianoid_middleware.modal_adapter.swept_discovery.audio_io import SessionAudioIO
    out = os.path.join(r"D:\modal_measurements\rig_checks", time.strftime("%Y%m%dT%H%M%S") + "-lfchirp")
    os.makedirs(out)
    io = SessionAudioIO(os.path.join(out, "sessions"))
    meta = {}
    for ex in EX:
        cfg = resolve_chirp_config({"f_start_hz": 15, "f_stop_hz": 300, "ir_length_ms": 2000,
                                    "level_dbfs": LEVEL[ex]}, FS)
        x = build_signal(cfg, FS)
        irs, hd = [], []
        for k in range(3):
            y, _ = io.play_record(x, ex, RC, 0.0, cfg.post_roll_s, f"lf_{ex.replace(' ', '')}_{k + 1}")
            r = impulse_responses(y, x, cfg, FS)
            irs.append(r["ir"])
            hd.append(r["harmonic_db"])
        np.save(os.path.join(out, f"ir_{ex.replace(' ', '')}.npy"), np.mean(irs, axis=0).astype(np.float32))
        meta[ex] = {"chirp": cfg.to_dict(), "harmonic_db": hd}
        print(ex, "done", flush=True)
    json.dump({"meta": meta, "sessions": io.sessions}, open(os.path.join(out, "report.json"), "w"),
              indent=1, default=float)
    print(out)


def live_irs():
    out = {}
    for e, d in enumerate(sorted(glob.glob(os.path.join(LIVE, "ModalAdapter-Scenario*")))):
        out[EX[e]] = np.stack([np.load(os.path.join(d, "averaged_responses", f"average_ch{c}.npy"))
                               for c in range(7)], axis=1)
    return out


def run_esprit(irs, ir_ms):
    from pianoid_middleware.modal_adapter.esprit_runner import EspritRunner
    params = {"bands": lf_bands(ir_ms), "use_gpu": True, "use_tls": True, "max_damping": 0.2,
              "window_length": 2000, "mac_threshold": 0.9, "freq_tol_pct": 0.01,
              "use_multichannel": True}
    res = {}
    for ex, ir in irs.items():
        sig = ir[:, 1:7] / np.abs(ir[:, 1:7]).max()
        r = EspritRunner().run_single_point(sig, FS, params)
        keep = [i for i, f in enumerate(r["frequencies"]) if f < 200 and not 49.0 < f < 51.0]
        res[ex] = [C.mk(r["frequencies"][i], r["damping_ratios"][i], np.asarray(r["mode_shapes"])[i])
                   for i in keep]
    return res


def reference():
    rep = json.load(open(os.path.join(E1, "report.json")))
    refs = []
    for i, m in enumerate(rep["modes"]):
        per = {}
        for ex in EX:
            f = rep["exciters"][ex]["fits"][i]
            if f:
                per[ex] = {"f": f["f"], "z": f["zeta"],
                           "s": np.array([complex(*c) for c in f["residue"]])[1:7]}
        refs.append({"f": m["f"], "z": m["zeta"], "src": m["src"], "per": per})
    return refs


def compare(esp, refs, label, log):
    rows = []
    for r in refs:
        hits = {}
        for ex in EX:
            L = esp[ex]
            if not L:
                continue
            ref = r["per"].get(ex, {"f": r["f"], "z": r["z"], "s": None})
            B = 2 * r["z"] * r["f"]
            j = int(np.argmin([abs(m["f"] - ref["f"]) for m in L]))
            df = abs(L[j]["f"] - ref["f"])
            if df <= 0.5 * B:
                hits[ex] = {"f": L[j]["f"], "z": L[j]["z"], "df_rel_B": df / B,
                            "mac": C.mac(L[j]["s"], ref["s"]) if ref["s"] is not None else None}
        rows.append({"f": r["f"], "src": r["src"], "z_ref": r["z"], "hits": hits})
    # chance: same matching with the ESPRIT lists shifted by +-5 / 7 %
    def count(shift):
        n = 0
        for r in refs:
            B = 2 * r["z"] * r["f"]
            for ex in EX:
                if esp[ex] and min(abs(m["f"] * shift - r["f"]) for m in esp[ex]) <= 0.5 * B:
                    n += 1
        return n
    found = sum(len(r["hits"]) for r in rows)
    chance = np.mean([count(s) for s in (0.93, 0.95, 1.05, 1.07)])
    rng = np.random.default_rng(0)
    nm = []
    for _ in range(2000):
        ex = EX[rng.integers(4)]
        rr = refs[rng.integers(len(refs))]
        if esp[ex] and ex in rr["per"]:
            nm.append(C.mac(esp[ex][rng.integers(len(esp[ex]))]["s"], rr["per"][ex]["s"]))
    macs = [h["mac"] for r in rows for h in r["hits"].values() if h["mac"] is not None]
    log(f"\n=== {label}: ESPRIT modes < 200 Hz per exciter {[len(esp[ex]) for ex in EX]}")
    log(f"  reference x exciter hits within B/2: {found} / {len(refs) * 4} (chance, lists shifted 5-7 %: {chance:.1f})")
    log(f"  shape MAC vs E1 residual-corrected (same exciter, In2..In7): median {np.median(macs):.2f}, "
        f">= 0.8: {sum(m >= 0.8 for m in macs)}/{len(macs)}; chance median {np.median(nm):.2f}")
    zs = [h["z"] / r["z_ref"] for r in rows for h in r["hits"].values()]
    log(f"  damping ESPRIT / reference: median {np.median(zs):.2f} (ESPRIT zeta median "
        f"{np.median([h['z'] for r in rows for h in r['hits'].values()]) * 100:.2f} %; appropriated ~1.6 %)")
    log("  mode    src  hits(exc: f, zeta%, MAC)")
    for r in rows:
        flag = "*" if any(abs(r["f"] - a) < 0.6 for a in AGREE) else " "
        h = "  ".join(f"{ex[-1]}:{v['f']:.1f},{v['z'] * 100:.2f},{'-' if v['mac'] is None else round(v['mac'], 2)}"
                      for ex, v in r["hits"].items())
        log(f" {flag}{r['f']:6.1f}  {r['src'][0]}  {len(r['hits'])}/4  {h}")
    s = C.summarize({e: esp[ex] for e, ex in enumerate(EX)}, bands=((0, 200, "<200"),))
    b = s["by_band"]["<200"]
    pairs = [(v["matched"], v["null_shifted"], v["mac_med"]) for v in s["pairs"].values()]
    log(f"  ESPRIT cross-exciter (<200): clusters {b['clusters']} k1..k4 {b['k1']}/{b['k2']}/{b['k3']}/{b['k4']}, "
        f"pairs matched {[p[0] for p in pairs]} vs chance {[p[1] for p in pairs]}, MAC med {[None if p[2] is None else round(p[2], 2) for p in pairs]}")
    pooled = C.collapse({e: esp[ex] for e, ex in enumerate(EX)}, prefer_snr=False)
    pf = [m["f"] for m in pooled]
    near = [r for r in refs if min(abs(np.array(pf) - r["f"])) <= r["z"] * r["f"]]
    log(f"  pooled ESPRIT clusters < 200 Hz: {len(pooled)}; reference modes with a pooled cluster within B/2: "
        f"{len(near)}/{len(refs)}; of the cross-exciter-agreeing set: "
        f"{sum(1 for r in near if any(abs(r['f'] - a) < 0.6 for a in AGREE))}/"
        f"{sum(1 for r in refs if any(abs(r['f'] - a) < 0.6 for a in AGREE))}")
    strong = [(r["f"], sum(1 for h in r["hits"].values() if h["mac"] is not None and h["mac"] >= 0.8)) for r in rows]
    log("  modes confirmed by ESPRIT (f within B/2 AND shape MAC >= 0.8) per number of exciters: "
        + ", ".join(f"{f:.1f}:{n}" for f, n in strong if n))
    return rows, s


def analyze(lf_dir):
    os.makedirs(OUT, exist_ok=True)
    LOG = []

    def log(x):
        print(x, flush=True)
        LOG.append(x)
    refs = reference()
    out = {}
    sources = {"live chirp collection (1 s IRs, 20 Hz-10 kHz ESS)": (live_irs(), 1000)}
    if lf_dir:
        sources["fresh LF chirp (2 s IRs, 15-300 Hz ESS)"] = (
            {ex: np.load(os.path.join(lf_dir, f"ir_{ex.replace(' ', '')}.npy")) for ex in EX}, 2000)
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(len(sources), 1, figsize=(13, 3.6 * len(sources)), squeeze=False)
    for ax, (label, (irs, ir_ms)) in zip(axes[:, 0], sources.items()):
        esp = run_esprit(irs, ir_ms)
        rows, s = compare(esp, refs, label, log)
        out[label] = {"rows": rows, "esprit": {ex: [(m["f"], m["z"]) for m in esp[ex]] for ex in EX}}
        for r in refs:
            ax.axvspan(r["f"] * (1 - r["z"]), r["f"] * (1 + r["z"]), color="#cde2fb" if not any(abs(r["f"] - a) < 0.6 for a in AGREE) else "#9fd9c0", lw=0)
        for e, ex in enumerate(EX):
            ax.plot([m["f"] for m in esp[ex]], [4 - e] * len(esp[ex]), "o", ms=4,
                    color=["#2a78d6", "#eb6834", "#1baf7a", "#eda100"][e])
        ax.set_yticks([4, 3, 2, 1])
        ax.set_yticklabels(EX)
        ax.set_xlim(25, 205)
        ax.grid(True, color="#e4e3df")
        ax.set_title(f"ESPRIT < 200 Hz, {label}: dots = ESPRIT modes per exciter; bands = reference modes "
                     f"(green = cross-exciter-agreeing), width = half-power", loc="left", fontsize=9)
    axes[-1, 0].set_xlabel("Frequency (Hz)")
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "lf_esprit_vs_reference.png"), dpi=110)
    json.dump(out, open(os.path.join(OUT, "lf_esprit_compare.json"), "w"), indent=1, default=str)
    open(os.path.join(OUT, "lf_esprit_compare.log"), "w", encoding="utf-8").write("\n".join(LOG))
    print(os.path.join(OUT, "lf_esprit_vs_reference.png"))


if __name__ == "__main__":
    if sys.argv[1] == "collect":
        collect()
    else:
        analyze(sys.argv[2] if len(sys.argv) > 2 else None)
