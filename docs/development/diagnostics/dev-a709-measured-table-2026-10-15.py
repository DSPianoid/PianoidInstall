"""dev-a709 2026-10-15: the measured-mode table (builder input) for F15_measured_plywood_2026-10-15.

Inputs (read-only): dev-fd69 prep.json (45 poles of 10-15, weights on), the live-validated core list (eval.json of the
two appropriation runs), q_decay.json (focused stop-and-decay), q-confidence q_classes.json, and this agent's
measured_residues.json (dev-a709-measured-modes-2026-10-15.py). Every rule below is a decision recorded in
docs/development/measured-plywood-preset-2026-10-15.md.

Selection  (< BOUNDARY_HZ):  the 24 live-validated core modes + every other mode with repeat MAC >= 0.9;
                             dropped: repeat MAC < 0.9, and 49.69 Hz (mains-adjacent, see EXCLUDE).
Damping    tight decay class (599/650/715/820/876/901 Hz) -> stop-and-decay zeta; otherwise PolyMAX zeta, capped
           by the decay zeta when one exists (decay = upper bound); 220.07 Hz -> PolyMAX 0.83 % (flagged).
Mass       1/m ~ sigma1 * u_max * v_max (residue per ampere, shape scaled to max 1 at the sampled points); the
           common power-law trend over the kept modes is the sensor chain (removed: a plate's modal mass is ~M/4
           at every frequency); per-mode residual clipped to +-MASS_CLIP_DB; mass_inv_rel = 10^(residual/20)
           (geometric mean 1 over the kept modes before clipping).
Channels   v_real (real-normal projection of v_current, max |.| = 1), order E1..E7.
Usage: python <this> <rig_checks dir> <measured_residues.json> <out measured_modes.json>
"""
import json
import os
import sys

import numpy as np

BOUNDARY_HZ = 1000.0
REPEAT_MIN = 0.9
MASS_CLIP_DB = 6.0
EXCLUDE = {49.69: "mains-adjacent (0.6 % below 50 Hz), cross-exciter MAC 0.12 = chance, mode vector -6.2 dB re the "
                  "optimum, not live-validated; earlier days: 53.2 Hz 'confirmed, weak', nothing at 49-50 Hz"}
ZETA_OVERRIDE = {220.07: ("polymax", "PolyMAX 0.83 % (runs 0.76/0.84, q-confidence 'tight') vs decay 1.93 % "
                                     "('beating' with 232 Hz, confidence 'poor'): PolyMAX kept, flagged")}


def load(rig, residues_path):
    prep = json.load(open(os.path.join(rig, "20261015T124849-appropriation", "prep.json")))
    core = [e["f"] for d in ("20261015T124849-appropriation", "20261015T135644-appropriation-extra7")
            for e in json.load(open(os.path.join(rig, d, "eval.json")))]
    qd = {e["f"]: e for e in json.load(open(os.path.join(rig, "20261015T142258-q-decay", "q_decay.json")))}
    qc = {e["f"]: e for e in json.load(open(os.path.join(rig, "q-confidence-20261015", "q_classes.json")))}
    res = {e["f"]: e for e in json.load(open(residues_path))["modes"]}
    return prep, core, qd, qc, res


def select(prep, core):
    kept, dropped = [], []
    for m in prep["modes"]:
        f = m["f"]
        if f >= BOUNDARY_HZ:
            dropped.append({"f": f, "reason": f">= {BOUNDARY_HZ:.0f} Hz boundary (FPGA modes kept there)"
                                              + (" - live-validated core mode" if f in core else "")})
        elif f in EXCLUDE:
            dropped.append({"f": f, "reason": EXCLUDE[f]})
        elif f in core:
            kept.append((m, "core (live-validated)"))
        elif m["repeat_mac"] >= REPEAT_MIN:
            kept.append((m, f"repeat MAC {m['repeat_mac']:.2f} >= {REPEAT_MIN}"))
        else:
            dropped.append({"f": f, "reason": f"repeat MAC {m['repeat_mac']:.2f} < {REPEAT_MIN}"})
    return kept, dropped


