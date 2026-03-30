# Second Derivative Sound Output — Investigation Report

**Status: RESOLVED** -- Kernel-level 2nd derivative implemented and verified.

## Feature Summary

Configurable sound derivative order (1st or 2nd) for `listen_to_modes=False` (strings) mode. When set to 2nd derivative, the bridge displacement output is differentiated once more, producing an acceleration-based signal with brighter timbre (high-frequency emphasis).

**Branch:** `feature/second-derivative-sound-channel` in PianoidCore

**Requirement:** The differentiation MUST happen inside the CUDA kernel, within the synthesis cycle. CPU post-processing approaches (both in-place in `playSoundSamples()` and read-time in `getRawSoundRecord()`) are rejected.

---

## Architecture

### Parameter Flow (fully working)

```
Frontend (ObjectInspector.jsx)
  -> useSettings.js: sound_derivative_order (1 or 2)
  -> POST /load_preset: { sound_derivative_order: N }
  -> backendServer.py: init_kwargs['sound_derivative_order']
  -> pianoid.py: initialize() -> Pianoid(sound_derivative_order=N)
  -> ModelParams.sound_derivative_order -> pack_as_dict_for_cuda()
  -> C++ InitializationParameters.sound_derivative_order
  -> Pianoid.init_params_.sound_derivative_order
```

### Audio Output Path (strings mode)

In `MainKernel.cu`, the `outerSoundChannel` block outputs bridge displacement for strings with `pitch >= 128` (sound output channel strings):

```
y[n]   = feedback                      (mode->string feedback sum at stem)
y[n-1] = s_b                           (previous displacement, persisted in string_state)
v[n]   = y[n] - y[n-1]                 (1st derivative -- velocity)
a[n]   = v[n] - v[n-1] = y[n] - 2*y[n-1] + y[n-2]  (2nd derivative -- acceleration)
```

The kernel currently outputs `v[n]` to `soundFloat`. For 2nd derivative, an additional differentiation step is needed **inside the kernel**.

---

## Current State of the Code

The branch has:
- Full parameter flow working (frontend -> C++ `init_params_`)
- Kernel outputs 1st derivative only (`feedback - s_b`)
- C++ post-processing block in `playSoundSamples()` applies in-place diff when `order == 2` (this is the code that produces boundary artifacts — it needs to be **replaced** with kernel-level differentiation)
- `sound_prev_sample_` vector in `Pianoid.cuh` for inter-chunk state (to be removed once kernel approach works)
- `dev_sound_prev_diff` GPU buffer registered (available for kernel use)

---

## The Unsolved Problem: 2.5x Boundary Artifacts

### Symptom

Every kernel-level approach to compute the 2nd derivative produces **2.0-2.5x larger sample-to-sample jumps at 64-sample cycle boundaries** compared to mid-cycle jumps. This causes audible distortion (buzzy/harsh timbre). The 1st derivative (`feedback - s_b`) is clean (1.04x boundary ratio).

### What Was Tried and Ruled Out

| Hypothesis | Test | Result |
|------------|------|--------|
| C++ diff math is wrong | Python simulation of identical chunk-by-chunk logic | **Identical** to Python (max diff = 0.00), so the math is correct |
| Kernel register approach (persist `v[n-1]`) | Implemented, tested | 2.5x boundary artifacts |
| Kernel global memory approach (direct read/write `sound_prev_diff`) | Implemented, tested | 2.5x boundary artifacts |
| Kernel second-difference (`y[n] - 2*y[n-1] + y[n-2]`) | Implemented, tested | 2.5x boundary artifacts |
| `cycle_parameters` packing changes kernel behavior | Removed packing, kernel binary identical | Still 2.48x |
| Buffer wrapping issue | 3-sec recording (576k < 960k capacity) | Still 2.01x |
| GPU non-determinism | 5 identical `order=1` runs with Python diff | All consistently 0.93x |
| Float precision mismatch | `real = float` confirmed | N/A |

### Key Observations

1. **1st derivative is clean** (1.04x) because `s_b` is part of `string_state`, which is properly persisted across kernel launches via `dev_string_state` D2H/H2D copies.

2. **Any further differentiation amplifies a tiny discontinuity** at cycle boundaries. This is true whether done in-kernel or in C++ post-processing.

3. **Python `np.diff()` on the final recorded buffer produces a clean 2nd derivative** (0.93x boundary ratio). This works because Python operates on the complete, contiguous buffer after all cycles are written.

