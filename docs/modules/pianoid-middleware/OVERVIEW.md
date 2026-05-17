# pianoid_middleware — Module Overview

## Purpose

`pianoid_middleware` is a Flask-based HTTP middleware layer that orchestrates three subsystems:

- **UI layer** — a web frontend that sends REST requests and displays charts
- **Domain model** — the Python `Pianoid` orchestrator that owns the string map, modes, presets, and physical parameters
- **CUDA engine** — the C++ extension (`pianoidCuda`) that runs real-time physical string simulation and audio output

The middleware exposes a REST API (served by `backendServer.py`) that the UI calls to load presets, trigger playback, update parameters, retrieve simulation data, and render charts. A **Socket.IO WebSocket channel** on the same port provides low-latency note playback and server-push events (lifecycle, calibration progress, MIDI playback, engine errors).

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
- `load_deck_from_txt(preset_path, num_modes)` — overlay `Ci_coef_cos.txt` / `Ci_coef_str.txt` / `Ci_str_out.txt` modes coefficients from an FPGA preset directory onto the live `StringMap` deck (feedin / feedback / sound_coefficients), leaving excitation untouched
- `load_excitation_from_fpga_preset(preset_path, main_volume, apply_ind_vol, apply_ind_mult)` — overlay `exp_all.txt` + `ind_vol_0..4.txt` + `ind_mult_0..4.txt` Gauss excitation parameters from an FPGA preset directory onto the live `StringMap` excitation block. See **Loading FPGA presets** below

### Loading FPGA presets

FPGA preset dumps (e.g. `PresetsFromFpga/Bl_Apr_19/`) hold the excitation
source in `exp_all.txt` (per-Gauss-component `mu`, `sigma`, `volume` for
5 velocity levels × 88 piano pitches × 5 Gauss components) plus two
per-(pitch, level) coefficient files: `ind_vol_0..4.txt` (volume multiplier)
and `ind_mult_0..4.txt` (time-scale coefficient).
[Schema details](../../proposals/fpga-preset-excitation-loader-2026-05-17.md).

