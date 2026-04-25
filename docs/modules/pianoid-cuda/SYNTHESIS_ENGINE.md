# Synthesis Engine

## Overview

The synthesis engine produces audio by solving the piano string wave equation and the
soundboard mode equations simultaneously on the GPU every synthesis cycle. The two
simulations are bidirectionally coupled: string vibration drives soundboard modes, and
mode displacement feeds back into each string at its bridge termination point.

An optional FIR convolution kernel post-processes the output for room acoustics or
equalization.

![Synthesis Signal Flow](../../images/synthesis-signal-flow.svg)

---

## Kernel Grid Layout

`addKernel` is launched as a **cooperative grid** (requires `cudaLaunchCooperativeKernel`)
so that `grid_group::sync()` can synchronise all thread blocks between the string and mode
computation phases.

```
Grid layout (cooperative, one launch per synthesis cycle)
=========================================================

  gridDim.x  = numArrays  (= numStrings / numStringsInArray = 256/4 = 64 blocks)
  blockDim.x = 4   (NUM_STRINGS_IN_ARRAY — one dimension for warp-bank layout)
  blockDim.y = 128 (MAX_ARRAY_SIZE / WARP_SIZE — warp-row tiles)

  Thread addressing:
    pointIndex  = threadIdx.y + threadIdx.x * WARP_SIZE   (string spatial point)
    stMdIndex   = threadIdx.y * blockDim.x + threadIdx.x  (mode / quarter index)

  Each block covers:
    - 4 strings packed side by side in shared memory
    - Up to 512 spatial points per string array (MAX_ARRAY_SIZE)
    - 256 modes distributed across blocks via NUM_FOLDS_IN_QUARTER=3 folding

  Shared memory per block (approximate):
    s_a[MAX_ARRAY_SIZE]                  — current string state
    s_mode[MAX_NUM_STRINGS_IN_ARRAY]     — current mode state for block's modes
    s_feedback[MAX_NUM_STRINGS_IN_ARRAY] — accumulated mode→string feedback
    s_force_function[MAX_ITERATIONS_IN_CYCLE × MAX_NUM_STRINGS_IN_ARRAY]
    force_on_bridge_summed[MAX_NUM_STRINGS_IN_ARRAY]
    s_mode_applied_force[NUM_STRINGS_IN_ARRAY]
```

---

## Wave Equation: FDTD String Simulation

### Physical model

Each string is modelled as a 1-D stiff vibrating beam with tension, bending stiffness,
velocity damping, and frequency-dependent (high-frequency) damping. The continuous PDE:

```
y_tt = (T/ρ) y_xx − (EI/ρ) y_xxxx − γ y_t − γ_HF · ∂(y_xx)/∂t + F/ρ
```

