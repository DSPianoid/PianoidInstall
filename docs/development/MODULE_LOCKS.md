# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-b001 | `PianoidCore/pianoid_middleware/backendServer.py`, `PianoidCore/tests/system/test_use_simulation_rejected.py` | 2026-05-01T15:50:00Z | Bug #1 fix — reject `use_simulation=1` with HTTP 4xx (placeholder is vestigial) |
