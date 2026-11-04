"""dev-bow2 CPU golden with the EXACT engine coefficients of string 172 (pitch 48, damper open) + friction-contact variants (compliance, width). Imported by dev-bow2-hfloss-golden.py."""
import numpy as np

MU_S, MU_D = 0.8, 0.3
S0, S1, S2, CU, DEC2, HF = 1.895563, 5.255886e-02, -3.437971e-04, -1.044301e-01, 6.63e-06, 2.991e-04


def solve(vrel, fn, v0, slipping, a):
    if fn <= 0:
        return 0.0, False
    if not slipping and abs(vrel) <= a * MU_S * fn:
        return -vrel / a, False
    b = v0 - abs(vrel) + a * MU_D * fn
    disc = b * b - 4 * v0 * (a * MU_S * fn - abs(vrel))
    x = 0.5 * (np.sqrt(disc) - b) if disc >= 0 else -1
    if x <= 0:
        return -vrel / a, False
    return -np.sign(vrel) * fn * (MU_D + (MU_S - MU_D) * v0 / (v0 + x)), True


def sim(n=166, bow=25, vb=1e-4, force=0.5, angle=0.3, steps=80000, comp=0.0, weights=(1.0,),
        jitter=0.0, seed=1):
    rng = np.random.default_rng(seed)
    u = np.zeros(n + 4); sv = np.zeros(n + 4); d3 = np.zeros(n + 4)
    lam = np.sqrt(S1 + 4 * S2)
    v0 = vb * (0.2 + 2.8 * angle)
    inner = slice(2, n + 2)
    idx = [bow + k - len(weights) // 2 for k in range(len(weights))]
    slip = [False] * len(weights)
    fprev = [0.0] * len(weights)
    flag = np.zeros(steps, bool)
    out = np.zeros(steps)
    for t in range(steps):
        g = min(1.0, t / 1200)
        fn = force * 32 * lam * vb * g * (1 + jitter * rng.standard_normal())
        d3_1 = d3.copy()
        d3[inner] = u[1:n + 1] + u[3:n + 3] - 2 * u[inner]
        dv = u[inner] * CU + (u[0:n] + u[4:n + 4]) * S2 + (u[1:n + 1] + u[3:n + 3]) * S1 \
            - sv[inner] * DEC2 + (d3[inner] - d3_1[inner]) * HF
        for k, (i, w) in enumerate(zip(idx, weights)):
            vrel = sv[i] + 0.5 * dv[i - 2] - vb * g - comp * fprev[k]
            f, slip[k] = solve(vrel, fn * w, v0, slip[k], 0.5 + comp)
            fprev[k] = f
            dv[i - 2] += f
        sv[inner] += dv
        u[inner] += sv[inner]
        flag[t] = slip[len(idx) // 2]
        out[t] = sv[n]
    return flag, out, lam


def report(tag, flag, out, n=166, lam2=S1 + 4 * S2):
    f0 = np.sqrt(lam2) / (2 * (n + 1))
    tail = flag[40000:]
    stick = ~tail
    slips = np.sum(np.diff(stick.astype(int)) == -1) / (len(tail) * f0)
    o = out[40000:]
    sp = np.abs(np.fft.rfft(o * np.hanning(len(o))))
    fr = np.fft.rfftfreq(len(o))
    h = [sp[(fr > f0 * (k - .3)) & (fr < f0 * (k + .3))].max() for k in range(1, 9)]
    print(f"{tag:34s} slips/period={slips:5.2f} stick={stick.mean():.3f} harm_dB={[round(20*np.log10(x/h[0]),1) for x in h]}",
          flush=True)


if __name__ == '__main__':
    import sys
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    for c in ([0.0, 1.0, 4.0, 16.0] if which in ('all', 'comp') else []):
        for force in (0.3, 0.5, 0.95):
            report(f'comp={c} f={force}', *sim(force=force, comp=c)[:2])
    if which in ('all', 'width'):
        for force in (0.5,):
            report(f'w3 f={force}', *sim(force=force, weights=(0.25, 0.5, 0.25))[:2])
            report(f'w3 comp4 f={force}', *sim(force=force, weights=(0.25, 0.5, 0.25), comp=4.0)[:2])
