# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-f5-stream | `PianoidCore/pianoid_cuda/CircularBuffer.cu`, `PianoidCore/pianoid_cuda/CircularBuffer.cuh` | 2026-04-22T13:39:03Z | F5: dedicated CUDA stream for produce() |
