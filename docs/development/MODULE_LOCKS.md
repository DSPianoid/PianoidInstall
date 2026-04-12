# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-86ba | `PianoidTunner/src/components/StabilizationDiagram.jsx` | 2026-04-12T20:00Z | Mode shape reference projection sub-chart |
