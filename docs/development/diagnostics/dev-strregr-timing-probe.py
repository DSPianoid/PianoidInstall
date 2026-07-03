"""dev-strregr — time a granular tension edit + check whether it changes the
excitation-coefficient table. Confirms: (a) how long update_parameter('string',
tension) takes (the full seed() rebuild suspicion), (b) that the coefficient flat
table is UNCHANGED by a tension edit (so the rebuild is a no-op waste)."""
import os, sys, time
import numpy as np

MW = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..",
                                  "PianoidCore", "pianoid_middleware"))
sys.path.insert(0, MW)
os.chdir(MW)
from pianoid import initialize

PRESET = sys.argv[1] if len(sys.argv) > 1 else "Preset_test5.json"
PITCH = int(sys.argv[2]) if len(sys.argv) > 2 else 60

p = initialize(os.path.join(MW, "presets", PRESET),
               filterlen=48*128*3, string_iteration=4, array_size=384,
               sample_rate=48000, samples_in_cycle=64, buffer_size=4,
               max_volume=5e18, audio_on=False, audio_driver_type=0)

pm = p.param_manager
base_t = float(p.sm.pitches[PITCH].physics.tension)
print(f"=== timing probe preset={PRESET} pitch={PITCH} base_tension={base_t:.6g} ===")

def coeff_snapshot():
    cache = getattr(pm, '_coeff_cache', None)
    if cache is None or getattr(cache, 'flat', None) is None:
        return None
    return np.array(cache.flat, dtype=np.float64)

# warm up (first edit seeds cache)
p.update_parameter("string", {str(PITCH): {"tension": base_t}}, pitches=[PITCH])
c0 = coeff_snapshot()

times = []
for i, fct in enumerate([0.9, 0.8, 0.7, 0.6, 0.5, 1.2, 1.4]):
    t = base_t * fct
    t0 = time.perf_counter()
    p.update_parameter("string", {str(PITCH): {"tension": t}}, pitches=[PITCH])
    dt = (time.perf_counter() - t0) * 1000.0
    times.append(dt)
    c1 = coeff_snapshot()
    if c0 is not None and c1 is not None:
        maxdiff = float(np.max(np.abs(c1 - c0)))
        nchanged = int(np.sum(c1 != c0))
    else:
        maxdiff, nchanged = -1, -1
    print(f"  tension x{fct:<4} = {t:>10.5g}   edit_time={dt:7.1f} ms   "
          f"coeff_maxdiff={maxdiff:.3e}  coeff_cells_changed={nchanged}")

print(f"\n  edit_time: min={min(times):.1f} max={max(times):.1f} "
      f"mean={sum(times)/len(times):.1f} ms  (N={len(times)})")
print("  INTERPRETATION: if coeff_cells_changed==0 for tension edits, the full "
      "excitation-coefficient rebuild fired by the granular path is a NO-OP waste.")

# For contrast: time a bulk excitation setter alone vs the incremental path
try:
    t0 = time.perf_counter()
    pm._upload_excitation_coefficients()   # the full seed() the granular path calls
    dt_seed = (time.perf_counter() - t0) * 1000.0
    print(f"  standalone _upload_excitation_coefficients() [full seed] = {dt_seed:.1f} ms")
except Exception as e:
    print(f"  seed timing failed: {e}")

try:
    p.pianoid.shutdownGpu()
except Exception:
    pass
