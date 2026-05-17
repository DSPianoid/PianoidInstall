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

## Runtime lifecycle (W3 Phase 2)

The Phase 2 ingress-activation milestone added two backend knobs and a runtime helper that let the listener be (a) on by default for tuning sessions and (b) hot-toggled at any time without rebooting the synthesis engine.

### Default-on at startup

| Surface | What it does | How to override |
|---|---|---|
| Frontend `useSettings.js` `DEFAULT_SETTINGS.listen_to_midi` | Fresh installs ship with `1` so the listener starts with the engine. | Existing users keep their saved value. Toggle in the Settings panel (also writes to localStorage). |
| Backend env var `PIANOID_LISTEN_TO_MIDI` | Read inside `/load_preset` per request. `"0"` or `"1"` overrides the request body's `listen_to_midi`. | Set the env var before launching the backend (e.g. `set PIANOID_LISTEN_TO_MIDI=0` for headless tests that don't want rtmidi noise). |
| `/load_preset` request body `listen_to_midi` | Final fallback when the env var is unset. | Use the frontend toggle (default 1) or supply any value via curl. |

Precedence (highest → lowest): env-var override → request body → backend default (=0 if `listen_to_midi` is missing from the request entirely, but the frontend always sends a value).

### Runtime control endpoints

`POST /midi/start` and `POST /midi/stop` flip the listener on / off without re-issuing `/load_preset` (which would destroy and rebuild the GPU engine). Both are idempotent. See `REST_API.md` for the full request / response schemas.

| Endpoint | Effect | Backed by |
|---|---|---|
| `POST /midi/start {"port": N}` | If listener is idle, calls `Pianoid.start_midi_listener_unified(midi_port=N)`. If running, returns current state — does NOT re-spawn (would race for the rtmidi port). | `pianoid.start_midi_listener_unified` |
| `POST /midi/stop` | If listener is running, calls `Pianoid.stop_midi_listener()` — sets `self.listen = False`, joins `_midi_thread` (1 s timeout). If idle, returns current state. | `pianoid.stop_midi_listener` (Phase 2 addition) |

### `Pianoid.stop_midi_listener(join_timeout=1.0)`

Idempotent helper added in Phase 2. Mirrors the stop sequence already used by `Pianoid.stop_playback()` (set `self.listen = False`, join the thread) but **does not** stop the synthesis engine or audio driver — it only releases the rtmidi port and reaps the listener thread. Returns `True` when a running listener was stopped, `False` when nothing was running. Backs `POST /midi/stop`.

The emit callback (`_emit_midi_callback`, constructor-injected in Phase 0) is captured once at thread startup (`pianoid.py:1533`) into a loop-local `emit_callback` variable. W4 Phase 3 added the broadcast on/off gate inside the helper itself (not inside the loop-local capture): the helper reads `pianoid.get_midi_broadcast_enabled()` per call, so the toggle takes effect on the next inbound byte without restarting the listener thread.

---

## Broadcast on/off gate (W4 Phase 3)

The W4 Phase 3 milestone added a runtime broadcast toggle to suppress the `midi_note_event` Socket.IO stream without stopping the listener thread or synthesis engine. Two new filters live in `backendServer.emit_midi_note_event(...)`:

