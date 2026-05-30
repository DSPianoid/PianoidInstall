# pianoid_middleware — Chart System

## Overview

The chart system renders simulation data as JSON arrays for the web frontend. It is built from five interconnected files:

- `ChartRegistry.py` — data model classes (`ChartData`, `ChartArray`, `ChartParameter`, `ChartType`, `ChartTypeRegistry`)
- `chart_config.json` — persistent registry of all chart types and actions
- `ChartGenerator.py` — `ChartGenerator` and `ActionPerformer` entry-point classes
- `chartFunctions.py` — standalone computation functions, one per chart type
- `actionPerformer.py` — (file does not exist separately; `ActionPerformer` is defined in `ChartGenerator.py`)

---

## Architecture

```
  REST request: POST /get_chart_test
       {chartType: "sound", length: 48000}
              |
              v
     backendServer.py
     chart_registry.get_type("sound", "chart")
              |
              v  returns ChartType object
     ChartGenerator(pianoid, chartType=<ChartType>, length=48000)
              |
              | __init__: chart_type_obj.extract_arguments(**kwargs)
              |           (type conversion + validation)
              v
     ChartGenerator.get_response()
              |
              | load_function("chartFunctions", "sound_function")
              | func(pianoid, length=48000, channel=0)
              v
     chartFunctions.sound_function(pianoid, **kwargs)
              |
              | builds ChartArray, appends ChartData objects
              | optionally creates base64 audio
              v
     (ChartArray, top_header, text_fields)
              |
              v
     ChartGenerator.form_response(top_header, text_fields)
              |
              v
     JSON response to frontend:
     {data, general_header, text_fields, chart_headers, audio_data}
```

---

## ChartRegistry.py — Data Model Classes

### `ChartData`

Holds a single numeric array and optional audio.

| Method | Description |
|--------|-------------|
| `__init__(header, data)` | Accepts `np.ndarray` or list; computes statistics immediately |
| `get_chart_statistics()` | Computes min/max values and their positions (excludes NaN) |
| `scale_to_onedig()` | Scales data to single-digit magnitude using powers of 10 |
| `scaled_header()` | Returns `"<header> max value <max_val>"` |
| `get_chart()` | Returns `(header, data.tolist(), audio)` |
| `get_scaled_chart()` | Returns scaled version with modified header |
| `create_audio(sample_rate, duration, amplitude_scale, direct, frequency_scale)` | Encodes data as base64 WAV. `direct=True` uses data as raw PCM; `direct=False` sonifies data by mapping values to frequencies. |

### `ChartArray`

Container for multiple `ChartData` objects.

| Method | Description |
|--------|-------------|
| `append_chart(header, data)` | Creates and appends a `ChartData` |
| `get_data(scaled=False)` | Returns `(headers[], datas[], audio_records[])` across all charts |
| `create_audio_to_chart(chartNo, sample_rate)` | Calls `create_audio()` on specified chart indices. `chartNo='all'` processes every chart. |

### `ChartParameter`

Describes a single parameter for a chart type. Types: `"string"`, `"number"`, `"int"`, `"float"`, `"boolean"`, `"choice"`. Choice parameters require a `choices` list. `get()` returns a JSON-serializable dict.

### `ChartType`

Describes one chart type or action type.

| Attribute | Description |
|-----------|-------------|
| `chart_name` | Unique name (registry key) |
| `label` | Human-readable label for UI |
| `processing_function` | String name of function in `chartFunctions.py` |
| `item_type` | `"chart"` or `"action"` |
| `parameters` | List of `ChartParameter` objects |

| Method | Description |
|--------|-------------|
| `add_parameter(**kwargs)` | Adds a `ChartParameter` |
| `extract_arguments(**kwargs)` | Validates and type-converts kwargs against parameter definitions; fills in defaults for missing values |
| `get_name()` | Returns `chart_name` |
| `get_parameters()` | Returns dict for JSON serialization |

### `ChartTypeRegistry`

Global registry. Registry keys use the format `"<item_type>@<name>"`.

