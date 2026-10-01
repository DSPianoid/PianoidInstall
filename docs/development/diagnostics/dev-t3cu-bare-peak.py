"""dev-t3cu audio-present harness — offline (audio_off, driver_type=0) bare-peak render.

Fresh-process render; NEVER runs against the live ASIO backend (that page-faults —
memory project_no_offline_render_in_live_backend). Stop the live backend BEFORE
running this. Prints a single machine-readable line: BARE_PEAK=<float>.

Usage:  <venv-python> dev-t3cu-bare-peak.py [preset_name]
"""
import os, sys

HERE = os.path.abspath(__file__)  # .../docs/development/diagnostics/x.py
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(HERE))))  # repo root
CORE = os.environ.get("PIANOID_CORE_DIR") or os.path.join(REPO, "PianoidCore")
MID = os.path.join(CORE, "pianoid_middleware")
sys.path.insert(0, CORE)
sys.path.insert(0, MID)
os.chdir(MID)

preset = sys.argv[1] if len(sys.argv) > 1 else "Preset_test5.json"
preset_path = os.path.join(MID, "presets", preset)

from pianoid import initialize

p = initialize(
    preset_path,
    filterlen=48 * 128 * 3,
    string_iteration=4,
    array_size=384,
    sample_rate=48000,
    samples_in_cycle=64,
    buffer_size=4,
    max_volume=5e18,
    audio_on=False,
    audio_driver_type=0,
)

try:
    peak = p._measure_bare_synthesis_peak(pitch=60, velocity=127)
    print(f"BARE_PEAK={peak:.6g}")
finally:
    try:
        p.pianoid.shutdownGpu()
    except Exception:
        pass
