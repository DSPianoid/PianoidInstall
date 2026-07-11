"""dev-scr1 — validate the matched-filter optimum is the LOUDEST drive at fixed total RMS.

Operator experiment: pick a low mode (0-9), find x* via calibration, then emit x* and >=5
suboptimal drive vectors ALL normalized to the same L2 norm (== equal total drive RMS, since
the temp /measure_drive_vectors route drives every vector at one fixed volume_coeff) and verify
x* gives maximum acoustic loudness at omega. Measurement only; NO writes.

Usage: python dev-scr1-optimum-validation.py [mode_override]
"""
import json
import sys
import urllib.request

import numpy as np

BASE = "http://127.0.0.1:5000"


def post(ep, body, timeout=240):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{BASE}/{ep}", data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def calibrate(mode_no, pitch=60):
    d = post("modal/calibrate_sound_channel", {"mode_no": mode_no, "pitch": pitch})
    return d.get("review", d)


def l2norm(v):
    return float(np.sqrt(np.sum(np.asarray(v, float) ** 2)))


def scale_to_norm(v, target):
    v = np.asarray(v, float)
    n = l2norm(v)
    return (v * (target / n)).tolist() if n > 1e-12 else v.tolist()


def survey():
    print("=== Survey modes 0-9 (pick best-conditioned) ===")
    rows = []
    for m in range(10):
        rv = calibrate(m)
        para = [x for x in rv["residuals"]["parallelogram_rel"] if isinstance(x, (int, float))]
        maxpara = max((abs(x) for x in para), default=float("nan"))
        sl = np.asarray(rv["self_loudness"], float)
        coupling = float(np.max(sl)) / (float(np.mean(sl)) + 1e-9)  # peak/mean spread
        rows.append((m, rv["frequency_hz"] if "frequency_hz" in rv else None,
                     maxpara, float(np.max(sl)), rv["reference"], rv["row_normalized"]))
        print(f" mode {m}: maxResidual={maxpara:.3f}  maxSelfLoud={np.max(sl):.3f}  "
              f"ref=ch{rv['reference']}  row={np.round(rv['row_normalized'],3)}")
    # best = lowest residual among modes with decent coupling (maxSelfLoud > 0.1)
    ok = [r for r in rows if r[3] > 0.1 and np.isfinite(r[2])]
    best = min(ok or rows, key=lambda r: r[2])
    print(f"\n-> chosen mode {best[0]} (lowest superposition residual {best[2]:.3f} among well-coupled)")
    return best[0]


def experiment(mode_no):
    print(f"\n=== Optimum-validation experiment on mode {mode_no} ===")
    rv = calibrate(mode_no)
    xstar = np.asarray(rv["row_normalized"], float)
    n = len(xstar)
    ref = rv["reference"]
    Rstar = l2norm(xstar)
    dom = int(np.argmax(np.abs(xstar)))
    print(f"x* = {np.round(xstar,4)}  ref=ch{ref}  dominant=ch{dom}  R*=||x*||={Rstar:.4f}")

    rng = np.random.default_rng(7)
    cands = {}
    cands["x* (OPTIMAL)"] = xstar
    cands["equal [1..1] same sign"] = np.ones(n)
    flip = xstar.copy(); flip[dom] *= -1
    cands[f"x* dominant(ch{dom}) sign FLIP"] = flip
    nondom = [i for i in range(n) if i != dom]
    j = nondom[int(np.argmax(np.abs(xstar[nondom])))]
    flip2 = xstar.copy(); flip2[j] *= -1
    cands[f"x* non-dom(ch{j}) sign FLIP"] = flip2
    single = np.zeros(n); single[dom] = np.sign(xstar[dom]) or 1.0
    cands[f"single dominant ch{dom} only"] = single
    flat = np.sign(xstar) * (np.mean(np.abs(xstar)) or 1.0)
    cands["x* amplitudes FLAT, signs kept"] = flat
    cands["random signed #1"] = rng.uniform(-1, 1, n)
    cands["random signed #2"] = rng.uniform(-1, 1, n)

    labels = list(cands.keys())
    vecs = [scale_to_norm(cands[k], Rstar) for k in labels]  # all equal L2 norm == equal RMS
    # sanity: equal norms
    norms = [round(l2norm(v), 4) for v in vecs]
    print("all candidate L2 norms (must be equal):", set(norms))

    resp = post("modal/measure_drive_vectors",
                {"mode_no": mode_no, "vectors": vecs, "repeats": 3})
    loud = np.asarray(resp["loudness"], float)   # shape (cands, repeats)
    mean = loud.mean(axis=1)
    std = loud.std(axis=1)

    order = np.argsort(-mean)
    print(f"\nfreq={resp['freq_hz']:.2f}Hz hold={resp['hold_seconds']*1000:.0f}ms "
          f"settle={resp['settle_seconds']*1000:.0f}ms\n")
    print(f"{'candidate':<34}{'drive vector (norm=R*)':<34}{'loudness(mean±std)':<24}rank")
    for rank, i in enumerate(order):
        star = "  <== OPTIMAL" if labels[i].startswith("x*") and "OPTIMAL" in labels[i] else ""
        print(f"{labels[i]:<34}{str(np.round(vecs[i],3)):<34}"
              f"{mean[i]:.4f} ± {std[i]:.4f}      #{rank+1}{star}")

    opt_i = labels.index("x* (OPTIMAL)")
    runner = mean[order[0]] if order[0] != opt_i else mean[order[1]]
    is_max = order[0] == opt_i
    margin = (mean[opt_i] - runner) / (runner + 1e-9) * 100
    print(f"\nVERDICT: x* is {'the LOUDEST' if is_max else 'NOT the loudest'} "
          f"at fixed total RMS. margin over runner-up = {margin:+.1f}%")
    return is_max


if __name__ == "__main__":
    mode = int(sys.argv[1]) if len(sys.argv) > 1 else survey()
    experiment(mode)
    print("\n--- repeat key ranking for stability ---")
    experiment(mode)
