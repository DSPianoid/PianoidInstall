---
name: diagnose
description: Full system diagnostic — interactive configuration, backend/frontend startup, sound generation, performance, audio driver, and optional mic verification. Auto-fixes with /dev on failure when -fix flag is set.
user-invocable: true
argument-hint: <options — e.g. "-fix", "-cli-only", "-skip-mic", or blank for default interactive diagnostic>
---

# Pianoid System Diagnostic

Comprehensive health check of the full Pianoid stack. Runs 8 diagnostic phases sequentially, verifying each layer from backend startup through audio output. On failure, either reports to the user or (with `-fix` flag) invokes `/dev` to attempt automated repair.

## Arguments

Parse `$ARGUMENTS` for flags:

| Flag | Effect |
|------|--------|
| `-fix` | On failure, invoke `/dev` to fix and re-run all diagnostics (up to 3 attempts) |
| `-cli-only` | Skip phases 8 (frontend UI verification) |
| `-skip-mic` | Skip phase 7 (microphone recording comparison) |
| (none) | Interactive diagnostic with user configuration prompts |

## Critical Rules

1. **Documentation first** — before investigating any failure, consult docs (see CLAUDE.md Documentation-First Rule)
2. **Never blanket-kill processes** — kill by specific PID on specific ports only
3. **Use correct venv** — always `PianoidCore\.venv`, never root `.venv/` or system Python
4. **Port-specific cleanup** — `netstat -ano | findstr :<port>` to identify PIDs
5. **Log everything** — write all diagnostic output to `D:/tmp/diagnose-session.log`

## Phase 0: Pre-Run Commit Gate (MANDATORY)

Before running any diagnostic, **all code changes must be committed**. Diagnostic results must be traceable to a specific codebase state.

### 0a: Check for uncommitted changes

Check all three repos for uncommitted work:

```bash
echo "=== Pre-run commit check ==="
for repo in PianoidCore PianoidBasic PianoidTunner; do
  cd D:/repos/PianoidInstall/$repo
  status=$(git status --porcelain 2>/dev/null)
  if [ -n "$status" ]; then
    branch=$(git branch --show-current)
    echo "UNCOMMITTED: $repo (branch: $branch)"
    echo "$status" | head -10
  else
    echo "CLEAN: $repo"
  fi
done
```

### 0b: If uncommitted changes exist

Ask the user:
```
Uncommitted changes found in <repo(s)>. Diagnostic results must be tied to a commit.
1. Commit to current branch and continue (Recommended)
2. Stash changes and run diagnostic on clean state
3. Abort — commit manually first
```

If committing: create a commit on the current branch (dev or feature branch) with message:
`"wip: pre-diagnostic checkpoint"`. Record the commit hash.

### 0c: Record commit state

Capture the exact commit hashes for all repos — these go into the report:

```bash
for repo in PianoidCore PianoidBasic PianoidTunner PianoidInstall; do
  cd D:/repos/PianoidInstall/$repo 2>/dev/null || cd D:/repos/PianoidInstall
  hash=$(git rev-parse --short HEAD 2>/dev/null)
  branch=$(git branch --show-current 2>/dev/null)
  echo "$repo: $hash ($branch)"
done
```

Store as variables: `commit_core`, `commit_basic`, `commit_tunner`, `commit_install`, and their branches.

---

## Session Log

Initialize the diagnostic log at the start:

```bash
echo "=== diagnose session started: $(date -Iseconds) ===" > D:/tmp/diagnose-session.log
echo "Arguments: $ARGUMENTS" >> D:/tmp/diagnose-session.log
echo "---" >> D:/tmp/diagnose-session.log
```

Append to this log at every phase transition and after every significant action:
```bash
echo "[$(date -Iseconds)] Phase N: <description> — <PASS|FAIL|SKIP>" >> D:/tmp/diagnose-session.log
```

---

## Default Parameters

Production-ready baseline configuration used when the user chooses defaults:

```json
{
  "path": "presets/BaselinePreset1.json",
  "audio_driver_type": 2,
  "sample_rate": 48,
  "volume": 120,
  "string_iterations": 4,
  "cycle_iterations": 64,
  "audio_buffer_size": 4,
  "array_size": 384,
  "audio_on": 1,
  "start_right_away": 1,
  "listen_to_midi": 0,
  "listen_to_modes": 1,
  "use_cuda": 1,
  "use_simulation": 0,
  "debug_mode": 0,
  "sound_derivative_order": 1
}
```

Default test pitches: `[60]` (C4). Microphone test: skip.

---

## Phase 1: Configuration

