# Playback Architecture Review

**Status:** Research snapshot prepared by `arch-playback` on 2026-04-20. No source
edits. Intended as a design brief for future implementation agents, keyed to the
user's stated target vision.

**Scope:** Online + offline playback subsystems — event producers, queues, engine
threads, dispatcher, parameter update path, audio driver control.

**Companion doc:** [DISTORTION_INVESTIGATION_CONTEXT.md](DISTORTION_INVESTIGATION_CONTEXT.md)
(P1/P2/P3 hypotheses; no duplication here).

---

## Target Vision (user, 2026-04-20)

> **Online.** Synthesis cycle is running. There should be only one path to feed
> events (note, mode excitation, sustain, other MIDI events) into the system —
> preferably all formatted as MIDI. A separate but also consolidated path exists
> for parameter updates.
>
> **Offline.** Stop online playback if needed (keep audio driver open). Start the
> synthesis engine with a predefined sequence of events (MIDI). Save synthesized
> sound in an internal format (convertible to WAV and back). Play the sound with
> the audio driver if required. Restart online synthesis if it was running
> before (make sure to restore all the parameters).

Each paragraph is tracked individually in §4 Gaps.

---

## 1. Current State — Online Event Paths

Every input path that causes the engine to play a note, excite a mode, move
sustain, or apply any playable event.

### 1.1 Enumeration

| # | Entry point | Thread context | Queue | Final synth call | Notes |
|---|---|---|---|---|---|
| A1 | `POST /play` (`backendServer.py:1162`) | Flask worker | `RealTimeEventBuffer` | `exciteStringsForPitch` via `EventDispatcher::handleNoteOn/Off` | Per-sid dedup of `(pitch,command)`. Supports `delay_ms`. |
| A2 | WebSocket `play` event (`backendServer.py:127`) | SocketIO (`threading` mode) worker | `RealTimeEventBuffer` | same as A1 | Per-sid dedup. Binary frame `[cmd,pitch,vel]`. |
| A3 | Python `MIDI_listener_unified` busy-wait (`pianoid.py:1353`) | `PianoidUnifiedMidiThread` | `RealTimeEventBuffer` | same as A1 | No `time.sleep`; see P1 in DISTORTION_INVESTIGATION_CONTEXT.md. |
| A4 | `POST /midi_playback start` → `load_midi_for_online_playback` (`pianoid.py:1478`) | Flask worker | `RealTimeEventBuffer` (pre-populated for base_cycle..end_cycle) | same as A1 | Events share the same buffer as A1/A2/A3; mixed with live input cycle-for-cycle. |
| A5 | `POST /play_mode/<n>` (`backendServer.py:1264`) → `pianoid.play_mode()` (`pianoid.py:877`) | Flask worker | **bypasses** `RealTimeEventBuffer`; direct `pianoid.exciteMode(mode, q, vel)` at `Pianoid.cu:1840` | Direct `_exciteSingleMode` mutation of `dev_mode_running`. | Polls estimator until `cycles_needed` elapse. If engine not running, `time.sleep(length/1000)`. |
| A6 | `/start_test` action `play_note_offline` | Flask worker | `EventQueue` (pre-built) | `runOfflinePlayback` | Offline path, not online; listed here because the user triggers it from the live UI. |
| A7 | `pianoidMidiListener.MidiListener` (legacy, `pianoidMidiListener.py`) | Separate thread, invoked via `perform_midi_command` | Via A1 path once it calls `perform_midi_command` | Some actions (`pitch_wheel`, `note_volume`, `note_pitch`, etc.) do NOT route through the event buffer — they mutate strings/modes directly via `ParameterManager`. | Only active in the legacy "listen" mode; not wired in the current startup path per MIDI_SYSTEM.md §Overview. |
| A8 | C++ `MidiInputListener` (documented in `PLAYBACK_SYSTEM.md:441`) | RtMidi callback thread | `RealTimeEventBuffer` | same as A1 | **DOC/CODE DRIFT (P2).** No source files in the tree (`MidiInputListener.h/.cpp` absent; `AddArraysWithCUDA.cpp:523` marks legacy MIDI removed). Listed only to flag the drift. |
| A9 | `perform_midi_command()` (`pianoid.py:785`) | Caller's thread (usually Flask) | `RealTimeEventBuffer` via `add_realtime_event()` | same as A1 | Thin facade over A3/A4 shared helper. |

### 1.2 Observations

1. **Four distinct live-event entry points** (A1, A2, A3, A4 — plus legacy A7)
   all terminate at the same call (`add_realtime_event` or directly pushing a
   `PlaybackEvent` into `RealTimeEventBuffer`). A1 and A2 duplicate dedup logic,
   MIDI extraction, and `midi_to_event_type` lookup. A4 duplicates the MIDI
   parsing directly against `MidiRecord.all_events()`.
2. **A5 (play_mode) is the outlier.** It is the only live-event path that does
   NOT go through `RealTimeEventBuffer`. It calls `pianoid.exciteMode()` from a
   Flask worker while the engine thread is reading/writing `dev_mode_running`.
   There is no mutex between the two, and `exciteMode` writes host→device via
   `cudaMemcpyAsync` then polls `getCurrentCycle`. Correctness depends on the
   kernel running asynchronously but not deadlocking — no hard guarantees. This
   is the closest thing to a "mode excitation" event but it is not one, it's a
   direct GPU write.
3. **Dedup divergence.** A1 uses a single module-level `last_command`. A2 uses a
   per-socket dict `_ws_last_command[sid]`. A3 has no dedup. A4 has no dedup.
   MIDI controllers that duplicate NOTE_OFFs hit A3 with no filter. See
   DISTORTION_INVESTIGATION_CONTEXT.md §2.2 for downstream impact.
