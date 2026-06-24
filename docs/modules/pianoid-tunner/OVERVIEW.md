# PianoidTunner — Module Overview

## Package Purpose

`PianoidTunner` is the **React 18 frontend** for the Pianoid system. It provides a visual tuning and parameter-editing interface that communicates with the Flask backend (`backendserver.py`) running at `http://127.0.0.1:5000`. The UI is structured as a mosaic of dockable panes — each pane renders a specific editing domain (modes, strings, excitation, deck matrices, virtual piano, charts).

---

## Version and Key Dependencies

| Package | Version | Role |
|---|---|---|
| react | ^18.3.1 | UI framework |
| react-dom | ^18.3.1 | DOM renderer |
| @mui/material | ^6.2.1 | Component library (MUI v6) |
| @mui/icons-material | ^6.2.1 | Icon set |
| @emotion/react / styled | ^11.14.0 | MUI styling engine |
| echarts | ^5.6.0 | Chart engine |
| echarts-for-react | ^3.0.2 | ECharts React wrapper |
| recharts | ^2.15.0 | Secondary charting library |
| react-mosaic-component | ^6.1.0 | Tiling window manager |
| react-reflex | ^4.2.7 | Resizable flex panels |
| react-resizable-panels | ^2.1.7 | Panel resizing primitives |
| axios | ^1.7.9 | HTTP client for Flask API |
| socket.io-client | ^4.7 | WebSocket client for real-time events |
| react-router-dom | ^7.1.3 | Client-side routing |
| react-icons | ^5.4.0 | Icon components |
| styled-components | ^6.1.15 | CSS-in-JS |

Build: `react-scripts 5.0.1` (CRA), output at `build/`.

### Backend Process Launcher

`server/launcher.js` — Node.js script that spawns and manages the Flask backend (`backendServer.py`) as a child process. Used by `useBackendProcess` hook to start/stop the backend from the frontend UI.

REST endpoints: `POST /api/start-backend`, `POST /api/stop-backend`, `POST /api/kill-stale`, `GET /api/backend-status`. WebSocket at `/ws/console` streams stdout/stderr and process status. `start-backend` automatically kills any stale process on port 5000 before spawning. `start-modal-adapter` kills stale processes on port 5001 before spawning. Both use port-specific WMIC patterns (`backendserver.py` for 5000, `modal_adapter_server.py` for 5001) to catch orphan processes not yet bound to their port. `kill-stale` kills processes on both ports without starting new ones.

`stopBackend()` uses a two-phase shutdown: first sends `POST /shutdown` to the Flask backend for graceful GPU cleanup (3-second timeout), then falls back to `taskkill /T /F` if the process is still alive. A `process.on('exit')` handler ensures force-kill as a last resort.

---

## Application Entry Point

`src/index.js` is the bundle entry. It mounts a `<BrowserRouter>` whose root route renders `<PianoidTuner />` (`src/PianoidTuner.js`) — the mosaic-layout shell that owns the entire production UI. Additional Router routes (`/new-window-chart`, `/chart-compare`, `/gauss-demo`, `/drawable-demo`) are demo / pop-out windows.

A legacy `src/App.js` single-file layout existed as the original prototype, was never wired into `index.js`, and was removed on 2026-04-27 (`dev-ghost-ui-b8bb`, review Phase 1.1) along with its dead-code closure: `modules/Connection.jsx`, `modules/Module.jsx`, `modules/Excitation.jsx`, `modules/Deck.jsx`, `modules/StringModule.jsx`, `modules/MouseEventsExample.jsx`, `components/PianoKeyboard.jsx`, `widgets/ChartStrings.jsx`, and the `modules/drafts/chatr_strings_draft.jsx` orphan (15 files, ~2677 LOC). The deleted closure called ~10 nonexistent `/get_deck_*` / `/set_deck_*` REST endpoints and was the source of two YELLOW C4 entries (Deck.jsx 772, modules/Excitation.jsx 545). The live `components/Excitation.jsx` (the one wired into `<PianoidTuner />`) is unrelated and remains.

---

## Component Architecture

### Primary Editing Components

