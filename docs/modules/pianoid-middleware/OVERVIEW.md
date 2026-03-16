# pianoid_middleware — Module Overview

## Purpose

`pianoid_middleware` is a Flask-based HTTP middleware layer that orchestrates three subsystems:

- **UI layer** — a web frontend that sends REST requests and displays charts
- **Domain model** — the Python `Pianoid` orchestrator that owns the string map, modes, presets, and physical parameters
- **CUDA engine** — the C++ extension (`pianoidCuda`) that runs real-time physical string simulation and audio output

The middleware exposes a REST API (served by `backendServer.py`) that the UI calls to load presets, trigger playback, update parameters, retrieve simulation data, and render charts.

---

## Component Map

```
  Web UI (browser)
       |
       | HTTP / JSON
       v
+-------------------------------+
|   backendServer.py            |  Flask app, CORS enabled
|   (Flask REST API)            |  All routes defined here
|                               |  Global: pianoid, running,
|                               |          chart_registry
+-------------------------------+
       |               |
       |               |
       v               v
+------------+   +------------------+
| pianoid.py |   | ChartGenerator   |
| Pianoid    |   | (ChartGenerator.py)|
| orchestr.  |   | ActionPerformer  |
+-----+------+   +------------------+
      |  |              |
      |  |              v
      |  |       +------------------+
      |  |       | ChartRegistry    |
      |  |       | (ChartRegistry.py)|
      |  |       | chart_config.json|
      |  |       +------------------+
      |  |              |
      |  |              v
      |  |       +------------------+
      |  |       | chartFunctions.py|
      |  |       | (computation fns)|
      |  |       +------------------+
      |  |
      |  v
      | pianoidMidiListener.py
      | MidiListener (rtmidi)
      |
      v
+---------------------+
| parameter_manager.py|  ParameterManager
| (CUDA transfers)    |  All pack-and-send logic
+---------------------+
      |
      v
  pianoidCuda (C++ extension)
  CUDA string simulation engine
  Audio driver (ASIO / SDL)
```

---

## Key Classes

### `Pianoid` (pianoid.py)

Central orchestrator. Owns:
- `self.mp` — `ModelParameters` instance (sample rate, array size, num modes, etc.)
- `self.sm` — `StringMap` from the `Pianoid` package (all strings and pitches)
- `self.modes` — list of `Piano_mode` objects
- `self.result` — `PianoidResult` for extracting simulation output
- `self.cuda_lock` — `threading.Lock` protecting concurrent CUDA parameter writes
- `self.midi_listener` — optional `MidiListener` instance
- `self._lifecycle_state` — `PianoidState` enum value

Key methods called by the REST layer:
- `initialize(path, filterlen, **kwargs)` — factory function, loads preset and allocates GPU memory. Opens C++ logger files before the constructor.
- `start_realtime_playback(with_midi_listener)` — launches audio + main loop threads. Switches C++ logger to RUNTIME phase.
- `add_realtime_event(event_type, pitch, velocity, delay_ms)` — queues a MIDI event
- `pack_for_interface(parameter, pitches, modes)` — serializes parameters for GET endpoints
- `update_parameter(parameter, values, pitches, modes)` — applies parameter updates from POST
- `get_chart_for_frontend(chartType, **kwargs)` — delegates to `ChartGenerator`
- `perform_frontend_command(action_type, **kwargs)` — delegates to `ActionPerformer`
- `save_preset(path)` / `reset()` / `destroyPianoid()`

### `ParameterManager` (parameter_manager.py)

Owns all parameter packing and GPU transfer operations. Receives `pianoid` (C++ binding), `sm` (StringMap), `modes` (ModeMap), `mp` (ModelParameters), and `cuda_lock`. Created during `initialize_pianoid()`.

Key methods:
- `update_parameter(param, values, **param_range)` — central dispatcher for all parameter types
- `update_pitch_physical_params_GRANULAR(pitchID, **params)` — per-pitch granular update via `updateMultiStringParameter_NEW` (preferred for runtime changes)
- `update_pitch_physical_params(pitchID, **params)` — *(deprecated)* bulk repack of all 256 strings; use granular variant instead
- `update_pitch_excitation(pitchID, **params)` — per-pitch excitation update; packs base levels via `pack_base_excitations()` and sends to CUDA
- `send_deck_params_to_CUDA()` — pack deck matrix and send to CUDA
- `send_hammer_params_to_CUDA()`, `send_mode_params_to_CUDA()`, `send_updated_params_to_CUDA()` — bulk pack-and-send helpers

Module-level translation maps:

| Map | Direction | Example |
|-----|-----------|---------|
| `FRONTEND_TO_PYTHON_PARAM_MAP` | UI → Python model | `detuning` → `tension_offset`, `dispersion_damping` → `disp_decay` |
| `PYTHON_TO_CUDA_PARAM_MAP` | Python model → CUDA | `jung` → `stiffness`, `rho` → `density`, `gamma` → `damping`, `r` → `radius` |

The frontend uses user-friendly names; `ParameterManager` translates through both maps before sending to CUDA.

All parameter modifications route through `ParameterManager`. The `Pianoid` class exposes facade methods that delegate directly:
- `update_parameter()` — dispatcher for REST API and batch operations
- `update_pitch_physical_params()` / `update_pitch_physical_params_GRANULAR()` — single-pitch physical param update
- `update_pitch_excitation()` — single-pitch excitation update
- `send_deck_params_to_CUDA()` — deck scaling for MIDI CC handlers

### Flask app (backendServer.py)

- Module-level globals: `pianoid` (current `Pianoid` instance), `running` (bool), `chart_registry` (`ChartTypeRegistry`)
- `long_running_procedure(pianoid, listen)` — background thread target, calls `start_realtime_playback`
- `parse_range(pianoid, parameter, key_no)` — converts URL segment (`all`, `42`, `from21to88`) to pitch/mode lists

### `ChartGenerator` (ChartGenerator.py)

Wraps a `ChartType` from the registry and a `Pianoid` instance. `get_response()` dynamically imports and calls the matching function from `chartFunctions.py`, returning a JSON-serializable dict containing data arrays, headers, text fields, and base64-encoded audio.

### `MidiListener` (pianoidMidiListener.py)

Owns the `rtmidi.MidiIn` port. Runs a polling loop that reads raw MIDI messages, maps them through a YAML keyboard config (`commands_dict`), and dispatches to named action methods (`note_on`, `note_off`, `sustain`, `main_volume`, etc.).

---

## PianoidState Enum

Defined in `pianoid.py`. Tracks the GPU/audio lifecycle:

```
UNINITIALIZED (0)  -- object created, no GPU memory allocated
      |
      v  devMemoryInit()
GPU_READY (1)      -- GPU buffers allocated
      |
      v  initParameters() + preset load
PARAMETERS_LOADED (2)  -- preset and physical params sent to CUDA
      |
      v  start_realtime_playback()
PLAYBACK_ACTIVE (3)    -- audio driver running, main loop active
      |
      v  stop / pause
PAUSED (4)             -- GPU ready, playback stopped
```

The `health` endpoint reports this state. `load_preset` always destroys any existing instance before creating a new one, returning to `UNINITIALIZED`.

---

## Related Documentation

- [REST_API.md](REST_API.md) — complete endpoint reference
- [MIDI_SYSTEM.md](MIDI_SYSTEM.md) — MidiListener, midi_commands, event pipeline
- [CHART_SYSTEM.md](CHART_SYSTEM.md) — ChartGenerator, ChartRegistry, chartFunctions, chart_config.json