### Q1: Default or Custom Parameters

First question — ask the user whether to use defaults or pick parameters manually:

```
Use default parameters (BaselinePreset1, SDL2, 48kHz, production mode) or configure manually?
1. Use defaults (Recommended) — production settings, fast start
2. Configure manually — choose all initialization parameters
```

**If user chooses "Use defaults":** apply the Default Parameters above, set test pitches to `[60]`, skip mic test, and proceed directly to Phase 2.

**If user chooses "Configure manually":** ask ALL of Q2–Q9 below.

### Q2: Preset
```
Which preset to load?
1. BaselinePreset1.json (default)
2. Custom path (enter path)
```

### Q3: Audio Driver
```
Which audio driver should be tested?
1. SDL2 (safe default, works everywhere) (Recommended)
2. SDL3
3. ASIO Callback (low latency, requires ASIO driver)
4. ASIO (legacy spin-wait)
5. Default (auto-detect)
```
Map answers: 1→`2`, 2→`3`, 3→`4`, 4→`1`, 5→`0`

### Q4: Sample Rate
```
Sample rate?
1. 48 kHz (default) (Recommended)
2. 44.1 kHz
3. 96 kHz
```
Map: 1→`48`, 2→`44`, 3→`96`

### Q5: Build Mode
```
Build mode?
1. Production (Release build, no extraction) (Recommended)
2. Debug (Debug build, full extraction)
```
Map: 1→`0`, 2→`1`

### Q6: Engine Parameters
```
Engine parameters? (string_iterations / cycle_iterations / array_size / audio_buffer_size)
1. Production defaults (4 / 64 / 384 / 4) (Recommended)
2. High quality (12 / 64 / 512 / 4)
3. Low latency (4 / 64 / 384 / 2)
4. Custom (enter values)
```
Map:
- 1→ `string_iterations=4, cycle_iterations=64, array_size=384, audio_buffer_size=4`
- 2→ `string_iterations=12, cycle_iterations=64, array_size=512, audio_buffer_size=4`
- 3→ `string_iterations=4, cycle_iterations=64, array_size=384, audio_buffer_size=2`
- 4→ ask for each value individually

### Q7: Listen Mode & Sound Derivative
```
Listen mode?
1. Modes (Mode forces) — listen_to_modes=1 (Recommended)
2. Strings (Bridge displacement) — listen_to_modes=0
```

```
Sound derivative order?
1. 1st (Velocity) (Recommended)
2. 0th (Displacement)
3. 2nd (Acceleration)
```
Map: 1→`1`, 2→`0`, 3→`2`

### Q8: Test Pitch
```
Which pitch(es) to test?
1. C4 (MIDI 60) — middle C (Recommended)
2. A4 (MIDI 69) — concert A
3. C2 (MIDI 36) — low register
4. All registers (C2, C4, A4, C6)
```

### Q9: Microphone Test
```
Test microphone recording? (requires connected mic)
1. No (skip) (Recommended)
2. Yes
```
If `-skip-mic` flag is set, auto-answer "No".

### Store and Log Configuration

Store all answers in variables. Build the full `load_preset` payload from chosen parameters.

Log chosen configuration:
```bash
echo "[$(date -Iseconds)] CONFIG: driver=$audio_driver preset=$preset sample_rate=$sample_rate build=$debug_mode string_iter=$string_iterations cycle_iter=$cycle_iterations array_size=$array_size buffer=$audio_buffer_size listen_modes=$listen_to_modes derivative=$sound_derivative_order pitches=$pitches mic=$mic_test" >> D:/tmp/diagnose-session.log
```

---

## Phase 2: Backend Server Startup

### 2a: Clean up stale processes

```bash
echo "[$(date -Iseconds)] Phase 2a: Cleaning stale processes" >> D:/tmp/diagnose-session.log
for port in 5000 3000 3001; do
  pid=$(netstat -ano 2>/dev/null | grep ":${port} .*LISTENING" | awk '{print $NF}' | head -1)
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    echo "  Killing PID $pid on port $port" >> D:/tmp/diagnose-session.log
    taskkill //F //PID "$pid" 2>/dev/null
  fi
done
sleep 2
```

### 2b: Start backend server

**IMPORTANT:** The backend must be started from `pianoid_middleware/` directory — preset paths are relative to CWD.

```bash
echo "[$(date -Iseconds)] Phase 2b: Starting backend server" >> D:/tmp/diagnose-session.log
cd D:/repos/PianoidInstall/PianoidCore/pianoid_middleware && D:/repos/PianoidInstall/PianoidCore/.venv/Scripts/python backendserver.py > D:/tmp/diagnose-backend.log 2>&1 &
BACKEND_PID=$!
echo "  Backend PID: $BACKEND_PID" >> D:/tmp/diagnose-session.log
```

