# pianoid_middleware — REST API Reference

## Server Architecture

The middleware runs as **two Flask servers**:

| Server | Port | Role |
|--------|------|------|
| `backendServer.py` | 5000 | Synthesis engine, playback, parameters, calibration, presets |
| `modal_adapter_server.py` | 5001 | Modal extraction pipeline, project management, folder dialogs |

Both servers have CORS enabled for all origins. The frontend connects to both servers concurrently.

**Error-response CORS guarantee** — `backendServer.py` registers a global `@app.errorhandler(Exception)` that converts any uncaught exception into a JSON 500 response (`{"error": <ExceptionClass>, "message": <str>, "path": <request.path>}`). This ensures Flask-CORS attaches `Access-Control-Allow-Origin` to every error the browser might see. Werkzeug `HTTPException` responses (404, 400, etc.) are passed through unchanged — Flask-CORS handles those via `after_request`. Without this, the Werkzeug debug HTML 500 response is untagged and the browser blocks it as a CORS error, making the actual failure invisible to the frontend.

### WebSocket Channel (port 5000)

`backendServer.py` also provides a **Socket.IO WebSocket channel** on the same port (5000) for low-latency bidirectional communication. The WebSocket layer is purely additive — all REST endpoints remain functional.

| Feature | Transport | Direction |
|---------|-----------|-----------|
| Note playback | `play` event (JSON or binary) | Client -> Server |
| Parameter updates | `set_parameter` event | Client -> Server |
| Runtime parameters | `set_runtime_parameters` event | Client -> Server |
| Fix-MIDI velocity | `set_fix_velocity` event | Client -> Server |
| String excitation | `set_string_excitation` event | Client -> Server |
| Hammer shape | `set_hammer_shape` event | Client -> Server |
| Parameter acknowledgment | `param_ack` event | Server -> Client (push) |
| Lifecycle state | `lifecycle` event | Server -> Client (push) |
| Calibration progress | `calibration` event | Server -> Client (push) |
| MIDI playback progress | `midi_progress` event | Server -> Client (push) |
| Inbound MIDI events | `midi_note_event` event | Server -> Client (push) |
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
  /set_fix_velocity         -- enable/disable Fix-MIDI velocity clamp (POST)
  /get_fix_velocity         -- read current Fix-MIDI clamp state (GET)
  /set_runtime_parameters   -- volume / feedback at runtime
  /play                     -- trigger note on/off
  /play_mode/<mode_no>      -- trigger mode playback
  /play_keyboard            -- full-keyboard sweep (online+mic capture / offline render)
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
  /preset/list              -- list library entry records + active preset
  /preset/load              -- load preset to GPU library as a read-only original
  /preset/switch            -- switch active preset (double-buffer swap)
  /preset/unload            -- remove preset from GPU library
  /preset/spawn_working_copy -- spawn an editable working copy from an entry
  /preset/promote           -- promote a working copy onto its original's JSON file
```

### modal_adapter_server.py (port 5001)

On startup, the server runs a stale process check: finds any PID listening on the configured port via `netstat`, verifies it is a Python process running `modal_adapter_server` via WMIC, and kills only confirmed stale instances before binding.

```
  /health                   -- lifecycle status
  /shutdown                 -- graceful shutdown
  /open_folder_dialog       -- native OS folder picker (tkinter subprocess)
  /modal/defaults           -- pipeline defaults shared with frontend
  /modal/data_status        -- pipeline stage availability flags
  /modal/run_pipeline       -- run full extraction pipeline (background)
  /modal/load_folder        -- load impulse response measurements
  /modal/upload_measurements -- upload measurement arrays
  /modal/measurement_info   -- measurement metadata
  /modal/mapping            -- set excitation-to-pitch mapping
  /modal/esprit_config      -- GET/POST ESPRIT config (persists to config.json)
  /modal/band_presets       -- GET built-in + user-saved band preset listing
  /modal/band_presets/save  -- POST save current band config as named user preset
  /modal/band_presets/<n>   -- DELETE remove a user-saved band preset
  /modal/gpu_status         -- check CuPy GPU availability
  /modal/run_esprit         -- launch ESPRIT extraction (background)
  /modal/status             -- poll ESPRIT progress
  /modal/results            -- get extraction results
  /modal/apply_to_preset    -- inject modes into active preset
  /modal/cancel             -- cancel running extraction
  /modal/run_frf            -- (Phase 1, dev-frf-q-phase01) spectral FRF
                               extraction with hammer-impact force window
                               from raw_recordings/ per scenario
  /modal/frf/summary        -- (Phase 1) project-level FRF index + per-scenario
                               metadata (lightweight, safe before any run)
  /modal/frf/scenario/<idx> -- (Phase 1) per-scenario FRF arrays serialised
                               for the frontend (frequencies + per-channel
                               magnitude_db / magnitude_abs / phase_deg /
                               coherence)
  /modal/frf                -- (Phase 1, DELETE) invalidate FRF — remove
                               persisted files + clear in-memory state
  /modal/qc/log_decrement   -- (Phase 0c) GET + POST Hilbert log-decrement
                               Q cross-check; flags chains where Q_logdec
                               disagrees with Q_esprit beyond threshold
                               (default 30%)
  /modal/run_modal_mass     -- (Phase 2, dev-modal-mass-p2) per-chain residue
                               extraction (SDOF circle-fit + MDOF RFP) +
                               SVD dual-unit-max inversion -> per-mode
                               relative modal mass + mass-normalised
                               shapes. Q6 gate: requires >=8 scenarios
                               with FRF persisted.
  /modal/modal_mass/summary -- (Phase 2) project-level modal-mass index
                               (chain count, m_rel/m_abs, reference mode)
  /modal/modal_mass/mode/<chain_id> -- (Phase 2) per-chain payload (shapes
                               + per-(scenario, channel) residues)
  /modal/modal_mass         -- (Phase 2, DELETE) invalidate modal mass —
                               remove persisted files + clear cache
  /modal/projects           -- list projects, current project, projects_base
  /modal/projects/create    -- create project with optional measurement_source
  /modal/projects/open      -- open existing project
  /modal/projects/copy      -- clean-clone: copy measurements + mapping
                               from an existing project but reset all
                               analysis output (ESPRIT/tracking/feedin/
                               applied) so the user can re-run the
                               pipeline with different parameters.
                               dev-mabug.
  /modal/projects/delete    -- delete project
  /modal/projects/add_measurements -- add measurements to current project
  /modal/projects/set_base  -- set projects base directory
  /modal/projects/export    -- download project as .pianoid-project zip
  /modal/projects/export_info -- preview export size and stage completeness
  /modal/projects/import    -- upload and import .pianoid-project zip
  /modal/projects/<name>/effective_signal_length -- (dev-qc01) per-scenario per-channel
                                                    Effective Signal Length QC (GET) +
                                                    recompute (POST). dev-qc02 added
                                                    qc_threshold body field (default 0.1).
  /modal/projects/<name>/qc_curves -- (dev-3151) interactive QC curves for one
                                      (scenario, channel) — signal_a / signal_b /
                                      env_signal / env_diff / ratio + T_eff at the
                                      requested threshold. Backs QCVisualizationPanel.
  /modal/collect/health     -- (B-0) RoomResponse coexistence probe
  /modal/collect/start      -- (B-1) begin one measurement scenario
  /modal/collect/status     -- (B-1) active session snapshot
  /modal/collect/cancel     -- (B-1) cancel active session
  /modal/collect/results/<sid> -- (B-1) completed-session result + metadata
  /modal/collect/devices    -- (B-1) enumerate SDL3 input/output devices
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
  "midi_port": 0,
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
- `audio_driver_type`: `0`=default (SDL3, hardware-free), `1`=ASIO, `2`=SDL (auto-detect SDL3 if available, else SDL2), `3`=SDL3, `4`=ASIO_CALLBACK

  Type `0` is pinned to SDL3 with `circular_buffer_chunks=16` — same as type `3`. Historically `0` was a "compile-time default" sentinel that resolved to whichever driver was prioritised in `ACTIVE_AUDIO_DRIVER` (ASIO when both ASIO and SDL3 are compiled in), but left the buffer depth at the ASIO default (`4`). On Windows builds compiled with both drivers this caused SDL3 driver underruns on the second in-place `/load_preset` reload — engine entered `audio_driver_active=false, exception=true` state. Fixed in dev-f99c (2026-05-01); see `pack_initialization_params_for_cuda` in `pianoid_middleware/pianoid.py`.

**Audio driver selection rule:** Prefer ASIO Callback (`4`) when an ASIO device is available — it provides the lowest latency. If ASIO is not available (no ASIO driver installed, or running without a dedicated audio interface), use SDL (`2`) as fallback. SDL works on all systems without special drivers. `0` is the safe default for tests / headless / "no specific audio hardware" callers — equivalent to type `3`.
- `cycle_iterations`: samples per cycle; must match audio buffer size, minimum 16, default 64
- `audio_buffer_size`: buffer chunks; `2`=low latency, `4`=balanced, `8`=high stability
- `array_size`: spatial discretization points per string block; `384` (default) or `512`. Clamped to 384–512. When the requested value differs from the preset's native `array_size`, string geometry (`main` and `tail`) is scaled proportionally
- `sample_rate`: Hz; if < 1000 is multiplied by 1000
- `volume`: MIDI-style level 0–127 (old API)
- `max_volume`: float, explicit max volume (new API, takes precedence over `volume`)
- `start_right_away`: **binary** — `1`=start realtime playback in a background thread; `0` (or any non-`1`)=initialize only, do not start (engine is loaded and ready; playback is started later). The frontend only ever sends `0` or `1`. (The former `2`=start inline [deprecated] and `3`=init only [duplicate of `0`] values were removed in dev-5c3b, 2026-05-30 — the `2` branch had no caller and `3` was byte-identical to `0`.)
- `listen_to_modes`: `0`=sound channels carry string bridge displacement, `1`=sound channels carry mode forces (default `1`)
- `use_simulation`: `0`=normal operation (default, the only supported value); `1`=routes to `pianoid_cuda_placeholder.py`, a vestigial pre-library-API stub that has not been kept in sync with the live `pianoidCuda` API. **`use_simulation=1` is rejected with HTTP `400 FeatureNotSupported`** — the route handler short-circuits before destroying the engine. Fixed in dev-b001 (2026-05-01); pre-fix the request returned HTTP 500 `TypeError: Pianoid.__init__() missing 1 required positional argument: 'strings_in_pitches'` AND destroyed the live engine. See `backendServer.py:load_preset_route` and the deferred WIP follow-up "use_simulation/use_placeholder placeholder is vestigial" for the resurrection or retirement decision.
- `listen_to_midi`: `0`=do not start the unified MIDI listener thread; `1`=start the unified `MIDI_listener_unified` thread that routes inbound rtmidi messages through `Pianoid.schedule_event(...)` for cycle-aligned dispatch (decision A1 — listener defaults to rtmidi port `0`; see `GET /midi/ports`).

    **Default since W3 Phase 2:** the frontend `useSettings.js` ships with `listen_to_midi: 1` so the listener starts with the engine. Existing users with `listen_to_midi: 0` saved in localStorage keep their preference; pre-feature users (no key at all) inherit the new default.

    **Sysadmin / test-harness override:** the backend honours the `PIANOID_LISTEN_TO_MIDI` environment variable. When set to `"0"` or `"1"`, the value overrides whatever the request body sent (read per-request inside `/load_preset` so it applies to every preset load in the session). Unset / any other value → request body wins. Use this to pin listener state regardless of which UI the user runs (e.g. headless CI, mic-only calibration runs).

    **Runtime control:** after the engine is up, callers can hot-toggle without re-issuing `/load_preset` via `POST /midi/start` and `POST /midi/stop` (W3 Phase 2). Both are idempotent.
- `midi_port` (optional, default `0`): rtmidi input-port index used when `listen_to_midi=1`. Use `GET /midi/ports` to enumerate available ports before posting. Use `POST /midi/select_port` to change ports in place without restarting the backend.

Response `200`:
```json
{"message": "Preset loaded successfully"}
```

