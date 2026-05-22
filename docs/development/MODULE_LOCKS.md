# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-maimport | `PianoidCore/pianoid_middleware/modal_adapter/modal_adapter.py`, `PianoidCore/pianoid_middleware/modal_adapter/measurement_import.py`, `PianoidCore/pianoid_middleware/modal_adapter/scenario_averager.py`, `PianoidCore/pianoid_middleware/modal_adapter/measurement_routes.py`, `PianoidCore/pianoid_middleware/modal_adapter/import_session.py` (NEW round 30), `PianoidCore/tests/integration/test_round30_import_session.py` (NEW round 30), `PianoidTunner/src/components/MeasurementImportDialog.jsx` (round 30 — TO BE DELETED), `PianoidTunner/src/components/AddScenariosToMeasurementDialog.jsx` (round 30 — TO BE DELETED), `PianoidTunner/src/components/ImportScenariosDialog.jsx` (NEW round 30), `PianoidTunner/src/hooks/useImportSession.js` (NEW round 30), `PianoidTunner/src/components/__tests__/ImportScenariosDialog.test.jsx` (NEW round 30), `PianoidTunner/src/components/CollectionSubpanel.jsx` (round 30 — mount-point swap), `PianoidTunner/src/components/MeasurementsManagementDialog.jsx` (round 30 — mount-point swap), `PianoidTunner/src/components/CreateProjectFromMeasurementDialog.jsx` (round 30 — Q6 polling wiring) | 2026-05-22T18:00:00Z | Round 30 — consolidate Import dialogs, polling progress, scenario selection, conflict resolution |