| Method | Description |
|--------|-------------|
| `__init__()` | Loads from `chart_config.json`; creates the file with a minimal bootstrap entry if it does not exist |
| `register_type(chart_type)` | Adds a `ChartType` to `self.types` |
| `get_type(name, item_type="chart")` | Retrieves by name and item_type |
| `get_all_types()` | Returns all registered types |
| `get_charts()` | Returns only `item_type == "chart"` entries |
| `get_actions()` | Returns only `item_type == "action"` entries |
| `get_all_type_names()` | Returns `{"charts": [...], "actions": [...]}` |
| `get_chart_names()` | List of chart names only |
| `get_action_names()` | List of action names only |
| `graph_names_json()` | Returns chart types as list of `get_parameters()` dicts |
| `action_names_json()` | Returns action types as list of `get_parameters()` dicts |
| `get_combined_json()` | Returns `{"graphs": [...], "actions": [...]}` |
| `sync_config_file()` | Appends to `chart_config.json` any registry entries not already present; returns count of new items added (or -1 on error) |

---

## chart_config.json — Registered Types

The file contains 19 entries: 12 chart types and 7 action types.

### Chart Types

| Name | Function | Key Parameters |
|------|----------|----------------|
| `sound` | `sound_function` | `length` (default 240000), `channel` (default 0) |
| `string_shape` | `string_shape_function` | `pitch_no`, `string_no`, `mode_no`, `block_no` (all default -1) |
| `feedin` | `feedin_function` | `pitch_no` (default -1), `string_no` (default -1) |
| `filter_test` | `filter_test_function` | `mode` (choice: pianoid/pulses/harmonic), `num_outputs`, `num_inputs`, `length`, `save_path`, `load_from_file`, `stop_pianoid`, `block_no`, `filter_file_no` |
| `block_output_data` | `block_output_data_function` | `record_name` (choice: 10 GPU debug records, default "Raw Coefficients"), `block_no` (default 0) |
| `profiling` | `profiling_data_function` | `cpu_file`, `gpu_file`, `auto_stop`, `auto_write`, `show_filter` |
| `mode_playback` | `play_mode_chart_function` | `mode_index`, `velocity`, `duration_ms`, `display_length_ms` |
| `note_playback` | `play_note_offline_chart_function` | `pitch`, `velocity`, `duration_ms`, `display_length_ms` |
| `test_volume_parameters` | `test_volume_parameters_function` | `max_volume` (float, default 8000.0), `volume_level` (default 80) |
| `feedback_diagnostic` | `feedback_diagnostic_function` | `pitch_no` (default 60), `num_modes` (default 50) |
| `hammer_shape` | `hammer_shape_function` | `pitch_no` (default 60) |
| `hammer_temporal` | `hammer_temporal_function` | `pitch_no` (default 60), `velocity` (default 100) |
| `online_midi_chart` | `online_midi_playback_chart_function` | `midi_file` (choice), `start_delay_ms`, `capture_length`, `channel` |
| `pure_mode_test` | `pure_mode_test_function` | `mode_index` (default 0), `velocity` (default 100), `duration_ms` (default 50), `coupling` (choice: off/on, default off) |
| `tuning_report` | `tuning_report_function` | `type` (choice: frequency/volume/both, default both) |
| `cfl_ratio` | `cfl_ratio_function` | `key_range` (choice: all/from21to108/output, default "all") |

### Action Types

| Name | Function | Description |
|------|----------|-------------|
| `add_action_type` | `add_new_type_action` | Registers a new action type in the registry |
| `add_chart_type` | `add_new_type_action` | Registers a new chart type in the registry |
| `filter` | `filter_action` | Toggles FIR filter on/off and optionally loads a filter file |
| `profiling_start` | `profiling_action` | Starts, stops, or resets GPU/CPU profiling |
| `live_play` | `toggle_engine_action` | Toggles real-time playback on/off |
| `play_note_offline` | `play_note_offline_action` | Synthesizes a single note offline to a WAV file |
| `audio_driver_test` | `audio_driver_test_action` | Tests audio driver with sinewave or synthesis engine |
| `online_midi_playback` | `online_midi_playback_action` | Controls online MIDI file playback (start/stop/status) |
| `auto_tune` | `auto_tune_action` | Runs automatic frequency and/or volume tuning (from `auto_tuner.py`) |

---

## ChartGenerator and ActionPerformer (ChartGenerator.py)

### `ChartGenerator`

```
ChartGenerator(pianoid, chartType=<ChartType>, **kwargs)
```

