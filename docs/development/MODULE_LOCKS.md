# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-drawable-bar | `PianoidTunner/src/components/BarChart.jsx`, `PianoidTunner/src/components/RowEditor.js`, `PianoidTunner/src/components/MeasuredMatrix.jsx`, `PianoidTunner/src/PianoidTuner.js`, `PianoidTunner/src/hooks/useSettings.js`, `PianoidTunner/src/components/ObjectInspector.jsx` | 2026-04-23T07:55:00Z | Wave 2: BarChart family → DrawableChart migration + per-panel viz setting |
