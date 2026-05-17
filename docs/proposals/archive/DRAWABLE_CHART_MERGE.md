# Drawable Chart Merge — Line-vs-Bar Unification Proposal

**Status:** Accepted 2026-04-21 (user decisions Q1–Q4 resolved via Telegram; see section 11)
**Date:** 2026-04-20 (original), 2026-04-21 (accepted + wave order revised)
**Scope:** PianoidTunner frontend components
**Driver request:** "We have two elements with very similar functionality (line chart with drawing, bar chart with drawing). Analyse and propose how to merge. Any panel using this functionality has to have a choice in settings: visualise as linechart or as barchart."

---

## 1. Inventory

### Drawable components found

| # | Component | File | LOC | Render | Edit pattern | Data shape |
|---|-----------|------|-----|--------|--------------|------------|
| 1 | `SoundChannelsAggregateChart` | `components/SoundChannelsAggregateChart.jsx` | 501 | ECharts line + zrender | Left-drag paint | `{pitch:[avg]}` (modes axis) / `{averaged:[per_mode]}` (strings axis) |
| 2 | `PerceptionCurveEditor` | `components/PerceptionCurveEditor.jsx` | 380 | ECharts line + zrender | Left-drag paint | `{pitch:[6 levels]}` × active level |
| 3 | `BarChart` (+ `BarChartValue`) | `components/BarChart.jsx` (213) + `BarChartValue.jsx` (112) | 325 | DOM divs + CSS fill % | Right-drag paint, wheel adjust, left-click select | flat `values[]` array + `startZoom`/`endZoom` window |
| 4 | `RowEditor` | `components/RowEditor.js` | 115 | Wraps `BarChart` above `VirtualPiano` / `ModesRule` | Forwards | Same as `BarChart` |
| 5 | `CurveEditor` | `components/CurveEditor.jsx` | 496 | ECharts line | Ctrl+click remove reference; server-side buttons only | Fetched from REST (`/calibration_curve`) |

**Exclusion:** `CurveEditor` is a server-driven reference-set editor (PCHIP follow, flat-via-REST, save/load). It's line-shaped but not drag-drawable in the same way. **Keep out of the merge.**

### Consumers (drawable call-sites)

| Consumer | Which drawable | Via |
|---|---|---|
| `MeasuredMatrix` (bottom pane of every matrix panel: Feedin, Feedback, Sound Channels per-channel, Deck) | `BarChart` | `RowEditor` |
| `Workbench` (default pane) | `BarChart` | `RowEditor` inside `case "Workbench"` in `PianoidTuner.js:1566` |
| Dynamic workbenches (one per opened parameter — Modes, Strings, matrix rows) | `BarChart` | `RowEditor` in default case `PianoidTuner.js:1770` |
| `Strings` / `Mode` parameter columns | `BarChart` for the mini per-column viewer (indirect, via workbench open) | — |
| `SoundChannelsPane` (aggregate ON) | `SoundChannelsAggregateChart` | Direct |
| `CalibrationPanel` ("Volume Tuner") | `PerceptionCurveEditor` | Direct |

---

## 2. Commonalities

All three drawables (1, 2, 3) share the following algorithmic core:

- **Data model:** scalar value per indexed bucket (pitch or mode). Index → x; value → y.
- **Drag-to-paint:** mouse-down picks a bucket, mouse-move paints each bucket under the cursor with the corresponding y-value.
- **Linear gap-fill interpolation** between sequential drag steps (reimplemented 3 times: `SoundChannelsAggregateChart.applyPaint`, `PerceptionCurveEditor.applyPaint`, `BarChart.changeArrayValuesAndFillGaps`).
- **Clamp:** y-values clamped to a component-specific `[min, max]` before emit.
- **Emit full or sparse vector:** change handler fires either on every mousemove (line drawables) or on mouse-up (bar).
- **Pitch-name x-labels:** `pitchToName(midi)` helper duplicated verbatim across `SoundChannelsAggregateChart.jsx`, `PerceptionCurveEditor.jsx`, `CurveEditor.jsx`.

