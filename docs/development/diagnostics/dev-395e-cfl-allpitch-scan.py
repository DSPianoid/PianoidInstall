"""
dev-395e: scan ALL piano pitches across presets — baseline coeff_T, gate max|g|, and the tension
reject-multiple (how many x baseline tension before the REAL gate rejects). IN-PROC, no GPU, no ports.

Purpose: pitch 57 on Belarus MFeq is 284x under the CFL edge (gate correct). Find whether ANY pitch /
preset sits close enough to the edge that a SMALL, realistic tension increase crosses the gate — and
confirm the gate's reject-multiple tracks the empirical blowup everywhere (consistency). Also surfaces
whether some pitch is ALREADY at/over the edge (would mean the gate flags a normal preset = false-reject,
the opposite failure) or whether the worst case is a benign far-from-edge that explains "no block".

Run:
  cd PianoidCore && unset VIRTUAL_ENV && \
    ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-395e-cfl-allpitch-scan.py
"""
import os, sys, json, math
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(REPO, "PianoidBasic", "Pianoid"))
sys.path.insert(0, os.path.join(REPO, "PianoidBasic"))
sys.path.insert(0, os.path.join(REPO, "PianoidCore", "pianoid_middleware"))

import numpy as np
from StringMap import StringMap
from ModelParams import ModelParameters
from parameter_manager import ParameterManager, CflRejected
import cfl_stability as cfl

PRESETS = [
    "Belarus_8band_196modes-MFeq.json",
    "BaselinePreset1.json",
    "Preset_test5.json",
    "Belarus_8band_196modes.json",
]
PDIR = os.path.join(REPO, "PianoidCore", "pianoid_middleware", "presets")


def reject_multiple(pm, pitch, base_tension):
    """Smallest x (baseline tension multiple) at which the REAL gate rejects; None if never within 1e6x."""
    def rejects(m):
        try:
            pm._raise_if_cfl_unstable([pitch], {str(pitch): {"tension": base_tension * m}})
            return False
        except CflRejected:
            return True
    if not rejects(1e6):
        return None
    if rejects(1.0):
        return 1.0   # already over the edge at baseline (would be a FALSE-REJECT of a normal preset)
    lo, hi = 1.0, 1e6
    for _ in range(50):
        mid = math.sqrt(lo * hi)
        if rejects(mid):
            hi = mid
        else:
            lo = mid
    return math.sqrt(lo * hi)


for pname in PRESETS:
    ppath = os.path.join(PDIR, pname)
    if not os.path.exists(ppath):
        print(f"[skip] {pname} not found\n")
        continue
    with open(ppath) as f:
        save = json.load(f)
    mp = ModelParameters()
    mp.update_params(**save['model_parameters'])
    # silence the StringMap block-loading prints
    import io, contextlib
    with contextlib.redirect_stdout(io.StringIO()):
        sm = StringMap(mp, **save)
    pm = ParameterManager(pianoid=None, sm=sm, modes=None, mp=mp, cuda_lock=None)

    piano_pitches = sorted(pp for pp in sm.pitches if 21 <= pp <= 108)
    rows = []
    for pitch in piano_pitches:
        phys = sm.pitches[pitch].physics
        bt = float(phys.tension)
        if bt <= 0:
            continue
        # baseline gate ratio (worst string)
        (tension, r, rho, jung, dx, dt_, dec_curr, cfd, num_strings,
         toff) = pm._prospective_string_coeffs(pitch, {})
        T0, B0 = cfl._coeffs(tension, r, rho, jung, dx, dt_)
        g0 = -1.0
        for i in range(max(1, int(num_strings))):
            amp = cfl.max_amplification(*cfl._coeffs(tension * (1 + i * toff), r, rho, jung, dx, dt_),
                                        dec_curr, cfd)
            g0 = max(g0, amp)
        rm = reject_multiple(pm, pitch, bt)
        rows.append((pitch, bt, T0, B0, g0, rm))

    print(f"=== {pname}   (string_iteration={mp.string_iteration}, sr={mp.sample_rate()}) ===")
    # summary: the most-vulnerable pitch (smallest reject multiple), and any baseline |g|>1
    valid = [r for r in rows if r[5] is not None]
    over = [r for r in rows if r[4] > cfl.CFL_LIMIT + cfl.CFL_STABILITY_EPS]
    if valid:
        mv = min(valid, key=lambda r: r[5])
        print(f"  most-vulnerable pitch : {mv[0]}  baseline coeff_T={mv[2]:.5f}  baseline|g|={mv[4]:.5f}  "
              f"rejects at {mv[5]:.1f}x baseline tension")
    print(f"  pitches over edge at baseline (false-reject risk): "
          f"{[r[0] for r in over] if over else 'none'}")
    print(f"  coeff_T range (baseline): {min(r[2] for r in rows):.5f} .. {max(r[2] for r in rows):.5f}")
    print(f"  reject-multiple range   : "
          f"{min(r[5] for r in valid):.1f}x .. {max(r[5] for r in valid):.1f}x  (smaller = closer to edge)")
    # print the 6 most vulnerable pitches
    print(f"  {'pitch':>6}{'tension':>10}{'coeff_T':>10}{'base|g|':>9}{'reject@':>9}")
    for r in sorted(valid, key=lambda r: r[5])[:6]:
        print(f"  {r[0]:>6}{r[1]:>10.1f}{r[2]:>10.5f}{r[4]:>9.5f}{r[5]:>8.1f}x")
    print()
