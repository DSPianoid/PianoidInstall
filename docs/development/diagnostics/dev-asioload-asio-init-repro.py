"""dev-asioload — ASIO load-failure reproduction (ISOLATED, no Flask, no port 5000).

Confirms the root cause measured passively (empty HKLM\\SOFTWARE\\ASIO registry):
when audio_driver_type=4 (ASIO_CALLBACK) is requested with no ASIO driver
installed, the engine's ASIO init fails at *enumeration* and throws.

This is SAFE to run while the user's SDL3 stack is live: with zero ASIO drivers
registered, InitAsioDriver() returns false at getDriverNames() (enumeration)
BEFORE any device is opened — it never touches the GIGAPORT eX hardware, so the
user's running SDL3 backend and the audio device are untouched.

Steps:
  1. Print getBestAvailableDriver() + isDriverAvailable(ASIO) (compile-time facts).
  2. Confirm pack_initialization_params_for_cuda(4) maps to ASIO_CALLBACK enum.
  3. initialize(..., audio_on=False, audio_driver_type=4) — constructs the ASIO
     driver object (no device touch yet) and verifies the engine reaches a clean
     GPU-initialized state.
  4. Call pianoid.startAudioDriver() directly — THIS is where audioDriver->init()
     runs the ASIO SDK enumeration. Capture the thrown exception / printed
     "No working ASIO driver found" signature.

Run:
    cd PianoidCore/pianoid_middleware
    ../.venv/Scripts/python.exe ../../docs/development/diagnostics/dev-asioload-asio-init-repro.py
"""
import os
import sys
import traceback

# Force UTF-8 stdout/stderr so the Windows cp1252 console can't choke on
# em-dashes etc. in our diagnostic prints (the redirected file is UTF-8).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# We run with CWD = pianoid_middleware (preset paths are relative there).
HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
MIDDLEWARE = os.path.join(REPO_ROOT, "PianoidCore", "pianoid_middleware")
if MIDDLEWARE not in sys.path:
    sys.path.insert(0, MIDDLEWARE)
os.chdir(MIDDLEWARE)

import pianoidCuda  # noqa: E402

print("=" * 70)
print("STEP 1: compile-time driver availability")
print("=" * 70)
print(f"getBestAvailableDriver() = {pianoidCuda.getBestAvailableDriver()!r}")
print(f"isDriverAvailable(ASIO)          = {pianoidCuda.isDriverAvailable(pianoidCuda.AudioDriverType.ASIO)}")
print(f"isDriverAvailable(ASIO_CALLBACK) = {pianoidCuda.isDriverAvailable(pianoidCuda.AudioDriverType.ASIO_CALLBACK)}")
print(f"isDriverAvailable(SDL3)          = {pianoidCuda.isDriverAvailable(pianoidCuda.AudioDriverType.SDL3)}")
print("(These are COMPILE-TIME flags — 'available' = compiled in, NOT 'device loads'.)")

from pianoid import initialize  # noqa: E402

# Use a small preset; default BaselinePreset1.json.
PRESET = os.path.join("presets", "BaselinePreset1.json")

print()
print("=" * 70)
print("STEP 2 + 3: initialize(audio_driver_type=4, audio_on=False)")
print("=" * 70)
pw = initialize(
    PRESET,
    filterlen=48 * 128 * 3,
    string_iteration=4,
    array_size=384,
    sample_rate=48,
    samples_in_cycle=64,
    buffer_size=8,
    max_volume=5e18,
    audio_on=False,            # do NOT auto-start playback thread
    audio_driver_type=4,       # ASIO_CALLBACK
    listen_to_modes=True,
)

ip = pw.pack_initialization_params_for_cuda(audio_driver_type=4, max_volume=5e18)
print(f"pack_initialization_params_for_cuda(4).audio_driver_type = "
      f"{ip.audio_driver_type!r} (int={int(ip.audio_driver_type)})")
print(f"  expected ASIO_CALLBACK int = {int(pianoidCuda.AudioDriverType.ASIO_CALLBACK)}")
print(f"  circular_buffer_chunks = {ip.circular_buffer_chunks} (ASIO path -> 8)")
print(f"engine GPU initialized = {pw.pianoid.isGpuInitialized()}")
print("(Driver OBJECT constructed as ASIO_CALLBACK; device not opened yet.)")

print()
print("=" * 70)
print("STEP 4: startAudioDriver() — triggers audioDriver->init() (ASIO SDK)")
print("=" * 70)
print(">>> Calling pianoid.startAudioDriver() — watch for ASIO enumeration output:")
sys.stdout.flush()
result = "UNKNOWN"
try:
    pw.pianoid.startAudioDriver()
    # If we got here, ASIO actually started (would mean a driver IS installed).
    result = "ASIO_STARTED_OK"
    print("\n<<< startAudioDriver() returned WITHOUT throwing — ASIO loaded a driver.")
except Exception as e:
    result = f"THREW: {type(e).__name__}: {e}"
    print(f"\n<<< startAudioDriver() THREW: {type(e).__name__}: {e}")
    traceback.print_exc()

print()
print("=" * 70)
print(f"RESULT: {result}")
print("=" * 70)

# Clean up the GPU engine we spun up.
try:
    pw.pianoid.shutdownGpu()
    print("GPU engine shut down cleanly.")
except Exception as e:
    print(f"shutdownGpu note: {e}")
