# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-e6b9 | `PianoidTunner/src/hooks/useSettings.js`, `PianoidTunner/src/PianoidTuner.js`, `PianoidTunner/src/components/PropertiesMaps.js`, `PianoidCore/pianoid_middleware/backendServer.py`, `PianoidCore/pianoid_middleware/pianoid.py` | 2026-04-21T11:50:00Z | Keyboard playback v2 — speed/mode settings + offline endpoint |
