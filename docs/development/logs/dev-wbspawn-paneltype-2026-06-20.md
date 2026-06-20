# Dev Session Log

- **Agent:** dev-wbspawn (panel-specific-dynamic type)
- **Task:** Workbench model — add 3rd type "panel-specific dynamic" (follows active param only within its host panel; frozen on out-of-panel selection) invoked by a panel-toolbar button (location-based, per user D1); + move "New Workbench Placement" setting to a new GLOBAL settings dialog (top-bar ⚙); remove it from the Workbench-pane gear.
- **Started:** 2026-06-20T00:00:00Z
- **Status:** In Progress
- **Worktree:** D:/repos/wt-wbspawn (branch feature/dev-wbspawn-paneltype off PianoidTunner dev 5b57d08)

## Actions

[STEP-0-COMPLETE] 2026-06-20T00:00:00Z

### Step 1: Context (already investigated across prior msgs) — 2026-06-20T00:00:00Z
- Types today: FIXED (Workbench:* clone, openWorkbench) + GLOBAL DYNAMIC (default "Workbench" pane, updateDefaultWorkbench via onActivate). Active-param = selectedParameter; panel scope = param.groupe.
- Affordance map: row-based panels Strings/Modes/Excitation have per-row fixed BarChart icons (onOpenWorkbench); panel-toolbar chart button (renderToolbarControls L2891) gated to Feedin/Feedback/Excitation. Feedin/Feedback are MATRIX panels (MeasuredMatrix, no rows) → flagged the structural edge to team-lead (Q-A/Q-B/Q-C pending).
- BUILD PLAN: (1) panel-agnostic TYPE foundation [no dependency on per-panel button decision] — additive {kind,scopeGroupe} on workbenches binding + groupe-gated re-target effect + handleOpenWorkbench accepts opts; (2) placement→global ⚙ (wire dead ToolBar SettingsIcon → new GlobalSettingsDialog hosting placementMode; remove from Workbench-pane gear); (3) per-panel button WIRING — WAITS on team-lead Q-A/Q-B/Q-C.
[PROGRESS] 2026-06-20T00:00:00Z step=1 note="building panel-agnostic foundation while button-wiring decision pends"

### Step 1b: Env — 2026-06-20T00:05:00Z
- Frontend-only, NO CUDA. Worktree off dev 5b57d08, node_modules junction valid. chrome-devtools available but per team-lead the USER live-tests; gate = Jest + CRA build.
[LOCK ACQUIRED] PianoidTunner/src/PianoidTuner.js
[LOCK ACQUIRED] PianoidTunner/src/hooks/useCurrentValues.js
[LOCK ACQUIRED] PianoidTunner/src/hooks/useSettings.js
[LOCK ACQUIRED] PianoidTunner/src/components/ObjectInspector.jsx

### Step 4: Foundation edits (panel-agnostic — no button decision needed) — 2026-06-20T00:40:00Z
[EDIT] file=src/hooks/useCurrentValues.js — openWorkbench(parameter,isPiano,extra) tags {kind,scopeGroupe} on the binding; updateDefaultWorkbench now ALSO re-targets panel-dynamic WBs whose scopeGroupe===param.groupe in the SAME state update (so every onActivate path drives panel-following for free); added standalone retargetPanelDynamic; exported it.
[EDIT] file=src/PianoidTuner.js — handleOpenWorkbench(parameter,isPiano,sourcePaneId,extra) threads extra → openWorkbench + into the spawn snapshot binding; destructured retargetPanelDynamic; added globalSettingsOpen state; mounted <GlobalSettingsDialog>; passed onOpenGlobalSettings to <ToolBar>; imported GlobalSettingsDialog.
[EDIT] file=src/components/GlobalSettingsDialog.jsx — NEW minimal app-wide settings dialog (top-bar ⚙) hosting "New Workbench Placement" (reads/writes workbenchSettings.placementMode; no migration).
[EDIT] file=src/components/ToolBar.jsx — wired the previously-DEAD top-bar Settings ⚙ → onOpenGlobalSettings prop.
[EDIT] file=src/components/ObjectInspector.jsx — placementMode marked hidden:true (removed from per-pane gear auto-render; now edited only in the global dialog).
[EDIT] file=src/utils/workbenchTitle.js — panel-dynamic WBs get a " (panel)" title marker (D3 default).
- Targeted Jest (workbenchPlacement + mosaicConfigStore) 48/48 PASS — foundation didn't break existing suites.
[PROGRESS] 2026-06-20T00:40:00Z step=4 note="panel-agnostic foundation + placement-to-global DONE; per-panel button wiring PENDING team-lead Q-A/Q-B/Q-C"

