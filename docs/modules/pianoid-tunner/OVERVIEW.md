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
| react-router-dom | ^7.1.3 | Client-side routing |
| react-icons | ^5.4.0 | Icon components |
| styled-components | ^6.1.15 | CSS-in-JS |

Build: `react-scripts 5.0.1` (CRA), output at `build/`.

### Backend Process Launcher

`server/launcher.js` — Node.js script that spawns and manages the Flask backend (`backendServer.py`) as a child process. Used by `useBackendProcess` hook to start/stop the backend from the frontend UI.

REST endpoints: `POST /api/start-backend`, `POST /api/stop-backend`, `POST /api/kill-stale`, `GET /api/backend-status`. WebSocket at `/ws/console` streams stdout/stderr and process status. `start-backend` automatically kills any stale process on port 5000 before spawning. `kill-stale` kills any process on port 5000 without starting a new one.

---

## Application Entry Point

`src/App.js` is the root component. It renders a static toolbar with Load/Save, Reset, and module-toggle buttons, plus a dynamic panel region where individual module components are conditionally mounted based on toggle state. The backend URL is hardcoded as `http://127.0.0.1:5000`.

Top-level modules visible in `App.js`:
- `Connection.Load` — preset file picker and load/save workflow
- `Deck` — feedin/feedback matrix editor
- `Excitation` (`src/modules/Excitation`) — hammer and Gauss parameter editor
- `Modules.StringModule` — string physical parameter editor
- `PianoKeyboard` — standalone keyboard display
- `MidiComponent` — MIDI device status
- `GaussDemo` — always-visible Gaussian curve preview

The main application entry used in production is a separate top-level component (not App.js) that integrates the mosaic layout; `App.js` represents the original single-file layout.

---

## Component Architecture

### Primary Editing Components

| Component | File | Purpose |
|---|---|---|
| `PianoKeyboard` | `PianoKeyboard.jsx` | 88-key visual keyboard, key selection, note highlighting |
| `PianoKey` | `PianoKey.jsx` | Individual key rendering with state colours |
| `VirtualPiano` | `VirtualPiano.js` | Compact virtual piano with range selection and fixed-velocity mode |
| `VerticalPiano` | `VerticalPiano.jsx` | Vertically-oriented pitch selector used in matrix views |
| `MidiComponent` | `MidiComponent.jsx` | MIDI device connection status display |
| `ModeSelector` | `ModeSelector.jsx` | Mode index selector |
| `Mode` | `Mode.jsx` | Single-mode parameter display (frequency, decrement, mass, stiffness) |
| `ModeMenu` | `ModeMenu.jsx` | Mode editing toolbar |
| `Strings` | `Strings.jsx` | String parameter editor (tension, string_stiffness, string_damping, string_radius, string_density, etc.) |
| `Hammers` | `Hammers.jsx` | Hammer overview across pitches |
| `HammerSpatialProperties` | `HammerSpatialProperties.jsx` | Per-pitch hammer shape editor (position, width, sharpness) |
| `Excitation` | `Excitation.jsx` | Gauss parameter editor for hammer excitation curves |
| `ExcitationProperties` | `ExcitationProperties.jsx` | Single-pitch excitation properties panel |
| `GaussEditor` | `GaussEditor.jsx` | Interactive Gauss curve editor |
| `GaussChart` | `GaussChart.jsx` | Chart rendering of a Gaussian excitation curve |
| `GaussDemo` | `GaussDemo.jsx` | Live preview of all 5 Gaussian components |
| `CompositeGaussianChart` | `CompositeGaussianChart.jsx` | Composite view of all Gauss curves at one velocity level |
| `GaussianParameterGrid` | `GaussianParameterGrid.jsx` | Grid of Gauss parameters (mu, sigma, volume, shift) across levels |
| `GaussCell` | `GaussCell.jsx` | Single cell in the Gauss parameter grid |
| `VelocitySelector` | `VelocitySelector.jsx` | Selects which of the 5 base velocity levels to edit |
| `PitchesModesMatrix` | `PitchesModesMatrix.jsx` | 2-D heatmap of pitches × modes for feedin/feedback |
| `PitchesModesMatrixCanvas` | `PitchesModesMatrixCanvas.jsx` | Canvas-rendered version of the matrix |
| `MeasuredMatrix` | `MeasuredMatrix.jsx` | Matrix with measurement overlays |
| `MatrixTools` | `MatrixTools.jsx` | Toolbar for matrix operations (normalise, scale, reset) |
| `BarChart` | `BarChart.jsx` | Horizontal bar chart for per-mode or per-pitch values |
| `BarChartGrid` | `BarChartGrid.jsx` | Grid of bar charts |
| `BarChartValue` | `BarChartValue.jsx` | Editable numeric bar chart cell |
| `VerticalColumn` | `VerticalColumn.jsx` | Vertical bar column component |
| `VerticalColumnChart` | `VerticalColumnChart.jsx` | Multi-column vertical chart |
| `ChartSelector` | `ChartSelector.jsx` | Dropdown for selecting chart type from `/graph_names` response |
| `newWindowChart` | `newWindowChart.jsx` | Chart rendered in a mosaic pane |
| `ParameterEditor` | `ParameterEditor.jsx` | Generic numeric parameter editor |
| `PropertyInput` | `PropertyInput.jsx` | Labelled numeric input with validation |
| `NumericInput` | `NumericInput.jsx` | Standalone numeric input field |
| `NumInput` | `NumInput/NumInput.js` | MUI-styled numeric input |
| `RowEditor` | `RowEditor.js` | Editable table row for matrix data |
| `PitchTools` | `PitchTools.jsx` | Pitch-level action toolbar (play, reset, copy) |
| `CopyPastMenu` | `CopyPastMenu.jsx` | Copy/paste menu for parameter arrays |
| `ToolBar` | `ToolBar.jsx` | Main application toolbar |
| `BackendStatusIndicator` | `BackendStatusIndicator.jsx` | Health status badge (healthy/crashed/disconnected) with backend start/stop controls |
| `BackendConsole` | `BackendConsole.jsx` | Backend process stdout/stderr console viewer |
| `ObjectInspector` | `ObjectInspector.jsx` | Debug inspector for arbitrary state objects; includes Block Size dropdown (array_size: 256/384/512) in Settings panel |
| `FileUploader` | `FileUploader.jsx` | File upload widget for preset loading |
| `Zoomer` | `Zoomer.jsx` | Zoom control for chart views |
| `TestChart` | `TestChart.jsx` | Test/debug chart component |
| `ModeWaveChart` | `ModeWaveChart.js` | Waveform chart for a single mode |
| `ModesRule` | `ModesRule.js` | Modes ruler/axis component |
| `MatrixTable` | `MatrixTable.js` | Raw HTML table for matrix data |
| `ContinuousPressButton` | `ContinuousPressButton.js` | Button that fires repeatedly while held |

