# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-b0d3 | `PianoidCore/pianoid_middleware/modal_adapter/modal_adapter.py`, `PianoidCore/pianoid_middleware/modal_adapter/esprit_runner.py`, `PianoidTunner/src/hooks/useModalAdapter.js` | 2026-04-13T01:25:00Z | Fix ESPRIT config persistence across project reopen |
