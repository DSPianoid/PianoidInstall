"""dev-fd69 2026-10-14: exciter nonlinearity, Out 1/2 vs Out 3/4 (level ladder, ESS + stepped tones).

Per exciter and level, ONE /audio/session: ESS 8 s 20 Hz-10 kHz, 1.5 s gap, then 1.0 s tones at
60 / 100 / 200 / 500 Hz (20 ms fades, 0.3 s gaps). Loopback marker Out 8 -> In 8 (sync reference,
marker only - the drive is NOT mirrored). Inputs In 1-7 = piezos P1-P7. Plus one electrical-floor
session: the same signal at -18 dBFS on Out 8 alone, recorded on In 8 (DAC -> ADC THD floor).
Ladder: -42 / -36 / -30 / -24 dBFS for every exciter, -18 dBFS for Out 1/2/4 only; a level is skipped
(and the ladder stops for that exciter) once any piezo peak exceeds -3 dBFS.

Metrics (median over the 7 piezos and on the strongest piezo):
  * linear FRF deviation vs -30 dBFS per band (rig_checks.linearity);
  * ESS H2 / H3 re the linear IR (rig_checks.harmonic_distortion) per level -> growth slope;
  * tone gain slope: d(response dB) / d(drive dB) at each tone frequency (1.0 = linear, < 1 = compression);
  * tone THD (harmonics 2-5 by lock-in) per level.

Usage:  capture  python <this> capture <out_dir>
        analyse  python <this> analyse <out_dir>     (writes nonlin.json + nonlin.png)
"""
import json
import os
import sys

import numpy as np

FS = 48000
F1, F2, T = 20.0, 10000.0, 8.0
TONES = (60.0, 100.0, 200.0, 500.0)
TONE_S, TGAP, ESS_GAP = 1.0, 0.3, 1.5
EXC = ["Out 1", "Out 2", "Out 3", "Out 4"]
LEVELS = {"Out 1": (-42, -36, -30, -24, -18), "Out 2": (-42, -36, -30, -24, -18),
          "Out 3": (-42, -36, -30, -24), "Out 4": (-42, -36, -30, -24, -18)}
PIEZO = [f"In {k}" for k in range(1, 8)]
# --plan "Out 9:-36,-30,-24;Out 10:-36,-30,-24;Out 3:-36,-30;Out 4:-36,-30,-24"  (overrides EXC / LEVELS)
# --map  "E1=Out 9,E2=Out 10,E3=Out 3,..."  (exciter -> output map, recorded in the run metadata)
# --no-elec  skip the Out 8 -> In 8 interface-floor session
OUTPUT_MAP, ELEC = None, True
for _a in list(sys.argv):
    if _a.startswith("--plan="):
        _p = [x.split(":") for x in _a.split("=", 1)[1].split(";") if x.strip()]
        EXC = [o.strip() for o, _ in _p]
        LEVELS = {o.strip(): tuple(int(v) for v in l.split(",")) for o, l in _p}
        sys.argv.remove(_a)
    elif _a.startswith("--map="):
        OUTPUT_MAP = dict(x.split("=") for x in _a.split("=", 1)[1].split(","))
        sys.argv.remove(_a)
    elif _a == "--no-elec":
        ELEC = False
        sys.argv.remove(_a)
PEAK_STOP = -3.0
BANDS = ((30, 250, "<250"), (250, 1000, "250-1k"), (1000, 2000, "1-2k"), (2000, 9500, "2k+"))


def fade(x, n=int(0.02 * FS)):
    x = x.copy(); x[:n] *= np.linspace(0, 1, n); x[-n:] *= np.linspace(1, 0, n); return x


def build(level):
    from pianoid_middleware.modal_adapter.measurement.ess import exp_sweep
    a = 10 ** (level / 20)
    parts = [exp_sweep(F1, F2, T, FS, level), np.zeros(int(ESS_GAP * FS))]
    t = np.arange(int(TONE_S * FS)) / FS
    for f in TONES:
        parts += [a * fade(np.sin(2 * np.pi * f * t)), np.zeros(int(TGAP * FS))]
    return np.concatenate(parts)


