# Second Derivative Sound Output — Investigation Report

## Feature Summary

Configurable sound derivative order (1st or 2nd) for `listen_to_modes=False` (strings) mode. When set to 2nd derivative, the bridge displacement output is differentiated once more, producing an acceleration-based signal with brighter timbre (high-frequency emphasis).

**Branch:** `feature/second-derivative-sound-channel` in PianoidCore

---

## Architecture

### Parameter Flow

```
Frontend (ObjectInspector.jsx)
  → useSettings.js: sound_derivative_order (1 or 2)
  → POST /load_preset: { sound_derivative_order: N }
  → backendServer.py: init_kwargs['sound_derivative_order']
  → pianoid.py: initialize() → Pianoid(sound_derivative_order=N)
  → ModelParams.sound_derivative_order → pack_as_dict_for_cuda()
  → C++ InitializationParameters.sound_derivative_order
  → Pianoid.init_params_.sound_derivative_order
```

### Audio Output Path (strings mode)

In `MainKernel.cu`, the `outerSoundChannel` block outputs bridge displacement for strings with `pitch >= 128` (sound output channel strings):

```
y[n]   = feedback                      (mode→string feedback sum at stem)
y[n-1] = s_b                           (previous displacement, persisted in string_state)
v[n]   = y[n] - y[n-1]                 (1st derivative — velocity)
a[n]   = v[n] - v[n-1] = y[n] - 2·y[n-1] + y[n-2]  (2nd derivative — acceleration)
```

The kernel outputs `v[n]` to `soundFloat`. For 2nd derivative, an additional differentiation is needed.

---

## What Works

| Component | Status |
|-----------|--------|
| Parameter flow (frontend → C++ init_params) | Verified correct |
| PianoidBasic `ModelParams.pack_as_dict_for_cuda()` includes `sound_derivative_order` | Working (required reinstall of PianoidBasic — was the source of initial "no effect" bug) |
| Kernel 1st derivative output (`feedback - s_b`) | Clean, no boundary artifacts (boundary/mid ratio = 1.04x) |
| Python `np.diff()` on recorded 1st derivative | Clean 2nd derivative (0.93-0.97x boundary ratio), sounds correct |
| Frontend UI dropdown (ObjectInspector "Sound Derivative" select) | Working |

---

## The Bug: C++ In-Place Post-Processing Distortion

### Symptom

When `sound_derivative_order == 2`, the C++ post-processing in `playSoundSamples()` modifies `rawSoundBuffer` in-place after `appendRawSound()`. The resulting 2nd derivative signal has **2.0-2.5x larger jumps at 64-sample cycle boundaries** compared to mid-cycle, causing audible distortion (buzzy/harsh timbre).

The Python `np.diff()` on the same underlying data produces a clean signal with no boundary artifacts.

### C++ Post-Processing Code

Location: `Pianoid.cu`, inside `playSoundSamples()`, after `appendRawSound("dev_soundFloat")`:

```cpp
if (init_params_.sound_derivative_order == 2 && rawSoundWritePos > 0) {
    const int nc = init_params_.num_channels;        // 4
    const int spc = init_params_.mode_iteration;      // 64
    const size_t chunkSize = spc * nc;                // 256
    const size_t chunkStart = (rawSoundWritePos - chunkSize) % rawSoundCapacity;
    for (int ch = 0; ch < nc; ch++) {
        for (int s = 0; s < spc; s++) {
            size_t idx = (chunkStart + ch * spc + s) % rawSoundCapacity;
            float cur = rawSoundBuffer[idx];
            float diff = cur - sound_prev_sample_[ch];
            sound_prev_sample_[ch] = cur;
            rawSoundBuffer[idx] = diff;
        }
    }
}
```

Raw buffer layout per cycle: `[ch0 × 64 samples, ch1 × 64 samples, ch2 × 64 samples, ch3 × 64 samples]` (channel-major, matching `dev_soundFloat` GPU layout).

### What Was Ruled Out

| Hypothesis | Test | Result |
|------------|------|--------|
| C++ diff math is wrong | Python simulation of identical chunk-by-chunk logic on same data | **Identical** (max diff = 0.00, boundary ratio = 0.93x) |
| Kernel-level 2nd derivative (register `prev_diff`, global memory `sound_prev_diff`, `y[n]-2y[n-1]+y[n-2]`) | Multiple implementations | All produce 2.5x boundary artifacts |
| `cycle_parameters[12]` changes kernel behavior | Removed packing entirely, kernel binary identical for both orders | Still 2.48x with C++ post-processing |
| `soundDerivativeOrder` variable in kernel affects register pressure | Removed variable declaration | No change |
| Buffer wrapping | Tested with 3-second recording (576k < 960k capacity) | Still 2.01x |
| `sound_prev_sample_` not reset between runs | `clearRecords()` fills with zeros | Confirmed in source, but boundary ratio ACCUMULATES across runs (2x → 18x → 35x), suggesting reset may not be effective at runtime |
| GPU non-determinism between runs | 5 identical `order=1` runs with Python diff | All consistently 0.93x |
| Float precision mismatch | `real = float` confirmed, no double/float mixing | N/A |

