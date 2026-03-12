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
- `Pianoid.SoundChannels` - Output channel routing coefficients
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

### Flask -> Middleware (Python)

Flask routes call methods on the global `Pianoid` instance:
- `pianoid.perform_midi_command(command, pitch, velocity)` - note events
- `pianoid.update_parameter(parameter, values, pitches, modes)` - parameter updates
- `pianoid.send_deck_params_to_CUDA(...)` - deck matrix upload
- `pianoid.set_volume_level(level)` - runtime volume via `RuntimeParameters`
- `pianoid.stop_pianoid()` / `pianoid.destroyPianoid()` - lifecycle control

### Middleware -> CUDA Engine (pybind11)

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

### CUDA Engine -> Audio Driver

`AudioDriverInterface` (pure virtual C++ base class) is implemented by:
- `ASIOAudioDriver` - low-latency ASIO callback (Windows, recommended for piano)
- `SDLAudioDriver` - SDL2 callback driver
- `SDL3AudioDriver` - SDL3 callback driver

Selected at build time by `USE_SDL2_AUDIO` / `USE_SDL3_AUDIO` / `USE_ASIO_AUDIO`
preprocessor defines; selected at runtime via the `audio_driver_type` parameter
(0=default, 1=ASIO, 2=SDL2, 3=SDL3, 4=ASIO_CALLBACK).

---

## Threading Model

```
Main Process
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
    +-- MIDI listener thread (optional, pianoidMidiListener.py)
            Calls pianoid.perform_midi_command() for each MIDI event.
            Pushes events into RealTimeEventBuffer (thread-safe, < 1us lock).
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
