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
<!-- dev-mtxfix locks RELEASED 2026-06-05 at Step 10a (team-lead-approved single batch wrap + push). Held:
     PianoidTunner MatrixTools.jsx/.css + __tests__/MatrixTools.theme.test.jsx (deleted), SoundChannelsPane.jsx,
     MeasuredMatrix.jsx, RowEditor.js, hooks/useSettings.js + 2 test files (RowEditor.axisVariant.test.jsx new +
     SoundChannelsPane.localChannel.test.jsx). Matrices-UI live-fix batch: (1) REVERT M1 dark-theme toolbar
     (restore raster icons + #ddd light bg = visible edit buttons; deleted M1-only theme test); (2) PART 3 SC pitch
     control still showed a keyboard after Rotate — bottom RowEditor ruler ignored axisVariant; threaded axisVariant
     MeasuredMatrix->RowEditor + FlatBarAxis for channel rows; (3) PART 4 SC per-channel matrix chart rendered as a
     LINE — soundChannelSettings.visualization='line' (aggregate-only default, pre-existing from dev-drawable-sc
     Wave 3) leaked into MeasuredMatrix's RowEditor; SoundChannelsPane now overrides visualization='bar' for the
     matrix path (aggregate keeps 'line'); corrected the misleading useSettings comment. All other dev-uimtx work
     (C1/H1/H2/H3/M3/bar-chart/clip) intact. Full Jest 83 suites/903 tests green; frontend-only, NO build.
     PianoidTunner feature/dev-mtxfix-revert-m1 278ee39 MERGED to dev e2aaacf (--no-ff). Docs (OVERVIEW RowEditor
     row + WIP matrix-zoom gap follow-up) + session log on PianoidInstall master. Pushed to origin. -->
| <!-- (none active) --> | | | |
<!-- dev-steinway-preset locks RELEASED 2026-06-05 at Step 10a Phase 2 (user-approved SHIP option A). Held:
     PianoidCore/pianoid_middleware/presets/Belarus_196modesC_Steinway1860 (NEW),
     .../Belarus_196modesC_Steinway1860_56SM (NEW), pianoid_middleware/auto_tuner.py,
     tests/unit/test_auto_tuner_robust.py (NEW). 2 Steinway 1860 mensur presets (full 88-key 58-block +
     56-SM 84-key trim) + robust harmonic-comb FrequencyTuner (R1 adaptive window/zero-pad, R2 comb f0,
     R3 comb-consistency confidence [deleted the 0.5 floor], R4 inharmonic stretched comb + treble window).
     Committed feature/steinway-1860-presets f30ba32 + 5655f02, MERGED to dev 7394188 (--no-ff, branch kept).
     NOT pushed (/sync handles origin reconcile + push-all). Regression: test_auto_tuner_robust 14/14 +
     test_tune_pipeline 59/59. Source preset Belarus_196modesC was READ-ONLY (untouched). -->
| <!-- (none active) --> | | | |
<!-- dev-asioload locks RELEASED 2026-06-03 at Step 10a Phase 2 (recovery wrap of the orphaned 2026-06-02 HOLD,
     same agent ID; user-approved merge + Phase 2 via Telegram). Held: PianoidCore/pianoid_cuda/Pianoid.cu,
     Pianoid.cuh, AddArraysWithCUDA.cpp, pianoid_middleware/backendServer.py, tests/system/test_asio_fallback.py (new).
     ASIO→SDL3 auto-fallback (option B) + USER-VISIBLE warning. C++: startAudioDriver() catches the ASIO init throw →
     reconstructs SDL3 (createDriverWithType(SDL3, chunks=16)+setupCuda+init); engine records requested/active driver +
     reason (engine = sole writer, P1); rethrows on non-ASIO failure OR if the SDL3 fallback ALSO fails (fail-fast S5).
     pybind getters (didAudioDriverFallback/getRequestedDriverType/getActiveDriverType/getAudioDriverFallbackReason) in
     AddArraysWithCUDA.cpp. Middleware: /health `audio_driver_fallback` dict + WS lifecycle push (mirrors cfl_redline
     precedent, same _audio_driver_fallback_status() helper). pianoid.py was locked then RELEASED 2026-06-02T19:22Z —
     no edit needed (fallback fully in C++). --heavy --release build verified (4 getters bound into correct-venv .pyd).
     END-TO-END VERIFIED on this no-ASIO machine: /health audio_driver_active=TRUE + audio_driver_fallback dict
     populated (occurred:true, requested:ASIO_CALLBACK, active:SDL3); engine isAudioDriverActive()=True / didFallback=True;
     test_asio_fallback.py 3/3; perf 5/5 + sound_regression PASS (synthesis byte-identical). COMMITTED PianoidCore
     feature/asio-sdl-fallback `3ef4e69` (5 files +330/-3), MERGED to dev `b88a627` (--no-ff). Feature branch KEPT.
     NOT pushed (local dev was 5 behind origin/dev — origin reconciliation deferred to orchestrator/user, same
     "LANDED VIA PULL MERGE" pattern as dev-7032/dev-eac2). Docs (AUDIO_DRIVERS/REST_API/STARTUP_TROUBLESHOOTING/
     TESTING) + session log on root master (9ab2571 + this Phase-2 bookkeeping commit). DEFERRED follow-up: Layer 3
     (PianoidTunner FE warning chip consuming the WS audio_driver_fallback field) is UNBUILT — correctly deferred while
     the FE tree was held by dev-blur; now an UNBLOCKED clean follow-up since PianoidTunner dev is clear (dev-blur
     COMPLETED 2026-06-03 @234e1b9). NO PianoidTunner edits this session. Session log archived to logs/archive/. -->
<!-- dev-3580 lock RECONCILED 2026-06-03 by dev-asioload (STALE — guards nothing). The active `| dev-3580 |` row that
     stood below on PianoidCore/pianoid_cuda/Pianoid_excitation.cu has been removed. Its content was a diagnostic
     NOTE_OFF_PROBE in `_add_string_for_playback` (a live note-off bisect probe, explicitly NOT a real fix and NOT to be
     merged to dev). The probe was preserved ONLY in `stash@{0}` = `26799bf` (alongside the dev-soundint-live work) —
     and that stash/branch/commit are VERIFIABLY GONE (confirmed by the dev-soundint-live RELEASED comment + the
     2026-05-30/05-31 verification: `git stash list` carries no soundint entry, `git branch -a | grep -i soundint`
     empty, `git cat-file -t 26799bf` → "Not a valid object name"). The 55/56/57 trichotomy this probe was investigating
     was independently RESOLVED by dev-427c (P1-1 GPU-pointer authority race, merged to PianoidCore dev `a352b2f`). With
     the protected stash gone and the bug resolved, the row protects nothing and is reconciled to this comment. The
     PianoidCore tree is clean on dev (Pianoid_excitation.cu committed-clean — no orphaned probe in the working tree). -->
<!-- dev-blur locks RELEASED 2026-06-03 at Step 10a Phase 2 (recovery wrap, user-approved full merge).
     Held: PianoidTunner NumInput/NumInput.js, Mode.jsx, Strings.jsx, GaussCell.jsx,
     ToolBar.jsx, NumInput/__tests__/numInput.blur.test.jsx (new),
     __tests__/ToolBar.commitKey.test.jsx (new). NumInput persist-on-blur: shared
     commitValue(rawString) (Enter+blur), handleBlur decision table, optional commitKey
     edit-identity guard (+editKeyRef). All 4 Group-1 callers wired — Mode/Strings (commitKey=key),
     GaussCell (`${level}-${chart}-${name}`), ToolBar (composite of selectedParameter
     groupe/name/gaussIndex/levelValue + pitch/mode, on the shared selected-param NumInput).
     Committed PianoidTunner feature/numinput-persist-on-blur 76a56fd (7 files, +471/-67),
     MERGED to PianoidTunner dev 234e1b9 (--no-ff). Feature branch KEPT. NOT pushed (PianoidTunner
     dev is local-only since dev-numsplit). Full Jest 70/830 → 71/834 (+1 suite ToolBar.commitKey /
     +4 tests; ZERO regressions); 0 new eslint warnings on changed files. Docs (OVERVIEW NumInput row +
     CODE_QUALITY God Objects NumInput.js RED rank 16 @1036 + P2-1 config-editor split named) already
     updated by the prior dev-blur session; recovery verified accuracy. FRONTEND-ONLY, NO CUDA/backend,
     no servers started (Jest jsdom). PianoidCore untouched (off-limits — on dev-asioload's
     feature/asio-sdl-fallback). Session log archived to logs/archive/. -->
<!-- dev-8085 locks RECONCILED 2026-06-03 by dev-blur (STALE — the 2 active `| dev-8085 |` rows that
     stood here are now removed). Per the dev-df69 consolidation (2026-05-31, comment further below):
     feature/lower-default-volume-100 (120→100 default preset-load volume) is an ANCESTOR of PianoidTunner
     dev (usePreset.js:152 default = 100, merged at 2d23254; ToolBar.jsx volume change history 88a016f) —
     the work shipped, the rows were orphaned leftovers the consolidation noted ("2 duplicate rows
     collapsed") but never deleted. dev-blur legitimately re-acquired + released ToolBar.jsx this session
     (persist-on-blur commitKey wiring) and usePreset.js is committed-clean on dev, so reconciling both
     dev-8085 files into this single RELEASED comment is in-scope. Held files were: ToolBar.jsx,
     usePreset.js. Tree clean. -->
<!-- dev-numsplit locks RELEASED 2026-06-01 at Step 10a Phase 1 commit (user-approved, live-tested "works"). Held:
     PianoidTunner/src/components/NumInput/NumInput.js + numInputMath.js (new) + useNumInputCaret.js (new) +
     __tests__/numInputMath.test.js (new). NumInput god-object split 1555 RED → 995 YELLOW (review R-1):
     pure math (formatNumber/anchorExponentCaret/getStepFromCursorPosition/computeExponentStep/getInputTitle/
     generateUniqueId) → numInputMath.js; caret machinery → useNumInputCaret hook; arrow-handler + config-commit
     dedup in-component. Public prop API byte-identical. Committed PianoidTunner feature/numinput-split c8edfa1
     (+962/-829, 4 files). Full Jest 68/795→69/820 (zero regressions); 3 files eslint-clean. Docs (CODE_QUALITY
     God Objects RED→YELLOW + OVERVIEW NumInput row) + session log on root master. MERGED to PianoidTunner dev
     (--no-ff) at Phase 2. NOT pushed (user did not request push — local only). -->
<!-- dev-df69 lock RELEASED 2026-05-31T09:35Z: PianoidTunner/src/PianoidTuner.js merge conflict resolved
     (feature/preset-settings-ui → dev), committed b24dead + pushed (origin/dev == b24dead, verified).
     dev-177a even-scheduler ONLINE + dev-8abf offline-WAV OFFLINE both survive; stopSweep + unmount
     cleanup tear down both. Full Jest 68/795 PASS, build0, eslint0. -->
<!-- ★dev-df69 consolidation NOTE: the merged feature/preset-settings-ui carried dev-bbcb (c19bb1e) +
     dev-e9ed (89cf124) + dev-8abf (bb46876) work into PianoidTunner dev. dev-bbcb's + dev-e9ed's ACTIVE
     lock rows below (ObjectInspector.jsx, NumInput.js, PaneSettingsDialog.jsx, PresetPanel.jsx + tests)
     are now STALE — their committed work is in dev; they will be reconciled (rows cleared) in the
     lock/WIP housekeeping at the end of this consolidation, after PianoidCore + master are pushed. -->

<!-- dev-8abf RE-ACQUIRED + RE-RELEASED 2026-05-31T09:20Z: post-Phase-1 NUL-byte correction in
     PianoidTunner/src/utils/__tests__/audioPlayback.test.js (Write tool turned a 4-space run in the
     SAMPLE_B64 literal into 4 NUL bytes → committed blob flagged binary). Rewrote NUL-free + amended the
     held FE commit (64ce7de → bb46876, NOT merged/pushed). 7/7 + full Jest 68/795 still PASS; committed blob
     now 0 NULs (git treats as text). -->
<!-- dev-8abf locks RELEASED 2026-05-31T09:13Z at Step 10a Phase 1 commit. Held:
     PianoidCore/pianoid_middleware/backendServer.py, PianoidTunner/src/PianoidTuner.js,
     PianoidTunner/src/utils/audioPlayback.js (new), PianoidTunner/src/utils/__tests__/audioPlayback.test.js (new),
     docs/development/diagnostics/dev-8abf-offline-audio-data-roundtrip.py (new).
     OFFLINE "Play All" playback fix (Option A): offline /play_keyboard now returns base64 `audio_data`
     (list-shaped, matches /get_chart_test) read from the already-written WAV; FE startSweep offline branch
     decodes audio_data[0] and plays via a hidden <audio>, idiom extracted to utils/audioPlayback.js (+7 Jest).
     Committed BE PianoidCore feature/start-right-away-binary `bdfc7c0` (+10); FE PianoidTunner
     feature/preset-settings-ui `bb46876` (+212/-1, on top of dev-e9ed 89cf124); docs/log/diagnostic on root master.
     FE Jest 68/795 PASS (+1 suite/+7 tests, 0 regressions) + build clean; BE 12/12 isolated round-trip.
     NEITHER branch merged — held for the user's post-release batch test (orchestrator consolidates later).
     ★dev-eac2's stale lock on backendServer.py/pianoid.py (CFL already merged to dev@ce2818b) flagged again
     for reconciliation — did NOT collide (different branch, file clean on my branch). NO CUDA build. -->
<!-- dev-5c3b locks RELEASED 2026-05-30T21:13Z at Step 10a Phase 1 commit. Held:
     PianoidCore/pianoid_middleware/backendServer.py + tests/unit/test_start_right_away_binary.py (new).
     start_right_away made BINARY 0/1 — deleted dead value-2 (deprecated inline, no caller) + value-3
     (no-op pass, byte-identical to else) dispatch branches in load_preset_route; kept the `==1` bg-thread
     branch byte-for-byte; non-1/0 = init only. Committed on PianoidCore feature/start-right-away-binary
     (b5815d6, +204/-12 incl. the 5-test unit suite). Docs (REST_API.md field → binary, TESTING.md test
     registration) + session log on root master. 5/5 new tests PASS + 17/17 sibling route regression PASS;
     no engine spin-up (heavy deps monkeypatched per the stall-avoidance constraint). NO CUDA build.
     NOT merged — branch awaits the user's test + approval. ★FLAGGED: dev-eac2's lock row (above) on
     backendServer.py/pianoid.py is STALE — its CFL work is already merged into dev@ce2818b (tree clean);
     orchestrator should reconcile dev-eac2's lock + WIP "HOLDING uncommitted" status. -->
<!-- dev-bbcb lock RELEASED 2026-05-31T09:42Z by dev-df69 consolidation (STALE — work merged to PianoidTunner dev).
     Held: ObjectInspector.jsx, NumInput/NumInput.js, PaneSettingsDialog.jsx, PresetPanel/PresetPanel.jsx,
     __tests__/PaneSettingsDialog.test.jsx, __tests__/ObjectInspector.test.jsx. Preset-load settings UI
     (integer NumInput + Save-Config-in-dialog). Committed c19bb1e on feature/preset-settings-ui, MERGED to
     PianoidTunner dev via b24dead (--no-ff) + pushed (origin/dev == b24dead). Tree clean. -->
<!-- dev-e9ed lock RELEASED 2026-05-31T09:42Z by dev-df69 consolidation (STALE — work merged to PianoidTunner dev).
     Held: ObjectInspector.jsx, __tests__/ObjectInspector.test.jsx. Virtual-keyboard settings refactor
     (selectors + integer fields, type-preserving Switch). Committed 89cf124 on feature/preset-settings-ui,
     MERGED to PianoidTunner dev via b24dead + pushed. Tree clean. -->

<!-- dev-177a lock RELEASED 2026-05-30T17:04:00Z at Step 10a Phase 1 commit. Held: PianoidTunner/src/PianoidTuner.js.
     Option A uneven-keyboard-timing fix — online "Play All" sweep now routes through the backend even-scheduler
     (ONE POST /play_keyboard {mode:"online"}) instead of a per-note setTimeout chain; visual-only setInterval drives
     the sweepingNote highlight; stopSweep halts the highlight (no backend mid-flight cancel — documented limitation);
     offline branch unchanged. Frontend-only, NO CUDA/backend. Committed on PianoidTunner feature/even-keyboard-sweep
     (27fcb56, +62/-23); docs (OVERVIEW Play All subsection + WIP deferred follow-up) + session log on root master
     (bd06676). Jest 66 suites / 745 tests PASS.
     MERGED + PUSHED 2026-05-30 by dev-e9ed (Phase 1 wrap-up of orphaned dev-177a): feature/even-keyboard-sweep
     merged to PianoidTunner dev `a593396` (--no-ff) and pushed (origin/dev 2d23254..a593396, clean fast-forward,
     verified by re-fetch ref-compare). Session log archived to logs/archive/dev-177a-2026-05-30-195124.md;
     WIP Active-Sessions row removed. -->

<!-- ===== Active/held lock rows from the release-2026-05-30 sync (PianoidInstall master) ===== -->
<!-- dev-7032 locks RELEASED 2026-05-30 at Step 10a Phase 2 wrap-up. Held (CFL ratio chart):
     PianoidCore pianoid_middleware/chartFunctions.py + chart_config.json + NEW
     tests/unit/test_cfl_ratio_chart.py + NEW docs/development/diagnostics/dev-7032-cfl-courant-varies.py.
     Per-pitch worst-string Courant number scatter across the keyboard with redline 1.0 + CFL_MARGIN
     reference via render_hints. Pure-Python (pianoid.param_manager._pitch_upload_amp, no GPU);
     cfl_stability.py NOT modified (only called). 13/13 unit + real-preset Courant-varies proof +
     registry E2E. ★LANDED VIA PULL MERGE (not via this agent's wrap-up): PianoidCore code committed
     a43f008 on feature/cfl-test-on-p1fix, merged to dev at ce2818b (Merge feature/cfl-test-on-p1fix
     into dev — co-merged with dev-eac2's CFL guard v2 a9d0aec); PianoidTunner render_hints
     thresholds-array commit 5e5d546 on feature/cfl-stability-chart, merged to dev at 9e7cb39 (Merge
     feature/cfl-stability-chart into dev). Both merges already on PianoidCore dev tip / PianoidTunner
     dev tip when this wrap-up ran — the user's upd-origin-9a1d pull (2026-05-30) had already brought
     them in. Step W2–W7 of the brief's plan corresponded to already-landed work; only the
     bookkeeping tail (locks/WIP/log) was executed in this session, recorded as
     PianoidInstall master commit (this commit). Live tested + approved by the user prior to
     wrap-up ("CFL chart already tested and approved, wrap up"). -->
<!-- dev-eac2 + dev-395e locks RELEASED 2026-05-30 at Step 10a Phase 2 wrap-up. Held (CFL guard v2,
     host-side, granular-only gate + CFL_MARGIN on the Courant number + flag-lifecycle fixes):
     PianoidCore pianoid_middleware/parameter_manager.py + pianoid.py + backendServer.py +
     cfl_stability.py (4 files; dev-eac2 explicitly took over dev-395e's lock per the dev-eac2
     log Step 0, so the 4 files = combined dev-eac2 + dev-395e scope on the same shared branch
     feature/cfl-test-on-p1fix). dev-395e's all-path gate (granular + 2 bulk sites) was
     SUPERSEDED by dev-eac2's directive-A REVERT (granular-only — bulk ungated per the user's
     "no gate on bulk update for now"); dev-eac2 then layered USER REVISION 2717 (CFL_MARGIN=0.99
     on the Courant number, granular-only) + USER REVISION 2720 (CFL_LIMIT restored 0.96→1.0 to
     fix the never-reset bug + _clear_cfl_redline added in switch_preset/load_preset for fresh
     preset = fresh stability state). cfl_stability.py exact math (max_amplification/is_stable_amp)
     UNCHANGED — only constants + acceptance threshold added. ★LANDED VIA PULL MERGE (not via this
     agent's wrap-up): PianoidCore code commit a9d0aec on feature/cfl-test-on-p1fix, merged to dev
     at ce2818b (Merge feature/cfl-test-on-p1fix into dev — co-merged with dev-7032's CFL ratio
     chart a43f008 + Belarus preset edits); PianoidTunner CFL redline warning chip commit 983f0c2
     on feature/lower-default-volume-100, merged to dev at 2d23254 (co-merged with the
     120→100 default volume change). Both merges already on PianoidCore dev tip / PianoidTunner
     dev tip when this wrap-up ran — the user's upd-origin-9a1d pull (2026-05-30) had already
     brought them in. Pure-Python verified pre-merge: dev-eac2-cfl-revert-verify.py 6/6,
     dev-eac2-cfl-margin-verify.py 6/6 (boundary EXACTLY at courant 0.99),
     dev-eac2-cfl-flag-lifecycle.py 5/5 (over-edge→set, safe→CLEARS),
     dev-eac2-cfl-preset-switch-reset.py 3/3 (library switch_preset clears stale flag); +
     test_cfl_amp.py 16/16 (exact math unchanged); dev-395e-cfl-allpath-gate.py 6/6 (pre-revert
     legacy). NO CUDA build (Python-middleware-only). Live tested + approved by the user prior
     to wrap-up. Step W2–W7 of the brief's plan corresponded to already-landed work; only the
     bookkeeping tail (locks/WIP/log) was executed in this session, recorded as PianoidInstall
     master commit (this commit). -->

<!-- dev-7032 lock RELEASED 2026-05-31T09:42Z by dev-df69 consolidation (STALE — work shipped in PianoidCore dev).
     Held: chartFunctions.py, chart_config.json, tests/unit/test_cfl_ratio_chart.py (new),
     docs/development/diagnostics/dev-7032-cfl-courant-varies.py (new). Per-pitch CFL ratio (Courant) chart.
     feature/cfl-test-on-p1fix (tip 94c7901) is an ANCESTOR of dev → dev has cfl_ratio (chart_config.json) +
     cfl_ratio_function (chartFunctions.py) + test_cfl_ratio_chart.py; diagnostic tracked on master. Tree clean.
     The earlier "HELD UNCOMMITTED" note predated the feature/cfl-test-on-p1fix → dev merge (ce2818b). -->
<!-- dev-eac2 lock RELEASED 2026-05-31T09:42Z by dev-df69 consolidation (STALE — work shipped in PianoidCore dev;
     orchestrator-directed). Held: parameter_manager.py, pianoid.py, backendServer.py, cfl_stability.py.
     CFL guard v2 (granular-only gate + CFL_MARGIN=0.99 on Courant [REV 2717] + flag-reset/CFL_LIMIT=1.0 [REV 2720]).
     feature/cfl-test-on-p1fix (tip 94c7901) is an ANCESTOR of dev → dev cfl_stability.py has CFL_MARGIN +
     is_stable_with_margin (13 refs) + CFL_LIMIT=1.0; pianoid.py + backendServer.py have _clear_cfl_redline.
     Tree clean (all 4 files committed-clean on dev). -->

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
<!-- (dev-8085's 2 stale active rows removed 2026-06-03 — see the "dev-8085 locks RECONCILED 2026-06-03 by dev-blur" comment near the top active-rows region.) -->
<!-- dev-8085 ACTIVE rows REMOVED 2026-06-04 (Phase 2 wrap, stale-row reconcile). These two rows were
     leftover ACTIVE entries for the 120→100 default-volume work; that work has long been an ancestor of
     PianoidTunner dev — already documented RELEASED 2026-05-31 by the dev-df69 consolidation (see the
     "dev-8085 locks RELEASED 2026-05-31T09:42Z by dev-df69 consolidation" comment further below). The
     rows simply weren't deleted at that time. No active lock; nothing held. -->
<!-- dev-stest-4a7c locks RELEASED 2026-05-31 at Step 10a Phase 1 (Sound Test diagnostic chart).
     Sound Test diagnostic chart — Phase B + M9 + M12 + M14 (audio attach for chart-native playback).
     M12: bool URL-string coercion fix in ChartRegistry.extract_arguments — bug where
     `bool("false")==True` made boolean params always-true for URL-routed requests.
     Unified PianoidResult architecture per user A3 directive: new fields `post_fir_sound` +
     `sint_sound` + loaders; engine-side new rings (Sint + FIR) + multi-channel offline writer
     fix; chart-fn reads ONLY via `PianoidResult.get_*_audio()` accessors (architectural assertion
     in unit test that raw C++ getters are never called by chart fn).
     Engine + middleware + tests committed locally on PianoidCore `feature/sound-test-chart`
     branched off dev `37f664a` (SHA reported in dev-m17-454a session log). Doc-gap closures
     (`docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md`, `docs/modules/pianoid-cuda/DEBUG_DATA.md`)
     + proposals (`docs/proposals/sound-test-chart-2026-05-30.md` + `chart-native-playback-2026-05-31.md`)
     committed on PianoidInstall master. Pre-edit regression baseline captured:
     sha256 e5654ec6...4e for BaselinePreset1 pitch 60 vel 100 (preserved in
     /tmp/dev-stest-4a7c-baseline.{npy,json}). dev-soundint-live PAUSED lock released this round
     (stash+branch confirmed gone). NOT merged to dev yet — Phase 2 awaits user re-confirmation. -->
<!-- dev-m17-454a locks RELEASED 2026-05-31 at Step 10a Phase 1 (M17 follow-up + M18/M18b/M18c).
     M17 follow-up: appended `TestRenderLayerCombinations` class (+18 parametrised tests + 2 symptom
     regression pins) to `PianoidCore/tests/unit/test_sound_test_chart.py` (620→861 LOC). Locks the
     parent's M17 architectural invariants — synthesis-always-runs; per-boolean rendering — by
     enumerating all 16 (kernel,fir,sint,mic) boolean combinations + Symptom A/B spot-checks.
     M18/M18b/M18c: NewWindowChart React.StrictMode-safe fetch in
     `PianoidTunner/src/components/newWindowChart.jsx` (540→~590 LOC) — `fetchedRef` one-shot
     fence prevents the dev double-invoke duplicate POST that the user heard as "note plays twice
     BEFORE the chart renders"; `isMountedRef` guards late setState onto an unmounted root; M18c
     swaps `useApi` → direct `axios.post(...)` to side-step `useApi.js:28`'s own
     auto-abort-on-unmount cleanup which was cancelling the only POST under StrictMode
     (`net::ERR_ABORTED` → Loading-hang). 4 strictMode regression tests committed in
     `PianoidTunner/src/components/__tests__/newWindowChart.strictMode.test.jsx`. Live-verified
     via chrome-devtools both OFFLINE + ONLINE modes — 1 POST → HTTP 200 → chart renders with
     Kernel/Sint per-source Play buttons. NO CUDA rebuild. NO backend edits. Frontend HMR
     pickup. Committed locally on PianoidTunner `feature/sound-test-chart` (NEW branch off dev
     `71bc77f`; SHA reported in session log). NOT merged to dev — Phase 2 awaits user
     re-confirmation. No collision with dev-snmtxleak-7e3d (their files MeasuredMatrix.jsx /
     SoundChannelsPane.jsx / useSoundChannels.js / useHotkeys.js — disjoint). -->
| dev-stest-4a7c | (released — see comment block above) | 2026-05-31T19:00:00Z | Released at Phase 1 wrap. |
<!-- dev-snmtxleak-7e3d locks RELEASED 2026-05-31 at Step 10a Phase 1. Held (architectural SC
     strings-axis decouple + useHotkeys falsy-zero guard hardening):
     PianoidTunner/src/components/SoundChannelsPane.jsx (~+24/-2 LOC: local `selectedChannel`
     useState, `onPitchSelect` gated by `listenToModes`, pitchInView axis-aware), useHotkeys.js
     (2 LOC: `!pitch` → `pitch == null` on lines 58 `play` + 65 `stopNote`), 2 NEW Jest test
     files (SoundChannelsPane.localChannel.test.jsx + useHotkeys.zeroPitch.test.jsx — 10 new
     tests, 5/5 existing useHotkeys.cyclePreset still PASS, sweep 15/15 PASS). Committed on
     PianoidTunner `feature/sc-decouple-spacebar-fix` (off dev tip 71bc77f), commit `4b0ce71`
     (+347/-5 across 4 files). NOT merged to dev. NOT pushed. Awaits user live re-test of
     both bugs: (1) spacebar after SC strings-axis matrix click → should fire WS `play` frame
     with the previous selectedPitch (not silent), (2) modes-axis behaviour unchanged
     (cross-pane sync to global setSelectedPitch preserved). Frontend-only, HMR pickup, no
     CUDA rebuild. No file collision with dev-m17-454a (newWindowChart.jsx), dev-stest-4a7c
     (PianoidCore backend), or dev-8085 (ToolBar.jsx + usePreset.js — different files). Live
     UI verified via chrome-devtools post-commit: fiber-prop onPitchSelect(2) on strings axis
     sets local selectedChannel=2 ONLY; global selectedPitch stays at 60; spacebar fires
     `play({pitch: 60})` post-click (pre-fix the same gesture fired `play({pitch: 2})`).
     [LOCK RELEASED] 2026-05-31T18:25:00Z. -->

| dev-m17-454a | (released — see comment block above) | 2026-05-31T19:00:00Z | Released at Phase 1 wrap. |
<!-- dev-pyspawn-8b3a lock RELEASED 2026-05-31 at Step 10a Phase 1. Held:
     docs/guides/STARTUP_TROUBLESHOOTING.md (re-scoped from code to docs).
     Original brief targeted backendServer.py + launcher.js for an alleged
     "venv→system Python child spawn" bug. Phase A measurement-based diagnosis
     against the live engine (3 diagnostic probes preserved in
     docs/development/diagnostics/dev-pyspawn-8b3a-*.py) REFUTED all 4 brief
     hypotheses (Werkzeug reloader / Flask-SocketIO async_mode / sys._base_executable
     / corrupted venv shim). The two-PID structure under the launcher is normal
     Python 3.12 venv launcher-shim architecture: .venv/Scripts/python.exe is a
     274 KB launcher stub that spawns C:\Python312\python.exe as the actual
     interpreter via CreateProcess; the child's sys.prefix correctly resolves to
     the venv via pyvenv.cfg discovery and imports the FRESH venv pyd (with
     getRawSoundRecordInt + getRawFilteredFloatRecord bound, verified by direct
     probe with launcher-exact env). User re-tested chart against running PID 73984
     — no AttributeError; cause was hypothesis D (running backend predated dev-stest-4a7c's
     working-tree edits to PanoidResult.py + chartFunctions.py; clean backend restart
     picks up the new module). Same misdiagnosis previously seen in dev-stest-4a7c
     log line 406 + the brief itself — STARTUP_TROUBLESHOOTING.md entry documents
     the pattern + decisive sys.prefix/pianoidCuda.__file__ probes so it doesn't
     recur. COMMITTED PianoidInstall master c21fadb (7 files +345/-1: STARTUP doc
     entry + 3 diagnostic .py probes + session log + WIP transition + this lock
     release). NO source code modified. Independent of dev-stest-4a7c's ongoing
     Phase B work (different files, different concerns). Live stack PRESERVED
     (PID 86072/58276/73984) per orchestrator direction — dev-stest-4a7c's
     continuing work needs it. -->

<!-- dev-8085 locks RELEASED 2026-05-31T09:42Z by dev-df69 consolidation (STALE — work shipped in PianoidTunner dev;
     2 duplicate rows collapsed). Held: ToolBar.jsx, usePreset.js. Lower default preset-load volume 120→100.
     feature/lower-default-volume-100 is an ANCESTOR of dev (dev usePreset.js:152 default volume = 100, merged
     at 2d23254). Tree clean. (Diagnostic rig .py are committed-free under docs/; instrumentation already reverted.) -->

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
<!-- dev-3580 active row REMOVED 2026-06-03 by dev-asioload (reconciled to RELEASED — see the
     "dev-3580 lock RECONCILED 2026-06-03 by dev-asioload" comment in the active-rows region near the top).
     Was: `PianoidCore/pianoid_cuda/Pianoid_excitation.cu` — diagnostic NOTE_OFF_PROBE preserved only in the
     now-lost stash@{0}=26799bf; guards nothing (stash GONE, trichotomy resolved by dev-427c). Tree clean. -->
<!-- dev-soundint-live PAUSED-lock RELEASED 2026-05-31 (orchestrator + user-approved cleanup;
     Telegram msg 3059 "Go as recommended" = α = release the PAUSED lock now over β = let
     dev-stest-4a7c override it). HONEST-RECORD CLEANUP — UNLIKE dev-eac2/dev-7032 (whose code
     reached dev via the morning's pull merge), dev-soundint-live's preserved work is VERIFIABLY
     GONE. Held 8 files: 6 PianoidCore C++ (Pianoid.cuh, Pianoid.cu, Pianoid_debug.cu,
     AddArraysWithCUDA.cpp, Pianoid_synthesis.cu, MainKernel.cu) + 2 PianoidCore Python
     (pianoid_middleware/chartFunctions.py, pianoid_middleware/chart_config.json). The protected
     work container `stash@{0}` = `26799bf` (stashed by dev-35a3 2026-05-29 for a clean bisect
     tree), branch `feature/soundint-readback`, and commit `26799bf` were ALL verified GONE on
     2026-05-30/2026-05-31 (verified independently by dev-stest-4a7c and again by this cleanup):
     `git stash list` carries no soundint entry, `git branch -a | grep -i soundint` empty,
     `git reflog | grep -i soundint` empty, `git cat-file -t 26799bf` → "Not a valid object name".
     No recovery is possible — the PAUSED lock has been protecting nothing for an unknown period.
     Cleanup driven by Phase A3 collision detection during dev-stest-4a7c design review (the new
     Sound Test feature needs the same `dev_soundInt` readback surface this lock guarded).
     Superseded by `dev-stest-4a7c` which is RE-DERIVING the Sint-readback hook from the archived
     dev-soundint-live session log (not from the lost stash) — the actual hook code will be NEW
     code, not the preserved stash. ★KEY RESULT that survives in the archived log for
     dev-stest-4a7c's reference: post-volume OVERFLOW REFUTED via direct kernel probe (mvc=7.999e8
     exact; soundInt ±6e6 ≈ 340× UNDER INT32 rail; engine CLEAN at vol=100; the railed M1/M2
     readings were a READBACK BUG — layout mismatch: kernel writes dev_soundInt at stride
     samplesInCycle, hook reshape used mode_iteration). Original task was POST-volume dev_soundInt
     readback hook (soundInt ring + getRawSoundRecordInt() + pybind + sound_int chart +
     getMainVolumeCoefficient() getter + TEMP kernel probe at MainKernel.cu:492) for the H1/H2
     trichotomy discriminators; trichotomy itself was independently resolved by dev-427c
     (P1-1 GPU-pointer authority race fix, merged to PianoidCore dev `a352b2f`). -->
<!-- damper-probe-ea77 lock RELEASED 2026-05-29 at Step 10a Phase 1 (lightweight).
     Held: PianoidCore/pianoid_cuda/Pianoid_synthesis.cu — DAMPER_PROBE inserted (+7 lines)
     at the existing UPLOAD_PROBE site (around line 204-210). Probe LEFT IN SOURCE for ongoing
     investigation (not reverted, not committed). Backend kept alive (orchestrator drove the
     reproduction directly; PID 80416 on port 5000 SDL3).
     Result: damper_string[201..203] = 3.6e-05 (matches preset, NOT zero) → H_A (damper-wipe) refuted.
     H_B (mode ringout) is the leading follow-up hypothesis.
     Log: docs/development/logs/damper-probe-ea77-2026-05-29-210147.md (kept open in logs/, not archived). -->
<!-- ===== Released-lock entries from origin/master (other-machine sessions, unioned in) ===== -->
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
<!-- dev-d52b locks RELEASED 2026-06-04 (Phase 2 wrap, user-approved). Held:
     PianoidBasic/Pianoid/StringMap.py + 8 PianoidCore CUDA files (Pianoid.cu/.cuh, MainKernel.cu/.cuh,
     constants.h, Pianoid_parameters.cu, Pianoid_debug.cu, AddArraysWithCUDA.cpp) +
     pianoid.py / pianoid_cuda_placeholder.py / backendServer.py. PROPORTIONAL piano-only feedback coeff
     (slider × feedin; output/sound 128+ excluded via per-string dev_feedback_output_mask) + int-domain
     tanh output soft-limiter (LIMITER_CEILING 1.2) + non-silent limiting signal (dev_limiter_peak buffer,
     getLimiterPeaks/resetLimiterPeaks pybind, /health get_limiter_status). KERNEL CHANGE (--heavy --both).
     PianoidCore feature/dev-d52b-feedback-coeff 24d5251 MERGED to dev at f332838 (--no-ff);
     PianoidBasic feature/dev-d52b-feedback-coeff 5758dae MERGED to dev at 206ea96 (--no-ff). Pushed to origin. -->
<!-- dev-uimtx locks RELEASED 2026-06-04 (Phase 2 wrap, user-approved). Held: ~23 PianoidTunner frontend
     files (MeasuredMatrix.jsx, PitchesModesMatrixCanvas.jsx, MatrixTools.jsx/.css, SoundChannelsPane.jsx,
     FlatBarAxis.jsx new, PianoidTuner.js, matrixEmit.js new, RowEditor.js, DrawableChart.jsx,
     useBackendHealth.js, BackendStatusIndicator.jsx, ToolBar.jsx + 8 new test files). Matrices-UI review
     fixes C1/H1/H3/M1/M3 + clip/limit indicator (binds dev-d52b's /health limiting contract read-only) +
     React-warning fixes + #208 bar-chart fixes. Frontend-only, HMR, NO CUDA build.
     PianoidTunner feature/matrices-ui-fixes 1132b4a MERGED to dev at 2488168 (--no-ff). Pushed to origin. -->
<!-- dev-lmode locks RELEASED 2026-06-05 at Step 10a (user-approved commit + push). Held:
     PianoidCore/pianoid_middleware/backendServer.py + tests/unit/test_health_listen_mode_regression.py (new).
     Fix: GET /health `listen_mode` now reads pianoid.mp.listen_to_modes (engine listen-to-modes truth, set
     from /load_preset) instead of pianoid.listen (the MIDI-listener loop flag) — pre-fix /health always
     reported listen_mode=false under the listen_to_midi=0 default regardless of the modes setting. Diagnosis
     (B) REPORTING GAP, measurement-confirmed (in-process probe: mp.listen_to_modes tracks request True/False,
     pianoid.listen independent). Feature was applied engine-side all along (StringMap.py:444 gates the
     sound-channel feedin cell); only the report was wrong. +3 unit tests (8/8 PASS incl. 5 sibling
     play/listen-gate). Python-middleware-only, NO CUDA build. PianoidCore feature/dev-lmode-health-listen-mode
     6125b69 MERGED to dev at a139971 (--no-ff). Docs (REST_API.md GET /health field semantics + TESTING.md
     test registration) + diagnostic probe + session log on PianoidInstall master. Pushed to origin. -->
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

