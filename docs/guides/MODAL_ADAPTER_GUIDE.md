# Modal Adapter Pipeline Guide

The Modal Adapter panel converts impulse response measurements of a real piano into synthesis
presets for the Pianoid engine. It extracts vibrational modes (frequencies, damping ratios, and
spatial shapes) from measurement data using the ESPRIT algorithm, tracks them across excitation
points, computes feedin coupling coefficients, and injects the results into the active preset.

## Architecture

The Modal Adapter runs as a **separate Flask server** (`modal_adapter_server.py`, port 5001)
from the main Pianoid backend (port 5000). This separation is required because CuPy GPU
operations (used by ESPRIT) deadlock in non-main threads — the modal adapter server runs
single-threaded (`threaded=False`) so ESPRIT executes on the main thread.

| Server | Port | Role |
|--------|------|------|
| `backendServer.py` | 5000 | Pianoid synthesis, parameter editing, playback |
| `modal_adapter_server.py` | 5001 | ESPRIT extraction, mode tracking, project management |

Both servers run simultaneously. Before ESPRIT extraction, the frontend pauses synthesis
on port 5000 (`POST /pause_synthesis`) to free GPU, and resumes after (`POST /resume_synthesis`).
The Node.js launcher (`server/launcher.js`) manages both processes.

## Algorithm Overview

The Modal Adapter uses the **ESPRIT** (Estimation of Signal Parameters via Rotational Invariance Techniques) algorithm to extract modal parameters from impulse response measurements. Given a recorded impulse response of a piano soundboard, ESPRIT identifies the individual vibrational modes — each characterized by a frequency, damping ratio, and spatial shape.

### Key Steps

1. **Band-splitting** — The full frequency range (30--5000+ Hz) is divided into overlapping bands (e.g., 4 or 8 bands). Each band is analyzed independently with a modest model order, which is far more tractable than fitting a single high-order model to the entire spectrum.

2. **Hankel matrix construction** — For each band, a Hankel (data) matrix is built from the decimated, bandpass-filtered impulse response signal.

3. **SVD decomposition** — Singular Value Decomposition separates the signal subspace from noise. The number of retained singular values corresponds to the expected number of modes in that band.

4. **Shift-invariance pole extraction** — The ESPRIT shift-invariance property is exploited to estimate poles (complex eigenvalues). The **TLS** (Total Least Squares) variant provides better noise robustness than the standard LS variant by treating both subspace matrices symmetrically.

5. **Conjugate pairing** — Extracted poles come in conjugate pairs (since the underlying signal is real-valued). Pairs are matched and only one pole per pair is retained.

6. **Continuous-time conversion** — Discrete-time poles are converted to continuous-time via logarithmic mapping, yielding natural frequencies in Hz and dimensionless damping ratios (zeta).

7. **Band merging** — Modes from overlapping bands are deduplicated using the **MAC** (Modal Assurance Criterion), which compares mode shape similarity. When two bands detect the same physical mode, the detection with higher MAC confidence is retained.

### Output Per Scenario

- **frequency** — natural frequency in Hz (ndarray)
- **damping_ratio** — dimensionless ratio to critical damping, zeta (ndarray)
- **mode_shapes** — complex spatial pattern per mode per channel (complex ndarray, n_modes x n_channels)
- **poles** — continuous-time poles (complex ndarray)

### Why Band-Splitting?

A piano soundboard has hundreds of modes spanning 30 Hz to well above 5000 Hz. Fitting all modes at once would require an impractically large model order, leading to numerical instability and excessive computation. Band-splitting keeps each sub-problem small (model orders of 8--30 per band) while collectively covering the full range. Overlapping band edges ensure no modes are missed at boundaries; the MAC-based deduplication removes any double-counted modes.

---

## Data Formats

This section documents the data shapes and units at each stage of the pipeline.

### Input

- **Per scenario:** `(T, n_channels)` numpy array — a multi-channel impulse response recording. `T` is the number of time samples; `n_channels` is the number of measurement channels (accelerometers/microphones along the bridge, plus optional force channel).

### ESPRIT Extraction Output (per scenario)

