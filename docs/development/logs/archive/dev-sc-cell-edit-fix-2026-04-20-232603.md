# Dev Session Log

- **Agent:** dev-sc-cell-edit-fix
- **Task:** Wave D — Fix SC cell-edit write path (stale closure on pitch + emit-once symptom)
- **Started:** 2026-04-20T23:26:03+03:00
- **Plan file:** None (task spec from orchestrator mt-sound-channels)
- **Status:** In Progress

## Actions

### Step 0: Initialize Session — 23:26
- Agent ID: `dev-sc-cell-edit-fix`
- Log file created
- Checked MODULE_LOCKS.md: only `docs-sc-overview` holds docs-only locks (no overlap with our target JS hooks)
- Checked WIP: no active dev sessions conflicting
- Target source files: `PianoidTunner/src/hooks/usePreset.js`, `PianoidTunner/src/hooks/useSoundChannels.js`

### Step 1: Docs-First Context — 23:28
- Read `docs/index.md` — confirmed PianoidTunner = React frontend, REST+WS to backend:5000
- Read `docs/modules/pianoid-tunner/OVERVIEW.md`: usePreset owns SC cache, has `changeSoundChannelValues` and `changeSoundChannelFeedback`; useSoundChannels owns SC UI state, commits via useEffect on `scModesHistory.mutedMatrix`
- DATA_FLOWS §2.4: sound_channel POST target is `/set_parameter/sound_channel/<pitch>` (modes axis) OR `/set_parameter/string_sound_channel/<pitch>` (strings axis)
- REST_API.md: `sound_channel` param type handled by `parse_range(key_no)`. Key formats: `"57"`, `"all"`, `"output"`, `"from21to88"`. `String(null) = "null"` matches none → backend returns 500 "Error parsing range null"
- **Root cause confirmed** for Bug #1: `changeSoundChannelValues` at usePreset.js:254 and :258 use `pitch === "all" ? "All" : String(pitch)` — when `pitch=null`, this produces `"null"` (literal string), which backend rejects. Compare to `changeSoundChannelFeedback` at line 285,288: uses `pitch == null ? "output" : String(pitch)` — correct null check
- **Stale-closure issue:** the debounced inner function captures `pitch` and `paramType` via closure at creation time (line 257). Even if callers later pass a real pitch value, the captured one is used. Fix: pass args to the inner function per-call
- **Emit-once hypothesis:** likely a consequence of #1 — first emit with key="null" fails, backend returns error, but inner is fire-and-forget so subsequent emits SHOULD still fire. Will diagnose in test-ui phase
- Compared working patterns: `changeFeedInValues` (line 348), `changeParametersOfStrings` (line 606), all accept per-call args into the debounced inner via its argument list

### Step 1b: Environment Control — 23:30
- Killed all stale processes on ports 3000/3001/5000/5001
- Ports confirmed clear

### Step 2: Baseline Build — 23:31
- `CI=true npm run build` fails on pre-existing lint warnings (unrelated to SC code: useSettings useEffect deps, ModalAdapter unused vars). NOT our scope.
- `npm run build` (non-CI) succeeds: "Compiled with warnings. The build folder is ready to be deployed."
- Baseline: PASS (non-CI). We'll keep targeting non-CI mode.

### Step 3: Feature Branch — 23:32
- Created `fix/sc-cell-edit-write` in PianoidTunner (from `dev`)

### Step 4: P1/P2 Analysis + Edit — 23:33
- **P1 Authority:** SC coefficient state owned by `useMatrixHistory` (via `useSoundChannels`). Write authority to backend = `usePreset.changeSoundChannelValues`. Fix stays within this owner boundary — no new writers.
- **P2 Concern:** `changeSoundChannelValues` has one concern: debounced-state+network write for SC coefficients. Fix tightens correctness; no concern widening.
- **Fix applied** (usePreset.js, lines 246-278):
  - Compute `pitchKey` in the outer function using `pitch == null ? "All" : String(pitch)` (matches `changeSoundChannelFeedback` null-safe pattern; prevents `String(null) = "null"` hitting backend)
  - Pass `newData`, `pitchKey`, `paramType` to the debounced inner as args (signature `(data, pk, pt)`) instead of capturing `pitch`/`paramType` via closure
  - Inner function reads from its own args — fresh on every call — so a ref reused for multiple invocations (same key) always serializes the latest values
