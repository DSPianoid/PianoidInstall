"""dev-excenergy — TEST-FIRST gate for the Wave 3 middleware flat-builder
build_excitation_coefficients_flat (B2 D9).

Verifies the per-(string, velocity) coefficient TABLE the engine setter
(setNewExcitationCoefficients) expects: num_strings * NUM_LEVELS reals, row-major
in sm.string_index order (= the kernel's noString order), each string inheriting
its pitch's 6-base-level coeffs interpolated 6 -> 128 with the SAME extrapolate()
the excitation curves use. Output/sound strings (pitch >= 128, not a keyPitch) get
1.0 at every level.

A full StringMap needs a complete preset through the engine loader (too heavy for a
unit gate), so we bind the REAL StringMap.pack_excitation_coefficients +
hammer_spatial_impulse to a lightweight stand-in (exactly like the Wave 1 gate),
add the string_index / strings mapping the flat-builder reads, and run the REAL
excitation_coefficients.build_excitation_coefficients_flat against it.

Run:
    cd PianoidCore && .venv/Scripts/python.exe \
      ../docs/development/diagnostics/dev-excenergy-wave3-flat-test.py
"""
import sys, os, types
import numpy as np

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "PianoidBasic", "Pianoid"))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "PianoidCore", "pianoid_middleware"))

from StringMap import StringMap                          # noqa: E402
from StringExcitation import (LEVEL_INDICES, NUM_LEVELS, # noqa: E402
                              extrapolate, compose_excitation_coefficient)
from constants import (hammer_speed_for_level,           # noqa: E402
                       DEFAULT_HAMMER_SPEEDS)
from excitation_coefficients import build_excitation_coefficients_flat  # noqa: E402

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
    def __init__(self, base):
        self.base = base
    def level_impulse(self, velocity):
        return self.base * (1.0 + LEVEL_INDICES.index(velocity))


class FakePitch:
    def __init__(self, mass, shape, base, outer=False):
        self.outerSound = outer
        self.physics = FakePhysics(mass, shape)
        self.excitation = FakeExcitation(base)


class FakeString:
    def __init__(self, pitch):
        self.pitch = pitch


class FakeMP:
    def __init__(self, speeds, calib):
        self.hammer_speeds = speeds
        self.excitation_impulse_calibration = calib


# --- build the stand-in ----------------------------------------------------
C = 2.5
speeds = list(DEFAULT_HAMMER_SPEEDS)
mp = FakeMP(speeds, C)
p60_shape = [0, 0, 0.2, 0.5, 0.3, 0, 0, 0]
p21_shape = [0.1, 0.4, 0.7, 0.4, 0.1, 0, 0, 0]
pitches = {
    60: FakePitch(0.0084, p60_shape, 4.0),
    21: FakePitch(0.012, p21_shape, 7.0),
    130: FakePitch(0.010, [0, 0, 0, 0], 1.0, outer=True),  # OUTPUT pitch
}

# Two strings per key pitch + one output string, in an interleaved string_index
# order to prove the builder follows string_index (NOT pitch order):
#   stringID 0 -> pitch 21, 1 -> pitch 60, 2 -> pitch 21, 3 -> pitch 60, 4 -> pitch 130
strings = {0: FakeString(21), 1: FakeString(60), 2: FakeString(21),
           3: FakeString(60), 4: FakeString(130)}
string_index = [0, 1, 2, 3, 4]

sm = types.SimpleNamespace()
sm.mp = mp
sm.pitches = pitches
sm.keyPitches = [60, 21]
sm.strings = strings
sm.string_index = string_index
sm.hammer_spatial_impulse = types.MethodType(StringMap.hammer_spatial_impulse, sm)
sm.pack_excitation_coefficients = types.MethodType(StringMap.pack_excitation_coefficients, sm)

# --- run the REAL flat-builder ---------------------------------------------
flat = build_excitation_coefficients_flat(sm)

check("returns a flat list (not None)", isinstance(flat, list))
check("length == num_strings * NUM_LEVELS",
      flat is not None and len(flat) == len(string_index) * NUM_LEVELS)

# expected per-pitch 128-row from the 6 base coeffs via extrapolate
table = sm.pack_excitation_coefficients()
full_by_pitch = {}
for pid, base6 in table.items():
    full_by_pitch[pid] = extrapolate(np.asarray(base6, dtype=np.float64),
                                     newdim=NUM_LEVELS, indices=list(LEVEL_INDICES)[1:-1])

def row(stringIdx):
    off = stringIdx * NUM_LEVELS
    return flat[off:off + NUM_LEVELS]

# string_index order: strings 0,2 -> pitch 21 ; 1,3 -> pitch 60 ; 4 -> output
ok_order = True
for sidx, pid in [(0, 21), (1, 60), (2, 21), (3, 60)]:
    exp = full_by_pitch[pid]
    got = row(sidx)
    if not np.allclose(got, exp, rtol=1e-9, atol=1e-12):
        ok_order = False
check("each string's 128-row == its PITCH's 6->128 interpolated coeffs (string_index order)", ok_order)

check("output string (pitch 130, not keyPitch) row is all 1.0 (loudness-inert)",
      np.allclose(row(4), [1.0] * NUM_LEVELS))

# anchor exactness: at the 6 base level indices the 128-row equals the base coeffs
ok_anchor = True
for j, level in enumerate(LEVEL_INDICES):
    if abs(row(1)[level] - table[60][j]) > 1e-9 * max(1.0, abs(table[60][j])):
        ok_anchor = False
check("base-level anchors preserved exactly in the 6->128 interpolation (pitch 60)", ok_anchor)

# silence anchor: level 0 (v=0) coefficient == 0
check("velocity 0 (silence) coefficient == 0 at the played-velocity grid", row(1)[0] == 0.0)
# monotone-ish dynamics: fff (127) louder than p (31) on the interpolated grid
check("fff (vel 127) coeff > p (vel 31) on the 128 grid (pitch 60)",
      row(1)[127] > row(1)[31])

# size-mismatch guard: a pitch whose pack row is the wrong length -> None
class BadPack:
    def pack_excitation_coefficients(self):
        return {60: [1.0, 2.0]}  # wrong length (not 6)
bad = types.SimpleNamespace()
bad.pack_excitation_coefficients = types.MethodType(BadPack.pack_excitation_coefficients, bad)
bad.strings = strings
bad.string_index = string_index
check("wrong-length base row -> None (caller falls back to 1.0)",
      build_excitation_coefficients_flat(bad) is None)

print()
if FAILS:
    print("GATE FAILED:", FAILS); sys.exit(1)
print("GATE PASSED — build_excitation_coefficients_flat matches the D9 flat contract"); sys.exit(0)
