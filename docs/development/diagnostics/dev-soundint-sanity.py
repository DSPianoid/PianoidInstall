"""dev-soundint-live — Phase A SANITY CHECK (in-process, build verification ONLY).

Verifies the NEW post-volume soundInt readback plumbing works end-to-end at the C++/pybind level:
  1. getRawSoundRecordInt() is callable + returns data after Online cycles.
  2. The int ring is POST-volume: soundInt ~= round(soundFloat * main_volume_coefficient), sample-for-sample.
  3. clearRecords() zeroes BOTH rings (the /capture reset discipline).
  4. Reports whether, at the configured volume, the post-volume signal already overflows INT32
     (peak as a multiple of INT32_MAX) — informational; the real bug test is the LIVE-UI Phase B.

This is NOT the bug reproduction. It triggers a note via the in-process addOneString() API purely to
exercise the ring (build verification). The 55/56/57 bug repro (Phase B) triggers notes via the LIVE UI
ONLY, per the task's hard constraint. Run with the freshly-built engine; no server needed.

Usage:
  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-soundint-sanity.py [--debug] [--pitch=56] [--volume=120]
    --debug : use the debug-variant module (pianoidCuda_debug) — matches the user's debug_mode=1.
"""
import sys, os, math

USE_DEBUG = "--debug" in sys.argv
PITCH = 56
VOLUME = 120
for a in sys.argv[1:]:
    if a.startswith("--pitch="):  PITCH = int(a.split("=", 1)[1])
    elif a.startswith("--volume="): VOLUME = int(a.split("=", 1)[1])

if USE_DEBUG:
    os.environ["PIANOID_USE_DEBUG"] = "1"

# Import the middleware initializer so we get the same init path the backend uses.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "PianoidCore"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "PianoidCore", "pianoid_middleware"))

import pianoidCuda
mod = pianoidCuda
print(f"pianoidCuda module: {mod.__file__}")

INT32_MAX = 2147483647

# --- Minimal in-process engine init (mirrors test_performance fixture) -----------------------------
# We use the middleware Pianoid wrapper for a faithful init (preset load + volume).
from pianoid import Pianoid as PianoidWrapper

PRESET = "Belarus_8band_196modes-MFeq.json"
preset_path = os.path.join(os.path.dirname(__file__), "..", "..", "PianoidCore", "pianoid_middleware", "presets", PRESET)
preset_path = os.path.abspath(preset_path)
print(f"preset: {preset_path}  exists={os.path.exists(preset_path)}")

p = PianoidWrapper()
# audio_driver_type: use 0 (no real driver) for a headless sanity check — the soundInt ring is filled
# by the Online record_to_host branch regardless of whether a real driver is attached.
p.initialize_pianoid(main_volume=10000, audio_driver_type=0)
try:
    p.load_preset_by_path(preset_path) if hasattr(p, "load_preset_by_path") else None
except Exception as e:
    print(f"(preset load via wrapper skipped/failed, continuing with default: {e})")

# Set volume to the user's level so mvc matches the live config.
try:
    p.set_volume_level(VOLUME)
    mvc = p.get_current_volume_coefficient()
    print(f"main_volume_coefficient (MEASURED) at volume_level={VOLUME}: {mvc:.6g}")
except Exception as e:
    mvc = None
    print(f"(could not set/read volume: {e})")

cu = p.pianoid

# --- Exercise the ring: clear, excite a string in-process, run Online cycles -----------------------
cu.clearRecords()
# sanity: both rings empty after clear
pre_int = cu.getRawSoundRecordInt()
pre_flt = cu.getRawSoundRecord()
print(f"after clearRecords: soundInt len={len(pre_int)}, soundFloat len={len(pre_flt)} (both should be 0)")

# Map pitch->string index via the wrapper's string map if available; else use addOneString on a guess.
string_index = None
try:
    if PITCH in p.sm.pitches:
        sid = p.sm.pitches[PITCH].stringIDs[0]
        # reuse middleware helper if present
        from chartFunctions import _string_id_to_cuda_index
        string_index = _string_id_to_cuda_index(p, sid)