| Symbol | Meaning |
|--------|---------|
| `y(x,t)` | Transverse displacement |
| `T` | String tension |
| `ρ` | Linear density (per-unit-length mass) |
| `EI` | Bending stiffness (`EI ∝ E · r⁴` — Young's modulus × area moment) |
| `γ` | Velocity damping coefficient |
| `γ_HF` | Frequency-dependent damping (time-derivative of curvature) |
| `F(x,t)` | Applied external force (hammer excitation) |
| `y_xx` | `∂²y/∂x²` (spatial second derivative); `y_xxxx` likewise fourth |

### FDTD discretization

The PDE is solved with an explicit finite-difference scheme. Time is advanced in sub-steps
of `dt = 1 / (sample_rate × string_iteration)` inside the inner loop; space is discretized
on a uniform grid of spacing `dx` (set by string geometry). Each outer iteration produces
one audio sample after `string_iteration` sub-steps.

Interior-point update (one sub-step `j`):

```
target  =  shift_0 * s_a[p]
         + shift_b * s_b                    (previous time step)
         + shift_1 * (s_a[p-1] + s_a[p+1]) (2nd-order stencil — tension)
         + shift_2 * (s_a[p-2] + s_a[p+2]) (4th-order stencil — bending stiffness)
         + coeff_frequency_decay * (d3 - d3_1)  (HF damping — d/dt of curvature)
         + s_force_function[n] * coeff_force    (hammer force, per-point)
```

Where:
- `s_a[p]` — displacement at point `p`, time `t`
- `s_b` — displacement at point `p`, time `t − dt`
- `d3 = s_a[p−1] + s_a[p+1] − 2·s_a[p]` — discrete second-difference (curvature operator)
- `shift_0`, `shift_b`, `shift_1`, `shift_2`, `coeff_force`, `coeff_frequency_decay` —
  per-string FDTD coefficients, precomputed each cycle by `Kernels.cu::parameterKernel`
  (see the scaling table below).
- `s_force_function[n]` is the pre-computed Gaussian-sum force time series
  (see [Excitation System](#excitation-system)); `coeff_force` multiplies it into the
  per-point update and folds in the per-point hammer shape `hammer[p]`.

**Boundary condition at the bridge (stem):** The stem points are not integrated with the
wave equation. Instead their displacement is overwritten with the summed mode feedback:

```
if (onStem):  target = feedback   // feedback accumulated from all resonance modes
```

**Python reference** for both the discretization and coefficient formulas is
`PianoidBasic/Pianoid/Pitch.py::get_coefficients` (line 294). When GPU and Python disagree,
Python is authoritative.

### Coefficient scaling table

`iterPerMs = (sample_rate × string_iteration) / 1000 = 1 / (dt · 1000)`, so `1/iterPerMs²
∝ dt²`. These are the canonical scalings used by `parameterKernel` to produce the update
coefficients above, each traceable to a Python reference formula for GPU↔Python parity audit.

| Coefficient | Physical meaning | Per-sub-step scaling | GPU source | Python reference |
|---|---|---|---|---|
| `coeff_tension` | `(T/ρ) · dt² / dx²` | `∝ dt²` (∝ 1/iter²) | `Kernels.cu:133` | `Pitch.py:307` |
| `coeff_bending` | `(π·E·r⁴ / 4ρ) · dt² / dx⁴` | `∝ dt²` (∝ 1/iter²) | `Kernels.cu:135` | `Pitch.py:310` |
| `coeff_frequency_decay` | HF damping: `γ_HF · 1e12 / (2·dx²)` | **iter-invariant** (disputed — see open issues) | `Kernels.cu:139` | `Pitch.py:321` (`c2dec ∝ 1/(dt·dx²)`) |
| `dec_curr` | `γ_string · dt + damper` (velocity damping) | `∝ dt` (∝ 1/iter) | `Kernels.cu:141` | `Pitch.py:311` |
| `coeff_force` | `dt² · dec_inv · hammer[p]` (per-point force coefficient) | `∝ dt²` (∝ 1/iter²) | `Kernels.cu:155–158` | `Pitch.py:319` (`cf = dt² · dec_inv`) |
| `shift_0` | `(2 + 12·coeff_bending − 2·coeff_tension) · dec_inv` | derived | `Kernels.cu:144` | `Pitch.py:314` |
| `shift_b` | `(dec_curr − 1) · dec_inv` | derived | `Kernels.cu:148` | `Pitch.py:318` |
| `shift_1` | `(coeff_tension − 8·coeff_bending) · dec_inv` | derived | `Kernels.cu:145` | `Pitch.py:315` |
| `shift_2` | `2 · coeff_bending · dec_inv` | derived | `Kernels.cu:146` | `Pitch.py:316` |

`dec_inv = 1 / (1 + dec_curr)`.

`coeff_force` was corrected in commit `6e58413`: previously `∝ dt¹` (in ms units), causing
the per-sample force integral to scale as `iter` and an audio peak that scaled linearly
with `string_iteration`. Current formula matches the Python reference `cf = dt² · dec_inv`
to within 0.3%. See
[VOLUME_ITER_BUG_INVESTIGATION.md](../../development/archive/VOLUME_ITER_BUG_INVESTIGATION.md).

**Note on `coeff_force` interpretation:** it is the per-point force coefficient
`dt² · dec_inv · hammer[p]`, *not* a spatial Gaussian. The Gaussian / circular hammer
profile is in `hammer[p]` (precomputed from `PianoHammer.calculate_hammer_shape()` and
folded into the coefficient by `parameterKernel` at kernel entry).

### Numerical scheme invariants

- **Per sub-step:** FDTD string update, bridge force accumulation. Runs `string_iteration`
  times per audio sample.
- **Per audio sample (outer iteration):** mode ODE update, feedin/feedback reduction,
  `soundFloat` / `soundInt` emission. Runs `samplesInCycle` times per kernel launch.
- **Iter-invariant by design:** audio peak, spectral content. Post-fix validation: peak
  ratio iter=12/iter=4 = 1.011× (target ≤ 1.02×).
- **Known iter-scaled residual (open issue):** HF content (~25 dB swing iter=4→12),
  spectral centroid (~2× swing), initial decay rate (±3 dB/s). Traced to
  `coeff_frequency_decay` missing dt-scaling. See
  [WORK_IN_PROGRESS.md](../../development/WORK_IN_PROGRESS.md#known-follow-ups).

---

## Mode Simulation: Harmonic Oscillator

### Physical model

Each of the `numModes` (up to 256) soundboard resonance modes is a damped harmonic
oscillator driven by the aggregated bridge force from all strings. Per mode `n`:

```
q̈_n + 2 γ_n q̇_n + ω_n² q_n = F_applied(n) / m_n
```

| Symbol | Meaning | Stored field |
|--------|---------|--------------|
| `q_n` | Modal displacement (scalar) | `s_mode` / `mode_1` |
| `ω_n` | Angular frequency | `mode_omega` (precomputed) |
| `γ_n` | Modal damping | `mode_dec` (precomputed) |
| `m_n` | Modal mass | `mode_mass_inv = 1/m_n` (precomputed) |
| `F_applied(n)` | Summed bridge force from strings to mode n | reduced from `feedin_cycle_matrix` |

### Discrete update

Per-mode state is stored as five rows in `dev_mode_state`:

```
mode_state[0 * numModes + modeNo]  — current displacement  s_mode
mode_state[1 * numModes + modeNo]  — previous displacement mode_1
mode_state[2 * numModes + modeNo]  — decrement coefficient mode_dec
mode_state[3 * numModes + modeNo]  — omega coefficient     mode_omega
mode_state[4 * numModes + modeNo]  — inverse mass          mode_mass_inv
```

Update equation (runs once per audio sample, inside the outer iteration of `addKernel`):

```
result = ( (2*s_mode - mode_1)
           + mode_1   * mode_dec
           - s_mode   * mode_omega
           + F_applied * mode_mass_inv
         ) * (1 - mode_dec)

mode_1  = s_mode
s_mode  = result
```

This is an explicit leapfrog-style update of the continuous ODE, with `mode_dec` encoding
`2γ_n dt` and `mode_omega` encoding `ω_n² dt²` at audio-sample cadence (not sub-step). The
trailing `(1 - mode_dec)` factor applies a symmetric damping envelope so that the
decrement is consistent whether `γ_n > 0` increases or decreases the effective mass term.

`F_applied` is the summed force fed into this mode from all strings for the current
audio sample, accumulated via `feedin_cycle_matrix` and reduced with `sumArray()` (see
[Feedin: String → Mode](#feedin-string--mode)).

---

## String–Mode Coupling

Coupling is bidirectional: string vibration drives soundboard modes (feedin), and mode
displacement feeds back into each string at its bridge termination point (feedback). Two
intermediate global matrices (`feedin_cycle_matrix`, `feedback_cycle_matrix`) accumulate
contributions from all thread blocks, then `sumArray()` reduces them to per-mode and
per-string scalars. Both matrices are zeroed once per outer iteration (per audio sample),
not per inner FDTD sub-step.

### Coupling Coefficients

Each deck coefficient is a **normalised spatial coupling** value: the mode shape amplitude at
a bridge position, scaled so that the spatial maximum for each mode equals 1. This per-mode
normalisation ensures all modes are on the same scale; each mode's absolute amplitude is
encoded in its frequency, damping, and mass parameters. By physical reciprocity, feedin and
feedback use the same spatial coefficients (the coupling between a bridge point and a mode
is identical in both directions).

For **output pitches** (128+, soundboard receiver points), feedin is zero (receivers don't
excite modes) and feedback carries the mode shape at the receiver location — this determines
how much of each mode's displacement is observed at that point.

**The engine expects deck coefficients in the 0–1 range.** Raw measurement values (FFT
magnitudes, ESPRIT coefficients) must be normalised per mode across all pitches — including
output pitches — before preset injection. Un-normalised values (e.g. raw FFT magnitudes of
order 1e-4) produce silent output because the force-to-mode coupling becomes negligible.

Each thread loads coupling coefficients at kernel entry from `mode_coefficients` (the deck
coupling buffer in `PianoidPresetParameters`). A thread covers up to `NUM_FOLDS_IN_QUARTER=3`
mode indices via index folding, so 512 threads per block can address all 256 modes:

```
mode_feedin[i]  = mode_coefficients[stringNo * numModes + modeIndex[i]]
                  (loaded from preset, row-major: string × mode)

mode_feedback[i]:
  USE_SINGLE_DECK_MATRIX=1 (current default):
    mode_feedback[i] = mode_coefficients[targetString * numModes + modeNo] * (*deck_feedback_coeff)
    (feedback for target string loaded from feedin matrix × scalar coefficient)

  USE_SINGLE_DECK_MATRIX=0 (legacy):
    mode_feedback[i] = mode_coefficients[numStrings*numModes + string*numModes + mode]
    (loaded from second half of a 2× larger deck buffer)

Note: the target string index for feedback (`foldedIndexInQuarter`) differs from the source
string index for feedin (`stringNoForQuarter`). Each thread processes a different (string,
mode) pair for feedin vs feedback within the cooperative grid.
```

### Feedin: String → Mode

After the inner FDTD loop, each stem point has accumulated `force_on_bridge_point` across
all `soundStep` sub-steps. The per-string bridge force is summed via `atomicAdd` into
`force_on_bridge_summed[stringInArr]`, then written into `feedin_cycle_matrix`:

```
feedin_cycle_matrix[string * SEGMENT + blockNo] +=
    mode_feedin[i] * force_on_bridge_summed[quarter] / soundStep
```

The `/soundStep` normalises the accumulated force to a per-sub-step average. After a
`grid_group::sync()`, `sumArray()` reduces `SEGMENT_FOR_SHUFFLE_SUMMATION=64` columns to
a single scalar `F_applied` for each mode. The matrix is then zeroed for the next iteration.

### Feedback: Mode → String

At the start of each outer iteration (before the FDTD inner loop), mode displacement is
written into `feedback_cycle_matrix`:

```
feedback_cycle_matrix[string * SEGMENT + blockNo] +=
    mode_feedback[i] * s_mode[quarter]
```

After `grid_group::sync()`, `sumArray()` reduces to one scalar `s_feedback[stringInArr]`
per string. This scalar overwrites the stem boundary points:

```
if (onStem):  target = s_feedback[stringInArr]
```

### Audio Output

Audio is emitted from virtual "sound strings" that act as soundboard proxies, driven by
the mode feedback. In the current `Belarus_8band_196modes` layout (22 strings × 384
array-size grid) these are strings 220–223. They are the strings with `pitch ≥ 128`;
their excitation is zero (no hammer) and their stem displacement is purely the summed
mode feedback.

**Output channel mapping** (`MainKernel.cu:200, 482–494`):

```
outerSoundChannel = parameters[... 24 * arraySize + pointIndex]
                  = max(pitch - 127, 0)           // assigned in packing

sampleIndex = (outerSoundChannel - 1) * samplesInCycle + main_cycle_index
```

Only stem points with `outerSoundChannel > 0` write. The channel index is packed at
preset load time from `PianoidBasic/Pianoid/Pitch.py:108`:

```python
packed_physics['outer_sound'] = max(self.pitch - 127, 0)
```

**Per-sample write** (at audio-sample cadence, `main_cycle_index` ∈ `[0, samplesInCycle)`):

```cpp
if (outerSoundChannel && isStem) {
    real diff_result = feedback - s_b;        // 1st derivative (velocity)
    real output = diff_result;
    if (soundDerivativeOrder == 2) {
        output = diff_result - prev_diff;     // 2nd derivative (acceleration)
        prev_diff = diff_result;              // persist for next sample
    }
    soundInt  [sampleIndex] = Sint32(output * main_volume_coefficient);
    soundFloat[sampleIndex] = float (output);
}
```

Where:
- `feedback = s_feedback[stringInArr]` — summed mode→string feedback reduced from
  `feedback_cycle_matrix` (MainKernel.cu:461).
- `s_b` — string displacement at this stem point from the *previous* audio sample (saved
  at the end of the FDTD inner loop, MainKernel.cu:540).
- `soundDerivativeOrder` comes from `cycle_parameters[12]`: `1` = velocity (default),
  `2` = acceleration.
- `prev_diff` state is persisted across kernel launches via the `sound_prev_diff` global
  memory buffer (one `real` per output channel). Loaded at kernel start
  (MainKernel.cu:203–206), saved at kernel end (MainKernel.cu:713–715).

The preset configures exactly 4 output channels in Belarus_8band_196modes, yielding 4 of
the 22 strings as "sound strings" with `outerSoundChannel` values `1..4` and contributing
2 stem points each (8 writes per cycle, filling `dev_soundFloat[0..samplesInCycle·4−1]`).
Full audio chain and empirical verification in
[VOLUME_ITER_BUG_INVESTIGATION.md](../../development/archive/VOLUME_ITER_BUG_INVESTIGATION.md#audio-path-discovery).

There is also a parallel **mode-direct output path** for listen-to-modes mode
(`MainKernel.cu:623–630`) that writes `s_mode_applied_force[quarter]` directly when
`outerSoundModeChannel > 0` — used when `listen_to_modes=1` to tap mode force without going
through string feedback.

### sumArray Reduction

`sumArray()` uses a two-level reduction: warp-level `__shfl_down_sync` (32 lanes, ~10
cycles) followed by cross-warp `atomicAdd` into shared memory (~100 cycles). The reduction
is synchronised with `thread_group::sync()` before and after.

### Runtime Feedback Coefficient

`deck_feedback_coeff` is a single `real` in GPU global memory, registered as
`STATIC_INPUT` category (not part of the TUNABLE double-buffered preset region). Updated
via direct `cudaMemcpy` + `cudaDeviceSynchronize()`. Controlled at runtime by MIDI CC 74
with exponential mapping: `8.0^((CC - 64) / 63)` — CC 0 → 0.125, CC 64 → 1.0,
CC 127 → 8.0. Validation range: 0.0–1000.0.

### FEEDBACK_OFF Debug Switch

`FEEDBACK_OFF` is a preprocessor define in `MainKernel.cu` (commented out by default). When
enabled, it overrides the stem boundary condition to `feedback = 0`, effectively decoupling
modes from strings. Used for debugging the feedin path in isolation — mode oscillators still
receive force from strings, but the feedback loop is broken so string behaviour is
independent of mode displacement.

---

## Synthesis Cycle

One synthesis cycle corresponds to `samplesInCycle` audio samples. The outer loop in
`addKernel` iterates `samplesInCycle` times (up to `MAX_ITERATIONS_IN_CYCLE = 1024`).
Each iteration contains an inner loop of `soundStep` FDTD sub-steps.

```
Per synthesis cycle (managed by Pianoid::runSynthesisKernel):

  1. Pianoid::runSynthesisKernel()
       |
       +-- cudaLaunchCooperativeKernel(addKernel, ...)
             |
             for main_cycle_index in [0, samplesInCycle):
               a. Write mode→string feedback into feedback_cycle_matrix
               b. allBlocks.sync()
               c. Reduce feedback for each string (sumArray)
               d. Emit audio sample to soundFloat / soundInt buffers
               e. Inner loop [0, soundStep):
                    - FDTD string update at every spatial point
                    - Accumulate force_on_bridge_point for stem points
               f. allThreads.sync()
               g. Accumulate string→mode force into feedin_cycle_matrix
               h. allBlocks.sync()
               i. Reduce force for each mode (sumArray)
               j. Update harmonic oscillator (mode equation)
               k. Zero feedin_cycle_matrix for next iteration
             |
             Save string_state (current + previous displacement)
             Save mode_state   (current + previous displacement)

  2. Pianoid::pushCycleAudioToDriver()   — advance excitation cycle index, push to audio driver
     (Online regime only; called from Pianoid::runCycle after synthesis)
```

---

## Signal Flow Diagram

```
  MIDI / REST event
       |
       v
  addStringToBatch() → records string index + velocity into host batch buffers
       |                 (Gauss params already resident on GPU in dev_gauss_params_full)
       v
  commitStringBatch() → cudaMemcpy batch buffers to GPU
       |                  sets new_notes_ind = batch_size + 1
       |
  +----+
  |
  |  +----- runSynthesisKernel() -------------------------------------------+
  |  |                                                                        |
  |  |  if new_notes_ind > 0:  parameterKernel (update coefficients)         |
  |  |  if new_notes_ind > 1:  gaussKernel (compute force_function)          |
  |  |                                                                        |
  |  |  dev_gauss_params_full ──► gaussKernel ──► dev_force_function          |
  |  |                                                  |                     |
  |  |                                                  v                     |
  |  |  [FDTD string update] <--- string_state (t, t-1)                      |
  |  |        |                    + force_function[n] * coeff_force          |
  |  |        |                                                               |
  |  |  force_on_bridge  -->  feedin_cycle_matrix  -->  sumArray             |
  |  |                                                      |                 |
  |  |                                               F_applied (per mode)    |
  |  |                                                      |                 |
  |  |                                            [harmonic oscillator]      |
  |  |                                                      |                 |
  |  |                                              mode_state (t, t-1)      |
  |  |                                                      |                 |
  |  |                    feedback_cycle_matrix  <----------+                 |
  |  |                           |                                            |
  |  |                        sumArray                                        |
  |  |                           |                                            |
  |  |                     feedback (per string)                              |
  |  |                           |                                            |
  |  |                    [stem displacement = feedback]                      |
  |  |                                                                        |
  |  |  soundFloat / soundInt  <-- (feedback - s_b) * main_volume_coeff      |
  |  |        |                                                               |
  |  +--------+                                                               |
  |           +---------------------------------------------------------------+
  |
  v
  [FIR convolution kernel — optional]
       |
       v
  audio driver (ASIO / SDL3)
```

---

## Excitation System

**Files:** `gaussTest.cu` / `gaussTest.cuh`, `Pianoid.cu`

The excitation system translates MIDI note events into time-varying force waveforms that
drive the FDTD string simulation. It operates in two phases: a **parameter phase** (Gauss
curves uploaded via the double-buffer preset system) and a **trigger phase** (per-note batch
API that launches `gaussKernel` to compute the force function).

### Batch Excitation API

When a note event arrives, the host prepares a batch of strings to excite, then commits
them all in one GPU transfer:

```cpp
void beginStringBatch();
// Reset batch counter (noStrings_in_GP = 0)

void addStringToBatch(int stringNo, int velocity);
// Append one string to the batch:
//   1. Store (stringNo, volume_coeff[stringNo], timing=0) in host buffer
//   2. Compute param_offset = (stringNo * 128 + velocity) * 20
//      into string_gauss_param_indices (index into dev_gauss_params_full)
//   3. Set dec_open[stringNo] = DUMP_OPEN (damper lifted)
//   4. Increment noStrings_in_GP

void commitStringBatch();
// Transfer batch to GPU and arm the kernel trigger:
//   1. cudaMemcpy: string_gauss_param_indices → dev_gauss_param_indices
//   2. cudaMemcpy: string_excitation_params   → dev_string_excitation_params
//   3. Set new_notes_ind = noStrings_in_GP + 1
//   4. Execute pending mode excitation if staged
```

Single-string convenience wrapper:

```cpp
void addOneString(int stringNo, int velocity);
// Equivalent to beginStringBatch() + addStringToBatch() + commitStringBatch()
// for a single string
```

### Kernel Trigger: `new_notes_ind`

`runSynthesisKernel()` checks `new_notes_ind` to decide which kernels to launch:

```
new_notes_ind == 0  →  addKernel only (normal synthesis cycle)
new_notes_ind == 1  →  parameterKernel + addKernel
new_notes_ind >  1  →  parameterKernel + gaussKernel + addKernel
                        (gaussKernel grid: noStrings = new_notes_ind - 1)
```

`new_notes_ind` is reset to 0 at the end of `runSynthesisKernel()`.

### gaussKernel — Force Function Computation

**File:** `gaussTest.cu`

`gaussKernel` is a separate kernel (not part of `addKernel`) launched once per note event
to pre-compute the full excitation time series into `dev_force_function`.

```
Launch configuration:
  gridDim  = (noStrings, numSeg)     where numSeg = (mode_iteration * sound_step * 7) / 128
  blockDim = 128
```

For each string in the batch, the kernel:

1. Reads the Gauss parameter offset from `dev_gauss_param_indices[blockIdx.x]`
2. Loads 20 parameters from `dev_gauss_params_full` at that offset:

```
[offset +  0.. 4]  →  mu[5]       (peak time of each Gaussian)
[offset +  5.. 9]  →  sigma[5]    (width of each Gaussian)
[offset + 10..14]  →  g_vol[5]    (amplitude of each Gaussian)
[offset + 15..19]  →  g_shift[5]  (vertical offset / ReLU threshold)
```

3. Computes the force value at each time point using a sum of 5 Gaussians:

```
xCoordinate = sample_index * (EXCITATION_FACTOR - 1) / excitation_length

For each Gaussian i:
    g = exp(-0.5 * ((xCoordinate - mu[i]) / sigma[i])²)
    g = max(g - g_shift[i], 0)      // per-component ReLU gate
    result += g * g_vol[i]

result *= volume_coefficient
```

4. Writes to `dev_force_function[stringNo * totalExcitationLength + sample_index]`

**Note:** The per-component ReLU gate (`max(g - shift, 0)` applied before summation) differs
from the Python `ExcitationParameters.calculate()` method which clips the total sum after
all 5 Gaussians are added. The GPU formula is the one used in actual synthesis.

### Excitation Cycle Index

Each string has an `exct_cycle_index` counter in `dev_exct_cycle_index` (256 ints). When
`gaussKernel` runs, it resets the counter to 0 for each excited string. The main kernel
(`addKernel`) advances this counter each synthesis cycle and reads `force_function` at the
corresponding offset. When the counter exceeds `excitation_factor × num_iterations()`
(default: 8 × 576 = 4,608 sub-steps), the force drops to zero — the hammer has left the string.

### Force Function Buffer

`dev_force_function` is a WORKING-category single-buffered GPU allocation:

```
Size: MAX_NUM_STRINGS × totalExcitationLength reals
      where totalExcitationLength = mode_iteration × sound_step × EXCITATION_FACTOR
      typical: 256 × 4096 = 1,048,576 reals (~4 MB float, ~8 MB double)

Layout (row-major):
  force_function[string_index * totalExcitationLength + sample_index]
```

The buffer is overwritten each time `gaussKernel` runs. Only strings in the current batch
are updated; previously-excited strings retain their force function until the next note event
targeting them.

### Excitation Parameter Storage (Preset Region)

`dev_gauss_params_full` is part of the TUNABLE double-buffered preset block:

```
Size: 256 strings × 128 velocity levels × 20 params = 655,360 reals (2.5 MB float)

Indexing: param_offset = (stringNo * 128 + velocity) * 20

Per velocity level (20 reals):
  [0..4]    mu[5]       — Gaussian peak times (ms within excitation window)
  [5..9]    sigma[5]    — Gaussian widths
  [10..14]  g_vol[5]    — Gaussian amplitudes
  [15..19]  g_shift[5]  — ReLU threshold offsets
```

**Update path (unified):** Both init and runtime use the same flow:

| Entry point | Method | When |
|-------------|--------|------|
| Init | `loadPresetToLibrary(preset_name, ...)` | Once at startup |
| Runtime | `setNewExcitationBaseLevels()` | Every parameter edit |

Both accept 6 base velocity levels per string (30,720 reals) and call the private
`interpolateBaseLevels()` helper to reconstruct the full 128-level buffer. The
interpolation uses the same segment boundaries [0, 5, 31, 63, 95, 128] and linear formula
as Python's `extrapolate()`. The reconstructed buffer is uploaded via
`updateTunableParameter()` on the double-buffer system (see
[MEMORY_MANAGEMENT.md](MEMORY_MANAGEMENT.md)).

### Mode Excitation

Modes can be excited directly (bypassing string-to-mode coupling) via:

```cpp
void addModeExcitation(int modeNo, float displacement, float velocity);
// Stages a direct mode excitation for the next commitStringBatch() call.
// Sets mode state: q = displacement, q_prev = displacement - velocity * dt
// Applied synchronously by commitStringBatch() via _exciteSingleMode().

void exciteMode(int modeNo, float displacement, float velocity);
// Direct mode excitation — writes q/q_prev to GPU immediately.
// No commitStringBatch() needed. Safe to call before runOfflinePlayback().
```

Mode state is stored in strided (SoA) layout in `dev_mode_state`:
`[q_0..q_N, q_prev_0..q_prev_N, dec_0..dec_N, omega_0..omega_N, mass_inv_0..mass_inv_N]`.
The kernel reads `mode_state[modeNo]` for q and `mode_state[numModes + modeNo]` for q_prev.

This is used for testing individual resonator modes without triggering string excitation.

### Excitation Constants

| Constant | Value | Meaning |
|----------|-------|---------|
| `NUM_GAUSS` | 5 | Gaussian components per excitation curve |
| `GAUSS_PARAMETERS_NUMBER` | 4 | Parameters per Gaussian (mu, sigma, vol, shift) |
| `LEN_LEVEL_GP` | 20 | Total params per velocity level (5 × 4) |
| `NO_EXCITATION_LEVELS` | 128 | MIDI velocity levels |
| `EXCITATION_FACTOR` | 8 | Excitation duration in milliseconds |
| `MAX_STRINGS_PER_EVENT` | 64 | Max strings per batch |

---

## FIR Filter Convolution

**File:** `FIRFilter.cuh` / `FIRFilter.cu`

`convolutionKernel` is a separate cooperative-grid kernel launched after the main kernel
when `FIRfilterON == true`. It performs per-channel overlap-add convolution:

```
__global__ void convolutionKernel(
    float* input_buffers,      // ring buffer per channel (filterSize + samplesPerCycle)
    const float* input_samples, // raw per-cycle audio
    const float* filters,       // FIR coefficients (inputChannels × outputChannels × filterSize)
    float* output,              // convolved output
    float* partials,            // partial sums [outputChannels × samplesPerCycle][WARP_SIZE]
    float* filter_sums,         // accumulated sums [outputChannels][samplesPerCycle]
    Sint16* int16output,
    float* floatOutput,
    int* cycle_parameters,      // [sampleRate, filterSize, cycle_index, dest_index,
                                //  inputChannelsNo, outputChannelsNo, debugOutputChannel,
                                //  samplesPerCycle]
    const real* main_volume_coeff
)
```

The grid maps `gridDim.x = inputChannels * outputChannels` blocks to input/output channel
pairs, enabling fully parallel multi-channel convolution in a single cooperative launch.

Host wrapper: `runConvolutionKernel()` allocates GPU buffers and returns the convolved
`std::vector<float>`.
