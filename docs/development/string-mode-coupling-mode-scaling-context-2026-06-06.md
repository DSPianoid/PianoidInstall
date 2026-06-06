# String–Mode Coupling & Mode-Count Scaling — Context for Radically Increasing Modes

**Date:** 2026-06-06
**Author:** research/context-prep agent (investigation only — no code edits, no builds)
**Goal:** Provide the complete, accurate technical context needed to later *radically increase
the number of soundboard resonance modes* in the synthesis engine.

> **Reading this doc.** Every high-stakes data-model fact is tagged:
> **[DOC]** = directly supported by existing docs; **[SRC]** = confirmed by reading source in
> this session (file:line cited); **[MEAS]** = read off a live preset/value this session;
> **[UNCERTAIN]** = inferred but not confirmed against live engine — flagged for follow-up.
> Per the project's high-stakes-inference rule, do not treat **[UNCERTAIN]** facts as load-bearing
> for an implementation without measuring them first.

---

## 0. Executive Summary

> **Primary goal (user, 2026-06-06): reach 4000 total modes via a two-tier SHAPED/FLAT split** — a
> small low-frequency SHAPED set kept on the current full shape-aware coupling, and the bulk treated
> as uniformly FLAT (per-(string,mode) coupling → simple summation). **The full design frame is
> §0b** (read it first); §1–§9 document the current system that design is built on.

- **Current effective mode count K.** The kernel iterates **`num_modes_for_model` mode-slots per
  cycle, and `num_modes_for_model` is padded up to `num_strings`** — so in production the kernel
  always processes **K = num_strings mode-slots**, of which the first `num_modes` are *real* modes
  and the remainder are **dummy modes (ID = −1)**. For the real presets measured this session
  (`BaselinePreset1`, `Belarus_8band_196modes`): `num_strings = 224`, so **K = 224 mode-slots**,
  with **196 real modes** (Belarus) / **100 real modes** (Baseline) and the rest dummy. **[MEAS]**
- **Where the count is defined.** Three layers each carry their own constant:
  - **Kernel compile-time array dimension:** `NUM_MODES = 256` in
    `PianoidCore/pianoid_cuda/constants.h:12`. **[SRC]**
  - **Python domain default / max:** `DEF_NUM_MODES = 32`, `MAX_NUM_MODES = 256` in
    `PianoidBasic/Pianoid/ModelParams.py:11-12`. **[SRC]**
  - **Effective per-run count:** `cycle_parameters[2] = init_params_.num_modes`
    (`Pianoid.cu:142`), where `init_params_.num_modes` is set from Python's `num_modes_for_model`,
    itself forced to `num_strings` (`pianoid.py:201`, `:2577`, `:3331`). **[SRC]**
