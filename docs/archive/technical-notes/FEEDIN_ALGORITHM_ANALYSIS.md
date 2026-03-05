# Feedin Algorithm: String-to-Mode Force Transfer

## Overview

The feedin algorithm transfers mechanical force from vibrating strings to resonant modes in the Pianoid synthesis engine. This bidirectional modal coupling is the core of the physical modeling approach, where strings excite modes and modes drive string motion through spatial mode shapes.

**Key file:** `pianoid_cuda/MainKernel.cu` (lines 220-247, 557-564)

## Algorithm Purpose

Each synthesis cycle, the algorithm must:
1. **Accumulate force** from ALL 224 strings to ALL 100 modes
2. **Apply coupling coefficients** (mode_feedin) that represent spatial overlap integrals
3. **Sum contributions** efficiently across GPU threads using atomic operations

This requires 224 × 100 = 22,400 force transfer operations per cycle.

## GPU Organization

The algorithm uses a folding pattern to distribute work across the GPU:

| Parameter | Value | Description |
|-----------|-------|-------------|
| `NUM_BLOCKS` | 56 | 224 strings ÷ 4 strings per block |
| `NUM_STRINGS_IN_ARRAY` | 4 | Strings processed per block |
| `QUARTER_SIZE` | 96 | arraySize (384) ÷ 4 |
| `NUM_FOLDS_IN_QUARTER` | 3 | Each thread handles 3 mode contributions |
| `SEGMENT_FOR_SHUFFLE_SUMMATION` | 64 | Stride for write addresses |

## The Folding Pattern

### Index Calculations

```cpp
// For each fold i = 0, 1, 2:
foldedIndexInQuarter[i] = indexInQuarter + quarterSize * i;
// Range: Fold 0 = 0-95, Fold 1 = 96-191, Fold 2 = 192-287

// Mode index calculation
numBlockForTheFold = foldedIndexInQuarter[i] / numStringsInArray;
if (numBlockForTheFold < numArrays) {
    modeIndexInQuarter[i] = (foldedIndexInQuarter[i] % numStringsInArray) * numArrays + numBlockForTheFold;
}
// This spreads modes: foldedIndex 0→mode 0, 1→mode 56, 2→mode 112, 3→mode 168, 4→mode 1, ...
```

### Mode Index Mapping

The formula `modeIndex = (foldedIndex % 4) * 56 + (foldedIndex / 4)` creates a specific pattern:

| foldedIndex % 4 | Base modeIndex | Valid modes (< 100) |
|-----------------|----------------|---------------------|
| 0 | 0 + foldedIndex/4 | 0-24 |
| 1 | 56 + foldedIndex/4 | 56-80 |
| 2 | 112 + foldedIndex/4 | None (all ≥ 100) |
| 3 | 168 + foldedIndex/4 | None (all ≥ 100) |

## Coefficient Loading

### Current Condition (After Fix)

```cpp
// MainKernel.cu:234
if (modeIndexInQuarter[i] < numModes && foldedIndexInQuarter[i] < numStrings) {
    mode_feedin[i] = mode_coefficients[stringNoForQuarter * numModes + modeIndexInQuarter[i]];
}
```

**Result:** All 100 modes receive force from all 224 strings.

### Historical Bug (Before Fix)

```cpp
// OLD - BUGGY:
if (modeIndexInQuarter[i] < numModes && foldedIndexInQuarter[i] < numModes) {
```

The condition `foldedIndex < numModes` (100) was too restrictive:
- **Fold 0** (foldedIndex 0-95): All passed → Modes 0-24, 56-79 covered
- **Fold 1** (foldedIndex 96-191): Only 96-99 passed → Modes 24, 80 added
- **Fold 2** (foldedIndex 192-287): None passed

**Result:** 50 modes were completely dead (received zero string contributions):
- Modes 25-55 (required foldedIndex 100-219)
- Modes 81-99 (required foldedIndex 101-175)

## Force Write Phase

### Write Operation

```cpp
// MainKernel.cu:557-564
for (int i = 0; i < NUM_FOLDS_IN_QUARTER; i++) {
    if (modeIndexInQuarter[i] < numModes && foldedIndexInQuarter[i] < numStrings) {
        int feedin_write_idx = foldedIndexInQuarter[i] * SEGMENT_FOR_SHUFFLE_SUMMATION + blockNo;
        atomicAdd(feedin_cycle_matrix + feedin_write_idx,
                  mode_feedin[i] * force_on_bridge_summed[quarterNumber] / soundStep);
    }
}
```

### Write Address Layout