### Key Finding

The **underlying 1st derivative data is different** when the C++ post-processing is active. Verified by:
1. Running with `order=2` (C++ post-processing active)
2. Recovering the 1st derivative via `cumsum` of the post-processed buffer
3. Measuring boundary ratio of the recovered signal: **2.06x** (should be ~1.0x)

This means the C++ post-processing corrupts the `rawSoundBuffer` in a way that even undoing the diff doesn't recover clean data. The in-place modification during the playback loop interferes with the buffer's integrity.

### Most Likely Root Cause

The C++ post-processing modifies `rawSoundBuffer` in-place **during** the offline playback loop, while other code may also access the buffer. Possible interference points:

1. **`appendRawSound()`** writes to `rawSoundBuffer` at `rawSoundWritePos`. Post-processing then modifies the just-written chunk. If `rawSoundWritePos` accounting is off by even one cycle, the post-processing reads from an already-modified region.

2. **`clearRecords()`** resets `sound_prev_sample_` but the escalating boundary ratio (2x → 18x → 35x across consecutive `runOfflinePlayback` calls) suggests the reset is not effective, or another accumulation mechanism exists.

3. **Buffer read during playback** — `getCurrentCycleAudio()` reads from `dev_soundFloat` (GPU), not `rawSoundBuffer`, so should not interfere. But other code paths need verification.

---

## Attempted Kernel-Level Approaches

All kernel-level approaches produce the same 2.5x boundary artifact:

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

All produce identical 2.5x boundary ratio. The 1st derivative (`feedback - s_b`) is clean (1.04x) because `string_state` persistence works correctly. The additional differentiation step amplifies a tiny cycle-boundary discontinuity in the `feedback` signal.

---

## Files Modified (current state on branch)

| File | Change |
|------|--------|
| `PianoidCore/pianoid_cuda/MainKernel.cu` | Kernel always outputs 1st derivative; `soundDerivativeOrder` and `sound_prev_diff` param removed |
| `PianoidCore/pianoid_cuda/MainKernel.cuh` | `sound_prev_diff` param removed from declaration |
| `PianoidCore/pianoid_cuda/Pianoid.cuh` | Added `sound_prev_sample_` vector, `dev_sound_prev_diff` pointer, `sound_derivative_order` to `InitializationParameters` |
| `PianoidCore/pianoid_cuda/Pianoid.cu` | C++ post-processing in `playSoundSamples()`, `clearRecords()` resets, buffer registration |
| `PianoidCore/pianoid_cuda/AddArraysWithCUDA.cpp` | pybind for `sound_derivative_order` |
| `PianoidCore/pianoid_middleware/pianoid.py` | Passes `sound_derivative_order` through init chain |
| `PianoidCore/pianoid_middleware/backendServer.py` | Reads `sound_derivative_order` from frontend request |
| `PianoidBasic/Pianoid/ModelParams.py` | Field + `pack_as_dict_for_cuda()` |
| `PianoidTunner/src/hooks/useSettings.js` | Default value + migration |
| `PianoidTunner/src/components/ObjectInspector.jsx` | "Sound Derivative" dropdown (1st/2nd) |
| `PianoidCore/tests/system/test_derivative_comparison.py` | Comparison test |

---

## Next Steps

1. **Debug the C++ in-place post-processing** — add logging/assertions to verify:
   - `rawSoundWritePos` value before/after `appendRawSound` and post-processing
   - Whether `sound_prev_sample_` is actually zero after `clearRecords()`
   - Whether any other code path modifies `rawSoundBuffer` during offline playback

2. **Alternative: post-process in `getRawSoundRecord()`** instead of in-place during playback. Apply the diff when the buffer is read (after all data is written), eliminating any interference with the write path.

3. **For real-time audio output:** the audio driver reads from `soundInt` (pushed via `pushSamples`), not from `rawSoundBuffer`. A separate mechanism is needed to apply the derivative to the audio driver path — either kernel-level (has boundary artifacts) or a CPU-side diff on `soundInt` data before pushing to the driver.
