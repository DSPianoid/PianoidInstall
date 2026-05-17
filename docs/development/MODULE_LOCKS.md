# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-cursor-drift | `PianoidTunner/src/components/NumInput/NumInput.js`, `PianoidTunner/src/components/__tests__/numinput-cursor.test.jsx`, `docs/development/DIGITAL_INPUT_ANALYSIS.md`, `docs/proposals/archive/cursor-drift-analysis-2026-05-17.md`, `docs/development/CODE_QUALITY.md`, `docs/development/reviews/numinput-inventory-2026-05-01.md` | 2026-05-17T08:53:30Z | Fix NumInput caret drift — single restore path + digit-anchored exponent caret + Jest test |
| dev-string-length-dx | `PianoidCore/pianoid_middleware/parameter_manager.py`, `PianoidCore/tests/integration/test_length_dx_propagation.py` | 2026-05-17T10:05:00Z | Fix: granular `length` edit must recompute + send `dx` to GPU |
