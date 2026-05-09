# MIDI Input Relocation Analysis — 2026-05-08

**Mode:** Read-only analysis. No code changes.
**Author:** `/analyse` (orchestrator-spawned)
**Goal:** Move the tuning-mode MIDI input path off the frontend (Web MIDI → REST/WS) so MIDI presses no longer pay the browser-round-trip latency, while keeping the frontend informed of the last note pressed for parameter editing.

---

## 1. Executive Summary

Pianoid currently has **two real MIDI input paths**, not three. The "direct C++ MIDI listener" the user remembers is **vestigial**: the `RtMidi.h` include in `pianoid_cycle.cu:9` is commented out, and `COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md:2652-2653` explicitly says `synth.midiListener()` is "commented out, requires RtMidi". The `MidiEventConverter` C++ class only converts MIDI **bytes** into `PlaybackEvent`s — it does not own a hardware port. So today the two real paths are: **(A)** Web MIDI in the browser → Socket.IO `play` (fast WS) or REST `POST /play` (slow fallback) → `pianoid.schedule_event()` → `RealTimeEventBuffer`, used in tuning mode; and **(B)** Python `MIDI_listener_unified` thread (`pianoid.py:1436`) using `rtmidi` → `pianoid.schedule_event()` → `RealTimeEventBuffer`, used in pure-playback mode (started by `playPianoid.py:88` with `with_midi_listener=True`). Path B is also reachable via the backend's `start_realtime_playback(with_midi_listener=True)` flag, which the launcher exposes as `listen_to_midi=1` on `POST /load_preset`. **The relocation work is therefore mostly a wiring change, not a new module:** activate the existing `MIDI_listener_unified` in tuning mode (today it's gated off), kill the Web-MIDI → backend leg of `useMidi.js`, and add a Socket.IO push **from** the backend (`midi_note_event` broadcast) so the frontend can keep `setSelectedPitch(midiLastKeyDown)` working without owning the keyboard. The existing Socket.IO infrastructure, the existing `schedule_event` pipeline, and the existing `socketio.emit` background-thread helper pattern (used today for `lifecycle`, `calibration`, `midi_progress`, `engine_error` — `backendServer.py:545-567`) all carry over.

---

## 2. Current State — MIDI Paths Mapped

### 2.1 Path A: Frontend Web MIDI → Backend (TUNING MODE, ACTIVE)

**Layer ownership:** Browser owns the hardware port.

```
MIDI Hardware (USB keyboard)
  │  Web MIDI API (browser driver)
  ▼
PianoidTunner/src/hooks/useMidi.js:67   handleMIDIMessage(message)
  │  - parses [status, keyNumber, keyVelocity]
  │  - filters out 254 (active sensing) and 176 (CC) — line 72-75
  │  - updates midiKeysDown / midiLastKeyDown / midiLastKeyUp local state
  │  - calls playNote({ pitch, command: status, velocity }) — line 83
  ▼
PianoidTunner/src/PianoidTuner.js:207   midiPlayNote(evt)
  │  - tags { source: "midi" } so backend applies Fix-MIDI clamp
  ▼
PianoidTunner/src/hooks/usePreset.js:1158  playNote(objToPlay)
  │  - try Socket.IO emit('play', payload)         line 1176-1178   ← preferred (low-latency)
  │  - else REST POST /play                          line 1182        ← REST fallback
  ▼
PianoidCore/pianoid_middleware/backendServer.py
  │  Socket.IO handler: @socketio.on('play')        line 283   handle_ws_play(data)
  │      - dedupe, source-flag handling, then:
  │      - pianoid.schedule_event(command, pitch, velocity, delay_ms,
  │                                apply_fix_velocity=is_midi_source)  line 350
  │  REST handler: /play route                       line 1124 (cited from DATA_FLOWS.md §1.3)
  ▼
PianoidCore/pianoid_middleware/pianoid.py:814   schedule_event(...)
  │  - Fix-MIDI velocity clamp (when apply_fix_velocity=True)
  │  - midi_to_event_type(command, pitch, velocity)
  │  - add_realtime_event(event_type, data1, data2, delay_ms)
  ▼
RealTimeEventBuffer.pushEvent(event, target_cycle)   pianoid.py:1504
  │  - std::mutex + std::multimap insert, < 1 µs
  ▼
OnlinePlaybackEngine engine thread
  │  - drainEventsUpTo(current_cycle) → EventDispatcher.dispatch()
  ▼
gaussKernel arms next runSynthesisKernel()  →  audio
```