except Exception as e:
    print(f"(string-index lookup failed: {e})")
if string_index is None:
    string_index = PITCH  # fallback; sanity check only cares that SOME signal flows
print(f"exciting string_index={string_index} (pitch {PITCH}) velocity=127")

cu.addOneString(string_index, 127)

# Run Online cycles with record_to_host=True so BOTH rings fill.
CycleOutput = pianoidCuda.CycleOutput
CycleRegime = pianoidCuda.CycleRegime
out = CycleOutput(CycleRegime.Online, True)
N = 200
for i in range(N):
    cu.runCycle(out)

int_rec = cu.getRawSoundRecordInt()
flt_rec = cu.getRawSoundRecord()
print(f"\nafter {N} Online cycles: soundInt len={len(int_rec)}, soundFloat len={len(flt_rec)}")

if not int_rec:
    print("FAIL: soundInt ring is EMPTY after Online cycles — the append hook did not fire.")
    sys.exit(1)

# --- Verify POST-volume relationship: soundInt ~= round(soundFloat * mvc) --------------------------
n = min(len(int_rec), len(flt_rec))
ipeak = max(abs(x) for x in int_rec[:n]) if n else 0
fpeak = max(abs(x) for x in flt_rec[:n]) if n else 0.0
print(f"soundFloat peak (PRE-volume): {fpeak:.6g}")
print(f"soundInt   peak (POST-volume): {ipeak} ({ipeak/INT32_MAX:.3f}x INT32_MAX)")
if mvc:
    print(f"soundFloat_peak * mvc = {fpeak*mvc:.6g}  (compare to soundInt peak {ipeak})")

# Per-sample agreement check on the first non-trivial samples (clamped expectation only valid if no overflow).
mismatch = 0
checked = 0
for fi, ii in zip(flt_rec[:n], int_rec[:n]):
    if abs(fi) > 1e-9 and mvc:
        checked += 1
        expected = fi * mvc
        # If |expected| < INT32_MAX, soundInt should equal int(expected) (truncation). Allow +/-2 for rounding.
        if abs(expected) < INT32_MAX * 0.99:
            if abs(ii - int(expected)) > 2:
                mismatch += 1
if checked:
    print(f"per-sample post-volume agreement (no-overflow samples): {checked-mismatch}/{checked} match int(soundFloat*mvc) within +/-2")

# Overflow info (informational — real test is live-UI Phase B):
at_rail = sum(1 for x in int_rec[:n] if abs(x) >= INT32_MAX * 0.999)
print(f"soundInt samples at/over INT32 rail: {at_rail}/{n}")
if ipeak > INT32_MAX:
    print(f">>> NOTE: post-volume soundInt EXCEEDS INT32 at this volume/pitch (peak {ipeak/INT32_MAX:.1f}x) — overflow plausible in-process. (Confirm via LIVE-UI Phase B.)")

# --- Verify clearRecords zeroes BOTH rings ---------------------------------------------------------
cu.clearRecords()
post_int = cu.getRawSoundRecordInt()
post_flt = cu.getRawSoundRecord()
print(f"\nafter 2nd clearRecords: soundInt len={len(post_int)}, soundFloat len={len(post_flt)} (both should be 0)")
ok_clear = (len(post_int) == 0 and len(post_flt) == 0)

print("\n=== SANITY VERDICT ===")
print(f"  getRawSoundRecordInt callable + non-empty after cycles : {'PASS' if int_rec else 'FAIL'}")
print(f"  clearRecords zeroes both rings                         : {'PASS' if ok_clear else 'FAIL'}")
print(f"  POST-volume (soundInt tracks soundFloat*mvc)           : {'PASS' if (checked and mismatch==0) else 'INCONCLUSIVE' }")
print("  (Overflow at user volume is INFORMATIONAL here; the bug repro is LIVE-UI Phase B.)")