- `__init__`: validates `chartType` is a `ChartType` object, calls `extract_arguments(**kwargs)` to type-convert and default-fill parameters.
- `get_response()`: calls `load_function("chartFunctions", processing_function)`, invokes it as `func(pianoid, **processing_arguments)`, then calls `form_response()`.
- `form_response(top_header, text_fields, scaled=False)`: calls `charts.get_data(scaled)` and assembles the final dict.
- `__str__()`: prints chart type name and resolved parameters.

### `ActionPerformer`

```
ActionPerformer(pianoid, action_type=<ChartType>, **kwargs)
```

- `__init__`: validates `action_type`, calls `extract_arguments`. For `add_action_type` and `add_chart_type` actions, also stores `chart_registry`, `item_type`, and `parameters` in `processing_arguments`.
- `execute()`: calls `load_function("chartFunctions", processing_function)`, invokes it as `func(pianoid, **processing_arguments)`. Returns the message from the function, or `"OK"` if the function returns `None`.

### `load_function(module_name, func_name)`

Dynamically imports `func_name` from `module_name` using `importlib.import_module`. Raises `ImportError` if not found, `TypeError` if not callable.

---

## chartFunctions.py — Computation Functions

Each function has signature `(pianoid, **kwargs)` and returns `(ChartArray, top_header, text_fields)`.

| Function | What it retrieves |
|----------|-------------------|
| `sound_function` | Fetches fresh audio from circular buffer via `get_sound_from_pianoid()`, then `get_sound()` — supports 1D and 2D (multi-channel) arrays; attaches direct WAV audio |
| `string_shape_function` | `pianoid.result.get_pianoid_state()` — string displacement array from GPU; selects by pitch, string, block, or all |
| `feedin_function` | `pianoid.sm.pack_deck()` — deck feed-in coupling array for a pitch/string index |
| `filter_test_function` | Runs CUDA FIR filter test via `FirFilterTest.filter_test()`; can generate test signals or use live sound; saves/loads filter files |
| `block_output_data_function` | Fetches debug output buffers from CUDA. Records 0–1 from string_states (block-indexed). Records 2–9 from output_data: block-indexed records (2,3,6,7,8) show single block view; string-indexed records (4,5,9) show one chart per string in block. Text fields include block layout info (string IDs, pitches, per-string point counts, total points vs array_size, min/max values) |
| `profiling_data_function` | Reads CPU/GPU profiling CSV files and charts timing data |
| `play_mode_chart_function` | Triggers offline mode playback via `0xF1` event, captures mode oscillation and generated sound via `_load_offline_sound_to_result()`. Charts are normalized (divided by peak) for display; raw max/RMS values are reported in text fields. Audio playback uses unnormalized data |
| `play_note_offline_chart_function` | Renders a single note offline, returns audio waveform via `_load_offline_sound_to_result()` |
| `test_volume_parameters_function` | Tests volume coefficient calculation |
| `feedback_diagnostic_function` | Plots feedback coefficients across modes for a pitch |
| `hammer_shape_function` | Retrieves spatial hammer force profile for a pitch |
| `hammer_temporal_function` | Retrieves temporal hammer force envelope for a pitch and velocity |
| `online_midi_playback_chart_function` | Starts MIDI file, waits, captures audio result |
| `pure_mode_test_function` | Excites a single mode via `exciteMode()` + offline playback, reads sound via `_load_offline_sound_to_result()`. Coupling off: deck matrix zeroed for pure damped oscillator. Coupling on: full string-mode interaction. Normalized output with frequency measurement via zero-crossings |
| `cfl_ratio_function` | Per-pitch FDTD CFL stability ratio across the keyboard — plots the worst-string **Courant number** (`coeff_tension − 8·coeff_bending`), the actual CFL ratio that VARIES per pitch (each pitch's headroom below the edge). **NB it does NOT plot `max\|g\|`**: `max\|g\|` is degenerate-flat at exactly `1.0` for every stable string → a useless flat line (revised 2026-05-30 after the user saw the flat chart). **PURE-PYTHON / HOST-side**: per pitch calls `pianoid.param_manager._pitch_upload_amp(pitch)` → `(max\|g\|, worst_string_index, Courant)` from the SAME closed-form the live gate uses (`cfl_stability.amp_and_courant_for_pitch_strings` over the current `StringMap` physics, honouring per-string `tension_offset`; output pitches ≥128 → `(1.0, 0, 0.0)` sentinel). NO GPU/engine/debug build; `cfl_stability.py` is NOT modified. Returns a **4-tuple** `(charts, header, text_fields, {"render_hints": [...]})` — a scatter chart with explicit pitch x-axis, the redline `threshold` at `CFL_LIMIT = 1.0` (Courant = 1, the stability edge), and the `CFL_MARGIN` reject-threshold marker via the additive `thresholds` array (read **live**). Per-point colour follows the gate's ACTUAL decision (`cfl_stability.is_stable_with_margin`): `Courant < CFL_MARGIN` AND `max\|g\| ≤ 1` → allowed (teal/circle), else rejected (red/diamond). Tooltip: `{note, pitch, courant, decision, max_g, worst_string}`. Degenerate (non-finite Courant) → NaN gap + rejected. `key_range`: `all` / `from21to108` / `output`. Unit test: `tests/unit/test_cfl_ratio_chart.py` (mocked `param_manager`, no engine, 13/13); real-preset varies-proof: `docs/development/diagnostics/dev-7032-cfl-courant-varies.py` |

**Offline chart sound-readout path.** Offline chart functions render with
`PlaybackConfig.audio_enabled = False`, which skips `manageSoundBuffers()` in
`PlaybackCycleExecutor::executeCycle` so nothing reaches the speakers. That same
skip also bypasses `appendRawSound()`, leaving the `rawSoundBuffer` that
`PianoidResult.get_sound_from_pianoid()` reads empty. Offline chart functions
therefore call the local `_load_offline_sound_to_result(pianoid)` helper, which
reads the offline engine's `getRecordedAudio()` output (populated by
`OfflinePlaybackEngine::collectAudio()` cycle-by-cycle into channel 0) and writes
it into `pianoid.result.sound` with shape `(num_channels, N)`. Live/online charts
(`sound_function`, etc.) continue to use `get_sound_from_pianoid()` — their raw
buffer is filled normally by `playSoundSamples()`.