- **The dominant hard ceiling of the CURRENT kernel is NOT `NUM_MODES=256` — it is the kernel's
  mode-placement formula `modeNo = numArrays * quarterNumber + blockNo`** (`Kernels.cu:253`) plus the
  `indexInQuarter==0` oscillator-update gate (`MainKernel.cu:667`), which together address at most
  `numArrays * num_strings_in_array = num_strings` distinct modes. Modes do **not** get their own
  CUDA blocks: they piggy-back on the string blocks via a quarter/fold indexing scheme. So
  **`num_modes ≤ num_strings` is a structural invariant of the current kernel**, independent of the
  `NUM_MODES=256` array bound. **[SRC]** This is reinforced by middleware comments
  (`PanoidResult.py:11-13`, `create_belarus_preset.py:55` "num_modes + num_sound_channels must be
  <= num_strings").
  > **⚠ See §0c (2026-06-06 correction).** This bound is caused by the *index convention*, **not**
  > by any per-block hardware/occupancy limit. A block spends all 512 threads on 4 strings' spatial
  > points but only **4 threads + 4 reals** on oscillators — ~508 threads idle of mode work. Several
  > scalar mode-oscillators CAN therefore share one string slot (the user's correction, SRC-confirmed),
  > so 4000 modes need not force `num_strings`→4000. The bound is real but **escapable by re-indexing,
  > not only by adding strings.**
- **Worst-scaling structures** (as a function of mode count M, when M is raised by raising
  num_strings to match): the deck/coupling matrix `dev_deck_parameters` scales **O(num_strings ×
  num_modes) = O(num_strings²)** because its row width is padded to `num_strings`; the per-string
  WORKING simulation buffers (`dev_string_state`, `dev_force_function`, the cycle matrices, the
  DEBUG `dev_output_data`) scale **O(num_strings × array_size)**. The mode *config/running* buffers
  (`dev_mode_state`, `dev_mode_running`) are tiny (O(modes)) but **fixed-allocated at `NUM_MODES`**.
- **Top constraints for a radical increase**, in order of severity:
  1. **Mode-per-string-slot coupling** — adding modes requires adding string slots (num_strings),
     which is the architectural bottleneck. There is no independent "modes" axis to grow.
  2. **Cooperative-grid launch** — `addKernel` is launched with
     `cudaLaunchCooperativeKernel` (`Pianoid_synthesis.cu:345`). A cooperative grid must be
     **fully co-resident on the GPU in one wave**. Grid = `num_string_arrays` blocks ×
     `array_size` threads. More strings → more blocks → may exceed the device's
     max-resident-blocks for a cooperative launch → launch fails.
  3. **`SEGMENT_FOR_SHUFFLE_SUMMATION = 64`** (`constants.h:90`) — the reduction segment width
     **must be ≥ the number of blocks (numArrays) and divisible by 32**. With num_strings ≤ 256 and
     num_strings_in_array=4 → 64 blocks max, exactly at the limit. Raising num_strings past 256
     overflows this constant and silently corrupts the feedin/feedback reductions.
  4. **Compile-time `NUM_MODES = 256` and `NUM_STRINGS = 256`** — array dimensions and several
     fixed allocations (`dev_mode_running = NUM_MODES*2`) are sized by these; raising the real
     ceiling means raising both.
  5. **`MAX_QUARTER_SIZE` / fold scheme** — `MAX_NUM_MODES_BY_QUARTER = MAX_QUARTER_SIZE*2 = 256`
     and `NUM_FOLDS_IN_QUARTER = 3` encode the quarter-fold addressing; they co-define the mode
     reach and must be revisited.
- **Cross-layer change map (summary; full version in §8):** kernel constants (`constants.h`) →
  kernel mode-placement + fold + reduction logic (`Kernels.cu`, `MainKernel.cu`) → fixed
  allocations (`Pianoid.cu`) → Python `ModelParameters` / `ModeMap` padding (`ModelParams.py`,
  `Mode.py`) → deck packing (`StringMap.py`) → middleware num_modes plumbing (`pianoid.py`,
  `backendServer.py /health`) → frontend `totalModes` + matrix mode-axis (`usePreset.js`,
  `MeasuredMatrix.jsx`, `SoundChannelsPane.jsx`).
- **Key risks:** the cooperative launch silently failing under contention; the
  `SEGMENT_FOR_SHUFFLE_SUMMATION` overflow being *silent* (wrong sound, not a crash); O(num_strings²)
  deck memory blow-up; and the architectural reality that "more modes" is really "more strings,"
  with all the per-string FDTD cost that implies.

---

## 0b. PRIMARY DESIGN FRAME — 4000 Modes via a Two-Tier Shaped/Flat Split

> **This is the design the whole document exists to enable.** Target: **4000 total modes.**
> Direction: split modes into **(1) a small SHAPED set** (low-frequency modes, kept on the
> *current* full shape-aware spatial-coupling treatment) and **(2) a large FLAT set** (the bulk of
> the 4000, treated as **uniformly flat** — the per-(string,mode) spatial coupling collapses to a
> **simple summation**).

### 0b.1 What the current "shaped" treatment IS — characterize the "convolution" concretely

There is **no FFT/DSP convolution** in the mode coupling — the "convolution / shape-aware"
operation is the **per-(string, mode) spatial-coupling weighted reduction**, i.e. a
matrix–vector product against the deck mode-shape matrix, done **every audio sample**:

```
FEEDIN  (string → mode), per sample:
    F_applied(m) = Σ_strings  deck[string, m] · bridgeForce(string) / soundStep
                                ^^^^^^^^^^^^^^^  per-(string,mode) mode-shape weight
FEEDBACK (mode → string), per sample:
    feedback(s)  = Σ_modes    deck[s, m] · q(m) · fb_scale(s)
                                ^^^^^^^^^  same per-(string,mode) weight (reciprocity)
    stem(s) = feedback(s)                       // overwrites the bridge boundary
```

**[SRC]** Feedin scatter `MainKernel.cu:622-623` (`mode_feedin[i] * force_on_bridge_summed /
soundStep` into `feedin_cycle_matrix`), reduced by `sumArray` (`:641`); feedback scatter `:441-442`
(`mode_feedback[i] * s_mode[quarter]` into `feedback_cycle_matrix`), reduced by `sumArray` (`:469`).
`mode_feedin`/`mode_feedback` are loaded from `mode_coefficients` (= `dev_deck_parameters`) at
`MainKernel.cu:249, 265`. The deck coefficient `deck[s,m]` is the **normalised spatial mode-shape
amplitude at pitch s's bridge position** (0–1, per-mode normalised). **[DOC]** (OVERVIEW "Coupling
Coefficients"; SYNTHESIS_ENGINE "Coupling Coefficients").

So the **"convolution" the shaped set keeps = the full dense `string × mode` weighted
reduction** (an O(strings × modes) matmul-per-sample, realised via atomic scatter into
`feedin/feedback_cycle_matrix` + `sumArray`). What makes it "shaped": each (string,mode) pair has
its **own** weight `deck[s,m]` — the spatial pattern of where each mode couples to each bridge.

The shaped set also keeps the full **per-mode oscillator** (`q̈+2γq̇+ω²q=F/m`,
`MainKernel.cu:668-672`) with per-mode `dec/omega/mass_inv` — that part is **already O(modes), not
O(strings×modes)**, and is cheap; it is the *coupling* (the deck weighting) that is the expensive,
shape-dependent part.

### 0b.2 What "uniformly flat → simple summation" REPLACES

A **flat** mode has **no per-(string,mode) shape** — its coupling weight is the *same* for all
strings (a single scalar per mode, or even unity). That collapses the two weighted reductions:

```
FLAT FEEDIN  (string → mode):
    F_applied(m) = a_in(m) · ( Σ_strings bridgeForce(string) )     // ONE global string-force sum,
                                                                    // reused by ALL flat modes
FLAT FEEDBACK (mode → string):
    feedback_flat = Σ_modes  a_out(m) · q(m)                       // ONE global scalar,
    stem(s) += feedback_flat   (× fb_scale / per-output gain)      // broadcast to every output point
```

The crucial collapse: **the per-(string,mode) double loop becomes two single sums.**
- The string→mode side needs only **one** reduction of total bridge force across strings (shared by
  all flat modes), then a per-mode scalar gain `a_in(m)`.
- The mode→string side becomes **one** scalar (`Σ a_out(m)·q(m)`) added to every output bridge —
  there is no per-string spatial weighting to preserve.

This turns the flat tier's coupling cost from **O(strings × flat_modes) per sample** into
**O(strings) + O(flat_modes) per sample** — the dense matmul becomes two independent sums.
**[SRC-grounded reasoning; the flat path itself is not yet in source — [UNCERTAIN] until prototyped.]**

> **Precise convolution-vs-summation difference:** shaped = *weighted* sum with a distinct
> `deck[s,m]` weight per (string,mode) pair (a dense matrix contraction); flat = *unweighted (or
> single-scalar-weighted)* sum, where the string axis and mode axis **separate** so each is summed
> once and combined by a rank-1 product. Mathematically, flat ≈ approximating the deck submatrix
> for the flat modes as a **rank-1 / separable** `a_out(m) · a_in(s)` (or `a(m)·1`) instead of a
> full-rank shape matrix.

### 0b.3 Do flat modes still need the per-mode coupling matrices?

**No — and that is the whole memory win.** **[SRC-grounded reasoning; [UNCERTAIN] pending design]**

| Structure | Shaped set needs? | Flat set needs? |
|---|---|---|
| `deck[string, mode]` (O(strings×modes)) | **Yes** — the shape weights | **No** — replace with ≤2 scalars per mode (`a_in(m)`, `a_out(m)`), i.e. **O(flat_modes)** not O(strings×flat_modes) |
| `mode_sound_channels` / `string_sound_channels` (O(pitch×channels)) | Yes (channel routing) | Flat modes fold into the single summed term → **per-channel scalar only**, no per-mode-per-pitch entries |
| `dev_mode_state` (dec/omega/mass_inv, O(modes)) | Yes | **Yes** — flat modes are still real oscillators with their own freq/damping; only their *coupling shape* is dropped |
| `dev_mode_running` (q/q_prev, O(modes)) | Yes | **Yes** — flat modes still have running state |

So the flat tier **keeps O(modes) oscillator state** (cheap, ~6 reals/mode) but **sheds the
O(strings×modes) deck**. At 4000 modes the deck for the flat tier is the structure that would
otherwise dominate, so dropping it is the key enabler.

### 0b.4 Memory + compute at 4000 under the split

Take an illustrative split: **n_shaped ∈ {64, 256}**, **n_flat = 4000 − n_shaped**, S = num_strings
(carrier). Critical: the **shaped tier still piggy-backs on string slots** (§3.3), so n_shaped ≤ S;
the **flat tier need NOT consume string slots** if it has its own summation path.

| Quantity | Shaped tier (n_shaped) | Flat tier (n_flat ≈ 4000) |
|---|---|---|
| Deck memory | O(S × n_shaped) (e.g. 256×256 ≈ 256 KB) — ~current | **O(n_flat) scalars** (≤2×4000 ≈ 8K reals, ~32 KB) — *not* O(S×n_flat) |
| Oscillator state | O(n_shaped) (~KB) | O(n_flat) (~4000×~6 reals ≈ 96 KB) |
| Coupling compute / sample | O(S × n_shaped) dense reduction (~current) | **O(S) + O(n_flat)** two separable sums |
| String slots consumed | n_shaped (≤ S) | **0** (own path) |

**Where the bottleneck shifts:** today the bottleneck is the O(S²) deck (string×mode) coupling and
the cooperative grid. Under the split, the **shaped tier stays at roughly current cost**
(small, bounded by S), and the **flat tier's new cost is the O(n_flat) reduction** `Σ a_out(m)·q(m)`
plus the O(n_flat) oscillator updates. At 4000 flat modes that reduction is a **4000-element sum per
sample** — large but a *1-D reduction*, not a matmul. **The new bottleneck becomes (a) the
O(n_flat) oscillator updates + reduction throughput, and (b) where those 4000 oscillators live in
the kernel grid** (they can't ride string slots — needs a dedicated mode partition / separate
kernel or extra blocks). Memory is no longer the binding constraint; **flat-oscillator update
throughput + the cooperative-grid layout for 4000 extra oscillators is.**

### 0b.5 The split point as a tunable parameter + kernel partitioning

- Introduce **`n_shaped`** (count of shaped modes) as a tunable model parameter (sibling of
  `num_modes`), with the convention **modes `[0, n_shaped)` are shaped, `[n_shaped, num_modes)` are
  flat** — sort modes by frequency at preset build so the shaped set = the lowest frequencies.
- **Kernel partition:** the existing mode loop branches on `modeNo < n_shaped`:
  - `modeNo < n_shaped` → current shaped path (deck-weighted scatter into
    `feedin/feedback_cycle_matrix`, per-(string,mode) `mode_feedin/feedback`).
  - `modeNo ≥ n_shaped` → flat path: contribute to/from the **single** flat accumulators
    (`flat_force_total`, `flat_feedback_total`) with per-mode scalar gains only.
- Because the flat path doesn't need the quarter/fold per-(string,mode) placement, the flat
  oscillators can be laid out **densely in their own thread range / their own kernel**, sidestepping
  the `modeNo = numArrays*quarterNumber+blockNo` ≤ num_strings ceiling (§3.3) entirely for the flat
  tier. **[UNCERTAIN — this is the design proposal, not current source.]**

### 0b.6 Cleanest architecture for the split (proposal)

1. **Data layout:** keep `dev_deck_parameters` as `S × n_shaped` (shaped only — small). Add
   `dev_flat_gain_in[n_flat]`, `dev_flat_gain_out[n_flat]` (or one if symmetric) + extend
   `dev_mode_state`/`dev_mode_running` to `num_modes = n_shaped + n_flat` (these are O(modes), cheap
   even at 4000). Per-output-channel flat routing = one scalar per channel.
2. **Kernel structure:** two phases sharing the grid sync —
   (a) shaped coupling exactly as today (bounded by n_shaped ≤ S);
   (b) flat coupling: one grid-wide reduction of total bridge force (feedin) → broadcast ×
   `a_in(m)`; flat oscillator updates over a dense `[n_shaped, num_modes)` range; one grid-wide
   reduction `Σ a_out(m)·q(m)` (feedback) → broadcast to output stems. The flat oscillators likely
   want **their own block range or a second kernel** since they don't map to string slots.
3. **Decouples the §3.3 ceiling:** `num_modes ≤ num_strings` only needs to hold for **n_shaped**,
   not the full 4000 — the flat tier escapes the string-slot mapping.

### 0b.7 Feasibility + risks of the flat approximation

- **Physical/audio rationale:** high-frequency soundboard modes are dense, individually
  inaudible-as-discrete, and their *spatial* coupling pattern matters far less perceptually than
  the low modes (which define the instrument's character and beat/coupling structure). Treating the
  HF tail as a flat (shapeless) energy sum is a defensible perceptual approximation — analogous to
  modal-density "noise-floor" treatments in physical modeling. **[UNCERTAIN — perceptual claim, not
  measured in Pianoid; needs A/B render verification per the Audio Verification Rule.]**
- **Where the shaped→flat boundary should sit:** physically, below the frequency where mode spacing
  becomes smaller than a critical band / where individual mode shapes stop being resolvable at the
  bridge. Practically it is the tunable `n_shaped`; start where the per-mode `deck` rows for HF
  modes are already near-uniform across pitches (measure the deck matrix column variance per mode —
  low variance ⇒ already ~flat ⇒ safe to flatten). **[UNCERTAIN — measure deck column variance vs
  mode frequency on Belarus before fixing the boundary.]**
- **Risks:** (1) losing per-string phase relationships of HF modes can dull/smear the attack
  transient or remove subtle inharmonic beating — must be A/B-rendered (offline `note_playback`).
  (2) Normalisation: flat-mode gains must be scaled so the flat tier's summed energy matches what
  the shaped treatment would have produced (per-mode normalisation is already mandatory — OVERVIEW
  "Per-mode normalisation is mandatory"). (3) The flat reduction `Σ a_out(m)·q(m)` over 4000 modes
  is a numerically large accumulation in float32 — consider wider accumulation / Kahan. (4) The
  shaped/flat boundary becoming a *preset* property complicates preset compatibility + the
  frontend mode-axis.

> The remaining sections (§1–§9) document the **current** system in full detail — they are the
> substrate this split is built on. Read §3.3 (the `num_modes ≤ num_strings` ceiling) and §2.1 (the
> O(S²) deck) as the two facts the split is specifically designed to escape for the flat tier.

---

## 0c. CORRECTION (2026-06-06, adversarial re-review) — the mode↔string-slot model was INCOMPLETE

> **This section supersedes the §0/§3.3 framing that "modes piggy-back ~1:1 on string slots →
> num_modes ≤ num_strings is a hardware-structural invariant."** The *current-kernel* bound
> `num_modes ≤ num_strings` is **real and confirmed [SRC]** — but the doc mis-attributed its
> CAUSE. It is **not** a hardware/occupancy/data-layout necessity (the user is right). It is a
> property of **one specific, replaceable indexing convention**: `modeNo =
> numArrays*quarterNumber + blockNo` plus the `indexInQuarter==0` gate on the oscillator update.
> The user's correction — *several mode-oscillators can share one string slot because a string is
> spatially multi-point while a mode is a single scalar* — is **CONFIRMED by source** and changes
> the change-map (§8) from "must add strings" to "can re-index modes onto spare per-block threads."

### 0c.1 What a "string slot" actually consumes vs what a mode actually consumes — [SRC]

Re-read of `Kernels.cu:185-300` + `MainKernel.cu:140-319, 666-676` + grid layout
(`SYNTHESIS_ENGINE.md` "Kernel Grid Layout"):

- **Grid:** `gridDim.x = numArrays = numStrings/numStringsInArray` blocks; **block = 512 threads**
  (`blockDim.x=4`, `blockDim.y=128`; `MAX_ARRAY_SIZE=512`). **[SRC/DOC]**
- **A STRING is genuinely multi-point.** Each block packs `numStringsInArray = 4` strings
  side-by-side across the 512 threads (`stringNum_s[idx] = stringMap[...]`, `Kernels.cu:208-226`);
  each string owns a contiguous spatial point-range (`start_s..end_s`, ~128 points). The FDTD
  update (`MainKernel.cu:549-566`) runs **per spatial point** — that is where the 512 threads/block
  are spent. **[SRC]**
- **A MODE is genuinely a single scalar oscillator.** The oscillator advance
  (`MainKernel.cu:666-676`) is gated `if (indexInQuarter == 0)`, where `indexInQuarter = stMdIndex %
  quarterSize` (quarterSize = 512/4 = 128). **Exactly 4 threads per block** satisfy this
  (stMdIndex ∈ {0,128,256,384}); each updates `s_mode[quarterNumber]`, `quarterNumber ∈ {0,1,2,3}`,
  for its `modeNo`. The mode state is a tiny `__shared__ real s_mode[MAX_NUM_STRINGS_IN_ARRAY]`
  (size **4**) — i.e. the block currently reserves room for only 4 live mode amplitudes. **[SRC]**

> **THE ASYMMETRY THE USER IDENTIFIED, made precise [SRC]:** within a 512-thread block, the string
> machinery consumes **all 512 threads** (4 strings × ~128 points), but the mode machinery consumes
> only **4 threads** (one per quarter) and **4 reals of shared memory**. **508 of 512 threads do no
> oscillator work.** A single scalar oscillator (`q̈+2γq̇+ω²q=F/m`, ~6 reals + ~3 FLOPs/sample) is
> ~2 orders of magnitude cheaper than a 128-point FDTD string. So the claim "one string slot's
> multi-point machinery could host many mode-oscillators" is **structurally TRUE** — there is spare
> per-block thread + register + shared-mem budget for far more than 4 oscillators.

### 0c.2 So WHY is `num_modes ≤ num_strings` true today? — [SRC] it's the *index convention*, not hardware

The bound is produced **entirely** by two coupled conventions, both replaceable:

1. **`modeNo = numArrays*quarterNumber + blockNo`** (`Kernels.cu:253`). With `quarterNumber ∈ {0..3}`
   and `blockNo ∈ {0..numArrays-1}`, the set of distinct `modeNo` is exactly `{0 .. 4*numArrays-1} =
   {0 .. numStrings-1}`. The mode index is *defined as a function of the string-block geometry*, so
   it cannot exceed it. **[SRC]**
2. **The `indexInQuarter==0` gate** (`MainKernel.cu:667`) → 1 oscillator per quarter → 4 per block.
   This is the line that throws away the other 508 threads. **[SRC]**

Neither is a hardware necessity. To host **K_block modes per block** instead of 4, you would (a)
let the oscillator update run on more than one thread per quarter (e.g. loop, or use the idle
threads with a stride), and (b) replace `modeNo`'s definition with one whose range is `K_block ×
numArrays` rather than `4 × numArrays`. The `s_mode[4]` shared array would grow to `s_mode[K_block ×
4]` (still tiny — even 256 modes/block = 256 reals = 1 KB shared, well under the ~3 KB current use).
**[SRC-grounded reasoning; the re-indexed kernel is a design, not current source → [UNCERTAIN]
until prototyped.]**

> **CORRECTED CEILING STATEMENT.** *Current kernel:* `num_modes ≤ num_strings` **[SRC, confirmed]**.
> *Cause:* the `modeNo` formula + `indexInQuarter==0` gate, **not** a per-block resource limit.
> *Implication for 4000 modes:* you do **not** have to inflate `num_strings` to 4000 (which would
> blow up the O(S²) deck and the O(S·A) FDTD buffers, §4/§6). You can instead **pack many
> oscillators per existing block** using the spare threads. This is a *different and cheaper* escape
> route than §0b/§8-TierB's "give modes their own grid dimension," and it is the one the user's
> idea exploits.

### 0c.3 One caveat the asymmetry does NOT remove — the COUPLING is still per-(string,mode) — [SRC]

The oscillator is cheap and packable; the **coupling reduction is the expensive part and it is
genuinely 2-D.** `mode_feedin[i] = mode_coefficients[stringNoForQuarter*numModes +
modeIndexInQuarter[i]]` (`MainKernel.cu:249`) and the feedback
`mode_coefficients[foldedIndexInQuarter[i]*numModes + modeNo]` (`:265`) both index a distinct
weight per (string, mode). Packing N oscillators into one block makes the *oscillator updates*
N-cheap, but each packed oscillator still needs its **own column of the deck** and its **own
string→mode / mode→string reduction** unless that coupling is shared (which is exactly the user's
premise — see §0d). **Packing oscillators ≠ packing coupling.** The win from packing is only
realised if the coupling is *also* collapsed; otherwise you've saved 4 threads' worth of arithmetic
and still pay O(strings×modes). **[SRC]** This is the hinge the next section turns on.

---

## 0d. THE BLOCK-GROUPING-BY-SHARED-COUPLING IDEA — steelman, then adversarial criticism

> **User's idea (verbatim intent):** *"provided that all modes sharing one string also share the
> SAME COUPLING COEFFICIENTS, they can be processed together in the same block."* I.e. group modes
> that have identical coupling, place the whole group in one block, and update them together —
> amortising the per-block coupling work across the group.

### 0d.1 STEELMAN — the strongest version of the idea, and why it is sound where it applies

Decompose the per-sample coupling cost. For a group **G** of modes that **share one coupling vector
across strings** — i.e. for every mode m∈G and string s, `deck[s,m] = w(s)` (the *same* string-shape
`w(s)`, independent of which mode in the group) — the two reductions factor:

```
FEEDIN  (string → each mode m∈G):
    F_applied(m) = Σ_s w(s)·bridgeForce(s)              ← SAME sum for ALL m∈G
                 = (Σ_s w(s)·bridgeForce(s))            ← compute ONCE per group
    → cost: O(strings) ONCE per group  +  O(|G|) trivial fan-out (optionally ×a_in(m))

FEEDBACK (each mode m∈G → string s):
    feedback(s) += Σ_{m∈G} w(s)·q(m) = w(s)·(Σ_{m∈G} q(m))   ← factor w(s) OUT of the mode sum
    → cost: O(|G|) to form Σ q(m) ONCE  +  O(strings) to scatter w(s)·(Σq)  per group
```

**This is real and correct.** When a group shares the string-coupling shape `w(s)`, the dense
`O(strings × |G|)` block of the deck contraction **collapses to `O(strings) + O(|G|)` per sample** —
the string axis is summed once (reused by all group members on feedin) and `Σ q(m)` is summed once
(reused by all strings on feedback). That is an **exact algebraic factorisation, not an
approximation**, *given* the shared-coupling premise. The mode group can then live in **one block**:
form `Σ q(m)` in shared memory, do one `w(s)`-weighted scatter, advance all |G| oscillators on the
block's spare threads (§0c.1). **[SRC-grounded algebra; [UNCERTAIN] as a kernel until prototyped.]**

So the steelman verdict: **the idea is valid and beneficial exactly when the premise holds** — and
the spare-thread asymmetry of §0c is precisely what makes "process them together in one block"
physically implementable.

### 0d.2 INTERROGATING THE PREMISE — "modes sharing a string share the same coupling"

This is the load-bearing assumption and it is **false in general by construction** [SRC]: the deck
matrix's *entire purpose* is that `deck[s,m]` is the **normalised spatial mode-shape amplitude of
mode m at string s's bridge position** (§0b.1, OVERVIEW "Coupling Coefficients"). Two different
modes m₁≠m₂ have **different spatial shapes**, so `deck[s,m₁] ≠ deck[s,m₂]` in general — that is the
whole reason the matrix is 2-D. **Modes sharing a string slot today do NOT share coupling** — they
share a *thread-placement slot*, which is unrelated to their coupling values. So the premise, taken
literally against the current data model, **does not hold for arbitrary modes.** [SRC]

**When DOES it hold?** Only when the group's modes are *deliberately constructed* to share `w(s)`.
Three regimes:

| Regime | Does shared-coupling hold? | Why |
|---|---|---|
| **Shaped tier** (low-freq, per-mode shape is the point) | **NO** | distinct `deck[s,m]` per mode is the feature; grouping would destroy the shapes [SRC] |
| **Flat tier** (the §0b bulk: coupling approximated as separable `a_out(m)·a_in(s)` or `a(m)·1`) | **YES — by construction** | flattening *defines* a shared string-shape (`a_in(s)`, or unity); every flat mode uses the same `w(s)` |
| **Arbitrary HF modes left un-flattened** | NO | same as shaped — real per-mode shapes differ |

> **ALIGNMENT CONFIRMED [SRC-grounded].** The user's grouping premise is satisfied **precisely by
> the flat tier and ONLY the flat tier.** Flattening a mode *means* replacing its per-string shape
> with a single shared string-vector `a_in(s)` (rank-1, §0b.2) — which is exactly "all these modes
> share the same coupling coefficients across strings." So the user's "group by shared coupling" is
> not a new requirement layered on top of the shaped/flat split; **it is the operational definition
> of the flat tier, viewed from the kernel-scheduling side.** The shaped tier categorically cannot
> be grouped this way. This refutes any reading where block-grouping is a general-purpose speedup
> for all modes, and confirms it as a flat-tier-only mechanism. **[SRC for "shaped can't";
> SRC-grounded for "flat can"; [UNCERTAIN] only on whether real Pianoid HF deck rows are close
> enough to separable to flatten without audible loss — that is the §0b.7 measurement.]**

### 0d.3 IS IT THE SAME AS, OR BETTER THAN, §0b's "FLAT = SEPARABLE-SUM"? — be precise

They are the **same decomposition seen from two layers**:

- **§0b ("separable-sum") describes the MATH:** approximate the flat deck submatrix as rank-1
  `a_out(m)·a_in(s)` so the double sum separates into two single sums. (Algebra.)
- **§0d ("block-grouping-by-shared-coupling") describes the SCHEDULE:** put all modes that share
  `a_in(s)` in one block so the single string-sum and the single `Σq(m)` are computed once per block
  on shared memory + spare threads. (Kernel placement.)

So the user's idea is **NOT a different/competing algorithm and NOT strictly more general** — it is
the *implementation strategy* for the §0b flat tier on this specific cooperative-grid kernel. It is
**"strictly better" only in the sense that it tells you HOW to realise the §0b win efficiently on
the existing block structure** (reuse spare per-block threads, §0c) instead of inventing a whole new
grid dimension (the §8-TierB "separate kernel / mode grid" proposal). Concretely it offers two
things §0b alone did not pin down:
1. **Where the 4000 flat oscillators live** (§0b.4 flagged this as the open bottleneck): on the
   spare 508 threads/block, grouped by shared `a_in(s)`.
2. **A finer granularity than one global flat group:** §0b assumed essentially *one* flat group with
   a single `a_in(s)`. The user's framing allows **multiple flat groups, each with its own shared
   `w(s)`** — a *piecewise-separable* (block-low-rank) approximation of the flat deck, strictly
   richer than a single rank-1 global flat term, at the cost of one extra reduction per group.

> **VERDICT on relation:** same win as §0b, expressed as a schedule; *more expressive* than §0b's
> single-rank-1 flat term because it permits several shared-coupling groups (piecewise rank-1).
> Not a separate idea — the **missing implementation half** of the §0b flat tier. **[SRC-grounded.]**

### 0d.4 ADVERSARIAL GOTCHAS — where it breaks or needs qualification

1. **Data-layout mismatch (string-multi-point vs mode-single-scalar) is real overhead, not free.**
   §0c shows the *threads* exist, but the FDTD string points and the packed oscillators interleave
   awkwardly: the oscillator update currently rides `indexInQuarter==0` (one thread per 128-wide
   quarter). Packing K oscillators/block means K threads doing scalar work scattered among 128-point
   FDTD threads — **warp divergence** (those K threads branch differently) and **poor coalescing**
   when they each touch `mode_running[modeNo]`/`mode_state[modeNo]` at non-contiguous `modeNo`. Fix
   requires re-laying mode state so a warp of packed oscillators reads contiguous memory — a real
   kernel rewrite, not a constant bump. **[SRC for current layout; [UNCERTAIN] for the rewrite.]**

2. **`SEGMENT_FOR_SHUFFLE_SUMMATION = 64` still bounds the reductions — grouping does NOT dodge it.**
   Both the feedin and feedback reductions use `sumArray(..., SEGMENT_FOR_SHUFFLE_SUMMATION, ...)`
   over a segment that **must be ≥ numArrays (block count) and ÷32** (`constants.h:90`,
   `MainKernel.cu:469,641`). Block-grouping *reduces the number of distinct coupling reductions*
   (one per group instead of one per mode) but each surviving reduction is still a SEGMENT-wide
   shuffle tied to the block count. If a future layout raises the block count past 64 to fit more
   string carriers, SEGMENT still silently corrupts. The user's idea **mitigates the O(modes) factor
   but inherits the O(blocks) segment constraint unchanged.** **[SRC]**

3. **"Same coupling" must be EXACT, not approximate, for the factorisation to be lossless.** The
   algebra in §0d.1 requires `deck[s,m] = w(s)` identically for all m∈G. If modes in a group have
   *nearly* equal shapes, factoring them as if identical introduces error proportional to the
   intra-group shape variance. This is acceptable **only because the flat tier already accepted that
   approximation** (§0b.7) — but it means **group membership is an approximation-quality decision**,
   not a free regrouping. Choosing groups = choosing a piecewise-rank-1 approximation of the deck;
   its error must be A/B-rendered (Audio Verification Rule). **[SRC-grounded; [UNCERTAIN] error
   magnitude — measure deck column-variance per candidate group on Belarus.]**

4. **Per-mode frequency/damping stays distinct even within a shared-coupling group — and that's
   fine, but don't conflate the two axes.** Shared *coupling* (`deck`) does NOT imply shared
   *oscillator parameters* (`dec/omega/mass_inv`, `dev_mode_state`). Each m∈G keeps its own
   `mode_state[modeNo]` (`MainKernel.cu:315-317`) and its own `q/q_prev`. The factorisation only
   touches the coupling sums; the K oscillator advances are still K independent updates (cheap, §0c).
   Correct — but a naive "process together" that also tried to share frequency/damping would be
   physically wrong (it would merge distinct resonances). The grouping axis (coupling) and the
   per-mode-physics axis (freq/damping) **must stay orthogonal.** **[SRC]**

5. **Numerical accumulation across a big group.** `Σ_{m∈G} q(m)` over a large group in float32 is a
   wide accumulation (§0b.7 risk #3); the *feedback factoring* concentrates many modes into one sum
   per string, so float32 cancellation/precision is a live risk at |G|~thousands. Consider Kahan or
   double accumulation for the group sum. **[SRC-grounded reasoning.]**

6. **"One block" capacity at 4000 — does it actually matter?** Spare threads exist (§0c), but a
   *single* block holding all 4000 flat oscillators would serialise their updates on ≤512 threads
   and bloat that block's shared memory. The realistic design is **many blocks, each holding one
   shared-coupling group** — which re-introduces the cooperative-grid co-residency question (§6
   risk #3): more groups → more blocks → the cooperative launch must still fit them all resident.
   Grouping helps the *coupling-compute* axis but **does not by itself relax the co-residency
   ceiling.** **[SRC for coop-launch constraint; [UNCERTAIN] at 4000-scale grid sizing.]**

7. **Group assignment becomes a preset-build + frontend concern.** Which modes belong to which
   shared-coupling group is a new preset property (like `n_shaped`, §0b.5). It must be packed
   (StringMap/Mode.py), plumbed (`/health`), and the matrix mode-axis must tolerate grouped modes —
   same cross-layer surface as §8 Tier C, now with an extra grouping dimension. **[SRC-grounded.]**

### 0d.5 WHAT MUST BE TRUE FOR THE IDEA TO WORK (preconditions) + WHAT TO MEASURE NEXT

**Must be true:**
- The flat tier's deck rows are genuinely (near-)separable so a small number of shared-coupling
  groups approximate them within audible tolerance. *(The premise; §0b.7.)*
- The kernel is re-indexed so `modeNo`'s range decouples from `4×numArrays` and the oscillator update
  runs on more than 1 thread/quarter (§0c.2) — a real kernel change.
- Mode state (`dev_mode_running`/`dev_mode_state`) is re-laid for contiguous per-group access to keep
  the packed-oscillator updates coalesced (gotcha #1).
- SEGMENT and the cooperative-grid sizing are revisited if block count rises (gotchas #2, #6).

**Measure next (in priority order):**
1. **Deck column-variance per mode vs mode frequency on Belarus** (live readback of
   `dev_output_data` records 4/5/9, §8.2 Q1 mechanism) → identifies the shaped/flat boundary AND
   the natural shared-coupling groups (clusters of low-variance, mutually-similar rows). This single
   measurement validates both §0b's flat boundary and §0d's grouping simultaneously. **[UNCERTAIN —
   not yet measured.]**
2. **A/B offline render** (`note_playback`, audio_off `/test-ui`) of full-deck vs grouped/flattened
   deck at a candidate group count, per the Audio Verification Rule — the only acceptance test for
   the approximation. **[UNCERTAIN.]**
3. **Cooperative-grid co-residency** at the target group/block count (§8.2 Q2) before committing to
   "many blocks, one group each." **[UNCERTAIN.]**

### 0d.6 BOTTOM-LINE VERDICT

- **Mode↔slot correction:** the user is **right** — modes are scalar and the per-block thread budget
  is ~99% idle of oscillator work, so multiple oscillators CAN share a string slot. The doc's
  `num_modes ≤ num_strings` ceiling is real **for the current index convention only**, not as a
  hardware law. **[SRC, confirmed.]**
- **Block-grouping-by-shared-coupling:** **valid and beneficial, but ONLY for the flat tier**, where
  "shared coupling" holds by construction. It is **not** a general speedup (shaped modes have
  distinct shapes by design — refuted there), and it is **not** a new algorithm — it is the
  *scheduling realisation* of §0b's separable-sum flat tier, with a useful generalisation (multiple
  shared-coupling groups = piecewise rank-1, richer than one global flat term). **[SRC-grounded.]**
- **Net:** the idea **holds where the design already needs it** and fills the gap §0b left open
  ("where do the 4000 flat oscillators live, and how is their coupling amortised"). It does **not**
  dissolve the remaining hard constraints — `SEGMENT_FOR_SHUFFLE_SUMMATION`, cooperative-grid
  co-residency, data-layout/coalescing rewrite, and the exactness/error of the shared-coupling
  approximation are all live and must be measured/handled. **It is a correct refinement, not a
  silver bullet.**

---

## 1. Architecture of the String–Mode Coupling System

### 1.1 What it is, physically

Pianoid couples two simulations every audio sample, **bidirectionally**, inside a single
cooperative kernel: **[DOC]** (`SYNTHESIS_ENGINE.md` "String–Mode Coupling")

- **Strings** — each piano string is an FDTD-discretised 1-D stiff wave equation
  (tension, bending, viscous + HF damping, hammer force). Solved at sub-sample cadence
  (`string_iteration` sub-steps per audio sample).
- **Modes** — each soundboard resonance is a damped harmonic oscillator
  `q̈ + 2γq̇ + ω²q = F/m`, advanced once per audio sample. **[DOC]** (`SYNTHESIS_ENGINE.md`
  "Mode Simulation"; `Mode.py` `Piano_mode.iteration`)

The two are coupled through **two intermediate global accumulator matrices**:

- **Feedin (string → mode):** each string's summed bridge force is distributed into modes,
  weighted by the per-(string,mode) **deck coupling coefficient** (`mode_feedin`). After a
  grid sync, `sumArray()` reduces this to one `F_applied` per mode. **[DOC][SRC]** (`MainKernel.cu:619-641`)
- **Feedback (mode → string):** each mode's displacement is distributed back to every string's
  bridge, weighted by the same coupling coefficient (`mode_feedback`, reciprocity). After a grid
  sync, reduced to one feedback scalar per string, which **overwrites the string's stem
  (bridge) boundary points**. **[DOC][SRC]** (`MainKernel.cu:433-472`)

Audio is read out from **output pitches (≥128)** — virtual "sound strings" whose stem
displacement *is* the summed mode feedback. The audible sample is the derivative
`feedback − s_b` (velocity) or its second difference (acceleration). **[DOC][SRC]**
(`SYNTHESIS_ENGINE.md` "Audio Output"; `MainKernel.cu:493-528`)

### 1.2 The coupling math (per audio sample)

```
F_applied(mode m)   = Σ_strings  deck[string, m] · force_on_bridge_summed[string] / soundStep
q_new(m)            = ((2q − q_prev) + q_prev·dec − q·omega + F_applied·mass_inv) · (1 − dec)
feedback(string s)  = Σ_modes  deck[s, m] · q(m)          (× runtime fb coeff, piano rows only)
stem(s)             = feedback(s)                          (overwrites the bridge boundary)
```

**[DOC][SRC]** (`MainKernel.cu:441-442`, `:622-623`, `:668-672`; mode update matches
`Mode.py` and `SYNTHESIS_ENGINE.md` "Discrete update").

The runtime feedback coefficient (`deck_feedback_coeff`) scales **only piano-resonance rows**;
output/sound-channel rows are masked at ×1 via `feedback_output_mask` so feedback=0 does not
silence note audio. **[DOC][SRC]** (`MainKernel.cu:262-265`; `StringMap.pack_output_mask`;
DATA_FLOWS §2.6)

### 1.3 Where it lives in the kernel & the data flow

Per cycle (`SYNTHESIS_ENGINE.md` "Synthesis Cycle", `MainKernel.cu:427-702`): for each of
`samplesInCycle` audio samples — (a) write mode→string feedback into `feedback_cycle_matrix`,
(b) grid sync, (c) reduce to `s_feedback` per string, (d) emit audio sample, (e) inner FDTD
loop (`soundStep` sub-steps) accumulating bridge force, (f) grid sync, (g) write string→mode
force into `feedin_cycle_matrix`, (h) grid sync, (i) reduce to `F_applied` per mode, (j) update
each harmonic oscillator, (k) zero `feedin_cycle_matrix`. **[SRC]**

---

## 2. Data Structures Dimensioned by Mode Count

### 2.1 The deck / coupling matrix — the central mode-scaled structure

| Name (layer) | Shape / size | Scales as | Source |
|---|---|---|---|
| `Pitch.deck['feedin']` / `['feedback']` (Python) | length `num_modes` per pitch | O(modes) per pitch | `Pitch.py`; OVERVIEW "Pitch" |
| Packed feedin row (`pack_pitch_feedin`) | **extended to `num_strings`** per pitch | O(num_strings) per pitch | `StringMap.py:438,440` **[SRC]** |
| `dev_deck_parameters` (GPU, single-matrix mode) | `NUM_STRINGS × NUM_MODES` reals = 65,536 | **O(num_strings × num_modes)** | `PresetParameters.h:40`; MEMORY_MANAGEMENT |
| `dev_deck_parameters` (GPU, legacy 2-matrix) | `NUM_STRINGS × NUM_MODES × 2` = 131,072 | O(num_strings × num_modes × 2) | `PresetParameters.h:42` **[SRC]** |

> **HIGH-STAKES — deck row width is `num_strings`, not `num_modes`. [SRC]**
> The packed feedin row is `ext_to_the_right(deck['feedin'], self.mp.num_strings)`
> (`StringMap.py:440`), and the kernel indexes it as `mode_coefficients[string * numModes +
> mode]` where `numModes = cycle_parameters[2] = num_modes_for_model = num_strings`. So the deck
> matrix's *column* dimension equals the *padded* mode count = `num_strings`. The compile-time
> array `dev_deck_parameters[NUM_STRINGS * NUM_MODES]` only holds because `num_modes_for_model ≤
> NUM_MODES = NUM_STRINGS = 256`. **This is the structure that blows up O(num_strings²).**

**Same-name disambiguation (do not conflate):** **[DOC]** (OVERVIEW "Sound channel vs deck";
DATA_FLOWS §2.4)
- `deck['feedin']`/`['feedback']` — per-(pitch,mode) spatial coupling (the matrix above).
- `mode_sound_channels` (`coefficients`) — per-pitch **length-`num_channels`** array injected into
  feedin slots reserved for mode channels; used only when `listen_to_modes=1`.
- `string_sound_channels` (`string_coefficients`) — per-output-pitch **length-`num_channels`**
  gain on the strings-path feedback; only output-pitch rows 128..127+num_output_channels are
  kernel-effective. These are channel-dimensioned, **not** mode-dimensioned — they do **not**
  scale with mode count.

### 2.2 Mode state buffers (config + running)

| Buffer | Layout | Stored extent | Scales as | Source |
|---|---|---|---|---|
| `dev_mode_state` (TUNABLE, preset) | `[dec×N][omega×N][mass_inv×N]` | `NUM_MODES × 3` = 768 reals | O(modes) | `PresetParameters.h:34`; SYNTHESIS_ENGINE |
| `dev_mode_running` (WORKING) | `[q×N][q_prev×N]` | **`NUM_MODES × 2`** (fixed) | O(modes) but **hard-coded** | `Pianoid.cu:352-353` **[SRC]** |

> **HIGH-STAKES — `dev_mode_running` is allocated at the compile-time `NUM_MODES`, not the
> runtime count. [SRC]** (`Pianoid.cu:353`: `NUM_MODES * 2`). The kernel indexes it as
> `mode_running[modeNo]` and `mode_running[numModes + modeNo]` (`MainKernel.cu:311-312, 741-742`).
> Because `numModes` (runtime) ≤ `NUM_MODES` (alloc), this is safe today; a radical increase that
> raises runtime modes past 256 without raising `NUM_MODES` would index **out of bounds** here.

### 2.3 The cycle accumulator matrices (WORKING)

| Buffer | Indexed as | Size driver | Source |
|---|---|---|---|
| `feedin_cycle_matrix` | `[string * SEGMENT + blockNo]` | num_strings × `SEGMENT_FOR_SHUFFLE_SUMMATION` (64) | `MainKernel.cu:622`; MEMORY_MANAGEMENT |
| `feedback_cycle_matrix` | `[string * SEGMENT + blockNo]` | num_strings × 64 | `MainKernel.cu:441` |

These are **O(num_strings × SEGMENT)**, and the `SEGMENT` dimension is the reduction width that
**must be ≥ numArrays (number of blocks)**. **[SRC]** (`constants.h:90` comment: "Has to be larger
than the number of the blocks and divisible by 32").

### 2.4 The pack_* functions that build these

- `StringMap.pack_deck(single_matrix_mode)` — builds the feedin (and legacy feedback) matrix
  by stacking `pack_pitch_feedin(pitch)` rows, each extended to `num_strings`. **[SRC]**
  (`StringMap.py:453-476`)
- `StringMap.pack_pitch_feedin(pitch)` — for output pitches, uses `deck['feedback'] × sc_gain`
  (the string sound-channel gain); for piano pitches uses `deck['feedin']`; injects the mode
  sound-channel coefficient at `mode_channel_index` only when `listen_to_modes`. **[SRC]**
  (`StringMap.py:427-451`)
- `ModeMap.pack_mode_config` / `pack_modes` — packs `[dec×N][omega×N][mass_inv×N]`, appending
  `modes_to_append() = num_modes_for_model − num_modes` **dummy modes (ID=−1)**. **[SRC][DOC]**
  (`Mode.py:401-429`; OVERVIEW "ModeMap")
- Deck arrays are padded to `num_modes_for_model` (= num_strings) on load via `np.pad(...,
  mode='edge')`. **[SRC]** (`pianoid.py:222-223`, `:2590-2592`)

---

## 3. The Mode Dimension, Precisely

### 3.1 The constants and where they live

| Symbol | Value | Layer | File:line | Tag |
|---|---|---|---|---|
| `NUM_MODES` | 256 | kernel array dim | `constants.h:12` | [SRC] |
| `NUM_STRINGS` | 256 | kernel array dim | `constants.h:28` | [SRC] |
| `MAX_ARRAY_SIZE` | 512 | spatial points/string | `constants.h:25` | [SRC] |
| `NUM_STRINGS_IN_ARRAY` | 4 | strings per block | `constants.h:26` | [SRC] |
| `MAX_QUARTER_SIZE` | 512/4 = 128 | quarter slots / block | `constants.h:27` | [SRC] |
| `NUM_FOLDS_IN_QUARTER` | 3 | mode folds per thread | `constants.h:30` | [SRC] |
| `MAX_NUM_MODES_BY_QUARTER` | 128×2 = 256 | mode reach via folds | `constants.h:32` | [SRC] |
| `SEGMENT_FOR_SHUFFLE_SUMMATION` | 64 | reduction width (≥ #blocks) | `constants.h:90` | [SRC] |
| `DEF_NUM_MODES` | 32 | Python default | `ModelParams.py:11` | [SRC] |
| `MAX_NUM_MODES` | 256 | Python max | `ModelParams.py:12` | [SRC] |

### 3.2 Stored vs EFFECTIVE count (the load-bearing distinction)

- **`num_modes`** (Python `ModelParameters`) = number of *real* modes from the preset
  (`len(ModeMap.modes)`). **[SRC]** (`Mode.py:361-366`)
- **`num_modes_for_model`** = `num_modes` rounded **up to a multiple of `num_blocks()` and, in
  practice, set explicitly to `num_strings`**. **[SRC]** (`ModelParams.set_num_modes:93-102`;
  `pianoid.py:201,2577,3331` pass `num_modes_for_model=self.mp.num_strings`)
- **`init_params_.num_modes`** (C++) = the Python `num_modes_for_model` → written to
  **`cycle_parameters[2]`** → read as `numModes` in every kernel. **[SRC]** (`Pianoid.cu:142`;
  `MainKernel.cu:125`)
- **Dummy modes (ID = −1)** fill the gap `num_modes_for_model − num_modes`. **[DOC][SRC]**
  (OVERVIEW "ModeMap"; `Mode.py:427-429`)

> **Therefore the EFFECTIVE kernel mode count K = num_modes_for_model = num_strings**, and the
> *real* usable modes = preset `num_modes` ≤ K. Measured: Baseline `num_modes=100`,
> Belarus `num_modes=196`, both with `num_strings=224` → **K=224 slots, 196/100 real, rest dummy.
> [MEAS]**

### 3.3 Indexing & the mode-placement formula (the real ceiling)

Modes are placed onto **string-block quarter slots**, not their own blocks:

```
quarterSize    = arraySize / numStringsInArray          // 512/4 = 128
quarterNumber  = stMdIndex / quarterSize                // 0..numStringsInArray-1  (0..3)
numArrays      = numStrings / numStringsInArray          // 224/4 = 56  (the #blocks / grid.x)
modeNo         = numArrays * quarterNumber + blockNo     // Kernels.cu:253  → max = numStrings-1
parameters[... 25*arraySize + idx] = modeNo             // per-thread mode tag, baked at packing
```

**[SRC]** (`Kernels.cu:195-298`). **Max distinct addressable modes = numArrays ×
num_strings_in_array = num_strings.** The kernel's per-thread `modeNo` is read back in `MainKernel`
(`:178`) and every mode op is guarded by `if (modeNo < numModes)`. The fold loop
(`NUM_FOLDS_IN_QUARTER=3`, `MainKernel.cu:237-272, 619-625`) lets each thread service up to 3
(string,mode) pairs for the *coupling-coefficient* load/accumulate, but the **oscillator update
itself is one mode per quarter slot** (`MainKernel.cu:666-676`, gated on `indexInQuarter==0`).

> **HIGH-STAKES — the binding ceiling is `num_modes ≤ num_strings`, enforced structurally by
> `modeNo = numArrays*quarterNumber + blockNo` + the `indexInQuarter==0` gate, NOT by
> `NUM_MODES=256`. [SRC]** Confirmed by middleware: `PanoidResult.py:11-13` ("works as long as
> num_modes <= num_strings"); `create_belarus_preset.py:55` ("num_modes + num_sound_channels must
> be <= num_strings = 224").
> **CORRECTION (§0c, 2026-06-06):** "To add modes you must add strings" is the *current-convention*
> consequence, **not a hardware law.** The oscillator update uses 1 thread/quarter (4/block); the
> other ~508 threads/block are idle of mode work, so the real fix for a radical increase is to
> **re-index modes onto the spare per-block threads** (pack many oscillators per existing block),
> which avoids inflating `num_strings` and the O(S²) deck. See §0c.2 and §0d.

---

## 4. Memory Footprint as a Function of Mode Count

Let `S = num_strings`, `M = num_modes` (real), `A = array_size`, `B = S/num_strings_in_array`
(blocks). Note the engine forces `padded_modes = S`, so "more modes" ⇒ "raise S."

| Buffer | Formula | Order | Current (S=224..256, A=512) |
|---|---|---|---|
| `dev_deck_parameters` (single) | S × S reals | **O(S²)** | 256×256 = 65,536 reals (256 KB f32) |
| `dev_deck_parameters` (legacy) | 2 × S × S | O(S²) | 131,072 reals (512 KB) |
| `dev_string_state` (×2 copies) | S × A | O(S·A) | 256×512 ≈ 131K reals |
| `dev_force_function` | S × (mode_iter·sound_step·EXCITATION_FACTOR) | O(S·A·k) | ~256×4096 ≈ 1M reals (4 MB) |
| `feedin/feedback_cycle_matrix` | S × SEGMENT(64) | O(S) | 256×64 = 16K reals each |
| `dev_mode_state` | NUM_MODES × 3 | O(M), fixed@256 | 768 reals |
| `dev_mode_running` | NUM_MODES × 2 | O(M), **fixed@256** | 512 reals |
| `dev_output_data` (DEBUG only) | S × A × 10 | O(S·A) | ~1.3M reals (huge — ~113 MB block) |
| Excitation `dev_gauss_params_full` | S × 128 × 20 | O(S), mode-independent | 655,360 reals (2.5 MB) |

**[DOC][SRC]** (MEMORY_MANAGEMENT "Tunable Buffer Layout"; `PresetParameters.h`; `constants.h`).

Total GPU: ~67 MB production / ~180 MB debug at current sizes. **[DOC]**

**Scaling read:**
- The **deck matrix is the only O(S²) structure** — at 2× strings it's ×4 (1 MB), at 10× (S=2560)
  it's ×100 (~25 MB f32), at 100× (S=25,600) it's ×10,000 (~2.5 GB f32) — **deck alone exceeds
  consumer GPU memory by the 100× point.**
- Per-string buffers (`string_state`, `force_function`, `output_data`) are O(S·A) — linear in S
  but with a large A=512 constant; `force_function` (~4 MB at S=256) → ~40 MB at 10×, ~400 MB at
  100×; the DEBUG `output_data` (~113 MB) → unusable beyond a few× (debug builds only).
- Mode state/running buffers are negligible (O(M)) — but **hard-pinned at `NUM_MODES`** and would
  need re-sizing.

**Shared memory / registers per block (kernel):** ~3 KB shared, ~20-30 registers/thread, block =
512 threads. **[SRC]** (`COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md:1291-1296`). Shared-mem use is
driven by `MAX_ARRAY_SIZE` and `MAX_NUM_STRINGS_IN_ARRAY`, **not by mode count** (modes live one
per quarter slot in registers + `s_mode[MAX_NUM_STRINGS_IN_ARRAY]`). So **raising modes via more
blocks does not raise per-block shared memory** — it raises the *block count*. [SRC]
(`MainKernel.cu:215, 281, 288, 325, 397`)

---

## 5. Kernel Compute

- **Launch:** `cudaLaunchCooperativeKernel(addKernel, grid=num_string_arrays, block=(A/32, 32))`.
  **[SRC]** (`Pianoid_synthesis.cu:229-230, 345`). Grid.x = B blocks; block = 512 threads (A=512).
- **No mode-dedicated launch dimension.** Modes are interleaved into the same blocks. Adding modes
  = adding strings = adding **blocks** to a cooperative grid. **[SRC]**
- **Per-mode cost:** the harmonic-oscillator update is O(1) per mode per sample
  (`MainKernel.cu:668-672`). The dominant per-cycle cost is **the coupling reductions**: two
  `sumArray` reductions per audio sample over `SEGMENT_FOR_SHUFFLE_SUMMATION` columns, plus the
  `atomicAdd` scatter into the cycle matrices across `NUM_FOLDS_IN_QUARTER` folds. **[DOC][SRC]**
  (SYNTHESIS_ENGINE "sumArray Reduction"; `MainKernel.cu:438-444, 619-641`)
- **Quadratic-in-modes hot spot:** the feedback computation is effectively **all modes × all
  strings** per sample (each string sums over all modes; each mode scatters to all strings),
  realised as the `atomicAdd` into `feedin/feedback_cycle_matrix` over folds + the `sumArray`
  reductions. As S grows (to carry more modes), this string×mode coupling work grows **O(S²)** per
  sample — the compute analogue of the O(S²) deck memory. **[SRC]** (the fold scatter
  `MainKernel.cu:619-625` + reduction `:641` run per `main_cycle_index`).
- **`SEGMENT_FOR_SHUFFLE_SUMMATION` ties reduction width to block count.** It must be ≥ numArrays
  (B) and divisible by 32. At S=256/nsa=4 → B=64 = SEGMENT. **[SRC]** (`constants.h:90`).
- **mode_dec / damping:** per-mode `dec/omega/mass_inv` from `dev_mode_state`
  (`MainKernel.cu:315-317`); kernel applies `(1 − mode_dec)` envelope. Mode-count independent
  per-mode. **[DOC]** (SYNTHESIS_ENGINE "Discrete update")

---

## 6. Scaling Implications at Multiple Multipliers

Assume the only way to add M modes is to raise S (num_strings) to ≥ M (structural invariant §3.3).
Baseline: S≈224-256, B≈56-64, A=512, deck≈256 KB, total GPU≈67 MB.

| Factor | Target real modes | Required S (≥ modes+channels) | Required B (nsa=4) | Deck (f32, O(S²)) | Cooperative grid | Verdict |
|---|---|---|---|---|---|---|
| **2×** | ~400 | ~410-450 | ~103-113 | ~0.7-0.8 MB | B>64 → **SEGMENT overflow** | Needs SEGMENT + NUM_MODES/NUM_STRINGS bump; coop grid likely still fits |
| **10×** | ~2,000 | ~2,050 | ~513 | ~17 MB | hundreds of blocks | Coop launch co-residency at risk; SEGMENT must grow large (≥512, ÷32); per-cycle O(S²) coupling cost ~100× |
| **100×** | ~20,000 | ~20,050 | ~5,013 | **~1.6 GB** | thousands of blocks | Coop grid cannot be co-resident on consumer GPUs; deck + force_function exceed VRAM; O(S²) coupling ~10,000× — **not feasible without re-architecting coupling** |

**Where it breaks first, in order:**
1. **`SEGMENT_FOR_SHUFFLE_SUMMATION=64` overflow** the moment B>64 (i.e. S>256 at nsa=4) — *silent
   wrong audio*, the earliest and most dangerous failure. **[SRC]**
2. **Compile-time `NUM_MODES`/`NUM_STRINGS=256`** array bounds + `dev_mode_running` fixed alloc —
   out-of-bounds the moment runtime modes/strings exceed 256. **[SRC]**
3. **Cooperative-grid co-residency** — a cooperative launch requires all blocks resident
   simultaneously; at ~hundreds-to-thousands of blocks the launch fails
   (`cudaErrorCooperativeLaunchTooLarge`). The codebase already has cooperative-launch grid-fitting
   logic for the FIR path (`Pianoid_synthesis.cu:467-521`) but **`addKernel` is launched directly
   with `num_string_arrays` and no occupancy clamp** (`:345`). **[SRC]**
4. **Deck O(S²) memory** — dominates VRAM beyond ~10×.
5. **Per-cycle O(S²) coupling compute** — dominates runtime beyond ~10×.

> **Architectural implication:** a *radical* (≥10×) mode increase is not a constant-bump exercise.
> The string-piggyback coupling (modes share string blocks; deck width = num_strings; reductions
> sized by block count) means the cost is quadratic in the carrier (strings). A true radical
> increase likely needs a **decoupled mode axis** (modes in their own grid dimension / kernel,
> with a rectangular num_strings × num_modes deck that does *not* force num_modes = num_strings),
> and a reduction scheme that does not bake the segment width to the block count.

---

## 7. Hardcoded Assumptions / Constraints — Every Place the Mode Count Is Baked In

### 7.1 Kernel (`PianoidCore/pianoid_cuda/`)

| Location | Assumption | Tag |
|---|---|---|
| `constants.h:12` `NUM_MODES=256` | mode array dimension | [SRC] |
| `constants.h:28` `NUM_STRINGS=256` | string array dim (= mode ceiling) | [SRC] |
| `constants.h:30,32` folds / `MAX_NUM_MODES_BY_QUARTER=256` | mode reach via quarter folds | [SRC] |
| `constants.h:90` `SEGMENT_FOR_SHUFFLE_SUMMATION=64` | reduction width ≥ #blocks, ÷32 | [SRC] |
| `PresetParameters.h:34,40,60,64` | `mode_config = NUM_MODES*3`, `deck = NUM_STRINGS*NUM_MODES` | [SRC] |
| `Kernels.cu:253` `modeNo = numArrays*quarterNumber+blockNo` | mode-per-string-slot placement | [SRC] |
| `MainKernel.cu:125` `numModes=cycle_parameters[2]` | runtime mode count | [SRC] |
| `MainKernel.cu:237-272,619-625` fold loops | `NUM_FOLDS_IN_QUARTER` coupling fold | [SRC] |
| `MainKernel.cu:311-317,741-742` | `mode_running`/`mode_state` indexing by `numModes` | [SRC] |
| `Pianoid.cu:353` `dev_mode_running = NUM_MODES*2` | **fixed** mode-running alloc | [SRC] |
| `Pianoid_synthesis.cu:345` coop launch grid=`num_string_arrays` | no occupancy clamp on addKernel | [SRC] |

### 7.2 Middleware / domain (`PianoidBasic/`, `pianoid_middleware/`)

| Location | Assumption | Tag |
|---|---|---|
| `ModelParams.py:11-12` `DEF_NUM_MODES=32`, `MAX_NUM_MODES=256` | Python defaults/max | [SRC] |
| `ModelParams.set_num_modes:93-102` | pads `num_modes_for_model` to multiple of num_blocks | [SRC] |
| `pianoid.py:201,2577,3331` | forces `num_modes_for_model = num_strings` | [SRC] |
| `pianoid.py:222-223,2590-2592` | pads deck arrays to `num_working_modes()` | [SRC] |
| `Mode.py:401-429` | appends dummy modes (ID=−1) to `num_modes_for_model` | [SRC] |
| `StringMap.py:438,440,472` | deck rows extended to `num_strings`/`num_modes_for_model` | [SRC] |
| `create_belarus_preset.py:55` | `num_modes + num_channels <= num_strings` invariant | [SRC] |
| `PanoidResult.py:11-13,139-165` | mode records sized by num_strings; `num_modes <= num_strings` | [SRC] |
| `backendServer.py:934,1683` | `/health` & range use `pianoid.mp.num_modes` | [SRC] |
| REST `/get_parameter/mode/<key>`, `parse_range` (DATA_FLOWS §2.3) | mode-axis keyed off `mp.num_modes` | [DOC] |

### 7.3 Frontend (`PianoidTunner/src/`)

| Location | Assumption | Tag |
|---|---|---|
| `usePreset.js:45,1744` `totalModes` state | mode-axis extent (from backend) | [SRC] |
| `MeasuredMatrix.jsx:22,174-178,399` | `totalModes` drives matrix mode-axis range/zoom | [SRC] |
| `SoundChannelsPane.jsx` (mode-column axis) | consumes `rangeOfModes`/`selectedModes` | [DOC] (WORK_IN_PROGRESS:250-253) |
| `RowEditor.js`, `MeasuredMatrix` barchart | per-mode bars sized to mode count | [SRC] |
| WORK_IN_PROGRESS:224-240 | matrix-scale Zoomer assumes current mode extent; not yet wired | [DOC] |

> **The just-built system-wide-selection mode range + matrices-zoom** (WORK_IN_PROGRESS
> "matrix-scale Zoomer", lines 224-253) reads the mode extent from `totalModes` (ultimately
> `mp.num_modes`). A radical mode increase changes that range wholesale; the zoom/selection math
> (`setRangeOfModes`, `selectedModes`) must tolerate a much larger axis (rendering perf of
> per-mode bars/cells becomes a concern at thousands of modes — ECharts/canvas matrix). **[DOC]**

---

## 8. Risks, Open Questions, and the Structured Change Map

### 8.1 Risks

- **Silent reduction corruption** (highest): `SEGMENT_FOR_SHUFFLE_SUMMATION=64` overflow when
  blocks > 64 produces *wrong sound, not a crash*. Any S>256 (nsa=4) trips it. **[SRC]**
- **Silent OOB** on `dev_mode_running` (fixed `NUM_MODES`) and the `[NUM_STRINGS*NUM_MODES]` deck
  array if runtime modes/strings exceed 256 without raising the compile-time constants. **[SRC]**
- **Cooperative-launch failure** under more blocks / GPU contention — already flagged as flaky
  ("the cooperative-grid addKernel cannot launch reliably under heavy GPU contention",
  DATA_FLOWS/SYNTHESIS_ENGINE CFL note). **[DOC]**
- **O(S²) deck memory + O(S²) coupling compute** make ≥10× a re-architecture, not a tune.
- **Preset compatibility:** every existing preset stores `num_strings`/`num_modes`; `num_blocks`
  divisibility (`set_num_modes` raises if `num_modes_for_model % num_blocks != 0`) constrains
  allowed counts. **[SRC]** (`ModelParams.py:96-98`)
- **Float32 numerics:** more modes summed into one feedback scalar may need wider accumulation;
  CFL stability is per-string (modes are a separate scheme, not CFL-gated). **[DOC]**

### 8.2 Open questions (flagged [UNCERTAIN] — measure before relying on)

1. **Is `num_modes ≤ num_strings` truly the *only* ceiling, or does the `NUM_FOLDS_IN_QUARTER=3` /
   `MAX_QUARTER_SIZE` fold scheme impose a tighter/looser bound at specific (array_size,
   num_strings_in_array) combos?** The fold math (`foldedIndexInQuarter = indexInQuarter +
   quarterSize*i`, `MainKernel.cu:240`) interacts with `array_size` and `num_strings_in_array` in
   ways that should be **probed on a live preset** by reading back `dev_output_data` records 4/5/9
   (mode_feedin/feedback/raw coefficients) across all modes to confirm none are silently dropped at
   the new count. **[UNCERTAIN]**
2. **Does `addKernel` actually co-reside at the current grid, and what is the device's
   max cooperative grid?** Needs `cudaOccupancyMaxActiveBlocksPerMultiprocessor` × SM count
   measured on the target GPU. **[UNCERTAIN]**
3. **Exact relationship between Python `num_strings_in_array` (preset value, =4 measured) and
   kernel `NUM_STRINGS_IN_ARRAY=4` / `MAX_NUM_STRINGS_IN_ARRAY=4`** — the Python *default* is 2
   (`ModelParams.py:9`) but measured presets use 4. Confirm the kernel hard-caps shared arrays at
   `MAX_NUM_STRINGS_IN_ARRAY=4`, so nsa cannot exceed 4 without raising that constant too
   (affects B = S/nsa and thus block count vs SEGMENT). **[SRC for the cap; UNCERTAIN whether nsa
   is ever >4 in any preset]**
4. **Whether any preset/path uses the legacy 2-matrix deck** (`USE_SINGLE_DECK_MATRIX=0`) — default
   is 1 (`constants.h:116`), but a radical change must not silently break the legacy branch.
   **[SRC default; UNCERTAIN if legacy ever compiled in CI]**
5. **`mode_channel_index` interaction** — mode sound channels live in feedin slots at
   `mode_channel_index = num_working_modes()` (`Mode.py:399`); raising modes shifts this and may
   collide with the channel slots. Confirm the `num_modes + num_channels ≤ num_strings` budget
   holds at the new count. **[SRC for the mechanism; UNCERTAIN at scale]**

### 8.3 Change map (what must change, in what layer, in what order)

**Tier A — make the current ceiling raisable to ≤ S (no re-architecture), to support modest (≤2×
within S≤256, or larger with S>256) increases:**
1. `constants.h` — raise `NUM_MODES` and `NUM_STRINGS` together (they are co-equal as the mode
   ceiling); raise `SEGMENT_FOR_SHUFFLE_SUMMATION` to ≥ new B and ÷32; re-derive
   `MAX_QUARTER_SIZE`/`MAX_NUM_MODES_BY_QUARTER`/fold counts.
2. `Pianoid.cu:353` — size `dev_mode_running` from the runtime count (or the new `NUM_MODES`).
3. `PresetParameters.h` — confirm `deck`/`mode_config` array dims follow the new constants
   (they already key off `NUM_STRINGS`/`NUM_MODES`).
4. `Pianoid_synthesis.cu:345` — add an occupancy/co-residency clamp or fallback for `addKernel`
   like the FIR path already has (`:467-521`).
5. `ModelParams.py` — raise `MAX_NUM_MODES`; verify `set_num_modes` divisibility against new
   `num_blocks`.
6. Verify (live readback) that mode records 4/5/9 cover all modes at the new count (open Q1).

**Tier B — decouple modes from strings (required for radical ≥10× without O(S²) blow-up):**
7. Introduce an independent `num_modes` axis so the deck is **rectangular num_strings ×
   num_modes** and the kernel does not force `num_modes_for_model = num_strings` — rework the
   `modeNo = numArrays*quarterNumber+blockNo` placement and the quarter/fold mapping, or move modes
   to a **separate kernel / grid dimension**.
   > **CHEAPER ROUTE surfaced by §0c/§0d (2026-06-06).** Decoupling does **not** require a whole new
   > grid dimension. Because ~508 of 512 threads/block do no oscillator work, the bulk (flat) modes
   > can be **re-indexed onto the spare per-block threads**: replace the `modeNo` range
   > `4×numArrays` with `K_block×numArrays`, drop the `indexInQuarter==0` single-thread gate so >1
   > oscillator updates per quarter, and grow `s_mode[4]`→`s_mode[K_block×4]` (still ≤~1 KB shared).
   > Group flat modes by **shared coupling vector `w(s)`** (one group per block) so each group pays
   > the string↔mode reduction **once** (§0d.1). This realises the §0b flat tier *on the existing
   > block structure* — keep the §8-Tier-B "separate kernel" only if the flat oscillator count
   > exceeds what packing onto spare threads can serve. Caveats: warp divergence / mode-state
   > coalescing rewrite (§0d.4 #1), `SEGMENT_FOR_SHUFFLE_SUMMATION` still bounds reductions
   > (#2), cooperative-grid co-residency still bounds block count (#6).
8. Replace the block-count-tied reduction (`SEGMENT_FOR_SHUFFLE_SUMMATION`) with a scheme
   independent of block count.
9. Reconsider the cooperative-grid requirement (the grid sync between string and mode phases) — a
   two-kernel split with explicit sync may scale better than one giant cooperative grid.

**Tier C — middleware + frontend (follow either tier):**
10. `pianoid.py` — stop forcing `num_modes_for_model = num_strings` (if Tier B done); plumb the
    real `num_modes` through `/health` (`backendServer.py:1683`).
11. `StringMap.pack_deck`/`pack_pitch_feedin` — extend rows to the new mode width (not
    num_strings) if decoupled.
12. `Mode.py` — dummy-mode padding logic follows the new padding target.
13. Frontend `usePreset.js` `totalModes` + `MeasuredMatrix.jsx`/`SoundChannelsPane.jsx` mode-axis +
    the matrix-scale Zoomer — ensure the mode axis, range/selection, and per-mode rendering scale
    to the larger count (rendering perf review at thousands of modes).

---

## 9. Appendix — Measured / Confirmed Numbers This Session

- **Presets** (`PianoidCore/pianoid_middleware/presets/`): `BaselinePreset1.json` →
  num_modes=100, num_strings=224, num_strings_in_array=4, array_size=512, num_channels=4,
  88 pitches. `Belarus_8band_196modes.json` → num_modes=196, otherwise identical structure. **[MEAS]**
- **Derived:** num_blocks B = 224/4 = 56; quarterSize = 512/4 = 128; max addressable modeNo =
  56×4−1 = 223 → ceiling = num_strings = 224. Effective kernel numModes (cycle_parameters[2]) =
  num_modes_for_model = 224 (196 real + 28 dummy for Belarus). **[SRC-derived from MEAS]**
- **Compile-time:** NUM_MODES=NUM_STRINGS=256, MAX_ARRAY_SIZE=512, NUM_STRINGS_IN_ARRAY=4,
  SEGMENT_FOR_SHUFFLE_SUMMATION=64, NUM_FOLDS_IN_QUARTER=3. **[SRC]**

### Key source references (absolute paths)

- `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\constants.h`
- `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\PresetParameters.h`
- `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\Kernels.cu` (mode placement: 185-300)
- `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\MainKernel.cu` (coupling: 100-760)
- `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\Pianoid.cu` (init/alloc: 142, 350-353)
- `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\Pianoid_synthesis.cu` (launch: 222-349)
- `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\Pianoid.cuh` (InitializationParameters: 35-72)
- `D:\repos\PianoidInstall\PianoidBasic\Pianoid\ModelParams.py`
- `D:\repos\PianoidInstall\PianoidBasic\Pianoid\Mode.py`
- `D:\repos\PianoidInstall\PianoidBasic\Pianoid\StringMap.py` (pack_deck: 427-476)
- `D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\pianoid.py` (num_modes_for_model: 201, 2577, 3331)
- `D:\repos\PianoidInstall\PianoidTunner\src\hooks\usePreset.js`, `...\components\MeasuredMatrix.jsx`

### Doc references (MkDocs `http://localhost:8001/`)

- `architecture/SYSTEM_OVERVIEW/` — 4-layer stack, ModelParameters.num_modes
- `architecture/DATA_FLOWS/#23-mode-parameters-granular-path`, `#24-deck-feedinfeedback-matrices`
- `modules/pianoid-cuda/SYNTHESIS_ENGINE/#string–mode-coupling`,
  `#mode-simulation-harmonic-oscillator`, `#kernel-grid-layout`
- `modules/pianoid-cuda/MEMORY_MANAGEMENT/#tunable-buffer-layout-preset-parameters`
- `modules/pianoid-cuda/OVERVIEW/#configuration-constants-constantsh`
- `modules/pianoid-basic/OVERVIEW/#modelparameters`, `#piano_mode-and-modemap`,
  `#stored-vs-effective-entries-high-stakes-data-model-fact`
