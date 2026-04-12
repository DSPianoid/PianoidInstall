# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-b515 | `PianoidCore/pianoid_middleware/modal_adapter_server.py`, `PianoidCore/pianoid_middleware/backendServer.py` | 2026-04-12T22:00:00Z | Add venv guard |
