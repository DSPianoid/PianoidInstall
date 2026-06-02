"""dev-asioload — capture the measured ASIO->SDL3 fallback values + the
middleware /health fallback dict, in one isolated process (no Flask server).

Confirms, on the current no-ASIO machine:
  1. Engine getters after an ASIO_CALLBACK request + startAudioDriver():
     didAudioDriverFallback / getRequestedDriverType / getActiveDriverType /
     getAudioDriverFallbackReason.
  2. The middleware helper _audio_driver_fallback_status() returns the JSON
     dict the /health endpoint + WS lifecycle event will carry (occurred /
     requested / active / reason / message).

Run:
    cd PianoidCore/pianoid_middleware
    ../.venv/Scripts/python.exe ../../docs/development/diagnostics/dev-asioload-fallback-capture.py
"""
import os
import sys
import json

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
MIDDLEWARE = os.path.join(REPO_ROOT, "PianoidCore", "pianoid_middleware")
if MIDDLEWARE not in sys.path:
    sys.path.insert(0, MIDDLEWARE)
os.chdir(MIDDLEWARE)

import pianoidCuda  # noqa: E402
from pianoid import initialize  # noqa: E402

PRESET = os.path.join("presets", "BaselinePreset1.json")

# REST audio_driver_type=4 == ASIO_CALLBACK (Python pack convention).
pw = initialize(
    PRESET, filterlen=48 * 128 * 3, string_iteration=4, array_size=384,
    sample_rate=48, samples_in_cycle=64, buffer_size=8, max_volume=5e18,
    audio_on=False, audio_driver_type=4, listen_to_modes=True,
)
cpp = pw.pianoid

print("\n>>> startAudioDriver() with ASIO_CALLBACK requested (no ASIO driver installed):")
sys.stdout.flush()
cpp.startAudioDriver()

print("\n=== ENGINE GETTERS (C++ enum: SDL2=0,SDL3=1,ASIO=2,ASIO_CALLBACK=3) ===")
print(f"isAudioDriverActive()        = {cpp.isAudioDriverActive()}")
print(f"didAudioDriverFallback()     = {cpp.didAudioDriverFallback()}")
print(f"getRequestedDriverType()     = {cpp.getRequestedDriverType()}  (3=ASIO_CALLBACK)")
print(f"getActiveDriverType()        = {cpp.getActiveDriverType()}  (1=SDL3)")
print(f"getAudioDriverFallbackReason = {cpp.getAudioDriverFallbackReason()!r}")

# Now exercise the middleware helper exactly as /health + WS will.
import backendserver as bs  # the module is backendServer.py (case-insensitive on win)
bs.pianoid = pw
status = bs._audio_driver_fallback_status()
print("\n=== MIDDLEWARE _audio_driver_fallback_status() (the /health + WS dict) ===")
print(json.dumps(status, indent=2))

# Cleanup
try:
    if cpp.isAudioDriverActive():
        cpp.stopAudioDriver()
    cpp.shutdownGpu()
    print("\nGPU engine shut down cleanly.")
except Exception as e:
    print(f"shutdown note: {e}")