Response `400` (when `use_simulation=1`):
```json
{
  "error": "FeatureNotSupported",
  "message": "use_simulation=1 is not currently supported. The placeholder module is out of sync with the live library-API and would crash the engine. Pass use_simulation=0 (the default)."
}
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
| `sound_channel` | Mode-coupling coefficients per pitch (modes-listen mode `listen_to_modes=1`). Effective rows: piano pitches `0..127` |
| `string_sound_channel` | Strings-mode gain per pitch (strings-listen mode `listen_to_modes=0`). Effective rows: **output pitches `128..127+num_output_channels` only** — POSTing to a piano-pitch `<key_no>` (0..127) updates the Python store but the kernel never reads those rows. To set the gain for audio output channel `ch`, POST to `<key_no> = 128 + ch`. See `docs/modules/pianoid-basic/OVERVIEW.md` "Stored vs effective entries" for the data-model contract |
| `stability_ratio` | **Read-only.** Per-pitch FDTD CFL/Courant stability ratio = `max_θ|g(θ)|` (`CFL_LIMIT = 1`); `ratio ≤ 1` is stable (a lossless string sits at exactly `1.0`). Per pitch: `{ratio, stable, strings:[{string_index, ratio, stable}]}`, plus a top-level `_meta {cfl_limit, criterion, formula}`. **Computed HOST-side** (v2) from the current `StringMap` physics via the closed-form `cfl_stability.max_amplification` (no GPU round-trip, no debug build), honouring the per-string `tension_offset`; output/"sound" strings (pitch ≥ 128) report the sentinel `1.0`/stable. Analyst-plottable vs pitch (`key_no = "all"`, `"output"`, or `"from21to108"`). Derivation: `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md` "FDTD Stability (CFL / Courant) Bound"; design `docs/proposals/cfl-stability-guard-v2.md`. `POST` to this parameter is not supported |

`key_no` formats:
- Integer string: `"57"` — single pitch or mode number
- `"all"` — all pitches or all modes (depending on parameter type)
- `"output"` — output pitches only (for `output` parameter)
- `"from<N>to<M>"` — inclusive range, e.g. `"from21to88"`

For `mode`, `feedin`, `feedback`, `output`: `key_no` is treated as a mode number range.
For all other parameters: `key_no` is treated as a pitch number range.

**`string` parameter — `length` unit.** For `parameter == string` (and `physics`),
the `length` field is the main-section physical length in **metres**
(`p_main * dx`), *not* the FDTD block count. `PhysicalParameters.pack()` stores
`p_main()` (the unitless block/discretisation-point count) in that slot; the
serializer multiplies by `dx` so the endpoint reports metres — the same unit the
`combined` branch reports and the same unit `geometry.set_length()` expects. A
`length` value POSTed back via `set_parameter/string` is therefore interpreted as
metres, making the GET→edit→POST round-trip unit-consistent. (Returning the raw
block count here previously made the granular path upload `dx ≈ 1.0 m`, an ~84-141x
error that diverged the FDTD solver — fixed in `cce4270`.)

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

Response `400` — engine safety net rejection (see "Engine safety net" below):
```json
{"error": "mode.decrement=-1 rejected: decrement must be >= 0 (negative damping causes runaway amplitude)"}
```

Response `416`:
```json
{"message": "Wrong parameter request"}
```
or
```json
"Set parameter route: Internal error in module pianoid.py: <traceback>"
```

#### Engine safety net (catastrophic-input rejection)

Per the **S5 fail-fast** principle (`docs/development/CODE_QUALITY.md` S5b),
`parameter_manager` rejects values that would corrupt engine state with HTTP 400
*before* any state mutation or GPU upload. The frontend NumInput callers omit
`min`/`max` clamps for engine-bound parameters (per dev-2706 directive); this
backend gate is the single line of defense against catastrophic inputs.

| Parameter | Field | Reject when | Reason |
|-----------|-------|-------------|--------|
| `mode` | `mass_inv` | `<= 0` | division-by-zero in `Mode.fit_params` (stiffness = (2πf)²/mass_inv) |
| `excitation` / `gauss` | `sigma` | `<= 0` | division-by-zero in Gaussian `exp(-((t-mu)/sigma)²)` |
| `mode` | `frequency` | `< 0` | physically meaningless; produces NaN/instability |
| `mode` | `decrement` | `< 0` | negative damping → exponential amplitude growth → speaker/ear damage |
| any | any numeric field | NaN, +Inf, -Inf | non-finite values corrupt every parameter type |
| `string` / `physics` | (combination of `tension`, `density`, `radius`, `stiffness`, `dx`, `sample_rate`, …) | the FDTD amplification `max_θ\|g(θ)\| > 1` (outside the two-sided box `8·coeff_bending ≤ coeff_tension ≤ 1 + 8·coeff_bending`), or non-finite | explicit FDTD scheme would diverge (Inf/NaN string field → engine-wide noise). Unlike the per-field predicates above, this is a *combination* check. **v2 (host-side):** `parameter_manager` computes the closed-form amplification from the **prospective** physics (current ⊕ this edit) **BEFORE** any GPU upload — honouring the per-string `tension_offset` (worst string decides) and skipping output strings (pitch ≥ 128) — and raises `CflRejected` → 400 if it would diverge. The edit is **never applied** (no `set_param`, no upload); the engine keeps its last-good coefficients. (No kernel guard / shadow buffer / per-string flag — those + the host flag-poll were the v1 design, removed in v2.) See `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md` "FDTD Stability" + `docs/proposals/cfl-stability-guard-v2.md` |

Example string-edit rejection body (v2) — HTTP `400`, served by the dedicated `@app.errorhandler(CflRejected)`:

```json
{
  "error": "CflRejected",
  "code": "cfl_unstable",
  "cfl_redline": true,
  "pitch": 60,
  "string": 1,
  "amplification": 46.123,
  "message": "cfl_unstable: string parameter rejected — would destabilise the FDTD solver (Courant). pitch 60 (string 1): amplification |g|=46.123 > 1.0. Edit not applied; last-stable coefficients retained.",
  "path": "/set_parameter/string/60"
}
```

`code: "cfl_unstable"` and the `cfl_redline` boolean (the redline-crossed flag) let the UI react without
parsing the message; `pitch`/`string`/`amplification` identify the worst offending string. The WebSocket
`set_parameter` handler emits the same `{code, cfl_redline, pitch, string, amplification, message}` shape on
an `error` event. The per-string amplification ratios behind this gate are queryable read-only via
`GET /get_parameter/stability_ratio/<key_no>` (above) for plotting ratio-vs-pitch.

Example rejection bodies:

```json
{"error": "mode.mass_inv=0 rejected: mass_inv must be > 0 (division-by-zero in mode update)"}
```
```json
{"error": "excitation.sigma=-0.01 rejected: sigma must be > 0 (division-by-zero in Gauss exp(-((t-mu)/sigma)^2))"}
```
```json
{"error": "mode.frequency=nan rejected: must be a finite number (NaN/Inf would corrupt engine state)"}
```

The same predicate set applies to:
- `POST /set_parameter/mode/<key_no>` (canonical route)
- `POST /set_parameter/excitation/<key_no>` and `POST /set_parameter/gauss/<key_no>` (sigma)
- `POST /set_string_excitation/<pitch_no>` (sigma in per-pitch curves)
- `POST /set_mode_parameters` (legacy route — same mode predicates)
- WS `set_parameter` and WS `set_string_excitation` (emit `error` with `code: "parameter_range_error"`)

**Range bounds beyond these catastrophic predicates are NOT validated** — values
the user types flow through to the engine. UX-style range checks (e.g. "volume
should be < 1e10") were intentionally removed from both UI and backend per
dev-2706.

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

Response `400` — see [Engine safety net](#engine-safety-net-catastrophic-input-rejection)
above. `sigma <= 0` and NaN/Inf in any curve field are rejected before
`update_pitch_excitation` mutates state.

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

Response `400` — see [Engine safety net](#engine-safety-net-catastrophic-input-rejection).
Mode predicates (`mass_inv <= 0`, `frequency < 0`, `decrement < 0`, NaN/Inf)
apply here too. Note: this is the legacy mode-update route; new code should
use `POST /set_parameter/mode/<key_no>`.

---

### Fix-MIDI velocity clamp

The Fix-MIDI clamp lets the user pin every incoming MIDI NOTE_ON to a single
velocity, regardless of how hard the key was pressed. State lives on the
running engine — runtime/session scope, NOT preset-persisted, NOT reset on
preset switch, reset to defaults on backend restart (option B per
dev-bv01 user direction, 2026-05-03).

**Source-flag protocol.** REST `/play` and WS `play` accept an optional
`source` field. The clamp applies ONLY when `source == "midi"`. Non-MIDI
callers (virtual piano, space-bar, Excitation editor, calibration paths)
omit the flag and preserve their explicit velocity.

**Single canonical helper.** Every clamp goes through
`Pianoid.apply_fix_velocity(velocity)` — there is no parallel mechanism. The
helper is called from:

| Ingress | Clamp gate |
|---|---|
| REST `POST /play` with `source: "midi"` | `pianoid.apply_fix_velocity` (gated by source flag) |
| REST `POST /play` without `source` | NOT clamped |
| WS `play` event with `source: "midi"` | gated by source flag (same as REST) |
| WS `play` event without `source` | NOT clamped |
| `Pianoid.schedule_event(...)` (default `apply_fix_velocity=True`) | unconditional clamp for NOTE_ON — used by the unified MIDI listener (`MIDI_listener_unified`, the `listen_to_midi=1` backend path) |
| Legacy `pianoidMidiListener` `note_on` | calls `apply_fix_velocity` directly |
| `Pianoid.perform_midi_command(...)` | defaults `apply_fix_velocity=False` — preserves backward compat for NoteTunner calibration / `set_sustain` |
| `/play_keyboard` (online + offline) | passes `apply_fix_velocity=False` — deterministic diagnostic sweep, never clamped |
| `/measure_rms`, `/tune_note`, `/calibrate_volume`, `/equalize_keyboard` | NOT clamped — calibration depends on explicit velocity |
| `/play_mode/<mode_no>` | N/A — uses internal synthesis path, not MIDI velocity |
| `note_playback` chart (offline render) | NOT clamped — strict-A1 audio_off determinism |

This collapses three pre-refactor parallel mechanisms (`pianoid.fixed_velocity`,
`pianoid.fixed_level`, frontend `midiPlayNote` JS rewrite) into one canonical
owner. Closes the listen_to_midi=1 sidestep where the backend MIDI listener
bypassed the JS clamp.

---

### `POST /set_fix_velocity`

Sets the Fix-MIDI velocity clamp state. Both fields required.

Request body:
```json
{"enabled": true, "level": 95}
```

- `enabled` (bool, required): when `true`, MIDI-source NOTE_ON velocities are
  clamped to `level`. When `false`, MIDI velocities pass through.
- `level` (int 0-127, required): the clamped velocity value. `0` is allowed
  (silent note); `127` is allowed (fortissimo).

Response `200`:
```json
{"message": "OK", "fix_velocity": {"enabled": true, "level": 95}}
```

Response `400` cases:
- `Pianoid not initialized`
- `Body must be a JSON object`
- `Both 'enabled' and 'level' are required`
- `enabled must be bool`
- `level must be int`
- `level must be 0-127, got <N>`

Symmetric WS event: `set_fix_velocity` accepts the same payload and emits
`param_ack` with `{parameter: "fix_velocity", status: "ok", updated: {...}}`.

---

### `GET /get_fix_velocity`

Returns the current Fix-MIDI velocity clamp state. Used by the frontend
`useFixVelocity` hook on mount and on `presetVersion` bumps to mirror the
backend state into the UI.

Response `200`:
```json
{"enabled": false, "level": 64}
```

Response `400` if `Pianoid not initialized`.

Defaults at backend start: `{enabled: false, level: 64}` (mf). Defaults
restore on backend restart only — preset switches preserve the runtime
state per option B.

---

### `POST /set_runtime_parameters`

Updates volume and/or deck feedback coefficient while the engine is running.

Request body:
```json
{
  "volume": 80,
  "feedback": 64,
  "volume_center": 1000.0,
  "volume_range": 25.0
}
```

`volume`: integer 0–127 (MIDI range). Maps to amplitude coefficient using either the legacy formula `max_volume^(level/127)` (when `volume_center == 0`) or the per-session sensitivity formula `volume_center * volume_range^((level-64)/63)` (when `volume_center > 0`).

`feedback` auto-detection:
- `0.0` — silence (no deck coupling)
- `1`–`127` — MIDI-style exponential mapping: 64 → 1.0, 127 → 8.0, 1 → ~0.125
- Outside `1`–`127` (e.g. `2.5`) — used as direct coefficient

Valid coefficient range after mapping: `0.0`–`1000`.

`volume_center` (optional, float): coefficient at level 64. `0` selects the legacy `max_volume^(level/127)` formula. Non-zero enables the new sensitivity formula.

`volume_range` (optional, float): "sensitivity" multiplier. At level 127 the coefficient is `center*range`; at level 0 it is `center/range`. **Default = 10**, matching the C++ `RuntimeParameters` engine default in `Pianoid.cuh`. **Per-session only** — never persisted in preset JSONs, never carried across preset switches.

**Init-time seeding (P1 single-owner contract):** the engine boots in NEW-formula mode. `pianoid.init_pianoid` and `pianoid.switch_preset` both seed `volume_center = max_volume**(64/127)` (positive — engages the new formula) with `volume_range = 10`. This is required because the UI ToolBar `VolumeSlider` always sends a positive center once touched; without seeding, startup state is `center=0` (legacy) and the user perceives "much higher sensitivity" until they round-trip the slider. The seed value is anchored at level=64 so coefficient at level=64 is unchanged from the legacy formula — only the slope across other levels changes (legacy: `max_volume^(63/127)` ratio between levels 64 and 127; seeded: `range = 10`). The frontend mirrors this in `usePreset.loadPreset` (defense in depth — explicit `set_runtime_parameters` POST after preset load). Regression test: `tests/integration/test_volume_sensitivity_reset.py::test_initial_runtime_params_seeded_for_new_formula`. The legacy frontend `localStorage` key `volumeRange` is no longer read.

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
  "delay_ms": 0.0,
  "source": "midi"
}
```

`command` values:
- `144` + `velocity > 0` — NOTE_ON
- `128` or `144` + `velocity == 0` — NOTE_OFF
- `176`/`177`/`178` + `pitch == 64` — SUSTAIN pedal