### 2c: Wait for server to respond

Poll `/ping` for up to 30 seconds:

```bash
for i in $(seq 1 15); do
  resp=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5000/ping 2>/dev/null)
  if [ "$resp" = "200" ]; then
    echo "[$(date -Iseconds)] Phase 2c: Server responding on port 5000" >> D:/tmp/diagnose-session.log
    break
  fi
  sleep 2
done
```

**PASS criteria:** `/ping` returns 200 within 30s — server is accepting connections.

**FAIL criteria:** Server doesn't respond within 30s. Check `D:/tmp/diagnose-backend.log` for traceback.

---

## Phase 3: Load Preset & Engine Initialization

### 3a: Send load_preset

Use the full parameter set from Phase 1 configuration:

```bash
echo "[$(date -Iseconds)] Phase 3a: Loading preset" >> D:/tmp/diagnose-session.log
load_resp=$(curl -s -X POST http://127.0.0.1:5000/load_preset \
  -H "Content-Type: application/json" \
  -d "{
    \"path\": \"$preset\",
    \"audio_driver_type\": $audio_driver,
    \"sample_rate\": $sample_rate,
    \"volume\": $volume,
    \"string_iterations\": $string_iterations,
    \"cycle_iterations\": $cycle_iterations,
    \"audio_buffer_size\": $audio_buffer_size,
    \"array_size\": $array_size,
    \"audio_on\": 1,
    \"start_right_away\": 1,
    \"listen_to_midi\": 0,
    \"listen_to_modes\": $listen_to_modes,
    \"use_cuda\": 1,
    \"use_simulation\": $use_simulation,
    \"debug_mode\": $debug_mode,
    \"sound_derivative_order\": $sound_derivative_order
  }" 2>/dev/null)
echo "  load_preset response: $load_resp" >> D:/tmp/diagnose-session.log
```

### 3b: Wait for engine to start

Poll `/health` until `pianoid_loaded: true` and `lifecycle.gpu_initialized: true` (up to 60s):

```bash
for i in $(seq 1 30); do
  h=$(curl -s http://127.0.0.1:5000/health 2>/dev/null)
  loaded=$(echo "$h" | python -c "import sys,json; d=json.load(sys.stdin); print(d.get('pianoid_loaded',False))" 2>/dev/null)
  gpu=$(echo "$h" | python -c "import sys,json; d=json.load(sys.stdin); print(d.get('lifecycle',{}).get('gpu_initialized',False))" 2>/dev/null)
  if [ "$loaded" = "True" ] && [ "$gpu" = "True" ]; then
    echo "[$(date -Iseconds)] Phase 3b: Engine loaded, GPU initialized" >> D:/tmp/diagnose-session.log
    break
  fi
  sleep 2
done
```

### 3c: Verify available notes

```bash
notes=$(curl -s http://127.0.0.1:5000/get_available_notes 2>/dev/null)
echo "[$(date -Iseconds)] Phase 3c: Available notes: $notes" >> D:/tmp/diagnose-session.log
```

### 3d: Full engine health check

Now that the preset is loaded and the engine is running, perform the comprehensive health verification:

```bash
health=$(curl -s http://127.0.0.1:5000/health 2>/dev/null)
echo "[$(date -Iseconds)] Phase 3d: Post-load health: $health" >> D:/tmp/diagnose-session.log
```

Extract and verify all health fields:

```python
import json, sys
h = json.loads(sys.argv[1])
checks = {
    "pianoid_loaded": h.get("pianoid_loaded") == True,
    "gpu_initialized": h.get("lifecycle", {}).get("gpu_initialized") == True,
    "audio_driver_active": h.get("lifecycle", {}).get("audio_driver_active") == True,
    "main_loop_running": h.get("lifecycle", {}).get("main_loop_should_continue") == True,
    "no_exception": h.get("exception") != True,
    "status_ok": h.get("status") in ("playing", "running", "loaded", "healthy"),
}
for k, v in checks.items():
    print(f"  {k}: {'PASS' if v else 'FAIL'}")
all_pass = all(checks.values())
print(f"HEALTH: {'PASS' if all_pass else 'FAIL'}")
sys.exit(0 if all_pass else 1)
```

**PASS criteria:** All 6 checks pass — engine loaded, GPU ready, audio driver active, main loop running, no exceptions, status is playing.

