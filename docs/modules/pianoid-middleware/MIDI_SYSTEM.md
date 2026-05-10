# pianoid_middleware — MIDI System

## Overview

Two MIDI listener implementations exist:

- **Python `MIDI_listener_unified`** (active) — defined in
  `pianoid_middleware/pianoid.py`. Uses `rtmidi` via the helper in
  `pianoidMidiListener.py` to read MIDI bytes, then pushes NOTE / SUSTAIN events
  to the C++ `RealTimeEventBuffer`. Started by `start_midi_listener_unified(midi_port=0)`
  (default port 0 — decision A1 of the MIDI refactor revised plan).
- **Python `MidiListener`** (legacy) — `pianoidMidiListener.py` class with YAML
  keyboard config and advanced features (mode pad, per-note CC). Not wired in
  the current startup path; retained for reference and for the per-note CC
  handlers that have not yet been migrated to the unified path. The class also
  serves as the rtmidi adapter used by `MIDI_listener_unified` (which
  constructs it with `parent=Pianoid` and uses `select_port` / `get_message`).

A C++ `MidiInputListener` class was previously planned and documented, but the
supporting source files were never committed. It has been removed from the docs
(Tranche A / M5); any low-latency C++ MIDI listener will be re-introduced under
a future migration step (review §6 M4).

Supporting file:
- `midi_commands.py` — lower-level `MidiCommand` and `MidiProcessor` classes (command data structure and a command-queue processor)

---

## MIDI Pipeline

```
  MIDI Device (keyboard, controller)
         |
         | rtmidi hardware port (port 0)
         v
  +---------------------+
  |   MidiListener      |
  |   start() loop      |  polls midi_in.get_message() every 10 ms
  |                     |
  |  midi_data[0] = raw command byte
  |  command = midi_data[0]
  |  channel  = command & 0x0F  (+1)
  |  pitch    = midi_data[1]
  |  velocity = midi_data[2]
  +---------------------+
         |
         | perform_action(command, pitch, velocity)
         |   -> get_function_name(command, pitch)
         |   -> looks up commands_dict[command][pitch]
         |   -> calls self.<action_name>(pitch, velocity)
         v
  +----------------------------+
  |  Action dispatch           |
  |  (YAML keyboard config)    |
  |  note_on / note_off        |
  |  sustain                   |
  |  main_volume / deck_feedback|
  |  mode_pad                  |
  |  etc.                      |
  +----------------------------+
         |
         | For NOTE_ON / NOTE_OFF (command 128/144):
         | self.play = True
         | midi_command = [1, pitch, 0, 0, dumper, velocity]
         v
  pianoid.pianoid.processMidiPoints(midi_command, index)
         |
         v
  CUDA string simulation engine
  (C++ extension: pianoidCuda)
```

---

## Unified ingress (W1 Phase 0)

The unified ingress path uses two surfaces, both wired in `pianoid.py`:

### `Pianoid.__init__(*, emit_midi_callback=None, ...)`

`emit_midi_callback` is a keyword-only constructor parameter (decision A2 — inject the callback explicitly at construction; do **not** rely on dynamic introspection or try/except imports). Signature `(command: int, pitch: int, velocity: int) -> None`. Invoked from the unified MIDI listener thread AFTER `schedule_event` has handed the event to the cycle-aligned `RealTimeEventBuffer`, so callback latency does not block audio. The default in standalone Pianoid usage is `None` (no broadcast). When the backend constructs Pianoid via `pianoid.initialize(...)`, `backendServer.py` injects `emit_midi_note_event` — a thin wrapper around `socketio.emit('midi_note_event', {command, pitch, velocity})` — so Socket.IO clients receive every observed inbound MIDI byte. Phase 2 (W3) will add a broadcast on/off toggle without changing the listener.

### `Pianoid.start_realtime_playback(with_midi_listener=False, midi_port=0)`

`midi_port` is the rtmidi input-port index opened when `with_midi_listener=True`. Default `0` (A1). The same `midi_port` argument is propagated through `start_realtime_playback_unified` and `start_midi_listener_unified` to `MIDI_listener_unified` itself.

### `Pianoid.list_midi_ports()`

Stateless rtmidi probe — opens a transient `rtmidi.MidiIn()`, reads `get_ports()`, discards. Safe before `init_pianoid` and from any thread. Backs `GET /midi/ports`.

### `Pianoid.request_port_switch(new_port)`