### Step 4: Row-based button wiring (Q-A CONFIRMED) — 2026-06-20T01:00:00Z
[EDIT] file=src/PianoidTuner.js — renderToolbarControls: ROW-BASED panels (Strings/Modes/Excitation) get a PANEL-FOLLOWING toolbar button (TimelineIcon) → handleOpenWorkbench(param, isPiano, id, {kind:"panel-dynamic", scopeGroupe:id}); spawns with selectedParameter if in-panel else placeholder {groupe:id}. Excitation's old fixed toolbar button REPURPOSED to this. MATRIX panels Feedin/Feedback KEEP their existing FIXED toolbar button (split out, unchanged) — HELD for M-answer. Imported TimelineIcon.
[EDIT] file=src/hooks/useCurrentValues.js — openWorkbench id uses name||"panel" fallback (clean id for placeholder panel-dynamic spawn).
[TEST] src/hooks/__tests__/useCurrentValues.panelDynamic.test.jsx (NEW, 6 tests) + workbenchPaneTitle.test.js (+3 marker tests).
- Full Jest 126 suites / 1289 tests PASS (zero regressions). CRA build "Compiled successfully" (eslint clean).
[BASELINE-TEST] 2026-06-20T01:00:00Z result=pass perf_log=jest-full
[REGRESSION-CHECK] 2026-06-20T01:00:00Z scope=frontend-jest verdict=pass
[PROGRESS] 2026-06-20T01:00:00Z step=5 note="row-based+foundation+placement-global green; committing increment; HOLD matrix buttons for M-answer; merge after fast-follow"

### Matrix fast-follow (M2) + Step 8 docs + Step 10a Phase 2 — 2026-06-20T01:30:00Z
- M-ANSWER = M2 all 3 matrix panels: repurpose toolbar → panel-following, drop fixed.
[EDIT] file=src/PianoidTuner.js — folded ALL 6 panels into ONE panel-following toolbar button (Timeline); removed matrix fixed-button block + unused BarChartIcon import.
[STEP-8-COMPLETE] 2026-06-20T01:25:00Z docs_touched="docs/modules/pianoid-tunner/OVERVIEW.md"
- Full Jest 126/1289 green, CRA build clean. Commits: cfad905 (row-based+foundation+placement-global) + 8eb33f1 (matrix M2).
[STEP-10A-PHASE-2] 2026-06-20T01:30:00Z
- MERGED --no-ff → PianoidTunner dev dc3a732 (in MAIN checkout which holds dev; clean ort) + PUSHED origin/dev (5b57d08..dc3a732).
- RESTARTED :3000 (port-scoped kill 7184 → detached relaunch): "Compiled successfully", LISTENING, serving dc3a732.
[SERVER-STOP] port=3000 pid=7184
[SERVER-START] role=frontend-dev port=3000 pid=59568
[LOCK RELEASED] PianoidTunner/src/PianoidTuner.js
[LOCK RELEASED] PianoidTunner/src/hooks/useCurrentValues.js
[LOCK RELEASED] PianoidTunner/src/hooks/useSettings.js
[LOCK RELEASED] PianoidTunner/src/components/ObjectInspector.jsx
- DONE — MERGED + live on dev; user live-tests.
