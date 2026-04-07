# Modal Adapter Pipeline Guide

The Modal Adapter panel converts impulse response measurements of a real piano into synthesis
presets for the Pianoid engine. It extracts vibrational modes (frequencies, damping ratios, and
spatial shapes) from measurement data using the ESPRIT algorithm, tracks them across excitation
points, computes feedin coupling coefficients, and injects the results into the active preset.

The pipeline is divided into sequential stages. Each stage must complete before the next becomes
available. Intermediate results are auto-saved to the project directory, so work can be resumed
across sessions.

---

## Panel Sections

The panel is organized as a series of collapsible accordion sections. A status indicator appears
next to each section title: a green checkmark when complete, a blue "Running" chip during
processing, or a red "Error" chip on failure. A **Reset** button in the header clears all state
and returns to the initial configuration.

### 1. Load Measurements

This section configures where data comes from and where intermediate results are saved.

**Project Directory** -- Set a persistence folder (e.g. `D:\modal_projects\piano1`) where
intermediate results (ESPRIT output, tracking chains, feedin data) are auto-saved between stages.
Click **Set** to register the directory on the backend. If omitted, intermediate data exists only
in memory for the current session.

**Measurement Folder** -- Path to a directory containing impulse response data. The backend
auto-detects two formats:

- **Direct `.npy` files** -- one array per excitation scenario
- **RoomResponse per-channel structure** -- subdirectories with per-channel scenario files

Enter the path and click **Load**. On success, a summary appears showing the number of
**scenarios** (excitation points), **channels**, and **sample rate** (Hz).

