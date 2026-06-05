"""dev-lmode in-process probe — listen_mode reporting gap diagnosis.

Deterministic engine-side read of:
  - pianoid.mp.listen_to_modes        (where load_preset's listen_to_modes lands; pianoid.py:194)
  - pianoid.listen                    (what GET /health reports as listen_mode; backendServer.py:2517)
  - the gated sound-channel feedin cell (StringMap.py:444 feedin[sc_idx])

Run from PianoidCore/pianoid_middleware with the venv interpreter:
    cd PianoidCore/pianoid_middleware
    ../.venv/Scripts/python ../../docs/development/diagnostics/dev-lmode-listen-mode-probe.py
"""
import sys, os
sys.path.insert(0, os.getcwd())  # pianoid_middleware on path

import backendServer as bs

PRESET = "presets/Belarus_8band_196modes.json"


def load(lm):
    if bs.pianoid is not None:
        try:
            bs.pianoid.destroyPianoid()
        except Exception as e:
            print("destroy warn:", e)
        bs.pianoid = None
    kwargs = dict(
        string_iteration=4, volume=100, array_size=384, sample_rate=48000,
        samples_in_cycle=64, use_placeholder=False, buffer_size=4,
        audio_on=0, audio_driver_type=0, use_debug_build=0,
        listen_to_modes=bool(lm), sound_derivative_order=1,
    )
    filterlen = 48 * 128 * 3  # same as backendServer.load_preset_route line 1017
    bs.pianoid = bs.initialize(PRESET, filterlen, **kwargs)
    return bs.pianoid


def gated_sc_cell(p):
    """Read the sound-channel feedin cell that listen_to_modes gates."""
    try:
        sm = p.sm
        scm = sm.soundChannelModes
        sc_idx = scm.get_index()
        # pick a sound-channel pitch (outer sound pitch) and a piano pitch
        sample = {}
        for pid in list(sm.pitches)[:0]:
            pass
        # Find first pitch where get_coeff is nonzero, read packed feedin[sc_idx]
        for pid in sm.pitches:
            feedin = sm.pack_pitch_feedin(pid)
            try:
                cell = feedin[sc_idx]
            except Exception:
                cell = None
            sample[pid] = (float(cell) if cell is not None else None, float(scm.get_coeff(pid)))
            if len(sample) >= 3:
                break
        return sc_idx, sample
    except Exception as e:
        return None, {"err": str(e)}


def probe(lm):
    p = load(lm)
    mp_ltm = getattr(p.mp, "listen_to_modes", "MISSING")
    p_listen = getattr(p, "listen", "MISSING")
    sc_idx, cells = gated_sc_cell(p)
    print(f"\n=== load with listen_to_modes={lm} ===")
    print(f"  pianoid.mp.listen_to_modes = {mp_ltm}")
    print(f"  pianoid.listen (== /health listen_mode source) = {p_listen}")
    print(f"  sound-channel sc_idx = {sc_idx}")
    print(f"  gated feedin[sc_idx] per pitch (cell_value, sc_coeff): {cells}")
    return mp_ltm, p_listen, sc_idx, cells


if __name__ == "__main__":
    r1 = probe(1)
    r0 = probe(0)
    print("\n=== SUMMARY ===")
    print(f"mp.listen_to_modes: lm=1 -> {r1[0]}   lm=0 -> {r0[0]}   (should DIFFER if engine applies it)")
    print(f"pianoid.listen:     lm=1 -> {r1[1]}   lm=0 -> {r0[1]}   (/health source; should be UNRELATED to lm)")
    # gated cell comparison
    cells1, cells0 = r1[3], r0[3]
    if isinstance(cells1, dict) and isinstance(cells0, dict) and "err" not in cells1:
        print("gated feedin[sc_idx] cell per pitch:")
        for pid in cells1:
            c1 = cells1.get(pid, (None,))[0]
            c0 = cells0.get(pid, (None,))[0]
            print(f"   pitch {pid}: lm=1 -> {c1}   lm=0 -> {c0}   {'DIFFER' if c1 != c0 else 'SAME'}")
