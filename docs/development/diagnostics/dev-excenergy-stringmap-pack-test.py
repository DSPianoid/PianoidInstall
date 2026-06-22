"""dev-excenergy — TEST-FIRST gate for StringMap.pack_excitation_coefficients +
hammer_spatial_impulse (B2 Wave 1, D9).

PianoidBasic has no pytest tree (bare imports resolve only from inside Pianoid/),
so this is the runnable test-first gate, executed via:
    cd PianoidBasic/Pianoid && \
      ../../PianoidCore/.venv/Scripts/python.exe \
      ../../docs/development/diagnostics/dev-excenergy-stringmap-pack-test.py

A full StringMap needs a complete preset (blocks/strings/pitches) through the
engine's loader — too heavy for a unit gate. We instead bind the real methods to a
lightweight stand-in carrying only the fields the pack reads (mp.hammer_speeds,
mp.excitation_impulse_calibration, keyPitches, pitches[*].physics.hammer_mass /
.get_hammer() / .outerSound, pitches[*].excitation.level_impulse). This exercises
the EXACT pack logic (the bound methods are StringMap's own) against the contract:

    coefficient[pitch][level] = c * m(pitch) * v(level)
                                  * temporalIntegral(curve[pitch][level])
                                  * hammerSpatial(pitch)

per the 6 BASE levels (LEVEL_INDICES), per key pitch; pure product; per-pitch mass,
per-level speed; spatial = sparse |sum| of the hammer shape (1.0 fallback if zero).
"""
import sys, os, types
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "PianoidBasic", "Pianoid"))

from StringMap import StringMap                       # noqa: E402
from StringExcitation import (LEVEL_INDICES,          # noqa: E402
                              compose_excitation_coefficient)
from constants import (hammer_speed_for_level,        # noqa: E402
                       DEFAULT_HAMMER_SPEEDS)

FAILS = []
def check(name, cond):
    print(("PASS" if cond else "FAIL"), name)
    if not cond:
        FAILS.append(name)


class FakePhysics:
    def __init__(self, hammer_mass, hammer_shape):
        self.hammer_mass = hammer_mass
        self._shape = np.asarray(hammer_shape, dtype=np.float64)
    def get_hammer(self):
        return self._shape


class FakeExcitation:
    """level_impulse returns a deterministic per-(pitch,level) temporal value."""
    def __init__(self, base):
        self.base = base
    def level_impulse(self, velocity):
        # distinct per level so a wrong-level pull would be caught
        return self.base * (1.0 + LEVEL_INDICES.index(velocity))


class FakePitch:
    def __init__(self, mass, shape, base, outer=False):
        self.outerSound = outer
        self.physics = FakePhysics(mass, shape)
        self.excitation = FakeExcitation(base)


class FakeMP:
    def __init__(self, speeds, calib):
        self.hammer_speeds = speeds
        self.excitation_impulse_calibration = calib


# --- build the stand-in ----------------------------------------------------
C = 2.5
speeds = list(DEFAULT_HAMMER_SPEEDS)
mp = FakeMP(speeds, C)
# pitch 60: mass 8.4g, SPARSE hammer shape (3 nonzero of 8), temporal base 4.0
# pitch 21: mass 12g,  denser shape, temporal base 7.0
# pitch 130: OUTPUT pitch (no hammer) -> must be EXCLUDED (keyPitches only)
p60_shape = [0, 0, 0.2, 0.5, 0.3, 0, 0, 0]
p21_shape = [0.1, 0.4, 0.7, 0.4, 0.1, 0, 0, 0]
pitches = {
    60: FakePitch(0.0084, p60_shape, 4.0),
    21: FakePitch(0.012, p21_shape, 7.0),
    130: FakePitch(0.010, [0, 0, 0, 0], 1.0, outer=True),
}

sm = types.SimpleNamespace()
sm.mp = mp
sm.pitches = pitches
sm.keyPitches = [60, 21]            # 130 is an output pitch, not a key pitch
# bind the REAL StringMap methods to the stand-in
sm.hammer_spatial_impulse = types.MethodType(StringMap.hammer_spatial_impulse, sm)
sm.pack_excitation_coefficients = types.MethodType(StringMap.pack_excitation_coefficients, sm)

# --- hammer_spatial_impulse ------------------------------------------------
si60 = sm.hammer_spatial_impulse(60)
check("spatial impulse = sum of (sparse) hammer shape", abs(si60 - 1.0) <= 1e-12)  # 0.2+0.5+0.3
check("spatial impulse counts only nonzero nodes (sparse)", abs(si60 - sum(p60_shape)) <= 1e-12)
check("output pitch (no hammer) -> spatial 1.0 (inert)", sm.hammer_spatial_impulse(130) == 1.0)
# zero shape -> 1.0 fallback (product must not collapse)
sm.pitches[99] = FakePitch(0.010, [0, 0, 0, 0], 1.0)
check("all-zero shape -> 1.0 fallback (no collapse)", sm.hammer_spatial_impulse(99) == 1.0)
del sm.pitches[99]

# --- pack_excitation_coefficients ------------------------------------------
table = sm.pack_excitation_coefficients()
check("table keyed by keyPitches only (output pitch excluded)", set(table.keys()) == {60, 21})
check("row has one coeff per base level (6)", len(table[60]) == len(LEVEL_INDICES) and len(table[21]) == 6)

# exact product cross-check, pitch 60, every level
ok_product = True
si = sum(p60_shape)
for j, level in enumerate(LEVEL_INDICES):
    v = hammer_speed_for_level(level, LEVEL_INDICES, speeds)
    tI = pitches[60].excitation.level_impulse(level)
    expected = compose_excitation_coefficient(C, 0.0084, v, tI, si)
    if abs(table[60][j] - expected) > 1e-9 * max(1.0, abs(expected)):
        ok_product = False
check("coeff == c*m*v*tImpulse*sImpulse for every base level (pitch 60)", ok_product)

# level 0 (speed 0) -> coefficient 0; level 127 (max speed) > level 31
check("silence level (v=0) -> coefficient 0", table[60][0] == 0.0)
check("fff (level 127) coeff > p (level 31)", table[60][LEVEL_INDICES.index(127)] > table[60][LEVEL_INDICES.index(31)])

# per-pitch mass: pitch 21 (12g) vs pitch 60 (8.4g) at the same level, same-ish temporal?
# masses differ AND temporals differ, so compare the mass factor in isolation:
v63 = hammer_speed_for_level(63, LEVEL_INDICES, speeds)
c60 = compose_excitation_coefficient(C, 0.0084, v63, pitches[60].excitation.level_impulse(63), sum(p60_shape))
c21 = compose_excitation_coefficient(C, 0.012, v63, pitches[21].excitation.level_impulse(63), sum(p21_shape))
check("pack reflects per-pitch mass + per-pitch spatial (pitch21 row matches recompose)",
      abs(table[21][LEVEL_INDICES.index(63)] - c21) <= 1e-9 * abs(c21) and
      abs(table[60][LEVEL_INDICES.index(63)] - c60) <= 1e-9 * abs(c60))

print()
if FAILS:
    print("GATE FAILED:", FAILS); sys.exit(1)
print("GATE PASSED — pack_excitation_coefficients + hammer_spatial_impulse match D9"); sys.exit(0)
