"""dev-mstat-30b6 (2026-05-26) — Live verification of the
``mass_inversion_status`` classifier against the persisted LG_p3 data.

Reads the chain_*.json + index.json from
``D:/modal_projects/LG_p3/modal_adapter/modal_mass/`` and the project's
mapping_config from ``project.json``, then applies
``classify_mass_inversion_status`` on every chain's
``per_scenario_residues``. Prints the bucket distribution + compares
against the audit expectation (386/242/126/3).

This is the offline replay path — it does NOT re-run modal_mass (which
needs a full FRF re-extraction; takes minutes + side effects). It
proves the classifier produces the expected counts on the real
persisted residue tensor.
"""
from __future__ import annotations

import json
import os
import sys
from collections import Counter
from typing import Any, Dict, Tuple

REPO_ROOT = "D:/repos/PianoidInstall"
sys.path.insert(0, os.path.join(REPO_ROOT, "PianoidCore"))

from pianoid_middleware.modal_adapter.modal_mass_orchestrator import (  # noqa: E402
    classify_mass_inversion_status,
    MASS_STATUS_VALID,
    MASS_STATUS_INSUFFICIENT_BAND_WIDTH,
    MASS_STATUS_NO_FULL_ROW,
    MASS_STATUS_ONLY_UNMAPPED_FULL_ROW,
)

PROJECT_DIR = r"D:/modal_projects/LG_p3"
MM_DIR = os.path.join(PROJECT_DIR, "modal_adapter", "modal_mass")


def _residues_to_classifier_dict(per_sc: Dict[str, Any]) -> Dict[int, Dict[int, Tuple[complex, float]]]:
    """Convert persisted ``per_scenario_residues`` (string-keyed JSON
    dict of dicts of ``{real, imag, fit_quality}``) into the in-memory
    tuple shape that ``classify_mass_inversion_status`` expects."""
    out: Dict[int, Dict[int, Tuple[complex, float]]] = {}
    for sc_str, ch_dict in per_sc.items():
        sc_idx = int(sc_str)
        ch_map: Dict[int, Tuple[complex, float]] = {}
        for ch_str, entry in ch_dict.items():
            ch_idx = int(ch_str)
            R = complex(float(entry.get("real", 0.0)),
                        float(entry.get("imag", 0.0)))
            q = float(entry.get("fit_quality", 0.0))
            ch_map[ch_idx] = (R, q)
        out[sc_idx] = ch_map
    return out


def main() -> int:
    # Load project mapping to get the actuator-mapping scenario set + S
    proj_json = os.path.join(PROJECT_DIR, "project.json")
    with open(proj_json) as f:
        proj = json.load(f)
    # v2 schema — measurement_snapshot.mapping_config.point_coordinates
    snap = proj.get("measurement_snapshot") or {}
    mapping = snap.get("mapping_config") or {}
    point_coords = mapping.get("point_coordinates") or {}
    # response_channels is derived from channel_roles per
    # MappingConfig.response_channels (a property): sorted ints of the
    # channels with role == "response". The persisted JSON stores
    # channel_roles as string-keyed; the property coerces to int.
    channel_roles = mapping.get("channel_roles") or {}
    response_channels = sorted(
        int(ch) for ch, role in channel_roles.items() if role == "response"
    )
    # JSON keys are strings -> coerce to int (the orchestrator does the
    # same in run_modal_mass at line 567).
    mapped_scenario_indices = set(int(k) for k in point_coords.keys())
    S = len(response_channels)
    print(f"Project: {PROJECT_DIR}")
    print(f"  mapped scenarios (point_coordinates):    {len(mapped_scenario_indices)}")
    print(f"  response channels:                       {S}  ({response_channels})")

    # Walk every chain_*.json
    counts = Counter()
    detailed_breakdown = {
        MASS_STATUS_VALID: 0,
        MASS_STATUS_INSUFFICIENT_BAND_WIDTH: 0,
        MASS_STATUS_NO_FULL_ROW: 0,
        MASS_STATUS_ONLY_UNMAPPED_FULL_ROW: 0,
    }
    total = 0
    for name in sorted(os.listdir(MM_DIR)):
        if not (name.startswith("chain_") and name.endswith(".json")):
            continue
        total += 1
        with open(os.path.join(MM_DIR, name)) as f:
            payload = json.load(f)
        m_abs = payload.get("m_absolute")
        per_sc = payload.get("per_scenario_residues") or {}
        residues_dict = _residues_to_classifier_dict(per_sc)
        # inversion_ok = the persisted m_absolute is finite
        import math
        inversion_ok = (
            m_abs is not None and isinstance(m_abs, (int, float))
            and math.isfinite(float(m_abs)) and float(m_abs) > 0
        )
        status = classify_mass_inversion_status(
            inversion_ok=inversion_ok,
            residues_by_scenario=residues_dict,
            mapped_scenario_indices=mapped_scenario_indices,
            num_response_channels=S,
        )
        counts[status] += 1
        detailed_breakdown[status] = counts[status]

    print()
    print(f"Total chains: {total}")
    print()
    print("mass_inversion_status distribution:")
    for k in (MASS_STATUS_VALID,
              MASS_STATUS_INSUFFICIENT_BAND_WIDTH,
              MASS_STATUS_NO_FULL_ROW,
              MASS_STATUS_ONLY_UNMAPPED_FULL_ROW):
        print(f"  {k:<35} {counts.get(k, 0):>4}")
    print()

    # Expected per the ana-mmnan-7c3a audit
    expected = {
        MASS_STATUS_VALID: 386,
        MASS_STATUS_INSUFFICIENT_BAND_WIDTH: 242,
        MASS_STATUS_NO_FULL_ROW: 126,
        MASS_STATUS_ONLY_UNMAPPED_FULL_ROW: 3,
    }
    print("Comparison with audit (proposal 2026-05-26):")
    all_match = True
    for k, exp in expected.items():
        got = counts.get(k, 0)
        marker = "OK" if got == exp else "MISMATCH"
        if got != exp:
            all_match = False
        print(f"  {k:<35} expected={exp:>4}  got={got:>4}  [{marker}]")
    print()
    if all_match:
        print("ALL BUCKETS MATCH THE AUDIT (386/242/126/3 on LG_p3).")
        return 0
    else:
        print("MISMATCH — classifier output diverges from the audit.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
