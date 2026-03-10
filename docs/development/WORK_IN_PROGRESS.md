# Work in Progress

## Parameter Routing Unification

**Status:** Complete.

All parameter modifications now route through `ParameterManager`. Dead code removed (`TunePreset.py`, `playPianoid.py`, `playNotes.py`, `update_physical_parameters()`). Broken `pitch_wheel` MIDI handler fixed. `/set_mode_parameters` and MIDI deck handlers routed through dispatcher/facade.

---

## Parameter Update Sleep Removal

**Status:** Future refactoring.

`parameter_manager.py` has `time.sleep(0.01)` after every bulk `setNew*Parameters()` call (hammer, mode, deck, excitation). The sleeps are a crude workaround for the `DROP_IF_BUSY` async policy — without them, consecutive updates can be silently dropped because `cudaMemcpyAsync` returns before the double-buffer swap completes.

All UI-driven parameter routes (REST endpoints, MIDI handlers) are designed to work during online playback. The bulk `setNew*` methods and their sleep workarounds may be obsolete — the granular `updateMultiStringParameter_NEW()` path (used by `update_pitch_params()`) already handles this correctly with explicit `waitForParameterUpdate()`.

**Refactoring options:**
- Replace sleeps with `waitForParameterUpdate()` calls
- Migrate all paths to the granular API
- Remove bulk methods if no longer needed

---

## Buffer Underrun Investigation

**Status:** Diagnostic tests implemented. Root cause identified. Fix not yet applied.

### Problem

With SDL3 audio enabled, ~12% of synthesis cycles show buffer phase times exceeding the 1.333ms real-time budget, causing audible underruns — despite GPU computation using only ~36% of the budget (mean 0.48ms).

### Root Cause

In `CircularBuffer.cu:105`, `produce()` releases its mutex **before** `cudaMemcpy`:

```
lock.unlock()           ← mutex released
cudaMemcpy(...)         ← ~0.5-1.3ms unprotected
cudaDeviceSynchronize()
write_position.store()  ← data visible only here
```

The SDL3 callback's `consume()` reads `write_position` atomically. During the `cudaMemcpy` window, the consumer sees stale `write_position` → empty buffer → underrun.

### Diagnostic Tests (done)

`TestBufferSynchronization` in `test_performance.py` instruments the issue:

- **test_buffer_underrun_diagnosis** — Proves GPU is fast while underruns occur. Prints per-phase timing breakdown and automatic root cause diagnosis.
- **test_callback_timing_regularity** — Measures SDL3 callback interval, jitter, and chunk coverage. Shows SDL3 batches ~7 chunks per callback at ~10ms intervals.

### Remaining Work

| Task | Status |
|------|--------|
| Diagnostic tests | Done |
| Root cause analysis | Done |
| Fix `produce()` lock scope in CircularBuffer.cu | Pending |
| Integration tests (test_cuda_bridge, test_offline_playback, etc.) | Planned |
| Unit tests (test_string_block, test_model_parameters, etc.) | Planned |

### Testing Plan Overview

The full 3-level testing system is being built top-down:

| Level | Directory | Scope | Status |
|-------|-----------|-------|--------|
| System | `tests/system/` | Full stack + audio hardware | 7 tests passing |
| Integration | `tests/integration/` | GPU, no audio | Planned |
| Unit | `tests/unit/` | Pure Python | Planned |

See [Testing](TESTING.md) for the implemented test inventory and usage.