---

## Optional `render_hints` — richer chart rendering (dev-ratiochart, 2026-05-24)

The frontend chart renderer (`newWindowChart.jsx`, via `src/utils/chartOption.js`)
historically rendered every chart's numeric arrays with one rigid ECharts option:
x-axis = array index `0..N-1`, a single `type:"line"` series, value y-axis,
`dataZoom` inside+slider, default tooltip. That is still the default.

A chart function MAY now opt into richer rendering by including an optional
top-level **`render_hints`** key in its response — a list **parallel to `data`**
(one entry per chart; entry `null`/absent = default rendering for that chart).
The renderer's `buildChartOption()` reads it. **Every field is optional and
additive; a chart that omits `render_hints` renders byte-identical to before.**
This is the contract a backend chart function emits to drive the enriched view
(introduced for the CFL stability ratio-vs-pitch chart).

`render_hints[i]` fields:

| Field | Type | Effect |
|-------|------|--------|
| `x_axis_values` | `any[]` | Explicit x-axis category labels (e.g. pitch numbers / note names) — replaces the default `0..N-1` index axis. Length should match the chart's data array. |
| `x_axis_name` | string | X-axis title. |
| `y_axis_name` | string | Y-axis title. |
| `series_type` | string | `"line"` (default) or `"scatter"`. |
| `threshold` | `{value:number, label?:string, color?:string}` | Renders a horizontal **markLine** at `value` (dashed, silent, labelled). Used for the CFL stability limit (`value = cfl_limit = 1`). |
| `thresholds` | `Array<{value:number, label?:string, color?:string}>` | **Additive** — renders one or more *extra* horizontal markLines alongside the single `threshold`, each independently styled/labelled. Used for the CFL ratio chart's `CFL_MARGIN` headroom reference line. A renderer build without this support ignores the array and still shows the single `threshold` (graceful degrade). Added by `feature/cfl-stability-chart` (`5e5d546`, Part 1 extension). |
| `point_styles` | `Array<{color?:string, symbol?:string}>` | Per-point styling. **Length MUST equal the data array** (a mismatch is ignored and the chart falls back to a uniform series — fail-safe, never blanks). Supplying a `symbol` gives a **non-colour cue** alongside `color` so stable/unstable points are distinguishable without relying on colour (accessibility). |
| `point_meta` | `Array<object>` | Per-point metadata merged into the tooltip (e.g. `{stable:true}`). |
| `tooltip_fields` | `string[]` | Ordered `point_meta` keys to surface in the tooltip; defaults to all keys. |

