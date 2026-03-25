---
name: pianoid-ui
description: Start and control the Pianoid interface — launch stack, navigate UI, adjust any synthesis parameter, capture sound, analyse results.
user-invocable: true
argument-hint: <action — e.g. "start", "set tension on C4 to 800", "capture sound after playing A4", "compare feedin before/after">
---

# Pianoid UI Control via Chrome DevTools

Control the Pianoid synthesizer interface through browser automation. Uses the `chrome-devtools` MCP server to launch Chrome, navigate the React frontend, and interact with UI components programmatically.

## Architecture Reference

```
Ports:
  3000  — React frontend (PianoidTunner dev server)
  3001  — Node.js launcher (backend process manager)
  5000  — Flask backend (pianoid_middleware + CUDA engine)

Launcher REST API (port 3001):
  POST /api/start-backend   — spawn Flask backend
  POST /api/stop-backend    — graceful shutdown + force kill
  POST /api/kill-stale      — kill anything on port 5000
  GET  /api/backend-status   — { running, pid }

Backend REST API (port 5000):
  GET  /health                          — engine lifecycle status
  POST /load_preset                     — initialize engine from preset file
  POST /play                            — trigger note on/off
  GET  /reset                           — reset engine state
  POST /shutdown                        — graceful GPU cleanup + exit
  GET  /get_parameter/<type>/<key>      — read parameters (string/mode/feedin/feedback/gauss/hammer/excitation/sound_channel/string_sound_channel)
  POST /set_parameter/<type>/<key>      — write parameters
  POST /set_string_excitation/<pitch>   — write excitation curves for one pitch at one velocity level
  POST /set_hammer_shape/<pitch>        — write hammer geometry for one pitch
  POST /set_mode_parameters             — write mode parameters (batch)
  POST /set_runtime_parameters          — volume / feedback at runtime
  POST /set_velocity/<velocity>         — fix MIDI velocity (-1 to disable)
  POST /capture                         — force extraction of current result buffer
  POST /get_chart_test                  — render a chart (sound, spectrum, etc.)
  GET  /graph_names                     — list available chart types and actions
  POST /start_test                      — execute a registered action
  POST /midi_playback                   — MIDI file playback control
  GET  /get_available_notes             — pitches in loaded preset
  GET  /playback_stats                  — EventQueue statistics
```

## Execution Steps

Follow these steps in order. Skip steps that are already satisfied (e.g. if services are already running).

### Step 1: Check Current State

Probe all three services to determine what is already running:

```bash
# Check frontend (React dev server)
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ 2>/dev/null || echo "DOWN"

# Check launcher
curl -s http://127.0.0.1:3001/api/backend-status 2>/dev/null || echo "DOWN"

# Check backend
curl -s http://127.0.0.1:5000/health 2>/dev/null || echo "DOWN"
```

Report status to user:
- Frontend: UP / DOWN
- Launcher: UP / DOWN (+ backend PID if running)
- Backend: not_started / healthy / crashed / disconnected

### Step 2: Start Services (if needed)

**If frontend is DOWN**, start it in background:
```bash
cd D:\repos\PianoidInstall\PianoidTunner && npm start
```
Note: This opens on port 3000. The launcher server on port 3001 starts automatically with `npm start` (configured as a proxy/concurrent process). Wait up to 30 seconds for port 3000 to respond.

**If launcher is UP but backend is DOWN**, start backend via launcher:
```bash
curl -s -X POST http://127.0.0.1:3001/api/start-backend
```

**If the user asked to start with specific preset settings**, note them for Step 4.

### Step 3: Open Browser to Pianoid UI

Use chrome-devtools MCP to open the Pianoid frontend:

1. **Navigate to the frontend:**
   - Use `navigate_page` tool → `http://localhost:3000`
   - If no page exists yet, use `new_page` tool → `http://localhost:3000`

2. **Wait for the app to load:**
   - Use `wait_for` tool — wait for network idle or a known element
   - Use `take_screenshot` to verify the UI rendered correctly

3. **Report UI state to user** — take a screenshot and describe what's visible (toolbar, panels, status indicator color).

### Step 4: Interact with the UI

Based on the user's request, perform the appropriate actions. Common workflows:

#### Load a Preset
1. Use `evaluate_script` to check current backend status:
   ```js
   fetch('http://127.0.0.1:5000/health').then(r => r.json())
   ```
2. Click the **Settings** panel or **Load/Save** button in the toolbar
3. Use `fill` or `fill_form` to enter preset path and parameters
4. Click **Apply** to trigger preset loading
5. Use `wait_for` to wait for the backend to become healthy
6. Take a screenshot to confirm loaded state

