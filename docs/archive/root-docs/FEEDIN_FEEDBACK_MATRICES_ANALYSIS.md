# Feedin and Feedback Matrices: Comprehensive Analysis

**Document Created:** November 12, 2025
**Author:** Claude Code Analysis
**Purpose:** Deep technical analysis of the separate feedin/feedback matrix architecture in PianoidCore

---

## Executive Summary

PianoidCore implements **two separate coupling matrices** (feedin and feedback) that mediate bidirectional energy exchange between piano strings and soundboard modes. These matrices are already separated in the codebase and serve distinct physical roles in modal synthesis.

**Key Findings:**
- ✅ Matrices are **already separated** in both memory layout and physical function
- ✅ Documentation accurately reflects the implementation
- ⚠️ **Potential bug found** in feedback matrix indexing ([MainKernel.cu:237](pianoid_cuda/MainKernel.cu#L237))
- ✅ Memory layout is optimized for GPU coalesced access

---

## Table of Contents

1. [Physical Model Overview](#1-physical-model-overview)
2. [Data Structure and Memory Layout](#2-data-structure-and-memory-layout)
3. [Matrix Initialization and Packing](#3-matrix-initialization-and-packing)
4. [CUDA Kernel Usage](#4-cuda-kernel-usage)
5. [Documentation Verification](#5-documentation-verification)
6. [Identified Issues](#6-identified-issues)
7. [Mathematical Foundation](#7-mathematical-foundation)
8. [API Reference](#8-api-reference)

---

## 1. Physical Model Overview

### Modal Synthesis Architecture

PianoidCore uses **modal synthesis** where:
- **Strings** are discretized vibrating systems (finite difference method)
- **Modes** are soundboard resonances (damped harmonic oscillators)
- **Coupling** occurs at the **bridge point** (stem) of each string

### Bidirectional Energy Exchange

```
┌─────────────┐                          ┌──────────────┐
│   String s  │                          │   Mode k     │
│  (discrete) │                          │  (oscillator)│
│             │                          │              │
│  x[1..N]    │   Feedin Matrix          │  State:      │
│  vibration  ├──────────────────────────>  position    │
│             │   F[k,s] = ∫φ_k·F_s dx   │  velocity    │
│             │                          │  frequency   │
│  Stem point │   Feedback Matrix        │  damping     │
│  x[stem_s]  <──────────────────────────┤              │
│             │   B[s,k] = φ_k(x_stem)   │              │
└─────────────┘                          └──────────────┘

Feedin:  String force → Mode excitation
Feedback: Mode amplitude → String stem displacement
```

### Physical Meaning

| Matrix | Direction | Physical Process | Mathematical Form |
|--------|-----------|------------------|-------------------|
| **Feedin** | String → Mode | String vibration excites soundboard modes via bridge force | `F[k,s] = ∫ φ_k(x) · F_s(x) dx` |
| **Feedback** | Mode → String | Mode vibration drives string stem point | `B[s,k] = φ_k(x_stem_s)` |

---

## 2. Data Structure and Memory Layout

### GPU Memory Structure

**Location:** [PresetParameters.h:33-35](pianoid_cuda/PresetParameters.h#L33-L35)

```cpp
// === DECK COUPLING PARAMETERS (131,072 reals) ===
// Layout: [feedin_string0 × 256] [feedin_string1 × 256] ...
//         [feedback_string0 × 256] ...
real deck_coupling_parameters[NUM_STRINGS * NUM_MODES * 2];
```

### Memory Layout Details

**Total Size:** 131,072 reals (~512 KB for float, ~1 MB for double)

**Structure:**
```
Offset 0:     [Feedin Matrix]  - 65,536 reals (256 strings × 256 modes)
Offset 65536: [Feedback Matrix] - 65,536 reals (256 strings × 256 modes)
```

**Matrix Organization (Row-major):**
```
Feedin Matrix:
  [string 0][mode 0, mode 1, ..., mode 255]
  [string 1][mode 0, mode 1, ..., mode 255]
  ...
  [string 255][mode 0, mode 1, ..., mode 255]

Feedback Matrix:
  [string 0][mode 0, mode 1, ..., mode 255]
  [string 1][mode 0, mode 1, ..., mode 255]
  ...
  [string 255][mode 0, mode 1, ..., mode 255]
```

### Indexing Formula

```cpp
// Feedin coefficient: mode k excitation from string s
feedin_coeff = mode_coefficients[s * NUM_MODES + k]

// Feedback coefficient: string s displacement from mode k
feedback_coeff = mode_coefficients[NUM_STRINGS * NUM_MODES + s * NUM_MODES + k]
```

**Offset Calculation:**
```cpp
// From PresetParameterOffsets (PresetParameters.h:57-58)
static constexpr size_t DECK_OFFSET = MODE_STATE_OFFSET + MODE_STATE_SIZE;
static constexpr size_t DECK_SIZE = NUM_STRINGS * NUM_MODES * 2;
```

---

## 3. Matrix Initialization and Packing

### Default Initialization Values

**Location:** [Pitch.py:158-189](D:\repos\PianoidInstall\PianoidCore\.venv\Lib\site-packages\Pianoid\Pitch.py#L158-L189)

| String Type | Feedin | Feedback | Rationale |
|-------------|--------|----------|-----------|
| **Key pitches (0-127)** | 1.0 | 0.0 | Strings respond to soundboard modes but don't excite them |
| **Outer sound pitches (128-139)** | 0.0 | 1.0 | Soundboard strings receive energy from piano strings |

```python
# Default initialization logic
if self.outerSound:
    self.deck['feedback'] = np.ones(self.mp.num_modes)   # Soundboard receives
    self.deck['feedin'] = np.zeros(self.mp.num_modes)    # Soundboard doesn't respond
else:
    self.deck['feedback'] = np.zeros(self.mp.num_modes)  # Keys don't excite modes
    self.deck['feedin'] = np.ones(self.mp.num_modes)     # Keys respond to modes
```

### Padding Strategy

**Location:** [pianoid.py:127-129](pianoid_middleware/pianoid.py#L127-L129)

```python
for _, pitch in self.sm.pitches.items():
    # Pad to match number of working modes (edge mode = repeat last value)
    pitch.deck['feedin'] = np.pad(
        pitch.deck['feedin'],
        (0, self.modes.num_working_modes() - len(pitch.deck['feedin'])),
        mode='edge'
    )
    pitch.deck['feedback'] = np.pad(
        pitch.deck['feedback'],
        (0, self.modes.num_working_modes() - len(pitch.deck['feedback'])),
        mode='edge'
    )
```

**Padding Mode:** `'edge'` - extends the last value to fill the array

### Packing for CUDA

**Location:** [StringMap.py:426-433](D:\repos\PianoidInstall\PianoidCore\.venv\Lib\site-packages\Pianoid\StringMap.py#L426-L433)

```python
def pack_deck(self, pack_for_cuda=True):
    # Stack feedin arrays for all pitches
    feedin = np.stack([
        self.pack_pitch_feedin(pitchID)
        for pitchID in self.pitch_index
    ])

    # Stack feedback arrays (padded to num_modes_for_model)
    feedback = np.stack([
        ext_to_the_right(self.pitches[pitchID].deck['feedback'],
                        self.mp.num_modes_for_model)
        for pitchID in self.pitch_index
    ])

    if pack_for_cuda:
        # Flatten and concatenate: [feedin matrix] + [feedback matrix]
        return feedin.ravel().tolist() + feedback.ravel().tolist()
    else:
        # Return separate numpy arrays
        return feedin, feedback
```

**Special Handling for Feedin:**

```python
def pack_pitch_feedin(self, pitchID):
    feedin = ext_to_the_right(
        self.pitches[pitchID].deck['feedin'],
        self.mp.num_strings
    )

    # Inject sound channel mode coefficients if enabled
    if self.mp.listen_to_modes:
        try:
            feedin[self.soundChannelModes.get_index()] = \
                self.soundChannelModes.get_coeff(pitchID)
        except Exception as e:
            raise e

    return feedin
```

---

## 4. CUDA Kernel Usage

### Kernel Registration

**Location:** [Pianoid.cu:349-352](pianoid_cuda/Pianoid.cu#L349-L352)

```cpp
memory_manager_.registerTunableBuffer("dev_deck_parameters",
    PresetParameterOffsets::DECK_OFFSET * sizeof(real),
    PresetParameterOffsets::DECK_SIZE * sizeof(real),
    (void**)&dev_deck_parameters);
```

### Main Kernel Access

**Location:** [MainKernel.cu:87](pianoid_cuda/MainKernel.cu#L87)

```cpp
__global__ void addKernel(
    // ... other parameters ...
    real* mode_coefficients,  // ← dev_deck_parameters
    // ... other parameters ...
)
```

### Coefficient Loading

**Location:** [MainKernel.cu:221-239](pianoid_cuda/MainKernel.cu#L221-L239)

Each thread loads coefficients for multiple modes using **loop unrolling**:

```cpp
// Local arrays for coefficient caching
real mode_feedin[NUM_FOLDS_IN_QUARTER] = {0};
real mode_feedback[NUM_FOLDS_IN_QUARTER] = {0};
int foldedIndexInQuarter[NUM_FOLDS_IN_QUARTER] = {0};
int modeIndexInQuarter[NUM_FOLDS_IN_QUARTER] = {0};

for (int i = 0; i < NUM_FOLDS_IN_QUARTER; i++) {
    mode_feedback[i] = 0;
    mode_feedin[i] = 0;

    // Calculate folded indices for mode striping
    foldedIndexInQuarter[i] = indexInQuarter + quarterSize * i;
    int numBlockForTheFold = foldedIndexInQuarter[i] / numStringsInArray;

    if (numBlockForTheFold < numArrays) {
        modeIndexInQuarter[i] =
            (foldedIndexInQuarter[i] % numStringsInArray) * numArrays + numBlockForTheFold;
    }

    // Load FEEDIN coefficient: String → Mode
    if (modeIndexInQuarter[i] < numModes && foldedIndexInQuarter[i] < numModes) {
        mode_feedin[i] = mode_coefficients[
            stringNoForQuarter * numModes + modeIndexInQuarter[i]
        ];
    }

    // Load FEEDBACK coefficient: Mode → String
    if (foldedIndexInQuarter[i] < numStrings && modeNo < numModes) {
        mode_feedback[i] = mode_coefficients[
            numStrings * numModes +           // ← Offset to feedback matrix
            foldedIndexInQuarter[i] * numModes +
            5  // ⚠️ POTENTIAL BUG - should be modeNo?
        ];
    }
}
```

### Usage Pattern 1: Feedback Application (Mode → String)

**Location:** [MainKernel.cu:378-390](pianoid_cuda/MainKernel.cu#L378-L390)

Modes write their amplitude weighted by feedback coefficients:

```cpp
if (modeNo < numModes) {
    for (int i = 0; i < NUM_FOLDS_IN_QUARTER; i++) {
        if (foldedIndexInQuarter[i] < numStrings) {
            int feedback_write_idx =
                foldedIndexInQuarter[i] * SEGMENT_FOR_SHUFFLE_SUMMATION + blockNo;

            // Mode contributes to string displacement
            atomicAdd(
                feedback_cycle_matrix + feedback_write_idx,
                mode_feedback[i] * s_mode[quarterNumber]  // ← Mode amplitude
            );
        }
    }
}
```

**Later in the cycle** ([MainKernel.cu:411, 483-485](pianoid_cuda/MainKernel.cu#L411)):

```cpp
// Strings read accumulated feedback
sumArray(&feedback_cycle_matrix[...], ..., s_feedback, ...);

if (onStem) {
    target = feedback;  // Stem point forced to modal feedback value
}
```

### Usage Pattern 2: Feedin Application (String → Mode)

**Location:** [MainKernel.cu:537-543](pianoid_cuda/MainKernel.cu#L537-L543)

Strings project their bridge force onto modes:

```cpp
for (int i = 0; i < NUM_FOLDS_IN_QUARTER; i++) {
    if (modeIndexInQuarter[i] < numModes && foldedIndexInQuarter[i] < numStrings) {
        int feedin_write_idx =
            foldedIndexInQuarter[i] * SEGMENT_FOR_SHUFFLE_SUMMATION + blockNo;

        // String force excites mode
        atomicAdd(
            feedin_cycle_matrix + feedin_write_idx,
            mode_feedin[i] * force_on_bridge_summed[quarterNumber] / soundStep
            // ↑ Feedin coefficient × bridge force
        );
    }
}
```

### Cycle Resetting

**Critical Implementation Detail:**

Both coupling matrices are **zeroed every inner timestep** to ensure energy conservation:

```cpp
// Reset cycle matrices (MainKernel.cu:430-431, 593-595)
memset(feedin_cycle_matrix, 0, size);
memset(feedback_cycle_matrix, 0, size);
```

This ensures each timestep computes fresh coupling based on current string/mode states.

---

## 5. Documentation Verification

### Documentation Accuracy Assessment

| Documentation Location | Status | Notes |
|------------------------|--------|-------|
| [PresetParameters.h](pianoid_cuda/PresetParameters.h#L33-L35) | ✅ Accurate | Correctly describes layout and size |
| [COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md:880-883](pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md#L880-L883) | ✅ Accurate | Matches implementation |
| [COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md:745-773](pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md#L745-L773) | ✅ Accurate | Correctly explains usage pattern |
| Size calculation | ✅ Accurate | 2 × 256 × 256 = 131,072 reals |
| Memory offset calculation | ✅ Accurate | DECK_OFFSET correctly positioned after modes |

### Verified Properties

✅ **Matrices are separate:** Feedin and feedback are distinct blocks
✅ **Row-major layout:** Strings are rows, modes are columns
✅ **Double-buffered:** Part of tunable parameter system with async updates
✅ **Coalesced access:** String-major layout optimizes GPU memory access
✅ **Proper bounds checking:** Kernel code checks indices before access (fixed in recent commits)

---

## 6. Identified Issues

### Issue 1: Suspicious Hardcoded Index in Feedback Loading

**Location:** [MainKernel.cu:237](pianoid_cuda/MainKernel.cu#L237)

```cpp
mode_feedback[i] = mode_coefficients[
    numStrings * numModes +
    foldedIndexInQuarter[i] * numModes +
    5  // ⚠️ Hardcoded value - should be modeNo?
];
```

**Expected Pattern (from line 337 comment):**
```cpp
mode_coefficients[numStrings * numModes + blockNo * numModes + stMdIndex]
                                           ↑                    ↑
                                         string                mode
```

**Comparison with Feedin (line 234):**
```cpp
mode_feedin[i] = mode_coefficients[
    stringNoForQuarter * numModes +
    modeIndexInQuarter[i]  // ← Correctly uses variable mode index
];
```

**Analysis:**
- Feedin uses `modeIndexInQuarter[i]` (variable)
- Feedback uses `5` (constant)
- This appears to **always access mode 5** for all strings in the feedback matrix
- Likely causes incorrect mode-to-string coupling

**Impact:**
- All strings would receive feedback from only mode 5
- Other mode feedbacks would be ignored
- Breaks the modal synthesis model

**Recommended Fix:**
```cpp
mode_feedback[i] = mode_coefficients[
    numStrings * numModes +
    foldedIndexInQuarter[i] * numModes +
    modeNo  // ← Should use current mode index
];
```

**Status:** ⚠️ **Requires investigation and testing**

---

## 7. Mathematical Foundation

### Modal Synthesis Equations

**Mode Evolution (Damped Harmonic Oscillator):**

```
d²q_k/dt² + 2γ_k dq_k/dt + ω_k² q_k = F_k(t)

where:
  q_k     = modal amplitude (mode k)
  ω_k     = angular frequency
  γ_k     = damping coefficient
  F_k(t)  = forcing from strings (feedin)
```

**String Evolution (Wave Equation with Coupling):**

```
∂²u_s/∂t² = c_s² ∂²u_s/∂x² - 2β_s ∂u_s/∂t + F_modes(x_stem, t)

where:
  u_s(x,t)       = string displacement
  c_s            = wave speed
  β_s            = damping
  F_modes        = forcing from modes (feedback)
```

### Coupling Integrals

**Feedin (String → Mode):**

```
F_k(t) = ∑_s F[k,s] · f_s(t)

where:
  F[k,s] = ∫_bridge φ_k(x) · δ(x - x_bridge_s) dx
         = φ_k(x_bridge_s)  (mode shape at bridge point)
  f_s(t) = bridge force from string s
```

**Feedback (Mode → String):**

```
F_modes(x_stem_s, t) = ∑_k B[s,k] · q_k(t)

where:
  B[s,k] = φ_k(x_stem_s)  (mode shape at stem point)
  q_k(t) = modal amplitude
```

### Discretization in PianoidCore

**Timestep Structure:**
```
Synthesis Cycle (64 samples @ 44.1 kHz = 1.45 ms)
  ├─ Outer Loop: 64 audio samples
  └─ Inner Loop: soundStep iterations per sample
      ├─ String PDE step (finite difference)
      ├─ Accumulate bridge forces
      ├─ Apply feedin: f_s → F_k
      ├─ Mode ODE step (analytical integration)
      ├─ Apply feedback: q_k → u_s(x_stem)
      └─ Reset coupling matrices
```

**Key Insight:**
Coupling matrices are **intermediate buffers** that accumulate contributions from many threads, then get summed and applied. They are **not persistent state** - they're zeroed each inner step.

---

## 8. API Reference

### Python API

#### High-Level Update

```python
# pianoid.py:1679-1683
def send_deck_params_to_CUDA(self, feedin_coeff=1, feedback_coeff=1, feedbackOFF=False):
    """
    Send deck coupling parameters to GPU.

    Args:
        feedin_coeff: Global multiplier for feedin matrix (unused in current impl)
        feedback_coeff: Global multiplier for feedback matrix (unused in current impl)
        feedbackOFF: Flag to disable feedback (unused in current impl)
    """
    with self.cuda_lock:
        deck = self.sm.pack_deck()  # Returns flattened list
        self.pianoid.setNewDeckParameters(deck)
        time.sleep(0.01)  # Allow CUDA operations to complete
```

#### Packing Methods

```python
# pianoid.py:1305-1306
def pack_deck_for_cuda(self):
    """Convenience wrapper for StringMap.pack_deck()"""
    return self.sm.pack_deck()

# StringMap.py:426-433
def pack_deck(self, pack_for_cuda=True):
    """
    Pack feedin and feedback matrices.

    Args:
        pack_for_cuda: If True, return flattened list. If False, return tuple of arrays.

    Returns:
        If pack_for_cuda=True: List[float] (feedin + feedback concatenated)
        If pack_for_cuda=False: Tuple[np.ndarray, np.ndarray] (feedin, feedback)
    """
```

#### Chart Retrieval

```python
# chartFunctions.py:92
feedin, feedback = sm.pack_deck(pack_for_cuda=False)
# Returns separate numpy arrays for visualization
```

### C++ API

#### Update Method

```cpp
// Pianoid.cu:783-788
bool Pianoid::setNewDeckParameters(const std::vector<real>& deck_parameters) {
    if (memory_manager_.getActivePresetName().empty()) {
        printf("WARNING: No active preset, cannot update deck parameters\n");
        return false;
    }
    return memory_manager_.updateTunableParameter("dev_deck_parameters", deck_parameters);
}
```

#### Pointer Access

```cpp
// Pianoid.cuh:88
real* dev_deck_parameters;  // Managed by UnifiedGpuMemoryManager

// Access in kernel launch (Pianoid.cu:619)
kernelArgs.push_back(dev_deck_parameters);
```

### Initialization Flow

```
1. Python: Preset loading
   └─> sm = StringMap(model_params=mp, **preset)
       ├─> Pitch.update_deck() for each pitch
       └─> Default values: feedin=1 or 0, feedback=0 or 1

2. Python: Padding
   └─> np.pad(pitch.deck['feedin'], mode='edge')
   └─> np.pad(pitch.deck['feedback'], mode='edge')

3. Python: Packing
   └─> deck = sm.pack_deck()  # Flattened list [feedin + feedback]

4. Python → C++: Transfer
   └─> pianoid.devMemoryInit(..., deck, ...)
       └─> memory_manager_.loadPreset(...)
           └─> cudaMemcpy to dev_deck_parameters

5. C++: Registration
   └─> memory_manager_.registerTunableBuffer("dev_deck_parameters", ...)
       └─> dev_deck_parameters pointer set

6. CUDA: Kernel usage
   └─> addKernel<<<...>>>(... , dev_deck_parameters, ...)
```

---

## Appendix A: Constants Reference

```cpp
NUM_STRINGS = 256               // Total piano strings
NUM_MODES = 256                 // Soundboard modes
NUM_STRINGS_IN_ARRAY = 4        // Strings per CUDA block
NUM_FOLDS_IN_QUARTER = 16       // Loop unrolling factor
SEGMENT_FOR_SHUFFLE_SUMMATION = 64  // Temp buffer segmentation

DECK_SIZE = NUM_STRINGS * NUM_MODES * 2  // 131,072 reals
```

---

## Appendix B: Memory Map Summary

```
PresetParameters Structure (816,640 reals total):

Offset       Size        Contents
--------     --------    -----------------------------------------
0            4,096       String physical parameters
4,096        24,576      Hammer shapes
28,672       655,360     Excitation parameters (gauss)
684,032      1,280       Mode state parameters
685,312      65,536      Feedin matrix (deck part 1)  ← HERE
750,848      65,536      Feedback matrix (deck part 2) ← HERE
816,384      256         Volume coefficients
--------     --------    -----------------------------------------
             816,640     TOTAL
```

**Deck Parameters Block:**
```
Base: PresetParameterOffsets::DECK_OFFSET = 685,312 reals

[685,312 .. 750,847]  Feedin:   string[256] × mode[256]
[750,848 .. 816,383]  Feedback: string[256] × mode[256]
```

---

## Appendix C: Verification Checklist

- [x] Documentation matches implementation (PresetParameters.h)
- [x] Memory layout is string-major (correct for coalescing)
- [x] Matrices are separate and serve different functions
- [x] Packing code correctly concatenates feedin + feedback
- [x] Kernel correctly offsets to feedback matrix (numStrings * numModes)
- [x] Bounds checking present in kernel code
- [x] Double-buffering enabled via UnifiedGpuMemoryManager
- [ ] ⚠️ Feedback indexing bug (line 237) requires investigation
- [x] API correctly exposes both matrices

---

## Conclusion

The feedin and feedback matrices in PianoidCore are **properly separated** both conceptually and in implementation. The architecture correctly implements bidirectional modal-string coupling with:

1. **Clear physical separation:** Feedin (string→mode) and feedback (mode→string) serve distinct roles
2. **Optimized memory layout:** Row-major organization for coalesced GPU access
3. **Robust update mechanism:** Double-buffered via UnifiedGpuMemoryManager
4. **Accurate documentation:** Technical docs match implementation

**One potential bug identified:** The hardcoded `+5` in feedback coefficient loading ([MainKernel.cu:237](pianoid_cuda/MainKernel.cu#L237)) should be investigated and likely changed to `modeNo`.

**Overall Assessment:** ✅ **Documentation accurately reflects codebase state.** The matrices are well-designed and properly separated.

---

**Document Version:** 1.0
**Last Updated:** November 12, 2025
**Related Documents:**
- [PresetParameters.h](pianoid_cuda/PresetParameters.h)
- [COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md](pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md)
- [PARAMETER_SYSTEM_UNIFIED_DOCUMENTATION.md](PARAMETER_SYSTEM_UNIFIED_DOCUMENTATION.md)