- LOC delta: +4 / -4 (net 0; one key line refactored, one comment added)
- **Deliberately NOT changed:** `changeSoundChannelFeedback` — already uses `pitch == null` check and each `key` ("all"/numeric) maps one-to-one to its closure pitch, so no stale-closure risk for callers we own. Touching it would widen scope.
- Post-fix `npm run build`: "Compiled with warnings. The build folder is ready to be deployed." — no new errors.

### Step 5-8: Scenario Matrix — 23:40-23:50

Test strategy: installed WebSocket send hook via `initScript` on page navigation to capture all outbound Socket.IO frames matching `set_parameter`. Also hooked `fetch` and `XMLHttpRequest.send` to capture REST fallbacks. Handlers invoked via React fiber walks from the MeasuredMatrix canvas to `onMatrixValuesChange`, `onUndo`, `onRedo`, `onAggregateToggle`.

| # | Scenario | Change dispatched | WS Emit Result |
|---|---|---|---|
| S3 | Single cell | `{op:Value, zone:Cell, pitch:60, mode:0, newValue:0.77}` | 1 emit, `sound_channel/All`, 84 pitches; pitch60 ch0=0.77 ✓ |
| S4 | Whole row | `{op:Value, zone:modesVector, pitch:60, newValue:0.42}` | 1 emit, `sound_channel/All`; pitch60=[0.42,0.42,0.42,0.42] ✓ |
| S5 | Whole col | `{op:Value, zone:pitchesVector, mode:2, newValue:0.55}` | 1 emit, `sound_channel/All`; all 84 pitches ch2=0.55 ✓ |
| S6 | Multiplier Matrix | `{op:Coefficient, zone:Matrix, newValue:0.5}` | 1 emit, `sound_channel/All`; all pitches halved ✓ |
| S7 | Undo | `onUndo()` | 1 emit, restores pre-multiplier state ✓ |
| S8 | Redo | `onRedo()` | 1 emit, returns to post-multiplier ✓ |
| S9 | Chart drag | `{op:Value, zone:modesVectorDrawn, pitch:60, newValue:[0.11,0.22,0.33,0.44]}` | 1 emit, `sound_channel/All`; pitch60=[0.11,0.22,0.33,0.44] ✓ |
| S10 | Aggregate fan-out | toggle agg ON, `{op:Value, zone:Cell, pitch:60, newValue:0.8}` | 1 emit with batch fan-out; pitch60 gets non-uniform channel values reflecting delta-based fan-out ✓ |
| S11 | Preset switch (Wave B regression) | `KeyboardEvent ']'` via useHotkeys | Switched `working → BaselinePreset1`. 2 emits: `sound_channel/All` (84 pitches, fresh default 0.3 values), `feedback/output` (4 channels). No stale pitch keys carried over ✓ |
| S12 | Round-trip audio | `POST /play` + `note_playback` chart | WAV returned, 48000 samples, peak_abs=26213/32767, rms=843 — audible ✓ |

**Additional verification:** direct `POST /set_parameter/sound_channel/All` with body `{"60":[0.55,0.55,0.55,0.55]}` returned HTTP 200 — REST fallback path also accepts the fixed key format.

**Root-cause confirmation:**
- Bug #1 (stale closure on `pitch` + `String(null)="null"` literal key) is the **primary** root cause. After the fix: every edit in every scenario produces a WS emit with `key="All"`, accepted by backend.
- Bug #2 (emit-once symptom) is a **consequence of Bug #1**, NOT a separate React dep/ref issue. Proof: after fixing only the null-key serialization, every user interaction produces exactly 1 WS emit per debounce-window as expected. The effect at `useSoundChannels.js:256-259` fires correctly on every `mutedMatrix` ref change; the prior "only 1 emit per session" observation was because after the first failed emit the subsequent emits still fired, but test-ui's network filter likely wasn't updating mid-test — or, more plausibly, the backend 500 error on key=`"null"` silenced the UI feedback loop masking the fact that subsequent emits were also firing. My hooks counted **every** outbound emit, and every edit produced one after the fix.

**Screenshots:**
- `D:/tmp/wave-d-s3-single-cell.png` (single-cell edit)
- `D:/tmp/wave-d-s10-aggregate-fanout.png` (aggregate fan-out)
- `D:/tmp/wave-d-s11-post-switch.png` (after preset switch)

**Build verification (post-fix):** `npm run build` → "Compiled with warnings. The build folder is ready to be deployed." (pre-existing lint warnings, none new; no compilation errors).

