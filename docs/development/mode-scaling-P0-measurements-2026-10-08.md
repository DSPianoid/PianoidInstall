# Mode-Scaling (4000 modes) — Phase 0 Measurements

**Date:** 2026-10-08
**Agent:** dev-dad7 (measurement only — no source changes in Core/Basic/Tunner)
**Feeds:** [4000-mode two-tier proposal](../proposals/mode-scaling-4000-implementation-proposal-2026-06-06.md)
§11 Phase 0 / §12.2 / §12.3 #1 + #3, and the
[register/occupancy plan](../proposals/register-memory-management-plan-2026-06-10.md) §3.3 / §8 "Phase 0 — Measure".
**Substrate:** [string-mode coupling context](string-mode-coupling-mode-scaling-context-2026-06-06.md).

> **Evidence tags.** **[MEAS]** measured this session (method + script given). **[DOC]** project docs.
> **[DERIVED]** arithmetic on [MEAS] values. **[UNMEASURED]** still open.

---

## 0. Headline numbers

| Quantity | Value | Tag |
|---|---|---|
| `addKernel` registers/thread — **release** (sm_86 / sm_89; sm_80) | **119** (118) | [MEAS] |
| `addKernel` registers/thread — **debug** (`__launch_bounds__(512,1)`, `-O2`) | **99** (98) | [MEAS] |
| `addKernel` spills / stack / local | **0 / 0 / 0** (both variants, all archs) | [MEAS] |
| `addKernel` static shared memory; dynamic | **18,496 B**/block; 0 | [MEAS] |
| Installed `.pyd` (release + debug) matches the worktree build | **yes** (cuobjdump: identical regs/smem) | [MEAS] |
| Max co-resident blocks/SM on the RTX 4090, block = 512 or 384 threads | **1** (16 / 12 warps of 48) | [MEAS] |
| Cooperative capacity (×128 SMs) vs grid | **128** vs **56** (Belarus) / **58** (F15) | [MEAS] |
| **Register cliff** (block can no longer launch) | **>128 r/t at 512 threads; >168 at 384 threads** | [DERIVED] |
| Release headroom **as built (no cap)** | **9 regs** at array_size 512; 49 at 384 | [DERIVED] |
| Lowest spill-free register count (`-maxrregcount` sweep) | **79** (cap 80) — first spill at cap 72 | [MEAS] |
| Deck: is the stored feedin == feedback (reciprocity, `a_in == a_out`)? | **yes, exactly** (84/84 and 88/88 piano pitches) | [MEAS] |
| Deck columns: do they get **flatter at high frequency**? | **No** (Belarus: same at every frequency; F15: *less* flat at HF) | [MEAS] |
| Belarus — shapes G at τ=0.95 / 0.99 (all 196 modes) | **43 / 115** | [MEAS] |
| Belarus — shared-basis rank r for per-mode error ≤10 % / 5 % / 1 % (all modes) | **29 / 36 / 69** | [MEAS] |
| F15 — modes ≥1600 Hz (127 modes): G@0.99 vs exact rank | **23 vs 2** | [MEAS] |

---

## 1. R0 — register / memory footprint per kernel

### 1.1 Method [MEAS]