| Field | Type | Description |
|-------|------|-------------|
| `frequencies` | ndarray (n_modes,) | Natural frequencies in Hz |
| `damping_ratios` | ndarray (n_modes,) | Dimensionless damping ratios (zeta) |
| `mode_shapes` | complex ndarray (n_modes, n_channels) | Complex spatial pattern per mode |
| `poles` | complex ndarray (n_modes,) | Continuous-time poles |

### Tracking Output

Mode tracking links per-scenario detections into **ModeChain** objects:

| Field | Type | Description |
|-------|------|-------------|
| `frequency_mean` | float | Mean frequency across detections (Hz) |
| `damping_mean` | float | Mean damping ratio across detections (dimensionless zeta) |
| `stability` | str | Classification: `stable`, `semi-stable`, `weak`, or `spurious` |
| `detections` | dict | Map of scenario index to detection data |

Each detection within a chain includes:

| Field | Type | Description |
|-------|------|-------------|
| `amplitude` | float | RMS mode shape amplitude = `sqrt(mean(\|shape\|^2))` |
| `shape_magnitudes` | ndarray (n_channels,) | Phase-rotated real projections preserving sign (for visualization) |

### Feedin Output

- **Per pitch:** FFT magnitude evaluated at each mode frequency — measures coupling strength between the excitation point and each mode.
- **Measured pitches:** Pitches with direct measurement data.
- **Interpolated pitches:** Pitches where feedin is interpolated from neighboring measurements.

### Preset Conversion

When injecting into a synthesis preset, damping ratios are converted to the engine's native parameters:

| Parameter | Formula | Description |
|-----------|---------|-------------|
| Logarithmic decrement | `delta = 2*pi*zeta / sqrt(1 - zeta^2)` | Continuous-time decay parameter |
| Decrement coefficient (dec) | `dt * decrement * frequency` | Discrete-time decay per sample |
| Omega | `dt^2 * frequency^2 * 4*pi^2` | Discrete-time squared angular frequency |

Where `dt = 1 / sample_rate` and `decrement` = logarithmic decrement.

---

## Project Management

All data is organized by **projects**. Each project stores measurements, ESPRIT results,
tracking chains, and feedin data in a self-contained directory:

```
{projects_base}/          # default: {PianoidInstall}/modal_projects
  {project_name}/
    project.json          # metadata: name, created, sample_rate, scenarios, channels
    measurements/
      scenario_3.npy      # combined (T, n_channels) array per scenario
      scenario_4.npy
      ...
    modal_adapter/
      esprit/             # per-scenario extraction results
      tracking/           # tracked chains with stability
      feedin/             # per-pitch feedin coefficients
      mapping/            # channel mapping config
      output/             # generated presets
```

Projects can be created from measurement folders (RoomResponse or flat `.npy` format),
cloned from existing projects, or reopened across sessions. Measurement data is copied
into the project as combined `.npy` files — the original source is not needed after import.

---

## Layout Types

Each project has a **layout type** that describes the spatial arrangement of its
measurements. The layout type is stored on `MappingConfig` and persisted to
`mapping_config.json`.

| Layout | Description | Pitch derivation? | Tracking method |
|--------|-------------|-------------------|-----------------|
| `line` (default) | Scenarios laid out along a 1-D bridge; bass/treble bridge split applies; `pitch = scenario_index + pitch_offset`. | Yes (line-mode `feedin_extractor` → `preset_injector`) | `sliding_window` (default) or `sequential` (DEPRECATED — emits `DeprecationWarning`) |
| `grid` | Scenarios laid out on a 2-D rectangular grid (square spacing); populated cells form an arbitrary shape inside the bounding box. | **Not in this PR** — see [`BRIDGE_FROM_GRID.md`](../development/proposals/BRIDGE_FROM_GRID.md) | `sliding_window` only (sequential explicitly raises `NotImplementedError`) |

For grid layout, the project schema gains four extra fields on `MappingConfig`:

| Field | Type | Meaning |
|-------|------|---------|
| `layout_type` | `"line" \| "grid"` | Layout selector |
| `grid_shape` | `[n_rows, n_cols]` | Bounding-box dimensions |
| `grid_spacing_mm` | float | Square cell spacing (dx = dy) |
| `cell_mask` | `bool[n_rows][n_cols]` | True where the cell is populated |
| `point_coordinates` | `{scenario_index: [x_mm, y_mm]}` | Physical coordinate per populated cell, row-major |

