# 4000-Mode Two-Tier (Shaped / Flat) Implementation Proposal

**Date:** 2026-06-06
**Author:** design agent (STATIC ANALYSIS ONLY — no builds, no engine runs, no measurements)
**Status:** DESIGN PROPOSAL — not yet implemented. Every `.cu/.cpp/.cuh/.h/setup.py` change
named here MUST go through the `/dev` workflow (CUDA build). This document does not authorise edits.
**★ REVISED 2026-06-07** — §5.5.9 uncertainty #1 RESOLVED by the user: **ALL MODES ARE COUPLED TO
ALL THE STRINGS** (the expensive branch). The flat feedin/feedback are now GLOBAL cross-block
all-strings reductions, one pair per coupling GROUP; grouping is GLOBAL by coupling shape, decoupled
from quarter placement (two-axis structure, §5.5.0); the cost driver is **G = the number of distinct
flat coupling shapes** (§5.5.cost); the cross-block reduction reuses the existing `sumArray(SEGMENT)`
path, which FITS unchanged at block count ≈56 < 64. Affected: §1, §4b.5/§4b.7, §5.3, §5.4, §5.5
(all sub-sections + new §5.5.0 and §5.5.cost), §6, §7.1/§7.3/§7.4, §12. Pre-revision block-local
framing is struck-through in place.
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
| **FLAT** (HF bulk) | `n_flat = 4000 − n_shaped` | per-group shared **all-strings** coupling vector `w_g(s)` → **separable / piecewise rank-1** | **G·O(S) + O(n_flat)** — G = number of distinct coupling shapes, the cost driver (§5.5.cost); ALL modes couple to ALL strings (cross-block) | **register-resident** oscillators placed on idle threads (axis 1); **grouped GLOBALLY by shared coupling shape** (axis 2), reductions cross-block per group |

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
co-residency is not worsened. **★ REVISED 2026-06-07 (§5.5.0/§5.5.3): with the user's resolution that
ALL MODES COUPLE TO ALL STRINGS, the flat feedin/feedback are NOT block-local — they are CROSS-BLOCK
all-strings reductions, one pair per coupling GROUP (`G·O(S)`), riding the existing
`sumArray(SEGMENT)` path re-keyed to `[G × SEGMENT]`; grouping is GLOBAL by coupling shape (two-axis
structure: placement vs grouping, §5.5.0), and G is the cost driver (§5.5.cost). SEGMENT=64 still
fits because block count stays ≈56 (§4b.5).** In addition to the unchanged shaped path. **SHAPED
COUNT — RESOLVED
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

