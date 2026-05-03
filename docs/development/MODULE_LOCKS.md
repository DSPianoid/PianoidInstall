# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-2706 | `PianoidTunner/src/components/GaussEditor.jsx`, `PianoidTunner/src/components/GaussCell.jsx`, `PianoidTunner/src/components/Mode.jsx`, `PianoidTunner/src/components/Strings.jsx`, `PianoidTunner/src/components/PerceptionCurveEditor.jsx`, `PianoidTunner/src/components/MatrixTools.jsx`, `PianoidTunner/src/components/ToolBar.jsx`, `PianoidTunner/src/components/HammerSpatialProperties.jsx`, `PianoidTunner/src/components/ExcitationProperties.jsx`, `PianoidTunner/src/components/__tests__/numinput-no-clamps.test.jsx` | 2026-05-03T18:30:00Z | Bug A scope expansion — remove value limits on engine-bound parameter editors |
