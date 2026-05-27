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
<!-- dev-asiocrash-b20f locks RELEASED 2026-05-27 at Step 10a Phase 1.
     CoInitializeEx(COINIT_APARTMENTTHREADED) in PianoidUnifiedPlaybackThread
     fixes 2nd-/load_preset ASIO crash. ASIO printf -> PLOG hygiene.
     Launcher captures backend stdout to PianoidCore/logs/backend_stdout.log.
     Live-verified: 3 x /load_preset adt=4 healthy + mic FFT SNR 24.0x/7.3x/10.4x
     for pitches 60/67/72 vel=100. PianoidCore commit 5d297a6,
     PianoidTunner commit 735d523. PianoidInstall docs + log on master. -->
<!-- dev-mstat-30b6 locks RELEASED 2026-05-26 at Step 10a Phase 1.
     Per-chain mass_inversion_status field on modal mass (enum:
     valid / insufficient_band_width / no_full_row / only_unmapped_full_row).
     Committed on feature/dev-mstat-30b6 (PianoidCore 39798bc + PianoidTunner
     7dc9763). PianoidInstall master commit pending — docs + session log +
     verify script. NOT merged yet — orchestrator merge sweep will handle.
     +17 backend tests (181/181 PASS in modal_adapter + external_export
     sweep), +9 frontend tests (37/37 PASS on touched suites). Live verified
     on LG_p3 via docs/development/diagnostics/dev-mstat-30b6-verify.py:
     classifier output matches the audit exactly — 386 valid / 242
     insufficient / 126 no_full_row / 3 only_unmapped out of 757 chains. -->
<!-- dev-collreorg-7a3f locks RELEASED 2026-05-26 at Step 10a Phase 1.
     Collection subpanel reorganization per proposal
     docs/proposals/collection-subpanel-reorg-2026-05-26.md — 6 commits on
     feature/dev-collreorg-7a3f (PianoidTunner): 54ccc25 Step 1
     SECTIONS_WITH_SETTINGS gate, 4c52d5b Step 2 CollectionSettingsPanel
     extraction, 6ad08f9 Step 3 useCollectionStatus hook + toolbar
     Start/Cancel, 80745df Step 4 default-true localStorage showSettings,
     287fdfb Step 5 Save All + gear Badge counter, 44a1617 Step 6 new
     tests + ModalAdapter architecture guards. Jest baseline 64 suites/739
     tests -> 66 suites/765 tests = +2 suites + +26 tests (11
     useCollectionStatus + 3 CollectionSettingsPanel + 12 architecture
     guards in lockSettings.test.jsx). Files: ModalAdapter.jsx (+177 net),
     CollectionSubpanel.jsx (+68 net), CollectionSettingsPanel.jsx NEW
     (+134), useCollectionStatus.js NEW (+162), 5 sub-section files +2
     each (additive onDirtyChange prop), 2 new test files, lockSettings
     test extended. CollectionToolbarActions.jsx + CollectionLog.jsx +
     CollectionSubpanel.test.jsx + CollectionLog.test.jsx locked-but-never-edited
     (CollectionToolbarActions inlined into ModalAdapter per Compute-Modal-Mass
     precedent; CollectionLog poll de-dup deferred to follow-up). PianoidCore +
     PianoidBasic untouched. Live verification deferred — test-ui blocked by
     PowerShell permission denial; full Jest suite + 12 architecture-guard
     source-text assertions cover the regression surface. NOT merged to dev
     yet — orchestrator handles the merge sweep per dispatch. Worked in
     dedicated worktree D:\repos\PianoidInstall\PianoidTunner-collreorg-wt
     to avoid shared-main-worktree collisions with dev-mstat-30b6 +
     dev-dlgrm-4b1a (Step 1 + Step 2 commits had to be cherry-picked /
     reconstructed once after another agent's git operations clobbered
     my HEAD — see session log "Worktree-sharing incident" section). -->


