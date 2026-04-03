---
name: pianoid-ui
description: Start and control the Pianoid interface — launch stack, navigate UI, adjust any synthesis parameter, capture sound, analyse results.
user-invocable: true
argument-hint: <action — e.g. "start", "set tension on C4 to 800", "capture sound after playing A4", "compare feedin before/after">
---

# Pianoid UI Control via Chrome DevTools

Control the Pianoid synthesizer interface through browser automation. Uses the `chrome-devtools` MCP server to launch Chrome, navigate the React frontend, and interact with UI components programmatically.

## Critical Rules

1. **NEVER use direct API calls** (`curl`, `fetch` via `evaluate_script`) for actions that should go through the React UI. The UI will not reflect changes and React state gets out of sync. Always interact through UI components (click, fill, press_key).
2. **Always load presets via the Settings panel APPLY button** — this triggers `ensureBackendAndLoadPreset` which starts the backend, loads the preset, and fetches all parameters into React state.
3. **Kill stale processes before starting** — multiple python processes cause audio distortion.
4. **Never reload the page** (`window.location.reload()`) — it disconnects from the backend and may crash it. Set layout via localStorage BEFORE first navigation.

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
  GET  /get_parameter/<type>/<key>      — read parameters
  POST /set_parameter/<type>/<key>      — write parameters
  POST /set_string_excitation/<pitch>   — write excitation curves
  POST /set_hammer_shape/<pitch>        — write hammer geometry
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

Follow these steps in order. Skip steps that are already satisfied.

### Step 1: Kill Stale Processes

**Always run this first** to prevent audio distortion from competing processes:

**CRITICAL: Only kill processes on Pianoid ports — NEVER blanket-kill python.exe or node.exe (kills MCP servers and Claude Code itself).**

```bash
# Kill ONLY processes on Pianoid ports (5000=backend, 3000/3001=frontend)
for port in 5000 3000 3001; do
  pid=$(netstat -ano 2>/dev/null | grep ":${port} .*LISTENING" | awk '{print $NF}' | head -1)
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    echo "Killing PID $pid on port $port"
    taskkill //F //PID "$pid" 2>/dev/null
  fi
done
sleep 2
```

Then verify clean state:
```bash
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ 2>/dev/null || echo "DOWN"
curl -s http://127.0.0.1:3001/api/backend-status 2>/dev/null || echo "DOWN"
curl -s http://127.0.0.1:5000/health 2>/dev/null || echo "DOWN"
```

### Step 2: Set Layout (before starting frontend)

If a specific layout is needed, set it in localStorage via Chrome DevTools AFTER opening the page but BEFORE clicking APPLY. Navigate to `http://localhost:3000`, then run via `evaluate_script`:

**Default recommended layout** (Settings sidebar + Excitation + Virtual Piano):
```js
localStorage.setItem("mosaicLayout", JSON.stringify({
  first: "Settings",
  second: {
    first: "Excitation",
    second: "Virtual Piano",
    direction: "column",
    splitPercentage: 70
  },
  direction: "row",
  splitPercentage: 18
}));
```

Then reload once (`navigate_page` type=reload) to apply the layout. This is the ONE acceptable reload — before any preset is loaded.

**Available mosaic window IDs:**

| Category | Windows |
|----------|---------|
| Parameter Editors | `Strings`, `Feedin`, `Feedback`, `Modes`, `Excitation`, `Sound Channels` |
| Selectors | `Workbench`, `Virtual Piano`, `Modes rule` |
| Utility | `Settings`, `MIDI`, `Charts`, `Console`, `NumInputTest` |

Layout is a binary tree: leaf nodes are window ID strings, branches have `first`, `second`, `direction` ("row"/"column"), and optional `splitPercentage`.

### Step 3: Start Frontend

```bash
cd D:\repos\PianoidInstall\PianoidTunner && npm run dev
```

**IMPORTANT:** `npm run dev` starts **both** the React dev server (port 3000) and the Node.js launcher (port 3001) via `concurrently`. Do NOT use `npm start` — that only starts React without the launcher.

Wait for **both** services:
```bash
for i in $(seq 1 20); do
  fe=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ 2>/dev/null)
  la=$(curl -s http://127.0.0.1:3001/api/backend-status 2>/dev/null)
  if [ "$fe" = "200" ] && [ -n "$la" ]; then
    echo "Ready: frontend=$fe launcher=$la"
    break
  fi
  sleep 2
done
```

The frontend comes up first; the launcher takes a few extra seconds.

### Timeout Safeguard

If any chrome-devtools MCP call (especially `new_page`, `navigate_page`) does not respond within 30 seconds, abort the task immediately and report: "Browser MCP timed out — chrome-devtools server may not be running or is unresponsive." Do NOT retry or wait indefinitely.

### Step 4: Open Browser

Use chrome-devtools MCP:

1. `new_page` → `http://localhost:3000`
2. `wait_for` → wait for "APPLY" or "Settings" text
3. `take_screenshot` to verify UI rendered

### Step 5: Load Preset via UI

**This is the only correct way to load a preset.** Direct API calls skip React state initialization.