Pre-grid `mapping_config.json` files (no `layout_type`, no grid fields) load as
`layout_type="line"` — fully backward compatible.

The grid editor is a small MUI table inside the Setup section's settings panel. It lets
the user set rows / cols / spacing, click cells to toggle populated/empty, and offers
bulk shape buttons (All On / All Off / Invert). Scenario indices are auto-assigned in
row-major order over populated cells. Per-chain amplitude is visualised as a 2-D heatmap
above the stabilization diagram in the Tracking section (see "Tracking Section" below).

The grid layout terminates at the tracking visualisation step in this PR — no Apply / no
preset injection. See [`BRIDGE_FROM_GRID.md`](../development/proposals/BRIDGE_FROM_GRID.md)
for the deferred future work that closes the loop.

Algorithmic deltas for grid mode (extrapolate_frequency degradation, merge_split_chains
no-op, sequential method rejection) are documented in
[`MODE_TRACKING_GRID_LAYOUT.md`](../development/MODE_TRACKING_GRID_LAYOUT.md).

---

## UI Sections

The panel uses a **compact toolbar** instead of tabs. All navigation and actions are in a
single toolbar row, with a collapsible settings panel below it.

### Toolbar Layout

From left to right:

1. **Server status chip** — "On" (green) or "Off" (gray). Clickable to start the modal
   adapter server if it is not running.

2. **Project button** — displays the current project name, or "Select Project" if none is
   loaded. Shows a checkmark icon when a project is open. Clicking opens the project
   management panel (create, open, clone, delete projects).

3. **Pipeline section buttons** — a `ButtonGroup` with three buttons: **ESPRIT**,
   **Tracking**, **Apply**. Each button shows a status indicator: checkmark when the stage
   has completed data, spinner while running. Clicking a section button selects it as the
   active section (highlighting it and switching the settings panel content).

4. **Settings gear icon** — toggles the collapsible settings panel. The panel content is
   **context-sensitive** based on which pipeline section is active:
   - **ESPRIT** → EspritConfig (GPU checkbox, band preset, advanced per-band table)
   - **Tracking** → freq tolerance %, max gap
   - **Apply** → merge mode, sound output channel mapping

5. **Play buttons** (right-aligned):
   - **Play icon** (▶) — run the currently selected pipeline step
   - **SkipNext icon** (⏭) — run from the current step through to the end of the pipeline
   - Both buttons show a **Stop icon** (■) when their operation is running, allowing
     cancellation

Settings and individual Run/Apply buttons that were previously inside each section body
have been removed — the toolbar handles all actions.

### Project Management

Accessed by clicking the **Project button** in the toolbar.

**Open existing** -- click a project chip to load it. All intermediate data (measurements,
ESPRIT results, tracking chains) are restored automatically.

**Create new** -- enter project name + measurement folder path, click **Create**. Measurements
are imported as combined `.npy` files. Supports RoomResponse per-channel and flat `.npy` formats.

**Import from Zip** -- click the upload button to pick a `.zip` or `.pianoid-project` file.
The button is **smart-routed**:

- A `.pianoid-project` archive (one previously produced by **Export Project**) is
  unpacked into the projects base verbatim — same as the legacy import flow.
