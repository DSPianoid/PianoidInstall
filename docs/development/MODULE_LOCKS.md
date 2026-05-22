# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-ce07 | `PianoidCore/pianoid_cuda/Pianoid.cu`, `PianoidCore/pianoid_cuda/Pianoid_calibration.cu`, `PianoidCore/pianoid_cuda/Pianoid_debug.cu`, `PianoidCore/pianoid_cuda/Pianoid_excitation.cu`, `PianoidCore/pianoid_cuda/Pianoid_internal.cuh`, `PianoidCore/pianoid_cuda/Pianoid_parameters.cu`, `PianoidCore/pianoid_cuda/Pianoid_presets.cu`, `PianoidCore/pianoid_cuda/Pianoid_synthesis.cu` | 2026-05-22T12:09:30Z | Wave-2 merge — lock split .cu/.cuh files before merge (precaution; Wave-2 confirmed not to touch them) |