`source` field (optional, dev-bv01 2026-05-03):
- `"midi"` — caller is a MIDI source (frontend WebMIDI hardware via `useMidi.handleMIDIMessage`, future MIDI-router integrations). Backend applies `Pianoid.apply_fix_velocity` to NOTE_ON velocity per the Fix-MIDI velocity clamp contract above.
- omitted / any other value — non-MIDI source (virtual piano click, space-bar, Excitation editor, calibration). Velocity passes through unchanged regardless of Fix-MIDI state.

**Cross-transport deduplication (dev-md01 2026-05-03).** The handler caches
the last `(mapped_d1, command)` it scheduled in a single shared module-global
key (`_last_play_cmd_key` in `backendServer.py`) protected by a thread lock.
A second call with the same `(mapped_d1, command)` is silently dropped (200
OK response, but no event is enqueued onto `RealTimeEventBuffer`). The dedup
state is shared between REST `/play` and WS `play` and is NOT keyed by
client SID, transport, source flag, or velocity — so a duplicate that
crosses transports (e.g. `usePreset.playNote` falling back from WS to REST
during a transient WS reconnect) or comes from a different WS client is
caught the same as a same-transport duplicate. Distinct events
(`NOTE_ON 60` then `NOTE_OFF 60`, or `NOTE_ON 60` then `NOTE_ON 61`) pass
through normally because their `(mapped_d1, command)` keys differ. Pre-fix
the dedup state was split into `_ws_last_command` (per-SID, WS only) +
`last_command` (module-global, REST only) which left a gap on cross-transport
and cross-SID duplicates — the user-visible "MIDI notes sound twice"
regression. Regression test:
`tests/system/test_play_dedup.py` (8 cases — same-transport, cross-transport
both directions, cross-SID, distinct-events sanity).

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

**Coexistence with the MIDI listener (dev-midi-play 2026-05-15).** `POST /play`
and WS `play` schedule notes **regardless of whether the unified MIDI listener
is running** (`listen_to_midi=1` / `POST /midi/start`). UI-originated play —
on-screen virtual piano, space-bar hotkey, Excitation editor, calibration —
and inbound hardware MIDI coexist: both routes converge on the thread-safe
`Pianoid.schedule_event(...)` → `RealTimeEventBuffer`, which serialises
concurrent producers (see [MIDI System](MIDI_SYSTEM.md)). There is no
exclusive-ownership lock between the two paths.

A legacy `if pianoid.listen` short-circuit used to drop every `/play` (and WS
`play`) request while the listener thread was alive — returning `200 OK` but
enqueueing nothing. It was a relic of the pre-unified `MidiListener` design
where the listener owned the engine exclusively; the W4 Phase 3 frontend MIDI
panel (which lets the user start the listener at runtime) exposed it as a
regression — the on-screen keyboard and space-bar fell silent whenever MIDI
listening was on. The gate was removed (CODE_QUALITY.md **P1**: the play
path's admission authority is the lifecycle state `PLAYBACK_ACTIVE`, enforced
inside `schedule_event` — not the unrelated listener flag). Regression test:
`tests/unit/test_play_listen_gate_regression.py`.

---

### `POST /play_mode/<mode_no>`

Triggers immediate playback of a specific resonance mode.

`mode_no`: integer mode index

Response `200`:
```json
{"Message": "OK"}
```

Response `416` if `mode_no` is not a valid integer.