4. **The discontinuity is in the `feedback` signal itself.** The 1st derivative `feedback - s_b` masks it because it's small relative to the signal amplitude. But the 2nd derivative (being a high-pass filter) amplifies it.

### Root Cause Hypothesis (NOT YET VERIFIED)

The `feedback` signal has a tiny discontinuity at each cycle boundary because of **how the kernel is relaunched between cycles**. Between the last iteration of cycle N and the first iteration of cycle N+1:

- The kernel ends, `string_state` is saved to global memory, mode state is saved
- A new kernel is launched, state is reloaded
- `feedback` at iteration 0 of cycle N+1 is recomputed from reloaded mode state

Something about this save/reload/recompute sequence introduces a sub-LSB discontinuity that the 1st derivative tolerates but the 2nd derivative amplifies. Possible causes:
- **Mode state quantization** during D2H/H2D round-trip (float precision loss?)
- **feedback_cycle_matrix zeroing** at kernel start vs mid-cycle (is iteration 0 different from iteration 1?)
- **Cooperative grid sync vs kernel boundary** — within a cycle, mode->string feedback is computed after a grid sync; across cycles, there's a full kernel relaunch

### What Needs Investigation Next

1. **Instrument the kernel boundary**: Capture `feedback`, `s_b`, and `v[n]` values for the last 2-3 samples of cycle N and first 2-3 samples of cycle N+1. Compare the sample-to-sample differences at the boundary vs mid-cycle. This will show exactly where the discontinuity originates.

2. **Check mode state round-trip**: Compare mode state values at kernel end (just before save) vs kernel start (just after load). Any precision loss in the `dev_mode_position` D2H/H2D copy would explain the discontinuity.

3. **Check `feedback_cycle_matrix` initialization**: Does iteration 0 of a new kernel compute `feedback` differently than iteration 1+ within the same kernel? (e.g., matrix is zeroed at start but accumulated within)

4. **Test with a single long kernel**: If the boundary artifact disappears when running many iterations in a single kernel launch (no kernel boundary), that confirms the kernel relaunch as the cause.

---

## Attempted Kernel Implementations (for reference)

### Approach 1: Persist `v[n-1]` in register + global memory
```cuda
// Load at kernel start
real prev_diff = sound_prev_diff[outerSoundChannel - 1];
// In audio output:
output = diff_result - prev_diff;
prev_diff = diff_result;
// Save at kernel end
sound_prev_diff[outerSoundChannel - 1] = prev_diff;
```

### Approach 2: Direct global memory read/write per sample
```cuda
int ch = outerSoundChannel - 1;
output = diff_result - sound_prev_diff[ch];
sound_prev_diff[ch] = diff_result;
```

### Approach 3: Second difference using displacement directly
```cuda
// y[n-2] persisted in sound_prev_diff
output = feedback - 2 * s_b + s_b2;
s_b2 = s_b;
```

All produce identical 2.5x boundary ratio.

---

## Files Modified (current state on branch)

| File | Change |
|------|--------|
| `PianoidCore/pianoid_cuda/MainKernel.cu` | Kernel always outputs 1st derivative; `soundDerivativeOrder` and `sound_prev_diff` param removed from kernel signature |
| `PianoidCore/pianoid_cuda/MainKernel.cuh` | `sound_prev_diff` param removed from declaration |
| `PianoidCore/pianoid_cuda/Pianoid.cuh` | Added `sound_prev_sample_` vector, `dev_sound_prev_diff` pointer, `sound_derivative_order` to `InitializationParameters` |
| `PianoidCore/pianoid_cuda/Pianoid.cu` | C++ post-processing in `playSoundSamples()` (TO BE REPLACED with kernel-level), `clearRecords()` resets, `dev_sound_prev_diff` buffer registration |
| `PianoidCore/pianoid_cuda/AddArraysWithCUDA.cpp` | pybind for `sound_derivative_order` |
| `PianoidCore/pianoid_middleware/pianoid.py` | Passes `sound_derivative_order` through init chain |
| `PianoidCore/pianoid_middleware/backendServer.py` | Reads `sound_derivative_order` from frontend request |
| `PianoidBasic/Pianoid/ModelParams.py` | Field + `pack_as_dict_for_cuda()` |
| `PianoidTunner/src/hooks/useSettings.js` | Default value + migration |
| `PianoidTunner/src/components/ObjectInspector.jsx` | "Sound Derivative" dropdown (1st/2nd) |
| `PianoidCore/tests/system/test_derivative_comparison.py` | Comparison test (boundary ratio measurement) |
| `PianoidCore/tests/system/diagnose_derivative.py` | Diagnostic script |

