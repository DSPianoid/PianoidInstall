# Dev Session Log

- **Agent:** dev-sc-tooltip-rowcol
- **Task:** Fix two bugs in Sound Channels panel after Wave D extraction: (1) tooltip shows `value: null` instead of cell value, (2) row/column bulk-edit across modes broken.
- **Started:** 2026-04-21T08:38:49Z
- **Plan file:** None (follow-up to Wave D multitask)
- **Status:** In Progress

## Actions

### Step 0: Initialize — 08:38
- Generated AGENT_ID=dev-sc-tooltip-rowcol (task-semantic ID per orchestrator brief; reused throughout session)
- Checked MODULE_LOCKS.md — empty, no conflicts
- Checked WORK_IN_PROGRESS.md — stale entry for dev-sc-cell-edit-fix (its log is archived; Wave D was already wrapped up)
- Will replace stale WIP entry with this session's row
- Logs directory is empty except archive/ and .gitkeep
- Servers reported running on 5000/3001/3000 per orchestrator; will verify in Step 1b

### Step 1: Docs & Diagnosis — 09:15
- Docs-first: read `docs/modules/pianoid-tunner/OVERVIEW.md` (useSoundChannels, Wave A/B/D notes).
- Read source: `SoundChannelsPane.jsx`, `useSoundChannels.js`, `PitchesModesMatrixCanvas.jsx`, `MeasuredMatrix.jsx`, `useMatrixHistory.js`, `MatrixTools.jsx`, plus `usePreset.js` SC + `availableOutputChanels` paths.
- Confirmed both reported bugs reproduce in browser (strings axis, matrixRowIsPiano=true, BaselinePreset1):
  - Tooltip hover at channel=1, mode=50 renders `Pitch: 1, Mode: 50, Value: null`.
  - `availableOutputChanels = [0,1,2,3]` (frontend subtracts 128 at usePreset.js:569), but strings matrix from `/get_parameter/feedback/output` has keys `["128","129","130","131"]`.
  - Canvas builds `newPitch = pianoRange[0] + colIndex` in the shifted [0..3] range. `matrixObject[newPitch]` returns undefined → tooltip shows null.
  - Same mismatch breaks `calcChange`'s pitch-zone guard (`useMatrixHistory.js:62-66`) — `change.pitch = 1` is not `in newMatrix` (keys are "128"..), so Cell/modesVector/modesVectorDrawn are silently no-op'd. Row/col bulk edit is broken for the same reason. Cell edit is also broken in strings axis — Wave D only verified the modes-axis pitch-key path.

### Root Cause
Data-format mismatch at the boundary between `usePreset.getAvailableNotes` (subtracts 128 from output-channel pitches → `availableOutputChanels = [0..N-1]`) and `soundChannelFeedbackMatrix` (raw backend keys `"128".."128+N-1"`). The strings-axis matrix was never normalized to align with `availableOutputChanels`, so every consumer that indexes by frontend channel index (canvas, history, workbench at PianoidTuner.js:796) hits a wrong-key lookup.

Classification: pre-existing bug latent since the shifted output-channel convention was introduced in `getAvailableNotes`. Wave A/B/D didn't cause it (the extraction moved, not reshaped, the data). Wave D verified cell edit on the modes axis where the convention DOES align (pitch keys match `availableNotes`).

### Fix Plan (P1 Authority, P2 Concern)
- **Owner of strings-axis matrix normalization:** `useSoundChannels` — it already owns the two histories and the init/emit effects. Strip `128` on init (to `"0".."N-1"`), re-apply on emit (to `"128".."128+N-1"`). Pure, self-contained, axis-scoped.
- Canvas, history, MeasuredMatrix, workbench stay oblivious. No callers change.
- Modes axis untouched (its keys already match availableNotes).

### Files Modified
- `PianoidTunner/src/hooks/useSoundChannels.js` — strip+restore 128 offset around `scStringsHistory` init/emit (+36 LOC).
- `docs/modules/pianoid-tunner/OVERVIEW.md` — documented the normalization.
- `docs/development/WORK_IN_PROGRESS.md` — entry under Preset System Revision cluster.

### Step 4: Lock & Edit — 09:15
- Locked `PianoidTunner/src/hooks/useSoundChannels.js` in `MODULE_LOCKS.md`.
- Added `normalizeStringsKeys` / `denormalizeStringsKeys` (pure functions, axis-scoped) alongside existing `extractArrayMap`.
- Strings-axis init effect: `normalizeStringsKeys(extractArrayMap(soundChannelFeedbackMatrix))` — strips 128 offset from numeric keys, non-numeric keys pass through.
- Strings-axis commit effect: `changeSoundChannelFeedback(denormalizeStringsKeys(scStringsHistory.mutedMatrix), null)` — restores 128 offset before network payload; non-numeric keys (none in practice) pass through.
- Modes axis untouched — pitch keys already align with `availableNotes`.
- P1: `useSoundChannels` is the sole writer of both `scModesHistory` and `scStringsHistory`; it is the natural owner of the strings-axis key convention translation. No other module writes these.
- P2: helpers isolated to this hook; canvas/MatrixHistory/MeasuredMatrix/Workbench remain oblivious to the backend key convention. Concern remains "history + emit/init, axis-aware".
- C4: file grew from 339 → 375 LOC, still well under 500 YELLOW threshold.

### Step 5: Verification via /test-ui equivalent — 09:50
No rebuild needed (frontend-only, CRA hot-reload). After page reload + APPLY preset in Strings axis:

