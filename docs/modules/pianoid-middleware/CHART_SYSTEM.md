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
| `sound` | `sound_function` | `length` (default 10000), `channel` (default 0) |
| `string_shape` | `string_shape_function` | `pitch_no`, `string_no`, `mode_no`, `block_no` (all default -1) |
| `feedin` | `feedin_function` | `pitch_no` (default -1), `string_no` (default -1) |
| `filter_test` | `filter_test_function` | `mode` (choice: pianoid/pulses/harmonic), `num_outputs`, `num_inputs`, `length`, `save_path`, `load_from_file`, `stop_pianoid`, `block_no`, `filter_file_no` |
| `block_output_data` | `block_output_data_function` | `num_charts`, `record_no` (default 9), `block_no` (default 0), `pitch_no` (default -1) |
| `profiling` | `profiling_data_function` | `cpu_file`, `gpu_file`, `auto_stop`, `auto_write`, `show_filter` |
| `mode_playback` | `play_mode_chart_function` | `mode_index`, `velocity`, `duration_ms`, `display_length_ms` |
| `note_playback` | `play_note_offline_chart_function` | `pitch`, `velocity`, `duration_ms`, `display_length_ms` |
| `test_volume_parameters` | `test_volume_parameters_function` | `max_volume` (float, default 8000.0), `volume_level` (default 80) |
| `feedback_diagnostic` | `feedback_diagnostic_function` | `pitch_no` (default 60), `num_modes` (default 50) |
| `hammer_shape` | `hammer_shape_function` | `pitch_no` (default 60) |
| `hammer_temporal` | `hammer_temporal_function` | `pitch_no` (default 60), `velocity` (default 100) |
| `online_midi_chart` | `online_midi_playback_chart_function` | `midi_file` (choice), `start_delay_ms`, `capture_length`, `channel` |

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
| `sound_function` | `pianoid.result.get_sound()` — raw audio buffer, supports 1D and 2D (multi-channel) arrays; attaches direct WAV audio |
| `string_shape_function` | `pianoid.result.get_pianoid_state()` — string displacement array from GPU; selects by pitch, string, block, or all |
| `feedin_function` | `pianoid.sm.pack_deck()` — deck feed-in coupling array for a pitch/string index |
| `filter_test_function` | Runs CUDA FIR filter test via `FirFilterTest.filter_test()`; can generate test signals or use live sound; saves/loads filter files |
| `block_output_data_function` | Fetches debug output buffers from CUDA (records 0–1: string states; records 2–9: output_data buffer) |
| `profiling_data_function` | Reads CPU/GPU profiling CSV files and charts timing data |
| `play_mode_chart_function` | Triggers mode playback, captures result audio |
| `play_note_offline_chart_function` | Renders a single note offline, returns audio waveform |
| `test_volume_parameters_function` | Tests volume coefficient calculation |
| `feedback_diagnostic_function` | Plots feedback coefficients across modes for a pitch |
| `hammer_shape_function` | Retrieves spatial hammer force profile for a pitch |
| `hammer_temporal_function` | Retrieves temporal hammer force envelope for a pitch and velocity |
| `online_midi_playback_chart_function` | Starts MIDI file, waits, captures audio result |