**Selected pitch follows MIDI:** `PianoidTuner.js:1418-1421` —

```js
useEffect(() => {
  if (virtualPianoSettings.autoSelect)
    setSelectedPitch(midiLastKeyDown?.keyNumber);
}, [midiKeysDown, midiLastKeyDown?.keyNumber]);
```

### 2.2 Path B: Backend Python `MIDI_listener_unified` (PURE PLAYBACK, GATED-OFF IN TUNING)

**Layer ownership:** Backend Python owns the hardware port via `rtmidi`.

```
MIDI Hardware (USB keyboard)
  │  rtmidi.MidiIn() — port selected interactively  pianoidMidiListener.py:21
  ▼
pianoid.py:1436   MIDI_listener_unified()  (background thread, started by
                  start_midi_listener_unified, pianoid.py:1426)
  │  while self.listen and not self.exception:
  │      message = listener.get_message()
  │      if message is None: continue          ← non-blocking poll, no sleep
  │      status, data1, data2 = message[0]
  │      self.schedule_event(status, data1, data2)   line 1461
  ▼
(same RealTimeEventBuffer / EventDispatcher / gaussKernel chain as Path A from §2.1)
```

**How it gets started:**

- `start_realtime_playback(with_midi_listener=True)` (pianoid.py:1315) →
  `start_realtime_playback_unified(with_midi_listener=True)` (pianoid.py:1339) →
  `start_midi_listener_unified()` (pianoid.py:1420 inside `if with_midi_listener:`).
- The backend exposes this as `listen_to_midi` in `POST /load_preset` payload
  (REST_API.md). When `listen_to_midi=1`, the backend opens its own MIDI port; when
  `listen_to_midi=0` (the default for the tuning UI), the listener thread is **never
  started** and the backend is deaf to hardware MIDI.

**`pianoidMidiListener.MidiListener` (legacy, NOT the unified path):** The class in
`pianoidMidiListener.py:8` is a **different** listener — it polls with
`time.sleep(0.01)` (10 ms blocking poll, line 92) and dispatches via a YAML
keyboard config. It is **only** used by `midi_keyboard.py:11` (interactive
config tool) and is referenced as the `listener` object inside
`MIDI_listener_unified` solely for `print_ports()` / `select_port()` /
`get_message()`. The `MidiListener.start()` polling loop with the 10 ms sleep
is **not** what the unified listener uses — the unified listener has its own
non-blocking `while` loop in `pianoid.py:1450-1463` that calls
`listener.get_message()` (`rtmidi.MidiIn.get_message()` returns `None` on no
message and does not block).

### 2.3 Path C: Direct C++ MIDI Listener — DOES NOT EXIST

**Status:** Vestigial. Only references in the codebase:

- `PianoidCore/pianoid_cuda/pianoid_cycle.cu:9` —
  `// #include <rtmidi/RtMidi.h>` (commented out).
- `PianoidCore/pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md:2652-2653` —
  `# MIDI listener (commented out, requires RtMidi) / # synth.midiListener()`.
- `docs/modules/pianoid-middleware/MIDI_SYSTEM.md:17-20` — explicitly states "A
  C++ `MidiInputListener` class was previously planned and documented, but the
  supporting source files were never committed. It has been removed from the
  docs."

