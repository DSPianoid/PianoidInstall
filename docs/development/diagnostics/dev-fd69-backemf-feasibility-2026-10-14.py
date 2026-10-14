"""dev-fd69 2026-10-14: are the OFF-DIAGONAL coil currents (I_k while exciter j != k drives) a mechanical
back-EMF measurement of board motion at exciter k, or electrical crosstalk? (analysis only)

Physics: undriven exciter k sits on a low-impedance amplifier output, so I_k = -Bl_k * v_rel,k / Z_e,k
(v_rel = coil-vs-magnet velocity, driven by the board at k through the exciter suspension).
Data: B3 (ESS 8 s 20 Hz-5 kHz at -36 dBFS, drives E1 E2 E3 E4 E7; all 8 inputs) + B3 noise record,
B2 (ESS 20 s 15-200 Hz, all 7 drives, 2 repeats) for LF + repeatability.
Checks per (j drive, k response):
  1 delay: current-referenced impulse response I_k / I_j (latency-free, 150 Hz-2 kHz): energy share in
    the first 5 samples (instantaneous = electrical) and the peak delay, vs P8 / I_j.
  2 SNR: |I_k/V| vs the noise record deconvolved the same way, per band.
  3 modal content: log-|I_k / I_j| peaks vs the consensus poles; correlation with P8 / I_j shape.
  4 reciprocity: R_kj = (I_k|j / I_j|j) / (I_j|k / I_k|k) should be SMOOTH (only exciter electromechanics,
    no modal peaks) if both are back-EMF of reciprocal board mobilities: compare the spectral roughness
    (std of log|.| minus its 1/3-octave smooth) of R_kj with that of the individual transfers.
  5 B2 repeatability (15-200 Hz): repeat coherence of off-diagonal I_k / V.
Usage: python <this> <B3_dir> <B2_dir> <out_dir>
"""
import itertools
import json
import os
import sys

import numpy as np

FS = 48000
B3_LEVEL = -36
DRV = ["E1", "E2", "E3", "E4", "E7"]
CONS = r"D:\modal_measurements\rig_checks\consensus-lt200-20261014\consensus_lt200.json"
REF7 = r"D:\modal_measurements\rig_checks\20261014T144226-fixed-layout-7x7\report.json"


def frf(y, x, band, nir_s=1.0, pre=30):
    from pianoid_middleware.modal_adapter.measurement.ess import deconvolve
    nir = int(nir_s * FS)
    h = np.roll(deconvolve(y, x, FS, band), pre, axis=0)[:nir]
    return np.fft.rfftfreq(nir, 1 / FS), np.fft.rfft(h, axis=0), h


def smooth_oct(f, v, frac=3):
    out = np.empty_like(v)
    for i, fi in enumerate(f):
        s = (f >= fi * 2 ** (-0.5 / frac)) & (f <= fi * 2 ** (0.5 / frac))
        out[i] = np.mean(v[s])
    return out