When `point_meta` or `x_axis_values` is present, the renderer attaches a custom
`tooltip` (axis-trigger) showing the x label + value + selected meta fields;
otherwise ECharts' built-in tooltip is used (legacy behaviour, unchanged).

**Example response fragment** (one chart, CFL stability ratio vs pitch):

```json
{
  "data": [[0.018, 0.034, 0.86, 0.041]],
  "chart_headers": ["CFL Courant Ratio"],
  "render_hints": [{
    "x_axis_values": ["A0", "A#0", "B0", "C1"],
    "x_axis_name": "Pitch", "y_axis_name": "CFL ratio (Courant)",
    "series_type": "scatter",
    "threshold": {"value": 1.0, "label": "CFL limit (1)", "color": "#ef5350"},
    "thresholds": [{"value": 0.8, "label": "CFL margin (0.8)", "color": "#ffa726"}],
    "point_styles": [
      {"color": "#26a69a", "symbol": "circle"},
      {"color": "#26a69a", "symbol": "circle"},
      {"color": "#ef5350", "symbol": "diamond"},
      {"color": "#26a69a", "symbol": "circle"}
    ],
    "point_meta": [
      {"courant": 0.018, "decision": "allowed"},
      {"courant": 0.034, "decision": "allowed"},
      {"courant": 0.86, "decision": "rejected"},
      {"courant": 0.041, "decision": "allowed"}
    ],
    "tooltip_fields": ["courant", "decision"]
  }]
}
```

**Part 2 — implemented (dev-7032, 2026-05-30; revised same day).** The backend
`chartFunctions.py` function that emits this is `cfl_ratio_function` (registered as
the `cfl_ratio` chart). It is PURE-PYTHON / host-side: per pitch it calls
`pianoid.param_manager._pitch_upload_amp(pitch)` (the v2 host closed-form, no GPU /
no debug build) and builds the chart array from the per-pitch worst-string
**Courant number** (`coeff_tension − 8·coeff_bending`). **Revision:** the first
version plotted `max|g|`, which is degenerate-flat at `1.0` for every stable string
→ the user saw a flat line; the chart was switched to the Courant number, which
varies per pitch and shows each pitch's headroom. The redline (`CFL_LIMIT = 1.0`)
is the Courant = 1 stability edge; the `CFL_MARGIN` line (additive `thresholds`
array, read `cfl_stability.CFL_MARGIN` **live**) is the gate's reject threshold;
per-point colour is the gate's actual `is_stable_with_margin` decision. Covered by
`tests/unit/test_cfl_ratio_chart.py` (backend, mocked `param_manager`, 13/13) +
`docs/development/diagnostics/dev-7032-cfl-courant-varies.py` (real-preset proof the
Courant array varies, pure-Python) + the renderer's `src/utils/__tests__/chartOption.test.js`
(frontend, 16/16). Backend on PianoidCore `feature/cfl-test-on-p1fix`; the
renderer's `thresholds` extension on PianoidTunner `feature/cfl-stability-chart`
(`5e5d546`).

> **Data-model note (why Courant, not |g|):** `max|g|` (the von-Neumann
> amplification) is degenerate-FLAT at exactly `1.0` for every stable string and
> only jumps past 1 when unstable (`cfl_stability.py` `CFL_MARGIN` docstring) — so a
> `max|g|` chart is a useless flat line. The **Courant number** (`coeff_tension −
> 8·coeff_bending`) varies per pitch and is the quantity that resolves each pitch's
> real headroom below the edge, and it is exactly what `CFL_MARGIN` thresholds.
> Hence the chart plots the Courant number. The redline (1.0) is the Courant
> stability edge; a point is coloured rejected when its worst-string Courant reaches
> `CFL_MARGIN` (or, for the lower/bending edge the Courant doesn't encode, when
> `max|g| > 1`).
