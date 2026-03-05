# pianoid_middleware — MIDI System

## Overview

The MIDI system consists of two files:

- `pianoidMidiListener.py` — the active listener that reads hardware MIDI input, maps events to actions, and pushes note events into the CUDA engine
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

## MidiListener Class

**File:** `pianoidMidiListener.py`

### Constructor: `__init__(self, parent=None)`

- `parent`: the `Pianoid` orchestrator instance. If `None`, uses full pitch range 21–108.
- Opens MIDI port 0 via `rtmidi.MidiIn`.
- Reads the device name from the first available port and calls `set_keyboard(keyboard_name)` to load the YAML config.

### Core Methods

| Method | Description |
|--------|-------------|
| `start()` | Main polling loop. Runs while `pianoid.isApplicationRunning()`. Reads messages at 10 ms intervals, dispatches via `perform_action`, sends note events to CUDA. |
| `stop()` | Closes MIDI port and calls `pianoid.pianoid.stopApplication(True)`. |
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
