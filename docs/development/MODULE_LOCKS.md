# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-546d | `PianoidCore/pianoid_middleware/modal_adapter/modal_adapter.py`, `PianoidCore/pianoid_middleware/modal_adapter/esprit_runner.py` | 2026-04-12T16:27:23Z | Fix mapping config load + ESPRIT channel filtering |
