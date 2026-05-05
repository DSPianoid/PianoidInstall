# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-3151 | PianoidCore/pianoid_middleware/modal_adapter/scenario_averager.py, PianoidTunner/src/components/QCVisualizationPanel.jsx (new), PianoidTunner/src/components/__tests__/QCVisualizationPanel.test.jsx (new), PianoidCore/tests/unit/test_qc_curves.py (new), docs/modules/pianoid-middleware/REST_API.md | 2026-05-05T18:40Z | QC Visualization Panel — exclusive lock on additive-new files only. SHARED FILES with dev-db2e (modal_adapter.py / routes.py / useModalAdapter.js / ModalAdapter.jsx / MODAL_ADAPTER_GUIDE.md): planned changes are PURELY ADDITIVE (new function / new endpoint / new hook export / new JSX block insert / new doc subsection). Coordination strategy: defer touching shared files until after Step 3 planning report → orchestrator decides serialisation vs additive-merge. |
