# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-c807 | `PianoidTunner/src/components/StabilizationDiagram.jsx`, `PianoidTunner/src/components/GridHeatmapInset.jsx`, `PianoidTunner/src/components/ModalResultsView.jsx`, `PianoidTunner/src/components/GridLayoutEditor.jsx`, `PianoidTunner/src/components/ProjectInfoCard.jsx`, `PianoidTunner/src/hooks/useModalAdapter.js`, `PianoidTunner/src/modules/ModalAdapter.jsx` | 2026-05-04T21:18:00Z | Modal Adapter tracking results UI: 5 bugs + 2 features (grid mismatch warning + project chip; square heatmap; chain export selector; manual connect; hover/header annotations; unfreeze tracking settings) |
| dev-d773 | `PianoidCore/pianoid_middleware/modal_adapter/esprit/mode_tracking.py`, `PianoidCore/tests/unit/test_mode_tracking.py`, `docs/development/MODE_TRACKING_REDESIGN.md` (or new `MODE_TRACKING_SUBCLUSTER_MERGE.md`) | 2026-05-04T21:25:18Z | Mode tracking — handle coherent sub-cluster inside over-broad chain (tmp8c7q0lu0 chain 7 vs chain 8). Pending design selection. |
