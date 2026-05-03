# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-bv01 | `PianoidCore/pianoid_middleware/pianoid.py`, `PianoidCore/pianoid_middleware/backendServer.py`, `PianoidCore/pianoid_middleware/pianoidMidiListener.py`, `PianoidCore/pianoid_middleware/NoteTunner.py`, `PianoidCore/tests/integration/test_fix_velocity.py`, `PianoidTunner/src/PianoidTuner.js`, `PianoidTunner/src/hooks/useCurrentValues.js`, `PianoidTunner/src/hooks/useFixVelocity.js`, `PianoidTunner/src/components/ToolBar.jsx` | 2026-05-03T17:05:00Z | Backend Fix-MIDI velocity refactor — collapse fixed_velocity/fixed_level/JS-rewrite into one canonical owner with source-flag discriminator |
