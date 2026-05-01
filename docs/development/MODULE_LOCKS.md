# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-39c7 | `PianoidTunner/src/components/Excitation.jsx`, `PianoidTunner/src/components/MatrixTools.jsx`, `PianoidTunner/src/hooks/useSettings.js`, `PianoidTunner/src/PianoidTuner.js`, `PianoidTunner/src/components/ObjectInspector.jsx` | 2026-05-01T18:02:00Z | Excitation pane: add `excitationSettings` bucket with `stretchStep: 1.2`; wire 4 stretch/shrink toolbar buttons (vertical → volume × k; horizontal → mu AND sigma × k); remove volume/duration sliders |
