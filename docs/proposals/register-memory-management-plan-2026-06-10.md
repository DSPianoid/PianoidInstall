# Register / Memory (Occupancy) Management Framework — Plan

**Date:** 2026-06-10
**Author:** plan-regmem-9f2c (PLANNING/DESIGN ONLY — no source edits, no build, read-only GPU introspection)
**Status:** DESIGN PROPOSAL — not implemented. Every `.cu/.cpp/.cuh/.h/setup.py` change named here
MUST go through `/dev` (CUDA build). This document does not authorise edits.

> **Evidence tags.** **[MEAS]** = measured this session on the live device (read-only); **[SRC]** =
> confirmed by reading source (file:line cited); **[DOC]** = supported by project docs; **[SPEC]** =
> from published NVIDIA architecture specs for sm_89 (Ada) / sm_80/86 (Ampere); **[EST]** = static
> estimate, assumption stated; **TO-MEASURE** = not obtainable without a build/profiler — the exact
> method is given. **Per the project high-stakes-inference rule, no [EST]/TO-MEASURE number here may
> drive a code edit until measured.**

> **Relationship to the 4000-mode scaling work.** The
> [4000-mode two-tier proposal](mode-scaling-4000-implementation-proposal-2026-06-06.md) §3
> (register analysis), §3.1 (SM budget table), §7 (`__launch_bounds__`/R0 plan), and §7.5 (occupancy
> clamp) already begin this analysis **for the flat-mode register-residency requirement**. This plan
> is the **shared register/occupancy FOUNDATION** that BOTH the BUG-1 robustness class AND the
> 4000-mode scaling depend on. It **does not duplicate** that proposal — it generalises §3/§7 into a
> reusable compile-time + runtime framework and adds the *detection-and-recommendation* layer that
> neither dev-bug1rt's tactical fix nor the scaling proposal provides. Where the scaling proposal
> states a number as `[EST]`/TO-MEASURE (notably **R0**, the kernel's baseline registers/thread),
> this plan inherits that exact gap and the exact method to close it.

---

## 0. Executive Summary

**The problem class.** Pianoid's primary synthesis kernel `addKernel` is launched as a **cooperative
grid** (`cudaLaunchCooperativeKernel`, `Pianoid_synthesis.cu:345` **[SRC]**). A cooperative launch
has a hard requirement absent from ordinary launches: **ALL `gridDim` blocks must be simultaneously
co-resident on the device in a single wave** (`grid_group::sync()` between the kernel's string and
mode phases needs every block alive at once). Whether that holds depends on the kernel's **register
footprint** (regs/thread → blocks-per-SM by the register file) and the **runtime GPU state**
(an active audio driver, other contexts). When it does not hold, the launch returns
`cudaErrorCooperativeLaunchTooLarge` **synchronously** — and until dev-bug1rt's fix that return was
**unchecked**, so the kernel never ran, `*kernel_status` kept its prior value, and the realtime
thread died at cycle 0 with **no sound and no error** (BUG-1, fully RCA'd in
`dev-bug1rt-2026-06-10-095401.md` **[DOC]**).

**The gap (what is missing today).** [SRC — grep over `pianoid_cuda/` this session]
- **No explicit register control** beyond dev-bug1rt's *tactical, debug-only* band-aid
  (`__launch_bounds__(512,1)` guarded by `#ifdef PIANOID_DEBUG_DATA`, `MainKernel.cu:90-94`). No
  `-maxrregcount`, no `-Xptxas`, no per-kernel budget on the release kernel, none on the FIR or
  gauss kernels.
- **No register visibility in the build.** nvcc runs with `-O3 -use_fast_math` only
  (`setup.py:296` **[SRC via DOC]**); registers/thread (**R0**) is never reported, so nobody knows
  how close any kernel is to the spill cliff.
- **No runtime pre-flight check.** Nothing calls `cudaOccupancyMaxActiveBlocksPerMultiprocessor` or
  `cudaFuncGetAttributes` before the cooperative launch. The first sign of shortage is the launch
  failure itself — now *detected* (dev-bug1rt FIX-3) but still without a *recommendation*.

**The framework (three layers + a decision tree).**
- **A. Compile-time register management** — documented per-kernel register budgets via
  two-arg `__launch_bounds__(maxThreads, minBlocksPerSM)`, optional `-maxrregcount`/`-Xptxas`,
  per-SM-arch targeting, and surfacing `ptxas --resource-usage` (R0) in the build log so register
  counts are *known and tracked*. (§3)
- **B. Runtime GPU-adaptive management** — at engine init, query device props +
  `cudaFuncGetAttributes` + `cudaOccupancyMaxActiveBlocksPerMultiprocessor`, and **pre-flight** every
  cooperative launch: `maxActiveBlocksPerSM × numSMs ≥ gridDim` must hold. Detect shortage **before**
  the launch; never let a silent `cudaErrorCooperativeLaunchTooLarge` happen again. (§4)
- **C. Shortage recommendations** — a concrete decision tree, each lever annotated with what it
  **saves**, what it **costs**, and when to recommend it (reduce block size; reduce
  `string_iterations`; reduce modes/strings; scope debug extraction; raise `minBlocksPerSM`; fall
  back to a non-cooperative path). Surfaced as an actionable log/UI message, not a silent failure. (§5)
- **D. BUG-1 tie-in** — how the framework would have caught BUG-1 at init with a recommendation
  instead of a 0-cycle death. (§6)
- **E. Integration with the 4000-mode scaling** register-residency requirement. (§7)

**Measured this session (RTX 4090, sm_89 Ada) [MEAS]:** 128 SMs · 1536 max threads/SM · 65536
regs/SM · 65536 regs/block · 102400 B shared/SM (49152 default / 101376 optin per block, 1024
reserved) · warp 32 · max 24 blocks/SM · CooperativeLaunch=1. **TO-MEASURE:** R0 (registers/thread)
for each kernel — needs a build with `-Xptxas -v` (method in §3.3). Every occupancy number below is
computed from the **measured** device props; only R0 is a placeholder until built.

---

## 1. Background — Why a Cooperative Launch Is a Resource-Shortage Tripwire

### 1.1 The cooperative co-residency requirement [DOC + SRC]

`addKernel` uses grid-level synchronisation (`grid_group::sync()`) between its string-FDTD phase and
its mode-oscillator phase (`SYNTHESIS_ENGINE.md` "Kernel Grid Layout", "Synthesis Cycle" **[DOC]**;
launch at `Pianoid_synthesis.cu:345` **[SRC]**). For `grid_group::sync()` to be legal, **the entire
grid must be co-resident** — CUDA refuses a cooperative launch whose blocks cannot all fit on the
device at once, returning `cudaErrorCooperativeLaunchTooLarge`. An ordinary (non-cooperative) launch
has no such constraint (excess blocks queue and run in later waves), which is precisely why this
failure mode is *unique to the cooperative kernels* (`addKernel`, and the FIR `convolutionKernel`
which is also cooperative — `SYNTHESIS_ENGINE.md` "FIR Filter Convolution" **[DOC]**).

### 1.2 The launch geometry [SRC]

```
grid  = init_params_.num_string_arrays()        // = numStrings / NUM_STRINGS_IN_ARRAY; 56 for Belarus (224/4)
block = dim3(array_size / WARP_SIZE, WARP_SIZE)  // = (512/32, 32) = (16, 32) = 512 threads = 16 warps
```
`Pianoid_synthesis.cu:228-230` (block), `:345` (cooperative launch with `num_string_arrays()`)
**[SRC]**. Note the **block dim decomposition** measured in BUG-1 is `(16,32)`, whereas
`SYNTHESIS_ENGINE.md` "Kernel Grid Layout" documents `blockDim.x=4, blockDim.y=128`. Both equal 512
threads; the doc's `(4,128)` is the *legacy/illustrative* decomposition and the *measured* runtime
block is `(array_size/32, 32) = (16,32)`. **DOC-DRIFT to fix in a later docs pass** (not load-bearing
for this plan — the framework keys off the *thread count* 512 and the *warp count* 16, which both
forms agree on).

### 1.3 The co-residency budget is governed by registers/thread [MEAS-derived]

Resident blocks per SM is the min over several limiters; for a 512-thread (16-warp) block on the
measured RTX 4090:

| Limiter | Value | blocks/SM |
|---|---|---|
| Max threads/SM (1536) | 1536 / 512 | **3** |
| Max blocks/SM (hw) | 24 | 24 |
| **Register file (65536/SM)** | depends on regs/thread | **the binding one** |
| Shared mem/SM (102400 B) | depends on shared/block (~3 KB today **[DOC]**) | ~30 (non-binding today) |

The register-file limiter, computed with the measured 65536 regs/SM and 256-reg/warp granularity:

| regs/thread (R0) | blocks/SM by reg-file | total coop blocks (×128 SMs) | fits 56-block grid (idle GPU)? |
|---|---|---|---|
| 32 | 3 (capped by 1536 thr/SM) | 384 | YES |
| 48 | 2 | 256 | YES |
| 64 | 2 | 256 | YES |
| 96 | 1 | 128 | YES |
| 128 | 1 | 128 | YES |
| **168** | **0** | **0** | **NO — spill cliff** |
| 255 | 0 | 0 | NO |

**[MEAS-derived — device props measured; R0 axis is the variable.]** **Key reading:** on an *idle*
RTX 4090 the kernel fits 56 cooperative blocks at *any* R0 up to ~128 regs/thread (1 block/SM × 128
SMs = 128 ≥ 56). The hard cliff is ~168 regs/thread. **So the static budget is generous** — which is
exactly why BUG-1 is *not* a static-budget failure (the release kernel always fits, and even the
debug kernel fits on an idle GPU). **BUG-1 manifests only because the runtime GPU state is not idle:**
the SDL3 audio driver consumes SM/engine resources, lowering the *effective* per-SM budget below what
the heavier debug kernel needs, so its 56 blocks stop co-residing (`dev-bug1rt` RCA **[DOC]**;
debug-OFFLINE = no driver = fits; debug-ONLINE = driver active = `TooLarge`). **This is the central
design insight: the binding budget is a RUNTIME quantity, so the framework must check it at runtime,
not only bound it at compile time.**

### 1.4 What makes a kernel "heavier" [DOC + SRC]

The debug kernel is register-heavier than release because `#ifdef PIANOID_DEBUG_DATA`
`recordOutputData` writes add live values (more registers/thread) — `DEBUG_DATA.md` "Compile Guard"
**[DOC]**; the writes are gated in `MainKernel.cu` and `Pianoid_synthesis.cu` **[SRC]**. The
4000-mode scaling will *also* make `addKernel` heavier (flat oscillators add ~5 regs/thread, scaling
§3.3 **[DOC]**). Both push the kernel along the §1.3 R0 axis toward the cliff — the same axis, the
same framework.

---

## 2. The Kernels Under Management (inventory)

| Kernel | Cooperative? | Launch geometry | Register control today | In framework scope |
|---|---|---|---|---|
| `addKernel` (MainKernel.cu) | **YES** | grid=`num_string_arrays()` (56), block=512 **[SRC]** | debug-only `__launch_bounds__(512,1)` (dev-bug1rt); release uncapped **[SRC]** | **PRIMARY** — pre-flight + budget |
| `convolutionKernel` (FIRFilter.cu) | **YES** | grid=`inputCh×outputCh` blocks, block=warp-tiled **[DOC]** | none **[SRC]**; FIR host *does* clamp its grid to coop limits (`Pianoid_synthesis.cu:467-481` **[SRC]**) | **SECONDARY** — pre-flight when FIR on |
| `gaussKernel` (gaussTest.cu) | no (ordinary) | grid=`(noStrings, numSeg)`, block=128 **[DOC]** | none | budget + ptxas-v reporting only (no co-residency risk) |
| `parameterKernel`, `stringMapKernel` (Kernels.cu) | no | per-block | none | ptxas-v reporting only |

**The cooperative kernels (`addKernel`, `convolutionKernel`) are the only ones that can fail with
`cudaErrorCooperativeLaunchTooLarge`** — they are where the runtime pre-flight (§4) is mandatory. The
ordinary kernels still benefit from compile-time budgets + ptxas-v reporting (§3) so their R0 is
tracked and they don't silently regress occupancy, but they cannot trigger the co-residency failure.

> **Precedent worth reusing [SRC]:** the FIR host wrapper at `Pianoid_synthesis.cu:467-481` already
> *computes a grid that respects cooperative-launch limits* — i.e. the codebase already contains one
> hand-rolled co-residency clamp. The framework should **generalise that one-off into the shared
> pre-flight helper** (§4.2) and apply it to `addKernel` too (which currently has none).

---

## 3. Layer A — Compile-Time Register Management

### 3.1 Goal

Make each kernel's register footprint **explicit, bounded, per-SM-arch-aware, and visible in the
build** — so occupancy is a controlled design parameter, not whatever nvcc happened to choose.

### 3.2 Per-kernel `__launch_bounds__(maxThreads, minBlocksPerSM)` budgets

`__launch_bounds__(T, B)` tells nvcc "this kernel launches with ≤T threads/block and I want ≥B blocks
resident per SM" — nvcc then caps registers so `regs/thread ≤ regfile_per_SM / (B × T)`. With the
measured 65536 regs/SM:

| `__launch_bounds__` | implied regs/thread cap | blocks/SM | total coop (×128) | when to use |
|---|---|---|---|---|
| `(512, 1)` | 65536/(1×512) = **128** | 1 | 128 | minimum to fit 56 blocks with margin; dev-bug1rt's debug choice |
| `(512, 2)` | 65536/(2×512) = **64** | 2 | 256 | more headroom under driver contention; modest spill risk |
| `(512, 3)` | 65536/(3×512) = ~42 | 3 (also thr/SM cap) | 384 | max occupancy; highest spill risk |

**[MEAS-derived caps; spill behaviour TO-MEASURE per kernel.]**

**Recommended documented budgets (to be confirmed by the §3.3 R0 measurement):**
- **`addKernel` RELEASE:** start with **`__launch_bounds__(512, 1)`** as an *explicit floor* (it
  guarantees ≥1 block/SM = 128 coop blocks ≥ 56 with 2.3× margin, and gives nvcc a hard register
  ceiling of 128 so a future kernel growth — e.g. 4000-mode flat oscillators — cannot silently push
  R0 past the cliff and reintroduce BUG-1 on release). **Caveat:** if measured release R0 is already
  ≤128 (likely, per scaling §3.2 EST 40-80), `(512,1)` changes nothing today — its value is as a
  *regression guard* and a *documented intent*. If a tighter occupancy target is wanted, `(512,2)`
  caps at 64 — only adopt if the §3.3 measurement shows release R0 ≤ 64 already (no spill) or a
  measured A/B shows no perf regression.
- **`addKernel` DEBUG:** keep dev-bug1rt's `(512,1)` (already in source) — its purpose is exactly
  this floor under driver contention. Consider `(512,2)` only if debug R0 measurement + sustained
  online test shows it helps; debug perf is not user-facing.
- **`convolutionKernel`:** document a budget once its R0 is measured; it is cooperative so it shares
  the co-residency risk (only when FIR is enabled).
- **Ordinary kernels:** no `minBlocksPerSM` floor needed (no co-residency requirement); a
  one-arg `__launch_bounds__(blockSize)` may be added purely to *codify the block size* but adds no
  register control (the two-arg form is what forces the cap — a point dev-bug1rt's team-lead already
  raised).

> **CRITICAL release-safety rule (carried from dev-bug1rt + scaling §7.3):** any `__launch_bounds__`
> on the RELEASE codegen of a kernel that ships today must be **proven non-regressing** by a measured
> N≥3 `note_playback` A/B (per the project's multi-run regression rule + Audio Verification Rule)
> AND a per-cycle timing comparison — because a register *cap* can force *spill* if the kernel's
> natural R0 exceeds the cap, which *deteriorates* performance (scaling §3.5 "dramatic
> deterioration"). The safe default is to set the cap **at or above** the measured R0 (so it is a
> ceiling/regression-guard, not a forced reduction), unless a shortage *requires* a reduction (§5).

### 3.3 ★ Surfacing R0 — make registers/thread visible in the build (the core compile-time gap)

Today **R0 is unknown** for every kernel (no profiler, no flag). Close it two ways:

1. **Build-time (authoritative, per-kernel, per-arch):** add **`-Xptxas -v`** (equivalently
   `--resource-usage`) to the nvcc invocation in `setup.py` (the `.cu` compile step, alongside the
   existing `-O3 -use_fast_math`). ptxas then prints, per kernel per `sm_*` target, e.g.
   `ptxas info: Used 72 registers, 3072 bytes smem, ...`. Capture these lines into the build log
   (`build_pianoid_cuda.bat` already tees to a log). **This is the single most valuable
   compile-time change** — it turns R0 from unknown into a tracked build artifact, and it is the
   prerequisite the scaling proposal flags as gating its entire §3.4 occupancy table (scaling §12
   "Exact R0 … unknown without `-Xptxas -v`" **[DOC]**).
   - **Method to obtain R0 NOW (one-off, before committing to budgets):** add `-Xptxas -v` to the
     `extra_compile_args` for the `.cu` step in `pianoid_cuda/setup.py`, run
     `build_pianoid_cuda.bat --heavy --both`, and grep the build log for `ptxas info` /
     `Used N registers` per kernel per arch. (This is a `/dev`-gated build — out of scope for this
     planning task; listed in §8 "Phase 0 — Measure".)
2. **Runtime (per loaded binary, confirms the build):** `cudaFuncGetAttributes(&attr, addKernel)`
   returns `attr.numRegs`, `attr.sharedSizeBytes`, `attr.maxThreadsPerBlock` for the *actually
   loaded* kernel. This is what the §4 pre-flight uses, and it cross-checks the build-time ptxas
   number against what's running (catching a stale-binary mismatch — a recurring Pianoid trap).

### 3.4 Per-SM-arch targeting

The build already targets `sm_80, sm_86, sm_89` (`build_config.json` `cuda_arch_list`,
`setup.py` gencode **[SRC via DOC]**). Register *limits* are uniform across these (65536 regs/SM,
255 max regs/thread) but **max-threads/SM differs** (Ampere 2048 vs **Ada 1536** — measured here)
and so does max-warps/SM (64 vs 48). A `__launch_bounds__(512, B)` therefore yields different
occupancy on Ampere vs Ada; the budget should be **documented per-arch** in a small table in
`BUILD_SYSTEM.md` (this plan provides the RTX-4090/Ada row; the Ampere rows are [SPEC] from the
scaling §3.1 table). No per-arch *code* divergence is needed — the same `__launch_bounds__` is
emitted for all archs; only the documented occupancy expectation differs.

### 3.5 Optional `-maxrregcount` / `-Xptxas --maxrregcount`

A global `-maxrregcount=N` caps *every* kernel's registers — blunter than per-kernel
`__launch_bounds__` (which is the recommended primary tool because it is per-kernel and lets nvcc
optimise within the cap). Reserve `-maxrregcount` for a *quick experiment* to find the spill knee, or
as a coarse global ceiling if per-kernel bounds prove insufficient. Document it; don't make it the
default.

---

## 4. Layer B — Runtime GPU-Adaptive Management (the pre-flight check)

### 4.1 Goal

At engine init (and whenever the launch config or GPU contention changes), compute whether the
cooperative grid can co-reside **given the actual device + the actual kernel register footprint +
the current config**, and **detect a shortage BEFORE the launch** — replacing the silent
`cudaErrorCooperativeLaunchTooLarge` with a deterministic, logged, recommendation-bearing decision.

### 4.2 The pre-flight check (the exact computation)

At init, once per (kernel, blockSize, device):

```cpp
int numSMs;                       cudaDeviceGetAttribute(&numSMs, cudaDevAttrMultiProcessorCount, dev);
int maxActiveBlocksPerSM;
cudaOccupancyMaxActiveBlocksPerMultiprocessor(
        &maxActiveBlocksPerSM, addKernel,
        blockSize.x * blockSize.y /* = 512 */,
        dynamicSharedMemBytes    /* = the kernel's dynamic smem, 0 if static */);

int coopCapacity = maxActiveBlocksPerSM * numSMs;     // device's cooperative-block capacity for THIS kernel+config
int gridBlocks   = init_params_.num_string_arrays();  // the cooperative grid we intend to launch

bool willCoReside = (coopCapacity >= gridBlocks);
```

`cudaOccupancyMaxActiveBlocksPerMultiprocessor` already folds in the kernel's **measured** registers
(via the loaded binary), the block size, and the shared-mem request — so `coopCapacity` is the real
per-device budget, and `coopCapacity >= gridBlocks` is the **exact** cooperative-launch feasibility
test CUDA itself applies. (CUDA exposes the same logic as
`cudaOccupancyMaxActiveBlocksPerMultiprocessor`; the cooperative requirement is literally
`gridDim ≤ maxActiveBlocksPerSM × numSMs`.)

> **The runtime-contention caveat (this is what makes BUG-1 subtle).**
> `cudaOccupancyMaxActiveBlocksPerMultiprocessor` reports the *theoretical* occupancy for an
> otherwise-idle device. It does **not** know that the SDL3 audio driver is concurrently consuming SM
> resources. So a pre-flight at init (before the driver starts, or computed theoretically) can report
> "fits" while the *runtime* launch (driver active) fails. The framework handles this two ways:
> 1. **Run the pre-flight AFTER `startAudioDriver()`** (the Online engine starts the driver before the
>    loop — `OnlinePlaybackEngine.cu` **[DOC]**), so the device state at pre-flight matches the launch.
> 2. **Always also keep the launch-return check** (dev-bug1rt FIX-3, already in source) as the
>    backstop: even with a passing pre-flight, the first launch's return is checked, and on
>    `cudaErrorCooperativeLaunchTooLarge` the framework runs the §5 recommendation logic and surfaces
>    it (rather than the prior silent death). **Pre-flight = early/clear detection; launch-return
>    check = guaranteed catch.** Both are needed; they are not redundant.

### 4.3 Where it lives

- **`Pianoid_synthesis.cu`** — a new helper `preflightCooperativeLaunch(kernel, blockSize, grid,
  smem)` returning a small struct `{willCoReside, coopCapacity, gridBlocks, numRegs, maxBlocksPerSM}`.
  Generalises the existing FIR grid-clamp (`:467-481` **[SRC]**) into the shared helper.
- **Called from:** (a) engine/online-playback init *after* the audio driver starts and before the
  first `runSynthesisKernel`; (b) optionally from a `/health`-style introspection endpoint so the
  budget is reportable to the UI.
- **`cudaFuncGetAttributes`** result (`numRegs`, `sharedSizeBytes`) is logged at init alongside the
  ptxas build number (§3.3) — the cross-check.

### 4.4 What it reports (never silent)

On every init, log a one-line budget summary (example, the measured RTX 4090, addKernel,
hypothetical R0=72):

```
[OCCUPANCY] addKernel: regs/thread=72 block=512 smem=3072B | device=RTX 4090 SMs=128
            maxActiveBlocks/SM=1 -> coopCapacity=128 >= grid=56  OK (margin 2.3x)
```

On a shortage (`coopCapacity < gridBlocks`), it logs the shortage + the §5 recommendation and refuses
the launch *with a clear message* (or applies an auto-lever per §5 policy) — instead of letting the
cooperative launch fail silently.

---

## 5. Layer C — ★ Shortage Decision Tree & Recommendations

When the §4 pre-flight (or the §4.2 launch-return backstop) detects `coopCapacity < gridBlocks`, the
framework emits a **ranked, actionable recommendation**, each lever with what it SAVES, what it COSTS,
and when it applies. The deficit is `gridBlocks − coopCapacity` (how many more co-resident blocks are
needed), and `needBlocksPerSM = ceil(gridBlocks / numSMs)` (the per-SM target). The levers are ordered
**least-harmful-first**.

### 5.1 The decision tree

```
DETECTED: coopCapacity (C) < gridBlocks (G)   [need ceil(G/numSMs) blocks/SM, have maxActiveBlocks/SM]

 ├─ Is debug extraction active online AND not needed right now?
 │     → LEVER 4 (scope debug extraction)  — recovers the BUG-1 deficit exactly, zero audio cost
 │
 ├─ Is regs/thread the binding limiter (reg-file blocks/SM < thread/smem blocks/SM)?
 │     → LEVER 5 (raise minBlocksPerSM via __launch_bounds__ — REBUILD)  if spill-tolerable
 │     → else LEVER 1 (reduce block size)                                if kernel tolerates it
 │
 ├─ Is the per-cycle realtime deadline the pressure (not pure co-residency)?
 │     → LEVER 2 (reduce string_iterations)  — relaxes the deadline, lets a fitting config keep realtime
 │
 ├─ Is gridBlocks itself too large (driven by num_strings)?
 │     → LEVER 3 (reduce num_strings / num_modes)  — fewer blocks, last resort (changes the instrument)
 │
 └─ None acceptable?
       → LEVER 6 (non-cooperative fallback path)  — architectural, largest effort, removes the constraint entirely
```

### 5.2 The levers (each: mechanism · SAVES · COSTS · when)

**LEVER 1 — Reduce BLOCK SIZE.**
- *Mechanism:* fewer threads/block → fewer registers consumed per block (regs/block = regs/thread ×
  threads) → more blocks co-reside per SM (the reg-file limiter `regfile/SM ÷ (regs/thread ×
  threads/block)` rises). Today block=512=(array_size/32, 32); reducing it means a smaller
  `array_size` tiling or a different `(x,y)` split.
- *SAVES:* directly raises `maxActiveBlocksPerSM`. Halving threads/block roughly doubles blocks/SM by
  the reg-file limiter.
- *COSTS:* the block size is **structurally tied to `array_size` (spatial points/string)** in
  `addKernel` (`dimX = array_size/WARP_SIZE` **[SRC]**) — you cannot freely shrink it without
  changing how many spatial points a block covers, i.e. the FDTD discretisation tiling. This is a
  **deep kernel change**, not a knob. It also reduces per-block parallelism (more blocks, each doing
  less). **[EST — the coupling to array_size makes this the *least* practical of the "cheap" levers
  for `addKernel`; more applicable to the FIR kernel whose block is independent of array_size.]**
- *When:* recommend only if the kernel's block size is genuinely independent of the physics tiling
  (FIR kernel) or as part of a deliberate kernel refactor. For `addKernel`, prefer LEVER 5.

**LEVER 2 — Reduce STRING_ITERATIONS (the user's explicit note: "increases cycle time tolerance").**
- *Mechanism:* `string_iteration` = FDTD sub-steps per audio sample
  (`dt = 1/(sample_rate × string_iteration)`, `SYNTHESIS_ENGINE.md` **[DOC]**). It does **not** change
  the kernel's register footprint or grid size — so it does **not** directly raise
  `maxActiveBlocksPerSM`. What it changes is the **per-cycle compute time**: fewer sub-steps → each
  cooperative launch finishes faster → the realtime per-cycle **deadline is met with more margin**.
- *SAVES:* **cycle-time headroom / realtime deadline tolerance** — not co-residency. The mechanism the
  user identified: a config that *fits* co-residency but is *too slow* to meet realtime (e.g. because
  it had to run at a low occupancy after another lever) becomes feasible again because the per-cycle
  work shrank. It buys back the throughput a co-residency-driven occupancy reduction costs.
- *COSTS:* **synthesis quality** — fewer sub-steps coarsens the FDTD time discretisation. Audio
  effects are documented: the engine is *iter-invariant by design* for audio peak + spectral content
  (post-fix peak ratio iter=12/iter=4 = 1.011× **[DOC]**), BUT there is a **known iter-scaled
  residual**: HF content (~25 dB swing iter=4→12), spectral centroid (~2× swing), initial decay rate
  (±3 dB/s) — traced to `coeff_frequency_decay` (`SYNTHESIS_ENGINE.md` "Numerical scheme invariants"
  / WIP **[DOC]**). So reducing `string_iteration` is **not free** — it shifts HF timbre/decay. Also
  CFL stability: lower iter raises `coeff_tension ∝ dt²`, moving toward the CFL upper edge
  (`SYNTHESIS_ENGINE.md` "FDTD Stability" **[DOC]**) — though real presets sit ~20× under the edge so
  there's margin.
- *When:* recommend as a **realtime-deadline** relief when a co-residency lever (5/1) has been applied
  and the now-lower-occupancy config can't meet realtime — *or* as a first-resort *tolerance* knob
  when the failure is "can't keep up" rather than "can't co-reside". Pair it with the
  Audio-Verification A/B so the HF/decay shift is measured, not assumed.

**LEVER 3 — Reduce NUM_STRINGS / NUM_MODES.**
- *Mechanism:* `gridBlocks = num_strings / NUM_STRINGS_IN_ARRAY` **[SRC]**, so fewer strings → fewer
  cooperative blocks → the `coopCapacity ≥ gridBlocks` test passes with a smaller right-hand side.
  Modes ride strings today (`num_modes ≤ num_strings`, scaling substrate §0c **[DOC]**) so reducing
  modes alone doesn't cut blocks unless it lets you cut strings.
- *SAVES:* directly shrinks the grid — the most direct way to make a too-large grid fit.
- *COSTS:* **changes the instrument** — fewer strings/modes = less polyphony / fewer resonances =
  audibly different. This is a preset/voicing change, not a tuning knob.
- *When:* last-resort for co-residency; or legitimately when a preset is over-provisioned. Always
  surface as "this reduces the instrument's string/mode count" — never apply silently.

**LEVER 4 — Scope / disable debug extraction online.**
- *Mechanism:* the `#ifdef PIANOID_DEBUG_DATA` `recordOutputData` writes are what make the debug
  kernel register-heavier (DEBUG_DATA.md **[DOC]**; the exact BUG-1 cause). Disabling them online (or
  not running the debug variant online) restores the release kernel's lighter footprint.
- *SAVES:* recovers **exactly the BUG-1 deficit** — the debug kernel becomes the release kernel
  register-wise.
- *COSTS:* **loses live debug-extraction charts** (`feedback_diagnostic`, `block_output_data`,
  `hammer_shape` read addKernel's debug output *while playing* without stopping the engine —
  dev-bug1rt traced these at `chartFunctions.py:382/437/604` **[DOC/SRC]**). This is precisely why
  dev-bug1rt **rejected** "gate debug writes off online" as the BUG-1 fix and chose `__launch_bounds__`
  instead (it preserves online extraction). So LEVER 4 is a *recommendation to the user* ("you can
  recover headroom by turning off live debug extraction"), not an auto-applied default — the user may
  *want* the extraction.
- *When:* recommend when the user is in debug build but not actively using a live-extraction chart, or
  as the explanation for why debug-online needs more headroom than release-online.

**LEVER 5 — Raise `minBlocksPerSM` via `__launch_bounds__` (REBUILD).**
- *Mechanism:* `__launch_bounds__(512, B)` forces nvcc to cap regs/thread to
  `≤ 65536/(B×512)`, raising `maxActiveBlocksPerSM` to ≥B. This is dev-bug1rt's debug fix
  (`(512,1)`) generalised.
- *SAVES:* deterministic co-residency — `(512,1)` guarantees ≥1 block/SM = 128 coop blocks ≥ 56.
- *COSTS:* if the kernel's natural R0 exceeds the implied cap, nvcc **spills registers to local
  memory** → the "dramatic deterioration" (scaling §3.5 **[DOC]**: spilled state pays global-memory
  latency). Requires a **rebuild** (compile-time lever, not runtime). Must be A/B-perf-verified.
- *When:* the **primary co-residency lever for `addKernel`** (block size is hard to change, LEVER 1).
  Set B to the *smallest* value that makes the grid fit with margin (B=1 already gives 2.3× margin for
  56 blocks on the 4090), so the register cap is as loose as possible (minimising spill risk). This is
  a *compile-time* fix surfaced by the *runtime* detector — the detector says "you need B≥1", the
  build sets it.

**LEVER 6 — Non-cooperative fallback path.**
- *Mechanism:* split `addKernel`'s grid-synced phases into separate ordinary-launch kernels with the
  grid sync replaced by a kernel boundary (each kernel launch is an implicit global barrier). Ordinary
  launches have **no co-residency requirement** — excess blocks queue in later waves — so
  `cudaErrorCooperativeLaunchTooLarge` becomes impossible.
- *SAVES:* removes the cooperative constraint entirely; the grid can be any size.
- *COSTS:* largest engineering effort (kernel-architecture change); per-launch overhead × N phases per
  sample; loses the single-launch efficiency of the fused cooperative kernel; needs careful state
  handoff between the split kernels via global memory. **[EST — architectural; out of scope for a
  shortage *recommendation* but the documented escape hatch if levers 1-5 cannot satisfy a target
  GPU.]** Scaling §12.1 lists "consider a two-kernel split if co-residency fails" as the same
  mitigation **[DOC]**.
- *When:* only if the framework must support a GPU where even `(512,1)` + reduced config cannot fit
  the grid cooperatively (e.g. a small GPU with few SMs), or a permanent move past the cooperative
  ceiling.

### 5.3 Recommendation surfacing (actionable, not silent)

The recommendation is emitted as:
- a **structured log line** (`[OCCUPANCY-SHORTAGE] need=<deficit> ... recommend: <lever> (saves X, costs Y)`),
- a **`/health` field** so the frontend can show a "GPU resource shortage — see recommendation" chip
  (mirrors the existing CFL chip pattern, `SYNTHESIS_ENGINE.md` "Where the guard lives" **[DOC]**),
- and, for the **auto-applicable** levers only (4 scope-debug, 2 reduce-iter within a safe band), an
  optional **policy** to apply-and-log rather than refuse — never for levers that change the
  instrument (3) or need a rebuild (5) or are architectural (6).

The non-negotiable: **a resource shortage produces a clear, logged, actionable message — never a
silent 0-cycle thread death.**

---

## 6. Layer D — How the Framework Catches BUG-1

Replaying the BUG-1 timeline (`dev-bug1rt` RCA **[DOC]**) through the framework:

| Step | Without framework (BUG-1 as it happened) | With framework |
|---|---|---|
| Debug build, online start, SDL3 driver active | — | §3.3 build log already shows debug `addKernel` R0 (e.g. heavier than release) |
| Engine init, after `startAudioDriver()` | nothing | §4.2 pre-flight: `cudaOccupancyMaxActiveBlocksPerMultiprocessor` for debug addKernel × 128 SMs vs grid=56 → if `< 56`, **detected here, before any cycle** |
| First `runSynthesisKernel`, cooperative launch | returns `cudaErrorCooperativeLaunchTooLarge`, **unchecked** → kernel never runs → `*kernel_status` stays 0 → run() breaks at cycle 0 → thread dies → **silent no sound** | launch-return check (§4.2 backstop, = dev-bug1rt FIX-3) catches it; framework runs §5 tree → recommends LEVER 5 (`__launch_bounds__(512,1)` rebuild — exactly dev-bug1rt's fix) or LEVER 4 (scope debug extraction); **logged with recommendation** |
| User experience | "debug doesn't work / no sound", hours of investigation | clear init-time message: "debug addKernel needs ≥1 block/SM under the audio driver; co-residency short by N; recommend `__launch_bounds__(512,1)` or disable live debug extraction" |

The framework **subsumes** dev-bug1rt's tactical fix: FIX-3 (launch-return check) becomes the §4.2
backstop; FIX-2 (`__launch_bounds__(512,1)` debug-only) becomes one instance of LEVER 5 chosen by the
decision tree. The framework adds the **detection-before-launch** and the **recommendation** that the
tactical fix lacks. dev-bug1rt's fix stays as-is; the framework is built around and on top of it.

---

## 7. Layer E — Integration with 4000-Mode Scaling

The [4000-mode proposal](mode-scaling-4000-implementation-proposal-2026-06-06.md) depends on this
framework as its register/occupancy foundation:

- **Shared register budget (scaling §3).** The flat-mode oscillators must be **register-resident**
  (scaling §3, §3.4 — spill = "dramatic deterioration"). Each flat mode adds ~5 regs/thread; at the
  quarter-fork layout `M_t≤1` so ~5 regs/thread total (scaling §4b.3 **[DOC]**). This plan's §1.3
  table is the *same* R0 axis: 56-block co-residency holds up to ~128 regs/thread on the 4090, so a
  release R0 of (measured baseline) + 5 has generous headroom — **confirmed against the measured
  device, not estimated.** The scaling §3.1 SM-budget table (which assumed sm_80/86 caps) is
  **superseded for this machine** by the measured sm_89 numbers here (1536 thr/SM, 24 blocks/SM).
- **Shared `__launch_bounds__` plan (scaling §7.3).** Scaling §7.3 says "add `__launch_bounds__(512,
  minBlocks)` to addKernel to cap regs/thread and pin occupancy deterministically — measure-then-set
  minBlocks." That is **exactly** this plan's LEVER 5 + §3.2 budget. The two are the same instrument;
  this plan provides the framework, the scaling work provides one consumer.
- **Shared pre-flight clamp (scaling §7.5).** Scaling §7.5 recommends the
  `cudaOccupancyMaxActiveBlocksPerMultiprocessor × SM_count` clamp before launch. That **is** this
  plan's §4.2 pre-flight. The scaling work should call the §4.3 shared helper rather than re-deriving
  it.
- **Shared R0 measurement (scaling §12 / Phase 0).** Both this plan (§3.3, §8) and the scaling
  proposal (§12.3 #4, Phase 0) require the same `-Xptxas -v` R0 measurement as the gating
  prerequisite. **Do it once; both consume it.**
- **The cooperative co-residency caveat.** Scaling §4b.5 argues the quarter-fork "does not worsen
  co-residency" because it adds no blocks (modes ride existing 56 string-blocks) — TRUE, but it
  *does* add ~5 regs/thread + a little shared mem, nudging the R0 axis. The §4 pre-flight is the guard
  that confirms the nudge didn't cross the cliff — exactly what scaling §7.5 asks for. If a future
  layout adds *flat blocks* (scaling §5.4 fallback), the grid grows and the §4 pre-flight + §5 tree
  become load-bearing (the same `cudaErrorCooperativeLaunchTooLarge` risk, now from the scaling side).

**Net:** this framework is the substrate scaling §3/§7/§12 already reach for. Implementing it first
(or alongside) means the 4000-mode work inherits the budget table, the build R0 visibility, the
pre-flight helper, and the shortage tree instead of re-deriving them.

---

## 8. Measured vs TO-MEASURE (high-stakes-inference compliance)

| Quantity | Value | Status |
|---|---|---|
| GPU | RTX 4090, sm_89 (Ada) | **[MEAS]** nvidia-smi |
| SM count | 128 | **[MEAS]** cupy `MultiProcessorCount` |
| Max threads/SM | 1536 (Ada — not 2048) | **[MEAS]** |
| Regs/SM | 65536 | **[MEAS]** |
| Regs/block (max) | 65536 | **[MEAS]** |
| Shared/SM | 102400 B (49152 default / 101376 optin per block; 1024 reserved) | **[MEAS]** |
| Max blocks/SM | 24 | **[MEAS]** |
| Warp size | 32 | **[MEAS]** |
| CooperativeLaunch supported | yes | **[MEAS]** |
| `addKernel` grid (Belarus) | 56 blocks (`num_string_arrays()` = 224/4) | **[SRC/MEAS]** (dev-bug1rt) |
| `addKernel` block | 512 threads = (16,32) | **[SRC/MEAS]** |
| Co-residency budget vs R0 (idle GPU) | fits 56 up to ~128 r/t; cliff ~168 r/t | **[MEAS-derived]** |
| Max regs/thread (sm_89) | 255 | **[SPEC]** |
| **R0 — `addKernel` registers/thread (release)** | **UNKNOWN** | **TO-MEASURE: `-Xptxas -v` at build** (§3.3) |
| **R0 — `addKernel` (debug)** | **UNKNOWN** | **TO-MEASURE** |
| R0 — FIR / gauss / parameter kernels | UNKNOWN | TO-MEASURE |
| Runtime `maxActiveBlocksPerSM` under SDL3 driver | UNKNOWN | TO-MEASURE: §4.2 pre-flight at runtime, driver active |
| `a_in==a_out` reciprocity (scaling) | UNKNOWN | TO-MEASURE (scaling §12.2) |

**Phase 0 — Measure (prerequisite, `/dev`-gated, NOT this task):**
1. Add `-Xptxas -v` to `pianoid_cuda/setup.py` nvcc args; `build_pianoid_cuda.bat --heavy --both`;
   capture R0 per kernel per arch from the build log.
2. Runtime: call the §4.2 pre-flight at init *after* `startAudioDriver()`; log `numRegs`,
   `maxActiveBlocksPerSM`, `coopCapacity` vs `gridBlocks` for `addKernel` (release AND debug).
3. Confirm the §1.3 table against the measured R0 — verify the release kernel sits well under 128 r/t
   and the debug kernel's deficit-under-driver matches the BUG-1 RCA.

---

## 9. Phased Implementation (all `.cu/.cpp/.py` edits via `/dev`)

- **Phase 0 — Measure (§8).** `-Xptxas -v` R0 + runtime pre-flight numbers. Gates every budget below.
- **Phase 1 — Build R0 visibility (§3.3).** Add `-Xptxas -v` permanently; document the per-kernel R0
  table in `BUILD_SYSTEM.md`. Low-risk, high-value, no runtime change.
- **Phase 2 — Runtime pre-flight + report (§4).** Add `preflightCooperativeLaunch` helper
  (generalising the FIR clamp `Pianoid_synthesis.cu:467-481`), call at init after the driver starts,
  log the `[OCCUPANCY]` budget line, surface to `/health`. Keep dev-bug1rt's launch-return check as
  the backstop. No behaviour change unless a shortage is detected.
- **Phase 3 — Compile-time budgets (§3.2).** Document + apply `__launch_bounds__` floors per kernel,
  *measure-then-set* (cap ≥ measured R0 so it's a regression guard, not a forced reduction).
  RELEASE changes require N≥3 `note_playback` A/B + per-cycle timing (no regression) per the project
  rules. (dev-bug1rt's debug-only `(512,1)` already covers the debug `addKernel`.)
- **Phase 4 — Shortage decision tree (§5).** Wire the §5 levers into the pre-flight/backstop path;
  emit the ranked recommendation; auto-apply only the safe levers (4, 2-within-band) under policy.
- **Phase 5 — Scaling consumption (§7).** The 4000-mode work calls the shared helper + budget table
  rather than re-deriving (scaling §7.3/§7.5).

---

## 10. Risks & Open Questions

- **Forced register spill from a too-tight `__launch_bounds__` cap on RELEASE** — the "dramatic
  deterioration." Mitigation: set caps at/above measured R0; A/B-perf-verify any release cap; B=1
  already gives 2.3× margin so the cap can stay loose.
- **Pre-flight reports "fits" but runtime fails** (driver contention not modelled by
  `cudaOccupancyMaxActiveBlocksPerMultiprocessor`). Mitigation: run pre-flight after driver start +
  keep the launch-return backstop (§4.2).
- **LEVER 2 (reduce iter) shifts HF timbre/decay** (the documented iter-scaled residual). Mitigation:
  Audio-Verification A/B; present as a quality trade, never silent.
- **Stale-binary R0 mismatch** (a recurring Pianoid trap). Mitigation: §4.3 cross-checks the runtime
  `cudaFuncGetAttributes.numRegs` against the build's ptxas number.
- **Open:** exact R0 per kernel (TO-MEASURE); the runtime contention budget under SDL3 vs ASIO
  (different drivers may consume different SM resources — measure both); whether the FIR kernel's
  cooperative grid ever exceeds capacity at high channel counts (its grid = inputCh×outputCh).

---

## 11. Summary

Today the only register/occupancy control is dev-bug1rt's *reactive, debug-only* band-aid and its
launch-return check. This plan turns that into a **proactive, general, GPU-adaptive framework**:
compile-time per-kernel register budgets with **R0 made visible in the build** (the core
compile-time gap); a **runtime pre-flight** that computes co-residency from the *measured* device +
kernel footprint **before** the cooperative launch; and a **shortage decision tree** that emits
ranked, costed, actionable recommendations (scope debug · `__launch_bounds__` floor · reduce iter ·
reduce strings/modes · non-cooperative fallback) — so a GPU resource shortage is **always detected
and explained, never a silent 0-cycle death (BUG-1)**. The device budget is **measured** on the
RTX 4090 (sm_89); only per-kernel **R0** remains TO-MEASURE, via a single `-Xptxas -v` build that the
4000-mode scaling work needs anyway. This framework is the shared foundation both BUG-1 robustness
and the 4000-mode scaling depend on.

---

### Source references (absolute paths, this session)
- `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\Pianoid_synthesis.cu` (block dims :228-230;
  cooperative launch + dev-bug1rt FIX-3 return-check :345-360; FIR grid-clamp precedent :467-481)
- `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\MainKernel.cu` (dev-bug1rt FIX-2
  ADDKERNEL_LAUNCH_BOUNDS macro :78-95)
- `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\setup.py` (nvcc `-O3 -use_fast_math`, gencode
  80/86/89 — no register flags)

### Doc references (MkDocs `http://localhost:8001/`)
- This plan: `development/proposals/register-memory-management-plan-2026-06-10/`
- BUG-1 RCA: `development/logs/dev-bug1rt-2026-06-10-095401/`
- 4000-mode proposal (§3/§7/§12): `development/proposals/mode-scaling-4000-implementation-proposal-2026-06-06/`
- `modules/pianoid-cuda/SYNTHESIS_ENGINE/#kernel-grid-layout`, `#fdtd-stability-cfl-courant-bound`,
  `#fir-filter-convolution`
- `modules/pianoid-cuda/DEBUG_DATA/#compile-guard`
- `architecture/BUILD_SYSTEM/#build-variants-debug--release`