- Any other `.zip` is treated as a **measurement-data archive** (RoomResponse scenario
  folders or flat `.npy`). The zip is streamed to disk, extracted to
  `D:\modal_measurements\<name>\` (or `$PIANOID_MEASUREMENTS_DIR`), the parent
  directory containing scenario folders is auto-detected (handles both
  "scenarios at top of zip" and "scenarios one wrapping dir deep" layouts),
  and the project is created from that path in one HTTP call. The on-disk
  extraction is **kept** so you can re-create the project later without
  re-uploading the zip.

This removes the foot-gun where uploading a measurement-folder zip into the old
"Import Project" button failed with `Invalid archive: missing manifest.json` —
the same button now handles both cases. Multi-GB zips upload streamingly
(Werkzeug spools to disk, no in-memory buffering).

#### Auto-averaging missing `averaged_responses/`

A measurement-data zip often contains scenarios that ship `raw_recordings/` and
`metadata/` but **no** `averaged_responses/`. The Modal Adapter's ESPRIT consumer
requires `averaged_responses/average_ch{N}.npy`; without those files the scenario
is skipped during discovery.

The "Import from Zip" flow runs the canonical `RoomResponseRecorder` averaging
pipeline on every such scenario during import:

1. Per measurement, extract calibration-channel cycles from `raw_recordings/`
2. Validate cycles against the per-scenario `calibration_quality_config`
   (negative-peak amplitude, peak width, precursor / aftershock checks)
3. Align cycles by negative-peak position (circular shift) and filter by
   cross-correlation against the highest-energy reference cycle
4. Apply the same per-cycle shifts to every other channel
5. Normalize each response channel by the per-cycle calibration negative-peak
   magnitude (`normalize_by_calibration: true`)
6. Mean across all surviving cycles, then truncate to `ir_working_length_ms`
   (default 600 ms) with a Hann fadeout over the last `ir_fade_length_ms`

The pipeline is **idempotent** — pre-existing `averaged_responses/` files are
never overwritten. The implementation lives in
`pianoid_middleware/modal_adapter/scenario_averager.py` and re-uses the
canonical pure-numpy modules from the sibling `RoomResponse` repo
(`signal_processor.SignalProcessor` + `calibration_validator_v2`).

The response includes an `averaging_summary` field with counts:

```json
"averaging_summary": {
  "total_scenarios_examined": 30,
  "computed": 26,
  "skipped_existing": 4,
  "skipped_no_raw": 0,
  "skipped_no_metadata": 0,
  "errors": 0,
  "computed_scenarios": ["PlyWood-Scenario1-Take1", "PlyWood-Scenario3-Take1", "..."]
}
```

If the sibling `RoomResponse` repo isn't bootstrapped (CI machines without it),
each affected scenario falls through with `status: "error"` and a clear
diagnostic message; pre-averaged scenarios still import successfully.

**Clone** -- click a project name in "Or copy from" to create a copy with the same measurements.

**Channel roles** -- shown after project creation/clone. Assign each measurement channel a role:

| Role | Description |
|------|-------------|
| Response | Soundboard/bridge sensors — used for feedin extraction |
| Force | Hammer force channel — used for normalization |
| Skip | Ignore this channel |

Collapsed to a summary line once configured. Click **Edit** to change.

**Add measurements** -- add more scenarios from another folder to the current project.

### ESPRIT Section

**Scenario selector** -- choose which scenarios to extract. Processed scenarios are highlighted
green; unprocessed are gray. After extraction, selection auto-advances to unprocessed scenarios.
Supports range input (e.g. `0-10, 20, 30-40`), shift-click for ranges, All/None buttons.

**Band preset** -- `standard_4band` (faster) or `extended_8band` (higher resolution). GPU
checkbox enables CuPy-accelerated extraction. Click **Show Advanced** for the per-band table
with editable fields (name, f_min, f_max, filter_order, decimation, exp_factor, model_order,
window_length).

**Run ESPRIT** -- click the **Play** button in the toolbar (with ESPRIT selected) to process
selected scenarios one at a time. Each scenario runs synchronously on the modal adapter
server's main thread (CuPy GPU requirement). Progress shows current scenario,
elapsed/remaining time, and accumulated mode count. Results persist across runs — run 3
scenarios, then 2 more, and tracking sees all 5. Use **SkipNext** to run the full pipeline
from ESPRIT through Apply.
- **Max Damping** (0--1, default 0.2) -- Discard modes with damping ratio above this value.
- **Freq Min / Freq Max** -- Overall frequency range to analyze (default 30--5000 Hz).

**Options:**

- **GPU** -- Use GPU-accelerated ESPRIT (recommended, much faster)
- **TLS** -- Use Total Least Squares variant of ESPRIT
- **Multichannel** -- Process multiple channels jointly

**Window Length** (advanced, visible when band details are expanded) -- Override the automatic
window length calculation. Leave empty for automatic sizing based on sample rate and band
parameters.

### Tracking Section

Mode tracking links detected modes across scenarios into **chains** — sequences of the same
physical mode observed at different piano keys. Tracking runs on ALL processed scenarios
(accumulated across ESPRIT runs), not just the current selection.

**Algorithm:** Two methods are available — see
[`MODE_TRACKING_REDESIGN.md`](../development/MODE_TRACKING_REDESIGN.md) for the full design.

- `sliding_window` (**default, recommended**) — adaptive frequency-window clustering with
  MAC-based hierarchical agglomeration. Layout-agnostic (works for both `line` and `grid`).
- `sequential` — **DEPRECATED as of 2026-05-04.** Per-bridge Hungarian assignment with
  MAC-verified cost function. Only supported for `layout_type="line"` (raises
  `NotImplementedError` on `grid`). Emits a `DeprecationWarning` on use. Will be removed
  in a future release; use `sliding_window` instead.

**Parameters** (in settings panel when Tracking is active): the editable fields **Freq
Tolerance %** (default `0.03`) and **Max Gap** (default `5`) drive the sequential
method's `freq_tol_pct` and `max_gap` (see
[`MODE_TRACKING_REDESIGN.md` § 7](../development/MODE_TRACKING_REDESIGN.md#7-configuration-parameters)).
For the default sliding-window method, these two fields have no effect — the
sliding-window parameters (`sw_*`) live in `TrackingConfig` source defaults and are not
exposed in the UI.

**Stabilization diagram** — scatter plot. Colors: green=stable, yellow=semi-stable,
orange=weak, gray=spurious. Blue=selected. Click points to view mode shapes.

- Line layout: X-axis is `Scenario`. The bass/treble bridge boundary is shown as a
  dashed red line.
- Grid layout: X-axis is `Grid point index` (cell IDs are not 1-D-positional). The
  bridge-boundary marker is hidden. **A per-chain 2-D heatmap inset renders above the
  stabilization diagram showing the selected chain's amplitude at every populated grid
  cell** — transparent for cells with no detection. See
  [`MODE_TRACKING_GRID_LAYOUT.md`](../development/MODE_TRACKING_GRID_LAYOUT.md).

**Mode chains table** — collapsible (hidden by default to maximize diagram space). Sortable
columns: Freq, Damping, Stability, Detections, Coverage %, Drift. Filters: stability, frequency
range, min coverage. Stable and semi-stable chains are auto-selected.

### Apply Section (Feedin & Apply)

**Feedin extraction** — computes mode coupling per channel per pitch via FFT. Requires response
channels configured in the Project panel. Shows measured vs interpolated pitch counts.

**Sound output mapping** (in settings panel when Apply is active) — maps response channels
to Pianoid output pitches (128+).

**Merge mode** (in settings panel when Apply is active) — replace or merge with existing
preset modes.

**Apply to Preset** — click the **Play** button in the toolbar (with Apply selected) to inject
selected chains and feedin data into the active preset on port 5000. Requires preset loaded
and engine running.

!!! warning "Save your preset first"
    Applying modes modifies the in-memory preset. Save before applying to enable revert.

---

## REST API

All modal adapter endpoints are on the modal adapter server (default `http://localhost:5001`).

