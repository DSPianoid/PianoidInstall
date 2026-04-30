# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-mass-rename | `PianoidBasic/Pianoid/Mode.py`, `PianoidCore/pianoid_middleware/parameter_manager.py`, `PianoidCore/pianoid_middleware/pianoid.py`, `PianoidTunner/src/components/Mode.jsx`, `PianoidTunner/src/hooks/usePreset.js`, `PianoidCore/tests/integration/test_mode_param_independence.py`, `PianoidCore/pianoid_cuda/Pianoid.cu`, `PianoidCore/pianoid_cuda/AddArraysWithCUDA.cpp`, `PianoidCore/pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md` | 2026-04-30T11:54:30Z | Rename `mass`→`mass_inv` across stack (no kernel/preset change) |