def zeta_of(m, qd, qc):
    """(zeta, source) per the damping rule."""
    f, z_pm = m["f"], m["zeta_pct"] / 100
    if f in ZETA_OVERRIDE:
        return z_pm, ZETA_OVERRIDE[f][1]
    d = qd.get(f)
    if d and d["confidence"] == "tight":
        return d["zeta_decay_pct"] / 100, "stop-and-decay (tight)"
    if d and d["zeta_decay_pct"] / 100 < z_pm:
        return d["zeta_decay_pct"] / 100, f"stop-and-decay (cap on PolyMAX {100 * z_pm:.2f} %)"
    return z_pm, "PolyMAX" + (" (decay higher: upper bound)" if d else "")


def masses(kept, res):
    """Relative 1/m per kept mode: trend-removed residue scale, clipped (returns rel, residual_db, clipped, exponent)."""
    f = np.array([m["f"] for m, _ in kept])
    q = np.array([res[m["f"]]["sigma1"] * res[m["f"]]["u_max"] * res[m["f"]]["v_max"] for m, _ in kept])
    b, a = np.polyfit(np.log(f), np.log(q), 1)
    r_db = 20 / np.log(10) * (np.log(q) - (a + b * np.log(f)))
    r_db -= r_db.mean()
    clipped = np.clip(r_db, -MASS_CLIP_DB, MASS_CLIP_DB)
    return 10 ** (clipped / 20), r_db, clipped, float(b)


def main(rig, residues_path, out_path):
    prep, core, qd, qc, res = load(rig, residues_path)
    kept, dropped = select(prep, core)
    rel, r_db, clipped, expo = masses(kept, res)
    modes = []
    for (m, why), mr, rd, cd in zip(kept, rel, r_db, clipped):
        z, zsrc = zeta_of(m, qd, qc)
        r = res[m["f"]]
        modes.append({"f_hz": m["f"], "zeta": round(z, 5), "zeta_source": zsrc, "mass_inv_rel": round(float(mr), 4),
                      "mass_residual_db": round(float(rd), 2), "mass_clipped": bool(abs(rd) > MASS_CLIP_DB),
                      "channels": r["v_real"], "real_projection_energy": round(r["v_real_energy"], 3),
                      "selection": why, "repeat_mac": m["repeat_mac"], "rank1": m["rank1"],
                      "cross_exciter_mac": m["cross_exciter_mac"], "src": m["src"]})
    out = {"source": {"rig_checks": rig, "prep": prep["runs"], "residues": residues_path},
           "boundary_hz": BOUNDARY_HZ, "channel_order": [f"E{k}" for k in range(1, 8)],
           "channel_convention": "real-normal projection of v_current (equal coil-current RMS), max |.| = 1",
           "mass_rule": {"estimator": "sigma1 * u_max * v_max (residues per ampere)", "trend_exponent": round(expo, 3),
                         "trend": "removed (sensor chain; plate modal mass ~ M/4, frequency-independent)",
                         "clip_db": MASS_CLIP_DB, "residual_sd_db": round(float(np.std(r_db)), 2)},
           "modes": modes, "dropped": dropped}
    json.dump(out, open(out_path, "w"), indent=1)
    print(f"kept {len(modes)}, dropped {len(dropped)}, trend exponent {expo:.2f}, residual sd {np.std(r_db):.1f} dB")
    for md in modes:
        print(f"{md['f_hz']:8.2f} z {100 * md['zeta']:.2f}% {md['zeta_source'][:22]:22s} m_rel {md['mass_inv_rel']:.2f} "
              f"({md['mass_residual_db']:+.1f} dB{' CLIP' if md['mass_clipped'] else ''}) {md['selection']}")
    for d in dropped:
        print(f"DROP {d['f']:8.2f} {d['reason'][:90]}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
