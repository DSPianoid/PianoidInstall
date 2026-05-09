# WebSocket Migration Analysis: REST API to Bi-Directional WebSocket

> **Implementation Status:** All 4 phases complete (2026-04-10/11). See `feature/websocket-migration` branch.
> Tests: 30/30 pass (20 unit in `test_websocket.py`, 10 integration in `test_websocket_integration.py`).

## Executive Summary

Replace the REST API between PianoidTunner (React) and PianoidCore (Flask middleware) with a hybrid REST + WebSocket architecture. The primary motivation is reducing MIDI note playback latency — currently ~10-20 ms via REST vs ~7 ms via hardware MIDI. A WebSocket channel can save 3-11 ms per note by eliminating HTTP overhead, and also enables server-push for status monitoring, calibration progress, and error notifications.

**Recommendation: Hybrid approach.** Keep REST for query/command endpoints (~27), add a single WebSocket channel for real-time events (~5 event types + note input).

---

## 1. Current State

### REST API Surface: 36 Endpoints

| Category | Count | Examples |
|----------|-------|---------|
| Lifecycle/System | 5 | `/ping`, `/health`, `/get_settings`, `/shutdown`, `/reset` |
| Preset Management | 6 | `/load_preset`, `/save_preset`, `/preset/list`, `/preset/load` |
| Parameter Read | 5 | `/get_parameter/<p>/<k>`, `/get_available_notes`, `/get_string_map` |
| Parameter Write | 7 | `/set_parameter/<p>/<k>`, `/set_string_excitation/<pitch>`, `/set_hammer_shape/<pitch>` |
| Playback | 4 | `/play`, `/play_mode/<n>`, `/midi_playback`, `/playback_stats` |
| Charts/Actions | 4 | `/graph_names`, `/get_chart_test`, `/start_test`, `/capture` |
| Calibration | 5 | `/calibrate_volume`, `/calibration_status`, `/calibration_cancel`, `/mic_devices` |

### Three MIDI Playback Paths

| Path | Transport | Per-Note HTTP? | Typical Latency |
|------|-----------|----------------|-----------------|
| Hardware MIDI (rtmidi) | Direct `MidiListener` -> `RealTimeEventBuffer` | No | ~7 ms |
| REST `/play` | `axios.post` -> Flask -> `add_realtime_event()` | Yes | ~10-20 ms |
| REST `/midi_playback` | Single POST, events pre-scheduled in batch | No (batch) | N/A (file playback) |

### Frontend Communication Patterns

- **Health polling**: `useBackendHealth` polls `GET /health` every 30 seconds
- **Parameter writes**: Debounced at 300 ms per category (`usePreset`)
- **Note playback**: Raw `axios.post` with **no debounce** — every note is a separate HTTP request
- **Existing WebSocket**: Node.js launcher already uses `ws` at `/ws/console` for stdout streaming (separate from Flask)

---

## 2. MIDI Latency Deep Dive

### Latency Budget: REST `/play` vs Hardware MIDI

| Component | REST `/play` | Hardware MIDI | WebSocket Fix? |
|-----------|-------------|---------------|----------------|
| HTTP round-trip (TCP + routing) | 2-10 ms | 0 ms | **YES** (saves 2-10 ms) |
| JSON parse + serialize | 0.5-1 ms | 0 ms | **YES** (binary frames) |
| Console `print()` (2x per note) | 1-2 ms | 0 ms | NO (code fix needed) |
| Event scheduling (+1 cycle) | 1.33 ms | 1.33 ms | NO (inherent) |
| Audio buffer (4 x 64 spc @ 48kHz) | 5.33 ms | 5.33 ms | NO (inherent) |
| **Total typical** | **~10-20 ms** | **~7 ms** | **Save ~3-11 ms** |

### Latency Sources Explained

**HTTP round-trip (2-10 ms):** Each note requires a full HTTP request/response cycle. On localhost this is typically 2-5 ms but can spike to 10+ ms under load or GIL contention. This is the largest reducible latency source.

**JSON overhead (0.5-1 ms):** `request.get_json()` parsing + `jsonify()` serialization on every note. A binary WebSocket frame could carry `{pitch, velocity, command}` in 3-4 bytes instead of ~50 bytes + HTTP headers.

**Console logging (1-2 ms):** Two synchronous `print()` calls per note (`backendServer.py:751,783`). Stdout is piped through `launcher.js`, adding I/O blocking. This is a code issue — should be removed or made conditional regardless of WebSocket migration.

**Event scheduling (1.33 ms):** `add_realtime_event()` schedules for `currentCycle + 1`. This is 64 samples / 48000 Hz = 1.33 ms. Inherent to the event buffer design, same for all paths.

**Audio buffer (5.33 ms):** `audio_buffer_size: 4` chunks of 64 samples = 256 samples at 48kHz. Inherent to the audio driver. ASIO callback mode gives lowest latency.

