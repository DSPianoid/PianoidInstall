# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-1564 | `tools/lock_gpu_clock.bat`, `tools/unlock_gpu_clock.bat` | 2026-05-01T15:11:00Z | Add NVIDIA GPU clock lock/unlock helper scripts |
