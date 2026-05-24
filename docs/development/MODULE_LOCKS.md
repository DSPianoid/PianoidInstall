# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-frf-q-phase01 | `PianoidCore/pianoid_middleware/modal_adapter/project_context.py`, `PianoidCore/pianoid_middleware/modal_adapter/esprit_runner.py`, `PianoidCore/pianoid_middleware/modal_adapter/modal_adapter.py`, `PianoidCore/pianoid_middleware/modal_adapter/apply_service.py`, `PianoidCore/pianoid_middleware/modal_adapter/frf_orchestrator.py` (NEW), `PianoidCore/pianoid_middleware/modal_adapter/qc/__init__.py` (NEW), `PianoidCore/pianoid_middleware/modal_adapter/qc/log_decrement_xcheck.py` (NEW), `PianoidCore/pianoid_middleware/modal_adapter/routes/pipeline_routes.py`, `PianoidTunner/src/components/ModalResultsView.jsx`, `PianoidCore/tests/integration/modal_adapter/test_frf_orchestrator.py` (NEW), `PianoidCore/tests/integration/modal_adapter/test_qc_log_decrement.py` (NEW), `PianoidCore/tests/integration/modal_adapter/test_quality_factor_surface.py` (NEW), `PianoidTunner/src/components/__tests__/ModalResultsView.qColumn.test.jsx` (NEW) | 2026-05-24T10:58:30Z | Modal Mass + Q-factor Phase 0 + Phase 1: Q surfacing, Hilbert log-dec, FrfOrchestrator + raw_recordings H1 + force window + NPZ persistence + REST endpoints + data_status |
<!-- dev-preset-bugs locks RELEASED 2026-05-23 at Step 10e wrap-up. Held: usePreset.js,
     useSoundChannels.js, PianoidTuner.js, useBackendProcess.js on feature/preset-1-leak-trace.
     Finding A (mount-race) committed 06cf96b + 0d31856. #1 string-param working-copy leak FIXED +
     live-verified (strings back-sync dep-array: drop parametersOfStrings + changeParametersOfStrings)
     committed 908a6c5; docs/log/screenshot on root master e3d2677. [#1-trace] stripped (0 markers).
     Full Jest 61/681 PASS. Stack DOWN (3000/3001/5000/5001 clear). NOT merged — branch awaits the
     user's test + approval. -->
| <!-- (none active) --> | | | |
<!-- dev-preset-bugs locks RELEASED 2026-05-23 at Step 10a wrap-up (user-approved merge). Held:
     ToolBar.jsx, useHotkeys.js, PianoidTuner.js, usePreset.js — all committed on
     feature/preset-library-bugs (99bed57, b7af146, bbe8638) and MERGED to PianoidTunner `dev` via
     984434a (--no-ff, local, NOT pushed; feature branch kept). useSoundChannels.js had only TEMP
     trace (stripped, never committed). #2/#3/#4 user-verified; #1 fix merged, live re-verify still
     pending the user's fresh post-restart test. Session log archived to logs/archive/. -->
<!-- dev-voice-docs lock RELEASED 2026-05-22 at Step 10a Phase 1 commit (voice-I/O durability + setup docs). Held: tools/tts_voice.py, tools/apply_telegram_voice_patch.py, tools/server.ts.voicepatch.diff (all new), docs/guides/TELEGRAM_CHANNEL_SETUP.md, mkdocs.yml. -->
<!-- dev-maimport round 30 lock RELEASED on 2026-05-22 after commits
     PianoidCore f1b5197 + PianoidTunner 9778416 landed on
     feature/dev-maimport-import. Held files: measurement_import.py,
     measurement_routes.py, modal_adapter.py, scenario_averager.py,
     routes/project_routes.py, NEW import_session.py, NEW
     test_round30_import_session.py (PianoidCore); NEW
     ImportScenariosDialog.jsx, NEW useImportSession.js, NEW
     ImportScenariosDialog.test.jsx, DELETED
     MeasurementImportDialog.jsx + tests, DELETED
     AddScenariosToMeasurementDialog.jsx + tests, MeasurementSelector.jsx
     (comment-only), MeasurementsManagementDialog.jsx,
     CollectionSubpanel.jsx, useProjectCRUD.js,
     CreateProjectFromMeasurementDialog.jsx (PianoidTunner). -->

