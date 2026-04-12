# pianoid_middleware — REST API Reference

## Server Architecture

The middleware runs as **two Flask servers**:

| Server | Port | Role |
|--------|------|------|
| `backendServer.py` | 5000 | Synthesis engine, playback, parameters, calibration, presets |
| `modal_adapter_server.py` | 5001 | Modal extraction pipeline, project management, folder dialogs |

Both servers have CORS enabled for all origins. The frontend connects to both servers concurrently.

### WebSocket Channel (port 5000)

`backendServer.py` also provides a **Socket.IO WebSocket channel** on the same port (5000) for low-latency bidirectional communication. The WebSocket layer is purely additive — all REST endpoints remain functional.

| Feature | Transport | Direction |
|---------|-----------|-----------|
| Note playback | `play` event (JSON or binary) | Client -> Server |
| Parameter updates | `set_parameter` event | Client -> Server |
| Runtime parameters | `set_runtime_parameters` event | Client -> Server |
| String excitation | `set_string_excitation` event | Client -> Server |
| Hammer shape | `set_hammer_shape` event | Client -> Server |
| Parameter acknowledgment | `param_ack` event | Server -> Client (push) |
| Lifecycle state | `lifecycle` event | Server -> Client (push) |
| Calibration progress | `calibration` event | Server -> Client (push) |
| MIDI playback progress | `midi_progress` event | Server -> Client (push) |
| Engine errors | `engine_error` event | Server -> Client (push) |
| Latency measurement | `ping_ws` / `pong_ws` | Bidirectional |

**Binary frame format** for minimum-latency note input: 3 bytes `[command, pitch, velocity]`.

**Dependencies:** `flask-socketio>=5.3`, `python-socketio>=5.10` (backend); `socket.io-client@^4.7` (frontend).

**Configuration:** `async_mode="threading"` for cuda_lock compatibility. `cors_allowed_origins="*"` for localhost deployment. Server started via `socketio.run()` instead of `app.run()`.

---

## Endpoint Categories

### backendServer.py (port 5000)

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
  /pause_synthesis          -- pause synthesis cycle (keeps GPU)
  /resume_synthesis         -- resume synthesis from pause
  /get_available_notes      -- list pitches in preset
  /get_string_map           -- string layout data
  /get_block_map            -- block-to-string mapping
  /capture                  -- force result extraction
  /get_chart_test           -- render a chart
  /start_test               -- execute an action
  /shutdown                 -- graceful shutdown (free GPU, stop Flask)
  /calibrate_volume         -- multi-velocity calibration (mic, background)
  /measure_rms              -- measure RMS for a single pitch (mic)
  /equalize_keyboard        -- equalize volume across keyboard (mic, background)
  /tune_note                -- iteratively tune a pitch to target dB (mic)
  /calibration_status       -- poll calibration progress
  /calibration_cancel       -- cancel running calibration
  /calibration_params       -- GET/POST perception curves, timing bands, level multipliers
  /mic_devices              -- list microphone input devices
  /set_mic_device           -- select microphone input device
  /preset/list              -- list loaded presets + active preset
  /preset/load              -- load preset to GPU library (no activation)
  /preset/switch            -- switch active preset (double-buffer swap)
  /preset/unload            -- remove preset from GPU library
```

### modal_adapter_server.py (port 5001)

```
  /health                   -- lifecycle status
  /shutdown                 -- graceful shutdown
  /open_folder_dialog       -- native OS folder picker (tkinter subprocess)
  /modal/data_status        -- pipeline stage availability flags
  /modal/run_pipeline       -- run full extraction pipeline (background)
  /modal/load_folder        -- load impulse response measurements
  /modal/upload_measurements -- upload measurement arrays
  /modal/measurement_info   -- measurement metadata
  /modal/mapping            -- set excitation-to-pitch mapping
  /modal/run_esprit         -- launch ESPRIT extraction (background)
  /modal/status             -- poll ESPRIT progress
  /modal/results            -- get extraction results
  /modal/apply_to_preset    -- inject modes into active preset
  /modal/cancel             -- cancel running extraction
  /modal/projects           -- list projects, current project, projects_base
  /modal/projects/create    -- create project with optional measurement_source
  /modal/projects/open      -- open existing project
  /modal/projects/copy      -- copy measurements from existing project
  /modal/projects/delete    -- delete project
  /modal/projects/add_measurements -- add measurements to current project
  /modal/projects/set_base  -- set projects base directory
  /modal/projects/export    -- download project as .pianoid-project zip
  /modal/projects/export_info -- preview export size and stage completeness
  /modal/projects/import    -- upload and import .pianoid-project zip
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

