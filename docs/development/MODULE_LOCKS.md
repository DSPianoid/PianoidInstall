# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-startup-configs | `PianoidTunner/src/hooks/useSettings.js`, `PianoidTunner/src/components/PresetPanel/PresetPanel.jsx`, `PianoidTunner/src/components/PresetPanel/PresetConfigBar.jsx`, `PianoidTunner/src/PianoidTuner.js`, `PianoidTunner/src/hooks/presetConfigStore.js`, `PianoidTunner/src/hooks/__tests__/presetConfigStore.test.jsx`, `PianoidTunner/src/hooks/__tests__/useSettings.presetConfigs.test.jsx`, `PianoidTunner/src/components/__tests__/PresetConfigBar.test.jsx`, `docs/modules/pianoid-tunner/OVERVIEW.md` | 2026-05-16T07:15:30Z | Named, switchable startup configs + JSON export/import |
