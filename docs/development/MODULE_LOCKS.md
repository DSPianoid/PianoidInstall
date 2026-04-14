# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-5d0d | `PianoidTunner/src/components/StabilizationDiagram.jsx` | 2026-04-14T16:05:00Z | Refactor zoom/scale system — unify dual-state zoom |