def tone_offsets():
    s = int((T + ESS_GAP) * FS)
    return [s + i * int((TONE_S + TGAP) * FS) for i in range(len(TONES))]


def capture(out):
    from pianoid_middleware.modal_adapter.swept_discovery.audio_io import SessionAudioIO
    io = SessionAudioIO(os.path.join(out, "sessions"), loopback=("Out 8", "In 8"))
    log = []
    os.makedirs(out, exist_ok=True)
    json.dump({"exciters": EXC, "levels": LEVELS, "output_map": OUTPUT_MAP, "piezos": PIEZO,
               "sync": "Out 8 -> In 8"}, open(os.path.join(out, "run_config.json"), "w"), indent=1)
    # electrical floor: Out 8 -> In 8 with NO loopback marker (Out 8 carries the test signal itself)
    ioe = SessionAudioIO(os.path.join(out, "sessions_elec"), loopback=None)
    if ELEC:
      y, m = ioe.play_record(build(-18), "Out 8", ["In 8"], 0.0, 1.0, "elec_m18")
      log.append({"tag": "elec_m18", "status": m.get("status"), "xruns": m.get("xruns"),
                "peak_dbfs": float(20 * np.log10(np.abs(y).max() + 1e-12))})
      print(log[-1], flush=True)
    io.record(T + 1.0, PIEZO, "noise")          # ESS harmonic-window noise floor of the piezos
    for e in EXC:
        for lv in LEVELS[e]:
            tag = f"{e.replace(' ', '').lower()}_m{-lv}"
            y, m = io.play_record(build(lv), e, PIEZO, 0.0, 1.5, tag)
            pk = (20 * np.log10(np.abs(y).max(axis=0) + 1e-12)).round(1).tolist()
            lb = m.get("loopback") or {}
            log.append({"tag": tag, "exciter": e, "level": lv, "status": m.get("status"), "xruns": m.get("xruns"),
                        "loopback_onset": lb.get("onset_frames"), "peaks_dbfs": pk})
            print(tag, m.get("status"), "xruns", m.get("xruns"), "onset", lb.get("onset_frames"), "max peak", max(pk), flush=True)
            if max(pk) > PEAK_STOP:
                print(f"  peak > {PEAK_STOP} dBFS -> ladder stopped for {e}", flush=True)
                break
    json.dump(log, open(os.path.join(out, "capture_log.json"), "w"), indent=1)


def lockin(x, f):
    t = np.arange(len(x)) / FS
    return 2 * np.abs(np.mean(x * np.exp(-2j * np.pi * f * t)[:, None], axis=0))


