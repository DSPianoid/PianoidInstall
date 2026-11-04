"""dev-bow2: HF-loss boost on the bowed string, per string with the engine coefficients (dump: dev-bow2-dump-coeffs.py, damper open). Usage: python dev-bow2-hfloss-golden.py 1,40   (boost factors)"""
import numpy as np, itertools
from multiprocessing import Pool
import dev_bow2_golden_engine as g

STR = {  # string: (n_main, bow_idx, s1, s2, c_u, hf)
    172: (166, 25, 5.255886e-02, -3.437971e-04, -1.044301e-01, 2.991e-04),
    64: (268, 40, 3.408880e-02, -1.512314e-04, -6.787514e-02, 5.407e-04),
    187: (58, 9, 3.724574e-02, -3.040228e-03, -6.841103e-02, 1.567e-04),
    139: (34, 5, 6.083360e-02, -6.717487e-03, -1.082322e-01, 2.372e-04),
}

def run(args):
    sid, boost, force, angle = args
    n, bow, s1, s2, cu, hf = STR[sid]
    g.S1, g.S2, g.CU, g.HF, g.DEC2 = s1, s2, cu, hf * boost, 1e-5
    lam = np.sqrt(s1 + 4 * s2); per_steps = 2 * (n + 1) / lam
    steps = int(max(60000, 40 * per_steps))
    flag, out, _ = g.sim(n=n, bow=bow + 2, force=force, angle=angle, steps=steps)
    tail = flag[steps // 2:].astype(int); segs = np.split(tail, np.flatnonzero(np.diff(tail)) + 1)
    per = len(tail) / per_steps
    alls = sum(1 for s in segs if s[0] == 1) / per
    longs = sum(1 for s in segs if s[0] == 1 and len(s) >= 8) / per
    return sid, boost, force, angle, alls, longs, tail.mean(), (bow) / n, bool(np.isfinite(out).all())

if __name__ == '__main__':
    import sys
    boosts = [float(b) for b in sys.argv[1].split(',')]
    cfg = list(itertools.product(STR, boosts, (0.3, 0.5, 0.8), (0.3,)))
    with Pool(8) as p:
        for r in p.map(run, cfg):
            print("string %d boost %.0f force %.1f angle %.1f: slips/period %.2f long %.2f slipfrac %.3f (beta %.3f) finite %s" % r, flush=True)
