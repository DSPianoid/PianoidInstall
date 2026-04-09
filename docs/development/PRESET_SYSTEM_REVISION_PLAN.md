# Preset System Revision — Per-Preset Runtime State & Complete Switch

## Problem Statement

The preset switching system has several gaps that break the user experience when working with multiple presets in the GPU library:

1. **Volume and feedback are global** — switching from loud preset A to quiet preset B and back loses A's volume/feedback settings
2. **Available notes not refreshed** after switch — presets with different note ranges show stale keyboard
3. **Frontend MIDI feedback slider position lost** — backend stores the coefficient but can't reconstruct the MIDI slider position accurately (lossy reverse mapping)
4. **No concurrency guard on switchPreset()** — rapid `[`/`]` key presses can interleave requests
5. **Frontend state refresh is incomplete** — some parameters are not re-fetched after switch

## Current Architecture Analysis

### What Already Works Per-Preset (GPU Library)

The GPU preset library (`loadPresetToLibrary` / `switchPreset` / `saveActiveToLibrary`) correctly stores and switches:

| Parameter Category | Storage | Switch Behavior |
|---|---|---|
| String physics (16 per string) | GPU double-buffered preset block | Swapped atomically via pointer swap |
| Hammer shape | GPU preset block | Swapped with preset |
| Excitation (gauss curves) | GPU preset block | Swapped with preset |
| Mode parameters (dec, omega, mass) | GPU preset block | Swapped with preset |
| Deck coupling (feedin/feedback matrices) | GPU preset block + Python `_library_models` | Swapped + repacked from Python |
| Sound channel coefficients | Python `_library_models[name]['sm']` | Swapped with Python model |

### What Is NOT Per-Preset (Global Runtime State)

| Parameter | Current Storage | Problem |
|---|---|---|
| Volume level (0-127 MIDI) | `RuntimeParameters.volume_level` (GPU scalar) | Persists across preset switches — not saved/restored |
| Feedback coefficient | `RuntimeParameters.deck_feedback_coefficient` (GPU scalar) | Persists across preset switches — not saved/restored |
| Volume sensitivity (center/range) | `RuntimeParameters.volume_center/range` | Global, arguably should stay global |
| Feedback sensitivity (center/range) | Frontend ref only | Global, stays global |

### Backend Switch Flow (Current)

```
pianoid.switch_preset(name):
  1. cuda_lock:
     - saveActiveToLibrary()          # saves current GPU working buffer to old preset slot
     - switchPreset(name, async)      # loads target preset into GPU working buffer
  2. Swap Python: self.sm = _library_models[name]['sm'], self.modes = ...
  3. Rebuild ParameterManager refs
  4. send_deck_params_to_CUDA()       # repack deck from new Python model
  --- Volume/feedback: UNTOUCHED ---
```

### Frontend Switch Flow (Current)

```
usePreset.switchPreset(name):
  1. POST /preset/switch {name}
  2. setActivePreset(name)
  3. Re-fetch: strings, modes, excitation, feedin, feedback, sound channels
  --- Missing: getAvailableNotes() ---
  --- Missing: volume/feedback from response ---
```

### Key Files

| File | Lines | Role |
|---|---|---|
| `PianoidCore/pianoid_middleware/pianoid.py` | 2136-2168 | `switch_preset()`, `load_preset_to_library()` |
| `PianoidCore/pianoid_middleware/pianoid.py` | 1741-1758 | `init_pianoid()` — `_library_models` initialization |
| `PianoidCore/pianoid_middleware/pianoid.py` | 533-654 | Volume/feedback get/set API |
| `PianoidCore/pianoid_middleware/backendServer.py` | 344-357 | `/preset/switch` endpoint |
| `PianoidCore/pianoid_middleware/backendServer.py` | 543-740 | `/set_runtime_parameters` endpoint |
| `PianoidTunner/src/hooks/usePreset.js` | 173-191 | `switchPreset()` frontend |
| `PianoidTunner/src/hooks/usePreset.js` | 1226-1316 | Volume/feedback state + send functions |
| `PianoidTunner/src/hooks/useHotkeys.js` | 92-105 | `[`/`]` preset cycling |

