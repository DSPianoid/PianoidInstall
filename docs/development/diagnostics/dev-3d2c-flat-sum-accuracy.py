"""dev-3d2c — 4000-modes T4: fp32 accuracy of the flat-tier feedback sum Q_sum at N ~ 2000 vs a float64 reference.

The engine (FlatTier.cuh) forms Q_sum = sum of the uniform flat modes' q' every sample in fp32:
  (1) per block: the owner threads t = Q + j (j < U = ceil(nF / B)) hold q'(nS + b*U + j); every warp overlapping
      [Q, Q + U) does a __shfl_down tree sum (offsets 16..1), lane 0 atomicAdds into shared (0 + w_a + w_b ...);
  (2) cross-block: warp 0, lane t: row[t] + row[t + 32] (64 columns, blocks >= B are 0), then the same shuffle tree.
This harness renders a chord on the engine (offline, fresh process), snapshots the REAL engine mode state (fp32 q of
every mode, getModeDisplacements) every --chunk-ms, and evaluates on each snapshot the bit-exact fp32 emulation of
(1)+(2) (both atomic orders of step 1) against the float64 sum of the same fp32 values. The difference is exactly the
reduction's rounding error on the engine's own state distribution (the q' themselves are fp32 in both).

Usage (PYTHONPATH = scratch bin + Basic, run from the Core worktree's pianoid_middleware):
    python dev-3d2c-flat-sum-accuracy.py <preset.json> <kw: Belarus|F15> <label> <out_dir> [--seconds 3] [--chunk-ms 20]
    -> <out_dir>/<label>_<preset stem>_accuracy.json (summary + per-snapshot rows)
"""
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
H = __import__("dev-5bf7-t3-harness")
WARP = 32
SEGMENT = 64


def warp_tree(lanes):
    """Lane-0 result of the CUDA __shfl_down_sync tree (offsets 16, 8, 4, 2, 1) in fp32."""
    v = np.asarray(lanes, dtype=np.float32).copy()
    for off in (16, 8, 4, 2, 1):
        v[:off] = (v[:off] + v[off:2 * off]).astype(np.float32)
    return np.float32(v[0])


def fp32_qsum(q, n_shaped, n_flat, blocks, quarter):
    """Bit-exact fp32 emulation of FlatTier.cuh for one state; returns (order a, order b) for the atomic order."""
    u = -(-n_flat // blocks)
    partial_a = np.zeros(SEGMENT, dtype=np.float32)
    partial_b = np.zeros(SEGMENT, dtype=np.float32)
    block_threads = 4 * quarter
    for b in range(blocks):
        vals = np.zeros(block_threads, dtype=np.float32)
        for j in range(u):
            f = b * u + j
            if f < n_flat:
                vals[quarter + j] = q[n_shaped + f]
        warp_sums = [warp_tree(vals[w * WARP:(w + 1) * WARP]) for w in range(block_threads // WARP)
                     if w * WARP < quarter + u and w * WARP + WARP > quarter]
        acc = np.float32(0.0)
        for s in warp_sums:
            acc = np.float32(acc + s)
        partial_a[b] = acc
        acc = np.float32(0.0)
        for s in reversed(warp_sums):
            acc = np.float32(acc + s)
        partial_b[b] = acc
    out = []
    for row in (partial_a, partial_b):
        lanes = (row[:WARP] + row[WARP:]).astype(np.float32)
        out.append(float(warp_tree(lanes)))
    return out


def main():
    preset, kw, label, out_dir = sys.argv[1:5]
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"{label}_{os.path.splitext(os.path.basename(preset))[0]}_accuracy.json")
    seconds = float(sys.argv[sys.argv.index("--seconds") + 1]) if "--seconds" in sys.argv else 3.0
    chunk = float(sys.argv[sys.argv.index("--chunk-ms") + 1]) if "--chunk-ms" in sys.argv else 20.0
    sys.path.insert(0, os.getcwd())
    from pianoid import initialize
    pw = initialize(preset, filterlen=48 * 128 * 3, buffer_size=4, audio_on=False, audio_driver_type=0,
                    use_debug_build=False, **H.KW[kw])
    p = pw.pianoid
    import pianoidCuda as pc
    mp = pw.mp
    n_s, n_f = int(mp.flat_tier_num_shaped), int(mp.flat_tier_num_flat)
    blocks, quarter = mp.num_strings // 4, mp.array_size // 4
    n_eng = int(mp.num_modes_for_model)
    p.resetStringsState()
    p.resetModeRunningState()
    H.run_offline(p, pc, 0.1, record=False)
    rows = []
    n_chunks = int(round(seconds * 1000 / chunk))
    for k in range(n_chunks):
        evs = [H.ev(pc, x, 1) for x in H.CHORD] if k == 0 else []
        if k == int(round(2400 / chunk)):
            evs = [H.ev(pc, x, 1, on=False) for x in H.CHORD]
        H.run_offline(p, pc, chunk / 1000.0, record=False, events=evs)
        st = np.asarray(p.getModeDisplacements(), dtype=np.float64)
        q = st[:n_eng].astype(np.float32)
        assert np.array_equal(q.astype(np.float64), st[:n_eng]), "mode state is not fp32-exact"
        flat = q[n_s:n_s + n_f].astype(np.float64)
        ref = math.fsum(flat)
        e32 = fp32_qsum(q, n_s, n_f, blocks, quarter)
        rows.append({"t_s": (k + 1) * chunk / 1000.0, "ref": ref, "abs_sum": float(np.abs(flat).sum()),
                     "max_abs": float(np.abs(flat).max()), "fp32_a": e32[0], "fp32_b": e32[1]})
    ref = np.array([r["ref"] for r in rows])
    err = np.array([[r["fp32_a"] - r["ref"], r["fp32_b"] - r["ref"]] for r in rows])
    abs_sum = np.array([r["abs_sum"] for r in rows])
    rms_ref = float(np.sqrt(np.mean(ref ** 2)))
    eps = float(np.finfo(np.float32).eps)
    summary = {
        "preset": preset, "num_modes_engine": n_eng, "n_shaped": n_s, "n_flat": n_f, "blocks": blocks,
        "quarter": quarter, "uniform_per_block": -(-n_f // blocks), "snapshots": len(rows), "chunk_ms": chunk,
        "rms_Q_sum": rms_ref, "max_abs_err": float(np.abs(err).max()), "rms_err": float(np.sqrt(np.mean(err ** 2))),
        "rel_err_vs_rms_Q": float(np.abs(err).max() / rms_ref) if rms_ref else None,
        "rms_rel_err_vs_rms_Q": float(np.sqrt(np.mean(err ** 2)) / rms_ref) if rms_ref else None,
        "max_err_over_sum_abs_eps": float(np.max(np.abs(err).max(axis=1) / (abs_sum * eps + 1e-300))),
        "cancellation_sum_abs_over_rms_Q": float(np.mean(abs_sum) / rms_ref) if rms_ref else None,
        "atomic_order_max_diff": float(np.abs(err[:, 0] - err[:, 1]).max()),
        "finite": bool(np.isfinite(ref).all()),
    }
    with open(out, "w") as f:
        json.dump({"summary": summary, "rows": rows}, f, indent=1)
    print("RESULT " + json.dumps(summary))
    try:
        p.shutdownGpu()
    except Exception:
        pass


if __name__ == "__main__":
    main()
