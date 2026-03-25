# Digital Input Component — Bidirectional Data Flow Analysis

## Problem Statement

The digital input components (primarily `NumInput`) work correctly in sandbox mode (frontend-only, no backend), but fail when connected to the live backend with bidirectional data flow. This document traces the root causes through the full pipeline.

---

## Components in Scope

| Component | File | Role |
|-----------|------|------|
| **NumInput** | `src/components/NumInput/NumInput.js` | Primary numeric editor (~1500 lines), deferred-commit pattern |
| **PropertyInput** | `src/components/PropertyInput.jsx` | Slider + number input, reactive pattern |
| **Strings** | `src/components/Strings.jsx` | String parameter grid, consumes NumInput |
| **ParameterEditor** | `src/components/ParameterEditor.jsx` | Generic parameter panel, consumes NumInput |
| **usePreset** | `src/hooks/usePreset.js` | Data layer — optimistic updates + debounced API calls |

---

## Data Flow Architecture

### Forward Path (User → Engine)

```
NumInput (Enter/Apply)
  → onChange(value)
    → Strings.handleValueChange(key, value)
      → usePreset.changeParametersOfStrings(pitches, paramName, values)
        → setParametersOfStrings(optimistic)          // immediate state update
        → debounced (300ms):
            POST /set_parameter/string/{pitch}        // Flask backend
              → pianoid.update_parameter()             // middleware
                → pianoidCuda.setNewPhysicalParameters // GPU
```

### Reverse Path (Engine → User)

Parameter values are **only fetched on preset load** — there is no live polling, WebSocket push, or read-back after a `set_parameter` POST. The frontend relies entirely on its own optimistic state as the source of truth after loading.

### NumInput Internal State Machine

```
                      ┌─────────────────────────┐
                      │    IDLE (not editing)    │
                      │  displayValue = f(prop)  │
                      └────────┬────────────────┘
                               │ user types
                               ▼
                      ┌─────────────────────────┐
                      │   EDITING (isEditing)    │
                      │  displayValue = user's   │
                      │  onChange NOT called      │
                      └──┬──────────┬───────────┘
                         │          │
                   Enter/Apply    Blur/Escape
                         │          │
                         ▼          ▼
                   onChange(val)   REVERT to prop
                   commit edit    discard edit
```

Key design: `onChange` is **only** called on explicit confirmation (Enter key, Apply button, wheel/arrow). Typing does **not** propagate to the parent.

---

## Critical Issues

### Issue 1: Duplicate `useEffect` — the Primary Bug

**Location:** `NumInput.js` lines 112–162

There are two `useEffect` hooks watching the **same** dependency array `[value, isExponential, internalDecPlaces]`:

```javascript
// Effect A (line 112) — "Initialize display value"
useEffect(() => {
  const formattedValue = formatNumber(value, isExponential, internalDecPlaces);
  updateDisplayValue(formattedValue);
  setPreviousValue(value);
  setIsEditing(false);              // ← UNCONDITIONALLY resets editing flag
}, [value, isExponential, internalDecPlaces]);

// Effect B (line 124) — "Update display value when props change"
useEffect(() => {
  // ... exponential check ...
  if (!isEditing) {                 // ← guard is useless; Effect A already cleared it
    updateDisplayValue(formatNumber(numValue, isExponential, internalDecPlaces));
  }
  setPreviousValue(value);
}, [value, isExponential, internalDecPlaces]);
```

**Why this is invisible in sandbox:** Without a backend, the `value` prop rarely changes externally. The user types, presses Enter, `onChange` fires, the parent updates state, and the prop change arrives when the user is done editing. The race never occurs.

**Why this breaks with the backend:** When the system is connected and parameters flow bidirectionally, any parent re-render that touches the `value` prop triggers both effects. React runs them in declaration order:

1. Effect A fires first → `setIsEditing(false)` + `updateDisplayValue(...)` → **overwrites the user's in-progress edit**
2. Effect B fires second → `isEditing` is now `false` → updates display again → **double overwrite**

**Timeline of failure:**