**FAIL criteria:** Any check fails. Common issues:
- `gpu_initialized: false` — CUDA build or GPU problem
- `audio_driver_active: false` — wrong driver type or missing ASIO
- `exception: true` — check health `message` field for details
- No available notes — preset file not found or corrupt

---

## Phase 4: Sound Generation & Amplitude Check

For each test pitch:

### 4a: Generate sound via note_playback

```bash
echo "[$(date -Iseconds)] Phase 4a: Testing sound generation for pitch $pitch" >> D:/tmp/diagnose-session.log
```

Use `curl` to call `POST /get_chart_test`:

```bash
sound_resp=$(curl -s -X POST http://127.0.0.1:5000/get_chart_test \
  -H "Content-Type: application/json" \
  -d "{
    \"chartType\": \"note_playback\",
    \"pitch\": $pitch,
    \"velocity\": 127,
    \"duration_ms\": 500,
    \"display_length_ms\": 500
  }" 2>/dev/null)
```

Save the response and extract `audio_data[0]` (base64 WAV).

### 4b: Decode and measure amplitude

```python
# Run via PianoidCore/.venv/Scripts/python
import json, base64, wave, io, numpy as np

with open('D:/tmp/diagnose-sound.json') as f:
    d = json.load(f)

if not d.get('audio_data') or len(d['audio_data']) == 0:
    print("FAIL: No audio_data in response")
    exit(1)

wav = base64.b64decode(d['audio_data'][0])
wf = wave.open(io.BytesIO(wav), 'rb')
s = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16).astype(float)

max_amp = np.max(np.abs(s))
rms = np.sqrt(np.mean(s**2))
duration_s = len(s) / wf.getframerate()
silence_ratio = np.sum(np.abs(s) < 10) / len(s)

print(f"samples={len(s)} max_amp={max_amp:.0f} rms={rms:.2f} duration={duration_s:.3f}s silence_ratio={silence_ratio:.3f}")
```

### 4c: Spectral analysis

Compute spectral characteristics for the report. Run via `PianoidCore/.venv/Scripts/python`:

```python
import numpy as np
from scipy.fft import fft

# s = decoded samples (from 4b), sample_rate = wf.getframerate()
N = len(s)
freqs = np.fft.rfftfreq(N, 1.0 / sample_rate)
spectrum = np.abs(fft(s)[:N // 2 + 1])
spectrum_db = 20 * np.log10(spectrum + 1e-10)

# Find fundamental and harmonics
peak_idx = np.argmax(spectrum[1:]) + 1  # skip DC
fundamental_hz = freqs[peak_idx]
fundamental_db = spectrum_db[peak_idx]

# Find top 5 spectral peaks
top_indices = np.argsort(spectrum[1:])[-5:][::-1] + 1
harmonics = [(freqs[i], spectrum_db[i]) for i in top_indices]

# Spectral centroid (brightness indicator)
spectral_centroid = np.sum(freqs * spectrum) / (np.sum(spectrum) + 1e-10)

# THD (total harmonic distortion) — ratio of harmonic energy to fundamental
fundamental_energy = spectrum[peak_idx] ** 2
total_energy = np.sum(spectrum[1:] ** 2)
thd = np.sqrt((total_energy - fundamental_energy) / (fundamental_energy + 1e-10))

print(f"fundamental={fundamental_hz:.1f}Hz ({fundamental_db:.1f}dB)")
print(f"spectral_centroid={spectral_centroid:.1f}Hz")
print(f"thd={thd:.4f}")
print(f"harmonics: {[(f'{hz:.1f}Hz', f'{db:.1f}dB') for hz, db in harmonics]}")
```

Save all spectral data as variables for the report: `fundamental_hz`, `spectral_centroid`, `thd`, `harmonics`.

### 4d: Evaluate results

| Metric | PASS | WARN | FAIL |
|--------|------|------|------|
| `max_amp` | > 1000 | 100–1000 | < 100 (silence) |
| `rms` | > 500 | 50–500 | < 50 |
| `silence_ratio` | < 0.5 | 0.5–0.9 | > 0.9 (mostly silent) |
| `duration_s` | > 0.3 | 0.1–0.3 | < 0.1 (too short) |
| `thd` | < 0.5 | 0.5–0.9 | > 0.9 (severe distortion) |

Log all values and pass/fail determination.

---

## Phase 5: Performance Measurement

### 5a: Get playback stats

```bash
stats=$(curl -s http://127.0.0.1:5000/playback_stats 2>/dev/null)
echo "[$(date -Iseconds)] Phase 5: Playback stats: $stats" >> D:/tmp/diagnose-session.log
```

