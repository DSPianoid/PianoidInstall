# Excitation API Mismatch — PianoidBasic vs PianoidCore

**Status:** Blocking. PianoidBasic update pending.

## Summary

`loadPresetToLibrary()` in PianoidCore (C++) rejects the excitation data produced by
PianoidBasic (`StringMap.pack_excitations()`) because the two sides now expect different formats.
Initialization fails with a size mismatch, and the GPU kernel crashes immediately after.

## Failing Tests

| Test | Error |
|------|-------|
| `tests/system/test_playback.py::TestOnlinePlayback::test_chord_playback` | `RuntimeError: CUDA device synchronization failed after main kernel` |
| `tests/integration/test_excitation_interpolation.py::TestExcitationUpdate::test_excitation_update_changes_output` | `RuntimeError: Failed to allocate GPU Working copy: an illegal memory access was encountered` |
| `tests/integration/test_excitation_interpolation.py::TestExcitationUpdate::test_velocity_sensitivity` | Same (cascade from previous fixture failure) |

## Root Cause

### PianoidCore side (new API)

Commit `58cfae4` ("refactor: unify excitation path, remove setNewExcitationParameters") unified
the excitation upload path to use only **5 base levels** per string, interpolated to 128 on the
C++ host side by `interpolateBaseLevels()`. The new `loadPresetToLibrary()` signature validates
the incoming excitation array size:

```
Expected: NUM_BASE_LEVELS × LEN_LEVEL_GP × num_strings = 5 × 20 × 224 = 22 400 elements
```

The old `setNewExcitationParameters()` (which accepted 128-level data) was removed entirely.

### PianoidBasic side (old format)

`StringMap.pack_excitations()` (the only excitation packing method) calls
`pitch.pack_excitation()` for each pitch, returning the **full 128-level matrix**:

```
Actual: NUM_LEVELS × LEN_LEVEL_GP × num_strings = 128 × 20 × 224 = 573 440 elements
```

`StringMap.pack_base_excitations()` — the method the middleware calls to produce
5-base-level data — **does not exist** in PianoidBasic v0.1.13. The building blocks
are present (`StringExcitation.get_base_levels_matrix()`, `NUM_BASE_LEVELS = 5`) but
`StringMap` has no method that aggregates them.

### Error chain

```
init_pianoid()
  └─ sm.pack_parameters()          → gauss_params = 573 440 elements (old format)
       └─ pianoid.loadPresetToLibrary(..., gauss_params, ...)
            └─ C++: size check fails → RuntimeError: "Excitation base levels size mismatch: 573440 != 22400"
                 └─ GPU memory left in bad state
                      └─ addKernel crashes → cudaError 700 (illegal memory access)
```

## Fix Required

Add `StringMap.pack_base_excitations()` to PianoidBasic that aggregates
`pitch.excitation.get_base_levels_matrix()` across all pitches in `pitch_index` order,
returning a flat list of `NUM_BASE_LEVELS × LEN_LEVEL_GP × num_strings` elements.

Also update `parameter_manager.py` `update_pitch_excitation()` which calls
`self.sm.pack_base_excitations()` at runtime (same missing method, same error path).

## Affected Files

| File | Repo | Change needed |
|------|------|---------------|
| `Pianoid/StringMap.py` | PianoidBasic | Add `pack_base_excitations()` |
| `pianoid_middleware/pianoid.py` | PianoidCore | `init_pianoid()` passes `gauss_params` — will work once StringMap fixed |
| `pianoid_middleware/parameter_manager.py` | PianoidCore | `update_pitch_excitation()` calls `pack_base_excitations()` — will work once StringMap fixed |