```
t=0ms    User focuses NumInput, starts typing "123" (isEditing = true)
t=50ms   User has typed "12" — displayValue = "12", isEditing = true
t=100ms  Parent re-renders (health poll, concurrent response, sibling state change)
         value prop unchanged but React re-runs effects
         → Effect A: setIsEditing(false), updateDisplayValue("0.0000") ← OVERWRITES "12"
         → Effect B: isEditing is false, updateDisplayValue("0.0000") ← DOUBLE OVERWRITE
t=150ms  User types "3" — sees "0.00003" instead of "123"
```

This is the primary reason digital input "works in sandbox but fails with the backend connected."

### Issue 2: Stale Closure in Debounced API Callbacks

**Location:** `usePreset.js` lines 603–637

```javascript
const changeParametersOfStrings = useCallback(async (...) => {
  // Optimistic update
  setParametersOfStrings(updatedParameters);

  // Create debounced function ONCE, stored in ref
  if (!debouncedApiCallRef.current) {
    debouncedApiCallRef.current = debounce(
      async (pitchesToSend, updatedParams, paramName) => {
        if (isUpdatingStrings) return;  // ← STALE: captured from first render (always false)
        setIsUpdatingStrings(true);
        // ... POST requests ...
        setIsUpdatingStrings(false);
      }, 300);
  }
  debouncedApiCallRef.current(pitches, updatedParameters, parameterName);
}, [parametersOfStrings, isUpdatingStrings]);
```

The `isUpdatingStrings` guard inside the debounced closure captures the value from the render when the function was first created. Since `debouncedApiCallRef.current` is only set once (`if (!...)`), the guard is permanently stuck at `false` and never prevents concurrent requests.

**Impact:** Rapid edits fire overlapping POST requests. With network latency variation, responses arrive out of order. The last optimistic state may not match the last value the backend actually applied.

### Issue 3: onBlur Silently Discards Edits

**Location:** `NumInput.js` lines 907–926

```javascript
const handleBlur = (e) => {
  if (isEditing) {
    // Revert to the previous value — NO onChange call
    updateDisplayValue(formatNumber(value, isExponential, internalDecPlaces));
    setIsEditing(false);
  }
};
```

If the user types a value and then clicks on another parameter (very common workflow), the edit is **silently reverted** without any visual feedback. In sandbox mode, this is tolerable because there's no latency and users instinctively press Enter. With backend latency and more complex workflows, users frequently click away mid-edit expecting auto-commit.

### Issue 4: PropertyInput Fires onChange on Every Event, No Debounce

**Location:** `PropertyInput.jsx` lines 32, 39

```javascript
<input type="range" value={value}
  onChange={(e) => onChange(Number(e.target.value))} />
<input type="number" value={value}
  onChange={(e) => onChange(Number(e.target.value))} />
```

Every slider pixel and every keystroke immediately calls `onChange`, which triggers `usePreset` methods that queue debounced API calls. If the parent re-renders mid-drag from a concurrent backend response, the `value` prop resets the slider position, causing **visual jitter**.

### Issue 5: No Read-Back After Parameter Push

**Location:** `usePreset.js` — `changeParametersOfStrings` and similar functions

The flow is: optimistic update → debounced POST → done. There is **no** re-fetch of the actual backend value after the POST succeeds. If the backend clamps, rounds, or transforms the value (via `UpdatePolicy` or physical constraints), the frontend displays a value that diverges from the actual engine state.

---

## Symptom-to-Cause Mapping

| Observed Symptom | Root Cause | Issue # |
|------------------|------------|---------|
| Value resets to previous while typing | Duplicate useEffect resets `isEditing` unconditionally | 1 |
| Display shows wrong value after rapid edits | Stale closure never blocks concurrent requests | 2 |
| Edit lost when clicking another parameter | `onBlur` reverts without commit | 3 |
| Slider jumps/jitters during drag | Parent re-render resets `value` prop mid-drag | 4 |
| Frontend value differs from engine state | No read-back after POST; optimistic-only truth | 5 |
| All of the above work fine in sandbox | Sandbox has no external prop changes, no backend latency, no concurrent responses | — |

---

## Why Sandbox Mode Masks These Issues

