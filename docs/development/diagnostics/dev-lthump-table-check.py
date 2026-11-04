"""dev-lthump offline check: the per-(string, velocity) excitation-coefficient table built by the INSTALLED PianoidBasic
(before the change) vs a PianoidBasic with the thump level coefficients (after), on Tuning18-10-26ver1 + a thump
string, no GPU.

  1. level_coeff absent (a preset saved before the change): the whole table is bit-identical before/after.
  2. level_coeff = [0, 0.5, 1, 2, 4]: only the thump string's row differs; it equals the old row x the level
     coefficient at 5/31/63/95/127, linear between levels.

Usage (PianoidCore venv, from PianoidCore so pianoid_middleware resolves):
  python dev-lthump-table-check.py --after-site <dir with the new Pianoid package> [--presets <presets dir>]
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

import numpy as np

LEVEL_COEFF = [0.0, 0.5, 1.0, 2.0, 4.0]
VELOCITIES = (5, 31, 63, 95, 127)
NUM_LEVELS = 128


def build(preset_path, level_coeff, out_path):
    """Child process: build the flat table with whatever Pianoid package is first on sys.path."""
    sys.path.insert(0, os.path.join(os.getcwd(), "pianoid_middleware"))
    import excitation_coefficients as ec
    from Pianoid.ModelParams import ModelParameters
    from Pianoid.StringMap import StringMap
    from Pianoid.thump_string import add_thump_string

    with open(preset_path) as f:
        preset = add_thump_string(json.load(f))
    if level_coeff is not None:
        preset["model_parameters"]["thump"]["level_coeff"] = level_coeff
    mp = ModelParameters()
    mp.update_params(**preset["model_parameters"])
    sm = StringMap(mp, **preset)
    rows = [i for i, sid in enumerate(sm.string_index) if sm.strings[sid].pitch == 20]
    np.savez(out_path, flat=np.array(ec.build_excitation_coefficients_flat(sm)), thump_rows=np.array(rows))


def run(site, preset_path, level_coeff, out_path):
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    if site:
        env["PYTHONPATH"] = site
    args = [sys.executable, __file__, "--child", preset_path, out_path]
    if level_coeff is not None:
        args += ["--level-coeff", json.dumps(level_coeff)]
    subprocess.run(args, env=env, check=True)
    data = np.load(out_path)
    return data["flat"], list(data["thump_rows"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--after-site")
    ap.add_argument("--presets", default=os.path.join("pianoid_middleware", "presets"))
    ap.add_argument("--child", nargs=2)
    ap.add_argument("--level-coeff")
    a = ap.parse_args()
    if a.child:
        build(a.child[0], json.loads(a.level_coeff) if a.level_coeff else None, a.child[1])
        return 0
    preset = os.path.join(a.presets, "Tuning18-10-26ver1.json")
    tmp = tempfile.mkdtemp()
    before, rows = run(None, preset, None, os.path.join(tmp, "before.npz"))
    same, _ = run(a.after_site, preset, None, os.path.join(tmp, "same.npz"))
    after, rows_after = run(a.after_site, preset, LEVEL_COEFF, os.path.join(tmp, "after.npz"))
    assert rows == rows_after and len(rows) == 1
    n_rows = before.size // NUM_LEVELS
    b, s, x = (t.reshape(n_rows, NUM_LEVELS) for t in (before, same, after))
    print(f"strings: {n_rows}, thump row: {rows[0]}")
    print(f"1. no level_coeff: identical bits = {np.array_equal(b.view(np.uint64), s.view(np.uint64))}")
    moved = [i for i in range(n_rows) if not np.array_equal(b[i].view(np.uint64), x[i].view(np.uint64))]
    print(f"2. level_coeff {LEVEL_COEFF}: rows that differ = {moved}")
    for v, g in zip(VELOCITIES, LEVEL_COEFF):
        r = x[rows[0], v] / b[rows[0], v] if b[rows[0], v] else float("nan")
        print(f"   velocity {v:3d}: before {b[rows[0], v]:.6e} after {x[rows[0], v]:.6e} ratio {r:.12f} (coeff {g})")
    v = 79
    t = (v - 63) / 32
    print(f"   velocity 79: after {x[rows[0], v]:.6e} = linear between 63 and 95: "
          f"{np.isclose(x[rows[0], v], (1 - t) * x[rows[0], 63] + t * x[rows[0], 95], rtol=1e-12)}")
    ok = np.array_equal(b.view(np.uint64), s.view(np.uint64)) and moved == rows
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