4. **NOTE_OFF release-velocity is discarded on the Python side** (A3 hardcodes
   `data2=0` at `pianoid.py:1385`; A1/A2 parse the original velocity but
   `EventDispatcher::handleNoteOff` only reads the pitch byte — velocity is
   lost regardless). This is consistent but one layer is redundant.
5. **`perform_midi_command` (A9) and `add_realtime_event` (A3 helper) are two
   facades over the same buffer.** A9 is called by the legacy path and
   `/play`'s legacy fallback; A3 helper is called by WS and the `/play`
   unified fast path. Two nearly identical functions.
6. **`EventType` enum has 4 unbound values** (PARAM_UPDATE_BATCH, TEST_MODE_ONLY,
   TOGGLE_FEEDBACK, RESERVED) — see PLAYBACK_SYSTEM.md §Pybind11 Binding
   Coverage. The system has a mode-excitation event type (`TEST_MODE_ONLY`)
   already, and `MidiEventConverter::isModeExcitation(0xF1)` /
   `createModeExcitationEvent()` helpers — but no producer pushes them and
   `play_mode` doesn't use them.

### 1.3 Burst / batch-state overwrite risk (continuing from DISTORTION_INVESTIGATION_CONTEXT.md §2.3)

`EventDispatcher::dispatch` is called in a loop inside
`OnlinePlaybackEngine::processEventsAtCycle`. Each NOTE_ON / NOTE_OFF runs
`PlaybackCycleExecutor::exciteStringsForPitch(...)` which `beginStringBatch →
addStringToBatch* → commitStringBatch` in full, inside the loop. Successive
excitations in the same cycle each commit to GPU — if batch state is
mutated on `commitStringBatch` via `new_notes_ind`, the next excitation of the
same pitch in the same cycle can overwrite it. This is an open question flagged
in DISTORTION_INVESTIGATION_CONTEXT.md §2.3 / §4 and worth auditing under the
proposed unified event path.

---

## 2. Current State — Parameter Update Paths

### 2.1 Enumeration

| # | Entry point | Thread | Path | Mechanism | Notes |
|---|---|---|---|---|---|
| B1 | `POST /set_parameter/<type>/<key>` | Flask worker | `parse_range → pianoid.update_parameter() → ParameterManager.update_parameter()` | Type-dispatched: granular (string/mode) or bulk pack+upload (hammer/excitation/deck/sound_channel) | 8 parameter types dispatched inside. `_gpu_upload` calls `waitForParameterUpdate()` then `setNew*Parameters()` / `updateMultiStringParameter_NEW()`. |
| B2 | WebSocket `set_parameter` | SocketIO worker | Same as B1 | Emits `param_ack` on success. |  |
| B3 | `POST /set_string_excitation/<pitch>` / WS `set_string_excitation` | Flask / SocketIO worker | `update_pitch_excitation()` → base-level pack → `_gpu_upload(setNewExcitationBaseLevels)` | Bulk (per-pitch granular, but uploads the whole 30,720-real base-level buffer). |
| B4 | `POST /set_hammer_shape/<pitch>` / WS `set_hammer_shape` | Flask / SocketIO worker | `update_parameter('hammer', ...)` | Goes through B1 path. |
| B5 | `POST /set_mode_parameters` (array) | Flask worker | `pianoid.update_mode_parameters()` | Bulk — rebuilds entire mode_state, calls `setNewModeParameters`. |
| B6 | `POST /set_runtime_parameters` / WS `set_runtime_parameters` | Flask / SocketIO worker | `set_volume_level(level)` + `set_deck_feedback_coefficient(coeff)` | Direct `setRuntimeParameters(params)` `cudaMemcpy` — no double-buffer. |
| B7 | `POST /set_velocity/<velocity>` | Flask worker | `pianoid.fixed_level = ...` | Python-side overwrite applied on each subsequent note event; no GPU write. |
| B8 | `POST /set_deck/<matrix>` (legacy, per REST_API.md removed) | — | Removed | Only listed for audit; `feedin/feedback` now go through B1. |
| B9 | MIDI CC (legacy listener) — CC 7 / CC 74 / CC 64 | MIDI listener thread | CC 7/74 → `set_volume_level` / `set_deck_feedback_coefficient` (same as B6); CC 64 → sustain event through A3 | Some CCs (`note_volume`, `note_pitch`, etc. — see MIDI_SYSTEM.md) call `ParameterManager.update_parameter` directly from the listener thread, not B1. |
| B10 | Calibration / auto-tuning / modal adapter | Flask worker (background threads for long runs) | `ParameterManager.update_pitch_physical_params_GRANULAR` / `setNewExcitationBaseLevels` / direct `updateSingleStringParameter_NEW` | Same terminal API as B1 but many distinct callers. |
| B11 | `POST /calibration_params` | Flask worker | `CalibrationController.set_perception_curves` / `apply_level_multipliers` | Internally uses B1 / B10 terminal paths. |
| B12 | `POST /modal/apply_to_preset` (main server) | Flask worker | `ModalAdapter.apply_to_preset` → many B1/B10 calls | Bulk preset mutation. |
| B13 | `POST /preset/switch` | Flask worker | `switchPreset` (D2D memcpy + pointer swap) | **Not a parameter update** — a whole-preset atomic swap. Listed here because `RuntimeParameters` are currently NOT preserved across it (see WIP.md "Preset System Revision"). |

### 2.2 Observations

1. **Single dispatcher already exists** — `ParameterManager.update_parameter()`
   at `parameter_manager.py:~200`. It covers ~80% of the parameter surface.
   The non-conformant paths are: B3 (`update_pitch_excitation`, separate entry
   used by the excitation editor), B5 (bulk mode params, rebuilds everything),
   B6 (runtime parameters, bypasses double-buffer), B7 (Python-side velocity
   override), B9 (per-note CC handlers in the legacy listener).
