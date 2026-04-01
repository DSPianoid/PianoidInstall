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

## Procedure

### Phase 1: Setup

1. Kill stale processes:
   ```bash
   taskkill //F //IM python.exe 2>/dev/null
   taskkill //F //IM node.exe 2>/dev/null
   sleep 2
   ```

2. Start frontend:
   ```bash
   cd D:\repos\PianoidInstall\PianoidTunner && npm run dev > /dev/null 2>&1 &
   ```
   Wait for ports 3000 + 3001.

3. **Timeout safeguard:** If any chrome-devtools MCP call (especially `new_page`, `navigate_page`) does not respond within 30 seconds, abort the task immediately and report: "Browser MCP timed out — chrome-devtools server may not be running or is unresponsive." Do NOT retry or wait indefinitely.

4. Open browser, set layout if needed, navigate to `http://localhost:3000`.

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

### Phase 7: Cleanup (MANDATORY)

```bash
curl -s -X POST http://127.0.0.1:3001/api/stop-backend 2>/dev/null
# close_page via MCP
taskkill //F //IM node.exe 2>/dev/null
taskkill //F //IM python.exe 2>/dev/null
```

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
