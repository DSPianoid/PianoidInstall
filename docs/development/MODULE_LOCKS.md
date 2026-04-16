# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-a565 | `PianoidCore/pianoid_middleware/calibration_controller.py`, `PianoidCore/tests/unit/test_direct_correction.py` | 2026-04-16T17:35:00Z | Replace iterative bisection with direct linear correction |