- Detached worktree of PianoidCore `dev` @ `0332511` at `D:\scratch\dev-dad7\wt-core` (compile only; nothing
  installed; the user's stack was not touched; `TEMP`/`TMP` on D:).
- Each `__global__`-bearing translation unit (`MainKernel`, `Kernels`, `FIRFilter`, `gaussTest`, `add_arrays`,
  `SinewaveGenerator`) compiled with the **exact `pianoid_cuda/setup.py` nvcc flags**
  ([BUILD_SYSTEM.md → CUDA Compilation](http://localhost:8001/architecture/BUILD_SYSTEM/#cuda-compilation-nvcc)) plus `-Xptxas -v`:
  release `-O3 -use_fast_math`; debug `-O2 -DPIANOID_DEBUG_DATA`; `-gencode` sm_80/86/89 (`build_config.json`).
  Script: [`diagnostics/dev-dad7-ptxas-r0.sh`](diagnostics/dev-dad7-ptxas-r0.sh); parser:
  [`diagnostics/dev-dad7-parse-ptxas.py`](diagnostics/dev-dad7-parse-ptxas.py).
- Cross-check: `cuobjdump --dump-resource-usage` on the **installed** `pianoidCuda*.cp312-win_amd64.pyd`
  (read-only, built 2026-10-08 13:31) → `addKernel` REG 118/119/119 release, 98/99/99 debug, SHARED 18496 —
  **identical** to the worktree build, so the numbers describe the binary the engine actually runs.

### 1.2 Results (sm_89 = RTX 4090; sm_80/86 in brackets where different)

| Kernel | Coop? | Release regs | Debug regs | Static smem | Stack | Spill |
|---|---|---|---|---|---|---|
| **`addKernel`** (MainKernel.cu) | **yes** | **119** [sm_80 118] | **99** [sm_80 98] | **18,496 B** | 0 | 0 |
| `convolutionKernel` (FIRFilter.cu) | yes | 33 [sm_80 27] | 33 [27] | 0 | **400 B** (local array) | 0 |
| `parameterKernel` (Kernels.cu) | no | 46 | 46 | 0 | 0 | 0 |
| `gaussKernel` (gaussTest.cu) | no | 47 | 48 [47] | 0 | 0 | 0 |
| `stringMapKernel` (Kernels.cu) | no | 40 [32] | 40 [32] | 96 B | 0 | 0 |
| `scaleAndAdd_kernel` (add_arrays.cu) | no | 40 [32] | 40 [32] | 0 | 0 | 0 |
| `sinewaveKernel` (SinewaveGenerator.cu) | no | 36 [32] | 40 [32] | 0 | 0 / 32 B dbg | 0 |
| `testSumKernel` (MainKernel.cu) | no | 12 [11] | 12 [11] | 64 B | 0 | 0 |
| `coefficientKernel`, `floatToAudioSampleKernel`, `initialize(Int)Kernel` | no | 10 | 10 | 0 | 0 | 0 |
| `copyKernel(Float)`, `nextIndexKernel` | no | 8 | 8 | 0 | 0 | 0 |

**Readings.**
- R0 = **119**, not the "~20–30 regs, ~3 KB shared" of the old technical doc nor the proposal's 48
  placeholder (proposal §3.2 estimated 40–80 — also low). Static smem is **18.5 KB**, dominated by
  `s_force_function[MAX_ITERATIONS_IN_CYCLE × MAX_NUM_STRINGS_IN_ARRAY]` = 1024×4×4 B = 16 KB.
- **The debug kernel is LIGHTER than release today** (99 vs 119) — it carries `__launch_bounds__(512,1)`
  (`MainKernel.cu:115-119`, dev-bug1rt) and is built `-O2`. The regmem plan §1.4 premise "debug is
  register-heavier" no longer holds for current code; release is the variant closest to the cliff.
- Release `addKernel` has **no register cap** (`ADDKERNEL_LAUNCH_BOUNDS` expands to nothing in release).

### 1.3 `-maxrregcount` sweep (release flags, sm_89) [MEAS]

Script: [`diagnostics/dev-dad7-maxrreg-sweep.sh`](diagnostics/dev-dad7-maxrreg-sweep.sh) (compile-only flag
sweep, no source edit).

| cap | regs used | stack | spill st / ld |
|---|---|---|---|
| none (as shipped) | 119 | 0 | 0 / 0 |
| 128 | 108 | 0 | 0 / 0 |
| 96 | 88 | 0 | 0 / 0 |
| 80 | **79** | 0 | **0 / 0** |
| 72 | 72 | 24 B | 24 / 32 B |
| 64 | 64 | 40 B | 44 / 48 B |
| 56 | 56 | 72 B | 92 / 88 B |
| 48 | 48 | 112 B | 132 / 144 B |

The kernel's real live set fits in **79 registers spill-free**; the uncapped 119 is the compiler spending
free registers on ILP. A cap **changes release codegen** (cap 128 → 108 regs) — its effect on per-cycle
time is **[UNMEASURED]** (needs a timing A/B, see §4).

---

## 2. Occupancy and cooperative co-residency

### 2.1 Method [MEAS]

[`diagnostics/dev-dad7-occupancy.py`](diagnostics/dev-dad7-occupancy.py): the `addKernel` sm_89 cubin
(extracted with `cuobjdump -xelf` from the worktree objects) is loaded into a **private** CUDA context via the
driver API (ctypes on `nvcuda.dll` — no `pianoidCuda` import, no engine init, no audio device), then
`cuFuncGetAttribute` + `cuOccupancyMaxActiveBlocksPerMultiprocessor(block, dynSmem=0)` — the same query the
regmem plan's §4.2 pre-flight would make. Device attributes queried live.

### 2.2 Results

Device [MEAS]: RTX 4090, 128 SMs, 1536 threads/SM, 65,536 regs/SM, 102,400 B smem/SM, 24 blocks/SM,
cooperative launch supported.

| Variant | numRegs | maxThreadsPerBlock | blocks/SM @512 | @384 | @256 | @128 | coop capacity @512/384 |
|---|---|---|---|---|---|---|---|
| release | 119 | 512 | **1** | **1** | 2 | 4 | **128** |
| debug | 99 | 512 | **1** | **1** | 2 | 4 | **128** |

Block = `array_size` threads (`Pianoid_synthesis.cu:261-262`: `dim3(array_size/32, 32)`); grid =
`num_string_arrays()` = num_strings/4 → **Belarus_8band_196modes 56 blocks @ 384 thr; F15_Elyashev_array512
58 blocks @ 512 thr** [MEAS from the preset JSON]. Capacity 128 ≥ 58 → **2.2× block headroom**; occupancy is
1 block = 16 of 48 warps (33 %) at 512, 12/48 (25 %) at 384.

### 2.3 Register headroom [DERIVED]

At one block/SM the register file limits regs/thread to `65536 / blockThreads` (8-reg granularity):

| array_size (block) | Cliff (block cannot launch above) | Headroom from release 119 | Headroom from spill-free floor 79 |
|---|---|---|---|
| **512** (F15 / array512 presets) | **128** | **9 regs** | 49 regs |
| 384 (Belarus) | 168 | 49 regs | 89 regs |

- **Correction to the proposal (§3.1 table / brief "hard ~168"):** 168 is the cliff only at array_size 384.
  At **array_size 512 the hard cliff is 128** — release sits **9 registers** below it.
- Crossing the cliff with an **uncapped** kernel does **not spill**: ptxas will happily emit >128 regs, the
  kernel's `maxThreadsPerBlock` drops below 512, and the cooperative launch fails
  (`cudaErrorCooperativeLaunchTooLarge` / out-of-resources) → the BUG-1 silent-0-cycle class. Under
  `__launch_bounds__(512,1)` the compiler instead spills to stay ≤128.
- The regmem plan §1.3 table (fits 56 blocks up to ~128 r/t) is **confirmed** for 512-thread blocks.
- Flat-oscillator budget at ~5 regs/flat mode (proposal §3.3): uncapped @512 → **1 mode/thread** fits
  (124 regs, 4 to spare); capped → the 49-reg gap to the floor is ~9 modes/thread of slack (perf unmeasured).
- Shared-memory fallback (proposal §3.6) is **cheap**: 48 KB static − 18.5 KB = ~29.5 KB/block free (≈82 KB
  with opt-in dynamic smem). 4000 modes / 56 blocks ≈ 72 flat modes/block × (q, q_prev) × 4 B ≈ **0.6 KB**.
- Runtime budget **with the SDL3/ASIO driver active** (dev-bug1rt's case) is **[UNMEASURED]** — the occupancy
  API does not see other contexts; it needs the in-engine pre-flight (regmem plan §4).

---

## 3. Deck coupling-shape analysis (Belarus_8band_196modes, F15_Elyashev_array512)

### 3.1 Data Model Card (facts the analysis relies on)

| Fact | Support |
|---|---|
| preset `pitch.deck` = base64 float64 `[2, num_modes]` = `stack([feedin, feedback])` | [DOC] [DATA_FLOWS → Preset file format](http://localhost:8001/architecture/DATA_FLOWS/) (`"deck": {"shape": [2, num_modes]}`, `encode_for_json(np.stack([feedin, feedback]))`) |
| Kernel deck = **one row per string**, each string carries its pitch's row; piano rows = `effective_deck('feedin')`, used for **both** directions (single-matrix mode, `USE_SINGLE_DECK_MATRIX=1`) | [DOC] [context doc §1.1/§2.1/§2.4](http://localhost:8001/development/string-mode-coupling-mode-scaling-context-2026-06-06/); verified `StringMap.pack_deck` (`pitch_index` = per string) + `constants.h:155` |
| Output pitches (≥128) rows = `effective_deck('feedback') × string-SC gain` | [DOC] context doc §2.4; DATA_FLOWS §2.4 |
| `effective_deck = raw × deck_mask`; no masks stored in these presets → effective == raw | [DOC]-adjacent: `Pitch.effective_deck` docstring; preset has no mask key [MEAS] |
| Mode frequency: F15 stores `frequency`; Belarus (legacy) → `sqrt(stiffness/mass)/(2π)` with `mass` read as `mass_inv` | [DOC] [OVERVIEW → Piano_mode](http://localhost:8001/modules/pianoid-basic/OVERVIEW/) ("Either set may be provided"); `Mode.fit_params` legacy branch (`Mode.py:130-132`) |
| F15 deck = FPGA `Ci_coef_cos`, per-mode normalised, signed, feedback = feedin | [DOC] OVERVIEW → FPGA preset converter |

Analysed matrix: piano strings × modes (Belarus 220 × 196, 84 pitches; F15 228 × 196, 88 pitches), columns
sorted by mode frequency (both presets already are). Script:
[`diagnostics/dev-dad7-deck-shape-analysis.py`](diagnostics/dev-dad7-deck-shape-analysis.py) (read-only on
the preset JSON, PianoidCore venv numpy/scipy).

### 3.2 Column flatness vs mode frequency

Per mode `m` the column `c_m(s)` over strings. CV = std/|mean|; |cos(c_m, 1)| = 1 for a perfectly uniform
coupling; minority-sign fraction > 0 = the column changes sign across strings.

| band (Hz) | Belarus modes | CV | \|cos(c,1)\| | F15 modes | CV | \|cos(c,1)\| | F15 minority-sign |
|---|---|---|---|---|---|---|---|
| 0–100 | 2 | 0.54 | 0.880 | 6 | 0.17 | 0.986 | 0.00 |
| 100–200 | 6 | 0.38 | 0.934 | 9 | 0.14 | 0.990 | 0.00 |
| 200–400 | 23 | 0.43 | 0.918 | 16 | 0.09 | 0.995 | 0.00 |
| 400–800 | 37 | 0.43 | 0.920 | 15 | 0.19 | 0.983 | 0.00 |
| 800–1600 | 46 | 0.45 | 0.913 | 23 | **2.61** | **0.358** | **0.30** |
| 1600–3200 | 41 | 0.45 | 0.911 | 30 | 1.05 | 0.688 | 0.09 |
| ≥3200 | 41 | 0.46 | 0.907 | 97 | 0.75 | 0.800 | 0.00 |

**Reading:** there is **no frequency above which coupling becomes flat.** Belarus columns are all-positive,
equally non-uniform (CV ≈ 0.45) at every frequency. F15 is *nearly uniform at LF* (<800 Hz) and becomes
**signed / less uniform at HF**. The proposal's premise (§9, substrate §0b: "HF rows are near-separable →
flatten") is **not supported by either preset** as "flat = uniform"; it is supported only in the
**low-rank** sense (§3.3–3.4).

### 3.3 SVD energy spectrum (rank-1 terms for 90 / 99 / 99.9 % energy)

| subset | Belarus modes | k90 | k99 | k99.9 | σ2/σ1 | F15 modes | k90 | k99 | k99.9 | σ2/σ1 |
|---|---|---|---|---|---|---|---|---|---|---|
| all modes | 196 | 2 | 16 | 34 | 0.137 | 196 | 2 | 5 | 12 | 0.402 |
| f ≥ 400 Hz | 165 | 1 | 15 | 33 | 0.133 | 165 | 2 | 5 | 10 | 0.435 |
| f ≥ 800 Hz | 128 | 1 | 14 | 31 | 0.142 | 150 | 2 | 4 | 8 | 0.444 |
| f ≥ 1600 Hz | 82 | 1 | 13 | 30 | 0.138 | 127 | 2 | **2** | **2** | 0.444 |
| f ≥ 3200 Hz | 41 | 1 | 9 | 20 | 0.155 | 97 | 2 | **2** | **2** | 0.420 |

(One-row-per-pitch, i.e. de-duplicated unisons: Belarus 2/17/35, F15 2/5/13 — unison duplication does not
change the rank picture.) Energy is dominated by the large-coupling modes, so §3.4 also reports a
**per-mode** (scale-free) error.

### 3.4 Shape groups G (proposal's piecewise rank-1) vs a shared rank-r basis

**G** = complete-linkage clusters of columns by |normalised correlation| (sign-free — the per-mode gain
`a(m)` absorbs sign and scale), so every pair in a group has |corr| ≥ τ. "resid" = energy not captured by one
rank-1 term per group. Per-mode error = `‖c_m − approx‖/‖c_m‖`. **r** = size of a *shared basis*
`c_m ≈ Σ_k A[m,k]·b_k(s)` (SVD of per-mode-normalised columns) needed for **max** per-mode error ≤ tol.

**Belarus_8band_196modes**

| flat band f ≥ | n_shaped below | n_flat | G@0.90 | G@0.95 | G@0.99 | resid @.90/.95/.99 | per-mode err G=1 med/max | G@0.95 med/max | G@0.99 med/max | r for ≤10/5/1 % |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | 196 | 20 | 43 | 115 | 3.0/1.3/0.19 % | 0.31/0.59 | 0.10/0.22 | 0.04/0.10 | 29/36/69 |
| 400 | 31 | 165 | 16 | 34 | 97 | 3.0/1.4/0.18 % | 0.30/0.48 | 0.11/0.22 | 0.04/0.10 | 27/35/66 |
| 800 | 68 | 128 | 11 | 27 | 72 | 3.2/1.3/0.18 % | 0.29/0.46 | 0.11/0.21 | 0.04/0.09 | 23/34/62 |
| 1600 | 114 | 82 | 7 | 20 | 51 | 3.9/1.4/0.17 % | 0.29/0.44 | 0.11/0.22 | 0.04/0.09 | 18/31/56 |
| 3200 | 155 | 41 | 5 | 11 | 26 | 2.9/1.4/0.14 % | 0.27/0.39 | 0.11/0.19 | 0.04/0.07 | 12/22/39 |

**F15_Elyashev_array512**

| flat band f ≥ | n_shaped below | n_flat | G@0.90 | G@0.95 | G@0.99 | resid @.90/.95/.99 | per-mode err G=1 med/max | G@0.95 med/max | G@0.99 med/max | r for ≤10/5/1 % |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | 196 | 22 | 35 | 58 | 0.9/0.5/0.14 % | 0.48/1.00 | 0.06/0.22 | 0.02/0.11 | 17/23/38 |
| 400 | 31 | 165 | 21 | 29 | 49 | 0.8/0.5/0.09 % | 0.67/1.00 | 0.06/0.21 | 0.02/0.11 | 15/18/28 |
| 800 | 46 | 150 | 18 | 26 | 40 | 1.1/0.4/0.07 % | 0.69/1.00 | 0.05/0.19 | 0.02/0.08 | 13/15/19 |
| 1600 | 69 | 127 | 8 | 12 | 23 | 1.1/0.3/0.07 % | 0.59/1.00 | 0.05/0.19 | 0.02/0.08 | **2/2/2** |
| 3200 | 99 | 97 | 7 | 11 | 21 | 1.1/0.4/0.07 % | 0.51/1.00 | 0.06/0.19 | 0.02/0.08 | **2/2/2** |

**Readings.**
1. **A single flat shape (G=1, the proposal's Phase-2 `w(s)=1`/one-shape group) is acoustically not a
   candidate:** median per-mode coupling error 27–31 % (Belarus), 48–69 % with sign inversions up to 100 %
   (F15). It is only a plumbing step.
2. **G is large at tight tolerance and does not collapse with frequency** for Belarus: G@0.99 ≈ 0.6 × n_flat
   at every cut (115/196 … 26/41). Only loose tolerance gives small G (G@0.90 = 5–20, max per-mode error
   ~0.4).
3. **A shared low-rank basis beats piecewise rank-1 clustering, decisively on F15:** the 127 F15 modes above
   1600 Hz are **exactly rank 2** (r=2 at 1 % max error) while clustering needs G=23 at τ=0.99 and still has
   8 % max error — the columns are mixtures `α_m u1 + β_m u2` with a continuously varying ratio
   (consistent with the converter's `Ci_coef_cos` cosine coupling, cos(a+b) = cos a cos b − sin a sin b —
   [DERIVED], not separately verified). For Belarus the basis is ~3–4× smaller than G at equal max error
   (all modes: r=29 for ≤10 % vs G@0.99=115 for ≤9.5 %).
4. **Reciprocity holds exactly in storage** (feedin == feedback, every piano pitch, both presets); the
   kernel's runtime `deck_feedback_coefficient` is one scalar on piano rows → **`a_out = coeff·a_in`**: one
   coefficient array suffices (answers proposal §12.2 "reciprocity").
5. Output (readout) rows: 4 channels, rank 3 (Belarus 90 %) / 4 (F15) — trivially per-mode × 4.
6. **Caveat:** both presets have 196 modes; no 4000-mode deck exists, so G/r at 4000 is an extrapolation.
   For formula-generated decks (F15 type) the rank-2 HF structure should persist at any mode count; for
   fitted decks (Belarus type) G and r will grow with n_flat (Belarus r@5 % grows 22→36 as n_flat 41→196).

---

## 4. Implications for the proposal's P1–P4

| Phase | Verdict | Adjustment driven by the measurements |
|---|---|---|
| **P1** quarter-fork refactor (behaviour-preserving) | **GO, with a precondition** | Release R0 = 119 is **9 regs from the 512-thread cliff** and uncapped. Before adding *any* per-thread state: (a) add `__launch_bounds__(arraySizeMax=512, 1)` (or `-maxrregcount 128`) to the **release** `addKernel` so growth spills instead of breaking the cooperative launch; (b) land the regmem plan's runtime pre-flight (`cuOccupancy… × SMs ≥ grid`); (c) **timing A/B of the cap alone** (it changes codegen: 119→108) — per-cycle mean/p99, N≥3 runs, at array_size 384 **and** 512. |
| **P2** one flat group, small n_flat | **GO as plumbing only** | A single shape costs 27–69 % median per-mode coupling error — never an acoustic configuration. Use "one measured shape" only to prove the reduction path; `n_shaped = num_modes` zero-regression check stands. Use the reciprocity result: one gain array (`a_out = deck_feedback_coeff · a_in`). |
| **P3** multiple groups (G) | **ADJUST — prefer a shared rank-r basis over piecewise rank-1 clusters** | Same machinery (one cross-block reduction pair per basis vector instead of per group), but per flat mode store r coefficients `A[m,k]` (from smem/L1 — not registers) instead of (gain, group id). Measured: F15 HF r=2 vs G=23; Belarus r≈18–36 vs G≈50–115 at comparable max error. If clusters are kept, G at τ=0.99 is ~0.6·n_flat for fitted decks — **no 30–4000× win** for Belarus-type decks. Choose the tolerance only after the A/B render (still [UNMEASURED], proposal §12.3 #2). |
| **n_shaped boundary** | **ADJUST — not frequency-derived** | Coupling does not flatten with frequency (Belarus constant; F15 *less* uniform at HF). Set n_shaped by cost/acoustic budget (A/B render), or per preset by where the residual rank saturates (F15: < 1600 Hz shaped, ≥ 1600 Hz rank-2 flat is a natural split, 69 shaped / 127 flat). |
| **P4** scale to 4000 | **GO on registers/smem, conditional on P1 cap + timing** | Grid stays 56–58 ≪ 128 capacity; SEGMENT 64 OK. M_t ≤ 1 (≈5 regs) fits only *with* the cap at array_size 512 (uncapped: 124/128). Shared-memory home for flat state is ~0.6 KB/block of ~29.5 KB free — a safe fallback. Coefficient storage for a rank-r basis: 4000·r floats (r=30 → 480 KB global, L2-resident). Needs a real 4000-mode deck (generator) to measure G/r at scale. |

**Still open after P0 [UNMEASURED]:** per-cycle timing cost of a release register cap; runtime co-residency
with the audio driver active (in-engine pre-flight); the A/B `note_playback` render that sets the acceptable
coupling tolerance (proposal §12.3 #2); G/r on an actual ≥1000-mode deck.

## 5. Doc drift found (not fixed here — flagged)

- `COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md` / substrate §4 "~20–30 registers/thread, ~3 KB shared" →
  measured **119 regs, 18.5 KB** (release).
- Regmem plan §1.4 "debug kernel is register-heavier than release" → measured debug **99 < release 119**.
- Proposal §3.1 / §3.4 use 2048-thread (sm_80/86) caps and R0=48 placeholder; §3 occupancy rows are
  superseded by §2 here (sm_89: 1 block/SM, cliff 128 @512 / 168 @384).

## Scripts (all under `docs/development/diagnostics/`)

| Script | Purpose |
|---|---|
| `dev-dad7-ptxas-r0.sh` | compile-only `-Xptxas -v` of every kernel TU, release + debug, sm_80/86/89 |
| `dev-dad7-parse-ptxas.py` | ptxas logs → per-kernel table |
| `dev-dad7-maxrreg-sweep.sh` | `addKernel` release under `-maxrregcount` N → regs + spills |
| `dev-dad7-occupancy.py` | driver-API occupancy query on the addKernel cubin (no engine import) |
| `dev-dad7-deck-shape-analysis.py` | deck flatness / SVD / G clustering / shared-basis r / reciprocity |