### 5b: Play a burst of notes and measure timing

Play 5 notes in sequence (pitches 48, 55, 60, 67, 72) with 200ms spacing, then check stats:

```bash
for p in 48 55 60 67 72; do
  curl -s -X POST http://127.0.0.1:5000/play \
    -H "Content-Type: application/json" \
    -d "{\"pitch\": $p, \"velocity\": 100}" > /dev/null 2>&1
  sleep 0.2
  curl -s -X POST http://127.0.0.1:5000/play \
    -H "Content-Type: application/json" \
    -d "{\"pitch\": $p, \"velocity\": 0}" > /dev/null 2>&1
done
sleep 1
stats_after=$(curl -s http://127.0.0.1:5000/playback_stats 2>/dev/null)
```

### 5c: Evaluate performance

Extract from stats JSON:
- `avg_event_latency_ms` — **PASS**: < 5ms, **WARN**: 5–20ms, **FAIL**: > 20ms
- `peak_buffer_size` — **PASS**: < 10, **WARN**: 10–50, **FAIL**: > 50
- All events processed (total_events_pushed ≈ total_events_drained)

---

## Phase 6: Audio Driver Verification

### 6a: Check driver status from health

```bash
health=$(curl -s http://127.0.0.1:5000/health 2>/dev/null)
```

Extract `lifecycle.audio_driver_active`. Must be `true`.

### 6b: Play an audible note and verify no errors

Play a note via `/play` (note ON for 1 second, then note OFF):

```bash
curl -s -X POST http://127.0.0.1:5000/play \
  -H "Content-Type: application/json" \
  -d "{\"pitch\": 60, \"velocity\": 100}" > /dev/null
sleep 1
curl -s -X POST http://127.0.0.1:5000/play \
  -H "Content-Type: application/json" \
  -d "{\"pitch\": 60, \"velocity\": 0}" > /dev/null
```

### 6c: Check for audio errors

Re-check `/health` after playback — look for `exception: true` or `status` changes.
Check `/playback_stats` for buffer overruns (`peak_buffer_size` spike, event count mismatches).

**PASS criteria:** `audio_driver_active: true`, no exceptions, no buffer overruns, events balanced.

---

## Phase 7: Microphone Recording Comparison (Optional)

**Skip if** `-skip-mic` flag is set or user chose to skip in Phase 1.

### 7a: List available microphone devices

```bash
mic_devices=$(curl -s http://127.0.0.1:5000/mic_devices 2>/dev/null)
echo "[$(date -Iseconds)] Phase 7a: Mic devices: $mic_devices" >> D:/tmp/diagnose-session.log
```

If no devices found, log and skip with warning.

### 7b: Select microphone

If multiple devices, ask user which to use. Set device:

```bash
curl -s -X POST http://127.0.0.1:5000/set_mic_device \
  -H "Content-Type: application/json" \
  -d "{\"device_index\": $device_idx}" > /dev/null
```

### 7c: Measure RMS via microphone

Use the `/measure_rms` endpoint for a test pitch:

```bash
rms_resp=$(curl -s -X POST http://127.0.0.1:5000/measure_rms \
  -H "Content-Type: application/json" \
  -d "{\"pitch\": $pitch, \"velocity\": 100}" 2>/dev/null)
echo "[$(date -Iseconds)] Phase 7c: Mic RMS: $rms_resp" >> D:/tmp/diagnose-session.log
```

### 7d: Compare generated vs recorded

1. Generate sound via `note_playback` (internal, deterministic) — get max_amp and rms
2. Record via microphone (external, real audio path) — get mic rms
3. Compare:
   - Mic RMS should be > 0 (sound is reaching the mic)
   - Check for gross distortion: if mic RMS is > 10× the expected proportional level, flag as distorted
   - If mic captures silence while internal sound is loud, flag audio routing issue

**PASS criteria:** Mic captures non-zero audio, proportional to generated amplitude, no obvious distortion.

**WARN criteria:** Mic level very low (possible volume/routing issue) or very high (possible clipping).

**FAIL criteria:** Mic captures pure silence while engine generates sound — audio driver or routing broken.

---

## Phase 8: Frontend UI Verification (Optional)

**Skip if** `-cli-only` flag is set.

### 8a: Start frontend

```bash
echo "[$(date -Iseconds)] Phase 8a: Starting frontend" >> D:/tmp/diagnose-session.log
cd D:/repos/PianoidInstall/PianoidTunner && npm run dev > D:/tmp/diagnose-frontend.log 2>&1 &
```

