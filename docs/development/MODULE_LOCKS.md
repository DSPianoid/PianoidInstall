# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-f7f1 | `PianoidTunner/src/components/Excitation.jsx`, `PianoidTunner/src/components/MatrixTools.jsx` | 2026-05-03T18:08:00Z | Excitation stretch/shrink buttons + wheel scope to selected velocity level (revising dev-39c7 broadcast design) + bug-C fix (GAUSS_LEVEL_KEYS pp=5) |
