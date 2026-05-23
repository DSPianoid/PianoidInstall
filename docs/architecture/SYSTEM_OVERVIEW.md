# Pianoid System Architecture Overview

## Four-Layer Architecture

Pianoid is organized into four layers that process audio from user interaction down
to GPU synthesis and out to the audio device.

![Pianoid Architecture Overview](../images/architecture-overview.svg)

---

## PianoidBasic: Cross-Cutting Domain Model

`PianoidBasic` is a pure-Python package (installed as a wheel into `.venv`) that
provides the domain model shared by the middleware and any analysis tooling:

- `Pianoid.StringMap` - Maps piano pitches to string objects with physical parameters
- `Pianoid.ModelParams` - Global synthesis parameters (array_size, sample_rate,
  string_iteration, num_modes, num_channels, etc.)
- `Pianoid.Mode` / `ModeMap` - Resonance mode objects with frequency, decrement,
  omega, and state vectors
- `Pianoid.SoundChannels` - Output channel routing coefficients. Two stores
  keyed by pitch: `coefficients` (modes path, used when `listen_to_modes=1`)
  and `string_coefficients` (strings path, used when `listen_to_modes=0`).
  Despite the per-pitch storage, in strings mode only the output-pitch rows
  `128..127+num_output_channels` are kernel-effective — each output pitch is
  isomorphic to one audio output channel. See `docs/modules/pianoid-basic/OVERVIEW.md`
  "SoundChannels — Stored vs effective entries" for the data-model contract
- `Pianoid.bytestream_encoding` - Serializes Python objects to flat arrays for CUDA upload

These classes are imported by `pianoid.py` and used to build the parameter arrays
that are passed into the C++ extension via pybind11.

---

## Data Flow: User Interaction to Audio Output

```
User (browser)
    |
    | POST /load_preset  {path, sample_rate, audio_driver_type, ...}
    v
backendServer.py:load_preset_route()
    - Reads JSON fields, validates audio_driver_type (0-4)
    - Calls initialize(path, filterlen, **init_kwargs)
    |
    v
pianoid.py:initialize()
    - Constructs Pianoid(preset=...) -> builds StringMap, ModeMap
    - Calls pianoid.initialize_pianoid()
        * devMemoryInit()   -> GPU memory allocated
        * initParameters()  -> CUDA kernel args prepared
        * Load preset       -> physics, hammer, excitation, modes, deck pushed to GPU
    - State: UNINITIALIZED -> PARAMETERS_LOADED
    |
    | (if start_right_away == 1)
    v
threading.Thread -> long_running_procedure()
    -> pianoid.start_realtime_playback()
        -> start_realtime_playback_unified()
            * Creates RealTimeEventBuffer
            * Creates OnlinePlaybackEngine, loads EventQueue
            * Starts background engine thread
    - State: PARAMETERS_LOADED -> PLAYBACK_ACTIVE

    |   (real-time path, during playback)
    v
User plays note (browser) or MIDI keyboard
    |
    | POST /play_note or MIDI callback
    v
backendServer -> pianoid.perform_midi_command(command, pitch, velocity)
    - Validates state == PLAYBACK_ACTIVE
    - Maps command to EventType (NOTE_ON / NOTE_OFF / SUSTAIN)
    - Calls add_realtime_event() -> RealTimeEventBuffer.pushEvent(event, cycle)
    |
    v
OnlinePlaybackEngine (engine thread, runs continuously)
    - Each synthesis cycle: processEventsAtCycle(cycle)
        * drainEventsUpTo(cycle) from RealTimeEventBuffer
        * EventDispatcher.dispatch(event) -> pianoid C++ object methods
    - Calls CUDA synthesis kernel per cycle
    - Pushes Sint32* samples -> AudioDriverInterface.pushSamples()
    |
    v
AudioDriver callback thread (SDL/ASIO)
    - Pulls from internal ring buffer
    - Sends PCM to OS audio device
```

---

## Frontend ↔ Backend State Discipline

PianoidTunner editor hooks (modes/strings sound channels, deck feedin/feedback,
string/mode/excitation parameters) follow three architectural principles to
keep the React-side state coherent with the engine's truth:

1. **Single source of truth = backend.** Every backend-state-changing event
   (`/load_preset`, `/preset/switch`, `/preset/unload`, future modal-adapter
   pushes) must trigger frontend re-init. The mechanism is a `presetVersion`
   counter in `usePreset`; editor hooks subscribe via `useEffect(deps:
   [presetVersion])` and discard their local history on every bump.
2. **Granular writes preferred over bulk.** A user editing one row sends ONE
   per-pitch POST; "Whole Matrix" sends N per-pitch POSTs, never one bulk
   `/feedback/output` call. Per-cell endpoints are added as needed; today the
   minimum granularity is per-pitch.
