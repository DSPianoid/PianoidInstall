# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-568e | `PianoidCore/pianoid_cuda/Pianoid.cu`, `PianoidCore/pianoid_cuda/Pianoid.cuh`, `PianoidCore/pianoid_cuda/AddArraysWithCUDA.cpp`, `PianoidCore/pianoid_cuda/PlaybackCycleExecutor.cu`, `PianoidCore/pianoid_cuda/PlaybackCycleExecutor.h`, `PianoidCore/pianoid_cuda/OnlinePlaybackEngine.cu`, `PianoidCore/pianoid_cuda/OfflinePlaybackEngine.cu`, `PianoidCore/pianoid_cuda/PianoidProfiler.h`, `PianoidCore/tests/system/test_performance.py`, `PianoidCore/tests/unit/test_tune_pipeline.py`, `PianoidCore/pianoid_middleware/chartFunctions.py`, `PianoidCore/pianoid_middleware/test_audio_driver.py`, `PianoidCore/pianoid_middleware/test_backendserver_audio.py` | 2026-04-20T19:05:00Z | Core split C2+C3 — CycleRegime enum + runCycle + primitive extraction + delete playSoundSamples/manageSoundBuffers/audioOn |