---

## Custom Hooks

All hooks live in `src/hooks/`.

### `usePreset`

The primary data-management hook. Owns all preset state and provides debounced API calls (300 ms debounce) for every parameter category.

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

### `useMidi`

Wraps the Web MIDI API. Requests `navigator.requestMIDIAccess()`, attaches `onmidimessage` handlers to all input ports, and tracks connection state changes.

Exposes: `midiIsConnected`, `midiLog`, `midiKeysDown`, `midiLastKeyDown`, `midiLastKeyUp`, `midiReconnect()`, `midiClearLog()`.

Each MIDI message is forwarded to an optional `playNote` callback with `{ pitch, command, velocity }`.

### `useSettings`

Manages all UI configuration state, persisted to `localStorage`. Parameter categories with their own state objects:

| State | localStorage key | Contents |
|---|---|---|
| `presetLoadSettings` | `presetLoadSettings` | Path, volume, sample_rate, string_iterations, number_of_modes, use_cuda, audio_driver_type (ASIO=1, SDL=2, ASIO_CALLBACK=4), audio_buffer_size, cycle_iterations, array_size (384/512), debug_mode (0=release, 1=debug build + extraction) |
| `virtualPianoSettings` | `virtualPianoSettings` | Key colours, velocity, range display |
| `modesSettings` | `modesSettings` | Auto-select, decimal places |
| `stringsSettings` | `stringsSettings` | Auto-select, decimal places |
| `chartSelectorSettings` | `chartSelectorSettings` | Show all parameters toggle |
| `feedInSettings` | `feedInSettings` | Piano height, modes width |
| `feedbackSettings` | `feedbackSettings` | Piano height, modes width |

Includes `migratePresetSettings()` which renames old parameter keys (`user_1` → `audio_driver_type`, `user_3` → `audio_buffer_size`) in-place in localStorage on first load.

### `useLayout`

Manages the `react-mosaic-component` tile layout tree. The initial layout places the following named panes:

```
Settings | Charts / NumInputTest
---------+-----------------------------------------------------
MIDI+Strings | Feedin / Feedback | Virtual Piano | Modes
                                               |
                                           Workbench
```

Layout is persisted to `localStorage` under `mosaicLayout`. Exposes `handleMaximize(id)` (saves backup, expands one pane to full screen), `handleRestore()` (restores backup), `handleDefaultLayout()` (resets to initial).

### `useCurrentValues`

Tracks the current UI selection state — which pitch, range of pitches, which modes, which parameter, which velocity level, and which Gaussian component are currently selected. Acts as a shared selection context consumed by multiple components.

### `useMatrixHistory`

Tracks edit history for the feedin/feedback matrices to support undo operations.

### `useValuesHistory`

Tracks edit history for generic parameter arrays.

### `useBackendProcess`

Manages the Flask backend process lifecycle from the frontend. Launches `server/launcher.js` (Node.js) which spawns the Python backend, monitors its stdout/stderr, and handles restart/shutdown. Exposes: `startBackend()`, `stopBackend()`, `killStale()`, `backendOutput` (log lines), `isRunning`.

`killStale()` calls `POST /api/kill-stale` on the launcher, which runs `killProcessesOnPort(5000)` to terminate any process holding the backend port — regardless of whether the launcher spawned it.

### `useWindowManager`

Manages the set of open/closed mosaic panes and their IDs.

---

## Mosaic Window Management

The application uses `react-mosaic-component` to implement a tiling window manager. The layout is a binary tree where each leaf node is a string ID (e.g., `"Feedin"`, `"Modes"`, `"Virtual Piano"`) and each internal node specifies a split direction and percentage.

`useLayout` owns the tree and provides helpers to maximize a single pane (replacing the whole tree with the leaf ID string) and restore the previous tree. Layout changes are saved to localStorage on every update.

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
