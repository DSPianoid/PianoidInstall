# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-3st1 | `PianoidCore/pianoid_middleware/modal_adapter/esprit/mode_tracking.py`, `PianoidCore/pianoid_middleware/modal_adapter/esprit/mode_tracking_nuclei.py` (new), `PianoidCore/tests/unit/test_mode_tracking.py`, `PianoidCore/tests/unit/test_mode_tracking_nuclei.py` (new), `docs/development/MODE_TRACKING_REDESIGN.md`, `docs/guides/MODAL_ADAPTER_GUIDE.md`, `docs/development/MODE_TRACKING_NUCLEI_MERGE.md` (new) | 2026-05-04T18:51:00Z | 3-stage nuclei-merge mode tracking algorithm + sliding-window split-chain merge bug fix |
