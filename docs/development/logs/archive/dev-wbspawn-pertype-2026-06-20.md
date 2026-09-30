# Dev Session Log

- **Agent:** dev-wbspawn (per-type placement)
- **Task:** Replace single workbenchSettings.placementMode with THREE per-type placement settings (fixed / panel-following / global-dynamic); defaults global=screen-bottom, panel-following=panel-bottom, fixed=panel-bottom; all 3 editable in the global ⚙; apply per-type at spawn; global-dynamic setting drives the checkbox re-add placement.
- **Started:** 2026-06-20T02:00:00Z
- **Status:** In Progress
- **Worktree:** D:/repos/wt-wbspawn (branch feature/dev-wbspawn-pertype-placement off PianoidTunner dev dc3a732)

## Actions

[STEP-0-COMPLETE] 2026-06-20T02:00:00Z

### Step 1: Context (verified) — 2026-06-20T02:00:00Z
- Current: single workbenchSettings.placementMode ("screen-bottom"/"panel-bottom"); used in handleOpenWorkbench (fixed+panel-following spawn) + rendered in GlobalSettingsDialog; global-dynamic "Workbench" pane is NOT spawned (initial layout + checkbox re-add via addWindowToLayout→appendToScreenBottom).
- GLOBAL-DYNAMIC nuance (flagged to team-lead): only dynamic placement event = checkbox RE-ADD; panel-bottom meaningless (no source panel) → falls back to screen-bottom.
- PLAN: replace placementMode with placement = { fixed, panelFollowing, globalDynamic } (defaults panel-bottom/panel-bottom/screen-bottom). handleOpenWorkbench picks fixed vs panelFollowing by the spawn's kind. addWindowToLayout("Workbench") honors globalDynamic placement (screen-bottom; panel-bottom→fallback screen-bottom). GlobalSettingsDialog renders 3 labeled selects. Drop the old single key (minor UI pref, no precise migration).
[PROGRESS] 2026-06-20T02:00:00Z step=1 note="per-type placement design set; building"

### Step 1b: Env — 2026-06-20T02:02:00Z
- Frontend-only, NO CUDA. Worktree off dev dc3a732, junction valid. Gate = Jest + build; user live-tests.
[LOCK ACQUIRED] PianoidTunner/src/PianoidTuner.js
[LOCK ACQUIRED] PianoidTunner/src/hooks/useSettings.js
[LOCK ACQUIRED] PianoidTunner/src/components/GlobalSettingsDialog.jsx

### Step 4-7: Implementation — 2026-06-20T02:20:00Z
- `useSettings.js`: replaced single `placementMode` with `placement: { fixed: "panel-bottom", panelFollowing: "panel-bottom", globalDynamic: "screen-bottom" }`.
- `workbenchPlacement.js`: added pure resolver `placementForSpawn(placement, kind)` — `kind === "panel-dynamic"` → `panelFollowing`, else (FIXED spawn) → `fixed`; returns only `screen-bottom`/`panel-bottom` (bad/missing → `panel-bottom`).
- `PianoidTuner.js`: `handleOpenWorkbench` now routes via `placementForSpawn(workbenchSettings?.placement, extra?.kind)` → `panel-bottom`=dockUnderPanel / `screen-bottom`=appendToScreenBottom. `addBottomPinnedToLayout` (global-dynamic re-add) documented as screen-bottom-only (panel-bottom degenerates).
- `GlobalSettingsDialog.jsx`: rewritten to render THREE labeled `<Select>` controls (Fixed / Panel-following / Global dynamic) from a PLACEMENT_FIELDS array, each with FormHelperText; globalDynamic helper notes panel-bottom→screen-bottom fallback. Writes `placement: {...placement, [key]: value}`.
- `ObjectInspector.jsx`: replaced `placementMode` PARAMETER_CONFIG entry with `placement: { hidden: true }` so the per-pane gear's ObjectInspector never renders the nested object as `[object Object]`.
- Tests: `workbenchPlacement.test.js` +`placementForSpawn — per-type` suite (fixed/panelFollowing resolution, missing→panel-bottom default, no bad-value leakage).