**Bug 1 — tooltip:** hover at channel 1, mode ~70 now renders `Pitch: 1, Mode: 70, Value: 3270.787376` (screenshot captured). Previously rendered `Value: null`.

**Bug 2 — row bulk edit (Row zone, `pitchesVector`, fills one mode column across all channels):**
- Before edit: `mode 20 across channels` = `[200, 600, 200, 200]`
- After synthetic click at channel=2, mode=20 with input=600
- After edit: `mode 20 across channels` = `[600, 600, 600, 600]`
All 4 channels updated — full fan-out through `calcChange.pitchesVector` branch.

**Bug 2 — column bulk edit (Column zone, `modesVector`, fills entire row for one channel):**
- Before edit: `channel 1 samples at modes [0, 50, 70]` = `[600, 1437.36, 3270.79]`
- After synthetic click at channel=1, mode=70 with input=600 (pre-filled at 600 from stale input)
- After edit: `channel 1 samples at modes [0, 50, 70]` = `[600, 600, 600]`
Entire row filled — `.fill(change.newValue)` path hit.

**Regression check — modes axis:** after switching Listen Mode back to Modes and re-applying preset, hover at pitch 64, mode 2 renders `Pitch: 64, Mode: 2, Value: 0.3`; matrix keys are still pitch strings `"23".."106"`. No regression; modes axis path is not touched by the fix.

### Step 6: Debug — Undo Crash — 10:30

**Symptom:** User hit `TypeError: Cannot read properties of undefined (reading 'operation')` in `restoreMatrixAtStep` when clicking Undo during real-UI testing. Not a regression from the strings-axis fix — pre-existing latent bug that the normalization fix exposed by enabling edits that previously no-op'd silently. User-reported flow was "undo after a few edits"; the trigger is a burst of closely-spaced clicks.

**Root cause:** Stale closure in `recordChange` (useMatrixHistory.js:52-55). The original implementation:
```js
const recordChange = (change) => {
  setHistory((prev) => [...prev.slice(0, currentStep), change]);  // currentStep from closure
  setCurrentStep((prev) => prev + 1);
};
```
When multiple clicks fire in the same React batch, every call reads the same captured `currentStep` value. `setHistory`'s functional updater slices at that stale `currentStep`, so for N rapid calls the history gains only 1 entry (last one wins via slice+append on each) while `setCurrentStep` correctly advances by N via its functional updater. Result: `currentStep > history.length`, and a later `restoreMatrixAtStep(currentStep - 1)` reads `history[i]` past the end → undefined → crash on `.operation`.

Reproduced with synthetic 5-burst in one tick: `step=7, len=3` (initial step=2, len=2 → expected +5 on both, got +5 step, +1 len). Calling onUndo: `Cannot read properties of undefined (reading 'operation')`.

**Fix (useMatrixHistory.js, +14 LOC net):**
- Added `stepRef = useRef(0)` — synchronous mirror of `currentStep`, the single source of truth for the slice boundary during a burst.
- `init()`: sets `stepRef.current = 1` alongside `setCurrentStep(1)`.
- `recordChange()`: reads `sliceAt = stepRef.current`, bumps `stepRef.current` before dispatching setState. `setHistory((prev) => [...prev.slice(0, sliceAt), change])` now slices at the correct boundary per-call; `setCurrentStep(stepRef.current)` keeps state in sync with the ref.
- `restoreMatrixAtStep()`: sets `stepRef.current = target` alongside `setCurrentStep(target)`. Also clamps `target = Math.min(step, history.length)` and adds `if (!entry) continue;` in the replay loop — belt-and-suspenders so a future desync can't crash.
- `undo()` / `redo()`: read `stepRef.current` instead of `currentStep` state so they see the latest value between renders.
- `useEffect` mirrors state→ref in case an external caller writes `currentStep` directly (none today; future-proofing).

**P1 Authority:** `useMatrixHistory` owns the `{history, currentStep}` invariant. The bug was P1 violation in the original code — the invariant "slice-at-step then increment-step atomically" depended on closure capture which React batching could not guarantee. The ref re-establishes single-writer ownership over a synchronous channel (not React-batched).

**P2 Concern:** Fix stays inside the hook. API unchanged — all callers (MatrixTools, MeasuredMatrix, Strings, Mode, Excitation) read `history` + `historyStep` as opaque values; nothing downstream needs to know about the ref.

**Verification (Modes axis, BaselinePreset1):**
- Burst 5 clicks in one tick: before step=2/len=2 → after step=7/len=7 (both advance by 5). Was 7/3 before the fix.
- Undo 6x: step 7→6→5→4→3→2→1, len=7 preserved. Zero errors.
- Redo 6x: step 1→2→3→4→5→6→7. Zero errors.
- Truncation: undo 3x to step=4, then new edit → step=5, len=5 (history[4..6] correctly dropped). Zero errors.

**Verification (Strings axis, BaselinePreset1):**
- Matrix keys still normalized to `["0","1","2","3"]` (Bug 1 fix intact).
- Burst 5 clicks: step 1→6, len 1→6. Perfect sync.
- Undo 4x: step 6→5→4→3→2, len preserved. Zero errors.

### Additional Files Modified
- `PianoidTunner/src/hooks/useMatrixHistory.js` — stepRef pattern for stale-closure fix + defensive guards (+14 LOC net).

### Pre-Step-10 Status (updated)
All 3 bugs fixed and verified. Locks held on `useSoundChannels.js` + `useMatrixHistory.js`. Servers still running. Not committed. Awaiting user real-UI verification for all three (tooltip, row/col bulk edit, undo).
