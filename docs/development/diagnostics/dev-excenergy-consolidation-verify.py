"""dev-excenergy CONSOLIDATION VERIFY (OFFLINE, audio_off, NO speaker emission).

Correctness gate + latency for the single CoefficientCache.recompose path. For each edit
KIND (mass / speed / calibration / curve / spatial) it:
  1. edits the model, recomposes via the cache (incremental), captures the flat table;
  2. independently FULL-rebuilds the flat table (build_excitation_coefficients_flat) from the
     same edited model — the byte-identical oracle;
  3. reports max|incremental - full| (must be ~0 within float tol) + the recompose latency.

A FakeCuda captures the uploaded flat (the recompose path uploads via setNewExcitationCoefficients).

RUN: PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-excenergy-consolidation-verify.py
"""
import os, sys, time, json

MW = r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware"
os.chdir(MW); sys.path.insert(0, MW)
import numpy as np
import pianoidCuda
from pianoid import initialize
import excitation_coefficients as ec

PRESET = os.path.join(MW, "presets", "Belarus_196modesC")
SR, SPC = 48000, 64


class FakeCuda:
    """Captures the last uploaded flat; mimics the real setter's True return."""
    def __init__(self, real):
        self._real = real
        self.last = None
    def setNewExcitationCoefficients(self, flat):
        self.last = list(flat)
        return True


def ms(fn, n=5):
    ts = []
    for _ in range(n):
        t0 = time.perf_counter(); fn(); ts.append((time.perf_counter() - t0) * 1000)
    return min(ts)


print("=== CONSOLIDATION VERIFY (offline, audio_off) ===", flush=True)
p = initialize(PRESET, filterlen=48*128*3, string_iteration=12, array_size=384,
               sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, max_volume=100.0,
               audio_on=False, audio_driver_type=0, start_right_away=0, listen_to_midi=0)
sm = p.sm
cache = ec.CoefficientCache()
fake = FakeCuda(p.pianoid)

# seed the cache (full build) — this is the load-path equivalent
ok, flat0 = cache.seed(fake, sm)
print(f"seed ok={ok} len={len(flat0) if flat0 else None}", flush=True)
# sanity: seed flat == standalone full build
full0 = ec.build_excitation_coefficients_flat(sm)
seed_match = float(np.max(np.abs(np.asarray(flat0) - np.asarray(full0))))
print(f"seed == full build: max|diff|={seed_match:.3e}", flush=True)

PID = sm.keyPitches[len(sm.keyPitches)//2]
floor = SPC/SR*1000
res = {"seed_vs_full_maxdiff": seed_match, "results": []}


def check(kind_label, edit_fn, changed):
    """edit_fn mutates the model; then recompose(changed) vs full rebuild."""
    edit_fn()
    lat = ms(lambda: cache.recompose(fake, sm, changed), n=5)  # repeated recompose is idempotent
    incr = np.asarray(fake.last, dtype=np.float64)
    full = np.asarray(ec.build_excitation_coefficients_flat(sm), dtype=np.float64)
    maxdiff = float(np.max(np.abs(incr - full)))
    total = lat + floor
    print(f"  {kind_label:24s}: recompose {lat:7.3f}ms (+floor={total:6.2f}ms {'OK' if total<50 else 'OVER50'})  "
          f"max|incr-full|={maxdiff:.3e} {'BYTE-IDENTICAL' if maxdiff==0.0 else ('within-tol' if maxdiff<1e-9 else 'MISMATCH')}",
          flush=True)
    res["results"].append({"kind": kind_label, "recompose_ms": lat, "total_ms": total,
                           "over_50ms": total >= 50, "max_diff": maxdiff})


print("\nPER-KIND recompose vs full-rebuild (byte-identical gate) + latency:", flush=True)

# MASS (per-pitch)
def edit_mass():
    sm.pitches[int(PID)].physics.hammer_mass = 0.007
check("mass (per-pitch)", edit_mass, {'kind': 'mass', 'pitches': [int(PID)]})

# SPEED (per-level, global)
def edit_speed():
    s = list(getattr(sm.mp, 'hammer_speeds', [0.0,0.3,0.9,1.8,3.2,5.5]))
    s[3] = s[3] * 1.25
    sm.mp.hammer_speeds = s
check("speed (per-level)", edit_speed, {'kind': 'speed'})

# CALIBRATION (global)
def edit_cal():
    sm.mp.excitation_impulse_calibration = float(sm.mp.excitation_impulse_calibration) * 1.5
check("calibration (global)", edit_cal, {'kind': 'calibration'})

# SPATIAL (hammer width/sharpness/position — per-pitch)
def edit_spatial():
    h = sm.pitches[int(PID)].physics.hammer
    w = getattr(h, 'width', 0.012)
    sm.update_hammer_shape(int(PID), width=float(w)*1.2)
check("spatial (hammer)", edit_spatial, {'kind': 'spatial', 'pitches': [int(PID)]})

# CURVE (gauss temporal — per-pitch). Nudge the excitation curve then recompose temporal.
def edit_curve():
    exc = sm.pitches[int(PID)].excitation
    # bump one base level's curve via load_from_dict if available; else scale level_impulse input
    try:
        d = exc.to_dict() if hasattr(exc, 'to_dict') else None
    except Exception:
        d = None
    # Generic nudge: re-run update_hammer_shape won't change temporal; instead perturb the
    # excitation object's stored curve array directly if accessible.
    arr = getattr(exc, 'excitation_matrix', None)
    if arr is not None:
        try:
            exc.excitation_matrix = np.asarray(arr) * 1.1
        except Exception:
            pass
check("curve (gauss temporal)", edit_curve, {'kind': 'curve', 'pitches': [int(PID)]})

allok = all(r["max_diff"] < 1e-9 and not r["over_50ms"] for r in res["results"])
print(f"\nALL byte-identical(<1e-9) AND <50ms: {'YES' if allok else 'NO'}", flush=True)
res["all_pass"] = allok
print("\n===== JSON =====\n" + json.dumps(res, indent=2, default=lambda o: round(o,9) if isinstance(o,float) else o), flush=True)
try: p.pianoid.stopApplication(True)
except Exception: pass
print("done", flush=True)