#### Project Import / Create-from-Zip

Two endpoints accept zip uploads:

```bash
# Smart-routed: handles both .pianoid-project archives (manifest.json+
# project.json at the top) and raw measurement-data zips (RoomResponse
# scenario folders, or flat .npy). Auto-detects layout, auto-extracts
# measurement zips, returns 201 on success.
curl -X POST http://localhost:5001/modal/projects/create_from_zip \
  -F "file=@C:/path/to/measurements.zip" \
  -F "name=MyProject"

# Legacy: only accepts .pianoid-project archives produced by
# /modal/projects/export. Returns 400 on a measurement-folder zip
# ("Invalid archive: missing manifest.json"). Kept for backward
# compatibility — new clients should prefer create_from_zip.
curl -X POST http://localhost:5001/modal/projects/import \
  -F "file=@C:/path/to/exported.pianoid-project" \
  -F "name=MyProject"
```

`create_from_zip` form fields:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `file` | yes | -- | Multipart upload, streamed to disk by Werkzeug |
| `name` | no | zip stem | Project name; conflicts auto-resolved with `_1`, `_2`, ... |
| `extracted_root` | no | `$PIANOID_MEASUREMENTS_DIR` or `D:\modal_measurements` | Where the un-zipped tree is kept |

201 response body adds two fields beyond the standard `create_project` shape:

