"""Live verification for Phase 2 modal mass (dev-modal-mass-p2, 2026-05-24).

Spins up ModalAdapter in-process (no Flask server) against
``D:/modal_measurements/PlyWoodLGtemp1`` to verify the modal-mass
extraction pipeline against real data.

Runs through:
  1. Spin up ModalAdapter
  2. Create temp project + grid mapping for first N scenarios
  3. Run ESPRIT on those scenarios
  4. Run tracking
  5. Run FRF
  6. Run modal mass
  7. Report: number of chains, m_relative ratios, fit_quality median,
     reference-mode chain ID, any chains rejected by m_1 selection.

Usage:
  PianoidCore/.venv/Scripts/python.exe \
      docs/development/diagnostics/dev-modal-mass-p2-live-verification.py
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

# Make sure we can import from the project src tree
PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT / "PianoidCore"))

import numpy as np

from pianoid_middleware.modal_adapter.modal_adapter import ModalAdapter

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("modal_mass_live")


PLYWOOD = Path("D:/modal_measurements/PlyWoodLGtemp1")
SCENARIO_COUNT = 12  # ≥8 to satisfy Q6 gate; small subset for speed


def main() -> int:
    assert PLYWOOD.is_dir(), f"PlyWood measurement folder not found: {PLYWOOD}"

    # Use a temp dir for the project; keep it after the run for the
    # report's persisted JSON references.
    project_root = Path(tempfile.mkdtemp(
        prefix="dev-modal-mass-p2-live-"))
    logger.info("Project root: %s", project_root)
    project_path = project_root / "live_verification_project"

    adapter = ModalAdapter()
    adapter.set_projects_base(str(project_root))
    adapter.set_project_dir(str(project_path))

    # ---- Step 1: discover scenarios + load a subset ----
    scenarios_root = PLYWOOD / "scenarios"
    available_scenarios = []
    import re
    for entry in sorted(scenarios_root.iterdir()):
        if not entry.is_dir():
            continue
        m = re.search(r"Scenario(\d+)", entry.name)
        if m:
            available_scenarios.append(int(m.group(1)))
    available_scenarios.sort()
    scenarios_to_load = available_scenarios[:SCENARIO_COUNT]
    logger.info(
        "Loading %d scenarios (indices %s..%s) from %s",
        len(scenarios_to_load), scenarios_to_load[0],
        scenarios_to_load[-1], scenarios_root)

    load_result = adapter.load_folder(
        str(PLYWOOD), scenarios=scenarios_to_load)
    logger.info("Load result: %s", {
        k: v for k, v in load_result.items() if k != "state"
    })
    n_loaded = len(adapter._measurements)
    logger.info("Measurements loaded: %d", n_loaded)
    if n_loaded < 8:
        logger.error(
            "Need ≥ 8 scenarios for Q6 gate; got %d", n_loaded)
        return 1

    # ---- Step 2: set mapping (grid layout, simulate one cell per scenario) ----
    n_scenarios = n_loaded
    grid_w = 4
    grid_h = (n_scenarios + grid_w - 1) // grid_w
    cell_mask = [
        [(r * grid_w + c) < n_scenarios for c in range(grid_w)]
        for r in range(grid_h)
    ]
    # ScenarioLoader populates measurements keyed by ORDINAL index
    # (0, 1, 2, ..., n_loaded-1) — verify
    measurement_keys = sorted(adapter._measurements.keys())
    logger.info("Measurement keys: %s..%s", measurement_keys[:3],
                measurement_keys[-3:])
    point_coords = {
        sc: (float((sc % grid_w) * 50.0), float((sc // grid_w) * 50.0))
        for sc in measurement_keys
    }
    # Channel roles — discover from first measurement shape
    first_arr = adapter._measurements[measurement_keys[0]]
    n_channels = first_arr.shape[1] if first_arr.ndim == 2 else 1
    logger.info("Channels per measurement: %d", n_channels)
    # PlyWood convention: channel 0 = force/calibration, ch 1..N = response
    channel_roles = {0: "force"}
    response_channels_list = list(range(1, n_channels))
    for c in response_channels_list:
        channel_roles[c] = "response"
    channel_to_sound = {c: i for i, c in enumerate(response_channels_list)}

    map_result = adapter.set_mapping(
        excitation_to_pitch={},  # grid layout doesn't need this
        channel_to_sound=channel_to_sound,
        skipped_channels=[],
        channel_roles=channel_roles,
        bridge_boundary=28,
        pitch_offset=21,
        layout_type="grid",
        grid_shape=(grid_h, grid_w),
        grid_spacing_mm=50.0,
        cell_mask=cell_mask,
        point_coordinates=point_coords,
    )
    logger.info("Mapping set: %s", map_result)

    # ---- Step 3: run ESPRIT on the loaded subset ----
    esprit_t0 = time.time()
    try:
        esprit_result = adapter.run_esprit(
            {"frequency_range": [50, 3000],
             "model_order": 50,
             "rank_estimate": 30})
        logger.info("ESPRIT done in %.1fs: %s", time.time() - esprit_t0,
                    {k: v for k, v in esprit_result.items() if k != "state"})
    except Exception as exc:
        logger.exception("ESPRIT failed: %s", exc)
        return 2

    # ---- Step 4: run tracking ----
    tracking_t0 = time.time()
    try:
        tracking_result = adapter.run_tracking(
            bridge_boundary=28, freq_tol_pct=0.02, max_gap=3,
            tracking_method="nuclei_merge")
        n_chains = len(adapter._tracked_chains)
        logger.info("Tracking done in %.1fs: %d chains",
                    time.time() - tracking_t0, n_chains)
    except Exception as exc:
        logger.exception("Tracking failed: %s", exc)
        return 3

    if n_chains == 0:
        logger.error("No chains produced — modal mass needs ≥1 chain")
        return 4

    # ---- Step 5: run FRF ----
    frf_t0 = time.time()
    try:
        # Have to set source_folder for FRF orchestrator (so it can
        # locate raw_recordings/)
        adapter._ctx.source_folder = str(PLYWOOD)
        frf_result = adapter.run_frf()
        logger.info("FRF done in %.1fs: %d scenarios",
                    time.time() - frf_t0,
                    frf_result.get("scenario_count", 0))
    except Exception as exc:
        logger.exception("FRF failed: %s", exc)
        return 5

    # ---- Step 6: run modal mass ----
    mm_t0 = time.time()
    try:
        mm_result = adapter.run_modal_mass()
        logger.info(
            "Modal mass done in %.1fs: %d chains",
            time.time() - mm_t0, mm_result.get("chain_count", 0))
    except Exception as exc:
        logger.exception("Modal mass failed: %s", exc)
        return 6

    # ---- Step 7: report ----
    summary = adapter.get_modal_mass_summary()
    chains = summary.get("chains", [])
    print("\n" + "=" * 70)
    print("LIVE VERIFICATION REPORT")
    print("=" * 70)
    print(f"Scenarios loaded: {n_loaded}")
    print(f"Tracked chains: {n_chains}")
    print(f"Modal-mass chains: {len(chains)}")
    print(f"Reference chain: {summary.get('reference_mode_chain_id')}")
    if summary.get("reference_mode_warning"):
        print(f"WARNING: {summary['reference_mode_warning']}")

    if chains:
        m_rels = [c["m_relative"] for c in chains
                  if c["m_relative"] is not None]
        fit_qs = [c["fit_quality_overall"] for c in chains
                  if c["fit_quality_overall"] is not None]
        if m_rels:
            print(f"m_relative range: [{min(m_rels):.3f}, "
                  f"{max(m_rels):.3f}], median {np.median(m_rels):.3f}")
        if fit_qs:
            print(f"fit_quality median: {np.median(fit_qs):.3f}")

        # Per-chain summary
        print("\nPer-chain table (first 20 lowest-freq):")
        sorted_chains = sorted(chains, key=lambda c: c["frequency_hz"])
        print(f"{'chain':>6} {'freq_hz':>8} {'fit':>6} "
              f"{'m_abs':>10} {'m_rel':>8} {'fit_q':>6} {'ref':>4}")
        for c in sorted_chains[:20]:
            m_abs = c["m_absolute"]
            m_rel = c["m_relative"]
            m_abs_s = f"{m_abs:.3e}" if m_abs is not None else "    n/a"
            m_rel_s = f"{m_rel:.3f}" if m_rel is not None else "  n/a"
            ref_s = "REF" if c["is_reference_mode"] else ""
            print(f"{c['chain_id']:>6} {c['frequency_hz']:>8.1f} "
                  f"{c['fit_method']:>6} {m_abs_s:>10} {m_rel_s:>8} "
                  f"{c['fit_quality_overall']:>6.2f} {ref_s:>4}")

        # Acceptance check
        ref_id = summary.get("reference_mode_chain_id")
        if ref_id is not None:
            print("\nAcceptance check:")
            print(f"  Reference mode selected: chain {ref_id} OK")
            high_q = sum(1 for q in fit_qs if q > 0.85)
            print(f"  Chains with fit_quality > 0.85: "
                  f"{high_q}/{len(fit_qs)}")
            # Per Q2 acceptance criterion: per-chain self-consistency
            # within 15 % is the formal target; the bar chart summary
            # gives us m_relative spread as a sanity check.
        else:
            print("\nNo reference mode → m_relative unavailable; "
                  "raw m_absolute still stored per chain")

    print(f"\nPersisted under: {project_path}/modal_adapter/modal_mass/")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
