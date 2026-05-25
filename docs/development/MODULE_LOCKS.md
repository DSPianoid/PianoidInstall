# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

<!-- dev-modal-mass-p2 locks RELEASED 2026-05-24 at Step 10a Phase 1.
     Phase 2 of Modal Mass + Q-factor improvement plan committed on
     feature/dev-modal-mass-p2 (PianoidCore + PianoidTunner) + docs
     commit on master (PianoidInstall). NOT merged to dev yet —
     awaits user verification (Phase 2 wrap-up). Files: 4 PianoidCore
     orchestration files (modal_mass_orchestrator.py NEW + 3 facade
     edits), modal_mass/ kernels (3 NEW), 4 test files (NEW), 4
     PianoidTunner files (ModalMassPanel + useModalMass NEW +
     ModalAdapter.jsx edit + Jest test NEW). -->
| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|

<!-- dev-mmui-6e97 round 2 locks RELEASED 2026-05-25 at Step 10a Phase 1.
     Modal Mass UI round 2 fixes committed on the existing
     feature/dev-mmui-6e97 (PianoidTunner: round-2 commit TBD on top of
     round-1 d616fb7). PianoidInstall docs commit on master. NOT merged
     to dev yet — awaits user verification (live browser test of moved
     checkbox + new toolbar button + progress banner). 18 new Jest
     tests (15 useModalMassRun + 3 chart in-progress); full 727-test
     suite green (64 suites). Backend untouched. -->


<!-- dev-mmui-6e97 round 1 locks RELEASED 2026-05-25 at Step 10a Phase 1.
     Modal Mass UI refactor committed on feature/dev-mmui-6e97 (PianoidTunner d616fb7).
     PianoidInstall docs commit on master. NOT merged to dev yet — awaits user
     verification (live testing on PlyWoodLGtemp1 dataset). 22 new Jest tests
     pass; full 709-test suite green. Backend untouched (PianoidCore unchanged). -->

<!-- dev-frf-q-phase01 locks RELEASED 2026-05-24 at Step 10a Phase 1.
     Phase 0 + Phase 1 of Modal Mass + Q-factor improvement plan
     committed on feature/dev-frf-q-phase01 + merged to dev on both
     repos. PianoidCore: 9c35c4f → ddbf997 (merge). PianoidTunner:
     3f41819 → c472997 (merge). PianoidInstall docs: 07508e4. NOT
     pushed (awaits user verification). -->

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