```json
{
  "name": "PlyWoodTake1",
  "path": "D:\\modal_projects\\PlyWoodTake1",
  "num_scenarios": 10,
  "num_channels": 8,
  "extracted_path": "D:\\modal_measurements\\PlyWoodTake1",
  "detected_format": "roomresponse",
  "renamed": false
}
```

`detected_format` is one of `pianoid_project`, `roomresponse`, `flat_npy`.

Errors: 400 on missing file, corrupt zip, or unrecognised layout (no scenario
folders and no flat `.npy` at top or one level deep). Multi-GB uploads are
supported; Werkzeug spools to a `SpooledTemporaryFile` so no in-memory
buffering happens.

#### Set Mapping (line or grid layout)

```bash
# Line layout (default)
curl -X POST http://localhost:5001/modal/mapping \
  -H "Content-Type: application/json" \
  -d '{
    "channel_roles": {"0": "force", "1": "response", "2": "response"},
    "skipped_channels": [],
    "channel_to_sound": {},
    "excitation_to_pitch": {"0": 21, "1": 22},
    "bridge_boundary": 28,
    "pitch_offset": 21,
    "layout_type": "line"
  }'

# Grid layout — 3x3 bounding box, 8 populated cells (one missing corner)
curl -X POST http://localhost:5001/modal/mapping \
  -H "Content-Type: application/json" \
  -d '{
    "channel_roles": {"0": "response", "1": "response"},
    "skipped_channels": [],
    "channel_to_sound": {},
    "excitation_to_pitch": {},
    "layout_type": "grid",
    "grid_shape": [3, 3],
    "grid_spacing_mm": 10.0,
    "cell_mask": [[true,true,true],[true,true,true],[true,true,false]],
    "point_coordinates": {
      "0": [0,0], "1": [10,0], "2": [20,0],
      "3": [0,10], "4": [10,10], "5": [20,10],
      "6": [0,20], "7": [10,20]
    }
  }'
```

For grid layout: `excitation_to_pitch` is empty (no pitch derivation in this PR). The
`bridge_boundary` and `pitch_offset` fields are ignored. Validation enforces
`cell_mask.sum() == len(point_coordinates)`.

#### Status & Progress

```bash
# Poll ESPRIT extraction progress
curl http://localhost:5001/modal/status
```

Response:
```json
{
  "state": "running",
  "progress": 3,
  "current_point": 3,
  "total_points": 88,
  "message": "ESPRIT scenario 40 (3/88)..."
}
```

#### Tracking Results

```bash
# Get all tracked chains with stability classification
curl http://localhost:5001/modal/tracking_results
```

Response includes an array of chain objects with `chain_id`, `frequency_mean`, `damping_mean`,
`stability`, `detection_count`, `coverage`, `frequency_drift`, and a `detections` map keyed by
scenario index.

#### Feedin Results

```bash
# Get per-pitch feedin coefficients
curl http://localhost:5001/modal/feedin_results
```

Response includes `per_pitch_feedin` (pitch -> feedin array), `mode_frequencies`,
`measured_pitches`, and `interpolated_pitches`.

#### Stabilization Diagram Data

```bash
# Get scatter plot data (chains with per-scenario detections)
curl http://localhost:5001/modal/stabilization_diagram
```

#### Mode Shape for a Single Chain

```bash
# Get feedin magnitude along bridge for chain 5
curl http://localhost:5001/modal/mode_shape/5
```

Response includes `pitches`, `magnitudes`, `bridge_labels`, and `frequency`.

#### Grid Heatmap for a Single Chain (grid layout only)

```bash
# Per-cell amplitude data for chain 5 in grid mode
curl http://localhost:5001/modal/grid_heatmap/5
```