Queues an in-place port switch consumed by the listener thread at the top of its next iteration. Returns `True` if the request was queued (listener alive); `False` if no listener is running. Backs `POST /midi/select_port`. The thread serialises the close + reopen under `_midi_port_lock` so concurrent `request_port_switch` calls always result in a well-defined final port state and never leak file descriptors. `_midi_active_port` reflects the currently-open port (or `None`).

### Listener thread loop

```
listener = MidiListener(parent=self)
listener.select_port(midi_port)           # initial port (default 0)

while self.listen and not self.exception:
    pending = consume(_midi_port_request)  # in-place switch request
    if pending: listener.select_port(pending)

    msg = listener.get_message()
    if msg is None: continue
    status, data1, data2 = msg[0][:3]
    self.schedule_event(status, data1, data2)        # cycle-aligned dispatch

    if self._emit_midi_callback is not None:
        self._emit_midi_callback(status, data1, data2)  # Phase 2 broadcast hook
```

The loop exits cleanly when `self.listen` is set False or `self.exception` is raised; the rtmidi port is closed on exit so the OS releases it for the next listener start.

---

## MidiListener Class

**File:** `pianoidMidiListener.py`

### Constructor: `__init__(self, parent=None, open_port_index=None)`

- `parent`: the `Pianoid` orchestrator instance, or `None` for standalone use. When `None` the listener uses the full piano pitch range 21–108 and skips YAML keyboard config loading — suitable for the unified ingress path that does not need YAML-based action dispatch.
- `open_port_index`: when a non-negative int, the constructor immediately opens that rtmidi input port and (if `parent` was provided) loads the YAML keyboard config matching the port's device name. When `None` (default), no port is opened — callers must invoke `select_port(idx)` explicitly. This avoids the previous double-open in `__init__` and lets the unified ingress decide port selection at runtime.

### Port management methods

- `print_ports()` — prints the rtmidi input-port table.
- `ports` property — returns the rtmidi input-port name list (live read).
- `select_port(port_index)` — closes any previously-open port, opens `port_index`, loads the matching YAML keyboard config when `parent` was provided. Raises `RuntimeError` if no ports are available or the index is out of range.
- `get_message()` — thin wrapper around `rtmidi.MidiIn.get_message()`; returns the `(data, delta_time)` tuple or `None` when no message is pending.
- `stop()` — closes the open port (if any) and stops the C++ application when `parent` was provided.

### Core Methods

| Method | Description |
|--------|-------------|
| `start()` | Main polling loop (legacy YAML-keyboard path). Runs while `pianoid.isApplicationRunning()`. Reads messages at 10 ms intervals, dispatches via `perform_action`, sends note events to CUDA. Caller must have invoked `select_port(idx)` first; the constructor no longer opens port 0 implicitly. |
| `stop()` | Closes MIDI port (when one is open) and, if `parent` was provided, calls `pianoid.pianoid.stopApplication(True)`. |
| `set_keyboard(keyboard_name)` | Looks up keyboard name in `KEYBOARD_CONFIG` dict, loads YAML config via `read_config()`. |
| `read_config(file_name, pitches_in_preset)` | Parses YAML keyboard config into `self.keyboard_config` and `self.commands_dict`. Handles pitch values: integer, `"any"` (0–127), or `"range"` (pitch-indexed range). |
| `save_config()` | Writes current `keyboard_config` back to the YAML file. |
| `update_entry(key, subkey, new_value)` | Modifies a single entry in `keyboard_config`. |
| `perform_action(command, pitch, velocity)` | Resolves action name via `get_function_name`, calls `self.<name>(pitch, velocity)`. |
| `get_function_name(command, pitch)` | Looks up `commands_dict[command][pitch]`, returns `"action_not_assigned"` if not found. |
| `get_all_actions()` | Returns list of action names from `keyboard_config`. |
| `config_keyboard()` | Interactive CLI utility: starts a configuration-mode listener thread and runs a menu-driven editor, then optionally saves. |
| `start_configuration_mode()` | Polling loop for the keyboard config utility; prints raw MIDI messages. |
| `stop_configuration_mode()` | Exits the configuration-mode loop. |

### MIDI State Variables

| Variable | Description |
|----------|-------------|
| `self.active_pitch` | Last pressed pitch (for per-note CC controls) |
| `self.dumper` | Damper value: `1` when note is held, `127` when released |
| `self.velocity` | Last MIDI velocity value |
| `self.mode_panel` | Current mode panel offset (for mode pad navigation) |
| `self.first_mode_in_panel` | First mode pitch currently shown in the mode pad |

