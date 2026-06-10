# Planning Session Log — Register/Memory (Occupancy) Management Framework

- **Agent:** plan-regmem-9f2c
- **Task:** Comprehensive plan for explicit register/memory (occupancy) management — compile-time AND
  runtime GPU-adaptive — with shortage recommendations. PLANNING/DESIGN ONLY: no source edits, no
  build, no stack interaction. Output = proposal doc + report to team-lead (orchestrator).
- **Started:** 2026-06-10T10:00:00Z
- **Status:** Complete
- **Constraints honoured:** read-only + docs-only; did NOT touch dev-bug1rt's in-flight work
  (`feature/debug-online-realtime-fix`); no `.cu/.cpp/.h/.py` edits; no build; no stack/ports touched.

## Actions

### Docs-first (mandatory, before any source)
- [READ] docs/index.md — module map, entry point.
- [READ] docs/development/logs/dev-bug1rt-2026-06-10-095401.md — BUG-1 RCA (the measured evidence:
  grid=56, block=512=(16,32), cudaErrorCooperativeLaunchTooLarge, debug-online-only, RTX 4090 128 SMs).
- [READ] docs/architecture/BUILD_SYSTEM.md — build config, variants (debug/release), nvcc flags
  (`-O3 -use_fast_math`, gencode 80/86/89), the canonical build procedure.
- [READ] docs/modules/pianoid-cuda/OVERVIEW.md — Pianoid facade, MainKernel/addKernel, the 7-file split.
- [READ] docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md — kernel grid layout, cooperative launch,
  per-sample loop, sumArray reductions, FIR convolution kernel (a 2nd cooperative kernel).
- [READ] docs/modules/pianoid-cuda/DEBUG_DATA.md — PIANOID_DEBUG_DATA guard, recordOutputData,
  what makes the debug kernel heavier.
- [READ] docs/development/proposals/mode-scaling-4000-implementation-proposal-2026-06-06.md
  (full, 1699 lines) — §3 register analysis, §3.1 SM budget table, §3.2 R0 measurement gap,
  §7 kernel/build edits incl. __launch_bounds__/R0 plan, §7.5 occupancy clamp, §10/§12 risks.
- [READ] docs/development/string-mode-coupling-mode-scaling-context-2026-06-06.md (substrate,
  §0–§3) — the num_modes≤num_strings ceiling, SEGMENT/co-residency constraints.

### Source confirmation (AFTER docs)
- [READ] PianoidCore/pianoid_cuda/Pianoid_synthesis.cu:220-260, 340-360, 460-485 — launch geometry
  (grid = num_string_arrays(), block = (array_size/32, 32) = 512), dev-bug1rt FIX-3 launch-return
  check, FIR-path grid-clamp precedent.
- [READ] PianoidCore/pianoid_cuda/MainKernel.cu:78-107 — dev-bug1rt FIX-2
  ADDKERNEL_LAUNCH_BOUNDS = __launch_bounds__(512,1) under #ifdef PIANOID_DEBUG_DATA.
- [GREP] pianoid_cuda/ for cudaOccupancy*/cudaFuncGetAttributes/maxrregcount/launch_bounds →
  ONLY dev-bug1rt's debug-only __launch_bounds__ + the FIX-3 launch-return check exist. NO
  cudaOccupancyMaxActiveBlocksPerMultiprocessor, NO -Xptxas -v reporting, NO runtime pre-flight
  check, NO -maxrregcount. **This is the gap the plan fills.**

### GPU introspection (read-only, allowed — grounds the runtime-adaptive design)
- [MEAS] nvidia-smi: NVIDIA GeForce RTX 4090, compute_cap 8.9 (sm_89 Ada), 24564 MiB, driver 565.90.
- [MEAS] cupy device attributes (RTX 4090, sm_89):
  - MultiProcessorCount = **128**
  - MaxThreadsPerMultiProcessor = **1536** (Ada; NOT 2048)
  - MaxThreadsPerBlock = 1024
  - MaxRegistersPerMultiprocessor = **65536**; MaxRegistersPerBlock = 65536
  - MaxSharedMemoryPerMultiprocessor = **102400 B**; per-block default 49152, optin 101376;
    ReservedSharedMemoryPerBlock = 1024
  - WarpSize = 32; MaxBlocksPerMultiprocessor = **24**; CooperativeLaunch = 1
- [MEAS-derived] Co-residency budget for addKernel (block=512=16 warps) at various regs/thread on
  RTX 4090, idle GPU: at 32 r/t → 4 blk/SM (but capped 3 by 1536 thr/SM) → 384 coop blocks; at
  64 r/t → 2 blk/SM → 256; at 128 r/t → 1 blk/SM → 128; at 168 r/t → **0 blk/SM by regfile → spill
  cliff** (cooperative launch would fail). All rows ≥64 fit the 56-block Belarus grid on an IDLE
  GPU — so the static budget is generous; **BUG-1 only manifests because the SDL3 audio driver
  consumes SM resources at runtime**, dropping the effective budget below the debug kernel's need.
  ⇒ confirms a RUNTIME pre-flight check (not compile-time alone) is required.

### Tools/bindings available (for the runtime design)
- cupy ✓, numba ✓, cuda ✓ (in PianoidCore/.venv). No torch, no pycuda, no pynvml.
- R0 (per-kernel registers/thread) is NOT obtainable without a build → marked TO-MEASURE with the
  exact method (`-Xptxas -v` / `nvcc --resource-usage` at build; `cudaFuncGetAttributes.numRegs`
  + `cudaOccupancyMaxActiveBlocksPerMultiprocessor` at runtime).

### Output
- [WRITE] docs/development/proposals/register-memory-management-plan-2026-06-10.md (confirmed
  non-existent before writing).
- [COMMIT] [plan-regmem] docs commit — staged ONLY the plan doc + this log (no `git add .`).
- [REPORT] executive summary → team-lead via SendMessage.

## Key conclusions (for the report)
- **Gap:** no explicit register control (beyond dev-bug1rt's debug-only band-aid), no R0 visibility
  in the build, no runtime occupancy pre-flight → resource shortage = silent
  cudaErrorCooperativeLaunchTooLarge (BUG-1).
- **Framework = compile-time budgets (per-kernel __launch_bounds__ + ptxas -v reporting +
  per-SM-arch targeting) + runtime pre-flight (cudaFuncGetAttributes ×
  cudaOccupancyMaxActiveBlocksPerMultiprocessor × numSMs ≥ gridDim, BEFORE the cooperative launch)
  + a shortage decision tree.**
- **Measured vs TO-MEASURE:** device props all MEASURED (above); R0 per kernel is TO-MEASURE
  (needs a build with `-Xptxas -v`).
- Integrates with (does not duplicate) the 4000-mode proposal §3/§7 — this plan is the shared
  register/occupancy foundation both BUG-1 robustness and mode-scaling depend on.
