# Feedin Coefficient Loading Bug Fix

**Date:** February 2026
**File:** `pianoid_cuda/MainKernel.cu:234`
**Severity:** Critical - 50% of modes were non-functional

## Problem Description

The feedin algorithm, which transfers force from strings to modes, had an overly restrictive condition that prevented coefficient loading for half of the modes.

### Root Cause

```cpp
// BUGGY CODE (line 234):
if (modeIndexInQuarter[i] < numModes && foldedIndexInQuarter[i] < numModes) {
    mode_feedin[i] = mode_coefficients[...];
}
```

The condition `foldedIndexInQuarter[i] < numModes` (100) was incorrect because:

1. The folding algorithm generates `foldedIndex = indexInQuarter + quarterSize × fold`
2. With `quarterSize = 96` and 3 folds: foldedIndex ranges 0-287
3. The mode index formula requires higher foldedIndex values to reach certain modes:
   - Modes 25-55 require foldedIndex 100-219
   - Modes 81-99 require foldedIndex 101-175

### Impact

- **50 modes** (25-55, 81-99) received **zero** force contributions from strings
- These modes were effectively "dead" - they could not be excited by string vibrations
- This affected 50% of the modal coupling in the synthesis engine

## Solution

Changed the condition from `foldedIndex < numModes` to `foldedIndex < numStrings`:

```cpp
// FIXED CODE (line 234):
// FIX: Changed foldedIndex < numModes to foldedIndex < numStrings
// The old condition blocked 50% of modes (25-55, 81-99) from receiving any string contributions
// because those modes require foldedIndex >= 100 to be reached by the modeIndex formula
if (modeIndexInQuarter[i] < numModes && foldedIndexInQuarter[i] < numStrings) {
    mode_feedin[i] = mode_coefficients[stringNoForQuarter * numModes + modeIndexInQuarter[i]];
}
```

## Verification

| Metric | Before | After |
|--------|--------|-------|
| Modes with full string coverage | 50 | 100 |
| Modes with zero coverage | 50 | 0 |

## Related Issues

This fix is separate from the write bounds check added in commit 8964087, which correctly prevents buffer overflow. That check (`foldedIndex < numStrings` on the write operation) remains valid and necessary.

## See Also

- [FEEDIN_ALGORITHM_ANALYSIS.md](../technical-notes/FEEDIN_ALGORITHM_ANALYSIS.md) - Complete algorithm documentation