Returns `chain_id`, `frequency`, `stability`, `grid_shape`, `grid_spacing_mm`, and a
`cells` array of `{row, col, scenario_index, x_mm, y_mm, amplitude}`. Cells with no
detection for this chain have `amplitude: null`. Errors with 400 when the project is
not in grid layout, when the chain_id is out of range, or when no tracking has been run.
Used by the `GridHeatmapInset` component above the stabilization diagram. See
[`MODE_TRACKING_GRID_LAYOUT.md`](../development/MODE_TRACKING_GRID_LAYOUT.md) for details.

#### Mode Preview (Decaying Sinewave Parameters)

```bash
# Get frequency + damping for chain 5
curl http://localhost:5001/modal/mode_preview/5
```

#### Load Saved Intermediate Results

```bash
# Load saved ESPRIT results from project directory
curl http://localhost:5001/modal/load_intermediate/esprit

# Load saved tracking results
curl http://localhost:5001/modal/load_intermediate/tracking

# Load saved feedin results
curl http://localhost:5001/modal/load_intermediate/feedin

# Load saved mapping
curl http://localhost:5001/modal/load_intermediate/mapping
```

#### Data Status (Availability Flags)

```bash
# Get data availability flags for all stages
curl http://localhost:5001/modal/data_status
```

Response:
```json
{
  "has_measurements": true,
  "has_mapping": true,
  "has_esprit": true,
  "has_tracking": true,
  "has_feedin": false,
  "has_project_dir": true
}
```

The frontend uses these flags to derive `canRunEsprit`, `canRunTracking`, `canRunFeedin`, and
`canApply` — enabling or disabling each section independently.

#### Run Full Pipeline

```bash
# Run all stages sequentially in background
curl -X POST http://localhost:5001/modal/run_pipeline \
  -H "Content-Type: application/json" \
  -d '{"config": {...}}'
```

Poll `GET /modal/status` for progress. The `pipelineStage` field in the response indicates which
stage is currently executing.

#### Band Presets

```bash
# List available band presets with per-band parameters
curl http://localhost:5001/modal/band_presets
```

### Offline Preset Building

`PresetInjector.build_preset_to_file()` generates a preset file without a running engine.
It reads a baseline preset JSON, applies modal data (frequencies, damping, feedin), and
writes the result to an output path. This enables the full pipeline to produce a preset
file that can be loaded later.

```python
from modal_adapter.preset_injector import PresetInjector

injector = PresetInjector()
result = injector.build_preset_to_file(
    baseline_path="presets/BaselinePreset1.json",
    output_path="output/modal_preset.json",
    mode_chains=tracked_chains,        # from EspritRunner.chains_to_dicts()
    feedin_data=feedin_extraction,      # from FeedinExtractor.extract_all()
    channel_mapping={0: 0, 1: 1},      # response_channel → sound_output_index
    selected_chains=[0, 1, 5],          # optional: None = all chains
)
```

### Via Filesystem

When a project directory is set, intermediate results are auto-saved to subdirectories:

```
{project_dir}/
  modal_adapter/
    esprit/          # Per-scenario ESPRIT extraction results
    tracking/        # Tracked chains with stability classification
    feedin/          # Per-pitch feedin coefficients
```

These files can be loaded back via `GET /modal/load_intermediate/<stage>` or accessed directly
as NumPy/JSON files for offline analysis.

---

## Workflow Example

A typical end-to-end pipeline run. You can run stages individually using the toolbar play
button, or use the **SkipNext** (⏭) button to run from the current step through to the end
of the pipeline. You can also **Load Saved** data at any stage to skip re-running earlier
stages:

1. **Open or create a project** -- Click the **Project** button in the toolbar. Either click
   an existing project chip to open it, or enter a new project name + measurement folder
   path and click **Create**.

2. **Configure channel roles** -- In the mapping editor (shown after project open/create),
   assign each channel its role:
    - Mark accelerometer/microphone channels as **Response**
    - Mark the hammer force sensor as **Force**
    - Mark any unused channels as **Skip**
    - Set the bridge boundary (typically 28 for a standard 88-key piano)
    - Verify the pitch offset (21 for A0 = scenario 0)

3. **Configure ESPRIT** -- Click **ESPRIT** in the toolbar to select it. Click the **gear**
   icon to open settings. Select `standard_4band` for a first pass. Leave other parameters
   at defaults unless you have specific requirements.

