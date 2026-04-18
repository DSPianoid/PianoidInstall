---
name: test-ui
description: Verify a Pianoid feature by launching the full stack, interacting via UI, measuring sound output, and reporting pass/fail with evidence.
user-invocable: true
argument-hint: <what to verify — e.g. "excitation volume slider doubles amplitude", "volume sensitivity range=2 narrows dynamic range">
---

# Pianoid UI Verification Test

End-to-end feature verification using the frontend UI and deterministic sound measurement.
Invoke this skill after code changes that affect synthesis, parameters, or UI controls.

## Principles

1. **All parameter changes go through the UI** — click, fill, press_key. Never use API calls to set parameters.
2. **All sound measurements use `note_playback` chart** — deterministic offline render, not the live circular buffer.
3. **Every claim is backed by a number** — amplitude, RMS, or ratio. No "should work."
4. **Screenshot every significant state change** — the user must be able to see what you did.

## Monitoring & Crash Diagnostics

Every test-ui session MUST maintain a diagnostic log to help investigate crashes. The orchestrator (or the agent itself) should be able to retrieve this log after a crash.

### Session Log

Write all significant events to `D:/tmp/test-ui-session.log`:

```bash
echo "=== test-ui session started: $(date -Iseconds) ===" > D:/tmp/test-ui-session.log
echo "PID: $$" >> D:/tmp/test-ui-session.log
```

Append to this log at every phase transition and after every MCP call:

```bash
echo "[$(date -Iseconds)] Phase N: <description>" >> D:/tmp/test-ui-session.log
```

### Health Checks (run between phases)

After each phase, run and log:

```bash
# Process health
echo "[$(date -Iseconds)] HEALTH CHECK" >> D:/tmp/test-ui-session.log
tasklist 2>/dev/null | grep -iE "python|node|chrome" | head -20 >> D:/tmp/test-ui-session.log 2>&1
# Port health
netstat -ano 2>/dev/null | grep -E ":(3000|3001|5000) " | head -10 >> D:/tmp/test-ui-session.log 2>&1
# Memory
wmic OS get FreePhysicalMemory /value 2>/dev/null >> D:/tmp/test-ui-session.log 2>&1
echo "---" >> D:/tmp/test-ui-session.log
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
echo "[$(date -Iseconds)] ACTION: <what> | CONTEXT: <why> | DETAIL: <params/values>" >> D:/tmp/test-ui-session.log
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
echo "[$(date -Iseconds)] BASH EXIT: $CMD_EXIT" >> D:/tmp/test-ui-session.log
```

**After each MCP call, log timing:**
```bash
echo "[$(date -Iseconds)] MCP COMPLETE: <tool_name> | result_size=<chars> | success=<true|false>" >> D:/tmp/test-ui-session.log
```

### Memory and Context Monitoring

Between phases, log resource state:
```bash
echo "[$(date -Iseconds)] RESOURCE CHECK:" >> D:/tmp/test-ui-session.log
wmic OS get FreePhysicalMemory /value 2>/dev/null >> D:/tmp/test-ui-session.log 2>&1
wmic PROCESS where "name='python.exe' or name='node.exe' or name='chrome.exe'" get name,WorkingSetSize /value 2>/dev/null >> D:/tmp/test-ui-session.log 2>&1
echo "---" >> D:/tmp/test-ui-session.log
```

### On Crash or Timeout

If the session crashes or an MCP call times out:
1. Log the final state: `echo "[timestamp] CRASH/TIMEOUT: <details>" >> D:/tmp/test-ui-session.log`
2. Capture full process list: `tasklist > D:/tmp/test-ui-crash-processes.txt 2>&1`
3. Capture port state: `netstat -ano | grep -E ":(3000|3001|5000) " > D:/tmp/test-ui-crash-ports.txt 2>&1`
4. Capture console errors if browser is still alive (try `list_console_messages`)
5. Capture last 100 lines of frontend log: `tail -100 D:/tmp/test-ui-frontend.log > D:/tmp/test-ui-crash-frontend.txt 2>&1`
6. The log file survives the crash — the orchestrator can read it to diagnose