```
feedin_write_idx = foldedIndex × 64 + blockNo

Buffer layout (feedin_cycle_matrix):
┌─────────────────────────────────────────────────────────────────┐
│ foldedIndex=0: [block0, block1, ..., block55, padding×8]        │ addresses 0-63
│ foldedIndex=1: [block0, block1, ..., block55, padding×8]        │ addresses 64-127
│ ...                                                              │
│ foldedIndex=223: [block0, block1, ..., block55, padding×8]      │ addresses 14272-14335
└─────────────────────────────────────────────────────────────────┘
Buffer size: 64 × 224 = 14,336 elements
```

### Bounds Check Rationale

The condition `foldedIndexInQuarter[i] < numStrings` (224) on the write operation prevents buffer overflow:

- **Without check:** foldedIndex can reach 287, writing to address 287×64+55 = 18,423 (overflow!)
- **With check:** Maximum address is 223×64+55 = 14,327 (within buffer)

When `foldedIndex ≥ 224`, `modeIndex` would be invalid (stays at 0 due to `numBlockForTheFold ≥ numArrays`), but the write condition `modeIndex < 100` would still pass, causing overflow writes of zero values.

## Force Read Phase

### Sum Operation

```cpp
// MainKernel.cu:580
firstModeAddress = blockNo * SEGMENT_FOR_SHUFFLE_SUMMATION * numStringsInArray;
sumArray(&feedin_cycle_matrix[firstModeAddress], SEGMENT_FOR_SHUFFLE_SUMMATION,
         numStringsInArray, s_mode_applied_force, stMdIndex, allThreads);
```

Each block reads 256 consecutive addresses (4 segments × 64) and sums them into `s_mode_applied_force[0..3]`.

## Data Flow Summary

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         FEEDIN ALGORITHM FLOW                            │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  STRING PHYSICS                    COEFFICIENT LOADING                   │
│  ┌─────────────┐                   ┌─────────────────────┐               │
│  │ String      │                   │ mode_coefficients   │               │
│  │ vibration   │──force_on_────────│ [string × mode]     │               │
│  │ at bridge   │  bridge           │                     │               │
│  └─────────────┘                   └──────────┬──────────┘               │
│                                               │                          │
│                                               │ mode_feedin[i]           │
│                                               ▼                          │
│  WRITE PHASE                       ┌─────────────────────┐               │
│  ┌─────────────┐                   │ feedin_cycle_matrix │               │
│  │ atomicAdd   │◄──────────────────│ [foldedIdx × 64 +   │               │
│  │ (all blocks │   mode_feedin ×   │  blockNo]           │               │
│  │  write)     │   force / step    │                     │               │
│  └─────────────┘                   └──────────┬──────────┘               │
│                                               │                          │
│  READ PHASE                                   │                          │
│  ┌─────────────┐                   ┌──────────▼──────────┐               │
│  │ sumArray    │◄──────────────────│ Sum 256 addresses   │               │
│  │ (per block) │                   │ per block           │               │
│  └──────┬──────┘                   └─────────────────────┘               │
│         │                                                                │
│         │ s_mode_applied_force[quarterNumber]                            │
│         ▼                                                                │
│  MODE EVOLUTION                                                          │
│  ┌─────────────────────────────────────────────────────────┐             │
│  │ mode_new = f(mode_current, mode_prev, s_mode_applied_force)          │
│  └─────────────────────────────────────────────────────────┘             │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Bug Fix History

### Issue #1: Buffer Overflow (Commit 8964087, Oct 2025)

**Problem:** Writes with `foldedIndex ≥ 224` caused memory corruption.

**Fix:** Added bounds check `foldedIndexInQuarter[i] < numStrings` to write condition.

**Status:** ✅ Correct fix, prevents overflow of zero-value writes.

### Issue #2: Dead Modes (Found Feb 2026)

**Problem:** Coefficient loading condition `foldedIndex < numModes` blocked 50% of modes.

**Fix:** Changed to `foldedIndex < numStrings` in coefficient loading condition.

**Status:** ✅ Fixed. All 100 modes now receive contributions from all 224 strings.

## Verification

After the fix, the algorithm correctly provides:

| Metric | Before Fix | After Fix |
|--------|------------|-----------|
| Modes with full coverage (224 strings) | 50 | **100** |
| Modes with zero coverage | 50 | **0** |
| Buffer overflow writes | 3,584 | **0** |

## Related Files

- `pianoid_cuda/MainKernel.cu` - Main kernel with feedin algorithm
- `pianoid_cuda/constants.h` - `SEGMENT_FOR_SHUFFLE_SUMMATION`, `NUM_FOLDS_IN_QUARTER`
- `pianoid_cuda/Pianoid.cu` - Buffer allocation for `mode_position` (feedin_cycle_matrix)
