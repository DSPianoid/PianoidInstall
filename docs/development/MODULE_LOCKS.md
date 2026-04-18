# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-f642 | `PianoidCore/pianoid_middleware/calibration_controller.py`, `PianoidCore/pianoid_middleware/backendServer.py`, `PianoidCore/pianoid_middleware/measurement_precision.py` (new), `PianoidCore/pianoid_middleware/measurement_engine.py` (new), `PianoidCore/pianoid_middleware/synthesis_tuner.py` (new), `PianoidCore/pianoid_middleware/acoustic_tuner.py` (new), `PianoidCore/tests/unit/test_calibration_review.py`, `PianoidCore/tests/unit/test_tune_pipeline.py`, `PianoidCore/tests/unit/test_direct_correction.py` | 2026-04-18T06:52:09Z | Refactor CalibrationController into focused modules |