### Final Log Entry

The LAST action before returning results must be:
```bash
echo "[$(date -Iseconds)] SESSION COMPLETE: success=<true|false> | phases_completed=<N>/7 | total_mcp_calls=<N>" >> D:/tmp/test-ui-session.log
```
If this line is missing from the log, the agent crashed before completing.

## Procedure

### Phase 1: Setup

1. Kill stale Pianoid processes (**ONLY on Pianoid ports — never blanket-kill python.exe or node.exe**). **NEVER rely on servers already running — always kill and start fresh with the correct venv Python (`PianoidCore/.venv/Scripts/python`). NEVER ask the user about server state.**
   ```bash
   echo "[$(date -Iseconds)] Phase 1: Killing stale processes" >> D:/tmp/test-ui-session.log
   # Kill ONLY processes on Pianoid ports (5000=backend, 5001=modal adapter, 3000/3001=frontend)
   for port in 5000 5001 3000 3001; do
     pid=$(netstat -ano 2>/dev/null | grep ":${port} .*LISTENING" | awk '{print $NF}' | head -1)
     if [ -n "$pid" ] && [ "$pid" != "0" ]; then
       echo "Killing PID $pid on port $port" >> D:/tmp/test-ui-session.log
       taskkill //F //PID "$pid" 2>/dev/null
     fi
   done
   sleep 2
   # Verify they're dead
   echo "[$(date -Iseconds)] Post-kill process check:" >> D:/tmp/test-ui-session.log
   netstat -ano 2>/dev/null | grep -E ":(3000|3001|5000) " >> D:/tmp/test-ui-session.log 2>&1 || echo "  (none running)" >> D:/tmp/test-ui-session.log
   ```

2. Start frontend:
   ```bash
   echo "[$(date -Iseconds)] Starting frontend..." >> D:/tmp/test-ui-session.log
   cd D:\repos\PianoidInstall\PianoidTunner && npm run dev > D:/tmp/test-ui-frontend.log 2>&1 &
   echo "[$(date -Iseconds)] Frontend PID: $!" >> D:/tmp/test-ui-session.log
   ```
   Wait for ports 3000 + 3001. Log when ports become available.

3. **Timeout safeguard:** If any chrome-devtools MCP call (especially `new_page`, `navigate_page`) does not respond within 30 seconds, log the timeout to `D:/tmp/test-ui-session.log`, capture crash diagnostics (process list, port state), then abort and report: "Browser MCP timed out — chrome-devtools server may not be running or is unresponsive. See D:/tmp/test-ui-session.log for diagnostics." Do NOT retry or wait indefinitely.

4. Open browser, set layout if needed, navigate to `http://localhost:3000`. Log each MCP call.

5. Click **APPLY** → wait for **"Playing"**.

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
   cd D:/repos/PianoidInstall/PianoidCore && .venv/Scripts/python -c "
   import json, base64, wave, io, numpy as np
   with open('D:/tmp/baseline.json') as f:
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

### Phase 7: Cleanup (MANDATORY — NEVER SKIP)

**You MUST clean up ALL servers and browser pages you started, regardless of test outcome.** Leaving stale processes prevents the user from restarting and is a severe violation.

```bash
echo "[$(date -Iseconds)] Phase 7: Cleanup" >> D:/tmp/test-ui-session.log
# Close browser page via chrome-devtools MCP (close_page) FIRST
# Then stop backend gracefully
curl -s -X POST http://127.0.0.1:3001/api/stop-backend 2>/dev/null
# Kill ALL processes on Pianoid ports — never blanket-kill python.exe or node.exe
for port in 5000 5001 3000 3001; do
  pid=$(netstat -ano 2>/dev/null | grep ":${port} .*LISTENING" | awk '{print $NF}' | head -1)
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    echo "Cleanup: killing PID $pid on port $port" >> D:/tmp/test-ui-session.log
    taskkill //F //PID "$pid" 2>/dev/null
  fi
done
echo "[$(date -Iseconds)] Session complete" >> D:/tmp/test-ui-session.log
```

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
