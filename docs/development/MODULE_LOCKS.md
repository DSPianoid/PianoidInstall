# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-midi-play | `PianoidCore/pianoid_middleware/backendServer.py`, `PianoidCore/tests/unit/test_play_listen_gate_regression.py` | 2026-05-15T18:26:30Z | Remove legacy `pianoid.listen` play gate (MIDI-on play regression) |
| dev-toggle-ui | `PianoidTunner/src/components/ObjectInspector.jsx`, `PianoidTunner/src/components/__tests__/PaneSettingsDialog.test.jsx` | 2026-05-15T18:12:00Z | Render binary preset-load params as MUI Switch toggles |
| dev-cal-twice | `PianoidCore/pianoid_middleware/calibration_controller.py`, `PianoidTunner/src/components/CalibrationPanel.jsx`, `PianoidCore/tests/unit/test_tune_pipeline.py` | 2026-05-15T18:43:00Z | Label clipping-correction pass in Calibrate Synthesis progress UI |