1. **Note-only filter.** Only NOTE_OFF (status `128`-`143`) and NOTE_ON (status `144`-`159`) survive. CC (sustain CC#64 included), program-change, pitch-wheel, aftertouch, and sysex are dropped — they have no place on a "last note pressed" indicator stream. Sustain still drives synthesis via `schedule_event(...)`; the drop is on the emit path only.
2. **Broadcast on/off gate.** Reads `pianoid.get_midi_broadcast_enabled()` per call. Default `True` on every fresh `Pianoid` init (so existing behaviour is preserved). Falsy short-circuits the emit. Toggled via `POST /midi/broadcast {"enabled": bool}` — see `REST_API.md`.

### State location

The flag lives on the running `Pianoid` instance (`self._midi_broadcast_enabled`, default `True`, atomic bool, no lock — single bool read/write is atomic in CPython and a one-cycle race is harmless). This makes the backend the **single source of truth** for both `listening` and `enabled`.

### Frontend ownership

The frontend (`PianoidTunner/src/components/MidiComponent.jsx`) bootstraps state from `GET /midi/ports` and `GET /midi/broadcast` on mount and on `presetVersion` bumps, then issues optimistic POSTs on toggle (mirroring the `useFixVelocity` pattern). The user-facing surface in the MIDI pane has three control rows:

- **Listener row** — start/stop button (`POST /midi/start` / `POST /midi/stop`), listening chip, port select (`POST /midi/select_port`), refresh ports button.
- **Broadcast row** — Switch wired to `POST /midi/broadcast`; chip shows current state.
- **Command-display log** — subscribes to the `midi_note_event` Socket.IO stream and shows the most recent 200 events (when broadcast is OFF, this stream stops too — log idles).

`useMidi.js` is the React hook that owns `midiKeysDown`, `midiLastKeyDown`, `midiLastKeyUp`, and `midiIsConnected` state for the rest of the frontend (virtual-piano highlight in `PianoidTuner.js:1433+`, pitch auto-select at line 1394, toolbar status pill at line 2360). Web MIDI is feature-flagged off (`ENABLE_WEB_MIDI = false`); the hook subscribes to the same `midi_note_event` Socket.IO stream and populates the same shape, so the consumers continue to work without modification when the backend listener owns ingress.

`useSettings.js` adds `midi_broadcast_enabled: true` to `DEFAULT_SETTINGS.presetLoadSettings`. This is a UI preference for fresh installs only — the canonical source remains the backend, which bootstraps via `GET /midi/broadcast` on every preset load. Existing users keep their stored value via the migration block.

---

## Validation (W5 Phase 4)

The W5 Phase 4 gate closed Sequence A of the MIDI refactor with a regression
suite covering every layer the W1-W4 waves touched. All tests render through
the deterministic offline path (`runOfflinePlayback`, audio_off) or drive the
ingress contract directly — no audio driver, no hardware MIDI port.

| Test file | Layer | What it locks down |
|---|---|---|
| `tests/system/test_kernel_midi_batch.py` | CUDA kernel (W1 Phase 1) | Per-cycle batch envelope: same-cycle 2-/12-note chords, NOTE_ON+NOTE_OFF, NOTE_ON+TEST_STRING_ONLY, NOTE_ON+TEST_MODE_ONLY, 300-event `MAX_EVENTS_PER_CYCLE` overflow. |
| `tests/system/test_backend_midi_ingress.py` | Middleware ingress (W1 P0 / W3 P2 / W4 P3) | `emit_midi_note_event` note-only filter (16 channels; CC / program-change / pitch-wheel / sysex dropped), broadcast switchability (off → no `socketio.emit`, on → resumes), `schedule_event` dispatch incl. a 4-note × 20-rep chord stress with 0 drops. |
| `tests/system/midi_latency.py` | Ingress hot path | Dispatch-leg latency: `schedule_event` median / 95p / 99p over 2000 events + a 4-note chord-burst measurement. Standalone (`python tests/system/midi_latency.py`) or one pytest test asserting the Gate 3 budget (median < 7 ms, 99p < 12 ms). |

**Latency legs.** The press-to-sound path has three legs: (1) rtmidi hardware
poll pickup, (2) `schedule_event` → `RealTimeEventBuffer.pushEvent`, (3) cycle
drain → kernel → audio out. `midi_latency.py` measures leg 2 — the only leg
the refactor changed and the only one deterministically measurable without
audio hardware. Leg 1 needs a physical MIDI keyboard or a `loopMIDI` virtual
cable (rtmidi's Windows winmm backend has no programmatic virtual port), so it
is a manual sign-off item. Leg 3 is fixed engine geometry
(`samples_per_cycle / sample_rate`).

**TEST_MODE_ONLY coverage.** The same-cycle NOTE_ON + TEST_MODE_ONLY tests
self-skip when the `TEST_MODE_ONLY` EventType is not pybind-bound — it is
C++-only until Sequence B / Phase 5 binds it. The kernel-level fix is still
exercised through the C++ offline path; only the Python-driven variant skips.

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
