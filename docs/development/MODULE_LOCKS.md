# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-bfe2 | `PianoidCore/pianoid_middleware/preset_library.py`, `PianoidCore/pianoid_middleware/backendServer.py`, `PianoidTunner/src/hooks/usePreset.js`, `PianoidTunner/src/components/PresetPanel/PresetPanel.jsx`, `PianoidTunner/src/components/PaneWithSettings.jsx`, `PianoidTunner/src/PianoidTuner.js` | 2026-05-18T09:50Z | Preset working-copy model (pianoid.py + parameter_manager.py now free — dev-3a08 released pianoid.py 2026-05-18) |