**Alternative — direct API load** (faster, bypasses UI):
```js
fetch('http://127.0.0.1:5000/load_preset', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    path: '<preset_path>',
    audio_driver_type: 4,
    cycle_iterations: 64,
    audio_buffer_size: 4,
    array_size: 384,
    sample_rate: 48000,
    string_iterations: 6,
    volume: 64,
    start_right_away: 1,
    listen_to_modes: 1
  })
}).then(r => r.json())
```

#### Play a Note
Use `evaluate_script` to send a play command:
```js
fetch('http://127.0.0.1:5000/play', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({pitch: <MIDI_pitch>, velocity: 100, command: 144})
}).then(r => r.json())
```

MIDI pitch reference: C4=60, D4=62, E4=64, F4=65, G4=67, A4=69, B4=71, C5=72.
For note names, convert to MIDI pitch number first.

Or click keys on the **Virtual Piano** component in the UI using the `click` tool.

#### Play a MIDI File
```js
fetch('http://127.0.0.1:5000/midi_playback', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({action: 'start', midi_file: 'elise.mid', start_delay_ms: 500})
}).then(r => r.json())
```

#### Adjust Volume / Feedback
```js
fetch('http://127.0.0.1:5000/set_runtime_parameters', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({volume: <0-127>, feedback: <0-127>})
}).then(r => r.json())
```

---

### Parameter Adjustment

All parameter reads/writes go through `evaluate_script` calling the backend REST API. The pattern is always:

1. **Read current value** → `GET /get_parameter/<type>/<key>`
2. **Modify the value** in the returned JSON
3. **Write it back** → `POST /set_parameter/<type>/<key>` with the modified JSON as body
4. **Optionally capture sound** to verify the effect (see Sound Capture below)

#### Read Any Parameter
```js
// Single pitch/mode
fetch('http://127.0.0.1:5000/get_parameter/<type>/<key>').then(r => r.json())

// All pitches/modes
fetch('http://127.0.0.1:5000/get_parameter/<type>/all').then(r => r.json())

// Range
fetch('http://127.0.0.1:5000/get_parameter/<type>/from<N>to<M>').then(r => r.json())
```

#### Parameter Types Reference

| `<type>` | `<key>` means | Properties |
|----------|---------------|------------|
| `string` | pitch (21–108) | `tension`, `string_stiffness`, `string_damping`, `string_radius`, `string_density` |
| `mode` | mode index (0–N) | `frequency`, `decrement` |
| `feedin` | pitch (21–108) | array of mode coupling coefficients (length = number_of_modes) |
| `feedback` | pitch (21–108) | array of mode coupling coefficients (length = number_of_modes) |
| `gauss` | pitch (21–108) | excitation curves dict: `{level: {curve_idx: {sigma, mu, volume, shift}}}` |
| `gauss_flat` | pitch (21–108) | flat array of 100 excitation values |
| `gauss_full` | pitch (21–108) | excitation dict, all 128 velocity levels |
| `hammer` | pitch (21–108) | `shape`, `width`, `position`, `sharpness` |
| `excitation` | pitch (21–108) | combined gauss + hammer |
| `sound_channel` | pitch (21–108) | mode-coupling coefficients (when `listen_to_modes=1`) |
| `string_sound_channel` | pitch (21–108) | strings-mode gain (when `listen_to_modes=0`) |

#### Set String Parameters
```js
// Example: set tension on pitch 60 (C4)
// First read current values
const current = await fetch('http://127.0.0.1:5000/get_parameter/string/60').then(r => r.json());
// Modify
current.tension = 800.0;
// Write back
fetch('http://127.0.0.1:5000/set_parameter/string/60', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify(current)
}).then(r => r.json())
```

String properties and typical ranges:
| Property | Description | Typical Range |
|----------|-------------|---------------|
| `tension` | String tension (N) | 400–1200 |
| `string_stiffness` | Bending stiffness | 0–0.1 |
| `string_damping` | Damping coefficient | 0–0.01 |
| `string_radius` | String radius (m) | 0.0003–0.002 |
| `string_density` | Linear density (kg/m) | 0.001–0.05 |

#### Set Mode Parameters
```js
// Read mode 0
const mode = await fetch('http://127.0.0.1:5000/get_parameter/mode/0').then(r => r.json());
// Modify frequency or decrement
mode.frequency = 440.0;
mode.decrement = 0.999;
// Write back
fetch('http://127.0.0.1:5000/set_parameter/mode/0', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify(mode)
}).then(r => r.json())

// Batch mode update (multiple modes at once)
fetch('http://127.0.0.1:5000/set_mode_parameters', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify([
    {mode: 0, parameters: {frequency: 440.0, decrement: 0.999}},
    {mode: 1, parameters: {frequency: 880.0, decrement: 0.998}}
  ])
}).then(r => r.json())
```

