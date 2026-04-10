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
- `load_preset_to_library(path, preset_name)` — loads a preset JSON into the GPU library without activating it
- `switch_preset(preset_name, async_switch)` — switches the active preset via double-buffer swap
- `get_library_presets()` / `get_active_preset()` / `unload_preset(preset_name)` — preset library management

### `ParameterManager` (parameter_manager.py)

Owns all parameter packing and GPU transfer operations. Receives `pianoid` (C++ binding), `sm` (StringMap), `modes` (ModeMap), `mp` (ModelParameters), and `cuda_lock`. Created during `initialize_pianoid()`.

All GPU uploads go through `_gpu_upload(method, *args)` which calls `waitForParameterUpdate()` before each upload to ensure the double-buffer is IDLE (prevents silent drops under the DROP_IF_BUSY policy).

Key methods:
- `update_parameter(param, values, **param_range)` — central dispatcher for all parameter types
- `update_pitch_physical_params_GRANULAR(pitchID, **params)` — per-pitch granular update via `updateMultiStringParameter_NEW` (preferred for runtime changes)
- `update_pitch_physical_params(pitchID, **params)` — *(deprecated)* bulk repack of all 256 strings; use granular variant instead
- `update_pitch_excitation(pitchID, **params)` — per-pitch excitation update; packs base levels via `pack_base_excitations()` and sends to CUDA
- `update_mode_params_GRANULAR(mode_indices, param_values_by_mode)` — per-mode granular update; fits only affected modes, sends only dec/omega/mass to CUDA via `updateModeParameters_GRANULAR` (preserves running GPU state)
- `send_deck_params_to_CUDA()` — pack deck matrix and send to CUDA
- `send_hammer_params_to_CUDA()`, `send_mode_params_to_CUDA()`, `send_updated_params_to_CUDA()` — bulk pack-and-send helpers

Module-level translation maps:

| Map | Direction | Example |
|-----|-----------|---------|
| `FRONTEND_TO_PYTHON_PARAM_MAP` | UI → Python model | `detuning` → `tension_offset`, `dispersion_damping` → `disp_decay` |
| `PYTHON_TO_CUDA_PARAM_MAP` | Python model → CUDA | `jung` → `stiffness`, `rho` → `density`, `gamma` → `damping`, `r` → `radius` |

The frontend uses user-friendly names; `ParameterManager` translates through both maps before sending to CUDA.

Additional parameter types handled directly (no map translation):

| Parameter | Handler | Effect |
|-----------|---------|--------|
| `sound_channel` | `set_parameter_batch('sound_channel', ...)` | Updates `soundChannelModes.coefficients[pitchID]` and sends deck params to CUDA |

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

## AutoTuner (auto_tuner.py)

Automatic frequency and volume tuning system. Uses offline rendering for clean, deterministic measurements.

| Class | Purpose |
|-------|---------|
| `MeasurementEngine` | Renders isolated notes offline, measures pitch (FFT + autocorrelation) and volume (frequency-aware RMS windowing) |
| `FrequencyTuner` | Iterative tension adjustment: measures pitch, corrects tension via `f ∝ √tension`, repeats until error < tolerance |
| `VolumeTuner` | A-weighted loudness equalization across keyboard x 6 velocity levels. Sets `ExcitationParameters.volume_coefficients` per pitch per level, bulk uploads via `setNewExcitationBaseLevels` |
| `TuningResults` | Persistence (JSON sidecar files) and reporting |

Exposed to the frontend via chart/action system:
- Action `auto_tune` — runs frequency and/or volume tuning
- Chart `tuning_report` — displays frequency error curve and volume coefficient charts

---

## CalibrationController (calibration_controller.py)

Microphone-based volume equalization using semi-offline calibration mode. The engine loop is stopped but the audio driver stays alive, enabling deterministic cycle-by-cycle synthesis from Python.

**4-phase calibration pipeline:**

| Phase | Description |
|-------|-------------|
| 1. Persistence | Load/save calibration data (perception curves, timing bands, level multipliers) to/from preset JSON |
| 2. Multi-velocity | Calibrate across 6 velocity levels (`[0, 5, 31, 63, 95, 127]`) per pitch |
| 3. Level multipliers | Per-velocity-level global scaling factors (e.g., boost pp, attenuate ff) |
| 4. ISO 226 curves | Frequency-dependent perception compensation (low-freq boost, high-freq cut) applied as per-pitch correction weights |

Key methods:

| Method | Purpose |
|--------|---------|
| `calibrate(velocity_levels, pitches, target_rms)` | Full calibration run (background thread) |
| `measure_single(pitch, velocity, repetitions)` | Single-note RMS measurement |
| `equalize_keyboard(reference_pitch, velocity)` | Equalize all pitches to a reference |
| `tune_single(pitch, velocity, target_db)` | Bisection search to match target dB |
| `get_perception_curves()` / `set_perception_curves()` | Read/write per-pitch correction weights |
| `apply_level_multipliers(multipliers)` | Apply 6-element velocity-level scaling |
| `save_perception_curves_to_preset()` | Persist calibration to preset JSON |

Timing is frequency-adaptive via timing bands (configurable from UI):

```python
DEFAULT_TIMING_BANDS = [
    {"max_freq": 131.0, "settle_ms": 500, "skip_ms": 100, "window_ms": 300},
    {"max_freq": 523.0, "settle_ms": 300, "skip_ms": 50,  "window_ms": 200},
    {"max_freq": 99999, "settle_ms": 150, "skip_ms": 30,  "window_ms": 150},
]
```

---

## Modal Adapter (modal_adapter/)

ESPRIT-based modal extraction pipeline. Extracts soundboard resonance modes from impulse response measurements and injects them into the active preset with measured feedin coefficients.

**Status:** All 6 waves complete — untested (not yet verified in browser). Backend (Waves 1-4) and frontend (Waves 5-6) implementation done. See [MODAL_ADAPTER_REDESIGN_PLAN.md](../../development/MODAL_ADAPTER_REDESIGN_PLAN.md) for commit references.

**Architecture:** Data-availability-driven with independent stage execution. The old sequential `AdapterState` enum is replaced by `data_status()` checks — each stage asks "do I have my inputs?" not "was the previous stage run in this session?" A `run_full_pipeline(config)` method executes all stages sequentially in a background thread.

```
Load → ESPRIT Extract → Mode Tracking → Feedin Extraction → Channel Mapping → Apply
```

| Component | File | Purpose | Status |
|-----------|------|---------|--------|
| `ModalAdapter` | `modal_adapter.py` | Data-driven orchestrator with auto-persistence, `data_status()`, `run_full_pipeline()` | Working (independent stages) |
| `MappingConfig` | `mapping.py` | Maps measurement points to pitches, channel roles, bridge geometry | Working (with channel_roles, bridge_boundary, pitch_offset) |
| `EspritRunner` | `esprit_runner.py` | MAC-based band merging + spatial mode tracking | Working (merge_multiband_results + track_modes_along_bridge) |
| `esprit/` | `esprit/*.py` | Inlined ESPRIT library — see table below | Refactored, no external dependency |
| `FeedinExtractor` | `feedin_extractor.py` | FFT feedin extraction from measured IRs | Working (per-pitch + interpolation) |
| `PresetInjector` | `preset_injector.py` | Applies modes to preset (legacy + FFT feedin paths) + `build_preset_to_file()` for offline preset generation | Working (output pitches dynamic, up to 16 channels) |
| `modal_bp` | `routes.py` | Flask blueprint mounted at `/modal/*` | 23 endpoints (includes `data_status`, `run_pipeline`) |

Key endpoints added in the redesign:

- `GET /modal/data_status` — returns availability flags (`has_measurements`, `has_esprit`, `has_tracking`, `has_feedin`, etc.) used by the frontend to enable/disable stages independently
- `POST /modal/run_pipeline` — runs the full pipeline in a background thread; poll `GET /modal/status` for progress

Supports two input formats: direct `.npy` files and RoomResponse per-channel scenario data. Auto-persists intermediate results to project directory.

The ESPRIT library (`esprit/` subpackage) is inlined from the RoomResponse project. No external dependency required.

| File | Responsibility |
|------|---------------|
| `esprit_core.py` | Core ESPRIT algorithm: Hankel matrix, LS/TLS pole extraction, conjugate pairing, filtering, mode shape estimation |
| `band_processing.py` | Signal processing: `FrequencyBand` config, band presets, bandpass filter, preemphasis, decimation |
| `band_merging.py` | Cross-band deduplication (MAC + center weighting) and `merge_multiband_results()` orchestrator |
| `mode_tracking.py` | Spatial mode tracking along the bridge (`track_modes_along_bridge`, `ModeChain`) |

REST endpoints: see [REST_API.md](REST_API.md#modal-adapter-endpoints).

---

## Related Documentation

- [REST_API.md](REST_API.md) — complete endpoint reference
- [MIDI_SYSTEM.md](MIDI_SYSTEM.md) — MidiListener, midi_commands, event pipeline
- [CHART_SYSTEM.md](CHART_SYSTEM.md) — ChartGenerator, ChartRegistry, chartFunctions, chart_config.json
