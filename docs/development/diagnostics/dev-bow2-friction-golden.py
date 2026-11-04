"""dev-bow2 CPU golden: the engine's summed-form string update (MainKernel inner loop) with the
friction-bow solve exactly as implemented in BowFriction.cuh, in the engine's own units.

Engine units: s_v = per-sub-step displacement increment; the bow adds its force directly to dv
(the point's own Delta s_v this sub-step, admittance 1). Stick: dv_bow = vb - v_free. Slip: the
hyperbolic friction curve mu(x) = mu_d + (mu_s - mu_d) * v0 / (v0 + x), x = |v_new - vb|, solved
in closed form (one sqrt). The point impedance of the discrete string is lambda = sqrt(T_eng)
(a sustained per-step force F gives a point velocity F / (2 lambda)) -> checked below.

Prints: point impedance check, then pitch / slips-per-period / slip fraction for a force sweep.
Run: python dev-bow2-friction-golden.py
"""
import numpy as np

MU_S, MU_D = 0.8, 0.3


def friction(v_free, vb, fn, v0, slipping, a=0.5):
    """Return (dv_bow, slipping). Mirrors bowFrictionStep() in BowFriction.cuh.

    v_free = the CENTRAL velocity of the bow point without the bow, (s_v_old + s_v_new_free) / 2.
    A bow force F added to this sub-step's dv moves s_v_new by F and the central velocity by
    a * F, a = 1/2 (the scheme's same-step admittance)."""
    dvf = v_free - vb
    x_abs = abs(dvf)
    f_stick = -dvf / a
    if fn <= 0:
        return 0.0, False
    if not slipping and abs(f_stick) <= MU_S * fn:
        return f_stick, False                   # stick: the point moves with the bow
    afn = a * fn
    b = v0 - (x_abs - afn * MU_D)
    c = v0 * (afn * MU_S - x_abs)
    disc = b * b - 4 * c
    x = 0.5 * (-b + np.sqrt(disc)) if disc >= 0 else -1.0
    if x <= 0:
        return f_stick, False                   # no slip solution -> recapture
    return -np.sign(dvf) * fn * (MU_D + (MU_S - MU_D) * v0 / (v0 + x)), True


def simulate(n=200, lam2=0.81, bend=1e-6, dec=2e-5, hf=1e-5, bow_at=None, vb=1e-4,
             fn_rel=0.5, v0_rel=1.0, steps=40000, const_force=None):
    """Return (point velocity trace at the bow, bridge-side velocity trace)."""
    dec_inv = 1 / (1 + dec)
    c_u = (12 * bend - 2 * lam2) * dec_inv
    s1 = (lam2 - 8 * bend) * dec_inv
    s2 = 2 * bend * dec_inv
    d2 = 2 * dec * dec_inv
    u = np.zeros(n + 4)
    sv = np.zeros(n + 4)
    d3 = np.zeros(n + 4)
    bow_at = bow_at if bow_at is not None else 2 + int(0.1 * n)
    lam = np.sqrt(s1 + 4 * s2)
    fn = fn_rel * 4 * lam * vb / 0.1           # fraction of Schelleng F_max at beta = 0.1
    v0 = v0_rel * vb
    slipping = False
    trace_bow, trace_out = np.zeros(steps), np.zeros(steps)
    inner = slice(2, n + 2)
    for t in range(steps):
        d3_1 = d3.copy()
        d3[inner] = u[1:n + 1] + u[3:n + 3] - 2 * u[inner]
        dv = u[inner] * c_u + (u[0:n] + u[4:n + 4]) * s2 + (u[1:n + 1] + u[3:n + 3]) * s1 \
            - sv[inner] * d2 + (d3[inner] - d3_1[inner]) * hf
        if const_force is not None:
            dv[bow_at - 2] += const_force
        elif fn_rel > 0:
            k = bow_at - 2
            g = min(1.0, t / 2000)
            f, slipping = friction(sv[bow_at] + 0.5 * dv[k], vb * g, fn * g, v0, slipping)
            dv[k] += f
        sv[inner] += dv
        u[inner] += sv[inner]
        trace_bow[t] = sv[bow_at]
        trace_out[t] = sv[n]                    # next to the bridge end
    return trace_bow, trace_out, lam


def pitch_hz(x, fs):
    x = x - x.mean()
    sp = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    f = np.fft.rfftfreq(len(x), 1 / fs)
    return f[np.argmax(sp[1:]) + 1]


def main():
    fs = 1.0                                    # per sub-step; f0 of the ideal string = sqrt(lam2)/(2 n)
    tb, _, lam = simulate(const_force=1e-4, fn_rel=0, steps=150, n=400)
    print(f"point impedance: lambda={lam:.4f}, F/(2 v) after 50 steps = {1e-4 / (2 * tb[50]):.4f}")
    n = 200
    f0 = np.sqrt(0.81) / (2 * (n + 1))
    print(f"ideal f0 = {f0:.6f} cycles/step")
    for fn_rel in (0.05, 0.2, 0.5, 1.0, 2.0, 4.0):
        tb, to, _ = simulate(n=n, fn_rel=fn_rel)
        tail = tb[20000:]
        stuck = np.abs(0.5 * (tail[1:] + tail[:-1]) - 1e-4) < 1e-9
        slips = np.sum(np.diff(stuck.astype(int)) == -1)
        periods = len(tail) * f0
        print(f"fn_rel={fn_rel:4.2f}: pitch/f0={pitch_hz(to[20000:], fs) / f0:5.2f} "
              f"slips/period={slips / periods:4.2f} slip_frac={1 - stuck.mean():.3f} "
              f"out_rms={np.sqrt(np.mean(to[20000:] ** 2)):.2e}")


if __name__ == "__main__":
    main()
