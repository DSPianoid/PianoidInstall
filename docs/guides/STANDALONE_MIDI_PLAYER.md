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
.venv\Scripts\python pianoid_middleware\playPianoid.py [preset_path] [options]
```

If no preset path is given, the default `presets/BaselinePreset1.json` is loaded.

The player will:

1. Initialize the CUDA synthesis engine with the specified preset
2. Start real-time audio playback
3. Enumerate available MIDI ports and connect to the selected port (default: port 0)
4. Print "Ready. Press Ctrl+C to quit."
5. Wait for MIDI input until interrupted

---

## Command-Line Parameters

All engine initialization parameters are exposed as command-line arguments:

### Positional

| Position | Parameter | Default | Description |
|----------|-----------|---------|-------------|
| 1 | `preset_path` | `presets/BaselinePreset1.json` | Path to the JSON preset file (relative to `PianoidCore/`) |

### Engine Parameters

| Argument | Default | Description |
|----------|---------|-------------|
| `--filterlen` | `18432` (48\*128\*3) | FIR filter length |
| `--string-iteration` | `6` | Solver iterations per string per cycle |
| `--volume` | `48` | Initial main volume, MIDI-style 0--127 |
| `--max-volume` | *(none)* | Explicit max volume float (overrides `--volume` if set) |
| `--array-size` | `384` | Spatial discretization points per string block (384 or 512) |
| `--sample-rate` | `48000` | Audio sample rate in Hz (values < 1000 are multiplied by 1000) |
| `--cycle-iterations` | `64` | Samples per synthesis cycle (minimum 16) |
| `--buffer-size` | `2` | Audio buffer chunks: 2=low latency, 4=balanced, 8=high stability |
| `--audio-driver-type` | `0` | Audio driver selection (see table below) |
| `--listen-to-modes` | `1` | Sound channels: 0=string displacement, 1=mode forces |
| `--sound-derivative-order` | `1` | Sound derivative order for output |
| `--no-audio` | *(flag)* | Initialize engine without audio output |
| `--use-placeholder` | *(flag)* | Use placeholder engine instead of real CUDA engine |
| `--debug-build` | *(flag)* | Use debug build of pianoidCuda if available |

### MIDI Parameters

| Argument | Default | Description |
|----------|---------|-------------|
| `--midi-port` | `0` | MIDI input port index to connect to |
| `--list-midi-ports` | *(flag)* | List available MIDI input ports and exit |
| `--no-midi` | *(flag)* | Run without MIDI listener (audio output only) |

---

## Audio Driver Types

| Value | Driver | Description |
|-------|--------|-------------|
| `0` | Auto-select | Default -- picks best available driver |
| `1` | ASIO polling | ASIO without callback mode |
| `2` | SDL2 | Legacy cross-platform fallback |
| `3` | SDL3 | Cross-platform, works on all systems |
| `4` | ASIO callback | Lowest latency, requires ASIO-compatible interface |

**Recommendation:** Use ASIO Callback (`4`) for lowest latency when an ASIO device
is available. Use SDL3 (`3`) as fallback on systems without ASIO drivers.

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

### Force ASIO callback driver with higher volume

```bash
.venv\Scripts\python pianoid_middleware\playPianoid.py --audio-driver-type 4 --volume 80
```

### Use SDL3 driver with 512-point array size

```bash
.venv\Scripts\python pianoid_middleware\playPianoid.py --audio-driver-type 3 --array-size 512
```

### List available MIDI ports

```bash
.venv\Scripts\python pianoid_middleware\playPianoid.py --list-midi-ports
```

### Connect to a specific MIDI port

```bash
.venv\Scripts\python pianoid_middleware\playPianoid.py --midi-port 1
```

### Run without MIDI (audio output only, useful for API testing)

```bash
.venv\Scripts\python pianoid_middleware\playPianoid.py --no-midi
```

### Low-latency configuration

```bash
.venv\Scripts\python pianoid_middleware\playPianoid.py --audio-driver-type 4 --buffer-size 2 --cycle-iterations 64
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
- Use `--audio-driver-type 3` to force SDL3 (works everywhere)
- Check that your audio interface is not locked by another application (ASIO is
  exclusive-access)

### CUDA errors on startup

- Ensure the NVIDIA GPU driver is installed and up to date
- Verify `pianoidCuda` was built against the same CUDA toolkit version
- Run `nvidia-smi` to confirm the GPU is visible

### Port index mismatch

Use `--list-midi-ports` to see available ports and their indices, then use
`--midi-port N` to connect to the correct one.

### High latency

- Use `--audio-driver-type 4` for ASIO Callback (lowest latency)
- Reduce `--string-iteration` (fewer solver iterations = faster cycles, but less accuracy)
- Use `--buffer-size 2` for minimum audio buffer latency
- Ensure no other GPU-intensive applications are running

### Ctrl+C does not stop cleanly

On Windows, the `signal.SIGINT` handler may not fire reliably in all terminal emulators.
If the player hangs after Ctrl+C, press Ctrl+Break or close the terminal window.