## 3. Differences

### Accidentally different (good merge targets)

| Aspect | SC aggregate | Perception | BarChart |
|---|---|---|---|
| Render engine | ECharts line + zrender mouse | ECharts line + zrender mouse | Raw DOM divs + inline CSS fill |
| Gap-fill code | Yes (local) | Yes (local) | Yes (local) — all linear, all independent |
| Clamp range | `[0, 1e6]` | `[0.01, 20]` | Unclamped |
| Dark theme | ECharts `theme="dark"` | Unstyled (inherits parent) | Hardcoded `#02814c` (not MUI) |
| Flat / Smooth | Yes (toolbar) | Yes (buttons) | No |
| Undo/redo integration | Via `useMatrixHistory` | Via parent | Via parent + `lastChangedIndex` local |
| Emits | Full painted vector | Updated `curves` map | Full values array |
| Pitch-name helper | Local copy | Local copy | Not applicable (uses `titles` prop) |

### Essentially different (domain semantics — keep in adapter layer)

| Aspect | SC aggregate | Perception | BarChart / RowEditor |
|---|---|---|---|
| Data shape | Object keyed by pitch or fixed "averaged" key | Object keyed by pitch, 6-element arrays | Flat array + zoom window |
| Fan-out after emit | Per-pitch → per-channel broadcast via hook | Single cell per pitch at active level | Parent decides |
| Multi-series overlay | No | Yes (5 velocity levels with active highlighted) | No |
| Axis semantics | Variable: x = pitch or mode | Fixed: x = pitch | Variable: flat array of any meaning |
| Level / velocity selector | No | Yes (pp/p/mf/f/ff + overlay switch) | No |
| Copy-to-all | No | Yes | No |
| Bottom ruler | No | No | Yes (`VirtualPiano` or `ModesRule`, via `RowEditor`) |

---

## 4. Architecture Options

### Option A — Single component with `variant="line" | "bar"` prop

```jsx
<DrawableChart
  values={[...]}
  variant={settings.visualization}  // 'line' | 'bar'
  xLabels={[...]}
  yRange={[min, max]}
  onDraw={(painted) => ...}
  toolbar={<FlatSmoothToolbar />}  // optional
/>
```

**Pros:**
- Single source of truth for paint + gap-fill + clamp.
- Easiest call-site migration (just wrap).

**Cons:**
- Bar-mode and line-mode rendering differ substantially — bar needs per-bucket DOM or ECharts bar series with custom zrender drag logic. Likely ends up with two internal render branches forked on `variant`, defeating the point.
- Forces bar-mode to give up its cheap DOM-fill style for ECharts bar type (or keeps two parallel paths inside one file).

### Option B — Shared core + thin variants (RECOMMENDED)

```
DrawableChartBase (ECharts wrapper, paint, gap-fill, clamp, flat/smooth, undo/redo props)
  ├── series type chosen by variant prop: 'line' | 'bar'
  ├── common toolbar slot
  └── dark MUI theme

Consumers pass `variant` (from per-panel settings) + data shape adapters.
```

Use ECharts' native `type: 'bar'` and `type: 'line'` series — both accept the same `data: [values]` and both work with `convertToPixel`/`convertFromPixel` for zrender drag math. The paint logic is **identical** regardless of variant; only the series descriptor and the symbol styling change.

**Pros:**
- Paint, gap-fill, clamp, flat, smooth, history props: written once.
- Bar-mode inherits dark MUI theme for free (currently absent in `BarChart`).
- Visual toggle is a one-line `series[0].type` switch.
- ECharts `bar` with category axis gives the right-click-aware legacy bar UI "for free" + gains left-drag-paint (an upgrade the current bar lacks).
- `RowEditor`-style ruler composition stays at the consumer level (no new coupling).

**Cons:**
- Must port `BarChart`'s current wheel-adjust and right-click-drag (small, ~20 LOC).
- Bar mode with many buckets (e.g. 88 pitches × 256 modes in workbench) needs ECharts perf spot-check. ECharts handles 1–10K bars fine; Pianoid's largest workbench is under 300 buckets.

