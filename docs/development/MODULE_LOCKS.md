# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-9a47 | `PianoidCore/pianoid_middleware/parameter_manager.py`, `PianoidCore/pianoid_middleware/backendServer.py`, `PianoidCore/tests/integration/test_parameter_safety_net.py` (NEW) | 2026-05-03T20:55:00Z | Backend parameter safety net (D3-followup from dev-2706) — fail-fast guard for catastrophic engine inputs |
