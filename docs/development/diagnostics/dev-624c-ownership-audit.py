"""dev-624c — T1 mode-ownership audit: read the BAKED per-thread tags back from the engine and check the
placement invariants of ModeLayout.cuh (every placed mode owned by exactly one thread and coupled by
exactly one quarter; shaped = quarter 0 thread 0; flat owners contiguous at t = Q + j; block-major order).

Usage (from PianoidCore/pianoid_middleware): PYTHONPATH=<bin dir> python dev-624c-ownership-audit.py <preset>
(loads the DEBUG .pyd — getParameters() is a PIANOID_DEBUG_DATA-only readback; the bake code is shared)
Parameter slots (POINT_PARAMETERS_NO = 32, layout [block][slot][arraySize]): 25 = coupling mode of the
thread's quarter, 27 = owned mode (sentinel numModes = none), 28 = owned mode's coupling slot.
"""
import os
import sys

import numpy as np

KW = {"Belarus_8band_196modes": dict(string_iteration=4, array_size=384, sound_derivative_order=2),
      "F15_Elyashev_array512": dict(string_iteration=16, array_size=512, sound_derivative_order=1)}


def main():
    preset = sys.argv[1]
    sys.path.insert(0, os.getcwd())
    from pianoid import initialize
    pw = initialize(f"presets/{preset}.json", filterlen=48 * 128 * 3, buffer_size=4, audio_on=False,
                    audio_driver_type=0, use_debug_build=True, sample_rate=48000, samples_in_cycle=64,
                    listen_to_modes=False, **KW[preset])
    p, A = pw.pianoid, KW[preset]["array_size"]
    N = len(p.getModeDisplacements()) // 5
    import pianoidCuda_debug as pc                  # the bake (stringMapKernel) runs with the first cycle
    cfg = pc.PlaybackConfig()
    cfg.audio_enabled, cfg.record_to_buffer, cfg.max_duration_ms = False, False, 50
    cfg.sample_rate, cfg.samples_per_cycle = 48000, 64
    p.runOfflinePlayback(pc.EventQueue(), cfg)
    par =np.asarray(p.getParameters()).reshape(-1, 32, A)
    B, S = par.shape[0], 4
    Q = A // S
    coup, own, slot = par[:, 25, :].astype(int), par[:, 27, :].astype(int), par[:, 28, :].astype(int)
    F = -(-(min(N, B * S) - B) // B)
    errors = []
    owners = {}
    for b in range(B):
        for t in range(A):
            if own[b, t] < N:
                owners.setdefault(own[b, t], []).append((b, t, slot[b, t]))
        for k in range(S):
            q = coup[b, k * Q:(k + 1) * Q]
            if not (q == q[0]).all():
                errors.append(f"block {b} quarter {k}: coupling tag not uniform")
            exp = b if k == 0 else (B + b * F + k - 1 if k - 1 < F else N)
            if q[0] != (exp if exp < min(N, B * S) else N):
                errors.append(f"block {b} quarter {k}: coupling {q[0]} != {exp}")
    for m in range(min(N, B * S)):
        o = owners.get(m, [])
        if len(o) != 1:
            errors.append(f"mode {m}: {len(o)} owners {o}")
            continue
        b, t, k = o[0]
        if coup[b, k * Q] != m:
            errors.append(f"mode {m}: owner slot {k} couples {coup[b, k * Q]}")
        if (m < B and (t != 0 or k != 0 or b != m)) or (m >= B and (t != Q + (m - B) % F or b != (m - B) // F)):
            errors.append(f"mode {m}: owner (block {b}, t {t}, slot {k}) off the layout")
    print(f"{preset}: N={N} B={B} Q={Q} flatPerBlock={F} owners={sum(len(v) for v in owners.values())} "
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
