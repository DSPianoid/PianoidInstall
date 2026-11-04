"""dev-bow3 CPU golden: bow contact WIDTH on the engine stencil with the per-register string loss.

Strings: engine coefficients from dev-bow2-dump-coeffs.py (C2 = string 64, "A2-like" = string 148
(190 points; its pitch is inferred from the length order), C3 = 172, C4 = 187, G4 = 159), damper open
(dec2 1e-5). Register defaults as BowController.h (BowRegister): loss x40 / x64 / x100 / x60 / x60,
force 0.5 x 1 / 0.67 / 0.6 / 1 / 1, angle 0.3.

Contact models, over w points centred on the hammer index:
  indep   - each point its own friction solve with the weighted share of F_N (point-wise distributed)
  coupled - ONE solve on the weighted contact velocity, force spread by the weights
            (admittance a = 0.5 sum w^2); needs the neighbours' free velocities each sub-step
Profiles: flat or hann (raised cosine).
Extra candidates: "soft" = a regularised stick (F = -vrel / (a + eps), eps = transition softness).

Metrics on the output (velocity next to the bridge), steady half:
  main slips / period (slips >= 8 sub-steps at the centre point), stick fraction,
  noise between partials (dB, energy off h1..h24 +-0.15 f0 vs on), centroid (x f0), roll-off (dB/oct).
Usage: python dev-bow3-width-golden.py [quick]
"""
import itertools
import sys
from multiprocessing import Pool

import numpy as np

MU_S, MU_D = 0.8, 0.3
STR = {  # name: (n_main, bow_idx, s1, s2, c_u, hf, loss, force)
    "C2": (268, 40, 3.408880e-02, -1.512314e-04, -6.787514e-02, 5.407e-04, 40, 0.5),
    "A2": (190, 28, 5.493785e-02, -3.809219e-04, -1.091139e-01, 3.112e-04, 64, 0.335),
    "C3": (166, 25, 5.255886e-02, -3.437971e-04, -1.044301e-01, 2.991e-04, 100, 0.3),
    "C4": (58, 9, 3.724574e-02, -3.040228e-03, -6.841103e-02, 1.567e-04, 60, 0.5),
    "G4": (40, 6, 4.068535e-02, -3.505854e-03, -7.435900e-02, 1.736e-04, 60, 0.5),
}


def solve(vrel, fn, v0, slipping, a, eps=0.0):
    """eps > 0: softened stick (the stick force uses admittance a + eps: the contact yields a little)."""
    if fn <= 0:
        return 0.0, False
    if not slipping and abs(vrel) <= (a + eps) * MU_S * fn:
        return -vrel / (a + eps), False
    b = v0 - abs(vrel) + a * MU_D * fn
    disc = b * b - 4 * v0 * (a * MU_S * fn - abs(vrel))
    x = 0.5 * (np.sqrt(disc) - b) if disc >= 0 else -1
    if x <= 0:
        return -vrel / a, False
    return -np.sign(vrel) * fn * (MU_D + (MU_S - MU_D) * v0 / (v0 + x)), True


def profile(w, kind):
    if w == 1:
        return np.array([1.0])
    if kind == "flat":
        p = np.ones(w)
    elif kind == "para":   # parabolic (Welch) window: centre-weighted, no trig (the kernel candidate)
        x = (np.arange(w) - (w - 1) / 2) / ((w + 1) / 2)
        p = 1 - x * x
    else:
        p = np.sin(np.pi * (np.arange(w) + 1) / (w + 1)) ** 2
    return p / p.sum()


