# Live UI Testing

Canonical procedure for launching the full Pianoid stack and verifying features through the browser UI. Used by the `/test-ui` skill and any dev agent that performs audio verification.

**Do not improvise.** Follow this guide end-to-end. Ad-hoc launches (direct `python backendserver.py`) interact badly with the launcher-supervised architecture (see [Three-Process Architecture](STARTUP_TROUBLESHOOTING.md#three-process-architecture)).

---

## Architecture Recap

Three processes must run together for a UI test:

| Process | Port | Start command | Notes |
|---|---|---|---|
| React dev server | 3000 | `npm run dev` | Frontend UI |
| Node.js launcher | 3001 | `npm run dev` | Owns the backend lifecycle; frontend talks to it over REST + WebSocket |
| Flask backend | 5000 | Launcher spawns on APPLY | `PianoidCore/.venv/Scripts/python backendserver.py` with CWD `pianoid_middleware/` |
| Modal adapter (optional) | 5001 | Launcher spawns on demand | Only needed for modal pipeline tests |

`npm run dev` uses `concurrently` to start launcher + React together (PianoidTunner/package.json:33).

**Critical coupling**: the frontend's APPLY handler (`ensureBackendAndLoadPreset`, PianoidTuner.js:297) kills any backend on :5000 that the launcher does not own. See [Three-Process Architecture](STARTUP_TROUBLESHOOTING.md#three-process-architecture). Never start the backend manually and then use the UI to APPLY — the backend will be killed.

---

## Prerequisites

- Build complete: `PianoidCore/.venv/` exists with `pianoidCuda` installed; frontend `node_modules` installed. See [Quick Start](QUICK_START.md).
- Ports 3000, 3001, 5000, 5001 free.
- Chrome DevTools MCP server reachable (for agent-driven tests).
- If measuring sound: do not rely on live audio output — use the `note_playback` chart (offline deterministic render).

---

## Start Sequence

### 1. Clear ports (port-targeted, never blanket kill)

```bash
for port in 5000 5001 3000 3001; do
  pid=$(netstat -ano 2>/dev/null | grep ":${port} .*LISTENING" | awk '{print $NF}' | head -1)
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    echo "Killing PID $pid on port $port"
    taskkill //F //PID "$pid" 2>/dev/null
  fi
done
sleep 2
netstat -ano | grep -E ":(3000|3001|5000|5001) " && echo "WARNING: ports still in use" || echo "Clear"
```

!!! danger "Never blanket kill"
    Do **not** run `taskkill //F //IM python.exe` or `taskkill //F //IM node.exe`. It kills MCP servers, Chrome DevTools, and Claude Code itself.

### 2. Start launcher + frontend

```bash
cd D:/repos/PianoidInstall/PianoidTunner
npm run dev > D:/tmp/test-ui-frontend.log 2>&1
```

Run this with `run_in_background: true` on the Bash tool (never shell `&` — the harness reports immediate exit).

Wait for **both** ports to bind:

```bash
until netstat -ano 2>/dev/null | grep -q ":3001 .*LISTENING" && netstat -ano 2>/dev/null | grep -q ":3000 .*LISTENING"; do
  sleep 1
done
echo "Launcher + frontend up"
```

### 3. Start backend via launcher

Open `http://localhost:3000` in the browser and click **APPLY**, OR call the launcher API directly:

```bash
curl -X POST http://127.0.0.1:3001/api/start-backend
# Poll until backend responds
until curl -sf http://127.0.0.1:5000/health > /dev/null; do sleep 1; done
echo "Backend up"
```

Clicking APPLY in the UI also triggers a `/load_preset` so the CUDA engine initializes and audio thread starts. If you called the launcher API directly you also need to POST a preset — see [REST API — POST /load_preset](../modules/pianoid-middleware/REST_API.md#post-load_preset).

### 4. Verify all three are healthy

```bash
# Launcher
curl -s http://127.0.0.1:3001/api/backend-status
# Expected: {"running":true,"pid":<N>,"modalRunning":false,"modalPid":null}

# Backend
curl -s http://127.0.0.1:5000/health
# Expected: {"status":"healthy","pianoid_loaded":true,...}

# Frontend (responds with HTML)
curl -s -I http://localhost:3000 | head -1
# Expected: HTTP/1.1 200 OK
```

---

## Interaction Patterns (Chrome DevTools MCP)

All parameter changes must go through the UI — never direct API. Sound measurement uses the `note_playback` chart (offline render; the only read-only API call allowed).

| Control type | How to drive |
|---|---|
| Toolbar hotkeys (volume, play) | `evaluate_script` dispatching `KeyboardEvent`. Blur active input first — range inputs block Space. |
| Spinbuttons (pitch, numeric) | `fill` on the uid, then Enter. |
| MUI Sliders | Focus slider, use arrow-key hotkeys; MUI does not accept direct `fill`. |
| Excitation sliders (range inputs) | `evaluate_script` with the native value setter, then dispatch `input`+`change`. |
| Dropdowns | Double-click label to open, `fill` the input uid, click OK. |
| Virtual Piano canvas | Dispatch synthesised pointer events on the canvas — see `feedback_ui_testing_patterns` patterns. |
| Sustained note (audible) | Dispatch `keydown`/`keyup` on Space with a setTimeout gap (3s hold). Blur inputs first. |

After each UI interaction: take a screenshot, check network requests, check console for React errors.

### Measuring sound deterministically

Use the `note_playback` chart — it renders a full note offline and returns WAV as base64. This is the only sound measurement allowed for regressions.

```javascript
// via evaluate_script
const resp = await fetch('http://127.0.0.1:5000/get_chart_test', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    chartType: 'note_playback',
    pitch: 60, velocity: 127,
    duration_ms: 500, display_length_ms: 500
  })
}).then(r => r.json());
return { b64: resp.audio_data?.[0], dataPoints: resp.data?.[0]?.length };
```

Decode and measure RMS/peak in Python — see [Testing](../development/TESTING.md) for the decode helper. Never use `/capture` (circular buffer) for regression measurements; it samples live audio and is not deterministic.

---

## Shutdown

**Reverse dependency order**: frontend → launcher → modal → backend.

```bash
# Preferred: close the browser page, then graceful backend stop via launcher
curl -s -X POST http://127.0.0.1:3001/api/stop-backend

# Full teardown (port-targeted, in reverse order)
for port in 3000 3001 5001 5000; do
  pid=$(netstat -ano 2>/dev/null | grep ":${port} .*LISTENING" | awk '{print $NF}' | head -1)
  [ -n "$pid" ] && [ "$pid" != "0" ] && taskkill //F //PID "$pid"
done
```

The launcher installs `SIGINT`/`SIGTERM` handlers (launcher.js:346) that `taskkill /T /F` its children on exit, so killing the launcher alone usually reaps the backend. Closing the `npm run dev` terminal also triggers this.

**MANDATORY**: every agent that starts any of these processes must tear them all down before exiting — regardless of test outcome. Leaving stale processes blocks the next test run.

---

## Troubleshooting

### Backend gets killed every time I click APPLY

Root cause: the backend on :5000 is not owned by the launcher (you started it manually, or the launcher died and was restarted). `ensureBackendAndLoadPreset` (PianoidTuner.js:312) intentionally kills any backend it doesn't own. Fix: stop the orphaned backend, make sure launcher is running, then let APPLY spawn a fresh backend under launcher supervision.

### Port 5000 seems to have a "zombie socket"

`netstat -ano` shows the port held but `taskkill //F //PID` says "process not found". Almost always the actual holder is a child of a launcher process you forgot to kill. See [Zombie socket diagnosis](STARTUP_TROUBLESHOOTING.md#zombie-socket-diagnosis). Do not reboot or reset network stack until the parent-process hypothesis is ruled out.

### Backend works from CLI but UI shows "Backend not connected"

The launcher (3001) is down. The frontend polls `/api/backend-status` over REST and subscribes to `/ws/console` on 3001. If `npm run dev` was started as `npm start` (only react-scripts, no `concurrently`), the launcher never started. Fix: kill and restart with `npm run dev`.

### Flask reloader errors on Windows (`WERKZEUG_SERVER_FD`)

The launcher spawns Python with `-u` (unbuffered) and no `FLASK_DEBUG`, so the reloader should be off. If you are launching the backend manually, make sure `FLASK_DEBUG` is unset and `app.run(debug=False, use_reloader=False)` — see the middleware OVERVIEW.

### Stale preset / last preset sticks after restart

The launcher does not persist engine state across backend restarts — each spawn starts fresh and requires `/load_preset`. If the UI shows "Playing" but the sound is silent, confirm the preset was actually loaded:

```bash
curl -s http://127.0.0.1:5000/health | grep pianoid_loaded
```

If `pianoid_loaded: false`, click APPLY again to trigger a fresh load_preset.

### CORS errors from frontend calls

The launcher allows `Access-Control-Allow-Origin: *` on 3001 (launcher.js:22). The Flask backend must also set permissive CORS for 3000 — see [REST API](../modules/pianoid-middleware/REST_API.md). If you see CORS errors, confirm both servers are actually on the expected ports (no port bump from CRA).

---

## See Also

- [Quick Start](QUICK_START.md) — installation, prerequisites, first-time setup
- [Startup Troubleshooting](STARTUP_TROUBLESHOOTING.md) — build failures, port conflicts, CUDA issues, three-process architecture
- [Testing](../development/TESTING.md) — pytest inventory, test levels, instrumentation APIs
- [REST API](../modules/pianoid-middleware/REST_API.md) — `/load_preset`, `/get_chart_test`, `/health`
- [Middleware Overview](../modules/pianoid-middleware/OVERVIEW.md) — server startup sequence, component dependencies
