# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-a328 | `PianoidTunner/src/PianoidTuner.js`, `PianoidTunner/src/hooks/useSettings.js`, `PianoidTunner/src/components/ModesPaneWithSettings.jsx`, `PianoidTunner/src/components/PresetPanel/PresetPanel.jsx`, `PianoidTunner/src/components/PaneWithSettings.jsx` (new) | 2026-05-01T18:45:00Z | PianoidTunner Phase 3: migrate remaining 8 panes to PaneSettingsDialog, remove vestigial Settings code, generalise wrapper into HOC |
