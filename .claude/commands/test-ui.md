---
name: test-ui
description: Verify a Pianoid feature by launching the full stack, interacting via UI, measuring sound output, and reporting pass/fail with evidence.
user-invocable: true
tier: project
argument-hint: <what to verify — e.g. "excitation volume slider doubles amplitude", "volume sensitivity range=2 narrows dynamic range">
---

# Pianoid UI Verification Test

End-to-end feature verification using the frontend UI and deterministic sound measurement.
Invoke this skill after code changes that affect synthesis, parameters, or UI controls.

## Audio Mode: audio_off

This skill operates in **audio_off** mode (strict A1, see `docs/development/TESTING.md`). All measurement happens via `note_playback` deterministic offline render — the audio driver is incidental and the mic is never engaged. Verification is by buffer-vs-buffer comparison, not by audible playback.

For audio_on verification (mic-vs-synth comparison after mic-engaging code changes), use `/diagnose` instead. See the Audio Verification Rule in `.claude/CLAUDE.md`.

The frontend toolbar exposes two MUI Chips that signal lifecycle: **"Synth"** (green when synthesis kernel is running) and **"Audio"** (green when real audio driver is active). The Synth Chip is the readiness signal for this skill; the Audio Chip status is irrelevant to the verification.

## Principles

1. **All parameter changes go through the UI** — click, fill, press_key. Never use API calls to set parameters.
2. **All sound measurements use `note_playback` chart** — deterministic offline render, not the live circular buffer.
3. **Every claim is backed by a number** — amplitude, RMS, or ratio. No "should work."
4. **Screenshot every significant state change** — the user must be able to see what you did.

## Docs-first (MANDATORY) for server startup + rebuilds

A stale binary or stale server makes every measurement in this skill a lie. 2026-04-23 lost ~3h to a silently-stale `.pyd`.