### Option C — Shared hook + separate variant components

```
useDrawableChart({values, clamp, onDraw}) → { chartOptions, onChartReady, flatHandler, smoothHandler }
DrawableLineChart({...hook}) // ECharts line
DrawableBarChart({...hook})  // ECharts bar (or legacy DOM)
```

**Pros:**
- Lets a consumer (e.g. Perception with multi-level overlay) keep full render control while reusing the paint logic.
- Easier to extract without touching all call sites at once.

**Cons:**
- Extra indirection for the 90% case where a consumer just wants "a drawable."
- Still ends up with two components to maintain.
- Multi-level overlay is only used by Perception — not a strong enough reason for the whole project to pay indirection cost.

### Option D — No merge

Keep three separate components. **Rejected.** The drag+gap-fill+clamp code is materially duplicated; bar-mode drawing has no dark theme; there's no existing line-vs-bar toggle anywhere.

---

## 5. Recommendation: Option B (shared core + thin variants)

**Name:** `DrawableChart` (new, in `components/DrawableChart/DrawableChart.jsx`).

**Proposed API:**

```jsx
<DrawableChart
  // data
  values={number[]}                     // y-values, index-aligned to xLabels
  xLabels={string[]}                    // category labels for x-axis
  indexMap={{pitch?, mode?}[]}          // optional meta for tooltip/emit payload
  
  // visualization
  variant="line" | "bar"                // switched by per-panel setting
  yMin={number}
  yMax={number}                         // auto-scale if undefined
  seriesColor={string}                  // MUI palette color
  
  // interaction
  onDraw={(paintedValues, indexMap) => void}   // full vector after each drag step
  onSelect={(index) => void}                   // left-click (bar legacy selection)
  
  // optional toolbar
  toolbar="minimal" | "full" | false           // minimal = undo/redo; full = +flat/smooth
  flatMin={0} flatMax={1e6}
  onFlat, onSmooth                             // implemented internally, invoked via toolbar button
  
  // history
  canUndo, canRedo, onUndo, onRedo
  
  // misc
  clampMin, clampMax
  dense={true}                                 // compact axis labels + small gap
/>
```

