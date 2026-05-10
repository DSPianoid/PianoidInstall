# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-midi-p1 | `PianoidCore/pianoid_cuda/EventDispatcher.cu`, `PianoidCore/pianoid_cuda/EventDispatcher.h`, `PianoidCore/pianoid_cuda/PlaybackCycleExecutor.cu`, `PianoidCore/pianoid_cuda/PlaybackCycleExecutor.h`, `PianoidCore/pianoid_cuda/OnlinePlaybackEngine.cu`, `PianoidCore/pianoid_cuda/OnlinePlaybackEngine.h`, `PianoidCore/pianoid_cuda/OfflinePlaybackEngine.cu`, `PianoidCore/pianoid_cuda/Pianoid.cu`, `PianoidCore/pianoid_cuda/Pianoid.cuh`, `PianoidCore/pianoid_cuda/AddArraysWithCUDA.cpp`, `PianoidCore/pianoid_cuda/constants.h`, `PianoidCore/tests/system/test_kernel_midi_batch.py`, `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md`, `docs/modules/pianoid-cuda/PLAYBACK_SYSTEM.md`, `docs/architecture/DATA_FLOWS.md` | 2026-05-09T19:17:30Z | MIDI W1 P1 — CUDA kernel single-envelope batch fix + TEST_* envelope merge + MAX_EVENTS_PER_CYCLE cap |