2. **REST and WebSocket layers duplicate glue code twice** — see B1/B2, B3/B3,
   B4/B4, B6/B6. The WS handler re-parses, re-validates, re-calls the same
   `ParameterManager.update_parameter` method as REST. About 200 lines of
   duplication across the two layers in `backendServer.py`.
3. **`time.sleep(0.01)` workaround from WIP.md ("Parameter Update Sleep
   Removal") is NOT present in the current tree.** Grep for `time.sleep` in
   `parameter_manager.py` returns 0 matches. All bulk paths now route through
   `_gpu_upload()` which calls `waitForParameterUpdate()`. The WIP row is stale
   — the refactor landed. Flag as a doc sync.
4. **B13 preset switch is not part of the parameter path but interacts with it
   heavily.** Runtime-vs-preset state divergence (volume, feedback, sensitivity
   don't survive switch; available-notes not refreshed) is open per WIP.md.
5. **Bulk `setNewModeParameters` (B5) is redundant with granular
   `updateModeParameters_GRANULAR` (used by B1/mode).** Two paths for the same
   write, and B5 is used only by `play_mode` (A5) and initial preset load —
   and A5 now uses `exciteMode` directly, so B5 is arguably init-only.
6. **`B10` callers are not uniform** — `auto_tuner`, `calibration_controller`,
   `modal_adapter.preset_injector` all call the terminal C++ methods with
   slightly different wrappers. Some use `_gpu_upload` via
   `ParameterManager`, others call `pianoid.setNewExcitationBaseLevels(...)`
   directly. Behavior is equivalent (`waitForParameterUpdate` is enforced
   inside `setNewExcitationBaseLevels` too) but the API entry point is not
   single.

---

## 3. Current State — Offline Playback

### 3.1 `runOfflinePlayback` flow

Terminal C++ call: `Pianoid::runOfflinePlayback(EventQueue, PlaybackConfig)` at
`Pianoid.cu:2952`. Creates an `OfflinePlaybackEngine`, `initialize()`,
`loadEvents()`, `run()`, collects `getRecordedAudio()` into
`last_recorded_audio_`. Python accesses via `pianoid.getRecordedAudio()` +
`pianoid.exportAudioToWav(path, audio_data, sr)`.

### 3.2 `OfflinePlaybackEngine::run` behaviour (`OfflinePlaybackEngine.cu:53`)

1. `calculateTotalCycles()` = `max(event.cycle_index) + 5s decay @ sample_rate /
   samples_per_cycle`.
2. Clamp by `config.max_duration_ms`.
3. **Hard requirement:** `pianoid_->shouldContinue()` must be `false`. If the
   online main loop is running, `run()` returns a failure `PlaybackStats` with
   `error_message = "Cannot render offline: Main loop is active. Call
   endMainLoop() first."` Audio driver presence is NOT checked.
4. `config.audio_enabled` is read by `PlaybackCycleExecutor::executeCycle` to
   decide whether to call `pianoid_->manageSoundBuffers()`. When `false`, no
   samples reach the driver's circular buffer — audio driver stays silent but
   alive.
5. Per-cycle: `processEventsAtCycle → runCycle → collectAudio` (if
   `config.record_to_buffer`).
6. Each cycle calls `pianoid_->getCurrentCycleAudio()` into
   `recorded_audio_`, pre-sized as `total_cycles * samples_per_cycle`.

### 3.3 Python wrappers calling `runOfflinePlayback`

| Caller | Reset before? | Audio? | Record? | Callers |
|---|---|---|---|---|
| `pianoid.render_midi_offline` (`pianoid.py:520`) | yes (`resetStringsState + executeSynthesisCycle`) | no | yes | Manual testing / CLI |
| `chartFunctions.play_note_offline_chart_function` (~line 1055) | yes | no | yes | `/get_chart_test` `note_playback` |
| `chartFunctions.play_note_offline_action` (~line 1176) | yes | no | yes | `/start_test` `play_note_offline` |
| `chartFunctions.offline_midi_playback_function` (~line 1316) | yes | no | yes | Chart |
| `chartFunctions.play_mode_chart_function` (~line 1480) | yes | no | yes | Chart |
| `auto_tuner.MeasurementEngine.render_note` | yes | no | yes | `FrequencyTuner` / `VolumeTuner` |
| `synthesis_tuner.SynthesisTuner` | yes | no | yes | synthesis tuner |

All wrappers use the same pattern:
1. `engine_was_running = _stop_online_engine(pianoid)` — calls
   `stop_playback()` then `pianoid.pianoid.endMainLoop()` then busy-waits
   `shouldContinue()` with `time.sleep(0.01)` (up to 3s).
2. Build `EventQueue`, `PlaybackConfig(audio_enabled=False,
   record_to_buffer=True)`.
3. `with cuda_lock: resetStringsState() + executeSynthesisCycle() [flush
   deferred reset] + runOfflinePlayback()`.
4. `_restart_online_engine(pianoid, engine_was_running)` — calls
   `pianoid.start_pianoid()` which re-initializes the full engine stack.

### 3.4 Audio driver state during offline

- `_stop_online_engine` does NOT stop the audio driver (`stop_playback` →
  `stopAudioDevice` is called in the Python shutdown path, but `endMainLoop`
  only sets a flag). The driver can remain alive or be stopped depending on
  exact shutdown path.
- `OfflinePlaybackEngine::run` never starts, pauses, or stops the audio
  driver. It doesn't even check for it.
- On restart (`_restart_online_engine → start_pianoid →
  start_realtime_playback_unified`) a fresh `OnlinePlaybackEngine` is created
  and `config.audio_enabled = True` → `pianoid_->startAudioDevice()` is called
  in `OnlinePlaybackEngine::run` unconditionally.
- **Known failure** (WIP.md "ASIO Driver Re-initialization Failure"): ASIO
  callback driver cannot restart after stop. So if offline rendering stops the
  audio driver (it shouldn't — but if any path does), restoring online fails.

### 3.5 Parameter isolation — does offline leak state into online?

- Preset (TUNABLE block) parameters: untouched by offline rendering unless the
  caller explicitly mutates them (e.g., `auto_tuner.FrequencyTuner` writes
  `tension` via `updateMultiStringParameter_NEW` in its correction loop).
  `_restart_online_engine` does NOT restore them.
- Mode running state (`dev_mode_running`): zeroed by `resetStringsState()` at
  the start of each offline render. Zeroed again at the start of the next
  online engine if the caller invokes it. So live-mode residue from before
  offline is LOST when offline runs.
- `RuntimeParameters` (volume, feedback): survive `endMainLoop` → restart
  because they live in `dev_main_volume_coeff` / `RuntimeParameters` member,
  not in preset buffers.
- `PlaybackConfig` of the restarted online engine: rebuilt from
  `start_realtime_playback_unified` defaults — `config.audio_enabled = True`,
  `record_to_buffer = False`, `max_duration_ms = 0`. NOT restored from prior
  online session. If the user had any non-default values set, they are lost.

### 3.6 Known issues (current state)

- `_stop_online_engine` uses `time.sleep(0.01)` busy-wait to confirm the engine
  stopped. 3s deadline. Not ideal but bounded.
- No internal audio format — offline returns `std::vector<float>`, Python
  copies to numpy, passes to `exportAudioToWav`. No serialization between
  render and playback.
- `runOfflinePlayback` does NOT drive the audio driver, so "play recorded
  sound through the driver" (part of user's vision) is not supported. Today,
  only WAV export is available.
- `_audio_stopped_for_calibration` flag and the semi-offline "keep audio open"
  mode in `pianoid.enter_calibration_mode`/`exit_calibration_mode`
  (`pianoid.py:363/424`) is a second, different offline flow — audio stays
  alive, engine loop stops, `executeSingleMeasurementCycle()` runs cycles
  synchronously from Python. This is the closest existing flow to the user's
  target vision.

### 3.7 Two offline flavors coexist

| Flavour | Driver entry point | Driver state | Input | Output |
|---|---|---|---|---|
| Pure-offline render (`runOfflinePlayback`) | C++ `OfflinePlaybackEngine::run` | silent (`audio_enabled=false`); driver untouched | `EventQueue` | `std::vector<float>` → WAV |
| Semi-offline calibration (`enter_calibration_mode` + `run_measurement_cycles` + `executeSingleMeasurementCycle`) | Python loop calls C++ per-cycle | ALIVE; mic capture drives timing | Python calls (`exciteStringsForPitch`, direct) | mic capture (`stopMicCapture`); sometimes synthesis capture via `synthesisCaptureBuffer_` |

The user's offline vision conceptually resembles a merge of these two.

---

## 4. Gaps vs User Vision

Clause-by-clause mapping from the user's statement to the current state.

### 4.1 "Online: only one path to feed events"

- **Current:** A1, A2, A3, A4 all route through `RealTimeEventBuffer` — already
  a single terminal queue. But the producers have ≥4 glue layers, two dedup
  strategies, two Python facades (`add_realtime_event` vs
  `perform_midi_command`), and `play_mode` (A5) bypasses the queue entirely.
- **Blocker for "one path":** A5 must be converted to push a mode-excitation
  event into `RealTimeEventBuffer` instead of calling `exciteMode` directly.
  That requires a real event type (TEST_MODE_ONLY is close but is documented
  as a "test" event and its dispatch handler uses hardcoded displacement
  scaling — see `EventDispatcher.cu:174-192`).
- **Secondary blocker:** legacy MIDI listener `pianoidMidiListener.py`
  "per-note" CC handlers (note_volume, note_pitch, etc.) route through
  `ParameterManager`, not the event buffer. These are parameter updates, not
  events, and could be retained on the parameter path IF we accept "events"
  and "parameters" as two distinct unified paths (exactly what the user asks).

### 4.2 "Preferably all formatted as MIDI"

- **Current event representation:** `PlaybackEvent` (24 bytes) — `EventType`
  enum + opaque 64-bit `data`. For NOTE_ON/OFF: `data = (pitch<<8) | velocity`.
  For SUSTAIN: `data = cc_value & 0x7F`. For TEST_MODE_ONLY:
  `data = (velocity<<16) | mode_index`. Data packing is per-type ad-hoc.
- **Already-MIDI paths:** `MidiEventConverter::fromMidiBytes(status, d1, d2,
  cycle)` converts standard MIDI bytes to a `PlaybackEvent` (`MidiEventConverter.h:12`).
  `fromMidiRecord(midi_record, sr, spc)` converts a `MidiRecord` (MIDI file)
  to an `EventQueue`. Both helpers already exist.
- **NOT-pure-MIDI:** mode excitation, parameter updates. Standard MIDI has no
  encoding for "excite mode N with displacement D, velocity V" or "set
  parameter X to Y". Proposal: either (a) reserve a SysEx range for "Pianoid
  extension" MIDI messages with custom payloads, or (b) keep two event types —
  standard-MIDI (NOTE_ON/OFF/SUSTAIN) plus a "Pianoid control" envelope that
  is MIDI-compatible in structure (status byte + 2-byte payload) but uses the
  `0xF1` range already reserved as `TEST_MODE_ONLY`, and document it as
  "Pianoid MIDI extension 0xF1".
- `MidiEventConverter::isModeExcitation(0xF1)` and
  `createModeExcitationEvent(d1, d2, cycle)` already exist as helpers — not
  yet wired into the dispatcher.

### 4.3 "Consolidated parameter path"

- **Current:** `ParameterManager.update_parameter()` is the consolidated dispatcher
  for ~80% of writes; REST `POST /set_parameter/<type>/<key>` and WS
  `set_parameter` both route to it. Outliers: excitation (B3), bulk-mode (B5),
  runtime (B6), velocity-override (B7), legacy-listener per-note CCs (B9).
- **Blockers:** (a) B3/B4 have separate endpoints for historic reasons (pre-unification);
  removing them requires frontend changes. (b) B6 bypasses double-buffer
  intentionally (volume is a scalar `cudaMemcpy`, not a TUNABLE slot); it
  shares the "parameter" dispatch interface but has a different terminal
  mechanism — this is a legitimate split, not a bug, but the surface API
  should still be uniform. (c) The SocketIO handlers re-implement the
  dispatcher glue rather than delegating to a shared helper.

### 4.4 "Offline: stop online (keep driver open), run seq, save internal format, (optional) play through driver, restore online + params"

| Target clause | Exists today? | Current mechanism | Missing |
|---|---|---|---|
| Stop online playback | Yes | `pianoid.stop_playback()` / `_stop_online_engine()` / `enter_calibration_mode()` | Three different paths; no single API. |
| Keep audio driver open | Partial | `enter_calibration_mode(keep_audio=True)` keeps it alive; `_stop_online_engine()` from chartFunctions usually leaves it alive because `endMainLoop` doesn't stop it — but full `stop_playback` does. | No explicit flag on the pure-offline render path. |
| Run predefined event sequence | Yes | `runOfflinePlayback(EventQueue, PlaybackConfig)` | Event sequence is `EventQueue`, not a serialized MIDI file — conversion via `MidiEventConverter::fromMidiRecord` exists but is not wired as the default input format. |
| Internal format convertible WAV↔internal | No | `exportAudioToWav` is one-way; no reader. | A `SoundBuffer` type + encode/decode helpers. |
| Play recorded sound through audio driver | No | `OfflinePlaybackEngine` never feeds the driver; no playback-of-rendered-buffer primitive exists. | A new primitive — e.g., "prepend a buffer into the driver's circular buffer and run the driver without the synthesis kernel." |
| Restart online if previously running | Yes | `_restart_online_engine(pianoid, was_running)` calls `start_pianoid()` which calls `start_realtime_playback_unified()` | Rebuilds state from defaults — `PlaybackConfig`, volume/feedback, current preset — no snapshot/restore mechanism. |
| Restore all parameters | Partial | Preset stays (TUNABLE is not touched). Runtime params (volume/feedback) stay because they live in driver-adjacent memory. PlaybackConfig options reset to defaults. | No explicit snapshot/restore. If offline mutates preset params (auto_tuner does), no auto-rollback. |

---

## 5. Proposed Target Architecture

### 5.1 Event representation — the MIDI envelope

Define a single canonical event struct that is MIDI-compatible wherever possible
and MIDI-extended where necessary:

```cpp
struct MidiEnvelope {
    uint8_t  status;      // standard MIDI status byte (0x80..0xFF)
    uint8_t  data1;       // MIDI data byte 1 (pitch, cc#, mode#, param#, ...)
    uint8_t  data2;       // MIDI data byte 2 (velocity, cc value, ...)
    uint8_t  flags;       // 0 = standard MIDI, 1 = Pianoid extension
    uint32_t cycle_index; // target cycle for scheduling (online: next cycle, offline: precomputed)
    uint64_t timestamp_us;// origin time (for latency measurement / logging)
    uint32_t extended;    // optional 4-byte tail for extended payloads (parameter values, mode q, etc.)
};
```

Status bytes:
- `0x80` NOTE_OFF, `0x90` NOTE_ON, `0xB0 + cc=64` SUSTAIN — standard MIDI.
- `0xF1 MODE_EXCITATION` — Pianoid extension. `data1 = mode_number`,
  `data2 = velocity`, `extended` = packed `q, q_prev` or the derived
  displacement/vel pair currently computed in `play_mode`.
- `0xF2 RESET_STATE` — matches existing `EventType::RESET_STATE`.
- `0xF3 CONFIG_TOGGLE` — reserved (feedback, sustain-override, etc.).
- Existing `PARAM_UPDATE_*` types move OUT of `PlaybackEvent`; parameters go
  through the parameter path, not the event path.

`MidiEnvelope` is the on-wire + in-memory format. Drop `NoteEvent`,
`SustainEvent`, `TestModeEvent`, `ParameterUpdateEvent` derived structs
(they were a factoring that added struct overhead without being used uniformly).

### 5.2 Single online event queue

Keep `RealTimeEventBuffer`. Owner: `OnlinePlaybackEngine` via `setRealTimeBuffer`.
Lock: `std::mutex` inside the buffer. Thread: producers push from any thread;
drain from engine thread in `processEventsAtCycle`.

Back-pressure: the multimap has no size cap today. Proposal — soft cap
(e.g., 10k entries), on overflow drop oldest NOTE_OFFs first (keep ONs to
preserve musical integrity), log via `PianoidLogger` counter.

All producers (A1, A2, A3, A4, converted A5) construct a `MidiEnvelope` and
call a single `scheduleEvent(envelope)` helper. Dedup happens in that helper
with a unified policy (per-producer token via `envelope.flags` high bits).

### 5.3 Single parameter-update queue

Introduce a `ParameterUpdateRequest` struct (distinct from MIDI events):

```python
@dataclass
class ParameterUpdateRequest:
    kind: str          # "string", "mode", "hammer", "excitation", "deck",
                       # "sound_channel", "runtime_volume",
                       # "runtime_feedback", "velocity_override"
    key: Union[int, str, slice]
    values: dict
    priority: int = 0  # 0 = user edit (debounced), 1 = auto-tuner, 2 = runtime MIDI CC
```

All REST/WS/MIDI/internal callers build a `ParameterUpdateRequest` and call
`ParameterManager.apply(request)`. Internally dispatches to the
current granular/bulk/runtime mechanisms. No new GPU path; just consolidation
of the Python surface.

Interaction with double-buffer swap: `ParameterManager.apply()` always calls
`waitForParameterUpdate()` before uploading (already the case). Preset switch
(B13) takes priority — if a switch is in flight, pending parameter requests
queue until swap completes. Use a `threading.Condition` inside
`ParameterManager` to coordinate with `_on_preset_switch_begin` /
`_on_preset_switch_end` hooks.

### 5.4 Offline session lifecycle

```
Online running (PLAYBACK_ACTIVE)
    |
    v  offline_session.begin(preserve_audio_driver=True, snapshot=True)
        1. Snapshot: online_engine_config, runtime_params, active_preset_name,
                     listener_state (MIDI on/off).
        2. pianoid.enter_calibration_mode(keep_audio=True)
           - stops MIDI listener
           - stopEngineKeepAudio() (C++: shouldContinueLoop=false, app=false)
           - online_engine.stop(); join _playback_thread
           - Audio driver stays alive (mic-calibration path).
        3. State: PAUSED, _offline_session_active = True
    |
    v  offline_session.run(midi_events: List[MidiEnvelope], record=True,
                            play_through_driver=False)
        1. Build EventQueue from MidiEnvelope list.
        2. PlaybackConfig(audio_enabled=play_through_driver,
                           record_to_buffer=record,
                           max_duration_ms=...).
        3. pianoid.resetStringsState() + executeSynthesisCycle().
        4. pianoid.runOfflinePlayback(queue, config) → PlaybackStats.
        5. audio = pianoid.getRecordedAudio() → wrapped in SoundBuffer.
        6. return SoundBuffer (if recorded) + stats.
    |
    v  offline_session.play_buffer(sound_buffer)   [optional, new primitive]
        - Pushes sound_buffer samples into audio driver's circular buffer
          directly, bypassing synthesis kernel.
        - Blocks until buffer drained or returns a future.
        - Requires a new C++ method Pianoid::pushPrerecordedAudio(vector<float>, int sr).
    |
    v  offline_session.end()
        1. If snapshot was taken: reapply runtime_params, reactivate original
           preset (if changed during session), restart MIDI listener if was
           running. Exit calibration mode (pianoid.exit_calibration_mode()).
        2. Else: just exit_calibration_mode().
        3. State: PLAYBACK_ACTIVE
```

### 5.5 Internal audio format

Proposal: a simple `SoundBuffer` dataclass / C++ struct carrying PCM +
metadata, with trivial WAV conversion.

```python
@dataclass
class SoundBuffer:
    samples: np.ndarray   # shape (num_channels, num_frames) or (num_frames,) mono
    sample_rate: int
    channels: int
    # Provenance (useful for A/B comparison, chart overlay):
    source: str           # "offline_render" | "mic_capture" | "wav_import"
    created_at: float     # unix ts
    metadata: dict        # {"preset": name, "pitch": 60, "velocity": 95, ...}

    def to_wav(self, path: str) -> bool: ...
    @classmethod
    def from_wav(cls, path: str) -> "SoundBuffer": ...
    @classmethod
    def from_cpp_buffer(cls, audio_vec: List[float], sr: int, meta: dict) -> "SoundBuffer": ...
```

Rationale:
- Raw float32 PCM + sidecar metadata matches what `runOfflinePlayback` already
  produces (`std::vector<float>` from `getRecordedAudio`).
- No new binary container — WAV handles round-trip (`exportAudioToWav` +
  `scipy.io.wavfile.read` or the bundled WAV reader already used for
  mic-capture analysis).
- Chart system already renders `SoundBuffer`-like data (`charts.create_audio`
  → base64 WAV); minimal changes to plug in.

Alternatives considered:
- Compressed format (FLAC): premature optimisation — offline renders are
  typically short (seconds). Add later if needed.
- Custom binary container: more code, more bugs, no clear benefit. Skip.

### 5.6 Text-format summary diagrams

**Online event path after unification:**

```
  REST /play   WS play   MIDI listener   MIDI-file scheduler   /play_mode
      \           \           \                 \                   /
       \           \           \                 \                 /
        +-----------+-----------+-----------------+---------------+
                                |
                                v
                    scheduleEvent(MidiEnvelope)
                    (owns dedup, back-pressure, logging)
                                |
                                v
                       RealTimeEventBuffer
                                |
                                v
                OnlinePlaybackEngine.processEventsAtCycle
                                |
                                v
                    EventDispatcher.dispatch(envelope)
                         |      |       |        |
                         v      v       v        v
                      NoteOn NoteOff Sustain ModeExcitation
```

**Parameter path after unification:**

```
 REST /set_parameter   WS set_parameter   MIDI CC handlers   /set_runtime_*
        \                  \                  \                  /
         \                  \                  \                /
          +------------------+------------------+--------------+
                                    |
                                    v
                  ParameterManager.apply(ParameterUpdateRequest)
                                    |
                          +---------+---------+
                          v         v         v
                     Granular    Bulk      Runtime
                     (per-item)  (pack+send)(cudaMemcpy)
                          |         |         |
                          +----+----+---------+
                               v
                    waitForParameterUpdate()
                               v
                         GPU buffers
```

**Offline session lifecycle:**

```
  PLAYBACK_ACTIVE
      |
      | offline_session.begin(snapshot=True, preserve_audio=True)
      v
  CALIBRATING (audio driver alive, engine loop stopped, state snapshot taken)
      |
      | offline_session.run(midi_events, record, play_through_driver)
      |    -> runOfflinePlayback -> SoundBuffer
      v
      | [optional] offline_session.play_buffer(sound_buffer)
      |    -> pushPrerecordedAudio (audio driver renders the buffer)
      v
      | offline_session.end() -> restore snapshot
      v
  PLAYBACK_ACTIVE (runtime params + preset restored)
```

---

## 6. Migration Plan

Ordered. Each row independently mergeable unless noted.

| # | Step | Scope | Size | Risk | Depends on |
|---|---|---|---|---|---|
| M1 | Collapse `perform_midi_command` and `add_realtime_event` into a single `schedule_event(envelope)` helper. Keep legacy names as thin wrappers until all callers are migrated. Unify dedup. | `pianoid.py` `backendServer.py` | S | Low — same terminal call. | — |
| M2 | Introduce `MidiEnvelope` struct (C++ + pybind) replacing the opaque `PlaybackEvent.data` bit-packing. `fromMidiBytes` / `fromMidiRecord` start producing envelopes. | C++ + Python | M | Med — touches dispatcher. Needs careful backward-compat while existing `PlaybackEvent` callers migrate. | — |
| M3 | Add `EventType::MODE_EXCITATION` as a first-class event (0xF1 already reserved). `EventDispatcher::handleModeExcitation` calls `exciteMode` with the correct q/vel derived from payload. Reroute `play_mode` (A5) to push this event into `RealTimeEventBuffer`. | C++ + `pianoid.py` | M | Med — changes tight-coupling of `play_mode` with GPU. Thread-safe because the event is dispatched on engine thread, same as NOTE_ON. | M2 |
| M4 | Delete legacy `pianoidMidiListener.MidiListener` (A7), promote `MIDI_listener_unified` (A3) to only listener, and give it a proper `rtmidi.MidiIn` callback (not busy-wait). This also resolves P1 in DISTORTION_INVESTIGATION_CONTEXT.md. | `pianoid.py`, deprecations in `pianoidMidiListener.py` | M | Med — the legacy listener has feature-rich per-note CC handling. Re-implement those as `ParameterUpdateRequest` producers. | — |
| M5 | Sync PLAYBACK_SYSTEM.md §MidiInputListener with reality. Either delete the section (removes doc debt) OR re-add the C++ callback listener as part of M4. | Docs + optional C++ | S–L | Low-if-delete, Med-if-reimplement. | — |
| M6 | Unify WS and REST parameter dispatch. WS handlers should construct `ParameterUpdateRequest` and call a shared `_apply_parameter_request(request)` helper. Delete duplicated parsing/validation in `backendServer.py`. | `backendServer.py`, `parameter_manager.py` | S | Low — refactoring, same terminal calls. | — |
| M7 | `ParameterUpdateRequest` dataclass + `ParameterManager.apply(request)`. Migrate all granular callers. Bulk `setNewModeParameters` used only by init can stay as an internal detail of `apply(kind='mode', bulk=True)`. | `parameter_manager.py` | M | Low — preserve behaviour, refactor API. | M6 |
| M8 | `SoundBuffer` dataclass + round-trip helpers (`to_wav`, `from_wav`, `from_cpp_buffer`). Migrate one chart function (e.g., `play_note_offline_chart_function`) to return a `SoundBuffer`. | `chartFunctions.py` + new file | S | Low — additive; old code path continues. | — |
| M9 | `offline_session` context manager (`pianoid.offline_session(snapshot=True, preserve_audio=True)`). Wraps `enter_calibration_mode`/`exit_calibration_mode` + `runOfflinePlayback` + state snapshot/restore. Migrate all `chartFunctions._stop_online_engine / _restart_online_engine` pairs to use it. | `pianoid.py`, `chartFunctions.py` | M | Med — many call sites. Keep old functions for one release as wrappers. | — |
| M10 | Add `Pianoid::pushPrerecordedAudio(vector<float>, int sr)` — pushes samples directly into driver's circular buffer without synthesis. Python: `offline_session.play_buffer(sound_buffer)`. | C++ + `pianoid.py` | M | Med — needs audio-driver-agnostic primitive; buffer-sizing edge cases. | M8, M9 |
| M11 | State snapshot/restore: `PianoidStateSnapshot` captures `runtime_params`, `active_preset_name`, `listener_state`, `PlaybackConfig`. `offline_session.begin(snapshot=True)` calls `PianoidStateSnapshot.capture(pianoid)`; `end()` calls `restore(pianoid)`. | `pianoid.py` | M | Med — needs to play well with WIP.md "Preset System Revision". Actually, this is the same problem extended to offline sessions. | (interacts with) Preset System Revision |
| M12 | Back-pressure on `RealTimeEventBuffer`: soft cap, drop policy, counter. | C++ `RealTimeEventBuffer.cu` | S | Low — additive. | — |
| M13 | Integration tests under `tests/system/`: online→offline→online round-trip with parameter snapshot. Online burst-mode stress test (1000 events/sec) verifying no cycle-drift or burst. Offline `SoundBuffer` WAV round-trip. | `tests/system/` | M | Low. | M9, M10, M11 |

Recommended sequencing: **M1, M5, M6, M7, M12** independent; land first (clean-up, low risk). **M2 → M3 → M4** in order, gated on M2. **M8 → M9 → M11** in order. **M10** needs M8 + M9. **M13** last, uses the new APIs.

---

## 7. Open Questions

Questions for the user / decisions blocking design finalisation.

1. **Non-MIDI event types that do not fit the standard MIDI encoding** — does
   the user accept extending MIDI with `0xF1 MODE_EXCITATION`, `0xF2 RESET`,
   `0xF3 CONFIG_TOGGLE`? Or should mode excitation and reset stay as
   "Pianoid-specific playable events" with a non-MIDI encoding?
2. **Parameter events on the event path** — the existing `EventType` has
   `PARAM_UPDATE_SINGLE` / `PARAM_UPDATE_BATCH`. The user's vision treats
   parameters as a separate path. Confirm: remove parameter events from the
   event path entirely, OR keep them for specific real-time scenarios
   (e.g., MIDI CC for volume that must be cycle-accurate rather than
   immediate)?
3. **Internal audio format** — accept the `SoundBuffer` dataclass with
   float32 PCM + sidecar metadata (round-trip via WAV), or is there a
   requirement for a binary container with embedded metadata (so the format
   itself is losslessly round-trip without a sidecar)?
4. **Snapshot scope for offline → online restore** — what exactly must be
   preserved?
   - Runtime params (volume, feedback, volume_center/range, sensitivity): yes
   - Active preset name: yes
   - MIDI listener state (on/off + port): yes
   - `PlaybackConfig` (audio_enabled, record_to_buffer, max_duration_ms,
     sample_rate, samples_per_cycle): should these be part of the online
     engine's lifecycle config and kept across offline? Confirm.
   - Mode running state (`dev_mode_running`): this is zeroed by offline's
     `resetStringsState`. Do we restore the pre-offline state, or accept a
     clean slate (faster, simpler, but musically discontinuous)?
5. **"Play recorded sound through audio driver"** — does the user want this
   to support interleaving live online events alongside the prerecorded
   buffer (A/B comparison of two renders), or purely replay a pre-rendered
   track with no live events?
6. **Simultaneous offline + mic capture** — `enter_calibration_mode` already
   supports this. Should the new `offline_session.run` accept a `mic_capture`
   flag so a single call produces both synthesis-render and mic-capture
   buffers?
7. **Legacy `perform_midi_command` and `pianoidMidiListener.MidiListener`
   removal** — OK to delete outright (they are not referenced by the
   default startup path today) or keep for one release cycle under a
   deprecation flag?
8. **Doc/code drift audit** — any other documented APIs missing from the
   source tree besides P2 (`MidiInputListener`)? This review found no
   additional drift of that magnitude, but a systematic pass over
   `PLAYBACK_SYSTEM.md` binding table vs `AddArraysWithCUDA.cpp` pybind
   exports is recommended. Add this as a follow-up.
9. **Dedup policy uniformity** — the three producers have three policies:
   per-sid (WS), module-level last_command (REST), none (MIDI listener).
   Under unified scheduling, which semantics apply? Suggested: per-origin
   dedup token in `MidiEnvelope.flags` or channel byte, so each producer
   chooses independently.

---

## 8. Evidence Cross-Reference

| Source | File | Evidence |
|---|---|---|
| Online engine loop | `PianoidCore/pianoid_cuda/OnlinePlaybackEngine.cu:53-174` | `run()` loop, drift calibration, events/cycle |
| Offline engine loop | `PianoidCore/pianoid_cuda/OfflinePlaybackEngine.cu:53-184` | `run()` checks `shouldContinue()`, no audio driver |
| Cycle executor | `PianoidCore/pianoid_cuda/PlaybackCycleExecutor.cu:21-51` | `audio_enabled` gates `manageSoundBuffers` |
| Dispatcher | `PianoidCore/pianoid_cuda/EventDispatcher.cu:24-205` | All 9 event handlers |
| PlaybackEvent bit-packing | `PianoidCore/pianoid_cuda/EventDispatcher.cu:71-73, 87-92, 101` | `pitch<<8 | velocity`, sustain cc, etc. |
| `play_mode` bypass | `PianoidCore/pianoid_middleware/pianoid.py:877-936` | Direct `pianoid.exciteMode()`, polls cycle estimator |
| `add_realtime_event` | `PianoidCore/pianoid_middleware/pianoid.py:1391-1434` | target_cycle computation |
| `perform_midi_command` | `PianoidCore/pianoid_middleware/pianoid.py:785-833` | facade over `add_realtime_event` |
| `MIDI_listener_unified` busy-wait | `PianoidCore/pianoid_middleware/pianoid.py:1353-1389` | no `time.sleep` |
| REST `/play` | `PianoidCore/pianoid_middleware/backendServer.py:1162-1262` | unified+legacy paths, module dedup |
| WS `play` | `PianoidCore/pianoid_middleware/backendServer.py:127-217` | per-sid dedup |
| WS set_parameter | `PianoidCore/pianoid_middleware/backendServer.py:226-266` | duplicated glue |
| `ParameterManager._gpu_upload` | `PianoidCore/pianoid_middleware/parameter_manager.py:74` | `waitForParameterUpdate()` before upload (no `time.sleep`) |
| `render_midi_offline` | `PianoidCore/pianoid_middleware/pianoid.py:520-583` | reset + offline pattern |
| `enter_calibration_mode` | `PianoidCore/pianoid_middleware/pianoid.py:363-422` | keep audio open offline |
| `exit_calibration_mode` | `PianoidCore/pianoid_middleware/pianoid.py:424-478` | ASIO restart known failure |
| `stopEngineKeepAudio` | `PianoidCore/pianoid_cuda/Pianoid.cu:2554` | engine stop, audio alive |
| `runOfflinePlayback` | `PianoidCore/pianoid_cuda/Pianoid.cu:2952-2974` | C++ entry |
| `MidiEventConverter` | `PianoidCore/pianoid_cuda/MidiEventConverter.h:1-45` | existing MIDI bytes → PlaybackEvent converters |
| `chartFunctions._stop/_restart` | `PianoidCore/pianoid_middleware/chartFunctions.py:20-36` | `time.sleep(0.01)` busy wait |
| MidiInputListener absent | `PianoidCore/pianoid_cuda/` | No `MidiInputListener.h/.cpp` (P2 drift) |
