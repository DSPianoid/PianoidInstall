# pianoid_middleware — REST API Reference

## Server

Flask application defined in `backendServer.py`. CORS is enabled for all origins. Default port when run directly: Flask development server on 5000.

---

## Endpoint Categories

```
  /ping                     -- connectivity check
  /health                   -- lifecycle status
  /get_settings             -- UI boot settings
  /load_preset              -- initialize engine
  /save_preset              -- persist preset
  /reset                    -- reset engine state
  /command_names            -- available command names
  /graph_names              -- chart and action type catalogue
  /get_parameter/<p>/<k>    -- read simulation parameters
  /set_parameter/<p>/<k>    -- write simulation parameters
  /set_string_excitation/<pitch>  -- write single-level excitation curves
  /set_hammer_shape/<pitch>       -- write hammer geometry (delegates to dispatcher)
  /set_mode_parameters      -- write mode parameters
  /set_velocity/<velocity>  -- fix MIDI velocity
  /set_runtime_parameters   -- volume / feedback at runtime
  /play                     -- trigger note on/off
  /play_mode/<mode_no>      -- trigger mode playback
  /midi_playback            -- MIDI file playback control
  /playback_stats           -- EventQueue statistics
  /get_available_notes      -- list pitches in preset
  /get_string_map           -- string layout data
  /get_block_map            -- block-to-string mapping
  /capture                  -- force result extraction
  /get_chart_test           -- render a chart
  /start_test               -- execute an action
  /shutdown                 -- graceful shutdown (free GPU, stop Flask)
  /preset/list              -- list loaded presets + active preset
  /preset/load              -- load preset to GPU library (no activation)
  /preset/switch            -- switch active preset (double-buffer swap)
  /preset/unload            -- remove preset from GPU library
```

---

## Lifecycle Endpoints

### `GET /ping`

Simple connectivity check. No pianoid required.

Response `200`:
```json
{
  "message": "pong",
  "timestamp": 1710000000000.0
}
```

---

### `GET /health`

Returns the full lifecycle state of the engine. Safe to call before a preset is loaded.

Response `200` (not started):
```json
{
  "timestamp": 1710000000000.0,
  "pianoid_loaded": false,
  "backend_thread_running": false,
  "exception": false,
  "status": "not_started",
  "message": "Flask server running, core not loaded",
  "lifecycle": {
    "gpu_initialized": false,
    "audio_driver_active": false,
    "main_loop_should_continue": false
  }
}
```

Response `200` (healthy):
```json
{
  "timestamp": 1710000000000.0,
  "pianoid_loaded": true,
  "backend_thread_running": true,
  "exception": false,
  "listen_mode": false,
  "status": "healthy",
  "message": "Core loaded, GPU initialized, main loop running with audio",
  "lifecycle": {
    "gpu_initialized": true,
    "audio_driver_active": true,
    "main_loop_should_continue": true
  },
  "cpp_module_responsive": true,
  "available_notes_count": 88
}
```

Status values: `not_started`, `healthy`, `idle`, `partial`, `crashed`.

Response `500` if health check itself throws.

---

### `GET /get_settings`

Returns default UI boot settings. Does not require a loaded preset.

Response `200`:
```json
{
  "path": "",
  "volume": "",
  "sample_rate": "",
  "string_iterations": 6,
  "use_simulation": 0,
  "debug_mode": 0,
  "listen_to_midi": 0
}
```

---

### `POST /load_preset`

Destroys any existing pianoid instance, initializes a new one from a preset file, and optionally starts playback immediately.

Request body:
```json
{
  "path": "presets/IversPond_ESPRIT_128modes.json",
  "listen_to_midi": 0,
  "use_simulation": 0,
  "debug_mode": 0,
  "audio_driver_type": 4,
  "cycle_iterations": 64,
  "audio_buffer_size": 4,
  "array_size": 384,
  "sample_rate": 48000,
  "string_iterations": 6,
  "volume": 64,
  "max_volume": null,
  "audio_on": 1,
  "start_right_away": 1,
  "listen_to_modes": 1
}
```