1. **Set preset path** — find the `path` textbox in Settings panel via `take_snapshot`, then `fill` it:
   ```
   fill uid=<path_textbox> value="presets/BaselinePreset1.json"
   ```

2. **Set audio driver to SDL** — click the Audio Driver combobox, then click the "SDL" option. Verify/set these defaults:
   - volume: `120`
   - audio_driver: `SDL` (not ASIO — ASIO has exclusive mode issues)
   - sample_rate: `48`
   - string_iterations: `4`
   - start_right_away: `1`
   - audio_on: `1`
   - listen_to_modes: `Modes (Mode forces)`

3. **Wait for launcher** to be ready (port 3001 responding).

4. **Click APPLY** button.

5. **Wait for "Playing"** text to appear (up to 120 seconds — backend start + GPU init + preset load):
   ```
   wait_for text=["Playing"] timeout=120000
   ```

6. **Verify** — take a screenshot. The toolbar should show the preset name and green "Playing" indicator.

### Step 6: Select a Pitch

Use the **Pitch** spinbutton in the toolbar:

1. `fill` the Pitch spinbutton with the desired MIDI pitch number (e.g., `60` for C4)
2. `press_key` → `Enter`

This populates parameter panels (Strings, Excitation, Modes) with data for that pitch.

### Step 7: Play Notes

The Virtual Piano renders on an HTML5 **canvas** element. It is NOT accessible via the a11y tree. Notes are played by **right-click** (mousedown with button=2).

**Programmatic note playing via evaluate_script:**

```js
(targetPitch) => {
  const panels = document.querySelectorAll('.mosaic-window');
  for (const panel of panels) {
    const title = panel.querySelector('.mosaic-window-title');
    if (title && title.textContent.includes('Virtual Piano')) {
      const canvas = panel.querySelector('canvas');
      const rect = canvas.getBoundingClientRect();
      const totalKeys = 88;
      const keySize = canvas.clientWidth / totalKeys;
      const keyIndex = targetPitch - 21;
      const clientX = rect.left + (keyIndex + 0.5) * keySize;
      const clientY = rect.top + rect.height * 0.7;

      canvas.dispatchEvent(new MouseEvent('mousedown', {
        clientX, clientY, bubbles: true, cancelable: true,
        button: 2, buttons: 2, view: window
      }));
      setTimeout(() => {
        canvas.dispatchEvent(new MouseEvent('mouseup', {
          clientX, clientY, bubbles: true, cancelable: true,
          button: 2, buttons: 0, view: window
        }));
      }, 500);
      return { played: true, pitch: targetPitch };
    }
  }
  return { error: 'Virtual Piano not found' };
}
```

Pass the MIDI pitch as an argument: `args: ["60"]`

**Key details:**
- `button: 2` triggers the play path (button 0 = left-click = select pitch only)
- `keyIndex = midiPitch - 21` (A0 is MIDI 21, the first key)
- mousedown sends Note ON (command 144), mouseup sends Note OFF (command 128)
- The `onPlayNote` callback in React POSTs to `/play`

**MIDI pitch reference:**

| Note | MIDI | Note | MIDI | Note | MIDI |
|------|------|------|------|------|------|
| A0   | 21   | C3   | 48   | C5   | 72   |
| C1   | 24   | C4   | 60   | C6   | 84   |
| C2   | 36   | D4   | 62   | C7   | 96   |
| A2   | 45   | E4   | 64   | C8   | 108  |
|      |      | A4   | 69   |      |      |

---

## Parameter Editing via UI

**Always edit parameters through UI components**, not API calls. The pattern:

1. **Select pitch** via toolbar Pitch spinbutton
2. **Find the parameter cell** via `take_snapshot` — look for textbox elements in the relevant panel
3. **Click** the cell textbox uid
4. **Fill** with new value
5. **Press Enter** to commit

The React code handles debouncing, state management, and API calls automatically.

### Excitation Editing

The Excitation panel shows a grid with 5 charts (Gauss curves) and 4 parameters each:

| Row | Chart 1 | Chart 2 | Chart 3 | Chart 4 | Chart 5 |
|-----|---------|---------|---------|---------|---------|
| mu | position | position | position | position | position |
| sigma | width | width | width | width | width |
| shift | offset | offset | offset | offset | offset |
| volume | amplitude | amplitude | amplitude | amplitude | amplitude |

The velocity level buttons (pp, p, mf, f, ff, ALL) control which velocity level is being edited.

To edit: click the textbox → fill new value → press Enter. The chart updates visually and the frontend sends `POST /set_parameter/excitation/{pitch}`.

### String Parameter Editing

When a pitch is selected, the Strings panel shows: damper_string, damper_tail, detuning, dispersion_damping, gamma, jung, length, r, rho, tail, tension, volume_coefficient.

### Hammer Editing

In the Excitation panel below the chart: Width (mm), Sharpness (%), Position (%). Use sliders or spinbutton inputs.

---

## Sound Capture & Analysis

For programmatic sound analysis (read-only operations where direct API calls ARE appropriate).

