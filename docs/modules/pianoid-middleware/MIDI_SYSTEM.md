# pianoid_middleware — MIDI System

## Overview

Two MIDI listener implementations exist:

- **Python `MIDI_listener_unified`** (active) — defined in
  `pianoid_middleware/pianoid.py`. Uses `rtmidi` via the helper in
  `pianoidMidiListener.py` to read MIDI bytes, then pushes NOTE / SUSTAIN events
  to the C++ `RealTimeEventBuffer`. Started by `start_midi_listener_unified(midi_port=None)`
  (None = the user's saved port, else auto-detect — dev-392a, [Input port](#input-port-saved-port-and-auto-detect-dev-392a); was port 0, decision A1).
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

### `Pianoid.start_realtime_playback(with_midi_listener=False, midi_port=None)`

`midi_port` is the rtmidi input-port index forced when `with_midi_listener=True`. Default `None` = saved port, else auto-detect (dev-392a; was `0`). The same `midi_port` argument is propagated through `start_realtime_playback_unified` and `start_midi_listener_unified` to `MIDI_listener_unified` itself.

### `Pianoid.list_midi_ports()`

Stateless rtmidi probe — opens a transient `rtmidi.MidiIn()`, reads `get_ports()`, discards. Safe before `init_pianoid` and from any thread. Backs `GET /midi/ports`.

### `Pianoid.request_port_switch(new_port)`

Queues an in-place port switch consumed by the listener thread at the top of its next iteration. Returns `True` if the request was queued (listener alive); `False` if no listener is running. Backs `POST /midi/select_port`. The thread serialises the close + reopen under `_midi_port_lock` so concurrent `request_port_switch` calls always result in a well-defined final port state and never leak file descriptors. `_midi_active_port` reflects the currently-open port (or `None`).

### Listener thread loop

```
listener = MidiListener(parent=self)
ports.start(midi_port)                    # forced / saved / auto-detect (midi_port_select.PortController)

while self.listen and not self.exception:
    pending = consume(_midi_port_request)  # in-place switch request
    if pending: listener.select_port(pending)

    msg = listener.get_message()
    if msg is None:
        time.sleep(MIDI_IDLE_SLEEP_S)   # 1 ms — NEVER a bare `continue` (see below)
        continue
    status, data1, data2 = msg[0][:3]
    self.schedule_event(status, data1, data2)        # cycle-aligned dispatch

    if self._emit_midi_callback is not None:
        self._emit_midi_callback(status, data1, data2)  # Phase 2 broadcast hook
```

The loop exits cleanly when `self.listen` is set False or `self.exception` is raised; the rtmidi port is closed on exit so the OS releases it for the next listener start.

**Idle wait, not a spin (dev-c6b6, 2026-10-20, bug R3).** rtmidi's `get_message()` is a non-blocking C call that keeps the GIL. With a bare `continue`, the listener thread held the GIL almost permanently, so every GIL release in any other thread (a numpy ufunc, a stdout write, socket I/O) waited a full 5 ms switch interval. Parameter writes, which run under `cuda_lock`, became 20-30x slower: `excitation/from21to108` took 16-30 s with the listener on and 0.75-1.1 s with it stopped; `mode/from0to195` took 3.5-5 s vs 0.12 s. The queued writes then filled the browser's 6-connections-per-host pool, so every route (`/health`, `/midi/ports`) looked frozen for up to 179 s. The loop now drains every pending message and sleeps `MIDI_IDLE_SLEEP_S` (1 ms requested, about 1-3 ms on Windows) only when nothing is pending. rtmidi queues messages between polls, so none are lost. Regression test: `tests/unit/test_midi_listener_idle_gil.py`. An unmapped status (for example CC `178` from a controller that streams it) is logged **once** per process instead of on every message.

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
| `POST /midi/start {"port": N}` | If listener is idle, calls `Pianoid.start_midi_listener_unified(midi_port=N)` (no `port` = saved port / auto-detect, dev-392a). If running, returns current state — does NOT re-spawn (would race for the rtmidi port). | `pianoid.start_midi_listener_unified` |
| `POST /midi/stop` | If listener is running, calls `Pianoid.stop_midi_listener()` — sets `self.listen = False`, joins `_midi_thread` (1 s timeout). If idle, returns current state. | `pianoid.stop_midi_listener` (Phase 2 addition) |

### `Pianoid.stop_midi_listener(join_timeout=1.0)`

Idempotent helper added in Phase 2. Mirrors the stop sequence already used by `Pianoid.stop_playback()` (set `self.listen = False`, join the thread) but **does not** stop the synthesis engine or audio driver — it only releases the rtmidi port and reaps the listener thread. Returns `True` when a running listener was stopped, `False` when nothing was running. Backs `POST /midi/stop`.

The emit callback (`_emit_midi_callback`, constructor-injected in Phase 0) is captured once at thread startup (`pianoid.py:1533`) into a loop-local `emit_callback` variable. W4 Phase 3 added the broadcast on/off gate inside the helper itself (not inside the loop-local capture): the helper reads `pianoid.get_midi_broadcast_enabled()` per call, so the toggle takes effect on the next inbound byte without restarting the listener thread.

---

## Broadcast on/off gate (W4 Phase 3)

The W4 Phase 3 milestone added a runtime broadcast toggle to suppress the `midi_note_event` Socket.IO stream without stopping the listener thread or synthesis engine. Two new filters live in `backendServer.emit_midi_note_event(...)`:

1. **Note-only filter.** Only NOTE_OFF (status `128`-`143`) and NOTE_ON (status `144`-`159`) survive. CC (sustain CC#64 included), program-change, pitch-wheel, aftertouch, and sysex are dropped — they have no place on a "last note pressed" indicator stream. Sustain still drives synthesis via `schedule_event(...)`; the drop is on the emit path only. Every message (CC, pitch bend, sysex, ...) goes to the MIDI monitor through the separate `midi_message` stream ([below](#pedal-mapping-and-the-midi-monitor-dev-ped1)), gated by the same switch.
2. **Broadcast on/off gate.** Reads `pianoid.get_midi_broadcast_enabled()` per call. Default `True` on every fresh `Pianoid` init (so existing behaviour is preserved). Falsy short-circuits the emit. Toggled via `POST /midi/broadcast {"enabled": bool}` — see `REST_API.md`.

### State location

The flag lives on the running `Pianoid` instance (`self._midi_broadcast_enabled`, default `True`, atomic bool, no lock — single bool read/write is atomic in CPython and a one-cycle race is harmless). This makes the backend the **single source of truth** for both `listening` and `enabled`.

### Frontend ownership

The frontend (`PianoidTunner/src/components/MidiComponent.jsx`) bootstraps state from `GET /midi/ports` and `GET /midi/broadcast` on mount and on `presetVersion` bumps, then issues optimistic POSTs on toggle (mirroring the `useFixVelocity` pattern). The user-facing surface in the MIDI pane has three control rows:

- **Listener row** — start/stop button (`POST /midi/start` / `POST /midi/stop`), listening chip, port select (`Auto` + ports; `POST /midi/select_port`, persisted, dev-392a) with the auto / manual chip, refresh ports button.
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
- `replace_port(port_index)` (dev-392a) — opens `port_index` on a fresh rtmidi input FIRST, then releases the old port; a failed open raises and leaves the old port open.
- `close_port()` (dev-392a) — releases the open port and nothing else. `stop()` is the legacy YAML-path shutdown: it ALSO calls `pianoid.stopApplication(True)` and must never be used to switch ports.
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
| `pitch_wheel` | command 224 | Bends every key pitch's tension to `base × (1 + (velocity-64)/64/10)`, `base` = the tensions captured when the wheel left its centre (repeated messages never compound; 64 restores them exactly). ONE batched `string` edit through the parameter write machinery (`Pianoid.update_parameter` → `edit_commit.commit`: guard, Layer B, `state_changed{string}` with `source.kind = midi_cc`). Fixed dev-960f (was a broken direct engine write: `getAllSt0rings` + `setUpdatedParameters`) |
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

## Channels and the sustain pedal (dev-6f0c)

**Omni decode.** `midi_to_event_type` (and the `schedule_event` lifecycle gate / Fix-MIDI clamp) read the message TYPE from the status high nibble and ignore the channel: NOTE_ON `0x90-0x9F`, NOTE_OFF `0x80-0x8F` (or NOTE_ON velocity 0), CC64 sustain `0xB0-0xBF`. Before dev-6f0c the decode matched exact bytes: notes on channel 1 only (`144`/`128`) and the pedal on channels 1-3 only (`176-178`), so a keyboard set to channel 2+ played nothing and a pedal on channel 4+ was ignored (measured on the pre-fix code: `0x99`/`0x89` and `0xB3 64` returned `None`). The engine has one instrument and one pedal, so the channel has no meaning there. Other CCs (e.g. `0xB2 1 x` = mod wheel on channel 3, the source of the `Unknown MIDI command: 178` log line) are still dropped; the log line itself is reported once per status (dev-c6b6).

**Pedal semantics — continuous since dev-pedal1.** `sustain_engine_value` passes the value on (clamped to 0-127) on the live path, the old `/midi_playback`, the offline MidiRecord render, WebSocket `/play` and the MIDI player; the engine grades the dampers: [Half pedal](#half-pedal-dev-pedal1). History: dev-6f0c made it a switch at 64 on purpose, because the old law `int(((127 - v) * dumper_position)^0.6)` left every `v < 127` at >= 1 damper step and one step already damped a released string almost like 18 (BaselinePreset1, p60, level at 1.0 s, `dev-6f0c-sustain-player-live.py --only half_sweep`: v = 0 / 32 / 64 / 96 / 110 / 118 / 122 / 125 gave −45.8 / −45.8 / −46.0 / −47.3 / −48.2 / −49.3 / −48.3 / −42.4 dB, only v = 127 sustained, −16.2 dB).

| Live measurement (dev-6f0c, ring, p60) | Result |
|---|---|
| no pedal, key 200-700 ms | −45.8 dB at 1.0 s, floor −60 by 1.4 s |
| pedal down (0xB2, ch3) | −16.2 dB at 1.0 s, −26.2 at 2.4 s; pedal up at 2.5 s -> −53 dB by 2.7 s (−28 dB/s) |
| pedal ch5 + notes ch10 (0xB4 / 0x99 / 0x89) | identical to ch3 (all bytes accepted; pre-fix they were dropped) |
| re-strike while sustained (2nd NOTE_ON at 1.5 s) | jumps to −8.1 dB at 1.8 s, rings until pedal up at 3.0 s, then −55 dB by 3.4 s |
| key held through pedal-up (pedal up 1.0 s, key off 2.5 s) | note keeps sounding (−35 dB at 2.2 s vs −60 pedal up) and stops at the key release; pedal down adds ~5 dB of sympathetic ringing while the key is held (−13.9 vs −18.8 dB at 0.6 s) |

**What a real pedal needs:** a sustain pedal plugged into the keyboard (or a MIDI interface); select that device's input port in the MIDI panel (`POST /midi/select_port`) and start the listener (`listen_to_midi=1` or `POST /midi/start`). No channel setting is needed for a standard pedal. A pedal that sends another CC than 64, sends 0 when pressed, or shares its CC with other pedals on other channels is mapped in the MIDI panel's pedal row ([below](#pedal-mapping-and-the-midi-monitor-dev-ped1)). Switch and continuous pedals both work, on every map: [Half pedal](#half-pedal-dev-pedal1).

## Pedal mapping and the MIDI monitor (dev-ped1)

**Why (2026-10-22, "MIDI input does not see a pedal pressed").** The panel's log was the note-only `midi_note_event` stream, so a pedal message could never be seen. Measured on the user's live backend log: keys on port 2 `MIDIIN2 (AMC-10)` (the device also exposes port 1 `AMC-10`); while the user tried the pedal the only non-note messages were CC#0 (Bank Select) on channels 1, 2 and 3 (`Unknown MIDI command: 176/177/178, pitch: 0`, logged once per status). CC64 is decoded silently, so the log cannot say whether it ever arrived.

| Piece | File | Concern |
|---|---|---|
| `MidiInputHub` (process singleton, `shared_hub()`) | `midi_input.py` | sole owner of the pedal settings (`sustain_cc` default 64, `sustain_channel` default `null` = any, `polarity` normal / inverted, `show_realtime`, `monitor_all_ports`; persisted to `$PIANOID_MIDI_SETTINGS` or `<PianoidInstall>/midi/midi_input_settings.json`), the sustain state the engine was last sent, the monitor sink; `describe_message` decodes every MIDI type |
| Listener loop | `pianoid.MIDI_listener_unified` | `hub.map_message`: the sustain source (configured CC on the configured channel, or any channel) -> CC64 after polarity (`127 - v` when inverted): the default CC64 pedal passes its value (engine switch at 64), a remapped one is `127` / `0` from the hysteresis switch; any other CC64 is dropped; system messages (`0xF0`-`0xFF`) never reach the engine; after the dispatch `hub.publish` sends the monitor record |
| rtmidi adapter | `pianoidMidiListener.py` | `ignore_types(sysex=False, timing=False, active_sense=False)` on the played port; `MidiPortTaps` opens the other input ports for the monitor only (a busy port is skipped), re-synced on a port switch |
| REST + stream | `midi_input_routes.py` | `GET`/`POST /midi/input`, Socket.IO `midi_message` ([REST_API](REST_API.md#get-midiinput)); registry `midi.input_settings` / `midi.set_input_settings` |
| UI | Tunner `MidiPedalRow.jsx`, `MidiMonitorLog.jsx`, `useMidiInput.js` | PEDAL DOWN/UP chip, Sustain CC, Ch (Any / 1-16), polarity, clock and all-ports switches; the monitor rows (time, port, `*` = tapped port, channel, label, raw hex) |

**How to read the monitor for a pedal.** Press and release the pedal: (a) rows `B? 40 7F` / `B? 40 00` = a standard CC64 pedal, the chip follows; (b) rows with another CC (e.g. `B2 00 7F` = CC 0 Bank Select) = set Sustain CC to that number; (b2) the same CC from several pedals on different channels (or one channel that flickers with nothing pressed) = set Ch to the channel that moves when THE pedal moves; (c) value 0 on press and 127 on release = set Inverted; (d) rows only with `*` in the port column = the pedal comes on another input port than the keys (select that port); (e) nothing at all = the pedal never reaches the computer (keyboard setting / cable). Polarity auto-detect was not added: most pedals send nothing at rest, so the first value seen is a press and would invert a normal pedal.

**Verification.** `tests/unit/test_midi_input.py` (no engine, no pianoidCuda, fake rtmidi): every message type decoded, CC64 on all 16 channels, the hysteresis switch, inverted polarity, remapped CC, the channel filter, a replay of the real AMC-10 capture (`tests/unit/fixtures/amc10_pedal_capture.json`), system messages kept from the engine, persistence, the listener loop (monitor record per message, taps monitor-only, port-switch re-sync) and the REST shell. `tests/conftest.py` points `PIANOID_MIDI_SETTINGS` at a temp file, so the machine's own pedal map never reaches a test. Live: press the pedal with the panel open.

### Pedal channel and hysteresis (dev-392a)

**Why (2026-10-23, "set sustain to the right pedal").** Measured on the user's AMC-10 (port 2 `MIDIIN2 (AMC-10)`, MIDI monitor capture): all three pedal inputs send **CC#0** and differ only by channel, and all are continuous and reversed.

| Source | Status | At rest | Fully pressed | Role |
|---|---|---|---|---|
| Right pedal | `B1` (ch2) CC#0 | 125-127 | 4-7 | **sustain** |
| Left pedal | `B0` (ch1) CC#0 | 118-124 | 0 | not used (engine has no soft pedal) |
| Floating input | `B2` (ch3) CC#0 | flickers 41 / 42 at 10-25 Hz | - | noise |

With `sustain_cc = 0` on any channel, the left pedal also drove sustain and the ch3 noise (41 / 42 -> 86 / 85 inverted) held it down. Hence the **`sustain_channel`** setting (`null` = any channel, the default and the old behaviour; 1-16 = only that channel) and the map for this keyboard: **`sustain_cc = 0`, `sustain_channel = 2`, `polarity = inverted`** (persisted in `<PianoidInstall>/midi/midi_input_settings.json`).

**Rules of the live map (`MidiInputHub.map_message`).**

| Message | To the engine |
|---|---|
| The sustain source (default or remapped) | CC64 with the value after polarity (dev-pedal1; dev-392a sent a remapped pedal as 127 / 0). The source CC itself is never forwarded. A value that does not change the engine pedal is dropped |
| Any other CC64 (another channel, or `sustain_cc` is not 64) | dropped: the source is the only sustain owner, so `sustain_down` is always what the engine was sent |
| Other CCs (e.g. the left pedal's CC#0) | unchanged (the engine ignores them) |

**Indicator.** `sustain_down` (the PEDAL DOWN/UP chip) has hysteresis so it does not flutter: from up, down at >= 64 (MIDI 1.0); from down, up at <= 54. It does not touch the sound. Remapped pedals are continuous too because what the 74 / 54 switch protected against is gone: the channel filter removes the ch3 noise, and the curve's dead zones absorb the AMC-10's ends (rest 0-2, pressed 120-123 after polarity). The AMC-10 right pedal therefore half-pedals as well.

**Replay of the capture** (`test_capture_replay_*`): with the AMC-10 map the 3 855 played-port messages give exactly one pedal down and one pedal up, both from `B1`; the 122 left-pedal and 3 594 ch3 messages pass with the sustain state untouched; with `sustain_channel = null` the ch3 noise ends the replay with the pedal held down.

**Verification.** Unit level (no engine): `tests/unit/test_midi_player.py` drives the listener loop with a fake rtmidi port (pedal on channel 3, notes on channel 10) and pushes the same bytes through `schedule_event` into a real `RealTimeEventBuffer`. Live: `docs/development/diagnostics/dev-6f0c-sustain-player-live.py` (table above; `--only half_sweep` = the pedal-value sweep), in-process on ASIO. The rtmidi leg itself needs a hardware keyboard or a loopMIDI cable (winmm has no virtual ports).

## Input port: saved port and auto-detect (dev-392a)

**Why (2026-10-23, "MIDI input is a bit of a problem, always resets to UMC1820").** Measured in `PianoidCore/logs/backend_stdout.log`: every `/load_preset` logged `midi_port=0` -> `MIDI listener active (unified mode, port 0)` (port 0 = `UMC1820 MIDI In`); the user picked port 2 (`[MIDI] Switched to port 2`, 2026-10-22 12:57 and 2026-10-23 16:14), and the next loads went back to port 0. Causes: the Tunner never sends `midi_port`, so the route default `0` applied; `/midi/select_port` changed the running listener only; the dev-0a88 reload signature kept re-sending the load's `0`; the browser-saved default port (dev-febatch star, dev-midiinit applier) re-pointed only an ALREADY running listener and raced the asynchronous listener start after a load.

**Rule now (the backend owns the choice: `MidiInputHub.settings['input_port']` + runtime `port_state`; logic in `midi_port_select.py`).** At every listener start:

| Order | Source | Mode |
|---|---|---|
| 1 | `midi_port` in the `/load_preset` request or `port` in `/midi/start` | `forced` (this start only; not persisted, not inherited by later loads) |
| 2 | `input_port`: the port the user picked (Tunner select / `POST /midi/select_port`), persisted by NAME without the rtmidi index suffix, so a re-ordered list still matches | `manual` |
| 3 | nothing saved, or the saved device is unplugged | `auto` |

**Auto-detect.** Every input port is opened; the first port that sends **meaningful** input is played, and the message that decided goes to the engine. The rest stay monitor-only (`midi_message` with `*`) until then. Meaningful = a note-on, a program change, or a CC / pitch bend that moves at least 16 / 1024 from the first value seen on that port. Note-off, aftertouch, clock, active sensing, and sysex never count. A key beats a moved controller that arrives in the same poll. The thresholds come from measurements on the user's AMC-10 (3 captures, ~30 min): its floating CC#0 on channel 3 streams 10-25 Hz with values 40-43 on BOTH ports. A plain "first message wins" would pick it at once. Its left pedal at rest drifts 118-124. Replaying the capture, the detector first fires on the right pedal (B1 value 108), never on the noise (`tests/unit/test_midi_port_select.py`). `POST /midi/select_port {"port": "auto"}` (Tunner: "Auto" in the port select) drops the saved port and detects again at once.

**The AMC-10's two ports.** `AMC-10 1` and `MIDIIN2 (AMC-10) 2` carried identical CC streams in every capture (same counts per status: pedals and the noise). Playing both would double every event, so the listener plays ONE port. The keys were seen on port 2 (dev-ped1 live log); whether port 1 also carries the keys is not yet measured. If a live check shows keys on one port and pedals on the other, the fix is to merge the listener's input across that device's ports, not to pick one (open: needs the live key check, dev-392a report).

**Tie-break (review H1).** When the same deciding message arrives from several ports in one poll (the AMC-10's duplicated CC stream), the controller prefers a port that has delivered note messages during the scan, then a port whose first name word has a keyboard YAML (`KEYBOARD_CONFIG`: VMini / Launchkey / UMX / CASIO), then the first port. Neither AMC-10 name has a YAML, so a pedal press as the very first input picks port 1 `AMC-10`; a key press decides on the port that delivered it. **Pending: live key check of AMC-10 port 1 vs 2.**

**Switching and failures (review C1, M1, M2).** The unified listener releases a port with `MidiListener.close_port()` only. The legacy `stop()` also calls `pianoid.stopApplication(True)`, which ended the synthesis engine when "Auto" was picked from a playing port. A switch to a port opens it on a fresh rtmidi input BEFORE the old port is released (`replace_port`). A failed open, for example a port another program holds, raises; the old port, or the running scan, stays as it was, `port_state` is unchanged, and nothing is persisted. The listener persists `input_port` itself, only after a switch succeeded; `/midi/select_port` only queues the request. The auto scan retries ports it could not open every `SCAN_RETRY_S` (1 s), so a port still held by the previous listener during a preset reload joins the scan.

**UI.** MIDI panel port select: `Auto (first port that plays)`, `Listen to All` ([below](#listen-to-all-dev-midiall)) + the ports. A saved port that is unplugged is shown as `<name> (disconnected)`. The chip next to it shows `AUTO: waiting` / `AUTO: <port>` / `MANUAL` / `FORCED` (`port_state`, pushed as Socket.IO `midi_input_state`). Picking a port persists it, through `/midi/select_port` while listening or `/midi/input {input_port}` while stopped (the hub stores the name without the index suffix, one form for every writer). Picking Auto while already in AUTO does nothing. **Start** sends no port. The old browser-saved default port (star) is no longer read: it could re-pin `UMC1820`. Auto-detect or an explicit pick decides.

## Listen to All (dev-midiall)

**Why (2026-10-29, user: "allow combining midi from different sources ... Listen to All, right after Auto").** Several devices play the one instrument at once: the AMC-10 (keys + pedals; sustain = CC#0 on channel 2, inverted) and the "Pianoid" USB-MIDI controller (FATAR keybed via the FPGA; sustain = standard CC64). The engine takes at most 7 note-ons per cycle and queues the rest, so bursts from several sources are safe.

**Mode `all`** (`POST /midi/select_port {"port": "all"}`, persisted as `input_port: "all"`; Tunner: "Listen to All" right after "Auto"). The listener opens EVERY input port (minus `all_exclude`) and drains them all into the one event path; every message is tagged with its port (the hub's pedal map / bookkeeping / `port_counts`, and the monitor's port column). The single-port path is unchanged apart from carrying its port name with each message.

| Piece | File | Concern |
|---|---|---|
| `MergedInputs` | `midi_merge.py` | the ALL ports: open every port, poll them port by port, `rescan` = open new ports, close vanished ones; a busy port is retried at the next rescan (reported once) |
| `NoteLedger`, `PedalSources` | `midi_merge.py` | who holds which pitch / each source's pedal value and down state |
| `PortController` mode `all` | `midi_port_select.py` | start / switch to / leave ALL; rescan every `SCAN_RETRY_S` (1 s) and on demand (`select_port all` again; Tunner Refresh); `next_message()` -> `(message, port, name)` |
| `MidiInputHub` | `midi_input.py` | `port_sustain` per-port pedal maps (global = fallback), `map_message(data, source)`, the deepest-press pedal, `release_messages`, `port_counts` |

**Rules.**

| Case | Behaviour | Why |
|---|---|---|
| Pedal map | the port's `port_sustain` entry (by name without the index suffix), else the global `sustain_cc` / `sustain_channel` / `polarity` | each device sends its pedal differently |
| Pedals of several sources | the engine pedal is the **deepest press** of the sources (dev-pedal1; the OR of dev-midiall, generalised); a message that does not change it is dropped | a real piano has one pedal; "last event wins" would let a release on one device cut a pedal held on the other |
| Same note from two sources | NOTE_ONs are never deduplicated (each is a strike, the engine re-strikes); a NOTE_OFF is forwarded only when no other source still holds that pitch (A60 on, B60 on, A60 off -> nothing; B60 off -> damped) | the engine damps a pitch on NOTE_OFF whoever struck it; same rule as the MIDI player's note pairing |
| One source | identical to before (every NOTE_OFF forwarded, a stray one too; pedal unchanged) | |
| Hot-plug | rescan every 1 s: a new port is opened, a vanished one closed; ports are named by their stable name (no rtmidi index suffix; a second identical device = `<name> #2`), so tags, `port_counts` and `port_state.ports` do not change when an index shifts | |
| A port stops being played (unplugged, or the user leaves ALL / switches port) | its held keys get NOTE_OFFs and its pedal goes up, each only where no other source still holds it | no stuck notes / pedal from a device that is gone |
| New listener session | the holders are forgotten (`reset_sources`) | a source of a previous session must not hold the OR pedal for good |
| Ordering across ports | port by port within one poll (~1-3 ms); per-port order is kept | rtmidi delta times are per port |

**Exclusions.** No Pianoid code opens a virtual port, and the only MIDI output it opens is the "Pianoid" controller's, for its configuration SysEx ([below](#pianoid-controller-configuration-dev-pctl)), so there is no loopback of our own to exclude. `all_exclude` (names, no index suffix) keeps a port out of ALL. **Default: `["MIDIIN2 (AMC-10)"]`** - the AMC-10 exposes `AMC-10` and `MIDIIN2 (AMC-10)` with identical CC streams in every capture ([above](#input-port-saved-port-and-auto-detect-dev-392a)), so with both every key / pedal would arrive twice. **Not yet confirmed live** (dev-ped1 saw the keys on `MIDIIN2 (AMC-10)`; if port `AMC-10` does not carry them, set `all_exclude` to `["AMC-10"]`): change it with `POST /midi/input {"all_exclude": [...]}` (assistant `midi.set_input_settings`).

**Settings migration.** `tools/migrate_midi_port_sustain.py` (PianoidCore) moves a remapped global pedal map into `port_sustain` for `AMC-10` and `MIDIIN2 (AMC-10)` and puts the global back to the standard (CC64, any channel, normal), the fallback for the Pianoid controller and every other port. Idempotent; run it with no backend running (a running backend rewrites the file from memory).

**Verification.** `tests/unit/test_midi_all_ports.py` (fake rtmidi bus, no engine): two-port merge + tags + counts, persistence, exclusion + busy ports, per-port maps, the OR pedal, the single-source pedal unchanged, the note ledger, hot-plug with releases, periodic / on-demand rescan, leaving ALL, the migration, and the real `MIDI_listener_unified` loop over two fake ports. `tests/unit/conftest.py` refuses any real `rtmidi.MidiIn.open_port` in unit tests. Isolated backend: `docs/development/diagnostics/dev-midiall-isolated-5024.py` (real Flask routes + listener on :5024, virtual MIDI bus, engine recorder; winmm has no virtual ports and loopMIDI is not installed). Live on the real devices: pending.

### Port identity = NAME (dev-midiall, live 2026-10-29)

**Why.** Measured live: ports `[UMC1820 0, AMC-10 1, MIDIIN2 (AMC-10) 2, Pianoid 3]`, manual = `MIDIIN2 (AMC-10) 2`; the "Pianoid" Arduino re-enumerated -> `[UMC1820 0, Pianoid 1, AMC-10 2, MIDIIN2 (AMC-10) 3]`; the backend kept reporting `active_port 2` (now "AMC-10") until a later start re-resolved the name. The rtmidi index is not an identity on Windows.

| Rule | Behaviour |
|---|---|
| Stored form | every port reference (`input_port`, `all_exclude`, `port_sustain` keys) is the NAME without the trailing index (`"Pianoid 3"` -> `"Pianoid"`); a legacy suffixed value is stripped on load; `tools/migrate_midi_port_sustain.py` rewrites the file in that form |
| Single port (manual / forced / auto-picked) | the listener re-reads the port list every `SCAN_RETRY_S` (1 s); a played device whose index changed is reopened at its new index by name (its pending messages are kept); the monitor taps are re-synced |
| Device gone | manual / forced: **waiting for `<name>`** (`port_state.waiting`, Tunner chip `WAITING: <name>`): nothing is played and no other device is used; it is reopened as soon as it is back. Auto: detects again |
| Saved device missing at start | waiting for it (before: silently fell back to auto-detect) |
| ALL | ports keyed by name, so exclusion and the per-port pedal maps follow a device wherever it moves |

Tests: `tests/unit/test_midi_all_ports.py` (`test_manual_port_follows_its_name_when_the_list_reorders` replays the live reorder; waiting / reopen; missing at start; ALL with exclude + pedal maps across the reorder; default exclusion; legacy names).

## Pianoid controller configuration (dev-pctl)

**Why (2026-10-29, user: "In MIDI menu two new controls, applicable to Pianoid controller only: Calibrate Pedal ... Assign Midi Command to Pedal ... and Select Speed").** The "Pianoid" USB-MIDI controller (FATAR keybed → FPGA → Arduino Micro; repo `fatar-midicontroller`) has 8 pedal inputs (X9-X16) and a fast FPGA → Micro link. Their configuration lives **on the device** (Micro EEPROM): calibration, the MIDI message per pedal, the link speed. Pianoid reads and writes it; it stores nothing.

| Piece | File | Concern |
|---|---|---|
| `PianoidController` (process singleton) | `pianoid_controller.py` | the SysEx request / reply client (manufacturer ID `0x7D`): opens the MIDI OUTPUT port `Pianoid`, sends `F0 7D 10 <cmd> ... F7`, waits for `F0 7D 12 <cmd> <status> ...`; the raw ADC stream `F0 7D 13 ...`; decode to dicts; duplicate assignments |
| routes | `pianoid_controller_routes.py` | `/controller/*` ([REST_API](REST_API.md#pianoid-controller-controller-dev-pctl)), a nested blueprint of the MIDI input routes |
| hook | `midi_input.MidiInputHub.sysex_hook` | a `0x7D` SysEx from the `Pianoid` port goes to the client and, if it was a config reply / sample, **not** to the monitor |
| UI | Tunner `PianoidControllerSection.jsx`, `PedalCalibrateDialog.jsx`, `PedalAssignDialog.jsx`, `usePianoidController.js` | shown only while a `Pianoid` port is listed |

**Replies and the input port.** Replies come back on the `Pianoid` INPUT port. A Windows MIDI input has one owner. When the listener plays or taps that port (Listen to All, the played port, or `monitor_all_ports`, the default), the client gets the replies through the hub hook. Otherwise it opens the input itself (its own open fails while the listener holds it) and releases it after 5 s without traffic, so the listener can take the port again.

**What the device does with it** (protocol: controller repo `docs/proposals/controller-config-2026-10-29.md`):

| Control | Device behaviour |
|---|---|
| Calibrate pedal | `min` / `mid` / `max` raw ADC + curve. Continuous: linear (min→0, max→127), piecewise through mid (mid→64), or power through mid; monotonic, clamped. Switch: pressed above 5/8 of the travel, released below 3/8; the order of min and max gives the polarity (an uncalibrated switch keeps the digital read + POL_AUTO). |
| Pedal assignments | per input: off / switch / continuous; CC (0-119) / note (switch) / channel pressure / pitch bend; channel 1-16; polarity. Defaults: X12 sustain CC64, X14 CC67, X13 CC66, X9 CC11 continuous. |
| Link speed | the FPGA → Micro wire (not the DIN socket, always 31250): 1x 31250 / 4x 125000 / 8x 250000. Both chips switch together over the Micro → FPGA aux line; an unconfirmed switch falls back. Needs a bitstream with `link_ctl` (else `selectable: false`). |
| Save | EEPROM; until then a change is live but lost at power-off. |

**Presence of a pedal.** The inputs have the Micro's internal pull-up and no board resistor: an empty jack reads ~1023, a pulled input (a continuous pedal, a closed switch) reads lower. `presence`: `active` (below 1000 now), `seen` (since the controller booted), `idle`. An open switch pedal reads like an empty jack, so the calibration dialog lists every input, connected ones first.

**Half pedal on this controller.** The factory X12 is a switch: it sends only 0 / 127, however the pedal moves. In the MIDI panel: Pedal assignments → X12 → type `continuous` (CC 64); Calibrate pedal → released / half / pressed → Through mid → Apply → Save to controller. No reflash; the settings go to the device's EEPROM. Not yet applied to the real board. With a switch-type pedal plugged in keep `switch`. [Half pedal](#half-pedal-dev-pedal1).

**Pianoid's own sustain map is separate.** The device decides what a pedal SENDS (e.g. CC64 on channel 1); `midi_input` decides what Pianoid does with it (`sustain_cc` / `port_sustain`). The defaults match: the device's X12 sends CC64, Pianoid's global map is CC64 any channel.

**Verification.** `tests/unit/test_pianoid_controller.py` (fake device speaking the protocol behind fake rtmidi ports: request bytes, reply decode, both reply paths, errors, stream, link, REST); Tunner `PianoidControllerSection.test.jsx`. Device side: controller repo `tools/test_pctl_logic.py` (curve / EEPROM / frame unit test) and `sim/tb_link_ctl.sv` (the rate switch in RTL). On hardware (2026-10-30, firmware v3, device side only): `verify_ctl.py` 17/17 in RAM and from flash, 31/31 extra checks (SAVE, DEFAULTS, saved rate at boot, recovery, fallback on an old image), speed 8x / 4x / 1x each with the 257/257 storm. Not tested on hardware: a real power cycle, the calibration flow, the 500 ms revert (simulation only). Details: controller repo `docs/IMPLEMENTATION_REPORT.md` §14.

## Half pedal (dev-pedal1) {#half-pedal-dev-pedal1}

**User decision (2026-10-31, "Build smooth pedal").** The pedal value grades the dampers; a pedal or file that sends only 0 / 127 sounds as before.

| Stage | Where | What |
|---|---|---|
| Source | device | the "Pianoid" controller's X12 is a switch by default (0 / 127, no firmware change needed): for half pedal set it to continuous and calibrate it ([below](#pianoid-controller-configuration-dev-pctl)). A continuous input changes by >= 2 steps at most every 10 ms |
| Map | `MidiInputHub._map_pedal` | polarity, per source; the engine pedal = the deepest press of the sources (`PedalSources`), so one device letting go does not cut another's half pedal |
| Value | `pianoid.sustain_engine_value` | clamp only; the one curve is the engine's |
| Rate | `Pianoid::applyPendingSustain` | once per cycle: an unchanged value costs nothing; intermediate values land at most every `SUSTAIN_MIN_CYCLE_GAP` (4) cycles, the latest wins; 0 and 127 land at once |
| Curve | `pedal_config.py`, `model_parameters.pedal` | per-string lift bands + the patch, `setDamperCurve` at load, preset switch and edit |
| Law | `DamperLaw.cuh`, `parameterKernel` | [SYNTHESIS_ENGINE → Damper multiplier](../pianoid-cuda/SYNTHESIS_ENGINE.md#damper-multiplier-dev-pedal1) |

Tuning: `GET /get_parameter/pedal/all`, `POST /set_parameter/pedal/all` ([REST_API](REST_API.md#half-pedal-curve-dev-pedal1)); undoable, saved with the preset only when it differs from the defaults (old presets load unchanged).

| Field | Default | Meaning |
|---|---|---|
| `dead_low` | 6 | at or below: every damper down (a pedal resting at 1-5 is fully up) |
| `dead_high` | 118 | at or above: every damper up (a pedal peaking at 120-126 sustains fully) |
| `register_spread` | 24 | pedal steps between the bass and the treble lifting: the band of a key slides up with its pitch (21 → 108). Bass first. Starting value, to be tuned by ear; 0 = all together |
| `patch_width` | 0.04 | damper patch width, fraction of the string (at least 5 points); 0 = the whole string as before |
| `patch_offset` | 0.02 | patch centre from the hammer point, fraction of the string, towards the bridge |
| `blend_power` | 3 | the whole-string share of the rate = closure^power: at closure 0.5 the patch carries 87.5 % |
| `decay_range` | 10000 | cap on fully damped rate / own rate, for a string with gamma 0 |

**Files that use CC64 as a switch with values other than 0 / 127.** Values 118-127 and 0-6 are the ends; a file holding the pedal at, say, 100 now half-pedals (a recorded performance wants that; the old switch flattened it).

**Status.** Measured on the rebuilt engine, offline; the real pedal is still to try: [results](../../development/half-pedal-test-plan-2026-10-31.md).

## MIDI player (dev-6f0c)

A backend player for MIDI files with transport, seek, speed, loop, transpose, velocity scale and track / channel mutes. Its UI is the **MIDI Player** mosaic pane ([Tunner OVERVIEW](../pianoid-tunner/OVERVIEW.md)); routes are `/midi_player/*` ([REST_API.md](REST_API.md)).

| File | Concern |
|---|---|
| `midi_song.py` | MIDI file -> `MidiSong`: time-sorted raw events with track + channel (tempo map of track 0, as the offline reader; NOTE_OFF/CC before NOTE_ON on the same tick); keeps notes + CC64/120/121/123 |
| `midi_player.py` | `MidiPlayer`: the player state (sole owner) and the scheduler thread |
| `midi_player_sink.py` | `PianoidEngineSink`: the engine adapter (buffer push / clear, cycle clock, preset pitches) behind the EngineGate shared slot |
| `midi_player_routes.py` | REST shell + the MIDI library listing |

**Where the timing runs: the backend, on the engine's cycle clock.** Every event is pushed into the engine's `RealTimeEventBuffer` with the target cycle computed from the song position (`cycle = cycle0 + (t - pos0) / (ms_per_cycle * speed)`), the same cycle-accurate path the live MIDI input and the old whole-file `/midi_playback` use. Notes land on the exact synthesis cycle (quantum = one cycle, `mode_iteration / sample_rate`) with no scheduling jitter of their own. Browser timers were rejected: every note would pick up the WS round trip and `setTimeout` jitter (tens of ms, and seconds in a throttled background tab).

**Lookahead window, not a whole-file push.** The thread (10 ms tick) pushes only the events due in the next `LOOKAHEAD_MS = 150` ms of wall time. So pause / seek / stop just `clear()` that window; a speed change re-anchors the clock at the pushed horizon, without clearing; and a long file never reaches the buffer's 10000-event back-pressure, which evicts NOTE_OFFs (= stuck notes; the old `/midi_playback` push hits it on long files).

| Behaviour | Rule |
|---|---|
| Note pairing | `_held[(track, channel, pitch)] = engine pitch` at NOTE_ON (after transpose); the NOTE_OFF damps that pitch, so changing transpose mid-note never leaves a note hanging; a pitch still held by another source is not damped |
| All notes off | pause, stop, seek, end of song, loop wrap: clear the window, NOTE_OFF every pitch struck since the last release, SUSTAIN 0 |
| Seek / resume | play resumes at the first event at or after the position, after a 40 ms lead; the pedal state at that position is re-sent (chased CC64) |
| Sustain + key CCs | CC64 -> SUSTAIN (the value, as the live path); CC121 -> SUSTAIN 0; CC123 / CC120 -> NOTE_OFF of that track+channel's held notes; other CCs dropped (engine has no per-channel volume / pan / soft pedal) |
| Mutes | muted track / channel: its NOTE_ONs and CCs are skipped, its held notes released at once; NOTE_OFFs always pass (no stuck notes). Muting a separate "Pedal" track removes the sustain |
| Transpose / velocity | ±24 semitones; velocity × 0.1-2.0 clamped to 1-127; notes outside the preset's pitches are skipped and counted (`skipped_notes`) |
| Loop | seamless: release at the end cycle, restart at the next cycle |
| Engine lost | a preset load (EngineGate refusal) or a rebuilt engine (buffer identity changed) stops the player without touching the engine |
| State push | Socket.IO `midi_player_state` on every change and every 250 ms while playing |

**Measured live (dev-6f0c, ASIO callback, BaselinePreset1, in-process):** cycle clock 1.3315 ms measured vs 1.3333 ms assumed (`mode_iteration / sample_rate`, −0.14 %); a metronome file at 400 ms gave onsets exactly 400.0 ms apart (std 0.0 at the 20 ms envelope resolution), at speed 1.5 a mean of 265.7 ms (expected 266.7); elise.mid from 10 s: position advanced 2961 ms in 3003 ms of wall time (the 40 ms start lead), pause -> output −71 dB re playing within 2 s, resume at 2x advanced 3923 ms in 2003 ms; event buffer peak 14 events, 0 dropped.

The MIDI folder (dev-midirec) is resolved by `midi_player_routes.resolve_midi_dir`, first set wins: `midi_dir` in the local settings file (`<PianoidInstall>/pianoid_local_settings.json` or `$PIANOID_LOCAL_SETTINGS`, the same file and layering as the measurements folder) -> `$PIANOID_MIDI_DIR` -> the standard folder `<PianoidInstall>/MidiRecords` (tracked by its `README.md`, every other file git-ignored). `GET /midi_player/library` lists it plus the bundled `MIDI_records/`; the launcher's Open dialog (`server/midiFileDialog.js`) resolves the same layers to choose its start folder. `<PianoidInstall>/midi/` now holds only the MIDI input settings. There is no MIDI recording/saving yet; a future writer should save to `midi_dir()`. The old `/midi_playback` (`play.midi_file`, whole-file push, stop without note-offs) is unchanged for the assistant's command; moving it onto the player is a WIP follow-up.

## MIDI files (`MidiRecord.read_midi`)

`/midi_playback` and the offline render read a MIDI file into `{ms: [events]}` through `MidiRecord.read_midi` (parse: `midi_file_reader.read_midi_instruments`, mido; [data flow](../../architecture/DATA_FLOWS.md)).

| Rule | Behaviour |
|---|---|
| Instruments | Only the piano-named instruments (track name contains `piano`, any case) when the file has any, else every instrument; each read once (dev-35e6; before, piano-named instruments were read twice) |
| Notes | NOTE_ON (144) at the start, NOTE_OFF (128) at the end, times truncated to ms |
| Sustain (`sustain=True`) | CC64 → command 176 pitch 64, value = raw CC. From the played instruments' own tracks, and from **CC-only tracks** (no notes, e.g. a separate "Pedal" track) whose channel is a played instrument's channel — scheduled once per CC event, not once per instrument |
| Sustain scope | The engine has one sustain pedal (`SUSTAIN` carries only the value, no channel — [event layout](../pianoid-cuda/PLAYBACK_SYSTEM.md)), so a pedal applies to every sounding note. The channel only decides whether a CC-only track's pedal is used |

Bundled files: `elise.mid` 2236 events (154 sustain), `mond_1.mid` 2596 events (308 sustain from its "Pedal" track).

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