- **Paint implementation:** single `handleChartReady` identical to current `SoundChannelsAggregateChart`/`PerceptionCurveEditor` (zrender mousedown/mousemove/mouseup + convertToPixel/convertFromPixel + linear gap-fill).
- **Variant switching:** `series[0].type = variant`. Bar gets `symbol: 'none'`, category gap ≈ 10%. Line gets `symbol: 'circle'`, `smooth: false`.
- **Dark theme:** ECharts `theme="dark"`, axis colors from `useTheme().palette`.
- **Keeps out:** multi-level overlay (Perception-specific), fan-out semantics (SC-specific), bottom ruler (RowEditor's job).

### Consumer migration

| Consumer | Migration |
|---|---|
| `SoundChannelsAggregateChart` | Delete file; `SoundChannelsPane` renders `<DrawableChart variant={soundChannelSettings.aggregateVariant} axis-shaped data>`. Flat/smooth stay via `toolbar="full"`. Fan-out stays in the hook (unchanged). |
| `PerceptionCurveEditor` | Keep as a thin wrapper that holds multi-level overlay + velocity selector + copy-to-all, delegates the drawable core to `<DrawableChart variant={...}>` for the active level. Overlay series (non-active levels) rendered via a `readonlyOverlaySeries` prop (array of `{name, color, data}` passed through to ECharts). |
| `BarChart` + `BarChartValue` + `BarChart.css` + `BarChartValue.css` | Delete. `RowEditor` replaces its inner `<BarChart>` with `<DrawableChart variant={settings.visualization}>`. Wheel-adjust + left-click-select ports into the new component. |
| `RowEditor` | Becomes thin wrapper: `DrawableChart` + `VirtualPiano`/`ModesRule`. Takes `variant` from containing panel's settings. |
| `CurveEditor` | **Unchanged.** Not a drag-drawable; stays as-is. |

---

## 6. User-facing setting

### Where the toggle lives

**Per-panel** (recommended), persisted in the same `useSettings` hook that already holds `feedInSettings`, `feedbackSettings`, `soundChannelSettings`, `modesSettings`, `stringsSettings`, `chartSelectorSettings`. Add a `visualization: 'line' | 'bar'` key to each settings object.

The per-panel Settings gear already exists (e.g. `feedInSettings.pianoHeight`, `soundChannelSettings.*`); add a MUI `ToggleButtonGroup` with Line / Bar icons in the settings dialog.

**Rejected alternatives:**
- **Global:** too coarse — users want bar for per-pitch feedin browsing but line for an averaged aggregate curve.
- **URL param:** non-standard for this codebase; settings panels are the established pattern.
- **Preset:** visualization is a UI preference, not a synthesis parameter; storing in preset pollutes the physical model.

### Default per panel

| Panel | Default variant | Rationale |
|---|---|---|
| Workbench (default + dynamic) | `bar` | Current behavior — don't break muscle memory |
| `MeasuredMatrix` bottom editor (Feedin, Feedback, Deck matrices) | `bar` | Current behavior |
| `SoundChannels` per-channel matrix row editor | `bar` | Matches other matrices |
| `SoundChannels` aggregate view | `line` | Current `SoundChannelsAggregateChart` behavior (a per-pitch/mode average curve is smoother as a line) |
| `Perception` ("Volume Tuner") | `line` | Multi-level overlay is already line-based |

### Persistence

`useSettings` already persists to `localStorage` per-panel key. New `visualization` field piggy-backs on existing pattern — no schema migration needed.

### Scope

- One shared setting key per existing per-panel settings object (`feedInSettings.visualization`, etc.).
- New MUI ToggleButtonGroup row in the existing settings panels.
- Consumers forward `settings.visualization` as the `variant` prop.

---

## 7. Implementation plan (revised 2026-04-21 per user Q4 — BarChart first)

### Wave 1 — Core component (no call-site changes yet)
1. Create `components/DrawableChart/DrawableChart.jsx` (~350 LOC) with ECharts line+bar variant + zrender paint + toolbar slot + dark theme.
2. Verify both variants render + drag-paint correctly via `/test-ui` (temporary demo mount or isolated test page).
3. DO NOT migrate any existing call-sites in this wave.

### Wave 2 — BarChart + BarChartValue + RowEditor migration
4. Replace `<BarChart>` inside `RowEditor` with `<DrawableChart variant={settings.visualization}>`. Port wheel-adjust + left-click-select semantics.
5. Add `visualization: 'bar'` field to `feedInSettings`, `feedbackSettings`, `modesSettings`, `stringsSettings`, `soundChannelSettings` in `useSettings` (default `bar` per user Q2).
6. Add Line/Bar `ToggleButtonGroup` to each panel's Settings gear.
7. Verify every Workbench + MeasuredMatrix consumer via `/test-ui`.
8. Delete `BarChart.jsx`, `BarChartValue.jsx`, `BarChart.css`, `BarChart.module.css`, `BarChartValue.css`.

### Wave 3 — SoundChannels aggregate migration
9. Delete `SoundChannelsAggregateChart.jsx`; render `<DrawableChart>` inline inside `SoundChannelsPane` aggregate branch.
10. Add `soundChannelSettings.visualizationAggregate` (default `line`) so per-channel and aggregate can differ.
11. Verify aggregate drag → fan-out → audio change via `/test-ui`.

### Wave 4 — PerceptionCurveEditor migration
12. Refactor `PerceptionCurveEditor` to use `<DrawableChart>` for active-level paint; keep level selector + overlay + copy-to-all as a wrapping component.
13. Verify via `/test-ui`: drag paint, level switch, smooth, copy-to-all.

### Wave 5 — Cleanup
14. Extract `pitchToName` to `utils/pitch.js` (duplicated in 3 files).
15. Remove `BarChartGrid.jsx` if unreferenced.
16. Final docs sweep (update `modules/pianoid-tunner/OVERVIEW.md` component table).
17. Code-quality sweep against `docs/development/CODE_QUALITY.md` principles (C4 size budget, no god-objects introduced).

### Not included in this revision
- No `Proposals` entry added to `mkdocs.yml` nav (user Q5 = no). Page remains reachable by URL only.
- `CurveEditor` ("Volume Tuner") is NOT given a line/bar toggle (user Q1 = no). Stays line-only server-driven.

---

## 8. Scope estimate

| Wave | LOC added | LOC removed | Effort |
|---|---|---|---|
| 1 (core) | ~400 | 0 | M (1–2 days) |
| 2 (Perception) | ~50 | ~150 | S (hours) |
| 3 (SC aggregate) | ~30 | ~501 | S (hours) |
| 4 (BarChart + settings) | ~150 | ~450 | M (1–2 days) |
| 5 (cleanup) | ~50 | ~60 | S (hours) |
| **Total** | **~680** | **~1160** | **Medium** (3–4 days end-to-end) |

Net delta: **−480 LOC**, 3 files deleted, 1 new component, ~12 call-site touches.

---

## 9. Risk + test strategy

### Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Regression in existing drag-paint feel (timing, gap-fill) | Medium | Port `applyPaint` verbatim from SC aggregate; write unit test against a fixed mouse path |
| Bar-mode rendering perf at 256 modes in workbench | Low | ECharts handles this — benchmark a 256-bucket drawable; fall back to DOM-fill render if > 16ms frame |
| Change in emitted-vector format silently breaks SoundChannels fan-out | Medium | Keep `pitchesVectorDrawn`/`modesVectorDrawn` zone semantics intact; map at SoundChannelsPane boundary, not inside `DrawableChart` |
| Per-panel settings forgotten on some consumer (visualization defaults to wrong value) | Low | Add explicit default to each panel's initial settings in `useSettings`; TypeScript/JSDoc on `variant` prop |
| Dark-theme regression in bar mode (palette vs hardcoded `#02814c`) | Low | Use `theme.palette` throughout; snapshot tests on a dark-theme page |
| Undo/redo integration differs per consumer | Medium | `DrawableChart` takes `canUndo/canRedo/onUndo/onRedo` as props — consumer owns history (same as today for Perception and SC) |

### Test strategy

| Level | Tests |
|---|---|
| Unit | paint across gap, clamp at bounds, flat-all, smooth at edges, variant prop switch, settings persistence roundtrip |
| Integration | `/test-ui` — drag in SC aggregate → audio verified via note_playback chart; drag in Workbench (feedin matrix row) → backend value change verified via REST |
| Visual | Screenshot: line vs bar variant in each consumer panel, dark theme |
| Perf | 256-bucket drawable render + paint at 60fps |

---

## 10. Open questions for the user (historical — resolved below)

1. Should `CurveEditor` also get a line-vs-bar toggle?
2. Workbench default variant: bar (current) or line?
3. Should the line-vs-bar toggle appear in the MosaicWindow title bar or only in the Settings gear?
4. Wave ordering: Perception first (lowest risk) or BarChart first (highest surface)?
5. Add a `Proposals` entry to `mkdocs.yml` nav?

## 11. Accepted decisions (2026-04-21, user via Telegram)

| Q | Decision | Rationale |
|---|----------|-----------|
| Q1 | `CurveEditor` stays line-only, no toggle | As recommended — not a drag-drawable; scope creep |
| Q2 | Workbench default = `bar` | As recommended — preserves muscle memory |
| Q3 | Toggle in Settings gear only | As recommended — consistent with existing panel settings pattern |
| Q4 | **BarChart migration FIRST** (after core) | User override of recommendation — highest-surface migration de-risked early |
| Q5 | NO `Proposals` nav entry in `mkdocs.yml` | URL access sufficient for now |

Wave order revised in §7 accordingly: Core → BarChart → SC aggregate → Perception → Cleanup.
