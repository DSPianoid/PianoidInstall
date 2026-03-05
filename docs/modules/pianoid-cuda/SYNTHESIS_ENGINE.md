# Synthesis Engine

## Overview

The synthesis engine produces audio by solving the piano string wave equation and the
soundboard mode equations simultaneously on the GPU every synthesis cycle. The two
simulations are bidirectionally coupled: string vibration drives soundboard modes, and
mode displacement feeds back into each string at its bridge termination point.

An optional FIR convolution kernel post-processes the output for room acoustics or
equalization.

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

Each string is modelled as a 1-D stiff vibrating beam. The finite-difference update for
interior points reads (one sub-step `j` inside the inner loop):

```
target  =  shift_0 * s_a[p]
         + shift_b * s_b                    (previous time step)
         + shift_2 * (s_a[p-2] + s_a[p+2]) (fourth-order spatial stencil — stiffness)
         + shift_1 * (s_a[p-1] + s_a[p+1]) (second-order spatial stencil — tension)
         + coeff_frequency_decay * (d3 - d3_1)  (frequency-dependent damping)
         + s_force_function[n] * coeff_force      (excitation force)
```

Where:
- `s_a[p]` — displacement at point `p`, time `t`
- `s_b`    — displacement at point `p`, time `t - dt`
- `shift_0`, `shift_b`, `shift_1`, `shift_2` — FDTD coefficients derived from tension,
  density, stiffness, and spatial step `dx` (precomputed by `Kernels.cu::parameterKernel`)
- `coeff_frequency_decay` — frequency-dependent damping term (proportional to `coeff_gamma`)
- `coeff_force` — spatial Gaussian profile of the hammer at point `p`
- `d3 = s_a[p-1] + s_a[p+1] - 2*s_a[p]` — second-difference operator

**Boundary condition at the bridge (stem):** The stem points are not integrated with the
wave equation. Instead their displacement is overwritten with the summed mode feedback:

```
if (onStem):  target = feedback   // feedback accumulated from all resonance modes
```

---

## Mode Simulation: Harmonic Oscillator

Each of the 256 resonance modes is a damped harmonic oscillator updated every sub-step.
Per-mode state is stored as five rows in `dev_mode_state`:

```
mode_state[0 * numModes + modeNo]  — current displacement  s_mode
mode_state[1 * numModes + modeNo]  — previous displacement mode_1
mode_state[2 * numModes + modeNo]  — decrement coefficient mode_dec
mode_state[3 * numModes + modeNo]  — omega coefficient     mode_omega
mode_state[4 * numModes + modeNo]  — inverse mass          mode_mass_inv
```

Update equation (one sample per synthesis cycle sub-step):

```
result = ( (2*s_mode - mode_1)
           + mode_1   * mode_dec
           - s_mode   * mode_omega
           + F_applied * mode_mass_inv
         ) * (1 - mode_dec)

mode_1  = s_mode
s_mode  = result
```

Where `F_applied` is the summed force fed into this mode from all strings for the current
sub-step, accumulated via `feedin_cycle_matrix` and reduced with `sumArray()`.

---

## String–Mode Coupling

Coupling is implemented through two intermediate global matrices that are zeroed after
each sub-step to avoid accumulation across cycles.

```
String → Mode  (feedin_cycle_matrix)
  For each string s and mode m:
    feedin_cycle_matrix[s * SEGMENT + block] += mode_feedin[i] * force_on_bridge

  sumArray() reduces SEGMENT columns → scalar F_applied for each mode

Mode → String  (feedback_cycle_matrix)
  For each mode m and string s:
    feedback_cycle_matrix[s * SEGMENT + block] += mode_feedback[i] * s_mode

  sumArray() reduces SEGMENT columns → scalar feedback for each string

  With USE_SINGLE_DECK_MATRIX=1 (current default):
    mode_feedback[i] = mode_feedin[i] * (*deck_feedback_coeff)
```

`mode_feedin` and `mode_feedback` are loaded once before the main iteration from the
`mode_coefficients` (deck coupling) buffer.

---

## Synthesis Cycle

One synthesis cycle corresponds to `samplesInCycle` audio samples. The outer loop in
`addKernel` iterates `samplesInCycle` times (up to `MAX_ITERATIONS_IN_CYCLE = 1024`).
Each iteration contains an inner loop of `soundStep` FDTD sub-steps.

```
Per synthesis cycle (managed by Pianoid::executeSynthesisCycle):

  1. Pianoid::launchMainKernel()
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

  2. Pianoid::playSoundSamples()   — advance excitation cycle index, push to audio driver
  3. Pianoid::appendSoundRecords() — optional D2H copy for recording
```

---

## Signal Flow Diagram

```
  MIDI / REST event
       |
       v
  addStringToBatch() → excitation Gaussian loaded into dev_gauss_params_full
       |
       v
  commitStringBatch() → exct_cycle_index[string] set to 0
       |
  +----+
  |
  |  +----- per cycle --------------------------------------------------------+
  |  |                                                                         |
  |  |  dev_gauss_params_full                                                  |
  |  |        |  (force function)                                              |
  |  |        v                                                                |
  |  |  [FDTD string update] <--- string_state (t, t-1)                       |
  |  |        |                                                                |
  |  |  force_on_bridge  -->  feedin_cycle_matrix  -->  sumArray              |
  |  |                                                      |                  |
  |  |                                               F_applied (per mode)     |
  |  |                                                      |                  |
  |  |                                            [harmonic oscillator]       |
  |  |                                                      |                  |
  |  |                                              mode_state (t, t-1)       |
  |  |                                                      |                  |
  |  |                    feedback_cycle_matrix  <----------+                  |
  |  |                           |                                             |
  |  |                        sumArray                                         |
  |  |                           |                                             |
  |  |                     feedback (per string)                               |
  |  |                           |                                             |
  |  |                    [stem displacement = feedback]                       |
  |  |                                                                         |
  |  |  soundFloat / soundInt  <-- (feedback - s_b) * main_volume_coeff       |
  |  |        |                                                                |
  |  +--------+                                                                |
  |           +----------------------------------------------------------------+
  |
  v
  [FIR convolution kernel — optional]
       |
       v
  audio driver (ASIO / SDL3)
```

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
