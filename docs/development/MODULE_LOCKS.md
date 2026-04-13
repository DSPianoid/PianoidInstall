# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-03db | `PianoidTunner/src/hooks/useModalAdapter.js`, `PianoidTunner/src/modules/ModalAdapter.jsx`, `PianoidTunner/src/components/EspritConfig.jsx`, `PianoidCore/pianoid_middleware/modal_adapter/__init__.py` | 2026-04-13T09:28:00Z | Modal Adapter Phase 5 cleanup |