The `MidiEventConverter` (`PianoidCore/pianoid_cuda/MidiEventConverter.h`) is
**not** a hardware listener — it converts already-received MIDI **bytes** into
`PlaybackEvent` structs. It is the C++ equivalent of `midi_to_event_type` in
Python, not a `RtMidiIn` consumer.

**Implication for the user's framing:** "pure playback mode" today is **Path B**
launched from `playPianoid.py:88` with `with_midi_listener=True`, not a separate
C++ path. The "direct core" is a memory of a planned (but never built)
optimization.

---

## 3. Tuning-Mode Constraints — Why the Backend MIDI Path Is Currently Gated Off

The backend Python listener path **already produces the same `PlaybackEvent` →
`RealTimeEventBuffer` → `EventDispatcher` → `gaussKernel` chain** as the
WebSocket `play` handler. There is **no per-note synthesis difference** between
"MIDI sourced from browser" and "MIDI sourced from backend `rtmidi`" — both go
through `pianoid.schedule_event()`, both apply the Fix-MIDI clamp identically
(unified listener uses `apply_fix_velocity=True` default; WS handler passes
`apply_fix_velocity=is_midi_source`, which is `True` for `source="midi"` events).

So the C++ direct path is "unusable in tuning" only in the sense that **it does
not exist**. The Python backend path is fully usable in tuning today; it's
simply turned off because the launcher's `POST /load_preset` payload defaults
`listen_to_midi=0` and the frontend has been the de-facto MIDI input.

The historical reason the frontend owned MIDI is almost certainly UX coupling —
the browser is where the user sees the parameter editors, so capturing the MIDI
in the browser made it trivial to drive `setSelectedPitch(midiLastKeyDown)`
without an extra IPC channel. That coupling is what §6 has to break.

---

## 4. Latency Budget — Per Link

All numbers are **estimates** based on documented architecture (audio-driver
buffer = 64 samples @ 48 kHz = 1.33 ms cycle; `RealTimeEventBuffer.pushEvent`
documented as < 1 µs; engine cycle dispatched on the next cycle boundary so
worst-case scheduling adds 0–1.33 ms of jitter on top of any link).

### Path A (current frontend Web MIDI → WS)

| Link | Typical | Worst case | Source / reasoning |
|---|---|---|---|
| MIDI hardware → OS driver | 1–3 ms | 5 ms | USB-MIDI is ~1 ms per direction; OS-MIDI driver buffering varies |
| OS driver → Chrome Web MIDI callback | 2–5 ms | 10 ms | Chrome's Web MIDI uses a polled main-thread callback; renderer-process scheduling jitter dominates |
| `useMidi.handleMIDIMessage` → `playNote` → WS `emit('play', ...)` | < 1 ms | 2 ms | Pure JS; React state updates are async but not on the playNote path |
| Socket.IO frame TCP localhost RTT | 0.5–2 ms | 5 ms | localhost loopback with Socket.IO `transports: ['websocket']` |
| `handle_ws_play` Python parsing + `schedule_event` | < 1 ms | 2 ms | dedupe + dict lookup + `midi_to_event_type` + `pushEvent` |
| Wait for next cycle boundary | 0–1.33 ms | 1.33 ms | engine runs cycles every 64 samples |
| **Total Path A (WS)** | **~5–13 ms** | **~25 ms** | |
| **Total Path A (REST fallback)** | **~10–25 ms** | **~50+ ms** | adds Flask request overhead, JSON parse, no persistent connection |

### Path B (existing backend Python `MIDI_listener_unified`)