def main(b3, b2, out):
    from pianoid_middleware.modal_adapter.measurement.ess import exp_sweep
    os.makedirs(out, exist_ok=True)
    x = exp_sweep(20.0, 5000.0, 8.0, FS, B3_LEVEL)
    nz = np.load(os.path.join(b3, "sessions", "noise", "data.npy")).astype(float)
    n9 = int(9.0 * FS)
    fN, Hn, _ = frf(nz[:n9], x, (20.0, 5000.0))
    H, IR = {}, {}
    for j in DRV:
        y = np.load(os.path.join(b3, "sessions", f"{j}_m{-B3_LEVEL}", "data.npy")).astype(float)[:n9]
        f, Hj, hj = frf(y, x, (20.0, 5000.0))
        H[j], IR[j] = Hj, hj
    bands = ((30, 100), (100, 300), (300, 1000), (1000, 2000), (2000, 4000))
    res = {"snr_db": {}, "delay": {}, "modal": {}, "reciprocity": {}}
    # 1 + 2: SNR per band and delay (current-referenced IR)
    for j in DRV:
        jj = int(j[1]) - 1
        for k in range(8):
            if k == jj:
                continue
            key = f"{'P8' if k == 7 else 'I' + str(k + 1)}|{j}"
            res["snr_db"][key] = {f"{lo}-{hi}": round(float(np.median(20 * np.log10(np.abs(H[j][(f >= lo) & (f < hi), k]) / np.abs(Hn[(f >= lo) & (f < hi), k])))), 1)
                                  for lo, hi in bands}
            n = 8192
            A = np.fft.rfft(IR[j][:n, k]); B = np.fft.rfft(IR[j][:n, jj]); fr = np.fft.rfftfreq(n, 1 / FS)
            bd = (fr >= 150) & (fr <= 2000)
            G = np.zeros_like(A); G[bd] = A[bd] / B[bd]
            g = np.roll(np.fft.irfft(G, n=n), 200); e = g ** 2
            res["delay"][key] = {"early_energy_frac_0_5": round(float(e[198:205].sum() / e.sum()), 3), "peak_delay_samples": int(np.argmax(np.abs(g))) - 200}
    # 3: modal content - local maxima of |I_k / I_j| near consensus / 7x7 poles
    poles = [m["f"] for m in json.load(open(CONS))["consensus"]] + [m["f"] for m in json.load(open(REF7))["modes"] if m["f"] >= 200]
    for j in DRV:
        jj = int(j[1]) - 1
        for k in range(7):
            if k == jj:
                continue
            key = f"I{k + 1}|{j}"
            t = 20 * np.log10(np.abs(H[j][:, k] / H[j][:, jj]) + 1e-15)
            p8 = 20 * np.log10(np.abs(H[j][:, 7] / H[j][:, jj]) + 1e-15)
            s = (f >= 40) & (f <= 1000)
            rough = t[s] - smooth_oct(f[s], t[s])
            pk = np.flatnonzero((rough[1:-1] > rough[:-2]) & (rough[1:-1] > rough[2:]) & (rough[1:-1] > 1.5)) + 1
            fpk = f[s][pk]
            hit = np.mean([np.min(np.abs(np.array(poles) - x0) / x0) <= 0.01 for x0 in fpk]) if len(fpk) else None
            rng = np.random.default_rng(0)
            rnd = np.mean([np.min(np.abs(np.array(poles) - x0) / x0) <= 0.01 for x0 in rng.uniform(40, 1000, 2000)])
            res["modal"][key] = {"n_peaks_40_1k": int(len(fpk)), "frac_peaks_on_known_poles": None if hit is None else round(float(hit), 2),
                                 "chance_frac": round(float(rnd), 2), "roughness_db": round(float(np.std(rough)), 2),
                                 "logmag_corr_with_P8": round(float(np.corrcoef(rough, (p8[s] - smooth_oct(f[s], p8[s])))[0, 1]), 2)}
    # 4: reciprocity among the drives present
    for a, b in itertools.combinations(DRV, 2):
        ia, ib = int(a[1]) - 1, int(b[1]) - 1
        Tab = H[a][:, ib] / H[a][:, ia]      # I_b while a drives, per I_a
        Tba = H[b][:, ia] / H[b][:, ib]
        s = (f >= 40) & (f <= 1000)
        lr = 20 * np.log10(np.abs(Tab[s] / Tba[s]))
        ra = 20 * np.log10(np.abs(Tab[s]))
        rough_ratio = float(np.std(lr - smooth_oct(f[s], lr)))
        rough_ind = float(np.std(ra - smooth_oct(f[s], ra)))
        res["reciprocity"][f"{a}<->{b}"] = {"roughness_ratio_db": round(rough_ratio, 2), "roughness_individual_db": round(rough_ind, 2),
                                            "ratio_median_db": round(float(np.median(lr)), 1)}
    # 5: B2 repeatability (15-200 Hz) of off-diagonal currents
    rep = {}
    for j in ["E1", "E2", "E3", "E4", "E5", "E6", "E7"]:
        jj = int(j[1]) - 1
        cfg = json.load(open(os.path.join(b2, "run_config.json")))
        x2 = exp_sweep(15.0, 200.0, 20.0, FS, cfg["levels"][j])
        Hs = []
        for r in (1, 2):
            y = np.load(os.path.join(b2, "sessions", f"{j}_r{r}", "data.npy")).astype(float)
            f2, Hr, _ = frf(y, x2, (15.0, 200.0), nir_s=4.0)
            Hs.append(Hr)
        Hs = np.array(Hs); s2 = (f2 >= 20) & (f2 <= 190)
        for hz in (50.0, 100.0, 150.0):
            s2 &= np.abs(f2 - hz) > 1.0
        g2 = np.abs(Hs.mean(0)) ** 2 / np.mean(np.abs(Hs) ** 2, axis=0)
        snr = 10 * np.log10(np.maximum(g2, 1e-9) / np.maximum(1 - g2, 1e-9))
        rep[j] = {f"I{k + 1}": round(float(np.median(snr[s2, k])), 1) for k in range(7) if k != jj}
    res["b2_repeat_snr_db_20_190"] = rep
    json.dump(res, open(os.path.join(out, "backemf_feasibility.json"), "w"), indent=1)
    # plot: one example drive, all off-diagonal currents per I_j vs P8 per I_j
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    fig, axs = plt.subplots(1, 2, figsize=(17, 5))
    for ax, j in zip(axs, ("E7", "E3")):
        jj = int(j[1]) - 1; s = (f >= 25) & (f <= 3000)
        for k in range(7):
            if k != jj:
                ax.semilogx(f[s], 20 * np.log10(np.abs(H[j][s, k] / H[j][s, jj])), lw=.8, label=f"I{k + 1}/I{jj + 1}")
        ax.semilogx(f[s], 20 * np.log10(np.abs(H[j][s, 7] / H[j][s, jj])) - 40, "k", lw=1, label="P8/I (-40 dB offset)")
        ax.semilogx(fN[s], 20 * np.log10(np.abs(Hn[s, 0] / H[j][s, jj])), color="0.7", lw=.6, label="noise (In 1)/I")
        for p in [p for p in poles if p < 300]:
            ax.axvline(p, color="r", lw=.3)
        ax.set_title(f"drive {j}: off-diagonal coil currents per own current"); ax.legend(fontsize=6); ax.grid(alpha=.3)
    plt.tight_layout(); plt.savefig(os.path.join(out, "backemf_feasibility.png"), dpi=85)
    print(json.dumps(res, indent=0)[:9000])


if __name__ == "__main__":
    main(*sys.argv[1:4])
