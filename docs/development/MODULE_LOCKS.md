# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-sc-averaged-chart | `PianoidTunner/src/components/SoundChannelsPane.jsx`, `PianoidTunner/src/components/SoundChannelsAggregateChart.jsx`, `PianoidTunner/src/hooks/useSoundChannels.js` | 2026-04-21T11:55:00Z | Refactor SC averaged mode to curve chart (reuse Volume Tuner drag pattern) |
