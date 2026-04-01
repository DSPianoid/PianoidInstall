# Standalone MIDI Player

The standalone MIDI player (`playPianoid.py`) runs the Pianoid synthesis engine
with a C++ MIDI listener, bypassing the Flask server and React frontend entirely.
It provides the lowest-latency path from MIDI input to audio output.

---

## Prerequisites

1. **Built `pianoidCuda` package** -- the CUDA extension must be compiled and installed
   in the PianoidCore venv. See [QUICK_START.md](QUICK_START.md) for build instructions.
2. **MIDI device connected** -- a USB MIDI keyboard or controller must be plugged in
   and recognized by the OS before launching the player.
3. **Audio output available** -- an ASIO-compatible audio interface (recommended) or
   any system audio device supported by SDL3.

---

## Basic Usage

```bash
cd D:\repos\PianoidInstall\PianoidCore
.venv\Scripts\python pianoid_middleware\playPianoid.py [preset_path]
```

If no preset path is given, the default `presets/BaselinePreset1.json` is loaded.

The player will:

1. Initialize the CUDA synthesis engine with the specified preset
2. Start real-time audio playback
3. Enumerate available MIDI ports and connect to port 0
4. Print "Ready. Press Ctrl+C to quit."
5. Wait for MIDI input until interrupted

---

## Command-Line Parameters

Currently `playPianoid.py` accepts a single positional argument:

| Position | Parameter | Default | Description |
|----------|-----------|---------|-------------|
| 1 | `preset_path` | `presets/BaselinePreset1.json` | Path to the JSON preset file (relative to `PianoidCore/`) |

The engine is initialized with these hardcoded defaults:

| Parameter | Value | Description |
|-----------|-------|-------------|
| `filterlen` | `48 * 128 * 3` (18432) | FIR filter length |
| `string_iteration` | `6` | Solver iterations per string per cycle |
| `volume` | `48` | Initial main volume (0--127) |
| `array_size` | `384` | Spatial discretization points per string block |
| `use_paceholder` | `False` | Use real CUDA engine (not placeholder) |

Audio driver selection follows the compile-time default (ASIO Callback if available,
SDL3 otherwise). The `audio_driver_type` is not currently exposed as a CLI argument.

---

## Example Commands

### Play with the default preset

```bash
cd D:\repos\PianoidInstall\PianoidCore
.venv\Scripts\python pianoid_middleware\playPianoid.py
```

### Play with a specific preset

```bash
.venv\Scripts\python pianoid_middleware\playPianoid.py presets/IversPond_ESPRIT_128modes.json
```

### Play with a custom preset from another directory

```bash
.venv\Scripts\python pianoid_middleware\playPianoid.py "C:\Users\me\my_presets\Grand.json"
```

---

## Loading Multiple Presets

The standalone player currently loads a single preset at startup. To switch presets,
stop the player (Ctrl+C) and relaunch with a different preset path.

For multi-preset workflows with live switching, use the full stack (Flask backend +
React frontend), which supports the preset library API:

- `POST /preset/load` -- load a preset into the GPU library
- `POST /preset/switch` -- switch the active preset via double-buffer swap
- `POST /preset/unload` -- remove a preset from the GPU library

See the [REST API reference](http://localhost:8001/modules/pianoid-middleware/REST_API/#lifecycle-endpoints)
for details.

---

## MIDI CC Mapping

The C++ `MidiInputListener` handles the following MIDI messages directly:

| MIDI Message | CC Number | Action | Description |
|--------------|-----------|--------|-------------|
| Note On (0x90) | -- | `NOTE_ON` | Triggers string excitation at the given pitch and velocity |
| Note Off (0x80) | -- | `NOTE_OFF` | Releases the string (damper engages) |
| CC | 64 | Sustain | Sustain pedal -- holds all active strings |
| CC | 7 | Volume | Main volume level (0--127) mapped to `VOLUME_CHANGE` event |
| CC | 74 | Deck Feedback | Soundboard feedback coefficient mapped to `DECK_FEEDBACK` event |

All events are pushed into `RealTimeEventBuffer` and dispatched by
`OnlinePlaybackEngine` with cycle-accurate timing (when `CycleEstimator` is set).

### Legacy Python MIDI Listener (additional CCs)

The legacy Python `MidiListener` (used by the Flask backend, not by `playPianoid.py`)
supports additional per-note CC controls. These are **not** available in the standalone
C++ listener:

| Action | Description |
|--------|-------------|
| `note_volume` | Per-note volume coefficient (exponential mapping) |
| `note_pitch` | Per-note tension coefficient |
| `note_dispersion` | Per-note Jung modulus |
| `note_decrement` | Per-note gamma |
| `note_tension_offset` | Per-note tension offset |
| `main_feedin` | Global feedin coefficient |
| `main_feedback` | Global feedback coefficient |
| `pitch_wheel` | Scales tension of all strings |
| `mode_pad` | Triggers individual mode playback |

See [MIDI System docs](http://localhost:8001/modules/pianoid-middleware/MIDI_SYSTEM/)
for the full action reference.

---

## Audio Driver Selection

The standalone player uses the compile-time default audio driver. The priority order is:

| Priority | Driver | `audio_driver_type` | Description |
|----------|--------|---------------------|-------------|
| 1 | ASIO Callback | `4` | Lowest latency, requires ASIO-compatible interface |
| 2 | ASIO Polling | `1` | ASIO without callback mode |
| 3 | SDL3 | `3` | Cross-platform, works on all systems |
| 4 | SDL2 | `2` | Legacy fallback |
| -- | Default | `0` | Auto-select best available |

To change the audio driver, modify the `initialize()` call in `playPianoid.py` and
add `audio_driver_type=N` to the keyword arguments. For example:

```python
pianoid = initialize(
    preset, filterlen,
    string_iteration=6,
    volume=48,
    array_size=384,
    use_paceholder=False,
    audio_driver_type=3,  # Force SDL3
)
```

---

## Troubleshooting

### No MIDI input ports found

```
WARNING: No MIDI input ports available. Running without MIDI input.
```

- Verify the MIDI device is connected and powered on before launching
- On Windows, check Device Manager for the MIDI device under "Sound, video and game controllers"
- Some USB MIDI devices need their driver installed first
- The player will still produce audio output; you can test synthesis via the REST API
  if the full stack is running

### Wrong audio driver / no sound

- If ASIO is selected but no ASIO device is available, the engine may fail to initialize
- Set `audio_driver_type=3` in the `initialize()` call to force SDL3 (works everywhere)
- Check that your audio interface is not locked by another application (ASIO is
  exclusive-access)

### CUDA errors on startup

- Ensure the NVIDIA GPU driver is installed and up to date
- Verify `pianoidCuda` was built against the same CUDA toolkit version
- Run `nvidia-smi` to confirm the GPU is visible

### Port index mismatch

The C++ listener always connects to MIDI port 0. If your target device is on a
different port, modify the `midi_listener.start(0)` call in `playPianoid.py` to
use the correct port index (shown in the port enumeration output at startup).

### High latency

- Use ASIO Callback (`audio_driver_type=4`) for lowest latency
- Reduce `string_iteration` (fewer solver iterations = faster cycles, but less accuracy)
- Ensure no other GPU-intensive applications are running
- Check `circular_buffer_chunks` -- smaller values (2--4) reduce latency at the cost of
  stability

### Ctrl+C does not stop cleanly

On Windows, the `signal.SIGINT` handler may not fire reliably in all terminal emulators.
If the player hangs after Ctrl+C, press Ctrl+Break or close the terminal window.
