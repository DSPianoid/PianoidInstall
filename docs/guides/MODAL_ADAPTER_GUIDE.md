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

**Parameters** (in settings panel when Tracking is active): Freq Tolerance % (default 0.02),
Max Gap (default 3).

**Stabilization diagram** — scatter plot (X=scenario, Y=frequency). Colors: green=stable,
yellow=semi-stable, orange=weak, gray=spurious. Blue=selected. Click points to view mode shapes.

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

- **Too few**: Lower the `freq_tol_pct` (e.g. from 0.02 to 0.03) to allow more frequency
  variation, or increase `max_gap` to tolerate more missing scenarios
- **Too many**: Raise `freq_tol_pct` to be stricter about frequency matching, or filter by
  stability and coverage in the mode table

### Apply to Preset Fails

- Ensure a preset is loaded and the engine is running (`POST /load_preset`)
- Ensure at least one chain is selected
- Check the backend console for error details