Default preset: `presets/BaselinePreset1.json`

Request body (default initialization settings):
```json
{
  "path": "presets/BaselinePreset1.json",
  "listen_to_midi": 0,
  "use_simulation": 0,
  "debug_mode": 0,
  "audio_driver_type": 4,
  "cycle_iterations": 64,
  "audio_buffer_size": 4,
  "array_size": 384,
  "sample_rate": 48,
  "string_iterations": 4,
  "volume": 120,
  "audio_on": 1,
  "start_right_away": 1,
  "listen_to_modes": 1,
  "use_cuda": 1
}
```

Parameter details:
- `audio_driver_type`: `0`=default, `1`=ASIO, `2`=SDL2, `3`=SDL3, `4`=ASIO_CALLBACK

**Audio driver selection rule:** Prefer ASIO Callback (`4`) when an ASIO device is available — it provides the lowest latency. If ASIO is not available (no ASIO driver installed, or running without a dedicated audio interface), use SDL (`2`) as fallback. SDL works on all systems without special drivers
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

### `POST /pause_synthesis`

Pauses the synthesis cycle (transitions `PLAYBACK_ACTIVE` → `PAUSED`). GPU resources are retained — the engine stops producing audio but can resume instantly.

Response `200`:
```json
{"message": "Synthesis paused"}
```

---

### `POST /resume_synthesis`

Resumes synthesis after a pause (transitions `PAUSED` → `PLAYBACK_ACTIVE`).

Response `200`:
```json
{"message": "Synthesis resumed"}
```

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

## Calibration Endpoints