#### Set Feedin / Feedback Matrix
```js
// Read feedin row for pitch 60
const row = await fetch('http://127.0.0.1:5000/get_parameter/feedin/60').then(r => r.json());
// row is an array of coupling coefficients, one per mode
// Modify specific mode couplings
row[0] = 1.0;  // mode 0 coupling
row[1] = 0.5;  // mode 1 coupling
// Write back
fetch('http://127.0.0.1:5000/set_parameter/feedin/60', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify(row)
}).then(r => r.json())

// Same pattern for feedback
```

#### Set Excitation / Hammer Parameters
```js
// Set hammer geometry for pitch 60
fetch('http://127.0.0.1:5000/set_hammer_shape/60', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    shape: 'circular',
    width: 0.012,
    position: 0.09,
    sharpness: 0.7
  })
}).then(r => r.json())

// Set excitation curves for pitch 60 at velocity level 2
fetch('http://127.0.0.1:5000/set_string_excitation/60', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    level: 2,
    curves: {
      '0': {sigma: 0.01, mu: 0.5, volume: 1.0, shift: 0.0},
      '1': {sigma: 0.02, mu: 0.3, volume: 0.8, shift: 0.1}
    }
  })
}).then(r => r.json())
```

#### Set Sound Channel Coefficients
```js
// Read sound channel for pitch 60 (mode-coupling coefficients)
const sc = await fetch('http://127.0.0.1:5000/get_parameter/sound_channel/60').then(r => r.json());
// Modify and write back
fetch('http://127.0.0.1:5000/set_parameter/sound_channel/60', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify(sc)
}).then(r => r.json())
```

---

### Sound Capture & Analysis

The capture workflow lets you record what the engine is producing and inspect the result as waveform/spectrum data. This is essential for verifying parameter changes have the desired acoustic effect.

#### Basic Capture Workflow

