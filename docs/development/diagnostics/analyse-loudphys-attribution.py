"""analyse-loudphys (2026-10-04) -- attribute the measured equal-mass per-pitch level to the chain terms. NO GPU.

    python analyse-loudphys-attribution.py BASE.json [VARIANT_out.json:label ...]

BASE.json = analyse-loudphys-probe.py --dump output (every key pitch at equal hammer_mass).
Terms per pitch p (dB, relative to pitch 60):
  D  = 20 log10(rho * dx^2)         engine string-side gain per unit hammer impulse vs physics (coeff_force lacks
                                     1/(rho dx); bridge force = T*dy lacks 1/dx)  -> physics: 0
  N  = 20 log10(n_strings)          every unison string gets the full c*m*v coefficient  -> physics (FPGA): sqrt(n)
  C  = 20 log10(curve_peak/curve_sum) temporal-shape concentration (same impulse, sharper pulse)  -> physical, data
  B  = 10 log10(sum_k w_k sum_ch |Y_ch(k f0)|^2)  linear modal-board transfer bridge force -> output velocity,
       from the dumped engine (dec, omega, mass_inv) + deck rows (listen_to_modes=0 only; =0 when the output
       tap is the bridge force itself, listen_to_modes=1)
OLS of the measured level on these terms + spreads after removing each (coefficient 1) + implied mass ranges.
"""
import json
import math
import sys

import numpy as np


def rel(v, keys, ref=60):
    v = np.asarray(v, dtype=float)
    i = keys.index(ref) if ref in keys else len(keys) // 2
    return v - v[i]


def board_transfer(base, p, f0, n_part=8):
    md, dk = base["modes"], base["deck"]
    dec, om, mi = (np.asarray(md[k], dtype=float) for k in ("dec", "omega", "mass_inv"))
    n = len(dec)
    a = np.asarray(dk["feedin_rows"][str(p)], dtype=float)[:n]
    outs = [np.asarray(dk["feedin_rows"][k], dtype=float)[:n] for k in dk["feedin_rows"] if int(k) >= 128]
    sr = 48000.0
    tot = 0.0
    for k in range(1, n_part + 1):
        w = 2 * math.pi * k * f0 / sr
        z = np.exp(1j * w)
        h = (1 - dec) * mi * z / (z * z - (1 - dec) * (2 - om) * z + (1 - dec) ** 2)
        drive = a * h * (1 - 1 / z)
        tot += (1.0 / k ** 2) * sum(abs(np.sum(o * drive)) ** 2 for o in outs)
    return 10 * math.log10(tot) if tot > 0 else float("nan")


def curve_spectrum_db(preset_path, pitch, vel, f0, si, n_part=4):
    """Q = 20 log10( sqrt(sum_k w_k |F(k f0)|^2 / sum_k w_k) / F(0) ), w_k = 1/k^2: the force-curve Fourier
    magnitude at the string's partials relative to its impulse (DC). A pulse much longer than the period drives
    the string quasi-statically (physics) -- but a curve width that does not scale with the period is DATA."""
    import base64
    d = json.load(open(preset_path))
    blob = d["pitches"][str(pitch)]["excitation"]
    lm = np.frombuffer(base64.b64decode(blob["data"]), np.dtype(blob["type"])).reshape(blob["shape"])[int(vel)]
    mode_it = d["model_parameters"]["mode_iteration"]
    length = 8 * mode_it * si
    dt = 1.0 / (48000 * si)
    x = np.arange(length) * (8.0 / length)
    z = (x[:, None] - lm[0][None, :]) / lm[1][None, :]
    f = (np.maximum(np.exp(-0.5 * z * z) - lm[3][None, :], 0.0) * lm[2][None, :]).sum(axis=1)
    t = np.arange(length) * dt
    dc = f.sum()
    num = sum((1.0 / k ** 2) * abs(np.sum(f * np.exp(-2j * math.pi * k * f0 * t))) ** 2 for k in range(1, n_part + 1))
    den = sum(1.0 / k ** 2 for k in range(1, n_part + 1))
    return 20 * math.log10(math.sqrt(num / den) / dc) if dc > 0 else float("nan")