| Component | File | Purpose |
|---|---|---|
| `VirtualPiano` | `VirtualPiano.js` | Compact virtual piano with range selection and fixed-velocity mode. The pane's "Play All" toolbar button runs a keyboard sweep over the selected range — see "Play All (keyboard sweep)" below |
| `VerticalPiano` | `VerticalPiano.jsx` | Vertically-oriented pitch selector used in matrix views |
| `MidiComponent` | `MidiComponent.jsx` | MIDI listener control surface (W4 Phase 3): listener on/off (`POST /midi/start`/`/midi/stop`), port enumeration/select (`GET /midi/ports`, `POST /midi/select_port`), broadcast toggle, and a live `midi_note_event` log. Bootstraps from `GET /midi/ports` + `GET /midi/broadcast` on mount and on `presetVersion` bump. **No longer a dockable mosaic pane (dev-tbmirror, 2026-06-14):** it is mounted inside a popup MUI `Dialog` opened from the toolbar MIDI button (the only opener). It is a self-contained `Box`, so it drops into the Dialog unchanged; props are `socketOn` + `presetVersion`. |
| `ModeSelector` | `ModeSelector.jsx` | Mode index selector |
| `Mode` | `Mode.jsx` | Single-mode parameter display (frequency, decrement, mass, stiffness) |
| `ModeMenu` | `ModeMenu.jsx` | Mode editing toolbar |
| `Strings` | `Strings.jsx` | String parameter editor (tension, string_stiffness, string_damping, string_radius, string_density, etc.) |
| `Hammers` | `Hammers.jsx` | Hammer overview across pitches |
| `HammerSpatialProperties` | `HammerSpatialProperties.jsx` | Per-pitch hammer shape editor (position, width, sharpness) |
| `Excitation` | `Excitation.jsx` | Gauss parameter editor for hammer excitation curves. Toolbar exposes four stretch/shrink buttons (`vol ↑ / vol ↓ / dur ↑ / dur ↓` semantically) — see "Excitation stretch/shrink toolbar" below. The two `vol x` / `dur x` log-axis sliders that previously lived in the toolbar were removed 2026-05-01 (dev-39c7) in favour of the buttons + a settings-popup `stretchStep` factor. **Workbench affordance (dev-excwb, 2026-06-11):** threads `onOpenWorkbench` down to `ExcitationProperties` + `GaussEditor` so EVERY excitation parameter carries a BarChart open-workbench `IconButton`, mirroring Strings/Modes — see "Excitation Workbench" below |
| `ExcitationProperties` | `ExcitationProperties.jsx` | Single-pitch excitation properties panel: the interactive hammer chart (left) + the Gauss curve editor (right). **Interactive hammer chart (dev-gausscp, 2026-06-15) — replaced the 3 hammer sliders + the canvas diagram + the `1/N` quick chips:** the hammer is now edited on a `HammerStringChart` (see its row), with `onHammerParamChange(name, value)` routing each param to the existing hammer emit path via `PianoidTuner.handleHammerParamChange` (name-aware: writes `excitationHistory` Cell directly, independent of `selectedParameter`, so each handle/field emits its own param; usePreset stays sole writer, P1). **Hammer units (audited dev-gausscp):** `hammer_position` = RATIO of string length `[0, 0.5]` (symmetric string; backend `Hammer.update_hammer_parameters` validates `0≤r≤1`, throws otherwise); `hammer_width` = METERS (bound `[0, string_length]`); `hammer_sharpness` = `[0, 1]` (backend uses `acos`). The chart DISPLAYS position as % and width in mm, sending real ratio/meters; sharpness is `[0,1]`. (This folded in the prior width/sharpness slider mis-scaling: the old "Width, mm" slider was 0.1–13 over a meters value, and "Sharpness, %" was 1–100 over a `[0,1]` value — both fixed by the chart's real-unit mapping.) The Gauss editor below is unchanged (`onGaussChange`/`onOpenWorkbench` for mu/sigma/shift/volume + the copy/paste buttons). |
| `HammerStringChart` | `HammerStringChart.jsx` | Interactive ECharts (echarts-for-react) view of the hammer on the string (dev-gausscp, 2026-06-15), replacing the position/width/sharpness sliders. X-axis = the string (normalized 0–1); the hammer is drawn as its excitation arc (mirrors the engine's `Hammer.calculate_hammer_shape`). Three draggable ECharts `graphic` handles: CENTER (drag X → `hammer_position`, ratio 0–0.5), right-edge WIDTH (drag X → `hammer_width`, meters), peak SHARPNESS (drag Y → `hammer_sharpness`, 0–1); plus precise `NumInput`s (Pos %, Width mm, Sharp 0–1). Emits via `onParamChange(name, value)` in real engine units (dark theme via `useTheme`). Width-meters → on-screen string fraction uses `STRING_DISPLAY_LENGTH_M` (per-pitch `l_main` not exposed to the FE; width still round-trips in real meters — exposing `l_main` would make the drawn width physically exact, flagged follow-up). Pure curve + unit converters (`hammerCurve`, `posPercentToRatio`/`widthMmToMeters`/`clampSharpness`/`widthHandleToMeters`/`applyWheelStep`) exported + unit-tested in `__tests__/HammerStringChart.test.jsx`. **Enhancements (dev-gausscp, 2026-06-15 — user "It is good"):** (1) STYLE matched to the Gauss/excitation chart — `CHART_COLORS` palette (blue `#4285F4` accent), circle symbols, soft area fill, smooth line, dark grid/axis. (2) ZOOM toggle (`ZoomIn` ToggleButton): narrows the x-window to the hammer zone `[center±1.6·halfW]` and renders the string as DISCRETE sample NODES (scatter circles + thin stems + per-node value labels). **EXACT per-node values (dev-gausscp, 2026-06-16):** on zoom the chart fetches `GET /get_hammer_shape/<pitch>` (read-only middleware route — returns the engine's resident `hammer_shape` array + geometry `l_main`/`dx`; see middleware REST_API) and renders the EXACT engine value at each true string node (x = `node_positions[xi]/l_main`; y normalized to a visible peak; the RAW engine value is shown in the label/tooltip). The pure mapper `mapExactNodesToDisplay` (exported + unit-tested) does the conversion. **Graceful fallback:** if the route is unreachable (backend down / pre-load / older build) the view falls back to sampling the analytic curve at `DISCRETE_GRID_POINTS` nodes (the title reads "approx" vs "exact string nodes"). NOTE: at default `array_size` the real hammer is sparse (a few nonzero nodes) — the honest physical shape, not the smoother analytic approximation. `pitch` is threaded `Excitation → ExcitationProperties → HammerStringChart`. (3) MOUSE-WHEEL on the SELECTED handle (clicking a handle or its NumInput sets the selection; selected handle gets a bigger ring + the field an accent outline): wheel adjusts that param with a fine per-notch step (`applyWheelStep`), EMIT-ON-SETTLE (one emit per ~150 ms wheel-rest, mirrors dev-mwfix/dev-excwb) to avoid emit spam |
| `GaussEditor` | `GaussEditor.jsx` | Interactive Gauss curve editor (per-cell mu/sigma/shift/volume edit). Each gauss param-ROW label (`mu`/`sigma`/`shift`/`volume`) renders a BarChart open-workbench button (dev-excwb) targeting the currently-selected chart (fallback chart `0`) → `onOpenWorkbench(level, chart, paramName, value)`. **Copy/paste (dev-gausscp; reverse-flow 2026-06-20):** the 5x4 grid (5 charts × mu/sigma/shift/volume) has a `GaussCopyPasteButtons` column just LEFT of the grid (COPY / PASTE / ALL). **Copy is an ARM → adjust → CAPTURE-ON-NAVIGATION flow** (`copyMode`, owned by `ExcitationProperties`): (1) click COPY → selection mode arms and the **WHOLE TABLE is selected by default** immediately, with a clear cue (dashed outline + tint + "Whole table armed — adjust …, then change pitch or level to copy" banner; COPY button shows pressed/`aria-pressed`); (2) while armed the selection is **freely re-adjustable any number of times** — a click on a CELL, chart-header (= whole COLUMN), param-row label (= whole ROW), or the **top-left-corner whole-table selector** ("ALL", just outside the table) re-sets the live selection (it does NOT capture or exit); (3) the copy is **FINALIZED when the user changes PITCH or LEVEL** — that navigation captures whatever is currently selected, from the SOURCE pitch/level, to the in-app clipboard (`useGaussClipboard`) and exits selection mode. Clicking COPY again while armed CANCELS — disarms AND clears the selection. **Selection visual is armed-only (UX polish):** the copy-selection outlines (row/column dashed highlight + the "ALL" corner + the armed cue/tint) render ONLY while `copyMode` is true; on cancel or finalize the selection is cleared so NO copy-selection visual shows when disarmed. **Source-snapshot guarantee (hardened — paste-no-op fix):** at arm time the SOURCE level's values OBJECT is captured into `copySourceRef.levelValues`; every (re)selection resolves `buildCellsFromSelection` against THAT pinned object — NOT a lazy re-read of the live `values[currentLevel]`. This is load-bearing: the finalize fires on a pitch/LEVEL change, by which point `currentLevel`+`values` have already moved to the DESTINATION, so a lazy re-read could yield EMPTY cells → empty clipboard → `changeParametersOfExcitationBatch` early-returns on `changes.length===0` ("paste does nothing"). `finalizeCopy` also ships only NON-EMPTY cells. So the destination's values can never contaminate (or empty) the copied shape. Selection shape `{kind:'cell'\|'row'\|'col'\|'all',chart?,name?}`. PASTE applies the clipboard to the CURRENT pitch at the current level (existing batch path → `changeParametersOfExcitationBatch`); ALL applies it to EVERY pitch at the current level via `usePreset.pasteExcitationToAllPitches` (one bulk-range emit). Paste/All/renormalize/immediate-write/Level-context unchanged by the reverse-flow. Selection/cell mapping math is the pure, unit-tested `utils/gaussClipboard.js`; the reverse-flow + nav-capture is unit-tested in `__tests__/GaussEditor.copySelMode.test.jsx` + `__tests__/ExcitationProperties.copyNavCapture.test.jsx`. (Superseded the original select-then-COPY flow and the interim one-click-capture flow.) |
| `GaussCopyPasteButtons` | `GaussCopyPasteButtons.jsx` | The COPY / PASTE / ALL icon-button column rendered left of the Gauss 5x4 grid (dev-gausscp). Pure presentational: **COPY is ALWAYS enabled** (it STARTS the selection flow) and reflects the armed state via `aria-pressed` + pressed styling (`copyMode` prop); PASTE/ALL enabled when the clipboard holds something. aria-labelled, tooltipped (`ContentCopy`/`ContentPaste`/`LibraryAdd` icons) |
| `GaussChart` | `GaussChart.jsx` | Chart rendering of a Gaussian excitation curve |
| `GaussDemo` | `GaussDemo.jsx` | Live preview of all 5 Gaussian components |
| `CompositeGaussianChart` | `CompositeGaussianChart.jsx` | Composite view of all Gauss curves at one velocity level |
| `GaussCell` | `GaussCell.jsx` | Single cell in the Gauss parameter grid |
| `VelocitySelector` | `VelocitySelector.jsx` | Selects which of the 6 base velocity levels to edit |
| `PitchesModesMatrix` | `PitchesModesMatrix.jsx` | 2-D heatmap of pitches × modes for feedin/feedback |
| `PitchesModesMatrixCanvas` | `PitchesModesMatrixCanvas.jsx` | Canvas-rendered version of the matrix. **Drag-to-select gesture (dev-mzoom, 2026-06-05):** the area-selection drag (which sets the scoping selection for selection-scoped edits) fires `onSelectRect` ONLY when (a) the tool mode is `Navigate` and (b) the drag spans a REAL rectangle (>1 cell in at least one axis). In Mute/Value/Coefficient mode a drag performs that mode's per-cell action (not a re-selection), and a single-cell click is navigation / a Cell edit — never a scoping selection. A click does NOT clear the selection (`handleMouseDown` no longer calls `onSelectRect(null)`), so a Navigate-set selection PERSISTS and Mute/Value/Coefficient act within it; the selection is replaced only by a fresh multi-cell Navigate drag (or cleared by the pane's reset/unzoom control) |
| `MeasuredMatrix` | `MeasuredMatrix.jsx` | Matrix with measurement overlays |
| `MatrixTools` | `MatrixTools.jsx` | Toolbar for matrix operations (normalise, scale, reset) |
| `BarChart` | `BarChart.jsx` | Thin adapter around `DrawableChart` (2026-04-23, Wave 2 of drawable-chart merge). Preserves the legacy `values`/`startZoom`/`endZoom`/`selectedIndex`/`titles`/`onSelect`/`onChange` API so existing call-sites (`RowEditor`, legacy `Deck`) keep working without API churn, and accepts an optional `variant` prop (`"bar" \| "line"`) forwarded to `DrawableChart`, and an optional `autoScale` prop (dev-mzoom Option P, 2026-06-06, default `true`) forwarded straight to `DrawableChart` so the pane-toolbar auto-scale toggle reaches the matrix/Workbench bars. Drag-paint, wheel-adjust-on-selected, click-select, and dark-theme rendering all live inside `DrawableChart`. Log-scale mode (the old `ScaleType` prop) is no longer supported — it was only used by the dead `Deck` module which is not mounted in the mosaic UI. **Optional DrawableChart pass-throughs (dev-dynwb, 2026-06-14):** forwards `mutedMask` (sliced to the visible `[lo,hi)` window), `paintDisabled`, `clampMin`/`clampMax`, `yMin`/`yMax`, `seriesColor`, `tooltipFormatter`, `toolbar`, `flat*`, `canUndo`/`canRedo`/`onUndo`/`onRedo` — ALL undefined-default so they fall through to DrawableChart's own defaults; existing call-sites (RowEditor workbench/matrix paths) that omit them are byte-identical. Added so the averaged-Sound-Channels view can reuse the workbench's RowEditor→BarChart drawing while keeping its mute/clamp/undo/tooltip feature set. Also forwards `isDynamic` (dev-dynwb, 2026-06-14, user msg 3515) → DrawableChart's distinct dynamic-workbench bar color |
| `DrawableChart` | `DrawableChart/DrawableChart.jsx` | Shared drawable scalar-per-bucket chart (2026-04-21, Wave 1 of drawable-chart merge). Renders `values[]` on a category x-axis as a line or bar curve (chosen by the `variant` prop), supports drag-to-paint with linear gap-fill, wheel-adjust on the selected bucket, click-select, optional Flat/Smooth toolbar, parent-owned undo/redo. Single concern: render + edit + emit the painted vector. Consumers own `values` and history state. **Opt-in `paintDisabled` prop (dev-mzoom, 2026-06-05, default `false`):** when true a mousedown records a no-paint drag so the no-move click still fires `onSelect` (click-select) but does NOT paint/emit a value — used by `SoundChannelsAggregateChart`'s mute mode so a bucket click mutes instead of overwriting. Existing consumers omit it → byte-identical drag-paint. **Controlled `autoScale` prop (dev-mzoom Option P, 2026-06-06, default `true`):** when `true` the y-axis defers to the consumer's `yMin`/`yMax` (undefined → ECharts auto-ranges to the data — the historical "auto-scale" behavior); when `false` the y-axis is FROZEN to a stable `[0, frozen-max]` domain (max captured at the instant `autoScale` flips off, then grown-not-shrunk as data changes) so editing within range never re-rescales the axis. The toggle UI lives in the PANE toolbar (`PianoidTuner.renderToolbarControls`), NOT in-chart — this is the controlled flag it drives; the flag is per-pane-persisted in each pane's settings bucket. Every existing consumer omits it → byte-identical. See `docs/proposals/DRAWABLE_CHART_MERGE.md` for the merge plan. **Dynamic-vs-fixed bar color + bars-fill-field (dev-dynwb, 2026-06-14, user msg 3515):** (c) an opt-in `isDynamic` prop (default `false`) — when no explicit `seriesColor` is given, `isDynamic` selects a DISTINCT theme accent (`theme.palette.secondary.main`) instead of the default (`theme.palette.primary.main`), so the DYNAMIC workbench (the "Workbench" leaf that re-targets) is visually distinguishable from the FIXED per-param panes; an explicit `seriesColor` (e.g. avg-SC) still wins, and omitting both is byte-identical (primary). `PianoidTuner` passes `chartProps={{isDynamic:true}}` to the default-Workbench `RowEditor` and `{{isDynamic:false}}` to the fixed clones. (d) bar series `barMaxWidth` cap REMOVED (was 40px) so bars FILL the plot width responsively, keeping `barCategoryGap:"10%"` as the small inter-bar gap; correct across zoom (category count = visible bucket count) with ruler alignment unchanged (shared `CHART_GRID_PAD`). Pinned by `DrawableChart/__tests__/DrawableChart.dynamicColor.test.jsx` (dynamic≠fixed color; default==fixed; explicit seriesColor wins; barCategoryGap 10% + no barMaxWidth) |
| `VerticalColumn` | `VerticalColumn.jsx` | Vertical bar column component |
| `VerticalColumnChart` | `VerticalColumnChart.jsx` | Multi-column vertical chart |
| `ChartSelector` | `ChartSelector.jsx` | Tabbed selector (Charts / Dynamic / Actions) for chart types from `/graph_names` response |
| `newWindowChart` | `newWindowChart.jsx` | Pop-out window (route `/new-window-chart`) for a standard-mechanism chart: fetches `POST /get_chart_test` and renders its numeric arrays; supports multi-chart layouts, dynamic 2D animation/heatmap, and interactive zoom. Option-building is delegated to the pure `src/utils/chartOption.js` `buildChartOption()` helper (dev-ratiochart, 2026-05-24), which adds an OPT-IN `render_hints` channel (explicit x-axis values, threshold markLine, per-point color+symbol, tooltip metadata) — charts that omit `render_hints` render byte-identical to before. See [CHART_SYSTEM.md — Optional render_hints](../pianoid-middleware/CHART_SYSTEM.md#optional-render_hints--richer-chart-rendering-dev-ratiochart-2026-05-24). **Chart-native audio playback (dev-chartplay, 2026-05-31):** any chart entry whose response carries a non-null `audio_data[i]` renders an inline `AudioPlayer` (play/pause + click-to-seek progress bar with `m:ss` readout) directly above that chart — one independent player per chart entry, so a multi-source `sound_test` response gets a player per source×channel. Decode→play helper lives in `src/utils/audioPlayback.js`. See [CHART_SYSTEM.md — Chart-native audio playback](../pianoid-middleware/CHART_SYSTEM.md#chart-native-audio-playback-dev-chartplay-2026-05-31). **Live-render throttle (dev-fethrottle, 2026-06-24, distortion-fix #4):** the inner `DynamicChart` (animated 2D dynamic charts) drove a full ECharts `setOption` re-render per frame at a 30 FPS default — a meaningful slice of the FE's GPU footprint during play that competes with audio synthesis on the same GPU (system GPU+CPU contention = the audible "all notes bad" distortion, dev-cpinv; worse since the 06-23 multipoint per-channel Sound Test data). Now: (a) default playback rate lowered 30→`DEFAULT_FPS=12`; (b) a hard render-rate CAP — the per-frame `setOption` is gated by the pure `src/utils/chartThrottle.js` `shouldRenderNow(lastRenderTs, now, {maxHz, isLast})` so it fires at most `MAX_RENDER_HZ=15` times/sec REGARDLESS of the FPS dialed in (the terminal frame is always force-rendered so the animation settles on the true last frame; slider scrub bypasses the cap; pause resets the gate). FPS input band tightened 1–120 → `MIN_FPS`–`MAX_FPS` (1–60) with `clampFps`. The heatmap path (static, one render) is untouched. Pure throttle decisions unit-tested in `utils/__tests__/chartThrottle.test.js`; default+bounds wiring in `components/__tests__/newWindowChart.throttle.test.jsx`. **UX tradeoff:** an animated string-shape replay is now ~12 fps by default and visually capped at 15 fps — smoother playback is opt-in via the FPS field |
| `SoundChannelsPane` | `SoundChannelsPane.jsx` | Dual-axis sound channel editor pane (extracted from `PianoidTuner.js`, 2026-04-20 Wave A). Dispatches between two render modes based on `aggregateMode`: **aggregate OFF** → `MeasuredMatrix` (per-channel matrix, axis is `listenToModes`: modes = pitches × channels, coupling into feedin; strings = channels × modes, feedback gain); **aggregate ON** → `SoundChannelsAggregateChart` (single curve, drag-to-edit, dedicated refactor 2026-04-21). Consumes the `useSoundChannels` hook for history/aggregate/fan-out; owns only the render-mode dispatch and display geometry for the matrix path. **Mode-axis zoom (dev-mzoom, 2026-06-05):** the pane consumes the shared `rangeOfModes`/`selectedModes` (from `useCurrentValues`) for the mode-COLUMN axis, so the toolbar zoom-button pair (un-gated for "Sound Channels" in `PianoidTuner.renderToolbarControls`) scales SC columns exactly like Feedin/Feedback. The pitch/CHANNEL ROW axis is deliberately kept full (`pianoRange=[displayNotes[0..last]]`, `selectedPianoRange=null`) — SC strings-axis rows are output channels `0..N-1`, not piano pitches, so the piano-space `rangeOfPitches` would blank them; channel-row zoom is a deferred follow-up (see `WORK_IN_PROGRESS.md`) |
| `SoundChannelsAggregateChart` | `SoundChannelsAggregateChart.jsx` | Thin domain wrapper around `DrawableChart` for the Sound Channels aggregate view (2026-04-23, Wave 3 of drawable-chart merge; previously a 500-LOC standalone editor, now ~170 LOC). Single concern: adapt the aggregate-matrix shape to a flat values-per-bucket vector and translate the painted-vector emit back into an axis-appropriate aggregate-change payload. **Render, drag-paint, Flat, Smooth, undo/redo toolbar, clamp, and dark theme all live in `DrawableChart`.** Data shape handled: **modes axis** → x = pitch (as note name), y = avg coefficient per pitch (hook's `scModesAggMatrix` = `{ pitch: [avg] }`); **strings axis** → x = mode index, y = avg per mode (`scStringsAggMatrix = { averaged: [val_per_mode] }`). Drag emits through `applyAggregateChange` as `pitchesVectorDrawn` (modes axis) or `modesVectorDrawn` (strings axis, with pitch key `"averaged"`); the hook's `fanOutAggregateChangeAxis` expands the delta across the fan-out dimension into one `applyBatchChange` history entry (single undo step per op, same as before). Accepts a `variant` prop (`"line" \| "bar"`) forwarded to `DrawableChart`, driven by `soundChannelSettings.visualization` (default `"line"` per Wave 3, overridable via the Settings gear). Wrapper owns only the pane-level aggregate-toggle (Layers icon) + per-axis caption above the chart; the DrawableChart toolbar (undo/redo + Flat + Smooth + NumInput) renders just below. **Zoom + mute in averaged mode (dev-mzoom, 2026-06-05):** the wrapper accepts a `viewRange` prop (the shared `rangeOfModes` for the strings-axis SC aggregate, x = mode indices) and SLICES the series to that visible window before passing to `DrawableChart` — so the toolbar zoom-in/unzoom buttons clip the aggregate curve like the matrix; a painted edit on a windowed curve is RE-EXPANDED to the full-length `*Drawn` vector (full current values, overwrite the window) before emit, since `fanOutAggregateChangeAxis` consumes a positional full-length vector. A **mute-mode toggle** (VolumeOff icon) in the header: while on, a bucket click emits an aggregate `Mute` change with `zone:"Cell"` (the bucket's pitch [modes axis] or mode [strings axis] fixed) → `fanOutAggregateChangeAxis` broadcasts it to ALL underlying channels/modes, toggling each cell exactly once (Cell zone avoids the per-fan double-toggle a Row/Column zone causes); mute-mode passes `paintDisabled` to `DrawableChart` so the click mutes instead of painting a value. **Ruler↔bar alignment (dev-mwfix, 2026-06-10):** the axis ruler strip below the curve (ModesRule on strings axis / VirtualPiano on modes axis) renders the SAME visible window the chart draws — its `range`/`availableNotes` are derived from the windowed series' absolute axis indices (`indexMap[].mode`/`.pitch`), not the full `[0, totalModes-1]` extent. Previously the ruler showed the full extent while the chart was sliced to the zoom window → ticks didn't line up with the bars (msg 3445). `ModesRule` was also fixed to position keys relative to `safeRange[0]` so a windowed (lo>0) range draws from the canvas left edge. Pinned by `SoundChannelsAggregateChart.rulerAlign.test.jsx` (ruler key-count == chart bucket-count across zoom levels). **Reuses the workbench DRAWING (dev-dynwb, 2026-06-14, user msg 3503):** the STRINGS axis (the only one reachable under H2) now renders its chart + ruler through the SAME `RowEditor` → `BarChart` → `DrawableChart` path the Workbench uses (`matrixRowIsPiano={false}` → ModesRule, x=mode), instead of this wrapper's own `DrawableChart` + hand-rolled `windowSeries`/ruler — so the averaged-SC curve draws IDENTICALLY to a workbench (fixes "the drawing in averaged sound channels works incorrectly while in workbenches all good"). RowEditor/BarChart window INTERNALLY via `range` and splice the painted slice back to full length before `onChange`, so the wrapper feeds the FULL averaged row + a FULL-length `mutedMask` and the emit (`handleDrawFullStrings`) receives a full-length vector (the wrapper-local `windowSeries`/`expandToFull` are no longer used on this path). ★The EMIT stays SEPARATE — still the 1→N fan-out (`onAggregateChange` `zone:"modesVectorDrawn"`, `pitch:"averaged"` → `fanOutAggregateChangeAxis` broadcasts across output channels), NOT a direct row write — and the SC channel-decouple holds (mode axis only; ruler drag → `onSelectModesRange`, never `selectedPitches`). The avg-SC feature set (tri-state mute grey-paint, clamp, undo/redo toolbar, custom tooltip, y-floor, series color) survives via a `chartProps` bag threaded RowEditor→BarChart→DrawableChart. The modes axis (H2-unreachable) keeps the legacy `DrawableChart` + `VirtualPiano` path. Pinned by `SoundChannelsAggregateChart.fanOutDecouple.test.jsx` (painted edit → fan-out modesVectorDrawn/pitch=averaged NOT a direct write; never writes `onSelectPitchesRange`; ModesRule not VirtualPiano; ruler drag → `onSelectModesRange` only) |
| `ParameterEditor` | `ParameterEditor.jsx` | Generic numeric parameter editor |
| `NumInput` | `NumInput/NumInput.js` | Canonical numeric editor (cursor-position step + wheel + opt-in min/max clamp + in-place min/max/decPlaces editing). Defaults to `min=-Infinity / max=+Infinity` so callers that omit the props get truly unbounded input. **Engine-bound parameter editors (Gauss, Mode, String, Hammer, Deck/Sound-Channel coefficients via ToolBar/MatrixTools) deliberately omit `min`/`max` per dev-2706 (Bug A scope expansion, 2026-05-03)** — the backend is the gate; UI does not pre-emptively clamp synthesis parameters. Hard system bounds (MIDI velocity 0–127, sample_rate, audio_buffer_size, calibration timing windows) keep their explicit `min`/`max` because the value range is a protocol/algorithmic constraint, not a UX guess. **Opt-in `integer` prop (dev-bbcb, 2026-05-30, default `false`):** when `integer={true}` the field is whole-number-only — display forces 0 decimal places, the decimal-places button is hidden, and every committed value (Enter / arrows / wheel) is rounded via `Math.round` in the single `handleValueChange` choke point, so a typed/parsed fractional value commits as an integer rather than a float that merely displays rounded. Used by the integer-typed preset-load fields (via `ObjectInspector`'s `PARAMETER_CONFIG`). Existing call-sites that omit the prop are byte-identical to before. Also delegated-to by `ObjectInspector` for every numeric field in every settings popup (dev-f259, 2026-05-01). **Split for C4 (dev-numsplit, 2026-06-01, review R-1):** the pure math — `formatNumber`, `anchorExponentCaret`, `getStepFromCursorPosition`, the once-quadruplicated exponent-step (`computeExponentStep`), `getInputTitle`, `generateUniqueId` — lives in `NumInput/numInputMath.js`; the caret-position machinery (refs + the single `useLayoutEffect` restore + `rememberCursorPosition`/`clearPendingCursorRestore`/`scheduleCursorRestore`/`armCaretForDisplayUpdate`) lives in the `useNumInputCaret` hook. Behaviour and the public prop API are unchanged; `NumInput.js` dropped 1555→995 LOC (RED→YELLOW). Pure helpers are unit-tested in `NumInput/__tests__/numInputMath.test.js`. **Persist-on-blur + optional `commitKey` prop (dev-blur, 2026-06-02):** a VALUE-mode edit now COMMITS on blur (previously it reverted), through the same `commitValue(rawString)` path as Enter — clamp-and-commit on out-of-range (like Enter), no-op if the typed value equals the committed value (skips a spurious debounced write), revert on invalid/empty/partial (`""`, `"-"`, `"."`, `"1e"`). In-place config sub-modes (editing the box's own min/max/step/decPlaces) are NOT auto-committed on blur — persist applies to VALUE mode only. The optional **`commitKey`** prop is the edit-identity guard: snapshot at focus / first keystroke, compared at blur — if the parent's selection moved to a different parameter before the blur fired (key changed), the uncommitted edit REVERTS instead of contaminating the new parameter. **Shared-instance Group-1 callers pass `commitKey`** = the selected-parameter id: `Mode`/`Strings` pass `key`, `GaussCell` passes `` `${level}-${chart}-${name}` ``. (The `ToolBar` selected-param mirror NumInput — the 4th, most complex Group-1 caller — was REMOVED with the field itself by dev-tbmirror, 2026-06-14; it was the redundant toolbar mirror whose persist-on-blur contamination the guard existed to patch.) Single-purpose Group-2 callers (preset-init via `ObjectInspector`, `CollectPanel`, `TimingBandEditor`) omit `commitKey` and always commit on blur. Escape still reverts (sets `isEditing=false` first, so the trailing blur short-circuits — no re-commit). Decision table is Jest-covered in `NumInput/__tests__/numInput.blur.test.jsx` |
| `RowEditor` | `RowEditor.js` | Editable table row for matrix data. Composes `BarChart` (DrawableChart adapter) above a row-axis ruler. Ruler is `ModesRule` on the modes axis; on the pitch/row axis it is `VirtualPiano` by default, or `FlatBarAxis` when `axisVariant="bars"` (dev-mtxfix PART 4, 2026-06-05 — the SC strings axis whose rows are OUTPUT CHANNELS, not piano notes; threaded from `MeasuredMatrix` so the bottom ruler matches the left ruler even after Rotate). Accepts a `variant` prop (`"bar" \| "line"`) forwarded to the underlying chart — driven from the containing panel's `visualization` setting in `useSettings`. **The SC per-channel matrix path forces `variant="bar"`** (SoundChannelsPane overrides `soundChannelSettings.visualization`, whose `"line"` default applies to the aggregate curve only) so the per-channel row-editor renders bars like Feedin/Feedback. Also forwards an `autoScale` prop (dev-mzoom Option P, 2026-06-06, default `true`) to `BarChart`→`DrawableChart`; `MeasuredMatrix` reads it from `settings.autoScale` (per-pane-persisted) so the matrix bars honor the pane-toolbar auto-scale toggle. **Optional `chartProps` bag (dev-dynwb, 2026-06-14, default `{}`):** an extra-DrawableChart-props bag spread onto `BarChart` (which forwards `mutedMask`/`paintDisabled`/`clampMin`/`clampMax`/`yMin`/`yMax`/`seriesColor`/`tooltipFormatter`/`toolbar`/`flat*`/`canUndo`/`canRedo`/`onUndo`/`onRedo`, all undefined-default → DrawableChart's own defaults). Lets the averaged-Sound-Channels view reuse this RowEditor drawing while keeping its richer feature set (tri-state mute grey-paint, clamp, undo/redo toolbar, custom tooltip). Every existing RowEditor call-site (workbench panes) omits it → byte-identical |
| `WorkbenchFunctionTools` | `WorkbenchFunctionTools.jsx` | Workbench range-edit toolbar cluster (dev-mwfix, 2026-06-11; user msg 3453/3454/3458). Operates on the pinned Workbench vector (a pitch's modes OR a mode's pitches), SCOPED to the selected index range (full/none selection ⇒ whole vector). **Extend/Shrink** (Compress/Expand `IconButton`s) geometrically scale the selected range by `scaleStep` (Excitation-style). **Apply-function**: a shape `<Select>` (linear/quadratic/cubic/exponential/logarithmic/power/sigmoid) + a coefficient `<NumInput>` (`k`) + a `Functions` `IconButton` whose root carries a NON-PASSIVE wheel listener — wheeling nudges `k` and re-applies live. ★The function is ANCHORED at the current cell: `out[i] = clamp(V + k·s((i−anchor)/span))` where `V` = the current (selectedPitch/Mode) cell's existing value and every shape has `s(0)=0`, so the anchor cell's value is UNCHANGED (the curve passes through it). For the LINEAR shape the wheel has a **sticky-zero detent** (snaps to/rests at `k=0` = the flat horizontal line; catch window = one full step, 2× wide per user msg 3458). All math is in the pure, unit-tested `utils/curveShapes.js` (`applyAnchoredFunction`/`scaleRange`/`wheelStepCoefficient`; anchor invariance + sticky-zero + scoped covered by `curveShapes.test.js`). Emits the shaped vector via the Workbench's `handleVectorChange` (granular, debounced; values only — mute untouched). Wired into `PianoidTuner.renderToolbarControls` for the Workbench pane + dynamic clones. The uniform-value control was removed (linear+sticky-zero covers the flat case). **Wheel emit-on-settle (dev-excwb traffic fix, 2026-06-11; user msg 3478/3482):** the wheel updates `k` LIVE on every notch (the coefficient field reflects it) but DEBOUNCES the apply/emit to a 150 ms wheel-rest — one emit per gesture, not one full re-apply+emit per notch. Because `applyFn` re-derives from the CURRENT vector with the accumulated `k` (it does not compound across notches until an emit lands), the settled curve equals what a per-notch sweep produced. Combined with the `usePreset` bulk emit, a multi-second wheel sweep now sends ~1 settled bulk message instead of (notches × N) per-pitch messages |
<!-- `CopyPastMenu` (CopyPastMenu.jsx) + `GaussianParameterGrid` (GaussianParameterGrid.jsx/.css) were a
     COMPLETE but DEAD copy/paste implementation (mounted only on the /gauss-demo route, never in the production
     mosaic; built on a non-leveled grid model unrelated to the live GaussEditor). DELETED by dev-gausscp
     (2026-06-15) when the Gauss copy/paste feature was built on the ACTIVE GaussEditor instead — see the
     GaussEditor + GaussCopyPasteButtons rows above. -->
| `Excitation`-area Gauss copy/paste | `GaussCopyPasteButtons.jsx` + `hooks/useGaussClipboard.js` + `utils/gaussClipboard.js` | The COPY/PASTE/ALL affordance for the Gauss 5x4 grid (dev-gausscp, 2026-06-15). `useGaussClipboard` = in-app clipboard state `{ cells: { [chart]: { [name]: value } } }`; `utils/gaussClipboard.js` = pure `buildCellsFromSelection`/`cellsToBatchChanges`/`cellsToExcitationFragment` (unit-tested). See the `GaussEditor` row for the wiring |
| `ToolBar` | `ToolBar.jsx` | Main application toolbar. The `FeedbackSlider` is a TWO-LAYER feedback-coefficient control (dev-fbsl, 2026-06-05): the slider position is a GLOBAL environment multiplier (`8^((pos-64)/63)`, 64 = ×1, persisted to `localStorage` `feedbackSliderPos`, survives preset switches) layered on a PER-PRESET stored baseline; the value label shows the multiplier and the tooltip the effective coefficient. A "Set" fold button (`SaveAsIcon`, disabled at neutral 64) folds the multiplier into the stored baseline value-preservingly and resets the slider to 64 (`usePreset.foldFeedbackIntoPreset`). The effective coefficient scales piano-pitch feedback only (dev-d52b mask). See DATA_FLOWS §2.6. **The redundant selected-parameter "mirror" NumInput was removed (dev-tbmirror, 2026-06-14):** the toolbar used to render a shared NumInput echoing `selectedParameter.value` (a second edit surface for a value every pane already edits in place), which — as a shared persist-on-blur instance reused across parameters — was the contamination surface the dev-blur `commitKey` guard existed to patch. Deleting it removed both the redundancy and that blur failure mode; `selectedParameter`/`onValueChange` are no longer passed to `ToolBar`. The per-pane editors (Mode/Strings/GaussCell/matrix cells) remain the canonical edit surfaces. **MIDI button+indicator (dev-tbmirror, 2026-06-14):** the MIDI icon was moved from the right cluster to next to the Fix-MIDI checkbox and is now a combined button + 3-state indicator — an `IconButton` whose color (from the theme palette via `MIDI_INDICATOR`) reflects `midiIndicator` (`green`=listening, `red`=devices-present-but-not-listening, `grey`=no devices; from `useMidiStatus`) with a state tooltip + `aria-label`; `onClick` (`onMidiClick`) opens the MIDI panel as a popup `Dialog`. The old `midiIsConnected`/`midiKeysDown` toolbar props were dropped. **Toolbar order + preset-name removal (dev-tbmirror, 2026-06-14, user msg 3493):** left→right order is `logo | [load][save] | [library selector][+ add][basket delete] | pitch | mode | level | fix-midi | midi-button | …` (Volume/Feedback/backend/layout/Settings after). The redundant preset-name string (the `{lastPresetFileName}` `Typography`) was removed — the preset name is shown in the library selector — and `onFileNameClick` (its only consumer) is no longer used. The `+` (add-preset, `AddIcon`) now precedes the basket (delete/unload-preset, `DeleteOutlineIcon`). All controls' functions are unchanged. **Responsive overflow (dev-09cf, 2026-06-09):** the toolbar is a single dense `<Toolbar>` ROW with a `flexGrow:1` spacer right-aligning the right cluster; a contained `sx` (`overflowX:auto`/`overflowY:hidden`, `& > * {flexShrink:0}`, thin dark-theme scrollbar) confines overflow to the toolbar so the rightmost controls stay reachable by horizontal scroll at narrow widths (byte-identical when wide). The dev-09cf overflow still applies to the new dev-tbmirror order. |
| `BackendStatusIndicator` | `BackendStatusIndicator.jsx` | Health status badge (healthy/crashed/disconnected) with backend start/stop controls; warning chips for CFL redline, output limiting, and **No CUDA** (dev-cudaguard: `/health.gpu_available===false` → amber "No CUDA" chip = GPU synthesis unavailable, GPU presets disabled; hidden when GPU present, absent, or backend down). APPLY (`ensureBackendAndLoadPreset`) short-circuits with a limited-mode notification when `gpuAvailable===false` (backend also enforces via `/load_preset`→503). |
| `BackendConsole` | `BackendConsole.jsx` | Backend process stdout/stderr console viewer |
| `CalibrationPanel` | `CalibrationPanel.jsx` | Mic-based volume calibration with two tabs (Volume Tuning, Curves). Volume Tuning: 5-level velocity selector (pp/p/mf/f/ff synced with Excitation panel), reference dB, Calibrate Synthesis, Calibrate Acoustic, precision profile. Curves tab mounts `CurveEditor` for the active velocity level. All long-running ops (Calibrate Synthesis, Calibrate Acoustic, Measure Precision) show a shared progress bar via `GET /calibration_status` polling with completion/error indication. When the status payload reports `clipping_pass: true` (Calibrate Synthesis re-running every pitch at a reduced target after clipping detection — see [REST API — GET /calibration_status](../pianoid-middleware/REST_API.md#get-calibration_status)), the progress box labels the rerun "Pass 2/2: clipping correction" with a warning caption + warning-colored bar, so the legitimate `progress` restart is not mistaken for an unexplained loop |
| `CurveEditor` | `CurveEditor.jsx` | Per-level calibration coefficient curve editor for the Curves tab. Renders `{positions, coefficients}` from `GET /calibration_curve?level=<lk>` as an ECharts line chart (88-pitch x-axis). Supports drag-to-paint via low-level ZRender handlers (`mousedown`/`mousemove`/`mouseup`/`globalout`) attached in `onChartReady` — pixel x snaps to nearest pitch via `convertToPixel('grid', [i,0])`, pixel y converts to coefficient via `convertFromPixel('grid', [0,y])` and clamps to `[0.01, 20.0]`. Painted updates accumulate in a `paintedRef` accumulator (pitch_id → value) and commit via 300ms-debounced `POST /calibration_curve` (`mouseup`/`globalout` flush immediately), then re-fetch authoritative state. Toolbar buttons (Flat / Follow / Apply / Revert / Save / Load) use the `/calibration_curve/{flat,follow,apply,revert,save,load}` endpoints. RCM toggle drives reference-point capture mode. Ctrl+click on a reference point removes it via `/calibration_curve/rcm/remove` |
| `TimingBandEditor` | `TimingBandEditor.jsx` | Editable frequency-dependent timing bands (settle, skip, window) for calibration |
| `ModalAdapter` | `modules/ModalAdapter.jsx` | Modal extraction panel with compact toolbar UI. **Toolbar** (left to right): server status chip (On/Off, clickable to start), pipeline section ButtonGroup (Collect / Setup / Tracking / Apply with status indicators — checkmark for done, spinner for running; Collect is the B-3 measurement-collection tab and has no toolbar status indicator since the panel owns its own status chip), and right-aligned play buttons (play current step, skip-to-end, both show stop icon when running; play buttons + settings gear are hidden on Collect — the panel owns its own Start/Cancel and config UI, separate from the ESPRIT pipeline state machine). Setup button shows current project name when a project is open. **Settings gear/lock icon lives in the native MosaicWindow title bar** (not inline in the pane body) — rendered via `ReactDOM.createPortal` into the `.mosaic-window-controls` container from a `useLayoutEffect` hook. The same hook hides the generic `button[title="Settings"]` injected by `PianoidTuner.renderToolbarControls` so exactly one settings gear appears on the title bar. Clicking it toggles the collapsible Collapse/Paper settings panel mounted below the toolbar (only mounted on Setup/Tracking/Apply via the internal `PIPELINE_RUN_SECTIONS` list). **Settings panel** content changes per active section: Setup shows channel roles (MappingEditor) + ESPRIT config (EspritConfig), Tracking shows freq tolerance and max gap, Apply shows merge mode and sound output mapping. **All settings freeze** (disabled + lock icon) once ESPRIT processing starts (running or done). Connects to modal adapter server on port 5001. See [MODAL_ADAPTER_GUIDE](../../guides/MODAL_ADAPTER_GUIDE.md) |
| `CollectionSubpanel` | `modules/panels/CollectionSubpanel.jsx` | **v2 Measurement-collection UI** (replaced the retired v1 `CollectPanel.jsx` + `useMeasurementCollection` at Phase 2b). Scoped to a selected Measurement: top-row `MeasurementSelector` + Unlock-with-warning button (when locked), a pre-flight `SetupTestBanner`, the 5 setup sections in the gear-toggled `CollectionSettingsPanel` (General / AudioDevices / Impulse / Series / CalibrationCriteria — under `modules/panels/collection/`), and a streaming `CollectionLog` below the Start/Cancel control. Phase chip pairs colour with a text label (accessibility). State is split across the v2 hooks (`useMeasurementCatalog` / `useMeasurementSetup` / `useSetupTest` / `useCollectionStatus`); the panel owns only the selected-Measurement id + dialog open-state. Measurement dialogs: `MeasurementsManagementDialog`, `UnlockMeasurementDialog`, `ImportScenariosDialog`, `CreateProjectFromMeasurementDialog`. See the **Measurement collection** hooks section below and [MODAL_COLLECTION.md](../pianoid-middleware/MODAL_COLLECTION.md) for the backend contract |
| `MappingEditor` | `MappingEditor.jsx` | Channel role assignment (force/response/reference/skip) with bridge boundary and pitch offset. Shown in Setup settings panel (gear icon), locked (disabled) when ESPRIT has started. Sound channel mapping is separate — in Apply settings panel |
| `EspritConfig` | `EspritConfig.jsx` | Band preset selector + GPU checkbox + disabled prop for freeze. Advanced toggle reveals per-band table (name, f_min, f_max, order, decimation, exp_factor, model_order, window_length) |
| `ModalResultsView` | `ModalResultsView.jsx` | Stabilization diagram wrapper, collapsible mode chain table, per-mode shape plot, feedin heatmap |
| `StabilizationDiagram` | `StabilizationDiagram.jsx` | ECharts scatter plot of mode chains with stability coloring, unified zoom system (brush-to-zoom + scroll-wheel zoom with cursor-centered log-aware Y axis, single `viewBounds` state, Reset button for any zoom source), chain paths (visible by default), chain visibility filter (Stable/+Semi/All/Unasgn), heatmap color mode (damping/amplitude), bridge boundary markLine with "Bass \| Treble" label, **selected chain info chips** (mean frequency, mean damping, point count per chain, colored by stability), sub-charts for selected chains (Damp/Amp/MAC/Shape/Proj — independent toggles, zoom-synced X-axis). Shape sub-chart phase-aligns scenarios within each chain (dot product sign flip against reference) for consistent visual comparison. Above the Shape sub-chart, a `ToggleButtonGroup` of channel numbers plus an OFF button lets the user pick an optional anchor channel — when an anchor is set, every displayed curve is multiplied by `1/curve[anchor]` so all curves pass through +1 at that channel (with a `|value| < 1e-12` near-zero guard leaving degenerate curves untouched), a dashed vertical markLine marks the anchor, and the Y-axis label becomes `Shape (norm @ Ch<N>)`. When an anchor is active, Y axis is clipped to the 5th–95th percentile of y-values (padded 10%, rounded to nice tick boundaries, always containing +1) so outlier curves with near-zero at the anchor don't stretch the readable range. Default is OFF (raw unphased, auto-range); toggling the Shape sub-chart off resets the anchor to null. Clicking selects all lines crossing the click area (5% Y-range tolerance) and highlights their corresponding points on the main chart (white diamond, orange glow). Full-bridge chains (`bridge="full"`) render with a gap at the boundary. Shows ESPRIT data as unassigned dots even before tracking. Centralized brush lifecycle via generation counter — `handleBrushSelected` starts with an empty-areas echo guard (prevents feedback loops from ECharts's `brushVisual` -> throttled `brushSelect` re-entry) then runs its body in try/finally so the clear dispatch and generation bump always run on real user events; the lifecycle effect owns cursor re-arm (takeGlobalCursor). Orphaned zrender covers — created when `brushselected` fires mid-drag and ECharts's `BrushController.updateCovers([])` skips `group.remove` due to its `_creatingCover !== oldCover` guard — are swept by `forceRemoveOrphanedCovers()` which walks `inst._componentsViews -> brush view -> _brushController` and removes any `group.children()` entry not tracked in `_covers`. Called from the echo path, the finally block, and the lifecycle effect. Accepts `interactionMode` for editing integration |
| `StabilizationToolbar` | `StabilizationToolbar.jsx` | MUI ToggleButtonGroup for chain editing modes (select/addPoint/drawChain/connect/break/dissolve) with undo/redo/save/discard buttons |
| `ObjectInspector` | `ObjectInspector.jsx` | Property-grid renderer for arbitrary settings buckets (one bucket per `<PaneSettingsDialog>` instance). `PARAMETER_CONFIG` declares per-field display name + field type. **Three explicit-config types:** `type:"select"` enums (Build Mode, Cycle Iterations, Audio Driver, Audio Buffer Size, Block Size, Listen Mode, Sound Derivative) render an MUI `<Select>`; `type:"boolean"` fields (the 5 binary preset-load params — Use Simulation, Start Right Away, Audio On, Listen to MIDI, Use CUDA) render an MUI `<Switch size="small">` (dev-toggle-ui, 2026-05-15); other **numeric fields (`typeof value === "number"` OR `PARAMETER_CONFIG[k].type === "number"`) delegate to `<NumInput>`** for cursor-step / wheel / min-max-clamp behavior (dev-f259, 2026-05-01). Strings keep the legacy `<input type="text">` fallback. Branch order in `renderInput` matters — the `type:"boolean"` check runs *before* the numeric check because the binary fields store 0/1 *numbers* and would otherwise be caught as numeric. **The Switch is type-preserving (dev-e9ed, 2026-05-30):** it detects the value's flavour at render time (`typeof value === "boolean"`) and round-trips THAT type — `number` 0/1 fields keep `checked = (value === 1)` and write `1`/`0` (so the `/load_preset` payload contract is unchanged); JS-`boolean` fields keep `checked = (value === true)` and write `true`/`false`. This matters because the **same field name can be a different type in different buckets** — `autoSelect` is a 0/1 number in `modesSettings`/`stringsSettings` but a JS boolean in `virtualPianoSettings`, and `PARAMETER_CONFIG` is keyed globally by field name; the runtime detection keeps each bucket's stored type intact (writes still go via `handleSelectChange`, the verbatim no-`parseFloat` path). **Integer-typed numeric fields (dev-bbcb, 2026-05-30):** the four preset-load fields the `/load_preset` REST schema types as integers — `volume` (MIDI 0–127), `sample_rate` (kHz), `string_iterations`, `number_of_modes` — carry `PARAMETER_CONFIG[k] = {type:"number", integer:true, min, …}` and pass `integer` through to `<NumInput>`, so they render whole-number-only (0 decimal places + round-on-commit, no decimal-places button). `volume` keeps the protocol-hard `min:0/max:127`; the counts/rate carry `min:1` (lower protocol bound) with no `max` (the backend remains the upper gate — the dev-2706 "UI does not pre-emptively clamp engine bounds" rule). **Virtual-keyboard settings (dev-e9ed, 2026-05-30):** the `virtualPianoSettings` bucket gets the same treatment — `playbackMode` is a `type:"select"` `<Select>` (Online/Offline); `velocity` (MIDI 0–127), `playbackSpeedMs` (ms/note, consumer-clamped `min:10/max:2000`) and `minRange` (`min:1`) are integer-only `<NumInput>`s; `showKeyNumbers`/`showRange`/`fixedVelocity` (0/1) + `autoSelect`/`selectedKeyTopPiority` (true/false) are `<Switch>`es; the `colorOf*` fields stay free-form text inputs (CSS color strings — no enumerated palette to offer). The widget→type mapping (every limited-choice field is a Select/Switch, every integer field is integer-only, each bucket's stored type preserved) is pinned by `__tests__/ObjectInspector.test.jsx`. |
| `FileUploader` | `FileUploader.jsx` | File upload widget for preset loading (native OS file picker) |
| `FolderBrowser` | `FolderBrowser.jsx` | Folder picker using native OS dialog via `POST /open_folder_dialog` (on modal adapter server, port 5001). Uses tkinter subprocess for thread safety. |
| `Zoomer` | `Zoomer.jsx` | Zoom control for chart views |
| `TestChart` | `TestChart.jsx` | Test/debug chart component |
| `ModeWaveChart` | `ModeWaveChart.js` | Waveform chart for a single mode |
| `ModesRule` | `ModesRule.js` | Modes ruler/axis component |
| `MatrixTable` | `MatrixTable.js` | Raw HTML table for matrix data |
| `ContinuousPressButton` | `ContinuousPressButton.js` | Button that fires repeatedly while held |
| `PresetPanel` | `PresetPanel/PresetPanel.jsx` | Mosaic pane for preset loading + library management. Sections: a named-startup-config switcher (`PresetConfigBar`), Current Preset, Library, footer Apply (see "Preset Panel" below). The previous monolithic Settings pane was extracted into this dedicated pane (dev-a328, 2026-05-01). Working-copy model (dev-bfe2, 2026-05-18): the Library list renders entry records — a lock icon for read-only `original` entries, an "editable" chip + `source` caption for `working` copies; per-entry Spawn working copy / Promote (working copies only, behind a confirm dialog) / Unload actions |
| `PresetConfigBar` | `PresetPanel/PresetConfigBar.jsx` | Named-startup-configuration switcher row (dev-startup-configs, 2026-05-16). Config-name `<Select>` + Save / Save As / Rename / Delete / Export / Import icon buttons + a reused name-prompt Dialog. Pure controlled component — every mutating action calls a `useSettings` callback. **Mounted inside the Preset-initialization settings dialog** (via `PaneSettingsDialog`'s `headerContent` slot) as of dev-bbcb (2026-05-30) — previously a row at the top of the `PresetPanel` body. See "Named startup configurations" under `useSettings` |
| `PaneWithSettings` | `PaneWithSettings.jsx` | Generic HOC that wraps any pane with a portaled gear icon in the MosaicWindow title bar + a `<PaneSettingsDialog>` bound to one settings bucket. Replaces the monolithic Settings pane / central PropertyManager-routing pattern (dev-a328, 2026-05-01). Accepts a `readOnly` prop (dev-bfe2, 2026-05-18): when true (a read-only `original` preset is active) it renders a lock banner + a pointer-events overlay over the wrapped editor — one chokepoint locks all six parameter-editor panes. The 6 editors (Strings, Modes, Excitation, Feedin, Feedback, Sound Channels) pass `readOnly={activePresetReadOnly}`; Charts / Virtual Piano / Workbench do not (they do not edit preset params). The backend is still the read-only authority (HTTP 409 `preset_read_only`); the overlay is UX |
| `PaneSettingsDialog` | `PaneSettingsDialog.jsx` | MUI Dialog wrapping `<ObjectInspector>` for one settings bucket. Snapshots a fresh `PropertyManager` on open; commits via `setSettings(newProps)` AND closes on Apply (the ObjectInspector's internal Apply button is the canonical commit path — DialogActions are intentionally omitted to avoid duplication). **Optional generic `headerContent` prop (dev-bbcb, 2026-05-30):** a node rendered above the ObjectInspector body inside `DialogContent` (followed by a `<Divider>`). The dialog stays generic — it knows nothing about what the slot contains. `PresetPanel` uses it to host `<PresetConfigBar>` so the named-startup-config Save/Save As/… controls live INSIDE the settings window next to the fields those configs store; every other pane omits it (byte-identical render) |

---

### Play All (keyboard sweep) — `startSweep` / `stopSweep` in `PianoidTuner.js`

The Virtual Piano pane's toolbar "Play All" button (▶ / ■) sweeps every available
pitch in the selected range, one note at a time, at `virtualPianoSettings.playbackSpeedMs`
(default 100 ms/note) and the currently-selected velocity level. Two modes, chosen by
`virtualPianoSettings.playbackMode`:

| Mode | Behaviour | Timing authority |
|---|---|---|
| `online` (default) | Issues **ONE** `POST /play_keyboard {mode:"online", speed_ms_per_note, velocity, pitches}` — the backend schedules every NOTE_ON/NOTE_OFF up-front on a sample-accurate cycle grid (`delay_ms = i·speed_ms`) and returns immediately. **Even spacing.** | Backend engine event queue (`RealTimeEventBuffer`) — **P1 sole owner of note timing**. |
| `offline` | Issues `POST /play_keyboard {mode:"offline", …}` — the backend stops the engine, renders a peak-normalized WAV to `/tmp`, restarts the engine, and returns the WAV **plus** its base64 (`audio_data`). The frontend decodes `audio_data[0]` and **plays it** through a hidden `<audio>` element. | Backend offline render; browser plays the returned WAV. |

**Even-timing rationale (dev-177a, Option A, 2026-05-30).** The online sweep previously
used a browser `setTimeout` chain that fired one `POST /play` per note with `delay_ms=0`;
the backend pinned each note to `getCurrentCycle()+1` at wall-clock **arrival**, so
browser/network jitter produced uneven spacing. Routing the whole sweep through the
existing `/play_keyboard` even-scheduler moves note timing off the browser entirely.
See [REST API — POST /play_keyboard](../pianoid-middleware/REST_API.md#post-play_keyboard).

**Offline playback (dev-8abf, 2026-05-31).** Offline mode previously only rendered the
WAV server-side and logged the (server-FS) `wav_path` — the browser, which cannot reach
that path, played nothing. The fix makes it render-then-**play**: the backend offline
branch now adds an `audio_data` field (base64 of the just-written WAV, same `["<base64
WAV>"]` shape as `/get_chart_test` — see [REST API — POST
/play_keyboard](../pianoid-middleware/REST_API.md#post-play_keyboard)), and `startSweep`
decodes `audio_data[0]` and plays it through a hidden `<audio>` element. The decode→play
idiom (atob → `Uint8Array` → `Blob({type:'audio/wav'})` → object URL → `.play()`, revoke
on `ended`/`error`) was extracted from `components/newWindowChart.jsx` (AudioPlayer) into
the reusable `src/utils/audioPlayback.js` (`base64WavToBlobUrl` / `playBase64Wav`), unit-
tested in `src/utils/__tests__/audioPlayback.test.js`. `wav_path` is still logged for
debug. The backend `audio_data` addition requires a **backend restart** to take effect;
the frontend change hot-reloads.

**On-screen highlight.** Because the browser no longer times the audio, the swept-key
highlight (`sweepingNote` → `VirtualPiano`) is driven by a **visual-only** `setInterval`
walking the same `speed_ms` grid. It is cosmetic — small drift vs the (even) audio is
harmless. (The backend `midi_note_event` Socket.IO stream is **not** usable for this: it
fires only for the unified hardware-MIDI listener, not for `/play_keyboard`-scheduled
events.)

**Stop (■) — both modes (consolidated when dev-177a + dev-8abf merged, 2026-05-31).**
`stopSweep` clears the online visual-highlight `setInterval` (`sweepHighlightRef`) **and**
pauses + revokes the offline `<audio>` blob URL (`sweepAudioRef`). So ■ stops offline
playback immediately (the WAV is a local `<audio>`), but for online it only halts the
highlight + local state — the notes were already scheduled up-front on the backend cycle
grid and there is no flush endpoint (the only backend stop is `stop_playback`, which tears
down the whole engine). The unmount cleanup effect performs the same dual teardown.

**STOP / cancel limitation.** Once an online sweep is scheduled, there is **no
lightweight way to cancel the already-queued audio** — the backend has no flush/clear
endpoint for the event queue (the only stop is `stop_playback()`, which tears down the
whole synthesis engine). So the ■ STOP button halts the **visual highlight** and resets
local sweep state, but the scheduled notes **play to completion**. (Same end-to-end
behaviour class as offline mode, which also runs to completion.) Lifting this would
require a new backend "cancel scheduled events" endpoint — tracked as a possible
follow-up; not done here (frontend-only change).

---

## Custom Hooks

All hooks live in `src/hooks/`.

### `usePreset`

The primary data-management hook. Owns all preset state and provides debounced API calls (300 ms debounce) for every parameter category. A `loadingRef` guard prevents concurrent `loadPreset()` calls — a second call while one is in-flight is silently skipped to avoid destroying the pianoid instance mid-initialization.

**Bulk vector emit (dev-excwb traffic fix, 2026-06-11; user msg 3478/3482).** `changeParametersOfStrings` / `changeParametersOfModes` / `changeParametersOfExcitation` emit ONE bulk `set_parameter` message carrying a whole contiguous range — key `"from<lo>to<hi>"` + a values dict keyed by every pitch/mode in the range — whenever MORE THAN ONE pitch/mode changed in a settle (a Workbench function-apply, drag-paint, extend/shrink, or matrix row/column edit). Previously the debounced inner LOOPED one per-pitch `set_parameter/<pitch>` message per changed pitch, so a whole-vector workbench gesture sent N messages (measured 83 for an 88-pitch gamma sweep; a slow wheel sweep = notches × 83). A **single-pitch** edit keeps the exact prior 1-message path (bare pitch key). The backend already consumes the bulk shape — `parse_range` parses `"from<lo>to<hi>"` and `ParameterManager.update_parameter` loops the pitches reading per-pitch values from the dict (`parameter_manager.py`) — so this is a **pure frontend emit-shape change: no backend edit, no rebuild**. Parity (bulk == old per-pitch state) is pinned by `hooks/__tests__/usePreset.bulkEmit.test.jsx` (multi-pitch→1 range emit with all pitches; single-pitch→bare key; modes→range emit). `feedin`/`feedback`/`sound_channel` already emitted one whole-matrix message and are unchanged. **Deferred follow-up:** the `string` backend path still does N per-pitch GPU uploads inside the single bulk call (modes/deck/gauss already do one) — a backend GPU-batching optimization, not the network flood this fix removed. The amplifier on the wheel itself is fixed in `WorkbenchFunctionTools` (wheel emit-on-settle — see its row above).

**Preset-switch / preset-load SC cache clear.** Both `loadPreset()` and `switchPreset()` call `setSoundChannelData(null)` + `setSoundChannelFeedbackMatrix(null)` before the async refetch. Without this, an in-flight debounced `changeSoundChannelValues` / `changeSoundChannelFeedback` from the outgoing preset can resolve after the refetch and re-merge stale pitch keys via `setSoundChannelData(prev => ({ ...prev, ...newData }))`, leaving orphan coefficients that silenced the new preset in Strings mode.

State managed:
- `availableNotes`, `availableOutputChanels` — MIDI pitches and output channels from loaded preset
- `totalModes` — mode count from feedin matrix dimensions
- `feedInMatrix`, `feedbackMatrix` — pitch-to-mode coupling matrices (pitches 21–108)
- `feedInMuteMap`, `feedbackMuteMap` — zero-filled shadow arrays for muting rows
- `parametersOfStrings` — per-pitch physical parameter dict (tension, string_stiffness, string_damping, string_radius, string_density, etc.)
- `parametersOfModes` — per-mode parameter dict (frequency, decrement)
- `parametersOfExcitation` — merged hammer + Gauss parameters per pitch
- `chartTypes` — `{ graphs: [], actions: [] }` from `/graph_names`
- `volume`, `feedback` — runtime scalar controls
- `libraryPresets` — preset library entry RECORDS (`{ name, kind, source, path }`), not bare names — working-copy model (dev-bfe2, 2026-05-18)
- `activePreset` — active preset name; `activePresetReadOnly` — derived boolean, true when the active entry's `kind !== "working"` (consumed by the editor panes to lock their UI)
- `spawnWorkingCopy(source)` / `promoteWorkingCopy(name)` — POST `/preset/spawn_working_copy` and `/preset/promote`. `switchPreset` calls `getAvailableNotes()` so the keyboard tracks presets with different note ranges. Concurrency: a switch requested while one is in flight is **coalesced** — the latest requested name is stashed in `pendingSwitchRef` and run once the in-flight switch settles (the last request wins, no click is lost). Before dev-preset-bugs (2026-05-23) a second switch was silently dropped, which surfaced as "preset not switched on the first click, need to click again" when a click landed inside the long busy window of a prior switch (e.g. a spawn's auto-switch or `[`/`]` cycling)
- **Pending-write cancellation on switch (dev-preset-bugs #1 round 2, 2026-05-23):** every per-pitch editor edit (strings/modes/excitation/feedin/feedback/sound-channels) schedules a *debounced* `/set_parameter` POST against the **active** preset (50 ms WS / 300 ms REST). `switchPreset` calls `cancelPendingParamWrites()` (which `.cancel()`s every editor debounce ref) BEFORE the `/preset/switch` POST, so an edit made on one preset that is still pending cannot fire after the switch and land on the switched-to preset. This was the *real* working-copy "isolation leak": editing working copy #1, then switching to the original and spawning copy #2 (which auto-switches via `spawnWorkingCopy → switchPreset`), let copy #1's stale debounced write POST onto copy #2. Global runtime writes (volume/feedback) are library-wide and intentionally NOT cancelled. Tradeoff: a last edit made <debounce-window before a switch is dropped (never reaches the prior preset); a future flush-on-switch could persist it to the prior preset instead
- **Record-shape contract for consumers (dev-preset-bugs, 2026-05-23):** any consumer that renders or iterates `libraryPresets` MUST treat each element as a `{ name, kind, source, path }` record — render `entry.name`, key/value on `entry.name`, pass `entry.name` (a string) to `switchPreset`/`spawnWorkingCopy`. `PresetPanel.jsx` and `ToolBar.jsx`'s library `<Select>` and `useHotkeys.cyclePreset` all follow this. Rendering the record object directly throws React's "Objects are not valid as a React child (found: object with keys {kind, name, path, source})"; using the object for a `<Select value>` (vs the string `activePreset`) silently mis-wires the selector; `indexOf`-ing the record array against a name string returns -1

Key methods exposed:

| Method | API endpoint | Description |
|---|---|---|
| `loadPreset(settings)` | POST `/load_preset` | Loads preset, then fetches all matrices |
| `savePreset(name)` | POST `/save_preset` | Saves current preset under given name |
| `getFeedInMatrix()` | GET `/get_parameter/feedin/all` | Refreshes feedin matrix |
| `getFeedbackMatrix()` | GET `/get_parameter/feedback/all` | Refreshes feedback matrix |
| `changeFeedInValues(matrix, pitch)` | POST `/set_parameter/feedin/{pitch}` | Debounced feedin update |
| `changeFeedbackValues(matrix, pitch)` | POST `/set_parameter/feedback/{pitch}` | Debounced feedback update |
| `changeParametersOfStrings(pitches, param, values)` | POST `/set_parameter/string/{pitch}` | Debounced string param update |
| `changeParametersOfModes(modes, param, values)` | POST `/set_parameter/mode/{mode}` | Debounced mode param update |
| `changeParametersOfExcitation(...)` | POST `/set_parameter/excitation/{pitch}` | Debounced excitation update |
| `pasteExcitationToAllPitches(level, cells)` | WS/POST `/set_parameter/excitation/from<lo>to<hi>` | Paste a copied Gauss-cell map (`{[chart]:{[name]:value}}`) onto EVERY pitch at one level (dev-gausscp). One-shot (no debounce): builds the merged state for all pitches + emits ONE bulk-range message (per-pitch multi-cell fragment), reusing the dev-excwb bulk shape. `usePreset` is the sole writer of excitation state |
| `playNote(obj)` | POST `/play` | Triggers a note |
| `playMode(n)` | POST `/play_mode/{n}` | Plays one resonator mode |
| `getChart(request)` | POST `/get_chart` | Fetches chart data with caching |
| `getChartTypes()` | GET `/graph_names` | Fetches available chart types and actions |
| `startTest(params)` | POST `/start_test` | Starts a test run |
| `reset()` | GET `/reset` | Resets the synthesiser |
| `capture()` | POST `/capture` | Captures current audio output |
| `changeVolume(v)` | POST `/set_runtime_parameters` | Sets output volume (0–127) |
| `changeFeedback(v)` | POST `/set_runtime_parameters` | Sets feedback gain (0–127) |

### `useSoundChannels`

Owns all Sound Channels UI state extracted from the former `PianoidTuner.js` god-object (Wave A, 2026-04-20). Lives at `src/hooks/useSoundChannels.js` and backs `SoundChannelsPane.jsx` + the SC Workbench row.

Holds two independent `useMatrixHistory` instances (`scModesHistory`, `scStringsHistory`) — one per axis. `listenToModes` selects the active axis (`modes` = pitches × channels, coupling into feedin; `strings` = output channels × modes, feedback-path gain) and routes `activeHistory` / `activeAggMatrix` / `activeAggMuteMap` accordingly. Init effects re-initialise each history from `soundChannelData` / `soundChannelFeedbackMatrix` whenever the `presetVersion` counter (exposed by `usePreset`, bumped on every backend-state-changing event) changes. Writes are imperative at the user-action site via `applyImperativeChange` / `applyImperativeMuteToggle` / `applyAggregateChange` / `imperativeUndo` / `imperativeRedo` — see the "Frontend State Discipline refactor" subsection below for the architectural rationale.

Aggregate math is axis-parameterised: a single `computeAggregate(matrix, axis)` + `computeAggregateMuteMap(muteMap, axis)` + `fanOutAggregateChangeAxis(change, history, axis, numFanOut)` replaces the modes/strings pair duplicated in the old implementation. For `modes`, aggregate collapses channel columns to a per-pitch average and fan-out broadcasts scalar deltas across channels; for `strings`, aggregate collapses channel rows to a single `averaged` row of per-mode values and fan-out broadcasts across output channels.

**Aggregate render (2026-04-21, dev-sc-averaged-chart; slimmed 2026-04-23, Wave 3 drawable-chart merge).** Aggregate mode no longer reuses the matrix canvas as a collapsed-row/column heatmap. `SoundChannelsPane` routes aggregate-ON rendering to `SoundChannelsAggregateChart`, which is now a ~175-LOC thin domain wrapper around `DrawableChart` (Wave 3 replaced the original 500-LOC standalone zrender/ECharts implementation). The chart emits painted-vector changes (`pitchesVectorDrawn` for modes axis, `modesVectorDrawn` for strings axis) through `applyAggregateChange`; the hook's `fanOutAggregateChangeAxis` then broadcasts the delta across the fan-out dimension into a single `applyBatchChange` history entry. This keeps P1 write authority with the hook (sole writer of `scModesHistory`/`scStringsHistory`) while moving the render/edit/toolbar concern into `DrawableChart`. Pane forwards `soundChannelSettings.visualization` as the `variant` prop so users can switch between line and bar via the Settings gear (default `line`). Per-channel (aggregate OFF) still renders `MeasuredMatrix` unchanged.

**Strings-axis key normalization (2026-04-21, dev-sc-tooltip-rowcol).** Backend `/get_parameter/feedback/output` returns the strings-axis matrix with output-pitch keys in backend convention (`128 + channel_index` → `"128", "129", ...`) while `usePreset.getAvailableNotes` already shifts output channels down by 128 to expose `availableOutputChanels = [0, 1, ..., N-1]` for downstream UI. The strings history, canvas, workbench and MatrixTools zones all index by the shifted frontend index. Without alignment, every lookup in strings axis (`matrixObject[channel]`, `newMatrix[change.pitch]` in `useMatrixHistory.calcChange`) missed — hover tooltip rendered `Value: null`, cell edit was silently no-op'd by the pitch-key guard at `useMatrixHistory.js:62-66`, and row/col bulk edit produced no backend POST either. `useSoundChannels` now strips the 128 offset at `scStringsHistory.init()` (via `normalizeStringsKeys`) and restores it inside the imperative emit helpers before `changeSoundChannelFeedback()` (via `OUTPUT_PITCH_OFFSET` in `emitOneStringsRow`), so the history/canvas/workbench stay oblivious to the backend convention while the network payload still uses `"128".."128+N-1"` keys that `backendserver.parse_range` expects. Modes axis is untouched — its pitch-key convention already aligns with `availableNotes`.

**Frontend State Discipline refactor (2026-04-30, dev-833f Phase C2).** The SC editor is the **reference implementation** of three architectural principles (see `docs/architecture/SYSTEM_OVERVIEW.md` "Frontend ↔ Backend State Discipline" and the `project_frontend_state_principles.md` user-directive memory):

  1. **Single source of truth = backend.** Re-init fires on every backend-state-changing event. `usePreset` exposes a `presetVersion` counter that increments on `loadPreset` (APPLY), `switchPreset`, and `unloadPreset`. The init `useEffect`s in `useSoundChannels.js` depend on `[soundChannelData / soundChannelFeedbackMatrix, presetVersion]` and unconditionally re-init on every bump (the previous `!matrix && scDataRefresh` guard from the pre-C2 architecture is gone, along with the `scDataRefresh` boolean itself). Local history is rebuilt from fresh backend data; stale values can't survive an APPLY.

  2. **Granular per-pitch writes.** A user "Change Matrix Cell" or "Change Matrix Row" emits ONE per-pitch POST (`/set_parameter/feedback/<pitch>` for strings axis, `/set_parameter/sound_channel/<pitch>` for modes axis). "Change Whole Matrix" emits N per-pitch POSTs in sequence — never one bulk `/feedback/output` call. The `emitOneStringsRow` / `emitOneModesPitch` helpers route a single (pitchID, row) pair through the existing `usePreset` debounce machinery.

  3. **Imperative emits at the user-action site.** The previous "watch `mutedMatrix`, POST on every change" `useEffect`s at lines 288-293 and 304-309 are removed. Writes now happen inside `applyImperativeChange` / `applyImperativeMuteToggle` / `applyAggregateChange` / `imperativeUndo` / `imperativeRedo`, all of which are called directly from `SoundChannelsPane`'s click handlers. State changes alone never emit. This eliminates the H3 anti-pattern: state surviving across APPLY then auto-emitting because the useEffect couldn't tell "user just changed" from "state was reloaded".

The H3 silence-bug history: a user "Change Matrix Row, Value=200" on Belarus dropped audio to ~50%; clicking APPLY restored backend state but left the frontend's history with the corrupt row; the next UI interaction re-emitted that stale row, undoing the restoration. Only an `npm run dev` restart fixed it because page reload nulled the local history, forcing init from a fresh GET. The Phase C2 refactor closes this loop. See `tests/system/test_sound_channels_silence_regression.py` for the engine-side contract guard.

**Other matrix-style editors** (deck Feedin/Feedback, Strings, Modes, Excitation panels in `PianoidTuner.js`) still use the speculative-emit pattern this refactor removed. Tracked as deferred tech debt — see `docs/development/WORK_IN_PROGRESS.md`.

Exposes: `scModesHistory`, `scStringsHistory`, `scModesAggMatrix`, `scStringsAggMatrix` (workbench reads both), `axis`, `activeHistory`, `activeAggMatrix`, `activeAggMuteMap`, `scNumChannels`, `handleAggregateToggle(enabled)`, `applyAggregateChange(change)`, `applyImperativeChange(change)`, `applyImperativeMuteToggle(newMuteMap)`, `imperativeUndo()`, `imperativeRedo()`.

### `useBackendHealth`

Polls `GET /health` every 30 seconds (2-second timeout). Initial state is `disconnected` (not `checking`). Timeout/connection-refused both map to `disconnected`; only HTTP error responses map to `crashed`. Tracks `healthStatus` with fields: `status` (healthy/not_started/crashed/disconnected/checking), `pianoidLoaded`, `running`, `cppModuleResponsive`, `exception`, `listenMode`, `availableNotesCount`, `consecutiveFailures`.

Exposes: `manualHealthCheck()`, `attemptReconnection()`, `toggleLivePlayback()`.

Preset loading uses `ensureBackendAndLoadPreset()` in `PianoidTuner.js`. On every call it performs a **fresh HTTP probe** to `:5000/health` (never trusts stale React state). Decision matrix:

| `:5000` responds | Launcher owns process | Action |
|---|---|---|
| yes | yes | Load preset directly |
| yes | no | **Stale server** — `killStale()`, then start fresh |
| no | yes | Backend unresponsive — `stopBackend()`, then restart |
| no | no | `startBackend()`, poll until responsive (30 s), then load |

The Apply button (`handleApplySettings`, Preset case) sets `presetLoadSettings` state; a `useEffect` is the sole trigger for `ensureBackendAndLoadPreset` to avoid double-fire.

A `beforeunload` handler in `PianoidTuner.js` sends `POST /api/stop-backend` (with `keepalive: true`) when the browser tab is closed, preventing stale backend processes. Health status is automatically refreshed (`manualHealthCheck()`) whenever a preset load completes (`isBusy` transitions from true to false).

### `useMidi`

MIDI state for the visual piano and pitch auto-select. Since W4 Phase 3 the
backend MIDI listener owns inbound MIDI hardware (`listen_to_midi=1` defaults
the listener on at preset load); the hook subscribes to the backend's
`midi_note_event` Socket.IO stream — passed in as `useMidi(playNote, { socketOn })`
— and populates the same state shape so the consumers in `PianoidTuner.js`
(virtual-piano highlight, pitch auto-select, toolbar status pill) keep working
unchanged. The Web MIDI path is retained behind a feature flag
(`ENABLE_WEB_MIDI`, default `false`).

Exposes: `midiIsConnected`, `midiLog`, `midiKeysDown`, `midiLastKeyDown`, `midiLastKeyUp`, `midiReconnect()`, `midiClearLog()`.

The hook does **not** play notes itself — note playback for the on-screen
keyboard and space-bar runs through `usePreset.playNote` (see [REST API
— POST /play](../pianoid-middleware/REST_API.md#post-play)); the backend
listener and the UI play path coexist because both schedule through the engine's
thread-safe `RealTimeEventBuffer`. The `playNote` callback is still threaded in
for the feature-flagged Web MIDI path.

### `useMidiStatus`

MIDI status poller for the toolbar MIDI indicator (dev-tbmirror, 2026-06-14).
Polls `GET /midi/ports` (`{ ports, active_port, listening }` — the authoritative,
stateless device+listener source; see [REST API — GET /midi/ports](../pianoid-middleware/REST_API.md#get-midiports))
on mount, on a 4 s interval, and on `presetVersion` bump, and derives the
toolbar's 3-state `indicator`: `grey` (no devices = `ports.length === 0`),
`green` (devices && `listening`), `red` (devices && !`listening`). The pure
`deriveMidiIndicator({ devicesAvailable, listening })` helper is exported and
unit-tested (`__tests__/useMidiStatus.test.jsx`). This is a *separate* source
from `useMidi.midiIsConnected` (a 2-state "a `midi_note_event` has arrived since
load" flag, which does **not** reflect device availability or listener state).
Exposes: `ports`, `devicesAvailable`, `listening`, `reachable`, `indicator`,
`refresh()`.

### `useSettings`

Manages all UI configuration state, persisted to `localStorage`. Parameter categories with their own state objects:

| State | localStorage key | Contents |
|---|---|---|
| `presetLoadSettings` | `presetLoadSettings` | Path, volume, sample_rate, string_iterations, number_of_modes, use_cuda, audio_driver_type (ASIO=1, SDL=2, ASIO_CALLBACK=4), audio_buffer_size, cycle_iterations, array_size (384/512), debug_mode (0=release, 1=debug build + extraction), listen_to_modes (0=strings, 1=modes). **This is the LIVE/active startup-configuration bucket** — kept equal to the active entry of `presetLoadConfigs` (see "Named startup configurations" below) |
| `presetLoadConfigs` | `presetLoadConfigs` | `{ name -> settingsObject }` map of all named startup configurations |
| `activePresetLoadConfig` | `activePresetLoadConfig` | Name of the currently selected startup configuration |
| `virtualPianoSettings` | `virtualPianoSettings` | Key colours (`colorOf*`), `velocity`, `minRange`, display toggles (`showKeyNumbers`/`showRange`/`fixedVelocity`/`autoSelect`/`selectedKeyTopPiority`), and Play-All `playbackMode` (online/offline) + `playbackSpeedMs`. Rendered in the Virtual Piano pane gear (`<PaneWithSettings>` → `<ObjectInspector>`): see the ObjectInspector entry for the per-field widget classification (dev-e9ed, 2026-05-30) |
| `modesSettings` | `modesSettings` | Auto-select, decimal places, `visualization` (bar/line) |
| `stringsSettings` | `stringsSettings` | Auto-select, decimal places, `visualization` (bar/line) |
| `chartSelectorSettings` | `chartSelectorSettings` | Show all parameters toggle |
| `feedInSettings` | `feedInSettings` | Piano height, modes width, `visualization` (bar/line), `autoScale` (bar-chart y-axis auto-range on/off; default ON, dev-mzoom Option P) |
| `feedbackSettings` | `feedbackSettings` | Piano height, modes width, `visualization` (bar/line), `autoScale` (bar y-axis auto-range; default ON) |
| `soundChannelSettings` | `soundChannelSettings` | Piano height, modes width, aggregate mode, `visualization` (bar/line; **default `line`** per Wave 3 of drawable-chart merge — aggregate view reads smoother as a line), `autoScale` (bar y-axis auto-range; default ON — applies to both the aggregate curve and the per-channel matrix bars) |
| `workbenchSettings` | `workbenchSettings` | `visualization` (bar/line) — governs both the default Workbench pane and every dynamic workbench clone — plus `autoScale` (bar y-axis auto-range; default ON) plus `placement` (PER-TYPE: `{fixed, panelFollowing, globalDynamic}`, each screen-bottom/panel-bottom; defaults panel-bottom/panel-bottom/screen-bottom) — where each workbench type docks when spawned; edited in the global ⚙ dialog; see "Workbench types" under Mosaic Window Management |
| `excitationSettings` | `excitationSettings` | `stretchStep` (positive float, default `1.2`) — multiplier applied per click of the four Excitation pane stretch/shrink toolbar buttons. See "Excitation stretch/shrink toolbar" below |

Includes `migratePresetSettings()` which renames old parameter keys (`user_1` → `audio_driver_type`, `user_3` → `audio_buffer_size`) in-place in localStorage on first load. `loadSetting()` merges stored values on top of current defaults (`{ ...prev, ...parsed }`) so that new fields added to a settings object — such as `visualization` in Wave 2 of the drawable-chart merge — are present even for users whose localStorage predates the field.

**Visualization setting (Wave 2 of drawable-chart merge).** Each panel listed above that renders a drawable chart carries a `visualization` key (`"bar" \| "line"`, default `"bar"`). `ObjectInspector` renders it as a Bar/Line MUI Select via a `PARAMETER_CONFIG` entry. Consumers forward the setting as the `variant` prop to `DrawableChart`: `MeasuredMatrix` reads `settings.visualization` from the containing panel (Feedin/Feedback/Sound Channels), and `PianoidTuner.renderWindowContent` reads `workbenchSettings.visualization` for the Workbench default + dynamic panes. Toggle lives in the per-pane settings gear only, not in the MosaicWindow title bar (user decision Q3 in `docs/proposals/DRAWABLE_CHART_MERGE.md`).

**Per-pane dialog routing (dev-a328, 2026-05-01).** Pre-refactor, `useSettings` held a transient `propertyManager` (a single `PropertyManager` instance) and an `applySettingsChanges(currentPropertyManagerName)` dispatcher. The legacy Settings pane displayed `<ObjectInspector>` against the active PropertyManager and routed Apply through this dispatcher to the matching bucket setter. Phase 3 of the dev-a328 refactor removed both — every pane now wraps its content in `<PaneWithSettings>` which owns its own dialog state via `usePaneSettingsDialog` and calls the bucket setter directly on Apply (no central router). `useSettings` is now purely a typed-bucket store with localStorage persistence; its return value no longer includes `propertyManager`, `setPropertyManager`, or `applySettingsChanges`.

**Excitation `stretchStep` bucket (dev-39c7, 2026-05-01).** `excitationSettings` was added with one field — `stretchStep` (default `1.2`) — to back the four toolbar stretch/shrink buttons (see below). The Excitation pane's `<PaneWithSettings>` is now bound to this bucket directly; the dev-a328 Phase 3 transitional binding to `stringsSettings` is gone. As a side-effect the dead `stringsNumInputSettings` destructure in `PianoidTuner.js` was dropped (it was undefined at runtime); the Strings pane consumer at the same call-site was repointed to the canonical `stringsSettings` bucket.

### Named startup configurations (dev-startup-configs, 2026-05-16)

The startup (preset-loading) configuration — the 17 fields of `presetLoadSettings` — can be kept as **multiple named configurations** the user switches between, with JSON export/import. The data model and pure transforms live in `src/hooks/presetConfigStore.js`; the stateful layer is part of `useSettings` (P1: `useSettings` is the sole writer of `presetLoadSettings` and its localStorage namespace, so the named-config map is a sibling concern, not a new hook racing on the same data).

**Storage shape (3 localStorage keys):**

- `presetLoadSettings` — the **live/active** bucket. Unchanged by this feature: every existing consumer and the `_applyTs` Apply contract keep working. It is kept equal to the active named config.
- `presetLoadConfigs` — `{ name -> settingsObject }` map of all named configs.
- `activePresetLoadConfig` — name of the currently selected config.

**Migration (single bucket → named config).** On first run of the named-config code, `presetConfigStore.loadConfigs` seeds `presetLoadConfigs` as `{ "Default": <current presetLoadSettings> }` and sets `activePresetLoadConfig = "Default"`. An existing single-bucket user transparently gets one named config "Default"; the seed is idempotent (only runs when `presetLoadConfigs` is absent). A corrupt or empty stored map is fail-soft re-seeded rather than throwing — startup is never blocked by bad localStorage.

**Live-bucket ↔ active-config sync.** The `presetLoadSettings` persist `useEffect` writes the live bucket to its localStorage key AND mirrors it into `presetLoadConfigs[activePresetLoadConfig]`, then persists the map. So editing the gear dialog (or picking a preset file) updates the named config the user is on — there is no separate "dirty/unsaved" state for the active config (consistent with the entrenched auto-persist behaviour of `presetLoadSettings`). The mirror inherits the original `path === ""` early-return: a config with no preset path yet does not mirror (it carries no engine state); `saveConfigAs` snapshots the live bucket directly, so explicit saves work regardless.

**Actions (exposed by `useSettings`, all sole mutators of the maps — P1):** `saveActiveConfig()` (overwrite the active config now), `saveConfigAs(name)`, `switchConfig(name)`, `deleteConfig(name)`, `renameConfig(old, new)`, `exportConfigs()` → JSON string, `importConfigs(jsonText)` → `{ ok, error?, count }`. `switchConfig` makes the target config the live bucket but does **not** inject `_applyTs` — switching selects a config; the user clicks Apply to re-initialise the engine (same as editing the gear dialog — no surprise engine reload on a Select change). `deleteConfig` refuses to remove the last config and falls back to a remaining one when the active config is deleted.

**Export / import.** Export serialises ALL named configs into one downloadable bundle — `{ kind: "pianoid-preset-configs", version: 1, activeConfig, configs }` — via a plain browser Blob + object-URL + transient anchor download (no server round-trip). Import reads a chosen file with `FileReader` and hands the text to `importConfigs`, which validates the shape (`parseImportBundle` — accepts the full bundle or a bare `{ name -> settings }` map; rejects non-JSON, arrays, primitives, wrong `kind`, non-object configs, empty collections) **before** touching live state. A malformed file is rejected with a clear message and never corrupts the live config map; valid configs are merged into the existing map (incoming names overwrite same-named entries).

**UI.** `<PresetConfigBar>` renders a config-name `<Select>` + Save / Save As / Rename / Delete / Export / Import icon buttons + a reused name-prompt Dialog (Save As + Rename, with inline duplicate/empty validation) + a transient feedback caption. It is a pure controlled component — every mutating action calls a `useSettings` callback threaded through `PresetPanel` and `PianoidTuner.js`. Since dev-bbcb (2026-05-30) it is rendered **inside the Preset-initialization settings dialog** (`PaneSettingsDialog`'s `headerContent` slot), so the Save-Configuration controls sit next to the initialization-parameter fields they store; before that it was Section 0 at the top of the PresetPanel body.

### Excitation stretch/shrink toolbar (dev-39c7 2026-05-01; level-scoped revision dev-f7f1 2026-05-03)

The Excitation pane's toolbar exposes four `IconButton`s — Shrink/Stretch × Horizontal/Vertical — backed by a single multiplier `k = excitationSettings.stretchStep` (positive float, default `1.2`). Each click is one discrete history step.

**Scope (revised dev-f7f1 2026-05-03).** Each click affects ONLY the 5 charts at the **currently-selected velocity level** (read from the toolbar's `Level` `ToggleButtonGroup`/combobox via the `level` prop). The pre-2026-05-03 contract was "broadcast across all 25 (level, chart) cells" — user feedback (Telegram, 2026-05-03) revised the intent: cross-level scaling was perceived as state leakage, not a feature. To affect a different level the user first selects it via the level selector. Other levels are untouched — granular-writes principle (P2 in `project_frontend_state_principles.md`) is preserved at the wire shape: only records for the selected level reach the backend payload.

| Button | Tooltip | Effect on the 5 charts at `currentLevelKey` | Records emitted per click |
|---|---|---|---|
| Stretch vertical | `Stretch vertically at current level (volume × stretchStep)` | `volume_new = volume_anchor · k` per chart | 5 (one per chart) |
| Shrink vertical | `Shrink vertically at current level (volume ÷ stretchStep)` | `volume_new = volume_anchor / k` per chart | 5 |
| Stretch horizontal | `Stretch horizontally at current level (mu and sigma × stretchStep)` | `mu_new = mu_anchor · k` AND `sigma_new = sigma_anchor · k` per chart | **10** (mu + sigma per chart) |
| Shrink horizontal | `Shrink horizontally at current level (mu and sigma ÷ stretchStep)` | `mu_new = mu_anchor / k` AND `sigma_new = sigma_anchor / k` per chart | 10 |

**Bug-C cleanup (dev-f7f1 2026-05-03).** Pre-2026-05-03 the `GAUSS_LEVEL_KEYS` constant in `Excitation.jsx` was `["0", "31", "63", "95", "127"]`. Level "0" is the silent-floor row of the 128-level interpolation table — its volumes are always zero. The pp anchor is level "5" (per the `levels` prop default `{pp: {5: "pianissimo"}}`). The constant has been corrected to `["5", "31", "63", "95", "127"]`. Even though the level-scoped revision above no longer iterates the constant in `applyScaleStep` (it uses `currentLevelKey` directly from the symbolic `level` prop), the array is kept as the canonical 5-anchor reference for any future code that needs to enumerate the velocity-level anchors. Pre-fix this constant caused the (now-removed) cross-level broadcast to silent-skip pp; post-fix the constant is correct and the broadcast is gone, so the bug-C symptom is doubly fixed.

**Why horizontal scales BOTH `mu` and `sigma`.** A Gauss curve `f(t) = volume · exp(−(t − μ)² / (2σ²))` scales horizontally around `t = 0` by factor `k` iff `μ` AND `σ` both scale by `k` simultaneously: `μ` shifts the centre away from the origin, `σ` morphs the width proportionally. Scaling `μ` alone slides the bump along the t-axis but preserves its width — that is not what "stretch horizontally" means visually. The button must scale both fields together to produce a uniform t-axis stretch.

**Implementation path.** `Excitation.jsx` declares `applyScaleStep(paramNames[], factor)` which iterates over `GAUSS_CHART_KEYS = 5 charts` at `currentLevelKey`, multiplies the current value of each (chart, paramName) cell by `factor`, and emits the resulting flat list through `onBatchGaussChange`. Vertical handlers pass `paramNames = ["volume"]`, horizontal handlers pass `paramNames = ["mu", "sigma"]`. The downstream `usePreset.changeParametersOfExcitationBatch` merges multi-parameter records targeting the same cell, so a 10-record horizontal-stretch batch produces a payload with both `mu` and `sigma` updated per chart at the current level — one debounced `POST /set_parameter/excitation/{pitch}` per click.

**State discipline.** `usePreset` is the sole writer of Gauss state. `excitationSettings` is owned by `useSettings`. The four click handlers are stateless — they READ `settings.stretchStep` + `values` and emit one batch via the existing `onBatchGaussChange` prop. No mirror state, no useEffect watcher, no anchor refs (the previous slider implementation needed `mousedown`-time anchors because the slider held continuous interim state during a drag; a single click does not).

**`stretchStep` editing.** Click the Excitation pane's gear icon (rendered into the MosaicWindow title bar by `usePaneSettingsDialog`) to open the `<PaneSettingsDialog>` for `excitationSettings`. The single field renders as a `<NumInput>` labelled "Stretch / Shrink Step" (via a `PARAMETER_CONFIG.stretchStep.displayName` entry + the numeric-delegation rule in `ObjectInspector.jsx`); the user commits a new value with Enter / wheel scroll / arrow buttons. Apply commits via `setExcitationSettings`, persists to `localStorage.excitationSettings`, and the next button click reads the new factor. The Excitation handler guards against non-positive or non-finite values with a fallback to the module-level `DEFAULT_STRETCH_STEP = 1.2` constant.

**Mouse-wheel affordance (dev-529b, 2026-05-02; lives on `feature/excitation-buttons-wheel-control` — not yet on `dev`).** Each of the four buttons also responds to the mouse wheel while the cursor is hovering over it — one notch maps to one full click of the equivalent button:

- Wheel **up** on EITHER vertical button (stretch-vertical OR shrink-vertical) → `volume × k` (stretch) at current level. Wheel **down** → `volume ÷ k` (shrink) at current level. Both buttons in the pair share the same up=stretch / down=shrink mapping.
- Wheel **up** on EITHER horizontal button → `mu × k` AND `sigma × k` at current level. Wheel **down** → `mu ÷ k` AND `sigma ÷ k` at current level.

Implementation: a small `useAxisWheel(onUp, onDown)` hook in `MatrixTools.jsx` returns a ref that attaches a **native** `wheel` listener via `addEventListener('wheel', handler, { passive: false })` on the IconButton's DOM root inside a `useEffect`. The non-passive flag is load-bearing: React 18 attaches its synthetic `onWheel` listener as PASSIVE at the React root, so calling `e.preventDefault()` on the synthetic event is silently ignored (and in dev emits the "Unable to preventDefault inside passive event listener" warning). The native non-passive listener is the only path that actually suppresses page-scroll while the cursor sits on a button. Page-scroll outside the four buttons is unaffected. The handler routes to the same `onStretchVertical / onShrinkVertical / onStretchHorizontal / onShrinkHorizontal` props the buttons already use — no duplicate scaling logic — so all behaviours documented above (level-scoping at `currentLevelKey`, `stretchStep` factor, history coalescing, debounced batch emission) apply identically to wheel events. **Note:** when dev-529b's branch rebases onto the post-dev-f7f1 `dev`, the wheel handlers automatically inherit level-scoping because they invoke the same `applyScaleStep` shared by the click handlers — no separate change to wheel code is required.

By-design caveat: rapid same-axis wheeling within the 300ms `usePreset` debounce window collapses to one batch (each handler reads the same React-state `values` snapshot, so the last wheel event's batch overwrites earlier debounced API calls before they flush). Cross-window wheeling compounds correctly because the React state has updated between debounce windows. Normal user behaviour (one notch at a time) is unaffected.

### Excitation Workbench (dev-excwb, 2026-06-11)

Every Excitation panel parameter can open a **Workbench** to edit that parameter ACROSS PITCHES — the per-pitch analogue of how a Strings parameter sweeps across pitches and a Modes parameter across modes. This reuses the SHARED Workbench mechanism (default-pane pin via `updateDefaultWorkbench`, dynamic spawn via `handleOpenWorkbench`, vector read via `computeWorkbenchValues`, vector emit via `handleVectorChange`) — no parallel implementation — so the dev-mwfix Workbench toolbar cluster (`WorkbenchFunctionTools`: apply-anchored-function + extend/shrink) works on Excitation workbenches for free.

**The affordance.** Each parameter row carries a `@mui/icons-material/BarChart` `IconButton` (matching Strings/Modes). `Excitation.jsx` threads a single `onOpenWorkbench` prop down to `ExcitationProperties` (3 hammer rows) and `GaussEditor` (4 gauss param rows). Clicking it spawns a dynamic Workbench pane (`Workbench:Excitation.<name>[-<chart>]:<counter>`); the row's existing `onActivate` separately pins the DEFAULT Workbench. Both bubble to `PianoidTuner`'s Excitation render case which builds the `{groupe:"Excitation", name, gaussIndex?, levelValue?, levelCaption?, value}` param.

**Two storage shapes — same vector axis (HIGH-STAKES "stored vs effective").** Excitation params split by storage even though both sweep per-pitch:

| Kind | Params | Storage | `onOpenWorkbench` args | `pitchesVectorDrawn` write |
|------|--------|---------|------------------------|-----------------------------|
| HAMMER | `hammer_width`, `hammer_sharpness`, `hammer_position` | flat `values[pitch][param]` | `(name, null, null, null, value)` | flat `newValues[pitch][param]` |
| GAUSS | `mu`, `sigma`, `shift`, `volume` | nested `values[pitch][level][chart][param]` | `(name, levelValue, levelCaption, gaussIndex, value)` | nested `newValues[pitch][level][chart][param]` |

A gauss-param Workbench sweeps a param at a FIXED `(level, chart)` across all pitches (e.g. "`mu` of chart 2 at the mf level, over every pitch"). `useValuesHistory.calcChange`'s `pitchesVectorDrawn` zone branches on whether `change.level`+`change.chart` are present → nested write for gauss, flat write for hammer. (Before dev-excwb the zone ALWAYS did a flat write, which silently created `values[pitch].mu` instead of touching the nested cell — a latent gauss-Workbench corruption.)

**Emit path (P1 authority).** `handleVectorChange`'s Excitation branch writes the painted vector into `excitationHistory` (the sole owner of the excitation editor state) — NOT `stringsHistory` (a copy-paste bug from the Strings branch, fixed in dev-excwb). The existing excitation→backend sync effect then diffs `excitationHistory.values` vs `parametersOfExcitation` and POSTs per pitch via `changeParametersOfExcitation` / `changeParametersOfExcitationBatch` — the SAME path a Cell edit already uses, so no new write authority is introduced. Pinned by `hooks/__tests__/useValuesHistory.gaussVector.test.jsx` (flat-vs-nested write + undo) and `components/__tests__/ExcitationWorkbench.openAffordance.test.jsx` (BarChart affordance fires for hammer + gauss with the right args).

### Workbench pane title (dev-dynwb, 2026-06-14, user msg 3512)

Every workbench pane's MosaicWindow title shows the **parameter it is editing**, with the word "Workbench" dropped — the DYNAMIC pane's title updates live as it re-targets (its `wb` is `workbenches["Workbench"]`, which changes on every param activate), each FIXED pane shows its pinned param. The descriptor is built by the pure `src/utils/workbenchTitle.js` `workbenchPaneTitle(wb)`: `"<groupe> · <name>[-<gaussIndex+1>][ (<levelCaption>)]"` (e.g. `"Strings · gamma"`, `"Excitation · mu-2 (fortissimo)"`, `"Modes · frequency"`), with NO `"Workbench — Piano./Modes. "` prefix. `gaussIndex` is stored 0-based and shown 1-based (chart `0` shows no `-N` suffix — preserved truthy-check behaviour). `PianoidTuner.renderTile`'s `title` collapsed its two duplicated workbench branches to one (`isWorkbench(id) ? workbenchPaneTitle(workbenches[id]) : id`). ★Non-empty fallback: a fresh dynamic pane with no param pinned yet returns the literal `"Workbench"` — mosaic panes must never have an empty title. Pinned by `src/utils/__tests__/workbenchPaneTitle.test.js` (descriptor shape + no "Workbench" word for a pinned param + non-empty fallback when unpinned).

### Workbench types — fixed / global-dynamic / panel-specific-dynamic (dev-wbspawn, 2026-06-20)

There are THREE kinds of workbench, all backed by the same `workbenches` map in `useCurrentValues` (`id → {parameter, matrixRowIsPiano, kind?, scopeGroupe?}`):

1. **FIXED** (`kind` absent) — bound to ONE target parameter forever; survives config switch via the orphan fix (gone prune + spawn auto-snapshot). Invoked from the **per-parameter-row BarChart icon** on the ROW-BASED panels (Strings/Modes/Excitation) — multiple per panel, one per param row. Unchanged by this feature.
2. **GLOBAL DYNAMIC** — the single always-present default `"Workbench"` pane; follows the active parameter SYSTEM-WIDE (re-targeted by every param row's `onActivate` → `updateDefaultWorkbench`). Not spawnable.
3. **PANEL-SPECIFIC DYNAMIC** (`kind:"panel-dynamic"`, `scopeGroupe:<panel groupe>`) — a spawnable `Workbench:*` clone that follows the active parameter ONLY while that param belongs to its host panel (`selectedParameter.groupe === scopeGroupe`); when the active param is in a DIFFERENT panel its content is UNCHANGED (frozen on its last in-panel param). Title carries a `"(panel)"` marker.

**Re-target mechanism.** `updateDefaultWorkbench(parameter, isPiano)` (the existing onActivate hook) re-points the global `"Workbench"` AND, in the same state update, every panel-dynamic WB whose `scopeGroupe === parameter.groupe`; out-of-panel activations leave a panel-dynamic WB untouched. So panel-following works on every activation path with no per-call-site edits. The `{kind, scopeGroupe}` fields are plain data on the binding, so they ride `mosaicConfigWorkbenches` save/restore + the spawn auto-snapshot generically (no allow-list — same path the Mass groupe used). Pinned by `hooks/__tests__/useCurrentValues.panelDynamic.test.jsx` (tag binding; in-panel re-target; out-of-panel freeze + global still follows; fixed immune; multi-panel selective).

**Invocation (user choice = location-based, 2026-06-20).** Each parameter panel's toolbar carries a single **panel-following** button (`@mui/icons-material/Timeline`) → `handleOpenWorkbench(param, isPiano, paneId, {kind:"panel-dynamic", scopeGroupe: paneId})` (spawns with the current `selectedParameter` if it belongs to this panel, else a `{groupe: paneId}` placeholder that re-points on the first in-panel activate). ROW-BASED panels (Strings/Modes/Excitation) keep FIXED on the per-row icons; their toolbar button is panel-following (Excitation's old fixed toolbar button was repurposed). MATRIX panels (Feedin/Feedback/Sound Channels) have no per-row affordance — per the user's M2 choice their toolbar button IS panel-following and they have **no fixed-spawn** (panel-following is the matrix-panel workbench). Each spawn's dock location comes from its TYPE's placement setting (below).

**PER-TYPE placement setting → global ⚙ (dev-wbspawn, 2026-06-20).** Workbench spawn placement is **per type**: `workbenchSettings.placement = { fixed, panelFollowing, globalDynamic }` (each `"screen-bottom" | "panel-bottom"`). **Defaults:** `globalDynamic = "screen-bottom"`, `panelFollowing = "panel-bottom"`, `fixed = "panel-bottom"` (fixed + panel-following default to docking below their host panel; the global dynamic defaults to the screen bottom). All three are edited in the always-reachable **global settings dialog** (`src/components/GlobalSettingsDialog.jsx`, three labeled `<Select>`s), opened by the top toolbar ⚙ (wired via `onOpenGlobalSettings`). At spawn, `handleOpenWorkbench` resolves the dock mode via `placementForSpawn(workbenchSettings.placement, kind)` (`src/utils/workbenchPlacement.js`): `kind:"panel-dynamic"` → `panelFollowing`, else (fixed) → `fixed`. **Global-dynamic nuance:** the always-present "Workbench" pane is never spawned via `handleOpenWorkbench`; its only dynamic-placement event is the checkbox RE-ADD (`addBottomPinnedToLayout` → `appendToScreenBottom`), and it has no source panel — so its setting's only realizable value is `screen-bottom` (panel-bottom degenerates to it; the control's helper text says so). `placement` lives in the `workbenchSettings` bucket; it is `hidden:true` in `ObjectInspector.PARAMETER_CONFIG` (a nested object) so the per-pane gear never renders it. The single old `placementMode` key was replaced (minor UI pref, no precise migration; `loadSetting`'s merge-over-defaults supplies `placement` for users whose localStorage predates it). Pinned by `placementForSpawn` tests in `workbenchPlacement.test.js`.

### Bottom bar — Volume / Feedback / Reset (dev-uiqueue T2, 2026-06-15)

`src/components/BottomBar.jsx` is a dedicated control bar below the mosaic that hosts the three
GLOBAL playback controls — **Volume**, **Feedback**, **Reset** — LARGE, each with an **inline,
always-visible Sensitivity control**. It owns no state (P2: layout only); every value + handler is
passed by `PianoidTuner` (usePreset is the sole owner of volume/feedback state, P1).

**Why it exists (regression fix).** The volume-Sensitivity control used to be a double-click popover
on the top toolbar's tiny "Volume" caption. dev-09cf (2026-06-09) added `overflowY:hidden` to the top
`<Toolbar>` to fix horizontal control clipping — which then **clipped the downward-opening
sensitivity popover** (measured live: ~2.2px of a 129px popover visible), so adjusting volume
sensitivity appeared to "do nothing" (the reported regression). Relocating Volume + Feedback + Reset
out of the overflow-constrained toolbar into this bar, with Sensitivity as an inline `NumInput` next
to each slider, structurally restores it (no `overflow:hidden` ancestor). The top `ToolBar` no longer
renders or receives those controls' props (`VolumeSlider`/`FeedbackSlider` defs deleted; Capture
stays).

**Volume sensitivity** = the `volumeRange` (curve "range ×"): the velocity-loudness spread around the
midpoint. The field commits `onVolumeSensitivityChange(center, range)` where `center =
exp((presetVolume+64)/8)`; usePreset sends `volume_center`/`volume_range` to the engine. **Feedback
sensitivity** (NEW, the volume analogue) = the **base of the env-multiplier curve** —
`envMultiplier(pos) = base^((pos-64)/63)` (was hardcoded `8`); a lower base = a gentler slider, higher
= steeper, 64 stays ×1 at every base. It is frontend-only (reshapes the slider→effective-coeff
mapping already sent via `feedback_coeff`), owned by usePreset as `feedbackSensitivity` +
`changeFeedbackSensitivity`, NOT persisted (resets with the runtime surface, mirroring `volumeRange`).
Feedback semantics (per `project_feedback_coeff_is_damping`): lower feedback = louder/sharper attack
but STABLE (it is a damping coefficient, decays at all values) — the only risk is output CLIPPING at
low feedback (headroom), NOT instability, so NO stability guard is added. The "Set" fold button
(`foldFeedbackIntoPreset`) moved to the bottom bar with the slider. Pinned by
`components/__tests__/BottomBar.test.jsx` (renders all three; Reset fires; Set fold disabled@neutral;
volume + feedback Sensitivity fields commit through to their handlers).

### `useLayout`

Manages the `react-mosaic-component` tile layout tree. The initial layout places the following named panes:

```
Preset | Charts
-------+-----------------------------------------------------
MIDI+Strings | Feedin / Feedback | Virtual Piano | Modes
                                               |
                                           Workbench
```

(The previous initial layout had `Settings` in the top-left where `Preset` is now. The migration from Settings to Preset is described below. The `NumInputTest` sandbox pane that previously occupied the bottom of the top-right column was removed in dev-f259, 2026-05-01.)

Layout is persisted to `localStorage` under `mosaicLayout`. Exposes `handleMaximize(id)` (saves backup, expands one pane to full screen), `handleRestore()` (restores backup), `closeMaximized(id)` (close-while-maximized — see below), `handleDefaultLayout()` (resets to initial).

**Close-while-maximized (dev-excwb, 2026-06-11; user msg 3476).** Each pane's title bar (`PianoidTuner.renderToolbarControls`) shows a Maximize/Restore toggle plus a Close (X). Previously the Close was suppressed whenever ANY pane was maximized (`if (!isFullscreen)`), so a maximized pane — e.g. an Excitation workbench — showed only Restore and the user could not close it without first un-maximizing. This was GENERAL (every pane type), not workbench-specific. The Close was hidden because the live `layout` when maximized is a single leaf (`handleMaximize` sets `layout = id`), so a plain `mosaicActions.remove(path)` would empty the layout and strand the user in fullscreen. The fix renders Close in BOTH states: maximized → `useLayout.closeMaximized(id)`, which prunes that leaf from the saved `layoutBackup` (via the `removeLeaf` prune-and-collapse helper, same idiom as `stripDynamicWorkbenches`), restores the pruned backup as the live layout, and exits fullscreen — "close while maximized returns you to the multi-pane view minus this pane" (falls back to the default layout if pruning empties the tree). Non-maximized Close is unchanged (`mosaicActions.remove(path)`). Pinned by `hooks/__tests__/useLayout.closeMaximized.test.jsx`.

**Layout migration walker `mapDeprecatedPaneIds` (dev-a328 Phase 2, 2026-05-01; extended by dev-f259, 2026-05-01).** Existing users who installed before a pane rename or removal have stale leaf IDs saved in their `localStorage.mosaicLayout`. The `useState` initialiser pipeline applies two walkers in order:

1. `stripDynamicWorkbenches(node)` — removes `Workbench:*` leaves (their state is not persisted across reloads). Pre-existing behaviour.
2. `mapDeprecatedPaneIds(node)` — rewrites or drops deprecated leaf IDs per the `PANE_ID_MIGRATION` registry. Two policies coexist: `"OldId": "NewId"` (rewrite the leaf, preserving its position) and `"OldId": null` (drop the leaf entirely, parent collapses). Currently:

   ```js
   const PANE_ID_MIGRATION = {
     Settings: "Preset",       // dev-a328: monolithic Settings pane → PresetPanel
     NumInputTest: null,       // dev-f259: sandbox demo pane removed
   };
   ```

   The walker uses `Object.prototype.hasOwnProperty` to distinguish "key not in registry" (preserve as-is) from "key explicitly mapped to null" (drop the leaf). Add new entries here as future panes are renamed, split, or removed.

The walker is implemented as a two-pass operation (`collectLeafIds` + `mapDeprecatedPaneIdsWith`):

- **Pass 1: collect all leaf IDs into a Set.**
- **Pass 2: rewrite. If the deprecated leaf's target ID already exists elsewhere in the tree, drop the deprecated leaf (return `null`, pruning it) instead of creating a conflict. For null-mapped entries, drop unconditionally.**

The duplicate-detection is load-bearing: `react-mosaic-component` does not allow leaves with the same ID and crashes hard with `Duplicate IDs [<id>] detected. Mosaic does not support leaves with the same ID`. The trigger scenario: a user's saved layout already contains both the deprecated leaf (Settings) AND the new leaf (Preset) — for example because the user manually re-added the legacy Settings pane via the Window Layout Manager dialog during the Phase 2 transition. Without de-duplication, the rewrite Settings → Preset would produce two `"Preset"` leaves and crash. With de-duplication, the user's existing Preset pane is preserved and the deprecated Settings leaf is silently dropped. Drop-by-null entries (NumInputTest) bypass the existence check and are pruned in all cases — the parent collapses through the standard `!first ? second : !second ? first` fallback in `mapDeprecatedPaneIdsWith`.

### `useCurrentValues`

Tracks the current UI selection state — which pitch, which selected pitch/mode RANGES (`selectedPitches`/`selectedModes`), which modes, which parameter, which velocity level, and which Gaussian component are currently selected. Acts as a shared selection context consumed by multiple components.

**Per-chart tie/untie zoom (system-wide-selection, rollout COMPLETE — dev-mwfix P1-A, 2026-06-10).** A chart's visible range is DERIVED, not stored: `deriveChartView(isChartTied(id), globalSelection, fullExtent)` (`utils/chartView.js`). The only per-chart state is the boolean `tied` flag (default true via the absent-entry convention; `isChartTied`/`setChartTied`/`clearChartTied`). Tied + a selection → view = selection; tied + no selection (or untied) → full extent. **The legacy shared-range zoom state `rangeOfPitches`/`rangeOfModes` (and their setters + the two reset effects) was DELETED** — every editor pane (Feedin, Feedback, Sound Channels MODE axis, Virtual Piano, Workbench + dynamic clones, Modes-rule) now derives its view this way, driven by ONE unified toolbar control set (ZoomIn re-tie / ZoomOut untie / Deselect) in `renderToolbarControls`. The matrix ruler drag drives the global SELECTION (`onSelectRange` → `setSelectedPitches`/`setSelectedModes`), NOT a zoom-write (the old `onRangeChange`/`onModesRangeChange` writers are retired no-ops). The Virtual Piano "Play All" sweep follows the VP's derived view (`vpPianoView`). **★Invariant:** the SC channel-ROW axis is NEVER governed by the global selection — it stays SC-LOCAL/full inside `SoundChannelsPane` (`selectedChannel`/`selectedChannelRange`); only the SC MODE axis ties to `selectedModes` (the fa3c64b `matrix[-22]` channel→pitch decouple).

### `useMatrixHistory`

Tracks edit history for the feedin/feedback (and Sound Channels) matrices to support undo operations. The pure `calcChange(stageMatrix, stageMuteMap, change)` applies one change object and is the single matrix-mutation primitive (reused by `applyChange`, `applyBatchChange`, and the imperative-emit paths in `useSoundChannels`/PianoidTuner). `applyChange` computes `calcChange` ONCE per edit (dev-mwfix P2-A; was twice → two full structured clones/frame). The dead `mutedMatrix` state + its derive-on-every-edit effect were removed (dev-mwfix P2-B; a pre-dev-833f speculative-emit leftover with no consumer). **Mute** flows ONLY through the zone-bearing `onMatrixValuesChange` → `applyChange` / `applyImperativeChange` path (and the tri-state aggregate `MuteSet`); the old `onMuteMapChange` / `applyImperativeMuteToggle` / `changeFeed*MuteMap` write-path was deleted (dev-mwfix P1-B — it issued a zoneless `Mute` op that `calcChange` no-op'd).

**Selection-scoped edits (dev-mzoom, 2026-06-05, Option A).** `change` accepts an optional `bounds = { pitchMin, pitchMax, modeMin, modeMax }` (matrix-key space: `pitchMin/Max` = matrix ROW keys — piano pitches for Feedin/Feedback, output-channel indices for SC; `modeMin/Max` = column indices). When present, the `Row` (`modesVector`), `Column` (`pitchesVector`), and `Matrix` zones — and their `Mute` variants — clamp their writes to the rectangle, so an edit applies ONLY to the selected area. `Cell` and the `*Drawn` zones ignore `bounds`. **Absent `bounds` = whole matrix as before (backward-compatible).** `MeasuredMatrix` derives `bounds` from the **SELECTION range per axis** (`selectedPianoRange`/`selectedModesRange`), bounding an axis ONLY when the selection is a real SUB-range (narrower than the full extent); a full-range or absent selection on an axis = no bound there. So editing with nothing selected hits the whole matrix; a drag-selected sub-range scopes the edit — uniform across Feedin/Feedback and SC. (Earlier dev-mzoom revisions bounded to the VIEW/zoom range; Option A switched the source to the SELECTION so the SC channel-ROW axis — not zoomed — can be scoped, and so selection-without-zoom scopes edits everywhere.) The **SC channel-row bound** comes from a SC-LOCAL `selectedChannelRange` in `SoundChannelsPane` (the channel-row drag is captured locally + passed as `selectedPianoRange`, never via the global `setSelectedPitches` — preserves the dev-snmtxleak channel→pitch decouple). Emit path unchanged. Covered by `__tests__/useMatrixHistory.bounds.test.jsx` (clamping) + `components/__tests__/MeasuredMatrix.scopedBounds.test.jsx` (selection→bounds incl. full-range=no-bound + SC channel case).

### `useValuesHistory`

Tracks edit history for generic parameter arrays.

### `useBackendProcess`

Manages the Flask backend process lifecycle from the frontend. Launches `server/launcher.js` (Node.js) which spawns the Python backend, monitors its stdout/stderr, and handles restart/shutdown. Exposes: `startBackend()`, `stopBackend()`, `killStale()`, `backendOutput` (log lines), `isRunning`.

`killStale()` calls `POST /api/kill-stale` on the launcher, which runs `killProcessesOnPort(5000)` to terminate any process holding the backend port — regardless of whether the launcher spawned it. The implementation uses `netstat -ano` to find PIDs on the specific port, then `taskkill /pid <PID> /T /F` to kill only those PIDs. It never blanket-kills `python.exe` or `node.exe`.

### `useHotkeys`

Global keyboard shortcut handler. Registers `keydown`/`keyup` listeners on `window`. All shortcuts are suppressed when focus is inside an `<input>`, `<textarea>`, `<select>`, or `contentEditable` element.

| Key | Action |
|---|---|
| Space | Play selected pitch (default 60); note-off on key release |
| ← / → | Select and play previous / next available pitch |
| + / = | Volume +5 (clamped 0–127) |
| - | Volume −5 (clamped 0–127) |
| Shift + + | Feedback +5 (clamped 0–127) |
| Shift + - | Feedback −5 (clamped 0–127) |
| Ctrl + - | Feedback → 0 |
| [ / ] | Previous / next library preset |
| Escape | Reset synthesiser |

Velocity is derived from the selected excitation level: pp=0, p=31, mf=63, f=95, ff=127.

### `useChainEditor`

Client-side chain editing state machine with snapshot-based undo/redo. Provides a working copy of tracked chains (`editedChains`), dirty tracking, and interaction mode switching (`select`, `addPoint`, `drawChain`, `connectChains`, `breakChain`, `dissolve`).

Mutation methods: `addPointToChain`, `removePointFromChain`, `createNewChain`, `mergeChains`, `breakChainAt`, `dissolveInRange`. Each mutation pushes the previous state to the undo stack and clears the redo stack.

Lifecycle: `initFromServer(chains)` loads chains from tracking data. `saveChains()` POSTs to `/modal/chains/save` via `useModalAdapter.saveEditedChains`. `discardEdits()` reverts to original server state.

Wired into `ModalAdapter.jsx` Tracking section alongside `StabilizationToolbar`.

### `useModalAdapter`

Manages the Modal Adapter pipeline. Connects to the modal adapter server on port 5001 (passed as `url` prop). All state synchronization flows through a single `syncFromBackend()` function that calls `GET /modal/project_state` and populates all frontend state from the backend response. This eliminates split-brain state between frontend and backend.

Key state: `stages` (per-stage `{done, running, data, error}`), `channelRoles`, `bridgeBoundary`, `pitchOffset`, `espritConfig`, `trackingParams`, `selectedChains`, `channelToSound`, `responseChannels` (derived), `dataStatus`, `serverRunning`, `projectList`, `currentProject`.

**State ownership (post-Phase-4):** Backend is authoritative for all persistent project data. Frontend mirrors this state for rendering only, divided into three buckets:

1. **Server-owned mirrors** — set ONLY by `syncFromBackend()`: `measurementInfo`, `channelRoles`, `bridgeBoundary`, `pitchOffset`, `channelToSound`, `espritConfig`, `trackingParams`, `dataStatus`, `project.{current,dir,base}`, and per-stage `done`/`data` flags on `stages`. `scenarioInfo` is set only by `fetchScenarioInfo()` (separate endpoint, same pattern). Direct setters for these are private staging primitives — never call them from action handlers.
2. **UI staging** — user-pending edits in form components: `mappingDirty` plus `stageChannelRoles` / `stageBridgeBoundary` / `stagePitchOffset` (exported as `setChannelRoles` etc.) for the Mapping form (commit via `submitChannelMapping()`); `setEspritConfig` direct (commit via `saveEspritConfig()` or `runEsprit()`); `setTrackingParams` direct (commit via `runTracking()`).
3. **UI-only state** — never round-trips: `stages` (progress/running flags), `loading`, `error`, `serverRunning`, `selectedChains`, `mergeMode`, `selectedScenarios` (frontend pick — backend has no notion of "selected"), `pipelineRunning`, `pipelineStage`.

**`syncFromBackend()` mutation sink.** Reads `GET /modal/project_state` and writes the canonical snapshot into all server-owned mirrors. Required after every action that mutates server state — sequence is: `user action → axios POST → backend accepts → await syncFromBackend()`. No optimistic local writes for server-owned mirrors; they race with the next sync. Sets `mappingDirty = false` at end.

**Mount:** fetches project list; if a project is open, calls `syncFromBackend()` then `fetchScenarioInfo()`.

**Server-status watcher.** In addition to the mount-time fetch, a dedicated `useEffect` polls `GET /health` at 2 s cadence while `serverRunning === false` and stops as soon as the server responds. A second effect watches `serverRunning` and — on every off→on transition — re-runs the same load sequence as Mount (`fetchProjects` → `syncFromBackend` → `fetchScenarioInfo`). This ensures the project list auto-populates when the modal adapter server is started after the frontend mounts (launcher, external script, or any off→on transition), removing the previous requirement to reload the page.

**`ensureModalServer()` (auto-start helper).** Probes `GET /health`; if alive returns `true` immediately. Otherwise POSTs `/api/start-modal-adapter` on the launcher and polls `/health` every 500 ms (up to 10 s = 20 attempts) until the server is alive, returning `true` on success or `false` on timeout / launcher rejection / no `launcherUrl` configured. Used both by hook actions that need the backend (`openProject`, `createProject`, `importProject`, `copyProject`, `deleteProject`, `renameProject`, `reaverageProject`, `applyToPreset`, `exportToText`) AND directly by the **Open Project** button onClick handler in `ModalAdapter.jsx` (dev-037a, 2026-05-06) so the project-browser dialog opens with a populated list rather than an empty list when the user clicks Open Project before the modal-adapter backend is up. Returns `false` and sets the hook's `error` state on failure — the caller is expected to skip its action when `false` is returned.

**Actions** (all call `syncFromBackend()` after backend acceptance): project CRUD (`createProject`, `openProject`, `copyProject`, `deleteProject`, `addMeasurementsToProject`); `submitChannelMapping()` (POSTs `/modal/mapping`); `submitSoundMapping()` (POSTs `/modal/channel_mapping`); `runTracking()` (uses all processed scenarios); `runFeedin()`; `applyToPreset()`; `loadIntermediate(stage)`; `saveEditedChains(chains)`; `runPipeline(config)` (polls `/modal/status` then syncs on completion); `reset()` (local-only wipe — does not touch backend).

**ESPRIT execution.** `runEsprit()` drives a per-scenario loop from the frontend — each iteration is a synchronous `POST /modal/run_esprit` with `scenario_indices: [i]`. Progress updates between iterations (elapsed, remaining, modes found). Pauses synthesis before, resumes after. Per-iteration `await fetchScenarioInfo()` keeps the processed list current. Post-loop sequence is strictly sequential to avoid races: fetch accumulated results → `await syncFromBackend()` (settles server-owned mirrors) → `await fetchScenarioInfo()` (refreshes scenario lists) → final `updateStage("esprit", { done, data })` and `setSelectedScenarios(unprocessed)` UI-only writes.

### Measurement collection (Collect subpanel — v2 Measurement entity)

The legacy v1 `useMeasurementCollection` + `CollectPanel.jsx` (which wrapped the
retired `/modal/collect/*` surface) were **replaced at Phase 2b** by a
Measurement-scoped editor. `useMeasurementCollection.js` is now a throwing stub
(it guards against any leftover import — the v1 endpoints return 410 Gone). See
[MODAL_COLLECTION.md](../pianoid-middleware/MODAL_COLLECTION.md) for the backend
contract.

**`CollectionSubpanel`** (`src/modules/panels/CollectionSubpanel.jsx`) is the
orchestrator, mounted from the Modal Adapter top-level and scoped to a selected
Measurement. Layout (per proposal §4.1):

1. **Top row** — `<MeasurementSelector>` (pick / create / manage; "+ New Project from this Measurement") + an **Unlock-with-warning** button when the Measurement is locked.
2. **Pre-flight banner** — `<SetupTestBanner>` (Setup Test surface #3): green/yellow/red verdict, gates Start Collection.
3. **Five sections** in `<CollectionSettingsPanel>` (the gear-toggled shell; dev-collreorg-7a3f moved the Accordions here): **General** (name, layout, channel mapping, grid editor) / **AudioDevices** (devices + `multichannel_config` + Setup Test #1) / **Impulse** (waveform params + ECharts preview + Setup Test #2) / **Series** (pulses, cycles) / **CalibrationCriteria** (editable rule table, lock-exempt). Each section has a per-section dirty flag + Save button and a lock chip.
4. **`<CollectionLog>`** — rolling streaming-message log under the Start/Cancel control.

Section components live in `src/modules/panels/collection/` (`GeneralSection`, `AudioDevicesSection`, `ImpulseSection`, `SeriesSection`, `CalibrationCriteriaSection`).

**Record | Synthesize sub-mode (dev-synthfe, synthetic-dataset Phase 4b, 2026-06-08).** A `ToggleButtonGroup` at the top of `CollectionSubpanel` switches between **Record** (the 5-section measurement-collection UI above, the default) and **Synthesize** — an analytic-ground-truth authoring surface that exercises the Phase-4a `/modal/measurements/synthesize` + `/<id>/validate` REST routes (modal-adapter, port 5001). The Synthesize path lets the user author a board of known plate modes + a receiver/impact grid, synthesise a `synthetic:true` Measurement, then (via a separate **Validate** button) run the real ESPRIT pipeline and view the **reconstructed-vs-ground-truth** comparison. Components (all in `src/modules/panels/collection/`):

| Component | Role |
|---|---|
| `SynthesizeSection` | Orchestrator — owns the authoring form (measurement id, mode table via `NumInput`, grid dims, ESPRIT-band selector, impulse via the reused `ImpulseShapeChart` idiom, GPU toggle); pre-flight "modes outside the band" warning; Synthesize + Validate buttons + "Synthetic" chip. |
| `SynthGridSelector` | Receiver/impact placement grid — reuses `GridLayoutEditor`'s opt-in **select-mode** (`selectMode`/`onSelectCell`/`cellRender`, purely additive). Defaults to the engine's interior-inset receiver lattice + 12 off-centre impacts; live "resolvable max mode order" caption (`floor((min(rows,cols)-1)/2)`); ★**dead-channel warning** when a receiver lands on a plate boundary node (where simply-supported eigenmodes are zero → poisons ESPRIT). |
| `SynthComparisonView` | The HEADLINE deliverable — renders the `ValidationScorecard`: per-mode **ground-truth vs ESPRIT-detected** frequency + Q grouped bars, per-mode MAC bars (threshold-colored), per-channel relative-RMS (dead channels in red), the pass/fail verdict badge + recall/precision/threshold rows, and a per-mode numeric table. |

Hook: `useSynthesize` (`src/hooks/`) is the sole writer of the synthesize/validate request+result state. Pure helpers (grid geometry mirroring the backend `forward_model` defaults + the scorecard→ECharts-option builders) live in `src/utils/synthScorecard.js` (DeepSeek-authored via the dev.md Step-4b batch pipeline, Jest-gated in `src/utils/__tests__/synthScorecard.test.js`). The synthetic Measurement lands in the normal Measurement store, so all downstream Project/ESPRIT flows are byte-identical.

**Hooks (P1 — sole-writer rule):**

| Hook | Owns | REST |
|------|------|------|
| `useMeasurementCatalog` | Measurement summary list, create flag, last error | `GET/POST/DELETE /modal/measurements` |
| `useMeasurementSetup` | manifest + per-section setup snapshot | `GET /modal/measurements/<id>`, `PATCH .../<section>` (mirrors the full re-read body the backend returns; round-10 fix) |
| `useSetupTest` | latest Setup Test report (single, N3), `isRunning` | `POST/GET /modal/measurements/<id>/setup_test`. **Single shared instance** behind all 3 Setup Test surfaces — a run from any surface updates all three |
| `useCollectionStatus` | `activePhase` / `activeSessionId` / `messages` / `isInFlight`; 1 Hz poll | `GET .../collect/status`, `POST .../collect/start`, `POST .../collect/cancel`. Consolidated the two duplicate pollers (subpanel phase + log messages) |

The "currently selected Measurement id" is local state in `CollectionSubpanel`, not in any hook (server-mirror state vs UI choice).

**Measurement dialogs** (`src/components/`): `MeasurementsManagementDialog` (list / rename / delete with linked-project guard), `UnlockMeasurementDialog` (confirm-with-warning), `ImportScenariosDialog` (the round-30 consolidated create-new / add-to-existing import flow; `targetMode` prop selects), `CreateProjectFromMeasurementDialog` + `MeasurementSelector` (branch a Project off a Measurement). `useMeasurementCatalog.deleteMeasurement` uses a 60 s axios timeout (Windows rmtree + serial Flask), `renameMeasurement` 30 s; the async create dialog backstops at 60 min.

### `useSocketIO`

Manages a persistent Socket.IO WebSocket connection to the Flask backend (port 5000). Provides low-latency note playback and receives server-push events.

Exposes: `connected` (boolean), `latencyMs` (last measured RTT), `emit(event, data)` (send JSON event), `emitBinary(bytes)` (send binary frame), `on(event, callback)` (register listener, returns unsubscribe fn), `off(event, callback)`, `measureLatency()`.

Used by `usePreset` (note playback with REST fallback) and `useBackendHealth` (lifecycle events with REST polling fallback). Configuration: reconnection with exponential backoff, prefers WebSocket transport with polling fallback.

### `useWindowManager`

Manages the set of open/closed mosaic panes and their IDs.

### `usePaneSettingsDialog`

Owns the open/close state for one pane's settings dialog and portals a gear `<IconButton>` into the MosaicWindow's native title bar (`.mosaic-window-controls` ancestor of the pane's root). Lifted from the existing pattern in `modules/ModalAdapter.jsx:60-81` (the canonical reference) and generalised so every consumer pane gets exactly one gear with one tooltip and zero duplication.

Concern (P2): own dialog `open` state + portal the gear; **knows nothing about the settings bucket itself** — caller passes settings + setSettings to `<PaneSettingsDialog>` directly through `<PaneWithSettings>`.

Returns: `{ open, openSettings, closeSettings, gearPortal }`. The `gearPortal` value is wrapped in a `React.Fragment` (NOT a bare `ReactPortal`). This wrap is load-bearing: MUI v6 Box's `propTypes.children` uses the `prop-types` package's `node` validator, which **predates the ReactPortal type and does not recognise `Symbol(react.portal)` as a valid node**. A bare ReactPortal embedded in a Box's `children` array trips `Warning: Failed prop type: Invalid prop \`children\` supplied to ForwardRef(Box)`. Wrapping in a Fragment makes the children look like `[Symbol(react.fragment), Symbol(react.element), ...]` — all valid per the validator. (Same pattern is needed if `modules/ModalAdapter.jsx` is ever updated; it has the same warning today, out of scope for the dev-a328 refactor.)

Coexistence with the (now-removed) inline gear injector: prior to the dev-a328 refactor, `PianoidTuner.renderToolbarControls` injected a generic `<IconButton title="Settings">` into every pane's title bar. While that injector still existed (Phase 1 + Phase 2), `usePaneSettingsDialog` hid it via `display:none` to keep exactly one gear per pane. Phase 3 (commit `b1c5f8e`) removed the injector entirely — every pane now portals its own gear via this hook (or via the ModalAdapter pattern for that one pane).

---

## Mosaic Window Management

The application uses `react-mosaic-component` to implement a tiling window manager. The layout is a binary tree where each leaf node is a string ID (e.g., `"Feedin"`, `"Modes"`, `"Virtual Piano"`) and each internal node specifies a split direction and percentage.

`useLayout` owns the tree and provides helpers to maximize a single pane (replacing the whole tree with the leaf ID string) and restore the previous tree. Layout changes are saved to localStorage on every update.

### Workbench spawn placement (dev-wbspawn, 2026-06-20: PER-TYPE)

Spawning a workbench inserts the new pane **without relocating any already-visible pane**. WHERE it docks is resolved **per workbench TYPE** — each of the three types has its own placement setting, all editable in the **global ⚙ dialog** (top-bar, `GlobalSettingsDialog.jsx`) under three labeled controls (Fixed / Panel-following / Global dynamic):

| Type | Setting key (`workbenchSettings.placement.*`) | Default | Spawned from |
|------|-----------------------------------------------|---------|--------------|
| **Fixed** (bound to one param forever) | `fixed` | `panel-bottom` | a Strings/Modes/Excitation param-row BarChart icon |
| **Panel-following** (follows active param within its host panel) | `panelFollowing` | `panel-bottom` | a panel-toolbar Timeline button (one per panel) |
| **Global dynamic** (single always-present "Workbench", follows the active param system-wide) | `globalDynamic` | `screen-bottom` | not user-spawned (re-added only) |

Each setting takes one of two **placement modes**:

- **`panel-bottom`** (default for fixed + panel-following) — the new pane docks directly under the pane that owns the source parameter (the source leaf is split into a column `{ sourcePane / newWorkbench }` in place); all other panes are untouched. Falls back to the screen-bottom append when the source pane is not in the layout.
- **`screen-bottom`** (default for global-dynamic) — the new pane is appended to the screen's bottom stack: the canonical layout's root `direction:"column"` `second` child is grown in place; if no bottom stack exists yet, one is created beneath the current layout. Every other pane keeps its exact position and size.

**Global-dynamic nuance.** The global-dynamic "Workbench" pane is the always-present default pane and is never *spawned* via `handleOpenWorkbench` — it is only ever **re-added** (after being closed) via `addBottomPinnedToLayout`, which always appends at the screen bottom. So its `globalDynamic` setting only meaningfully selects `screen-bottom`; if set to `panel-bottom` it degenerates to `screen-bottom` on re-add (the pane has no single "source panel" — it follows the active param system-wide). The control is still shown for symmetry/clarity; the helper text states the fallback.

**Resolution at spawn.** `placementForSpawn(workbenchSettings.placement, kind)` maps the spawn's `kind` to its setting: `kind === "panel-dynamic"` → `panelFollowing`; absent (a FIXED spawn) → `fixed`. It returns only `"screen-bottom"` / `"panel-bottom"` (any other/missing value → `panel-bottom`). `handleOpenWorkbench(parameter, isPiano, sourcePaneId, extra)` routes `panel-bottom → dockUnderPanel`, `screen-bottom → appendToScreenBottom`.

**The bug the original placement work fixed:** the previous `addBottomPinnedToLayout` gathered EVERY bottom-pinned pane from anywhere in the tree (`collectBottomPinned` + `stripBottomPinned`) and rebuilt them into one full-width balanced stack on every spawn — so spawning a new workbench yanked all already-placed workbenches (and Virtual Piano) to the bottom ("all the workbenches are relocated to the bottom of the screen" — the reported bug).

The pure tree transforms (`isBottomPinned`, `appendToScreenBottom`, `dockUnderPanel`) plus the per-type resolver (`placementForSpawn`) live in `src/utils/workbenchPlacement.js`; `PianoidTuner` holds thin `setLayout(transform(layout, …))` wrappers. The three settings render as labeled `<Select>` controls in `GlobalSettingsDialog.jsx`; the nested `placement` object is hidden from the per-pane gear's ObjectInspector (`placement: { hidden: true }`) so it never renders as `[object Object]`. Persists in the `workbenchSettings` localStorage bucket (merged-over-defaults on load; the old single `placementMode` key is dropped, the three per-type keys default per the table — a minor UI pref, no precise migration). Pinned by `src/utils/__tests__/workbenchPlacement.test.js` (no-relocate, canonical extend, fresh-stack-create, dock-under-panel, source-absent fallback, no-mutate, **plus `placementForSpawn` per-type**).

### Workbench color coding — 2-D schema (dev-wbspawn, 2026-06-20)

A workbench pane's **title-bar accent** encodes TWO dimensions, both user-editable in the global ⚙ dialog:

- **HUE = the panel/groupe of the parameter it currently reflects.** Seven parameter-bearing panels, each with a default hue. (There is no separate "Hammer" panel — hammer params live in the Excitation panel, so they take the Excitation hue; **H1**, no special-casing.)
- **BRIGHTNESS tier = the workbench TYPE.** Global-dynamic = purest/brightest, panel-following = middle, fixed = dullest. Same hue, three tiers — derived by mixing the base hue toward mid-grey by a per-type factor.

So **colour = hue(groupe of current param) × brightness(type)**. The global-dynamic "Workbench" pane re-colours **live** as it follows the active param across panels (bright blue on a Strings param, bright red on Excitation, …); panel-following and fixed panes take their bound param's groupe hue.

| Panel (groupe) | Default hue | | Type | Default tier |
|----------------|-------------|---|------|--------------|
| Strings | **#2196f3** blue | | Global dynamic | **1.0** (purest) |
| Modes | **#4caf50** green | | Panel-following | **0.7** (middle) |
| Excitation (+ hammer) | **#e53935** red | | Fixed | **0.4** (dullest) |
| Feedin | **#00bcd4** cyan | | | |
| Feedback | **#fb8c00** orange | | | |
| Sound Channels | **#e91e63** magenta | | | |
| Mass | **#8d6e63** brown | | | |

All seven default hues are distinct from the **Sound Channels average chart** accent (MUI default-theme `primary.light` **#42a5f5** blue / `secondary.light` **#ba68c8** purple, in `SoundChannelsAggregateChart.jsx` `seriesColor`); Sound Channels uses magenta (not purple) to stay clear.

**Implementation.** The pure resolver `workbenchColor(id, wb, colors)` (`src/utils/workbenchColor.js`) returns the final hex: it resolves the type via `workbenchKind(id, wb)` (`workbenchTitle.js`: `"Workbench"`→global; `Workbench:` with binding `kind === "panel-dynamic"`→panel; else→fixed; non-workbench→`null`), looks up the groupe's hue, and applies the tier via `applyTier(hex, factor)` (mix toward `#808080`). Defaults live in `workbenchColor.js` (`DEFAULT_WORKBENCH_HUES` / `DEFAULT_WORKBENCH_TIERS`) and are mirrored in `workbenchSettings.colors = { hues, tiers }` (the resolver merges-over-defaults, so a partial saved schema still resolves). `PianoidTuner.renderTile` resolves the colour per-render and delivers it as the `--wb-accent` CSS custom property on a `display:contents` wrapper around the `MosaicWindow`; the single `.wb-accent .mosaic-window-toolbar` rule in `index.css` paints the toolbar (translucent `color-mix` fill + 4px solid left-border), declared before `.highlighted-window` so the active-panel orange cue still wins on overlap. **Editing UI:** the global ⚙ dialog's "Workbench colours" section — 7 per-panel `<input type=color>` swatches + 3 per-type brightness `Slider`s (with live preview chips) + a reset button. **Supersedes** the earlier flat 3-color-per-type scheme (the `wb-kind-*` classes + `workbenchKindClass`). Pinned by `src/utils/__tests__/workbenchColor.test.js` (tier math, 2-D resolve, global-follows-param, hammer→Excitation, SC-avg distinctness) + the `workbenchKind` suite in `workbenchPaneTitle.test.js`.

### Workbench panel registry — icon + tracking SSOT (dev-wbfix, 2026-06-23)

`src/utils/workbenchRegistry.js` is the **single source of truth for workbench-able parameter PANELS**. A workbench pins ONE modifiable parameter and edits it across the keyboard; three facets were previously hardcoded ad-hoc per panel and DRIFTED — the **open-workbench icon**, the **dynamic-workbench tracking**, and per-panel label/groupe metadata. The registry makes the set of workbench-able panels explicit so none is ever silently missed again.

- **`WORKBENCH_PANELS`** = the seven workbench-able groupes (`Strings`/`Modes`/`Excitation`/`Feedin`/`Feedback`/`Sound Channels`/`Mass` — the SAME key set as `DEFAULT_WORKBENCH_HUES`), each carrying `{ icon, label, matrixRowIsPiano }`. The authoritative unit is the **panel/groupe**, NOT a frozen list of param *names* — the matrix panels' param names are data-driven from the backend `values` keys (freezing them would duplicate + drift the engine). Hammer spatial params ride `groupe === "Excitation"` (no separate Hammer groupe, mirrors `workbenchColor.js`); per-pitch mass is its own groupe `"Mass"`.
- **`workbenchIconFor(groupe)`** is the **icon SSOT**. Every "open workbench" affordance derives its glyph from it — `Mode`/`Strings`/`GaussEditor`/`HammerStringChart` (the per-param BarChart `IconButton`s), `ExcitationEnergyEditor`'s mass control, and `PianoidTuner.renderToolbarControls`' panel-following toolbar button. **This fixed the "wrong mass icon":** the mass control hardcoded `OpenInNewIcon` while every other affordance used `BarChartIcon`; now all resolve through the registry (default `BarChartIcon` for all seven groupes), so the drift is impossible by construction. `src/utils/workbenchIcon.js` is a thin re-export of the registry resolver (preserves the import path). Composes with the other two groupe-keyed SSOTs — `workbenchColor.js` (groupe→hue) + `workbenchTitle.js` (groupe→title).
- **`isWorkbenchGroupe(groupe)` / `matrixRowIsPianoFor(groupe)`** back the **uniform activation helper** `activateWorkbenchParam(param, isPiano)` in `PianoidTuner.js` — the SINGLE path by which "the user selected a modifiable param" becomes the active param the dynamic (`Workbench`) + panel-following workbenches track (`setSelectedParameter` + `setMatrixRowIsPiano` + `updateDefaultWorkbench`; groupe validated against the registry, row axis derived from it when not given).

**Dynamic-workbench tracking fix (the actual #1 defect).** The retarget logic (`useCurrentValues.updateDefaultWorkbench`) was already groupe-GENERIC (no allow-list — it follows ANY groupe). The gap was that the **hammer chart and the mass control never CALLED it** — they set their own local selection but bypassed the per-panel `onActivate` wiring, so selecting a hammer/mass param silently stopped the dynamic workbench following. Fix: `HammerStringChart` gained an `onSelectParam` prop (fired on handle-mousedown + each NumLabel select via the `selectHandle` helper) and `handleHammerParamChange` now activates on edit; `HammerMassControl` gained `onSelectParam` (control mousedown + NumInput change). Both thread `PianoidTuner → Excitation → ExcitationProperties →` the leaf and route through `activateWorkbenchParam` (Excitation / Mass groupe). Pinned by `useCurrentValues.panelDynamic.test.jsx` (Excitation + Mass retarget cases) + `utils/__tests__/workbenchRegistry.test.js`.

### Hammer wheel — accumulate-then-emit, no dropped ticks (dev-wbfix #4 2026-06-23; hardened dev-hwheel3 #A/#B 2026-06-24)

The `HammerStringChart` mouse-wheel-on-selected-handle handler previously **dropped ticks**. A per-handle `liveValRef` `{name,value}` is the SOLE running total and is **never nulled at settle** — every notch accumulates onto it (N ticks → N steps), and the settle timer only batches the one network write per wheel-rest.

**dev-wbfix #4** first attacked the stale-prop re-seed (the accumulator survives settle). **dev-hwheel3 #A/#B** found that the fix was incomplete *specifically when wheeling FROM THE CHART* (vs the NumInput field, which commits synchronously per-notch and never had a settle timer to lose) — two residual drop mechanisms, both reproduced live (real `WheelEvent` on real ECharts, against a 300 ms-debounced echoing parent):

1. **Listener teardown killed the pending emit.** The wheel `useEffect` listed `selectedHandle`/`onParamChange`/`widthFloorMeters`/`propValueFor` in its deps, so every prop echo (the debounced `usePreset` write), the per-pitch width-floor fetch, and the default-width nudge **re-subscribed** the listener — and its cleanup ran `clearTimeout(wheelTimerRef)`, **killing a pending settle-emit**. A burst whose settle coincided with that re-render lost its emit entirely (measured 16/20 position ticks, 3/5 width-burst emits landed — width is hit harder by its two extra writers, the floor-fetch + nudge, which is exactly the "width applies inconsistently" report). Fix: the wheel listener is now **mount-once** (empty deps) and reads `selectedHandle`/`onParamChange`/`widthFloor`/`propValueFor` through refs synced each render — so a mid-burst re-render never tears it down and the settle timer is cleared only on true unmount.
2. **Backward re-seed from a lagging self-echo.** The old sync test (`!propIsOurEmit` vs `lastEmittedRef`) compared the prop only against the *latest* emit. With a debounced parent the prop echoes our emits late and through a *sequence* of intermediate values, so an echo rarely equals the latest emit → it was mis-classified as an external edit and **re-seeded the accumulator BACKWARD** (measured emit trail `[0.12,0.14,0.14,0.16,0.18]` — a duplicate from a backward re-seed). Fix: re-seed ONLY when the prop is a value we did **not** emit, matched against a per-handle **emit ring** (`recordEmitted`/`isOurRecentEmit`). A lagging self-echo is in the ring → ignored; a genuine external edit (drag / NumInput / pitch change) is absent from the ring → re-seeds — and this works even when the external edit lands mid-wheel, which a time window cannot.

Pinned by the "wheel ticks are never dropped" + "chart-wheel never drops a tick with a DEBOUNCED echoing parent" suites in `HammerStringChart.test.jsx` (real `WheelEvent` dispatch with a realistic debounced-echoing parent: multi-burst POSITION N→N, long rapid burst, multi-burst WIDTH N→N, the burst-after-settle-before-prop regression, and the external-prop-change re-seed).

### Savable mosaic layouts (dev-uiqueue, 2026-06-15)

The toolbar `Widgets` control is a **selector of named, savable layouts** plus a Manage popup — the
per-layout analogue of the named-startup-configuration feature (`presetConfigStore` + `useSettings`).
The data model and pure transforms live in `src/hooks/mosaicConfigStore.js`; the stateful layer is part
of `PianoidTuner.js` (P1: `PianoidTuner` is the layout owner — via `useLayout` — so it is the sole
writer of the named-config maps; the store is pure, no React/state).

**Storage shape (3 localStorage keys, mirroring the preset-config pattern):**

- `mosaicLayout` — the **live/active** layout tree (unchanged, still owned by `useLayout`). Kept equal
  to the active named layout.
- `mosaicConfigs` — `{ name -> layoutTree }` map of all named layouts.
- `activeMosaicConfig` — name of the currently selected layout.

**Migration + persistence.** On first run `mosaicConfigStore.loadConfigs` seeds `mosaicConfigs` as
`{ "Default": <deep-copy of current mosaicLayout> }` (fail-soft: a corrupt/empty stored map is
re-seeded, never throws). The `mosaicLayout` persist `useEffect` in `PianoidTuner` writes the LIVE
working layout to `localStorage.mosaicLayout` (so the working layout survives reload) — independent of
the named saved configs.

**★Frozen snapshots — no live auto-mirror (dev-mosaicref, 2026-06-16).** A named config changes ONLY on
an explicit **save-as / rename / delete**; there is NO auto-mirror of the live layout into the active
config. The original T1 design auto-mirrored every live edit into the active config (presetLoadSettings
style), which made saving by NAME unreliable: "save A → reconfigure (A still active → A silently
overwritten) → save B" left A == B ("both names show the last config" — the reported bug). Removing the
mirror makes each save a frozen snapshot. **Deep-copy guard (`cloneLayout` = `structuredClone` with a
JSON-roundtrip fallback; string leaf returned as-is):** save-as stores `cloneLayout(liveLayout)`, the
seed clones, and select / delete-fallback apply `cloneLayout(stored)` — because react-mosaic mutates the
live layout object in place, storing/loading it by reference would let one mutating object alias every
saved entry. Snapshot independence is pinned by `hooks/__tests__/mosaicConfigStore.test.jsx`
(`saveConfigAs` stores a non-aliased deep copy; two saves around an in-place mutation stay independent;
`cloneLayout` deep-copies nested splits without touching the source).

**★Workbench bindings persist with the config (dev-mosaicref, 2026-06-16).** A *dynamic workbench* pane
(leaf id `Workbench:<groupe>.<name>[-<gaussIndex>]:<counter>`) binds to its target parameter via the
in-memory `workbenches` map in `useCurrentValues` (`id → {parameter, matrixRowIsPiano}`); the layout tree
stores ONLY the pane-id string, and that map was never persisted. A saved config keeps the `Workbench:*`
leaf, so applying it restored the pane id but the binding was gone → `renderWindowContent`'s
`workbenches[id]` was undefined → the pane rendered unlinked ("after switching configs the workbenches no
longer follow their fixed target params" — the reported bug). Fix: a **companion map**
`localStorage.mosaicConfigWorkbenches` (`{ [configName]: { [workbenchId]: binding } }`) is saved alongside
each config. `mosaicConfigStore.pickWorkbenchBindings(workbenches, layout)` deep-copies the bindings for
exactly the `Workbench:*` ids present in a layout (the bare default `Workbench` pane is excluded, unbound
ids skipped) at save-as; select / delete-fallback call `useCurrentValues.restoreWorkbenches(bindings)`
(which MERGES into the map, preserving the default pane + other open dynamic panes); rename/delete keep
the companion map in sync; a mount effect re-wires the active config's bindings after reload. The layout
tree shape is unchanged (bindings are a sibling map). Pinned by `collectWorkbenchIds` +
`pickWorkbenchBindings` tests in `hooks/__tests__/mosaicConfigStore.test.jsx`.

**★Bindings survive a config switch — prune-on-switch removed + spawn auto-snapshot (dev-wbspawn, 2026-06-19).**
The dev-mosaicref save/restore above persisted the binding, but a *second* path still orphaned fixed
workbenches on a config switch: a layout-watching `useEffect([layout])` in `PianoidTuner` ("clean up
workbench state when panes are removed") deleted every `workbenches[id]` whose pane id was absent from the
**live** layout. On a config switch the live layout becomes the *other* config's tree, so the effect
nuked the previous config's workbench bindings from memory — and it mis-fired the same way on a
**maximize** (the live layout is then a single leaf, so every other pane is transiently absent). The
effect could not tell "user closed the pane" from "pane transiently absent (switch / maximize)". **Fix
(a):** the layout-watching prune effect was **removed**; binding-GC is now explicit at the close ACTION —
the pane Close (X) button (both maximized → `closeMaximized` and non-maximized → `mosaicActions.remove`
branches) and `removeWindowFromLayout` (the checkbox path) each call `closeWorkbench(id)` for a dynamic
`Workbench:*` pane. A binding is dropped only on a real close, never on a switch/maximize/default-layout.
**Fix (c):** because named configs are FROZEN snapshots (no live auto-mirror), a workbench *spawned* into
config A was never written to `mosaicConfigWorkbenches[A]` until an explicit Save — so spawn → switch away
→ back lost it. `handleOpenWorkbench` now **auto-snapshots** the active config's bindings (the just-spawned
one included) into `mosaicConfigWorkbenches[activeMosaicConfig]` immediately on spawn, via
`pickWorkbenchBindings(nextBindings, nextLayout)` (the next layout computed from the same pure placement
transform the spawn applies). Pinned by the "workbench binding survives a config switch (orphan-fix)"
suite in `hooks/__tests__/mosaicConfigStore.test.jsx` (A→B→A preserves the binding; the removed prune
would have orphaned it; restore-from-empty after reload; spawn-in-A survives switch-away-and-back).

**Actions (all in `PianoidTuner`, sole mutators — P1):** `handleMosaicConfigSelect(name)` (make active +
apply the saved layout, exiting fullscreen), `handleSaveMosaicConfigAs(name)`, `handleRenameMosaicConfig`,
`handleDeleteMosaicConfig` (refuses the last config; falls back + applies a remaining one when the active
is deleted). The pure transforms (`saveConfigAs`/`renameConfig`/`deleteConfig`) return a new map +
`{ok, error}` and never mutate; invalid ops surface via the existing `notification` Snackbar.

**UI.** The toolbar (`ToolBar.jsx`) renders a layout-name `<Select>` (apply on change) next to the
`Widgets` `IconButton` (now "Manage layouts"). The Manage popup is `MosaicConfigManager.jsx` (MUI
`Dialog`): (a) the saved-layout list with inline rename + delete (delete disabled at the last entry),
(b) "save current layout as", and (c) the EXISTING pane/window selector (the category checkboxes +
open-workbenches list) passed in AS-IS via a `paneSelector` slot — not recreated — plus the unchanged
"Reset to Default". The dev-a328 `useWindowManager.js` hook remains an unused duplicate of the inline
window-management logic in `PianoidTuner.js`; this feature builds on the live inline copy. Pure store is
unit-tested in `hooks/__tests__/mosaicConfigStore.test.jsx`; the Manage popup in
`components/__tests__/MosaicConfigManager.test.jsx`.

---

## Preset Panel + Per-Pane Settings Popup Pattern (dev-a328, 2026-05-01)

The Pianoid frontend originally exposed a single monolithic `Settings` mosaic pane. That pane was a generic `<ObjectInspector>` that rotated through 9 different settings buckets (`presetLoadSettings`, `virtualPianoSettings`, `modesSettings`, etc.) — clicking the gear icon on any other pane set `currentPropertyManagerName`, which swapped which bucket the Settings pane displayed. This conflated two concerns: (1) preset loading + initialization parameters, (2) per-pane local UI settings.

The dev-a328 refactor (3 phases, branch `feature/preset-panel-and-popup-settings`, merged into `dev`) split these concerns:

### Preset panel

A dedicated `PresetPanel` mosaic pane (`src/components/PresetPanel/PresetPanel.jsx`) replaces the legacy Settings pane in the default layout. Sections, top-to-bottom:

1. **Current Preset** — overline header + filename in monospace + Load (file-picker) IconButton + Reload (UTurnRight) IconButton (only visible when a preset has loaded) + a Save-As `<TextField>` paired with a Save IconButton.
2. **Library** — overline header + Refresh + Add (+) buttons (right-aligned) + a scrollable MUI `<List>` of library entry **records** from `usePreset` (working-copy model, dev-bfe2, 2026-05-18). Each row renders its `kind`: a lock icon + `source`/path caption for read-only `original` entries, an "editable" chip + `source` caption for `working` copies. Active preset is highlighted (`selected` ListItemButton + bold). Click a row → `switchPreset(name)`. Per-entry trailing actions: Spawn working copy (all entries), Promote to original (working copies only — behind a confirm dialog, since it overwrites the original's on-disk JSON), Unload.
3. **Footer Apply** — full-width primary contained Button. Clicking it bumps `_applyTs` and re-fires the existing `useEffect(() => ensureBackendAndLoadPreset(...), [presetLoadSettings])` cycle.

The `<PresetConfigBar>` named-startup-configuration switcher (config-name `<Select>` + Save / Save As / Rename / Delete / Export / Import — the "Save Configuration" surface; dev-startup-configs, 2026-05-16) was previously Section 0 at the top of the panel BODY. Since dev-bbcb (2026-05-30) it lives **inside the initialization-parameters settings dialog** (the gear) instead — it manages the very `presetLoadSettings` bucket the dialog edits, so it belongs next to those fields. See "Named startup configurations" under `useSettings`.

The pane's title bar carries a portaled gear icon (tooltip "Preset initialization parameters") that opens a `<PaneSettingsDialog>` bound to `presetLoadSettings`. The dialog renders `<PresetConfigBar>` at the top (via the dialog's `headerContent` slot, followed by a `<Divider>`), then the 16 initialization-parameter fields, grouped by widget: `path` is a text input; `volume` / `sample_rate` / `string_iterations` / `number_of_modes` are **integer-only** `<NumInput>` fields (0 decimal places + round-on-commit, dev-bbcb 2026-05-30); `Build Mode` / `Cycle Iterations` / `Audio Driver` / `Audio Buffer Size` / `Block Size` / `Listen Mode` / `Sound Derivative` are MUI `<Select>` enums; and the 5 binary on/off fields — `Use Simulation`, `Start Right Away`, `Audio On`, `Listen to MIDI`, `Use CUDA` — render as MUI `<Switch>` toggles (dev-toggle-ui, 2026-05-15; previously bare 0/1 `<NumInput>` floats). The Switch toggle still stores 0/1 integers, so the `/load_preset` payload is unchanged. Apply commits via `setPresetLoadSettings({ ...newProps, _applyTs: Date.now() })` AND closes the dialog.

> **`start_right_away` note (dev-bbcb, 2026-05-30):** the `/load_preset` REST schema types this as a 4-value enum (`0`=init only, `1`=start in background, `2`=start inline [deprecated], `3`=init only no start), but the UI renders it as a binary 0/1 `<Switch>` (off=init only / on=start in background). This is an intentional simplification — the two non-default values are deprecated/rarely-used — kept as-is to avoid changing the payload semantics users rely on. If the 4-value choice is ever needed in the UI, convert its `PARAMETER_CONFIG` entry from `type:"boolean"` to a `type:"select"` enum.

The top `ToolBar` (`src/components/ToolBar.jsx`) keeps its existing preset-management controls — Save Preset As, library Select dropdown, Add to library, Unload. PresetPanel mirrors them with a richer view (full library list + inline Save-As field + file metadata). Both surfaces are fully equivalent; the user can use either.

### `<PaneWithSettings>` HOC

Every other pane that owns a settings bucket wraps its content in `<PaneWithSettings>`. The HOC takes children + settings + setSettings + title via props:

```jsx
<PaneWithSettings
  title="Modes Settings"
  tooltip="Modes settings"
  settings={modesSettings}
  setSettings={setModesSettings}
>
  <Modes ... />
</PaneWithSettings>
```

The HOC owns one `usePaneSettingsDialog` instance, portals one gear into the MosaicWindow's `.mosaic-window-controls`, and renders one `<PaneSettingsDialog>` at the end of its DOM subtree. Every Pianoid pane that needs settings uses this HOC — **one canonical pattern, no per-pane wrappers**. Phase 3 of the refactor consolidated all 9 panes (Modes, Strings, Excitation, Feedin, Feedback, Sound Channels, Virtual Piano, Charts, Workbench) onto this single HOC. The Modal Adapter pane is the one exception — it has its own bespoke `useLayoutEffect` portal pattern (`modules/ModalAdapter.jsx:60-81`) that pre-dates the refactor and was kept as-is to avoid scope creep.

### Apply contract

Both `PresetPanel`'s footer Apply button and every `<PaneWithSettings>` dialog Apply use the same contract: state is updated optimistically via the bucket setter (`setPresetLoadSettings`/`setModesSettings`/etc.), and downstream effects fire from the state-change. There is NO central `handleApplySettings` dispatcher routing PropertyManager swaps — that pattern was removed in Phase 3.

For `presetLoadSettings`, the Apply path additionally injects an `_applyTs: Date.now()` field. This forces React to see a new object reference even when settings are otherwise identical, so the existing `useEffect(() => ensureBackendAndLoadPreset(...), [presetLoadSettings])` always re-fires. The `_applyTs` field is stripped from the persisted localStorage payload by `useSettings`'s persistence effect.

### State discipline

All bucket state is owned by `useSettings` (sole writer of each bucket). `usePreset` owns library state (`libraryPresets`, `activePreset`). PresetPanel and the HOC consumers are pure controlled components — they dispatch on user clicks and never own persistent state. There are no speculative-emit useEffects watching settings state and posting; all writes are imperative-at-action-site.

---

## API Integration Pattern

All API calls use `axios` with `PIANOID_URL = "http://127.0.0.1:5000"`.

The pattern used throughout `usePreset`:

1. State is updated immediately (optimistic update) for responsive UI.
2. The actual API call is debounced (300 ms for parameter changes, 100 ms for volume/feedback).
3. Debounced functions are stored in `useRef` so they persist across renders without recreating.
4. Concurrent calls are guarded by `isUpdating*` flags to prevent race conditions.
5. For chart data, responses are cached in `lastChartResponse` ref and reused for identical requests.

Endpoint conventions observed in the codebase:

```
GET  /health                              Backend health check
POST /shutdown                            Graceful shutdown (GPU cleanup + exit)
GET  /get_available_notes                 Available MIDI pitches in loaded preset
GET  /get_parameter/{type}/all            Fetch all parameters of a type
GET  /get_parameter/{type}/{id}           Fetch one parameter
POST /set_parameter/{type}/{id}           Update one parameter
POST /load_preset                         Load a preset file
POST /save_preset                         Save current preset
POST /play                                Trigger note playback
POST /play_mode/{n}                       Play a specific mode
POST /get_chart                           Fetch chart data
GET  /graph_names                         Available chart types and backend actions
POST /start_test                          Start a test run or toggle live playback
GET  /reset                               Reset synthesiser state
POST /capture                             Capture audio output
POST /set_runtime_parameters              Set volume/feedback scalars
```

---

## Progress Tracking Rule

All long-running backend operations must show progress in the UI. The pattern:

1. **Launch:** POST the operation endpoint. The backend starts a background thread and returns immediately with `{ status: "started" }`.
2. **Poll:** Start an interval polling `GET /calibration_status` (or the operation's status endpoint) every 800ms. The response includes `{ running, progress, current_pitch, pitches_completed }`.
3. **Display:** Show a `LinearProgress` bar with percentage and current step description.
4. **Complete:** When polling returns `running: false`, stop the interval and show a success/error chip with the result summary. Auto-clear after 8 seconds.
5. **Guard:** While any operation is active, disable all operation buttons to prevent concurrent runs.

This applies to: Calibrate Synthesis, Calibrate Acoustic, Measure Precision, Equalize Keyboard, and any future long-running backend operations.
