# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-eebf | `PianoidCore/pianoid_cuda/MicAnalyzer.h`, `PianoidCore/pianoid_cuda/MicAnalyzer.cpp`, `PianoidCore/pianoid_cuda/Pianoid.cu`, `PianoidCore/pianoid_cuda/AddArraysWithCUDA.cpp`, `PianoidCore/pianoid_middleware/calibration_controller.py`, `PianoidCore/tests/unit/test_mic_analyzer.py` | 2026-04-16T15:55:00Z | Revise volume measurement system — Goertzel + reference signal |