Parameter details:
- `audio_driver_type`: `0`=default, `1`=ASIO, `2`=SDL2, `3`=SDL3, `4`=ASIO_CALLBACK (recommended)
- `cycle_iterations`: samples per cycle; must match audio buffer size, minimum 16, default 64
- `audio_buffer_size`: buffer chunks; `2`=low latency, `4`=balanced, `8`=high stability
- `array_size`: spatial discretization points per string block; `384` (default) or `512`. Clamped to 384–512. When the requested value differs from the preset's native `array_size`, string geometry (`main` and `tail`) is scaled proportionally
- `sample_rate`: Hz; if < 1000 is multiplied by 1000
- `volume`: MIDI-style level 0–127 (old API)
- `max_volume`: float, explicit max volume (new API, takes precedence over `volume`)
- `start_right_away`: `1`=start in background thread, `2`=start inline (deprecated), `3`=init only no start, `0`=init only
- `listen_to_modes`: `0`=sound channels carry string bridge displacement, `1`=sound channels carry mode forces (default `1`)

Response `200`:
```json
{"message": "Preset loaded successfully"}
```

---

### `POST /save_preset`

Saves the current in-memory preset to a file.

Request body:
```json
{"path": "presets/MySave.json"}
```

Response `200`:
```json
{"message": "Preset saved successfully"}
```

---

### `GET /reset`

Calls `pianoid.reset()` to reinitialize simulation state without reloading the preset.

Response `200`:
```json
{"message": "Reset successfull"}
```

---

### `POST /shutdown`

Graceful shutdown: destroys the pianoid instance (freeing GPU resources), stops the MIDI listener, then terminates the Flask process via `SIGTERM` after a short delay so the HTTP response can be sent.

Response `200`:
```json
{"message": "Shutting down"}
```

The process exits ~300 ms after responding. If cleanup raises an exception, the endpoint still proceeds with shutdown. Callers should follow up with a force-kill (`taskkill /T /F`) if the process does not exit within a few seconds.

---

## Parameter Endpoints

### `GET /get_parameter/<parameter>/<key_no>`

Reads simulation parameters serialized for the frontend.

`parameter` values:
| Value | Description |
|-------|-------------|
| `string` | Physical string parameters |
| `mode` | Mode (resonance) parameters |
| `gauss` | Temporal excitation (hammer) — dictionary format |
| `gauss_flat` | Temporal excitation — flat array of 100 values |
| `gauss_full` | Temporal excitation — dictionary, all 128 velocity levels |
| `hammer` | Spatial excitation (hammer shape) |
| `excitation` | Combined gauss + hammer |
| `feedin` | Deck feed-in coupling matrix |
| `feedback` | Deck feedback coupling matrix |
| `output` | External sound output parameters (alias for feedback on output pitches) |
| `sound_channel` | Mode-coupling coefficients per pitch (modes listen mode) |
| `string_sound_channel` | Strings-mode gain per pitch (strings listen mode) |

`key_no` formats:
- Integer string: `"57"` — single pitch or mode number
- `"all"` — all pitches or all modes (depending on parameter type)
- `"output"` — output pitches only (for `output` parameter)
- `"from<N>to<M>"` — inclusive range, e.g. `"from21to88"`

For `mode`, `feedin`, `feedback`, `output`: `key_no` is treated as a mode number range.
For all other parameters: `key_no` is treated as a pitch number range.

Response `200`: parameter payload (structure depends on parameter type)

Response `416`:
```json
{"message": "Error parsing parameters, parcer error, <details>"}
```

---

### `POST /set_parameter/<parameter>/<key_no>`

Writes simulation parameters. Same `parameter` and `key_no` semantics as `GET /get_parameter`.

Request body: parameter payload in the same structure returned by the corresponding GET.

Response `200`:
```json
{"message": "OK"}
```

Response `416`:
```json
{"message": "Wrong parameter request"}
```
or
```json
"Set parameter route: Internal error in module pianoid.py: <traceback>"
```

---

### `POST /set_string_excitation/<pitch_no>`

Sets temporal excitation curves for a single pitch at one velocity level.
Delegates to `update_pitch_excitation()` which updates the Python model and GPU.

`pitch_no`: integer pitch ID

Request body:
```json
{
  "level": 2,
  "curves": {
    "0": {"sigma": 0.01, "mu": 0.5, "volume": 1.0, "shift": 0.0},
    "4": {"sigma": 0.02, "mu": 0.5, "volume": 0.8, "shift": 0.1}
  }
}
```

Response `200`:
```json
{"message": "String excitation set successfully"}
```

---

### `POST /set_hammer_shape/<pitch_no>`

Sets hammer geometry for a single pitch. Null values in the JSON body are silently
ignored. Delegates to `update_parameter('hammer', ...)`.

`pitch_no`: integer pitch ID

