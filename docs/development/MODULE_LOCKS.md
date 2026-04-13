# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-47a9 | `PianoidCore/pianoid_middleware/modal_adapter_server.py`, `PianoidTunner/server/launcher.js` | 2026-04-13T10:12:00Z | Add stale process check to modal adapter server and launcher |