In sandbox mode:
- **No backend** → `value` prop only changes when the user commits via Enter → Effects A and B never fire mid-edit
- **No latency** → No overlapping requests → Stale closure doesn't matter
- **No concurrent responses** → Parent never re-renders from external data → Slider drag is smooth
- **No clamping** → Optimistic value is always correct → No divergence

The connected pipeline introduces **external prop mutations** (backend responses, health polls, sibling re-renders) that expose all five issues simultaneously.

---

## Proposed Fixes

### Fix 1: Merge Duplicate useEffects (Critical)

Replace both effects with a single effect that respects the editing guard:

```javascript
useEffect(() => {
  if (isEditing) {
    // Only save previousValue during editing, don't touch display
    setPreviousValue(value);
    return;
  }

  // Exponential value equivalence check
  if (displayValue.includes("e") || displayValue.includes("E")) {
    try {
      const displayNumber = Number(displayValue);
      if (!isNaN(displayNumber) && isFinite(displayNumber) &&
          Math.abs(displayNumber - value) < Number.EPSILON) {
        return;
      }
    } catch (error) { /* continue */ }
  }

  const numValue = typeof value === "number" ? value : parseFloat(value);
  if (!isNaN(numValue)) {
    updateDisplayValue(formatNumber(numValue, isExponential, internalDecPlaces));
  }
  setPreviousValue(value);
}, [value, isExponential, internalDecPlaces]);
```

### Fix 2: Use a Ref for the Update Guard

```javascript
const isUpdatingStringsRef = useRef(false);

// Inside debounced callback:
if (isUpdatingStringsRef.current) return;
isUpdatingStringsRef.current = true;
try { /* ... POST ... */ }
finally { isUpdatingStringsRef.current = false; }
```

### Fix 3: Commit on Blur (Optional Behavior)

```javascript
const handleBlur = (e) => {
  if (e.relatedTarget &&
      inputRef.current?.closest(".NumInputContainer")?.contains(e.relatedTarget)) {
    return;
  }
  setIsFocused(false);

  if (isEditing) {
    // Attempt to commit rather than discard
    const numValue = Number(displayValue);
    if (!isNaN(numValue) && isFinite(numValue) &&
        numValue >= minValue && numValue <= maxValue) {
      handleValueChange(numValue);  // commit
    } else {
      updateDisplayValue(formatNumber(value, isExponential, internalDecPlaces));
    }
    setIsEditing(false);
  }
};
```

### Fix 4: Local State Buffer in PropertyInput

```javascript
const PropertyInput = ({ value, onChange, ...props }) => {
  const [localValue, setLocalValue] = useState(value);
  const isDragging = useRef(false);

  useEffect(() => {
    if (!isDragging.current) setLocalValue(value);
  }, [value]);

  const handleChange = (newValue) => {
    setLocalValue(newValue);
    onChange(newValue);
  };

  return (
    <input type="range" value={localValue}
      onMouseDown={() => { isDragging.current = true; }}
      onMouseUp={() => { isDragging.current = false; }}
      onChange={(e) => handleChange(Number(e.target.value))} />
  );
};
```

### Fix 5: Read-Back After POST

```javascript
// After successful POST in debounced callback:
const response = await axios.post(`${PIANOID_URL}/set_parameter/string/${pitch}`, payload);
if (response.data?.actual_value !== undefined) {
  // Backend returned the clamped/actual value
  updatedParams[pitch][paramName] = response.data.actual_value;
}
// After all pitches are sent:
setParametersOfStrings({ ...updatedParams });
```

---

## Priority

| Fix | Severity | Effort | Impact |
|-----|----------|--------|--------|
| 1 — Merge duplicate useEffects | **Critical** | Low | Eliminates the primary edit-overwrite bug |
| 2 — Ref-based update guard | High | Low | Prevents request overlap and state corruption |
| 3 — Commit on blur | Medium | Low | Prevents silent data loss on focus change |
| 4 — PropertyInput local buffer | Medium | Medium | Eliminates slider jitter during drag |
| 5 — Read-back after POST | Low | Medium | Ensures frontend-engine consistency |

Fix 1 alone will resolve the most visible symptom (edits being overwritten). Fixes 2–5 address secondary issues that become apparent once the primary bug is resolved.
