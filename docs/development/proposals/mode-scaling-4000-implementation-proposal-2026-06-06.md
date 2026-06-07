# 4000-Mode Two-Tier (Shaped / Flat) Implementation Proposal

**Date:** 2026-06-06
**Author:** design agent (STATIC ANALYSIS ONLY — no builds, no engine runs, no measurements)
**Status:** DESIGN PROPOSAL — not yet implemented. Every `.cu/.cpp/.cuh/.h/setup.py` change
named here MUST go through the `/dev` workflow (CUDA build). This document does not authorise edits.
**Substrate doc (factual base):**
`docs/development/string-mode-coupling-mode-scaling-context-2026-06-06.md`
(read §0c corrected mode↔slot model and §0d block-grouping critique first).

> **Folder note:** `docs/development/proposals/` already existed; this file was added to it.

> **Evidence tags.** **[DOC]** = supported by existing project docs; **[SRC]** = confirmed by
> reading source this session (file:line cited); **[SPEC]** = from published NVIDIA architecture
> specs for the build's target SM (sm_80/86/89), not measured on this machine; **[EST]** = my
> estimate from static reasoning, with the assumption stated; **[UNCERTAIN]** = inferred, must be
> measured before relying on. **Per the project high-stakes-inference rule, no [EST]/[UNCERTAIN]
> number here may drive a code edit until measured.** The measurements are forbidden in this task;
> they are listed in §12.

---

## 1. Summary, Goal, and the Two-Tier Architecture (one page)

**Goal.** Reach **4000 total soundboard resonance modes** in the synthesis engine, up from the
current effective ceiling of **K = num_strings ≈ 224 mode-slots** (196 real on Belarus) **[MEAS,
substrate §3.2/§9]**, without the O(num_strings²) deck-memory and O(num_strings²) coupling-compute
blow-up that "just add strings" would incur (substrate §4/§6).

**The two tiers.**

| Tier | Count (illustrative) | Coupling treatment | Cost / sample | Lives where |
|---|---|---|---|---|
| **SHAPED** (low-freq) | `n_shaped` ∈ [64, 256] | full per-(string,mode) deck weight `deck[s,m]` — *unchanged from today* | O(S·n_shaped) dense reduction | string-block quarter slots (as today), bounded n_shaped ≤ S |
| **FLAT** (HF bulk) | `n_flat = 4000 − n_shaped` | per-group shared coupling vector `w_g(s)` → **separable / piecewise rank-1** | O(S) + O(n_flat) two single sums | **register-resident** oscillators packed onto the ~508 idle threads/block, **grouped by shared coupling** |

**Why this works (the three enabling facts, all SRC-confirmed in the substrate doc):**

1. **The mode oscillator is a single scalar** (`q̈+2γq̇+ω²q=F/m`, ~6 floats of state) while a
   string is ~128-point FDTD. Within a 512-thread block the string machinery uses all 512 threads
   but the oscillator update uses **only 4** (gated `indexInQuarter==0`) — **~508 threads idle of
   mode work** (substrate §0c.1 **[SRC]** `MainKernel.cu:304, 666-676`). Flat oscillators can be
   packed onto those idle threads.
2. **The `num_modes ≤ num_strings` ceiling is an index convention, not hardware.** It is produced by
   `modeNo = numArrays*quarterNumber + blockNo` (`Kernels.cu:253`) + the `indexInQuarter==0` gate —
   both replaceable (substrate §0c.2 **[SRC]**).
3. **"Group by shared coupling" = the flat tier viewed from the scheduler.** Flattening a mode
   *means* replacing its per-string shape `deck[s,m]` with a shared vector `w_g(s)`; modes sharing
   `w_g(s)` factor their string↔mode reductions to **O(S)+O(|G|)** exactly (substrate §0d.1/§0d.3
   **[SRC-grounded algebra]**).