def spread(v):
    v = np.asarray(v, dtype=float)
    v = v[np.isfinite(v)]
    return f"max-min {v.max() - v.min():6.1f}  p95-p5 {np.percentile(v, 95) - np.percentile(v, 5):6.1f}  std {v.std():5.1f} dB"


def ols(y, X, names):
    A = np.column_stack([np.ones(len(y))] + X)
    beta, *_ = np.linalg.lstsq(A, y, rcond=None)
    res = y - A @ beta
    r2 = 1 - res.var() / y.var()
    return beta, res, r2


def main():
    base = json.load(open(sys.argv[1]))
    P = base["pitches"]
    keys = sorted(int(k) for k in P if P[k]["m_all"] is not None)
    F = {k: P[str(k)]["factors"] for k in keys}
    L = np.array([P[str(k)]["m_all"] for k in keys])
    D = rel([20 * math.log10(F[k]["rho"] * F[k]["dx"] ** 2) for k in keys], keys)
    N = rel([20 * math.log10(F[k]["n_strings"]) for k in keys], keys)
    C = rel([20 * math.log10(F[k]["curve_peak"] / F[k]["curve_sum"]) for k in keys], keys)
    ltm = base["listen_to_modes"]
    if not ltm and "modes" in base:
        B = rel([board_transfer(base, k, F[k]["f0_ideal"]) for k in keys], keys)
    else:
        B = np.zeros(len(keys))
    Lr = rel(L, keys)
    preset_path = None
    for a in sys.argv[2:]:
        if a.startswith("--preset="):
            preset_path = a.split("=", 1)[1]
    if preset_path:
        Q = rel([curve_spectrum_db(preset_path, k, base["vel"], F[k]["f0_ideal"], base["string_iteration"]) for k in keys], keys)
    else:
        Q = np.zeros(len(keys))
    print(f"preset {base['preset']}  array {base['array_size']} / si {base['string_iteration']} / d{base['deriv']} / ltm {ltm}"
          f"  vel {base['vel']}  equal mass {base['mass_g']} g  n={len(keys)}")
    print(" pitch |  L(meas)  |   D(rho dx^2)   N(nstr)   Q(curve@f0)  B(board) | L-D     L-D-N  L-D-N-Q  L-D-N-Q-B | rho     dx mm  nc nstr f0    curve ms")
    for i, k in enumerate(keys):
        f = F[k]
        print(f" {k:5d} | {Lr[i]:8.1f}  | {D[i]:8.1f} {N[i]:8.1f} {Q[i]:8.1f} {B[i]:8.1f} | {Lr[i]-D[i]:6.1f} {Lr[i]-D[i]-N[i]:7.1f} {Lr[i]-D[i]-N[i]-Q[i]:7.1f} {Lr[i]-D[i]-N[i]-Q[i]-B[i]:7.1f} | "
              f"{f['rho']:.4f} {f['dx']*1e3:5.2f} {f['n_contact']:2d} {f['n_strings']:2d} {f['f0_ideal']:7.1f} {f['curve_width_ms']:5.2f}")
    print("\nSPREADS (equal mass):")
    print("  measured L          ", spread(Lr))
    print("  L - D               ", spread(Lr - D))
    print("  L - D - N           ", spread(Lr - D - N))
    print("  L - D - N - Q       ", spread(Lr - D - N - Q))
    if ltm == 0:
        print("  L - D - N - B       ", spread(Lr - D - N - B))
        print("  L - D - N - Q - B   ", spread(Lr - D - N - Q - B))
    print("  D alone             ", spread(D))
    print("  N alone             ", spread(N))
    print("  Q alone             ", spread(Q))
    print("  C alone             ", spread(C))
    if ltm == 0:
        print("  B alone             ", spread(B))
    terms = [("D", D), ("N", N), ("Q", Q)] + ([("B", B)] if ltm == 0 else [])
    beta, res, r2 = ols(Lr, [t for _, t in terms], [n for n, _ in terms])
    print("\nOLS  L = c0 + " + " + ".join(f"{b:.2f}*{n}" for b, (n, _) in zip(beta[1:], terms)) + f"   R^2 {r2:.3f}   residual {spread(res)}")
    for n, t in terms:
        c = np.corrcoef(Lr, t)[0, 1] if t.std() > 0 else float('nan')
        b1, r1, rr = ols(Lr, [t], [n])
        print(f"   single-term {n}: slope {b1[1]:.2f}  corr {c:.2f}  R^2 {rr:.3f}")
    sel = np.array([F[k]["f0_ideal"] < 2000 for k in keys])
    if sel.sum() > 10:
        beta2, res2, r22 = ols(Lr[sel], [t[sel] for _, t in terms], [n for n, _ in terms])
        print("OLS (f0 < 2 kHz only, n=%d)  L = c0 + " % sel.sum() + " + ".join(f"{b:.2f}*{n}" for b, (n, _) in zip(beta2[1:], terms)) + f"   R^2 {r22:.3f}   residual {spread(res2)}")
        print("   fixed-coefficient residual (f0 < 2 kHz)  L - D - N:", spread((Lr - D - N)[sel]))
    # implied mass range to flatten (mass ∝ 10^(-L/20))
    def mass_range(v, tag):
        v = np.asarray(v); v = v - np.median(v)
        m = 10 ** (-v / 20) * base["mass_g"]
        print(f"  {tag:26s} masses {m.min():7.2f} .. {m.max():8.2f} g  (range {20*math.log10(m.max()/m.min()):5.1f} dB)")
    print("\nIMPLIED hammer_mass to flatten (median = %g g):" % base["mass_g"])
    mass_range(Lr, "as measured")
    mass_range(Lr - D, "after fixing D (rho dx^2)")
    mass_range(Lr - D - N, "after D + N")
    mass_range(Lr - D - N - Q, "after D + N + Q (curves)")
    if ltm == 0:
        mass_range(Lr - D - N - B, "after D + N + B")
        mass_range(Lr - D - N - Q - B, "after D + N + Q + B")
    # variants
    for arg in sys.argv[2:]:
        if arg.startswith("--"):
            continue
        path, label = arg.rsplit(":", 1)
        V = json.load(open(path))["pitches"]
        print(f"\nVARIANT {label}:   (pred = 20 log10 of the rho*dx^2 ratio variant/base)")
        dm, dp = [], []
        for k in sorted(int(x) for x in V):
            if str(k) in P and V[str(k)]["m_all"] is not None:
                b, v = P[str(k)], V[str(k)]
                fb, fv = b["factors"], v["factors"]
                pred = 20 * math.log10((fv["rho"] * fv["dx"] ** 2) / (fb["rho"] * fb["dx"] ** 2))
                dm.append(v['m_all'] - b['m_all']); dp.append(pred)
                print(f"   p{k}: d m_all {v['m_all']-b['m_all']:+7.2f} dB (pred {pred:+6.2f})  d m_ch {v['m_ch']-b['m_ch']:+7.2f}  d peak {v['peak']-b['peak']:+7.2f} | "
                      f"rho {fb['rho']:.4f}->{fv['rho']:.4f} T {fb['tension']:.0f}->{fv['tension']:.0f} dx {fb['dx']*1e3:.2f}->{fv['dx']*1e3:.2f} mm "
                      f"nc {fb['n_contact']}->{fv['n_contact']} width {fb['hammer_width']*1e3:.1f}->{fv['hammer_width']*1e3:.1f} mm f0 {fb['f0_ideal']:.1f}->{fv['f0_ideal']:.1f}"
                      f"  nonfinite {v['nonfinite']}")
        if len(dm) > 3:
            dm, dp = np.array(dm), np.array(dp)
            err = dm - dp
            print(f"   over {len(dm)} pitches: measured-predicted  mean {err.mean():+.2f}  std {err.std():.2f}  max|.| {abs(err).max():.2f} dB"
                  f"   (measured spread {dm.max()-dm.min():.1f}, predicted spread {dp.max()-dp.min():.1f} dB)")


if __name__ == "__main__":
    main()
