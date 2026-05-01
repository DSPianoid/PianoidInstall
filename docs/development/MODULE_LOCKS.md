# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-f259 | `PianoidTunner/src/components/ObjectInspector.jsx`, `PianoidTunner/src/components/NumInput/NumInput.js`, `PianoidTunner/src/components/NumericInput.jsx`, `PianoidTunner/src/components/PropertyInput.jsx`, `PianoidTunner/src/components/PropertyInput.css`, `PianoidTunner/src/components/PitchTools.jsx`, `PianoidTunner/src/components/Hammers.jsx`, `PianoidTunner/src/components/NumInputTest.jsx`, `PianoidTunner/src/components/__tests__/PaneSettingsDialog.test.jsx`, `PianoidTunner/src/PianoidTuner.js`, `PianoidTunner/src/hooks/useLayout.js`, `PianoidTunner/src/hooks/useWindowManager.js` | 2026-05-01T19:15:00Z | ObjectInspector → NumInput delegation + delete legacy NumericInput/PropertyInput/PitchTools/Hammers/NumInputTest |