def sim(name, width=1, kind="flat", mode="indep", vb=1e-4, angle=0.3, steps=None, ramp=1200, eps=0.0):
    n, bow, s1, s2, cu, hf, loss, force = STR[name]
    hf *= loss * 2 ** (1.2 * (angle - 0.3))     # BowController angleLossScale
    lam = np.sqrt(s1 + 4 * s2)
    per = 2 * (n + 1) / lam
    steps = steps or int(max(60000, 36 * per))
    u = np.zeros(n + 4); sv = np.zeros(n + 4); d3 = np.zeros(n + 4)
    inner = slice(2, n + 2)
    v0 = vb * (0.2 + 2.8 * angle)
    w = profile(width, kind)
    idx = np.arange(width) + bow + 2 - width // 2
    centre = width // 2
    slip = [False] * width
    flag = np.zeros(steps, bool); out = np.zeros(steps)
    for t in range(steps):
        g = min(1.0, t / ramp)
        fn = force * 32 * lam * vb * g
        d3_1 = d3.copy()
        d3[inner] = u[1:n + 1] + u[3:n + 3] - 2 * u[inner]
        dv = u[inner] * cu + (u[0:n] + u[4:n + 4]) * s2 + (u[1:n + 1] + u[3:n + 3]) * s1 \
            - sv[inner] * 1e-5 + (d3[inner] - d3_1[inner]) * hf
        if mode == "indep":
            for k in range(width):
                i = idx[k]
                f, slip[k] = solve(sv[i] + 0.5 * dv[i - 2] - vb * g, fn * w[k], v0, slip[k], 0.5, eps)
                dv[i - 2] += f
        else:  # coupled
            vc = np.sum(w * (sv[idx] + 0.5 * dv[idx - 2]))
            f, slip[0] = solve(vc - vb * g, fn, v0, slip[0], 0.5 * np.sum(w * w))
            dv[idx - 2] += w * f
            slip[centre] = slip[0]
        sv[inner] += dv
        u[inner] += sv[inner]
        flag[t] = slip[centre]
        out[t] = sv[n]
    return flag, out, per


def metrics(args):
    name, width, kind, mode = args[:4]
    ramp = args[4] if len(args) > 4 else 1200
    eps = args[5] if len(args) > 5 else 0.0
    flag, out, per = sim(name, width, kind, mode, ramp=ramp, eps=eps)
    h0 = len(flag) // 2
    tail = flag[h0:].astype(int)
    segs = np.split(tail, np.flatnonzero(np.diff(tail)) + 1)
    periods = len(tail) / per
    main = sum(1 for s in segs if s[0] == 1 and len(s) >= 8) / periods
    o = out[h0:]
    m = len(o)
    sp = np.abs(np.fft.rfft(o * np.hanning(m), 4 * m)) ** 2
    fr = np.fft.rfftfreq(4 * m)        # cycles per sub-step
    f0 = 1 / per
    on = np.zeros_like(fr, bool)
    harm = []
    for h in range(1, 25):
        band = (fr > f0 * (h - 0.15)) & (fr < f0 * (h + 0.15))
        on |= band
        harm.append(sp[band].max())
    region = fr < f0 * 24.5
    noise = 10 * np.log10(sp[region & ~on].sum() / sp[region & on].sum())
    lv = 10 * np.log10(np.array(harm) / harm[0])
    roll = np.polyfit(np.log2(np.arange(1, 25)), lv, 1)[0]
    amp = np.sqrt(sp[region])
    cen = (amp * fr[region]).sum() / amp.sum() / f0
    return name, width, kind, mode, main, 1 - tail.mean(), noise, cen, roll


def averaged():
    """3 attack ramps per config (the motion is chaotic): mean of each metric."""
    cfg = [(nm, w, k, m, r) for nm in STR for (w, k, m) in ((1, "flat", "indep"), (2, "flat", "indep"),
           (2, "flat", "coupled"), (3, "hann", "coupled"), (5, "hann", "coupled")) for r in (900, 1200, 1700)]
    with Pool(8) as p:
        res = p.map(metrics, cfg)
    groups = {}
    for r in res:
        groups.setdefault(r[:4], []).append(np.array(r[4:]))
    for key, vals in groups.items():
        m = np.mean(vals, axis=0); sd = np.std(vals, axis=0)
        print("%s width %d %-4s %-7s" % key + " main_slips %.2f stick %.3f noise_between %.1f (+-%.1f) dB centroid %.1f xf0 rolloff %.1f"
              % (m[0], m[1], m[2], sd[2], m[3], m[4]), flush=True)


def soft_sweep():
    cfg = [(nm, 1, "flat", "indep", r, e) for nm in STR for e in (0.0, 0.5, 2.0) for r in (900, 1200, 1700)]
    with Pool(8) as p:
        res = p.map(metrics, cfg)
    groups = {}
    for c, r in zip(cfg, res):
        groups.setdefault((c[0], c[5]), []).append(np.array(r[4:]))
    for (nm, e), vals in groups.items():
        m = np.mean(vals, axis=0)
        print("%s stick softness %.1f main_slips %.2f stick %.3f noise_between %.1f dB centroid %.1f xf0 rolloff %.1f"
              % (nm, e, m[0], m[1], m[2], m[3], m[4]), flush=True)


MAX_FRAC, TILT_K, MAX_W = 0.06, 0.7, 16