`Pianoid.load_excitation_from_fpga_preset()` decodes those files and writes
the resulting `(5, 4, 5)` Gauss matrix into each pitch's
`ExcitationParameters.levels_matrix` (5-level FPGA data is auto-migrated to
the framework's 6-level base and extrapolated to 128 levels).

The loader does **not** touch deck modes, sound channels, physics, or
ESPRIT-side data — it only updates the excitation block. To replace deck
coefficients, call `load_deck_from_txt()` separately.

**Volume calibration.** FPGA volumes are dimensionless (range
`[-0.6, 0.4]`); framework presets carry CUDA-side excitation amplitudes
in `[1e7, 1e10]`. The `main_volume` argument is a scalar applied to the
FPGA volume slot before `ind_vol` multiplication. For the Belarus preset
family, `main_volume = 8.35e9` produces a per-pitch median |volume| of
~3.08e8, matching the source `Belarus_8band_196modes.json` median
(3.18e8) within 3%.

**Skipped pitches.** FPGA covers MIDI 21..108 (A0..C8, 88 keys). If the
host preset omits any of those pitches (e.g. Belarus omits 21, 22, 107,
108), the loader silently skips them — only pitches present in the live
`StringMap.pitches` dict are wired.

**Known quirk: `ind_vol` row 88.** The FPGA `ind_vol_*.txt` files have
128 lines each (FPGA-addressed); rows 0..87 are real per-piano-key data
and row 88 (1-indexed file line 89) carries an off-by-one artifact value
the loader silently drops via the `[:88, :]` slice. Rows 89+ are zero
padding.

**Building a new preset.** `tools/generate_belarus_fpga_preset.py` shows
the canonical recipe: load a base preset JSON, instantiate `Pianoid` with
it, call `load_excitation_from_fpga_preset(...)`, then `save_preset(...)`
to a new path. The result (`presets/Belarus_8band_196modes_FPGAexc.json`)
keeps Belarus modes / deck / sound channels intact and only swaps in the
FPGA Gauss parameters.

### `ParameterManager` (parameter_manager.py)

Owns all parameter packing and GPU transfer operations. Receives `pianoid` (C++ binding), `sm` (StringMap), `modes` (ModeMap), `mp` (ModelParameters), and `cuda_lock`. Created during `initialize_pianoid()`.

**Engine safety net (catastrophic-input gate).** Before any mutation, the
dispatcher validates incoming parameter values via `validate_engine_param`.
Catastrophic predicates (`mode.mass_inv <= 0`, `excitation.sigma <= 0`,
`mode.frequency < 0`, `mode.decrement < 0`) plus a universal NaN/Inf guard
raise `ParameterRangeError` (a `ValueError` subclass). REST handlers in
`backendServer.py` catch it and return HTTP 400 with a structured error
message; WS handlers emit `error` with `code: "parameter_range_error"`.
The safety net is the canonical engine-correctness gate — the only line of
defense after dev-2706 removed UI-level value clamps. See REST_API.md
"Engine safety net" and CODE_QUALITY.md S5b.

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
- `apply_parameter_request(request)` — canonical entry (Tranche A / M7). Accepts a typed `ParameterUpdateRequest(kind, values, pitches=None, modes=None, extra={})`. Used by the shared `_apply_parameter_request` / `_apply_string_excitation` helpers in `backendServer.py` so REST and WebSocket callers share the same dispatch glue.
- `update_parameter()` — existing dispatcher for REST API and batch operations; still supported, also reached internally via `apply_parameter_request` for the standard `kind` values.
- `update_pitch_physical_params()` / `update_pitch_physical_params_GRANULAR()` — single-pitch physical param update
- `update_pitch_excitation()` — single-pitch excitation update (also reachable via `kind="string_excitation_curves"` on `ParameterUpdateRequest`).
- `send_deck_params_to_CUDA()` — deck scaling for MIDI CC handlers

**Runtime parameters** (volume, feedback, volume_center/range, max_volume) do NOT go through `ParameterManager` — they live on `Pianoid` directly and use `setRuntimeParameters` / `set_volume_level` / `set_deck_feedback_coefficient`. REST `/set_runtime_parameters` and WS `set_runtime_parameters` share a separate helper `_apply_runtime_parameters` in `backendServer.py` (Tranche A / M6).

**Fix-MIDI velocity clamp** (`fix_velocity_enabled`, `fix_velocity_level`) is a runtime/session-only velocity-clamp applied to every MIDI-source NOTE_ON ingress. State lives on `Pianoid` (not preset-persisted, not reset on preset switch, reset to defaults on backend restart). One canonical helper `Pianoid.apply_fix_velocity(v)` is consulted by the unified MIDI listener (`schedule_event` for `listen_to_midi=1`), the legacy `pianoidMidiListener.note_on`, and REST `/play` + WS `play` when the caller passes `source: "midi"`. Calibration, `/play_keyboard`, and `/play_mode` paths are intentionally exempt. REST surface: `POST /set_fix_velocity` + `GET /get_fix_velocity` + WS `set_fix_velocity`. See [REST_API.md — Fix-MIDI velocity clamp](REST_API.md#fix-midi-velocity-clamp). Frontend: `useFixVelocity` hook + ToolBar checkbox + Level dropdown — replaces the legacy JS `midiPlayNote` velocity rewrite (dev-bv01, 2026-05-03).

### Flask app (backendServer.py)

- Module-level globals: `pianoid` (current `Pianoid` instance), `running` (bool), `chart_registry` (`ChartTypeRegistry`), `socketio` (`SocketIO` instance)
- `long_running_procedure(pianoid, listen)` — background thread target, calls `start_realtime_playback`
- `parse_range(pianoid, parameter, key_no)` — converts URL segment (`all`, `42`, `from21to88`) to pitch/mode lists
- `emit_lifecycle_event(state_name, preset, extra)` — broadcasts lifecycle state change via WebSocket (thread-safe)
- `emit_calibration_progress(progress_data)` — broadcasts calibration progress via WebSocket (thread-safe)
- `emit_midi_playback_progress(position_ms, total_ms, notes_played)` — broadcasts MIDI playback progress (thread-safe)
- `emit_engine_error(code, message)` — broadcasts engine error via WebSocket (thread-safe)
- `_DEBUG_PLAY` — environment flag (`PIANOID_DEBUG_PLAY=1`) to enable console print in the `/play` hot path

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

**Volume correction algorithm:** Direct linear correction exploiting the linear RMS-to-excitation relationship (`RMS = K(pitch) * excitation_scale`, R^2 > 0.998). A single measurement determines the correction factor (`target_rms / measured_rms`), reducing per-note calibration from 20-30 measurements (bisection) to 1-2 measurements. Bisection is retained as a fallback for clipping, near-zero signal, or unexpected nonlinearity.

Key methods:

| Method | Purpose |
|--------|---------|
| `calibrate(velocity_levels, pitches, target_rms)` | Full calibration run (background thread) |
| `measure_single(pitch, velocity, repetitions)` | Single-note RMS measurement |
| `equalize_keyboard(reference_pitch, velocity)` | Equalize all pitches to a reference (direct correction) |
| `tune_single(pitch, velocity, target_db)` | Direct correction to match target dB (bisection fallback) |
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

**Status:** All 6 waves complete — untested (not yet verified in browser). Backend (Waves 1-4) and frontend (Waves 5-6) implementation done. See [MODAL_ADAPTER_REDESIGN_PLAN.md](../../development/archive/MODAL_ADAPTER_REDESIGN_PLAN.md) for commit references.

**Architecture:** Data-availability-driven with independent stage execution. The old sequential `AdapterState` enum is replaced by `data_status()` checks — each stage asks "do I have my inputs?" not "was the previous stage run in this session?" A `run_full_pipeline(config)` method executes all stages sequentially in a background thread.

```
Load → ESPRIT Extract → Mode Tracking → Feedin Extraction → Channel Mapping → Apply
```

| Component | File | Purpose | Status |
|-----------|------|---------|--------|
| `ModalAdapter` | `modal_adapter.py` | Data-driven orchestrator with auto-persistence, `data_status()`, `run_full_pipeline()` | Working (independent stages) |
| `MappingConfig` | `mapping.py` | Maps measurement points to pitches, channel roles, bridge geometry, and response-channel-to-sound-output (`channel_to_sound`). Single on-disk source is `mapping_config.json`; legacy `channel_mapping.json` is auto-migrated on `open_project` (F6 / W3-B). | Working (channel_roles, bridge_boundary, pitch_offset, channel_to_sound) |
| `EspritRunner` | `esprit_runner.py` | Per-scenario multi-band ESPRIT extraction, MAC-based band merging, spatial mode tracking along bridge, amplitude/shape/mode_shape computation. Filters to response channels only when channel roles are set (excludes force/skip from Hankel matrix) | Working (merge_multiband_results + track_modes_along_bridge + response channel filtering) |
| `esprit/` | `esprit/*.py` | Inlined ESPRIT library — see table below | Refactored, no external dependency |
| `FeedinExtractor` | `feedin_extractor.py` | Feedin extraction: mode-shape reference projection (default) with FFT fallback | Working (mode_shape + fft methods) |
| `PresetInjector` | `preset_injector.py` | Applies modes to preset (legacy + FFT feedin paths) + `build_preset_to_file()` for offline preset generation. Configurable via `PresetConfig` | Working (output pitches dynamic, up to 16 channels) |
| `PresetConfig` | `preset_injector.py` | Dataclass for preset build parameters: `max_modes`, `feedin_max`, `regular_feedback`, `sound_max`, `interpolate_missing` | Working |
| `modal_bp` | `routes.py` | Flask blueprint mounted at `/modal/*` on the **modal adapter server (port 5001)** only. The main backend (port 5000) does NOT register the blueprint; it defines just one counterpart route (`POST /modal/apply_to_preset`) inline because that route alone needs the live `Pianoid` engine. | 23 endpoints on 5001 + 1 on 5000 |

### PresetConfig Parameters

`PresetConfig` controls post-processing applied during preset building. All parameters default to legacy behavior (no normalization, feedback = feedin copy).

| Parameter | Type | Default | Effect |
|-----------|------|---------|--------|
| `max_modes` | `int \| None` | `None` | Filter to top N chains by stability class (stable > semi-stable > weak > spurious) then coverage |
| `feedin_max` | `float \| None` | `None` | Scale feedin so global max equals this value (ASIO compatibility) |
| `regular_feedback` | `float \| None` | `None` | Uniform feedback for regular pitches; enables per-channel output pitch feedback from baseline ratio |
| `sound_max` | `float \| None` | `None` | Scale sound coefficients so global max does not exceed this value |
| `interpolate_missing` | `bool` | `False` | Fill missing pitch feedin/sound data from nearest neighbors |

Belarus pipeline equivalent: `PresetConfig(max_modes=196, feedin_max=0.5, regular_feedback=2.0, sound_max=1.0, interpolate_missing=True)`.

Key endpoints added in the redesign:

- `GET /modal/data_status` — returns availability flags (`has_measurements`, `has_esprit`, `has_tracking`, `has_feedin`, etc.) used by the frontend to enable/disable stages independently
- `POST /modal/run_pipeline` — runs the full pipeline in a background thread; poll `GET /modal/status` for progress
- `GET /modal/defaults` — pipeline defaults (`bridge_boundary`, `pitch_offset`, tracking and ESPRIT defaults) shared between backend and frontend (F16, W4-A)

Supports two input formats: direct `.npy` files and RoomResponse per-channel scenario data. Auto-persists intermediate results to project directory.

The ESPRIT library (`esprit/` subpackage) is inlined from the RoomResponse project. No external dependency required.

| File | Responsibility |
|------|---------------|
| `esprit_core.py` | Core ESPRIT algorithm: Hankel matrix, LS/TLS pole extraction, conjugate pairing, filtering, mode shape estimation |
| `band_processing.py` | Signal processing: `FrequencyBand` config, band presets, bandpass filter, preemphasis, decimation |
| `band_merging.py` | Cross-band deduplication (MAC + center weighting) and `merge_multiband_results()` orchestrator |
| `mode_tracking.py` | Spatial mode tracking along the bridge (`track_modes_along_bridge`, `ModeChain`, `ModeDetection`) |

### Feedin Extraction Methods

The pipeline supports two feedin extraction methods, controlled by `feedin_method` parameter (`"mode_shape"` default, `"fft"` fallback):

| Method | Algorithm | Input | Signed? |
|--------|-----------|-------|---------|
| `mode_shape` | Reference projection: mean complex mode shape as reference, project each detection via `Re(phi . conj(phi_ref))` | Complex mode shapes from ESPRIT (persisted as `.npy`) | Yes — captures node crossings |
| `fft` | FFT magnitude at mode frequencies from raw IR measurements | Raw measurement signals + response channels | No — always positive |

Mode-shape method auto-falls back to FFT when chains lack complex mode shape data (e.g., loaded from old project data without `.npy` files).

### Complex Mode Shape Persistence

ESPRIT results are persisted per scenario as:
- `scenario_{idx}.json` — frequencies, damping, amplitudes, shape_magnitudes (real projections)
- `scenario_{idx}_shapes.npy` — complex128 array (n_modes x n_channels), lossless phase preservation

REST endpoints: see [REST_API.md](REST_API.md#modal-adapter-endpoints).

### Measurement Stack (Phase 0 RR-port, dev-rrport 2026-05-10)

`modal_adapter_server` (port 5001) imports the in-tree measurement stack
at process start to make the `sdl_audio_core` measurement engine and the
`RoomResponseRecorder` family available in the same Python process as
the Modal Adapter pipeline. Both pieces ship inside PianoidCore now and
install into `PianoidCore/.venv/Lib/site-packages/`:

- `sdl_audio_core` — pybind11 C++ extension built from
  `PianoidCore/sdl_audio_core/` by `build_pianoid_cuda.bat` (subroutine
  `:build_sdl_audio_core`, see
  [BUILD_SYSTEM.md](../../architecture/BUILD_SYSTEM.md#sdl_audio_core-build-phase-0-rr-port)).
- `pianoid_middleware.modal_adapter.measurement` — the seven Python
  modules ported verbatim from the sibling RoomResponse repo (recorder,
  dataset_collector, missing_averages, mic_testing, signal_processor,
  filename_utils, calibration_validator).

| Aspect | Detail |
|--------|--------|
| Probe (in-process) | `_probe_measurement_stack()` in `modal_adapter_server.py` — imports `sdl_audio_core` + `pianoid_middleware.modal_adapter.measurement.recorder` |
| Status surface | `app.config['roomresponse_status']` (dict: `available`, `sdl_version`, `error`, `room_response_path`) — dict shape preserved for frontend backwards-compat; `room_response_path` is now always `None` |
| Health endpoint | `GET /modal/collect/health` returns the status dict verbatim |
| Failure mode | Soft — server still starts when the import probe fails (e.g. `sdl_audio_core` not built yet) |

**Pre-Phase-0 (deleted at dev-rrport, 2026-05-10):** `_room_response_bootstrap.py`
shim that injected `<PianoidInstall sibling>/RoomResponse` into `sys.path`
and the `PIANOID_ROOMRESPONSE_PATH` env var. After Phase 0 PianoidCore
no longer reaches outside its own checkout for measurement code; future
RoomResponse updates do not propagate automatically (intended decoupling
per proposal Q6 — see [`docs/proposals/modal-adapter-measurement-entity-2026-05-10.md`](../../proposals/modal-adapter-measurement-entity-2026-05-10.md)).

The main backend (port 5000) does NOT run the probe — `modal_bp` mounted
on `backendServer.py` returns `available: false` with a clear error from
the health endpoint, since `roomresponse_status` is never populated in
that process. This is intentional: synthesis uptime must not depend on
measurement collection availability, and the audio device cannot be
opened twice in the same process.

SDL3.dll is byte-identical between
`PianoidCore/.venv/Lib/site-packages/pianoidCuda/` and
`PianoidCore/.venv/Lib/site-packages/sdl_audio_core/` (both built from
`C:\SDL3-3.2.0\`), so importing `sdl_audio_core` alongside `pianoidCuda`
does not cause symbol or DLL conflict. Pause/resume coexistence (the
modal-adapter-server claiming the audio device while Pianoid is paused)
relies on `/pause_synthesis` (`backendServer.py:1844-1853`) reaching
`pianoid.stop_playback()` → `SDL3AudioDriver::stopPlayback`
(`SDL3AudioDriver.cpp:296-309`), which calls `SDL_DestroyAudioStream`.
In SDL3, destroying the last stream bound to a device releases the OS
audio device — so the device is genuinely free for `sdl_audio_core` to
open while paused.

---

## Related Documentation

- [REST_API.md](REST_API.md) — complete endpoint reference
- [MIDI_SYSTEM.md](MIDI_SYSTEM.md) — MidiListener, midi_commands, event pipeline
- [CHART_SYSTEM.md](CHART_SYSTEM.md) — ChartGenerator, ChartRegistry, chartFunctions, chart_config.json
