# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

<!-- dev-soundd locks RELEASED 2026-06-22 at Step 10a Phase 1 (user-approved ship; coordinator-relayed).
     D1 Sound Test in-cycle checkpoint profiling + D2 (save result, spectrum, align-then-zoom-sync).
     Held + released: PianoidCore (wt-soundd-core) pianoid_cuda/Pianoid_synthesis.cu (cp2/cp3 around the
     blocking pushSamples + cp4/cp5 in runCycle), pianoid_middleware/chartFunctions.py (_sound_test_checkpoint_spans_us
     + Full-cycle/Sync-wait charts + breakdown/attribution + spectrum + mic-delay + ms-axis helpers),
     chart_config.json (include_spectrum + include_time_axis), tests/unit/test_sound_test_profiling.py (depth-robust
     full-cycle tests) + NEW tests/unit/test_sound_test_d2.py (18). CircularBuffer.cu/.cuh, Pianoid.cuh,
     AddArraysWithCUDA.cpp, constants.h, test_sound_test_chart.py were locked precautionarily but NOT edited.
     PianoidTunner (wt-soundd-tunner): src/utils/chartOption.js (gated category->value axis for sync_group=time),
     src/components/newWindowChart.jsx (echarts.connect time-group + Save JSON/CSV), src/utils/__tests__/chartOption.test.js.
     COMMITTED on feature/dev-soundd: Core ff469b6, Tunner 513cc5b. NOT merged — merge-sweep rebuilds --heavy --both on
     merged dev (the .cu kernel change) + smoke-tests, then commits ALL root docs/logs in one master commit (CHART_SYSTEM
     update + log dev-soundd-2026-06-22-054200.md + diagnostic dev-soundd-online-population-check.py left UNCOMMITTED in
     the root tree to avoid a concurrent-commit race with dev-applyc). HEAVY --both already built BUILD_EXIT=0 (release+debug
     .pyd into shared venv); 87 backend + 24 FE tests green; in-process audio_on verified the new checkpoints populate.
     dev-soundd STAYS ALIVE. -->
| <!-- (none active for dev-soundd — released at Phase 1) --> | | | |

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
<!-- dev-hxfix locks RELEASED 2026-06-22T15:34:00Z at Step 10a Phase 1 (committed, HOLD for user test + merge approval).
     BLOCKER (reload-kills-backend) + #3 (control-row overflow) COMMITTED a729cbd on feature/dev-hxfix-reload-layout
     (off dev 579b525): PianoidTuner.js (remove beforeunload stop-backend + add bare-recovery effect),
     HammerStringChart.jsx (control row flexWrap + 62/70/62 widths), NEW reloadKeepsBackend.source.test.js (2 tests).
     Root docs committed 0ce64bc (STARTUP_TROUBLESHOOTING note + log + 3 screenshots + WIP/locks). NOT merged to dev.
     #2 loudness = measure/propose/HOLD (no code; full measurement+approach in the session log). #1 workbench tracking
     re-verified GOOD live (no fix needed). Jest 129/1325==baseline + 2 new; eslint 0 errors. dev-hxfix STAYS ALIVE. -->
<!-- dev-applyc-arraysize locks RELEASED 2026-06-22 (code COMMITTED acb103d on
     feature/dev-applyc-arraysize, HOLD for user combined test). array_size in-place
     re-init silent-render. ROOT CAUSE = Python, NOT C++/CUDA: _rebuild_stringmap_for_array_size
     rebuilt StringMap but a fresh StringMap defaults soundChannelModes.string_coefficients to
     ZEROS (not carried by pack_for_preset_file) → sound-string feedin row = 0 → deck collapses
     → with listen_to_modes the mode-channel audio tap reads 0 → SILENT. FIX (pianoid.py only):
     capture+restore the per-pitch sound-channel coupling coeffs across the rebuild. UN-GATED
     array_size to the in-place path (preset_reinit.py INPLACE_STRUCTURAL_FIELDS + pianoid.py
     REINIT_INPLACE_STRUCTURAL + classifier test). All .cu instrumentation REVERTED to HEAD
     before commit (the .cu files were NOT changed). Clean release .pyd rebuilt (no instrumentation).
     Classifier 28/28 green; minrepro bit-identical sound; round-trip C==A. Root PianoidInstall
     docs/logs/diagnostics LEFT UNCOMMITTED for the merge-sweep. -->
| <!-- (none active for dev-applyc-arraysize — committed, HOLD) --> | | | |
<!-- dev-applyc locks RELEASED 2026-06-22T09:45:00Z at Step 10a Phase 1 (code COMMITTED, user chose
     option A — ship in-place re-init now). In-place CUDA re-init (Apply HOT/STRUCTURAL lifecycle).
     COMMITTED on feature/dev-applyc: PianoidCore 008ec9e (backendServer.py + pianoid.py +
     preset_reinit.py NEW + tests/unit/test_preset_reinit_classify.py NEW) + PianoidTunner e532434
     (usePreset.js + __tests__/usePreset.hotReinit.test.jsx NEW). Pure Python middleware + FE, NO CUDA.
     3-way classifier: hot (volume/feedback runtime set) / structural-inplace (sample_rate/
     string_iterations/cycle_iterations/audio_driver_type/audio_buffer_size/audio_on → rebuild GPU
     engine only, keep edited model + FE state) / full (preset-name OR array_size/debug_mode/
     listen_to_modes/sound_derivative_order). reinitialize_cuda_engine: stop+join → deterministic GPU
     free → re-pack edited model → reconstruct → devMemoryInit → re-push library + switchPreset →
     excitation → initParameters → re-apply runtime → push edits; restart thread only if was playing;
     ReinitFailed 500 + FE recoverWithFullReload on failure. array_size → full reload (in-place
     geometry rebuild preserves edits but renders SILENT — tracked C++-level follow-up). Classifier
     28/28, FE Jest 12/12 green. NOT merged (HOLD for user combined live-test). Root PianoidInstall
     docs/logs (REST_API/SYSTEM_OVERVIEW, session log, proposal, diagnostics) LEFT UNCOMMITTED for the
     merge-sweep master commit (avoids the concurrent-commit race with dev-soundd). dev-applyc STAYS
     ALIVE for combined-test feedback + the array_size silent-render follow-up. -->
| <!-- (none active for dev-applyc — code committed, locks released) --> | | | |
<!-- dev-37f6 locks RELEASED 2026-06-22T05:35:00Z at Step 10a Phase 1 (MERGED + PUSHED, user approved
     delivery option B). Excitation/Hammer Cluster A+B (A1 erratic width, A2 width→loudness norm, A3
     position-latency, B1 workbenches, B2 anchored-LINEAR). Held: PianoidBasic Hammer.py + constants.py;
     PianoidTunner PianoidTuner.js + HammerStringChart.jsx + Excitation.jsx + ExcitationProperties.jsx +
     __tests__/HammerStringChart.test.jsx (StringMap.py was locked earlier but NOT edited — released, EOL
     artifact). A2: unit-sum hammer spatial energy-norm (width-independent loudness, measured ×1895→×1.6) +
     EXCITATION_IMPULSE_CALIBRATION 2.16e-06→1.131e-06 (Belarus p60v127 -3.30 dBFS in-range). A1: width
     floor 3·dx→1.05·dx (HAMMER_WIDTH_FLOOR_DX_MULT, measured-stable margin) + stored==effective + FE
     WIDTH_FLOOR_DX_MULT mirror + deleted renormalizeGaussForSpatialEdit workaround. A3: backend ~13ms;
     HammerStringChart optimistic analytic chart during drag (exactShape {data,atParams} freshness gate).
     B1: restored position/width/sharpness Workbench affordances (read/write already supported; added the
     open button + onOpenHammerWorkbench thread). B2: WorkbenchFunctionTools clampMax 1e6→Infinity (the 1e6
     ceiling pinned non-anchor pitches while the anchor bypassed the clamp → standout; measured residual 0
     after). MERGED --no-ff: PianoidBasic dev 22af002 (5d28b67..22af002, off 40b5b3b) + PianoidTunner dev
     bf0633c (895e063..bf0633c, off ef0836e), PUSHED origin/dev both. Post-merge sanity: PianoidTunner Jest
     171/171 + CRA build clean; PianoidBasic wheel rebuilt clean from dev + L1 import OK (markers verified).
     PianoidBasic = WHEEL (no CUDA). dev-37f6 STAYS ALIVE for user live-test follow-ups (Phase 2 close-out
     held). KNOWN edge (flagged to user): single-node hammer struck at the bridge (pos<~0.06) → RMS=0
     (boundary physics, not a defect). ASIO-crash-on-FE-load flagged as separate instability. -->
