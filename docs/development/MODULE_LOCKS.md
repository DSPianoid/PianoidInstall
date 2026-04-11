# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-bd25 | `PianoidCore/pianoid_middleware/backendServer.py`, `PianoidCore/pianoid_middleware/pianoid.py`, `PianoidCore/pianoid_middleware/calibration_controller.py`, `PianoidTunner/src/hooks/usePreset.js`, `PianoidTunner/src/hooks/useBackendHealth.js`, `PianoidTunner/src/hooks/useSocketIO.js` (new), `PianoidTunner/package.json` | 2026-04-10T23:52:00Z | WebSocket migration |
