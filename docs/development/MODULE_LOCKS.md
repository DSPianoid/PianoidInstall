# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-5312 | `PianoidTunner/src/components/CalibrationPanel.jsx`, `PianoidTunner/src/PianoidTuner.js` | 2026-04-18 16:02 | Simplify CalibrationPanel to 2 tabs, move timing to Settings |
| dev-de0f | `PianoidTunner/src/components/CurveEditor.jsx` | 2026-04-18 16:19 | Fix CurveEditor chart not updating on RCM capture |
| dev-8319 | `PianoidCore/pianoid_middleware/modal_adapter/modal_adapter.py` (`save_edited_chains` body only — lines 2530-2560), `PianoidCore/tests/unit/test_modal_adapter_state.py` (new `TestSaveEditedChainsRoundTrip` class appended at end of file) | 2026-04-18 19:04 | W4-C / F11 — Preserve tracking params across save_edited_chains() round-trip |