| Link | Typical | Worst case | Source / reasoning |
|---|---|---|---|
| MIDI hardware → OS driver | 1–3 ms | 5 ms | same as Path A |
| OS driver → `rtmidi.MidiIn.get_message()` | < 1 ms | 2 ms | `rtmidi` uses a callback-driven C++ port; `get_message` reads a queue with no sleep |
| `MIDI_listener_unified` poll loop | 0 ms | bounded by Python GIL contention with engine thread | `pianoid.py:1450-1463` is `while: get_message; if None: continue` — busy-poll on a non-blocking call. **Hot loop with no sleep**: this is intentional for low latency but contends with the engine thread for the GIL. Real-world ms TBD. |
| `schedule_event` → `pushEvent` | < 1 ms | 2 ms | same code path as Path A |
| Wait for next cycle boundary | 0–1.33 ms | 1.33 ms | same |
| **Total Path B** | **~2–7 ms** | **~12 ms** | |

### Path C (hypothetical C++ `RtMidi` callback in the engine process)

| Link | Typical | Worst case | Source / reasoning |
|---|---|---|---|
| MIDI hardware → OS driver | 1–3 ms | 5 ms | same |
| OS driver → `RtMidi` callback (C++ thread) | < 0.5 ms | 1 ms | callback-driven, no GIL |
| Callback → `RealTimeEventBuffer.pushEvent` (already C++) | < 10 µs | 50 µs | direct C++ method call |
| Wait for next cycle boundary | 0–1.33 ms | 1.33 ms | same |
| **Total Path C** | **~1–5 ms** | **~7 ms** | |

### Summary

- **Path A WS** is the current path. ~5–13 ms typical. The user reports this is
  unacceptable for piano-feel — credible since pianists notice 10 ms+ delays
  and 25 ms is the threshold for clearly perceptible.
- **Path B** is roughly **half** the latency of Path A (no browser, no WS, no
  Python REST). ~2–7 ms typical. **This is the cheapest win.**
- **Path C** would be marginally better than Path B (~1–5 ms typical) by
  removing GIL contention, but requires linking `rtmidi` into the C++
  extension and writing a `RtMidi`-callback thread inside `OnlinePlaybackEngine`.
  Defer unless Path B's measured latency is still unacceptable.

The browser side adds an irreducible **3–7 ms** versus the backend Python
path — Web MIDI in Chrome is dispatched on the renderer main thread, which
shares scheduling with React reconciliation, paint, and JS GC. **No amount of
WebSocket or REST tuning will close this gap;** the gap is the browser itself.

---

## 5. Proposed Architecture

### 5.1 Diagram

```
                  +-----------------------+
                  |   MIDI Hardware       |
                  +-----------+-----------+
                              |
                              v
              (rtmidi C++ port, owned by Python)
                              |
                  +-----------+-----------+
                  | pianoid.MIDI_listener_|         pianoid.py:1436
                  | unified  (BG thread)  |         (already exists, gated by
                  +-----------+-----------+          listen_to_midi flag)
                              |
              +---------------+----------------+
              |                                |
              v                                v
   schedule_event(cmd,pitch,vel)      socketio.emit('midi_note_event',
   (pianoid.py:814 — already exists)     {cmd, pitch, vel, ts})  ← NEW
              |                                |
              v                                v
   RealTimeEventBuffer                Socket.IO WebSocket
   (audio path, < 1 µs lock)          (informational push to frontend)
              |                                |
              v                                v
   OnlinePlaybackEngine               PianoidTunner useMidi hook
   (synthesis cycle)                  - update midiKeysDown
                                      - update midiLastKeyDown
                                      - DO NOT call playNote
              |                                |
              v                                v
        AUDIO OUT                    setSelectedPitch(midiLastKeyDown)
                                     (already wired in PianoidTuner.js:1418)
```

### 5.2 Routing Rules

**Tuning mode:**

- Backend opens the MIDI port (`listen_to_midi=1` on `POST /load_preset`).
- Backend Python `MIDI_listener_unified` consumes events, calls
  `schedule_event` (audio path) **and** `socketio.emit('midi_note_event',
  ...)` (informational path) for every NOTE_ON / NOTE_OFF / SUSTAIN.