These endpoints use the **semi-offline calibration mode**: the engine loop is stopped but the audio driver stays alive, allowing deterministic cycle-by-cycle synthesis and microphone capture. See [MIC_VOLUME_EQUALIZATION_PLAN.md](http://localhost:8001/development/MIC_VOLUME_EQUALIZATION_PLAN/) for architecture details.

### `POST /measure_rms`

Measures RMS for a single pitch via microphone. Automatically enters and exits semi-offline calibration mode.

Request body:
```json
{
  "pitch": 60,
  "velocity": 95,
  "repetitions": 3
}
```

- `pitch` (required): MIDI pitch number
- `velocity` (optional, default `95`): MIDI velocity 0-127
- `repetitions` (optional, default `1`): number of measurements to take. When > 1, takes multiple samples and returns the median to reject outliers. Internal calibration workflows (equalize, tune) use 3 repetitions by default.

Response `200`:
```json
{
  "rms": 0.00234,
  "peak": 0.0089,
  "spectralEnergy": 0.0018,
  "db": -52.6,
  "capturedFrames": 24000,
  "analyzedFrames": 14400
}
```

Response `400` if `pitch` missing or pianoid not initialized.
Response `500` on measurement error.

---

### `POST /equalize_keyboard`

Starts full keyboard equalization in a background thread. Measures every available pitch and adjusts excitation volume coefficients to match a reference pitch's RMS.

Three-phase process per pitch: noise floor lift, initial correction, iterative verification (up to 3 passes, 20% error threshold). Poll progress via `GET /calibration_status`.

Request body:
```json
{
  "reference_pitch": 60,
  "velocity": 95,
  "reference_rms": 0.01
}
```

- `reference_pitch` (required): MIDI pitch to use as the equalization target
- `velocity` (optional, default `95`): MIDI velocity for all measurements
- `reference_rms` (optional): pre-measured RMS of reference pitch. If omitted, the reference is measured first.

Response `200`:
```json
{
  "status": "started",
  "message": "Keyboard equalization started in background"
}
```

Response `400` if `reference_pitch` missing or pianoid not initialized.
Response `409` if calibration is already in progress.
Response `500` on error.

---

### `POST /tune_note`

Iteratively adjusts the excitation volume coefficient for a single pitch until the measured dB matches the target (within 1 dB tolerance, max 5 iterations). Blocking — returns when tuning completes.

Request body:
```json
{
  "pitch": 60,
  "velocity": 95,
  "target_db": -35.0
}
```

- `pitch` (required): MIDI pitch number
- `velocity` (optional, default `95`): MIDI velocity 0-127
- `target_db` (required): target RMS level in decibels (e.g. `-35.0`)

Response `200` (converged):
```json
{
  "rms": 0.0178,
  "db": -35.0,
  "iterations": 3,
  "converged": true
}
```

Response `200` (did not converge):
```json
{
  "rms": 0.0195,
  "db": -34.2,
  "iterations": 5,
  "converged": false
}
```

Response `400` if `pitch` or `target_db` missing, or pianoid not initialized.
Response `500` on error.

---

### `GET /calibration_status`

Returns the current calibration progress. Used to poll `equalize_keyboard` status from the frontend.

Response `200` (not running):
```json
{
  "running": false,
  "progress": 0.0
}
```

Response `200` (in progress):
```json
{
  "running": true,
  "progress": 0.45,
  "current_pitch": 57,
  "current_level": null,
  "pitches_completed": 10,
  "results": {
    "48": {"rms": 0.0023, "db": -52.8, "correction": 1.23, "noise_boosted": false, "boost_iterations": 0}
  },
  "corrections": {
    "48": {"3": 1.23}
  }
}
```

---

### `POST /calibration_cancel`

Cancels a running keyboard equalization. The equalization thread stops after the current pitch completes.

Response `200`:
```json
{"status": "cancelled"}
```

Response `200` (no calibration running):
```json
{"status": "not_running"}
```

---

### `GET /mic_devices`

Lists available microphone input devices.

Response `200`:
```json
{
  "devices": ["Microphone (Realtek)", "Line In (ASIO)"]
}
```

Returns empty list if pianoid is not initialized.

---

### `POST /set_mic_device`

Sets the microphone input device by name.

Request body:
```json
{
  "device_name": "Microphone (Realtek)"
}
```

Response `200`:
```json
{"message": "Mic device set"}
```

Response `400` if pianoid not initialized.

---

### `POST /calibrate_volume`

Starts multi-velocity calibration in a background thread. Measures and corrects volume across selected velocity levels and pitches.

Request body:
```json
{
  "velocity_levels": [0, 1, 2, 3, 4, 5],
  "pitches": "all",
  "target_rms": 0.01
}
```

- `velocity_levels` (optional): list of base level indices (0-5) to calibrate. Default: all levels
- `pitches` (optional): `"all"` or comma-separated pitch list. Default: `"all"`
- `target_rms` (optional, default `0.01`): target RMS level

Response `200`:
```json
{"status": "started", "message": "Calibration started in background"}
```

Poll progress via `GET /calibration_status`.

---

### `GET /calibration_params`

Returns perception curves, timing bands, level multipliers, and reference settings for the Calibration UI panel.

Response `200`:
```json
{
  "perception_curves": {"21": [1.0, 1.0, 1.0, 1.0, 1.0, 1.0], ...},
  "timing_bands": [{"max_freq": 131.0, "settle_ms": 500, "skip_ms": 100, "window_ms": 300}, ...],
  "reference_target_db": -50,
  "reference_pitch": 60,
  "level_multipliers": [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]
}
```

---

### `POST /calibration_params`

Updates calibration parameters in-memory. Supports partial updates.

Request body (all fields optional):
```json
{
  "perception_curves": {"21": [1.2, 1.1, 1.0, 0.95, 0.9, 0.85], ...},
  "timing_bands": [...],
  "reference_target_db": -50,
  "reference_pitch": 60,
  "level_multipliers": [1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
  "generate_defaults": false,
  "save_to_preset": false
}
```

- `generate_defaults`: if `true`, returns ISO 226-based default perception curves without applying
- `save_to_preset`: if `true`, persists calibration data to the preset JSON file
- `level_multipliers`: 6-element array of per-velocity-level global scaling factors

Response `200`:
```json
{"status": "ok", "updated": {"perception_curves": 88, "timing_bands": true}}
```

---

## Modal Adapter Endpoints (port 5001)

Served by `modal_adapter_server.py` on port 5001. ESPRIT-based modal extraction pipeline, project management, and folder dialogs. All `/modal/*` endpoints use stage-based architecture with independent stage execution and auto-persistence.

### Utility Endpoints

#### `GET /health`

Returns lifecycle status of the modal adapter server.

---

#### `POST /shutdown`

Graceful shutdown of the modal adapter server.

---

#### `POST /open_folder_dialog`

Opens the native OS folder picker (tkinter `askdirectory` in a subprocess) and returns the selected path. The dialog appears on top of all windows. Runs in a subprocess so tkinter gets its own main thread — calling tkinter from a Flask worker thread hangs on Windows. Used by the frontend `FolderBrowser` component for measurement folder selection.

Request:
```json
{
  "title": "Select Measurement Folder",
  "initial_dir": "D:\\tmp"
}
```

Response `200`:
```json
{"path": "D:\\tmp\\belarus_78_extended_8band", "cancelled": false}
```

Response `200` (user cancelled):
```json
{"path": "", "cancelled": true}
```

---

### Data Status & Pipeline

#### `GET /modal/data_status`

Returns availability flags for each pipeline stage. Used by the frontend to determine which stages can run independently. When ESPRIT data exists, includes `esprit_config` with the parameters used for the last ESPRIT run (band preset, resolved bands, GPU/TLS flags, etc.) so the frontend can restore the configuration on project reopen.

Response `200`:
```json
{
  "measurements": true,
  "mapping": true,
  "esprit": true,
  "tracking": false,
  "feedin": false,
  "channel_mapping": false,
  "applied": false,
  "esprit_config": {
    "band_preset": "extended_8band",
    "preset": "extended_8band",
    "bands": [
      {"name": "Ultra-Low", "f_min": 30, "f_max": 100, "filter_order": 4, "decimation": 1, "exp_factor": 0.15, "model_order": 8, "window_length": 12000},
      {"name": "Low", "f_min": 80, "f_max": 200, "...": "..."}
    ],
    "use_gpu": true,
    "use_tls": true,
    "max_damping": 0.2,
    "mac_threshold": 0.9,
    "window_length": 2000
  }
}
```

`esprit_config` is only present when `esprit` is `true`. The `bands` array contains the actual resolved frequency bands used for processing (not just the preset name).

---

#### `POST /modal/run_pipeline`

Runs the full extraction pipeline (load → mapping → ESPRIT → tracking → feedin) in a background thread. Returns immediately with a task ID. Poll progress via `GET /modal/status`.

Request body:
```json
{
  "folder_path": "/path/to/measurements",
  "sample_rate": 48000,
  "scenarios": [10, 40, 70],
  "mapping": {
    "excitation_to_pitch": {"0": 36, "1": 48},
    "channel_to_sound": {"0": 0, "1": 1},
    "skipped_channels": [],
    "channel_roles": {"0": "response", "1": "response"},
    "bridge_boundary": 28,
    "pitch_offset": 21
  },
  "esprit_params": {"band_preset": "extended_8band"},
  "tracking": {"bridge_boundary": 28, "freq_tol_pct": 0.02, "max_gap": 3},
  "response_channels": [0, 1]
}
```

Response `200`:
```json
{"task_id": "modal_pipeline"}
```

Response `400` if ModalAdapter not initialized.

---

### Stage 1: Load Measurements

#### `POST /modal/load_folder`

Load impulse response measurements from a folder. Auto-detects direct `.npy` files or RoomResponse per-channel scenario structure.

Request body:
```json
{
  "path": "/path/to/measurements",
  "sample_rate": 48000,
  "scenarios": [10, 40, 70]
}
```

- `scenarios` (optional): specific scenario indices for RoomResponse format

Response `200`: measurement info (excitation points, channels, sample rate, file list).

---

#### `POST /modal/upload_measurements`

Upload measurement arrays as multipart form data.

Form fields: `sample_rate` (required). File fields: numbered keys (`0`, `1`, ...) with `.npy` files.

Response `200`: measurement info.

---

#### `GET /modal/measurement_info`

Returns metadata about currently loaded measurements.

---

### Stage 2: Mapping & Configuration

#### `POST /modal/mapping`

Set the mapping from measurement points to MIDI pitches, channel roles, and bridge geometry.

Request body:
```json
{
  "excitation_to_pitch": {"0": 36, "1": 48, "2": 60},
  "channel_to_sound": {"0": 0, "1": 1},
  "skipped_channels": [3, 4],
  "channel_roles": {"0": "response", "1": "response", "2": "force", "3": "response", "4": "response", "5": "reference"},
  "bridge_boundary": 28,
  "pitch_offset": 21
}
```

---

#### `POST /modal/config`

Set ESPRIT configuration with band preset name and/or advanced parameters.

Request body:
```json
{
  "band_preset": "extended_8band",
  "mac_threshold": 0.9,
  "freq_tol_pct": 0.01,
  "use_gpu": false
}
```

---

#### `GET /modal/band_presets`

Return available band preset configurations (standard_4band, extended_8band) with per-band parameters.

---

### Stage 3: ESPRIT Extraction

#### `POST /modal/run_esprit`

Launch ESPRIT extraction in background. Accepts ESPRIT-specific parameters (frequency bands, model order, etc.). Results auto-persist to project dir.

Response `200`:
```json
{"task_id": "modal_esprit"}
```

---

#### `GET /modal/status`

Poll extraction progress.

Response `200`:
```json
{
  "state": "running",
  "progress": 3,
  "current_point": 3,
  "total_points": 5,
  "message": "ESPRIT scenario 40 (3/5)..."
}
```

---

#### `GET /modal/results`

Returns per-scenario extraction results (frequencies, damping ratios, merge stats).

---

### Stage 4: Mode Tracking

#### `POST /modal/run_tracking`

Run spatial mode tracking on ESPRIT results. Tracks separately for bass and treble bridges.

Request body:
```json
{
  "bridge_boundary": 28,
  "freq_tol_pct": 0.02,
  "max_gap": 3
}
```

Response `200`: tracked chains with stability classification and summary.

---

#### `GET /modal/tracking_results`

Return tracked chains with stability classification.

---

### Stage 5: Feedin Extraction

#### `POST /modal/run_feedin`

Run FFT feedin extraction on tracked mode chains. Uses response channels from mapping if not specified.

Request body:
```json
{
  "response_channels": [0, 1, 3, 4]
}
```

Response `200`: per-pitch feedin coefficients, sound coefficients, measured/interpolated pitch lists.

---

#### `GET /modal/feedin_results`

Return per-pitch feedin and sound coefficients.

---

### Stage 6: Channel Mapping & Visualization

#### `POST /modal/channel_mapping`

Set response channel to Pianoid sound output mapping.

Request body:
```json
{
  "channel_to_sound": {"0": 0, "1": 1, "3": 2, "4": 3}
}
```

---

#### `GET /modal/stabilization_diagram`

Return chain data for scatter plot visualization. Points: scenario x frequency, colored by stability.

---

#### `GET /modal/mode_shape/<chain_id>`

Return feedin magnitude along bridge for a single mode chain.

---

#### `GET /modal/mode_preview/<chain_id>`

Return frequency + damping for rendering decaying sinewave (uses existing `exciteMode()` pattern).

---

#### `POST /modal/chains/save`

Replace tracked chains with manually edited version. Re-indexes chain IDs 0..N-1, invalidates feedin data (must re-run feedin after edits), persists to disk.

Request:
```json
{
  "chains": [{ "chain_id": 0, "frequency_mean": 440.0, "damping_mean": 0.001, ... }]
}
```

Response `200`:
```json
{ "saved": 42, "data_status": { "measurements": true, "mapping": true, ... } }
```

---

### Stage 7: Apply & Persistence

#### `POST /modal/apply_to_preset`

Apply extracted modes to the active Pianoid preset. Uses FFT feedin path when feedin data is available.

Request body:
```json
{
  "selected_modes": [0, 1, 2, 5, 8],
  "merge": false
}
```

- `merge`: if `true`, merges with existing modes; if `false`, replaces

---

#### `POST /modal/cancel`

Cancel a running ESPRIT extraction.

---

#### `POST /modal/set_project_dir`

Set persistence directory. Creates subdirs for auto-saving intermediate results.

Request body:
```json
{"path": "D:/projects/my_piano"}
```

---

#### `GET /modal/load_intermediate/<stage>`

Load saved intermediate results for a stage. Stage: `esprit`, `tracking`, `feedin`, `mapping`.

---

### Project Management

#### `GET /modal/projects`

Returns the list of projects, current active project, and the projects base directory.

Response `200`:
```json
{
  "projects": ["piano_A", "piano_B"],
  "current_project": "piano_A",
  "projects_base": "D:\\projects"
}
```

---

#### `POST /modal/projects/create`

Create a new project. Optionally copy measurements from an existing source.

Request body:
```json
{
  "name": "piano_C",
  "measurement_source": "piano_A"
}
```

- `measurement_source` (optional): name of existing project to copy measurements from

---

#### `POST /modal/projects/open`

Open an existing project. Loads measurements and any saved intermediate data (ESPRIT results, tracking, feedin).

Request body:
```json
{
  "name": "piano_A"
}
```

---

#### `POST /modal/projects/copy`

Copy measurements from an existing project into a new project.

Request body:
```json
{
  "source": "piano_A",
  "destination": "piano_A_copy"
}
```

---

#### `POST /modal/projects/delete`

Delete a project and its data.

Request body:
```json
{
  "name": "piano_C"
}
```

---

#### `POST /modal/projects/add_measurements`

Add measurement files to the current project.

---

#### `POST /modal/projects/set_base`

Set the base directory for all projects.

Request body:
```json
{
  "path": "D:\\projects"
}
```

---

### Project Export / Import

#### `GET /modal/projects/export?name=<name>`

Streams a `.pianoid-project` zip archive as a download. The archive contains `manifest.json` (format version, checksum, hostname), sanitised `project.json` (measurement_source replaced with `"(exported)"`), and all project data (measurements, modal_adapter intermediate results).

Response: binary zip file with `Content-Disposition: attachment; filename="<name>.pianoid-project"`.

---

#### `GET /modal/projects/export_info?name=<name>`

Preview info before exporting. Returns size and stage completeness.

Response `200`:
```json
{
  "name": "piano_A",
  "total_size_bytes": 73400320,
  "total_size_mb": 70.0,
  "num_scenarios": 78,
  "stages": {
    "measurements": true,
    "esprit": true,
    "tracking": true,
    "feedin": false
  }
}
```

---

#### `POST /modal/projects/import`

Import a `.pianoid-project` zip archive via multipart file upload. Validates archive structure (must contain `manifest.json` + `project.json`), checks format version, extracts into `projects_base`. Resolves name conflicts by appending `_1`, `_2`, etc.

Form fields: `file` (required, the zip archive), `name` (optional, override project name).

Response `200`:
```json
{
  "name": "piano_A",
  "path": "D:\\projects\\piano_A",
  "imported_from": "STUDIO-PC",
  "renamed": false
}
```

If name conflict was resolved, `renamed` is `true` and `name` contains the suffixed name.

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
