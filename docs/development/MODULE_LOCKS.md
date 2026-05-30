# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-7032 | `PianoidCore/pianoid_middleware/chartFunctions.py`, `PianoidCore/pianoid_middleware/chart_config.json`, `PianoidCore/tests/unit/test_cfl_ratio_chart.py` (new), `docs/development/diagnostics/dev-7032-cfl-courant-varies.py` (new) | 2026-05-30T10:15:00Z | ★REVISED (plot Courant, not max\|g\|). ★HELD UNCOMMITTED (task: STOP before commit) — locks RETAINED to keep the committed-or-locked invariant on the held dirty files. CFL ratio chart `cfl_ratio` / `cfl_ratio_function` in chart_config.json + chartFunctions.py — pure-Python per-pitch **Courant number** via `pianoid.param_manager._pitch_upload_amp` (the SAME host closed-form the live gate uses; NOT max\|g\|, which is flat); redline 1.0 + CFL_MARGIN reference via render_hints; per-point colour = gate's is_stable_with_margin decision. On `feature/cfl-test-on-p1fix`. Verified 13/13 unit (mocked param_manager, no engine) + real-preset Courant-varies proof (dev-7032-cfl-courant-varies.py, BaselinePreset1, no GPU) + registry E2E. cfl_stability.py NOT modified (only called). FRONTEND `chartOption.js` thresholds-array extension COMMITTED on PianoidTunner `feature/cfl-stability-chart` (5e5d546) via a worktree (main tree untouched) — lock RELEASED; renderer is generic so the Courant switch needs NO FE change. ★NOMINAL COEXISTENCE with PAUSED dev-soundint-live's lock on chartFunctions.py/chart_config.json: its edits are STASHED (stash@{0}=26799bf) on branch `feature/soundint-readback`, NOT present here. NOT disturbing dev-eac2's CFL edits (backendServer/cfl_stability/parameter_manager/pianoid.py) or preset files. NO CUDA build. Awaiting user live test + commit/merge decision. |
| dev-eac2 (continues dev-395e) | `PianoidCore/pianoid_middleware/parameter_manager.py`, `PianoidCore/pianoid_middleware/pianoid.py`, `PianoidCore/pianoid_middleware/backendServer.py`, `PianoidCore/pianoid_middleware/cfl_stability.py` | 2026-05-30T06:26:00Z | CONTINUE CFL guard v2 (user REDIRECT + REVISION 2717). (A) REVERTED bulk gating (granular-only gate restored). (B) Documented the TRUE 2-path upload architecture (granular + bulk; send_updated_params_to_CUDA = init bulk variant). (C→revised) USER REVISION 2717: added a SAFETY MARGIN `CFL_MARGIN=0.99` on the Courant number (coeff_tension − 8·coeff_bending) in cfl_stability.py (new `is_stable_with_margin`/`amp_and_courant_for_pitch_strings`/`courant_number`), wired into the GRANULAR gate only (bulk stays ungated); + CONFIRMED Strings-panel tension routes to the granular gated method. cfl_stability.py exact math (max_amplification/is_stable_amp) UNCHANGED. Pure-Python verified (margin boundary exactly 0.99; 16/16 unit). On feature/cfl-test-on-p1fix. NOT touching usePreset.js (dev-8085), presets, or tools/*.ps1. NO CUDA build. STOP before commit — held for user live retest. |
<!-- dev-427c locks RELEASED 2026-05-29 by the sync wrap-up (completing dev-427c's halted Step 10).
     Held: PianoidCore Pianoid.cuh, Pianoid_synthesis.cu, Pianoid_presets.cu, UnifiedGpuMemoryManager.cu,
     UnifiedGpuMemoryManager.h. P1-1 GPU-pointer authority-race fix (engine sole-writer of the swappable
     TUNABLE sub-pointers via release/acquire publish/consume). USER-VERIFIED live (55/56/57 trichotomy
     GONE, no recurrence); race measured 1842→0 mid-cycle mutations; 5/5 perf + 11/11 functional.
     COMMITTED PianoidCore feature/p1-authority-fix `80fc9ed` (+90/-20) and MERGED to dev `a352b2f`
     (--no-ff). Docs (SYSTEM_OVERVIEW/MEMORY_MANAGEMENT/PARAMETER_SYSTEM/DATA_FLOWS/CODE_QUALITY +
     bug-55-56-57 §7b) + diagnostic dev-427c-p1-authority-race-stress.py + session log committed on root
     master by the same sync. stash@{0}=26799bf (dev-soundint-live) NOT popped/touched. Other feature
     branches untouched. NOT pushed yet (awaiting user push-confirm). -->
| dev-8085 | `PianoidTunner/src/components/ToolBar.jsx`, `PianoidTunner/src/hooks/usePreset.js` | 2026-05-29T13:20:00Z | Lower default preset-load volume 120→100 (user request). Frontend-only, no rebuild. Committed THIS SYNC on PianoidTunner `feature/lower-default-volume-100` ONLY (NOT merged, NOT pushed — held for user approval). (Diagnostic rig files + backendServer.py/pianoid.py instrumentation RELEASED — instrumentation reverted to clean source; rig .py are committed-free diagnostics under docs/.) |
| dev-8085 | `PianoidTunner/src/components/ToolBar.jsx`, `PianoidTunner/src/hooks/usePreset.js` | 2026-05-29T13:20:00Z | Lower default preset-load volume 120→100 (user request). Frontend-only, no rebuild. (Diagnostic rig files + backendServer.py/pianoid.py instrumentation RELEASED — instrumentation reverted to clean source; rig .py are committed-free diagnostics under docs/.) |
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
| dev-3580 | `PianoidCore/pianoid_cuda/Pianoid_excitation.cu` | 2026-05-28T19:09:39Z | Diagnostic NOTE_OFF_PROBE in `_add_string_for_playback` for live note-off bisect (NOT a real fix). Tree is now CLEAN (PianoidCore detached @67148fa); the probe is PRESERVED in `stash@{0}` = `26799bf` alongside the dev-soundint-live work. NOT to be merged to `dev`. Kept (not discarded) for the ongoing static review per the 2026-05-29 USER CORRECTION. |
| dev-soundint-live (PAUSED — agent shut down 2026-05-29 at user request; lock RETAINED to protect preserved work) | `PianoidCore/pianoid_cuda/Pianoid.cuh`, `PianoidCore/pianoid_cuda/Pianoid.cu`, `PianoidCore/pianoid_cuda/Pianoid_debug.cu`, `PianoidCore/pianoid_cuda/AddArraysWithCUDA.cpp`, `PianoidCore/pianoid_cuda/Pianoid_synthesis.cu`, `PianoidCore/pianoid_cuda/MainKernel.cu`, `PianoidCore/pianoid_middleware/chartFunctions.py`, `PianoidCore/pianoid_middleware/chart_config.json` | 2026-05-29T13:08:00Z | ★PAUSED. Work is now PRESERVED IN STASH `stash@{0}` = `26799bf` (stashed by dev-35a3 2026-05-29 for a clean bisect tree; PianoidCore tree is detached @67148fa, clean). NOT committed, NOT reverted, NOT merged to `dev`. ★USER CORRECTION 2026-05-29: the 55/56/57 trichotomy is REAL (not artifact, not probe-induced) — so this readback hook + probes are KEPT for the ongoing static review, but the hook has a known readback bug and the probes are stale, so they MUST NOT be merged to `dev` as-is. ★KEY RESULT: post-volume OVERFLOW REFUTED by direct kernel probe (mvc=7.99902e8 exact; soundInt ±6e6 ≈ 340× UNDER INT32 rail; engine CLEAN at vol=100). The 97.6%/47.6%-railed M1/M2 were a READBACK BUG (layout mismatch: kernel writes dev_soundInt at stride samplesInCycle, hook reshape used mode_iteration; cudaMemset zero-fill didn't fix it). TODO before any merge/use: fix readback to valid-extent copy + REVERT the TEMP kernel probe printf @ MainKernel.cu:492. NEXT PHASE: build-and-test bisect from the 05-10 baseline (needs a clean tree → reconcile this uncommitted work first). DAMPER_PROBE (Pianoid_synthesis.cu) + dev-3580 NOTE_OFF_PROBE (Pianoid_excitation.cu) untouched. ORIGINAL TASK: POST-volume `dev_soundInt` readback hook + H1/H2 discriminators. soundInt ring + `getRawSoundRecordInt()` + pybind + `sound_int` chart (mirror of soundFloat ring) + `getMainVolumeCoefficient()` getter + TEMP kernel probe at MainKernel.cu:492 printing (output, mvc, Sint32) ch0 first cycles (REVERT after H1/H2 pinned). On feature/soundint-readback (off dev @ 67148fa). `Pianoid_synthesis.cu`+`MainKernel.cu` team-lead authorized (my stack now, no user gate). DAMPER_PROBE/NOTE_OFF_PROBE untouched. |
<!-- damper-probe-ea77 lock RELEASED 2026-05-29 at Step 10a Phase 1 (lightweight).
     Held: PianoidCore/pianoid_cuda/Pianoid_synthesis.cu — DAMPER_PROBE inserted (+7 lines)
     at the existing UPLOAD_PROBE site (around line 204-210). Probe LEFT IN SOURCE for ongoing
     investigation (not reverted, not committed). Backend kept alive (orchestrator drove the
     reproduction directly; PID 80416 on port 5000 SDL3).
     Result: damper_string[201..203] = 3.6e-05 (matches preset, NOT zero) → H_A (damper-wipe) refuted.
     H_B (mode ringout) is the leading follow-up hypothesis.
     Log: docs/development/logs/damper-probe-ea77-2026-05-29-210147.md (kept open in logs/, not archived). -->

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