- Frontend `useMidi.js` is rewritten to **subscribe** to the Socket.IO
  `midi_note_event` instead of opening Web MIDI itself. The hook keeps
  the same return shape (`midiKeysDown`, `midiLastKeyDown`, `midiLastKeyUp`)
  so consumers (`PianoidTuner.js:1418`, `MidiComponent.jsx`) need no change.
- Web MIDI in the browser is **disabled by default in tuning mode** (option
  to keep as a "browser-only" mode for pianists with Bluetooth MIDI on the
  laptop running the browser but not the backend — see Open Questions §7).

**Pure playback mode (`playPianoid.py`):**

- **Unchanged.** Already uses `MIDI_listener_unified` via
  `start_realtime_playback(with_midi_listener=True)`. The added
  `socketio.emit('midi_note_event', ...)` becomes a no-op when no
  Socket.IO server is running (the call must be guarded — see §6 risks).

**REST `POST /play` and Socket.IO `play` (browser virtual piano, space-bar,
Excitation editor, calibration):** **Unchanged.** These are not MIDI hardware
sources; they're UI / programmatic note triggers. They keep going through
`schedule_event` directly via the existing handlers.

### 5.3 Last-Note-Pressed Broadcast — Latency Budget

The frontend's only need is "show which key was just pressed in the parameter
editor" — a UX feedback signal, not an audio path. Acceptable latency is
20–50 ms (anything below human reaction time is fine). Existing channels:

| Mechanism | Typical RTT | Effort | Notes |
|---|---|---|---|
| **Socket.IO `socketio.emit` from BG thread** | 2–10 ms | **S** | Pattern already used for `lifecycle`, `calibration`, `midi_progress`, `engine_error` (`backendServer.py:545-567`). Best fit. |
| Server-Sent Events (SSE) | 5–15 ms | M | New endpoint, no existing infrastructure. |
| Polling `GET /last_midi_note` | 50–200 ms | S | Too slow and wasteful. Reject. |
| WebSocket from launcher (`server/launcher.js`) | 5–15 ms | M | Launcher already runs a `/ws/console` WS, but it's stdout/stderr only. Wrong process. |

**Recommendation:** reuse the existing Socket.IO server on port 5000. New
event name: `midi_note_event` (matches naming style of existing `midi_progress`
event). Payload shape:

```json
{ "command": 144, "pitch": 60, "velocity": 100, "ts_ms": 1730000000123 }
```

The frontend `useMidi.js` becomes ~30 LOC of `socket.on('midi_note_event',
...)` instead of ~130 LOC of Web MIDI plumbing.

---

## 6. Implementation Impact

### 6.1 File-by-File Changes