### Step 8: Docs — 2026-06-20T02:30:00Z
- `docs/modules/pianoid-tunner/OVERVIEW.md`: settings-table row (placementMode → per-type `placement`), invocation note, and the "Workbench spawn placement" subsection rewritten to the PER-TYPE model (type→setting→default table, two placement modes, global-dynamic nuance, placementForSpawn resolution).

### Verification — 2026-06-20T02:35:00Z
- `workbenchPlacement.test.js`: 15/15 PASS (react-scripts test).
- Full Jest: **126 suites / 1293 tests PASS**.
- CRA `react-scripts build`: **Compiled successfully** (eslint gate clean).
- chrome-devtools DOWN → user live-tests on :3000.

### Close — 2026-06-20T02:40:00Z
- Feature commit `0a90c61` on `feature/dev-wbspawn-pertype-placement`.
- MERGED --no-ff to PianoidTunner `dev` (off dc3a732) → merge `31941cc`.
- PUSHED `origin/dev` (`dc3a732..31941cc`).
- `:3000` killed (react-scripts tree PID 49816/59568) + restarted detached from main checkout; serving 31941cc, HTTP 200.
- Locks RELEASED, WIP updated, this log finalized.
- **Status: COMPLETE.**

---

## ADD: Per-type COLOR CODING (folded into the same cycle) — 2026-06-20T03:25:00Z

User refinement: "all three types of workbenches should have different color coding, and all three of them should be distinct from the Sound Channels average chart."

### SC-average color found (the one to avoid)
`SoundChannelsAggregateChart.jsx` `seriesColor` = `theme.palette.primary.light` on the **modes** axis, `theme.palette.secondary.light` on the **strings** axis. The app uses MUI's default theme (no app-level `createTheme`), so these resolve to:
- `primary.light` = **#42a5f5** (blue)
- `secondary.light` = **#ba68c8** (purple)

### The 3 type colors (distinct from each other AND from #42a5f5/#ba68c8; dark-theme-friendly, warm/green hues clear of blue/purple)
- FIXED → amber **#ffb300** (`wb-kind-fixed`)
- PANEL-FOLLOWING → teal **#26a69a** (`wb-kind-panel`)
- GLOBAL DYNAMIC → coral **#ff7043** (`wb-kind-global`)

### Surface + implementation
- Surface chosen = the **pane title-bar** (most visible at a glance), mirroring the existing `.highlighted-window` pattern: translucent toolbar fill + 4px solid left-border accent in `index.css`.
- New pure helper `workbenchKindClass(id, wb)` in `utils/workbenchTitle.js` (home of pane-title presentation): `id === "Workbench"` → global; `Workbench:` pane with binding `kind === "panel-dynamic"` → panel; else → fixed; non-workbench → `""`.
- `PianoTuner.js` folds the class into the `MosaicWindow` `className` next to the active-panel `highlighted-window` cue.
- CSS type rules declared BEFORE `.highlighted-window` so the transient active-panel orange cue still wins by source order on overlap.
- Tests: `workbenchPaneTitle.test.js` +`workbenchKindClass — per-type color coding` suite (global/panel/fixed mapping, non-workbench → "", all-3-distinct).

### Verification
- Full Jest: **126 suites / 1298 tests PASS** (+5). CRA build: **Compiled successfully**. chrome-devtools DOWN → user live-tests.

### Close
- Feature commit `5aba136`; MERGED --no-ff to PianoTunner dev (off 31941cc) → merge `644aebd`; PUSHED origin/dev (`31941cc..644aebd`); `:3000` restarted (serving 644aebd, HTTP 200). Locks RELEASED, WIP updated. **Color-coding COMPLETE.**
