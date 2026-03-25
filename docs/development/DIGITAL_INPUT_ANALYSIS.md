# Digital Input Component — Bidirectional Data Flow Analysis

## Problem Statement

The digital input components (primarily `NumInput`) work correctly in sandbox mode (frontend-only, no backend), but fail when connected to the live backend with bidirectional data flow. This document traces the root causes and records fixes applied.

---

## Components in Scope

| Component | File | Role |
|-----------|------|------|
| **NumInput** | `src/components/NumInput/NumInput.js` | Primary numeric editor (~1500 lines), deferred-commit pattern |
| **PropertyInput** | `src/components/PropertyInput.jsx` | Slider + number input, reactive pattern |
| **Strings** | `src/components/Strings.jsx` | String parameter grid, consumes NumInput |
| **usePreset** | `src/hooks/usePreset.js` | Data layer — optimistic updates + debounced API calls |

---

## Issues Found and Fixed

### Fix 1: Duplicate useEffect (Critical) — DONE

Two `useEffect` hooks watched the same deps `[value, isExponential, internalDecPlaces]`. The first unconditionally reset `isEditing=false`, destroying the guard that prevented external prop updates from overwriting in-progress edits. Merged into a single effect that respects `isEditing`.

### Fix 2: Stale Closure in Debounced Callbacks — DONE

All `isUpdating*` state flags in `usePreset.js` were captured from first render inside debounced functions stored in refs. Converted all 10 flags to `useRef` so closures always read current values.

### Fix 3: onBlur Behavior — DONE (kept as discard)

Commit-on-blur was attempted but exposed a pre-existing race condition: `Strings.handleValueChange` drops the parameter key, so the parent uses `selectedParameter` from React state. When blur fires after clicking another cell, `selectedParameter` has already changed, causing cross-parameter contamination. Reverted to safe discard-on-blur.

**Prerequisite for commit-on-blur:** The parent (`PianoidTuner.handleValueChange`) must accept a parameter-key override so the value is routed to the correct parameter regardless of selection state.

### Fix 4: PropertyInput Local State Buffer — DONE

Added `useState` + `useRef(isDragging)` local buffer. The slider uses `localValue` that only syncs from the parent `value` prop when not actively dragging, preventing jitter from parent re-renders.

### Fix 5: Read-Back After POST — DONE

`changeParametersOfStrings` now reads back the first updated pitch after all POSTs complete, logging any divergence between the optimistic value and what the backend actually applied.

### Fix 6: Exponential Step Calculation — DONE

`getStepFromCursorPosition()` was gated on `isExponential` state being `true`. But values like `3.1963e-14` display in exponential format via `forceExp` (auto-detect for `< 1e-6`), not from `isExponential` state (which defaults to `false`). The step function skipped its mantissa-aware math and fell through to the decimal calculator, producing a step of `~0.0001` for a value of `3e-14`. Fixed by checking the display string for "e"/"E" instead of the state flag.

### Fix 7: Number.EPSILON Comparison — DONE

The exponential equivalence check used `Math.abs(a - b) < Number.EPSILON`, which is wrong for very small numbers (e.g., `3e-14` vs `5e-14` are both "equal" to EPSILON). Replaced with relative comparison `absDiff / magnitude < 1e-10`.

---

## Open Issue: Cursor Position Drift During Rapid Changes

**Status:** Partially mitigated, not fully resolved.

### Problem

When arrow keys or scroll wheel are used rapidly on any NumInput field (decimal or exponential), the cursor drifts to the end of the input. For exponential fields, this causes the cursor to land in the exponent part, so subsequent steps change the exponent instead of the intended mantissa digit.

### Root Cause

React's controlled input pattern: when `setDisplayValue(newString)` triggers a re-render, React sets `input.value = newString` on the DOM element, which causes the browser to reset the cursor to end-of-string. Each arrow press triggers **two** render cycles — one from local state (`setDisplayValue`) and one from the parent re-rendering after `onChange`. The second render resets the cursor after any restoration from the first.

### Mitigations Applied

1. **`pendingCursorRef`** — A persistent ref set by arrow/wheel handlers with the desired cursor position. A `useLayoutEffect` (synchronous, post-DOM) restores the cursor on every render while the ref is set.
2. **`updateDisplayValue` guard** — When `pendingCursorRef` is active, skips the `preserveCursorPosition` setTimeout chain that would overwrite the position from a competing render.
3. **Deliberate clear** — `pendingCursorRef` is cleared only on user-initiated actions: typing, clicking, blur, Enter, Escape.

These mitigations reduce drift significantly but do not fully eliminate it under rapid input. The fundamental issue is that React's reconciliation can produce more render cycles than the `useLayoutEffect` can keep up with during sustained rapid key repeat.

### Potential Full Solutions (not yet implemented)

| Approach | Trade-off |
|----------|-----------|
| **Uncontrolled input** — Use `defaultValue` + `ref` instead of `value` prop, sync on commit only | Eliminates cursor reset entirely; requires rewrite of display sync logic |
| **Debounce onChange** — Delay parent notification during stepping, commit on pause | Reduces render cycles; undo history lags behind display |
| **requestAnimationFrame loop** — Continuously restore cursor while stepping is active | Robust but adds per-frame overhead |
| **onKeyDown rate limiting** — Ignore arrow repeats faster than render cycle | Limits max step rate but guarantees stability |

---

## Architecture Notes

### NumInput State Machine

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

### Data Flow: User → Engine

```
NumInput (Enter/Apply)
  → onChange(value)
    → Strings.handleValueChange(key, value) → drops key, passes only value
      → PianoidTuner.handleValueChange(value) → uses selectedParameter from state
        → stringsHistory.applyChange(changeInfo)
          → usePreset.changeParametersOfStrings(pitches, paramName, values)
            → setParametersOfStrings(optimistic)
            → debounced POST /set_parameter/string/{pitch}
```

### Why Sandbox Works But Connected Fails

In sandbox mode: no backend → `value` prop only changes on user commit → effects never fire mid-edit → no concurrent responses → no parent re-renders during stepping.

Connected mode: backend responses, health polls, and sibling state changes cause external prop mutations that trigger effects and re-renders during active editing.
