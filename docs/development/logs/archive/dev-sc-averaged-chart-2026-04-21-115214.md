# Dev Session Log

- **Agent:** dev-sc-averaged-chart
- **Task:** Refactor Sound Channels averaged mode from matrix canvas to curve chart. Reuse curve chart from Volume Tuner. Per-channel mode stays unchanged.
- **Started:** 2026-04-21T11:52:14Z
- **Plan file:** None
- **Status:** In Progress

## Actions

### Step 0: Initialize Session — 11:52
- Agent ID assigned by team lead: dev-sc-averaged-chart
- Log file created
- Registered in `WORK_IN_PROGRESS.md` Active Dev Sessions

### Step 1: Docs + Discovery — 11:53
- Read `docs/modules/pianoid-tunner/OVERVIEW.md` (SC pane + useSoundChannels sections, strings-axis normalization context confirmed).
- Component search: found `src/components/CurveEditor.jsx` and `src/components/PerceptionCurveEditor.jsx`.
  - `CurveEditor.jsx` → calibration-bound (fetches `/calibration_curve`, manages RCM), line chart, click handler only. Not reusable for SC aggregate without significant decoupling.
  - `PerceptionCurveEditor.jsx` (used by `CalibrationPanel` — "Volume Tuner" in user's mental model) → the drag-to-edit pattern: zrender low-level `mousedown/mousemove/mouseup` handlers, `convertToPixel`/`convertFromPixel` math, `applyPaint` interpolation gap-filling. Props: `{ curves, onChange, onReset }`. Works on `{ pitch: [level_values] }` shape.
- Read `src/components/SoundChannelsPane.jsx` (122 LOC) and `src/hooks/useSoundChannels.js` (370 LOC) and `src/hooks/useMatrixHistory.js` (257 LOC).
- **Design decision:** reuse the drag-to-paint pattern from PerceptionCurveEditor in a new focused child component `SoundChannelsAggregateChart.jsx`. Not a literal import of the existing component (its data shape/API is level-based, not axis-based), but a direct adaptation of its proven zrender drag math.
- **Data binding:**
  - Modes axis, aggregate ON: `scModesAggMatrix = { pitch: [avg] }` → x = pitch index, y = avg. Drag → emit `{ operation: "Value", zone: "pitchesVectorDrawn", newValue: [avg_per_pitch] }`.
  - Strings axis, aggregate ON: `scStringsAggMatrix = { averaged: [val_per_mode] }` → x = mode index, y = val. Drag → emit `{ operation: "Value", zone: "modesVectorDrawn", pitch: "averaged", newValue: [val_per_mode] }`.
- **P1:** `useSoundChannels` remains sole writer (via `applyAggregateChange` → `fanOutAggregateChangeAxis` → `applyBatchChange`). Chart only emits change objects.
- **P2:** Chart is a focused renderer (one concern: render + drag the aggregate curve). Pane remains dispatcher between matrix and chart views.
- **C4:** All files currently under 500 LOC. New chart component target ~200 LOC.

### Step 1b: Env Control — 11:55
- Frontend refactor only — no backend server needed for build verification. `/test-ui` in Step 7 will start the full stack.

### Step 2: Baseline Build — 11:56
- `npm run build` (without CI=true, per project convention) → success. Bundle 694.03 kB gzipped.
- Warning count: 189 (pre-existing). `CI=true` build fails on these pre-existing warnings — not introduced by this session.
- Baseline metric: **189 warnings**. Goal: ≤189 after changes.

### Step 3: Branch — 11:57
- `git pull origin dev --ff-only` (up to date), `git checkout -b feature/sc-averaged-curve`.

### Step 4: Locks — 11:58
- Registered lock on `SoundChannelsPane.jsx`, `SoundChannelsAggregateChart.jsx` (new), `useSoundChannels.js` in `MODULE_LOCKS.md`.
- **P1 answer:** State owner is `useSoundChannels` hook (via `useMatrixHistory` instances). My change does NOT make a non-owner write; new chart only emits change objects through existing `applyAggregateChange`.
- **P2 answer:** New chart has one concern (render + drag-edit the aggregate curve). Pane stays dispatcher (matrix vs chart). Hook's concern (aggregate math + fan-out) unchanged.

### Step 4 (cont): Implement — 12:02
- Created `PianoidTunner/src/components/SoundChannelsAggregateChart.jsx` (~320 LOC) — ECharts line chart + zrender drag pattern adapted from `PerceptionCurveEditor`. Emits `pitchesVectorDrawn` (modes axis) or `modesVectorDrawn` with pitch `"averaged"` (strings axis).
- Rewrote `SoundChannelsPane.jsx` to dispatch: aggregate OFF → `MeasuredMatrix` (unchanged legacy path); aggregate ON → `SoundChannelsAggregateChart`. Removed dead `activeAggMuteMap` destructure (no longer used in the chart render; matrix render carries its own `activeHistory.muteMap`).
- `useSoundChannels.js` unchanged.
- Build: 189 warnings (baseline parity, no new warnings after unused-var cleanup).
- Commit: `98afef7 feat: SC averaged mode renders as curve chart` — 2 files changed, 364 insertions, 19 deletions.

### Step 5 (/test-ui) — 12:08
- Killed stale processes on ports 5000/5001/3000/3001. Started full stack via `npm run dev` (background). Backend came up on port 5000 after `APPLY`. 88 notes loaded (BaselinePreset1).

**Scenarios:**
- **(a) Aggregate OFF, strings axis → matrix renders.** Regression PASS — heatmap rendered, tooltip values correct.
- **(b) Aggregate ON, strings axis → curve chart renders, x=mode (0..99), y=avg per mode (teal curve).** Drag from modes 15..49 across y=520..200 → backend averages reflect delta: mode-range lowered to ~20 across channels [0.02, 0.02, 0.02, 0.02] per mode. Undo (50 clicks to walk chain) restored exact original values.
- **(c) Aggregate ON, modes axis → curve chart renders, x=pitch (B0..G7 spanning 84 available pitches), y=avg per pitch (blue curve).** Drag V-shape → backend averages: pitches 58..67 show varying 0.227..0.281 (was uniform 0.3); outside drag range stayed at 0.3. Per-pitch channel arrays were [x, x, x, x] — fan-out working.
- **(d) Toggle ON→OFF→ON (modes axis).** Chart re-renders with identical V-curve, state preserved. Undo button still enabled.
- **(e) Preset reload (via browser reload + APPLY).** Chart re-initialises with fresh 0.3 baseline — preset-switch cache-clear still works for aggregate-ON mode.
- **(f) Undo/redo.** Validated in scenario (b). Wave D history fix still holds.

**Follow-up fix (12:16)**: initial console check surfaced a React "Maximum update depth" warning from my `ToggleButtonGroup` + `ToggleButton` + `Tooltip` combo (the ToggleButton's value matched the group's selected value, driving Popper re-renders). Replaced with a plain `IconButton` for the aggregate toggle. Also null-guarded the zrender cleanup for dispose/unmount races. Post-fix console: no app errors, only pre-existing WebSocket-closure noise during startup.
- Commit: `143787b fix: simplify aggregate chart toolbar, guard zrender cleanup` — 1 file changed, 25 insertions, 18 deletions.
- Build: 189 warnings (still parity).

### Step 8: Docs — 12:18
- Updated `docs/modules/pianoid-tunner/OVERVIEW.md`:
  - `SoundChannelsPane` row: rewrote to describe the render-mode dispatch.
  - New row added for `SoundChannelsAggregateChart` (API, data shapes, reuse source, emission zones).
  - `useSoundChannels` section: appended "Aggregate render (2026-04-21, dev-sc-averaged-chart)" paragraph describing the new chart render path and P1 invariant.

### Files Modified
- `PianoidTunner/src/components/SoundChannelsAggregateChart.jsx` (new, 332 LOC)
- `PianoidTunner/src/components/SoundChannelsPane.jsx` (dispatcher rewrite, ~130 LOC)
- `docs/modules/pianoid-tunner/OVERVIEW.md` (two sections updated)

### Verification snapshots (D:/tmp)
- `sc_matrix_strings_baseline.png` — matrix view before aggregate toggle
- `sc_agg_strings_on.png` — strings-axis curve on
- `sc_agg_strings_after_drag.png` — post-drag, modes 15..68 flattened
- `sc_matrix_strings_toggleback.png` — regression check: matrix renders after toggle-off
- `sc_agg_modes_on.png` — modes-axis curve on
- `sc_agg_modes_after_drag.png` — V-shape curve from drag
- `sc_agg_modes_after_toggle_cycle.png` — state preserved after ON→OFF→ON
- `sc_agg_modes_fixed.png` — post-fix UI (IconButton toolbar), aggregate ON after reload

### Extension: Flat + Smooth toolbar buttons — 14:25 (user second-pass request)
User approved via Telegram: "B - add both" (Flat + Smooth).

**Changes.** `PianoidTunner/src/components/SoundChannelsAggregateChart.jsx` only:
- Added `useState`-backed `flatValue` (default 1.0) bound to an inline `NumInput` (MUI-dense, `min=0`, `max=20`, `step=0.1`, `decPlaces=3`, `width="80px"`).
- Added `emitVector(values)` callback that packages a full painted vector into the axis-correct change shape (pitchesVectorDrawn / modesVectorDrawn) and calls `onAggregateChange`. Clamps per-point to `[0, 20]` (same clamp as drag).
- `handleFlat()`: builds a vector of `flatValue` × N and calls `emitVector`.
- `handleSmooth()`: 3-point moving average with 2-point single-sided average at indices 0 and N-1. Matches the approach taken by `PerceptionCurveEditor.handleSmooth` — documented inline.
- Toolbar layout: `Divider` separates undo/redo from Flat/Smooth. Icon-only buttons: `HorizontalRuleIcon` for Flat, `BlurOnIcon` for Smooth. All wrap in `Tooltip` and carry `aria-label` per project CLAUDE.md.
- Build: 189 warnings (baseline parity).

**Test matrix (both axes).**

Modes axis (BaselinePreset1, all 84 pitches × 4 channels start at 0.3):
- Flat with default 1.0 → every pitch's 4 channels all become 1.0. Curve flat at y=1. Fan-out confirmed.
- Drew a zigzag (6-point drag across indices 12..47) → backend shows the sawtooth pattern.
- Smooth → sharp dips (e.g. index 20: 0.111) replaced with neighbor average (0.1753 = (0.175 + 0.111 + 0.24)/3). All 84 pitches × 4 channels preserved per-pitch-equal (fan-out intact).
- Undo after Smooth → one step reverts exactly the smoothed indices to pre-smooth values.

Strings axis (all 100 modes × 4 output channels):
- Flat with 1.0 → every mode's 4 channels = 1.0. Fan-out confirmed.
- Zigzag drag at modes 20..36, Smooth: mode 30 (0.11) → 0.254 = (0.33 + 0.11 + 0.33)/3 ✓. All 4 channels equal per mode.
- Undo after Smooth → one step reverts.

Console clean of app errors (only pre-existing WebSocket startup noise during reload).

**Commit** on `feature/sc-averaged-curve`: `9038041 feat: add Flat + Smooth toolbar buttons to SC aggregate chart` (1 file, +93/-4).

**Docs** on `docs/sc-averaged-curve-flat-smooth` (PianoidInstall, NOT master this time per team-lead note): SoundChannelsAggregateChart row updated with Flat/Smooth toolbar description.

### Screenshots added (D:/tmp)
- `sc_agg_modes_before_flat.png` — toolbar with Flat/Smooth buttons visible
- `sc_agg_modes_after_flat1.png` — modes axis, all pitches flattened to 1.0
- `sc_agg_modes_after_smooth.png` — modes axis, zigzag attenuated by Smooth
- `sc_agg_strings_after_undo_smooth.png` — strings axis post-undo state

### Hot-fix: drawing reverts + Flat stale-value (user real-UI feedback) — 15:05
User reported via Telegram that **drawing worked incorrectly** and the **Flat button did nothing** in real UI. My earlier scripted tests missed both bugs because the synthesized MouseEvents were spaced well apart (render could catch up) and because I never tested Flat after typing without pressing Enter. Reproduced both via chrome-devtools pointer + keyboard injection.

**Bug 1 — Drawing reverts.** `emitPainted` rebuilt the full vector from `yValuesRef.current` on every mousemove, but React batches state updates — between mousemoves the ref often still pointed to the pre-drag `yValues`, so the emitted vector overwrote previously-painted indices with their original values. End effect: only the last touched index retained its new value; intermediate painted positions silently reverted.

*Fix:* Keep a drag-scoped working vector inside `dragState.current.vector`. Seed from `yValuesRef` on mousedown, mutate only the touched indices on each mousemove, emit the vector, discard on mouseup. Emitted payload is now consistent regardless of render timing.

**Bug 2 — Flat applies stale value.** NumInput defers `onChange` to Enter / internal Apply click, and its blur handler REVERTS uncommitted edits. User sequence `type "0.5" → click Flat`:
1. Button mousedown → input blur → NumInput reverts display to previous committed value.
2. Button onClick → handleFlat reads either stale `flatValue` state or reverted `input.value`. Either way wrong.

First-attempt fix (read `input.value` at click time via wrapper ref) failed because blur had already run. Working fix: attach a native `input` event listener to the raw `<input>` via the wrapper Box ref. Every keystroke mirrors into `latestTypedValueRef`, so by the time the user clicks Flat the ref holds the typed value. handleFlat clamps to `[0, 20]` and syncs the committed React state so the NumInput display updates after next render (overriding any "reverted on blur" state).

**Real-UI verification (chrome-devtools injected pointer + keyboard).**
- Strings axis: `Ctrl+A, type "0.5", click Flat` → all 100 modes × 4 channels = 0.5. Fast 30-step drag of rising line across modes 10..90 → smooth 0.055..0.345 curve, untouched edges at 0.5. Per-mode channel arrays equal. Screenshot: `sc_agg_strings_drag_fixed.png`.
- Modes axis: `Ctrl+A, type "0.8", click Flat` → all 84 pitches × 4 channels = 0.8. 26-step drag → smooth 0.033..0.205 curve across 68 pitches, per-pitch channel arrays equal. Screenshot: `sc_agg_modes_drag_fixed.png`.

Console clean of app errors from this component (pre-existing ObjectInspector Max-update-depth warning unrelated).

Build: 189 warnings (baseline parity). Commit: `51d26c6 fix: drawing reverts + Flat stale-value bugs` (1 file, +88/-29) on `feature/sc-averaged-curve`.

### Drawing-reverts-fix screenshots
- `sc_agg_strings_drag_fixed.png` — 30-step drag produces smooth rising line across 81 modes (fix verified)
- `sc_agg_modes_drag_fixed.png` — modes axis, rising line across 68 pitches (fix verified)

### Second hot-fix: value mapping (axis + clamp) — 15:40
User re-tested and still saw "drawing sets wrong values". Deeper probe via fiber-chain ECharts access found two quantitative bugs neither of my earlier real-UI tests had caught.

**Root cause A — y-axis auto-scaled below zero.** `convertFromPixel('grid', [0, canvasY=408])` (the grid bottom) returned `-0.27835`, not `0`. ECharts's default auto-scale adds padding to both ends, so the pixel-to-value line didn't pass through zero at the label's "0" tick. Dragging near the bottom wrote a small positive value that did NOT correspond to the pixel the user clicked.

*Fix:* `yAxis.min = 0`. Auto-max remains (axis grows when user drags above current max). The bottom grid pixel now maps to exactly 0.

**Root cause B — `DRAG_CLAMP_MAX = 20`.** Strings-axis preset coefficients range to ~3400; my clamp silently capped any drag or flat value > 20 to 20. On strings axis, a user trying to pull coefficients back to their baseline of 600 saw them lock at 20 with no error.

*Fix:* `DRAG_CLAMP_MAX = 1e6`.

**Verification after fix.**
- `convertFromPixel` at grid bottom returns exactly 0.
- Single-point drag at clientY=200 writes 0.2652 at the nearest pitch, matching `0.3 * (408 - 65) / (408 - 20) = 0.2652` exactly.
- Drag above grid top (clientY=50) writes 0.381 → axis grows on next render to 0..0.4 (expected — auto-max).
- Drag below current auto-max (clientY=500) writes 0.044 — inside [0, 0.38], no clamping.

**Fan-out semantics (user-confirmed).** User answered "A" to the clarification: delta fan-out is correct. Drawing avg=700 at a mode with channels [600, 800, 300, 300] (oldAvg=500) gives [800, 1000, 500, 500] (newAvg=700, delta=+200 applied to each channel). No changes to `useSoundChannels.fanOutAggregateChangeAxis`.

**Commit** on `feature/sc-averaged-curve`: `9d00780 fix: pin y-axis to zero + raise clamp for strings-axis values` (+15/-1). Build: 189 warnings (baseline).

### Second-hot-fix screenshots
- `sc_agg_axis_pinned.png` — fresh preset, y-axis starts at 0
- `sc_agg_axis_pinned_after_drags.png` — cumulative drag produces visible pattern exactly matching commanded values

### Final state at wrap-up (2026-04-21)
- Feature branch `feature/sc-averaged-curve` in PianoidTunner: 5 commits (`98afef7`, `143787b`, `9038041`, `51d26c6`, `9d00780`). Merged into `dev` with `--no-ff` at Step 10a.
- Docs branch `docs/sc-averaged-curve-flat-smooth` in PianoidInstall: 2 commits (`f68ec53`, `79b9306`) linear on top of the earlier direct-to-master `9777e58`. Merged into `master` with `--no-ff` at Step 10a — no history rewrite.
- User-confirmed: delta fan-out retained (option A).
- Neither push performed (per policy).
- Status: **Complete**. Log archived.