Wait for ports 3000 + 3001 (up to 60s).

### 8b: Open browser and load preset via UI

Use Chrome DevTools MCP:

1. `new_page` → `http://localhost:3000`
2. `wait_for` → "APPLY" text (up to 30s)
3. `take_screenshot` — verify UI rendered
4. If backend is already running from Phase 2, click APPLY directly
5. `wait_for` → "Playing" text (up to 120s)
6. `take_screenshot` — verify loaded state

### 8c: Re-run Phases 3–6 through UI context

Repeat the core diagnostic checks, but this time verify that:
- The frontend correctly shows "Playing" status
- Parameter panels populate when a pitch is selected
- Note playback through Virtual Piano canvas produces sound
- No console errors (`list_console_messages`)
- Network requests to backend succeed (`list_network_requests`)

### 8d: Play note via Virtual Piano

Use the canvas right-click pattern from `/pianoid-ui` skill:

```js
// evaluate_script — play test pitch via Virtual Piano
(targetPitch) => {
  const panels = document.querySelectorAll('.mosaic-window');
  for (const panel of panels) {
    const title = panel.querySelector('.mosaic-window-title');
    if (title && title.textContent.includes('Virtual Piano')) {
      const canvas = panel.querySelector('canvas');
      const rect = canvas.getBoundingClientRect();
      const keySize = canvas.clientWidth / 88;
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

Verify sound is generated (via `note_playback` measurement after the UI play).

### 8e: Take final screenshot

Capture the UI state showing successful playback.

---

## Cleanup (MANDATORY)

Run after all phases complete (success or failure):

```bash
echo "[$(date -Iseconds)] Cleanup: stopping services" >> D:/tmp/diagnose-session.log

# Stop backend gracefully
curl -s -X POST http://127.0.0.1:5000/shutdown 2>/dev/null
sleep 2

# Stop launcher if running
curl -s -X POST http://127.0.0.1:3001/api/stop-backend 2>/dev/null

# Close browser tab (if opened)
# close_page via MCP

# Kill remaining processes on Pianoid ports only
for port in 5000 3000 3001; do
  pid=$(netstat -ano 2>/dev/null | grep ":${port} .*LISTENING" | awk '{print $NF}' | head -1)
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    echo "  Cleanup: killing PID $pid on port $port" >> D:/tmp/diagnose-session.log
    taskkill //F //PID "$pid" 2>/dev/null
  fi
done

echo "[$(date -Iseconds)] Cleanup complete" >> D:/tmp/diagnose-session.log
```

---

## Failure Handling

**CRITICAL: Never report results without a clean full pass.** If any phase fails and a fix is applied (whether manually or via `/dev`), the entire diagnostic sequence (Phases 2–8) must be re-run from scratch before reporting. Partial results from a run that included a failure are not trustworthy — a fix in one phase may affect other phases.

### Without `-fix` flag

On any phase failure:
1. Log the full failure details to `D:/tmp/diagnose-session.log`
2. Continue remaining phases (collect all failures for awareness)
3. At the end, print a diagnostic report with all results
4. Relay failures to user with specific error details and suggested fixes
5. **Do NOT present this as a final report** — clearly mark it as "preliminary results with failures"

### With `-fix` flag

On any phase failure:
1. Log the failure
2. Analyze the root cause using documentation (not source code trawling)
3. Invoke `/dev` skill with a targeted fix description
4. After `/dev` completes, **perform full Cleanup** (stop all services, kill ports)
5. **Re-run ALL diagnostic phases from Phase 2** (clean restart — not just the failed phase)
6. Only produce the Final Report after a **complete clean run with all phases passing**
7. If the same error persists after 3 fix attempts, abort and relay to user:

```
DIAGNOSTIC FAILED after 3 fix attempts.

Persistent failure in Phase N: <description>
Error: <details>
Fix attempts:
  1. <what was tried> — <result>
  2. <what was tried> — <result>
  3. <what was tried> — <result>

Log: D:/tmp/diagnose-session.log
Backend log: D:/tmp/diagnose-backend.log
Frontend log: D:/tmp/diagnose-frontend.log (if applicable)

