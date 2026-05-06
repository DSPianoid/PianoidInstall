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
| `line` (default) | Scenarios laid out along a 1-D bridge; bass/treble bridge split applies; `pitch = scenario_index + pitch_offset`. | Yes (line-mode `feedin_extractor` → `preset_injector`) | `nuclei_merge` (default since dev-d773 2026-05-05 — see [`MODE_TRACKING_NUCLEI_MERGE.md`](../development/MODE_TRACKING_NUCLEI_MERGE.md)), `sliding_window` (legacy), or `sequential` (DEPRECATED — emits `DeprecationWarning`) |
| `grid` | Scenarios laid out on a 2-D rectangular grid (square spacing); populated cells form an arbitrary shape inside the bounding box. | **Not in this PR** — see [`BRIDGE_FROM_GRID.md`](../development/proposals/BRIDGE_FROM_GRID.md) | `nuclei_merge` (default) or `sliding_window` (both layout-agnostic; sequential raises `NotImplementedError`) |

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

**Grid-vs-scenarios consistency** (dev-c807 Bug 2). The grid's populated-cell count MUST
agree with the project's scenario count — `point_coordinates` keys are the contiguous
range `0..N-1` and `_per_scenario_results` is keyed by the same ESPRIT scenario indices.
When the two disagree (e.g. the project has 30 scenarios but the grid only covers 24
cells), detections at scenarios outside the grid are silently dropped from the per-chain
heatmap. The UI surfaces the mismatch in three places:

1. **Inline warning Alert** in the GridLayoutEditor body, visible while editing.
2. **Save-time confirmation Dialog** when the user clicks Save Mapping with a mismatch —
   the user must explicitly choose "Save anyway" or "Cancel".
3. **Mismatch Chip** on the ProjectInfoCard (`<cells> cells / <scenarios> scenarios`),
   so the inconsistency stays visible at the project level after save.

Saving with a mismatch is allowed (some workflows intentionally measure more scenarios
than the grid covers), but the user has been warned. Existing projects with an already-
saved mismatch keep their state; the chip is the only retroactive surface for them.

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

The Setup section opens with three action buttons (**Open Project**, **Copy From…**,
**Create Project…**), the selected-project info card, and — when the project uses
grid layout — the processing grid editor. As of dev-8b5f (2026-05-04) the legacy
inline chip-list UI was replaced by a file-browser dialog and the standalone "New
Project from folder" form was removed (Create Project auto-detects format and
covers both `.pianoid-project` archives and raw measurement-data zips).

**dev-cp01 (2026-05-05) streamlined the create flow.** The legacy "Import from
Zip" button (which exposed an inline `IR(ms)` field next to it and skipped
straight to upload-on-click) was replaced by a single popup dialog that gathers
all create-time fields up-front: file, project name, signal length, averaging
mode. Post-create, an Effective Signal Length QC follow-up prompt offers to
re-run averaging at a measurement-supported length when QC reports
`global_min_t_eff_ms < requested signal_length_ms` (see "Create Project Dialog"
below).

**Open Project** -- opens a `ProjectBrowserDialog` with two tabs:

- **Recent** -- the last 8 opened projects (per-browser, stored in
  `localStorage` under key `pianoid:modal-adapter:recent-projects`). LRU
  ordering, most-recent first. Stale entries (projects no longer present
  on disk) are filtered out automatically.
- **Browse** -- every project under the projects base directory
  (default `D:\modal_projects`), with a search filter. Each row shows
  `N sc · M ch · Linear|Grid R×C · sig N ms` plus a stage badge
  (`E`/`T`/`F` for ESPRIT/Tracking/Feedin completion). The currently-open
  project is highlighted with a left border. Per-row icons offer **Export**
  (download as `.pianoid-project`) and **Delete**.

Double-clicking a row, or selecting + clicking **Open**, opens the project.
All intermediate data (measurements, ESPRIT results, tracking chains) is
restored automatically and the project is pushed to the Recent list.

