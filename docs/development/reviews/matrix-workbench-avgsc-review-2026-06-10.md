# Code Review: Matrix / Workbench / Averaged-Sound-Channels

- **Status:** REVIEW / READ-ONLY analysis — for user + orchestrator. NO source edited, NO build, NO
  running stack touched (a debug backend was UP for the user; only frontend source + docs were read).
- **Agent:** review-mwsc-98d1, 2026-06-10. Maximum-reasoning-depth pass.
- **Target:** `PianoidTunner` `dev @ 5758019` — the merged *system-wide-selection* batch (tie/untie
  auto-zoom, selection ranges, tri-state mute, ruler↔bar alignment) + the origin reconcile that
  brought the new Synthesize/collection feature set. Reviewed AS-IS on that commit (confirmed HEAD,
  clean tree).
- **Scope:** the MATRIX editors (Feedin / Feedback / SC per-channel), the WORKBENCH (pitch + mode
  axis), the AVERAGED SOUND CHANNELS view, and the hooks behind them (`usePreset`, `useSoundChannels`,
  `useMatrixHistory`, `useCurrentValues`, `useHotkeys`, `useBackendProcess`), plus the merged
  tie/untie model (`utils/chartView.deriveChartView`).
- **Prior art (read first, NOT re-tread):** dev-d52b's backend interface review
  ([doc](feedin-feedback-soundchannels-review-2026-06-04.md)) and ana-uimtx's UI review
  ([doc](feedin-feedback-soundchannels-UI-review-2026-06-04.md), 2026-06-04). Most of ana-uimtx's
  C1/H1/H2/H3/M1/M3 findings were ACTED ON since (task list #204–#221): C1 layout reverted to
  matrix-dominant, H1 rowLabel+FlatBarAxis added, H2 SC disabled in listen-to-modes, M3 tooltip
  rounding. This review focuses on the **new** surface the merge introduced (tie/untie, scoped edits,
  tri-state mute, the two-zoom split) and on what those earlier reviews did not cover.

---

## Executive summary

The matrix/workbench/avg-SC subsystem is in markedly better shape than at the 2026-06-04 reviews:
the SC editor's three-principle state discipline is intact, the dev-snmtxleak channel→pitch decouple
holds across all the new code paths I traced, the scoped-edit and tri-state-mute machinery is
well-tested at the pure-function layer, and the ruler↔bar alignment uses a single shared
`CHART_GRID_PAD` source of truth.

The dominant problem is **architectural drift introduced by the partial tie/untie rollout**: the merge
shipped a NEW zoom model (`deriveChartView` + per-chart `tied` flag + global selection) on *Feedin and
Workbench only*, while *Feedback, Sound Channels, and Virtual Piano* still run the LEGACY shared-range
zoom (`rangeOfPitches`/`rangeOfModes`). The two systems coexist in the same toolbar with two different
button sets and two different state sources. This is the single biggest correctness/UX/maintainability
risk in the subsystem and the thing most likely to confuse a user (and the next developer). It is
explicitly acknowledged as "paused P3" in the code comments — so it is known, but it is shipped to
`dev` in a half-migrated state.

Secondary: a confirmed **dead mute write-path** (the matrix `onMuteMapChange` prop is never invoked,
and the hook helper it is wired to relies on a `calcChange` branch that is a no-op), and two
**leftover-from-refactor** items in `useMatrixHistory` (a double `calcChange` per edit, and the now-unused
`mutedMatrix` state+effect).

No NEW data-corrupting bug was found. The ★critical invariant — the SC channel axis must never enter
global piano-pitch state — **holds** across the merged code (verified at `SoundChannelsPane.jsx:268,281`
and the aggregate ruler).

### Prioritized top findings

| # | Sev | One-line | File:line |
|---|-----|----------|-----------|
| **P1-A** | P1 | Two overlapping zoom systems (tie/untie vs legacy shared-range) split across panes — inconsistent state source + duplicated toolbar | `PianoidTuner.js:1806/1888/2407`, `chartView.js` |
| **P1-B** | P1 | Dead mute write-path: `onMuteMapChange` never invoked; wired `applyImperativeMuteToggle`/`changeFeedInMuteMap` are dead; the `calcChange` "Mute"-without-zone branch is a no-op | `MeasuredMatrix.jsx:41`, `useSoundChannels.js:462-477`, `useMatrixHistory.js:120` |
| **P2-A** | P2 | `applyChange` runs `calcChange` TWICE per edit (double full-matrix deep-clone) | `useMatrixHistory.js:213-214` |
| **P2-B** | P2 | `mutedMatrix` state + useEffect is unused dead churn (re-clones whole matrix on every edit) | `useMatrixHistory.js:9,26-37,293` |
| **P2-C** | P2 | `scListenToModes` still localStorage-derived, not backend `listen_mode` — opposite-direction divergence still possible (ana-uimtx H2 partially open) | `PianoidTuner.js:494-496` |
| **P2-D** | P2 | Feedback pane fully disabled in single-deck mode but still carries the full legacy zoom/range wiring + dead `onMuteMapChange` | `PianoidTuner.js:1863-1912` |
| **P3-A** | P3 | No render-without-`range` mount test for the canvas (f704087 crash class); canvas reads `pianoRange[0]` before any guard | `PitchesModesMatrixCanvas.jsx:57` |
| **P3-B** | P3 | Matrix-cell click changes the active pitch as a side-effect of navigation (the known backlog item) — assessed; defensible but a footgun | `MeasuredMatrix.jsx:355-357` |
| **P3-C** | P3 | `Object.values(matrix)` row-order coupling persists (ana-uimtx L1) | `PitchesModesMatrixCanvas.jsx:54`, `MeasuredMatrix.jsx:84` |

---

## 1. CORRECTNESS

### ★ Critical invariant — SC channel axis must never enter global pitch state — HOLDS
**Evidence:** `SoundChannelsPane.jsx:268` (`onPitchSelect={listenToModes ? setSelectedPitch :
setSelectedChannel}`), `:281` (`onSelectPitchesRange={setSelectedChannelRange}` — SC-LOCAL, not the
global `setSelectedPitches`), `:291` (`onPianoRangeChange={NOOP_RANGE}`). The aggregate ruler
(`SoundChannelsAggregateChart.jsx:356-392`) only ever exposes a MODE ruler (strings axis) or a PITCH
ruler (modes axis, which H2 makes unreachable) — **never a channel ruler**, so the collapsed fan-out
axis can't leak. The `applyAggregateMuteCycle` bounds are mode-/pitch-only and the muteCycle test
(`useSoundChannels.muteCycle.test.jsx:116-129`) pins "no pitch/channel bound ever appears." **Verdict:
the fa3c64b `matrix[-22]` crash class is structurally prevented across the merged code.** Good.

### P1-A (P1) — Two overlapping zoom systems
**Evidence:**
- Feedin derives its view: `pianoRange={deriveChartView(isChartTied("Feedin"), selectedPitches, …)}`
  and `modesRange={deriveChartView(…)}` (`PianoidTuner.js:1806-1815`).
- Workbench likewise uses `deriveChartView` (`:2013-2017, 2058-2065`).
- **Feedback** uses the LEGACY shared range: `pianoRange={rangeOfPitches}` `modesRange={rangeOfModes}`
  (`:1888-1889`).
- **Sound Channels** uses the legacy `rangeOfModes` for its column axis (`SoundChannelsPane.jsx:265`,
  `PianoidTuner.js:1984`).
- The toolbar renders **two distinct button groups**: a tie/untie group for `Feedin`/`Workbench`
  (`renderToolbarControls` `:2355-2405`, ZoomIn/ZoomOut that toggle `tied` + a Deselect button) and a
  *separate* legacy ZoomIn/ZoomOut group for `["Virtual Piano","Feedback","Sound Channels"]`
  (`:2407-2465`, which mutate `rangeOfPitches`/`rangeOfModes`).

**Why it matters:** two zoom paradigms, two state sources (`tied`+`selectedPitches/Modes` vs
`rangeOfPitches/Modes`), two button sets, in the SAME app, often in the SAME 4-pane layout. A user who
drag-selects a range in Feedin (which zooms Feedin via tie) sees NOTHING happen in Feedback (legacy,
ignores selection) unless they also use the *other* zoom buttons. The icons are even swapped: the
tie/untie "untie" uses `ZoomOutIcon` to MORE than the legacy "zoomIn" which ALSO uses `ZoomOutIcon`
(`:2371` vs `:2437`) — visually identical buttons with opposite semantics across panes. This is the
classic half-migration trap and is the most likely source of "the zoom behaves differently in
different panes / I can't tell what these buttons do."

**Recommendation:** finish the P3 rollout — migrate Feedback + Sound Channels (+ Virtual Piano range)
onto `deriveChartView`, then delete the legacy `rangeOfPitches`/`rangeOfModes` zoom branch in
`renderToolbarControls` and the `onPianoRangeChange`/`onModesRangeChange` plumbing. If finishing is not
in scope now, at minimum (a) make the legacy zoom buttons use a DIFFERENT icon set so they aren't
confusable with the tie/untie ones, and (b) document in OVERVIEW that the subsystem is mid-migration so
the next dev doesn't "fix" one half into the other. SC's channel-row axis must stay SC-LOCAL in either
design (do NOT route it through the shared selection — see the invariant above).

### P1-B (P1) — Dead mute write-path + a no-op calcChange branch
**Evidence (trace it through):**
1. `MeasuredMatrix` declares `onMuteMapChange` (`:41`) but **never calls it** (grep: the identifier
   appears only at the destructure site `:41`). The matrix Mute affordance flows entirely through
   `onMatrixValuesChange` (`:223`, `handleMatrixValuesChange` builds an `operation:"Mute"` change WITH
   a `zone` and dispatches it via `onMatrixValuesChange`).
2. So the props wired to `onMuteMapChange` are dead: SC's
   `onMuteMapChange={(newMap)=>applyImperativeMuteToggle?.(newMap)}` (`SoundChannelsPane.jsx:293`) and
   Feedin/Feedback's `onMuteMapChange={changeFeedInMuteMap}` (`PianoidTuner.js:1835,1905`).
3. Worse, even if it WERE invoked, `applyImperativeMuteToggle` calls
   `activeHistory.applyChange({ operation: "Mute", muteMap: newMuteMap })` (`useSoundChannels.js:464`)
   — a Mute op with **no `zone`**. In `calcChange` the `else if (change.operation === "Mute")` block
   (`useMatrixHistory.js:120`) only does anything inside `if (change.zone === "Cell"|"modesVector"|
   "pitchesVector"|"Matrix")` — none match → the muteMap is returned UNCHANGED. The history entry
   records a no-op; the actual mute would only have come from the emit loop reading the *supplied*
   `newMuteMap`, which never arrives because (1).

**Why it matters:** it's confusing dead code that LOOKS like the live mute path. A future dev wiring
"mute" through `onMuteMapChange` (the obvious-looking hook) would get a silent no-op in history +
a divergence between history state and the emitted backend state. The actual working mute path is the
`zone`-bearing `onMatrixValuesChange` path, which IS correct and tested
(`useMatrixHistory.bounds.test.jsx:113`).

**Recommendation:** delete `onMuteMapChange` from `MeasuredMatrix`'s prop list and from all three
call-sites; delete `applyImperativeMuteToggle` (or, if you want a real "replace the whole muteMap"
primitive, give `calcChange` a `MuteReplace`/`MuteSet`-style handler and route it properly — note the
tri-state aggregate path already added a proper `MuteSet` op, so the toggle helper is redundant). The
per-channel matrix mute is unaffected (it uses the zone path).

### P2-C (P2) — `scListenToModes` localStorage source (ana-uimtx H2, partially open)
**Evidence:** `PianoidTuner.js:494-496` derives `scListenToModes` from
`presetLoadSettings.listen_to_modes` (a localStorage bucket), not from backend `health.listen_mode`.
ana-uimtx flagged this; since then the SC pane is DISABLED when `listenToModes` is true
(`SoundChannelsPane.jsx:121-148`). That closes the *forward* hazard (editing modes-coefficients while
the engine is in modes mode is now blocked). But the **opposite** divergence is still live: if
localStorage says `listen_to_modes=0` (strings) while the engine was APPLYed in modes mode, the SC pane
renders the strings editor over a surface the engine isn't using — the user edits a phantom matrix that
silently does nothing. The same `single_deck_matrix` flag is already sourced authentically from
`/health` for the Feedback pane (`:1863`), proving the backend-sourced pattern is available.

**Recommendation:** source `scListenToModes` from `healthStatus.listenMode` (the hook already exposes
`listenMode`, OVERVIEW `useBackendHealth`), or reconcile the two and show a mismatch banner. Low-risk,
single-source-of-truth (P1) fix.

### P3-B (P3) — Matrix-cell click changes active pitch (the known backlog item) — assessed
**Evidence:** `MeasuredMatrix.jsx:355-357` — on canvas mousedown, `if (newPitch !== pitch)
onPitchSelect(newPitch); if (newMode !== mode) onModeSelect(newMode)`. For Feedin/Feedback,
`onPitchSelect={setSelectedPitch}` (global), so navigating the matrix re-points the globally selected
pitch — which drives the Strings/Modes/Excitation editors and the spacebar play target.
**Assessment:** this is intentional cross-pane sync (the matrix IS a pitch×mode navigator) and is
consistent with how Feedin's `onActivate` pins the workbench. It is defensible. The footgun is that a
*navigation* click (just to read a value or area-select) mutates a globally-shared selection that other
panes act on — e.g. clicking a Feedin cell to inspect it moves the spacebar play target. For SC the
decouple correctly routes this to `setSelectedChannel` instead, so SC is safe. **Recommendation:** keep
the behavior (it's by design) but consider distinguishing "hover/read" from "select" — e.g. only commit
the pitch change on a deliberate click, not on the drag-through that also area-selects. Not a bug;
flag for UX review.

### Other correctness notes (verified OK)
- **mode-0 / single-cell-≠-selection / tied-untied:** `handleMouseMove` only sets a selection on a
  REAL multi-cell drag in Navigate mode (`PitchesModesMatrixCanvas.jsx:285-300`); a single click leaves
  the selection intact (`handleMouseDown:315-327` no longer clears it). `deriveChartView` clamps a stale
  wider selection into the full extent and falls back to full on an out-of-range selection
  (`chartView.js:33-36`) — robust. The live-preview-vs-commit split (`onSelectRect` during drag,
  `onSelectRectCommit` on mouse-up, `:378-392`) correctly prevents a tied chart from re-zooming on every
  drag frame.
- **tri-state mute determinism:** `applyAggregateMuteCycle` uses the `MuteSet` SET primitive (not XOR
  toggle), is disabled when nothing is selected (`SoundChannelsAggregateChart.jsx:307`), and resets to
  idle when the selection changes (`:150-157`). Cycle 1→2→3→1 is deterministic and tested.

---

## 2. STATE MANAGEMENT

### Adherence to the 3 frontend-state principles
`useSoundChannels` remains the reference implementation: presetVersion-driven unconditional re-init
(`:313-323`), granular per-pitch emits, imperative-at-handler writes, no speculative-emit useEffects.
**The feedin/feedback editors still use the legacy speculative-emit pattern** (ana-uimtx H3) — that is
*outside* this subsystem's hooks (it lives in `PianoidTuner.js` feedin/feedback wiring and was flagged
deferred tech-debt). I did NOT re-tread it; it is unchanged and still owed.

### P2-A (P2) — `applyChange` double-computes `calcChange`
**Evidence:** `useMatrixHistory.js:213-214`:
```js
setMatrix(calcChange(matrix, muteMap, change).newMatrix);
setMuteMap(calcChange(matrix, muteMap, change).newMuteMap);
```
`calcChange` deep-clones the WHOLE matrix and muteMap via `JSON.parse(JSON.stringify(...))` (`:72-73`).
Calling it twice doubles that clone cost per edit. For Belarus (84 pitches × 196 modes ≈ 16k floats)
that's two full structured clones per cell drag frame.
**Recommendation:** `const r = calcChange(matrix, muteMap, change); setMatrix(r.newMatrix);
setMuteMap(r.newMuteMap);`. Trivial, pure win.

### P2-B (P2) — `mutedMatrix` is dead state churn
**Evidence:** `useMatrixHistory.js:9` declares `mutedMatrix`, `:26-37` is a useEffect that recomputes a
full `matrix × muteMap` product on EVERY `[muteMap, matrix]` change, and it's exported (`:293`). Grep
shows **no consumer** reads `mutedMatrix` in the matrix/SC subsystem (the SC emit path computes its own
gated row inline, e.g. `useSoundChannels.js:404`). This is a leftover of the pre-dev-833f speculative-
emit architecture (the H3 silence-bug pattern watched `mutedMatrix`). It now just burns a full-matrix
`Object.fromEntries(... .map(...))` on every edit for nobody.
**Recommendation:** delete `mutedMatrix` state, its useEffect, and the export (confirm no out-of-scope
consumer first — a repo-wide grep showed none in the editor panes).

### Race conditions / the bar-chart intermittent-render bug
ana-uimtx and task #208/#210/#211/#212 already diagnosed + fixed the headline intermittency:
`RowEditor` `titles` NaN-length (`RowEditor.js:88-98`), the two mismatched `barChartValues` effects
merged into one union-dep effect (`MeasuredMatrix.jsx:81-87`), and the `DrawableChart` ResizeObserver
(`DrawableChart.jsx:460-474`). I reviewed those fixes — they are sound. **One residual race I did NOT
see addressed:** `MeasuredMatrix`'s `verticalPanelSizes` effect (`:126-128`) calls `handleVerticalResize`
which imperatively `panel.resize(...)` on refs — and `onResize` on those same panels writes
`verticalPanelSizes` (`:267-268, 336-338`). That's a resize→setState→effect→resize loop that is only
stable because `panel.resize` to the same size is a no-op; it's fragile and worth a guard (`if
newSize === verticalPanelSizes.top return`). Low-frequency; flagged P3-adjacent. The DrawableChart
StrictMode double-fetch class doesn't apply here (no fetch in these components; data arrives via props).

### Stale closures
`DrawableChart` correctly reads live values via refs in the zrender handlers (`valuesRef`,
`paintDisabledRef`, `clampRef`, `:122-130, 319-322`) — no stale-closure bug in the drag path. The
`useSoundChannels` emit helpers compute post-change matrices synchronously via `calcChange`/
`computeMatrixAtStep` rather than trusting React-committed state (`:395-401, 546-552`) — correct, and
the documented reason for the pure-helper exports.

---

## 3. UI / UX + ACCESSIBILITY

- **MUI v6 / dark theme:** the new components are compliant — `SoundChannelsAggregateChart` and
  `DrawableChart` use `useTheme()` + `theme.palette.*` for series/axis/grid/muted colors
  (`DrawableChart.jsx:112-115`, `SoundChannelsAggregateChart.jsx:266-268`), `backgroundColor:
  "transparent"`, dark ECharts theme. Icon buttons carry `aria-label` (`:296,312`). Good. **The legacy
  `MatrixTools` toolbar is still light-themed with hardcoded hex + raster PNG icons** (ana-uimtx M1) —
  unchanged, still owed; out of this review's new-surface focus but re-flagged.
- **Tooltip:** `formatTooltipValue` rounds to `decPlaces` with trailing-zero trim
  (`PitchesModesMatrixCanvas.jsx:7-14`) — ana-uimtx M3 done. `tabular-nums` applied (`:376`). Good.
- **Mute grey-paint:** `DrawableChart` paints muted buckets with `theme.palette.action.disabled` via
  per-point `itemStyle` while keeping the drag vector numeric (`:231-237`) — correct, drag-paint
  unaffected. The `mutedMask` is mapped through the WINDOWED `indexMap` so it stays aligned under zoom
  (`SoundChannelsAggregateChart.jsx:235-245`). Good.
- **Ruler↔bar alignment:** single shared `CHART_GRID_PAD` source (`DrawableChart.jsx:26-29`) consumed by
  both `RowEditor` (`RULER_PAD`) and the aggregate ruler (`AGG_RULER_*`) — they can't drift. Good.
- **a11y gaps (unchanged):** the matrix `<canvas>` is still mouse-only — no `role`/`tabIndex`/
  `aria-label`/keyboard nav (ana-uimtx M2). The new tie/untie + clear-selection buttons DO have
  `title`/`aria-label`. The FlatBarAxis / VirtualPiano rulers are drag-only. Canvas a11y remains a
  scoped follow-up.

---

## 4. PERFORMANCE + RENDER

- **ECharts churn:** `DrawableChart`'s `option` is memoized with a complete dep array (`:304-308`);
  `animation:false`; `notMerge:true`. Reasonable. The aggregate chart slices to the visible window
  before passing data (`windowSeries`, `SoundChannelsAggregateChart.jsx:74-90`), bounding render cost
  under zoom. Good.
- **Matrix canvas:** redraws the full matrix on `[matrix, muteMap, cellSize, …]`
  (`PitchesModesMatrixCanvas.jsx:224-234`). For a drag-paint that emits a new matrix per frame, that's a
  full canvas repaint per frame — acceptable for a 2D fill loop, but combined with P2-A (double clone)
  and P2-B (mutedMatrix recompute) the per-frame cost is ~3× what it needs to be. Fixing P2-A/B removes
  two full-matrix passes per edit.
- **Memoization gap:** `MeasuredMatrix`'s big inline arrow props (`onMouseDown`, `onSelectRect`,
  `onActivate`) are re-created every render and passed to the canvas; the canvas isn't memoized, so it
  re-renders on every parent render regardless. Low impact (canvas is cheap) but worth a `React.memo` +
  `useCallback` if churn shows up in profiling. Flag, not urgent.

---

## 5. ARCHITECTURE — averaged-SC ↔ workbench overlap (the explicit ask)

**Should the averaged-SC view and the Workbench be unified into one component? Recommendation: NO.**

They look similar (both a single scalar-per-bucket editable curve) but they are different *concerns*:
- **Workbench** (`RowEditor` → `BarChart` → `DrawableChart`) edits ONE parameter ROW of an
  already-2D matrix (a pitch's modes, or a mode's pitches) — it's a slice editor; its emit is a direct
  per-index vector write to that row.
- **Averaged-SC** (`SoundChannelsAggregateChart` → `DrawableChart`) edits an AGGREGATE (the average
  across the collapsed fan-out axis) and must FAN the painted delta back across N channels via
  `fanOutAggregateChangeAxis` — its emit is a 1→N broadcast, not a direct write.

Unifying them would force the fan-out concern into the slice editor or vice-versa, coupling two
unrelated emit semantics. **The right boundary is already drawn:** both correctly delegate render +
drag + toolbar to the shared `DrawableChart` (single concern: render/edit/emit a vector), and each owns
its own thin adapter. That IS the DRY win; the adapters are NOT duplicated logic (one does positional
writes, the other does averaging+fan-out). `deriveChartView`'s placement in `utils/chartView.js` (pure,
unit-tested, reused) is correct.

The real (acceptable) duplication is the two thin DrawableChart wrappers (`BarChart`/`RowEditor` path
vs `SoundChannelsAggregateChart`), which is the intended Wave-2/Wave-3 design. Leave it.

**P2-D (P2) — Feedback pane carries dead wiring.** In single-deck mode (the active build) the Feedback
pane renders only an Alert and never mounts `MeasuredMatrix` (`PianoidTuner.js:1863-1868`). But the
`else` branch still carries the full legacy zoom/range/`onMuteMapChange` wiring (`:1869-1912`), and the
toolbar still lists "Feedback" in the legacy zoom gate (`:2408`) even when the pane shows only an Alert.
**Recommendation:** when `singleDeckMatrix`, also suppress the Feedback zoom toolbar buttons (they act
on a pane with no matrix). Minor, but it's a control that does nothing visible.

---

## 6. TEST COVERAGE

Strong at the pure-function layer: `useMatrixHistory.bounds`, `useMatrixHistory.muteSet`,
`useSoundChannels.muteCycle`, `chartView`, `MeasuredMatrix.layout`/`scopedBounds`/`barChartValues`,
`RowEditor.axisVariant`/`barchart`, `SoundChannelsPane.localChannel`, `useHotkeys.zeroPitch`,
`DrawableChart.autoScale`, `PitchesModesMatrixCanvas.tooltip`. The SC-decouple guard tests
(localChannel + zeroPitch) ARE sufficient for the invariant they protect — they pin the
`setSelectedChannel` routing and the `pitch===0` hotkey guard.

**Gaps:**
- **P3-A — no render-without-`range` mount test (the f704087 class).** `PitchesModesMatrixCanvas`
  reads `pianoRange[0]` at module-body line 57 BEFORE the draw-effect guard (`:105`), and `matrix[col]
  [row]` at `:127`. Call-sites guard against a null matrix (`SoundChannelsPane.jsx:150`, the
  `feedinHistory?.matrix ?` ternaries), so it can't crash today — but there is no test asserting the
  canvas tolerates a missing/empty `range` or a `pianoRange` whose `[0]` precedes `firstAvailableNote`
  (the negative-`normRangeStart` → `matrix[-N]` class). Recommend a mount test rendering the canvas with
  `pianoRange=undefined` and with a sub-range, asserting no throw.
- **No test for the dead `onMuteMapChange` path** (P1-B) — because nothing exercises it; deleting it
  removes the gap.
- **No integration test for the two-zoom interaction** (P1-A) — a test that drag-selects in Feedin and
  asserts Feedback does/doesn't follow would have surfaced the half-migration. Add when P1-A is resolved.

---

## 7. What was checked and is FINE (so it isn't re-reviewed)
- SC channel-decouple invariant (§1, the ★critical one) — holds everywhere, incl. the new aggregate
  ruler and tri-state mute.
- `deriveChartView` correctness (clamping, fallback, highlight gating) — `chartView.js`, well-tested.
- DrawableChart drag/paint/wheel/paintDisabled/mutedMask/autoScale — ref-based, no stale closures.
- Scoped-edit bounds derivation (selection-narrower-than-full → bound) — `MeasuredMatrix.jsx:176-208`,
  tested in `MeasuredMatrix.scopedBounds.test.jsx`.
- Strings-axis key normalization (128 offset in/out) — `useSoundChannels.js:234-257`, correct.
- presetVersion re-init discipline — intact.

---

## Status at close
Read-only review. No source edited, no build run, no locks held, no running stack/ports touched. Tree
additions: this review doc + the session log `docs/development/logs/review-mwsc-98d1-2026-06-10.md`.
All findings are PROPOSED — implementation is a separate user-approved `/dev`.

MkDocs link:
http://localhost:8001/development/reviews/matrix-workbench-avgsc-review-2026-06-10/