4. **Run ESPRIT** -- Click the **Play** (▶) button in the toolbar. Monitor progress via the
   spinner on the ESPRIT button. For 88 scenarios with `standard_4band` and GPU, expect
   1--5 minutes. Alternatively, click **SkipNext** (⏭) to run ESPRIT + Tracking + Apply
   in sequence.

5. **Run tracking** -- Click **Tracking** in the toolbar, then click **Play** (▶). Or if
   using SkipNext, tracking runs automatically after ESPRIT.

6. **Inspect results** -- The stabilization diagram and mode table appear in the main panel
   when Tracking is selected:
    - Green clusters at consistent frequencies indicate real physical modes
    - Isolated gray points are likely spurious
    - Use the frequency and coverage filters to focus on high-quality chains
    - Click chains in the diagram to see their spatial mode shapes

7. **Adjust selection** -- Use the mode table filters and checkboxes to refine which chains to
   include. Aim for chains that are stable or semi-stable with good coverage. Deselect any
   chains that appear spurious despite being classified otherwise.

8. **Configure and apply** -- Click **Apply** in the toolbar, then click the **gear** icon to
   configure merge mode and sound output mapping. Click **Play** (▶) to apply to the active
   preset.

9. **Save** -- Save the preset via the frontend or `POST /save_preset` to persist the changes.

---

## Troubleshooting

### Out of Memory with Extended 8-Band

The `extended_8band` preset uses significantly more memory than `standard_4band`. Memory is
freed between bands automatically (GPU pools and CPU intermediates), but peak per-band
allocation can still exceed available VRAM. If ESPRIT fails with an out-of-memory error:

- Switch to `standard_4band`
- Reduce per-band model orders (low bands need only 8--15, not 30+)
- Increase the decimation factor in lower frequency bands
- Disable GPU and use CPU extraction (slower but uses system RAM)

### Long ESPRIT Extraction Times

If extraction takes longer than expected:

- Verify GPU is enabled (the GPU checkbox should be checked)
- Use `standard_4band` instead of `extended_8band`
- Reduce the number of scenarios by loading a subset
- Lower the model order

### No Response Channels

The Feedin Extraction button is disabled when no channels have the "response" role. Go back to
the Load Measurements section and assign at least one channel as Response in the channel mapping
editor.

### Port Conflicts

The backend server defaults to port 5000. If another process is using this port, the modal
adapter endpoints will be unreachable. Check with:

```bash
netstat -ano | findstr :5000
```

Restart the backend on a different port or stop the conflicting process.

### Stabilization Diagram Shows Only Spurious Modes

This usually indicates measurement quality issues or incorrect ESPRIT parameters:

- Check that measurement data was loaded correctly (correct folder, expected scenario count)
- Verify the sample rate matches the actual recording sample rate
- Try increasing the model order
- Try adjusting the MAC threshold (lower values are more permissive)
- Check that the frequency range covers the expected mode frequencies

### Tracking Finds Too Few / Too Many Chains

These hints apply to the deprecated `sequential` method's `freq_tol_pct` / `max_gap`
parameters (the only tracking knobs exposed in the UI). The default `sliding_window`
method uses different parameters (`sw_*` in `TrackingConfig`) that are not UI-editable
— see [`MODE_TRACKING_REDESIGN.md` § 7](../development/MODE_TRACKING_REDESIGN.md#7-configuration-parameters).

- **Too few chains** (mode is being broken into multiple short fragments): **raise**
  `freq_tol_pct` (e.g. from current default `0.03` up to `0.05`) so adjacent scenarios
  with slightly different frequencies stay in the same chain; or **raise** `max_gap`
  (current default `5`) to tolerate more missing scenarios before a chain closes.
- **Too many chains** (spurious noise modes appearing): **lower** `freq_tol_pct` (e.g.
  from `0.03` down to `0.02`) to be stricter about frequency matching, or filter by
  stability and coverage in the mode table.

### Apply to Preset Fails

- Ensure a preset is loaded and the engine is running (`POST /load_preset`)
- Ensure at least one chain is selected
- Check the backend console for error details