---

## Design: Backend-Authoritative Per-Preset Runtime State

### Architecture Decision

Backend is the single source of truth. Each `_library_models[name]` entry gets a `runtime` dict alongside `sm`, `modes`, `mp`. The `/preset/switch` response returns the target preset's runtime values; the frontend updates its display state from the response.

Why backend-authoritative:
- RuntimeParameters live on the GPU, controlled through the C++ `pianoidCuda` binding
- Backend already has `get_volume_level()`, `get_deck_feedback_coefficient()` getters
- No risk of frontend/backend state divergence
- Frontend remains a display/control layer

### Runtime State Schema

```python
_library_models[preset_name]['runtime'] = {
    'volume_level': int,               # 0-127 MIDI range
    'deck_feedback_coefficient': float, # mapped coefficient (0.0-1000)
    'volume_center': float,            # sensitivity center (0 = legacy)
    'volume_range': float,             # sensitivity range
    'feedback_midi': int,              # raw 0-127 slider position (avoids lossy reverse mapping)
}
```

The `feedback_midi` field is critical: the frontend sends a MIDI value (e.g. 80), the backend maps it via exponential formula to a coefficient (e.g. 2.83). Without storing the original MIDI value, we can't restore the slider position accurately.

---

## Implementation Steps

### Step 1: Backend — Add `runtime` to `_library_models` entries

**File:** `pianoid.py`

**1a. `init_pianoid()` (line ~1741)** — Add `runtime` dict with defaults to the "working" entry and the reference copy:

```python
self._library_models = {
    "working": {
        'sm': self.sm, 'modes': self.modes, 'mp': self.mp,
        'runtime': {
            'volume_level': 64,
            'deck_feedback_coefficient': 1.0,
            'volume_center': 0,
            'volume_range': 6,
            'feedback_midi': 64,
        }
    }
}
```

Same `runtime` dict for the reference copy at line ~1754.

**1b. `load_preset_to_library()` (line ~2133)** — New presets inherit current volume, default feedback:

```python
self._library_models[preset_name] = {
    'sm': sm, 'modes': modes, 'mp': mp,
    'runtime': {
        'volume_level': self.get_volume_level(),
        'deck_feedback_coefficient': 1.0,
        'volume_center': 0,
        'volume_range': 6,
        'feedback_midi': 64,
    }
}
```

### Step 2: Backend — Save/restore runtime in `switch_preset()`

**File:** `pianoid.py`, lines 2136-2168

Rewrite to:
1. Snapshot current `getRuntimeParameters()` + `feedback_midi` into `_library_models[old_preset]['runtime']`
2. Perform GPU switch (existing logic)
3. Swap Python model (existing logic)
4. Restore `setRuntimeParameters()` from `_library_models[new_preset]['runtime']`
5. Repack deck (existing logic)

### Step 3: Backend — Add helper methods

**File:** `pianoid.py`

- `get_preset_runtime_state(preset_name=None)` — Returns `runtime` dict for given (or active) preset
- `update_active_preset_runtime(updates)` — Syncs volume/feedback changes to active preset's `runtime`

### Step 4: Backend — Enrich `/preset/switch` response

**File:** `backendServer.py`, lines 344-357

After `switch_preset()`, include runtime state in response:

```json
{
    "message": "Switched to Steinway",
    "active": "Steinway",
    "volume": 64,
    "feedback_midi": 64,
    "feedback_coefficient": 1.0,
    "volume_center": 0,
    "volume_range": 6
}
```

### Step 5: Backend — Sync `/set_runtime_parameters` to library

**File:** `backendServer.py`, lines 542-740

