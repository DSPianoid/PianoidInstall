# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-b0d3 | `PianoidCore/pianoid_middleware/modal_adapter/modal_adapter.py`, `PianoidTunner/src/hooks/useModalAdapter.js`, `PianoidTunner/src/modules/ModalAdapter.jsx` | 2026-04-13T01:45:00Z | Fix ESPRIT config persistence + project switch stuck |