**The performance hinge (this proposal's load-bearing section, §3): flat-mode oscillator state MUST
be register-resident.** The user's explicit warning — performance "deteriorates dramatically" if
flat state spills — is quantified in §3: keeping each flat oscillator's ~5 live floats in registers
vs in global memory is the difference between ~0 extra latency and **~4000 modes × hundreds of cycles
of global-load latency per audio sample**. §3 establishes the register budget, the per-flat-mode
register cost, how many flat modes/thread are register-resident at what occupancy, and the
shared-memory fallback.

**Headline of the kernel change (§7, §4b):** under the **quarter-fork scheduling** (user refinement,
2026-06-06 — see §4b), the kernel **forks on `quarterNumber == 0`**: per block, **quarter 0 → SHAPED
(convolution, unchanged), quarters 1–3 → FLAT (summation)**. The fork is **warp-uniform — a quarter
is exactly 4 warps, zero intra-warp divergence** (§4b.2 [SRC+SPEC]). Drop the `indexInQuarter==0`
single-oscillator gate **for the flat quarters** so their threads each advance a register-resident
oscillator (~27 modes / 128 threads ⇒ **≤1 mode/thread**, ~5 added registers, §4b.3); keep the gate
for the shaped quarter. The flat modes **ride the existing ~56 string-blocks' spare quarters — NO new
blocks** (§4b.5), so the block count stays **<64, respecting `SEGMENT_FOR_SHUFFLE_SUMMATION=64`**, and
co-residency is not worsened. Add one block-local reduction per flat quarter for feedin and one for
feedback (`Σ q(m)` factored), in addition to the unchanged shaped path. **SHAPED COUNT — RESOLVED
(user, 2026-06-06): exactly ONE shaped mode per block in quarter 0, running the current per-mode
logic unchanged; quarters 1–3 hold ~25–30 FLAT modes each (~80/block). Real shaped ≈ 1 × ~56 blocks
≈ 56 modes — the shaped path = today's per-quarter code restricted to quarter 0 (§4b.4).** Constants,
allocations, and the Python/JS plumbing follow (§7–§8).

---

## 2. Corrected Mode↔Slot Model — the Enabling Change (recap of substrate §0c)

The current kernel addresses modes through a **string-geometry-derived index**, baked per-thread at
packing time:

```
Kernels.cu:253   modeNo = numArrays * quarterNumber + blockNo;     // range {0 .. num_strings-1}
Kernels.cu:298   parameters[start_ind + 25*arraySize + idx] = modeNo;   // baked per-thread tag
MainKernel.cu:178 modeNo = parameters[start_ind + 25*arraySize + stMdIndex];  // read back
MainKernel.cu:304/666  if (indexInQuarter == 0) { ... oscillator update ... }   // 4 threads/block
MainKernel.cu:288 __shared__ real s_mode[MAX_NUM_STRINGS_IN_ARRAY];   // size 4 — room for 4 live modes
```
**[SRC]**

**The three changes that lift the ceiling (substrate §0c.2/§0d.5):**

1. **Drop the `indexInQuarter==0` gate** for the flat path so more than one thread per 128-wide
   quarter advances an oscillator (use the idle threads with a stride / a per-thread register loop).
2. **Widen the `modeNo` range** — replace `modeNo = numArrays*quarterNumber+blockNo` for flat modes
   with an index whose extent is `M_block × numArrays` (M_block = flat modes per block). The shaped
   tier keeps the existing formula (it still needs ≤ S slots).
3. **Grow the mode-state working set** — `s_mode[4]` (shared) is replaced for the flat tier by a
   **per-thread register array** `real q_flat[M_t]`, `real qprev_flat[M_t]` (§3), NOT a larger
   shared array. (A larger shared array is the fallback in §3.6; the register form is the target
   because of the user's performance warning.)

> This is *only* about where the flat oscillators live and how they're indexed. The shaped tier's
> placement is untouched. The substrate doc is explicit (§0d.2 **[SRC]**) that grouping/flattening
> is valid **only** for the flat tier — shaped modes have distinct shapes by design and must not be
> grouped.

---

## 3. ★ Register-Memory Analysis (the performance foundation)

> **This section is the deliverable's load-bearing analysis.** The user's premise: if flat-mode
> oscillator state is not register-resident, throughput "deteriorates dramatically." Below I (a)
> establish the GPU register budget for the build's target SM, (b) estimate the current kernel's
> register usage, (c) count the minimal per-flat-mode register set, (d) compute how many flat modes
> a thread can own register-resident and the occupancy retained, (e) quantify the catastrophic
> global-memory alternative, and (f) analyse the shared-memory fallback.

### 3.1 The GPU register budget — target SM and the numbers

**Target SM.** The build compiles `cuda_arch_list = ["80","86","89"]` **[SRC**
`build_config.json:12-16`, `setup.py:127, 250-251]** → **sm_80 (A100), sm_86 (Ampere consumer,
RTX 30xx / A40), sm_89 (Ada, RTX 40xx)**. No specific device is pinned in the build; analyse for the
**Ampere/Ada class** and parameterise. The dev machine GPU model is not determinable from the repo
without running `nvidia-smi` (forbidden here) → **[UNCERTAIN device]**; the per-SM register-file
size and limits below are **uniform across sm_80/86/89** so the analysis holds for any of them.

| Quantity | Value (sm_80/86/89) | Source |
|---|---|---|
| Register file per SM | **65,536** 32-bit registers (256 KB) | **[SPEC]** NVIDIA Ampere/Ada tuning guides |
| Max registers per thread | **255** | **[SPEC]** |
| Max threads per SM | **2,048** (sm_80/86); **1,536** (sm_89 Ada) | **[SPEC]** |
| Max resident warps/SM | 64 (sm_80/86); 48 (sm_89) | **[SPEC]** |
| Max resident blocks/SM | 32 (sm_80/86); 24 (sm_89) | **[SPEC]** |
| Register allocation granularity | 256 regs per warp (8 regs/thread, rounded) | **[SPEC]** |
| `real` type | **float (32-bit)** → 1 register/value | **[SRC]** `pianoid_types.h:6,16` |

**The occupancy ↔ registers/thread trade (the core constraint).** Resident warps per SM is capped by
whichever binds first:

```
warps_by_regfile = floor( 65536 / (regs_per_thread × 32) )         # register-file limit
warps_resident   = min( warps_by_regfile, hw_warp_cap, block-count limit, shared-mem limit )
occupancy        = warps_resident / hw_warp_cap
```

For sm_80/86 (hw cap 64 warps = 2048 threads):

| regs/thread | warps by reg-file | occupancy (of 64) |
|---|---|---|
| 32 | 64 | 100% |
| 40 | 51 | 80% |
| 48 | 42 | 66% |
| 64 | 32 | 50% |
| 96 | 21 | 33% |
| 128 | 16 | 25% |
| 168 | 12 | 19% |
| 255 | 8 | 12.5% |

**[SPEC-derived arithmetic.]** This is the table every later estimate trades against: **each extra
flat oscillator a thread owns adds ~5 registers (§3.3) → moves down this table.**

### 3.2 Current kernel register usage (static estimate — NOT measured)

The build has **no register-control flags**: no `-maxrregcount`, no `__launch_bounds__`, no
`-Xptxas`, no `cudaFuncSetAttribute` anywhere **[SRC** — grep over `pianoid_cuda/` returned no
matches; `setup.py:296` release flags are only `-O3 -use_fast_math]**. So nvcc chose register count
freely at compile time; the actual number is **unknown without `-Xptxas -v` or a profiler**
(forbidden here).

The substrate doc cites the existing technical doc: **"~20–30 registers/thread, ~3 KB shared, block
= 512 threads"** **[DOC** substrate §4 ← `COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md:1291-1296]**.
Reading `addKernel` (`MainKernel.cu:100-768`) the per-thread live set is large: dozens of
`parameters[...]` scalars (`stringNo, firstStringNo, modeNo, indexInQuarter, quarterNumber, …`), the
`mode_feedin[3]/mode_feedback[3]/foldedIndexInQuarter[3]/modeIndexInQuarter[3]` fold arrays
(`:233-236`), FDTD locals (`sa__2..sa_2, d3, d3_1, target, s_b`), and the limiter block. A compiler
that is not register-capped on a 512-thread, `-O3` kernel of this size **plausibly sits well above 30
— I estimate 40–80 regs/thread [EST; assumption: typical nvcc behaviour for an un-capped large
fused kernel on sm_86; the 20–30 figure in the old doc may predate later kernel growth (limiter,
2nd-derivative, fold loops)].** **This MUST be measured with `-Xptxas -v` before the design's
occupancy headroom is trusted (§12).** The number matters because the flat oscillators' registers
*add on top of* whatever the current kernel already uses.

> **Design consequence of the current kernel being un-capped:** adding M_t flat oscillators (each
> ~5 regs) to an already-large kernel risks pushing total regs/thread up the §3.1 table fast. The
> design (§7) therefore **considers `__launch_bounds__(512, minBlocksPerSM)` or a `-maxrregcount`**
> to *cap* and thereby control occupancy deterministically rather than let nvcc spill silently.

### 3.3 Per-flat-mode register cost — the minimal set

The flat oscillator's recurrence, copied from the current update (`MainKernel.cu:668-672`):

```
result = ((2·q − q_prev) + q_prev·dec − q·omega + F_applied·mass_inv) · (1 − dec);
q_prev = q;  q = result;
```

Per flat mode `m`, classify each value as **per-mode (must be owned)** vs **shared/derivable**:

| Value | Per-mode? | Register cost | Note |
|---|---|---|---|
| `q(m)` (current displacement) | **per-mode** | 1 | MUST stay resident across samples |
| `q_prev(m)` | **per-mode** | 1 | MUST stay resident across samples |
| `dec(m)` (damping) | per-mode but **read-only** | 1 if cached in reg; 0 if re-read | physics axis — distinct per mode (substrate §0d.4 #4 **[SRC]**) |
| `omega(m)` (≈ω²·dt²) | per-mode read-only | 1 if cached; 0 if re-read | physics axis, distinct |
| `mass_inv(m)` | per-mode read-only | 1 if cached; 0 if re-read | physics axis, distinct |
| `a_in(m)` (feedin gain) | per-mode read-only | 1 if cached; 0 if re-read | scalar replaces the deck column |
| `a_out(m)` (feedback gain) | per-mode read-only | 1 if cached; 0 if re-read | may equal a_in by reciprocity → save 1 |
| `F_applied(m)` (per-sample force) | per-mode transient | 1 (reused each sample) | = a_in(m)·groupForceSum; transient |
| group's `w_g(s)` | **shared across group** | 0 per mode | one vector per group, not per mode |
| group force sum `Σ w_g(s)·bridge(s)` | **shared across group** | 0 per mode | computed once/group/sample |

**Two register regimes:**

- **Minimal resident set (state-only): `q, q_prev` = 2 registers/mode.** The 5 read-only constants
  (`dec, omega, mass_inv, a_in, a_out`) are **re-read from global each sample** rather than held.
  This is the smallest register footprint but trades registers for memory traffic — acceptable only
  if those reads are coalesced and L2/L1-cached (they are read-only, same address each sample, so
  they stay hot in cache → near-register latency after the first sample). **[EST; assumption:
  read-only per-mode constants laid out contiguously stay L1/L2-resident; verify with profiler.]**
- **Full resident set (state + cached constants): ~5–7 registers/mode** (`q, q_prev` + cached
  `dec, omega, mass_inv` + optionally `a_in`/`a_out`). Zero per-sample memory traffic for the
  oscillator advance, at higher register pressure.

**Working figure for the design: ~5 registers per register-resident flat mode** (q, q_prev, and 3
cached physics constants; a_in/a_out re-read or folded). The 2-register minimal regime is the
fallback if occupancy is too low (§3.5). **[EST; assumption stated.]**

### 3.4 The design math — how many flat modes fit register-resident, and the occupancy retained

Let **R0** = the kernel's *baseline* regs/thread without flat oscillators (§3.2, MUST be measured;
use 48 as a working placeholder **[EST]**), **r** = regs per flat mode (≈5, §3.3), **M_t** = flat
modes owned per thread, **T** = 512 threads/block, **B_flat** = blocks doing flat work.

```
regs_per_thread(M_t) = R0 + r · M_t
flat_modes_per_block = M_t · T_active            # T_active = threads advancing flat modes
```

With the gate dropped, up to all 512 threads can advance flat modes. Take **T_active = 512** (every
thread owns M_t flat modes). Then flat modes per block = 512·M_t. To cover **n_flat ≈ 4000** flat
modes:

```
needed (modes·block) = 4000  ⇒  with one block: M_t = ceil(4000/512) = 8 flat modes/thread
                              ⇒  with two blocks: M_t = 4;  four blocks: M_t = 2
```

**Register cost and occupancy at each option** (R0 = 48 placeholder, r = 5, sm_86 64-warp cap):

| Layout | M_t | flat regs added (r·M_t) | total regs/thread | occupancy (§3.1) | verdict |
|---|---|---|---|---|---|
| all 4000 in **1 block** | 8 | 40 | 88 | ~33% (21/64 warps) | works; that one block under-occupies but it is 1 of many SMs' worth |
| 4000 across **2 blocks** | 4 | 20 | 68 | ~47% | good balance |
| 4000 across **4 blocks** | 2 | 10 | 58 | ~55% | best occupancy; 2 modes/thread is comfortably register-resident |
| 4000 across **8 blocks** | 1 | 5 | 53 | ~60% | each thread owns 1 flat mode; trivially register-resident |

**[EST — every row depends on the unmeasured R0; the *shape* of the trade (more modes/thread ⇒ more
regs ⇒ lower occupancy) is [SPEC]-solid, the absolute occupancy is [EST].]**

**The sweet spot.** Spreading the 4000 flat modes across **~4–8 flat blocks** keeps **M_t ≤ 2** (≤10
added registers), so the flat oscillators are **comfortably register-resident with ~55–60%
occupancy** and almost no occupancy penalty vs the shaped-only kernel. This aligns with the
substrate doc's §0d.4 #6 conclusion ("many blocks, each holding one shared-coupling group") — the
group count naturally gives you several flat blocks, each owning a sub-thousand-mode group at
M_t ≤ 2. **The register verdict: at the realistic multi-block / multi-group layout, ALL flat-mode
state is register-resident at M_t ∈ {1,2}, costing ~5–10 extra registers/thread and retaining
~55–60% occupancy — no register spill, no shared-memory fallback needed.** The single-block layout
(M_t=8) also fits without spill (88 regs < 255) but at lower occupancy and is not recommended for the
full 4000.

> **★ Superseded by the quarter-fork layout (§4b).** This sub-section's "T_active=512, spread across
> 4–8 *flat blocks*" model predates the user's 2026-06-06 quarter-fork refinement. Under the
> quarter-fork the flat modes ride the **existing ~56 string-blocks** (NOT new flat blocks, §4b.5),
> 3 flat quarters × 128 threads = 384 flat threads/block, with only ~27 modes/flat-quarter ⇒
> **`M_t ≤ 1`** (§4b.3). That is the **most** favourable register row above (≤5 added regs,
> ~55–60% occupancy), so the §3.4 register-residency verdict holds *a fortiori*. Read §4b.3 for the
> reconciled mapping; this sub-section's relative ordering of options is retained as background.

### 3.5 Why register-residency matters — quantifying the "dramatic deterioration"

If the flat oscillator state `q, q_prev` lived in **global memory** instead of registers, every
sample every flat mode would do: 2 global loads (q, q_prev) + 2 global stores (q, q_prev) + 5
constant loads. Global-memory latency on Ampere/Ada is **~400–800 cycles** for an L2-miss, ~200 for
an L2 hit **[SPEC]**. Per audio sample:

```
4000 flat modes × (≥4 global accesses) = ≥16,000 global transactions / sample
per cycle (samplesInCycle, e.g. 48) → ≥768,000 global transactions / cycle, JUST for flat oscillators
```

Even fully L2-resident (~200 cyc) and perfectly coalesced (the substrate §0d.4 #1 coalescing rewrite
is *required* to get even that), this is **hundreds of thousands of cycles of memory latency the
register form pays ZERO of** — the oscillator advance in registers is ~6 FLOPs and 0 memory ops
after the constants are cached. This is precisely the "deteriorates dramatically" the user warns of:
the flat tier's whole value (turning O(S×n_flat) coupling into O(S)+O(n_flat)) is **negated if the
O(n_flat) part is paid at global-memory latency instead of register latency.** The register-resident
design (§3.4) is therefore not an optimisation — it is a correctness condition for the performance
goal. **[SPEC for latencies; EST for the aggregate; the point is order-of-magnitude, robust to the
exact latency.]**

### 3.6 Shared-memory fallback (if register pressure forces spill)

If R0 (measured) turns out high enough that even M_t=1 pushes regs/thread past the spill threshold
(unlikely given 255 max, but possible if R0 ≳ 200), the fallback is **shared memory**, not global:

- A 512-thread block has 64 KB / 100 KB / 164 KB shared mem available per SM depending on carveout
  (sm_86: up to 100 KB, sm_89: up to 100 KB) **[SPEC]**. The current kernel uses ~3 KB shared
  **[DOC]**, so there is large headroom.
- A flat-mode shared array `real s_qflat[flat_modes_per_block]` at 4000/8 = 500 modes/block × 2
  (q,q_prev) × 4 B = **4 KB/block** — trivial. Even 4000 in one block = 32 KB, still fits the 100 KB
  carveout. **[EST.]**
- **Shared-mem latency (~20–30 cycles) is ~10× worse than registers but ~10× better than global**
  — an acceptable middle ground. But shared has its own occupancy cost (shared/block caps resident
  blocks) and bank-conflict risk on the strided `q_flat` access (the §0d.4 #1 coalescing concern
  reappears as bank conflicts). **Prefer registers; use shared only if the profiler shows spill.**

**Fallback decision rule (to apply once R0 is measured):** if `R0 + 5 ≤ ~168` (≥19% occupancy at
M_t=1), keep flat state in registers. Else move `q,q_prev` to shared and cache only constants in
registers. **[EST rule; finalise after the §12 register measurement.]**

---

## 4. SHAPED Tier Design

**Keep the current treatment verbatim.** The shaped tier is exactly today's coupling: per-(string,
mode) deck weights `deck[s,m]`, scattered into `feedin_cycle_matrix`/`feedback_cycle_matrix` over
`NUM_FOLDS_IN_QUARTER` folds and reduced by `sumArray` (`MainKernel.cu:438-444, 619-625, 469, 641`)
**[SRC]**, with the per-mode oscillator on the `indexInQuarter==0` thread. Substrate §0b.1/§0d.2
establish this must not be grouped/flattened — the distinct shapes are the feature.

**Bounding / allocation:**

- **`n_shaped ≤ S` (num_strings).** The shaped placement still uses
  `modeNo = numArrays*quarterNumber+blockNo` (range ≤ S), so shaped count is capped by the string
  carrier. With S ≈ 224–256 today and `n_shaped` chosen in [64, 256], shaped fits with no string
  growth. **[SRC for the ceiling, §3.3 substrate.]**
- **Shaped deck stays `S × n_shaped`** in `dev_deck_parameters` (small — 256×256 ≈ 256 KB at most,
  ~current `DECK_SIZE` `PresetParameters.h:40,64` **[SRC]**). Column dimension shrinks from
  `num_strings` (padded) to `n_shaped` once the flat modes no longer ride the deck (§6).
- **Shaped oscillator state** (`q,q_prev,dec,omega,mass_inv`) stays in `dev_mode_state` /
  `dev_mode_running` for indices `[0, n_shaped)`.

No kernel-math change to the shaped path; only the loop bound changes from "all modes" to
"`modeNo < n_shaped`" (§7).

---

## 4b. ★ QUARTER-FORK SCHEDULING — the per-block SHAPED/FLAT layout (2026-06-06 refinement)

> **This section integrates the user's architectural refinement (2026-06-06, verbatim intent):**
> *"modes should be spread evenly across the blocks, so maximum will be roughly 80 modes/block. In
> each block ONE QUARTER should be dedicated to the SHAPED modes, the rest of the quarters to FLAT
> modes, roughly 27 modes per quarter. The logic should FORK at quarterNumber == 0 to go convolution
> or summation."*
>
> Concretely: **per block → quarter 0 = SHAPED (convolution), quarters 1–3 = FLAT (summation)**;
> ~80 modes/block; ~27 modes/quarter; ~50 blocks for 4000 modes; the kernel branches on
> `quarterNumber == 0`. This section grounds that against the kernel, **confirms the warp-alignment
> claim**, derives the thread↔mode mapping and register budget under THIS layout, and surfaces one
> open question (the SHAPED-COUNT implication, §4b.3) that the user must decide before implementation.

### 4b.1 MECHANISM — the quarter structure, grounded [SRC]

The block is launched `cudaLaunchCooperativeKernel(addKernel, grid=num_string_arrays,
blockSize)` with **`blockSize = dim3(array_size/32, 32) = dim3(16, 32)` = 512 threads**
(`Pianoid_synthesis.cu:229-230, 345` **[SRC]**). Inside the kernel two distinct linearisations of the
512 threads coexist (`MainKernel.cu:144-147` **[SRC]**):

```
pointIndex = threadIdx.y + threadIdx.x * WARP_SIZE        // string-FDTD layout (segment-of-32, bank-conflict avoidance)
stMdIndex  = threadIdx.y * blockDim.x + threadIdx.x       // mode/coupling layout ("done directly for the warp shuffle to work correctly")
```

The quarter machinery rides `stMdIndex` (`MainKernel.cu:173-176` **[SRC]**):

```
quarterSize    = arraySize / numStringsInArray = 512/4 = 128
indexInQuarter = stMdIndex % quarterSize           // 0..127
quarterNumber  = stMdIndex / quarterSize           // 0..3  (one per string-in-block)
modeNo         = parameters[... 25*arraySize + stMdIndex]   // baked at packing = numArrays*quarterNumber + blockNo  (Kernels.cu:253)
```

So **`quarterNumber ∈ {0,1,2,3}` partitions the 512 threads into four contiguous 128-thread bands by
`stMdIndex`.** A fork `if (quarterNumber == 0) { …convolution… } else { …summation… }` cleanly routes
the 128 threads of band 0 to the shaped path and the 384 threads of bands 1–3 to the flat path. The
oscillator update today is additionally gated `indexInQuarter == 0` (`MainKernel.cu:304, 667` **[SRC]**)
→ stMdIndex ∈ {0,128,256,384} → exactly 4 threads/block advance one oscillator each. The quarter-fork
proposal **drops that inner gate for the flat bands** (so all 384 flat threads can advance
oscillators) while **keeping it for the shaped band** (band 0 keeps its existing single-oscillator-
per-quarter convolution treatment, or is widened — see §4b.2).

### 4b.2 ★ WARP-ALIGNMENT VERDICT — CONFIRMED (the fork is warp-uniform) [SRC + SPEC]

**The user's premise is correct: the `quarterNumber` fork is warp-aligned with NO intra-warp
divergence.** Proof from the launch geometry:

- CUDA assigns hardware warp lanes by the linear thread index
  `threadIdx.x + threadIdx.y·blockDim.x + threadIdx.z·blockDim.x·blockDim.y` **[SPEC** — CUDA
  programming model, warp lane assignment]**. With `blockDim = (16, 32, 1)` this is
  `threadIdx.x + threadIdx.y·16` = **exactly `stMdIndex`** (`MainKernel.cu:147` **[SRC]**). So
  `stMdIndex` IS the hardware linear thread index → **warp `w` = the 32 threads with
  `stMdIndex ∈ [32w, 32w+31]`**, contiguous.
- A quarter is `quarterNumber = stMdIndex / 128` → quarter `q` = `stMdIndex ∈ [128q, 128q+127]` =
  **warps `{4q, 4q+1, 4q+2, 4q+3}` — exactly 4 whole warps, no warp split across the boundary**
  (128 = 4·32). Therefore `quarterNumber` is **constant within every warp** → a branch on
  `quarterNumber == 0` (or any function of `quarterNumber`) is **warp-uniform: zero intra-warp
  divergence.** Quarter 0 = warps 0–3 (shaped); quarters 1–3 = warps 4–15 (flat). **[SRC-grounded
  from the launch dims + SPEC warp-lane rule.]**

> **Correction to the substrate's §0d.4 #1 divergence worry.** The substrate flagged "warp
> divergence (those K threads branch differently)" as a gotcha for packing oscillators. That worry
> applies to the **current `indexInQuarter == 0` gate**, which fires only lane 0 of warps 0/4/8/12 —
> that IS intra-warp divergent (1 of 32 lanes active). The **quarter-fork layout REMOVES that
> specific divergence for the flat path**: forking on `quarterNumber` is warp-uniform, and dropping
> the `indexInQuarter==0` gate so all 128 threads of a flat quarter advance oscillators makes the
> flat oscillator advance **fully warp-converged**. The quarter-fork is therefore *better* on
> divergence than the substrate feared, not worse. **[SRC-grounded.]** The residual divergence
> concern is only at the shaped/flat *block-level* coexistence (warps 0–3 doing convolution while
> 4–15 do summation), which is **inter-warp**, not intra-warp — warps are independently scheduled, so
> this is a scheduling/occupancy question, not a divergence penalty. **[SPEC.]**

### 4b.3 THREAD↔MODE MAPPING + REGISTER RECONCILIATION under the quarter-fork

**The numbers, derived from "~80 modes/block, ~50 blocks, 1 shaped quarter + 3 flat quarters":**

```
4000 modes / ~50 blocks            = ~80 modes / block          [EST, user's figure]
~80 modes/block / 4 quarters       = ~20 modes / quarter        (uniform) — user says "~27/quarter"
```

> **Arithmetic reconciliation [EST].** 80/4 = 20, not 27. The user's "~27 modes/quarter" is
> internally consistent with a *different* split: if the ~80 modes/block are **concentrated in the 3
> flat quarters** (shaped quarter carrying few/zero real modes), then 80/3 ≈ **27 modes per flat
> quarter** — which matches the user's "~27" exactly and implies the shaped quarter is **lightly
> populated**. Alternatively, if all 4 quarters carry equal real modes it is ~20/quarter and the
> shaped count is large (§4b.4). **The "27" figure itself is evidence for the lightly-populated-
> shaped-quarter interpretation** — flagged in §4b.4 for the user to confirm.

**Thread↔mode mapping (flat quarters).** Each flat quarter = 128 threads. With ~27 (or ~20) modes
mapped onto 128 threads, the natural mapping is **≤1 mode per thread** — assign mode `j` of the
quarter to thread `indexInQuarter == j` (the first ~27 threads of the quarter own one oscillator
each; threads 27–127 own zero). This is **register-trivial**: `M_t ≤ 1` for almost every thread.
Packing (`M_t = ceil(27/128) = 1`) is unnecessary — there are 128 threads for 27 modes, ~4.7×
headroom. Contrast §3.4's earlier analysis which assumed `T_active = 512` threads spreading
512·M_t modes/block and asked how many modes/thread; **under the quarter-fork the flat modes are so
sparse per quarter that the spread is ≤1 mode/thread with room to spare.**

> **Register reconciliation with §3.** §3.3 priced a flat oscillator at **~5 registers**
> (`q, q_prev` + 3 cached physics constants) **[EST]**. §3.4 found `M_t ≤ 2` keeps occupancy
> ~55–60%. **Under the quarter-fork, `M_t ≤ 1` for the flat threads** → flat oscillators add **≤5
> registers/thread**, the *most* favourable row of §3.4's table (the "8 blocks / M_t=1 / ~60%
> occupancy" row). So the quarter-fork layout lands at or below §3's best-case register budget — it
> is *easier* register-wise than §3 conservatively assumed, because spreading across ~50 blocks ×
> 384 flat threads = ~19,200 flat-thread-slots for 3000–4000 flat modes ⇒ ~0.15–0.2 modes/thread
> on average. **The §3 register-residency conclusion holds a fortiori: ALL flat state is
> register-resident, no spill, ~5 added registers, ~55–60% occupancy.** [EST; the absolute
> occupancy still depends on the unmeasured baseline R0 (§3.2) — only the *delta* (~5 regs) is firm.]**

> **Idle-thread note [EST].** With ~27 modes in a 128-thread quarter, ~100 threads/flat-quarter do
> no oscillator work — the layout *re-introduces* the very idle-thread waste §0c identified, just at
> a different granularity. This is **acceptable** because (a) those idle threads cost no registers/
> occupancy beyond the block's resident footprint, (b) the flat oscillator advance is ~6 FLOPs so
> even 27/128 utilisation is negligible compute, and (c) the 128 threads are still needed *as a
> group* for the per-quarter reduction (the `sumArray` warp-shuffle needs the full warp population).
> The user could pack tighter (more modes/quarter, fewer blocks) to raise utilisation, but that
> trades against the SHAPED-count and per-mode register budget — see §4b.4. **[EST.]**

### 4b.4 ★ SHAPED-COUNT — RESOLVED (user decision, 2026-06-06)

**RESOLUTION: exactly ONE shaped mode per block, in quarter 0, with all current per-mode logic
retained unchanged; quarters 1–3 hold ~25–30 FLAT modes each (~80 modes/block).** → Real shaped
count ≈ 1 × ~56 blocks ≈ **56 shaped modes** (one per string-block — even smaller than interpretation
B). The shaped path is therefore **today's per-quarter shaped code kept only in quarter 0**: currently
the shaped (1-mode-per-quarter) path runs in all 4 quarters/block (~4 shaped/block); the change is to
keep it in quarter 0 ONLY and convert quarters 1–3 to flat packing. Convolution cost ≈ today's
(≈1 shaped mode/block, as now). This is neither interpretation A nor B below — it is the cleanest
reading and preserves the two-tier economics maximally. The A/B analysis below is retained as the
decision record.

> **★ IMPLEMENTATION NUANCE (for the /dev phase):** "retain current logic" applies to quarter 0's
> single shaped mode. The kernel edit keeps the existing shaped per-mode path for `quarterNumber==0`
> and routes `quarterNumber∈{1,2,3}` to the new flat packing+summation. Effectively all current HF
> modes beyond the one lowest-per-block become flat — exactly the §0b.7 intent.

---

_(historical — the question as originally posed, retained as the decision record:)_ The user's layout
says **"in EACH block ONE QUARTER is dedicated to SHAPED."** Taken literally with a uniform
population, that has a large, possibly-unintended consequence:

```
1 shaped quarter/block × ~50 blocks × ~27 (or ~20) modes/quarter
   = ~1,350 shaped modes  (at 27/quarter)   OR   ~1,000 shaped modes (at 20/quarter)
   = ~25–34% of the 4000 are SHAPED (full per-(string,mode) convolution)
```

This is **5–20× the proposal's prior "small SHAPED set, n_shaped ∈ [64, 256]" assumption** (§1, §4,
§9). Two interpretations, both plausible from the user's words, with very different cost — **this is
the load-bearing decision and must be the user's, not the agent's:**