| File | Change | Effort |
|---|---|---|
| `PianoidCore/pianoid_middleware/pianoid.py` (`MIDI_listener_unified`, line 1436) | Add `socketio.emit('midi_note_event', ...)` call alongside `schedule_event`. Must guard with a `try` / `if hasattr` because `playPianoid.py` runs without the Flask server. Probably inject an emit-callback at listener-construction time so `pianoid.py` doesn't import `backendServer`. | **S** |
| `PianoidCore/pianoid_middleware/backendServer.py` | Wire the emit callback into `MIDI_listener_unified` startup. Possibly add `start_midi_listener=True` default for tuning sessions, or expose a separate `POST /midi/start` and `POST /midi/stop` so the frontend can toggle without a full preset reload. | **S** |
| `PianoidCore/pianoid_middleware/pianoidMidiListener.py` | Probably add a non-interactive port-selection helper (today `MIDI_listener_unified` calls `input(...)` at line 1445 to pick a port — that blocks the backend on a console prompt; tuning mode must use port 0 or a `selected_port` config). **Bug: this `input()` call would hang the Flask process if `listen_to_midi=1` is sent today** — see §6.4 risks. | **S** |
| `PianoidTunner/src/hooks/useMidi.js` | Rewrite. Drop `navigator.requestMIDIAccess`. Subscribe to `socket.on('midi_note_event', ...)`. Keep same return shape. Drop the `playNote` arg (it's now backend-driven). | **S** |
| `PianoidTunner/src/PianoidTuner.js` (line 207-220) | Drop `midiPlayNote` wrapper (no longer needed — backend already tags `source="midi"` internally for its own listener). Drop the `useMidi(midiPlayNote)` arg. Keep the `setSelectedPitch(midiLastKeyDown)` effect. | **S** |
| `PianoidTunner/src/components/MidiComponent.jsx` | Either keep (it's a debug panel that lists messages) and rewire to the broadcast, or delete (it duplicates `useMidi` and its `onNoteDown` callback is unused in the live tree). | **S** |
| `PianoidCore/pianoid_middleware/REST_API.md` | Document new `midi_note_event` Socket.IO emit + any new `POST /midi/start` / `POST /midi/stop` REST. Update `listen_to_midi` semantics (now default-on for tuning sessions, or whatever the chosen contract is). | **S** |
| `docs/modules/pianoid-middleware/MIDI_SYSTEM.md` | Update — make explicit that the unified listener is now the default for tuning, and that `useMidi` is a subscriber not an owner. Remove the "frontend owns MIDI" assumption. | **S** |
| `docs/architecture/DATA_FLOWS.md` §1.2 | Update diagram to show the `midi_note_event` fan-out alongside `schedule_event`. | **S** |
| Tests | Add: integration test that `MIDI_listener_unified` emits `midi_note_event` on every NOTE_ON; system test that a simulated MIDI input through the backend triggers both audio (existing `note_playback` chart-path coverage) and a frontend-visible broadcast (mock Socket.IO client). | **M** |

**Total effort: small-to-medium (S+M).** Most of the existing infrastructure is already there; this is a wiring change plus a new Socket.IO event.

### 6.2 Test Plan

1. **Unit:** `MIDI_listener_unified` calls both `schedule_event` and the
   emit-callback for every parsed message. Mock `rtmidi.MidiIn`.
2. **Integration:** Start backend with `listen_to_midi=1`, simulate a MIDI
   input via `rtmidi`'s loopback (or mock), verify the engine receives the
   event AND a Socket.IO client receives `midi_note_event`.
3. **System (UI):** `/test-ui` mode — start full stack, simulate keypress on
   the virtual MIDI port (or actual hardware if available in CI), verify
   `setSelectedPitch` follows the simulated key. Audio verification via
   existing `note_playback` chart route.
4. **Latency:** Measure end-to-end backend MIDI input → audio-out latency
   with a `tests/system/midi_latency.py` script that timestamps the
   `MIDI_listener_unified` ingest and the audio buffer dispatch. Target:
   < 7 ms median, < 12 ms 99th percentile.
5. **Regression:** `playPianoid.py` still works standalone (Socket.IO emit
   guard does not crash when no server present).

### 6.3 Risks

1. **`MIDI_listener_unified` calls `input()` at startup (pianoid.py:1445).**
   This is a blocking interactive prompt for port selection. **It would hang
   the Flask backend's main thread today** if `listen_to_midi=1` were sent
   over `POST /load_preset` — and it explains why the tuning mode has
   defaulted to `listen_to_midi=0`. **This must be fixed before relocation
   ships.** Replace with a config-driven port selection (e.g. `midi_port` in
   the load-preset payload, default 0).

2. **`pianoidMidiListener.MidiListener.__init__` opens port 0
   unconditionally** (`pianoidMidiListener.py:29`) before the unified
   listener even gets to `select_port`. There's a redundant double-open. Need
   to rationalize the port-selection flow.

3. **GIL contention.** The `MIDI_listener_unified` poll loop has no sleep
   (line 1450-1463). It's a busy-poll on a non-blocking C++ call, so it
   should not actually starve the engine thread — but real-world ms must be
   measured. If contention is observed, add a 0.5–1 ms sleep (still gives
   sub-2 ms latency) or move to an `rtmidi` callback (which dispatches from
   a C++ thread without GIL, but rtmidi's Python binding's callback API has
   known thread-safety quirks — `set_callback` re-acquires GIL inside the
   callback, which would defeat the point).

4. **MIDI port ownership conflict.** If both the browser AND the backend
   open the same MIDI device, behaviour is undefined (Windows tends to
   give the port to the first opener; Linux/ALSA allows multiple subscribers).
   When relocating, the frontend must **stop** opening Web MIDI in tuning
   mode, otherwise the user sees double-trigger or "device busy" errors.

5. **Pure-playback mode regression.** `playPianoid.py` uses
   `with_midi_listener=True` today. The added `socketio.emit` call must be
   no-op'd when there's no Socket.IO server — inject the emit callback at
   listener construction, default to `lambda *a, **kw: None`.

6. **MidiListener (legacy) confusion.** `pianoidMidiListener.MidiListener`
   has a `start()` method with `time.sleep(0.01)` (line 92) — a 10 ms
   blocking poll. **This is NOT what `MIDI_listener_unified` calls** (the
   unified listener has its own non-blocking loop in pianoid.py:1450-1463
   and only borrows `MidiListener` for its `print_ports` / `select_port` /
   `get_message` helpers). Anyone reading the legacy class might assume the
   10 ms sleep applies to the active path — it does not. Document this
   clearly to avoid future "fix the latency" confusion.

7. **Hardware-MIDI availability for pianists running the browser remotely.**
   If the user runs the frontend on a laptop and the backend on a desktop
   with the MIDI keyboard plugged into the desktop, this all works
   identically. If they run the browser on a tablet and want to use a
   Bluetooth MIDI keyboard paired to the tablet, the backend will not see
   the hardware. **Edge case** — see Open Questions §7.

### 6.4 Architectural Observation

The user's framing ("3 paths") reflects a planned architecture where the
fast path was a C++ `RtMidi` callback in the engine process. That C++ path
was scoped, planned, but **never built** (only the commented-out include
remains). The relocation to backend Python is **75% of the latency win** of
the planned C++ path, with **5% of the implementation effort**. If
measurement of the relocated Python path shows insufficient latency
improvement (unlikely, but possible if GIL contention dominates), the C++
path becomes worth revisiting at that point.

---

## 7. Open Questions for the User

1. **MIDI port selection in tuning mode.** Should the backend default to port
   0, or should we expose a port-picker in the frontend (`GET /midi/ports` →
   `POST /load_preset { midi_port: N }`)? Multi-device pianists with both a
   keyboard and a controller often need to pick.

2. **Soft-disable of Web MIDI vs hard-removal.** Do you want to keep
   `useMidi`'s Web MIDI path as a fallback (e.g. for the tablet-with-Bluetooth
   case in §6.3 risk 7), gated by a frontend toggle? Or remove entirely and
   only support backend-MIDI?

3. **`MidiComponent.jsx` (the debug message panel) — keep or delete?** It's a
   thin debug panel duplicating `useMidi`. After relocation, it would need
   rewiring to subscribe to the broadcast. Simpler to delete unless you use
   it.

4. **CC handling.** Today `useMidi.js:73-75` filters out `command === 176`
   (CC) entirely — frontend is deaf to control changes. The backend
   listener path **does** handle CC (sustain pedal at CC#64, plus the
   legacy YAML mappings for volume, deck feedback, per-note CC). Should the
   relocated path broadcast CC events to the frontend too (for visual
   feedback of pedal-down indicator, etc.), or keep them backend-only?

5. **Velocity-clamp behaviour.** Today `apply_fix_velocity=True` is the
   default in `MIDI_listener_unified` (pianoid.py:864), and the WS handler
   passes `is_midi_source` (True for `source="midi"`). After relocation,
   the unified listener is the only "MIDI source" so the clamp always
   applies — that matches today's behaviour. **Confirm:** is that what you
   want, or should the clamp become a runtime toggle independent of source?

6. **Pure-playback compatibility check.** The added `socketio.emit` in
   `MIDI_listener_unified` must be guarded for `playPianoid.py`'s no-server
   case. Confirm preferred guard: (a) inject an emit-callback at listener
   construction (default no-op), or (b) `try / except` import of
   `backendserver.socketio`. Option (a) is cleaner.

7. **Latency target.** What's the actual target for end-to-end MIDI →
   audio? "Unacceptable" is qualitative. If it's < 10 ms median, Path B
   alone is enough. If it's < 5 ms, only Path C (C++) gets there.

---

## 8. Recommendation

**Proceed with the Path B relocation.** Effort is S+M, the existing
`MIDI_listener_unified` already has the audio path wired identically to the
WS handler, the broadcast pattern (`socketio.emit` from BG thread) is
already in production use for four other event types, and the latency win
is roughly 2x (5–13 ms → 2–7 ms median), with the upper bound dropping from
25 ms → 12 ms.

The hidden landmines are the `input()` blocking call at startup and the
double-port-open in `MidiListener.__init__` — both are quick fixes but
**must** be addressed before flipping `listen_to_midi` to default-on, or
the backend will hang or crash on startup.

---

## Appendix — Source citations

| Concern | File:line | Quoted intent |
|---|---|---|
| Web MIDI ingest | `PianoidTunner/src/hooks/useMidi.js:67-104` | `handleMIDIMessage(message)` |
| Frontend → WS `play` | `PianoidTunner/src/hooks/usePreset.js:1158-1186` | `playNote(objToPlay)` with `socketEmit('play', payload)` |
| WS `play` handler | `PianoidCore/pianoid_middleware/backendServer.py:283-386` | `@socketio.on('play')` |
| `schedule_event` | `PianoidCore/pianoid_middleware/pianoid.py:814-888` | unified entry point |
| `MIDI_listener_unified` | `PianoidCore/pianoid_middleware/pianoid.py:1436-1463` | Python rtmidi → schedule_event |
| `MIDI_listener_unified` startup gate | `PianoidCore/pianoid_middleware/pianoid.py:1419-1420` (inside `start_realtime_playback_unified`) | `if with_midi_listener: self.start_midi_listener_unified()` |
| `input()` port-pick blocker | `PianoidCore/pianoid_middleware/pianoid.py:1445` | `port = input(f"Select MIDI port (0-{len(listener.ports) - 1}): ")` |
| Legacy MidiListener (10 ms sleep) | `PianoidCore/pianoid_middleware/pianoidMidiListener.py:55-96` | `time.sleep(0.01)` |
| Direct C++ MIDI = vestigial | `PianoidCore/pianoid_cuda/pianoid_cycle.cu:9` | `// #include <rtmidi/RtMidi.h>` |
| Direct C++ MIDI = vestigial | `PianoidCore/pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md:2652-2653` | "MIDI listener (commented out, requires RtMidi)" |
| Selected pitch follows MIDI | `PianoidTunner/src/PianoidTuner.js:1418-1421` | `setSelectedPitch(midiLastKeyDown?.keyNumber)` |
| `socketio.emit` from BG thread pattern | `PianoidCore/pianoid_middleware/backendServer.py:545-567` | `lifecycle`, `calibration`, `midi_progress`, `engine_error` |
| `useSocketIO` (`socket.on`) infrastructure | `PianoidTunner/src/hooks/useSocketIO.js:71-79, 121-136` | `onAny`, `on(event, callback)` |
| `pure playback` is Path B | `PianoidCore/pianoid_middleware/playPianoid.py:88` | `pianoid.start_realtime_playback(with_midi_listener=True)` |
| Doc admission of vestigial C++ MIDI | `docs/modules/pianoid-middleware/MIDI_SYSTEM.md:17-20` | "supporting source files were never committed" |