1. **Play a note** (or let current sound ring)
2. **Wait** for the sound to develop (100–500 ms depending on what you're checking)
3. **Capture** the result buffer
4. **Request a chart** of the captured audio

```js
// Step 1: Play a note
await fetch('http://127.0.0.1:5000/play', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({pitch: 60, velocity: 100, command: 144})
}).then(r => r.json());

// Step 2: Wait for sound to develop
await new Promise(r => setTimeout(r, 300));

// Step 3: Force capture of current buffer
await fetch('http://127.0.0.1:5000/capture', {method: 'POST'}).then(r => r.json());

// Step 4: Get the sound chart (waveform)
const chart = await fetch('http://127.0.0.1:5000/get_chart_test', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({chartType: 'sound', length: 48000, channel: 0})
}).then(r => r.json());
// chart.data = array of waveform samples
// chart.audio_data = base64-encoded WAV (if available)
// chart.text_fields = metadata about the recording
```

#### Available Chart Types

Use `evaluate_script` to discover what's available in the current preset:
```js
fetch('http://127.0.0.1:5000/graph_names').then(r => r.json())
// Returns: {graphs: [{name, label, parameters: [{name, type, label, defaultValue}]}], actions: [...]}
```

Common chart types:
| Chart Type | Description | Key Parameters |
|------------|-------------|----------------|
| `sound` | Raw waveform capture | `length` (samples), `channel` (0-based) |
| Other types | Vary by preset — use `/graph_names` to discover | Vary |

#### Before/After Comparison Workflow

To evaluate the acoustic effect of a parameter change:

1. **Capture baseline:**
   ```js
   // Play note, wait, capture, get chart
   await fetch('http://127.0.0.1:5000/play', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({pitch:60, velocity:100, command:144})}).then(r=>r.json());
   await new Promise(r => setTimeout(r, 300));
   await fetch('http://127.0.0.1:5000/capture', {method:'POST'}).then(r=>r.json());
   const before = await fetch('http://127.0.0.1:5000/get_chart_test', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({chartType:'sound', length:48000, channel:0})}).then(r=>r.json());
   ```

2. **Reset engine state** (clear ringing strings):
   ```js
   await fetch('http://127.0.0.1:5000/reset').then(r=>r.json());
   ```

3. **Apply parameter change** (see Parameter Adjustment section above)

4. **Capture after:**
   ```js
   // Same play-wait-capture-chart sequence
   await fetch('http://127.0.0.1:5000/play', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({pitch:60, velocity:100, command:144})}).then(r=>r.json());
   await new Promise(r => setTimeout(r, 300));
   await fetch('http://127.0.0.1:5000/capture', {method:'POST'}).then(r=>r.json());
   const after = await fetch('http://127.0.0.1:5000/get_chart_test', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({chartType:'sound', length:48000, channel:0})}).then(r=>r.json());
   ```

5. **Compare results:**
   - Report `before.text_fields` vs `after.text_fields`
   - Compare waveform amplitudes: `Math.max(...before.data[0])` vs `Math.max(...after.data[0])`
   - If `audio_data` is available, the user can listen to both captures
   - Take UI screenshots showing any chart panels that updated

6. **Report to user** with a summary table:
   | Metric | Before | After | Change |
   |--------|--------|-------|--------|
   | Peak amplitude | — | — | — |
   | RMS level | — | — | — |
   | Chart metadata | — | — | — |

#### Execute Backend Actions

Some presets register special actions (filters, tests, toggles). Execute them via:
```js
// List available actions
const types = await fetch('http://127.0.0.1:5000/graph_names').then(r=>r.json());
// types.actions = [{name, label, parameters}]

// Execute an action
fetch('http://127.0.0.1:5000/start_test', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({action_type: '<name>', ...params})
}).then(r => r.json())
```

#### Playback Statistics
```js
// Check EventQueue buffer and engine stats
fetch('http://127.0.0.1:5000/playback_stats').then(r => r.json())
// Returns: total_events_pushed, peak_buffer_size, avg_event_latency_ms, etc.
```

---

#### Take a Screenshot
Use the `take_screenshot` tool to capture the current UI state. This is useful for:
- Verifying UI state after actions
- Debugging layout issues
- Showing chart/visualization output to the user

#### Inspect Console / Network
- `list_console_messages` — check for React errors or warnings
- `list_network_requests` — see API calls between frontend and backend
- `get_network_request` — inspect specific request/response payloads

#### Check Health
Use `evaluate_script`:
```js
fetch('http://127.0.0.1:5000/health').then(r => r.json())
```
Report key fields: status, pianoid_loaded, gpu_initialized, audio_driver_active, available_notes_count.

#### Navigate UI Panels
The UI uses a mosaic layout. Key panels and their typical locations:
- **Settings** — top-left (preset path, audio config, load/save)
- **Charts** — top-right (waveform, spectrum, sound analysis)
- **Feedin / Feedback** — center (pitch-to-mode coupling matrices)
- **Virtual Piano** — bottom (keyboard for playing notes)
- **Modes** — right (resonance mode parameters)
- **Strings** — left (string physical parameters)
- **MIDI** — left (MIDI device connection)

Use `take_snapshot` (accessibility/DOM snapshot) to identify clickable elements when needed.

#### Run Lighthouse Audit
Use the `lighthouse_audit` tool to check frontend performance, accessibility, and best practices.

#### Monitor Performance
1. `performance_start_trace` — begin recording
2. Perform actions (play notes, load presets, switch panels)
3. `performance_stop_trace` — get performance data
4. `performance_analyze_insight` — drill into specific bottlenecks

### Step 5: Stop Services (if requested)

**Graceful shutdown sequence:**

1. Stop the backend via launcher:
   ```bash
   curl -s -X POST http://127.0.0.1:3001/api/stop-backend
   ```
   This sends `/shutdown` to Flask (GPU cleanup) then force-kills if needed.

2. Close the browser tab:
   - Use `close_page` tool

3. Stop the frontend dev server (if requested):
   - The npm process must be killed manually (it runs in a separate terminal)

## Error Handling

- **Backend won't start:** Check `list_console_messages` for launcher errors. Try `curl http://127.0.0.1:3001/api/kill-stale` to clear port 5000, then retry.
- **UI won't load:** Verify port 3000 responds. Check if `node_modules` exists in PianoidTunner. May need `npm install`.
- **Chrome won't connect:** The chrome-devtools MCP auto-launches Chrome. If it fails, check that Chrome is installed and no `--browser-url` flag is misconfigured.
- **Health shows "crashed":** The CUDA engine hit an exception. Use `evaluate_script` to call `/health` for the exception details, then report to user.
- **Blank/white page:** Take a screenshot, check console messages for React errors. Common cause: backend not running when frontend tries to fetch initial data.

## Quick Reference — Note Names to MIDI

| Note | MIDI | Note | MIDI | Note | MIDI |
|------|------|------|------|------|------|
| A0   | 21   | C3   | 48   | C5   | 72   |
| C1   | 24   | C4   | 60   | C6   | 84   |
| C2   | 36   | D4   | 62   | C7   | 96   |
| A2   | 45   | E4   | 64   | C8   | 108  |
|      |      | A4   | 69   |      |      |