| | **Interpretation A — Uniform block layout (literal)** | **Interpretation B — Mostly-dummy shaped quarters** |
|---|---|---|
| Shaped quarter population | every block's quarter 0 holds ~20–27 **real** shaped modes | only the **first N blocks** carry real shaped modes in quarter 0; the rest have a quarter 0 that is **dummy/unpopulated** (placeholder, `modeNo` ≥ n_shaped or ID=−1) |
| Real shaped count | **~1000–1350** (~25–34% of 4000) | **small, ~64–256** (matches §1/§4/§9) — e.g. n_shaped=256 → only first ~10–13 blocks have a populated shaped quarter |
| Convolution cost | **O(S × ~1300)** per sample — the expensive dense reduction over ~1300 modes; ~5–20× the prior shaped budget | **O(S × ≤256)** — the cheap, bounded shaped cost the whole two-tier design was built around |
| Deck memory (shaped) | `S × ~1300` ≈ 224×1300 ≈ 1.1 MB | `S × 256` ≈ 256 KB (≈ current) |
| Layout uniformity | every block identical (clean SIMT, simplest packing/index math) | blocks heterogeneous (first N "have shaped", rest "all-flat") — slightly more complex packing |
| Matches user's "~27/quarter"? | only if shaped quarter also ~27 (then ~1350 shaped) | yes — flat quarters carry the ~27; shaped quarter mostly empty |
| Audio implication | far more HF modes kept shape-aware → *higher fidelity*, *higher cost* | HF bulk flattened as the §0b.7 perceptual argument intends |

**Cost driver to make explicit:** the convolution (shaped) cost scales with the **real** shaped
count, NOT with the number of reserved shaped quarters. Reserving a shaped quarter in every block is
*free* if those quarters are dummy (Interpretation B); it is *expensive* only if they hold real
shaped modes (Interpretation A). So the question is purely: **how many of the 4000 are genuinely
shaped?**

> **★ EXPLICIT QUESTION FOR THE USER (blocking before implementation):** Do you intend
> **(A)** a uniform layout where every block's shaped quarter holds real shaped modes — accepting
> **~1000–1350 shaped modes (~25–34% of 4000)** at ~5–20× the convolution cost of the original
> "small shaped set" plan (higher fidelity, higher cost) — **or (B)** a uniform *reserved-slot*
> layout where the shaped quarter exists in every block for index regularity but is **populated only
> in the first N blocks** (real shaped count stays small, ~64–256, per §9's variance-driven
> boundary), the remaining shaped quarters carrying dummy modes? **Interpretation B preserves the
> two-tier design's core economics (§0b.4); Interpretation A is a deliberately higher-fidelity, more
> expensive instrument.** The "~27 modes/quarter" figure leans toward B (flat quarters carry the
> ~27, shaped quarter near-empty), but the "one quarter dedicated to shaped in each block" wording
> leans toward A. **This is not the agent's call.** [EST/UNCERTAIN — both are coherent readings; the
> convolution cost difference (~256 vs ~1300 shaped modes) is the whole point of the two-tier split,
> so it must be the user's explicit decision.]**

### 4b.5 BLOCK-COUNT vs CONSTRAINTS — mode-blocks ARE the string-blocks (pivotal finding)

**Finding: under the quarter-fork, the mode-blocks are the SAME blocks as the string-blocks — modes
ride the existing string blocks' spare quarters/threads. They are NOT new mode-dedicated blocks.**
[SRC-grounded] This follows directly from the kernel structure:

- The grid is `gridDim.x = numArrays = numStrings/numStringsInArray` blocks (`MainKernel.cu:121`,
  `Pianoid_synthesis.cu:345` **[SRC]**). Each block already binds 4 strings (the FDTD work on all
  512 threads) AND hosts 4 mode-oscillators (one per quarter, `indexInQuarter==0`). Modes already
  *co-habit* the string blocks today (§0c.1). The quarter-fork keeps that co-habitation and merely
  **uses more of each block's idle threads** for modes — it does **not** add a separate `gridDim`
  partition. **[SRC.]**
