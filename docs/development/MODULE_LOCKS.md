# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-529b | `PianoidTunner/src/components/MatrixTools.jsx`, `PianoidTunner/src/components/Excitation.jsx` | 2026-05-02T14:54:26+03:00 | Mouse-wheel control for Excitation stretch/shrink buttons |
