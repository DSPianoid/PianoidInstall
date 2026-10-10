"""dev-5bf7 — T3 mode-ownership audit: read the BAKED per-thread tags back from the engine (debug .pyd,
getParameters()) and check the ModeLayout.cuh tier invariants independently of the C++ helpers:
  shaped  m < nS          : owner (block m, t 0, slot 0), coupled by quarter 0 of block m
  uniform nS <= m < nS+nF : owner (block f // U, t Q + f % U, slot -1), f = m - nS, U = ceil(nF / B); coupled by NO quarter
  linked  m >= nS+nF      : owner slot k >= 1 coupled by quarter k of its block, owner t = Q + U + k - 1
and every placed mode has exactly one owner; quarter 0 of blocks >= nS couples nothing.
Legacy presets (nF = 0) are checked against the T1 rules (nS = B, U = 0).

Usage (from PianoidCore/pianoid_middleware): PYTHONPATH=<bin>;<basic> python dev-5bf7-ownership-audit.py <preset.json> <Belarus|F15>
"""
import json
import os
import sys

import numpy as np

KW = {"Belarus": dict(string_iteration=4, array_size=384, sound_derivative_order=2),
      "F15": dict(string_iteration=16, array_size=512, sound_derivative_order=1)}


def main():
    preset, key = sys.argv[1], sys.argv[2]
    sys.path.insert(0, os.getcwd())
    from pianoid import initialize
    pw = initialize(preset, filterlen=48 * 128 * 3, buffer_size=4, audio_on=False, audio_driver_type=0,
                    use_debug_build=True, sample_rate=48000, samples_in_cycle=64, listen_to_modes=False, **KW[key])
    p, A = pw.pianoid, KW[key]["array_size"]
    N = len(p.getModeDisplacements()) // 5
    d = pw.mp.pack_as_dict_for_cuda()
    nF = int(d.get("flat_tier_num_flat", 0) or 0)
    import pianoidCuda_debug as pc
    cfg = pc.PlaybackConfig()
    cfg.audio_enabled, cfg.record_to_buffer, cfg.max_duration_ms = False, False, 50
    cfg.sample_rate, cfg.samples_per_cycle = 48000, 64
    p.runOfflinePlayback(pc.EventQueue(), cfg)
    par = np.asarray(p.getParameters()).reshape(-1, 32, A)
    B, S = par.shape[0], 4
    Q = A // S
    nS = int(d["flat_tier_num_shaped"]) if nF else min(N, B)
    U = -(-nF // B)
    base = nS + nF
    placed = base + min(max(N - base, 0), B * (S - 1))
    L = -(-(placed - base) // B)
    coup, own, slot = par[:, 25, :].astype(int), par[:, 27, :].astype(int), par[:, 28, :].astype(int)
    errors, owners, coupled = [], {}, {}
    for b in range(B):
        for t in range(A):
            if own[b, t] < N:
                owners.setdefault(own[b, t], []).append((b, t, slot[b, t]))
        for k in range(S):
            q = coup[b, k * Q:(k + 1) * Q]
            if not (q == q[0]).all():
                errors.append(f"block {b} quarter {k}: coupling tag not uniform")
            if q[0] < N:
                coupled.setdefault(int(q[0]), []).append((b, k))
    for b in range(nS, B):
        if coup[b, 0] < N:
            errors.append(f"block {b}: quarter 0 couples {coup[b, 0]} beyond the shaped tier")
    for m in range(placed):
        o = owners.get(m, [])
        if len(o) != 1:
            errors.append(f"mode {m}: {len(o)} owners {o}")
            continue
        b, t, k = o[0]
        if m < nS:
            ok = (b, t, k) == (m, 0, 0) and coupled.get(m) == [(m, 0)]
        elif m < base:
            f = m - nS
            ok = (b, t, k) == (f // U, Q + f % U, -1) and m not in coupled
        else:
            ok = k >= 1 and coupled.get(m) == [(b, k)] and t == Q + U + k - 1
        if not ok:
            errors.append(f"mode {m}: owner (block {b}, t {t}, slot {k}), coupled {coupled.get(m)} off the layout")
    tiers = {"N": N, "B": B, "Q": Q, "nS": nS, "nF": nF, "U": U, "linkedBase": base, "placed": placed, "L": L}
    print(f"AUDIT {os.path.basename(preset)}: {json.dumps(tiers)} owners={sum(len(v) for v in owners.values())} "
          f"errors={len(errors)}")
    for e in errors[:20]:
        print("  ", e)
    try:
        p.shutdownGpu()
    except Exception:
        pass
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
