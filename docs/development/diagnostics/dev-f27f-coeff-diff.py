"""dev-f27f: bitwise diff of parameterKernel output (dev_parameters, debug getParameters) before vs after.
    python dev-f27f-coeff-diff.py BEFORE_DIR AFTER_DIR ARRAY_SIZE [labels...]
Layout (Kernels.cu): block b, slot k, point i at b*32*A + k*A + i; slot 11 = stringNo, 18 = onMain, 19 = onTail."""
import sys
import numpy as np
bd, ad, A = sys.argv[1], sys.argv[2], int(sys.argv[3])
for lab in sys.argv[4:]:
    a = np.load(f"{bd}/{lab}/coeffs.npy"); b = np.load(f"{ad}/{lab}/coeffs.npy")
    blk = a.reshape(-1, 32, A)
    diff = np.argwhere(a.reshape(-1, 32, A) != b.reshape(-1, 32, A))
    print(f"== {lab}: {a.size} values, {len(diff)} differ (bitwise)")
    if len(diff):
        slots = np.unique(diff[:, 1]); print("   slots:", slots.tolist())
        tail = blk[diff[:, 0], 19, diff[:, 2]]; main = blk[diff[:, 0], 18, diff[:, 2]]
        strings = np.unique(blk[diff[:, 0], 11, diff[:, 2]]).astype(int)
        print(f"   points: onTail={int((tail != 0).sum())} onMain={int((main != 0).sum())}; strings={strings.tolist()[:20]}")
        for k in slots:
            m = diff[:, 1] == k
            va = blk[diff[m, 0], k, diff[m, 2]].astype(np.float64); vb = b.reshape(-1, 32, A)[diff[m, 0], k, diff[m, 2]].astype(np.float64)
            print(f"   slot {k}: n={m.sum()} max|rel|={np.max(np.abs(vb - va) / np.maximum(np.abs(va), 1e-30)):.3e}")
