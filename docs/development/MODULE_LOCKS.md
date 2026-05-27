# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
<!-- dev-ratiochart locks RELEASED 2026-05-24 at Step 10a Phase 1 commit. Held (CFL chart Part 1, frontend):
     newWindowChart.jsx, NEW src/utils/chartOption.js, NEW src/utils/__tests__/chartOption.test.js.
     Committed on PianoidTunner feature/cfl-stability-chart (0a3973f). Full Jest 62/693 PASS, 0 regressions.
     NOT merged — branch awaits user test + approval. Part 2 (PianoidCore chartFunctions.py +
     chart_config.json) PENDING, blocked on the CFL guard merge to PianoidCore dev (needs dev-cfl getters;
     avoids working-tree collision). See WORK_IN_PROGRESS.md deferred follow-up #1. -->
<!-- dev-cfl-3 (v1) locks RELEASED 2026-05-26: v1 impl committed to feature/cfl-stability-guard (13b68dd); superseded by v2. -->
<!-- dev-cfl-v2 locks RELEASED 2026-05-26 at Step 10a Phase 1 commit. Held (CFL stability guard v2, host-side):
     PianoidCore pianoid_middleware/parameter_manager.py, pianoid.py, backendServer.py, NEW cfl_stability.py,
     NEW tests/system/test_cfl_stability_guard.py, NEW tests/unit/test_cfl_amp.py. Committed on
     feature/cfl-stability-guard-v2 (off dev); docs (SYNTHESIS_ENGINE, REST_API, TESTING, proposal archive-move),
     session log, and dev-cfl-* diagnostics on root master. Fresh --heavy build verified (dead v1 getters gone);
     27/27 tests green (16 unit + 11 system incl. 2 route-level regressions); live note_playback pitch-57 = SUSTAIN
     (click gone). Two route-level bugs found+fixed during live verify (stability_ratio jsonify-sort 500 → str keys;
     CflRejected → 400+cfl_redline handler, was a 416). NOT merged — branch awaits the user's final live re-test + approval. -->
<!-- dev-ratiochart's PianoidTunner-only locks (above) do not collide with these PianoidCore files. -->
<!-- dev-cfl locks RELEASED 2026-05-24 at Step 10a Phase 1 commit. Held (CFL stability guard):
     Kernels.cu, Kernels.cuh, constants.h, Pianoid.cu, Pianoid.cuh, Pianoid_synthesis.cu,
     Pianoid_parameters.cu, Pianoid_debug.cu, AddArraysWithCUDA.cpp, Pianoid_internal.cuh (locked
     precautionarily, not edited), pianoid.py, parameter_manager.py, backendServer.py,
     tests/system/test_cfl_stability_guard.py. Committed on feature/cfl-stability-guard (PianoidCore
     2a37faa); docs/diagnostics/log on root master. NOT merged — branch awaits the user's test + approval. -->
<!-- dev-vpnoteoff lock RELEASED 2026-05-27 at Step 10a Phase 1 commit. Held: PianoidTunner/src/components/VirtualPiano.js. Committed on feature/vp-noteoff-fix (f3ce378); 62/693 Jest PASS. NOT merged — awaits user test + approval. -->
| <!-- (none active) --> | | | |
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