def analyse(out):
    from pianoid_middleware.modal_adapter.measurement.ess import exp_sweep
    from pianoid_middleware.modal_adapter.swept_discovery import frf as frf_mod
    from pianoid_middleware.modal_adapter.swept_discovery.rig_checks import harmonic_distortion, linearity
    log = json.load(open(os.path.join(out, "capture_log.json")))
    res = {"electrical_floor": None, "per_exciter": {}}

    def tones_of(y, lv):
        r = {}
        for f, s0 in zip(TONES, tone_offsets()):
            w = y[s0 + int(0.25 * FS): s0 + int(0.85 * FS)]
            a = np.array([lockin(w, k * f) for k in range(1, 6)])        # (5, C)
            r[f] = {"fund_dbfs": 20 * np.log10(a[0] + 1e-15),
                    "thd_db": 10 * np.log10(np.sum(a[1:] ** 2, axis=0) / (a[0] ** 2 + 1e-30)),
                    "h2_db": 20 * np.log10(a[1] / (a[0] + 1e-15)), "h3_db": 20 * np.log10(a[2] / (a[0] + 1e-15))}
        return r

    ep = os.path.join(out, "sessions_elec", "elec_m18", "data.npy")
    if os.path.exists(ep):
        ye = np.load(ep).astype(float)
        te = tones_of(ye, -18)
        x = exp_sweep(F1, F2, T, FS, -18)
        he = harmonic_distortion(ye[:int((T + 1.0) * FS)], x, (F1, F2, T))
        res["electrical_floor"] = {"ess": he, "tones_thd_db": {f: float(v["thd_db"][0]) for f, v in te.items()}}
    for e in [x for x in dict.fromkeys(r.get("exciter") for r in log) if x]:
        rows = [r for r in log if r.get("exciter") == e]
        H, d = {}, {}
        tones, raw = {}, {}
        for r in rows:
            lv = r["level"]
            y = np.load(os.path.join(out, "sessions", r["tag"], "data.npy")).astype(float)
            x = exp_sweep(F1, F2, T, FS, lv)
            ess_y = y[:int((T + 1.0) * FS)]
            freqs, Hl = frf_mod.coarse_frf(ess_y, x, FS, (30.0, 9500.0), 1.0, 0.5, sweep_band=(F1, F2), pre_s=0.1)
            H[lv] = Hl[:, :, None]
            npath = os.path.join(out, "sessions", "noise", "data.npy")
            nz = np.load(npath).astype(float) if os.path.exists(npath) else None
            d[lv] = harmonic_distortion(ess_y, x, (F1, F2, T), noise=nz)
            tones[lv] = tones_of(y, lv)
            raw[lv] = [np.array([lockin(y[s0 + int(0.25 * FS): s0 + int(0.85 * FS)], k * f) for k in range(1, 4)])
                       for f, s0 in zip(TONES, tone_offsets())]
        lvls = sorted(H)
        dev = linearity(freqs, H, -30) if -30 in H else None
        strong = int(np.argmax([np.median(np.abs(H[-30][:, c, 0])) for c in range(len(PIEZO))])) if -30 in H else 0
        ex = {"levels": lvls, "strongest_piezo": PIEZO[strong], "frf_dev_vs_m30": dev,
              "ess_h2_db_median": [float(np.median(d[l]["h2_db"])) for l in lvls],
              "ess_h3_db_median": [float(np.median(d[l]["h3_db"])) for l in lvls],
              "ess_h2_db_strong": [float(d[l]["h2_db"][strong]) for l in lvls],
              "ess_h3_db_strong": [float(d[l]["h3_db"][strong]) for l in lvls],
              "ess_h2_noise_db_median": [float(np.median(d[l]["h2_noise_db"])) if "h2_noise_db" in d[l] else None for l in lvls],
              "tones": {}}
        for f in TONES:
            fund = np.array([tones[l][f]["fund_dbfs"] for l in lvls])            # (L, C)
            slope = np.polyfit(np.array(lvls, float), fund, 1)[0]                 # per channel
            top = (fund[-1] - fund[-2]) / (lvls[-1] - lvls[-2])
            ex["tones"][f] = {"gain_slope_median": float(np.median(slope)), "top_step_slope_median": float(np.median(top)),
                              "thd_db_median": [float(np.median(tones[l][f]["thd_db"])) for l in lvls],
                              "thd_db_strong": [float(tones[l][f]["thd_db"][strong]) for l in lvls],
                              "h2_db_strong": [float(tones[l][f]["h2_db"][strong]) for l in lvls],
                              "h3_db_strong": [float(tones[l][f]["h3_db"][strong]) for l in lvls]}
        # force-domain tone harmonics: a_k / |H(k f)| re a_1 / |H(f)| per piezo (board assumed linear,
        # FRF of the same level), only piezos whose harmonic is >= 10 dB above the noise record's lock-in
        nz_rec = np.load(os.path.join(out, "sessions", "noise", "data.npy")).astype(float)
        fd = {}
        for i, f in enumerate(TONES):
            nzk = np.array([lockin(nz_rec[:int(0.6 * FS)], k * f) for k in range(1, 4)])
            per = {"h2_db": [], "h3_db": [], "n_piezos_h2": []}
            for l in lvls:
                a = raw[l][i]; Hm = np.abs(H[l][:, :, 0])
                hk = [Hm[np.argmin(np.abs(freqs - k * f))] for k in range(1, 4)]
                for k, key in ((1, "h2_db"), (2, "h3_db")):
                    ok = a[k] > nzk[k] * 10 ** 0.5
                    v = 20 * np.log10((a[k] / hk[k]) / (a[0] / hk[0]) + 1e-15)
                    per[key].append(float(np.median(v[ok])) if ok.any() else None)
                    if k == 1:
                        per["n_piezos_h2"].append(int(ok.sum()))
            fd[f] = per
        ex["tone_force_domain"] = fd
        ex["h2_growth_db_per_db"] = float(np.polyfit(lvls, ex["ess_h2_db_median"], 1)[0])
        ex["h3_growth_db_per_db"] = float(np.polyfit(lvls, ex["ess_h3_db_median"], 1)[0])
        res["per_exciter"][e] = ex
    json.dump(res, open(os.path.join(out, "nonlin.json"), "w"), indent=1, default=float)

    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    col = {"Out 1": "#36c", "Out 2": "#69e", "Out 3": "#c33", "Out 4": "#e88", "Out 9": "#173", "Out 10": "#4b6",
           "Out 5": "#a6c", "Out 6": "#c90", "Out 7": "#888"}
    pk = {(r["exciter"], r["level"]): max(r["peaks_dbfs"]) for r in log if "exciter" in r}
    fig, ax = plt.subplots(1, 4, figsize=(21, 4.8))
    for e, ex in res["per_exciter"].items():
        L = ex["levels"]
        ax[0].plot(L, ex["ess_h2_db_median"], "o-", color=col[e], label=f"{e} H2")
        ax[0].plot(L, ex["ess_h3_db_median"], "s:", color=col[e], alpha=.6, label=f"{e} H3")
        ax[1].plot([pk[(e, l)] for l in L], ex["ess_h2_db_median"], "o-", color=col[e], label=e)
        fd = ex["tone_force_domain"]
        ax[2].plot(L, [np.nan if v is None else v for v in fd[200.0]["h2_db"]], "o-", color=col[e], label=f"{e} 200 Hz")
        ax[2].plot(L, [np.nan if v is None else v for v in fd[100.0]["h2_db"]], "^:", color=col[e], alpha=.6, label=f"{e} 100 Hz")
        dev = ex["frf_dev_vs_m30"] or {}
        lv_dev = [l for l in L if l != -30]
        ax[3].plot(lv_dev, [dev[f"{l:+.0f} vs -30 dBFS"]["250-1k"]["abs_db_median"] for l in lv_dev], "o-", color=col[e], label=e)
    nf = np.median([ex["ess_h2_noise_db_median"][0] for ex in res["per_exciter"].values()])
    if res["electrical_floor"]:
        ax[0].axhline(np.median(res["electrical_floor"]["ess"]["h2_db"]), color="k", ls=":", lw=1, label="interface H2 (-18 dBFS)")
    ax[0].set(xlabel="drive dBFS", ylabel="dB re linear IR (median 7 piezos)", title="ESS H2 / H3 vs drive")
    ax[1].set(xlabel="max piezo peak dBFS (board motion proxy)", ylabel="H2 dB re linear", title="ESS H2 at equal board motion")
    ax[2].set(xlabel="drive dBFS", ylabel="dB re fundamental (force domain)", title="Tone H2, FRF-equalised (100 / 200 Hz)")
    ax[3].set(xlabel="drive dBFS", ylabel="|dB| median, 250 Hz-1 kHz", title="Linear FRF change vs -30 dBFS (compression)")
    for a_ in ax:
        a_.grid(alpha=.3); a_.legend(fontsize=7)
    plt.tight_layout(); plt.savefig(os.path.join(out, "nonlin.png"), dpi=80)
    for e, ex in res["per_exciter"].items():
        print(e, "H2", np.round(ex["ess_h2_db_median"], 1), "H3", np.round(ex["ess_h3_db_median"], 1),
              f"H2 growth {ex['h2_growth_db_per_db']:.2f} dB/dB", "slopes",
              {f: round(ex["tones"][f]["gain_slope_median"], 3) for f in TONES},
              "THD100", np.round(ex["tones"][100.0]["thd_db_median"], 1))
    print("electrical floor", res["electrical_floor"])


if __name__ == "__main__":
    {"capture": capture, "analyse": analyse}[sys.argv[1]](sys.argv[2])