---

## MIDI Action Methods

All action methods share the signature `(self, pitch, velocity)`.

| Action | MIDI trigger | Behavior |
|--------|-------------|----------|
| `note_on` | command 144, velocity > 0 | Sets `dumper=1`, updates `active_pitch`, sets `self.play=True` |
| `note_off` | command 128 or 144+vel=0 | Sets `dumper=127`, velocity=0, calls `get_result_from_pianoid(100)`, sets `self.play=True` |
| `pitch_wheel` | command 224 | Scales tension of all strings by `1 + (velocity-64)/64/10`, pushes to CUDA |
| `sustain` | CC sustain | Sends `processSustain(127 - velocity)` to CUDA |
| `main_volume` | CC 7 | Calls `pianoid.set_volume_level(velocity)`; falls back to `set_volume(velocity)` |
| `deck_feedback` | CC 74 (Brightness) | Exponential mapping: 64→1.0, 127→8.0, 0→0.125; calls `set_deck_feedback_coefficient` |
| `note_volume` | assigned CC | `exp(velocity/8)` volume coefficient for `active_pitch` |
| `note_pitch` | assigned CC | `1.002^(velocity-64)` tension coefficient for `active_pitch` |
| `note_dispersion` | assigned CC | Maps velocity to Jung modulus (0–20000) for `active_pitch` |
| `note_decrement` | assigned CC | `exp((velocity-64)/8)` gamma for `active_pitch` |
| `note_tension_offset` | assigned CC | Maps velocity to tension offset `(velocity-127)/2048` for `active_pitch` |
| `main_feedin` | assigned CC | `exp((velocity-64)/8)` feedin coefficient for all strings |
| `main_feedback` | assigned CC | `-exp((velocity-64)/2)` feedback coefficient for all strings |
| `mode_pad` | note in mode range | Calls `pianoid.play_mode(pitch - first_mode_in_panel)` |
| `mode_pad_one_command` | note in mode range | Combines mode_pad on note-on and mode_pad_release on note-off |
| `mode_pad_shift_up` | assigned note | Scrolls mode panel up by `num_mode` steps |
| `mode_pad_shift_down` | assigned note | Scrolls mode panel down by `num_mode` steps |
| `filter_on` | assigned note | Enables FIR filter |
| `filter_off` | assigned note | Disables FIR filter |
| `save_file` | assigned note | Prompts for filename and calls `pianoid.save_preset(path)` |
| `reset_pianoid` | assigned note | Calls `pianoid.reset()` |
| `stop_pianoid` | assigned note | Calls `self.stop()` |
| `note_not_assigned` | note outside preset | Prints warning, no action |
| `action_not_assigned` | unknown CC | No-op |

---

## midi_commands.py

Provides a command data structure and a command-queue processor. These are lower-level utilities; the active listener in `pianoidMidiListener.py` does not use them directly.

### `MidiCommand`

| Method | Description |
|--------|-------------|
| `__init__(comNo, pitch, velocity)` | Stores the three MIDI bytes |
| `set_velocity(velocity)` | Updates velocity |
| `isNote()` | Returns `True` if `comNo` is 128 (NOTE_OFF) or 144 (NOTE_ON) |
| `signature()` | Returns `"<comNo>p<pitch>"` string for use as dict key |

### `MidiProcessor`

Manages a `command_stack` and dispatches commands to caller-provided handlers.

| Method | Description |
|--------|-------------|
| `__init__(available_notes, noteOn, noteOff, controls)` | Opens MIDI port 0. `controls` is a dict mapping `signature()` strings to handler functions. |
| `get_note()` | Reads one message from `midi_in`, validates note availability, pushes to `command_stack`. |
| `process_command()` | Pops from `command_stack`; dispatches to `noteOn`/`noteOff` for notes, or to `controls[signature]` for CCs. Returns `(handler_fn, kwargs)`. |

---

## Keyboard Configuration

`MidiListener` loads a YAML file that maps MIDI command+pitch combinations to action names. The `commands_dict` built from the file has structure:

```
{
  144: {pitch_0: "note_on", pitch_1: "mode_pad", ...},
  128: {pitch_0: "note_off", ...},
  176: {cc_pitch: "main_volume", ...}
}
```

Pitches not present in the preset are remapped to `"note_not_assigned"` during config load.
