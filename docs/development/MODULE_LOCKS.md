# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-md01 | `PianoidCore/pianoid_middleware/backendServer.py` | 2026-05-03T21:35:00Z | Fix MIDI double-fire — collapse cross-transport dedup to single shared store |