- So "~50 blocks for 4000 modes" must reconcile with the **string** block count. Today
  `numStrings ≈ 224, nsa = 4 → numArrays ≈ 56 string-blocks` (substrate §9 **[MEAS-derived]**). The
  user's "~50 blocks" ≈ the existing ~56 string-blocks. **The 4000 modes are spread across the
  EXISTING ~56 string-blocks** (4000/56 ≈ 71 modes/block, close to the user's "~80"), 4 quarters
  each. **No new blocks are created; the block count stays = numArrays (string-driven).** [SRC-grounded
  arithmetic.] This is the §8-Tier-B "cheaper route" (substrate §8.3 #7 note) realised concretely:
  re-index modes onto spare per-block threads rather than inventing a mode grid dimension.

> **Consequence for the "decouple modes from strings" goal:** the quarter-fork does **NOT** fully
> decouple the mode count from the block count — block count is still `numStrings/nsa`. But it
> decouples the mode count from `numStrings` *as a 1:1 ceiling*: each block now carries ~80 modes
> instead of 4, so 4000 modes fit on ~56 blocks (≈ today's count) **without raising numStrings to
> 4000.** The O(S²) deck blow-up is avoided (deck width stays driven by n_shaped, not 4000). This is
> exactly the substrate §0c.2 escape route. **[SRC-grounded.]**

**SEGMENT_FOR_SHUFFLE_SUMMATION = 64 — RESPECTED (a plus of this layout).** The reduction segment
must be ≥ block count and ÷32 (`constants.h:90`, `MainKernel.cu:469, 641` **[SRC]**). Because the
quarter-fork keeps the block count at `numArrays ≈ 50–56` (NOT raising numStrings), **block count
≈ 50–56 < 64 = SEGMENT — the layout stays UNDER the segment limit with no change to SEGMENT.** This
is a genuine advantage over the §6 "raise numStrings to 4000" path, which would push block count to
~1000 and demand SEGMENT ≥ 1024 (and silently corrupt if forgotten — substrate §8.1 #1). **The
quarter-fork respects SEGMENT=64 as-is.** [SRC-grounded — but see the caveat below.]

> **CAVEAT on SEGMENT [SRC + UNCERTAIN].** SEGMENT bounds the *block-count* axis of the reductions,
> which the quarter-fork leaves at ≈56 ✓. BUT the quarter-fork ADDS a **new reduction axis**: the
> per-flat-quarter `groupForceSum_g` (feedin) and `modeSum_g = Σ a_out·q` (feedback) over the flat
> modes (§5.2). Those are *block-local* reductions over ~27 modes (well within a warp/quarter), NOT
> SEGMENT-wide cross-block shuffles — so they do **not** stress SEGMENT. The existing SEGMENT-wide
> `sumArray` (feedin/feedback cycle-matrix reduction across blocks, `MainKernel.cu:469, 641`) is
> unchanged in width. **Net: SEGMENT=64 is respected; the new flat group-sums are a separate,
> smaller, intra-block reduction.** Verify the flat group-reduction does not accidentally reuse the
> SEGMENT-wide `feedin_cycle_matrix` path at block-count width — [UNCERTAIN until the kernel edit
> is written; flagged for the §7 change.]**

**Cooperative-grid co-residency — UNCHANGED, still binding but NOT worsened.** The grid stays
`numArrays ≈ 56` cooperative blocks (the same grid that launches today), so co-residency is **no
harder than the current working kernel** — the quarter-fork does not add blocks. The added per-block
register pressure (~5 regs, §4b.3) and any added shared memory (the flat group-sum scratch, a few
reals/quarter) **could** lower max-resident-blocks/SM and thus threaten co-residency at the margin,
but the delta is small. The §7.5 occupancy clamp (`cudaOccupancyMaxActiveBlocksPerMultiprocessor ×
SM_count`) is still recommended as a guard. **[SRC for the grid; EST for the margin — must verify
co-residency once registers/shared are measured, §12.]**

### 4b.6 DISTRIBUTED SHAPED — convolution + deck access with shaped spread 1-quarter-per-block

Under the quarter-fork the shaped modes are **distributed** (quarter 0 of every block) rather than
**concentrated** (the first n_shaped contiguous slots, as §4/§9 assumed). Implications:

- **Convolution correctness is preserved** either way — the shaped path is the *unchanged*
  per-(string,mode) deck reduction (`MainKernel.cu:619-641, 433-444` **[SRC]**); it does not care
  whether the shaped modes are contiguous or block-distributed, only that each shaped mode's
  `modeNo` correctly indexes its deck column `mode_coefficients[s·numModes + modeNo]`. The existing
  `modeNo = numArrays*quarterNumber + blockNo` already *distributes* modes across blocks by
  construction (`Kernels.cu:253` **[SRC]**) — quarter 0 of block b is `modeNo = b` (the first
  `numArrays` modes are the quarter-0 modes of all blocks). So distributing shaped modes to quarter 0
  is the *natural* placement, not a special case. **[SRC-grounded.]**
- **Deck-access coalescing [UNCERTAIN].** The deck is indexed `mode_coefficients[string·numModes +
  modeNo]`. With shaped modes at quarter-0 `modeNo`s that are **strided by `numArrays` across
  blocks** (modeNo = blockNo for quarter 0), consecutive blocks read deck columns 0,1,2,… — but
  *within* a block the shaped quarter's threads read along the **string** axis (the inner loop over
  folds / strings), which is the `string·numModes` stride. Whether this coalesces depends on the
  shaped deck's row/column-major layout, which the contiguous-re-layout note (§6) addresses for the
  *flat* tier but **not** explicitly for distributed shaped. **Recommendation:** keep the shaped deck
  in its current `S × n_shaped` layout (small, ≤256 KB) where today's access pattern already works;
  the distribution to quarter-0 does not change the per-mode deck column, only which thread reads it.
  **[SRC for the index; UNCERTAIN whether distributed shaped changes the existing coalescing — it
  reuses the existing shaped path, so it should match today's behaviour, but confirm with the §12
  profiler pass.]**
- **Deck-layout implication:** because shaped stays distributed-but-using-the-existing-path, the
  **shaped deck layout is unchanged from today** (the §6 "contiguous re-layout" rewrite applies to
  the **flat** mode-state, not the shaped deck). This *reduces* the implementation surface vs a
  scheme that concentrated shaped modes (which would have needed a deck re-pack). **[SRC-grounded.]**

### 4b.7 SUMMARY of the quarter-fork integration

| Question | Verdict |
|---|---|
| Fork on `quarterNumber==0` routes Q0→convolution, Q1–3→summation? | **Yes, cleanly** — `quarterNumber` partitions 512 threads into 4×128-thread bands by `stMdIndex` [SRC] |
| Warp-aligned (no intra-warp divergence)? | **CONFIRMED** — 128-thread quarter = 4 whole warps; `stMdIndex` = hardware lane index; fork is warp-uniform [SRC+SPEC] |
| Thread↔mode mapping | **≤1 mode/thread** in flat quarters (~27 modes / 128 threads); packing unnecessary [EST] |
| Register budget vs §3 | **Easier** — `M_t ≤ 1` ⇒ ~5 added regs, §3.4's best row; all flat state register-resident, no spill [EST, delta firm] |
| Shaped count | **OPEN QUESTION (§4b.4)** — literal layout ⇒ ~1000–1350 shaped (~25–34%); reserved-slot layout ⇒ ~64–256. User must decide. |
| Mode-blocks vs string-blocks | **SAME blocks** — modes ride existing ~56 string-blocks' spare quarters; no new grid dimension [SRC] |
| Block count | **≈ numArrays ≈ 50–56** (unchanged; string-driven), not 4000 [SRC-grounded] |
| SEGMENT=64 respected? | **Yes** — block count stays <64; flat group-sums are separate intra-block reductions [SRC; one caveat to verify §4b.5] |
| Co-residency | **Unchanged / not worsened** — same grid as today; keep the §7.5 clamp as guard [SRC+EST] |
| Distributed shaped works? | **Yes** — reuses the existing per-(string,mode) path; shaped deck layout unchanged; coalescing matches today [SRC; one profiler check §12] |

---

## 5. FLAT Tier Design

### 5.1 Register-resident oscillators

Each flat mode is a damped harmonic oscillator (same recurrence as shaped, §3.3) but its **state
lives in a per-thread register array** (§3.4): `real q_flat[M_t]`, `real qprev_flat[M_t]`, plus
cached/ re-read constants. With the `indexInQuarter==0` gate removed for the flat path, each thread
advances its `M_t` flat modes in a small unrolled loop per sample. At M_t ≤ 2 this is ~12 FLOPs/
thread/sample with zero memory ops after the first sample's constant load (§3.5).

### 5.2 Block-grouping by shared coupling (piecewise rank-1)

A **flat group G** is a set of flat modes that **share one coupling vector `w_g(s)` across strings**
(substrate §0d.1 **[SRC-grounded algebra]**). Per group, per sample:

```
FEEDIN  (string → each m∈G):
    groupForceSum_g = Σ_s w_g(s) · bridgeForce(s)          # ONE reduction per group, shared by all m∈G
    F_applied(m)    = a_in(m) · groupForceSum_g            # per-mode scalar fan-out

FEEDBACK (each m∈G → string s):
    modeSum_g = Σ_{m∈G} a_out(m) · q(m)                    # ONE reduction per group
    feedback(s) += w_g(s) · modeSum_g                      # scatter, per group
```

This is the **exact** factorisation (not an approximation) *given* `deck[s,m]=w_g(s)` for all m∈G.
The approximation is only in *choosing* to flatten/group (§9). The string axis is summed once per
group (reused by all members on feedin) and `Σ a_out·q` is summed once per group (reused by all
strings on feedback) — collapsing O(S·|G|) to **O(S)+O(|G|)** per group per sample.

**Multiple groups = piecewise rank-1** (substrate §0d.3): instead of one global flat term (one
`w(s)`), allow `n_groups` groups each with its own `w_g(s)` — a richer (block-low-rank) approximation
of the flat deck, at the cost of one extra feedin+feedback reduction per group.

### 5.3 How groups are formed

- **At preset build** (not at runtime), cluster the flat modes by the similarity of their deck rows
  `deck[s,m]` across strings. Modes whose normalised shape vectors are mutually close form a group;
  the group's `w_g(s)` is the representative (e.g. mean) shape. Low intra-group variance ⇒ low
  approximation error (substrate §0d.4 #3 **[SRC-grounded]**).
- **The degenerate single-group case** (`n_groups=1`, `w(s)=1` or a single global shape) is the
  simplest flat tier and the recommended **Phase 2** starting point (§11).
- Group assignment becomes a **preset property** (like `n_shaped`), packed and plumbed (§8).

### 5.4 Where flat oscillators live in the grid

> **★ Updated by the quarter-fork layout (§4b.5).** The earlier "several *additional* flat blocks,
> one group per block" framing is superseded: under the user's 2026-06-06 refinement the flat modes
> ride the **existing ~56 string-blocks' quarters 1–3** (3 flat quarters × 128 threads/block), NOT
> new `gridDim.x` blocks. **No blocks are added to the cooperative grid** — it stays `numArrays ≈ 56`,
> the same grid that launches today (§4b.5), so co-residency is **not worsened** vs the current
> kernel (cf. the original concern below). The per-flat-quarter group forms its `modeSum_g` /
> `groupForceSum_g` as a **block-local (intra-quarter) reduction** over its ~27 modes, advances them
> on the quarter's threads at `M_t ≤ 1` (§4b.3), and scatters `w_g(s)·modeSum_g`. Each block can thus
> host up to **3 flat groups** (one per flat quarter) in addition to its shaped quarter.

**Original framing (retained as the alternative if per-block packing proves insufficient):** several
flat blocks, one shared-coupling group per block; each flat block forms its group's `modeSum_g` in
shared memory, does one `w_g(s)`-weighted scatter, advances oscillators on the block's threads
(M_t ≤ 2). This sits **inside the same cooperative grid** as the shaped/string blocks (they need the
grid sync between the string and mode phases — substrate §1.3 **[SRC]** `allBlocks.sync()`
`MainKernel.cu:448, 628`). The quarter-fork layout makes this the default-on-existing-blocks; only if
the flat oscillator count exceeds what the existing blocks' spare quarters can serve would
*additional* flat blocks be introduced, re-opening the co-residency question (§12).

---

## 5.5 ★ FLAT-MODE PROCESSING — detailed per-sample logic (the /dev implementation spec)

> **Scope & method.** This section derives the flat per-sample algorithm **as a strict
> simplification of the CURRENT kernel math**, with line citations into
> `PianoidCore/pianoid_cuda/MainKernel.cu` (the per-sample loop `:427-702`) and
> `Kernels.cu` (the placement bake `:185-300`). Nothing here is invented: every flat step is
> the shaped step with the per-(string,mode) deck weight `deck[s,m]` replaced by a shared group
> vector `w_g(s)` × per-mode scalar — exactly the §0d.1 factorisation. Evidence tags as in §1.
> Anything not confirmable from source is marked **[UNCERTAIN]**.
>
> **The current shaped path this simplifies, in one place [SRC]:**
> - FEEDBACK scatter `mode_feedback[i] * s_mode[quarterNumber]` → `feedback_cycle_matrix` (`:441-442`),
>   reduced per-string by `sumArray` (`:469`) into `s_feedback`, applied to the stem (`:471-472`).
> - OSCILLATOR advance `result = ((2q − q_prev) + q_prev·dec − q·omega + F·mass_inv)·(1 − dec)`
>   (`:668-672`), gated `indexInQuarter==0` (`:667`), state in `s_mode[quarterNumber]`/`mode_1`.
> - FEEDIN scatter `mode_feedin[i] * force_on_bridge_summed[quarterNumber] / soundStep` →
>   `feedin_cycle_matrix` (`:622-623`), reduced per-mode by `sumArray` (`:641`) into
>   `s_mode_applied_force`.
> - The deck weights `mode_feedin`/`mode_feedback` are loaded once (outside the sample loop) from
>   `mode_coefficients` (= `dev_deck_parameters`) at `:249` / `:265`. `mode_coefficients[s·numModes + m]`.

### 5.5.1 FLAT-MODE STATE — exactly what each flat mode holds (register-resident)

A flat mode is the **same damped harmonic oscillator** as a shaped mode (§0b.3, §0d.4 #4 — physics
axis is NOT shared); only its *coupling* is replaced. For flat mode `m` owned by a thread, the
register-resident state is:

| Register value | Per-mode? | Replaces (current source) | Notes |
|---|---|---|---|
| `q` (current displacement) | **per-mode, MUTABLE** | `s_mode[quarterNumber]` (`:311, 674`) — shared today, **register here** | the live oscillator state; persisted to global at cycle end |
| `q_prev` (previous displacement) | **per-mode, MUTABLE** | `mode_1` (`:312, 673`) | second state var of the 2-tap recurrence |
| `dec` (damping) | per-mode, read-only | `mode_dec = mode_state[modeNo]` (`:315`) | physics — distinct per mode; cache in reg or re-read |
| `omega` (≈ω²·dt²) | per-mode, read-only | `mode_omega = mode_state[numModes+modeNo]` (`:316`) | physics — distinct |
| `mass_inv` | per-mode, read-only | `mode_mass_inv = mode_state[2·numModes+modeNo]` (`:317`) | physics — distinct |
| `a_in(m)` (feedin gain) | per-mode, read-only | **NEW** — replaces the per-(string,mode) deck **column** used at `:249` | a single scalar instead of S deck weights |
| `a_out(m)` (feedback gain) | per-mode, read-only | **NEW** — replaces the deck **row** used at `:265` | may equal `a_in` by reciprocity (§12.2) → save 1 reg |
| `F_applied(m)` (per-sample force) | per-mode, transient | `s_mode_applied_force[quarterNumber]` (`:660, 671`) | recomputed each sample = `a_in(m)·groupForceSum_g`; not persisted |

**Shared / group-constant (NOT per-mode — held once per group, not in every mode's registers):**

| Value | Scope | Replaces (current) |
|---|---|---|
| `w_g(s)` (group coupling vector over strings) | **one vector per group** (shared mem / global) | the deck columns/rows `deck[s,m]` that were per-mode (`:249, 265`) |
| `groupForceSum_g = Σ_s w_g(s)·bridge(s)` | one scalar per group per sample | the per-mode reduction output `s_mode_applied_force` (`:641`) — now one sum reused by all m∈G |
| `modeSum_g = Σ_{m∈G} a_out(m)·q(m)` | one scalar per group per sample | the per-mode feedback scatter sum (`:441-442, 469`) — now one sum scattered by w_g(s) |

**Register accounting (ties to §3.3, §4b.3):** the **mutable** per-mode state is exactly **2 regs**
(`q`, `q_prev`). The 3 physics constants + `a_in`/`a_out` are read-only and may be cached (~5 regs)
or re-read from contiguous, L1/L2-hot global (2-reg minimal regime, §3.3). Working figure: **~5
regs/flat-mode**. Under the quarter-fork `M_t ≤ 1` (§4b.3) so this is ~5 added regs/thread total —
the most favourable §3.4 row. The group-constant values cost **0 per-mode registers** — `w_g(s)` lives
in shared/global, `groupForceSum_g`/`modeSum_g` are computed once per group into shared scalars.

### 5.5.2 PER-SAMPLE ALGORITHM for a flat quarter (step by step, derived from the current math)

This runs inside the existing sample loop (`MainKernel.cu:427`), in the **`quarterNumber != 0`**
branch of the §7.3 fork. Ordering mirrors the current loop: feedback-scatter → reduce → emit audio →
inner FDTD → feedin-scatter → reduce → oscillator advance.

#### (a) FEEDIN (force → mode) — factor the shaped Σ_strings deck[s,m]·force(s)

The shaped feedin (`:622-623`) is, per mode, `F_applied(m) = (Σ_s deck[s,m]·bridge(s))/soundStep`
realised as an atomic scatter + `sumArray` reduction (`:641`). For a flat group where
`deck[s,m] = w_g(s)·a_in(m)` (separable), the string sum **factors out of the per-mode loop**:

```
groupForceSum_g = Σ_s  w_g(s) · force_on_bridge_summed[s] / soundStep      // ONE reduction per group
F_applied(m)    = a_in(m) · groupForceSum_g                                 // per-mode scalar fan-out, no reduction
```

- The **shared sum** `groupForceSum_g` is computed **once per group per sample** from the existing
  per-string bridge force `force_on_bridge_summed[stringInArr]` (already produced by the FDTD inner
  loop at `:599`, available at `:619`). It uses the block-local reduction of §5.5.3, NOT the
  per-mode `feedin_cycle_matrix`/`sumArray` path (which is kept only for the shaped quarter).
- The **per-mode application** is a single multiply by the register scalar `a_in(m)` — replacing the
  per-mode `sumArray` output `s_mode_applied_force[quarterNumber]` (`:671`). At `M_t≤1` each flat
  thread does exactly one such multiply.
- **Reduction to O(S)+O(|G|):** the string axis is summed once (O(S), shared by every m∈G); the
  per-mode work is O(|G|) trivial multiplies. This is the exact §0d.1 factorisation, not an
  approximation, *given* `deck[s,m]=w_g(s)·a_in(m)`.

#### (b) OSCILLATOR ADVANCE — register-only recurrence, transcribed from `:668-672`

The advance is **identical** to the shaped advance (the simplification is in coupling, not physics).
Transcribed verbatim from `MainKernel.cu:668-672`, with `s_mode[quarterNumber]→q`,
`mode_1→q_prev`, `s_mode_applied_force[quarterNumber]→F_applied(m)`:

```
result = ((2*q - q_prev) + q_prev*dec - q*omega + F_applied*mass_inv) * (1 - dec);
q_prev = q;
q      = result;
```

- **Per-mode INDEPENDENT — confirmed [SRC]:** the recurrence reads only this mode's own
  `q, q_prev, dec, omega, mass_inv` and its own `F_applied`. There is **no cross-mode term** in the
  advance (`:668-672` references only `s_mode[quarterNumber]`, `mode_1`, and the three per-mode
  config scalars + the per-mode force). Cross-mode coupling exists ONLY through the string field
  (feedin/feedback), never inside the advance. So packing N oscillators = N fully independent copies
  of this 6-FLOP update; safe to run one-per-thread with zero synchronisation between them.
- **Gate change:** the current advance is gated `indexInQuarter==0` (`:667`) → 1 thread/quarter. For
  flat quarters this gate is **dropped** (§7.3): each thread holding a flat mode (`indexInQuarter < |G_quarter|`) runs the advance on its **register** `q`/`q_prev` (not `s_mode[]`). Threads with no
  mode (`indexInQuarter ≥ |G_quarter|`) skip the advance but **still participate** in the §5.5.3
  shuffle with an identity contribution.

#### (c) FEEDBACK (mode → output) — factor the shaped Σ_modes deck[s,m]·q(m)

The shaped feedback (`:441-442`) scatters `mode_feedback[i]·s_mode[quarterNumber]` per (string,mode)
into `feedback_cycle_matrix`, reduced per-string by `sumArray` (`:469`) into `s_feedback`, applied to
the stem (`:471-472`). For a flat group where `deck[s,m] = w_g(s)·a_out(m)`, factor `w_g(s)` OUT of
the mode sum:

```
modeSum_g     = Σ_{m∈G} a_out(m) · q(m)                 // ONE reduction per group (block-local, §5.5.3)
feedback(s)  += w_g(s) · modeSum_g                       // scatter per group, per output point
```

- `modeSum_g` is the **single** group reduction over its ~27 flat modes — replacing the per-mode
  feedback scatter+`sumArray`. It maps to the current feedback path as: instead of every mode
  atomic-adding `deck[s,m]·q(m)` into `feedback_cycle_matrix[s·SEGMENT+blockNo]` (`:441-442`), the
  group forms one scalar `modeSum_g`, then adds `w_g(s)·modeSum_g` to each output point's feedback.
- **Where it lands:** the flat contribution adds into the **same `s_feedback`/stem accumulator** the
  shaped path uses (`:472`), so the integration point is unchanged (§5.5.6). For the degenerate
  `w_g(s)=1` (uniform) group, `feedback(s) += modeSum_g` is broadcast identically to every output
  stem (substrate §0b.2).
- **Output tap:** audio is read from the stem as `feedback − s_b` (velocity) or its 2nd difference
  (`:497-501`), **unchanged** — the flat feedback simply adds into `feedback` before that tap.

### 5.5.3 ★ THE REDUCTIONS — block-local, NOT the SEGMENT-wide `sumArray` (the §4b.5 caveat)

The two per-group flat sums — `groupForceSum_g` (feedin) and `modeSum_g` (feedback) — MUST be
**block-local**, computed within the flat quarter's own warps, and **must NOT route through the
cross-block `sumArray(..., SEGMENT_FOR_SHUFFLE_SUMMATION, ...)` path** (`:469, 641`). Reasoning [SRC]:
the existing `sumArray` reduces the per-string `*_cycle_matrix` **across blocks** (segment width 64 =
block-count axis); the flat group sum is over **~27 modes inside ONE quarter of ONE block** — a
different, smaller axis. Reusing the SEGMENT-wide path would (a) be wrong-axis and (b) re-stress the
SEGMENT=64 constraint the quarter-fork was careful to leave alone (§4b.5 caveat).

**Concrete block-local mechanism (a flat quarter = exactly 4 whole warps, §4b.2):**

1. **Warp-shuffle within each of the quarter's 4 warps.** Reuse the existing `warpReduceSum`
   (`MainKernel.cu:21-30` **[SRC]** — `__shfl_down_sync(FULL_MASK, val, offset)` butterfly over
   `offset = 16,8,4,2,1`). Each lane's input is its mode's contribution:
   - feedback: `a_out(m)·q(m)` for a thread owning a mode, else `0.0`;
   - feedin: `w_g(s_lane)·bridge(s_lane)` — but feedin sums over **strings**, not modes (see note
     below). Lane 0 of each warp holds that warp's partial sum after the shuffle.
2. **Shared-memory combine across the quarter's 4 warps.** A small `__shared__ real
   s_flat_group[NUM_FLAT_QUARTERS][?]` scratch (or reuse a sized slot): each warp's lane-0 does
   `atomicAdd(&s_flat_group[quarterNumber], warpSum)` — exactly the `sumArray` warp-combine pattern
   (`:61-62`), but scoped to the 4 warps of THIS quarter, indexed by `quarterNumber` (1,2,3), with NO
   cross-block atomic and NO SEGMENT addressing. One `allThreads.sync()` (block barrier) after the
   atomics makes `s_flat_group[quarterNumber]` the per-group result, readable by all the quarter's
   threads.
3. **Per-block group result.** After the sync, `s_flat_group[1..3]` hold the 3 flat quarters'
   `modeSum_g` (feedback) or `groupForceSum_g` (feedin). No `allBlocks.sync()` is needed for the
   *group* sum itself (it is block-local); the existing grid sync (`:448, 628`) is still needed only
   for the string↔mode field coupling, unchanged.

> **Shared-mem slots.** Add `__shared__ real s_flat_feedback[NUM_STRINGS_IN_ARRAY]` and
> `__shared__ real s_flat_feedin[NUM_STRINGS_IN_ARRAY]` (4 reals each — index by `quarterNumber`,
> only entries 1–3 used). Trivial vs the ~3 KB current shared budget (substrate §4). Zero them
> (the `if (stMdIndex < 4)` pattern of `:293-295`) before each sample's accumulation.

> **★ Feedin reduction axis note [SRC-grounded].** The feedback group-sum is over **modes** (lanes =
> modes, ≤27 active per quarter) — the warp-shuffle above applies directly. The feedin group-sum
> `groupForceSum_g = Σ_s w_g(s)·bridge(s)` is over **strings** (only `numStringsInArray = 4` bridge
> forces per block — `force_on_bridge_summed[0..3]`, `:417, 593, 599`). That is a **4-element sum**,
> not a 27-element one: it does NOT need a warp shuffle at all — a single thread (e.g.
> `indexInQuarter==0` of the flat quarter) can compute `Σ_{s=0..3} w_g(s)·force_on_bridge_summed[s]`
> directly into `s_flat_feedin[quarterNumber]` after the existing `:602` sync, then all the quarter's
> mode-threads read it. **This is cheaper than the shaped feedin's cross-block `sumArray` because the
> flat string-sum is intra-block (4 strings) — the cross-block accumulation only existed to gather a
> mode's force from all blocks; a flat group's force comes from its own block's 4 strings.**
> [UNCERTAIN — confirm whether a flat group's coupling is intended to span only the block's 4 strings
> or all strings; if all-strings, the feedin sum DOES need a cross-block gather and the §4b.5 caveat
> tightens. Flagged for §12 — see 5.5.8.]

### 5.5.4 MULTIPLE FLAT GROUPS (piecewise rank-1)

If a block's flat modes split into `G` groups by shared coupling (substrate §0d.3), the natural
mapping under the quarter-fork is **one group per flat quarter** (quarters 1, 2, 3 → groups g₁, g₂,
g₃), since the per-quarter reduction is already group-scoped by `quarterNumber` (§5.5.3 step 2). Then:

- Each group gets **its own** `w_g(s)` vector (3 vectors/block max), **its own** `a_in/a_out` per
  member, and **its own pair** of reductions (`groupForceSum_g`, `modeSum_g`) landing in
  `s_flat_*[quarterNumber]` — the `quarterNumber` index already separates them with no extra
  bookkeeping.
- **Layout across quarters/threads:** group `g` = flat quarter `qn ∈ {1,2,3}` = warps `{4qn..4qn+3}`
  (§4b.2). Its members occupy threads `indexInQuarter ∈ [0, |g|)` of that quarter; `|g| ≤ 128`,
  realistically ~27 (§4b.3). Three independent, warp-uniform groups per block, zero inter-group
  divergence (each is whole warps).
- If MORE than 3 groups/block are needed, either (i) pack >1 group per quarter (sub-ranges of
  `indexInQuarter`, costs a per-sub-range partial-sum mask), or (ii) spill extra groups to additional
  flat blocks (§5.4 fallback). Start with **≤3 groups/block** (one/quarter) — the clean case.
- **Phase-2 degenerate case:** `n_groups = 1`, `w(s)=1` — a single global flat term (§5.3, §11
  Phase 2). Then all 3 flat quarters share one `w`, and the 3 quarter sums are summed once more into a
  block flat total. Recommended starting point.

### 5.5.5 THREAD↔MODE MAPPING (concretely)

Per the quarter-fork (§4b.3): ~27 modes per 128-thread flat quarter ⇒ **≤1 mode/thread**.

- **Index math.** For flat quarter `qn ∈ {1,2,3}`, thread with `indexInQuarter == j` owns flat mode
  `flatLocalId = j` of that quarter's group iff `j < modesInThisQuarter`. Its **global** flat-mode
  index (for the contiguous mode-state buffer, §6) is
  `flatModeIndex = flatBase(blockNo, qn) + j`, where `flatBase` is baked at packing time into a new
  per-thread `parameters[...]` slot alongside the existing `modeNo` bake (`Kernels.cu:298` **[SRC]** —
  same mechanism, new slot; §7.2). The thread also reads its baked **group id** (= `qn` for
  one-group-per-quarter) and the `w_g`/`a_in`/`a_out` offsets.
- **Owner predicate:** `bool ownsFlatMode = (quarterNumber != 0) && (indexInQuarter < modesInThisQuarter);`
- **Idle threads (128 − ~27 ≈ 101 per flat quarter) MUST contribute identity, not garbage** in the
  reductions:
  - feedback shuffle: a non-owner lane feeds `0.0` (additive identity) into `warpReduceSum` — so its
    garbage `q` register never enters `modeSum_g`. Concretely the per-lane input is
    `ownsFlatMode ? (a_out(m)*q) : 0.0f`. Because the fork is warp-uniform (`quarterNumber` constant
    per warp, §4b.2) and `FULL_MASK` is used (`:24`), **all 32 lanes are active** in the shuffle — the
    non-owners just contribute 0. This is REQUIRED: `warpReduceSum` uses `FULL_MASK` (`:24`), so every
    lane MUST hold a valid (identity) value or the butterfly sums uninitialised registers. Initialise
    the per-lane accumulator to `0.0f` before the owner-conditional write.
  - feedin: handled by the 4-element single-thread sum (§5.5.3 note), so idle mode-threads are
    irrelevant there.
- **No `M_t` loop needed** at ≤1 mode/thread; if a denser packing is later chosen (`M_t>1`, §3.4),
  the owner predicate becomes a short unrolled per-thread loop over `M_t` and each iteration feeds the
  shuffle separately (or pre-sums the thread's `M_t` modes into one lane value first).

### 5.5.6 INTEGRATION — combining flat + shaped + string output into the per-sample stem

The flat feedback adds into the **same** stem feedback accumulator as the shaped path, preserving the
current audio tap. Ordering within one sample of the loop (`:427-702`), with required barriers:

1. **Feedback assembly (loop top, `:433-448`).**
   - Quarter 0 (shaped): existing per-(string,mode) scatter into `feedback_cycle_matrix` (`:441-442`).
   - Quarters 1–3 (flat): form `modeSum_g` (§5.5.3) → `s_flat_feedback[qn]`.
   - `allThreads.sync()` (`:447`) — barrier so both shaped scatter and flat group sums are complete.
2. **Per-string feedback reduction (`:469-472`).** Run the existing `sumArray` for the **shaped**
   contribution into `s_feedback`. Then **add the flat contribution**: for each output point `s`,
   `feedback = s_feedback[stringInArr] + Σ_{qn=1..3} w_{g(qn)}(s) · s_flat_feedback[qn]` (for uniform
   `w=1`, just `+ Σ s_flat_feedback[qn]`). This single addition is the integration point — flat and
   shaped feedback are summed BEFORE the stem overwrite (`:472`) and the audio tap (`:497`).
   `allBlocks.sync()` is already present (`:448`) for the cross-block shaped reduction; the flat group
   sum being block-local needs no additional grid sync.
3. **Audio emit (`:493-528`).** Unchanged — reads the combined `feedback`.
4. **String FDTD inner loop (`:531-587`).** Unchanged — the stem boundary now carries shaped+flat
   feedback. Produces `force_on_bridge_summed[0..3]` (`:599`) after `:602` sync.
5. **Feedin assembly (`:619-641`).**
   - Quarter 0 (shaped): existing scatter into `feedin_cycle_matrix` + cross-block `sumArray` (`:641`).
   - Quarters 1–3 (flat): compute `groupForceSum_g` (§5.5.3 note, 4-string sum) → `s_flat_feedin[qn]`,
     then `F_applied(m) = a_in(m)·groupForceSum_g`.
   - Barriers `:627-628` (`allThreads.sync()` + `allBlocks.sync()`) bound this — unchanged for shaped;
     the flat 4-string sum needs only the `allThreads.sync()` already at `:602`/`:627`.
6. **Oscillator advance (`:666-676`).** Quarter 0: gated shaped advance (unchanged). Quarters 1–3:
   ungated register advance (§5.5.2b) using `F_applied(m)`.
7. **Cycle-end persist (`:739-743`).** Quarter 0: existing `mode_running[modeNo] = s_mode[...]`. Flat:
   write each register `q`/`q_prev` to the contiguous flat working buffer at `flatModeIndex`
   (mirrors `:741-742`, new indices; §6, §7.3).

**No NEW grid barriers are required** beyond the two the loop already has (`:448`, `:628`): the flat
group reductions are block-local. The flat path slots into the existing barrier structure; only the
*content* between barriers changes (forked by `quarterNumber`).

### 5.5.7 NUMERICAL — fp32 accumulation of the group sums

`real = float` (`pianoid_types.h:6,16` **[SRC]**), so every group sum is single-precision.

- **Per-quarter `modeSum_g`** sums ~27 terms `a_out(m)·q(m)` — small, low cancellation risk; plain
  fp32 warp-shuffle (`warpReduceSum`) is adequate.
- **`groupForceSum_g`** sums only 4 string terms — negligible risk.
- **Cancellation risk concentrates at any GLOBAL combine** (§7 if flat groups span the whole instrument
  or are later summed across all blocks): summing toward ~4000 flat modes' contributions in fp32 is the
  substrate §0b.7 #3 / §0d.4 #5 risk. **Mitigation only where the accumulation width is large:**
  - Per-quarter (≤27) and per-block (≤80): plain fp32 is fine.
  - Any cross-block flat total (if a single global flat group is chosen, Phase 2): use **Kahan
    compensation** in the cross-block combine, or a **double accumulator** for the final scalar (cast
    the per-block fp32 partials to `double`, sum in double, cast back). Double atomics are emulated
    (the commented-out `atomicAddDouble`, `MainKernel.cu:33-42` [SRC]) — prefer Kahan in fp32 over
    emulated-double atomics for throughput.
- **Where to spend it:** put the compensated accumulation ONLY on the widest sum (the global/cross-
  block one). The block-local ~27-element sums do not warrant Kahan. This matches §10 #5.

### 5.5.8 PSEUDOCODE — per-sample flat-quarter logic (for the /dev implementer)

> Pseudocode for the **`quarterNumber != 0`** branch of the §7.3 fork, one sample of the loop
> (`MainKernel.cu:427`). Shaped quarter (0) keeps its current code verbatim. `g = quarterNumber` is
> the group id (one group per flat quarter). Barriers named to match the current loop.

```c
// ---- PER-THREAD SETUP (once, before the sample loop; baked indices from Kernels.cu) ----
bool isFlat        = (quarterNumber != 0);
int  g             = quarterNumber;                       // group id (1..3)
int  flatLocalId   = indexInQuarter;                      // 0..127
int  flatModeIndex = flatBase[blockNo][g] + flatLocalId;  // baked slot (Kernels.cu:298 analogue)
bool ownsFlatMode  = isFlat && (flatLocalId < modesInQuarter[g]);

// register-resident oscillator state (loaded once from contiguous flat working buffer)
real q = 0, q_prev = 0, dec = 0, omega = 0, mass_inv = 0, a_in = 0, a_out = 0;
if (ownsFlatMode) {
    q        = (status==500) ? 0 : flat_running[flatModeIndex];                 // cf. :311
    q_prev   = (status==500) ? 0 : flat_running[numFlat + flatModeIndex];       // cf. :312
    dec      = flat_state[flatModeIndex];                                       // cf. :315
    omega    = flat_state[numFlat + flatModeIndex];                            // cf. :316
    mass_inv = flat_state[2*numFlat + flatModeIndex];                          // cf. :317
    a_in     = flat_gain_in[flatModeIndex];                                     // NEW (replaces deck col)
    a_out    = flat_gain_out[flatModeIndex];                                    // NEW (replaces deck row)
}
// w_g(s): 4 reals per group for this block's strings (shared/global), loaded once
real w_g[NUM_STRINGS_IN_ARRAY];   // w_g[0..3] for this group g

for (sample = 0; sample < samplesInCycle; ++sample) {           // == MainKernel.cu:427

  // ===== (c) FEEDBACK: mode -> output, block-local group reduction =====
  if (g>=1 && indexInQuarter < 4) s_flat_feedback[g] = 0.0;     // zero group slot (cf. :293)
  allThreads.sync();                                            // cf. :447

  real fb_in = ownsFlatMode ? (a_out * q) : 0.0f;               // identity for idle lanes (§5.5.5)
  real warpSum = warpReduceSum(fb_in);                          // MainKernel.cu:21-30 (FULL_MASK)
  if ((stMdIndex % WARP_SIZE) == 0) atomicAdd(&s_flat_feedback[g], warpSum);   // cf. :61-62
  allThreads.sync();                                            // group sum ready (cf. :447/:484)

  // integrate flat feedback into the SAME stem accumulator as shaped (§5.5.6 step 2)
  if (onStem) {
      real flat_fb = 0.0f;
      for (int gg=1; gg<=3; ++gg) flat_fb += w_for_point(gg, s) * s_flat_feedback[gg];  // w=1 ⇒ sum
      feedback += flat_fb;                                       // added to s_feedback[...] (:472)
  }
  allBlocks.sync();                                             // already at :448 (shaped path)

  // ===== AUDIO EMIT (:493-528) and STRING FDTD INNER LOOP (:531-587): UNCHANGED =====
  // ... produces force_on_bridge_summed[0..3] at :599, sync at :602 ...

  // ===== (a) FEEDIN: force -> mode, factored =====
  if (g>=1 && indexInQuarter == 0) {                            // 4-string sum, one thread/group
      real fsum = 0.0f;
      for (int s=0; s<numStringsInArray; ++s) fsum += w_g[s] * force_on_bridge_summed[s];
      s_flat_feedin[g] = fsum / soundStep;                      // cf. :623 (/soundStep)
  }
  allThreads.sync();                                            // cf. :627
  real F_applied = ownsFlatMode ? (a_in * s_flat_feedin[g]) : 0.0f;   // per-mode fan-out (replaces :671)

  // ===== (b) OSCILLATOR ADVANCE: register-only, ungated (§5.5.2b; transcribed :668-672) =====
  if (ownsFlatMode) {
      real result = ((2*q - q_prev) + q_prev*dec - q*omega + F_applied*mass_inv) * (1 - dec);
      q_prev = q;
      q      = result;
  }
  allThreads.sync();                                            // cf. :678
  // (shaped quarter 0 runs its gated advance + cross-block sumArray in parallel, unchanged)
}

// ===== CYCLE-END PERSIST (§5.5.6 step 7; cf. :739-743) =====
if (ownsFlatMode) {
    flat_running[flatModeIndex]           = q;        // cf. :741
    flat_running[numFlat + flatModeIndex] = q_prev;   // cf. :742
}
```

> **Implementer notes.**
> 1. The fork wraps this whole body in `if (quarterNumber == 0) { /*shaped, current code*/ } else
>    { /*above*/ }` — warp-uniform, zero intra-warp divergence (§4b.2).
> 2. `w_for_point(gg, s)` = the group's coupling at output point `s`; for the Phase-2 uniform case it
>    is `1.0` and the loop collapses to `feedback += Σ s_flat_feedback[gg]`.
> 3. The idle-lane `0.0f` initialisation before the owner-conditional is **load-bearing** (FULL_MASK
>    shuffle, §5.5.5) — do not guard the shuffle itself with `ownsFlatMode`.
> 4. Replace plain fp32 atomics with Kahan only on any cross-block flat total (§5.5.7), not on the
>    ≤27-element per-quarter sums.

### 5.5.9 UNCERTAINTIES / ASSUMPTIONS specific to this section

- **[UNCERTAIN] Flat group string-span.** Whether a flat group's coupling spans only its block's 4
  strings (intra-block feedin, as the pseudocode assumes — cheaper, no cross-block gather) or all
  strings (needs a cross-block feedin gather, tightening the §4b.5 SEGMENT caveat). The substrate's
  separable-sum math (§0b.2) is written global-over-strings; the quarter-fork's block-locality
  (§4b.5) favours intra-block. **Must be decided/measured (§12) — it changes whether the feedin
  reduction is the cheap 4-element sum or a SEGMENT-wide one.**
- **[EST] One-group-per-flat-quarter** is the clean default; >3 groups/block needs sub-range packing
  or extra blocks (§5.5.4).
- **[UNCERTAIN] a_in == a_out (reciprocity).** Saves a register + an array; depends on the physical
  model's deck symmetry (§12.2) — assumed distinct here to be safe.
- **[SRC-confirmed] The advance is per-mode independent** (`:668-672`) and the **feedback/feedin are
  exact factorisations** of the shaped scatters (`:441-442, 622-623`) under `deck[s,m]=w_g(s)·a(m)`.
  The ONLY approximation is the choice to flatten/group (§9, §10 #3) — the per-sample mechanics above
  are exact given that choice.
- **[SPEC] `warpReduceSum` + FULL_MASK** requires all 32 lanes valid — the idle-lane identity
  (§5.5.5) is mandatory, not optional.

---

## 6. Data Layout

| Structure | Today | Under the split |
|---|---|---|
| `dev_deck_parameters` | `S × num_modes_padded`(=S) reals, O(S²) **[SRC** `PresetParameters.h:40]** | **shaped only: `S × n_shaped`** (shrinks). Flat deck **deleted** — replaced by per-group `w_g(s)` |
| Flat coupling | (rode the deck) | `dev_flat_w[n_groups × S]` (group shape vectors) + `dev_flat_gain_in[n_flat]`, `dev_flat_gain_out[n_flat]` (or one if reciprocal) — **O(n_groups·S + n_flat)**, ~tens of KB |
| `dev_mode_state` (dec/omega/mass) | `NUM_MODES × 3` fixed **[SRC** `PresetParameters.h:34]** | extend to `(n_shaped + n_flat) × 3`; flat constants laid **contiguous per group** for coalesced load (substrate §0d.4 #1) |
| `dev_mode_running` (q/q_prev) | `NUM_MODES × 2` **fixed** **[SRC** `Pianoid.cu:353]** | shaped portion persists here; **flat q/q_prev live in registers** during the cycle, persisted back to a `(n_shaped+n_flat)×2` working buffer at cycle end (mirrors current `MainKernel.cu:739-743`) |
| `feedin/feedback_cycle_matrix` | `S × SEGMENT(64)` **[SRC]** | shaped path unchanged; flat groups add `n_groups × SEGMENT` columns (or a separate small flat-reduction buffer) |
| flat group membership / `w_g` index | n/a | new packed arrays (preset-built) |

> **Contiguous mode-state re-layout (substrate §0d.4 #1, the flagged rewrite).** Today
> `mode_running[modeNo]` / `mode_state[modeNo]` are indexed by the *string-geometry* `modeNo`, which
> is **non-contiguous** for packed oscillators → bad coalescing if many oscillators/block read it.
> The flat tier MUST re-lay flat-mode state so a warp of packed oscillators reads **contiguous**
> addresses (group-major, then mode-within-group). This is a genuine layout rewrite, not a constant
> bump.

---

## 7. Kernel Structure Changes (concrete edits — all via `/dev`)

> Every edit below touches `.cu/.h` → **CUDA rebuild via `/dev` (`build_pianoid_cuda.bat --heavy
> --release`)**. Listed as a change map, not applied here.

### 7.1 `constants.h`
- Raise `NUM_MODES` from 256 to ≥ `n_shaped + n_flat` (≥ 4096) — array dims and fixed allocs key off
  it (`PresetParameters.h`, `Pianoid.cu:353`). **[SRC]**
- Add `MAX_FLAT_MODES_PER_THREAD` (= M_t cap, e.g. 8) and `MAX_FLAT_GROUPS`.
- `SEGMENT_FOR_SHUFFLE_SUMMATION` (`:90`): must stay ≥ block count AND ÷32. If flat blocks raise the
  block count past 64, raise SEGMENT to the next ÷32 ≥ new block count (substrate §0d.4 #2 **[SRC]**
  — this constraint is **inherited unchanged**; grouping does not dodge it).
- Re-derive `MAX_NUM_MODES_BY_QUARTER` only if the shaped fold scheme is touched (it is not, for
  shaped ≤ S).

### 7.2 `Kernels.cu` (placement, ~:185-300) — quarter-fork bake
- **Shaped path (quarter 0):** keep `modeNo = numArrays*quarterNumber+blockNo` (`:253`) and the
  per-thread bake (`:298`) for the **quarter-0** threads (`quarterNumber == 0`). **[SRC]** These are
  the shaped modes; nothing about their placement changes.
- **Flat path (quarters 1–3):** for `quarterNumber ∈ {1,2,3}` bake a **flat-mode index** per thread:
  with ≤1 mode/thread (§4b.3), thread `indexInQuarter == j` of flat quarter `qn` owns flat mode
  `flatBase(blockNo, qn) + j` for `j < (modes_in_this_flat_quarter)`, else none. Also bake the
  thread's **flat group id** (= the quarter, if one group per flat quarter) and the `w_g` /
  `a_in/a_out` offsets. The bake writes to a new per-thread slot (alongside the existing `modeNo` at
  `25*arraySize`). **[SRC for the slot mechanism `:298`; EST for the new index formula.]**
- **Fork point:** the kernel reads `quarterNumber = stMdIndex / quarterSize` (`MainKernel.cu:175`);
  the fork `if (quarterNumber == 0)` is warp-uniform (§4b.2) so it costs no divergence.

### 7.3 `MainKernel.cu` (the loop, ~:427-702) — the `quarterNumber==0` fork
- **The fork:** wrap the mode coupling+oscillator work in `if (quarterNumber == 0) { …shaped
  convolution… } else { …flat summation… }`. Warp-uniform (§4b.2). Quarter 0 keeps the existing
  per-(string,mode) deck scatter+reduce (`:619-641, 433-444`) and the gated single-oscillator update.
- **Gate change (flat quarters only):** the oscillator update (`:666-676`) currently
  `if (indexInQuarter==0)` — for the flat quarters, drop that gate so each of the (up to 128) flat
  threads holding a mode advances its `q_flat` (M_t ≤ 1 → no loop needed, just one oscillator/thread;
  §4b.3, §5.1). Quarter 0 (shaped) **keeps** the `indexInQuarter==0` gate (or its existing
  convolution treatment) unchanged.
- **Flat feedin:** after the string phase produces `force_on_bridge_summed`, each flat group computes
  `groupForceSum_g = Σ_s w_g(s)·bridge(s)` via one `sumArray`-style reduction per group (reusing the
  reduction machinery, sized by SEGMENT), then `F_applied(m)=a_in(m)·groupForceSum_g` per owned mode.
- **Flat feedback:** each flat group forms `modeSum_g = Σ_{m∈G} a_out(m)·q_flat(m)` (block-local
  reduction in shared mem, Kahan/double if |G| large — substrate §0d.4 #5), then scatters
  `w_g(s)·modeSum_g` into the output stems alongside the shaped feedback (`:441-442` analogue).
- **Mode-state persist:** extend the cycle-end write-back (`:739-743`) to store flat `q/q_prev` from
  registers to the working buffer at the (new contiguous) flat indices. **[SRC current form.]**
- **Register control:** add `__launch_bounds__(512, minBlocks)` to `addKernel` to cap regs/thread and
  pin occupancy deterministically (§3.2) — measure-then-set the `minBlocks` arg.

### 7.4 `Pianoid.cu` (allocations, ~:268-353)
- `dev_mode_running` (`:353`): size from `(n_shaped+n_flat)·2`, not `NUM_MODES·2`. **[SRC]**
- `dev_mode_state`/`dev_deck_parameters` register sizes follow the new constants
  (`PresetParameters.h`). Shaped deck shrinks to `S × n_shaped`.
- Add registrations for `dev_flat_w`, `dev_flat_gain_in/out`, flat-group membership, flat reduction
  scratch.
- `cycle_parameters` (`:140-152`): add `n_shaped`, `n_flat`, `n_groups`, `M_t` so the kernel reads
  them (extend beyond the current 16-int `dev_cycle_params` `:355`). **[SRC]**

### 7.5 `Pianoid_synthesis.cu` (launch, ~:345)
- **Under the quarter-fork (§4b.5) the grid does NOT grow** — it stays `num_string_arrays() ≈ 56`,
  the same cooperative grid as today, because flat modes ride the existing string-blocks' flat
  quarters rather than new blocks. (The earlier "+ n_flat_blocks" applies only to the alternative
  *additional-flat-blocks* fallback in §5.4, not the quarter-fork default.) **[SRC + §4b.5.]**
- Still add the **occupancy/co-residency clamp** the FIR path already models (`:467-481` **[SRC]**
  computes a grid that respects cooperative limits) — `addKernel` currently has none (substrate §6 #3
  **[SRC]**) — as a guard against the small added register/shared-mem pressure (§4b.5) reducing
  max-resident-blocks. Use `cudaOccupancyMaxActiveBlocksPerMultiprocessor × SM_count` to verify
  co-residency before launch; fail loudly (not silently) if not.

---

## 8. Cross-Layer Change Map

### 8.1 Middleware (`PianoidCore/pianoid_middleware/`, `PianoidBasic/`)
- **`pianoid.py`** — stop forcing `num_modes_for_model = num_strings` for the *flat* count
  (`:201, 2577, 3331` **[SRC]**); plumb `n_shaped`, `n_flat`, `n_groups` separately. The flat count
  is no longer bounded by `num_strings`.
- **`StringMap.pack_deck` / `pack_pitch_feedin`** (`StringMap.py:427-476` **[SRC]**) — build the
  **shaped** deck at width `n_shaped` (not `num_strings`); build the new **flat** arrays
  (`w_g(s)` per group, `a_in/a_out` per flat mode, group membership). Add `pack_flat_groups`.
- **`ModelParams.py`** (`ModelParameters`, `set_num_modes` `:93-102` **[SRC]**) — raise
  `MAX_NUM_MODES` to ≥4096; add `n_shaped`/`n_flat`/`n_groups` fields + `PARAM_NAMES` entries; the
  `num_modes_for_model % num_blocks` divisibility check (`:96-98`) applies to the *shaped* slot count
  only.
- **`Mode.py`** (`pack_mode_config`/`pack_modes` `:401-429` **[SRC]**) — dummy-mode padding targets
  the new contiguous flat layout; the shaped dummy padding (ID=−1) stays for the shaped slot fill.
- **`/health`** (`backendServer.py:934, 1683` **[SRC** per substrate §7.2]**) — report `n_shaped`,
  `n_flat`, `n_groups` and total `num_modes = n_shaped+n_flat` so the frontend mode-axis is correct.
- **Preset compatibility:** legacy presets (no `n_shaped`) default to `n_shaped = num_modes,
  n_flat = 0` (i.e. all-shaped = current behaviour) so existing presets render identically.

### 8.2 PianoidBasic domain (`ModelParams.py` / `Mode.py`)
- Mode padding: shaped modes [0, n_shaped) get full deck rows; flat modes [n_shaped, total) get
  group-id + scalar gains, no per-string deck row. The `num_modes + num_channels ≤ num_strings`
  invariant (`create_belarus_preset.py:55` **[SRC]**) now applies to **`n_shaped` + num_channels**.

### 8.3 Frontend (`PianoidTunner/src/`)
- **`usePreset.js`** `totalModes` (`:45, 1744` **[SRC]**) — now `n_shaped + n_flat` (up to 4000);
  expose `n_shaped` so the UI can distinguish tiers.
- **`MeasuredMatrix.jsx`** (`:22, 174-178, 399` **[SRC]**) — the mode-axis range/zoom must tolerate a
  4000-wide axis; **per-mode bars/cells at 4000 are a rendering-perf concern** (substrate §7.3
  **[DOC]**) — the matrix should render the **shaped** modes fully and the flat tier as an aggregated
  band (one bar per group, or a density strip), not 4000 individual cells.
- **`SoundChannelsPane.jsx`** mode-column axis + the matrix-scale Zoomer (`WORK_IN_PROGRESS:224-253`
  **[DOC]**) — range/selection math (`setRangeOfModes`, `selectedModes`) must handle the larger axis;
  default the flat tier to collapsed/aggregated view.

---

## 9. Shaped ↔ Flat Boundary

- **Parameter:** `n_shaped` (count of shaped modes), with convention **modes [0, n_shaped) shaped,
  [n_shaped, num_modes) flat**; modes sorted by frequency at preset build so shaped = lowest
  frequencies (substrate §0b.5 **[SRC-grounded]**).
- **Selection criterion (deck-column-variance):** for each mode, compute the variance of its deck row
  `deck[s,m]` across strings. **Low variance ⇒ the mode's shape is already near-uniform ⇒ safe to
  flatten.** Set `n_shaped` at the frequency where column variance drops below a threshold (substrate
  §0b.7, §0d.4 #3 **[UNCERTAIN — must measure deck column variance vs mode frequency on Belarus,
  §12]**).
- **Tunable:** `n_shaped` is a model parameter; **default = `num_modes`** (all-shaped = current
  behaviour, zero regression) until the variance measurement justifies a lower value. Suggested first
  non-trivial default after measurement: `n_shaped ∈ [64, 256]` (substrate §0b.4).
- **Grouping granularity** (`n_groups`) is a second tunable: start at 1 (single global flat term),
  raise to a handful of clusters identified by the same variance/similarity measurement.

---

## 10. Constraints to Respect (from substrate §0d / §8)

1. **`SEGMENT_FOR_SHUFFLE_SUMMATION = 64`** must stay ≥ block count and ÷32. Flat blocks raise the
   block count; raise SEGMENT accordingly or the feedin/feedback reductions **silently corrupt** —
   the earliest and most dangerous failure (substrate §8.1 #1, §0d.4 #2 **[SRC]**).
2. **Cooperative-grid co-residency.** The string and mode phases need `allBlocks.sync()` so the whole
   grid (string + flat blocks) must be co-resident in one wave. More flat blocks → risk of
   `cudaErrorCooperativeLaunchTooLarge`. Add the occupancy clamp (§7.5); grouping does **not** relax
   this (substrate §0d.4 #6 **[SRC]**).
3. **Exact-vs-near coupling approximation error.** The factorisation is exact only if `deck[s,m] =
   w_g(s)` identically within a group; near-equality introduces error ∝ intra-group shape variance.
   Group membership is an **approximation-quality decision**, validated by A/B render (substrate
   §0d.4 #3 **[SRC-grounded]**).
4. **Coupling axis ≠ physics axis.** Shared `w_g(s)` (coupling) does **not** imply shared
   `dec/omega/mass_inv` (physics). Each flat mode keeps its own per-mode frequency/damping
   (`dev_mode_state[modeNo]`) — merging those would physically wrong-merge distinct resonances
   (substrate §0d.4 #4 **[SRC]** `MainKernel.cu:315-317`).
5. **fp32 accumulation of `Σ q`.** `modeSum_g = Σ a_out(m)·q(m)` over a large group in float32 risks
   cancellation/precision loss at |G|~thousands; use **Kahan compensation or double accumulation**
   for the group sum (substrate §0b.7 #3, §0d.4 #5). `real = float` **[SRC** `pianoid_types.h:16]**,
   so this is a live concern.
6. **`MAX_NUM_STRINGS_IN_ARRAY = 4`** caps strings/block; flat blocks reuse the 512-thread block
   shape but need not bind 4 strings — they bind a flat group instead. Keep the shaped/string blocks
   at nsa=4 (substrate §8.2 Q3 **[SRC]**).

---

## 11. Phased Implementation Plan

Each phase is independently buildable/testable. **Every phase that touches `.cu/.h` goes through
`/dev`** (study → baseline test → branch → edit → CUDA build → verify → document → commit). Audio-
affecting phases require a **`note_playback` A/B offline render** (audio_off `/test-ui`) per the
Audio Verification Rule.

**Phase 0 — Measure first (NOT in this task; prerequisites).**
- `-Xptxas -v` on the current `addKernel` → real R0 regs/thread (§3.2). Gates the §3.4 occupancy
  numbers and the `__launch_bounds__` choice.
- Deck column-variance vs mode frequency on Belarus (§9) → the `n_shaped` boundary and natural groups.
- `cudaOccupancyMaxActiveBlocksPerMultiprocessor` × SM count on the target GPU → co-residency budget.

**Phase 0b — Resolve the SHAPED-COUNT decision (§4b.4) BEFORE coding the layout.**
- The user must choose Interpretation A (uniform, ~1000–1350 real shaped) vs B (reserved-slot,
  ~64–256 real shaped). This gates the convolution cost, the shaped deck width, and whether the
  shaped quarters are populated or dummy. **Blocking — do not implement the quarter-fork bake (§7.2)
  until decided.** [Per the project investigation→implementation rule: a code edit must not proceed
  on an unanswered design question.]

**Phase 1 — Enable multi-oscillator-per-slot via the quarter-fork (no flat *coupling* yet, pure
refactor).**
- Implement the `quarterNumber==0` fork (§7.3): quarter 0 keeps today's shaped path verbatim;
  quarters 1–3 drop the `indexInQuarter==0` gate so each flat-quarter thread can own M_t=1 register
  oscillator over a *re-indexed* flat mode layout; raise `NUM_MODES`/`dev_mode_running` sizing.
- Keep flat coupling identical to shaped initially (each flat mode still reads its own deck column),
  so this phase is **behaviour-preserving** — it only changes *which thread* advances each oscillator,
  not the math.
- **Verify:** identical audio to baseline at the current mode count (the re-indexing is behaviour-
  preserving) — A/B `note_playback` must match bit-for-bit-ish (within fp tolerance). This validates
  the gate removal + contiguous layout in isolation. **[the enabling change of §2.]**

**Phase 2 — Flat tier with ONE group (single global `w(s)`), small n_flat.**
- Add `n_shaped` + a single flat group with `w(s)=1` (or a single measured shape); flat oscillators
  register-resident at M_t≤2; one feedin + one feedback reduction.
- Set `n_shaped = num_modes` initially (n_flat=0) to prove zero regression, then move a *few* HF modes
  to flat and **A/B render** shaped-only vs split.
- **Verify:** audio A/B within tolerance; register count (`-Xptxas -v`) and occupancy match §3.4 est.

**Phase 3 — Multiple flat groups (piecewise rank-1).**
- Add `n_groups`, group membership from the variance clustering; one reduction per group; flat blocks
  = one group each (§5.4).
- **Verify:** A/B render shows grouped flat closer to full-deck than single-group; SEGMENT raised if
  block count > 64; co-residency confirmed.

**Phase 4 — Scale to 4000.**
- Raise n_flat to ~4000−n_shaped across the §3.4 sweet-spot block layout; Kahan/double group sums.
- **Verify:** full A/B render at 4000; performance measurement (per-cycle time) vs baseline;
  register/occupancy verification; SEGMENT + co-residency at the final grid.

**Phase 5 — Middleware + frontend plumbing (§8).**
- Plumb counts through `/health`, packers, `usePreset.totalModes`, matrix aggregated flat view.
- **Verify:** UI renders 4000-mode preset without perf collapse (flat tier aggregated, not 4000
  cells); legacy presets unchanged.

---

## 12. Risks, Open Questions, and Deferred Measurements

### 12.1 Risks
- **Silent reduction corruption** (highest) — SEGMENT overflow if block count > 64 (substrate §8.1 #1
  **[SRC]**). Mitigation: raise SEGMENT with block count; add an assert.
- **Cooperative-launch failure** at the larger grid (substrate §6 #3 **[SRC]**). Mitigation: the
  §7.5 occupancy clamp; consider a two-kernel split if co-residency fails.
- **Register spill of flat state** → the "dramatic deterioration" (§3.5). Mitigation: the §3.4
  multi-block layout (M_t≤2), `__launch_bounds__`, shared-mem fallback (§3.6).
- **Coalescing / warp divergence** from packed oscillators on string-FDTD threads (substrate §0d.4
  #1 **[SRC]**) → the contiguous mode-state re-layout (§6) is mandatory, not optional.
- **fp32 accumulation error** in large group sums (§10 #5).
- **Audible loss** from flattening HF spatial phase (substrate §0b.7 #1) → A/B render is the only
  acceptance test.
- **Preset compatibility** — mitigated by the all-shaped default (§8.1).

### 12.2 Open questions
- **★ SHAPED-COUNT (§4b.4) — the load-bearing design decision.** Does the user intend a uniform
  layout with ~1000–1350 *real* shaped modes (~25–34% of 4000, ~5–20× the convolution cost), or a
  reserved-slot layout where the shaped quarter is populated only in the first N blocks (real shaped
  ~64–256)? Both are coherent readings of "one quarter dedicated to shaped in each block." **User
  decision required before §7.2 implementation.** [UNCERTAIN — design intent, not measurable.]
- Exact R0 (current regs/thread) — **unknown without `-Xptxas -v`** (§3.2).
- Whether the deck HF rows are near-separable enough to flatten without audible loss (§9).
- The target GPU model and its exact occupancy/co-residency budget (§3.1, §5.4).
- Whether reciprocity lets `a_in = a_out` (saves a register + an array) — depends on the physical
  model; check `StringMap`/`Pitch` deck symmetry.

### 12.3 Deferred measurements (the substrate's 3 + one new — ALL forbidden in this task)
1. **Deck column-variance per mode vs frequency on Belarus** (substrate §0d.5 #1) — sets `n_shaped`
   and the natural groups. Read back `dev_output_data` records 4/5/9 (`OUTPUT_REC_MODE_FEEDIN/
   FEEDBACK/RAW_COEFFICIENTS` **[SRC** `constants.h:68-73]**) in a debug build.
2. **A/B `note_playback` offline render** (audio_off `/test-ui`) full-deck vs grouped/flattened at a
   candidate split (substrate §0d.5 #2) — the acceptance test.
3. **Cooperative-grid co-residency** at the target block count (substrate §0d.5 #3) —
   `cudaOccupancyMaxActiveBlocksPerMultiprocessor` × SM count.
4. **(NEW) Register/occupancy verification once code exists** — `-Xptxas -v` on the modified
   `addKernel` to confirm R0 + r·M_t lands where §3.4 estimates, and that no spill occurs. This
   validates the entire §3 register premise the design rests on.

---

### Source references (absolute paths, confirmed this session)
- `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\constants.h` (NUM_MODES:12, SEGMENT:90, USE_SINGLE_DECK:116, output recs:64-73)
- `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\MainKernel.cu` (sumArray:45-67, gate/update:304,666-676, reductions:469,641, feedback/feedin scatter:441-442,622-623, mode-state:311-317, write-back:739-743)
- `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\Kernels.cu` (placement:185-300, modeNo:253, bake:298)
- `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\Pianoid.cu` (cycle_params:140-152, allocs:268-353, dev_mode_running:353)
- `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\Pianoid_synthesis.cu` (blockSize:229-230, coop launch:345, FIR clamp precedent:467-481)
- `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\PresetParameters.h` (deck:40,64, mode_config:34,60)
- `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\pianoid_types.h` (real=float:6,16)
- `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\setup.py` (no reg flags; -O3 -use_fast_math:296; gencode:250-251)
- `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\build_config.json` (cuda_arch_list 80/86/89:12-16)
- `D:\repos\PianoidInstall\PianoidBasic\Pianoid\ModelParams.py` (MAX_NUM_MODES:12, set_num_modes:93-102)

### Doc references (MkDocs `http://localhost:8001/`)
- Substrate context doc: `development/string-mode-coupling-mode-scaling-context-2026-06-06/` (§0b, §0c, §0d)
- `modules/pianoid-cuda/SYNTHESIS_ENGINE/#string–mode-coupling`, `#kernel-grid-layout`
- `modules/pianoid-cuda/MEMORY_MANAGEMENT/#tunable-buffer-layout-preset-parameters`
- `architecture/DATA_FLOWS/#24-deck-feedinfeedback-matrices`