### What WebSocket Fixes for MIDI

1. **Eliminates per-note HTTP overhead** — persistent connection, sub-millisecond frame delivery
2. **Enables binary message format** — 3-4 bytes per note instead of JSON + HTTP headers
3. **Enables chord batching** — multiple simultaneous notes in a single frame
4. **Reduces GIL contention** — fewer Flask request-handling threads competing

### What WebSocket Does NOT Fix

- Event scheduling latency (1.33 ms) — inherent to `currentCycle + 1` design
- Audio buffer latency (5.33 ms) — inherent to audio driver
- Console logging overhead — needs code fix (remove/make debug-only)
- GIL contention from other heavy endpoints — still a Python limitation

### Additional Code Fixes (Independent of WebSocket)

These should be done regardless of WebSocket migration:

1. **Remove/conditionally disable `print()` in `/play` path** — saves 1-2 ms per note
2. **Add deduplication to unified play path** — legacy path has `last_command` dedup but unified path (`backendServer.py:762`) does not
3. **Consider `audio_buffer_size: 2`** — would reduce audio latency from 5.33 ms to 2.67 ms at the cost of higher CPU load

---

## 3. WebSocket Benefits Beyond MIDI

### High Value

| Use Case | Current Approach | WebSocket Improvement |
|----------|-----------------|----------------------|
| Health/lifecycle monitoring | Poll `GET /health` every 30s | Push state changes instantly (UNINITIALIZED -> LOADED -> ACTIVE) |
| Calibration progress | Must poll `GET /calibration_status` | Push real-time progress (pitch, percentage, RMS levels) |
| MIDI file playback progress | No visibility into position | Push current position, completion events |
| Engine errors/crashes | Discovered on next health poll (up to 30s delay) | Push error events immediately |

### Medium Value

| Use Case | Current Approach | WebSocket Improvement |
|----------|-----------------|----------------------|
| Parameter update confirmation | Fire-and-forget POST | Push actual applied value (after clamping/rounding) |
| Chart rendering progress | No progress indication | Push progress for long-running computations |

---

## 4. What Should Stay as REST

These are inherently request-response and gain nothing from WebSocket:

- **Preset file operations**: `/load_preset`, `/save_preset` — file I/O with clear success/fail
- **Data retrieval**: `/get_parameter`, `/get_available_notes`, `/get_string_map`, `/get_block_map`, `/graph_names`, `/command_names`, `/get_settings`
- **Chart data**: `/get_chart_test` — large payloads (waveform arrays, base64 WAV); HTTP is better for large responses
- **One-shot commands**: `/shutdown`, `/reset`, `/capture`, `/play_mode`
- **Boot connectivity**: `/ping`, `/get_settings` — needed before WebSocket is established

**~27 endpoints remain as REST.** No existing endpoint needs to be deleted.

---

## 5. Proposed WebSocket Event Schema

### Client -> Server (Note Input)

```
Binary frame: [command(1 byte), pitch(1 byte), velocity(1 byte)]
Example: [0x90, 0x3C, 0x64]  // Note-on, C4, velocity 100
```

Or JSON for compatibility:
```json
{"type": "play", "pitch": 60, "velocity": 100, "command": 144}
```

### Client -> Server (Parameter Updates)

```json
// Generic parameter update (mirrors POST /set_parameter/<p>/<k>)
{"event": "set_parameter", "parameter": "string", "key": "60", "values": {"60": {"tension": 0.985}}}

// Runtime parameters (volume, feedback, sensitivity)
{"event": "set_runtime_parameters", "volume": 80, "feedback": 64, "volume_center": 5000, "volume_range": 6}

// String excitation curves
{"event": "set_string_excitation", "pitch": 60, "level": 2, "curves": {"0": {"sigma": 0.01, "mu": 0.5}}}

// Hammer shape
{"event": "set_hammer_shape", "pitch": 60, "width": 0.012, "position": 0.09, "sharpness": 0.7}
```

### Server -> Client (Push Events)

```json
// Lifecycle state change
{"event": "lifecycle", "state": "PLAYBACK_ACTIVE", "preset": "BaselinePreset1"}

// Calibration progress
{"event": "calibration", "progress": 0.45, "pitch": 60, "rms": 0.0092, "message": "Measuring C4 at velocity 3/5"}

// MIDI playback progress
{"event": "midi_progress", "position_ms": 15000, "total_ms": 30000, "notes_played": 142}

// Engine error
{"event": "error", "code": "engine_crash", "message": "CUDA out of memory"}

// Parameter acknowledgment
{"event": "param_ack", "parameter": "string", "key": "60", "status": "ok"}
{"event": "param_ack", "parameter": "runtime", "status": "ok", "updated": {"volume": 80}}
```

---

## 6. Implementation Plan

### Backend (Flask + Flask-SocketIO)

