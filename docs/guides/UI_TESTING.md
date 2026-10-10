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

### 1. Clean the stack (BEFORE — mandatory, mirrors the icon launcher)

Follow [`PROJECT_CONFIG.md` → Clean stack](../PROJECT_CONFIG.md#clean-stack) (the SSOT procedure + verification checklist). In short:

```powershell
powershell -ExecutionPolicy Bypass -File tools\kill_pianoid.ps1 -DryRun   # inventory: ports, spare ports, orphans, .pyd holders
powershell -ExecutionPolicy Bypass -File tools\kill_pianoid.ps1           # tree-kill supervisor + core ports + orphans + wt-* dev servers
python tools/dev-pipeline/env_sweep.py                                       # verify 3000/3001/5000/5001 free + spare-port sweep (exit 0)
```

Then close every agent browser page (chrome-devtools `list_pages` → `close_page` all but one → `navigate_page` the last to `about:blank`). Skip the sweep only if the orchestrator says a concurrent agent is using the stack.

!!! danger "Never blanket kill"
    Do **not** run `taskkill //F //IM python.exe` or `taskkill //F //IM node.exe`. It kills MCP servers, Chrome DevTools, and Claude Code itself.

### 2. Start launcher + frontend

```powershell
$env:BROWSER='none'; Start-Process -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList "/c","npm run dev" -WorkingDirectory "D:/repos/PianoidInstall/PianoidTunner" -RedirectStandardOutput "D:/tmp/npmdev.log" -RedirectStandardError "D:/tmp/npmdev.err"
```

Detached `Start-Process` (a Bash `npm run dev` trips the harness long-running-process gate). **`BROWSER=none` is mandatory for agents:** without it CRA opens a new tab in the user's default browser on every start, and every such tab auto-loads the preset on reconnect (4 stale tabs → concurrent `/load_preset` → backend `0xC0000005`, 2026-10-10). Open exactly ONE page yourself via chrome-devtools.

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

### Branch FE from a worktree against the user's live backend (agents)

To verify a frontend branch while the user's stack (`:3000` main checkout, `:3001`, `:5000`) keeps running, run a
**second CRA from the worktree on a spare port** (e.g. `PORT=3013 BROWSER=none npx react-scripts start`, detached via
`Start-Process -WindowStyle Hidden`). Two traps (dev-4505, 2026-10-05):

- **Never junction the whole `node_modules` to main.** CRA 5's persistent webpack cache dir is hard-wired to
  `<app>/node_modules/.cache` and **ignores `CACHE_DIR`** (that only moves `babel-loader`), so through a single
  junction the worktree CRA overwrites main's `.cache/default-development` → main's next clean start serves a blank
  page (`reading 'call'`). Instead make the worktree `node_modules` a **real directory of per-entry junctions** to
  main's entries (copy top-level files) **plus a local `.cache` dir**. If main's cache was already written, delete
  `PianoidTunner/node_modules/.cache/default-development` (the next main start rebuilds it).
- **Keep the agent tab read-only towards the live backend.** A fresh origin has empty localStorage; an Apply/autoload
  would `POST /load_preset` with whatever settings it holds (a STRUCTURAL diff = full reload of the user's engine).
  Open the tab in an isolated Chrome context with a `navigate_page` `initScript` that answers every non-GET
  XHR/fetch to `:5000/:5001/:3001` locally (`load_preset` → `{"reinit":"full"}` so the FE hydrates via GETs) and
  blocks WebSockets to them; edits then change only the tab's local history. Verify afterwards by a backend GET.
- **An `initScript` guard covers ONE navigation only (dev-6c93 incident, 2026-10-06).** A `location.reload()` from
  `evaluate_script` and a CRA live-reload after a source edit both reload the tab WITHOUT the guard — the fresh origin's
  autoload then POSTs `/load_preset` with DEFAULT settings (listen_to_modes=1, number_of_modes=64, …) = a full engine
  reload on the user's backend. Always (re)open the tab via `navigate_page type=url` WITH the `initScript`, and navigate
  the tab to `about:blank` BEFORE editing worktree source. Even a guarded hydration still sends the loadPreset side
  writes (`set_runtime_parameters` volume_center/range defaults, `feedback_coeff`) — check them against the live values.
  If a reload slipped through: restore with the exact prior `load_preset` dict from `PianoidCore/logs/backend_stdout.log`.
- **Real input at exact coordinates:** chrome-devtools `click`/`drag` take an a11y uid, not x/y. Inject a 2×2
  `position:fixed; pointer-events:none` probe `<div role=button aria-label=probeX>` at the target point and click/drag
  its uid — the CDP mouse events land at the probe centre and hit the element underneath (rulers, canvases, chart bars).
- Removing the worktree: `cmd /c rmdir` every junction (or the whole junction dir) BEFORE `git worktree remove`.

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

**MANDATORY**: every agent that starts any of these processes must tear them all down before exiting — regardless of test outcome. Leaving stale processes blocks the next test run. The full AFTER procedure (close all agent pages → stop everything you created → clean slate by default, or exactly ONE clean stack only when the user needs it running → verification checklist) is [`PROJECT_CONFIG.md` → Clean stack](../PROJECT_CONFIG.md#clean-stack); `tools\kill_pianoid.ps1` + `env_sweep.py` replace the port loop above.

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