- **Before starting backend/frontend** — read `docs/guides/QUICK_START.md` + `docs/modules/pianoid-middleware/REST_API.md` + `docs/guides/STARTUP_TROUBLESHOOTING.md`.
- **Pre-start hygiene** — the Phase 1 clean-stack BEFORE ([`PROJECT_CONFIG.md#clean-stack`](../../docs/PROJECT_CONFIG.md#clean-stack)): sweep stale backends/dev servers (core + agent spare ports), `.pyd` holders, and agent browser pages — do NOT skip; Phase 7 repeats it AFTER.
- **If this test requires a rebuild first** — canonical build = `cd /d PianoidCore && .\build_pianoid_cuda.bat --heavy --both` via the **detached `Start-Process`** form in agent context (absolute bat path, stop the `.pyd` holder first); NEVER `cmd //c … --heavy` (bricks the venv) and NEVER `pip install --force-reinstall … pianoid_cuda/` (stale `.pyd`). Full docs-first discipline + procedure: [`PROJECT_CONFIG.md` → Docs-first for build + run](../../docs/PROJECT_CONFIG.md#docs-first-build--run) / [`BUILD_SYSTEM.md` → Canonical Install / Rebuild](../../docs/architecture/BUILD_SYSTEM.md#canonical-install--rebuild-read-this-first).
- **Canonical venv only.** The project's only venv is `PianoidCore/.venv/`. If `pianoidCuda.cp312-win_amd64.pyd` or `pianoidCuda_debug.cp312-win_amd64.pyd` is MISSING from `PianoidCore/.venv/Lib/site-packages/`, **rebuild via `build_pianoid_cuda.bat`** — do NOT copy or fetch the file from any other venv (e.g. a stray root `.venv/`). Cross-venv binaries are silently stale at the C++ API level and produce runtime AttributeError. (2026-04-30 incident: 20-day-old debug pyd cross-fetched from root venv → `'pianoidCuda_debug.Pianoid' object has no attribute 'runSynthesisKernel'`.)
- **Verify rebuild landed** before measuring: `grep -a "<marker-you-added>" PianoidCore/.venv/Lib/site-packages/pianoidCuda.cp312-win_amd64.pyd`. Missing marker = stale binary = every "AFTER" number is garbage.
- **On unexpected server/build failure** — invoke `/startup` rather than burning phases on ad-hoc fixes.

## Monitoring & Crash Diagnostics

Every test-ui session MUST maintain a diagnostic log to help investigate crashes. The orchestrator (or the agent itself) should be able to retrieve this log after a crash.

### Session Log

Write all significant events to `/tmp/test-ui-session.log`:

```bash
echo "=== test-ui session started: $(date -Iseconds) ===" > /tmp/test-ui-session.log
echo "PID: $$" >> /tmp/test-ui-session.log
```

Append to this log at every phase transition and after every MCP call:

```bash
echo "[$(date -Iseconds)] Phase N: <description>" >> /tmp/test-ui-session.log
```

### Health Checks (run between phases)

After each phase, run and log:

```bash
# Process health
echo "[$(date -Iseconds)] HEALTH CHECK" >> /tmp/test-ui-session.log
tasklist 2>/dev/null | grep -iE "python|node|chrome" | head -20 >> /tmp/test-ui-session.log 2>&1
# Port health
netstat -ano 2>/dev/null | grep -E ":(3000|3001|5000) " | head -10 >> /tmp/test-ui-session.log 2>&1
# Memory
wmic OS get FreePhysicalMemory /value 2>/dev/null >> /tmp/test-ui-session.log 2>&1
echo "---" >> /tmp/test-ui-session.log
```

### Chrome DevTools MCP Call Wrapper

Before EVERY chrome-devtools MCP call, log the call name and parameters. After the call, log success/failure and elapsed time. If the call times out or errors, log the full error before aborting.

Pattern:
1. `echo "[timestamp] MCP CALL: <tool_name> params=<summary>" >> log`
2. Execute the MCP call
3. `echo "[timestamp] MCP RESULT: <success|error> elapsed=<seconds>" >> log`

**CRITICAL: Log BEFORE and AFTER every tool call, not just MCP calls.** This includes Bash commands, Read/Write/Edit operations, evaluate_script calls, and any other tool invocation. The log must show a complete trace of every action taken so that crash investigations can pinpoint the exact failing step.

### Comprehensive Logging Requirements

Every significant action must produce a log entry. Use this format consistently:

```bash
echo "[$(date -Iseconds)] ACTION: <what> | CONTEXT: <why> | DETAIL: <params/values>" >> /tmp/test-ui-session.log
```

**Log these events (minimum):**
- Every Bash command executed (command + exit code + first line of output)
- Every MCP tool call (tool name + key params before, result summary + elapsed after)
- Every evaluate_script call (script purpose + return value summary)
- Every screenshot taken (filename)
- Every fetch/curl request (URL + method + response status)
- Every phase transition (phase number + description)
- Every health check result (processes found, ports bound, free memory)
- Every error or unexpected result (full error text, not just "failed")
- Every retry attempt (what failed, attempt number)
- Agent context size warnings (if response feels slow, log estimated context usage)

**After each Bash command:**
```bash
CMD_EXIT=$?
echo "[$(date -Iseconds)] BASH EXIT: $CMD_EXIT" >> /tmp/test-ui-session.log
```

**After each MCP call, log timing:**
```bash
echo "[$(date -Iseconds)] MCP COMPLETE: <tool_name> | result_size=<chars> | success=<true|false>" >> /tmp/test-ui-session.log
```

### Memory and Context Monitoring

Between phases, log resource state:
```bash
echo "[$(date -Iseconds)] RESOURCE CHECK:" >> /tmp/test-ui-session.log
wmic OS get FreePhysicalMemory /value 2>/dev/null >> /tmp/test-ui-session.log 2>&1
wmic PROCESS where "name='python.exe' or name='node.exe' or name='chrome.exe'" get name,WorkingSetSize /value 2>/dev/null >> /tmp/test-ui-session.log 2>&1
echo "---" >> /tmp/test-ui-session.log
```

### On Crash or Timeout

If the session crashes or an MCP call times out:
1. Log the final state: `echo "[timestamp] CRASH/TIMEOUT: <details>" >> /tmp/test-ui-session.log`
2. Capture full process list: `tasklist > /tmp/test-ui-crash-processes.txt 2>&1`
3. Capture port state: `netstat -ano | grep -E ":(3000|3001|5000) " > /tmp/test-ui-crash-ports.txt 2>&1`
4. Capture console errors if browser is still alive (try `list_console_messages`)
5. Capture last 100 lines of frontend log: `tail -100 /tmp/test-ui-frontend.log > /tmp/test-ui-crash-frontend.txt 2>&1`
6. The log file survives the crash — the orchestrator can read it to diagnose

### Final Log Entry

The LAST action before returning results must be:
```bash
echo "[$(date -Iseconds)] SESSION COMPLETE: success=<true|false> | phases_completed=<N>/7 | total_mcp_calls=<N>" >> /tmp/test-ui-session.log
```
If this line is missing from the log, the agent crashed before completing.

## Procedure

### Phase 1: Setup

1. **Clean the stack — BEFORE (MANDATORY, mirrors the user's icon launcher).** Follow [`PROJECT_CONFIG.md#clean-stack`](../../docs/PROJECT_CONFIG.md#clean-stack) → BEFORE. **NEVER rely on servers already running — always clean and start fresh with the correct venv (`PianoidCore/.venv/Scripts/python`). NEVER ask the user about server state.** Port-targeted / marker-matched only — never blanket-kill python.exe or node.exe.
   ```powershell
   powershell -ExecutionPolicy Bypass -File D:\repos\PianoidInstall\tools\kill_pianoid.ps1 -DryRun   # inventory -> log it
   powershell -ExecutionPolicy Bypass -File D:\repos\PianoidInstall\tools\kill_pianoid.ps1           # supervisor tree + core ports + orphans + wt-* dev servers
   python D:\repos\PianoidInstall\tools\dev-pipeline\env_sweep.py                                       # MUST exit 0 (core ports free + spare ports 3002-3020/5002-5020 swept)
   tasklist /M pianoidCuda.cp312-win_amd64.pyd                                                         # no holder left (except a live concurrent agent's harness)
   ```
   Then **close every agent browser page**: chrome-devtools `list_pages` → `close_page` every page but one → `navigate_page` the last to `about:blank`. Append the inventory + sweep output to `/tmp/test-ui-session.log`. (Skip the sweep only if the orchestrator says a concurrent agent is using the stack — then clean only what you own.)

2. Start frontend — **use the PowerShell tool with `Start-Process -WindowStyle Hidden`, NOT `npm run dev &` in Bash.** A bare `npm run dev` spawns React + the launcher via `concurrently` (multiple child processes); under the Claude Code harness that trips the "long-running process" detector, which raises a CLI permission prompt **regardless of `bypassPermissions`** — invisible to a Telegram user, hanging the agent indefinitely. The detached `Start-Process` form avoids the gate:
   ```powershell
   $env:BROWSER='none'; Start-Process -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList "/c","npm run dev" -WorkingDirectory "D:/repos/PianoidInstall/PianoidTunner" -RedirectStandardOutput "D:/tmp/test-ui-frontend.log" -RedirectStandardError "D:/tmp/test-ui-frontend.err"
   ```
   **`BROWSER=none` is mandatory** — without it CRA opens a new tab in the user's own Chrome on every start, and those stale tabs auto-load the preset concurrently (2026-10-10 backend `0xC0000005`).
   Log the start to `/tmp/test-ui-session.log`, then poll for ports 3000 + 3001 to reach LISTENING (up to 60s); log when available. If `Start-Process` itself trips the gate on the session's first process, escalate to the orchestrator via SendMessage — do NOT retry (each retry re-prompts).

3. **Timeout safeguard:** If any chrome-devtools MCP call (especially `new_page`, `navigate_page`) does not respond within 30 seconds, log the timeout to `/tmp/test-ui-session.log`, capture crash diagnostics (process list, port state), then abort and report: "Browser MCP timed out — chrome-devtools server may not be running or is unresponsive. See /tmp/test-ui-session.log for diagnostics." Do NOT retry or wait indefinitely.

4. Open **exactly ONE** agent page (reuse the `about:blank` page via `navigate_page`, or `new_page`), set layout if needed, navigate to `http://localhost:3000`. Never open a second Pianoid tab — every tab auto-loads the preset on (re)connect. Log each MCP call.

5. Click **APPLY** → wait for the **"Synth"** Chip in the toolbar to turn green (the strict-A1 readiness signal — synthesis kernel running, GPU initialised). The "Audio" Chip may stay grey: this skill operates in audio_off mode (see Audio Mode below).

6. Select pitch via **Pitch spinbutton** → fill value → press Enter.

7. **Take screenshot** — confirm preset loaded, pitch selected, status "Playing".

### Phase 2: Baseline Measurement

Before testing the feature, establish a baseline:

1. **Measure sound** using `note_playback` chart (read-only API, acceptable):
   ```js
   // Via evaluate_script
   const resp = await fetch('http://127.0.0.1:5000/get_chart_test', {
     method: 'POST',
     headers: {'Content-Type': 'application/json'},
     body: JSON.stringify({
       chartType: 'note_playback',
       pitch: 60, velocity: 127,
       duration_ms: 500, display_length_ms: 500
     })
   }).then(r => r.json());
   return { hasAudio: resp.audio_data?.length > 0, dataPoints: resp.data?.[0]?.length };
   ```

2. Save `audio_data[0]` to a file and decode:
   ```bash
   cd PianoidCore && .venv/Scripts/python -c "
   import json, base64, wave, io, numpy as np
   with open('/tmp/baseline.json') as f:
       d = json.load(f)
   wav = base64.b64decode(d['audio_data'][0])
   wf = wave.open(io.BytesIO(wav), 'rb')
   s = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16).astype(float)
   print(f'BASELINE: {len(s)} samples, max={np.max(np.abs(s)):.0f}, rms={np.sqrt(np.mean(s**2)):.2f}')
   "
   ```

3. Record: `BASELINE max=XXXXX rms=XXXX.XX`

### Phase 3: Apply Change via UI

Interact ONLY through UI components:

- **Toolbar controls**: use keyboard hotkeys (`+`/`=` for vol up, `-` for vol down, Space for play)
- **Spinbutton inputs**: `fill` uid with value
- **MUI Sliders**: use hotkeys (cannot fill directly)
- **Dropdowns**: double-click label via `evaluate_script` → `fill` the input uid → click OK
- **Excitation sliders**: mousedown/set value/mouseup via `evaluate_script` with native value setter

After each UI action:
1. **Take screenshot** — show the change visually
2. **Check network requests** — verify the correct API call was sent
3. **Check console errors** — ensure no React errors

### Phase 4: Post-Change Measurement

1. Run the SAME `note_playback` chart with the SAME pitch/velocity.
2. Decode WAV and measure.
3. Record: `AFTER max=XXXXX rms=XXXX.XX`

### Phase 5: Compare & Report

Print a comparison table:

```
| Condition          | Max Amplitude | RMS      | Ratio vs Baseline |
|--------------------|---------------|----------|-------------------|
| Baseline           |         XXXXX | XXXX.XX  | 1.00              |
| After change       |         XXXXX | XXXX.XX  | X.XX              |
```

**Pass criteria** (adjust per test):
- For volume/sensitivity: ratio should match expected formula
- For excitation changes: amplitude should change proportionally
- For features that shouldn't affect sound: ratio ≈ 1.0

### Phase 6: Multi-Point Verification (if testing sensitivity/range)

For features with a range (volume slider, sensitivity):

1. Measure at 3+ points across the range (e.g., vol=0, vol=64, vol=127)
2. Record all measurements
3. Verify the dynamic range matches expectations:
   - Legacy: enormous range (thousands×)
   - range=2: 4× total (center/2 to center×2)
   - range=5: 25× total

### Phase 7: Cleanup — AFTER (MANDATORY — NEVER SKIP)

**Clean the stack AFTER, on every exit path** — [`PROJECT_CONFIG.md#clean-stack`](../../docs/PROJECT_CONFIG.md#clean-stack) → AFTER. Leaving stale processes or tabs prevents the user from restarting cleanly and is a severe violation.

1. **Close all agent pages FIRST** (before the backend goes down, so no tab reconnects / re-applies settings): `list_pages` → `close_page` all but one → `navigate_page` the last to `about:blank`.
2. **Stop everything you started** (spare-port CRA, worktree/isolated backend, modal adapter, harness), then sweep:
   ```powershell
   curl.exe -s -X POST http://127.0.0.1:3001/api/stop-backend
   powershell -ExecutionPolicy Bypass -File D:\repos\PianoidInstall\tools\kill_pianoid.ps1
   python D:\repos\PianoidInstall\tools\dev-pipeline\env_sweep.py      # MUST exit 0
   ```
3. **End state:** clean slate (default). Only if the brief says the user needs the stack running: start exactly ONE stack via Phase 1 step 2 (`BROWSER=none`) + `/api/start-backend` + preset, with **zero** agent pages on it. If the orchestrator flagged a concurrent agent on the stack: stop only what you created.
4. **Verification checklist** (log the evidence): listeners on 3000–3020 / 5000–5020 = none (or exactly 3000/3001/5000 for the one-stack case); `kill_pianoid.ps1 -DryRun` = no Pianoid processes (or one stack tree); no `.pyd` holder (or only that backend); `list_pages` = only `about:blank`; report (never touch) how many user-Chrome clients are ESTABLISHED to :3000.

**This cleanup MUST run even if:**
- The test failed or crashed
- The agent is about to return/exit
- An earlier phase threw an error
- The user cancelled the test

## Quick Reference

### Sustained audible note (for user to hear)
```js
// Via evaluate_script — hold Space for 3 seconds
() => {
  document.activeElement?.blur();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
  setTimeout(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));
  }, 3000);
}
```

### Decode WAV and measure
```python
import base64, wave, io, numpy as np
wav = base64.b64decode(b64_string)
wf = wave.open(io.BytesIO(wav), 'rb')
s = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16).astype(float)
max_amp, rms = np.max(np.abs(s)), np.sqrt(np.mean(s**2))
```

### Volume hotkeys
| Key | Action |
|-----|--------|
| `+` or `=` | Volume +5 |
| `-` | Volume −5 |
| Space | Play/stop note |
| `[` / `]` | Previous/next preset |
| Escape | Reset |

**Important:** Blur focused inputs before using hotkeys — range inputs block Space via `isInputFocused()`.