**Channel Mapping** -- After loading, a mapping editor appears (see
[Channel Mapping](#7-channel-mapping) below) where you assign roles to each measurement channel
and configure bridge geometry. This mapping is used by all downstream stages.

### 2. ESPRIT Configuration

Controls for the ESPRIT modal extraction algorithm. This section is disabled until measurements
are loaded.

**Band Preset** -- Select a frequency band configuration:

| Preset | Description |
|--------|-------------|
| `standard_4band` | 4 frequency bands -- faster, suitable for most pianos. Per-band model orders: Low=10, Mid-Low=15, Mid-High=25, High=30 |
| `extended_8band` | 8 frequency bands -- higher resolution, more memory-intensive. Per-band model orders: Ultra-Low=8, Low=12, Low-Mid=25, Mid=35, Mid-High=45, High/Upper/Top=50 |
| `custom` | Manual band definition |

Click **Show Band Details** to expand the per-band table with editable fields:

| Field | Description |
|-------|-------------|
| `f_min` | Lower frequency bound (Hz) |
| `f_max` | Upper frequency bound (Hz) |
| `filter_order` | Bandpass filter order |
| `decimation` | Signal decimation factor (higher = faster but lower resolution) |
| `exp_factor` | Exponential weighting factor |
| `model_order` | Per-band ESPRIT model order. Determines how many signal components ESPRIT searches for in this band. Empty = use global default. Low-frequency bands need fewer modes (5--15), high-frequency bands need more (30--50) |

You can add or remove bands. Any manual edit switches the preset to "Custom".

**Core Parameters:**

- **Default Model Order** (slider, 10--100, default 30) -- Fallback model order used when a band
  does not specify its own. Each band can override this via the per-band `model_order` field in
  the band details table. Low-frequency bands typically contain only 5--7 modes and benefit from
  lower orders (8--15); high-frequency bands need higher orders (30--50).
- **MAC Threshold** (0--1, default 0.9) -- Modal Assurance Criterion threshold for merging
  duplicate modes across bands. Lower values merge more aggressively.
- **Max Damping** (0--1, default 0.2) -- Discard modes with damping ratio above this value.
- **Freq Min / Freq Max** -- Overall frequency range to analyze (default 30--5000 Hz).

**Options:**

- **GPU** -- Use GPU-accelerated ESPRIT (recommended, much faster)
- **TLS** -- Use Total Least Squares variant of ESPRIT
- **Multichannel** -- Process multiple channels jointly

**Window Length** (advanced, visible when band details are expanded) -- Override the automatic
window length calculation. Leave empty for automatic sizing based on sample rate and band
parameters.

### 3. ESPRIT Extraction

Click **Run ESPRIT** to start the extraction. This runs in the background. The panel shows:

- A progress bar with the current scenario number (e.g. "Point 3 / 88")
- A progress message from the backend

Click **Cancel** to abort a running extraction. When complete, a success alert shows the total
number of modes found.

**Expected duration:**

- `standard_4band` with GPU: approximately 1--5 minutes for 88 scenarios
- `extended_8band` with GPU: approximately 10--30 minutes for 88 scenarios
- Without GPU: multiply by 5--10x

The backend polls `GET /modal/status` every second to update the progress display.

### 4. Mode Tracking

After ESPRIT extraction, mode tracking links detected modes across excitation scenarios into
**chains** -- sequences of the same physical mode observed at different piano keys.

**Parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| Bridge Boundary | 28 | Scenario index separating bass bridge from treble bridge. Tracking runs independently for each bridge region. |
| Freq Tolerance % | 0.02 | Maximum relative frequency difference (2%) for linking a mode detection to an existing chain. |
| Max Gap | 3 | Maximum number of consecutive missing scenarios before a chain is terminated. |

Click **Run Tracking** to execute. Results appear as summary chips showing the count of chains
in each stability category:

- **stable** -- detected in most scenarios, consistent frequency
- **semi stable** -- detected in many scenarios with some gaps
- **weak** -- detected in few scenarios
- **spurious** -- likely noise artifacts

After tracking completes, the stabilization diagram is automatically fetched for visualization.

### 5. Mode Selection & Visualization

This section provides interactive tools for inspecting tracked mode chains and selecting which
ones to include in the final preset. A chip in the section header shows the selection count
(e.g. "12 / 45").

Stable and semi-stable chains are auto-selected after tracking. You can manually adjust the
selection using the tools below.

#### Stabilization Diagram

A scatter plot with:

- **X axis**: Scenario index (0--87, corresponding to piano keys)
- **Y axis**: Frequency (Hz, logarithmic scale)
- **Color coding**: green = stable, yellow = semi-stable, orange = weak, gray = spurious
- **Blue highlights**: currently selected chains
- **Red dashed line**: bridge boundary marker

**Interaction**: Click any point to select that chain and load its mode shape plot below.
Hovering shows a tooltip with the scenario index, frequency, chain ID, and stability class.

#### Mode Table

A sortable, filterable table of all tracked chains.

**Columns** (all sortable by clicking the header):

| Column | Description |
|--------|-------------|
| Freq (Hz) | Mean frequency across all detections |
| Damping | Mean damping ratio |
| Stability | Classification (stable / semi stable / weak / spurious) |
| Detections | Number of scenarios where this mode was detected |
| Coverage % | Fraction of scenarios covered |
| Drift (Hz) | Frequency variation across scenarios |

**Filters** (above the table):

- **Stability** -- multi-select dropdown to show only specific stability classes
- **Freq Min / Freq Max** -- numeric fields to restrict frequency range
- **Min Coverage** -- slider (0--100%) to hide chains below a coverage threshold

A **select-all checkbox** in the header toggles all currently filtered chains. Individual
checkboxes toggle single chains. The filter status line shows "N / M chains" to indicate how
many are visible.

#### Mode Shape Plot

Appears after clicking a chain in the stabilization diagram. Shows the feedin magnitude of that
mode along the bridge, split into bass bridge (blue) and treble bridge (green) regions based on
the bridge boundary and pitch offset settings.

- **X axis**: MIDI pitch number (21--108)
- **Y axis**: Feedin magnitude

This reveals the spatial shape of the mode -- where on the bridge the mode couples most strongly.

#### Feedin Heatmap

Appears after feedin extraction (section 6). A color-coded matrix showing feedin magnitude for
every pitch (X axis) and mode (Y axis). Colors range from dark blue (low coupling) through
yellow to dark red (high coupling). Hover for exact values.

The heatmap provides an overview of which modes contribute to which pitches, helping identify
modes that are globally important versus locally relevant.

### 6. Feedin Extraction

Computes how strongly each tracked mode couples to each response channel at each pitch. This
uses FFT-based analysis of the impulse responses at the tracked mode frequencies.

**Prerequisites**: At least one channel must be assigned the "response" role in the channel
mapping. The panel lists which channels are currently marked as response channels. If none are
assigned, the Run button is disabled.

Click **Run Feedin Extraction** to compute. On success, the alert shows the count of measured
pitches (where direct data exists) and interpolated pitches (where values were estimated from
neighbors).

The feedin data is used by the "Apply to Preset" stage and also populates the feedin heatmap
in the visualization section.

### 7. Channel Mapping

The mapping editor appears within the Load Measurements section after data is loaded. It
configures how measurement channels map to the synthesis engine.

#### Bridge Geometry

| Field | Default | Description |
|-------|---------|-------------|
| Bridge Boundary | 28 | Scenario index where bass bridge ends and treble bridge begins. Scenarios 0--27 are bass, 28--87 are treble. |
| Pitch Offset | 21 | MIDI pitch number of scenario 0. The formula is: `pitch = scenario + offset`. With offset 21, scenario 0 corresponds to MIDI pitch 21 (A0). |

#### Channel Roles

Each measurement channel is assigned one of four roles:

| Role | Color | Description |
|------|-------|-------------|
| Response | Green | Channels that capture the piano's acoustic response (soundboard, bridge sensors). These are used for feedin extraction. |
| Force | Yellow | The excitation (hammer) force channel. Used for normalization. |
| Reference | Blue | Reference channels (e.g. accelerometer on frame). Not used for feedin but preserved for analysis. |
| Skip | Gray | Channels to ignore entirely. Rows appear dimmed. |

The panel shows a summary of how many channels are assigned to each role.

#### Sound Output Mapping

For response channels, the **Sound Output** column maps each measurement channel to a Pianoid
**output pitch** (128+). Each response channel corresponds to a physical receiver point
(accelerometer, microphone) on the soundboard. The mapping determines which output pitch
receives that receiver's modal coupling data:

- Sound Output 0 → output pitch 128
- Sound Output 1 → output pitch 129
- Sound Output 2 → output pitch 130
- Sound Output 3 → output pitch 131

Output pitches are virtual soundboard strings: their feedback coefficients carry the mode shape
at the receiver location, reproducing what that physical sensor would measure. In
`listen_to_modes=0` (strings mode), audio output comes exclusively from these output pitches.
Only editable for channels with the "response" role.

### 8. Apply to Preset

The final stage injects the extracted modal data into the currently active Pianoid preset.

**Summary panel** shows:

- Number of selected mode chains
- Number of pitches with measured feedin vs. interpolated
- Response channel to sound output mapping

**Merge mode toggle**:

- **Replace existing modes** (default) -- overwrites all mode data in the preset
- **Merge with existing modes** -- adds extracted modes alongside existing ones

Click **Apply to Preset** to execute. This first submits the channel mapping, then applies the
selected chains and feedin data to the active preset. The preset must be loaded and the engine
running for this to work.

!!! warning "Save your preset first"
    Applying modes modifies the in-memory preset. Use `POST /save_preset` or the frontend save
    button to persist changes to disk before applying, so you can revert if needed.

---

## Accessing Intermediate Data

### Via REST API

All endpoints are relative to the backend server (default `http://localhost:5000`).

#### Status & Progress

```bash
# Poll ESPRIT extraction progress
curl http://localhost:5000/modal/status
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
curl http://localhost:5000/modal/tracking_results
```

Response includes an array of chain objects with `chain_id`, `frequency_mean`, `damping_mean`,
`stability`, `detection_count`, `coverage`, `frequency_drift`, and a `detections` map keyed by
scenario index.

#### Feedin Results

```bash
# Get per-pitch feedin coefficients
curl http://localhost:5000/modal/feedin_results
```

Response includes `per_pitch_feedin` (pitch -> feedin array), `mode_frequencies`,
`measured_pitches`, and `interpolated_pitches`.

#### Stabilization Diagram Data

```bash
# Get scatter plot data (chains with per-scenario detections)
curl http://localhost:5000/modal/stabilization_diagram
```

#### Mode Shape for a Single Chain

```bash
# Get feedin magnitude along bridge for chain 5
curl http://localhost:5000/modal/mode_shape/5
```

Response includes `pitches`, `magnitudes`, `bridge_labels`, and `frequency`.

#### Mode Preview (Decaying Sinewave Parameters)

```bash
# Get frequency + damping for chain 5
curl http://localhost:5000/modal/mode_preview/5
```

#### Load Saved Intermediate Results

```bash
# Load saved ESPRIT results from project directory
curl http://localhost:5000/modal/load_intermediate/esprit

# Load saved tracking results
curl http://localhost:5000/modal/load_intermediate/tracking

# Load saved feedin results
curl http://localhost:5000/modal/load_intermediate/feedin

# Load saved mapping
curl http://localhost:5000/modal/load_intermediate/mapping
```

#### Band Presets

```bash
# List available band presets with per-band parameters
curl http://localhost:5000/modal/band_presets
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

A typical end-to-end pipeline run:

1. **Set project directory** -- Enter a path like `D:\modal_projects\steinway_b` and click
   **Set**. This enables auto-persistence of intermediate results.

2. **Load measurements** -- Enter the measurement folder path and click **Load**. Verify the
   summary shows the expected number of scenarios and channels.

3. **Configure channel roles** -- In the mapping editor, assign each channel its role:
    - Mark accelerometer/microphone channels as **Response**
    - Mark the hammer force sensor as **Force**
    - Mark any unused channels as **Skip**
    - Set the bridge boundary (typically 28 for a standard 88-key piano)
    - Verify the pitch offset (21 for A0 = scenario 0)

4. **Configure ESPRIT** -- Expand the ESPRIT section. Select `standard_4band` for a first pass.
   Leave other parameters at defaults unless you have specific requirements.

5. **Run ESPRIT** -- Click **Run ESPRIT** and wait for completion. Monitor the progress bar.
   For 88 scenarios with `standard_4band` and GPU, expect 1--5 minutes.

6. **Run tracking** -- Expand the Mode Tracking section. Verify the bridge boundary matches
   your channel mapping. Click **Run Tracking**.

7. **Inspect results** -- Expand Mode Selection & Visualization. Review the stabilization
   diagram:
    - Green clusters at consistent frequencies indicate real physical modes
    - Isolated gray points are likely spurious
    - Use the frequency and coverage filters to focus on high-quality chains
    - Click chains in the diagram to see their spatial mode shapes

8. **Adjust selection** -- Use the mode table filters and checkboxes to refine which chains to
   include. Aim for chains that are stable or semi-stable with good coverage. Deselect any
   chains that appear spurious despite being classified otherwise.

9. **Run feedin extraction** -- Expand the Feedin section. Verify response channels are listed.
   Click **Run Feedin Extraction**. Check the feedin heatmap to verify sensible coupling
   patterns.

10. **Map sound outputs** -- In the channel mapping, set the Sound Output index for each
    response channel to match your desired Pianoid output routing (0--3).

11. **Apply to preset** -- Expand Apply to Preset. Choose merge or replace mode. Click
    **Apply to Preset**.

12. **Save** -- Save the preset via the frontend or `POST /save_preset` to persist the changes.

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