**Dependencies:**
```
flask-socketio>=5.3
python-socketio>=5.10
```

**Changes:**

1. Wrap Flask app with SocketIO:
   ```python
   from flask_socketio import SocketIO
   socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")
   ```

2. Add WebSocket note handler (~20 lines):
   ```python
   @socketio.on('play')
   def handle_play(data):
       pw.add_realtime_event(data['pitch'], data['velocity'], data['command'])
   ```

3. Emit lifecycle events from `PianoidState` transitions (~15 lines in `pianoid.py`)

4. Emit calibration progress from `CalibrationController` (~10 lines)

5. Replace `app.run()` with `socketio.run(app)` in server startup

**Risk:** Step 5 changes the server threading model. `async_mode="threading"` keeps compatibility with the existing thread-based architecture. Must verify `cuda_lock` behavior is unaffected.

### Frontend (React + socket.io-client)

**Dependencies:**
```
socket.io-client@^4.7
```

**Changes:**

1. New `useSocketIO` hook (~80-100 lines):
   - Manages connection/reconnection
   - Exposes `emit()` for note sending
   - Dispatches incoming events to registered listeners

2. Modify `usePreset.js` `playNote()` — use WebSocket `emit('play', ...)` instead of `axios.post('/play', ...)`

3. Modify `useBackendHealth` — listen for `lifecycle` events, keep REST polling as fallback when WebSocket is disconnected

4. Add calibration progress listener (new capability)

### Estimated Scope

| Area | Lines of Code | Risk |
|------|--------------|------|
| Backend: SocketIO setup + event emitters | ~80-100 | Low-Medium |
| Backend: Server startup change | ~5 | Medium (threading model) |
| Frontend: `useSocketIO` hook | ~80-100 | Low |
| Frontend: `playNote` migration | ~10 | Low |
| Frontend: health listener update | ~20 | Low |
| **Total** | **~200-300** | **Low-Medium** |

No existing REST endpoints need to be removed or modified. The WebSocket layer is purely additive.

---

## 7. Migration Strategy

### Phase 1: WebSocket Infrastructure (Low Risk)
- Add Flask-SocketIO to backend, `socket.io-client` to frontend
- Implement `useSocketIO` hook with connection management
- Add lifecycle event push (replace health polling)
- Keep all REST endpoints functional as fallback

### Phase 2: Note Playback via WebSocket (Medium Risk)
- Move `/play` note input to WebSocket channel
- Implement binary frame format for minimum latency
- Keep REST `/play` endpoint as fallback
- Benchmark latency improvement

### Phase 3: Status Push Events (Low Risk)
- Add calibration progress push
- Add MIDI playback progress push
- Add engine error push
- Remove polling where WebSocket covers it

### Phase 4: Parameter Updates via WebSocket (Low Risk)
- Add `set_parameter` WS handler mirroring REST `POST /set_parameter/<p>/<k>`
- Add `set_string_excitation`, `set_hammer_shape` WS handlers
- Add `set_runtime_parameters` WS handler (volume, feedback, sensitivity)
- Frontend: all 8 debounced parameter write paths try WS first, REST fallback
- Debounce reduced from 300ms to 50ms when WS connected (volume/feedback: 100ms to 50ms)
- `param_ack` event returned to client on each successful parameter update
- Extracted `_map_feedback_to_coefficient()` helper for MIDI-to-coefficient mapping

---

## 8. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Flask-SocketIO threading conflicts with `cuda_lock` | Engine deadlock | Use `async_mode="threading"`, emit from Python threads via `socketio.emit()` (not `flask_socketio.emit()`) |
| Audio callback thread blocking | Audio glitches | Never emit from audio callback — only from Python middleware |
| WebSocket disconnection during playback | Lost notes | Keep REST `/play` as automatic fallback; Socket.IO has built-in reconnection with exponential backoff |
| GIL contention under heavy WebSocket traffic | Latency spikes | Binary frames minimize Python processing; note handler is lightweight (`add_realtime_event` is C++ via pybind11) |
| CORS issues with WebSocket | Connection refused | `cors_allowed_origins="*"` in SocketIO constructor (localhost-only deployment) |
| `socketio.run()` vs `app.run()` behavior difference | Startup failure | Test in isolation before integration; both use same port and host |

---

## 9. Expected Latency After Migration

| Component | After WebSocket | Savings vs REST |
|-----------|----------------|-----------------|
| Transport (WebSocket frame) | <1 ms | 2-10 ms saved |
| Parsing (binary frame) | <0.1 ms | 0.5-1 ms saved |
| Console print (if removed) | 0 ms | 1-2 ms saved |
| Event scheduling | 1.33 ms | 0 (inherent) |
| Audio buffer | 5.33 ms | 0 (inherent) |
| **Total** | **~7-8 ms** | **~5-12 ms saved** |

This brings browser-triggered note playback to parity with hardware MIDI latency (~7 ms).
