"""dev-frfres-9c41 (2026-05-25): Live-repro script for the FRF resolver
fix.

Operates DIRECTLY on the user's on-disk `D:/modal_projects/PlyWoodLGtemp1_p4`
(v2 schema, empty `measurements/`, parent Measurement at
`D:/modal_measurements/PlyWoodLGtemp1`) — no browser, no Flask server,
no test fixtures.

Pre-fix expected output:
    source_folder=None
    FRF resolver would raise: No usable measurement source folder for FRF; resolved=None

Post-fix expected output:
    source_folder=D:/modal_measurements/PlyWoodLGtemp1 (or similar absolute path)
    Resolver guard passes (no exception at the source_folder check)

Usage:
    PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-frfres-9c41-live-repro.py
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path


# Wire the script into the middleware package without needing pip-install.
HERE = Path(__file__).resolve()
REPO_ROOT = HERE.parents[3]
sys.path.insert(0, str(REPO_ROOT / "PianoidCore" / "pianoid_middleware"))

# Configure logging so loader/orchestrator info messages surface.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("frfres-repro")


def main() -> int:
    from modal_adapter import ModalAdapter

    adapter = ModalAdapter()
    adapter._projects_base = r"D:\modal_projects"

    logger.info("Opening project 'PlyWoodLGtemp1_p4'…")
    try:
        adapter.open_project("PlyWoodLGtemp1_p4")
    except Exception as exc:
        logger.exception("open_project failed: %s", exc)
        return 1

    ctx = adapter._ctx
    logger.info("After open_project:")
    logger.info("  ctx.project_dir      = %s", ctx.project_dir)
    logger.info("  ctx.source_folder    = %s", ctx.source_folder)
    logger.info("  len(ctx.measurements)= %d", len(ctx.measurements))
    logger.info("  ctx.sample_rate      = %s", ctx.sample_rate)

    if ctx.source_folder is None:
        logger.error(
            "PRE-FIX state: ctx.source_folder is None — FRF would fail "
            "with 'No usable measurement source folder for FRF; resolved=None'"
        )
        return 2

    if not os.path.isdir(ctx.source_folder):
        logger.error(
            "ctx.source_folder is set but not a directory: %r",
            ctx.source_folder,
        )
        return 3

    scenarios_dir = os.path.join(ctx.source_folder, "scenarios")
    if not os.path.isdir(scenarios_dir):
        logger.warning(
            "source_folder/scenarios not found at %s — "
            "FrfOrchestrator._resolve_scenario_dirs will fall back "
            "to source_folder directly (still recoverable)",
            scenarios_dir,
        )
    else:
        logger.info(
            "POST-FIX OK: source_folder/scenarios exists at %s",
            scenarios_dir,
        )

    # Probe the FRF orchestrator's resolver path WITHOUT actually running
    # FRF (which needs a mapping + would take ~20 s). We just call the
    # internal source-folder check the orchestrator does at the top of
    # run_frf.
    source_folder = adapter._frf_orchestrator._source_folder_resolver()
    if not source_folder or not os.path.isdir(source_folder):
        logger.error(
            "FRF resolver returns invalid source_folder=%r — fix not "
            "effective", source_folder,
        )
        return 4

    logger.info(
        "POST-FIX OK: FRF source_folder_resolver returns %s "
        "(directory exists)", source_folder,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