<!-- dev-dlgrm-4b1a locks RELEASED 2026-05-26 at Step 10a Phase 1.
     Delete dead dialogs + Copy-mode branch per proposal
     modal-adapter-dialog-review-2026-05-26.md §6.1 #7 + §6.4 #1, #2, #4.
     Committed on feature/dev-dlgrm-4b1a (PianoidTunner): 3 commits totalling
     -1880 LOC (CreateProjectDialog.jsx + test 937; EffectiveSignalLengthRerunDialog
     .jsx + test 825; ProjectBrowserDialog Copy-mode branch 118 net).
     Files: CreateProjectDialog.jsx + test (DELETED in 9391fb7),
     EffectiveSignalLengthRerunDialog.jsx + test (DELETED in dd5c8cf),
     ProjectBrowserDialog.jsx + test (edited in 4154b6c), ProjectSubpanel.jsx
     (1-line `mode="open"` removal in 4154b6c). Jest baseline 64 suites/739
     tests -> 62 suites/694 tests; -2 suites + -45 tests = exactly the deleted
     test count (-25 CreateProjectDialog + -16 ESL + -4 Copy-mode); no
     regression in surviving tests. NOT merged to dev yet — orchestrator
     handles the merge sweep per dispatch. PianoidCore + PianoidBasic
     untouched. Heads-up: orphaned hook methods (importProject, copyProject,
     reaverageProject, fetchEffectiveSignalLength in useProjectCRUD.js +
     useModalAdapter.js facade) confirmed orphaned at production-caller
     level — deletion deferred to a separate /dev session per proposal §8 #2. -->

<!-- dev-mmexp2-f492 locks RELEASED 2026-05-26 at Step 10a Phase 1.
     Filter relative_modal_mass.txt to export set (matches omega_coef.txt
     selected_chains filter from build_export_payload) + drop NaN
     m_relative rows defensively. PianoidCore feature/dev-mmexp2-f492
     commit f6464cc. PianoidInstall master commit 3c5e919 (docs + log).
     NOT merged to dev yet — orchestrator merge-sweep will handle.
     +8 net new tests (71 -> 78 PASS in test_external_export.py;
     1 renamed). Live verified on D:/modal_projects/LG_p3: 386 data
     rows (was 757) with selected_chains=None, 6 data rows with an
     explicit 10-chain selection (4 of the 10 dropped by NaN drop —
     chain 5 was in the export set but had NaN m_relative). 0 NaN
     rows in any output. external_export.py crossed C4 RED at 1033
     LOC (was 993; +40); CODE_QUALITY.md updated. -->


<!-- dev-mmexp-5561 locks RELEASED 2026-05-26 at Step 10a Phase 1.
     Add relative_modal_mass.txt to Apply text export bundle.
     PianoidCore feature/dev-mmexp-5561 commit 9ad8ae1. PianoidInstall
     master commit 1c14dcd (docs + log). NOT merged to dev yet — awaits
     user verification / orchestrator merge sweep. 15 new tests
     (test_external_export.py 56 -> 71 PASS). Live verified on
     D:/modal_projects/LG_p3 — bundle now ships 8 files including
     relative_modal_mass.txt (757 rows, 386 finite m_relative + 371
     NaN; reference chain 312 @ 867.52 Hz m_relative=1.000000). -->


<!-- ana-madlg-7c2e lock RELEASED 2026-05-26 at Step 10a Phase 1.
     Proposal at docs/proposals/modal-adapter-dialog-review-2026-05-26.md
     (1071 LOC) committed on PianoidInstall master. Read-only /analyse; no
     code touched. Inventoried 20 dialogs (17 live + 2 dead + 1 shared
     reference) reachable from the Modal Adapter pane; cross-cutting
     analysis across 5 progress-UI patterns, 16 timeout sites, 2
     near-duplicate dialog pairs; consolidation roadmap with 8 quick
     wins / 8 medium refactors / 3 architectural changes / 6 code-quality
     reductions (~2000 LOC dead code identified for deletion). -->