Please investigate manually or provide more context.
```

### Re-run Protocol

When re-running after a fix:
1. Run Cleanup to stop all services
2. Clear backend and frontend logs (`> D:/tmp/diagnose-backend.log`, etc.)
3. Log: `echo "[$(date -Iseconds)] === RE-RUN after fix attempt N ===" >> D:/tmp/diagnose-session.log`
4. Execute Phases 2–8 in full (same configuration from Phase 1)
5. If all phases pass, produce the Final Report with a note: "Passed after N fix attempt(s)"
6. If any phase fails again, loop back to fix (up to 3 total attempts)

---

## System Info Collection

Collect hardware and system data for the report. Run once during Phase 0 or Phase 1:

```bash
# Machine identity
hostname=$(hostname)
os_version=$(cmd //c "ver" 2>/dev/null | grep -i windows || uname -a)

# CPU info
cpu_name=$(wmic cpu get name /value 2>/dev/null | grep -i name | cut -d= -f2 | tr -d '\r')
cpu_cores=$(wmic cpu get NumberOfCores /value 2>/dev/null | grep -i cores | cut -d= -f2 | tr -d '\r')
cpu_threads=$(wmic cpu get NumberOfLogicalProcessors /value 2>/dev/null | grep -i logical | cut -d= -f2 | tr -d '\r')

# GPU info
gpu_name=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
gpu_driver=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)
gpu_memory=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader 2>/dev/null | head -1)
gpu_cuda=$(nvcc --version 2>/dev/null | grep "release" | awk '{print $5}' | tr -d ',')
gpu_compute=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1)

# RAM
total_ram=$(wmic OS get TotalVisibleMemorySize /value 2>/dev/null | grep -i total | cut -d= -f2 | tr -d '\r')

# Python version
python_version=$(D:/repos/PianoidInstall/PianoidCore/.venv/Scripts/python --version 2>&1)
```

Store all as variables for the report.

---

## Final Report & Persistent Record

After a successful run (all phases PASS), produce two outputs:
1. Print a summary to the user (console)
2. Save a detailed report as a Markdown file

### Report Directory

```
D:\repos\PianoidInstall\docs\development\diagnostic-reports\
```

Create this directory if it doesn't exist. Do NOT add it to `.gitignore` — reports should be committed.

### Report Filename

Format: `YYYY-MM-DD_HHmmss_<hostname>.md`

Example: `2026-04-05_093000_WORKSTATION.md`

### Report Template

Write the following to the report file:

```markdown
# Diagnostic Report

| Field | Value |
|-------|-------|
| Date | YYYY-MM-DD HH:MM:SS |
| Hostname | <hostname> |
| OS | <os_version> |
| Result | PASS (or PASS after N fix attempts) |
| Fix attempts | 0 (or N) |

## System

| Component | Details |
|-----------|---------|
| CPU | <cpu_name> (<cpu_cores> cores / <cpu_threads> threads) |
| GPU | <gpu_name> (<gpu_memory>, compute <gpu_compute>) |
| GPU Driver | <gpu_driver> |
| CUDA Toolkit | <gpu_cuda> |
| RAM | <total_ram_gb> GB |
| Python | <python_version> |

## Codebase State

| Repo | Commit | Branch |
|------|--------|--------|
| PianoidCore | <commit_core> | <branch_core> |
| PianoidBasic | <commit_basic> | <branch_basic> |
| PianoidTunner | <commit_tunner> | <branch_tunner> |
| PianoidInstall | <commit_install> | <branch_install> |

## Configuration

```json
{
  "path": "<preset>",
  "audio_driver_type": <audio_driver>,
  "sample_rate": <sample_rate>,
  "volume": <volume>,
  "string_iterations": <string_iterations>,
  "cycle_iterations": <cycle_iterations>,
  "audio_buffer_size": <audio_buffer_size>,
  "array_size": <array_size>,
  "listen_to_modes": <listen_to_modes>,
  "use_simulation": <use_simulation>,
  "debug_mode": <debug_mode>,
  "sound_derivative_order": <sound_derivative_order>
}
```

## Phase Results

| Phase | Check | Status | Details |
|-------|-------|--------|---------|
| 0 | Commit Gate | DONE | all repos clean |
| 1 | Configuration | DONE | <summary> |
| 2 | Backend Server | PASS | port 5000 OK |
| 3 | Preset & Engine | PASS | <note_count> notes, status=healthy |
| 4 | Sound Generation | PASS | see below |
| 5 | Performance | PASS | see below |
| 6 | Audio Driver | PASS | <driver_type> active |
| 7 | Microphone | PASS/SKIP | <details> |
| 8 | Frontend UI | PASS/SKIP | <details> |

## Sound Generation

| Pitch | Max Amp | RMS | Duration | Silence % | Fundamental | Centroid | THD | Status |
|-------|---------|-----|----------|-----------|-------------|----------|-----|--------|
| C4 (60) | 26213 | 3056.14 | 0.500s | 0.9% | 261.6 Hz | 1234.5 Hz | 0.0312 | PASS |

