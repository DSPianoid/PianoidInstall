"""Compare two dev-elat1-offline.py runs: every B_* array must be bit-identical (np.array_equal)."""
import sys
import numpy as np
a, b = np.load(sys.argv[1]), np.load(sys.argv[2])
ka, kb = sorted(a.files), sorted(b.files)
assert ka == kb, (set(ka) ^ set(kb))
bad = 0
for k in ka:
    x, y = a[k], b[k]
    same = x.shape == y.shape and np.array_equal(x, y)
    if not same:
        bad += 1
        d = float(np.max(np.abs(x.astype(np.float64) - y.astype(np.float64)))) if x.shape == y.shape else float('nan')
        print(f"DIFF {k}: shape {x.shape} vs {y.shape}, max|d| {d:.3e}, peak {float(np.max(np.abs(x))):.3e}")
def group(k):
    return 'coeff' if k.endswith('_coeff') else ('force' if k.endswith('_force') else 'audio')
for g in ('coeff', 'force', 'audio'):
    ks = [k for k in ka if group(k) == g]
    same = [k for k in ks if a[k].shape == b[k].shape and np.array_equal(a[k], b[k])]
    rel = [float(np.max(np.abs(a[k].astype(np.float64) - b[k].astype(np.float64))) / (np.max(np.abs(a[k])) + 1e-30))
           for k in ks]
    print(f"{g:5s}: {len(same)}/{len(ks)} bit-identical; max rel |d| {max(rel) if rel else 0:.3e}")
sys.exit(1 if bad else 0)
