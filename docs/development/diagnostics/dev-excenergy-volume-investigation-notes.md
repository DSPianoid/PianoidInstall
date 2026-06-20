# dev-excenergy — Volume-slider investigation notes (2026-06-17)

**Outcome:** NON-REPRODUCIBLE. User reported "volume slider doesn't work" on the calibrated
build (energy c=2.2e-05), then later reported it WORKS and could not reproduce. No code change
made (correctly did not guess-fix). Notes kept for future reference.

## What was measured (all audio_off, no speaker emission)

### 1. UI slider → backend (chrome-devtools, live :3000 → :5000, Belarus loaded)
- Real bottom-bar Volume slider (MuiSlider 0–127). Driving its real onChange (native-setter +
  input/change) updates React value correctly.
- NETWORK (instrumented fetch+XHR over 3 rapid changes 40/95/120): exactly ONE debounced
  `POST /set_runtime_parameters {"volume":120}` → 200 (correct value, correct debounce).
- No console errors on drag. Connected to 127.0.0.1:5000. → FE wiring is CORRECT.

### 2. Engine ACTUAL output vs volume (production sint extractor — engine applies mvc, not my arithmetic)
Belarus_196modesC, pitch 60, vel 127, max_volume=100, R=2^31=2.147e9:
| volume | get_current_volume_coefficient | sint PEAK | dBFS | sint RMS |
|---|---|---|---|---|
| 20 | 2.065 | 3.11e8 | -16.8 | 6.98e7 |
| 64 | 10.183 | 1.53e9 | -2.9 | 3.44e8 |
| 120 | 77.583 | 2.147e9 (RAIL) | 0.0 | 1.53e9 |
- PEAK scales 6.9× across the range → the engine DOES apply the runtime volume coefficient to
  output. "Engine ignores mvc" hypothesis RULED OUT by measurement.
- The one real characteristic: output PEAK clips at the INT32 rail above slider ~64 (because the
  energy calibration put slider-64 at -2.9 dBFS). RMS keeps rising above 64 (more energy) but the
  PEAK rails → above 64 the slider adds clip/distortion rather than clean loudness. This is NOT
  the reported bug (user couldn't reproduce "doesn't work"), just a headroom characteristic.

### 3. Realtime path vs offline (code inspection)
- mvc applied IN-KERNEL: MainKernel.cu `soundInt = output * main_volume_coefficient` (:543 string
  tap / :678 mode tap); kernel reads `*main_volume_coeff` every cycle (:153).
- Realtime: runCycle(Online) → pushCycleAudioToDriver (Pianoid_synthesis.cu): FIR OFF →
  outputData = dev_soundInt (the same post-mvc buffer the offline sint extractor reads); FIR ON →
  FIR(dev_soundInt) back into dev_soundInt. → pushSamples → circular buffer.
- ASIO callback (ASIOAudioDriver.cpp:181) just `audioBuffer.consume()` — NO volume scaling in the
  callback. → realtime == offline for volume; no separate realtime path drops mvc.

## ★ DEFERRED OPTION (ready if the user ever wants more clean upward headroom)
FE-only volume-curve re-center via the existing `volume_center`/`volume_range` sensitivity formula
(`mvc = center · range^((level-64)/63)`), so the whole slider sits below the rail and is monotonic:
target slider-127 ≈ -3 dBFS, slider-64 ≈ -12 dBFS (for THIS preset/raw level ~1.5e8: center≈3.6,
range≈2.8 — re-measure to confirm exact values). Change site: PianoidTunner usePreset.js
`VOLUME_CENTER_DEFAULT` / `VOLUME_RANGE_DEFAULT`. No backend/wheel rebuild. NOT requested — deferred.

## ★ Methodology lesson (recorded)
First diagnosis multiplied raw_output × mvc MYSELF and called it the output — that assumes the
conclusion. Corrected by measuring the engine's ACTUAL sint output (it applies mvc itself). When a
fix depends on "does X scale the output," MEASURE the real output buffer; never reconstruct it with
your own arithmetic.
