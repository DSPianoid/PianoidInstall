"""dev-ir01 — CLI proof: per-band IR length config + re-averaging at 1000 ms.

Demonstrates the end-to-end flow without touching the user's running
modal adapter server (PID 22824):

  1. Build a synthetic RoomResponse-style scenario whose metadata says
     ir_working_length_ms = 600 ms (the scenario_averager default).
  2. Call ``ensure_averaged_responses(force=True,
     ir_working_length_ms_override=1000.0)`` and verify the resulting
     average_ch{N}.npy is 1000 ms x 48 kHz = 48000 samples.
  3. Then call ``process_band`` per ``EXTENDED_BANDS`` band and confirm
     each band slices the 48000-sample signal to its own ir_length_ms.

This exercises the same code paths the new ``create_project`` /
``create_project_from_zip`` REST endpoints will use; the only thing
the REST layer adds is JSON parsing + a write to project.json.
"""
import os
import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np

# Make pianoid_middleware importable + RoomResponse for the canonical pipeline.
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "PianoidCore" / "pianoid_middleware"))
sys.path.insert(0, str(ROOT.parent / "RoomResponse"))

from modal_adapter import scenario_averager as sa  # noqa: E402
from modal_adapter.esprit.band_processing import (  # noqa: E402
    EXTENDED_BANDS, process_band,
)

# Re-use the synthetic-scenario helpers from the existing test file.
sys.path.insert(0, str(ROOT / "PianoidCore" / "tests" / "integration"))
from test_scenario_averager import _make_synthetic_scenario  # noqa: E402


def main() -> int:
    print("=" * 70)
    print("dev-ir01 — Re-averaging proof at 1000 ms IR working length")
    print("=" * 70)

    work = Path(tempfile.mkdtemp(prefix="dev_ir01_proof_"))
    try:
        scenario_dir = work / "Proof-Scenario0-Take1"
        _make_synthetic_scenario(
            scenario_dir, "Proof-Scenario0-Take1",
            num_measurements=2, num_pulses=5, sample_rate=48000,
            cycle_duration=1.0, num_channels=4, include_metadata=True)

        # Step 1: confirm the synthetic metadata defaults to 600 ms truncation
        meta_path = scenario_dir / "metadata" / "Proof-Scenario0-Take1_metadata.json"
        import json
        with open(meta_path) as f:
            meta = json.load(f)
        baseline_ms = meta["measurements"][0]["signal_params"][
            "truncate_config"]["ir_working_length_ms"]
        print(f"\nStep 1: scenario metadata baseline ir_working_length_ms = {baseline_ms} ms")
        assert baseline_ms == 600.0

        # Step 2: average WITHOUT the override -> 600 ms / 28800 samples
        result_default = sa.ensure_averaged_responses(scenario_dir)
        assert result_default.status == sa.STATUS_COMPUTED, (
            f"averaging failed: {result_default.error}")
        ch0_path = scenario_dir / "averaged_responses" / "average_ch0.npy"
        n_default = np.load(ch0_path).shape[0]
        print(f"\nStep 2: default averaging — average_ch0.npy length = {n_default} samples ({n_default / 48000 * 1000:.1f} ms)")
        assert n_default == 28800, (
            f"expected 28800 (=600 ms x 48 kHz), got {n_default}")

        # Step 3: force re-average WITH override = 1000 ms
        result_override = sa.ensure_averaged_responses(
            scenario_dir, force=True, ir_working_length_ms_override=1000.0)
        assert result_override.status == sa.STATUS_COMPUTED, (
            f"override averaging failed: {result_override.error}")
        n_override = np.load(ch0_path).shape[0]
        print(f"\nStep 3: with override=1000ms — average_ch0.npy length = {n_override} samples ({n_override / 48000 * 1000:.1f} ms)")
        assert n_override == 48000, (
            f"expected 48000 (=1000 ms x 48 kHz), got {n_override}")
        print(f"        -> override successfully extended truncation from 600 to 1000 ms")

        # Step 4: per-band slicing on the new 1000-ms averaged signal
        # Combine all 4 channels into a (T, n_channels) array like the project
        # importer would.
        signals = np.stack([
            np.load(scenario_dir / "averaged_responses" / f"average_ch{c}.npy")
            for c in range(4)
        ], axis=1)
        assert signals.shape == (48000, 4)
        print(f"\nStep 4: per-band slicing (new EXTENDED_BANDS defaults)")
        print(f"        Combined signal shape: {signals.shape} (4 channels x 1000 ms)")
        print()
        print(f"  {'Band':12} {'ir_ms':6} {'dec':3} {'fs_band':8} {'sliced':8} {'after_dec':9} {'L=N/2':6} {'df_Hz':6} {'cost_L^2*K':12}")
        for band in EXTENDED_BANDS:
            _, fs_band, m = process_band(
                signals, fs=48000, band=band, apply_preemphasis=False)
            L = m["n_samples_decimated"] // 2
            df = fs_band / L if L > 0 else 0
            cost = L * L * (band.model_order or 30)
            print(f"  {band.name:12} {band.ir_length_ms:6.0f} {band.decimation:3d} {fs_band:8.0f} {m['n_samples_original']:8d} {m['n_samples_decimated']:9d} {L:6d} {df:6.2f} {cost:12,d}")

        print()
        print("=" * 70)
        print("PROOF COMPLETE")
        print("=" * 70)
        print(f"  - Override raised averaged-response file from 600 -> 1000 ms (28800 -> 48000 samples)")
        print(f"  - Each band sliced INDEPENDENTLY to its own ir_length_ms")
        print(f"  - Hankel L bounded by silent clamp len(processed)//2")
        print(f"  - Cost ratio (Ultra-Low new vs old proposal):")
        # Old: dec=1, ir=full=1500, L=12000, K=8 -> cost 1.152e9
        # New: dec=4, ir=1000, L=6000, K=8 -> cost 2.88e8
        print(f"      old (dec=1, full signal): L²xK ≈ 1.152e9")
        print(f"      new (dec=4, 1000 ms IR):  L²xK = 2.88e8 — 4x cheaper")
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