**dev-037a (2026-05-06) — auto-start on click.** When the user clicks
**Open Project** while the modal-adapter backend (port 5001) is not
running, the click handler now calls `useModalAdapter.ensureModalServer()`
first — which probes `GET /health`, and if that fails POSTs
`/api/start-modal-adapter` on the launcher (port 3001), then polls
`/health` every 500 ms until the server is alive (up to 10 s). The button
shows a spinner and "Starting…" label during the wait. Once the server
is up, the dialog opens with a populated `projectList` (refreshed by the
hook's existing `serverRunning` off→on transition effect; see [P1: Single source of truth — projectList]). Previously the user had to start the
modal-adapter backend manually via the toolbar status chip, then re-click
Open Project to see a non-empty list. The chip-driven manual start
remains available for users who prefer to pre-warm the backend (e.g.
right after launching the stack).

**Copy From…** -- same dialog, but the action button reads "Copy" and a
"New project name" field appears below the project list. The destination
name is auto-suggested as `{source}_copy` and validated against the
existing project list before submission. Disabled when no projects exist.

**Selected-project info card** -- once a project is open, a compact info
card replaces the legacy "Project: name — path" text line. It shows:

| Field | Source |
|-------|--------|
| Project name | `project.json` `name` (or folder name) |
| Scenario count | `project.json.num_scenarios` |
| Response channel count | Live mirror state (channels with role `response`) |
| Layout | `mapping_config.json.layout_type` (`Linear` or `Grid R×C`) |
| Signal length | `project.json.ir_working_length_ms` (preferred) or derived from `scenario_0.npy.shape[0] / sample_rate * 1000` |
| Project directory | Full path under projects base |

The card includes a **Rename** button that opens a small dialog. Validation
mirrors the backend (`POST /modal/projects/<old_name>/rename`):

- Allowed characters: letters, digits, dot, underscore, hyphen, space
- New name must differ from the current name
- New name must not collide with an existing project (HTTP 409 surfaced
  inline in the dialog)

When renaming the open project, backend retargets in-memory state in place
(no close/reopen cycle); the front-end recent list is updated to point at
the new name.

The same Rename dialog is also available **per-row in the
ProjectBrowserDialog Browse tab** as of dev-db2e — click the pencil icon
next to any project row. Useful when you want to rename a project
without opening it first.

**Delete project** -- the trash icon on the info card (and per-row in
the ProjectBrowserDialog Browse tab) opens a `DeleteProjectDialog`
(dev-db2e). The dialog confirms:

- Project directory path that will be removed
- Optional checkbox: **also delete the extracted measurements folder**
  (default OFF). The checkbox is auto-disabled when:
    - the project has no `measurement_source` recorded in `project.json`
      (legacy projects), OR
    - the recorded `measurement_source` lives **outside** the canonical
      extracted-root (`$PIANOID_MEASUREMENTS_DIR` or
      `D:\modal_measurements`) — protects user-curated source folders
      from accidental destruction.
- A "currently-open project" note when the project being deleted is the
  active one (backend closes it first, then removes the directory).

The recent-projects list is cleaned up automatically on successful
delete. See `POST /modal/projects/delete` (REST API) for the response
shape including `deleted_measurements`, `measurements_path`, and
`measurements_skipped_reason`.

**Processing Grid** -- when `layout_type == "grid"`, the
`GridLayoutEditor` (rows / cols / spacing / cell mask, with All On / All
Off / Invert bulk buttons) renders directly in the Project subpanel body
beneath the info card. It is no longer hidden inside the settings-gear
accordion. For `line` layout the editor does not render — switch to grid
via the LINE/GRID layout selector in the settings panel (gear icon) to
reveal it.

**Create Project…** -- click to open `CreateProjectDialog` (dev-cp01,
2026-05-05). The dialog collects the four pieces of create-time
information in one step:

| Field | Default | Notes |
|-------|---------|-------|
| **Source file** | (none) | Picker accepts `.zip` or `.pianoid-project`. Required. |
| **Project name** | filename stem | Auto-derived from the picked file's name with the standard `.zip` / `.pianoid-project` suffix stripped. Editable. Backend auto-suffixes `_1`, `_2`, ... on collision. |
| **Signal length (ms)** | `1000` | Numeric override for `ir_working_length_ms`. Truncates the averaged response to this duration with a Hann fadeout over the last `ir_fade_length_ms`. Hidden when the picked file is a `.pianoid-project` archive (length determined by archive). |
| **Quality threshold** (dev-cp02) | `0.1` | Effective Signal Length QC threshold — the env_diff/env_signal ratio gate beyond which the signal is considered no longer reproducible. UI range `0.05` (strict, 5% noise floor) – `0.5` (permissive, 50% noise floor); backend gate is `(0, 1)`. Lower = stricter. Forwarded as `qc_threshold` form field on `POST /modal/projects/create_from_zip` and persisted into each scenario's `effective_signal_length.json` v2. Hidden for `.pianoid-project` archives. |
| **Averaging mode** | `Re-average from raw (overwrite)` | Radio: **Re-average** maps to `force_reaverage=true` (always re-runs the canonical averager from `raw_recordings/`, overwriting `averaged_responses/`); **Keep existing** maps to `force_reaverage=false` (preserves existing averages, only computes for scenarios that lack them). Hidden for `.pianoid-project` archives. |

The button is **smart-routed** based on the picked file:

- A `.pianoid-project` archive (one previously produced by **Export Project**) is
  unpacked into the projects base verbatim — same as the legacy import flow.
- Any other `.zip` is treated as a **measurement-data archive** (RoomResponse scenario
  folders or flat `.npy`). The zip is streamed to disk, extracted to
  `D:\modal_measurements\<name>\` (or `$PIANOID_MEASUREMENTS_DIR`), the parent
  directory containing scenario folders is auto-detected (handles both
  "scenarios at top of zip" and "scenarios one wrapping dir deep" layouts),
  and the project is created from that path in one HTTP call. The on-disk
  extraction is **kept** so you can re-create the project later without
  re-uploading the zip (use `POST /modal/projects/<n>/reaverage` to extend).

This removes the foot-gun where uploading a measurement-folder zip into the old
"Import Project" button failed with `Invalid archive: missing manifest.json` —
the same button now handles both cases. Multi-GB zips upload streamingly
(Werkzeug spools to disk, no in-memory buffering).

**dev-cp01 Bug B fix.** When the route caller (curl, legacy frontend) omits the
`name` form field, the route now derives the project name from the upload's
original filename (`request.files['file'].filename`) rather than the Werkzeug
temp filename. Previously, projects ended up named `tmpXXXXXX` on disk in this
case. The dialog always sends an explicit `name`; the route fix is defence-in-
depth.

**dev-cp01 Bug C fix.** When the requested `ir_working_length_ms` exceeds the
on-disk pre-averaged length of any scenario, the averager auto-promotes
`force=true` per-scenario for those scenarios. Without this fix the
idempotency short-circuit silently honoured the shorter pre-averaged file,
ignoring the requested length. Scenarios already at (or longer than) the
requested length remain on the fast path (no needless re-averaging).

**Effective Signal Length follow-up prompt.** When the create call returns,
the frontend fetches the project's QC summary
(`GET /modal/projects/<n>/effective_signal_length`). If
`summary.global_min_t_eff_ms < requested signal_length_ms`, the
`EffectiveSignalLengthRerunDialog` opens with:

- A **substandard-scenarios summary** (dev-cp02): how many of the project's
  scenarios reached the requested length, how many fell short, the median
  T_eff among the failing scenarios, and the worst single scenario's
  T_eff with its name. Format example with 30 scenarios:

  ```
  QC summary across 30 scenarios:
  • 5 scenarios reached the requested length (T_eff ≥ 1000 ms)
  • 25 scenarios fell short:
      median T_eff (failing): 180 ms
      min T_eff: 53 ms (PlyWood-Scenario23-Take1)
  ```

  All client-computed from `summary.per_scenario_min_t_eff_ms` (already
  in the QC summary payload — no extra backend calls).

- A threshold/method footnote (`Threshold: env_diff/env_signal < 10%
  (last sustained), method: hilbert + 20 ms Gaussian smooth,
  split-half jackknife.`). Inverted direction (`<` vs the v1/v2 `≥`)
  to match v3 last-crossing semantics — see "Schema-v2 → v3 changes"
  below.

- A suggested signal length: **`floor(median_failing / 50) * 50`** —
  rounded DOWN to the nearest 50 ms for a cleaner number, never below 50.
  Switched from `floor(global_min / 50) * 50` to median-based in dev-cp02
  because the post-qc02 algorithm exposed scenarios with T_eff ≈ 0 ms
  (e.g. PlyWoodTake1 Sc 5 residual zero) that would have collapsed the
  suggestion to 50 ms — useless. The median of failing scenarios is a
  representative target for the substandard population.

- Three actions (revised in dev-cp02 followup #2 + #4):
  - **Proceed** — closes the dialog and leaves the project at the
    requested length. The Eff sig chip on ProjectInfoCard still surfaces
    the warning at the project level, so the user can revisit later.
    Replaces the former "Keep current N ms" button.
  - **Show details** — expands a per-scenario / per-channel T_eff
    table sorted worst-first (unchanged from dev-cp02).
  - **Go Back** — closes the EffSigLen dialog AND reopens the
    `CreateProjectDialog` with the user's **entire prior Create
    attempt restored** (file, project name, averaging mode, quality
    threshold), with the signal-length field adjusted to the
    EffSigLen-suggested value. The user only needs to edit what
    they want changed — typically just confirm the new signal length
    by clicking Create.
  - **Cancel** (X / Escape / backdrop click) — distinct from Proceed
    in dev-cp02 followup #4. The user explicitly abandons the retry;
    the speculatively-created project is **deleted on disk** (with
    extracted measurements via `deleteProject(name,
    delete_measurements=true)`) so orphans don't accumulate. A Snackbar
    confirms "Cancelled: deleted speculatively-created project …".

  When the user accepts Go Back and resubmits the Create dialog, the
  ModalAdapter handler picks one of four backend ops based on what
  changed since the prior successful Create (dev-cp02 followup #4):

  | What changed | Backend op | Why |
  |---|---|---|
  | Nothing (just signal length adjusted via the suggestion) | `POST /modal/projects/<n>/reaverage` | Re-run averaging on existing on-disk tree. Skip zip re-upload and re-extract. |
  | Project name only (file unchanged) | `POST /modal/projects/<old>/rename` then `reaverage` | Reuse on-disk artifacts (raw_recordings, averaged_responses); just relabel and re-run averaging at the new length. |
  | File changed (different zip) | `POST /modal/projects/delete` (with `delete_measurements=true`) then `POST /modal/projects/create_from_zip` | Clean up the orphan project + extracted folder, then full Create with the new file. |
  | (Dialog cancelled — see above) | `POST /modal/projects/delete` (with `delete_measurements=true`) | User abandoned the retry; clean up the speculatively-created project. |

  The `reaverageProject` and `rename + reaverage` paths re-fire the
  EffSigLen prompt on completion (the new shorter length might still
  be too long for some scenarios — user gets another chance to
  shorten further). Implementation: `ModalAdapter` stashes
  `{file, name, signalLengthMs, averagingMode, qcThreshold,
  createdProjectName, priorNumScenarios}` in `lastCreateAttempt` when
  opening the EffSigLen prompt; the Create dialog's submit handler
  reads `createdProjectName` to detect "Go Back retry" mode and
  reference-compares the resubmitted File against the stashed File to
  pick the right backend op. The browser-held `File` object survives
  the round-trip via component state (DOM `<input type="file">`
  cannot be programmatically reset, but the JS `File` reference is
  enough to re-submit without re-picking).

The follow-up prompt only fires when the user picked the "Re-average from
raw" mode AND a numeric `ir_working_length_ms` was set — "Keep existing"
mode opts the user out of the QC truncation suggestion, since they
explicitly asked to preserve the existing averages.

**Post-create Snackbar (dev-cp02 followup #2).** The post-create summary
("Project Foo created. 30 scenarios imported. ...") is now rendered as
an MUI dark-themed Snackbar at bottom-center of the Modal Adapter pane,
6 s auto-hide, dismissible. This replaces the previous `window.alert()`
that triggered Chrome's native "Confirm action on localhost:3000"
system-notification styling. Severity is `success` (or `warning` when
at least one scenario failed averaging — `summary.errors > 0`); for
`.pianoid-project` archive imports a brief `info` Snackbar reports the
import. Errors during the import itself are surfaced through the
existing `setError` → inline Alert pattern (unchanged).

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

#### Effective Signal Length QC (split-half jackknife)

**Schema v1 introduced in dev-qc01 (2026-05-05). Schema v2 in dev-qc02
(2026-05-05) — corrects the split level (cycle-level instead of
measurement-level) and adds `qc_threshold` to the persisted JSON.
Schema v3 in dev-qcthr (2026-05-06) — replaces "uniform 5 ms smoothing
+ first-crossing" with "Gaussian 20 ms smoothing + last-crossing"
detection (see "Schema-v2 → v3 changes" below).**
The auto-averager performs a split-half reproducibility check per
response channel every time it runs:

1. Run the canonical preprocessing on ALL surviving cycles together
   (extract → validate → align-by-onset → calibration-normalize),
   producing a single pooled stack of aligned-normalized cycles per
   channel. Per-cycle alignment uses the per-cycle calibration
   onset, so all cycles across all measurements share the same
   onset reference.
2. Pool every channel's surviving cycles into one stack
   (`pooled_cycles_per_channel[c]` shape `(N_cycles, T)`). All cycles
   in the pool went through the SAME canonical pipeline output —
   no per-subset alignment / normalisation differences.
3. Per channel, randomly partition the cycle indices into two halves
   using a deterministic seed `hash(scenario_name) & 0xFFFF` so
   reruns reproduce the same split. (v1 partitioned MEASUREMENTS,
   not cycles — v2 fix.)
4. Average each half: `signal_A = mean(pool[half_A])`,
   `signal_B = mean(pool[half_B])`.
5. Compute `diff(t) = signal_A(t) − signal_B(t)`.
6. Compute the **signal envelope** = Hilbert magnitude of
   `signal_full(t)`, then Gaussian-smoothed with σ = 20 ms (v3).
   This smoothing is heavy enough to flatten cycle-level ripple, so
   the result is "almost monotonically decreasing" — a clean trace
   of the IR decay shape (see boundary handling note below).
7. Compute the **diff envelope** = Hilbert magnitude of `diff(t)`,
   smoothed with the same Gaussian σ. Because `diff` is dominated by
   uncorrelated cycle-to-cycle noise, this trace is "relatively
   stable" — a slow drift around the noise floor.
8. Find the **last** sample index `t` where
   `env_diff[t] / env_signal[t] < qc_threshold` (default 0.1) AND
   the ratio has stayed below for the preceding `sustained_ms`
   (default 10 ms = trailing-window gate that prevents a single noise
   spike from defining `T_eff`). That sample is the **Effective
   Signal Length** (`T_eff`). The recording is reliable up to `T_eff`
   and unreliable thereafter. `null` is returned only when no
   sustained-below window exists at all (the recording was
   unreliable from sample 0).
9. The QC step runs on the FULL pre-truncation mean, not the
   fadeout-shaped truncated array — the fadeout would mask the
   noise tail and produce a falsely-late T_eff.

**Why last-crossing, not first-crossing? (dev-qcthr)** The diff
envelope routinely dips back below threshold AFTER the noise has
started dominating (cycle-to-cycle noise is bursty, not monotonic).
First-crossing answered "when does the noise envelope FIRST exceed
10 % of signal" — but the noise can return to compliance briefly
after that, and the truly meaningful boundary is "when does the
agreement fail PERMANENTLY." Last-crossing scans backwards for the
last sample where the trailing 10 ms window is still all-below
threshold; that is the operationally useful "the recording is good
up to here" boundary.

**Boundary handling.** Hilbert magnitude has a well-known
boundary-build-up artefact at finite-signal endpoints (the
analytic-signal FFT pretends the input is periodic, so a
discontinuity between the last and first sample raises `|H[N-1]|`
to arbitrary values). The Gaussian smoother uses `mode="reflect"`
to mirror the decaying tail across the boundary so the artefact
does not propagate into the smoothed envelope and falsely extend
`T_eff` to the very last sample. (Hit during dev-qcthr verification
on `PlyWoodTake11/Sc14/ch5`: `mode="nearest"` gave `t_eff = 999.98 ms`
on a signal that decayed by ~250 ms; `mode="reflect"` gives
`t_eff = 207 ms`.)

**Why split-half on cycles, not measurements?** A measurement-level
split (v1) leaves per-measurement processing artefacts in `env_diff`:
each measurement's `align_cycles_by_onset` picks its own highest-
energy reference cycle, then the correlation filter drops cycles
based on similarity to that per-measurement reference. The surviving
cycles from measurement K aren't statistically independent of the
reference for measurement K. When the split places whole measurements
on opposite sides, that per-measurement reference variance leaks into
`env_diff` and biases T_eff downward.

A cycle-level split (v2) draws each half from the same canonical
pool, so both halves see the same alignment and normalisation
output. The remaining variance in `env_diff` is genuine cycle-to-
cycle measurement noise — exactly what we want to compare against
the signal envelope.

Empirical impact on `PlyWoodTake1_1` (30 scenarios) when switching
from v1 → v2:

| Metric | v1 (measurement-split) | v2 (cycle-split) |
|---|---|---|
| Median scenario T_eff | 56.8 ms | **135.6 ms** |
| Max scenario T_eff | 199.7 ms | **287.4 ms** |
| Scenarios at T_eff = 0 ms | 2 (Sc 12, 23) | 1 (Sc 5) |
| Best-case channel rms_diff_pct | 4-5% | 4-5% |
| Worst-case channel rms_diff_pct | 16-17% | 8-9% |

(Sc 5's residual T_eff = 0 is a deferred follow-up — appears to be
genuine cycle-to-cycle variance on one channel, not an algorithmic
artefact. See `WORK_IN_PROGRESS.md` dev-qc02 entry.)

**Why split-half (general)?** A single mean hides per-measurement
variance. Halving the dataset two ways and averaging each half
independently preserves the signal (both halves contain the
deterministic response) while exposing the noise (each half sees a
different random sample of cycle-to-cycle variance, variance that
would otherwise cancel in the full mean). The point at which the
noise envelope grows to a fixed fraction of the signal envelope is
the operational definition of "the signal is no longer reliably
reproducible past here."

**Output.** Per-scenario JSON written to
`<scenario>/averaged_responses/effective_signal_length.json`:

```json
{
  "version": 3,
  "scenario_name": "PlyWood-Scenario3-Take1",
  "qc_status": "computed",
  "split_seed": 12345,
  "envelope_method": "hilbert",
  "smoothing_ms": 20.0,
  "smoothing_kind": "gaussian",
  "t_eff_definition": "last_sustained_below_threshold",
  "threshold": 0.1,
  "qc_threshold": 0.1,
  "sustained_ms": 10.0,
  "calibration_channel": 0,
  "response_channels": [1, 2, 3],
  "n_measurements_total": 18,
  "n_measurements_kept": 18,
  "n_cycles_per_channel": {"0": 90, "1": 90, "2": 90, "3": 90},
  "n_cycles_per_half_a": 45,
  "n_cycles_per_half_b": 45,
  "sample_rate": 48000,
  "per_channel_t_eff_ms": {"0": null, "1": 920.5, "2": 880.0, "3": 905.2},
  "per_channel_t_eff_samples": {"0": null, "1": 44184, "2": 42240, "3": 43450},
  "per_channel_detail": { /* full QC dict per channel + n_cycles_total/half_a/half_b */ },
  "scenario_min_t_eff_ms": 880.0
}
```

**Schema-v1 → v2 field changes (dev-qc02):**

- Removed: `n_measurements_per_half_a`, `n_measurements_per_half_b`
  (the algorithm no longer splits at measurement level).
- Added: `n_cycles_per_channel` (dict `{channel_idx_str: n_cycles}`),
  `n_cycles_per_half_a`, `n_cycles_per_half_b` — describe the
  cycle-level partition that actually produced T_eff.
- Added: `qc_threshold` (explicit alias of the existing `threshold`
  field — frontend should prefer reading `qc_threshold`). Records
  whichever threshold was supplied via REST `qc_threshold` form/body
  field, or the module default 0.1 if omitted.

**Schema-v2 → v3 field changes (dev-qcthr):**

- `version` bumped to `3`.
- `smoothing_ms` default changed from `5.0` (uniform-window width)
  to `20.0` (Gaussian σ). Number is the same field but the unit
  semantics depend on `smoothing_kind`.
- Added: `smoothing_kind` — `"gaussian"` (new default) or
  `"uniform"` (legacy v1/v2 behaviour, still selectable for
  backward-compat). For `"uniform"`, `smoothing_ms` is the full
  window width; for `"gaussian"`, it is the Gaussian sigma.
- Added: `t_eff_definition` — algorithm tag, currently
  `"last_sustained_below_threshold"`. Frontends and downstream
  readers should branch on this string when interpreting `t_eff_ms`
  alongside `version`.
- The semantics of `t_eff_ms` changed: now the LAST sample of
  sustained agreement (was the FIRST sample of sustained
  disagreement). The downstream meaning ("the recording is reliable
  up to this many ms") is preserved — frontend warning surfaces
  (`EspritConfig.jsx`'s "Eff signal: N ms" caption,
  EffectiveSignalLengthRerunDialog's truncation prompt, ProjectInfo
  card's QC chip) continue to work unchanged.

**Schema readers must accept v1, v2, or v3.** Existing v1/v2 JSON on
disk stays readable — the newer fields will simply be missing on
older files. Re-run the averager (force=True) or hit
`POST /modal/projects/<n>/effective_signal_length` to upgrade
existing projects to v3 numbers.

**`qc_status` values:**

| Status | Meaning |
|---|---|
| `computed` | Split-half ran successfully; per-channel T_eff is populated. |
| `skipped_too_few_measurements` | Fewer than 4 surviving measurements after validate/align — split-half needs at least 2 per half. T_eff is `null` everywhere. |
| `skipped_no_response_channels` | Only the calibration channel was present (rare data-shape error). |

**`per_channel_t_eff_ms` semantics (v3 last-crossing):**

- `null` for the calibration channel — ALWAYS skipped because the
  calibration signal is a sharp impulse (not a decaying response), so
  envelope-ratio noise analysis is meaningless on it.
- `null` for response channels ONLY when no sustained-below window
  exists at all (i.e. `env_diff/env_signal ≥ threshold` from sample
  0 — the recording was unreliable from the start). v1/v2
  semantically returned `null` here AND when the signal was reliable
  to the end; v3 separates the two: an end-to-end reliable signal
  reports `t_eff_ms ≈ signal_length_ms` (the trailing-window
  condition holds at the very last sample).
- Numeric value: T_eff in milliseconds — the last sample where the
  trailing 10 ms of the noise-envelope-to-signal-envelope ratio is
  still under threshold. Beyond this point the agreement is no
  longer reliable.

**Aggregation across channels per scenario:** `scenario_min_t_eff_ms`
is `min(per-channel T_eff)` across response channels — the most
pessimistic value, since one bad channel makes the whole scenario
unreliable past that point. `null` when every channel was either
skipped or fully reproducible.

**Aggregation across scenarios per project:** the project-level summary
(`global_min_t_eff_ms` in the `effective_signal_length_summary` field of
each project's `/modal/projects` entry) is `min(scenario_min_t_eff_ms)`
across every scenario that produced QC. This is the canonical "longest
per-band `ir_length_ms` safely supported on every scenario × response
channel in this project."

**Frontend warning surface.** The ESPRIT settings panel
(`EspritConfig.jsx`) reads the project's QC summary on mount and shows:

- An **orange Alert** above the band table when one or more bands
  request `ir_length_ms` exceeding `global_min_t_eff_ms`.
- A **per-row warning icon** (with tooltip) next to each offending
  band's IR (ms) input.
- A **"Eff signal: N ms"** caption next to the band-count showing the
  current project's measured T_eff (or "Eff signal: full" when every
  channel is reproducible across the full duration).

**Interactive QC inspection panel (dev-3151, 2026-05-06).** A
collapsible Accordion ("Averaging Quality Inspection") under the
Setup section of the Modal Adapter UI surfaces the underlying QC
curves so the user can investigate WHY a particular scenario or
channel reports a short T_eff:

- **Scenario + channel selectors** — pick any scenario × response
  channel pair (calibration channel is hidden — QC isn't meaningful
  on it).
- **Six view modes:**
  - *Curves* — overlay `signal_a` (half-A mean, blue) and
    `signal_b` (half-B mean, orange). Where the two diverge is
    where the underlying measurement noise exceeds reproducibility.
  - *Difference* (dev-qcdiff revision) — `signal_a − signal_b`
    raw diff (purple), its smoothed envelope `env_diff` (pink), and
    `env_signal` (the full-signal envelope, dashed grey) overlaid as
    a **scale reference**. The reference trace anchors the Y-axis to
    the source signal envelope (~0.12 on a typical IR) so the diff
    appears as the small ripple it actually is. Without it the Y-axis
    auto-scales to the diff range only (~0.005), inflating the diff
    visually to fill the chart and misleading users into reading
    "the diff is huge" when in fact it's ~5% of the signal.
  - *Envelopes* (dev-qcdiff follow-up) — `env_signal` (solid blue)
    and `env_diff` (solid purple) on a single signal-scale Y-axis.
    Dedicated inspection surface for the two smoothed envelopes the
    threshold algorithm operates on (env_signal × threshold defines
    the noise budget; env_diff measures the actual half-A vs half-B
    deviation). The T_eff vertical marker carries through so the
    user can see where env_diff approaches its budget.
  - *Ratio* — `env_diff / env_signal` time series with the
    threshold drawn as a horizontal dotted line. The first
    sustained crossing is T_eff.
  - *Combined* (dev-qccmb / dev-qcdiff revision) — `signal_a`
    (blue), `signal_b` (orange), and `signal_a − signal_b` (purple)
    overlaid on a SINGLE shared Y-axis. The earlier dual-axis design
    (signals on left, diff on right, dev-qccmb 2026-05-06) misled
    users by auto-scaling the diff so its pixel-height matched the
    signals despite representing ~1/18 the amplitude. The shared
    axis tells the truth at-a-glance: when halves agree, the diff
    is a small flat line near zero. Use the Y-zoom buttons (Step+/
    Step−) to drill into diff detail when needed.
  - *All-combined* (dev-qcdiff follow-up #3) — every trace at once
    on a literally **zero-based** Y axis (`yAxis.min = 0`):
    - signed signals (`signal_a` blue, `signal_b` orange,
      `signal_a − signal_b` purple) at thinner stroke + reduced
      opacity (background context role)
    - envelopes (`env_signal` blue solid, `env_diff` purple solid)
      at standard width + full opacity (foreground primary role)

    Per the user's explicit choice, signed signals visually clip at
    `y=0`: only their positive lobes render. The data is NOT
    rectified or shifted — the negative half is simply outside the
    rendered Y range. This view exists to evaluate "how much of the
    signal envelope budget is the half-A vs half-B disagreement
    consuming?" with the signed signal traces as contextual
    background. yZoomAnchor: zero-bottom (matches the literal axis
    floor).
- **Zoom controls** (dev-qcdiff follow-up #2 + #4 — anchor rule +
  X persistence) —
  - **Horizontal zoom is slider-only AND persists across view
    switches.** The visible X-axis slider below the chart (drag
    handles to crop the time range) is the sole horizontal control
    surface. Mouse wheel does NOT zoom X; no toolbox rect-zoom; no
    inline X-zoom buttons. The user's slider drag is **persisted in
    React state** (`xDataZoomWindow`) and re-applied on every
    re-render — including view-mode switches — so the same time
    window stays visible as the user toggles Curves → Difference →
    Envelopes → … to inspect a specific event across views. The
    Reset Zoom button wipes this persistence in addition to issuing
    `dispatchAction({type:"restore"})`.
  - **Vertical zoom by Step+/Step− buttons** in the panel toolbar
    follows a strict per-view ANCHOR rule (no pan along axis), and
    is intentionally **NOT persisted** — each view has its own
    anchor and resets on switch:
    - **zero-bottom** views (*Envelopes*, *Ratio*, *All-combined*) —
      non-negative quantities (or, in All-combined's case, a
      literal zero-based axis). Bottom of axis pinned to 0; only
      the top edge scales. Each Step+ click multiplies the top
      edge by 0.7; Step− divides by 0.7.
    - **zero-center** views (*Curves*, *Difference*, *Combined*) —
      signed quantities. Axis is symmetric around 0; both edges
      scale together preserving |y|=|y|. Each Step+ click
      multiplies the half-range by 0.7; Step− divides by 0.7.
    `shift+wheel` also zooms Y (free-form, no anchor) as a
    power-user shortcut alongside the buttons.
  - **Reset Zoom** IconButton restores both axes to full range AND
    wipes the persisted X window.
  - **Implementation note** — the Y dispatch uses ECharts'
    `dataZoomIndex: 0` (the Y `inside` component) with
    `startValue`/`endValue` (data-space). An earlier design used
    `yAxisIndex: [0, 1]` — that property is NOT recognised by
    ECharts' `dataZoom` action and the dispatch silently fanned
    out to ALL dataZoom components, including the X-axis slider,
    which moved the visible time window as a side-effect. Live-
    verified against ECharts 5.5.0.
  - **X-persistence implementation** — both dataZoom components
    carry stable `id`s (`qcYInside`, `qcXSlider`). A `datazoom`
    event listener on the chart reads the X slider's current
    `start`/`end` from `inst.getOption().dataZoom` (looked up by
    id, robust to event-payload variation) and writes them to
    React state. The X slider's option re-reads this state on
    every render, so view switches preserve the user's selection.
- **Mutable threshold** — Slider [0.05, 0.50] step 0.01 + paired
  monospace numeric input. Default = the project's persisted
  `qc_threshold` (0.10 unless overridden at create time).
  Threshold sweeps recompute T_eff client-side against the cached
  ratio array (no backend round-trip per slider tick).
- **Readouts** — T_eff at the slider's threshold (with the
  persisted T_eff at the project's threshold shown in parentheses
  for comparison); ratio at the very last sample plus the median
  over the trailing 50 ms (more robust against single-sample edge
  effects); cycle counts (total / half_a / half_b).

The panel is **read-only**: changing the threshold slider does NOT
modify any persisted state. The persisted
`effective_signal_length.json` remains the source of truth for the
project-level warning surface (EspritConfig). To change the
persisted threshold, use the Quality Threshold field at project
create time or POST to `/effective_signal_length` with a
`qc_threshold` body field (dev-qc02).

The panel re-runs the canonical pipeline on demand (~1-2 s on first
request per scenario) via the new
[`GET /modal/projects/<n>/qc_curves`](#interactive-qc-curves-endpoint-dev-3151)
endpoint. The backend caches the per-scenario POOLED CYCLES (not
the per-channel curves) in an LRU capped at 16 entries, so channel
switches against the same scenario hit the cache (~280 ms vs
~670 ms cold on a typical 1-second 8-channel scenario).

**Backward compatibility.** Projects whose `averaged_responses/` were
generated BEFORE dev-qc01 lack the QC json. The frontend interprets
this as "QC unavailable" and does NOT show any warning. To populate QC
for a legacy project, POST to
`/modal/projects/<name>/effective_signal_length` (no body) — this
re-runs the canonical averager with `force=True`, which rewrites
`average_ch*.npy` AND writes the QC json. Raw recordings must still be
on disk; legacy projects whose source was pruned to averages-only
cannot be retroactively QC'd.

**REST endpoints.**

- `GET /modal/projects` includes `effective_signal_length_summary` per
  project (or `null` when QC is unavailable). Roll-up only — for the
  per-channel and per-scenario detail use the next endpoint.
- `GET /modal/projects/<name>/effective_signal_length` returns the
  full per-scenario detail map (every QC json under one envelope).
- `POST /modal/projects/<name>/effective_signal_length` recomputes QC.
  Body `{ "scenarios": [...] }` (optional) restricts to specific
  scenario folder names; without it every scenario the project has
  raw_recordings for is recomputed. Returns the same payload as GET
  plus `recomputed_scenarios` (count) and `averaging_summary`.
- `POST /modal/projects/<name>/reaverage` (dev-cp01, 2026-05-05) —
  re-runs the canonical averager on every scenario of an existing
  project against its already-resolved measurement source folder
  (the on-disk extracted tree from import time). Body:
  `{ "ir_working_length_ms": float (optional), "force": bool (default true) }`.
  Persists the new `ir_working_length_ms` to `project.json` so
  `open_project` and the ProjectInfoCard reflect the new length.
  Returns the same payload as the QC GET endpoint plus
  `averaging_summary` and `ir_working_length_ms`. Used by the
  EffectiveSignalLengthRerunDialog to extend or shorten an existing
  project without re-uploading the source zip. Errors:
  - `404` — project does not exist
  - `400` — project has no resolvable measurement source folder
    (raw_recordings pruned), or `ir_working_length_ms` is non-numeric

#### Interactive QC curves endpoint (dev-3151)

- `GET /modal/projects/<name>/qc_curves?scenario=<sname>&channel=<idx>[&qc_threshold=<float>]`
  (dev-3151, 2026-05-06) — returns the time-domain QC curves for one
  (project, scenario, channel) tuple. Backs the
  [Interactive QC inspection panel](#interactive-qc-inspection-panel-dev-3151-2026-05-06).
  Re-runs the canonical pipeline on the scenario's `raw_recordings/`
  to produce `signal_a` (half-A mean), `signal_b` (half-B mean),
  `signal_full` (canonical full mean), `signal_diff` (a − b),
  `env_signal` + `env_diff` (smoothed Hilbert envelopes), and
  `ratio` (env_diff / env_signal, safe-divided). Optional
  `qc_threshold` query param overrides the env_diff/env_signal ratio
  gate ONLY for the server-side `t_eff_ms` field in the response —
  the panel mutates the threshold client-side via its own
  recompute on the returned `ratio` array, so most calls omit it.
  Per-process LRU cached on `(project, scenario)` for the SLOW part
  (cycle pooling); channel switches inside the same scenario reuse
  the pool.

  Response payload schema is documented in
  [`docs/modules/pianoid-middleware/REST_API.md` `/qc_curves`](../modules/pianoid-middleware/REST_API.md#get-modalprojectsnamesqc_curves).

  Errors:
  - `400` — invalid channel (calibration channel, non-integer,
    non-response), invalid `qc_threshold` (non-numeric or outside
    `(0, 1)`), or missing required query params.
  - `404` — project, scenario, or scenario raw_recordings not
    found; too few cycles surviving for split-half (< 4).
  - `500` — canonical pipeline crash (RoomResponse import failure,
    unexpected error).

**Default values are tuned for impulse-response measurements:**

| Parameter | Default (v3) | Rationale |
|---|---|---|
| `threshold` | 0.1 | env_diff/env_signal ratio ≥ 0.1 ≈ -20 dB SNR per split |
| `smoothing_kind` | `"gaussian"` | Preserves IR decay shape, suppresses cycle-level ripple far better than uniform smoothing of comparable cost |
| `smoothing_ms` | 20.0 | Gaussian σ in ms. Produces a near-monotonically-decreasing signal envelope on real IR data (~70 % decreasing pairs vs ~50 % for uniform 5 ms) |
| `sustained_ms` | 10.0 | Trailing-window length; a real noise tail is sustained, transient envelope spikes are not |
| `envelope_method` | `"hilbert"` | Standard analytic-signal envelope; `"rms"` is also accepted |
| `t_eff_definition` | `"last_sustained_below_threshold"` | Tag — current algorithm is last-crossing (was first-crossing in v1/v2) |

These are NOT exposed as project config — change them in
`pianoid_middleware/modal_adapter/scenario_averager.py` (constants
`QC_DEFAULT_THRESHOLD`, `QC_DEFAULT_SMOOTHING_MS`,
`QC_DEFAULT_SMOOTHING_KIND`, `QC_DEFAULT_SUSTAINED_MS`,
`QC_DEFAULT_ENVELOPE_METHOD`, `QC_T_EFF_DEFINITION`) and re-run the
averager. Frontend exposure of these knobs is a deferred follow-up.

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
window_length, **ir_length_ms**, **skip_start_ms**). The last two are per-band overrides
that default to `None` for `standard_4band` (legacy: use full averaged signal, no skip)
and to per-band values for `extended_8band` (see "Per-band IR length and start-skip" below).

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

#### Per-band IR length and start-skip

The advanced per-band table exposes two related per-band overrides that
let each band trade time-window length and start-pollution against
frequency resolution and SNR:

- **IR (ms)** (`ir_length_ms`, dev-ir01 2026-05-04) — truncates the
  averaged signal to this many milliseconds **BEFORE** bandpass +
  decimation. The relation `df = fs_band / L = 2 / T_total` means
  frequency resolution is preserved when you halve decimation AND halve
  sample count; only the usable Nyquist (anti-alias = `0.4 * fs_band`)
  changes. Lower bands need more time samples (longer IR) for fine
  frequency resolution at low f; higher bands can use shorter IRs
  (less GPU memory, faster ESPRIT). Empty = use the full averaged signal.
- **Skip (ms)** (`skip_start_ms`, dev-07b4 2026-05-05) — discards the
  first N milliseconds of each band's signal **AFTER** bandpass +
  decimation + preemphasis (LAST step before metadata). Removes two
  pollution sources at once: the **forcing-function transient** (hammer
  impact decaying, which ESPRIT otherwise fits as wide-band high-damping
  ghost modes) and the **Butterworth `sosfiltfilt` zero-edge-state
  settling region** (`~10*order/(2*pi*f_min)` seconds at the start).
  Empty = no skip.

`extended_8band` ships with the following per-band defaults
(`(ir_length_ms, skip_start_ms)`):

| Band      | f_min  | f_max  | dec | IR (ms) | Skip (ms) |
|-----------|--------|--------|-----|---------|-----------|
| Ultra-Low | 30     | 100    | 4   | 1000    | **50**    |
| Low       | 80     | 200    | 4   | 800     | **30**    |
| Low-Mid   | 180    | 400    | 4   | 600     | **15**    |
| Mid       | 350    | 700    | 2   | 400     | **5**     |
| Mid-High  | 600    | 1200   | 2   | 400     | 0         |
| High      | 1000   | 2500   | 1   | 400     | 0         |
| Upper     | 2000   | 4500   | 1   | 400     | 0         |
| Top       | 4000   | 6000   | 1   | 400     | 0         |

Skip defaults carry ~2-3x margin over the rough Butterworth settling
estimate to also cover the dominant hammer-impact transient. Top 5 bands
are 0 because at `f_min >= 600 Hz` the pollution region is sub-millisecond
and rounds to zero samples post-decimation. `standard_4band` leaves both
fields `None` for every band (fast first-pass; no per-band tuning).
See [`SKIP_START_MS_RATIONALE.md`](../development/SKIP_START_MS_RATIONALE.md)
for the design notes and Allemang & Brown reference.

#### Per-band fade-in and tail fade-out

Two additional per-band fields shape the *amplitude envelope* of each
band's signal independently of all other bands. Both apply inside
`process_band` and operate on the post-decimation, post-skip signal.
They sit alongside `IR (ms)` and `Skip (ms)` in the EspritConfig
advanced table.

- **Start fade (ms)** (`start_fade_ms`, dev-esrt 2026-05-06) — a
  half-Hann window over the FIRST `round(start_fade_ms * fs_band / 1000)`
  samples (`np.hanning(2N)[:N]`, ramping from 0 up to ~1). Eliminates
  the step discontinuity introduced by `skip_start_ms > 0`. Without
  this fade-in, the implicit `0 → x[0]` jump at the new sample 0 of
  the post-skip signal generates `1/f` spectral leakage that overlaps
  the ESPRIT analysis band. **Measurement on real PlyWoodTake1_1
  averaged_responses (4 scenarios × 4 low bands)** found the
  `|x[0]| / peak` ratio at the cut routinely 30–95 %, peaking at
  95 % for the Low band on Scenario0 — the worst-case `0 → peak` step
  is essentially the most spectrally costly discontinuity possible.
  Only meaningful when `skip_start_ms > 0`; bands without a skip
  carry a natural zero onset (impulse-response reference) and a
  fade-in would corrupt early-time mode information. Empty = no
  fade-in. See `band_processing.py` `process_band` and
  `tests/unit/test_band_processing_end_fade.py` for the contract.

- **End fade (ms)** (`end_fade_ms`, dev-esrt 2026-05-06) — a half-Hann
  window over the LAST `round(end_fade_ms * fs_band / 1000)` samples
  (`np.hanning(2N)[N:]`, ramping from ~1 down to 0 — last sample is
  exactly zero). Suppresses tail-noise contribution to ESPRIT mode
  estimation, layered on top of the project-wide scenario-level Hann
  fade applied during the `averaged_responses/` averaging step (see
  `scenario_averager.py` `ir_fade_length_ms`, default 20 ms across
  every scenario). The scenario fade is **shared across all bands**;
  the per-band end fade lets each band tune its own
  resolution-vs-tail-noise trade-off independently. Empty = no
  per-band tail fade.

Application order inside `process_band` (each step optional via
field=None / 0):

```
ir_length_ms slice → bandpass → preemphasis → decimation
                                            → skip_start_ms (start trim)
                                            → start_fade_ms (fade-in)
                                            → end_fade_ms   (fade-out)
```

`extended_8band` ships with the following per-band defaults
(`(start_fade_ms, end_fade_ms)`):

| Band      | f_min  | f_max  | Skip (ms) | Start fade (ms) | End fade (ms) |
|-----------|--------|--------|-----------|-----------------|---------------|
| Ultra-Low | 30     | 100    | 50        | **10**          | **20**        |
| Low       | 80     | 200    | 30        | **10**          | **20**        |
| Low-Mid   | 180    | 400    | 15        | **5**           | **15**        |
| Mid       | 350    | 700    | 5         | **2**           | **10**        |
| Mid-High  | 600    | 1200   | 0         | None            | **10**        |
| High      | 1000   | 2500   | 0         | None            | **5**         |
| Upper     | 2000   | 4500   | 0         | None            | **5**         |
| Top       | 4000   | 6000   | 0         | None            | **5**         |

`start_fade_ms` defaults are ~20–40 % of the corresponding
`skip_start_ms` — long enough to smoothly cover the cut, short enough
to leave most of the post-skip signal untouched. Mid-High through Top
are `None` because they don't carry a skip (no discontinuity to mask).
`end_fade_ms` defaults follow the lower-bands-need-longer-fades
pattern (`[20, 20, 15, 10, 10, 5, 5, 5]` ms): low-frequency cycles
are longer so more tail material can be safely tapered without losing
mode information; high-frequency cycles are shorter so the tail
fade-out must be more conservative.

`standard_4band` leaves both fields `None` on every band — fast
first-pass preset with no per-band envelope shaping; relies on the
project-wide scenario fade alone.

**Frontend lock semantics.** Both new columns inherit the existing
"Settings freeze rules" (Channel Mapping + Band Configuration are
locked once ESPRIT has been run on any scenario; both fade fields
are part of Band Configuration). `standard_4band` users can flip a
single band to add fade-in or fade-out via the Advanced expander,
which sets `preset = "custom"` and persists the per-band override
into the project's persisted band config.

### Tracking Section

Mode tracking links detected modes across scenarios into **chains** — sequences of the same
physical mode observed at different piano keys. Tracking runs on ALL processed scenarios
(accumulated across ESPRIT runs), not just the current selection.

**Algorithm:** Three methods are available — see
[`MODE_TRACKING_REDESIGN.md`](../development/MODE_TRACKING_REDESIGN.md) for the
historical design and
[`MODE_TRACKING_NUCLEI_MERGE.md`](../development/MODE_TRACKING_NUCLEI_MERGE.md)
for the 3-stage default method.

- `nuclei_merge` (**default since dev-d773, 2026-05-05; recommended**) — 3-stage algorithm:
  nuclei detection (HIGH-MAC sliding window) → weighted nuclei merging (full coverage ×
  overlap matrix; damping is HARD GATE only) → stray-point assignment.  Addresses the
  over-broad-cluster failure mode where the previous default's greedy peeling produced a
  "junk drawer" cluster (chain 7 in `tmp8c7q0lu0` — 8 detections, R²=0.10 freq smoothness,
  shape_consistency 0.626) that should have had its coherent sub-cluster merged with a
  neighbouring tight cluster.  Also resolves the high-coverage / low-overlap / large-
  frequency-drift case that `sliding_window`'s narrow `_merge_split_chains` 6 % gate cannot
  catch.  Layout-agnostic (works for both `line` and `grid`).  Returns intermediate Stage-1
  nuclei via the `nuclei_stage_chains` field for the stab-diagram nuclei view toggle.
- `sliding_window` — **legacy default** (was the default before dev-d773; still available
  via explicit `tracking_method="sliding_window"`). Adaptive frequency-window clustering
  with MAC-based hierarchical agglomeration.  Layout-agnostic.  As of dev-3st1 (2026-05-04),
  runs `_merge_split_chains` post-step (always-on; the `sw_post_merge` config field
  defaults to `True`).  Use this when you want the legacy behaviour or for comparison.
- `sequential` — **DEPRECATED as of 2026-05-04.** Per-bridge Hungarian assignment with
  MAC-verified cost function. Only supported for `layout_type="line"` (raises
  `NotImplementedError` on `grid`). Emits a `DeprecationWarning` on use. Will be removed
  in a future release; use `nuclei_merge` (default) or `sliding_window` (explicit) instead.

**Parameters** (in settings panel when Tracking is active): the editable fields **Freq
Tolerance %** (default `0.03`) and **Max Gap** (default `5`) drive the sequential
method's `freq_tol_pct` and `max_gap` (see
[`MODE_TRACKING_REDESIGN.md` § 7](../development/MODE_TRACKING_REDESIGN.md#7-configuration-parameters)).
For the legacy `sliding_window` method, these two fields have no effect — the
sliding-window parameters (`sw_*`) live in `TrackingConfig` source defaults and are
exposed via the EspritConfig advanced UI rows.  For the **default** `nuclei_merge` method,
the per-stage MAC thresholds (`nm_nucleus_mac_threshold`, `nm_merge_min_mac`,
`nm_stray_min_mac`) AND all stage weights and score thresholds are surfaced as
editable rows in the same panel — see
[`MODE_TRACKING_NUCLEI_MERGE.md` § 2](../development/MODE_TRACKING_NUCLEI_MERGE.md#2-three-stage-pipeline).

**Settings freeze rules.** Channel Mapping and Band Configuration are locked once ESPRIT
has been run (their values shape the extraction so changing them post-extraction would
silently invalidate per-scenario results). Tracking-section inputs (Tracking Method,
Freq Tolerance, Max Gap, the `nm_*` MAC threshold rows) and the Grid Layout editor
**stay editable after ESPRIT finishes** (dev-c807 Bug 7) — they only freeze WHILE ESPRIT
or tracking is actively running. This lets users retune tracking parameters and re-run
`/tracking` against the cached extraction without going through Reset.

**Re-tracking resets the editor (dev-md06 Bug B).** A second `Run Tracking` click on the
same project rebuilds chains from scratch on the backend (and clears the
in-memory chain edit history — the snapshot stack's IDs would no longer match). The
backend bumps `tracked_chains_version`; the frontend's effect keyed on that counter
clears the local stabilization-diagram cache and resets `editedChains` to `null` so the
init effect re-fires with the fresh chain set. Without this, the stab-diagram +
chain-data table would keep showing pre-retrack assignments because the previous init
effect was gated on `editedChains === null`.

**Lock-state visual feedback (dev-md04 Bug 2).** The toolbar Settings gear icon stays a
gear at all times — it does not swap to a Lock icon when ESPRIT has run (the previous
behaviour was misleading because the panel still opens fully, and Tracking + Grid Layout
fields stay editable). Lock state is communicated exclusively by per-section "🔒 Locked"
Chips inside Channel Mapping and Band Configuration accordion summaries — those sections
also `disabled`-prop their fields, so the visual + behavioural cues stay aligned. The
panel-wide opacity dim and the top-of-panel "ESPRIT has started — Settings locked"
banner were also removed for the same reason: they implied the entire panel was
read-only when only two sections actually were.

**Stabilization diagram** — scatter plot. Colors: green=stable, yellow=semi-stable,
orange=weak, gray=spurious. Blue=selected. Click points to view mode shapes.

- Line layout: X-axis is `Scenario`. The bass/treble bridge boundary is shown as a
  dashed red line.
- Grid layout: X-axis is `Grid point index` (cell IDs are not 1-D-positional). The
  bridge-boundary marker is hidden. **A per-chain 2-D heatmap inset renders above the
  stabilization diagram showing the selected chain's amplitude at every populated grid
  cell** — transparent for cells with no detection. The heatmap container holds an
  `aspectRatio: nCols / nRows` constraint so cells render as squares regardless of
  pane width (dev-c807 Bug 3). The heatmap header now includes a
  `(N populated / M total cells)` summary so users see at-a-glance that low-coverage
  chains legitimately render fewer points than there are grid cells (dev-md04 Bug 1) —
  e.g. a chain with 6 detections on a 5×6 grid shows `6 / 30 cells`, not "the heatmap
  is broken". The inset can be toggled on/off via the **Heatmap** button in the chart
  sub-toggle row (next to Damp/Amp/MAC/Shape/Proj — dev-md04 Bug 3); only visible on
  grid-layout projects. See
  [`MODE_TRACKING_GRID_LAYOUT.md`](../development/MODE_TRACKING_GRID_LAYOUT.md).

**Heatmap + shape side-by-side layout (dev-md07).** When BOTH the
**Heatmap** and **Shape** toggles are active in the chart-sub-toggle row,
the heatmap inset moves from its default above-scatter slot into a 30/70
horizontal row below the scatter chart, side-by-side with the SHAPE
sub-chart (heatmap left, shape right). This pairs the spatial and
spectral views of the selected chain on a single visual line. When SHAPE
is off, the heatmap returns to its above-scatter slot. When HEATMAP is
off, the shape sub-chart renders full-width below the scatter as before.

**Heatmap fill + smoothing controls (dev-md07).** A controls subrow
appears immediately below the chart-sub-toggle row whenever the HEATMAP
toggle is on (and the project is grid layout):

- **Heatmap fill**: ToggleButtonGroup with `None` / `Linear` / `Planar`.
  - `None` (default) — empty cells render transparent, exact pre-dev-md07
    behaviour.
  - `Linear` — reserved API for future 1-D heatmap use; in grid layout it
    falls back to `Planar`.
  - `Planar` — empty cells get filled by a 2-D plane fit
    (`z = a*x + b*y + c` via `np.linalg.lstsq` on populated `(x_mm, y_mm,
    value)` tuples). Same algorithm
    [`external_export.approximate_planar`](../modules/pianoid-middleware/REST_API.md#export-to-text-files-dev-6c54c87f)
    uses for the text-export tool, so the heatmap visualisation matches
    the export at-a-glance. Originally-measured cells are written back
    verbatim — the planar fit only fills holes.
- **Smooth σ**: Slider 0–2 step 0.1 (Gaussian σ in cells). Backend applies
  `scipy.ndimage.gaussian_filter` to the (possibly filled) grid AFTER the
  approximation pass. Smoothing acts only on cells that already have a
  value — to fill empty cells the user must ALSO pick an approximation.
  At σ = 0 (default) smoothing is disabled.

Both controls are forwarded to the backend as query params on
`GET /modal/grid_heatmap/<chain_id>?approximation=...&smoothing=...`
(see [REST_API.md](../modules/pianoid-middleware/REST_API.md#per-chain-grid-heatmap)).
The heatmap refetches automatically whenever either control changes.

**Per-point hover annotation** — hovering a point on the stabilization diagram surfaces
`Scenario N · Freq F Hz · Chain ID (stability) — K scenarios · MAC: 0.xxx · Damping D`
(dev-c807 Feature 6). The "K scenarios" field is the chain's `detection_count`, exposing
chain richness at-a-glance. The `MAC: 0.xxx` field is the chain's
`quality.shape_consistency` — mean pairwise MAC across the chain's detections, computed
backend-side in `mode_tracking.compute_chain_quality` and shipped on every chain. Renders
as `MAC: —` when the chain has no shape data (very short chains or shape-less detections).

**Stability summary chips** — above the diagram, one chip per stability category showing
`<category> <count> (Av. Sc. <avg>)` where `Av. Sc.` is the rounded mean of
`detection_count` across chains in that category (dev-c807 Feature 6). Example layout:
`weak 139 (Av. Sc. 7) · semi-stable 75 (Av. Sc. 14) · stable 77 (Av. Sc. 20)`. Lets the
user gauge cluster quality per category at a glance.

**Chart selection vs export selection (dev-md07).** The frontend now
holds two independent chain-selection populations:

- **chart selection** — chains the user clicks/highlights in the
  stabilization diagram. Drives blue path/point styling, the per-chain
  sub-charts (Damp/Amp/MAC/Shape/Proj), the GridHeatmapInset chainId,
  the Connect / Dissolve buttons, and the Apply-panel "Delete selected"
  button. Pure visual focus — never round-trips to the backend. Mutated
  by clicks in the diagram.

- **export selection** — the curated set of chains that drives **Apply
  to Preset** (`POST /modal/apply_to_preset selected_chains`) AND **Export
  to Text Files** (`POST /modal/projects/<n>/export_text selected_chains`).
  Mutated by the per-stability bulk +/- buttons in the toolbar below, the
  ModeTable checkbox column, and the new "+ Add selected" / "− Remove
  selected" buttons described next.

Both populations start empty and are pruned together whenever the
backend chain set changes (merge / delete / dissolve / undo / redo /
run_tracking / project switch) — keyed on the same
`tracked_chains_version` counter dev-md06 introduced for heatmap
freshness. This guards against post-mutation stale-id leaks.

**Export selection toolbar** — sits between the summary chips and the
diagram (dev-c807 Feature 4 + dev-md07 split). One-click bulk-action
buttons for managing the export selection:

- `+ <stability> (count)` / `−` paired buttons per stability category —
  add/remove all chains in that category to/from the export set in one
  click. Includes a `+ spurious (count)` and `− spurious` pair so the
  user can quickly include OR purge spurious modes without manual
  toggling.
- `+ Coverage ≥ 50%` — add every chain whose coverage is at least 50% to
  the set (high-quality preset candidates).
- **`+ Add selected (n)`** (dev-md07) — adds the chart-selected chains
  (the ones the user has highlighted by clicking in the diagram) to the
  export set. The `(n)` shows the count of chart-selected chains NOT
  already in the export set, so the user sees the actual additive
  effect before clicking.
- **`− Remove selected (n)`** (dev-md07) — removes the chart-selected
  chains FROM the export set. The `(n)` shows the count of
  chart-selected chains currently in the export set (= the count the
  click will drop).
- `All` / `Clear` — populate export selection with every chain / clear
  it entirely.
- Trailing counter: `<exportSelection>/<total> in export set`. The
  ModalResultsView header above also shows both populations explicitly:
  `N chains · M in export · K highlighted`.

The toolbar **never** mutates the chart selection — its only effect is
on the export set. Symmetrically, clicking points in the diagram only
changes the chart selection. The two populations are bridged
exclusively by the explicit `+ Add selected` / `− Remove selected`
buttons.

The mode chains table (collapsed by default, see below) mutates the
**export** set via its checkbox column — the table is the row-by-row
counterpart to the bulk toolbar buttons.

**Manual chain editing** — the chain-editor click handlers (`addPoint`, `connectChains`,
`breakChain`) match a clicked point against chain detections within ±1 scenario index of
the rounded pixel-to-data position (dev-c807 Bug 5). The earlier exact-only match
silently no-op'd on grid layouts and on zoomed-out views where the pixel snap could land
one cell off from the actual detection.

**Backend-owned chain composition (dev-md06).** Every action that changes the chain set
— add point, remove point, create chain, merge (Connect), break, dissolve, delete — now
goes through a dedicated REST endpoint on the modal adapter (`POST /modal/chains/<op>`).
The frontend `useChainEditor` hook is a thin proxy: it calls the endpoint, then replaces
`editedChains` with the canonical chains list returned by the backend. There is no
client-side mutation buffer, no `Save` button, no `isDirty` flag. The Save and Discard
icons have been removed from the stabilization-diagram toolbar.

This fixes the post-merge stale-heatmap bug (dev-md06 Bug A): the heatmap reads from
`/modal/grid_heatmap/<chain_id>` which sources from backend `_tracked_chains`. Before
dev-md06, merge was a frontend-only mutation of `editedChains`, so the backend chain
set was unchanged until the user clicked Save — the heatmap would show pre-merge data
even though the stab-diagram showed the merged chain. Routing every mutation through
the backend means the heatmap's data source is always in sync.

**Heatmap cache invalidation.** The `data_status` payload now carries a monotonic
`tracked_chains_version` counter, bumped on every backend chain change (run_tracking,
project load, every mutation, undo, redo, reset). `useModalAdapter` mirrors this into
React state and forwards it to `GridHeatmapInset` as a prop — included in the
`useEffect` deps so the heatmap refetches whenever the backend chain set changes, even
when the selected `chainId` is unchanged (the case that caused Bug A: merge target
keeps its id, useEffect deps unchanged, no refetch).

**Connect (multi-chain merge)** — selects 2+ chains and merges them all into the first
selected chain in a single backend operation (`POST /modal/chains/merge`). The backend
combines detections from all sources into the target, deletes the sources, re-indexes
remaining chain IDs sequentially 0..N-1, and returns the merged target's NEW chain_id
in the response (`merged_chain_id` field). The frontend updates `selectedChains` to
match. Detections at scenarios shared by multiple chains are taken from the
later-selected source (deterministic conflict resolution).

**Backend chain edit history (dev-md06)** — the modal adapter holds an in-memory
snapshot stack (capped at 30 entries) of pre-mutation chain states. Every mutation
endpoint pushes a snapshot before mutating; `POST /modal/chains/undo` pops it and
restores. `POST /modal/chains/redo` reapplies the most recently undone state. Both
re-persist `chains.json` and bump `tracked_chains_version`. The Undo / Redo toolbar
buttons are gated on `data_status.chain_undo_available` /
`chain_redo_available` (mirrors of the snapshot-stack lengths) which arrive via
`syncFromBackend`. Snapshots are dropped on `run_tracking` (chain set rebuilt from
scratch — old IDs no longer match), on project switch (new chain set), and on
`reset`. They are NOT persisted across server restart.

**Mode chains table** — collapsible (hidden by default to maximize
diagram space). Sortable columns: Freq, Damping, Stability, Detections,
Coverage %, Drift. Filters: stability, frequency range, min coverage.
The checkbox column mutates the **export** selection (per the
dev-md07 chart-vs-export split above); chains are NOT auto-selected on
load — the user picks which chains belong in the export set, either
row-by-row in the table or via the bulk-action toolbar above.

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

### Export to Text Files (dev-6c54c87f)

The Apply panel includes an **Export to Text Files** sub-panel that writes
the same modal-extraction results into the 5 fixed-name text files that the
external RoomResponse-based consumer expects. This is the runtime equivalent
of the standalone `Merge_res_New.py` script in the RoomResponse repository,
adapted to consume already-aggregated mode chains directly from the Modal
Adapter (no separate per-band JSON dump required).

**Files written** (all tab-separated, `%.6f` formatting):

| File | Shape | Description |
|------|-------|-------------|
| `Ci_coef_cos.txt` | 11264 x 1 | Packed mode-shape coefficients `ci[nn = note//2, k + ni*128]` for `ni = note%2`, flattened row-major |
| `omega_coef.txt` | 128 x 1 | Mode frequencies in Hz (raw, not `2*pi`-multiplied) |
| `Q_coeff_Q.txt` | 128 x 1 | Q values: `Q = 1 / (2*zeta)`, with sentinel `BIGQ = 1e6` when zeta <= 0 |
| `Q_coeff_E.txt` | 128 x 1 | Damping ratio zeta directly |
| `decka_coeff.txt` | 128 x 16 | Per-mode receiver amplitudes, phase-aligned to the strongest receiver per mode |
| `stitched_results.json` | sidecar | Same data in JSON form for inspection / re-use |

When fewer than 128 chains are exported the remaining slots are padded with
placeholder modes (`f = 1000.0 Hz, zeta = 1.0, zero shape`) so the consumer
always sees a fixed-size 128-mode array.

**Approximation strategy** is selected automatically based on the project's
mapping `layout_type`:

* `line` (1-D bridge) -> linear `scipy.interpolate.interp1d` along the
  scenario index axis, with `fill_value="extrapolate"` for cells outside
  the measured range (matches the original `Merge_res_New.py` behaviour).
* `grid` (2-D rectangular) -> planar `z = a*x + b*y + c` least-squares fit
  via `np.linalg.lstsq` on the populated cells' `(x_mm, y_mm, value)`
  tuples. Populated cells keep their measured values exactly; only the
  empty cells get the planar evaluation. With fewer than 3 populated
  cells the fit falls back to the cell mean.

**UI controls** (Apply panel, "Export to Text Files" sub-panel):

* **Output folder** -- optional free-text path. Default =
  `{project}/modal_adapter/export_text/`. The path is forwarded to the
  backend as-is and the directory is created if missing.
* **Export all chains** -- checkbox override. When unchecked (default),
  the export uses the same `selectedChains` set the Apply panel uses
  (the user's curated subset). When checked, all tracked chains are
  exported.
* **Export to Text Files** -- triggers the export. Disabled when no
  project is open, no chains are tracked, or the selected-chain set
  is empty (with the override off).
* **Copy folder path** -- after a successful export, copies the output
  folder path to the clipboard so the user can paste it into Explorer
  or Finder. (Browsers cannot directly invoke an OS file manager.)

**Differences from `Merge_res_New.py`:**

* No standalone Stage-1 (`results_{low}_{high}.json` band aggregation) --
  the Modal Adapter's `_tracked_chains` already provides aggregated
  per-chain detections. Stage 2's stitching/dedup loop is replaced by
  reading directly from the aggregated chains, sorted by frequency.
* Signed mode shapes are computed from the chain detections' complex
  `mode_shape` arrays via reference-projection (the same approach
  `feedin_extractor.extract_from_mode_shapes` uses), rather than
  re-projecting from raw per-band JSON.
* Receiver-channel mapping uses the project's `MappingConfig.channel_to_sound`
  rather than the hard-coded `selected_r_indices` shipped in the original
  band JSON. Force / reference channels (per `channel_roles`) are excluded
  from the projection automatically.
* The matplotlib `ModeViewer` step is dropped -- the same data is already
  visualised live by the existing `StabilizationDiagram` and per-chain
  heatmap views.

**Channel-to-receiver mapping fallback** (dev-6c54c87f decka-fix):

The receiver assignment in `decka_coeff.txt` follows this priority:

1. `mapping.channel_to_sound` when populated -- explicit map set via the
   Apply panel's "Sound output mapping" sub-section.
2. **Fallback:** when `channel_to_sound` is empty (the user has run
   tracking but never visited the Apply-panel mapping step), the export
   derives a contiguous mapping from `mapping.response_channels`:
   the first response channel becomes receiver `0`, the second becomes
   receiver `1`, and so on, up to `NUM_RECEIVERS=16`. Trailing channels
   beyond the 16-receiver limit are dropped with a warning.

Mirror of the original `Merge_res_New.py` line 253-256 fallback
(`if all_selected_r_indices is None: present = list(range(NUM_RECEIVERS))`),
adapted to the Pianoid Modal Adapter's role-based channel model.

**Mode-shape array layout** (subtle but important):

Per `esprit_runner.py:194`, ESPRIT signals are pre-filtered to
response-only channels before extraction. The resulting `mode_shape`
array length therefore equals `len(response_channels)`, NOT
`num_channels`. Index `0` of the array corresponds to the **first**
response channel (e.g. measurement-channel index `1` when channel `0`
is the force). The export's `decka_coeff` packing translates amplitude
indices through `response_channels` to the original measurement-channel
indices before applying the `channel_to_receiver` lookup.

The sidecar `stitched_results.json` echoes the resolved mapping under
`channel_to_receiver` (and `selected_r_indices` for backwards
compatibility with consumers that read the original Stage-2 metadata)
so users can verify which receiver each response channel landed on.

---

## REST API

All modal adapter endpoints are on the modal adapter server (default `http://localhost:5001`).

#### List Projects

```bash
curl http://localhost:5001/modal/projects
```

Returns the projects-base directory, the currently-open project name (or
`null`), and a list of every project under that base. Each project row
includes the `project.json` metadata plus three fields derived by the
backend (extended in dev-8b5f for the Project subpanel info card):

```json
{
  "projects_base": "D:\\modal_projects",
  "current_project": "PlyWoodTake1",
  "projects": [
    {
      "name": "PlyWoodTake1",
      "path": "D:\\modal_projects\\PlyWoodTake1",
      "num_scenarios": 30,
      "num_channels": 8,
      "sample_rate": 48000.0,
      "scenario_indices": [0, 1, ..., 29],
      "has_esprit": true,
      "has_tracking": true,
      "has_feedin": false,
      "layout_type": "grid",
      "grid_shape": [4, 6],
      "signal_length_ms": 600.0
    }
  ]
}
```

`layout_type` and `grid_shape` are read from the per-project
`mapping_config.json`; defaults are `"line"` / `null` for projects with no
mapping_config yet. `signal_length_ms` prefers `project.json.ir_working_length_ms`
(persisted by the create-from-zip path), falling back to a
`scenario_first.shape[0] / sample_rate * 1000` derivation via
`np.load(..., mmap_mode="r")` (no full array load).

#### Rename Project

```bash
curl -X POST http://localhost:5001/modal/projects/MyOldName/rename \
  -H "Content-Type: application/json" \
  -d '{"new_name": "MyNewName"}'
```

Renames a project on disk. Validation:

| Status | Cause |
|--------|-------|
| `200` | Success — body: `{old_name, new_name, path, was_current}` |
| `400` | `new_name` missing/empty, identical to `old_name`, or contains characters outside `[A-Za-z0-9._\- ]` |
| `404` | Source project does not exist |
| `409` | A project with `new_name` already exists |

When renaming the currently-open project, the backend retargets in-memory
state (`_project_dir`, `_current_project`) atomically — no close/reopen
cycle is required, and pipeline state (loaded measurements, ESPRIT
results, tracking chains) stays in memory.

#### Delete Project

```bash
# Default: delete only the project directory under projects_base.
curl -X POST http://localhost:5001/modal/projects/delete \
  -H "Content-Type: application/json" \
  -d '{"name": "MyProject"}'

# dev-db2e: also delete the extracted measurements folder (when it
# lives under the canonical extracted-root).
curl -X POST http://localhost:5001/modal/projects/delete \
  -H "Content-Type: application/json" \
  -d '{"name": "MyProject", "delete_measurements": true}'
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | yes | — | Project name (folder name under `projects_base`) |
| `delete_measurements` | no | `false` | When true, also `rmtree` the project's `measurement_source` — but ONLY when that path lives under `$PIANOID_MEASUREMENTS_DIR` (default `D:\modal_measurements`). User-curated source folders outside this canonical root are silently kept. |

200 response body:

```json
{
  "message": "Deleted project 'MyProject'",
  "deleted_measurements": true,
  "measurements_path": "D:\\modal_measurements\\MyProject",
  "measurements_skipped_reason": null
}
```

`measurements_skipped_reason` (string) explains why optional measurements
deletion was skipped — possible values:

- `"no measurement_source recorded in project.json"` — legacy project
- `"measurement_source path does not exist: <path>"` — already gone
- `"measurement_source is not under canonical extracted-root (<root>)"`
  — safety guard refused to delete a user-curated path
- `"rmtree failed: <error>"` — filesystem error during the optional
  delete (the project directory was still removed first)

When deleting the currently-open project, the backend closes it first
(`reset()` + `_current_project = None` + `_project_dir = None`) before
the rmtree. The optional measurements rmtree happens AFTER the project
rmtree so a measurements failure cannot leave a half-state where the
project directory still exists.

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
| `name` | no | upload filename stem (dev-cp01 Bug B fix) or zip-on-disk stem | Project name; conflicts auto-resolved with `_1`, `_2`, ... |
| `extracted_root` | no | `$PIANOID_MEASUREMENTS_DIR` or `D:\modal_measurements` | Where the un-zipped tree is kept |
| `band_config` | no | -- | JSON-encoded list of `FrequencyBand`-shaped dicts to persist as project default |
| `ir_working_length_ms` | no | `max(b.ir_length_ms for b in band_config)` when `band_config` set, else metadata-derived | Truncation length applied to the averaged response (ms) |
| `force_reaverage` | no | `false` | Re-run the averager on every scenario even if `averaged_responses/` already exists. Required when raising `ir_working_length_ms` on a project whose pre-existing averages are too short — but as of dev-cp01 the averager auto-promotes `force=true` per-scenario in that case (Bug C fix), so `force_reaverage=true` is only needed to overwrite at the same/shorter length. |

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
parameters (the only tracking knobs exposed as legacy UI fields). The default
`nuclei_merge` method exposes its `nm_*` knobs as separate UI rows.  The legacy
`sliding_window` method uses different parameters (`sw_*` in `TrackingConfig`) that are
not UI-editable — see [`MODE_TRACKING_REDESIGN.md` § 7](../development/MODE_TRACKING_REDESIGN.md#7-configuration-parameters).

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