Request body:
```json
{
  "shape": "circular",
  "width": 0.012,
  "position": 0.09,
  "sharpness": 0.7
}
```

Response `200`:
```json
{"Message": "OK", "Width": 0.012}
```

---

### `POST /set_mode_parameters`

Writes mode parameters for one or more modes and sends all mode params to CUDA.

Request body: array of mode parameter objects:
```json
[
  {"mode": 0, "parameters": {...}},
  {"mode": 1, "parameters": {...}}
]
```

Response `200`:
```json
{"Message": "OK"}
```

---

### `POST /set_velocity/<velocity>`

Fixes MIDI velocity to a constant value. Set to `-1` to disable fixed velocity.

`velocity`: integer

Response `200`:
```json
{"Message": "OK"}
```

---

### `POST /set_runtime_parameters`

Updates volume and/or deck feedback coefficient while the engine is running.

Request body:
```json
{
  "volume": 80,
  "feedback": 64
}
```

`volume`: integer 0–127 (MIDI range). Maps to amplitude coefficient using `max_volume^(level/127)`.

`feedback` auto-detection:
- `0.0` — silence (no deck coupling)
- `1`–`127` — MIDI-style exponential mapping: 64 → 1.0, 127 → 8.0, 1 → ~0.125
- Outside `1`–`127` (e.g. `2.5`) — used as direct coefficient

Valid coefficient range after mapping: `0.0`–`1000`.

Response `200`:
```json
{"message": "OK", "updated": {"volume": 80, "feedback": 64}}
```

Response `400`: missing parameters, invalid range, or pianoid not initialized.
Response `500`: internal set failure.

---

## Playback Endpoints

### `POST /play`

Triggers a note-on or note-off event. Routes to the unified EventQueue system (v3.0+) if `realtime_buffer` is available.

Request body (unified format):
```json
{
  "pitch": 60,
  "velocity": 100,
  "command": 144,
  "delay_ms": 0.0
}
```

`command` values:
- `144` + `velocity > 0` — NOTE_ON
- `128` or `144` + `velocity == 0` — NOTE_OFF
- `176`/`177`/`178` + `pitch == 64` — SUSTAIN pedal

Request body (legacy format):
```json
{
  "pitch": 60,
  "command": 144,
  "velocity": 100
}
```

Response `200`:
```json
{"Message": "OK", "mode": "unified"}
```

Response `417` if pianoid is in exception state.

---

### `POST /play_mode/<mode_no>`

Triggers immediate playback of a specific resonance mode.

`mode_no`: integer mode index

Response `200`:
```json
{"Message": "OK"}
```

Response `416` if `mode_no` is not a valid integer.

---

### `POST /midi_playback`

Controls online MIDI file playback.

Request body:
```json
{
  "action": "start",
  "midi_file": "elise.mid",
  "start_delay_ms": 500
}
```

`action` values: `"start"`, `"stop"`, `"status"`

`midi_file` choices: `"elise.mid"`, `"mond_1.mid"`

Response `200`:
```json
{
  "status": "success",
  "midi_file": "elise.mid",
  "events_scheduled": 1234,
  "duration_ms": 30000
}
```

Response `400` for invalid action or pianoid not initialized.
Response `404` if MIDI file not found.
Response `500` for unexpected errors.

---

### `GET /playback_stats`

Returns EventQueue buffer and engine statistics.

Response `200`:
```json
{
  "unified_mode": true,
  "state": "PLAYBACK_ACTIVE",
  "unified": {
    "buffer": {
      "total_events_pushed": 42,
      "total_events_drained": 42,
      "peak_buffer_size": 3,
      "avg_insert_latency_us": 12.5,
      "avg_drain_latency_us": 8.1,
      "current_size": 0
    },
    "engine": {
      "total_events_processed": 42,
      "realtime_events": 40,
      "scheduled_events": 2,
      "avg_event_latency_ms": 1.2,
      "calibration_count": 1
    }
  }
}
```

---

## MIDI Endpoints

### `GET /get_available_notes`

Returns a list of MIDI pitch numbers currently loaded in the preset.

Response `200`:
```json
[21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81, 84, 87, 88]
```

---

## Chart Endpoints

### `GET /graph_names`

Returns all registered chart types and action types from the `ChartTypeRegistry`.

Response `200`:
```json
{
  "graphs": [
    {
      "name": "sound",
      "label": "Sound Analysis",
      "parameters": [
        {"name": "length", "type": "number", "label": "Length", "defaultValue": 10000},
        {"name": "channel", "type": "number", "label": "Channel Number", "defaultValue": 0}
      ]
    }
  ],
  "actions": [
    {
      "name": "filter",
      "label": "Filter",
      "parameters": [...]
    }
  ],
  "message": "OK"
}
```