> **★ CAVEAT on SEGMENT — REVISED 2026-06-07, now ACTIVE and ADDRESSED [SRC].** The pre-revision
> claim that the flat group-sums are *block-local* and do not touch SEGMENT was **based on the refuted
> 4-strings-per-group assumption.** With uncertainty #1 resolved (ALL MODES COUPLE TO ALL STRINGS,
> §5.5.9), both flat group-sums are **cross-block, all-strings** and DO use the SEGMENT (block-count)
> axis — they ride the **same** `sumArray(SEGMENT)` mechanism as the current per-string reductions,
> re-keyed to `[G × SEGMENT]` group-accumulators (§5.5.3). **The SEGMENT verdict at ~56 blocks:**
> - SEGMENT bounds the **block-count** axis, which must be ≥ block count and ÷32 (`constants.h:90`).
> - The quarter-fork keeps **block count = numArrays ≈ 50–56** (modes ride existing string-blocks; no
>   new blocks). **56 < 64 = SEGMENT → the flat cross-block reductions FIT the existing segment with
>   NO change.** ✓
> - Adding the per-*group* accumulator adds **rows** (G of them, the `numSegments` arg to `sumArray`),
>   **not columns** — the SEGMENT (block-axis) **width is untouched**. So G can grow without touching
>   SEGMENT; only the block count would (and it doesn't).
> - **The mechanism IS supported:** `sumArray(arr, SEGMENT, numSegments, sharedSum, …)`
>   (`MainKernel.cu:45-67` **[SRC]**) already reduces an arbitrary number of SEGMENT-wide segments
>   (today `numSegments = numStringsInArray`); passing `numSegments = G` reduces G group-rows the
>   same way. No new cross-block primitive is needed — the all-strings per-group reduction is a direct
>   re-parameterisation of the existing call. **[SRC-grounded — the one /dev verification is the
>   `[G × SEGMENT]` buffer addressing + the `numSegments = G` arg; the segment width and the primitive
>   are unchanged.]**
> - **If a future layout DID add flat blocks** (the §5.4 fallback, NOT the quarter-fork default),
>   pushing block count past 64, SEGMENT would have to rise to the next ÷32 ≥ block count or the
>   reductions silently corrupt (§10 #1). The quarter-fork avoids this by construction.

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
| SEGMENT=64 respected? | **Yes** — block count stays ≈56 <64. ★ REVISED: flat group-sums are NOT intra-block — with all-strings coupling (§5.5.0) they are CROSS-BLOCK reductions riding the SAME SEGMENT axis re-keyed to `[G × SEGMENT]`; SEGMENT width unchanged (G adds rows, not block-axis width) [SRC §4b.5 revised] |
| Flat coupling span (uncertainty #1) | ★ RESOLVED 2026-06-07: **ALL modes couple to ALL strings** → global cross-block feedin/feedback per GROUP; grouping global by shape (two-axis: placement vs grouping, §5.5.0); cost = G·O(S)+O(n_flat), G = distinct shapes (§5.5.cost) |
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

### 5.2 Grouping by shared coupling (piecewise rank-1) — GLOBAL, cross-block

> **★ REVISED 2026-06-07.** A group is defined GLOBALLY by coupling shape (§5.5.0 axis 2), not by
> block/quarter; with ALL strings coupled, `Σ_s` below runs over **all ~224 strings (cross-block)**
> and `Σ_{m∈G}` runs over the group's modes **wherever placed (cross-block)**. The factorisation math
> is unchanged — only its *reach* (all-strings, blocks-spanning) and its *implementation* (cross-block
> `sumArray(SEGMENT)` re-keyed to `[G × SEGMENT]`, §5.5.3) are.

A **flat group G** is a set of flat modes that **share one all-strings coupling vector `w_g(s)`**
(substrate §0d.1 **[SRC-grounded algebra]**). Per group, per sample (sums are over ALL strings /
ALL the group's modes, cross-block):

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

- **At preset build** (not at runtime), cluster the flat modes by the similarity of their **all-strings**
  deck rows `deck[s,m]` (`s = 0..numStrings-1`, ~224-long). Modes whose normalised shape vectors are
  mutually close form a group; the group's `w_g(s)` is the representative (e.g. mean) all-strings
  shape. Low intra-group variance ⇒ low approximation error (substrate §0d.4 #3 **[SRC-grounded]**).
  **★ The number of clusters this produces IS `G`, the cost driver (§5.5.cost) — the deferred
  measurement (§12 #1).**
- **★ Grouping is GLOBAL (by shape), independent of block/quarter placement (§5.5.0 axis 2).** A
  group's members are scattered across blocks/quarters wherever their oscillators were placed; the
  group is identified by a baked `g(m)` per mode, not by a quarter. (Pre-2026-06-07 drafts mapped one
  group to one flat quarter — that is invalid under all-strings coupling, §5.5.4.)
- **The degenerate single-group case** (`G=1`, `w(s)=1` or a single global all-strings shape) is the
  simplest flat tier and the recommended **Phase 2** starting point (§11) — ~2 cross-block reductions
  total, independent of n_flat (§5.5.cost).
- Group assignment becomes a **preset property** (like `n_shaped`), packed and plumbed (§8).

### 5.4 Where flat oscillators live in the grid

> **★ Updated by the quarter-fork layout (§4b.5) AND the all-strings resolution (§5.5.0, 2026-06-07).**
> Two separate facts now govern this:
> - **PLACEMENT (axis 1):** the flat oscillators ride the **existing ~56 string-blocks' quarters 1–3**
>   (3 flat quarters × 128 threads/block), NOT new `gridDim.x` blocks. **No blocks are added to the
>   cooperative grid** — it stays `numArrays ≈ 56`, the same grid that launches today (§4b.5), so
>   co-residency is **not worsened**. ≤1 mode/thread, register-resident (§4b.3).
> - **GROUPING (axis 2):** with ALL MODES COUPLED TO ALL STRINGS, a group's reduction is **cross-block
>   over all ~224 strings / over the group's blocks-spanning modes** (§5.5.0, §5.5.3) — NOT a
>   block-local intra-quarter sum. A quarter does **not** map to a group; a block hosts modes from
>   **many** groups, and any one group's modes are sprinkled across many blocks. The per-group
>   reductions use the existing cross-block `sumArray(SEGMENT)` path re-keyed to `[G × SEGMENT]`
>   (§5.5.3). **The number of groups G is a global parameter (`MAX_FLAT_GROUPS`), not capped at 3.**
>
> _(struck — pre-2026-06-07, valid only under the refuted block-local assumption:)_ ~~The
> per-flat-quarter group forms its `modeSum_g`/`groupForceSum_g` as a block-local (intra-quarter)
> reduction over its ~27 modes … Each block hosts up to 3 flat groups (one per flat quarter).~~

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

> **★ REVISED 2026-06-07 — §5.5.9 uncertainty #1 RESOLVED by the user: ALL MODES ARE COUPLED TO
> ALL THE STRINGS.** This is the *expensive* branch. It **invalidates the prior §5.5.3 assumption**
> that a flat group's feedin is a trivial 4-element (block's-own-4-strings) sum. Every flat group's
> feedin reduction is now a **GLOBAL reduction over ALL ~224 strings (cross-block)** and every flat
> group's feedback is a **GLOBAL scatter to ALL ~224 strings (cross-block)**. The separable win is
> *preserved* (the global string reduction is computed ONCE per group per sample and shared by all
> the group's modes), but the reductions are no longer block-local — they ride the **existing
> cross-block `*_cycle_matrix[numStrings × SEGMENT]` + `sumArray(SEGMENT)` path** the current kernel
> already uses for exactly this all-strings coupling (`MainKernel.cu:438-444, 469, 619-625, 641`
> **[SRC]**). The grouping axis is correspondingly **decoupled from block/quarter placement** — a
> "group" is now defined globally by coupling shape `w_g(s)`, not "the modes that happen to sit in
> one flat quarter" (§5.5.0, §5.5.4). The cost driver becomes the **number of distinct flat coupling
> shapes G** (§5.5.cost). Sub-sections below are revised in place; the pre-revision block-local
> framing is retained only as struck-through historical notes where it aids the diff.

### 5.5.0 ★ TWO-AXIS STRUCTURE — oscillator PLACEMENT vs coupling GROUPING (the regroup)

The all-strings resolution forces an explicit separation of two previously-conflated structures.
**They are independent axes; conflating them was the source of the now-invalidated 4-element-sum
assumption.**

- **Axis 1 — PLACEMENT (where a flat oscillator's `q`/`q_prev` live, and where its 6-FLOP advance
  runs).** UNCHANGED from §4b: each flat oscillator is a thread in some block's flat quarter
  (`quarterNumber ∈ {1,2,3}`), ≤1 mode/thread, register-resident (§4b.3, §3.4). Placement is about
  *where compute lives* — it is dictated by the quarter-fork scheduling and the register budget, and
  it spreads the ~3000–4000 flat oscillators across the existing ~56 string-blocks' spare quarters.
  **This axis is correct as-is and is NOT changed by the all-strings resolution.** [SRC §4b]
- **Axis 2 — GROUPING (which coupling-group a flat mode belongs to).** NOW GLOBAL: a group `g` is
  **the set of flat modes that share one all-strings coupling vector `w_g(s)`, `s = 0..numStrings-1`**
  (a full ~224-long vector, not 4). These modes **may be spread arbitrarily across blocks and
  quarters** — group membership is a property of the mode's *coupling shape*, determined at preset
  build by clustering the flat deck rows (§5.3, §9), and is entirely independent of which thread/
  quarter/block the oscillator was placed on. **This axis IS changed: grouping is no longer
  per-quarter.** [revised]
- **How the axes interact — the per-group reductions gather ACROSS axis-1 placement.** A group's
  feedback sum `modeSum_g = Σ_{m∈g} a_out(m)·q(m)` must collect `q(m)` from wherever each member was
  *placed* (any block, any flat quarter). Because a group's members can be scattered across blocks,
  forming `modeSum_g` is intrinsically a **cross-block reduction** (§5.5.3). Symmetrically the
  feedin scatter `w_g(s)·modeSum_g` and the feedin gather `groupForceSum_g = Σ_s w_g(s)·bridge(s)`
  touch **all strings**, which live across all blocks → also cross-block. So: **placement is local
  (a thread owns its oscillator), grouping is global (a group spans blocks), and the bridge between
  them is the cross-block reduction of §5.5.3.**

> **★ Reconciliation with the user's earlier "one group per flat quarter" model — it NO LONGER
> HOLDS.** Under the prior block-local assumption, mapping group `g` ≡ flat quarter `qn` was clean
> because a group's reduction was confined to one quarter. With all-strings coupling, a group's
> members are *defined by shape*, not by quarter, so a single global group's modes are sprinkled
> across many blocks' quarters, and a single block's flat quarter holds modes from *several* groups.
> The corrected model: **oscillators are PLACED in quarters (axis 1, for register-residency);
> groups are ASSIGNED by coupling shape (axis 2, global); reductions run cross-block PER GROUP**
> (axis-2-indexed, gathering over axis-1 placement). The quarter index is no longer the group index;
> each flat thread carries a *baked group id* `g(m)` (a small int, packed alongside `flatModeIndex`,
> §7.2) that says which `w_g`/reduction-slot its mode contributes to, independent of its quarter.

> **Scope & method.** This section derives the flat per-sample algorithm **as a strict
> simplification of the CURRENT kernel math**, with line citations into
> `PianoidCore/pianoid_cuda/MainKernel.cu` (the per-sample loop `:427-702`) and
> `Kernels.cu` (the placement bake `:185-300`). Nothing here is invented: every flat step is
> the shaped step with the per-(string,mode) deck weight `deck[s,m]` replaced by a shared group
> vector `w_g(s)` × per-mode scalar — exactly the §0d.1 factorisation. **The all-strings span is
> the current kernel's actual behaviour** — the fold loop `foldedIndexInQuarter[i] = indexInQuarter
> + quarterSize·i` (`MainKernel.cu:240`) walks a mode's coupling across the **whole** string range
> (3 folds × 128 = 384 ≥ numStrings ≈ 224), and the scatter target
> `feedback_cycle_matrix[foldedString·SEGMENT + blockNo]` (`:441`) is indexed by the *global* string
> id with the block id on the SEGMENT axis — i.e. **the current coupling is ALREADY all-strings and
> ALREADY cross-block** (`[SRC]`). The flat tier inherits that exact reach; it only replaces the
> per-(string,mode) weight with `w_g(s)·a(m)`. Evidence tags as in §1.
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
| `w_g(s)` (group coupling vector over **ALL strings**, `s = 0..numStrings-1` ≈ 224) | **one full ~224-long vector per group**, in global memory (`dev_flat_w[G × numStrings]`, §6) — NOT a 4-element per-block slice | the deck columns/rows `deck[s,m]` that were per-mode (`:249, 265`); a group's `w_g(s)` is one row shared by all its modes |
| `groupForceSum_g = Σ_{s=0..numStrings-1} w_g(s)·bridge(s)` | one scalar per group per sample — a **GLOBAL all-strings (cross-block) reduction** | the per-mode reduction output `s_mode_applied_force` (`:641`) — now **one** all-strings sum reused by every mode in group g, regardless of which block each mode sits in |
| `modeSum_g = Σ_{m∈g} a_out(m)·q(m)` | one scalar per group per sample — a **GLOBAL reduction over the group's modes, which span multiple blocks** | the per-mode feedback scatter sum (`:441-442, 469`) — now one sum, gathered cross-block over the group's placed oscillators, then scattered by `w_g(s)` to all strings |

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
`deck[s,m] = w_g(s)·a_in(m)` (separable), the string sum **factors out of the per-mode loop**.
**★ With uncertainty #1 resolved (ALL strings couple), the string sum runs over ALL ~224 strings,
cross-block — NOT the block's own 4:**

```
groupForceSum_g = Σ_{s=0..numStrings-1}  w_g(s) · force_on_bridge(s) / soundStep   // ONE GLOBAL (all-strings, cross-block) reduction per group
F_applied(m)    = a_in(m) · groupForceSum_g                                         // per-mode scalar fan-out, no reduction
```

- The **shared sum** `groupForceSum_g` is now a **global all-strings reduction** (~224 terms whose
  bridge forces live in different blocks), computed **once per group per sample**. The
  per-string bridge forces are *not* all visible in one block — each block produces only its own 4
  strings' `force_on_bridge_summed[stringInArr]` (`:599`). Gathering `Σ_s w_g(s)·bridge(s)` over all
  strings is therefore a cross-block reduction, and it **reuses the existing
  `feedin_cycle_matrix[numStrings × SEGMENT]` + `sumArray(SEGMENT)` machinery** (§5.5.3) — the very
  path the shaped/current coupling already uses, just contracted per *group* instead of per *mode*.
- **★ This is the §5.5.3 caveat now BITING** (was deferred under the block-local assumption): the
  feedin group-sum is no longer a 4-element single-thread sum; it is the same width as the current
  per-mode feedin reduction. The win vs the current per-mode path is that it is done **G times (once
  per distinct shape), not n_flat times (once per mode)** — see the cost analysis (§5.5.cost).
- The **per-mode application** is a single multiply by the register scalar `a_in(m)` — replacing the
  per-mode `sumArray` output `s_mode_applied_force[quarterNumber]` (`:671`). At `M_t≤1` each flat
  thread does exactly one such multiply, reading its group's `groupForceSum_{g(m)}` (indexed by its
  baked group id, §5.5.0).
- **Reduction to G·O(S) + O(n_flat):** the all-strings axis is summed **once per group** (G groups ⇒
  G all-strings reductions, each reused by every member of that group on feedin); the per-mode work
  is O(n_flat) trivial multiplies. This is the exact §0d.1 factorisation, not an approximation,
  *given* `deck[s,m]=w_g(s)·a_in(m)`. **Cost is driven by G (§5.5.cost), not by n_flat × S.**

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
  flat quarters this gate is **dropped** (§7.3): each thread holding a flat mode runs the advance on
  its **register** `q`/`q_prev` (not `s_mode[]`). **★ The owner predicate is now placement-based, not
  group-based:** a thread owns a flat mode iff `quarterNumber != 0 && flatLocalId < modesPlacedInThisQuarter`
  (a placement count — how many oscillators were *packed* onto this quarter, §5.5.0 axis 1), which is
  unrelated to its group id. Each owned oscillator carries a **baked group id `g(m)`** (§5.5.0) saying
  which group's `groupForceSum`/`modeSum`/`w_g` it uses — a quarter generally holds modes from
  *several* groups. Threads with no mode skip the advance but **still participate** in the §5.5.3
  reduction with an identity contribution into their (zero) lane.

#### (c) FEEDBACK (mode → output) — factor the shaped Σ_modes deck[s,m]·q(m)

The shaped feedback (`:441-442`) scatters `mode_feedback[i]·s_mode[quarterNumber]` per (string,mode)
into `feedback_cycle_matrix`, reduced per-string by `sumArray` (`:469`) into `s_feedback`, applied to
the stem (`:471-472`). For a flat group where `deck[s,m] = w_g(s)·a_out(m)`, factor `w_g(s)` OUT of
the mode sum. **★ With uncertainty #1 resolved, `modeSum_g` is a GLOBAL reduction over the group's
modes (which span multiple blocks), and the scatter goes to ALL ~224 strings/stems (cross-block):**

```
modeSum_g     = Σ_{m∈g} a_out(m) · q(m)         // ONE GLOBAL reduction per group (group's modes span blocks, §5.5.3)
feedback(s)  += w_g(s) · modeSum_g               // GLOBAL scatter to ALL strings s = 0..numStrings-1
```

- `modeSum_g` is the **single** reduction over the group's modes — but those modes are **placed
  across many blocks** (§5.5.0 axis 1), so forming `modeSum_g` is a **cross-block reduction**, not a
  block-local one. It maps to the current feedback path as: instead of every *mode* atomic-adding
  `deck[s,m]·q(m)` into `feedback_cycle_matrix[s·SEGMENT+blockNo]` for every string s (`:441-442`),
  each mode atomic-adds its `a_out(m)·q(m)` into **one group accumulator column** keyed by its group
  id; the per-group accumulator is then reduced cross-block by `sumArray(SEGMENT)` (the block axis),
  yielding one `modeSum_g` per group (§5.5.3).
- **The scatter is GLOBAL:** `feedback(s) += w_g(s)·modeSum_g` is applied at **every** output point
  `s = 0..numStrings-1` (cross-block), because the group couples to all strings. Each block applies
  it to *its own* 4 strings (`onStem` threads), reading the group's `modeSum_g` (cross-block-reduced,
  visible to all blocks after the grid sync) and the group's `w_g(s)` for that block's strings.
  Summed over the G groups: `feedback(s) += Σ_{g=1..G} w_g(s)·modeSum_g`.
- **Where it lands:** the flat contribution adds into the **same `s_feedback`/stem accumulator** the
  shaped path uses (`:472`), so the integration point is unchanged (§5.5.6). For the degenerate
  `w_g(s)=1` (uniform) single-group case (G=1), `feedback(s) += modeSum` is broadcast identically to
  every output stem (substrate §0b.2) — the cheapest configuration.
- **Output tap:** audio is read from the stem as `feedback − s_b` (velocity) or its 2nd difference
  (`:497-501`), **unchanged** — the flat feedback simply adds into `feedback` before that tap.

### 5.5.3 ★ THE REDUCTIONS — CROSS-BLOCK, via the existing SEGMENT `sumArray` path (uncertainty #1 = all-strings)

> **★ REVISED 2026-06-07.** The pre-revision version of this section asserted the two per-group sums
> were **block-local** and must NOT use the SEGMENT `sumArray` path. **That rested on the now-refuted
> assumption that a flat group couples only to its block's 4 strings.** With ALL MODES COUPLED TO ALL
> STRINGS resolved by the user, both per-group sums are intrinsically **cross-block** and the correct
> mechanism is precisely the existing `sumArray(SEGMENT)` path — re-keyed from per-*string*/per-*mode*
> to per-*group*. The struck reasoning is retained at the end as a historical note.

The two per-group flat sums are now:

- **`modeSum_g = Σ_{m∈g} a_out(m)·q(m)`** — over the group's modes, which are **placed across many
  blocks** (§5.5.0). Forming it gathers contributions from every block that holds a group-`g` member
  → **cross-block**.
- **`groupForceSum_g = Σ_{s=0..numStrings-1} w_g(s)·bridge(s)`** — over **all ~224 strings**, whose
  bridge forces are produced one block at a time (4 strings/block) → **cross-block**.

**The mechanism — re-key the existing `*_cycle_matrix[numStrings × SEGMENT]` + `sumArray(SEGMENT)`
path to a `[G × SEGMENT]` per-group accumulator [SRC-grounded].** The current kernel already performs
*exactly* an all-strings cross-block reduction: each mode scatters into
`feedback_cycle_matrix[foldedString·SEGMENT + blockNo]` (`:441`) and `sumArray(..., SEGMENT, ...)`
(`:469`) reduces along the SEGMENT (block-count) axis to give each string its total over all blocks.
The flat tier does the **same shape of reduction, contracted to G group-rows instead of numStrings
string-rows:**

1. **Feedback group-accumulator (mode → group).** Allocate a small `flat_feedback_group[G × SEGMENT]`
   buffer (or reuse spare columns of the existing matrix). Each flat oscillator thread, after its
   advance, does `atomicAdd(&flat_feedback_group[g(m)·SEGMENT + blockNo], a_out(m)·q(m))` — keyed by
   its **baked group id `g(m)`** (§5.5.0) and its block id, mirroring `:441-442`. Optionally pre-sum
   a warp's same-group lanes with `warpReduceSum` (`:21-30`) before the atomic to cut atomic traffic
   (only lanes sharing `g` in a warp combine — since group membership is by shape, not placement, a
   warp may hold mixed groups; the safe default is one atomic per owning lane, the optimisation is a
   per-group warp mask). Then `sumArray(flat_feedback_group, SEGMENT, G, s_modeSum, …)` reduces the
   block axis → `s_modeSum[g] = modeSum_g` for all G groups, cross-block. **One `allBlocks.sync()`
   (already at `:448`) makes every block's atomics visible before the reduce.**
2. **Feedback scatter (group → all strings).** After `modeSum_g` is known, each block's `onStem`
   threads add `Σ_{g=1..G} w_g(s)·modeSum_g` to their 4 strings' feedback (reading `w_g(s)` for this
   block's strings from `dev_flat_w`, §6), landing in the **same** `s_feedback`/stem accumulator as
   the shaped path (§5.5.6). This is the global scatter.
3. **Feedin group-accumulator (all strings → group).** Symmetric: after the FDTD inner loop produces
   each block's `force_on_bridge_summed[0..3]` (`:599`), each block scatters its 4 strings'
   contribution to **every group** it must drive:
   `atomicAdd(&flat_feedin_group[g·SEGMENT + blockNo], Σ_{s∈block's 4} w_g(s)·force_on_bridge_summed[s])`
   for each group g. Then `sumArray(flat_feedin_group, SEGMENT, G, s_groupForce, …)` reduces the block
   axis → `s_groupForce[g] = groupForceSum_g` (all-strings, cross-block). The existing
   `allThreads.sync()`+`allBlocks.sync()` (`:627-628`) bound this.
4. **Feedin fan-out (group → its modes).** Each flat oscillator reads its group's
   `s_groupForce[g(m)]` and computes `F_applied(m) = a_in(m)·s_groupForce[g(m)]/soundStep`. O(1) per
   mode.

> **★ SEGMENT verdict (the §4b.5 caveat, now ACTIVE — addressed head-on).** Both flat reductions use
> the SEGMENT (block-count) axis of `sumArray`, exactly like the current per-string reduction.
> **SEGMENT_FOR_SHUFFLE_SUMMATION = 64 must be ≥ block count and ÷32** (`constants.h:90`,
> `MainKernel.cu:467` comment **[SRC]**). Under the quarter-fork the **block count stays = numArrays
> ≈ 50–56** (modes ride existing string-blocks, §4b.5) — **so block count ≈ 56 < 64 = SEGMENT: the
> flat cross-block reductions FIT the existing segment unchanged.** The flat group-reductions ride the
> identical block-count axis the current `sumArray` already handles at width 56; adding the
> per-*group* accumulator does NOT widen the block axis (it adds *rows* — G of them — not *columns*).
> **No change to SEGMENT is required by the all-strings resolution**, provided the block count stays
> <64 (which the quarter-fork guarantees by not adding blocks). The ONE thing to verify in /dev: the
> `flat_*_group[G × SEGMENT]` buffer must be addressed with the **same SEGMENT stride** as the string
> matrices, and its row count G must be passed as the `numSegments` arg to `sumArray` — a
> mechanical change, the segment *width* is untouched. **[SRC for the SEGMENT width fit; the per-group
> re-keying is the §7 edit — verify the buffer addressing and the `sumArray` row/segment args in /dev.]**

> **Shared-mem slots.** Add `__shared__ real s_modeSum[MAX_FLAT_GROUPS]` (feedback) and
> `__shared__ real s_groupForce[MAX_FLAT_GROUPS]` (feedin) — the `sumArray` output scratch, sized by
> the max group count (e.g. 64). Trivial vs the ~3 KB current shared budget (substrate §4). Zero the
> `flat_*_group[G × SEGMENT]` columns each sample (the `:488`/`:682` zeroing pattern, extended to the
> G group-rows).

> _(historical, struck — pre-2026-06-07, valid ONLY under the refuted block-local/4-strings
> assumption.)_ ~~The two per-group flat sums MUST be block-local, computed within the flat quarter's
> own warps, and must NOT route through the cross-block `sumArray` path; the feedin group-sum is a
> 4-element single-thread sum over the block's own `force_on_bridge_summed[0..3]`.~~ This is **wrong
> under all-strings coupling**: a group's force comes from *all* strings (not the block's 4), and a
> group's modes live in *many* blocks (not one quarter), so both sums are cross-block — see above.
> The feedback-over-modes warp-shuffle idea survives only as the *intra-warp pre-sum* optimisation in
> step 1 above (combine same-group lanes before the cross-block atomic), not as the whole reduction.

### 5.5.4 ★ MULTIPLE FLAT GROUPS (piecewise rank-1) — GLOBAL grouping by shape, NOT per-quarter

> **★ REVISED 2026-06-07.** Grouping is now **global by coupling shape** (§5.5.0 axis 2), decoupled
> from quarter placement. The pre-revision "one group per flat quarter" mapping is **invalid** — it
> only worked when a group's reduction was confined to one quarter (block-local), which the
> all-strings resolution refuted. A group is now the set of flat modes sharing one all-strings
> `w_g(s)`, and those modes are sprinkled across many blocks/quarters.

With grouping global, the `G` groups (substrate §0d.3) are formed at preset build by clustering the
flat deck rows (§5.3, §9); `G` = the number of **distinct flat coupling shapes**. Then:

- Each group gets **its own** all-strings `w_g(s)` vector (`dev_flat_w[G × numStrings]`, §6), **its
  own** `a_in/a_out` per member, and **its own pair** of cross-block reductions (`groupForceSum_g`,
  `modeSum_g`) landing in `s_groupForce[g]` / `s_modeSum[g]` (§5.5.3) — keyed by the **group id `g`**,
  NOT by `quarterNumber`.
- **Layout across quarters/threads (placement, axis 1):** a flat oscillator's thread is chosen for
  register-residency (§4b.3), independent of its group. A single block's flat quarters therefore hold
  modes from **many different groups**; the thread carries its baked `g(m)` so its
  feedin-fanout/feedback-scatter use the right group slot. There is **no requirement that a quarter =
  a group**; the quarter index no longer indexes a group.
- **Inter-warp / divergence note:** because group membership is now by shape (not by warp), a single
  warp may hold lanes from several groups. The §5.5.3 step-1 atomic is per-lane (safe regardless of
  group mix); the optional intra-warp pre-sum must mask by group. There is **no intra-warp control
  divergence** (every flat lane runs the same advance + the same atomic; only the destination *index*
  `g(m)` differs, which is data, not a branch). [SRC-grounded: the advance has no per-group branch.]
- **`G` is unconstrained by the quarter count.** Previously capped at "≤3 groups/block (one/quarter)";
  now `G` is a global parameter bounded only by `MAX_FLAT_GROUPS` (the `[G × SEGMENT]` accumulator
  height and the `s_*[G]` scratch). G can be 1, a handful, or dozens — see the cost analysis
  (§5.5.cost): **G is the performance knob.**
- **Phase-2 degenerate case:** `G = 1`, `w(s)=1` — a single global flat term (§5.3, §11 Phase 2):
  ONE cross-block all-strings feedin reduction + ONE cross-block feedback reduction + ONE uniform
  scatter, shared by **all** ~3000–4000 flat modes. This is the cheapest configuration and the
  recommended starting point; cost ≈ 2 of the current per-string reductions total, independent of
  n_flat.

### 5.5.5 ★ THREAD↔MODE MAPPING (concretely) — placement-indexed, group-tagged

Per the quarter-fork (§4b.3): ~71–80 modes/block spread over 3 flat quarters ⇒ ~24–27 modes per
128-thread flat quarter ⇒ **≤1 mode/thread** (placement, §5.5.0 axis 1). **★ Each placed mode also
carries a baked GROUP ID** (axis 2) that is independent of its quarter.

- **Index math (placement).** For flat quarter `qn ∈ {1,2,3}`, thread with `indexInQuarter == j` owns
  flat mode `flatLocalId = j` iff `j < modesPlacedInThisQuarter`. Its **global** flat-mode index (for
  the contiguous mode-state buffer, §6) is `flatModeIndex = flatBase(blockNo, qn) + j`, baked at
  packing time into a new per-thread `parameters[...]` slot alongside the existing `modeNo` bake
  (`Kernels.cu:298` **[SRC]** — same mechanism, new slot; §7.2).
- **Group tag (grouping).** The thread ALSO reads its baked **group id `g(m)` ∈ [1, G]** — a small int
  packed into another per-thread slot, set at preset build by the shape-clustering (§5.3). `g(m)`
  selects which `dev_flat_w` row, which `s_groupForce[g]`/`s_modeSum[g]` slot, and which
  `flat_*_group[g·SEGMENT+blockNo]` accumulator column the mode uses. **`g(m)` ≠ `qn` in general** —
  a quarter holds mixed groups.
- **Owner predicate (placement-based):**
  `bool ownsFlatMode = (quarterNumber != 0) && (flatLocalId < modesPlacedInThisQuarter);`
- **Idle threads (128 − ~25 ≈ 103 per flat quarter) and the cross-block atomic:**
  - feedback (§5.5.3 step 1): a non-owner lane simply does **not** issue the
    `atomicAdd(&flat_feedback_group[g·SEGMENT+blockNo], a_out·q)` (guarded by `ownsFlatMode`) — so its
    garbage `q` never enters any group sum. (Unlike a `FULL_MASK` warp shuffle, a guarded atomic needs
    no identity value because non-participants just skip the add.) **If** the optional intra-warp
    pre-sum (§5.5.3 step 1) is used, the `warpReduceSum` `FULL_MASK` path (`:24`) DOES require every
    lane to hold a valid value → initialise the per-lane accumulator to `0.0f` and have non-owners
    keep 0; additionally mask the pre-sum to one group at a time (since a warp may mix groups).
  - feedin (§5.5.3 step 3): each block scatters its 4 strings' contribution per group from one (or a
    few) threads; idle mode-threads are irrelevant to the feedin gather — they only *read*
    `s_groupForce[g(m)]` on the fan-out.
- **No `M_t` loop needed** at ≤1 mode/thread; if a denser packing is later chosen (`M_t>1`, §3.4),
  the owner predicate becomes a short unrolled per-thread loop over the thread's `M_t` modes, each
  iteration issuing its own group-keyed atomic with its own `g(m)`.

### 5.5.6 INTEGRATION — combining flat + shaped + string output into the per-sample stem

The flat feedback adds into the **same** stem feedback accumulator as the shaped path, preserving the
current audio tap. Ordering within one sample of the loop (`:427-702`), with required barriers:

1. **Feedback assembly (loop top, `:433-448`).**
   - Quarter 0 (shaped): existing per-(string,mode) scatter into `feedback_cycle_matrix` (`:441-442`).
   - Quarters 1–3 (flat): each owning thread `atomicAdd`s `a_out(m)·q(m)` into
     `flat_feedback_group[g(m)·SEGMENT + blockNo]` (§5.5.3 step 1) — **cross-block, group-keyed**.
   - `allThreads.sync()` (`:447`) **+ `allBlocks.sync()` (`:448`, already present)** — the grid barrier
     is **REQUIRED here for the flat path too** (it was already there for the shaped cross-block
     reduction): a group's modes span blocks, so every block's atomics must complete before the reduce.
2. **Per-string feedback reduction + group reduction (`:469-472`).** Run the existing `sumArray` for
   the **shaped** per-string contribution into `s_feedback` AND `sumArray(flat_feedback_group, SEGMENT,
   G, s_modeSum, …)` for the flat **per-group** sums (both reduce the SEGMENT/block axis — §5.5.3).
   Then **add the flat contribution**: for each output point `s`,
   `feedback = s_feedback[stringInArr] + Σ_{g=1..G} w_g(s) · s_modeSum[g]` (for uniform `w=1`, G=1,
   just `+ s_modeSum[1]`). This addition is the integration point — flat and shaped feedback are summed
   BEFORE the stem overwrite (`:472`) and the audio tap (`:497`). The `allBlocks.sync()` at `:448`
   covers both reductions; **no additional grid sync** beyond it.
3. **Audio emit (`:493-528`).** Unchanged — reads the combined `feedback`.
4. **String FDTD inner loop (`:531-587`).** Unchanged — the stem boundary now carries shaped+flat
   feedback. Produces `force_on_bridge_summed[0..3]` (`:599`) after `:602` sync.
5. **Feedin assembly (`:619-641`).**
   - Quarter 0 (shaped): existing scatter into `feedin_cycle_matrix` + cross-block `sumArray` (`:641`).
   - Quarters 1–3 (flat): each block scatters its 4 strings' force per group:
     `atomicAdd(&flat_feedin_group[g·SEGMENT+blockNo], Σ_{s∈block} w_g(s)·force_on_bridge_summed[s]/soundStep)`
     for each group g (§5.5.3 step 3), then `sumArray(flat_feedin_group, SEGMENT, G, s_groupForce, …)`
     reduces the block axis → `s_groupForce[g] = groupForceSum_g` (all-strings). Each owned mode then
     `F_applied(m) = a_in(m)·s_groupForce[g(m)]`.
   - Barriers `:627-628` (`allThreads.sync()` + **`allBlocks.sync()`**) bound this — the
     `allBlocks.sync()` is now **load-bearing for the flat feedin too** (the group force gathers all
     strings cross-block), not only for the shaped path.
6. **Oscillator advance (`:666-676`).** Quarter 0: gated shaped advance (unchanged). Quarters 1–3:
   ungated register advance (§5.5.2b) using `F_applied(m)`.
7. **Cycle-end persist (`:739-743`).** Quarter 0: existing `mode_running[modeNo] = s_mode[...]`. Flat:
   write each register `q`/`q_prev` to the contiguous flat working buffer at `flatModeIndex`
   (mirrors `:741-742`, new indices; §6, §7.3).

**No NEW grid barriers are required** beyond the two the loop already has (`:448`, `:628`) — but **both
are now load-bearing for the flat path** (previously claimed unnecessary under the block-local
assumption). The cross-block flat group reductions slot into the SAME two grid barriers the shaped
cross-block reductions already use; only the *content* between barriers changes (forked by
`quarterNumber`, with the added per-group accumulator scatter+reduce).

### 5.5.7 NUMERICAL — fp32 accumulation of the group sums

`real = float` (`pianoid_types.h:6,16` **[SRC]**), so every group sum is single-precision.

> **★ REVISED 2026-06-07.** With all-strings coupling, the group sums are NO LONGER the small
> per-quarter (≤27) sums the pre-revision text assumed — `modeSum_g` now sums over **the group's
> modes, which can number in the thousands** (e.g. G=1 ⇒ all ~3000–4000 flat modes in one sum), and
> `groupForceSum_g` sums over **all ~224 strings**. The cancellation risk is now FRONT AND CENTRE,
> not a corner case.

- **`modeSum_g = Σ_{m∈g} a_out(m)·q(m)`** — width = the group's membership, which for small G is
  large (G=1 ⇒ ~4000 terms; G=16 ⇒ ~250/group; G=64 ⇒ ~60/group). At small G this is the
  substrate §0b.7 #3 / §0d.4 #5 fp32 cancellation risk realised. The accumulation happens in two
  stages: per-block partials (fp32 atomics into `flat_feedback_group[g·SEGMENT+blockNo]`, ~71 modes
  max per block per group) then the cross-block `sumArray` over ≤56 block-partials.
  - **Per-block partial (≤71 terms): plain fp32 acceptable.**
  - **Cross-block combine (≤56 partials, but each partial sums toward a large group total):** use
    **Kahan compensation** in the `sumArray` cross-block combine, or cast the per-block fp32 partials
    to `double`, sum in double, cast back. Double atomics are emulated (the commented-out
    `atomicAddDouble`, `MainKernel.cu:33-42` [SRC]) — prefer Kahan in fp32 over emulated-double
    atomics for throughput. **Apply this whenever G is small (a group total ≳ a few hundred modes).**
- **`groupForceSum_g = Σ_s w_g(s)·bridge(s)`** — width = all ~224 strings, two-stage (per-block 4
  strings → cross-block ≤56 partials). 224 terms is moderate; plain fp32 is usually fine, but the
  same Kahan option is available on the cross-block combine if a precision regression shows in the
  A/B render (§12 deferred measurement #2).
- **Where to spend it:** the compensated accumulation is needed on **every** group's cross-block
  combine when G is small (large per-group membership); at large G (many small groups) plain fp32
  per group suffices. This matches §10 #5 and ties the precision cost to the same knob (G) as the
  throughput cost (§5.5.cost).

### 5.5.8 PSEUDOCODE — per-sample flat-quarter logic (for the /dev implementer)

> ★ REVISED 2026-06-07 for **all-strings coupling**. Pseudocode for the **`quarterNumber != 0`**
> branch of the §7.3 fork, one sample of the loop (`MainKernel.cu:427`). Shaped quarter (0) keeps its
> current code verbatim. **`g = g(m)` is the BAKED GROUP ID (NOT the quarter)**; reductions are
> **cross-block** via the `[G × SEGMENT]` accumulators + `sumArray` (§5.5.3). Barriers named to match
> the current loop; both grid syncs (`:448`, `:628`) are load-bearing for the flat path now.

```c
// ---- PER-THREAD SETUP (once, before the sample loop; baked indices from Kernels.cu) ----
bool isFlat        = (quarterNumber != 0);
int  flatLocalId   = indexInQuarter;                          // 0..127 (placement, axis 1)
int  flatModeIndex = flatBase[blockNo][quarterNumber] + flatLocalId;   // baked slot (Kernels.cu:298 analogue)
bool ownsFlatMode  = isFlat && (flatLocalId < modesPlaced[blockNo][quarterNumber]);
int  g             = ownsFlatMode ? flatGroupId[flatModeIndex] : -1;   // BAKED group id (axis 2), 1..G

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
// dev_flat_w[G × numStrings]: each group's ALL-STRINGS coupling vector (global). This block reads
// w_g(s) only for its own 4 output strings on the scatter, and for its own 4 on the feedin gather.

for (sample = 0; sample < samplesInCycle; ++sample) {           // == MainKernel.cu:427

  // ===== (c) FEEDBACK: mode -> ALL strings, CROSS-BLOCK group reduction =====
  // zero this block's group-accumulator columns (cf. :488/:682, extended to G rows)
  if (stMdIndex < G) flat_feedback_group[stMdIndex*SEGMENT + blockNo] = 0.0;
  allThreads.sync();                                           // cf. :447
  // each owner scatters into its GROUP column at this block's SEGMENT slot (cf. :441-442)
  if (ownsFlatMode) atomicAdd(&flat_feedback_group[g*SEGMENT + blockNo], a_out * q);
  allThreads.sync();
  allBlocks.sync();                                            // REQUIRED: group spans blocks (cf. :448)
  // cross-block reduce the block axis -> s_modeSum[g] for all G groups (cf. :469)
  sumArray(flat_feedback_group, SEGMENT, G, s_modeSum, stMdIndex, allThreads);   // Kahan if G small (§5.5.7)

  // integrate flat feedback into the SAME stem accumulator as shaped (§5.5.6 step 2)
  if (onStem) {
      real flat_fb = 0.0f;
      for (int gg=1; gg<=G; ++gg) flat_fb += dev_flat_w[gg*numStrings + thisStringGlobalId] * s_modeSum[gg];  // w=1 ⇒ Σ s_modeSum
      feedback += flat_fb;                                       // added to s_feedback[...] (:472)
  }

  // ===== AUDIO EMIT (:493-528) and STRING FDTD INNER LOOP (:531-587): UNCHANGED =====
  // ... produces force_on_bridge_summed[0..3] at :599, sync at :602 ...

  // ===== (a) FEEDIN: ALL strings -> mode, CROSS-BLOCK group gather =====
  if (stMdIndex < G) flat_feedin_group[stMdIndex*SEGMENT + blockNo] = 0.0;
  allThreads.sync();
  // this block contributes its 4 strings' force to EVERY group it drives (one thread/group, or strided)
  if (stMdIndex < G) {
      int gg = stMdIndex;                                       // group id this thread handles
      real fsum = 0.0f;
      for (int s=0; s<numStringsInArray; ++s)
          fsum += dev_flat_w[gg*numStrings + (firstStringAddress + s)] * force_on_bridge_summed[s];
      flat_feedin_group[gg*SEGMENT + blockNo] = fsum / soundStep;   // cf. :623 (/soundStep)
  }
  allThreads.sync();                                           // cf. :627
  allBlocks.sync();                                            // REQUIRED: gather is all-strings (cf. :628)
  sumArray(flat_feedin_group, SEGMENT, G, s_groupForce, stMdIndex, allThreads);  // -> groupForceSum_g
  real F_applied = ownsFlatMode ? (a_in * s_groupForce[g]) : 0.0f;   // per-mode fan-out (replaces :671)

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
>    { /*above*/ }` — warp-uniform, zero intra-warp divergence (§4b.2). Note the advance has **no
>    per-group branch** — `g` is only a *data index* into `dev_flat_w`/`s_*`, never a branch
>    condition, so mixed-group warps do not diverge.
> 2. `dev_flat_w[gg*numStrings + s]` is the group's coupling at ALL-strings index `s`; for the
>    Phase-2 uniform case (G=1, w=1) it collapses to `feedback += s_modeSum[1]` and the feedin gather
>    to `fsum = Σ_{s∈block} force_on_bridge_summed[s]`.
> 3. The feedback per-group scatter is a **guarded atomic** (only owners add), so NO identity value is
>    needed (unlike a FULL_MASK warp shuffle). If the §5.5.3-step-1 intra-warp pre-sum is added as an
>    optimisation, THEN the FULL_MASK rule applies and idle lanes must hold `0.0f` AND the pre-sum must
>    be masked per group (a warp may mix groups).
> 4. The feedin "one thread per group" scatter (`stMdIndex < G`) assumes `G ≤ blockDim` (true for
>    G ≤ 512); for larger G, stride it. Each block touches only its own 4 strings on the gather and
>    its own 4 on the scatter — the *cross-block* assembly is done by `sumArray` over the SEGMENT axis.
> 5. Replace plain fp32 atomics/`sumArray`-combine with Kahan on the cross-block group totals whenever
>    G is small (large per-group membership) — §5.5.7. At large G plain fp32 suffices.
> 6. Both `allBlocks.sync()` (`:448`, `:628`) are load-bearing for the flat path now — do NOT remove
>    them for the flat branch (the pre-revision draft wrongly said they were unneeded for flat).

### 5.5.9 UNCERTAINTIES / ASSUMPTIONS specific to this section

- **✅ [RESOLVED 2026-06-07 — uncertainty #1] Flat group string-span = ALL STRINGS.** The user
  decided: ALL MODES ARE COUPLED TO ALL THE STRINGS. The feedin gather and the feedback scatter are
  therefore **global (all ~224 strings), cross-block**, NOT the cheap 4-element block-local sum the
  pre-revision pseudocode assumed. This propagated through §5.5.0–§5.5.8 (cross-block reductions via
  the SEGMENT `sumArray` path), §4b.5 (the SEGMENT caveat is now active but FITS at block count ≈56 <
  64), and the cost model (§5.5.cost — cost driven by the number of groups G, not by n_flat × S). The
  ONLY thing this does NOT change is the oscillator PLACEMENT (axis 1, §5.5.0) — register-residency
  and the quarter-fork are unaffected.
- **✅ [RESOLVED — supersedes] One-group-per-flat-quarter is INVALID.** Grouping is now global by
  coupling shape (§5.5.0 axis 2, §5.5.4); a group's modes span blocks/quarters and a quarter holds
  mixed groups. The quarter index is no longer the group index — each flat mode carries a baked group
  id `g(m)`.
- **[UNCERTAIN] a_in == a_out (reciprocity).** Saves a register + an array; depends on the physical
  model's deck symmetry (§12.2) — assumed distinct here to be safe.
- **[UNCERTAIN — THE cost driver, must be measured] The number of distinct flat coupling shapes G.**
  With all-strings coupling, total flat coupling cost ≈ G·(O(S) feedin + O(S) feedback) + O(n_flat)
  (§5.5.cost). G is set by how many clusters the flat deck rows fall into — the **deferred
  deck-column-variance / shape-clustering measurement (§12 deferred #1)**. Small G (HF modes share a
  near-uniform shape) ⇒ cheap; large G ⇒ approaches the dense shaped cost. **The design supports G
  parametrically (`MAX_FLAT_GROUPS`); the break-even G is in §5.5.cost.**
- **[SRC-confirmed] The advance is per-mode independent** (`:668-672`) and the **feedback/feedin are
  exact factorisations** of the shaped scatters (`:441-442, 622-623`) under `deck[s,m]=w_g(s)·a(m)`.
  The ONLY approximation is the choice to flatten/group (§9, §10 #3) — the per-sample mechanics above
  are exact given that choice.
- **[SRC-confirmed] The cross-block all-strings reduction mechanism EXISTS in the current kernel** —
  `*_cycle_matrix[numStrings × SEGMENT]` + `sumArray(SEGMENT)` (`:441,469,623,641`). The flat tier
  re-keys it from per-string/per-mode to per-group; the SEGMENT (block) axis width (≈56) is unchanged.
- **[SPEC] `warpReduceSum` + FULL_MASK** requires all 32 lanes valid — relevant ONLY if the optional
  intra-warp pre-sum (§5.5.3 step 1) is used; the default guarded-atomic path needs no identity.

### 5.5.cost ★ COST AS A FUNCTION OF G (the number of distinct flat coupling shapes)

> **The all-strings resolution makes G the single performance knob for the flat tier.** This
> sub-section states the cost parametrically, tabulates it at representative G, and gives the
> break-even G where the flat tier stops beating a dense shaped treatment of the same modes.

**Cost model (per audio sample), all-strings coupling [EST, grounded in the kernel's reduction
shape]:**

```
flat_advance      = O(n_flat)             // ~6 FLOPs/mode, register-resident, fully parallel over ~19k flat-thread-slots
flat_feedin       = G · O(S)              // G all-strings cross-block reductions (sumArray over SEGMENT≈56), one per group
flat_feedback     = G · O(S)              // G all-strings cross-block reductions + G·O(S) scatter
─────────────────────────────────────────
flat_coupling_total ≈ G · O(S)  +  O(n_flat)      // NOT O(S · n_flat)
```

Compare a **dense shaped** treatment of the same `n_flat` modes (the cost the two-tier split is
trying to avoid): `O(S · n_flat)` — the full per-(string,mode) deck contraction. So the flat tier
replaces the `n_flat` factor in the coupling term with `G`.

**Representative cost (S ≈ 224, n_flat ≈ 4000, units = "all-strings reductions" R, where one R is the
cost of the current per-string `sumArray`-style cross-block reduction; the O(n_flat) advance is
near-free — register-resident, massively parallel):**

| G (distinct shapes) | feedin+feedback reductions | flat coupling cost | vs dense shaped (= n_flat·R-equiv) | verdict |
|---|---|---|---|---|
| **1** (single global w, w=1) | 2·R | **~2 R** + O(n_flat) advance | ~4000× cheaper | cheapest; the Phase-2 default |
| **4** | 8·R | **~8 R** | ~500× cheaper | very cheap; coarse spatial structure |
| **16** | 32·R | **~32 R** | ~125× cheaper | cheap; moderate spatial fidelity |
| **64** | 128·R | **~128 R** | ~31× cheaper | still a clear win; rich piecewise-rank-1 |
| **~224 (= S)** | ~448·R | **~448 R** | ≈ parity-ish | approaches dense; no longer worth flattening |

**[EST — the R-unit normalisation is approximate (the dense shaped reduction and the per-group flat
reduction are the same `sumArray` shape, so the ratio ≈ n_flat : G is robust; the absolute R cost is
the unmeasured per-reduction time).]**

**Break-even G.** The flat tier beats dense-shaped treatment of the flat band as long as
`G · O(S) + O(n_flat) < O(S · n_flat)`, i.e. roughly **`G < n_flat`** (the advance term O(n_flat) is
dominated). With n_flat ≈ 4000, the flat tier is cheaper for **any G up to ~thousands** — but the
*meaningful* win (≥10×) requires **`G ≲ n_flat/10 ≈ 400`**, and the *large* win (≥100×) requires
**`G ≲ 40`**. The design target is therefore **small G (1–64)**; the whole premise (substrate §0b.7)
is that the HF flat band's deck rows cluster into *few* distinct shapes. **If the deferred
measurement (§12 #1) finds G is large (HF modes have genuinely diverse all-strings shapes), the flat
tier's advantage collapses toward parity and the shaped/flat boundary `n_shaped` should be raised
instead** (keep more modes shaped, fewer flat) — i.e. G and n_shaped are jointly tuned by the same
variance/clustering measurement.

**What MUST be measured to fix G (the deferred deck-column-variance measurement, §12 #1):** cluster
the flat band's deck rows `deck[s,m]` (all-strings, ~224-long, per mode) by shape similarity and
count the number of distinct clusters at an acceptable intra-cluster variance (the A/B-render
approximation-error threshold, §10 #3). **That cluster count IS G.** The design is parametric in G
(`MAX_FLAT_GROUPS`, the `[G × SEGMENT]` accumulator height, the baked `g(m)`), so it accommodates
whatever the measurement returns — but the *performance* of the design is set by it.

---

## 6. Data Layout

| Structure | Today | Under the split |
|---|---|---|
| `dev_deck_parameters` | `S × num_modes_padded`(=S) reals, O(S²) **[SRC** `PresetParameters.h:40]** | **shaped only: `S × n_shaped`** (shrinks). Flat deck **deleted** — replaced by per-group `w_g(s)` |
| Flat coupling | (rode the deck) | `dev_flat_w[n_groups × S]` (group shape vectors) + `dev_flat_gain_in[n_flat]`, `dev_flat_gain_out[n_flat]` (or one if reciprocal) — **O(n_groups·S + n_flat)**, ~tens of KB |
| `dev_mode_state` (dec/omega/mass) | `NUM_MODES × 3` fixed **[SRC** `PresetParameters.h:34]** | extend to `(n_shaped + n_flat) × 3`; flat constants laid **contiguous per group** for coalesced load (substrate §0d.4 #1) |
| `dev_mode_running` (q/q_prev) | `NUM_MODES × 2` **fixed** **[SRC** `Pianoid.cu:353]** | shaped portion persists here; **flat q/q_prev live in registers** during the cycle, persisted back to a `(n_shaped+n_flat)×2` working buffer at cycle end (mirrors current `MainKernel.cu:739-743`) |
| `feedin/feedback_cycle_matrix` | `S × SEGMENT(64)` **[SRC]** | shaped path unchanged; **flat tier adds a separate `[G × SEGMENT]` per-group cross-block accumulator** (`dev_flat_feedback_group`/`dev_flat_feedin_group`) — the all-strings group reductions ride the SAME SEGMENT (block) axis re-keyed to G group-rows (§5.5.3). G rows, not S — accumulator is tiny (G≤64 × 64 × 4B ≈ 16 KB) |
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
- `SEGMENT_FOR_SHUFFLE_SUMMATION` (`:90`): must stay ≥ block count AND ÷32. **★ The flat per-group
  cross-block reductions (§5.5.3) ride this same SEGMENT (block-count) axis** (all-strings coupling,
  §5.5.0). Under the quarter-fork, block count stays = numArrays ≈ 56 < 64, so **SEGMENT=64 is
  UNCHANGED and sufficient** — the flat group-accumulators `[G × SEGMENT]` add *rows* (passed as the
  `numSegments` arg to `sumArray`), not block-axis width (§4b.5 revised caveat). If a future layout
  added flat blocks past 64 (the §5.4 fallback, NOT the quarter-fork default), raise SEGMENT to the
  next ÷32 ≥ new block count or the reductions silently corrupt (substrate §0d.4 #2 **[SRC]**).
- Re-derive `MAX_NUM_MODES_BY_QUARTER` only if the shaped fold scheme is touched (it is not, for
  shaped ≤ S).

### 7.2 `Kernels.cu` (placement, ~:185-300) — quarter-fork bake
- **Shaped path (quarter 0):** keep `modeNo = numArrays*quarterNumber+blockNo` (`:253`) and the
  per-thread bake (`:298`) for the **quarter-0** threads (`quarterNumber == 0`). **[SRC]** These are
  the shaped modes; nothing about their placement changes.
- **Flat path (quarters 1–3):** for `quarterNumber ∈ {1,2,3}` bake a **flat-mode index** per thread
  (PLACEMENT, §5.5.0 axis 1): with ≤1 mode/thread (§4b.3), thread `indexInQuarter == j` of flat
  quarter `qn` owns flat mode `flatBase(blockNo, qn) + j` for `j < (modes_placed_in_this_flat_quarter)`,
  else none. **★ Also bake the thread's GROUP ID `g(m)` (GROUPING, axis 2) — a global value from the
  preset shape-clustering (§5.3), NOT `= qn`** (a quarter holds mixed groups; a group spans blocks).
  The bake also carries the `dev_flat_w` row offset (= `g(m)·numStrings`) and the `a_in/a_out`
  offsets. These write to new per-thread slots (alongside the existing `modeNo` at `25*arraySize`).
  **[SRC for the slot mechanism `:298`; EST for the new index formulas; the group id is preset data,
  §5.3.]**
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
- **Flat feedin (★ all-strings, cross-block):** after the string phase produces
  `force_on_bridge_summed`, each block scatters its 4 strings' force per group into
  `flat_feedin_group[g·SEGMENT+blockNo]`, then `sumArray(flat_feedin_group, SEGMENT, G, …)` reduces
  the block axis → `groupForceSum_g` (all-strings, G groups), then `F_applied(m)=a_in(m)·groupForceSum_{g(m)}`
  per owned mode. Re-keys the existing `feedin_cycle_matrix`+`sumArray` path (`:623,641`) from
  per-mode to per-group (§5.5.3 step 3).
- **Flat feedback (★ cross-block over group's blocks-spanning modes):** each owned mode atomic-adds
  `a_out(m)·q_flat(m)` into `flat_feedback_group[g(m)·SEGMENT+blockNo]`; `sumArray(…, SEGMENT, G, …)`
  reduces the block axis → `modeSum_g` (Kahan/double when G small ⇒ large per-group membership —
  §5.5.7, substrate §0d.4 #5), then each block scatters `Σ_g w_g(s)·modeSum_g` to its strings'
  feedback alongside the shaped feedback (`:441-442` analogue, re-keyed per group; §5.5.3 steps 1–2).
- **Mode-state persist:** extend the cycle-end write-back (`:739-743`) to store flat `q/q_prev` from
  registers to the working buffer at the (new contiguous) flat indices. **[SRC current form.]**
- **Register control:** add `__launch_bounds__(512, minBlocks)` to `addKernel` to cap regs/thread and
  pin occupancy deterministically (§3.2) — measure-then-set the `minBlocks` arg.

### 7.4 `Pianoid.cu` (allocations, ~:268-353)
- `dev_mode_running` (`:353`): size from `(n_shaped+n_flat)·2`, not `NUM_MODES·2`. **[SRC]**
- `dev_mode_state`/`dev_deck_parameters` register sizes follow the new constants
  (`PresetParameters.h`). Shaped deck shrinks to `S × n_shaped`.
- Add registrations for `dev_flat_w` (**`G × numStrings`** — all-strings shape per group),
  `dev_flat_gain_in/out` (`n_flat`), flat-group membership / baked `g(m)` (`n_flat`), and the
  **cross-block group accumulators `dev_flat_feedback_group` / `dev_flat_feedin_group`
  (`G × SEGMENT` each)** + the `sumArray` output scratch `s_modeSum`/`s_groupForce` (shared, size
  `MAX_FLAT_GROUPS`). The `[G × SEGMENT]` buffers are the all-strings cross-block reduction surface
  (§5.5.3); G ≤ `MAX_FLAT_GROUPS`.
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

1. **`SEGMENT_FOR_SHUFFLE_SUMMATION = 64`** must stay ≥ block count and ÷32. **★ Under the
   quarter-fork the block count stays = numArrays ≈ 56 < 64, so SEGMENT=64 is sufficient UNCHANGED —
   even for the new all-strings flat per-group reductions, which ride the same SEGMENT (block) axis
   re-keyed to `[G × SEGMENT]` (G adds rows, not block-axis width; §4b.5/§5.5.3).** Only the §5.4
   *additional-flat-blocks* fallback would raise the block count past 64 and force SEGMENT up; then
   raise it or the feedin/feedback reductions **silently corrupt** — the earliest and most dangerous
   failure (substrate §8.1 #1, §0d.4 #2 **[SRC]**).
2. **Cooperative-grid co-residency.** The string and mode phases need `allBlocks.sync()` so the whole
   grid must be co-resident in one wave. **★ The quarter-fork adds NO blocks (modes ride existing
   ~56 string-blocks), so co-residency is not worsened** beyond the small per-block register/shared
   pressure (§4b.5). The §5.4 additional-flat-blocks fallback WOULD risk
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

**Phase 3 — Multiple flat groups (piecewise rank-1), GLOBAL grouping by shape.**
- Add `G` (`n_groups`) + baked per-mode group id `g(m)` from the variance/shape clustering (§5.3);
  one cross-block all-strings reduction PAIR per group (`[G × SEGMENT]` accumulators, §5.5.3).
  **Grouping is global by coupling shape, NOT one-group-per-quarter/block** (§5.5.0/§5.5.4) — a
  group's modes span blocks; a quarter holds mixed groups.
- **Verify:** A/B render shows grouped flat closer to full-deck than single-group; measure the actual
  G the clustering yields and confirm the §5.5.cost win at that G; SEGMENT stays 64 (block count ≈56);
  co-residency confirmed; Kahan on cross-block group totals where G is small (§5.5.7).

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
1. **★ Deck column-variance + shape-CLUSTERING per mode vs frequency on Belarus** (substrate §0d.5
   #1) — sets `n_shaped` AND, critically, **`G` = the number of distinct flat coupling shapes (the
   cost driver, §5.5.cost)**. With all-strings coupling resolved, this measurement is now the load-
   bearing one: cluster the flat band's full ~224-long all-strings deck rows `deck[s,m]` by shape
   similarity; the cluster count at an acceptable intra-cluster variance IS G. Small G (1–64) ⇒ the
   flat tier wins by 30–4000× (§5.5.cost); large G ⇒ raise `n_shaped` instead. Read back
   `dev_output_data` records 4/5/9 (`OUTPUT_REC_MODE_FEEDIN/FEEDBACK/RAW_COEFFICIENTS` **[SRC**
   `constants.h:68-73]**) in a debug build, then cluster offline.
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
