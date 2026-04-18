# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-5312 | `PianoidTunner/src/components/CalibrationPanel.jsx`, `PianoidTunner/src/PianoidTuner.js` | 2026-04-18 16:02 | Simplify CalibrationPanel to 2 tabs, move timing to Settings |
| dev-de0f | `PianoidTunner/src/components/CurveEditor.jsx` | 2026-04-18 16:19 | Fix CurveEditor chart not updating on RCM capture |
| dev-9d65 | `PianoidTunner/src/hooks/useModalAdapter.js`, `PianoidTunner/src/modules/ModalAdapter.jsx` | 2026-04-18 18:06 | F8 (W3-C) — sync-only authoritative state; remove dirty-flag wrappers; fix runEsprit race |
