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
| `VirtualPiano` | `VirtualPiano.js` | Compact virtual piano with range selection and fixed-velocity mode |
| `VerticalPiano` | `VerticalPiano.jsx` | Vertically-oriented pitch selector used in matrix views |
| `MidiComponent` | `MidiComponent.jsx` | MIDI device connection status display |
| `ModeSelector` | `ModeSelector.jsx` | Mode index selector |
| `Mode` | `Mode.jsx` | Single-mode parameter display (frequency, decrement, mass, stiffness) |
| `ModeMenu` | `ModeMenu.jsx` | Mode editing toolbar |
| `Strings` | `Strings.jsx` | String parameter editor (tension, string_stiffness, string_damping, string_radius, string_density, etc.) |
| `Hammers` | `Hammers.jsx` | Hammer overview across pitches |
| `HammerSpatialProperties` | `HammerSpatialProperties.jsx` | Per-pitch hammer shape editor (position, width, sharpness) |
| `Excitation` | `Excitation.jsx` | Gauss parameter editor for hammer excitation curves. Toolbar exposes four stretch/shrink buttons (`vol ↑ / vol ↓ / dur ↑ / dur ↓` semantically) — see "Excitation stretch/shrink toolbar" below. The two `vol x` / `dur x` log-axis sliders that previously lived in the toolbar were removed 2026-05-01 (dev-39c7) in favour of the buttons + a settings-popup `stretchStep` factor |
| `ExcitationProperties` | `ExcitationProperties.jsx` | Single-pitch excitation properties panel |
| `GaussEditor` | `GaussEditor.jsx` | Interactive Gauss curve editor (per-cell mu/sigma/shift/volume edit) |
| `GaussChart` | `GaussChart.jsx` | Chart rendering of a Gaussian excitation curve |
| `GaussDemo` | `GaussDemo.jsx` | Live preview of all 5 Gaussian components |
| `CompositeGaussianChart` | `CompositeGaussianChart.jsx` | Composite view of all Gauss curves at one velocity level |
| `GaussianParameterGrid` | `GaussianParameterGrid.jsx` | Grid of Gauss parameters (mu, sigma, volume, shift) across levels |
| `GaussCell` | `GaussCell.jsx` | Single cell in the Gauss parameter grid |
| `VelocitySelector` | `VelocitySelector.jsx` | Selects which of the 6 base velocity levels to edit |
| `PitchesModesMatrix` | `PitchesModesMatrix.jsx` | 2-D heatmap of pitches × modes for feedin/feedback |
| `PitchesModesMatrixCanvas` | `PitchesModesMatrixCanvas.jsx` | Canvas-rendered version of the matrix |
| `MeasuredMatrix` | `MeasuredMatrix.jsx` | Matrix with measurement overlays |
| `MatrixTools` | `MatrixTools.jsx` | Toolbar for matrix operations (normalise, scale, reset) |
| `BarChart` | `BarChart.jsx` | Thin adapter around `DrawableChart` (2026-04-23, Wave 2 of drawable-chart merge). Preserves the legacy `values`/`startZoom`/`endZoom`/`selectedIndex`/`titles`/`onSelect`/`onChange` API so existing call-sites (`RowEditor`, legacy `Deck`) keep working without API churn, and accepts an optional `variant` prop (`"bar" \| "line"`) forwarded to `DrawableChart`. Drag-paint, wheel-adjust-on-selected, click-select, and dark-theme rendering all live inside `DrawableChart`. Log-scale mode (the old `ScaleType` prop) is no longer supported — it was only used by the dead `Deck` module which is not mounted in the mosaic UI |
| `DrawableChart` | `DrawableChart/DrawableChart.jsx` | Shared drawable scalar-per-bucket chart (2026-04-21, Wave 1 of drawable-chart merge). Renders `values[]` on a category x-axis as a line or bar curve (chosen by the `variant` prop), supports drag-to-paint with linear gap-fill, wheel-adjust on the selected bucket, click-select, optional Flat/Smooth toolbar, parent-owned undo/redo. Single concern: render + edit + emit the painted vector. Consumers own `values` and history state. See `docs/proposals/DRAWABLE_CHART_MERGE.md` for the merge plan |
| `VerticalColumn` | `VerticalColumn.jsx` | Vertical bar column component |
| `VerticalColumnChart` | `VerticalColumnChart.jsx` | Multi-column vertical chart |
| `ChartSelector` | `ChartSelector.jsx` | Tabbed selector (Charts / Dynamic / Actions) for chart types from `/graph_names` response |
| `newWindowChart` | `newWindowChart.jsx` | Chart rendered in a mosaic pane; supports multi-chart layouts and interactive zoom |
| `SoundChannelsPane` | `SoundChannelsPane.jsx` | Dual-axis sound channel editor pane (extracted from `PianoidTuner.js`, 2026-04-20 Wave A). Dispatches between two render modes based on `aggregateMode`: **aggregate OFF** → `MeasuredMatrix` (per-channel matrix, axis is `listenToModes`: modes = pitches × channels, coupling into feedin; strings = channels × modes, feedback gain); **aggregate ON** → `SoundChannelsAggregateChart` (single curve, drag-to-edit, dedicated refactor 2026-04-21). Consumes the `useSoundChannels` hook for history/aggregate/fan-out; owns only the render-mode dispatch and display geometry for the matrix path |
| `SoundChannelsAggregateChart` | `SoundChannelsAggregateChart.jsx` | Thin domain wrapper around `DrawableChart` for the Sound Channels aggregate view (2026-04-23, Wave 3 of drawable-chart merge; previously a 500-LOC standalone editor, now ~170 LOC). Single concern: adapt the aggregate-matrix shape to a flat values-per-bucket vector and translate the painted-vector emit back into an axis-appropriate aggregate-change payload. **Render, drag-paint, Flat, Smooth, undo/redo toolbar, clamp, and dark theme all live in `DrawableChart`.** Data shape handled: **modes axis** → x = pitch (as note name), y = avg coefficient per pitch (hook's `scModesAggMatrix` = `{ pitch: [avg] }`); **strings axis** → x = mode index, y = avg per mode (`scStringsAggMatrix = { averaged: [val_per_mode] }`). Drag emits through `applyAggregateChange` as `pitchesVectorDrawn` (modes axis) or `modesVectorDrawn` (strings axis, with pitch key `"averaged"`); the hook's `fanOutAggregateChangeAxis` expands the delta across the fan-out dimension into one `applyBatchChange` history entry (single undo step per op, same as before). Accepts a `variant` prop (`"line" \| "bar"`) forwarded to `DrawableChart`, driven by `soundChannelSettings.visualization` (default `"line"` per Wave 3, overridable via the Settings gear). Wrapper owns only the pane-level aggregate-toggle (Layers icon) + per-axis caption above the chart; the DrawableChart toolbar (undo/redo + Flat + Smooth + NumInput) renders just below |
| `ParameterEditor` | `ParameterEditor.jsx` | Generic numeric parameter editor |
| `NumInput` | `NumInput/NumInput.js` | Canonical numeric editor (cursor-position step + wheel + opt-in min/max clamp + in-place min/max/decPlaces editing). Defaults to `min=-Infinity / max=+Infinity` so callers that omit the props get truly unbounded input. **Engine-bound parameter editors (Gauss, Mode, String, Hammer, Deck/Sound-Channel coefficients via ToolBar/MatrixTools) deliberately omit `min`/`max` per dev-2706 (Bug A scope expansion, 2026-05-03)** — the backend is the gate; UI does not pre-emptively clamp synthesis parameters. Hard system bounds (MIDI velocity 0–127, sample_rate, audio_buffer_size, calibration timing windows) keep their explicit `min`/`max` because the value range is a protocol/algorithmic constraint, not a UX guess. Also delegated-to by `ObjectInspector` for every numeric field in every settings popup (dev-f259, 2026-05-01) |
| `RowEditor` | `RowEditor.js` | Editable table row for matrix data. Composes `BarChart` (DrawableChart adapter) above a `VirtualPiano` or `ModesRule`. Accepts a `variant` prop (`"bar" \| "line"`) forwarded to the underlying chart — driven from the containing panel's `visualization` setting in `useSettings` |
| `CopyPastMenu` | `CopyPastMenu.jsx` | Copy/paste menu for parameter arrays |
| `ToolBar` | `ToolBar.jsx` | Main application toolbar |
| `BackendStatusIndicator` | `BackendStatusIndicator.jsx` | Health status badge (healthy/crashed/disconnected) with backend start/stop controls |
| `BackendConsole` | `BackendConsole.jsx` | Backend process stdout/stderr console viewer |
| `CalibrationPanel` | `CalibrationPanel.jsx` | Mic-based volume calibration with two tabs (Volume Tuning, Curves). Volume Tuning: 5-level velocity selector (pp/p/mf/f/ff synced with Excitation panel), reference dB, Calibrate Synthesis, Calibrate Acoustic, precision profile. Curves tab mounts `CurveEditor` for the active velocity level. All long-running ops (Calibrate Synthesis, Calibrate Acoustic, Measure Precision) show a shared progress bar via `GET /calibration_status` polling with completion/error indication. When the status payload reports `clipping_pass: true` (Calibrate Synthesis re-running every pitch at a reduced target after clipping detection — see [REST API — GET /calibration_status](../pianoid-middleware/REST_API.md#get-calibration_status)), the progress box labels the rerun "Pass 2/2: clipping correction" with a warning caption + warning-colored bar, so the legitimate `progress` restart is not mistaken for an unexplained loop |
| `CurveEditor` | `CurveEditor.jsx` | Per-level calibration coefficient curve editor for the Curves tab. Renders `{positions, coefficients}` from `GET /calibration_curve?level=<lk>` as an ECharts line chart (88-pitch x-axis). Supports drag-to-paint via low-level ZRender handlers (`mousedown`/`mousemove`/`mouseup`/`globalout`) attached in `onChartReady` — pixel x snaps to nearest pitch via `convertToPixel('grid', [i,0])`, pixel y converts to coefficient via `convertFromPixel('grid', [0,y])` and clamps to `[0.01, 20.0]`. Painted updates accumulate in a `paintedRef` accumulator (pitch_id → value) and commit via 300ms-debounced `POST /calibration_curve` (`mouseup`/`globalout` flush immediately), then re-fetch authoritative state. Toolbar buttons (Flat / Follow / Apply / Revert / Save / Load) use the `/calibration_curve/{flat,follow,apply,revert,save,load}` endpoints. RCM toggle drives reference-point capture mode. Ctrl+click on a reference point removes it via `/calibration_curve/rcm/remove` |
| `TimingBandEditor` | `TimingBandEditor.jsx` | Editable frequency-dependent timing bands (settle, skip, window) for calibration |
| `ModalAdapter` | `modules/ModalAdapter.jsx` | Modal extraction panel with compact toolbar UI. **Toolbar** (left to right): server status chip (On/Off, clickable to start), pipeline section ButtonGroup (Collect / Setup / Tracking / Apply with status indicators — checkmark for done, spinner for running; Collect is the B-3 measurement-collection tab and has no toolbar status indicator since the panel owns its own status chip), and right-aligned play buttons (play current step, skip-to-end, both show stop icon when running; play buttons + settings gear are hidden on Collect — the panel owns its own Start/Cancel and config UI, separate from the ESPRIT pipeline state machine). Setup button shows current project name when a project is open. **Settings gear/lock icon lives in the native MosaicWindow title bar** (not inline in the pane body) — rendered via `ReactDOM.createPortal` into the `.mosaic-window-controls` container from a `useLayoutEffect` hook. The same hook hides the generic `button[title="Settings"]` injected by `PianoidTuner.renderToolbarControls` so exactly one settings gear appears on the title bar. Clicking it toggles the collapsible Collapse/Paper settings panel mounted below the toolbar (only mounted on Setup/Tracking/Apply via the internal `PIPELINE_RUN_SECTIONS` list). **Settings panel** content changes per active section: Setup shows channel roles (MappingEditor) + ESPRIT config (EspritConfig), Tracking shows freq tolerance and max gap, Apply shows merge mode and sound output mapping. **All settings freeze** (disabled + lock icon) once ESPRIT processing starts (running or done). Connects to modal adapter server on port 5001. See [MODAL_ADAPTER_GUIDE](../../guides/MODAL_ADAPTER_GUIDE.md) |
| `CollectPanel` | `components/CollectPanel.jsx` | **B-3 measurement-collection UI** mounted in the ModalAdapter pane's Collect tab. Owns form state for one scenario collection: scenario number (NumInput, 0–87 per direction Q3 — positional, not a pitch picker), project directory (TextField; pre-filled from `useModalAdapter.projectDir` when a project is open, decoupled after first user edit), and 6 high-impact recorder config fields per direction Q2 (sample_rate / num_pulses / volume / num_measurements + input_device / output_device Select populated from `GET /modal/collect/devices`). Renders an MUI dark-theme Chip for `phase` (idle/pausing/recording/saving/resuming/done/cancelled/error) — colour PAIRS WITH a text label so colour is never the only indicator (accessibility). LinearProgress bound to `progress_pct` while non-terminal. Output paths list rendered after `phase === "done"`. All REST/polling lifecycle is delegated to the `useMeasurementCollection` hook; the panel owns only form state and presentation. Recorder config is a collapsible Paper (default-open) with the 4 numeric NumInputs + 2 device Selects + a Refresh device list button. Full schema viewer (every recorderConfig.json key) is deferred to Wave B-2 (per Q2). See [MODAL_COLLECTION.md](../pianoid-middleware/MODAL_COLLECTION.md) for the backend contract |
| `MappingEditor` | `MappingEditor.jsx` | Channel role assignment (force/response/reference/skip) with bridge boundary and pitch offset. Shown in Setup settings panel (gear icon), locked (disabled) when ESPRIT has started. Sound channel mapping is separate — in Apply settings panel |
| `EspritConfig` | `EspritConfig.jsx` | Band preset selector + GPU checkbox + disabled prop for freeze. Advanced toggle reveals per-band table (name, f_min, f_max, order, decimation, exp_factor, model_order, window_length) |
| `ModalResultsView` | `ModalResultsView.jsx` | Stabilization diagram wrapper, collapsible mode chain table, per-mode shape plot, feedin heatmap |
| `StabilizationDiagram` | `StabilizationDiagram.jsx` | ECharts scatter plot of mode chains with stability coloring, unified zoom system (brush-to-zoom + scroll-wheel zoom with cursor-centered log-aware Y axis, single `viewBounds` state, Reset button for any zoom source), chain paths (visible by default), chain visibility filter (Stable/+Semi/All/Unasgn), heatmap color mode (damping/amplitude), bridge boundary markLine with "Bass \| Treble" label, **selected chain info chips** (mean frequency, mean damping, point count per chain, colored by stability), sub-charts for selected chains (Damp/Amp/MAC/Shape/Proj — independent toggles, zoom-synced X-axis). Shape sub-chart phase-aligns scenarios within each chain (dot product sign flip against reference) for consistent visual comparison. Above the Shape sub-chart, a `ToggleButtonGroup` of channel numbers plus an OFF button lets the user pick an optional anchor channel — when an anchor is set, every displayed curve is multiplied by `1/curve[anchor]` so all curves pass through +1 at that channel (with a `|value| < 1e-12` near-zero guard leaving degenerate curves untouched), a dashed vertical markLine marks the anchor, and the Y-axis label becomes `Shape (norm @ Ch<N>)`. When an anchor is active, Y axis is clipped to the 5th–95th percentile of y-values (padded 10%, rounded to nice tick boundaries, always containing +1) so outlier curves with near-zero at the anchor don't stretch the readable range. Default is OFF (raw unphased, auto-range); toggling the Shape sub-chart off resets the anchor to null. Clicking selects all lines crossing the click area (5% Y-range tolerance) and highlights their corresponding points on the main chart (white diamond, orange glow). Full-bridge chains (`bridge="full"`) render with a gap at the boundary. Shows ESPRIT data as unassigned dots even before tracking. Centralized brush lifecycle via generation counter — `handleBrushSelected` starts with an empty-areas echo guard (prevents feedback loops from ECharts's `brushVisual` -> throttled `brushSelect` re-entry) then runs its body in try/finally so the clear dispatch and generation bump always run on real user events; the lifecycle effect owns cursor re-arm (takeGlobalCursor). Orphaned zrender covers — created when `brushselected` fires mid-drag and ECharts's `BrushController.updateCovers([])` skips `group.remove` due to its `_creatingCover !== oldCover` guard — are swept by `forceRemoveOrphanedCovers()` which walks `inst._componentsViews -> brush view -> _brushController` and removes any `group.children()` entry not tracked in `_covers`. Called from the echo path, the finally block, and the lifecycle effect. Accepts `interactionMode` for editing integration |
| `StabilizationToolbar` | `StabilizationToolbar.jsx` | MUI ToggleButtonGroup for chain editing modes (select/addPoint/drawChain/connect/break/dissolve) with undo/redo/save/discard buttons |
| `ObjectInspector` | `ObjectInspector.jsx` | Property-grid renderer for arbitrary settings buckets (one bucket per `<PaneSettingsDialog>` instance). `PARAMETER_CONFIG` declares per-field display name + field type. **Three explicit-config types:** `type:"select"` enums (Build Mode, Cycle Iterations, Audio Driver, Audio Buffer Size, Block Size, Listen Mode, Sound Derivative) render an MUI `<Select>`; `type:"boolean"` fields (the 5 binary preset-load params — Use Simulation, Start Right Away, Audio On, Listen to MIDI, Use CUDA) render an MUI `<Switch size="small">` (dev-toggle-ui, 2026-05-15); other **numeric fields (`typeof value === "number"` OR `PARAMETER_CONFIG[k].type === "number"`) delegate to `<NumInput>`** for cursor-step / wheel / min-max-clamp behavior (dev-f259, 2026-05-01). Strings keep the legacy `<input type="text">` fallback. Branch order in `renderInput` matters — the `type:"boolean"` check runs *before* the numeric check because the 5 binary fields store 0/1 *numbers* and would otherwise be caught as numeric. The Switch maps `checked = (value === 1)` and writes `1`/`0` on toggle (via `handleSelectChange`, the verbatim path — no parseFloat coercion), so the stored 0/1 integer type is preserved and the `/load_preset` payload contract is unchanged. |
| `FileUploader` | `FileUploader.jsx` | File upload widget for preset loading (native OS file picker) |
| `FolderBrowser` | `FolderBrowser.jsx` | Folder picker using native OS dialog via `POST /open_folder_dialog` (on modal adapter server, port 5001). Uses tkinter subprocess for thread safety. |
| `Zoomer` | `Zoomer.jsx` | Zoom control for chart views |
| `TestChart` | `TestChart.jsx` | Test/debug chart component |
| `ModeWaveChart` | `ModeWaveChart.js` | Waveform chart for a single mode |
| `ModesRule` | `ModesRule.js` | Modes ruler/axis component |
| `MatrixTable` | `MatrixTable.js` | Raw HTML table for matrix data |
| `ContinuousPressButton` | `ContinuousPressButton.js` | Button that fires repeatedly while held |
| `PresetPanel` | `PresetPanel/PresetPanel.jsx` | Mosaic pane for preset loading + library management. Sections: a named-startup-config switcher (`PresetConfigBar`), Current Preset, Library, footer Apply (see "Preset Panel" below). The previous monolithic Settings pane was extracted into this dedicated pane (dev-a328, 2026-05-01). Working-copy model (dev-bfe2, 2026-05-18): the Library list renders entry records — a lock icon for read-only `original` entries, an "editable" chip + `source` caption for `working` copies; per-entry Spawn working copy / Promote (working copies only, behind a confirm dialog) / Unload actions |
| `PresetConfigBar` | `PresetPanel/PresetConfigBar.jsx` | Named-startup-configuration switcher row at the top of `PresetPanel` (dev-startup-configs, 2026-05-16). Config-name `<Select>` + Save / Save As / Rename / Delete / Export / Import icon buttons + a reused name-prompt Dialog. Pure controlled component — every mutating action calls a `useSettings` callback. See "Named startup configurations" under `useSettings` |
| `PaneWithSettings` | `PaneWithSettings.jsx` | Generic HOC that wraps any pane with a portaled gear icon in the MosaicWindow title bar + a `<PaneSettingsDialog>` bound to one settings bucket. Replaces the monolithic Settings pane / central PropertyManager-routing pattern (dev-a328, 2026-05-01). Accepts a `readOnly` prop (dev-bfe2, 2026-05-18): when true (a read-only `original` preset is active) it renders a lock banner + a pointer-events overlay over the wrapped editor — one chokepoint locks all six parameter-editor panes. The 6 editors (Strings, Modes, Excitation, Feedin, Feedback, Sound Channels) pass `readOnly={activePresetReadOnly}`; Charts / Virtual Piano / Workbench do not (they do not edit preset params). The backend is still the read-only authority (HTTP 409 `preset_read_only`); the overlay is UX |
| `PaneSettingsDialog` | `PaneSettingsDialog.jsx` | MUI Dialog wrapping `<ObjectInspector>` for one settings bucket. Snapshots a fresh `PropertyManager` on open; commits via `setSettings(newProps)` AND closes on Apply (the ObjectInspector's internal Apply button is the canonical commit path — DialogActions are intentionally omitted to avoid duplication) |

---

## Custom Hooks

All hooks live in `src/hooks/`.

### `usePreset`

The primary data-management hook. Owns all preset state and provides debounced API calls (300 ms debounce) for every parameter category. A `loadingRef` guard prevents concurrent `loadPreset()` calls — a second call while one is in-flight is silently skipped to avoid destroying the pianoid instance mid-initialization.

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

### `useSettings`

Manages all UI configuration state, persisted to `localStorage`. Parameter categories with their own state objects:

| State | localStorage key | Contents |
|---|---|---|
| `presetLoadSettings` | `presetLoadSettings` | Path, volume, sample_rate, string_iterations, number_of_modes, use_cuda, audio_driver_type (ASIO=1, SDL=2, ASIO_CALLBACK=4), audio_buffer_size, cycle_iterations, array_size (384/512), debug_mode (0=release, 1=debug build + extraction), listen_to_modes (0=strings, 1=modes). **This is the LIVE/active startup-configuration bucket** — kept equal to the active entry of `presetLoadConfigs` (see "Named startup configurations" below) |
| `presetLoadConfigs` | `presetLoadConfigs` | `{ name -> settingsObject }` map of all named startup configurations |
| `activePresetLoadConfig` | `activePresetLoadConfig` | Name of the currently selected startup configuration |
| `virtualPianoSettings` | `virtualPianoSettings` | Key colours, velocity, range display |
| `modesSettings` | `modesSettings` | Auto-select, decimal places, `visualization` (bar/line) |
| `stringsSettings` | `stringsSettings` | Auto-select, decimal places, `visualization` (bar/line) |
| `chartSelectorSettings` | `chartSelectorSettings` | Show all parameters toggle |
| `feedInSettings` | `feedInSettings` | Piano height, modes width, `visualization` (bar/line) |
| `feedbackSettings` | `feedbackSettings` | Piano height, modes width, `visualization` (bar/line) |
| `soundChannelSettings` | `soundChannelSettings` | Piano height, modes width, aggregate mode, `visualization` (bar/line; **default `line`** per Wave 3 of drawable-chart merge — aggregate view reads smoother as a line) |
| `workbenchSettings` | `workbenchSettings` | `visualization` (bar/line) — governs both the default Workbench pane and every dynamic workbench clone |
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

**UI.** `<PresetConfigBar>` (Section 0 at the top of the PresetPanel body) renders a config-name `<Select>` + Save / Save As / Rename / Delete / Export / Import icon buttons + a reused name-prompt Dialog (Save As + Rename, with inline duplicate/empty validation) + a transient feedback caption. It is a pure controlled component — every mutating action calls a `useSettings` callback threaded through `PresetPanel` and `PianoidTuner.js`.

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

Layout is persisted to `localStorage` under `mosaicLayout`. Exposes `handleMaximize(id)` (saves backup, expands one pane to full screen), `handleRestore()` (restores backup), `handleDefaultLayout()` (resets to initial).

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

Tracks the current UI selection state — which pitch, range of pitches, which modes, which parameter, which velocity level, and which Gaussian component are currently selected. Acts as a shared selection context consumed by multiple components.

### `useMatrixHistory`

Tracks edit history for the feedin/feedback matrices to support undo operations.

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

### `useMeasurementCollection`

**Wave B-3 measurement-collection hook** that wraps the `/modal/collect/*` REST surface (port 5001 — see [MODAL_COLLECTION.md](../pianoid-middleware/MODAL_COLLECTION.md) for the canonical contract). Sole owner of the server-side session-status mirror, the SDL3 device list, and the 1000ms polling lifecycle. Lives at `src/hooks/useMeasurementCollection.js` and backs `CollectPanel.jsx`.

State (P1 — sole writer rule): `status` (mirror of `GET /modal/collect/status`), `devices` (mirror of `GET /modal/collect/devices`), `error` (last REST error message; user-facing, dismissable via `clearError()`), `isStarting` / `isCancelling` (in-flight flags), `isPolling` / `isActive` (lifecycle derived state). Form fields (scenario_number, project_dir, recorder_config) live in `CollectPanel` itself — the hook does not own them.

Polling lifecycle: `start()` issues `POST /modal/collect/start`, optimistically bumps the local phase to `pausing`, then enables the 1000ms `setInterval`. Each tick calls `GET /modal/collect/status`; when `phase` enters a terminal value (`done`, `cancelled`, `error`, or `idle`), polling stops automatically. `cancel()` POSTs `/modal/collect/cancel` and forces one immediate status refresh so the UI sees the new phase without waiting a full poll tick. `refreshDevices()` and `refreshStatus()` are exposed for UI-driven manual refresh.

Exposes: `{ status, devices, error, isStarting, isCancelling, isPolling, isActive, start(scenarioNumber, projectDir, recorderConfig), cancel(), refreshDevices(), refreshStatus(), clearError() }`. Optimistic local phase update on `start()` is bounded — the next poll tick replaces it with the canonical backend state, which means a `409 Measurement already running` response surfaces as `error` plus the unchanged backend phase, never as a phantom `pausing` chip.

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

---

## Preset Panel + Per-Pane Settings Popup Pattern (dev-a328, 2026-05-01)

The Pianoid frontend originally exposed a single monolithic `Settings` mosaic pane. That pane was a generic `<ObjectInspector>` that rotated through 9 different settings buckets (`presetLoadSettings`, `virtualPianoSettings`, `modesSettings`, etc.) — clicking the gear icon on any other pane set `currentPropertyManagerName`, which swapped which bucket the Settings pane displayed. This conflated two concerns: (1) preset loading + initialization parameters, (2) per-pane local UI settings.

The dev-a328 refactor (3 phases, branch `feature/preset-panel-and-popup-settings`, merged into `dev`) split these concerns:

### Preset panel

A dedicated `PresetPanel` mosaic pane (`src/components/PresetPanel/PresetPanel.jsx`) replaces the legacy Settings pane in the default layout. Sections, top-to-bottom:

0. **Startup Configuration** — the `<PresetConfigBar>` named-config switcher row: a config-name `<Select>` + Save / Save As / Rename / Delete / Export / Import icon buttons (dev-startup-configs, 2026-05-16). See "Named startup configurations" under `useSettings`.
1. **Current Preset** — overline header + filename in monospace + Load (file-picker) IconButton + Reload (UTurnRight) IconButton (only visible when a preset has loaded) + a Save-As `<TextField>` paired with a Save IconButton.
2. **Library** — overline header + Refresh + Add (+) buttons (right-aligned) + a scrollable MUI `<List>` of library entry **records** from `usePreset` (working-copy model, dev-bfe2, 2026-05-18). Each row renders its `kind`: a lock icon + `source`/path caption for read-only `original` entries, an "editable" chip + `source` caption for `working` copies. Active preset is highlighted (`selected` ListItemButton + bold). Click a row → `switchPreset(name)`. Per-entry trailing actions: Spawn working copy (all entries), Promote to original (working copies only — behind a confirm dialog, since it overwrites the original's on-disk JSON), Unload.
3. **Footer Apply** — full-width primary contained Button. Clicking it bumps `_applyTs` and re-fires the existing `useEffect(() => ensureBackendAndLoadPreset(...), [presetLoadSettings])` cycle.

The pane's title bar carries a portaled gear icon (tooltip "Preset initialization parameters") that opens a `<PaneSettingsDialog>` bound to `presetLoadSettings`. The dialog displays the 17 initialization-parameter fields, grouped by widget: `path` is a text input; `volume` / `sample_rate` / `string_iterations` / `number_of_modes` are `<NumInput>` numeric fields; `Build Mode` / `Cycle Iterations` / `Audio Driver` / `Audio Buffer Size` / `Block Size` / `Listen Mode` / `Sound Derivative` are MUI `<Select>` enums; and the 5 binary on/off fields — `Use Simulation`, `Start Right Away`, `Audio On`, `Listen to MIDI`, `Use CUDA` — render as MUI `<Switch>` toggles (dev-toggle-ui, 2026-05-15; previously bare 0/1 `<NumInput>` floats). The Switch toggle still stores 0/1 integers, so the `/load_preset` payload is unchanged. Apply commits via `setPresetLoadSettings({ ...newProps, _applyTs: Date.now() })` AND closes the dialog.

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