At end of handler, after `updated` dict is built, sync to active preset's library entry:
- `volume` in updated → `runtime['volume_level']`
- `feedback` in updated → `runtime['deck_feedback_coefficient']` + `runtime['feedback_midi']`
- `volume_center`/`volume_range` in updated → `runtime[...]`

### Step 6: Frontend — Rewrite `switchPreset()`

**File:** `usePreset.js`, lines 173-191

- Add `switchingRef` concurrency guard (mirrors `loadingRef` pattern)
- Set `isBusy` during switch
- Read `volume`, `feedback_midi`, sensitivity from response → update state
- Add missing `getAvailableNotes()` call

### Step 7: Frontend — No changes to volume/feedback handlers

`changeVolume()` and `changeFeedback()` already send to `/set_runtime_parameters` which (after Step 5) syncs to library. No changes needed.

---

## End-to-End Data Flow (After Revision)

```
User presses ] → cyclePreset(1) → switchPreset("B")
  |
  v
Frontend: POST /preset/switch {name: "B"}
  |
  v
Backend switch_preset("B"):
  1. old = getActivePreset() → "A"
  2. rp = getRuntimeParameters() → {volume_level:100, deck_feedback:2.83, ...}
  3. _library_models["A"]["runtime"] ← {volume_level:100, feedback_midi:80, ...}
  4. saveActiveToLibrary()       → GPU saves A's physics/modes/excitation
  5. switchPreset("B")           → GPU loads B's physics/modes/excitation
  6. Swap Python sm/modes to B's
  7. rt = _library_models["B"]["runtime"] → {volume_level:64, feedback_midi:64, ...}
  8. setRuntimeParameters(rt)    → GPU now has B's volume/feedback
  9. send_deck_params_to_CUDA()  → Deck repacked from B's Python model
  |
  v
Response: {active:"B", volume:64, feedback_midi:64, feedback_coefficient:1.0, ...}
  |
  v
Frontend:
  - setVolume(64), setFeedback(64), update sensitivity refs
  - getAvailableNotes()         → piano keyboard updates
  - getParametersOfStrings()    → string panel updates
  - getParametersOfModes()      → mode panel updates
  - getParametersOfExcitation() → excitation panel updates
  - getFeedInMatrix()           → feedin matrix updates
  - getFeedbackMatrix()         → feedback matrix updates
  - getSoundChannelData()       → sound channel editor updates
```

---

## Edge Cases

| Case | Expected Behavior |
|---|---|
| **First load** | `init_pianoid` sets `runtime` with defaults (vol=64, fb=64) for "working" and reference presets |
| **Load new preset to library** | Inherits current volume level; feedback starts at unity (1.0 / MIDI 64) |
| **Unload preset** | `_library_models.pop()` removes runtime data — no special handling needed |
| **Save preset to disk** | Does NOT include runtime state (per requirement: in-memory only unless explicitly instructed) |
| **Page refresh** | All in-memory state lost — acceptable per requirement. Backend restart rebuilds defaults |
| **Rapid `[`/`]` presses** | `switchingRef` concurrency guard skips interleaved requests |
| **Volume change during switch** | `cuda_lock` serializes; debounced volume API call waits for switch to complete |
| **Preset with different note range** | `getAvailableNotes()` now called after switch — keyboard updates |

---

## Verification Checklist

1. Load two presets to library
2. Set vol=100 on A → switch to B → verify vol=64 (default) → switch back to A → verify vol=100
3. Same test with feedback — MIDI slider position (not just coefficient) preserved
4. Press `[`/`]` rapidly 20 times — no crashes, no 500 errors, no interleaved state
5. Switch between presets with different note ranges — piano keyboard updates correctly
6. Edit string parameters on A → switch to B → switch back → A's edits preserved
7. Volume/feedback sliders in UI reflect correct values immediately after each switch
8. Edit feedback on A to 90, switch to B, adjust B's feedback to 30, switch back to A — shows 90, not 30