<!-- ana-csub-4f12 lock RELEASED 2026-05-26 at Step 10a Phase 1.
     Proposal at docs/proposals/collection-subpanel-reorg-2026-05-26.md
     committed on master. Read-only /analyse; no code touched. -->


<!-- dev-cptmto-9d7e locks RELEASED 2026-05-25 at Step 10a Phase 1.
     Fix for 5-min hardcoded polling timeout in
     CreateProjectFromMeasurementDialog round-30 async path.
     Committed on feature/dev-cptmto-9d7e (PianoidTunner ee54470):
     POLL_MAX_MS bump 5min->60min + live mm:ss elapsed-chip + 10-min
     "still running" banner + improved timeout error message + 8 new
     Jest tests. Docs commit on PianoidInstall master pending:
     MODAL_COLLECTION.md async-path note, CODE_QUALITY.md God Objects
     update (file crossed 1000 LOC RED), WIP doc-gap entry for
     REST_API.md async surface. 37/37 dialog tests PASS; 64/64
     broader related Jest sweep PASS. PianoidCore untouched. NOT
     merged to dev yet — awaits user verification (live retry on the
     large measurement that triggered the original bug). -->

<!-- dev-msdel-3b1a locks RELEASED 2026-05-25 at Step 10a Phase 1.
     Fix for 5000 ms axios timeout on measurement-set deletion.
     Committed on feature/dev-msdel-3b1a (PianoidTunner 1a6a3de):
     useMeasurementCatalog.js timeout bump 5000->60000 + new Jest
     regression test. Docs commit on PianoidInstall master:
     MODAL_COLLECTION.md callout for the new timeout + the threaded=
     False / rmtree-cost rationale. PianoidCore untouched (backend
     handler was correct). 18/18 useMeasurementCatalog tests PASS;
     78/78 broader measurement-related Jest sweep PASS. Held files
     were the 4 candidates investigated; only 2 (useMeasurementCatalog
     .js + its Jest test) ended up edited. NOT merged to dev yet -
     awaits user verification (live browser test of delete from
     Measurements Management dialog). -->

<!-- dev-mmui-6e97 round 3 locks RELEASED 2026-05-25 at Step 10a Phase 1.
     Backend fix (get_project_state() data_status pass-through) +
     latent Rules-of-Hooks fix in ModalMassFreqChart.jsx + 4 backend
     integration tests + 3 frontend reactivity tests. Committed on
     feature/dev-mmui-6e97-r3 (PianoidCore) + feature/dev-mmui-6e97
     (PianoidTunner) + docs commit on PianoidInstall master. NOT
     merged to dev yet. Backend tests 4/4 PASS + related modal_adapter
     sweep 142/142 PASS. Frontend 64 suites / 730 tests PASS. -->


<!-- dev-frfres-9c41 locks RELEASED 2026-05-25 at Step 10a Phase 1.
     Fix for v2 open_project not setting ctx.source_folder (caused FRF
     resolver to return None → "No usable measurement source folder
     for FRF" on every measurement-backed v2 project). Committed on
     feature/dev-frfres-9c41 (PianoidCore) + docs commit on
     PianoidInstall master. NOT merged to dev yet — awaits user
     verification (live browser test of Compute Modal Mass toolbar
     button on PlyWoodLGtemp1_p4). New regression test
     test_v2_open_project_source_folder.py PASS (2/2); related v2 +
     FRF suites untouched (41/41 PASS). Live repro on real _p4 data
     confirmed pre-fix=None, post-fix=D:\modal_measurements\PlyWoodLGtemp1.
     Files: scenario_loader.py (24-line addition), new regression
     test, MODAL_COLLECTION.md doc edit, diagnostic script. -->


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

