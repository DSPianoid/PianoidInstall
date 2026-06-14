# CPU Synthesis for No-CUDA Mode — Deferred Follow-up (stub)

- **Status:** DEFERRED / future work — NOT implemented. Stub for scoping.
- **Date:** 2026-06-10
- **Author:** dev-cudaguard
- **Parent work:** the no-CUDA graceful mode (dev-cudaguard, user-approved "Opt C") — see the
  shipped backend gate + `/health gpu_available` + frontend APPLY-disable + launcher limited-mode
  warning. That work blocks **all** GPU-synthesis preset loads when no CUDA device is available.

## Why this is deferred

The user's no-CUDA spec says preset-loading should be gated **"except for the cpu-simulation
option."** The clarified meaning (user, authoritative): **"CPU simulation" = real CPU-based Pianoid
synthesis that lives in PianoidBasic** (it exists, and may be broken) — NOT the Modal Adapter /
synthetic-dataset path.

As of this work, there is **no working "play a preset on CPU" path** wired into the backend:
- `use_simulation=1` -> `pianoid_cuda_placeholder.py` is a **non-functional mock** (rejected with
  HTTP 400; no FDTD synthesis; API out of sync with the live engine). It is NOT the PianoidBasic
  CPU synth the user refers to.
- The synthesis backend (`backendServer.py` -> `pianoid.py` -> `pianoidCuda`) requires a CUDA
  device (`devMemoryInit`); it has no CPU branch.

So the no-CUDA mode currently **disables all GPU presets** (the honest, shippable behaviour). The
"except cpu-sim" path is this deferred feature: surface PianoidBasic's CPU synthesis as a loadable
"cpu-sim" option that the no-CUDA gate ALLOWS while still blocking GPU presets.

## Scope to investigate when picked up (NOT done here)

1. **Locate + assess the PianoidBasic CPU synthesis** the user means — what module/entry point, what
   it produces (audio? a render?), and whether it currently runs (the user says it may be broken).
2. **Define the "cpu-sim option"** concretely — a dedicated preset? an init flag (e.g. a real,
   non-mock `use_cpu_sim`)? a separate code path in `load_preset_route`?
3. **Wire it through the no-CUDA gate:** when `gpu_available` is false, ALLOW a cpu-sim load
   (bypass the 503) while still blocking GPU presets. Update the frontend (APPLY enabled for the
   cpu-sim option only; the "No CUDA" chip messaging) and the launcher wording accordingly.
4. **Build type:** likely PianoidBasic (Python) + middleware (Python) — assess whether any CUDA/C++
   is involved (probably not, if it's a pure-Python CPU path). Confirm before scoping.

## What already exists to build on

- Backend: `_gpu_available()` (cached CuPy probe) + the `load_preset_route` gate (returns 503
  `gpu_unavailable` before `destroyPianoid()`); `/health gpu_available`. The cpu-sim allowance hooks
  in right at that gate.
- Frontend: `useBackendHealth.gpuAvailable`, the APPLY guard in `PianoidTuner.ensureBackendAndLoadPreset`,
  and the `BackendStatusIndicator` "No CUDA" chip.
- Launcher: `check-cuda.ps1` limited-mode warning + `diagnose-cuda.ps1`.

## Status

Awaiting a future /dev task + user definition of the cpu-sim option. Do NOT implement without the
user's spec for what "CPU simulation" should do (inspect-only vs real CPU audio) and which
PianoidBasic entry point it maps to.
