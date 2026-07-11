# dev-scr1 — Synthesis cooperative-kernel `grid==0` startup race

**Date:** 2026-07-11
**Severity:** Blocking (process hard-crash on a fresh `dev`-checkout backend under test-harness launch)
**Status:** OPEN — kernel-owner item (dev-538e). Excluded from the sound-channel-calibration merge (`PianoidCore` dev `94a43b0`) by operator decision.

## Symptom

An idle backend built from a fresh `PianoidCore` `dev` checkout crashes the process
(exit `3221225477` = `0xC0000005`, access violation) shortly after preset load /
on the first resume of synthesis. No calibration, no note played — the crash fires
on an IDLE load. The CUDA error text originates in
`PianoidCore/logs/pianoid_runtime.log`.

## CUDA error (root cause chain)

```
cudaLaunchCooperativeKernel FAILED (grid=0, block=0x32): invalid configuration argument
...
error code 700: illegal memory access was encountered
CUDA device synchronization failed after main kernel
```

## Root cause

`PianoidCore/pianoid_cuda/Pianoid_synthesis.cu:408` launches the synthesis
cooperative kernel with the grid dimension taken from
`init_params_.num_string_arrays()`:

```cpp
cudaError_t coopLaunchErr = cudaLaunchCooperativeKernel(
    (void*)addKernel, init_params_.num_string_arrays(), blockSize,
    kernelArgs.data(), 0, synthesis_stream_);
```

On the FIRST realtime cycle this value is **0** — the realtime playback thread runs
cycle 0 *before* the string arrays are committed. A `grid=0` cooperative launch is an
invalid configuration, which poisons the CUDA context. The failure then cascades:

1. `cudaLaunchCooperativeKernel FAILED (grid=0, block=0x32): invalid configuration argument`
   — the launch at `Pianoid_synthesis.cu:408`.
2. The CUDA context is poisoned → a follow-on `error code 700: illegal memory access`.
   (A subsequent `grid=56` code-700 may be an **independent** out-of-bounds access
   that a `grid==0` guard alone would not fix — see Open questions.)
3. `Pianoid_synthesis.cu:474` throws `"CUDA device synchronization failed after main
   kernel"` → the synthesis thread dies.
4. When `exit_calibration_mode` (or any resume) restarts synthesis, the poisoned
   context **hard-crashes the process** (`0xC0000005`).

## Evidence / scope (verified)

- Fires on IDLE load with **zero** calibration — independent of the sound-channel
  calibration feature (whose ASIO code is inert at idle).
- Reproduces on **both** `BaselinePreset1` and the default
  `Belarus_196modesC_Fanera6exc`.
- Hardware is a clean RTX 4090 (128 SMs, 0% utilisation, ~1177 MiB) — **not** GPU
  contention. The `grid=56` value is `num_string_arrays`, **not** an SM count.
- **Not** caused by a missing amp-guard: the dev-538e amp-guard is merged to `dev`
  (`16f7eb4`) and verified in-build — it does not fix this.
- **Not** a `.pyd` divergence on the calibration branch.
- Does **not** fire on the operator's normal installed `.pyd` — a build/timing
  difference means the race isn't hit there, which is why the operator's live stack
  runs fine. It **does** bite a fresh `dev`-checkout backend under test-harness
  launch timing.
- CUDA error text source: `PianoidCore/logs/pianoid_runtime.log`.

## Suggested fix (SUGGESTION for the kernel owner — do NOT implement here)

dev-538e holds `MainKernel.cu` / the synthesis kernels; this is their call.

1. **Guard the launch** at `Pianoid_synthesis.cu:408` — skip the cooperative kernel
   launch when `init_params_.num_string_arrays() == 0` (never launch a 0-block
   kernel), and/or
2. **Fix load ordering** so the string arrays commit before the first realtime cycle
   runs.
3. **Re-check** the follow-on `grid=56` code-700 after the guard lands — it may be a
   separate OOB and would not be resolved by a `grid==0` guard alone.

## Open questions

- Is the `grid=56` code-700 a pure downstream symptom of the poisoned context, or an
  independent out-of-bounds access? Confirm after the `grid==0` guard is in place.

## Owner / status

Open; kernel-owner item (**dev-538e**). Excluded from the sound-channel-calibration
merge (`PianoidCore` dev `94a43b0`) by operator decision — the operator tests on
their own stack, where the race does not trigger.