### Spectral Detail (per pitch)

**C4 (MIDI 60):**
- Fundamental: <fundamental_hz> Hz (<fundamental_db> dB)
- Spectral centroid: <spectral_centroid> Hz
- THD: <thd>
- Top harmonics: <harmonics list>

## Performance

| Metric | Value | Status |
|--------|-------|--------|
| avg_event_latency_ms | <value> | PASS/WARN/FAIL |
| peak_buffer_size | <value> | PASS/WARN/FAIL |
| total_events_pushed | <value> | — |
| total_events_drained | <value> | — |
| avg_insert_latency_us | <value> | — |
| avg_drain_latency_us | <value> | — |

## Microphone (if tested)

| Metric | Value |
|--------|-------|
| Device | <mic_device> |
| Mic dB | <mic_db> |
| Mic RMS | <mic_rms> |
| Mic Peak | <mic_peak> |
| Synthesis Peak | <synthesis_peak> |
| Mic/Synthesis Ratio | <ratio> |

## Frontend UI (if tested)

| Check | Status |
|-------|--------|
| UI renders | PASS/FAIL |
| Preset loads via APPLY | PASS/FAIL |
| Pitch selection populates panels | PASS/FAIL |
| Virtual Piano note produces sound | PASS/FAIL |
| Console errors (new) | 0 |
```

### Commit the Report

After writing the report file, commit it:

```bash
cd D:/repos/PianoidInstall
git add docs/development/diagnostic-reports/
git commit -m "diagnostic: <date> <hostname> — <PASS|FAIL>"
```

---

## Console Summary

Also print a brief summary to the user:

```
╔══════════════════════════════════════════════════════════════╗
║                  PIANOID DIAGNOSTIC REPORT                   ║
╠═══════╤══════════════════════════════╤════════╤══════════════╣
║ Phase │ Check                        │ Status │ Details      ║
╠═══════╪══════════════════════════════╪════════╪══════════════╣
║   0   │ Commit Gate                  │  DONE  │ all clean    ║
║   1   │ Configuration                │  DONE  │ SDL2, 48kHz  ║
║   2   │ Backend Server               │  PASS  │ port 5000 OK ║
║   3   │ Preset & Engine              │  PASS  │ 88 notes     ║
║   4   │ Sound Generation             │  PASS  │ max=26213    ║
║   5   │ Performance                  │  PASS  │ lat=1.1ms    ║
║   6   │ Audio Driver                 │  PASS  │ active, 0 err║
║   7   │ Microphone                   │  SKIP  │ no mic       ║
║   8   │ Frontend UI                  │  PASS  │ all checks OK║
╠══════════════════════════════════════════════════════════════╣
║ Overall: 7/8 PASS, 0 FAIL, 1 SKIP                           ║
║ Report: docs/development/diagnostic-reports/<filename>.md    ║
║ Log: D:/tmp/diagnose-session.log                             ║
╚══════════════════════════════════════════════════════════════╝
```

---

## Invoking /dev for Fixes — Context from Previous Reports

When the `-fix` flag triggers `/dev` to fix a diagnostic failure, the `/dev` invocation **MUST** include context from previous successful diagnostic reports. This allows `/dev` to identify what changed.

### Before invoking /dev:

1. **Find the last successful report:**

```bash
ls -t D:/repos/PianoidInstall/docs/development/diagnostic-reports/*.md 2>/dev/null | head -5
```

2. **Read the last successful report** and extract:
   - Commit hashes (which version of the code last passed)
   - Configuration used (were the parameters different?)
   - Performance metrics (has latency/amplitude regressed?)
   - System info (same machine or different?)

3. **Diff the codebase** between the last passing commits and current HEAD:

```bash
# For each repo, diff from last-passing commit to current HEAD
cd D:/repos/PianoidInstall/PianoidCore
git log --oneline <last_passing_commit>..HEAD
git diff --stat <last_passing_commit>..HEAD
```

4. **Include in the /dev prompt:**

```
Fix diagnostic failure in Phase N: <error description>

Last successful diagnostic: <report filename>
  - Date: <date>
  - Commits: Core=<hash>, Basic=<hash>, Tunner=<hash>
  - Config: <key differences or "identical">

Changes since last pass:
  PianoidCore: <N commits>
    <git log --oneline summary>
  PianoidTunner: <N commits>
    <git log --oneline summary>

Current failure: <full error details>
```

This gives `/dev` the full picture: what worked before, what changed, and what broke.
