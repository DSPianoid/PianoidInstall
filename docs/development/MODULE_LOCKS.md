# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-string-length-dx | `PianoidCore/pianoid_middleware/parameter_manager.py`, `PianoidCore/tests/integration/test_length_dx_propagation.py` | 2026-05-17T10:05:00Z | Fix: granular `length` edit must recompute + send `dx` to GPU |
