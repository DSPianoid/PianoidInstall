# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-5312 | `PianoidTunner/src/components/CalibrationPanel.jsx`, `PianoidTunner/src/PianoidTuner.js` | 2026-04-18 16:02 | Simplify CalibrationPanel to 2 tabs, move timing to Settings |
| dev-9d5c | `PianoidTunner/src/components/StabilizationDiagram.jsx` | 2026-04-19 11:56 | Fix Bug 2 brush rectangle persistence after zoom |