### Deterministic measurement (PREFERRED)

Use `note_playback` chart — renders a note offline and returns a precise WAV. No timing issues, no audio driver dependency:

```js
// Via evaluate_script:
const resp = await fetch('http://127.0.0.1:5000/get_chart_test', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    chartType: 'note_playback',
    pitch: 60,
    velocity: 127,
    duration_ms: 500,
    display_length_ms: 500
  })
}).then(r => r.json());
// resp.audio_data[0] = base64-encoded WAV file
// resp.data = [[waveform samples]] for charting
```

Decode and measure in Python (save audio_data to file first):
```python
import base64, wave, io, numpy as np
wav_bytes = base64.b64decode(audio_data_b64)
wf = wave.open(io.BytesIO(wav_bytes), 'rb')
samples = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16).astype(float)
max_amp = np.max(np.abs(samples))
rms = np.sqrt(np.mean(samples**2))
```

### Live circular buffer (for monitoring only)

**WARNING:** The circular buffer captures a rolling 5-second window. If the note has finished or timing is off, it captures silence. Use `note_playback` for precise measurement.

```js
// 1. Capture current buffer snapshot
await fetch('http://127.0.0.1:5000/capture', {method: 'POST'});

// 2. Get waveform from buffer (audio_data[0] is base64 WAV)
const chart = await fetch('http://127.0.0.1:5000/get_chart_test', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({chartType: 'sound', length: 48000, channel: 0})
}).then(r => r.json());
```

### Before/After Comparison

1. Call `note_playback` chart with target pitch/velocity → save `audio_data[0]` as `before`
2. Edit parameter via UI
3. Call `note_playback` chart with SAME pitch/velocity → save as `after`
4. Decode both WAVs, compare max amplitude and RMS

**Note:** `note_playback` uses `OfflinePlaybackEngine` which reads `dev_main_volume_coeff` from GPU, so volume/sensitivity changes ARE reflected in the measurement.

### Other useful endpoints

```js
// List available chart types and actions
const types = await fetch('http://127.0.0.1:5000/graph_names').then(r => r.json());

// Playback statistics
const stats = await fetch('http://127.0.0.1:5000/playback_stats').then(r => r.json());
```

### Playing notes for audible testing

| Method | Audible? | Measurable? | How |
|--------|----------|-------------|-----|
| Space key (hold) | Yes | Imprecise | `evaluate_script`: keydown, setTimeout(keyup, 3000) |
| Virtual Piano right-click | Yes | Imprecise | `evaluate_script`: MouseEvent button=2 on canvas |
| `note_playback` chart | No | Precise | `POST /get_chart_test` as above |
| `play_note_offline` action | No (saves WAV) | Precise | `POST /start_test` |

For audible notes, blur any focused input first (`document.activeElement?.blur()`) — range inputs block Space key via `isInputFocused()`.

---

## Inspect & Debug

- `take_screenshot` — current UI state
- `take_snapshot` — a11y tree with uid values for clicking/filling
- `list_console_messages` — React errors/warnings
- `list_network_requests` — API calls (filter with `resourceTypes: ["fetch", "xhr"]`)
- `get_network_request` — inspect specific request/response payload by reqid

### Check Health
```js
// Via evaluate_script (read-only, acceptable)
fetch('http://127.0.0.1:5000/health').then(r => r.json())
```
Key fields: status, pianoid_loaded, gpu_initialized, audio_driver_active, available_notes_count.

---

## Stop Services (MANDATORY on task completion)

**Always run cleanup when the UI task is finished**, whether it succeeded or failed. Do not leave services running.

1. Stop backend via launcher:
   ```bash
   curl -s -X POST http://127.0.0.1:3001/api/stop-backend
   ```

2. Close browser tab: `close_page` tool

3. Kill only Pianoid processes (by port, not by image name):
   ```bash
   for port in 5000 3000 3001; do
     pid=$(netstat -ano 2>/dev/null | grep ":${port} .*LISTENING" | awk '{print $NF}' | head -1)
     if [ -n "$pid" ] && [ "$pid" != "0" ]; then
       taskkill //F //PID "$pid" 2>/dev/null
     fi
   done
   ```

---

## Error Handling

| Problem | Diagnosis | Fix |
|---------|-----------|-----|
| **Distorted sound** | Multiple python processes on port 5000 | Kill by PID via `netstat -ano | grep :5000`, then APPLY to reload |
| **Backend won't start** | Launcher error | `curl http://127.0.0.1:3001/api/kill-stale` to clear port 5000 |
| **UI doesn't reflect changes** | Used direct API calls | Reload page, load preset via APPLY, edit via UI only |
| **"Disconnected" after reload** | Page reload killed connection | Wait for health polling to reconnect, or click APPLY again |
| **"Select a pitch" in panels** | No pitch selected | Fill Pitch spinbutton + Enter |
| **Virtual Piano empty** | Preset not loaded via frontend | Click APPLY in Settings panel |
| **Launcher not found** | Used `npm start` instead of `npm run dev` | Kill node, restart with `npm run dev` |