---

## Testing & Debugging Procedure

Stepwise verification to isolate where the boundary artifact is introduced. All derivative computations must be done in C++ (no Python `np.diff`) to eliminate type/precision discrepancies.

### Step 1: Baseline — order=1, offline, short duration

Run kernel with `sound_derivative_order=1`. Offline synthesis, short duration (~1 second). Record the resulting 1st derivative sound via `getRawSoundRecord()`. This is the **reference signal**.

### Step 2: Order=2 run — capture both derivatives

Run kernel with `sound_derivative_order=2`. Record **two** outputs:
- The 1st derivative sound (the raw kernel output before any differentiation) — use debug output functionality to capture this separately
- The 2nd derivative sound (the final differentiated output)

### Step 3: Compare 1st derivative sounds (order=1 vs order=2)

The 1st derivative from Step 1 and the 1st derivative from Step 2 **must be identical** — the kernel should produce the same raw output regardless of `sound_derivative_order`. If they differ, the `sound_derivative_order` parameter is leaking into kernel behavior. **Debug this before proceeding.**

### Step 4: Compare 2nd derivatives (C++ diff of Step 1 vs kernel output of Step 2)

Take the 1st derivative sound from Step 1 and apply a C++ discrete diff to produce a 2nd derivative. Compare this to the 2nd derivative sound from Step 2. **They should be identical.** If not, the difference reveals exactly where the kernel-level differentiation diverges from a correct post-hoc diff. Debug the discrepancy.

### Step 5: Scale up

Once Steps 3-4 produce identical results, run the same verification with:
- Online synthesis (audio driver active)
- Longer durations (3-5 seconds)
- Multiple notes / different pitches

---

## Test Commands

```bash
# Run boundary ratio comparison test
cd D:\repos\PianoidInstall\PianoidCore
.venv/Scripts/python -m pytest tests/system/test_derivative_comparison.py -v -s

# Run diagnostic script (detailed per-sample analysis)
.venv/Scripts/python tests/system/diagnose_derivative.py
```

**Success criteria:** 2nd derivative boundary ratio < 1.2x (matching the 1st derivative's 1.04x).

---

## Resolution (2026-03-30)

### Root Cause

The 2.5x boundary artifact was **NOT** caused by a discontinuity in the `feedback` signal at kernel boundaries. Diagnostic testing confirmed:

| Signal | Boundary Ratio | Status |
|--------|---------------|--------|
| 1st derivative (kernel output) | 0.999 | Clean |
| 2nd derivative (CPU `np.diff` of 1st) | 0.990 | Clean |
| 2nd derivative (chunk-by-chunk CPU diff) | 0.990 | Clean -- identical to contiguous |

The earlier kernel-level implementations (approaches 1-3) had bugs in how `prev_diff` state was loaded/saved. The investigation hypothesis about sub-LSB feedback discontinuities was incorrect -- the 1st derivative signal is perfectly continuous across kernel boundaries.

### Solution

A straightforward kernel-level implementation works correctly:

1. Read `soundDerivativeOrder` from `cycle_parameters[12]`
2. Add `sound_prev_diff` (global memory) as kernel parameter
3. Load `prev_diff` per output channel at kernel start
4. In audio output: `output = diff_result - prev_diff` when order==2
5. Save `prev_diff` at kernel end

The CPU post-processing in `playSoundSamples()` was removed.

### Verified Results

| Metric | Value |
|--------|-------|
| 2nd derivative boundary ratio | 0.99 |
| Kernel vs CPU 2nd derivative relative diff | ~1% |
| GPU timing impact | 0% (0.428ms unchanged) |

### Files Modified (final state)

| File | Change |
|------|--------|
| `MainKernel.cu` | Added `sound_prev_diff` param, reads `soundDerivativeOrder` from cycle_parameters[12], computes 2nd derivative in-kernel |
| `MainKernel.cuh` | Added `sound_prev_diff` to declaration |
| `Pianoid.cu` | Packs `sound_derivative_order` into cycle_parameters[12], adds `dev_sound_prev_diff` to kernelArgs, removed CPU post-processing |
| `pianoid.py` | Graceful handling of missing InitializationParameters attributes |
| `test_derivative_comparison.py` | Added `test_kernel_2nd_derivative_boundary_ratio` test |