def tilt_width(name, tilt):
    global MAX_FRAC
    if len(sys.argv) > 2 and sys.argv[1] == "tilt":   # the Pool workers re-import: read it again
        MAX_FRAC = float(sys.argv[2])
    """Tilt -> contact points: the hair ribbon (MAX_FRAC of the main string) narrowed by tilt, min 3."""
    n = STR[name][0]
    return int(min(MAX_W, n - 2, max(3, round(MAX_FRAC * n * (1 - TILT_K * tilt)))))


def metrics_tilt(args):
    name, tilt, ramp = args
    w = tilt_width(name, tilt)
    flag, out, per = sim(name, w, "para", "coupled", angle=tilt, ramp=ramp)
    return (name, tilt, w) + metrics_from(flag, out, per)


def metrics_from(flag, out, per):
    h0 = len(flag) // 2
    tail = flag[h0:].astype(int)
    segs = np.split(tail, np.flatnonzero(np.diff(tail)) + 1)
    main = sum(1 for s in segs if s[0] == 1 and len(s) >= 8) / (len(tail) / per)
    o = out[h0:]
    m = len(o)
    sp = np.abs(np.fft.rfft(o * np.hanning(m), 4 * m)) ** 2
    fr = np.fft.rfftfreq(4 * m)
    f0 = 1 / per
    on = np.zeros_like(fr, bool)
    harm = []
    for h in range(1, 25):
        band = (fr > f0 * (h - 0.15)) & (fr < f0 * (h + 0.15))
        on |= band
        harm.append(sp[band].max())
    region = fr < f0 * 24.5
    noise = 10 * np.log10(sp[region & ~on].sum() / sp[region & on].sum())
    roll = np.polyfit(np.log2(np.arange(1, 25)), 10 * np.log10(np.array(harm) / harm[0]), 1)[0]
    amp = np.sqrt(sp[region])
    return main, 1 - tail.mean(), noise, (amp * fr[region]).sum() / amp.sum() / f0, roll,         10 * np.log10(sp[region].sum())


def _report(groups, label):
    for key, vals in groups.items():
        m = np.mean(vals, axis=0); sd = np.std(vals, axis=0)
        print(label % key + " main_slips %.2f stick %.3f noise_between %.1f (+-%.1f) dB centroid %.1f xf0"
              " rolloff %.1f level %.1f dB" % (m[0], m[1], m[2], sd[2], m[3], m[4], m[5]), flush=True)


def wide_sweep():
    """Large coupled widths (parabolic window) on the bass: noise vs width, 3 attack ramps each."""
    cfg = [(nm, w, "para", "coupled", r) for nm in ("C2", "A2") for w in (1, 3, 5, 8, 12, 16) for r in (900, 1200, 1700)]
    with Pool(6) as p:
        res = p.map(lambda_wide, cfg)
    groups = {}
    for c, r in zip(cfg, res):
        groups.setdefault(c[:2], []).append(np.array(r))
    _report(groups, "%s width %2d para coupled")


def lambda_wide(c):
    flag, out, per = sim(c[0], c[1], c[2], c[3], ramp=c[4])
    return metrics_from(flag, out, per)


def tilt_sweep():
    cfg = [(nm, t, r) for nm in ("C2", "C3", "C4") for t in (0.0, 0.3, 0.6, 0.9) for r in (900, 1200, 1700)]
    with Pool(6) as p:
        res = p.map(metrics_tilt, cfg)
    groups = {}
    for r in res:
        groups.setdefault(r[:3], []).append(np.array(r[3:]))
    _report(groups, "%s tilt %.1f -> width %2d")


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] in ("wide", "tilt"):
    if len(sys.argv) > 2:   # tilt <max width fraction>
        MAX_FRAC = float(sys.argv[2])
    wide_sweep() if sys.argv[1] == "wide" else tilt_sweep()
    sys.exit()

if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "soft":
    soft_sweep()
    sys.exit()

if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "avg":
    averaged()
    sys.exit()

if __name__ == "__main__":
    quick = len(sys.argv) > 1 and sys.argv[1] == "quick"
    cfg = [(nm, 1, "flat", "indep") for nm in STR]
    for nm, wdt, kind, mode in itertools.product(STR, (2, 3, 5), ("flat", "hann"), ("indep", "coupled")):
        if quick and (kind == "hann" or mode == "coupled"):
            continue
        cfg.append((nm, wdt, kind, mode))
    with Pool(8) as p:
        for r in p.map(metrics, cfg):
            print("%s width %d %-4s %-7s main_slips/period %.2f stick %.3f noise_between %.1f dB centroid %.1f xf0 rolloff %.1f dB/oct" % r,
                  flush=True)