<!-- dev-wbspawn (2-D COLOR schema) locks RELEASED 2026-06-20T13:40:00Z — MERGED + PUSHED. Replaced the
     flat wb-kind-* 3-color scheme with a 2-D schema: HUE=param groupe × BRIGHTNESS-tier=workbench type;
     colour=hue(current param's groupe)×tier(type); global-dynamic hue follows the active param. Defaults
     Strings#2196f3/Modes#4caf50/Excitation#e53935(+hammer,H1)/Feedin#00bcd4/Feedback#fb8c00/Sound
     Channels#e91e63/Mass#8d6e63; tiers global1.0/panel0.7/fixed0.4 — all distinct from SC-avg #42a5f5/
     #ba68c8. NEW utils/workbenchColor.js (workbenchColor + applyTier + DEFAULT_*); workbenchTitle.js
     workbenchKindClass→workbenchKind; useSettings workbenchSettings.colors={hues,tiers}; PianoTuner
     renderTile delivers colour via --wb-accent CSS var on a display:contents wrapper; index.css single
     .wb-accent rule (color-mix); GlobalSettingsDialog new "Workbench colours" section (7 swatches + 3
     sliders + reset). Tests NEW workbenchColor.test.js + workbenchKind suite. Jest 1312/1312 green, CRA
     build clean. MERGED --no-ff to PianoTunner dev (off 644aebd; feature 941fedd; merge b510c63) + PUSHED
     origin/dev (644aebd..b510c63); :3000 restarted (serving b510c63, HTTP 200). Frontend-only, NO CUDA.
     User live-tests. Docs (OVERVIEW "Workbench color coding — 2-D schema") + log
     dev-wbspawn-color2d-2026-06-20.md on PianoidInstall master. -->
<!-- dev-wbspawn (per-type COLOR CODING) locks RELEASED 2026-06-20T03:25:00Z — MERGED + PUSHED. 3
     workbench types each get a distinct title-bar accent, all distinct from the SC-average chart accent
     (MUI default-theme primary.light #42a5f5 modes / secondary.light #ba68c8 strings — found in
     SoundChannelsAggregateChart seriesColor). Colors: fixed=amber #ffb300 / panel-following=teal #26a69a
     / global-dynamic=coral #ff7043. New pure workbenchKindClass(id, wb) in workbenchTitle.js → CSS class;
     PianoidTuner folds it into MosaicWindow className; index.css accent rules (translucent fill + 4px
     left-border) declared BEFORE .highlighted-window so active-panel orange still wins on overlap. Files:
     PianoTuner.js, utils/workbenchTitle.js, index.css, utils/__tests__/workbenchPaneTitle.test.js
     (+per-type class suite). Jest 1298/1298 green, CRA build clean. MERGED --no-ff to PianoTunner dev (off
     31941cc; feature commit 5aba136; merge 644aebd) + PUSHED origin/dev (31941cc..644aebd); :3000
     restarted (serving 644aebd, HTTP 200). Frontend-only, NO CUDA. User live-tests. Docs (OVERVIEW
     "Workbench type color coding") + log appended on PianoidInstall master. -->
<!-- dev-wbspawn (per-type placement) locks RELEASED 2026-06-20T02:40:00Z — MERGED + PUSHED. Per-type
     workbench spawn placement: replaced single placementMode with placement.{fixed, panelFollowing,
     globalDynamic} (defaults panel-bottom/panel-bottom/screen-bottom); 3 labeled controls in global
     top-bar ⚙ (GlobalSettingsDialog); placementForSpawn(placement, kind) resolves spawn TYPE at
     handleOpenWorkbench (panel-dynamic→panelFollowing, else→fixed); global-dynamic Workbench is re-add
     only (panel-bottom degenerates to screen-bottom, helper text states fallback). Files edited:
     PianoidTuner.js, useSettings.js, GlobalSettingsDialog.jsx, ObjectInspector.jsx (placement:{hidden}),
     workbenchPlacement.js (+placementForSpawn), workbenchPlacement.test.js (+per-type suite). Jest
     1293/1293 green, CRA build clean. MERGED --no-ff to PianoidTunner dev (off dc3a732; feature commit
     0a90c61; merge 31941cc) + PUSHED origin/dev (dc3a732..31941cc); :3000 restarted (serving 31941cc,
     HTTP 200). Frontend-only, NO CUDA. User live-tests. Docs (OVERVIEW Workbench-types/spawn-placement
     + settings-table row) + log dev-wbspawn-pertype-2026-06-20.md on PianoidInstall master. -->
<!-- dev-wbspawn locks RELEASED 2026-06-20T01:30:00Z at Step 10a Phase 2 (MERGED + PUSHED, user M2 + Q-A
     confirmed). Workbench 3rd type (panel-specific dynamic) + placement-setting-to-global, MERGED to
     PianoidTunner dev dc3a732 (--no-ff, off 5b57d08; commits cfad905 + 8eb33f1) + PUSHED origin/dev
     (5b57d08..dc3a732); :3000 restarted (serving dc3a732). Held: PianoidTuner.js, useCurrentValues.js,
     useSettings.js (not edited), ObjectInspector.jsx (+ NEW GlobalSettingsDialog.jsx, ToolBar.jsx,
     workbenchTitle.js + 2 test files). PANEL-SPECIFIC DYNAMIC type: {kind,scopeGroupe} binding +
     groupe-gated re-target folded into updateDefaultWorkbench (follows active param within its panel,
     frozen out-of-panel); panel-toolbar Timeline button on all 6 panels (row-based keep fixed on per-row
     icons; matrix Feedin/Feedback/Sound Channels panel-following-only per M2). "New Workbench Placement"
     moved to global top-bar ⚙ (GlobalSettingsDialog, was-dead button wired), removed from pane gear.
     Jest 126/1289 green (+9), CRA build clean. Frontend-only, NO CUDA. User live-tests. Docs (OVERVIEW
     Workbench-types) + log on PianoidInstall master. -->
| <!-- (none active for dev-wbspawn) --> | | | |
<!-- dev-gausscp locks RELEASED 2026-06-20 at Step 10a Phase 2 (team-lead pre-authorized merge-after-verify).
     Held: ExcitationProperties.jsx, GaussEditor.jsx, GaussCell.jsx (locked, not edited), GaussCopyPasteButtons.jsx.
     Reverse gauss-copy flow → Copy-first selection mode + one-click capture + top-left whole-table selector.
     MERGED feature/dev-gausscp-copy-selmode → PianoidTunner dev 23ef3df (--no-ff, off fe93b5d) + PUSHED
     origin/dev (fe93b5d..23ef3df). FE Jest 121/1267 green, eslint 0, prod build clean. Frontend-only, NO CUDA. -->
<!-- dev-reset lock RELEASED 2026-06-19 at wrap (user "commit and push all to dev"). Held:
     PianoidCore/pianoid_cuda/MainKernel.cu. RE-APPLIED the parked W5-B reset PRIMARY accumulator
     full-clear (orig dev-excenergy bf5f720, reverted as collateral in Option-A revert 4c935b9,
     never re-merged; dev-reset Phase-12 parked it pending user confirm — the user's runaway-reset
     re-report was the confirmation). On *status==500, before the main loop, full-clear
     feedback_cycle_matrix + feedin_cycle_matrix (byte-identical to bf5f720, comment updated).
     Branch feature/dev-reset-runaway-accumulator-clear (off PianoidCore dev 89b1e9f, rebased onto
     9c2dd51 = 1f839ac), MERGED --no-ff -> PianoidCore dev df0fa58, PUSHED origin/dev
     (9c2dd51..df0fa58). HEAVY --both built off 89b1e9f+fix; installed .pyd 02F9E03C is
     binary-equivalent to a build off df0fa58 (only other compiled delta = comment-only
     Pianoid_synthesis.cu) -> NO rebuild needed; installed .pyd MATCHES dev. Verified offline
     (audio_off): normal note ring rms=171.5 -> post-reset string=0/mode=0/RMS=0 for 6 cyc
     (RESET_CONFIRMED_FIXED), no regression. ★OPEN: the user's AUDIBLE realtime runaway could not be
     reproduced in the offline harness (drives kernel synchronously, not the live audio-tap loop) —
     the fix is correct for the accumulator-residual mechanism + regression-free, but its efficacy
     vs the user's specific runaway needs a live-device confirm or the user's exact trigger. Worktree
     D:/repos/wt-reset removed; feature branch deleted (merged); dev checked out nowhere. -->
| <!-- (none active for dev-reset) --> | | | |
<!-- dev-underrun2 locks RELEASED 2026-06-19 after team-lead-approved merge. Held: Pianoid_synthesis.cu (COMMENT-ONLY — e5
     placement already correct; the brief's "move e5 after sync" zeroes add_ms via cudaErrorNotReady, reverted to byte-identical
     code + doc comment) + chartFunctions.py (sound_test profiling chart switched from full-cycle host span to getGpuProfilingData
     add_ms = pure addKernel device time; every-3rd over-budget proven to live in the host audio-clock sync wait, 0% on add_ms).
     Tests 16+52 green. feature/dev-underrun2-kernel-profiling 80782a5 MERGED --no-ff → PianoidCore dev 9c2dd51 (off 89b1e9f, in
     throwaway worktree wt-underrun2-dev now removed), PUSHED origin/dev (89b1e9f..9c2dd51); dev left checked out NOWHERE (dev-reset's
     wt-reset + :5000 untouched). Rate-sweep verdict: underruns = SYSTEM HICCUPS not GPU slowdown (add_ms FLAT ~537us idle->40/s).
     Temp /diag_rate_sweep endpoint reverted out of backendServer.py. -->
| <!-- (none active for dev-underrun2 — released after merge) --> | | | |
<!-- dev-pitchfix lock RELEASED 2026-06-19 at Step 10a Phase 1. Held: PianoidTuner.js. ITEM 2 ALIGNMENT FIX (dev-workbench review of
     merged 5ab2d40): Mass workbench read (computeWorkbenchValues "Mass") + write (handleVectorChange "Mass") switched from
     excitationHistory.values key order → availableNotes (the RowEditor x-axis) — fixes a real defect where sparse/pitchID-keyed
     hammerMass could misalign bars + edit the WRONG pitch; + diff-guard (only changed pitches POST). dev-workbench OK'd all 4 checks;
     team-lead Q1/Q2/Q3 answered (in-scope correctness, user re-tests Mass WB). Committed feature/dev-pitchfix-mass-axis-fix 7cba39b
     (off 5ab2d40), MERGED --no-ff dev fe93b5d, PUSHED 5ab2d40..fe93b5d. origin/dev = fe93b5d. Jest green, eslint clean, build OK.
     :3000 restarted (serving fe93b5d). EXCITATION RESTRUCTURE fully COMPLETE + corrected. Frontend-only, NO CUDA. -->
| <!-- (none active for dev-pitchfix) --> | | | |
<!-- dev-pitchfix locks RELEASED 2026-06-19 at Step 10a Phase 1. Held: PianoidTuner.js, Excitation.jsx, ExcitationProperties.jsx,
     ExcitationEnergyEditor.jsx (+ ExcitationEnergyEditor.massControl.test.jsx). EXCITATION RESTRUCTURE item 2 (mass→workbench-link,
     LEAD; partnered dev-workbench): "Mass" workbench groupe — computeWorkbenchValues case "Mass" reads excitationEnergy.hammerMass
     over excitationHistory.values pitch order (grams); handleVectorChange "Mass" branch writes setMassForPitch per pitch (g→kg, same
     order); onOpenMassWorkbench glue PianoidTuner→Excitation→ExcitationProperties→HammerMassControl → {groupe:"Mass",name:"hammer_mass"}.
     No groupe allow-list needed (isWorkbench/openWorkbench/restore groupe-generic); rides dev-wbspawn's fixed binding. Committed
     feature/dev-pitchfix-mass-workbench 5fe7525 (off 9472b47), MERGED → dev 5ab2d40 (--no-ff, dev free of worktrees), PUSHED
     9472b47..5ab2d40. origin/dev = 5ab2d40. Jest 120/1261 green, eslint clean, CRA build OK. :3000 restarted (serving 5ab2d40).
     EXCITATION RESTRUCTURE COMPLETE (items 1/2/3/4). Frontend-only, NO CUDA. -->
| <!-- (none active for dev-pitchfix) --> | | | |
<!-- dev-wbspawn lock RELEASED 2026-06-19T14:50:00Z at Step 10a Phase 1 (frontend commit 9ac5002 on
     feature/dev-wbspawn-orphan-fix off PianoidTunner dev acbf9e6, worktree D:/repos/wt-wbspawn). Held:
     PianoidTunner/src/PianoidTuner.js (+ test src/hooks/__tests__/mosaicConfigStore.test.jsx, this agent's).
     FIX fixed-workbench orphaned-after-layout-switch: (a) DELETED the layout-watching prune useEffect that
     deleted workbench bindings whenever the pane was absent from the LIVE layout (orphaned other configs'
     WBs on every switch + mis-fired on maximize); binding-GC now EXPLICIT at the close action (pane Close X
     button — maximized closeMaximized + non-max mosaicActions.remove — and removeWindowFromLayout each call
     closeWorkbench for a dynamic Workbench:* pane). (c) handleOpenWorkbench AUTO-SNAPSHOTS the active
     config's WB bindings (incl. the just-spawned one) into mosaicConfigWorkbenches on spawn (frozen-config
     gap). Removed now-unused addPanelBottomToLayout wrapper. Jest 119/1254 green (+4 orphan-fix tests),
     closeMaximized regression-guarded, CRA build clean. Frontend-only, NO CUDA. NOT merged — dev is not
     checked out anywhere (main checkout busy with dev-mosaicsave's uncommitted excitation work); merge
     sequenced with dev-mosaicsave (it rebases onto 9ac5002). Lock released so dev-mosaicsave can proceed.
     Docs (OVERVIEW) + log on PianoidInstall master. Agent STAYS ALIVE. -->
| <!-- (none active for dev-wbspawn) --> | | | |
<!-- dev-excenergy lock RELEASED 2026-06-21 by orchestrator (STALE — agent died in a prior session; working
     tree was CLEAN on all locked files = no orphaned uncommitted work). The CONSOLIDATED coeff-update refactor
     (single factor-cache recompose path: mass/speed/calibration/curve incremental <50ms; StringMap split
     pack_excitation_coefficients → pack_excitation_factors + compose_from_factors; excitation_coefficients
     CoefficientCache+recompose; parameter_manager → one recompose call) is PRESERVED, committed + unmerged on
     feature/dev-excenergy-coeff-consolidation (PianoidCore + PianoidBasic). Lock cleared so the new
     excitation/hammer-panel /dev session (Cluster A+B) can acquire these files; that agent will EVALUATE the
     coeff-consolidation branch as prior art for the A3 position-shift latency. -->
| <!-- (none active for dev-excenergy — stale lock cleared) --> | | | |
<!-- dev-pitchfix locks RELEASED 2026-06-19 at Step 10a Phase 1. Held: ExcitationProperties.jsx, ExcitationEnergyEditor.jsx,
     Excitation.jsx, MatrixTools.jsx (+ NEW ExcitationEnergyEditor.massControl.test.jsx; rewrote ExcitationProperties.energyPopup.test.jsx).
     EXCITATION-PANEL RESTRUCTURE items 1/3/4 (user-confirmed): (1) MASS extracted to standalone HammerMassControl rendered inline where
     the Energy button was; (3) energy popup = speeds+calibration only, Energy button moved to pane toolbar next to the horizontal/width
     pair (energyOpen lifted to Excitation.jsx, popup prop-driven); (4) REMOVED the vertical height/volume gauss-scale pair + its
     handlers/props/wheel refs (horizontal kept). Item 2 (mass→workbench) NOT done — deferred, partners with dev-wbspawn (its orphan
     fix is now on origin/dev, so the rebase target is available). Committed feature/dev-pitchfix-exc-restructure ebe92a9 (off acbf9e6);
     REBASED onto origin/dev 62974f6 (dev-wbspawn orphan fix merged meanwhile; CLEAN, disjoint files) → 9472b47; PUSHED HEAD:dev FF
     (62974f6..9472b47). origin/dev = 9472b47. Jest 120/1256 green, eslint clean, CRA build OK. Frontend-only, NO PianoidTuner.js, NO CUDA. -->
| <!-- (none active for dev-pitchfix) --> | | | |
<!-- dev-pitchfix locks RELEASED 2026-06-19 at Step 10a Phase 1. Held: PianoidTunner/src/components/HammerStringChart.jsx,
     src/PianoidTuner.js, src/components/__tests__/HammerStringChart.test.jsx. HAMMER-CHART 3 FIXES (team-lead greenlit):
     (1) tooltip-null crash — hideTipSafely(dispatchAction hideTip, isDisposed-guarded) before the debounced exactShape
     rebuild + in placeHandles setOption + tooltip confine/enterable belt (PRE-EXISTING e744160, width clamp exonerated);
     (2a) DEBOUNCE the zoomed exactShape /get_hammer_shape refetch EXACT_REFETCH_DEBOUNCE_MS=150 (position kept in deps —
     engine shape shifts with position, Hammer.py:154); (3) EMIT GUARANTEE — excitation diff-sync now diffs flat hammer_*
     params unconditionally (was skipped when a gauss cell selected → hammer edit never emitted). Committed
     feature/dev-pitchfix-hammer-fixes 4410f46 (off dev 2aab192), MERGED → dev acbf9e6 (--no-ff), PUSHED 2aab192..acbf9e6.
     origin/dev = acbf9e6. Jest 119/1250 green (+2), eslint clean, CRA build OK. Frontend-only, NO CUDA. -->
| <!-- (none active for dev-pitchfix) --> | | | |
<!-- dev-profchart locks RELEASED 2026-06-19 at Step 10a Phase 1. Held: PianoidCore/pianoid_middleware/chartFunctions.py + tests/unit/test_sound_test_profiling.py (also chart_config.json). Profiling MVP (kernel cycle-timing + over-budget/underrun markers in sound_test via render_hints, online-only, include_profiling toggle). MERGED to PianoidCore dev 89b1e9f (--no-ff, off 818bd9b) + PUSHED origin/dev (818bd9b..89b1e9f). Backend Python only, NO CUDA rebuild. Tests 13 new + 52 existing green; live audio_on population check PASSED (430 cycles, 31.6% over-budget, 2/424 underruns). Worktree wt-profchart removed. -->
| <!-- (none active for dev-profchart) --> | | | |
<!-- dev-pitchfix lock RELEASED 2026-06-18 at Step 10a Phase 1. PianoidTunner/src/PianoidTuner.js.
     Pitch-selection fix: (A) bare-backend safety-net effect re-issues loadPreset when health shows
     reachable && pianoid_loaded=false; (B) removed beforeunload→POST /api/stop-backend (killed backend on
     reload). Committed feature/dev-pitchfix-reload-bootstrap ccfbf06 (off dev ee0df28), MERGED to PianoidTunner
     dev bfd1d88 (--no-ff). Full Jest 119/1245 green, live-verified audio_off (reload keeps backend up 12/12;
     forced-bare auto-recovers ~1s; pitch selectable post-reload). Pre-existing bug (02caf5f), not the batch merges.
     ★REVERTED 2026-06-18 per team-lead/user: the diagnosis was a SYMPTOM-MATCH (a reload-triggered backend-kill
     that yields the same "no notes / can't select pitch") but NOT the user's confirmed bug — the user never
     reloaded, and their failure is on a different (broken-wheel) system (G1 look-alike). git revert -m 1 bfd1d88
     → revert commit eb36729, PUSHED origin/dev (bfd1d88..eb36729); PianoidTuner.js now byte-identical to ee0df28.
     STARTUP_TROUBLESHOOTING "reload is safe" note also reverted. feature/dev-pitchfix-reload-bootstrap (ccfbf06)
     kept for reference but OFF dev. Awaiting the user's ACTUAL error before re-approaching. -->
| <!-- (none active for dev-pitchfix — released + reverted) --> | | | |
<!-- dev-excpopup locks RELEASED 2026-06-17 at Step 10a Phase 1 — FINAL: 2 commits on
     feature/dev-excpopup-energy-popup off dev 7f03e90, worktree D:/repos/wt-excpopup. Held + released:
     ExcitationProperties.jsx, Excitation.jsx, ExcitationProperties.energyPopup.test.jsx (HammerStringChart.jsx
     lock RELEASED — wheel commit DROPPED, file byte-identical to dev).
     Commits: 4dfeb86 (energy tunables → MUI popup + hammer-mass accessible), 12f1d28 (gauss params table
     no longer overlaps chart — container 140→210px + stretch + overflow hidden). Jest green, CRA build clean.
     Popup + overlap LIVE-verified (isolated :5050 Belarus, audio_off; before/after/popup screenshots in logs).
     ★WHEEL ITEM DROPPED 2026-06-17 per team-lead: the hammer latency is in the SOUND not the visual — an
     instant chart redraw would MISMATCH (chart shows new shape, sound still old). Commit fa4d4cf reverted
     (git reset --hard HEAD~1); HammerStringChart.jsx untouched vs dev. Sound-latency investigation → dev-excenergy5.
     NOT merged — HOLD for user test. Throwaway :5050 backend + frontend-URL redirect fully reverted. -->
<!-- dev-wbspawn locks RELEASED 2026-06-17T12:45:00Z at Step 10a Phase 1 (frontend commit 73f32f0 on
     feature/dev-wbspawn-placement off PianoidTunner dev 7f03e90, worktree D:/repos/wt-wbspawn). Held:
     PianoidTunner/src/PianoidTuner.js, src/hooks/useSettings.js, src/components/ObjectInspector.jsx
     (+ NEW src/utils/workbenchPlacement.js + src/utils/__tests__/workbenchPlacement.test.js). Workbench
     spawn placement: (1) BUG FIX — spawn no longer gathers+rebuilds ALL bottom-pinned panes (relocate
     gone); appendToScreenBottom grows the bottom stack in place, existing panes stay put. (2) NEW MODE —
     dockUnderPanel docks the new WB under its source param's pane. (3) GLOBAL SETTING —
     workbenchSettings.placementMode (screen-bottom default / panel-bottom), Select in Workbench Settings
     gear (auto-rendered via ObjectInspector PARAMETER_CONFIG). Pure transforms extracted to
     workbenchPlacement.js; PianoidTuner net -43 LOC (deleted dead buildStack/collectBottomPinned/
     stripBottomPinned). Jest 118/1241 green (+11, 0 regressions), CRA build clean (eslint), setting
     live-verified (chrome-devtools, port 3011 vs shared :5000, both options render); no-relocate +
     panel-bottom UNIT-proven against exact user scenarios (live click-through needs a loaded preset =
     /load_preset, forbidden — dev-excenergy5 owns shared :5000). Frontend-only, NO CUDA. NOT merged —
     HOLD for user/team-lead. Docs (OVERVIEW Workbench-spawn-placement) + log + screenshot on
     PianoidInstall master. Agent STAYS ALIVE. -->
| <!-- (none active for dev-wbspawn) --> | | | |
<!-- dev-excenergy's constants.py calibration lock RELEASED 2026-06-17 by dev-energycal-20260617-124636 at Step 10a Phase 1.
     COLLISION-GUARD RESOLUTION: dev-excenergy had ALREADY committed the exact calibration on
     feature/dev-excenergy-energy-calibration (PianoidBasic commit 44218c5: EXCITATION_IMPULSE_CALIBRATION 1.0 -> 2.2e-05)
     + installed it into the wheel, but went idle without reporting/merging. dev-energycal INDEPENDENTLY re-measured offline
     (audio_off): reference Belarus_196modesC p60 v127 init-vol100 slider64 peaked 6.93e13 = 32251x the INT32 rail (+90 dBFS)
     at c=1.0; AFTER c=2.2e-05 -> 1.53e9 (-2.94 dBFS, within range, no clip). CONFIRMS 44218c5 exactly. No duplicate branch
     made (redundant feature/dev-energycal-loudness deleted). 44218c5 is the deliverable; HOLD for team-lead merge approval.
     ★dev-excenergy RESUMED 2026-06-17 (team-lead confirmed it owns the calibration; dev-energycal stood down): restored the
     working tree to feature/dev-excenergy-energy-calibration @ 44218c5, rebuilt the wheel from it, verified the INSTALLED
     default = 2.2e-05 + built-wheel render in-range (-2.94 dBFS). Calibration harness committed on master
     (docs/development/diagnostics/dev-excenergy-energy-calibration.py). Still HELD for team-lead merge. -->
| <!-- (none active for energy calibration — dev-excenergy 44218c5 verified by dev-energycal, held for merge) --> | | | |
<!-- dev-msave locks RELEASED 2026-06-17T10:10:00Z at Step 10a Phase 1 (commit 73a9438 on
     feature/dev-mosaicref-save-current off dev 7f03e90, in worktree D:/repos/wt-mosaicref2). Held:
     PianoidTunner/src/PianoidTuner.js, src/components/MosaicConfigManager.jsx, src/components/ToolBar.jsx,
     src/hooks/__tests__/mosaicConfigStore.test.jsx. Mosaic "save current config under current name" (update
     active in place via reused saveConfigAs overwrite path; ToolBar Save button + Manage-popup "Save to
     <name>" button). Jest 33/33, CRA build clean, live-verified (chrome-devtools, port 3010). NOT merged —
     HOLD for user/team-lead approval. -->

<!-- dev-excenergy MainKernel.cu lock RELEASED 2026-06-16 (Option A energy-only revert DONE + pushed). Reverted
     the two W5 commits on PianoidCore dev: 4c935b9 (reverts bf5f720 reset PRIMARY) + 81f0417 (reverts e3e31df
     soft-limiter removal); dev 9aaaa2d..81f0417 → origin/dev. MainKernel.cu now byte-identical to pre-W5 044f375;
     energy files + 654 init fix untouched. ENERGY-ONLY HEAVY --both rebuilt + L1 + L2 200 + energy linear
     (mass×2→RMS×2.002). PRESERVED ORIGINALS for the separate re-merges: e3e31df (soft-limiter removal),
     bf5f720 (reset PRIMARY). dev-excenergy STAYS ALIVE (decay + reset/soft-limiter re-merges ahead) — will
     re-acquire MainKernel.cu then. -->
| <!-- (no active locks) --> | | | |
<!-- dev-mosaicref locks RELEASED 2026-06-16 at Step 10a Phase 1 (frontend commit c3f777f on
     feature/dev-mosaicref-snapshot-fix off dev 2f320f1). Held: PianoidTunner/src/hooks/mosaicConfigStore.js,
     src/PianoidTuner.js, src/hooks/__tests__/mosaicConfigStore.test.jsx. FIX the merged save-mosaic-config bug
     (saved layouts all show the last one): cloneLayout deep-copy snapshots on save-as/seed/select/delete +
     REMOVED the live→active auto-mirror (named configs are frozen, change only on explicit save/rename/delete).
     Full Jest 115/1197 green, eslint 0, live-verified (save A w/Modes → remove Modes → save B ⇒ A frozen,
     A!=B). Frontend-only, NO CUDA. NOT merged — HOLD for user test. ★Behaviour note: this removes the T1
     auto-persist-into-active-config mirror (flagged to team-lead). -->
<!-- dev-excenergy locks RELEASED 2026-06-16 at Step 10a Phase 2 (user-approved "merge and push energy model").
     Physics-based excitation energy (B2) + reset fix + soft-limiter removal MERGED + PUSHED across all 3 repos:
     PianoidBasic dev 445e87a (d86b477..445e87a), PianoidCore dev 9aaaa2d (974a19f..9aaaa2d), PianoidTunner dev
     7f03e90 (2df8658..7f03e90). All 5 lock-sets released:
       - PianoidBasic model: PhysicalParameters.py, ModelParams.py, StringExcitation.py, constants.py, StringMap.py, Pitch.py.
       - PianoidCore kernel: gaussTest.cu/.cuh, Pianoid_excitation.cu, Pianoid.cuh, Pianoid.cu, Pianoid_parameters.cu,
         AddArraysWithCUDA.cpp, Pianoid_synthesis.cu, MainKernel.cu (W5-A soft-limiter removal e3e31df + W5-B reset
         PRIMARY accumulator-clear bf5f720).
       - PianoidCore middleware: pianoid.py, parameter_manager.py, backendServer.py, excitation_coefficients.py (NEW).
       - PianoidTunner FE: excitationImpulse.js (NEW), useExcitationEnergy.js (NEW), ExcitationEnergyEditor.jsx (NEW),
         PianoidTuner.js, Excitation.jsx, ExcitationProperties.jsx.
     REBUILD: W5 HEAVY --both build STANDS (merged dev byte-identical to built tips); post-merge L2 200. Reset
     CONFIRMED FIXED + energy linear (mass×2→RMS×2) by offline measurement. AUDIBLE USER-GATED on the 56-SM box.
     ★dev-excenergy STAYS ALIVE for the aftersounds/DECAY follow-up (dev-reset Phase-11 spec, pending user decision)
     — it will re-acquire MainKernel.cu (+ feedback files) for that separate later kernel change + HEAVY build + merge. -->
| <!-- (no active locks) --> | | | |
<!-- dev-gausscp lock RELEASED 2026-06-15 at Step 10a Phase 1 (frontend commit a78d0c4 on
     feature/dev-gausscp-hammer-chart). Held: HammerStringChart.jsx (ExcitationProperties.jsx re-locked precautionarily,
     NOT edited this round). 3 hammer-chart enhancements: (1) style matched to Gauss/excitation chart (CHART_COLORS,
     circle symbols, fill); (2) zoom toggle → discrete string-node view (scatter+stems+value labels; sampled from the
     analytic curve — exact engine per-node needs backend hammer_shape exposure, flagged); (3) mouse-wheel on the
     selected handle, emit-on-settle. Jest 115/1189 green (+5), eslint 0, live-verified (2 screenshots). NOT
     merged/pushed — HOLD for user live test. Docs (OVERVIEW) + screenshots + log on PianoidInstall master. STAYS ALIVE. -->
| <!-- (none active for dev-gausscp — released at Phase 1) --> | | | |
<!-- dev-gausscp locks RELEASED 2026-06-15 at Step 10a Phase 1 (frontend commit e66435d on
     feature/dev-gausscp-hammer-chart off dev 99b6f25). Held: PianoidTunner/src/components/ExcitationProperties.jsx
     + NEW HammerStringChart.jsx (also edited Excitation.jsx + PianoidTuner.js + 2 tests, all this agent's). Interactive
     ECharts hammer-on-string chart replacing position/width/sharpness sliders; 3 draggable handles (center=position
     ratio 0–0.5, right-edge=width meters, peak=sharpness 0–1) + NumInputs; folded in width/sharpness units audit
     (old Width-mm 0.1–13 over meters + Sharpness-% 1–100 over [0,1] both fixed). Jest 115/1184 green, eslint 0,
     live-verified (screenshot). NOT merged/pushed — HOLD for user live test. Docs (OVERVIEW) + screenshot + log on
     PianoidInstall master. Agent STAYS ALIVE. -->
| <!-- (none active for dev-gausscp — released at Phase 1) --> | | | |
<!-- dev-gausscp lock RELEASED 2026-06-15 at Step 10a Phase 1 (frontend commit 966f3d1 on
     feature/dev-gausscp-position-units off dev 8049673). Held: PianoidTunner/src/components/ExcitationProperties.jsx
     (+ NEW __tests__/ExcitationProperties.positionUnits.test.jsx). Position (hammer_position) units fix: % display
     (ratio×100) / ratio send (÷100) via handlePositionChange; slider range 0–50% (ratio 0–0.5, string symmetric);
     1/11,1/9,1/7 chips write ratios (1/N) not (1/N)*100. Jest 115/1183 green (+1/+5), eslint 0, live-verified
     (slider max=50, field 0.15→"15", 1/9 chip sends ratio 0.1111). NOT merged/pushed — HOLD for user live test.
     Docs (OVERVIEW Position-units paragraph) + screenshot + log on PianoidInstall master. Agent STAYS ALIVE. -->
| <!-- (none active for dev-gausscp — released at Phase 1) --> | | | |
<!-- dev-gausscp locks RELEASED 2026-06-15 at Step 10a Phase 1 (frontend commit 3a99265 on
     feature/dev-gausscp-gauss-copy-paste off PianoidTunner dev b913ee4). Held: PianoidTunner/src/{PianoidTuner.js,
     components/GaussEditor.jsx, components/ExcitationProperties.jsx, components/Excitation.jsx, hooks/usePreset.js}
     + NEW {components/GaussCopyPasteButtons.jsx, hooks/useGaussClipboard.js, utils/gaussClipboard.js} + 3 NEW tests;
     DELETED dead components/{GaussianParameterGrid.jsx,GaussianParameterGrid.css,CopyPastMenu.jsx}. Excitation gauss
     copy/paste (COPY/PASTE/ALL buttons left of the 5x4 grid; cell/row/col/whole selection; paste current pitch via
     existing batch path; paste ALL pitches via new usePreset.pasteExcitationToAllPitches bulk-range emit). Jest
     114/1178 green (+3/+19), eslint 0, prod build clean, live bundle mounts error-free. NOT merged/pushed — HOLD for
     user live test (★live click-through + bulk-range engine emit UNVERIFIED here: this 56-SM box destabilizes the
     backend under audio_on/ASIO, same box constraint as dev-uiqueue). Docs (OVERVIEW) + log on PianoidInstall master
     d738324. Agent STAYS ALIVE. -->
| <!-- (none active for dev-gausscp — released at Phase 1) --> | | | |
<!-- dev-uiqueue T2 FOLLOW-UP 2 lock RELEASED 2026-06-15 (frontend commit on feature/dev-uiqueue-mosaic-bottombar).
     Held: PianoidTunner/src/components/BottomBar.jsx. Reset → wide RED contained Button labelled "RESET"
     (theme error palette, 200x56) per user feedback. eslint 0, BottomBar Jest 6/6, live-verified
     (text=RESET, 200x56, error.main red). NOT merged — held with the dev-uiqueue batch. -->
<!-- dev-uiqueue T2 FOLLOW-UP lock RELEASED 2026-06-15 (frontend commit on feature/dev-uiqueue-mosaic-bottombar).
     Held: PianoidTunner/src/components/BottomBar.jsx. Made the Reset button LARGE (64x64 square, 40px icon,
     rounded border) to match the big Volume/Feedback sliders per user feedback. eslint 0, BottomBar Jest 6/6,
     live-verified (screenshot). NOT merged — held with the rest of the dev-uiqueue batch for user test. -->
<!-- dev-uiqueue T1 locks RELEASED 2026-06-15 at Step 10a Phase 1 (frontend commit e78bc3e on
     feature/dev-uiqueue-mosaic-bottombar off dev 0f3cfe0). Held: PianoidTunner/src/PianoidTuner.js,
     src/components/ToolBar.jsx, + NEW src/hooks/mosaicConfigStore.js, src/components/MosaicConfigManager.jsx,
     + 2 NEW test files. Savable mosaic layouts (selector + Manage popup). Full Jest 110/1153 green, eslint 0,
     build compiles, live-verified. NOT merged — HOLD for user live test. T2 (bottom bar) NOT yet started —
     awaits team-lead go-ahead; will re-acquire PianoidTuner.js + ToolBar.jsx then. Agent STAYS ALIVE. -->
<!-- dev-uiqueue T2 locks RELEASED 2026-06-15 at Step 10a Phase 1 (frontend commit c301966 on
     feature/dev-uiqueue-mosaic-bottombar). Held: PianoidTunner/src/PianoidTuner.js, src/components/ToolBar.jsx,
     src/hooks/usePreset.js, + NEW src/components/BottomBar.jsx, src/components/__tests__/BottomBar.test.jsx.
     Bottom bar (relocated Volume/Feedback/Reset large + always-visible inline Sensitivity); RESTORED
     volume-sensitivity (regression = dev-09cf overflowY:hidden clipped the popover, measured ~2.2px/129px
     visible) by relocation; NEW feedback-sensitivity (curve base). Full Jest 111/1159 green, eslint 0, build
     compiles, live-verified (both Sensitivity fields commit; audible curve effect needs user's box — 56-SM GPU
     audio_on crash here). NOT merged — HOLD for user live test. dev-uiqueue session COMPLETE (T1+T2 both on
     this one branch, both unmerged). Agent stays alive for feedback. -->
| <!-- (none active for dev-uiqueue — T1+T2 released, held for user test) --> | | | |
<!-- dev-dynwb refinement locks RELEASED 2026-06-14 at Step 10a Phase 1 (refinement commit). Held:
     PianoidTunner/src/components/DrawableChart/DrawableChart.jsx, BarChart.jsx, PianoidTuner.js (+
     NEW DrawableChart/__tests__/DrawableChart.dynamicColor.test.jsx). RowEditor.js + SoundChannelsAggregateChart.jsx
     were re-locked but NOT edited this round (isDynamic threads PianoidTuner→RowEditor chartProps→BarChart→
     DrawableChart; RowEditor's existing chartProps spread carries it unchanged). User msg 3515 refinements:
     (c) DYNAMIC workbench bars in a DISTINCT theme accent (DrawableChart isDynamic → secondary.main vs
     fixed primary.main; explicit seriesColor wins; default false = byte-identical); (d) bars FILL the field
     with a small gap (removed barMaxWidth:40 cap, kept barCategoryGap:"10%"; ruler alignment unaffected).
     Committed feature/dev-dynwb-avgsc-workbench-reuse 91266eb. Full Jest 107/1123 green, eslint 0, build
     compiles. ★Live pixel-verified: dynamic=rgb(255,165,0) orange vs fixed=rgb(25,118,210) blue, bars fill
     field (screenshots). Frontend-only, NO CUDA. NOT merged — held for user live test (same hold as the rest
     of the batch). -->
| <!-- (none active for dev-dynwb) --> | | | |
<!-- dev-dynwb locks RELEASED 2026-06-14 at Step 10a Phase 1 commit. Held: PianoidTunner/src/PianoidTuner.js,
     src/utils/workbenchTitle.js (NEW), src/components/BarChart.jsx, src/components/RowEditor.js,
     src/components/SoundChannelsAggregateChart.jsx (+ 2 NEW test files: utils/__tests__/workbenchPaneTitle.test.js,
     components/__tests__/SoundChannelsAggregateChart.fanOutDecouple.test.jsx). SoundChannelsPane.jsx was locked but
     NOT edited (the avg-SC drawing reuse landed entirely inside SoundChannelsAggregateChart, which SoundChannelsPane
     already renders — no pane-level change needed). TWO independent pieces of the workbench batch (user msgs 3503+3512):
     (1) TITLE (msg 3512): workbench pane title = the edited param, "Workbench" word dropped; pure
         utils/workbenchTitle.js workbenchPaneTitle helper + collapsed PianoidTuner.renderTile's 2 duplicated branches
         + non-empty "Workbench" fallback. Committed PianoidTunner feature/dev-dynwb-avgsc-workbench-reuse 329957c.
     (2) AVG-SC reuses workbench DRAWING (msg 3503): avg-SC strings axis now renders via RowEditor→BarChart→DrawableChart
         (shared workbench drawing) instead of its own DrawableChart+ruler; BarChart/RowEditor widened with optional
         pass-throughs (omit=byte-identical for all existing callers); EMIT stays the 1→N fan-out (modesVectorDrawn/
         pitch="averaged"), SC channel-decouple preserved (mode axis only, never selectedPitches). Committed 501d66c.
     Branch feature/dev-dynwb-avgsc-workbench-reuse off dev 62696e4. Full Jest 106/1119 green (+2 suites/+11 tests,
     ZERO regressions; named SC-decouple guards green); eslint 0 errors; production build compiles; live-verified
     (avg-SC renders via RowEditor — docs/development/screenshots/dev-dynwb-avgsc-via-roweditor.png). Frontend-only,
     NO CUDA. NOT merged — HOLD for user live test (Step 9). ★PARTS 1+2 (dynamic/fixed workbench WIRING) NOT touched —
     verdict Q2 (already work in merged dev), held for the user's a/b/c/d answer. Docs (OVERVIEW
     SoundChannelsAggregateChart/RowEditor/BarChart rows + NEW "Workbench pane title" subsection) + session log on
     PianoidInstall master. -->
| <!-- (none active for dev-dynwb) --> | | | |
<!-- dev-tbmirror locks RELEASED 2026-06-14 at Step 10a Phase 2 (user-approved merge msg 3506). Toolbar BATCH MERGED to
     PianoidTunner dev 62696e4 (--no-ff, off 19756de) + PUSHED origin/dev. Held: ToolBar.jsx, PianoidTuner.js,
     useWindowManager.js, MidiComponent.jsx (precautionary, not edited), useMidiStatus.js (NEW), + 4 NEW/edited test
     files (useMidiStatus.test.jsx, useWindowManager.midiRemoved.test.jsx, ToolBar.presetSelector.test.jsx,
     toolbarMidiRemoved.source.test.js). 5 feature commits: 25ce0de mirror-field removal (blur fix) · db624bb MIDI
     button+indicator+popup+drop-mosaic-pane · 5982cc8 MIDI tests · cb34e5a reorder+preset-name removal · 8c52e03
     BOTH-windowCategories guard. Frontend-only, NO CUDA. Full Jest 104/1108 green, eslint 0, build compiles.
     ★dev-dynwb branched off the SAME dev 19756de in parallel — this merge moved dev to 62696e4; dev-dynwb reconciles
     later (expected/planned). Session log archived to logs/archive/. -->
| <!-- (none active for dev-tbmirror) --> | | | |
<!-- dev-tbmirror locks RELEASED 2026-06-14 at Step 10a Phase 1 commit (mirror-removal). Held: PianoidTunner/src/components/ToolBar.jsx,
     src/PianoidTuner.js, src/components/__tests__/ToolBar.commitKey.test.jsx (DELETED), src/components/__tests__/ToolBar.presetSelector.test.jsx.
     Removed the redundant top-toolbar "mirroring" selected-parameter NumInput (echoed selectedParameter.value — a second
     edit surface for a value every pane already edits in place; as a shared persist-on-blur instance it was the
     contamination surface the dev-blur commitKey guard existed to patch). ToolBar.jsx: delete mirror block + Divider +
     NumInput import + selectedParameter/onValueChange props + update responsive-overflow comment (695→650 LOC, YELLOW).
     PianoidTuner.js: stop passing selectedParameter/onValueChange to <ToolBar> (both stay defined — pane-shared).
     Deleted ToolBar.commitKey.test.jsx (tested the removed field); added a field-removed negative assertion to
     ToolBar.presetSelector.test.jsx. Committed feature/dev-tbmirror-remove-toolbar-mirror 25ce0de (off dev 19756de).
     Full Jest 101/1098 green (baseline 102/1101; -1 suite/-4 + 1 new = net -3), eslint 0 new errors, build compiles.
     Frontend-only, NO CUDA. Live-verified (chrome-devtools): toolbar has no mirror field; all other controls + responsive
     overflow intact. NOT merged — HOLD for user live test. Docs (OVERVIEW ToolBar+NumInput rows) + log on master. -->
<!-- dev-excwb ALL locks RELEASED 2026-06-14 at Phase 2 (user msg 3485 "commit merge push"). The whole dev-excwb batch —
     Excitation workbenches (3941714) + maximized-Close-icon fix (b222b66) + A+B kernel-traffic fix (a5e2fd0) — was
     MERGED to PianoidTunner dev 19756de (--no-ff) and PUSHED origin/dev (1a2dba2..19756de, no force). Held files
     across the batch: PianoidTuner.js, useLayout.js, useValuesHistory.js, components/Excitation.jsx,
     ExcitationProperties.jsx, GaussEditor.jsx, GaussCell.jsx, hooks/usePreset.js, WorkbenchFunctionTools.jsx (+ 4 NEW
     test files). Full Jest 102/1101 green, eslint 0, build compiles. Frontend-only, NO CUDA rebuild. User-tested +
     approved. Deferred follow-up logged: string per-pitch GPU uploads inside one bulk backend call (GPU-batching). -->
| <!-- (none active for dev-excwb) --> | | | |
<!-- dev-excwb close-icon-fix locks RELEASED 2026-06-11 at Step 10a Phase 1 commit. Held PianoidTunner/src/PianoidTuner.js
     + hooks/useLayout.js (+ 1 NEW test). GENERAL bug (user msg 3476): renderToolbarControls suppressed Close (X)
     whenever isFullscreen → maximized panes (incl. Excitation workbenches) showed only Restore. Fix: render Close in
     both states; maximized → useLayout.closeMaximized(id) (removeLeaf prunes the leaf from layoutBackup → restore
     pruned backup → exit fullscreen; default-layout fallback). Committed feature/dev-excwb-excitation-workbench
     b222b66. Full Jest 101/1098 green, eslint 0, build compiles, live-verified. Frontend-only. NOT merged — HOLD
     (merge gate: this fix + Excitation-workbench feature + user axis-confirm + user live test). -->
| <!-- (none active for dev-excwb) --> | | | |
<!-- dev-excwb locks RELEASED 2026-06-11 at Step 10a Phase 1 commit. Held: PianoidTunner/src/PianoidTuner.js,
     components/Excitation.jsx, components/ExcitationProperties.jsx, components/GaussEditor.jsx,
     hooks/useValuesHistory.js (+ 2 NEW test files). GaussCell.jsx was locked but NOT edited (affordance lives on
     the GaussEditor param-row label, not the cell). Excitation→Workbench: every hammer + gauss param now opens a
     Workbench (BarChart IconButton) editing across pitches, mirroring Strings/Modes; reused the shared mechanism
     (updateDefaultWorkbench/handleOpenWorkbench/computeWorkbenchValues/handleVectorChange). Fixed 2 latent bugs:
     handleVectorChange Excitation branch wrote stringsHistory (→ excitationHistory) + calcChange pitchesVectorDrawn
     was flat-only (→ gauss-aware nested write). Committed feature/dev-excwb-excitation-workbench 3941714 (off dev
     1a2dba2). Full Jest 100/1095 green, eslint 0, build compiles. Frontend-only, NO CUDA. NOT merged — HOLD for
     user live test. Docs (pianoid-tunner OVERVIEW) + log on PianoidInstall master. -->
| <!-- (none active for dev-excwb) --> | | | |
<!-- dev-mwfix locks RELEASED 2026-06-11 at Step 10a (Workbench feature wrap; user-approved merge+push+sync msg 3458).
     Held: PianoidTunner/src/utils/curveShapes.js (NEW) + curveShapes.test.js (NEW) + WorkbenchFunctionTools.jsx (NEW) +
     PianoidTuner.js. Workbench range-edit feature: apply-anchored-function (7 shapes, anchor value unchanged) + 2x-sticky
     linear c=0 wheel detent + extend/shrink (Excitation-style); uniform-value control removed per user. Committed
     079101d/30490cc/78e921c/9f3a8eb on feature/dev-mwfix-matrix-fixes, MERGED to PianoidTunner dev 23a1d38 (--no-ff).
     Full Jest 96/1080 green, eslint 0, build compiles. Frontend-only. (The earlier items 1-5 locks were already released
     at the prior Step 10a Phase 1 — see the comment below.) -->
| <!-- (none active for dev-mwfix) --> | | | |
<!-- dev-mwfix locks RELEASED 2026-06-10T18:30:00Z at Step 10a Phase 1 (all 5 items committed on
     PianoidTunner feature/dev-mwfix-matrix-fixes, off dev 5758019: 0c38c80 avg-SC ruler-align + ModesRule
     windowed positioning [item 1]; 925c96a P1-A tie/untie rollout complete + delete legacy shared-range zoom
     [item 2]; b732b31 P1-B delete dead mute write-path [item 3]; 9bb71f9 P2 cleanups (double calcChange,
     mutedMatrix, scListenToModes source, Feedback dead zoom) [item 4]; 71b2398 P3 render-without-range guard +
     cell-click decouple + explicit row order [item 5]). Held 9 files: SoundChannelsAggregateChart.jsx, ModesRule.js,
     PianoidTuner.js, useCurrentValues.js, SoundChannelsPane.jsx, MeasuredMatrix.jsx, usePreset.js, useSoundChannels.js,
     useMatrixHistory.js, PitchesModesMatrixCanvas.jsx (+2 NEW test files). ★SC channel-row decouple PRESERVED
     throughout (only SC MODE axis ties to global selection). Full Jest 95 suites/1030 tests green, eslint 0 errors,
     production build compiles. Frontend-only, NO CUDA build. NOT merged — HOLD on feature branch for user's live test.
     Docs (pianoid-tunner OVERVIEW) + session log on PianoidInstall master. -->
| <!-- (none active for dev-mwfix) --> | | | |
<!-- dev-bug1rt locks RELEASED 2026-06-10 at Step 10a Phase 2 (user-confirmed live debug test "Works ok" msg 3438; team-lead-authorized LOCAL merge + wrap). Held: PianoidCore pianoid_cuda/MainKernel.cu, Pianoid_synthesis.cu, OnlinePlaybackEngine.cu (probes-only, reverted to net-zero), Pianoid.cu (read-only, not edited), pianoid_middleware/chartFunctions.py.
     BUG-1 = DEBUG addKernel cudaErrorCooperativeLaunchTooLarge (recordOutputData register pressure + online SDL3 audio-driver SM consumption exceed cooperative co-residency → realtime thread 0-cycles at launcher/APPLY boot → silent no-sound + empty kernel). FIX-2 = debug-only __launch_bounds__(512,1) on addKernel (#ifdef PIANOID_DEBUG_DATA macro → empty in release → release codegen byte-identical, preserves live debug-online extraction). FIX-3 = check cudaLaunchCooperativeKernel return → PLOG_ERR + return 500 (fail-fast; also makes the steinway 58-block-on-56-SM kernel_status-500 failure loud). BUG-2 = _stop_online_engine clears endMainLoop on stuck loop-flag regardless of isRunning() (→ "Cannot render offline" after dead thread). Committed feature/debug-online-realtime-fix f96e266 (3 files +58/-4), MERGED to LOCAL PianoidCore dev d0136e5 (--no-ff). Docs (DEBUG_DATA.md RCA+fix) + session log on PianoidInstall master (e58cc6a + Phase-2 wrap). All 5 verify gates PASS + user-tested OK. NOT pushed — origin reconcile + push HELD pending user push decision. Session log archived. -->
| <!-- (none active for dev-bug1rt) --> | | | |
<!-- dev-debugboot-bacd Fix-B locks RELEASED 2026-06-09 at Step 10a Phase 1 commit. Held:
     PianoidCore/pianoid_middleware/backendServer.py + chartFunctions.py. /get_chart_test offline
     render no longer leaves the realtime playback thread stopped: backendServer _spawn_realtime_thread
     helper + pianoid._restart_realtime_thread hook (registered by load_preset); _restart_online_engine
     prefers the hook (restores long_running_procedure + `running` flag), falls back to start_pianoid()
     for serverless callers. Committed feature/debug-at-boot 3c4244a (+123/-5, incl.
     tests/unit/test_chart_restart_realtime_thread.py 3/3). Docs (SYSTEM_OVERVIEW threading) on master.
     3/3 Fix-B + 5/5 Fix-A unit; live: note_playback+mode_test keep backend_thread_running=TRUE (was
     dropping to False). Python middleware — NO CUDA rebuild. NOT merged — awaits user test + approval. -->
<!-- dev-debugboot-bacd lock RELEASED 2026-06-09 at Step 10a Phase 1 commit. Held:
     PianoidCore/pianoid_middleware/pianoid.py. Honor PIANOID_USE_DEBUG at module-import
     boot (select_cuda_variant_at_boot) so DEBUG wins the first pianoidCuda import + no-downgrade
     rule (release-request on a debug-active process is a no-op). Fixes debug-via-UI first-import
     race (frontend APPLY debug_mode=0 imported RELEASE first → later debug_mode=1 was a no-op).
     Committed PianoidCore feature/debug-at-boot cdee490 (pianoid.py + tests/unit/test_debug_variant_at_boot.py,
     +156/-1). Docs (BUILD_SYSTEM Runtime selection) + log on PianoidInstall master 40dc5c9. 5/5 unit +
     4/4 live tests (a-d) PASS. Python middleware, loads from source — NO CUDA rebuild. NOT merged —
     awaits user live-test + approval. -->
<!-- dev-cudaguard locks RELEASED 2026-06-10 at Step 10a Phase 1 commit (NOT merged/pushed — Phase 2
     after the user's live test on the no-CUDA box). No-CUDA graceful mode (Opt C). COMMITTED, 3 feature
     branches (held for the user's test, then merge per team-lead):
       - PianoidCore feature/no-cuda-gate `fa22dda` (off dev 8df0e56): pianoid_middleware/backendServer.py
         (_gpu_available cached CuPy probe + /load_preset 503 gate BEFORE destroyPianoid + /health gpu_available)
         + tests/system/test_no_cuda_gate.py (NEW, 7/7). Python-only, NO CUDA build.
       - PianoidTunner feature/no-cuda-apply-gate `3c8dad5` (off dev 5758019): src/hooks/useBackendHealth.js
         (gpuAvailable, default-true unless explicit false) + src/PianoidTuner.js (ensureBackendAndLoadPreset
         no-CUDA short-circuit + dep) + src/components/BackendStatusIndicator.jsx ("No CUDA" amber chip) +
         2 NEW Jest (BackendStatusIndicator.noCuda 5, useBackendHealth.gpuAvailable 3). Jest 8/8; BSI suite 11/11.
       - Outer worktree feature/dev-cudaguard `d6142af`: check-cuda.ps1 (limited-mode warning wording; detection
         logic from the prior broken-NVML fix). .ps1 only.
     Diagnostic diagnose-cuda.ps1 already SHIPPED to master (fa2cde1). PianoidBasic CPU synth DEFERRED (docs only:
     docs/proposals/no-cuda-cpu-synthesis-2026-06-10.md + WIP). Bookkeeping/docs committed on PianoidInstall master.
     start-pianoid.bat was locked precautionarily but NOT edited (contract sound; the gate lives in check-cuda.ps1
     + the backend). NO merge, NO push (Phase 2 pending user live test). -->
<!-- (no active dev-cudaguard locks — released at Phase 1) -->
<!-- dev-nvmldiag locks RELEASED 2026-06-10 at orchestrator Phase-2 wrap. Held (OUTER PianoidInstall, master):
     diagnose-cuda.ps1 (edit) + docs/development/diagnostics/dev-nvmldiag-mismatch-verdict-tests.ps1 (NEW harness).
     diagnose-cuda.ps1 4-round hardening SHIPPED to master (fa2cde1 -> 2cef064 -> 9b53ad9 -> 27f908e); verdict
     harness (28/28) PRESERVED to master in this wrap. .ps1-only, NO CUDA build. Tree clean. -->
<!-- dev-drvinstall locks RELEASED 2026-06-10 at orchestrator Phase-2 wrap (lock row was working-tree-only, never
     committed to master). Held (OUTER PianoidInstall, master): install-nvidia-driver.ps1, check-driver-health.ps1
     (NEW), setup-packages.bat (option 7), setup-dev.ps1 + 2 NEW harnesses. Driver detect+reinstall option 7 SHIPPED
     to master (ccf1b0c -> 04a3080 -> 60fcbeb); harnesses PRESERVED to master in this wrap. .ps1/.bat-only, NO CUDA
     build. All driver ops logic-tested only (no real choco/pnputil/DDU/reboot on this box). Tree clean. -->
<!-- dev-upcheck locks RELEASED 2026-06-10 at Step 10a Phase 1 commit (NOT merged/pushed — team-lead FFs
     feature/check-updates-integration-branch onto master + pushes). Held (OUTER PianoidInstall repo root):
     check-updates.ps1 (edit) + docs/development/diagnostics/dev-upcheck-edge-tests.ps1 (NEW, edge-test diagnostic).
     Hardened the launcher origin-ahead detector: compare HEAD vs the explicit REMOTE INTEGRATION BRANCH
     (origin/dev for Core/Tunner/Basic, origin/master for outer) instead of the current-branch upstream @{u},
     so a no-upstream local feature branch (or detached HEAD / merged-but-not-deleted branch) no longer reports
     "unknown" and silently skips the prompt. @{u} kept as secondary fallback; unresolvable ref + no upstream ->
     -1 unknown/skip (never errors). Added -WhatIf dry-run (prints per-repo decision, no MessageBox). PRESERVED:
     timeout-guarded fetch; git-missing/offline/any-failure -> exit 0 silent; Yes=10/No=0 pop-up; "+N" listing.
     VERIFIED non-disruptively (NO launch/pull/modal): -WhatIf on this machine = Core +4 / Tunner +13 behind
     origin/dev, Basic + outer up to date (exit 10); no-upstream bug condition still detects Core +4 (old code
     skipped it); git-unreachable -> exit 0; edge unit tests 10/10; AST-clean (209 LOC). Committed on
     feature/check-updates-integration-branch 6f99d68 (off master b5f9051, +222/-29, 6 files). .ps1-only — NO CUDA
     build, NO backend, NO stack. Docs (QUICK_START update-check paragraph) + session log on this branch. -->
<!-- dev-syschecks locks RELEASED 2026-06-09 at Step 10a Phase 1 (option-(a) /auto adjustment; NOT merged/pushed —
     team-lead FFs the feature branch onto master + pushes). Held: check-running-servers.ps1 (edit), check-cuda.ps1
     (edit); start-pianoid.bat NOT edited this round (already passes -Auto; per-case decision moved into the helpers).
     Adjusted the /auto routing per the user's option (a): running-servers /auto → SHOW Kill&restart/Cancel pop-up
     (timed WScript.Shell.Popup 30s; Yes→kill+0, No/timeout→cancel/20 = don't-kill-don't-launch); CUDA no-device /auto
     → SHOW (timed; OK/timeout→0, Cancel→30); CUDA SM<60 /auto → SUPPRESS (informational, shown only bare/interactive);
     bare/interactive → all 3 blocking MessageBox (unchanged). Show-ServerPrompt NEW; Show-CudaWarning gains -Kind
     [no-device|low-sm]. POPUP_TIMEOUT_SEC=30. VERIFIED static/AST/sim only (stack LEFT RUNNING — NO launch, NO live-
     port kill): both .ps1 AST-clean; REAL /auto+SM<60 on this 56-SM box → suppressed (exit0, no warning); REAL timed
     WScript.Shell.Popup → rc=-1 on 2s timeout (no hang); decision matrix + .bat RC routing all pass team-lead's
     required matrix (/auto+servers→shown, /auto+no-CUDA→shown, /auto+SM<60→NO popup, bare+SM<60→shown,
     bare+servers→shown). Committed feature/launcher-prelaunch-checks 749aba5 (+125/-51). Docs (QUICK_START /auto
     column) on this branch. NOT merged/pushed. Prior Phase-1 commits this branch: 2dff830 feat + 1951b83 docs +
     e72f505 chore (off master c6baf4e). -->
<!-- (none active for dev-syschecks — released at Phase 1) -->
<!-- dev-syschecks locks RELEASED 2026-06-09 at Step 10a Phase 1 commit (NOT merged/pushed — team-lead FFs the
     feature branch onto master + pushes). Held (OUTER PianoidInstall repo root): start-pianoid.bat (edit),
     check-running-servers.ps1 (NEW), check-cuda.ps1 (NEW). TWO best-effort pre-launch checks added to
     start-pianoid.bat, each a self-contained PowerShell helper invoked like check-updates.ps1 (exit code read by
     the .bat; any failure → exit 0 = launch): (1) check-running-servers.ps1 — Get-NetTCPConnection -State Listen on
     3000/3001/5000/5001; if a stack is up → MessageBox (Yes=Kill&restart via PORT-TARGETED Stop-Process on those
     ports' OwningProcess PIDs ONLY, never /IM; No=Cancel→exit 20). -Auto = warn+leave-untouched+proceed (never kills
     a live stack unattended). (2) check-cuda.ps1 — venv python + cupy (getDeviceCount + multiProcessorCount) via a
     TEMP FILE (python -c mangles embedded quotes), nvidia-smi availability fallback; no device → warn, SM<60 → warn
     (cooperative block_count=strings/4 may exceed SMs; use *_56SM), ≥60 → silent; Cancel→exit 30; -Auto = print+proceed.
     start-pianoid.bat: running-servers block (RC20→cancel) after node_modules check L97-124, CUDA block (RC30→cancel)
     after :after_update_check L170-198; both gated by `if not exist ...ps1`+`where powershell`, pass -Auto when
     NOPROMPT=1. FLAG DESIGN (flagged to team-lead): under /auto both run NON-interactively (safe-default+proceed) so
     an unattended shortcut never hangs on a pop-up. VERIFIED static/AST/sim only (stack LEFT RUNNING — NO launch, NO
     live-port kill): both .ps1 AST-clean; check-cuda -Auto via prod path detected RTX 4070 SUPER=56 SMs→correct <60
     warning; check-running-servers -Auto detected live [3000,3001,5001]+left untouched; .bat full routing S1-S5 (bare
     all-clear→LAUNCH, servers-up Cancel→abort, CUDA Cancel→abort, /auto→both run w/-Auto→LAUNCH, /auto-noupdate→update
     skipped+both run→LAUNCH). Committed feature/launcher-prelaunch-checks (2dff830 feat + 1951b83 docs, off master
     c6baf4e). NO CUDA build, NO backend, NO stack launched. Docs (QUICK_START Pre-launch-safety-checks subsection) +
     session log on this branch. NOT merged/pushed. -->
<!-- (none active for dev-syschecks — released at Phase 1) -->
<!-- dev-b70f locks RELEASED 2026-06-09 at Step 10a Phase 1 commit (NOT merged/pushed — team-lead FFs onto
     master + pushes). Held (OUTER PianoidInstall repo root): start-pianoid.bat (edit), check-updates.ps1 (NEW),
     make-shortcut.bat (NEW), make-shortcut.ps1 (NEW). Launcher enhancements: (1) start-pianoid.bat parses %1 →
     /auto (alias --no-prompt) skips both keypress pauses; /auto-noupdate (alias /no-update-check) also skips the
     update check; bare = current interactive prompts; error path still pauses in /auto so a shortcut-launched
     failure stays visible. (2) Best-effort origin-ahead update check before launch via check-updates.ps1 →
     Yes/No pop-up → Yes calls update-repos.bat then launches; fully guarded (git-missing/offline/no-upstream/any
     failure → silent fall-through to launch, NEVER blocks/hangs/errors). check-updates.ps1 = timeout-guarded
     git fetch + rev-list ahead-count for Core/Tunner/Basic(current branch)+Install(master); exit 10=update/0=skip.
     (3) make-shortcut.ps1+.bat = WScript.Shell COM → Desktop\Pianoid.lnk targeting `start-pianoid.bat /auto`,
     repo-root workdir, favicon.ico icon. VERIFIED non-disruptively (stack left running): both .ps1 AST-parse clean;
     start-pianoid.bat all 4 flag branches sim-tested via stubbed copy through cmd /c; check-updates.ps1 git-unreachable→
     exit 0 + ahead-detection unit-tested (up-to-date/ahead/no-upstream/missing) + real read-only 4-repo probe (6.0s,
     no pop-up) + Main Yes→10/No→0 decision; make-shortcut real run → Desktop\Pianoid.lnk created, all props asserted.
     Committed feature/launcher-update-check-shortcut da7c1d5 (off master d7465a3). NO CUDA/backend, NO stack launched,
     NO real pull. Docs (QUICK_START.md launch subsection) + session log on this branch too. -->
<!-- dev-09cf locks RELEASED 2026-06-09 at Step 10a Phase 1 commit (user-approved scroll fix, "OK"). Held:
     PianoidTunner/src/components/ToolBar.jsx. Top-toolbar responsive truncation fix — `<Toolbar>` gets a contained
     `sx` (overflowX:auto + overflowY:hidden + `& > * {flexShrink:0}` + thin dark-theme scrollbar) so the dense
     heterogeneous control row scrolls instead of clipping its rightmost controls at narrow widths; wide layout
     byte-identical. Verified live (chrome-devtools @1600/800/500 — all controls reachable, no page-level h-scroll,
     wide unchanged) + full Jest 91 suites/1003 tests green + eslint 0 new. Committed on PianoidTunner
     feature/toolbar-responsive-overflow (off current HEAD feature/eslint-casing-fix; SHA in session log). NOT
     merged/pushed — team-lead FFs onto dev + pushes (+ Phase 2 wrap). Docs (OVERVIEW ToolBar row) + session log on
     PianoidInstall master. Frontend-only, NO CUDA/backend. -->
<!-- dev-pipefix locks RELEASED 2026-06-09 — merged: eslint fix → PianoidTunner dev (8b9acf3); synthetic-dataset → dev (Core a35800a, Tunner 8b9acf3); outer setup-pianoid scripts + update-repos.{bat,sh} (NEW) + docs (QUICK_START/LINUX_BUILD Status_indicator_OK→dev) → master. -->
<!-- dev-setuppath locks RELEASED 2026-06-08 at Step 10a Phase 1 commit. Held (OUTER PianoidInstall repo root):
     setup-dev.ps1, setup-path-guard.ps1 (NEW), tests/setup-path-guard.Tests.ps1 (NEW). PATH-preserving guard so
     setup-dev.ps1 stops breaking NI LabWindows/CVI: the script doesn't persist PATH itself, but the installers it
     launches (Python PrependPath, VS Build Tools, CUDA, Node MSI) rewrite the persistent PATH and drop NI/CVI
     entries. Fix: setup-path-guard.ps1 (8 pure/unit-tested helpers) snapshots Machine+User PATH before installers +
     writes a timestamped backup + NI/CVI heads-up, then reconciles dropped entries after (dedup, survivors-first,
     2047-char truncation guard refuses-not-truncates); Python PrependPath=0 by default (-PythonPrependPath opt-in).
     Also ASCII-cleaned the 4 pre-existing em-dashes (removes a latent no-BOM ParseFile fragility). Unit test 17/17
     PASS (PS 5.1, no Pester dep); ParseFile clean. NO CUDA build, no stack, no audio, no servers. Committed on
     feature/setup-path-preserve-cvi bec2ccf, MERGED to master d7df7f4 (--no-ff), pushed to origin. Docs (BUILD_SYSTEM.md Step-1
     PATH-preservation subsection + encoding caveat) + session log on master. -->
<!-- dev-synthfe Phase-4b locks RELEASED 2026-06-08 at Step 10a Phase 1 commit (NOT merged/pushed —
     awaits user live-test + merge approval). Held (PianoidTunner repo, off dev): SynthesizeSection.jsx,
     SynthComparisonView.jsx, SynthGridSelector.jsx (3 NEW under modules/panels/collection/), useSynthesize.js
     (NEW hook), utils/synthScorecard.js (NEW, 8 DeepSeek helpers) + GridLayoutEditor.jsx (edit: additive
     selectMode/onSelectCell/cellRender) + CollectionSubpanel.jsx (edit: Record|Synthesize toggle) + 3 NEW
     test files. Synthetic-dataset Phase 4b FRONTEND — the MA Collect "Synthesize" sub-mode + the
     reconstructed-vs-ground-truth comparison charts (the headline comment-1 deliverable). HYBRID routing
     (dev.md Step 4b): 8 pure JS/Jest helpers via the DeepSeek batch pipeline (8/8 shipped first-try, $0.0043,
     node --test gate); the hook + 4 components + 2 edits Opus-inline. REUSE per DECISIONS comment 2:
     GridLayoutEditor EXTENDED (additive select-mode, not cloned), ImpulseShapeChart reused as the impulse
     preview, NumInput for every numeric field — no recreation. ACCEPTANCE: 62 new Jest tests (synthScorecard
     49 + SynthesizeSection 9 + GridLayoutEditor.selectMode 4) + 0 regression (CollectionSubpanel 4/4) + 0
     eslint errors. ★LIVE UI end-to-end PASSED on the full stack (launcher+React 3000/3001 + modal adapter
     5001): Record|Synthesize toggle → Synthesize section (mode table + dead-channel grid + impulse) →
     Synthesize 201 → Validate 200 → comparison charts rendered with PASS verdict, MAC 1.000, recall 1.000,
     both modes recovered exactly; live ECharts clean. Live-fix during verify: SYNTH_TIMEOUT_MS 180→600s (GPU
     cold-start). Committed PianoidTunner feature/synthetic-dataset `e707408` (feat) + `a99a41f` (timeout fix).
     Frontend-only, NO CUDA build. NOT merged/pushed. Docs (OVERVIEW Synthesize sub-mode + proposal status
     PHASES 1-4 ALL BUILT) + log + ledger + screenshot on PianoidInstall master. -->
<!-- (none active for dev-synthfe — released at Phase 1) -->
<!-- dev-synth1 Phase-4a locks RELEASED 2026-06-08 at Step 10a Phase 1 commit (NOT merged/pushed —
     orchestrator sequences Phase 4b frontend; team-lead said the backend is fully done after 4a).
     Held (PianoidCore repo): synth/synth_routes.py (NEW), routes/__init__.py (edit: register_synth_routes),
     tests/integration/test_synth_routes.py (NEW). Synthetic-dataset Phase 4a — the synthesize/validate REST
     routes on modal_bp wiring the P1-3 backend into REST: POST /modal/measurements/synthesize (→201 +
     synthetic Measurement) + POST /modal/measurements/<id>/validate (→200 + ValidationScorecard JSON).
     Reuses import_folder_as_measurement UNCHANGED. 100% Opus-inline, 0 DeepSeek. 8/8 route tests; synth
     integration 16/16 (1 PRE-EXISTING unrelated fail proven at clean HEAD). Committed PianoidCore
     feature/synthetic-dataset `a35800a` (off P3 37bd432, +379/3 files). Pure Python + CuPy — NO CUDA/.cu, NO
     rebuild. NOT merged/pushed. Docs (TESTING.md + proposal status BACKEND-COMPLETE) + log + ledger + the
     REST contract on PianoidInstall master.
     ★INCIDENT (recovered, no harm): a pre-existing-failure check used `git stash push -- <untracked files>`
     (fails) + bare `git stash pop` → popped the unrelated preserved stash@{0} (dev-35a3 CUDA work) with
     conflicts; restored via `git checkout HEAD -- <9 files>` + rm; the dev-35a3 stash is PRESERVED (intact).
     LESSON: never stash/bare-pop in a shared tree with pre-existing stashes. -->
<!-- dev-synth1 Phase-3 locks RELEASED 2026-06-08 at Step 10a Phase 1 commit (NOT merged/pushed —
<!-- dev-synth1 Phase-3 locks RELEASED 2026-06-08 at Step 10a Phase 1 commit (NOT merged/pushed —
     orchestrator sequences Phase 4). Held (PianoidCore repo):
       pianoid_middleware/modal_adapter/synth/validate.py (NEW — validation harness)
       tests/integration/test_synth_validate.py (NEW)
       pianoid_middleware/modal_adapter/synth/forward_model.py (re-edit: interior-receiver default fix)
     Synthetic-dataset Phase 3 — validation harness: runs the REAL EspritRunner on a synthetic dataset →
     match_modes#15 → precision_scorecard#17, scoring with the INDEPENDENT synth.metrics.compute_mac#12 (NOT
     band_merging — circular-dep). 100% Opus-inline, 0 DeepSeek. ★Lowest-band-first surfaced + I root-caused
     (by measurement, probe7) a DEAD-CHANNEL regime: default receivers sat on plate-boundary nodes (simply-
     supported eigenmodes = 0 there) → noise poisoning ESPRIT. FIX: forward_model default receivers inset to
     the plate INTERIOR (physics untouched — P2 CPU↔GPU parity still bit-exact) + harness amplitude-normalize
     + a per-channel dead-channel diagnostic (channel_diagnostics, for the Phase-4 UI; captured into
     DECISIONS.md comment 3 ★INTERIOR PLACEMENT). ACCEPTANCE both green: clean lowest-band hits thresholds on
     5×5 AND 7×7 (median freq err 7e-5/1.3e-4 <1%, MAC 0.995 >0.95, recall 0.92 >0.9, all 4 modes); band-
     mismatch → recall 0.0. 5/5 integration tests; 367 no-regression. Committed PianoidCore
     feature/synthetic-dataset `37bd432` (off P2 e3658e4, +474/3 files). Pure Python + CuPy — NO CUDA/.cu, NO
     rebuild. NOT merged/pushed. Docs (TESTING.md + proposal status PHASES-1-3) + log + ledger on
     PianoidInstall master. -->
<!-- dev-synth1 Phase-2 locks RELEASED 2026-06-08 at Step 10a Phase 1 commit (NOT merged/pushed —
<!-- dev-synth1 Phase-2 locks RELEASED 2026-06-08 at Step 10a Phase 1 commit (NOT merged/pushed —
     orchestrator sequences Phases 3-4). Held 3 NEW PianoidCore files + the synth/__init__.py edit:
       PianoidCore: pianoid_middleware/modal_adapter/synth/forward_model.py (NEW)
       PianoidCore: pianoid_middleware/modal_adapter/synth/dataset_writer.py (NEW)
       PianoidCore: tests/integration/test_synth_forward_model.py (NEW)
       PianoidCore: pianoid_middleware/modal_adapter/synth/__init__.py (Phase-2 exports added)
     Synthetic-dataset Phase 2 — GPU sim orchestration (forward_model.py xp-switch mirroring
     esprit_core._to_gpu_or_cpu; oversample→scipy.signal.decimate→48kHz; grid/modes parametric, default
     7×7+12) + dataset_writer.py (exact Measurement import layout). 100% Opus-inline, 0 DeepSeek. ACCEPTANCE:
     CPU↔GPU parity BIT-EXACT (0.000e+00); live POST /modal/measurements/import_folder → HTTP 201 (3 sc /
     25 ch / 48k — confirms the (samples,n_channels) float32 npy contract via the REAL importer); 11/11
     integration tests. Committed PianoidCore feature/synthetic-dataset `e3658e4` (off Phase-1 b9c0380,
     +619/4 files). Pure Python + CuPy — NO CUDA/.cu, NO rebuild. NOT merged/pushed (awaits Phases 3-4 + user
     gate). Docs (TESTING.md + proposal status) + log + ledger on PianoidInstall master. -->
<!-- dev-synth1 locks RELEASED 2026-06-08 at Step 10a Phase 1 commit (NOT merged/pushed — orchestrator
     sequences Phases 2-4). Held 11 NEW files, ALL in the **PianoidCore** repo (repo-relative paths;
<!-- dev-synth1 locks RELEASED 2026-06-08 at Step 10a Phase 1 commit (NOT merged/pushed — orchestrator
     sequences Phases 2-4). Held 11 NEW files, ALL in the **PianoidCore** repo (repo-relative paths;
     all created this session, no conflict possible):
       PianoidCore: pianoid_middleware/modal_adapter/synth/{__init__,geometry,pulse,oscillator,metrics}.py
       PianoidCore: tests/unit/conftest.py (the `xp` fixture) + tests/unit/test_synth_{geometry,pulse,oscillator,metrics,parity}.py
     Synthetic-dataset Phase 1 — pure-fn core (17 xp-agnostic numpy/cupy fns) via the dev.md Step-4b
     delegation model: DeepSeek batch pipeline shipped 16 routine fns first-try ($0.0107, 0 escalated, 0
     harness errors); Opus authored the 1 judgment fn integrate_modal_oscillator (#8, exact-ZOH IIR). 3
     dependents CALL their deps (compute_mac/relative_error/oscillator_zoh_coeffs). DUAL-BACKEND GATE:
     356/356 green on numpy AND cupy (178+178, cupy genuinely ran on GPU). §3.4.2 parity cross-check
     <1e-2 at the validated band. Committed PianoidCore feature/synthetic-dataset `b9c0380` (off dev
     9f2c3b5, +1634/11 files). Pure Python + CuPy — NO CUDA/.cu, NO rebuild. NOT merged, NOT pushed
     (awaits Phases 2-4 + user gate). Docs (TESTING.md + proposal status header) + session log + ledger
     ref on PianoidInstall master. Stats ledger: D:/tmp/synthds-build/{ledger.json,LEDGER.md}. -->
<!-- dev-minopus locks RELEASED 2026-06-07 at Phase-2 merge. tools/dev-pipeline/ (common.py + the 4 bookkeeping
     scripts + marker_hook.py + README + tests) committed 5be7efa, merged to master a02b67b + pushed (d60fb57). -->
<!-- dev-dsfix locks RELEASED 2026-06-06 at Step 10a Phase 1 commit (user-approved option A — commit only, NO
     merge/push). Took over dead deepseek-phase0's tools/deepseek-codegen-mcp/** lock and CONTINUED the
     integration: FIX deepseek-codegen MCP reliability (dir-1) + add NON-THINKING codegen mode (dir-2).
     Held: tools/deepseek-codegen-mcp/core.py, README.md, test_core.py (server.py + test_integration.py
     locked precautionarily, NOT edited).
     ROOT CAUSE (measured): deepseek-v4-flash is a dual-mode REASONING model; with thinking ENABLED it
     spends reasoning_tokens (measured 1.1k-11.8k) before the answer, counting against max_tokens → the
     4096 cap truncated complex bodies (no closing fence → unusable) or let reasoning eat the whole budget
     (no visible content → "empty implementation"); intermittent because reasoning length varies.
     FIX: (1) disable thinking for codegen (`{"thinking":{"type":"disabled"}}` = DEEPSEEK_THINKING_DISABLED)
     — the real speed/cost lever, eliminates the failure structurally; (2) DEFAULT_MAX_TOKENS 4096→32768
     (env-overridable DEEPSEEK_MAX_TOKENS) as defense-in-depth; (3) hardened extract_code (3-tier: closed
     fence / unterminated-fence recovery / bare-code; never returns a ```lang marker as code). v4-flash pin
     + temp 0.0 unchanged. +10 unit tests; README updated. NESTED-backtick extractor edge (review Medium #1)
     DEFERRED.
     MEASURED: thinking-fix 6/6 usable + oracle-correct (calc 71/71, csv 53/53); non-thinking 9/9 usable
     (finish=stop, reasoning_tokens=0), ~3-19x fewer completion tokens/call, much faster, with a small
     first-pass oracle dip on the hardest specs (csv 44-52/53; the /fn test is the correctness gate). Tool
     suite 48/48 (46 unit + 2 integration incl. 1 live call). Pure-Python, NO CUDA/engine/middleware;
     server.py untouched.
     COMMITTED on feature/deepseek-codegen-mcp (Phase 1 — SHA in session log). NOT merged, NOT pushed
     (awaiting user merge/push approval — Phase 2 pending team-lead relay). Session log NOT yet archived
     (Phase 2). -->
<!-- dev-dsfix locks RELEASED 2026-06-07 at Step 10a Phase 1 commit (user-approved "commit your scope ONLY",
     NO merge/push). PRODUCTIONISED the L3 batch codegen pipeline: NEW tools/deepseek-codegen-mcp/
     batch_pipeline.py + test_batch_pipeline.py (standalone CLI: manifest → parallel delegate → DeepSeek
     self-review → test gate → re-delegate ≤K → escalate; never ships a failing body, invariant shipped-iff-
     passed) + the 2 real-life gap fixes (conftest/_candidate gate convention; collection-error→harness_error
     no-retry) + Gap A (dual-backend xp_untested signals) + Gap B (deps DAG: validate/topo-layer/expose,
     --expose). core.py UNCHANGED (context_snippets already existed). Held: tools/deepseek-codegen-mcp/
     batch_pipeline.py + test_batch_pipeline.py + README.md (server.py/test_integration.py/core.py NOT edited
     this phase). PROVEN: full repo suite 67/67; real Arm B re-run 17/17 (dual-backend both [numpy]+[cupy],
     3 dependents CALL their helpers). Committed on feature/deepseek-codegen-mcp (Phase-1 SHA in session log);
     NOT merged, NOT pushed. Design/analysis proposals (docs/proposals/deepseek-*.md) committed by team-lead.
     fn.md/dev.md = orchestrator-owned (untouched). Session log NOT archived (Phase 2 pending — not merged). -->
<!-- (none active for dev-dsfix — released at Phase 1) -->
| <!-- (none) --> | | | |
<!-- dev-wave3split-f634 locks RELEASED 2026-06-06 at Step 10a Phase 2 (user-approved "Merge and push" via Telegram;
     executed by sync-release as part of the multi-repo release). Held 9 files: modal_adapter.py, chain_editor.py (NEW),
     project_store.py (NEW), apply_service.py, esprit_orchestrator.py (NEW), tests/unit/test_modal_adapter_state.py,
     tests/unit/test_qc_curves.py, tests/integration/test_project_v2_branch.py (renamed → test_project_store.py),
     tests/integration/test_measurement_rename.py. Wave 3 Modal Adapter facade split (Option A): extract ChainEditor +
     ProjectStore, migrate deferred-QC/ESPRIT logic out of facade to ApplyService/EspritOrchestrator, rename
     test_project_v2_branch → test_project_store (§8.2). modal_adapter.py 4253 → 1755 LOC (−58.7% wave, −69% from 5649).
     613 tests pass / 1 skipped / 1 pre-existing-failure (documented). /modal smoke 200. Behaviour identical. 2 endorsed
     judgment calls: kept run_full_pipeline on the facade (5-service orchestrator); did NOT fold test_measurement_rename
     into test_project_store. Committed PianoidCore feature/modal-adapter-wave3-split (4 commits: 3a26270 ChainEditor,
     aeaa717 ProjectStore, 7e8e9d7 deferred-QC/ESPRIT migration, 0248b46 test rename), MERGED to dev `9f2c3b5` (--no-ff).
     Pure-Python refactor — no CUDA rebuild. Literal ~400-LOC thin-facade rewrite DEFERRED to follow-up proposal
     docs/proposals/modal-adapter-facade-shim-removal-2026-06-06.md (300-test rewrite). Session log archived to
     logs/archive/. -->
<!-- (none active for dev-wave3split-f634) -->
<!-- dev-fbsl PianoidTunner locks RELEASED 2026-06-05 (team-lead-directed, to unblock dev-mzoom's PianoidTuner.js SC-zoom work). Frontend slider work is COMMITTED on feature/feedback-coeff-slider 9aa0e3e (usePreset.js + useBackendHealth.js + ToolBar.jsx + PianoidTuner.js); no further frontend edits needed. PianoidCore/PianoidBasic locks KEPT (switch-path test + merge). -->
<!-- dev-fbsl locks RELEASED 2026-06-06 (Step 10a Phase 2, reconciled by sync-release — work already MERGED + PUSHED
     2026-06-06 by dev-mzoom per the user's "include in the push", all CLEAN no conflicts). Held: ModelParams.py,
     pianoid.py, backendServer.py, tests/system/test_feedback_coeff_sound_channels.py. Feedback-coefficient slider:
     per-preset deck_feedback_coefficient persistence + runtime feedback_coeff/store_feedback_coeff + switch_preset
     ownership inversion + /health flags + sound-channels/switch-path tests. Backend: PianoidCore dev ed99d42 (slider
     tip 9a88518 incl. UNRUN switch-lifecycle test); PianoidBasic dev d86b477 (slider 4660f6b); frontend PianoidTunner
     dev 05ce924 (slider 9aa0e3e). ★UNVERIFIED — needs a BACKEND REBUILD to function; preset-switch lifecycle test
     (9a88518) UNRUN; user rebuilds + live-tests on another system. Frontend Jest stays green (88/941, eslint 0).
     NO CUDA build done by dev-fbsl itself (frontend composition + middleware/Python). -->
<!-- (none active for dev-fbsl) -->
<!-- dev-mzoom locks RELEASED 2026-06-06 (Step 10a Phase 2, reconciled by sync-release — (1)+(2) and the P0/P1 of (3)
     already MERGED to PianoidTunner dev + PUSHED to origin). Held: PianoidTuner.js, hooks/useCurrentValues.js,
     utils/chartView.js (NEW), SoundChannelsPane.jsx, MeasuredMatrix.jsx, RowEditor.js, BarChart.jsx,
     DrawableChart/DrawableChart.jsx, SoundChannelsAggregateChart.jsx. Three sub-features: (1) matrices-zoom +
     selection-scoped edits + AVG-mode zoom/mute (f3ff30a); (2) bar-chart auto-scale toggle (795f559); (3) system-wide
     selection + per-chart tie/untie zoom (docs/proposals/system-wide-selection-2026-06-06.md) — P0 core + P1 Feedin
     reference MERGED to dev (41b4737). ★HARD CONSTRAINT preserved: SC channel-ROW axis stays SC-LOCAL, NEVER global
     pitch (dev-snmtxleak/fa3c64b) — only SC MODE axis ties to global selectedModes. Jest 88/941, eslint 0. Frontend-only,
     NO CUDA build. ★DEFERRED follow-up (REAL pending work — see WORK_IN_PROGRESS.md): (3) P2 (highlight band in
     DrawableChart) + P3 (rollout to Feedback/Modes/Workbench/SC mode-axis) PENDING the user's cross-system test of the
     Feedin reference. Do NOT lose this — it is greenlit, partially-shipped work awaiting a user gate. -->
<!-- (none active for dev-mzoom) -->
<!-- dev-mzoom locks RELEASED 2026-06-05 at Step 10a Phase 1 commit. Held:
     PianoidTunner/src/PianoidTuner.js + src/components/SoundChannelsPane.jsx. Unlock existing
     matrix zoom for Sound Channels (mode-axis): un-gate SC in renderToolbarControls zoom-button
     id list + wire SC mode-COLUMN axis to shared rangeOfModes/selectedModes (zooms like
     Feedin/Feedback). Channel-ROW axis kept full (SC rows = output channels 0..N-1, not piano
     pitches — shared piano-space rangeOfPitches would blank them; deferred follow-up). Reset
     [0,63] modes bug is PRE-EXISTING + SHARED (Feedin/Feedback too) — NOT fixed here, flagged in
     WIP. Committed PianoidTunner feature/mzoom-sc-zoom ba38453 (off dev e2aaacf, +25/-3, 2 files).
     Jest 83 suites/903 tests green; 0 eslint errors. Frontend-only, NO build, no servers.
     NOT merged — awaits user test + approval. Co-edits PianoidTuner.js with dev-fbsl's COMMITTED
     feature/feedback-coeff-slider (disjoint regions: fbsl=ToolBar/usePreset wiring + Feedback
     Alert; mzoom=renderToolbarControls zoom buttons + SC call-site) → clean 3-way merge expected,
     team-lead sequences fbsl-then-mzoom at integration. Docs (OVERVIEW SC row + WIP follow-ups)
     + session log on PianoidInstall master. -->
<!-- (none active for dev-mzoom) -->
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
<!-- (none active) -->
<!-- dev-steinway-preset locks RELEASED 2026-06-05 at Step 10a Phase 2 (user-approved SHIP option A). Held:
     PianoidCore/pianoid_middleware/presets/Belarus_196modesC_Steinway1860 (NEW),
     .../Belarus_196modesC_Steinway1860_56SM (NEW), pianoid_middleware/auto_tuner.py,
     tests/unit/test_auto_tuner_robust.py (NEW). 2 Steinway 1860 mensur presets (full 88-key 58-block +
     56-SM 84-key trim) + robust harmonic-comb FrequencyTuner (R1 adaptive window/zero-pad, R2 comb f0,
     R3 comb-consistency confidence [deleted the 0.5 floor], R4 inharmonic stretched comb + treble window).
     Committed feature/steinway-1860-presets f30ba32 + 5655f02, MERGED to dev 7394188 (--no-ff, branch kept).
     NOT pushed (/sync handles origin reconcile + push-all). Regression: test_auto_tuner_robust 14/14 +
     test_tune_pipeline 59/59. Source preset Belarus_196modesC was READ-ONLY (untouched). -->
<!-- (none active) -->
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
<!-- dev-stest-4a7c row removed 2026-06-10 (cleanup-bkkp) — was a stale placeholder; release documented in the comment block above. -->
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

<!-- dev-m17-454a row removed 2026-06-10 (cleanup-bkkp) — was a stale placeholder; release documented in the comment block above. -->
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
<!-- (none active) -->
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