> **Debug-build required.** The endpoint returns the mode-state record
> (`SOUND_REC_MODE_STATE`, record 1) which is populated only in debug builds
> (`PIANOID_BUILD_VARIANT=debug`); release builds return an empty array
> silently. See [DEBUG_DATA: Sound Records Buffer](../pianoid-cuda/DEBUG_DATA.md#sound-records-buffer).

---

### `POST /play_keyboard`

Plays the full keyboard as a NOTE_ON/NOTE_OFF sweep in either online (live driver) or offline (rendered WAV) mode. Online mode can optionally record the microphone while playing so room acoustics can be captured.

Request body:
```json
{
  "mode": "online",
  "speed_ms_per_note": 100,
  "velocity": 63,
  "capture_mic": false,
  "tail_ms": 2000,
  "pitches": null
}
```

- `mode`: `"online"` (default) schedules events through the live audio driver and returns immediately. `"offline"` stops the online engine, runs `runOfflinePlayback`, writes a peak-normalized 16-bit PCM synth WAV to `/tmp/keyboard_offline_<timestamp>.wav`, then restarts the engine.
- `speed_ms_per_note`: NOTE_ON to NOTE_OFF duration per key (also the per-step advance). Clamped to 10–2000 ms.
- `velocity`: MIDI velocity 1–127, default 63 (mf).
- `pitches`: optional explicit list; omit for all available pitches.
- `capture_mic` (online only, default `false`): when `true`, the server calls `startMicCapture` before scheduling events, sleeps synchronously for `speed_ms_per_note * num_pitches + tail_ms`, then calls `stopMicCapture` and writes an un-normalized 16-bit PCM mic WAV to `/tmp/keyboard_mic_<timestamp>.wav`. Requires an active audio driver with a selected input device — set via `POST /set_mic_device` if needed.
- `tail_ms` (online, `capture_mic` only): extra capture time after the last NOTE_OFF to catch decay. Clamped to 0–10000 ms, default 2000.

Online response (no mic): scheduled event count + nominal duration, returns immediately.
Online response (with mic): adds `mic_wav_path`, `mic_sample_rate`, `mic_samples`, `mic_peak`, `mic_rms`, `mic_nonzero_fraction`. Blocks until capture finishes.
Offline response: `wav_path`, `audio_data`, `audio_samples`, `cycles_rendered`, `peak`, `rms`, `peak_normalized_scale`.

- `audio_data`: the rendered WAV as a **list of one base64 string** — same shape as `POST /get_chart_test` (`["<base64 WAV string>"]`). It is the base64 of the bytes just written to `wav_path` (a complete RIFF/16-bit-PCM file), so the browser can decode and play it directly (`atob` → `Uint8Array` → `Blob({type:'audio/wav'})`) without reaching the server-side `wav_path`. The frontend "Play All" offline sweep (`PianoidTuner.js` `startSweep`) consumes `audio_data[0]`. `wav_path` is retained for server-side debugging.

Response `400` for invalid params or empty pitch list. Response `417` if pianoid is in exception state.

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

### `GET /midi/ports`

Returns the list of available rtmidi input ports as observed at the moment of the call. Stateless — works even before `/load_preset` has initialized a `pianoid` instance, because the implementation opens a transient `rtmidi.MidiIn()` to read the port table.

Use this to populate a port-picker UI before posting `listen_to_midi=1` to `/load_preset` or before calling `POST /midi/select_port`.

Response `200`:
```json
{
  "ports": ["VMini 0", "MIDIIN2 (VMini) 1"],
  "active_port": 0,
  "listening": true
}
```

- `ports`: ordered list of rtmidi port names; the array index is the canonical port id used by `midi_port` (in `/load_preset`) and by `POST /midi/select_port`.
- `active_port`: the port currently held open by the unified MIDI listener, or `null` when the listener is not running.
- `listening`: `true` when the unified listener thread is alive (i.e. `/load_preset` was called with `listen_to_midi=1`).

Response `500`:
```json
{"error": "MidiPortsFailed", "message": "<rtmidi exception text>"}
```

---

### `POST /midi/select_port`

Switches the running unified MIDI listener to a different rtmidi input port without stopping or restarting the listener thread. The listener loop closes the previously-opened port and opens the new one at the start of its next iteration (typically within ~10 ms), preserving cycle-aligned dispatch for any in-flight `schedule_event` calls.

Request body:
```json
{"port": 1}
```

- `port` (int, required): 0-based rtmidi input-port index from `GET /midi/ports`.

Response `200`:
```json
{"port": 1, "name": "MIDIIN2 (VMini) 1"}
```

Response `400` — bad request body:
```json
{"error": "BadRequest", "message": "Missing or non-integer \"port\" field."}
```

Response `400` — out of range:
```json
{
  "error": "PortOutOfRange",
  "message": "Port 9 not in range 0..1",
  "ports": ["VMini 0", "MIDIIN2 (VMini) 1"]
}
```

Response `400` — no MIDI hardware:
```json
{"error": "NoMidiPorts", "message": "No MIDI input ports available"}
```

Response `409` — listener not running:
```json
{
  "error": "ListenerNotRunning",
  "message": "Unified MIDI listener is not running. Pass listen_to_midi=1 to /load_preset."
}
```

---

### `POST /midi/start`

Start the unified MIDI listener at runtime without re-issuing `/load_preset` (W3 Phase 2). Idempotent — if the listener is already running, returns the current state without restarting (no double-open of the rtmidi port).

Request body (all fields optional):
```json
{"port": 0}
```

- `port` (int, default `0`): 0-based rtmidi input-port index to open. Use `GET /midi/ports` to enumerate available ports. Out-of-range ports are rejected with 400.

Response 200 — listener now running (or already was):
```json
{
  "listening": true,
  "active_port": 0,
  "ports": ["VMini 0", "MIDIIN2 (VMini) 1"]
}
```

Response 400 — preset not loaded:
```json
{"error": "PianoidNotInitialized"}
```

Response 400 — no MIDI hardware:
```json
{"error": "NoMidiPorts", "message": "No MIDI input ports available"}
```

Response 400 — port out of range:
```json
{
  "error": "PortOutOfRange",
  "message": "Port 5 not in range 0..1",
  "ports": ["VMini 0", "MIDIIN2 (VMini) 1"]
}
```

Response 500 — listener start failed (rtmidi exception, thread creation failure, etc.):
```json
{"error": "MidiStartFailed", "message": "<exception text>"}
```

Response 400 — port acquisition failed asynchronously (W4 Phase 3 fix D):
```json
{
  "error": "PortOpenFailed",
  "message": "Failed to acquire MIDI port; another process may hold it.",
  "port": 0
}
```

The listener thread opens the rtmidi port inside `MIDI_listener_unified` (async, not in the request handler). If the port is held by another process (a Werkzeug debug-reloader sibling, a stale backend, or any other MIDI consumer), rtmidi raises and the thread bails. The handler sleeps 50 ms then re-reads `_midi_active_port` — if still `None` and `self.listen` has flipped back to False (fix C), the open failed and 400 is returned instead of falsely-true 200.

---

### `POST /midi/stop`

Stop the unified MIDI listener at runtime without tearing down the synthesis engine (W3 Phase 2). Idempotent — if no listener is running, returns the current state without raising. Internally calls `Pianoid.stop_midi_listener()`, which sets `self.listen = False` and joins the listener thread with a 1 s timeout; the rtmidi port is released cleanly on loop exit.

Request body: empty `{}` accepted.

Response 200 — listener stopped (or already was):
```json
{
  "listening": false,
  "active_port": null,
  "ports": ["VMini 0", "MIDIIN2 (VMini) 1"]
}
```

Response 400 — preset not loaded:
```json
{"error": "PianoidNotInitialized"}
```

Response 500 — stop failed:
```json
{"error": "MidiStopFailed", "message": "<exception text>"}
```

---

### `GET /midi/broadcast`

Return the current state of the W4 Phase 3 broadcast gate. The gate controls whether the unified MIDI listener's per-event emit callback forwards `midi_note_event` Socket.IO messages to clients. Default is `true` on every fresh `Pianoid` init (matches the W3 Phase 2 default). Independent of the listener-running state — the gate is still readable when the listener is stopped (in which case no events flow anyway).

Response 200:
```json
{"enabled": true}
```

Response 400 — preset not loaded:
```json
{"error": "PianoidNotInitialized"}
```

---

### `POST /midi/broadcast`

Toggle the W4 Phase 3 broadcast gate. The toggle takes effect on the very next inbound MIDI byte — the listener thread is not stopped, restarted, or otherwise touched. Useful for suppressing the per-event Socket.IO stream during calibration runs, heavy-load synthesis tests, or any other workload where the `midi_note_event` chatter is undesirable.

Request body:
```json
{"enabled": false}
```

- `enabled` (bool, required): truthy enables broadcast (default on every fresh init); falsy suppresses the stream.

Response 200:
```json
{"enabled": false}
```

Response 400 — preset not loaded:
```json
{"error": "PianoidNotInitialized"}
```

Response 400 — missing field:
```json
{"error": "BadRequest", "message": "Missing \"enabled\" field."}
```

---

### Socket.IO `midi_note_event` (server -> client)

Pushed by the unified MIDI listener thread for every observed inbound MIDI byte that survives the two filters in `emit_midi_note_event` (W4 Phase 3). Wired in `backendServer.py` via the helper that is constructor-injected into the `Pianoid` instance per W1 Phase 0 decision A2.

Two filters apply on every invocation:

1. **Note-only filter.** Only NOTE_OFF (status `128`-`143`, channels 0-15) and NOTE_ON (status `144`-`159`, channels 0-15) are forwarded. CC (including sustain CC#64), program-change, pitch-wheel, aftertouch, and sysex are silently dropped — they have no place on a "last note pressed" indicator stream. (Sustain still drives synthesis via `schedule_event(...)`; the drop is on the emit path only.)
2. **Broadcast on/off gate.** When `GET /midi/broadcast` reports `{"enabled": false}`, no emit happens. The gate is per-event (read live from the running `pianoid` instance), so toggling via `POST /midi/broadcast` takes effect on the very next inbound byte.

Payload (when both filters pass):
```json
{"command": 144, "pitch": 60, "velocity": 100}
```

- `command`: raw MIDI status byte in `128`..`159` (NOTE_OFF / NOTE_ON, channels 0-15).
- `pitch`: MIDI data1 (pitch).
- `velocity`: MIDI data2 (velocity; `0` on NOTE_ON encodes the running-status NOTE_OFF convention used by some hardware).

Start the listener with `listen_to_midi=1` on `/load_preset` (W3 Phase 2 default) or `POST /midi/start` (runtime). Stop the chatter without stopping synthesis via `POST /midi/broadcast {"enabled": false}` (W4 Phase 3).

---

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

The preset library follows the **working-copy model** (2026-05-18). Every
library entry has a **kind**: `original` (a read-only snapshot of an on-disk
preset) or `working` (an editable copy spawned from an original). Parameter
edits are rejected while an `original` is active — see the `preset_read_only`
409 below. See [DATA_FLOWS.md §2.8 "Working-Copy Model"](../../architecture/DATA_FLOWS.md).

### `GET /preset/list`

Returns the preset library entry records and the active preset name. Requires
a loaded pianoid instance.

Response `200`:
```json
{
  "presets": [
    { "name": "Steinway",            "kind": "original", "source": "Steinway", "path": "presets/Steinway.json" },
    { "name": "Steinway (working 1)", "kind": "working",  "source": "Steinway", "path": null }
  ],
  "active": "Steinway (working 1)"
}
```

Each record: `name`, `kind` (`original`|`working`), `source` (the originating
original's name; an original's `source` is itself), `path` (on-disk JSON path
for originals, `null` for working copies).

Response `400` if pianoid not initialized.

---

### `POST /preset/load`

Loads a preset JSON file into the GPU preset library as a read-only `original`
entry, without activating it.

Request body:
```json
{ "path": "presets/Steinway_256modes.json", "name": "Steinway" }
```

- `path`: path to preset JSON file (relative to middleware working directory)
- `name`: unique identifier for this preset in the library

Response `200`: `{ "message": "...", "presets": [<records>] }`

Response `400` if `path` or `name` missing.
Response `500` if preset already exists in library or file not found.

---

### `POST /preset/switch`

Switches the active synthesis parameters to a named preset from the GPU
library. Double-buffered atomic swap — playback continues without glitches.

Switching away from a `working` copy first saves its live edits back to its
slot; switching away from an `original` never writes back (originals stay
pristine). Volume / feedback / volume-sensitivity are global library-wide and
are preserved across the switch.

Request body: `{ "name": "Steinway (working 1)" }`

Response `200`: `{ "message": "...", "active": "<name>" }`

Response `400` if `name` missing.
Response `500` if preset not found in library.

**Note:** uses `async_switch=False` (synchronous).

---

### `POST /preset/spawn_working_copy`

Spawns a new editable `working` copy from an existing library entry. The copy
duplicates the source's *current* state (live edits included) and is
auto-labelled `<original> (working N)`.

Request body: `{ "source": "Steinway" }`

Response `200`:
```json
{
  "message": "Spawned working copy Steinway (working 2)",
  "name": "Steinway (working 2)",
  "presets": [<records>],
  "active": "<active name>"
}
```

Response `400` if `source` missing.
Response `409` (`PresetLibraryError`) if `source` is not a library entry.

---

### `POST /preset/promote`

Promotes a `working` copy: atomically overwrites its source original's on-disk
JSON file with the working copy's current model (permanent — survives restart),
then refreshes the in-memory original. **Destructive** — overwrites a file on
disk; the frontend confirms before calling this.

Request body: `{ "name": "Steinway (working 2)" }`

Response `200`: `{ "message": "...", "original": "Steinway", "presets": [<records>] }`

Response `400` if `name` missing.
Response `409` (`PresetLibraryError`) if `name` is not a working copy, or its
original has no on-disk path.

---

### `POST /preset/unload`

Removes a preset from the GPU library. Any entry — including the boot preset —
is unloadable as long as at least one preset remains loaded. When the unloaded
entry is active, the engine switches to a replacement first; when an `original`
is left with no working copies, a fresh one is auto-spawned.

Request body: `{ "name": "Steinway (working 1)" }`

Response `200`: `{ "message": "...", "presets": [<records>], "active": "<active name>" }`

Response `400` if `name` missing.
Response `409` (`PresetLibraryError`) if this would unload the last preset.

---

### Read-only enforcement — `preset_read_only` 409

Parameter-edit endpoints (`POST /set_parameter/*`, `POST /set_string_excitation/*`,
`POST /set_hammer_shape/*`, `POST /set_mode_parameters`) reject writes while a
read-only `original` is the active preset. The orchestrator guard
`Pianoid._assert_active_editable()` raises `PresetReadOnlyError`, which the
dedicated error handler maps to:

```
HTTP 409
{ "error": "PresetReadOnlyError",
  "message": "Preset '<name>' is read-only. Spawn a working copy to edit.",
  "code": "preset_read_only" }
```

The matching WebSocket handlers emit an `error` event with
`code: "preset_read_only"`. Runtime-parameter writes (`/set_runtime_parameters`
— volume / feedback) are **exempt**: they are global, not preset-block edits.

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

Two-phase process per pitch: noise floor lift (boost until signal above noise), then direct linear correction (1-2 measurements using RMS = K * excitation linearity, with bisection fallback). Poll progress via `GET /calibration_status`.

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

Adjusts the excitation volume coefficient for a single pitch to match the target dB using direct linear correction (1-2 measurements). Falls back to bisection search if direct correction overshoots. Blocking -- returns when tuning completes.

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
  "iterations": 2,
  "converged": true,
  "coefficient": 1.234,
  "method": "direct"
}
```

`method` values: `direct` (converged via linear correction), `direct_noop` (already at target), `direct_no_verify` (small correction, skipped verification), `bisection_fallback_zero` / `bisection_fallback_clip` / `bisection_fallback_overshoot` (fell back to bisection).

Response `200` (did not converge):
```json
{
  "rms": 0.0195,
  "db": -34.2,
  "iterations": 5,
  "converged": false,
  "coefficient": 1.456,
  "method": "bisection_fallback_overshoot"
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
  },
  "step": "calibrate_synthesis",
  "message": "Synthesis cal: pitch 57 (10/84)",
  "clipping_pass": false
}
```

- `step`: name of the current pipeline step (e.g. `calibrate_synthesis`, `calibrate_acoustic`). `null` before the first progress emission.
- `message`: human-readable progress message for the current step.
- `clipping_pass`: `true` while `calibrate_synthesis` is running its **second sweep**. The synthesis step is single-pass, but when it detects that pitches would clip it reduces the target level and re-runs every pitch — so `progress` legitimately restarts `0.0 → 1.0` a second time. The frontend uses this flag to label the rerun ("Pass 2/2: clipping correction") instead of showing what looks like an unexplained restart. Reset to `false` at the start of each calibration and once the step completes.

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

### Error Status Codes

All `/modal/*` endpoints return JSON error responses `{"error": "<message>"}` with the following status classification (F18, W4-A):

| Status | Mapped from | When |
|--------|-------------|------|
| `400` | `ValueError`, `TypeError`, `KeyError` | Bad request payload (malformed JSON, missing/invalid keys, schema mismatch) |
| `404` | `FileNotFoundError` | A resource (project, measurement file, export) does not exist |
| `409` | `RuntimeError` | Server state conflict — no project open, ModalAdapter not initialized, pipeline in wrong stage |
| `503` | `ModalAdapterOnlyError` | The requested route is main-server-only (port 5000) and was hit on the modal-adapter server (port 5001) |
| `500` | Any other exception | Unexpected server bug — logged with traceback |

Routes may still return explicit codes (e.g. export endpoints return `404` for "not found" inside the happy path); the automatic classification applies to uncaught exceptions routed through `_error()`.

### Server Role & Cross-Process Routes

Routes that mutate the running synthesis engine (`POST /modal/apply_to_preset`) require a live `Pianoid` instance and therefore only work when served by the **main** backend (port 5000). When served by the standalone **modal adapter** server (port 5001), these routes respond `503` with message `"This route only runs on the main server at port 5000 ..."` (F9, W4-A). Each server advertises its role via the Flask `app.config['role']` attribute (`'main'` / `'modal_adapter_server'`).

The main backend provides its own `POST /modal/apply_to_preset` route (defined in `backendServer.py`, not via the blueprint) — it rehydrates a fresh `ModalAdapter` instance from the project directory on disk and applies to the local `pianoid`. The frontend (`useModalAdapter.applyToPreset`) posts directly to port 5000 for this route while all other `/modal/*` calls target port 5001. See the `POST /modal/apply_to_preset` entry under Stage 7 below for the main-server payload shape.

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

#### `GET /modal/defaults`

Returns pipeline defaults shared between backend and frontend (F16, W4-A). Replaces hardcoded duplicates (`bridge_boundary=28`, `pitch_offset=21`) in both layers with a single source of truth derived from `MappingConfig` dataclass defaults and `DEFAULT_ESPRIT_PARAMS`.

The frontend (`useModalAdapter.js`) fetches this endpoint once on mount and uses the values as initial `bridgeBoundary` / `pitchOffset` / `trackingParams` state. Hardcoded fallbacks remain in the frontend as a first-render guard when the modal adapter server is not yet reachable.

Response `200`:
```json
{
  "bridge_boundary": 28,
  "pitch_offset": 21,
  "tracking_params_default": {
    "bridge_boundary": 28,
    "freq_tol_pct": 0.02,
    "max_gap": 3,
    "tracking_method": "nuclei_merge"
  },
  "esprit_config_default": {
    "band_preset": "extended_8band",
    "mac_threshold": 0.9,
    "freq_tol_pct": 0.01,
    "use_gpu": true,
    "use_tls": true,
    "max_damping": 0.2,
    "window_length": 2000
  }
}
```

`bridge_boundary` and `pitch_offset` are top-level aliases into `tracking_params_default` (kept flat for the most common frontend consumers).

`tracking_method` is mirrored from the backend `TrackingConfig` dataclass default — currently `"nuclei_merge"` (since dev-d773, 2026-05-05). The frontend `useModalAdapter.js` overlays this onto its hardcoded `DEFAULT_TRACKING_PARAMS` on mount so a future flip of the backend default propagates without a frontend code change.

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

#### `GET /modal/project_state`

Returns complete project state in a single response. Combines project metadata, data availability flags, all configuration, and applied status. Designed to replace multiple individual GET calls from the frontend.

Response `200`:
```json
{
  "project_name": "belarus_78",
  "project_dir": "D:\\modal_projects\\belarus_78",
  "projects_base": "D:\\modal_projects",
  "measurement_info": {
    "num_scenarios": 78,
    "num_channels": 5,
    "sample_rate": 48000.0,
    "scenario_indices": [0, 1, 2, "..."]
  },
  "data_status": {
    "measurements": true,
    "mapping": true,
    "esprit": true,
    "tracking": true,
    "feedin": true,
    "applied": false
  },
  "mapping_config": {
    "channel_roles": {"0": "force", "1": "response", "...": "..."},
    "bridge_boundary": 28,
    "pitch_offset": 21,
    "excitation_to_pitch": {"0": 21, "1": 22, "...": "..."},
    "skipped_channels": []
  },
  "channel_mapping": {"0": 0, "1": 1},
  "esprit_config": {
    "preset": "extended_8band",
    "bands": ["..."],
    "use_gpu": true,
    "use_tls": true,
    "max_damping": 0.2
  },
  "tracking_params": {
    "freq_tol_pct": 0.02,
    "max_gap": 3
  },
  "applied": false
}
```

Fields are `null` when data is not available (e.g., `measurement_info` is `null` before loading measurements, `tracking_params` is `null` before running tracking). `mapping_config` contains channel roles, bridge geometry, and the response-channel-to-sound-output mapping (`channel_to_sound`). The top-level `channel_mapping` field is a convenience view onto `mapping_config.channel_to_sound` (same data, flat dict) — kept for backward compatibility. On-disk storage is `modal_adapter/mapping/mapping_config.json` only; legacy projects with a standalone `channel_mapping.json` are auto-migrated into `mapping_config.json` on `open_project`. Old projects without `tracking/config.json` or `output/applied.json` get default values (`null` and `false`).

---

#### `POST /modal/run_pipeline`

Runs the full extraction pipeline (load → mapping → ESPRIT → tracking → feedin) in a background thread. Returns immediately with a task ID. Poll progress via `GET /modal/status`.

Payload key names match the frontend exactly — `esprit_config` and `tracking_params` (not the legacy `esprit_params` / `tracking` names). Sending the old keys is silently ignored and the pipeline runs with defaults.

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
  "esprit_config": {"band_preset": "extended_8band"},
  "tracking_params": {"bridge_boundary": 28, "freq_tol_pct": 0.02, "max_gap": 3},
  "response_channels": [0, 1],
  "feedin_method": "mode_shape"
}
```

All fields are optional. Two guards protect against silent data loss when re-running the pipeline on an already-open project:

- **Measurements reuse.** If `folder_path` is omitted or matches the currently-loaded source folder, `load_folder` is skipped — the existing `_measurements`, `_mapping`, `_results`, and `_applied` state is preserved.
- **Mapping preservation.** If `mapping` is omitted AND the adapter already has a mapping loaded, the existing `_mapping` is reused. If the adapter has no mapping and `mapping` is absent, the pipeline errors immediately with `"mapping required when adapter has no existing mapping loaded"`.

Response `200`:
```json
{"task_id": "modal_pipeline"}
```

Response `409` if ModalAdapter not initialized or pipeline is in a conflicting state (see Error Status Codes table above).

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

#### `POST /modal/esprit_config`

Persist ESPRIT configuration to the project's `esprit/config.json`. This is the user's intended config, independent of whether ESPRIT has been run. Saved config is returned by `data_status` and used as defaults when running ESPRIT.

Request body: same shape as `espritConfig` in the frontend.

#### `GET /modal/esprit_config`

Load saved ESPRIT configuration from `esprit/config.json` (single source of truth). Returns `{}` if no config has been saved. Never falls back to `esprit/metadata.json` — that file holds run provenance only (`scenario_count`, `scenario_indices`, `run_at`). A successful ESPRIT run overwrites `config.json` with the params actually used so the on-disk results and saved config never diverge. Legacy projects with `params` embedded in `metadata.json` are migrated to `config.json` automatically on `open_project`.

#### `GET /modal/gpu_status`

Check CuPy GPU availability.

Response `200`:
```json
{ "gpu_available": true, "gpu_name": "NVIDIA GeForce RTX 3080" }
```

#### `GET /modal/band_presets`

Return available band preset configurations (standard_4band, extended_8band) with per-band parameters.

**dev-esrt Phase 3 (2026-05-06):** the response also includes user-saved
named presets loaded from `<projects_base>/.user_band_presets.json`
(see `POST /modal/band_presets/save` below). User presets are merged
into the same flat `{name: [<band dicts>]}` dict as built-ins, plus a
top-level sentinel field `_user_preset_names: [<name>, ...]` so the
frontend can identify user-saved entries (for italics + delete
affordance) without a hardcoded built-in list. The leading underscore
signals "metadata, not a preset entry" — frontend iterators must skip
this key when listing dropdown options.

Per-band fields per entry: `name`, `f_min`, `f_max`, `filter_order`,
`decimation`, `exp_factor`, `model_order`, `window_length`,
`ir_length_ms`, `skip_start_ms`, `start_fade_ms`, `end_fade_ms`. See
[`MODAL_ADAPTER_GUIDE.md` § Per-band fade-in and tail fade-out](../../guides/MODAL_ADAPTER_GUIDE.md#per-band-fade-in-and-tail-fade-out)
for the per-field semantics.

#### `POST /modal/band_presets/save`

dev-esrt Phase 3 (2026-05-06). Save the supplied bands as a named user
preset (cross-project; reusable from any project under the same
`projects_base`).

Request body:
```json
{ "name": "MyBass", "bands": [<band dict>, <band dict>, ...] }
```

The `name` is validated and canonicalised:
- Stripped of leading/trailing whitespace.
- Non-empty after stripping.
- Length ≤ 64 characters.
- Not in the reserved set `{standard_4band, extended_8band, custom}`.
- Free of control / format / unassigned characters (Unicode categories
  `Cc` / `Cf` / `Cn`).

Bands list must be a non-empty list of dicts with the standard band
field shape (same as the entries returned by `GET /modal/band_presets`).

**Idempotent**: a name collision overwrites silently. The frontend
layers a confirm-replace dialog on top for UX, but the backend stays
idempotent so retries / parallel saves don't surprise.

Storage: written atomically to
`<projects_base>/.user_band_presets.json` via temp-file + `os.replace`.

Response `200`:
```json
{ "message": "saved", "name": "MyBass" }
```

Response `400` on invalid name or empty bands list:
```json
{ "error": "Preset name 'extended_8band' is reserved by the built-in preset registry. Reserved names: ['custom', 'extended_8band', 'standard_4band']." }
```

#### `DELETE /modal/band_presets/<path:name>`

dev-esrt Phase 3 (2026-05-06). Remove a named user preset. The name
is stripped of leading/trailing whitespace before lookup. Built-in
presets cannot be deleted (the user file does not contain them — DELETE
on a built-in name returns 404, the same as DELETE on any non-existent
name). Atomically rewrites the user presets file via temp-file +
`os.replace`.

Response `200`:
```json
{ "message": "deleted", "name": "MyBass" }
```

Response `404` when not found:
```json
{ "error": "preset 'Nonexistent' not found" }
```

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
  "max_gap": 3,
  "tracking_method": "nuclei_merge",
  "tracking_options": {}
}
```

`tracking_method` (optional) — one of `"nuclei_merge"` (default since dev-d773, 2026-05-05), `"sliding_window"` (legacy), or `"sequential"` (DEPRECATED). When omitted, the backend uses the `TrackingConfig` dataclass default. The frontend always sends an explicit value to avoid divergence between the dropdown selection and the backend's effective method (dev-nucl-default, 2026-05-07).

`tracking_options` (optional) — dict of overrides applied to `TrackingConfig` fields by name (e.g. `{"nm_nucleus_mac_threshold": 0.7}`). Unknown keys are ignored with a backend log warning.

Response `200`: tracked chains with stability classification and summary. Includes `nuclei_stage_chains` (Stage-1 nucleus snapshot) when `tracking_method == "nuclei_merge"` — empty list otherwise.

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

### Stage 5b: FRF + Q Cross-check (dev-frf-q-phase01, Phase 0 + Phase 1)

The FRF (Frequency Response Function) stage was added in 2026-05-24 as
the first half of the Modal Mass + Q-factor improvement plan. It
promotes the calibration / force channel from "alignment timing" to
the input `X(f)` in a proper spectral-domain `H(f) = Y(f) / X(f)`
using the clean H1 estimator on raw per-cycle data.

See [`docs/proposals/modal-mass-q-factor-IMPROVEMENT-PLAN-2026-05-24.md`](../../proposals/modal-mass-q-factor-IMPROVEMENT-PLAN-2026-05-24.md)
for the full design rationale.

**Hammer-impact force window (user Q5 directive).** The force/calibration
sensor is mounted on the hammer itself (not co-located with response
sensors), so the recorded force signal contains the main impact peak
PLUS post-impact hammer bounce + recoil + ringdown. Only the main
impulse represents true input force into the structure. Before FFT,
the force is windowed to `[peak - W_pre, peak + W_post]` (default
0.5 ms + 4.5 ms = 5 ms total centred on the negative-peak impact).
Defaults are tunable per project via the `config` body field on
`POST /modal/run_frf`.

#### `POST /modal/run_frf`

Compute FRF for the requested scenarios (synchronous; per-scenario
~tens-of-ms). Bypasses `normalize_by_calibration` and works directly
on `raw_recordings/raw_*_chN.npy` so the H1 estimator is not
double-normalised (see proposal §4.2).

Request body:
```json
{
  "scenario_indices": [100, 101, 102],
  "config": {
    "force_window_pre_ms": 0.5,
    "force_window_post_ms": 4.5
  }
}
```

Both fields are optional — `scenario_indices=null` processes every
loaded scenario; `config` falls back to the module defaults.

Response `200`: same shape as `GET /modal/frf/summary`.

---

#### `GET /modal/frf/summary`

Return the project-level FRF index. Lightweight — no heavy arrays.
Safe to call before any FRF run (`available: false` then).

Response `200` (after a run):
```json
{
  "available": true,
  "stale": false,
  "computed_at": "2026-05-24T11:49:20.459820+00:00",
  "scenario_count": 1,
  "config": {
    "force_window_pre_ms": 0.5,
    "force_window_post_ms": 4.5,
    "calibration_channel": 0,
    "response_channels": [1, 2, 3, 4, 5, 6, 7]
  },
  "scenarios": [
    { "scenario_index": 100, "has_npz": true }
  ]
}
```

`stale=true` when an ESPRIT re-run or scenario re-load happened
since the last FRF run; the frontend renders a "FRF needs re-run"
badge in that state (Q8 dirty-flag flow).

---

#### `GET /modal/frf/scenario/<int:scenario_idx>`

Return one scenario's FRF arrays serialised as plain JSON lists for
the frontend. Reads back the persisted
`<project>/modal_adapter/frf/scenario_<N>.npz`.

Response `200`:
```json
{
  "scenario_index": 100,
  "frequencies": [0.0, 1.0, 2.0, "..."],
  "n_cycles_used": 120,
  "force_window": {
    "peak_sample_median": 0.0,
    "w_pre_ms": 0.5,
    "w_post_ms": 4.5
  },
  "channels": {
    "ch1": {
      "channel": 1,
      "magnitude_db": ["..."],
      "magnitude_abs": ["..."],
      "phase_deg": ["..."],
      "coherence": ["..."]
    }
  }
}
```

Coherence `γ²(f) = |G_xy|² / (G_xx · G_yy) ∈ [0, 1]` is a per-frequency
quality metric — values close to 1 mean the FRF estimate is
trustworthy at that bin, values << 1 mean the response is dominated
by input-uncorrelated noise. The frontend can gray-out / hatch
regions where coherence < 0.7.

Returns `404` if the scenario has no persisted FRF.

---

#### `DELETE /modal/frf`

Invalidate FRF for the current project: remove persisted
`frf/scenario_*.npz` + `frf/index.json` and clear the in-memory cache.
Drives the Q8 user-opt-in dirty-flag flow.

Response `200`:
```json
{
  "message": "Invalidated FRF: removed 5 files",
  "deleted_files": ["scenario_100.npz", "index.json", "..."]
}
```

---

#### `POST /modal/qc/log_decrement`

Run the Hilbert log-decrement Q cross-check against the current
tracked chains (Phase 0c). Bandpass-filters the averaged IR around
each chain's mode frequency, computes the Hilbert envelope, fits
the slope of `log(envelope)` to recover `ζ = -slope / ω_n`, and
compares `Q_logdec = 1/(2ζ)` against ESPRIT's `Q_esprit` per chain.

Request body (optional):
```json
{
  "disagreement_threshold": 0.30
}
```

`disagreement_threshold` is the relative tolerance
`|Q_logdec - Q_esprit| / Q_esprit` above which the chain is flagged
as suspicious (default 0.30 = 30%).

Response `200`:
```json
{
  "computed_at": "2026-05-24T...",
  "disagreement_threshold": 0.30,
  "chain_count": 42,
  "per_chain": {
    "0": {
      "chain_id": 0,
      "frequency_hz": 200.05,
      "Q_esprit": 100.0,
      "Q_logdec": 102.4,
      "disagreement_ratio": 0.024,
      "disagreement_flag": false,
      "reason": "ok",
      "samples_used": 4759
    }
  }
}
```

`reason` is one of: `"ok"`, `"no_damping"`, `"out_of_band"`,
`"insufficient_samples"`, `"fit_failed"`, `"bad_envelope"`,
`"no_measurements"`.

Persisted to `<project>/modal_adapter/qc/log_decrement.json`.

---

#### `GET /modal/qc/log_decrement`

Return the persisted log-decrement cross-check payload (or
`{"available": false, "per_chain": {}}` when no cross-check has run).

---

### Stage 5c: Modal Mass extraction (dev-modal-mass-p2, Phase 2)

The Modal Mass stage was added in 2026-05-24 as the second half of the
Modal Mass + Q-factor improvement plan. It consumes the FRF output of
Stage 5b plus the tracked-chain set from Stage 4 to extract per-mode
relative modal mass + mass-normalised mode shapes.

See [`docs/proposals/modal-mass-q-factor-IMPROVEMENT-PLAN-2026-05-24.md`](../../proposals/modal-mass-q-factor-IMPROVEMENT-PLAN-2026-05-24.md)
§5.2.1 + §5.2.3 + §6 Phase 2 for the design.

**Pipeline.** Per tracked chain `n`:

1. Detect MDOF clusters by frequency proximity (user decision C —
   `|f_i - f_j| < 3 · max(BW_i, BW_j)`, cluster cap = 4 modes; chains
   beyond the cap get `fit_method = "low_density_unresolved"`).
2. For each `(scenario_i, response_channel_c)` in the chain's
   `detections`, run the SDOF Kennedy-Pancu circle-fit (singleton
   cluster) or the MDOF RFP joint LS fit (cluster of 2-4) on the
   persisted FRF `H1_ch<c>` in the band `f_n ± 3·ζ_n·f_n`. Returns
   `R_n^{i,c}` (complex) + `fit_quality ∈ [0, 1]`.
3. Build the residue tensor `R[n, a, s]` where `a` is the
   populated-grid-cell index (0..A-1, per
   `MappingConfig.point_coordinates`) and `s` is the response-channel
   axis. Missing `(actuator, channel)` entries are NaN.
4. Per chain, invert the rank-1 residue matrix via SVD under the
   **dual-unit-max convention** (`max|φ_a| = max|φ_s| = 1`): the
   leftover scale equals `1/m_n` at the joint peak by the physics, so
   `m_n = 1 / (σ_0 · max|u_0| · max|v_0|)`.
5. Reference-mode selection (user decision B): lowest-freq chain with
   `fit_quality_overall > 0.7 AND coverage >= 0.5`. Fallback: refuse
   to normalise, emit `reference_mode_warning`, raw `m_absolute` still
   stored per chain.

**Q6 gate (user decision E):** `POST /modal/run_modal_mass` requires
≥ 8 scenarios with FRF persisted; otherwise returns `422` with
`InsufficientDataError`. `GET /modal/modal_mass/summary` is
unconstrained — returns whatever was last persisted regardless of
the current scenario count.

**Units note (relative only per Q2).** H1 from Stage 5b is in
dimensionless `response_voltage / force_voltage` (raw ADC, no sensor
calibration applied). The recovered `m_n` is in
"internally-consistent voltage-ratio units" — NOT kg. The
user-meaningful output is `m_relative = m_n / m_ref`. Absolute SI
calibration is deferred per proposal §5.5.1.

#### `POST /modal/run_modal_mass`

Run the modal-mass extraction across all tracked chains. Synchronous
(per-chain fit is bounded — dozens of chains finish in a few seconds
total). Reads FRF NPZ files on disk; writes per-chain JSON +
`modal_mass/index.json`.

Request body: none (empty `{}`).

Response `200`: same shape as `GET /modal/modal_mass/summary`.

Response `422` (Q6 gate trips):
```json
{
  "error": "Modal mass requires ≥ 8 scenarios with FRF persisted; have 3. Run FRF on more scenarios first."
}
```

Other errors (`400`):

- `"No tracked chains"` — run ESPRIT + tracking first
- `"Modal mass requires a grid-layout mapping"` — line-layout project
- `"Mapping has no response channels"` — set channel roles first

---

#### `GET /modal/modal_mass/summary`

Return the project-level modal-mass summary (light meta only — no
shape arrays). Safe to call before any modal-mass run
(`available: false` then). Unconstrained by Q6 gate per user
decision E.

Response `200` (after a run):
```json
{
  "available": true,
  "stale": false,
  "computed_at": "2026-05-24T12:34:56.789012+00:00",
  "chain_count": 42,
  "scenario_count": 12,
  "reference_mode_chain_id": 4,
  "reference_mode_warning": null,
  "config": {
    "min_scenarios_for_modal_mass": 8,
    "ref_mode_fit_quality_min": 0.7,
    "ref_mode_coverage_min": 0.5,
    "mdof_cluster_cap": 4,
    "cluster_bw_mult": 3.0,
    "response_channels": [1, 2, 3, 4, 5, 6, 7],
    "actuator_count": 12
  },
  "chains": [
    {
      "chain_id": 4,
      "frequency_hz": 42.2,
      "fit_method": "mdof",
      "m_absolute": 8.87e-6,
      "m_relative": 1.0,
      "fit_quality_overall": 0.77,
      "is_reference_mode": true,
      "mass_inversion_status": "valid",
      "has_file": true
    }
  ]
}
```

`stale=true` when FRF, ESPRIT, or scenarios re-ran since the last
modal-mass run; the frontend renders a "STALE" badge on the Modal
Mass tab.

`mass_inversion_status` (dev-mstat-30b6 2026-05-26) explains the
per-chain inversion outcome — useful when `m_absolute` is `null`
because it tells the user *why*. Enum values:

| Value | Meaning |
|---|---|
| `"valid"` | Inversion succeeded; `m_absolute` is finite. |
| `"insufficient_band_width"` | Every per-`(scenario, channel)` circle/RFP fit returned `0+0j` because the chain's frequency band held < `MIN_FIT_BINS = 8` bins. Dominantly low-frequency chains. |
| `"no_full_row"` | Some residues are nonzero but no mapped actuator row had all response channels populated; `shape_inversion.py`'s row-completeness gate dropped every row. Typically high-frequency chains. |
| `"only_unmapped_full_row"` | Full rows exist, but only at scenario indices outside the actuator grid mapping (synthetic / unmapped scenario indices). Inherently rare. |

See the audit at
`docs/proposals/modal-mass-nan-investigation-2026-05-26.md` for the
decision-tree derivation and per-bucket counts on LG_p3 (386 valid /
242 insufficient_band_width / 126 no_full_row / 3
only_unmapped_full_row out of 757 chains).

**Backward compatibility:** older indices written before this commit
do not carry the field. The backend backfills on read with a best-
effort guess from `m_absolute` (finite -> `"valid"`, non-finite ->
`"insufficient_band_width"`); the next `POST /modal/run_modal_mass`
overwrites with the actually-classified value.

---

#### `GET /modal/modal_mass/mode/<int:chain_id>`

Return one chain's full modal-mass payload (residues + shapes +
mass-normalised variants + per-(scenario, channel) detail). Used by
the Modal Mass tab's per-chain drilldown.

Response `200`:
```json
{
  "chain_id": 4,
  "frequency_hz": 42.2,
  "damping_ratio": 0.0051,
  "quality_factor": 98.0,
  "coverage": 0.95,
  "fit_method": "mdof",
  "cluster_chain_ids": [3, 4, 5],
  "m_absolute": 8.87e-6,
  "m_relative": 1.0,
  "shape_actuator": [
    { "index": 0, "real": 0.92, "imag": 0.0 },
    { "index": 1, "real": 0.45, "imag": 0.01 }
  ],
  "shape_response": [
    { "index": 0, "real": 0.78, "imag": 0.02 }
  ],
  "shape_actuator_mass_normalised": [
    { "index": 0, "real": 309.4, "imag": 0.0 }
  ],
  "shape_response_mass_normalised": [
    { "index": 0, "real": 262.0, "imag": 6.7 }
  ],
  "per_scenario_residues": {
    "0": {
      "1": { "real": 0.024, "imag": 0.012, "fit_quality": 0.72 }
    }
  },
  "fit_quality_overall": 0.77,
  "is_reference_mode": true,
  "mass_inversion_status": "valid"
}
```

`mass_inversion_status` (dev-mstat-30b6 2026-05-26) — same enum as
documented above under `GET /modal/modal_mass/summary`; identical
value to the per-chain summary entry.

Both shape arrays are SPARSE — actuator cells with no valid residue
extraction are absent from the list (NOT serialised as `NaN`). The
frontend iterates the list and uses `index` to position each entry
on the actuator grid.

Returns `404` when the chain has no persisted modal-mass payload.

---

#### `DELETE /modal/modal_mass`

Invalidate modal mass for the current project: remove persisted
`modal_mass/chain_*.json` + `modal_mass/index.json` and clear the
in-memory cache. Mirrors the FRF invalidate flow.

Response `200`:
```json
{
  "message": "Invalidated modal mass: removed 42 files",
  "deleted_files": ["chain_0.json", "chain_1.json", "index.json"]
}
```

---

### Data Status surface extensions

`GET /modal/data_status` payload was extended in Phase 1 with three
new keys (additive, no breaking change), and again in Phase 2 with
two more:

| Key | Type | Meaning |
|---|---|---|
| `frf` | bool | True when at least one scenario has FRF persisted |
| `frf_stale` | bool | True when ESPRIT re-run / scenario re-load happened since the last FRF run |
| `qc_log_decrement` | bool | True when the Hilbert log-decrement cross-check has been computed for the current project |
| `modal_mass` | bool | (Phase 2) True when at least one chain has modal-mass persisted |
| `modal_mass_stale` | bool | (Phase 2) True when FRF / ESPRIT / scenarios re-ran since the last modal-mass run |

Per-chain dicts (returned by `GET /modal/tracking_results`) gained
two additive fields:

| Field | Type | Meaning |
|---|---|---|
| `quality_factor` | number \| null | `1 / (2 · damping_mean)` — surfaces the Q-factor per chain. `null` when `damping_mean` is degenerate. |
| `detections[<sc>].quality_factor` | number \| null | Per-detection Q, same formula on `damping_ratio`. |

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

#### `GET /modal/grid_heatmap/<chain_id>` <a id="per-chain-grid-heatmap"></a>

Per-chain 2-D amplitude data for the grid-layout heatmap inset. Requires
`layout_type='grid'` mapping; raises 400 on line-layout projects.

Per-cell `amplitude` is the **raw measured value** for that scenario
under this chain (or `null` when no detection exists). The matrix is
returned UNCHANGED — no smoothing, no approximation, no fill. The
frontend renders smoothing as a pure-visual overlay over the unmodified
matrix (see PianoidTunner `GridHeatmapInset.jsx` for the overlay-canvas
implementation).

Optional query params — **all DEPRECATED no-ops as of round 24 (dev-maimport,
2026-05-17)**. They are accepted (parseable / valid-shape values stay
200) but produce no side effects:

- `approximation`: `"none"` (default) | `"linear"` | `"planar"`. **Round 24:
  silently ignored.** Pre-round-24 it filled empty cells via a 2-D
  planar `np.linalg.lstsq` fit; that fill is now removed because it
  injected extrapolated values into cells that had no measurement. A
  future server-side approximation feature will be its own separate
  round with a fresh API design. Echo field always reports `"none"`.
- `smoothing`: `float` (default `0.0`). **Round 24: silently ignored.**
  Pre-round-24 it applied `scipy.ndimage.gaussian_filter` server-side,
  rewriting every populated cell's amplitude with the smoothed value
  (so the frontend tooltip displayed fabricated numbers as if they
  were measurements — the round-24 user directive
  reversed this). Smoothing is now a pure-rendering concern handled
  client-side by an overlay `<canvas>` with bilinear interpolation
  that leaves the underlying matrix and tooltip untouched. Echo field
  always reports `0.0`. Garbage (non-numeric) values still 400 — the
  parameter is type-checked even though it has no effect.

Response (`200`):
```json
{
  "chain_id": 5,
  "frequency": 432.7,
  "stability": "stable",
  "grid_shape": [4, 6],
  "grid_spacing_mm": 25.0,
  "approximation": "none",
  "smoothing": 0.0,
  "cells": [
    {
      "row": 0, "col": 0,
      "scenario_index": 0,
      "x_mm": 0.0, "y_mm": 0.0,
      "amplitude": 0.83,
      "is_measured": true
    },
    ...
  ]
}
```

`is_measured` mirrors `amplitude != null` — round 24 keeps it on the
payload for the frontend to render measured-vs-empty cells distinctly
(empty cells now stay white / transparent regardless of any query
params the caller passes). Pre-round-24 callers that sent
`approximation="planar"&smoothing=2.0` will get the same response as a
no-param request — see "Round 24 deprecation" note above.

---

#### `POST /modal/chains/save`

Replace tracked chains with manually edited version. Re-indexes chain IDs 0..N-1, invalidates feedin data (must re-run feedin after edits), persists to disk. **Legacy bulk-replace path** kept for backward compatibility — prefer the granular per-op endpoints below for new code (they capture undo snapshots and recompute derived stats per chain).

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

#### Granular chain mutation endpoints (dev-md06)

All seven endpoints mutate `_tracked_chains` directly, push a snapshot onto the in-memory undo stack BEFORE mutating, recompute derived stats on touched chains (`frequency_mean`, `frequency_range`, `frequency_drift`, `damping_mean`, `detection_count`, `coverage`, `stability`), drop empty chains, re-index `chain_id` sequentially, invalidate feedin (`_feedin_data = None`, `_applied = False`), persist `chains.json` (carrying forward `params`, `cross_bridge_matches`, `splitter_reports` from the prior file; bumping `summary.edit_count`; recording `summary.last_action`), and bump `data_status.tracked_chains_version`. The `quality` field on each chain is NOT recomputed (requires the rotated reference shape from tracking) — consumers should treat it as stale-after-edit until the next `run_tracking`.

All responses include `chains` (the canonical post-mutation list) and `data_status`. Op-specific fields are noted per endpoint.

##### `POST /modal/chains/merge`

Merge source chains into target chain. Detection conflicts at shared scenarios: source-order wins (later sources overwrite earlier; target's existing detection is overwritten by any source). Source chains are deleted; remaining chains are re-indexed.

Request: `{"target_chain_id": int, "source_chain_ids": [int, ...]}`

Response: `{"merged_chain_id": int, "chains": [...], "data_status": {...}}` — `merged_chain_id` is the merged target's NEW (post-re-index) chain_id.

Errors: `400` on empty `source_chain_ids`, target in source list, or unknown id.

##### `POST /modal/chains/add_point`

Add a single detection to a chain at a given scenario. Existing detection at that scenario on this chain is overwritten. Cross-chain duplicate validation (same scenario+frequency on a different chain) is the frontend's responsibility — backend accepts any detection unconditionally.

Request: `{"chain_id": int, "scenario_index": int, "detection": {"frequency": float, "damping_ratio": float?, "amplitude": float?, "shape": [...]?, "mode_shape": [[r,i], ...]?}}`

Response: `{"chain_id": int, "chains": [...], "data_status": {...}}`

##### `POST /modal/chains/remove_point`

Remove a single detection from a chain. If this empties the chain, the chain itself is deleted. Silently no-op if the detection is not present (no error, no version bump, no undo snapshot).

Request: `{"chain_id": int, "scenario_index": int}`

Response: `{"removed_chain_id": int, "chains": [...], "data_status": {...}}`

##### `POST /modal/chains/create`

Create a new chain from a list of points. The new chain's id is assigned during re-index (it ends up at position N).

Request: `{"points": [{"scenario_index": int, "frequency": float, "damping_ratio": float?, ...}, ...]}`

Response: `{"new_chain_id": int, "chains": [...], "data_status": {...}}`

Errors: `400` on empty `points` list or any point missing `scenario_index` / `frequency`.

##### `POST /modal/chains/break`

Split a chain at a given scenario into two chains. Detections at scenario ≤ split point stay with the original chain id; detections after the split form a NEW chain (assigned during re-index). Errors if the split would empty either side (i.e. split at the first or last scenario).

Request: `{"chain_id": int, "scenario_index": int}`

Response: `{"left_chain_id": int, "right_chain_id": int, "chains": [...], "data_status": {...}}`

##### `POST /modal/chains/dissolve`

Remove all detections inside a (frequency, scenario) box. Empty chains after dissolution are deleted.

Request: `{"freq_min": float, "freq_max": float, "scenario_min": int|null, "scenario_max": int|null}` — `scenario_min`/`max` of `null` mean unbounded on that side.

Response: `{"dissolve_warning": bool, "chains": [...], "data_status": {...}}` — `dissolve_warning` is `true` if any chain lost > 50% of its detections.

##### `POST /modal/chains/delete`

Delete one or more entire chains by id. Idempotent — silently ignores ids that aren't present (no error). If no ids actually delete, returns without bumping version or capturing an undo snapshot.

Request: `{"chain_ids": [int, ...]}`

Response: `{"deleted": int, "chains": [...], "data_status": {...}}`

##### `POST /modal/chains/undo` and `POST /modal/chains/redo`

Step backward / forward through the in-memory chain edit history. Undo stack capped at 30 entries. Each mutation endpoint pushes a snapshot (and clears the redo stack); undo pops from undo + pushes current to redo; redo pops from redo + pushes current to undo. Both re-persist `chains.json` and bump `tracked_chains_version`.

Snapshots are dropped on `run_tracking` (chain set rebuilt — old IDs no longer match), on project switch (new chain set), and on `reset`. They do NOT survive server restart.

Request: empty body (`{}` accepted, also no body).

Response: `{"chains": [...], "data_status": {...}}`.

Errors: `400` `{"error": "nothing to undo"}` (or "nothing to redo") when the corresponding stack is empty. Frontend should gate the toolbar buttons on `data_status.chain_undo_available` / `chain_redo_available` so users can't trigger this.

---

#### `data_status` fields added by dev-md06

The `data_status` payload (returned in every chain-mutation response, `/modal/project_state`, `/modal/data_status`) includes:

- `chain_undo_available: bool` — true iff the in-memory undo snapshot stack is non-empty.
- `chain_redo_available: bool` — true iff the in-memory redo snapshot stack is non-empty.
- `tracked_chains_version: int` — monotonic counter, bumped on every backend change to `_tracked_chains` (run_tracking, project load, every chain mutation, undo, redo, reset). Frontend cache effects (e.g. `GridHeatmapInset` fetch useEffect) include this in their deps so they re-fetch automatically when the backend chain set changes — fixes the post-merge stale-heatmap class of bugs (dev-md06 Bug A) where the cache key on the heatmap (chain_id) didn't move even though the backend chain contents did.

---

### Stage 7: Apply & Persistence

#### `POST /modal/apply_to_preset` — **served by the main backend (port 5000)**

Apply extracted modes to the active Pianoid preset. Uses FFT feedin path when feedin data is available.

This is the one `/modal/*` route that runs on the **main backend** (port 5000), not on the modal adapter server (port 5001). It must mutate the running `Pianoid` engine, which lives only in the main server process. The modal adapter server rejects this route with `503 ModalAdapterOnlyError` (see F9 above) — external callers must POST to the main server instead.

Implementation: the main-server route rehydrates a fresh `ModalAdapter` from the project directory on disk (auto-persisted by the 5001 server on every mutation), then calls `adapter.apply_to_preset(pianoid, selected_chains, merge)`.

Request body:
```json
{
  "project_name": "belarus_78",
  "selected_chains": [0, 1, 2, 5, 8],
  "merge": false
}
```

- `project_name` (required): the adapter's on-disk project to apply. Usually the frontend's `currentProject`.
- `selected_chains` (optional, default `[]` = all): chain IDs to inject.
- `merge` (optional, default `false`): if `true`, merges with existing modes; if `false`, replaces.

Responses:
- `200`: `{"message": "Applied N modes with FFT feedin"}`
- `400`: missing `project_name`
- `404`: project not found on disk
- `409`: no preset loaded, or project has no tracking/feedin data to apply
- `500`: unexpected error

---

#### `POST /modal/projects/<name>/export_text` (dev-6c54c87f, extended dev-camp 2026-05-07, dev-mmexp-5561 2026-05-26)

Write the 5 RoomResponse-format text files (`Ci_coef_cos.txt`, `omega_coef.txt`,
`Q_coeff_Q.txt`, `Q_coeff_E.txt`, `decka_coeff.txt`) plus a
`stitched_results.json` sidecar, a `mode_amplitudes.csv`
(per-(mode, scenario) complex amplitudes), AND -- when the project has
persisted modal-mass results -- a `relative_modal_mass.txt` (per-chain
relative modal mass reference) to disk. This is the runtime port of the
`Merge_res_New.py` Stage-2 generator from the RoomResponse repository,
adapted to consume already-aggregated mode chains directly from the Modal
Adapter's `_tracked_chains`.

The named project must be the currently-open project — the export reads
the in-memory `_tracked_chains` and `_mapping`, so opening a different
project first is required (`POST /modal/projects/<name>/open`).

Request body (all fields optional):

```json
{
  "output_dir": "D:/some/path",
  "selected_chains": [0, 2, 5, 7]
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `output_dir` | `{project}/modal_adapter/export_text/` | Absolute path. Created if missing. |
| `selected_chains` | `null` (= all chains) | List of chain_ids to export. Pass the user's curated `selectedChains` set to match the Apply panel's behaviour, or omit to export all. |

200 response body:

```json
{
  "message": "Exported 7 text files to D:/.../export_text (12 modes + 116 placeholders)",
  "output_dir": "D:/.../modal_adapter/export_text",
  "files": {
    "Ci_coef_cos.txt": "D:/.../Ci_coef_cos.txt",
    "omega_coef.txt":  "D:/.../omega_coef.txt",
    "Q_coeff_Q.txt":   "D:/.../Q_coeff_Q.txt",
    "Q_coeff_E.txt":   "D:/.../Q_coeff_E.txt",
    "decka_coeff.txt": "D:/.../decka_coeff.txt",
    "stitched_results.json": "D:/.../stitched_results.json",
    "mode_amplitudes.csv": "D:/.../mode_amplitudes.csv",
    "relative_modal_mass.txt": "D:/.../relative_modal_mass.txt"
  },
  "n_modes_exported": 12,
  "n_modes_padded":   116,
  "approximation":    "linear"
}
```

`approximation` is either `"linear"` (line layout — uses `scipy.interpolate.interp1d`)
or `"planar"` (grid layout — uses `np.linalg.lstsq` on `(x, y, value)` tuples
to fit `z = a*x + b*y + c`). The choice is auto-determined by the project's
`mapping.layout_type`.

`mode_amplitudes.csv` (dev-camp 2026-05-07) is an additive companion to
the 5 fixed-name `.txt` files. It holds the per-(mode, scenario) complex
amplitudes -- one row per chain, columns
`0_re, 0_im, 1_re, 1_im, ..., (N-1)_re, (N-1)_im` where `N` is the
number of scenarios. Cells with no detection write `0.000000, 0.000000`.
Only the effective modes are written (no placeholder rows). See
[`MODAL_ADAPTER_GUIDE.md` — Complex amplitudes CSV](../../guides/MODAL_ADAPTER_GUIDE.md#export-to-text-files-dev-6c54c87f).

`relative_modal_mass.txt` (dev-mmexp-5561 2026-05-26; dev-mmexp2-f492
2026-05-26 added export-set filter + NaN drop; dev-mstat-30b6 2026-05-26
added `mass_inversion_status` column) is the per-chain
relative-modal-mass reference. Tab-separated, with `#`-prefixed header
lines (compatible with `np.loadtxt(comments="#")` round-trips) carrying
the reference chain, project metadata, column names, and the filter
book-keeping (`rows_after_filter`, `rows_written`). Rows are
**sorted by frequency ascending** (NOT chain_id). Columns (in order):
`chain_id`, `frequency_hz`, `m_relative`, `m_absolute`,
`fit_quality_overall`, `is_reference`, `mass_inversion_status`.

The trailing `mass_inversion_status` column is a string enum (one of
`valid` / `insufficient_band_width` / `no_full_row` /
`only_unmapped_full_row`); numpy round-trip consumers should pass
`usecols=range(0, 6)` to skip it. In practice every emitted row has
`status = valid` because the NaN-drop filter (see below) removes every
non-valid candidate — the column exists for schema stability if the
NaN drop is ever relaxed.

**Row filtering** (matches the rest of the bundle):

- **Export-set filter** — when `selected_chains` is supplied in the
  request body, the file is filtered to those chain_ids only. This is
  the same filter `build_export_payload` applies to `omega_coef.txt`,
  `Q_coeff_*.txt`, `decka_coeff.txt`, `Ci_coef_cos.txt`, and
  `mode_amplitudes.csv`, so all bundle files cover the same modes.
  Omit `selected_chains` (or pass `null`) to include all chains from
  the modal-mass summary.
- **NaN drop** — rows where `m_relative` is non-finite (`None` /
  `NaN` / `inf` — i.e. the modal-mass fit failed for that chain) are
  dropped after the export-set filter. The header records the row
  count both before (`rows_after_filter`) and after (`rows_written`)
  the drop so a reader can audit how many chains were skipped.

The file is **silently omitted** when the project has no persisted
modal-mass results (no `modal_adapter/modal_mass/index.json` on disk).
The 5 fixed-name `.txt` files + sidecar + `mode_amplitudes.csv` are
always written regardless. To populate modal mass first, run
`POST /modal/run_modal_mass` (the Q6 gate requires ≥8 scenarios with
FRF persisted). Reads from `modal_adapter/modal_mass/index.json` in
the project directory — same source as
`GET /modal/modal_mass/summary`.

Error responses:

| Status | Cause |
|--------|-------|
| `400` | `name` is not the currently-open project |
| `400` | `selected_chains` is not a list of integers |
| `400` (RuntimeError → 409) | No tracked chains (run mode tracking first), or no mapping set |
| `500` | Unexpected error |

See [`MODAL_ADAPTER_GUIDE.md` — Export to Text Files](../../guides/MODAL_ADAPTER_GUIDE.md#export-to-text-files-dev-6c54c87f) for the full file format spec, the linear-vs-planar approximation choice, and the UI workflow.

---

#### `POST /modal/projects/<name>/tracking_report` (dev-f116)

Render a per-mode tracking-results **PDF** for the export set and write
it to disk. One page per mode (frequency range, damping, MAC, stability =
scenario count, heatmap, mode-shape chart) plus a summary cover page.
Read-only — does not modify project state.

The named project must be the currently-open project (the report reads
the in-memory `_tracked_chains` and `_mapping`).

Request body (all fields optional):

```json
{
  "selected_chains": [0, 2, 5, 7],
  "smoothing": 1.5,
  "output_dir": "D:/some/path"
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `selected_chains` | `null` (= all chains) | The export set — list of chain_ids to include. Pass the frontend's curated `exportSelection` set. |
| `smoothing` | `1.5` | Heatmap blend strength (0–2). Replicates the on-screen `GridHeatmapInset` pairwise-border blend (`σ * cellWidth / 4` stripe half-width); the measured matrix is not mutated. |
| `output_dir` | the **project directory root** (`{projects_base}/{name}/`) | Absolute path. Created if missing. The PDF is named `{name}_tracking_report.pdf`. |

200 response body:

```json
{
  "message": "Tracking report written for 8 modes",
  "pdf_path": "D:/modal_projects/PlyWood_p2/PlyWood_p2_tracking_report.pdf",
  "n_modes": 8,
  "layout_type": "grid",
  "smoothing": 1.5
}
```

Per-mode fields are read straight from the serialized chain dict:
frequency range = `frequency_range`, damping = `damping_mean`, MAC =
`quality.shape_consistency`, stability = `detection_count`. The heatmap
is the per-chain grid amplitude (grid layout) or a per-scenario amplitude
strip (line layout); the shape chart is the per-detection `shape`
spatial pattern. Rendered with matplotlib `PdfPages` (no new dependency).

Error responses:

| Status | Cause |
|--------|-------|
| `400` | `name` is not the currently-open project |
| `400` | `selected_chains` is not a list of integers, or `smoothing` is not a number |
| `400` | No tracked chains (run mode tracking first), no mapping set, or the export set selects no existing chains |
| `500` | Unexpected error |

See [`MODAL_ADAPTER_GUIDE.md` — Tracking Report (PDF)](../../guides/MODAL_ADAPTER_GUIDE.md#tracking-report-pdf-dev-f116) for the report layout and the heatmap-smoothing parity note.

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

Create a new project by cloning the raw measurement data and channel
mapping from an existing project. dev-mabug (2026-05-09) reaffirmed
the **clean-clone** contract: ESPRIT results, tracking chains, feedin
data, the applied flag, and any cached export artifacts are all
**reset** in the destination so the user can immediately re-run the
pipeline with different ESPRIT parameters.

Request body:
```json
{
  "source": "piano_A",
  "name": "piano_A_copy"
}
```

Both `source` and `name` are required (HTTP 400 if either is missing).
`source` must already exist as a project; `name` must NOT already
exist (HTTP 500 with `ValueError` surfaced to the response if it
does).

What the destination carries from the source:

- `measurements/scenario_*.npy` (raw scenario arrays, byte-identical)
- `modal_adapter/mapping/mapping_config.json` (channel roles, grid
  layout, pitch_offset, bridge_boundary, cell_mask)
- From `project.json`: `sample_rate`, `num_scenarios`, `num_channels`,
  `scenario_indices`, `measurement_source`, `band_config`,
  `ir_working_length_ms`, `extracted_path`

What the destination resets:

- `modal_adapter/esprit/`, `modal_adapter/tracking/`,
  `modal_adapter/feedin/` — empty stage directories
- `modal_adapter/output/applied.json` — not carried (applied=False)
- `modal_adapter/export_text/` — not carried
- `project.json.created` is reset to "now"; `copied_from` is set to
  `source` for provenance

Response: the destination project's `open_project` envelope (the
adapter opens the new project before returning so the frontend sees
it loaded with measurements + mapping in memory).

See `ModalAdapter.copy_project` and the integration tests in
`tests/integration/test_modal_copy_project.py`.

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

### Effective Signal Length QC (dev-qc01)

Per-scenario per-channel reproducibility check (split-half jackknife).
The averager runs this every time it computes a canonical mean — see
[`MODAL_ADAPTER_GUIDE.md` § Effective Signal Length QC](../../guides/MODAL_ADAPTER_GUIDE.md#effective-signal-length-qc-split-half-jackknife)
for algorithm details.

#### `GET /modal/projects/<name>/effective_signal_length`

Returns the QC roll-up + per-scenario per-channel detail for one project.

Response `200`:
```json
{
  "project_name": "PlyWoodTake1",
  "summary": {
    "n_scenarios_total": 30,
    "n_scenarios_with_qc": 30,
    "n_scenarios_without_qc": 0,
    "global_min_t_eff_ms": 880.0,
    "per_channel_min_t_eff_ms": {"1": 905.2, "2": 880.0, "3": 920.5},
    "per_scenario_min_t_eff_ms": {
      "PlyWood-Scenario0-Take1": 905.2,
      "PlyWood-Scenario1-Take1": 880.0
    },
    "threshold": 0.1,
    "envelope_method": "hilbert"
  },
  "per_scenario": {
    "PlyWood-Scenario0-Take1": { /* full effective_signal_length.json content */ }
  }
}
```

`summary` is `null` when no QC files exist anywhere under the project's
measurement source (e.g. legacy projects whose `averaged_responses/`
predate dev-qc01). `404` when the named project doesn't exist.

#### `POST /modal/projects/<name>/effective_signal_length`

Recomputes QC for one project. Re-runs the canonical averager on each
target scenario with `force=True` — the QC step rewrites
`effective_signal_length.json`. Raw recordings must still be on disk.

Body (all optional):
```json
{
  "scenarios": ["PlyWood-Scenario3-Take1", "PlyWood-Scenario7-Take1"],
  "qc_threshold": 0.1
}
```

- `scenarios`: list of scenario folder names. Without it, every
  scenario the project has access to is recomputed.
- `qc_threshold` (dev-qc02): env_diff/env_signal ratio gate, must be in
  `(0, 1)`. Default 0.1. Persisted into each scenario's
  `effective_signal_length.json` so the next reader knows which
  threshold the QC was computed with. Useful for sweeping the threshold
  to find a setting suited to the project's noise characteristics.

Response `200`:
```json
{
  "project_name": "PlyWoodTake1",
  "summary": { /* as above */ },
  "per_scenario": { /* as above */ },
  "recomputed_scenarios": 2,
  "averaging_summary": {
    "computed": 2,
    "qc_computed": 2,
    "qc_min_t_eff_ms_per_scenario": {"PlyWood-Scenario3-Take1": 905.2}
  }
}
```

`404` when project doesn't exist; `400` when `scenarios` is not a list
or `qc_threshold` is not numeric / out of range.

#### `GET /modal/projects/<name>/qc_curves`

Return time-domain QC curves for one (project, scenario, channel)
tuple — backs the interactive
[`QCVisualizationPanel`](../../guides/MODAL_ADAPTER_GUIDE.md#interactive-qc-inspection-panel-dev-3151-2026-05-06)
panel (dev-3151, 2026-05-06).

Re-runs the canonical pipeline (extract → validate → align →
normalize → pool cycles → split-half → average each half → compute
envelopes) on the scenario's `raw_recordings/` and returns the
arrays the panel needs to render: `signal_a`, `signal_b`,
`signal_full`, `signal_diff`, `env_signal`, `env_diff`, `ratio` —
plus T_eff at the requested threshold and ratio-at-end statistics.

The persisted `effective_signal_length.json` is NOT modified — this
is a read-only introspection. The persisted T_eff (computed at
averaging time) remains the source of truth for the project-level
warning surface (EspritConfig).

Per-process LRU cache on `(project, scenario)` (the slow part is
the cycle pool; the per-channel split + average + envelope is
~50 ms on cached pool). Cap 16 entries.

**Query params:**

- `scenario` (required, string): scenario folder name
  (e.g. `"PlyWood-Scenario3-Take1"`).
- `channel` (required, int): response channel index. Must NOT be
  the calibration channel.
- `qc_threshold` (optional, float in `(0, 1)`): override the
  env_diff/env_signal ratio gate ONLY for the server-side
  `t_eff_ms` field in the response payload. The panel mutates
  threshold client-side via its own recompute against the returned
  `ratio` array, so most calls omit this. Default = the module
  default (0.1).

Response `200`:
```json
{
  "project_name": "PlyWoodTake1",
  "scenario_name": "PlyWood-Scenario3-Take1",
  "channel": 1,
  "sample_rate": 48000,
  "qc_threshold": 0.1,
  "smoothing_ms": 5.0,
  "sustained_ms": 10.0,
  "envelope_method": "hilbert",
  "cal_ch": 0,
  "response_channels": [1, 2, 3],
  "n_cycles_total": 90,
  "n_cycles_half_a": 45,
  "n_cycles_half_b": 45,
  "split_seed": 12345,
  "signal_length_samples": 48000,
  "signal_length_ms": 1000.0,
  "time_ms":     [0.0, 0.0208, 0.0417, "..."],
  "signal_a":    ["..."],
  "signal_b":    ["..."],
  "signal_full": ["..."],
  "signal_diff": ["..."],
  "env_signal":  ["..."],
  "env_diff":    ["..."],
  "ratio":       ["..."],
  "t_eff_ms": 87.4,
  "t_eff_samples": 4195,
  "ratio_at_end": 0.234,
  "ratio_end_window_ms": 50.0,
  "ratio_end_median": 0.221
}
```

All time-series arrays have length `signal_length_samples` (T).
The `ratio` field is the safe-divided `env_diff / max(env_signal,
1e-12)`. `t_eff_ms` is `null` when no sustained crossing exists at
the requested threshold (the signal is reproducible across the full
duration). `ratio_at_end` is the very last sample's ratio;
`ratio_end_median` is the median over the trailing 50 ms — more
robust against single-sample edge effects.

**Errors:**

- `400` — missing `scenario` or `channel` query param; non-integer
  channel; channel is the calibration channel; channel is not in
  the scenario's response-channels set; non-numeric or
  out-of-range `qc_threshold`.
- `404` — project does not exist; scenario folder not found under
  the project's measurement source; scenario lacks `raw_recordings/`;
  too few cycles surviving validation/alignment for split-half
  (< 4 cycles).
- `500` — canonical pipeline crash (RoomResponse not available,
  unexpected error).

**Payload size:** ~8 MB raw on a typical 48000-sample (1 s) signal
× 8 numeric series × 8 bytes per float64 ≈ ~3 MB gzipped. ECharts
handles this without issue; the LRU cache makes channel switches
~280 ms (vs ~670 ms cold).

---

### Modal Collection Endpoints (port 5001, B-1)

Five new endpoints under `/modal/collect/*` orchestrate one in-flight
RoomResponse measurement scenario per process. All routes are mounted on
the modal_adapter_server (port 5001) only — calls to the same paths on
the main backend (port 5000) return HTTP 503 because the RoomResponse
bootstrap is not run there. See [MODAL_COLLECTION.md](MODAL_COLLECTION.md)
for the full architecture.

#### `POST /modal/collect/start`

Begin one measurement scenario. Returns a `session_id` immediately; the
worker thread runs in background. Poll `/modal/collect/status` for
progress.

Request body:

```json
{
  "scenario_number": 0,
  "project_dir": "D:/data/myproject",
  "recorder_config": {
    "num_measurements": 5,
    "measurement_interval": 0.5,
    "computer": "Belarus",
    "room": "Run1",
    "sample_rate": 48000,
    "num_pulses": 5,
    "volume": 0.65,
    "input_device_name": "IN 01-08 (BEHRINGER UMC 1820)",
    "output_device_name": "OUT 1-2 (BEHRINGER UMC 1820)",
    "multichannel_config": {
      "enabled": true,
      "num_channels": 6,
      "response_channels": [0, 1, 3, 4, 5],
      "calibration_channel": 2,
      "reference_channel": 5
    }
  }
}
```

Only the high-impact keys above are honoured in v1 (per direction Q2).
Everything else falls back to RoomResponse's bundled `recorderConfig.json`.

Responses:

| Code | Body | When |
|------|------|------|
| 200 | `{"session_id": "<12-hex>"}` | Accepted; worker thread spawned |
| 400 | `{"error": "..."}` | Missing `scenario_number` / `project_dir`, malformed body |
| 409 | `{"error": "Measurement already running ..."}` | Another session is in flight |
| 502 | `{"error": "Failed to pause Pianoid synthesis ..."}` | Synchronous-path pause failure (rare; usually surfaces via status `phase=error`) |
| 503 | `{"error": "RoomResponse unavailable on this server"}` | Bootstrap failed or running on port 5000 |

Pause coordination happens inside the worker thread. If
`/pause_synthesis` (port 5000) fails or is unreachable, the session
transitions to `phase=error` without opening the audio device — the
operator must check status to learn the failure.

#### `GET /modal/collect/status`

Returns the current (or most recent) session snapshot:

```json
{
  "session_id": "d0722c397e99",
  "scenario_number": 0,
  "project_dir": "D:/data/myproject",
  "phase": "recording",
  "progress_pct": 10.0,
  "started_at": 1777636462.86,
  "finished_at": null,
  "error_message": null,
  "output_paths": []
}
```

When no session has ever run on this process, returns `{"phase": "idle"}`.

| Phase | Meaning |
|-------|---------|
| `idle` | No session has run |
| `pausing` | Posting `/pause_synthesis` |
| `recording` | RoomResponseRecorder + collector running |
| `saving` | Generating averaged_responses + scenario_N.npy mirror |
| `resuming` | Posting `/resume_synthesis` |
| `done` | Success terminal |
| `cancelled` | Cancellation requested mid-flight |
| `error` | Pause failed, recording crashed, or save failed (`error_message` populated) |

#### `POST /modal/collect/cancel`

Signals cancellation of the active session via `threading.Event`. The
worker checks between phases; the final `/resume_synthesis` always fires
when the engine paused successfully, regardless of cancel/error.

Response: `{"cancelled": true}` if a session was active, `{"cancelled": false}` otherwise.

#### `GET /modal/collect/results/<session_id>`

Returns paths and persisted metadata for a completed session. Sessions
are kept in memory (last 16 by id) for post-completion polling.

```json
{
  "session_id": "d0722c397e99",
  "scenario_number": 0,
  "phase": "done",
  "output_paths": [
    "D:/data/myproject/B1Demo-Scenario0-Run1/raw_recordings/raw_meas_000.wav",
    "...",
    "D:/data/myproject/B1Demo-Scenario0-Run1/averaged_responses/average_ch0.npy",
    "D:/data/myproject/measurements/scenario_0.npy"
  ],
  "session_metadata": {
    "scenario_name": "B1Demo-Scenario0-Run1",
    "device_info": { "sdl_version": "3.2.0", "device_counts": { ... } },
    "measurements": [ ... ]
  }
}
```

| Code | Body | When |
|------|------|------|
| 200 | result body | session known |
| 404 | `{"error": "Unknown session: ..."}` | session_id not in active or recent history |

#### `GET /modal/collect/devices`

Transient SDL3 device probe. The handler does NOT keep an `AudioEngine`
open across the call — it enumerates and returns.

```json
{
  "input_devices":  [{"index": 0, "name": "IN 05 (BEHRINGER UMC 1820)"}, ...],
  "output_devices": [{"index": 0, "name": "OUT 1-2 (BEHRINGER UMC 1820)"}, ...],
  "sdl_version": "3.2.0"
}
```

| Code | Body | When |
|------|------|------|
| 200 | device list | normal |
| 503 | `{"error": "RoomResponse unavailable"}` | `/modal/collect/health` would also report `available: false` |

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