3. **Imperative emits at the user-action site.** Writes happen inside the
   click/edit handler, NOT inside a `useEffect` watching state. The Phase A3
   silence bug (dev-833f, Apr 2026) was a state-watching useEffect re-pushing
   stale local state after `/load_preset`, undoing the restoration.
4. **Cancel pending writes on a preset transition.** Per-pitch editor writes are
   *debounced* (50 ms WS / 300 ms REST) and target the **active** preset by URL
   (`/set_parameter/...` — no preset in the path; the backend uses whatever is
   active). `switchPreset` therefore calls `cancelPendingParamWrites()` BEFORE
   the `/preset/switch` POST, so an edit scheduled against the preset being left
   cannot fire after the switch and land on the switched-to preset. This was the
   working-copy "isolation leak" (dev-preset-bugs #1, May 2026): the backend
   library deep-copies per entry and was never the cause; the leak was a stale
   in-flight client write surviving the transition. Global runtime writes
   (volume/feedback) are library-wide and are NOT cancelled.

**Reference implementation**: `PianoidTunner/src/hooks/useSoundChannels.js`
(Sound Channels editor, refactored Phase C2).

The string / mode / excitation / feedin / feedback editor histories in
`PianoidTuner.js` follow Principle 1 as of dev-preset-bugs (2026-05-23): each
history re-initialises from fresh backend data on every `presetVersion` change.
The re-init is keyed on `presetVersion` via a per-editor `*InitVersionRef`, NOT
on the `parametersOf*` / matrix object identity — the per-editor change handlers
also call `setParametersOf*` / `setFeed*` on a user edit, so re-initialising on
identity would wipe the in-progress undo stack mid-edit. On the re-init render a
`skip*SyncRef` is armed so the editor's speculative back-sync effect does NOT
re-POST the freshly-seeded values to the engine (real edits / undo / redo leave
the ref false and still propagate). Before this fix these editors were
initialised once and never re-seeded, so a working copy's edits leaked into the
next preset shown after a switch, and the back-sync re-POSTed that stale state
onto the switched-to preset (the working-copy "isolation leak" — same class as
the Phase A3 silence bug). The backend preset library was never the cause: it
deep-copies domain objects per entry (see DATA_FLOWS §2.8 "Edit isolation").

See `project_frontend_state_principles.md` (memory) for the user directive
and `docs/modules/pianoid-tunner/OVERVIEW.md` for the SC editor's wiring.

---

## Key Interfaces Between Layers

### Frontend -> Flask (REST)

Selected routes defined in `backendServer.py`:

| Route | Method | Purpose |
|---|---|---|
| `/load_preset` | POST | Initialize engine from preset file |
| `/get_parameter/<param>/<key>` | GET | Read string/mode/excitation params |
| `/set_parameter/<param>/<key>` | POST | Update params and push to GPU |
| `/set_runtime_parameters` | POST | Change volume/deck feedback live |
| `/set_deck/<matrix>` | POST | Upload full feedin/feedback matrix |
| `/play_note/<pitch>/<velocity>` | POST | Inject note via EventQueue |
| `/reset` | GET | Reset string and mode state |
| `/save_preset` | POST | Serialize current state to file |
| `/preset/list` | GET | List loaded presets and active preset |
| `/preset/load` | POST | Load preset to GPU library (no activation) |
| `/preset/switch` | POST | Switch active preset (double-buffer swap) |
| `/preset/unload` | POST | Remove preset from GPU library |
| `/calibrate_volume` | POST | Multi-velocity mic calibration (background) |
| `/calibration_params` | GET/POST | Perception curves, timing bands, level multipliers |
| `/pause_synthesis` | POST | Pause synthesis (PLAYBACK_ACTIVE → PAUSED), keeps GPU |
| `/resume_synthesis` | POST | Resume synthesis (PAUSED → PLAYBACK_ACTIVE) |

### Flask -> Middleware (Python)

Flask routes call methods on the global `Pianoid` instance:
- `pianoid.perform_midi_command(command, pitch, velocity)` - note events
- `pianoid.update_parameter(parameter, values, pitches, modes)` - parameter updates
- `pianoid.send_deck_params_to_CUDA(...)` - deck matrix upload
- `pianoid.set_volume_level(level)` - runtime volume via `RuntimeParameters`
- `pianoid.stop_pianoid()` / `pianoid.destroyPianoid()` - lifecycle control

### Middleware -> CUDA Engine (pybind11)

Two build variants exist: `pianoidCuda` (release, `-O3`) and `pianoidCuda_debug` (debug, `-O2` + `PIANOID_DEBUG_DATA`). At startup, `select_cuda_variant()` aliases the chosen variant as `pianoidCuda` in `sys.modules` — all downstream code imports a single name. Selection: `use_debug_build=True` in `initialize_pianoid()` or `PIANOID_USE_DEBUG=1` env var. See [BUILD_SYSTEM.md](BUILD_SYSTEM.md#build-variants-debug--release).

The `pianoidCuda` extension module (built from `pianoid_cuda/`) exposes:
- `pianoidCuda.RealTimeEventBuffer` - thread-safe cycle-keyed event queue
- `pianoidCuda.OnlinePlaybackEngine` - real-time synthesis loop
- `pianoidCuda.PlaybackConfig` - engine configuration struct
- `pianoidCuda.RuntimeParameters(volume_level)` - live-adjustable parameters
- `pianoidCuda.InitializationParameters(max_volume)` - init-time parameters
- `pianoidCuda.EventType` - NOTE_ON, NOTE_OFF, SUSTAIN, PARAM_UPDATE_*
- `Pianoid.devMemoryInit()`, `Pianoid.initParameters()`, `Pianoid.resetStringsState()`
- `Pianoid.setNewPhysicalParameters(...)`, `Pianoid.setRuntimeParameters(...)`
- `Pianoid.runOfflinePlayback(event_queue, config)` - offline MIDI-to-WAV render
- `Pianoid.loadPresetToLibrary(name, physics, hammer, excitation, modes, deck, volume)` - store preset in host library
- `Pianoid.switchPreset(name, async)` - activate preset via double-buffer swap
- `Pianoid.getLibraryPresets()`, `Pianoid.getActivePreset()`, `Pianoid.unloadPresetFromLibrary(name)` - library management
- `pianoidCuda.UpdatePolicy` - DROP_IF_BUSY, BLOCK_UNTIL_READY, QUEUE_NEXT
- `Pianoid.stopEngineKeepAudio()`, `Pianoid.executeSingleMeasurementCycle()`, `Pianoid.restartOnlineEngine()` - semi-offline calibration mode
- `Pianoid.startMicCapture()`, `Pianoid.stopMicCapture()`, `Pianoid.getMicBuffer()` - microphone capture for calibration
- `Pianoid.listMicDevices()`, `Pianoid.setMicDevice(name)` - mic device selection

### CUDA Engine -> Audio Driver

`AudioDriverInterface` (pure virtual C++ base class) is implemented by:
- `ASIOAudioDriver` - low-latency ASIO callback (Windows, recommended for piano)
- `SDLAudioDriver` - SDL2 callback driver
- `SDL3AudioDriver` - SDL3 callback driver

Selected at build time by `USE_SDL2_AUDIO` / `USE_SDL3_AUDIO` / `USE_ASIO_AUDIO`
preprocessor defines; selected at runtime via the `audio_driver_type` parameter
(0=default, 1=ASIO, 2=SDL2, 3=SDL3, 4=ASIO_CALLBACK).

---

## Server Architecture

Two Flask servers run in parallel, managed by the Node.js launcher (`server/launcher.js`):

| Server | Port | Script | Role |
|--------|------|--------|------|
| Backend | 5000 | `backendServer.py` | Pianoid synthesis engine, parameter editing, playback |
| Modal Adapter | 5001 | `modal_adapter_server.py` | ESPRIT extraction, mode tracking, project management |

Separation is required because CuPy GPU operations (used by ESPRIT) deadlock in
non-main threads. The modal adapter server runs with `threaded=False` so ESPRIT
executes on the main thread. The frontend drives the per-scenario loop, sending
one `POST /modal/run_esprit` per scenario. Before ESPRIT starts, the frontend
pauses synthesis on port 5000 (`POST /pause_synthesis`) to free GPU resources.

### Audio-driver coordination — preset load vs. modal-adapter measurement (dev-mastop, 2026-05-07)

The Pianoid main backend (5000) and the Modal Adapter (5001) both touch the
same audio device:

- **Pianoid main backend** opens the audio driver (SDL3 / SDL2 / ASIO) on
  every `POST /load_preset` — `load_preset` always destroys any existing
  engine instance and re-initialises (which re-opens the driver).
- **Modal Adapter** opens the audio device only DURING measurement
  collection — `MeasurementSession._invoke_collection` constructs a
  `RoomResponseRecorder` that holds the SDL3 device for the duration of
  the scenario, then releases it on completion / cancel / error.

Windows grants exclusive ownership to one application at a time, so the
two backends cannot both hold the device. The legacy half of this
contract is `MeasurementSession._pause_backend` → `POST /pause_synthesis`
(the MA tells Pianoid to free the driver before recording). The
preset-load direction is enforced as a frontend pre-flight in
`PianoidTuner.js → ensureBackendAndLoadPreset`:

1. If `useBackendProcess` reports `modalRunning === true`, the frontend
   POSTs `/api/stop-modal-adapter` on the launcher and `await`s.
2. The launcher's `gracefulShutdown(modalProcess, 5001)` posts
   `http://127.0.0.1:5001/shutdown`, polls process liveness for up to
   3 s, then `taskkill /T /F` as fallback. The HTTP response only
   returns once the MA process has exited, so the OS has reclaimed any
   audio device handle by then.
3. `modal_adapter_server.shutdown()` calls
   `MeasurementSession.cancel_and_wait(timeout=5.0)` BEFORE scheduling
   SIGTERM, so the recorder's audio-device handle is released
   deterministically (rather than relying on OS-level process-death
   cleanup, which races the next `/load_preset` call).
4. After the MA stop completes, `ensureBackendAndLoadPreset` continues
   its existing flow (probe `/health` on 5000, kill stale, start backend
   if needed, `POST /load_preset`).

The pre-flight runs on **every** preset load — not just when starting a
fresh backend — because every `/load_preset` re-opens the audio driver
on the running backend too.

---

## Threading Model

```
Backend Process (port 5000)
    |
    +-- Flask thread (backendServer.py)
    |       Handles HTTP requests from the browser.
    |       Calls into the Pianoid object (thread-safe via cuda_lock).
    |       Spawns the engine thread via threading.Thread.
    |
    +-- Engine thread (start_realtime_playback_unified)
    |       Runs OnlinePlaybackEngine.run() loop.
    |       Each cycle:
    |         1. processEventsAtCycle(cycle) - drain RealTimeEventBuffer
    |         2. EventDispatcher.dispatch() - apply to C++ Pianoid state
    |         3. CUDA synthesis kernel (GPU stream)
    |         4. AudioDriver.pushSamples() - enqueue to ring buffer
    |       Protected from parameter races by cuda_lock on caller side.
    |
    +-- Audio callback thread (ASIO/SDL runtime)
    |       Driven by OS audio scheduler, fires every ~1.33ms (64 samples @ 48kHz).
    |       Pulls from ring buffer filled by engine thread.
    |       Must not block; no Python code runs here.
    |
    +-- MIDI listener thread (optional)
            Python MIDI_listener_unified (pianoid.py) — uses rtmidi to read
            raw MIDI bytes from a hardware port, then pushes NOTE_ON /
            NOTE_OFF / SUSTAIN events into RealTimeEventBuffer via
            Pianoid.schedule_event(). Thread-safe buffer, < 1us lock.
            Legacy Python MidiListener (pianoidMidiListener.py) is retained
            for its YAML keyboard config / per-note CC handlers but is not
            wired into the default startup path.
```

Thread safety is maintained by:
- `self.cuda_lock` (Python `threading.Lock`) in the Pianoid middleware class,
  held by any caller that invokes a CUDA parameter-update method.
- `RealTimeEventBuffer` internal `std::mutex` protecting the `std::multimap`
  event store; lock-free `std::atomic<size_t>` for size queries.
- Audio driver ring buffer managed inside the C++ driver implementation.

---

## Lifecycle State Machine

Defined as `PianoidState` enum in `pianoid.py`:

```
UNINITIALIZED (0)
    |  devMemoryInit() + initParameters() + preset load
    v
GPU_READY (1)           [intermediate, typically skipped]
    |
    v
PARAMETERS_LOADED (2)
    |  start_realtime_playback_unified()
    v
PLAYBACK_ACTIVE (3)
    |  stop_pianoid() - stops engine thread, keeps GPU
    v
PAUSED (4)
    |  start_realtime_playback_unified()
    +---------> PLAYBACK_ACTIVE
    |  close_pianoid() / destroyPianoid()
    v
(resources freed, object discarded)
```

State validation is enforced in `perform_midi_command()`: NOTE_ON and NOTE_OFF
commands are dropped when state is not `PLAYBACK_ACTIVE`. Control commands
(sustain, volume) are accepted in any post-init state.

---

## CUDA Synthesis Engine Internals

The CUDA kernel processes physical string simulation each cycle:

- **Cycle size**: 64 samples (configurable, must match audio driver buffer size)
- **Sample rate**: 48000 Hz (configurable via `ModelParameters.sample_rate`)
- **Numeric type**: `float` (compile-time via `PIANOID_USE_FLOAT` in `pianoid_types.h`)
- **String model**: Wave equation with physical parameters - tension, damping,
  stiffness, radius, density, frequency damping, hammer shape (Gaussian)
- **Modes**: Each pitch has resonance modes; feedin/feedback matrices couple
  string motion to deck resonances
- **Volume formula**: `coefficient = max_volume ^ (volume_level / 127)`
  where `volume_level` is 0-127 (MIDI range) and `max_volume` is a
  floating-point scale factor set at initialization

Offline rendering (`render_midi_offline`) bypasses the audio driver entirely:
`record_to_buffer=True` captures samples from the engine loop, then
`exportAudioToWav()` writes a WAV file.