---

### `POST /get_chart_test`

Renders a chart by delegating to `ChartGenerator` (for chart types) or `ActionPerformer` (for action types).

Request body: chart type name plus any chart-specific parameters:
```json
{
  "chartType": "sound",
  "length": 48000,
  "channel": 0
}
```

If `chartType` resolves to an action type in the registry, the action is executed and the response has status `499`.

Response `200`:
```json
{
  "data": [[0.1, 0.2, ...]],
  "general_header": "Sound record",
  "text_fields": {
    "Sound obtained": "Length 1000.00 ms, channels 2",
    "Sound displayed": "Length 500.00 ms, channel 0"
  },
  "chart_headers": [""],
  "audio_data": ["<base64 WAV string>"]
}
```

Response `416` on internal error (returns traceback string).
Response `499` when chart type is actually an action type.

---

### `POST /start_test`

Executes a registered action type by delegating to `ActionPerformer`.

Request body:
```json
{
  "action_type": "filter",
  "toggle": true,
  "file": "Bluthner.fir"
}
```

Response `200`:
```json
{"Message": "OK"}
```

Response `416` on internal error.

---

### `POST /capture`

Forces extraction of the current simulation result buffer. Useful before requesting a chart when `debug_mode` is enabled.

Response `200`:
```json
{"Message": "OK"}
```

---

## Preset Library Endpoints

### `GET /preset/list`

Returns all presets currently loaded in the GPU preset library and the active preset name. Requires a loaded pianoid instance.

Response `200`:
```json
{
  "presets": ["default", "Steinway", "Bluthner"],
  "active": "default"
}
```

Response `400` if pianoid not initialized.

---

### `POST /preset/load`

Loads a preset JSON file into the GPU preset library without activating it. The preset is parsed, packed into flat arrays, and stored in host memory ready for instant GPU transfer via `/preset/switch`.

Request body:
```json
{
  "path": "presets/Steinway_256modes.json",
  "name": "Steinway"
}
```

- `path`: path to preset JSON file (relative to middleware working directory)
- `name`: unique identifier for this preset in the library

Response `200`:
```json
{
  "message": "Preset loaded as Steinway",
  "presets": ["default", "Steinway"]
}
```

Response `400` if `path` or `name` missing.
Response `500` if preset already exists in library or file not found.

---

### `POST /preset/switch`

Switches the active synthesis parameters to a named preset from the GPU library. Uses the double-buffered swap mechanism — the new preset is uploaded to the staging buffer via `cudaMemcpyAsync` and pointer-swapped atomically, so playback continues without glitches.

Request body:
```json
{
  "name": "Steinway"
}
```

Response `200`:
```json
{
  "message": "Switched to Steinway",
  "active": "Steinway"
}
```

Response `400` if `name` missing.
Response `500` if preset not found in library.

**Note:** Currently uses `async_switch=False` (synchronous), blocking until the GPU transfer completes.

---

### `POST /preset/unload`

Removes a preset from the GPU library, freeing host memory.

Request body:
```json
{
  "name": "Steinway"
}
```

Response `200`:
```json
{
  "message": "Preset Steinway unloaded",
  "presets": ["default"]
}
```

Response `400` if `name` missing.
Response `500` if preset not found or is the active preset.

---

## System / Preset Endpoints

### `GET /command_names`

Returns available command names.

Response `200`:
```json
{"commands": ["volume"], "message": "OK"}
```

---

### `GET /get_string_map`

Returns string layout data from `pianoid.sm.get_string_map()`.

Response `200`: string map dictionary (structure defined by `StringMap` domain class).

---

### `GET /get_block_map`

Returns the block-to-string mapping from `pianoid.sm.get_strings_for_stringmap_manager()`.

Response `200`: block map array.

---

## Error Handling Patterns

| HTTP Code | Meaning |
|-----------|---------|
| 200 | Success |
| 400 | Bad request: missing or invalid parameters, pianoid not initialized |
| 404 | Resource not found (e.g. MIDI file) |
| 416 | Parameter parsing error or internal module error |
| 499 | Action executed (returned by `/get_chart_test` for action types) |
| 500 | Unexpected server error |

All error responses include a `message` or `error` field with a description. Internal module errors include a Python traceback in the response body.
