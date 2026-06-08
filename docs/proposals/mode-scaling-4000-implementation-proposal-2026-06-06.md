# 4000-Mode Two-Tier (Shaped / Flat) Implementation Proposal

**Date:** 2026-06-06
**Author:** design agent (STATIC ANALYSIS ONLY — no builds, no engine runs, no measurements)
**Status:** DESIGN PROPOSAL — not yet implemented. Every `.cu/.cpp/.cuh/.h/setup.py` change
named here MUST go through the `/dev` workflow (CUDA build). This document does not authorise edits.
**Substrate doc (factual base):**
`docs/development/string-mode-coupling-mode-scaling-context-2026-06-06.md`
(read §0c corrected mode↔slot model and §0d block-grouping critique first).

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

**Headline of the kernel change (§7):** drop the `indexInQuarter==0` single-oscillator gate; let each
of the (up to) 512 threads/block own **M_t flat oscillators in a register array**; replace the
`modeNo` formula with a flat-mode index whose range is `M_block × numArrays` not `4 × numArrays`;
add one grid-wide reduction per flat group for feedin and one for feedback (`Σ q(m)` factored), in
addition to the unchanged shaped path. Constants, allocations, and the Python/JS plumbing follow.

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

Per §3.4 sweet spot: **several flat blocks, one shared-coupling group per block.** Each flat block
forms its group's `modeSum_g` in shared memory (a single-value reduction over the block's flat modes),
does one `w_g(s)`-weighted scatter, and advances its group's oscillators on the block's threads
(M_t ≤ 2). This sits **inside the same cooperative grid** as the shaped/string blocks (they need the
grid sync between the string and mode phases — substrate §1.3 **[SRC]** `allBlocks.sync()`
`MainKernel.cu:448, 628`), so flat blocks are additional `gridDim.x` blocks co-resident with the
string blocks. **Co-residency at the larger block count is an open measurement (§12).**

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

### 7.2 `Kernels.cu` (placement, ~:185-300)
- **Shaped path:** keep `modeNo = numArrays*quarterNumber+blockNo` (`:253`) and the per-thread bake
  (`:298`) for blocks/threads serving shaped modes. **[SRC]**
- **Flat path:** for flat blocks, compute a **flat-mode base index** `flatBase = (flatBlockNo ·
  M_block) + groupOffset` and bake per-thread the `M_t` flat-mode indices this thread owns (a small
  contiguous run), plus the thread's group id. Bake `w_g` index and `a_in/a_out` offsets.

### 7.3 `MainKernel.cu` (the loop, ~:427-702)
- **Gate removal:** the oscillator update (`:666-676`) currently `if (indexInQuarter==0)`. For flat
  threads, replace with a `for (k=0; k<M_t; k++)` register loop advancing `q_flat[k]` (§3.3, §5.1).
  Shaped modes keep the gated single-thread update.
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
- Grid grows from `num_string_arrays()` to `num_string_arrays() + n_flat_blocks`. Add the
  **occupancy/co-residency clamp** the FIR path already models (`:467-481` **[SRC]** computes a grid
  that respects cooperative limits) — `addKernel` currently has none (substrate §6 #3 **[SRC]**).
  Use `cudaOccupancyMaxActiveBlocksPerMultiprocessor × SM_count` to verify the grid is co-resident
  before launch; fail loudly (not silently) if not.

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

**Phase 1 — Enable multi-oscillator-per-slot (no flat tier yet, pure refactor).**
- Drop the `indexInQuarter==0` gate behind a flag; let each thread own M_t=1 register oscillator over
  a *re-indexed contiguous* mode layout; raise `NUM_MODES`/`dev_mode_running` sizing.
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
