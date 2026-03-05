# PianoidBasic Parameter Management System - Comprehensive Documentation

**Document Version:** 1.0
**Date:** 2025-11-09
**Status:** ✅ Complete Technical Documentation
**Related Documents:**
- [PARAMETER_SYSTEM_UNIFIED_DOCUMENTATION.md](PARAMETER_SYSTEM_UNIFIED_DOCUMENTATION.md) - PianoidCore/CUDA parameter system
- [PARAMETER_SYSTEM_DOCUMENTATION_REVIEW.md](PARAMETER_SYSTEM_DOCUMENTATION_REVIEW.md) - System review
- [PIANOID_CORE_DOCUMENTATION.md](PIANOID_CORE_DOCUMENTATION.md) - Complete application documentation

---

## 🎯 Executive Summary

This document provides comprehensive documentation of parameter management on the **PianoidBasic side** of the Pianoid parameter system. While the unified documentation covers the PianoidCore/CUDA side, this document focuses on the Python-based parameter processing layer that sits between the REST API and CUDA kernels.

### Key Findings

**PianoidBasic implements a sophisticated hierarchical parameter management system that:**

1. **Transforms high-level musical concepts** (pitch, velocity, timbre) into low-level physics parameters
2. **Applies extensive mathematical processing** (finite differences, Gaussian curves, interpolation)
3. **Manages complex state** (circular buffers, feedback history, coefficient caching)
4. **Validates parameters** at multiple levels to prevent invalid physics configurations
5. **Packs data efficiently** for CUDA consumption with proper alignment and formatting

**Critical Architecture Pattern:**
```
REST API → PianoidBasic (Processing) → CUDA Packing → GPU Memory
         ↑                           ↑
    Host-side state              Data transformation
    Parameter storage            Mathematical modeling
```

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [Parameter Class Hierarchy](#2-parameter-class-hierarchy)
3. [Parameter Storage Architecture](#3-parameter-storage-architecture)
4. [Parameter Packing for CUDA](#4-parameter-packing-for-cuda)
5. [Parameter Update Methods](#5-parameter-update-methods)
6. [Parameter Processing and Transformations](#6-parameter-processing-and-transformations)
7. [Default Values and Initialization](#7-default-values-and-initialization)
8. [Validation Logic](#8-validation-logic)
9. [Caching and State Management](#9-caching-and-state-management)
10. [Data Flow: REST API → CUDA](#10-data-flow-rest-api--cuda)
11. [Mathematical Processing Deep Dive](#11-mathematical-processing-deep-dive)
12. [Integration with PianoidCore](#12-integration-with-pianoidcore)

---

## 1. System Architecture

### 1.1 Package Structure

**Physical Location:** `C:\Users\astri\PianoidInstall\PianoidBasic\Pianoid\`

**Python Import:** `from Pianoid import StringMap, ModeMap, Pitch, ...`

**⚠️ Important Naming Convention:**
- **Package directory:** `PianoidBasic/`
- **Import name:** `Pianoid`
- **Usage in PianoidCore:** `from Pianoid import StringMap`

### 1.2 Component Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                     PianoidBasic Package                          │
│                  (Parameter Processing Layer)                     │
└──────────────────────────────────────────────────────────────────┘

┌────────────────────── TOP LEVEL ─────────────────────────────────┐
│                                                                   │
│  StringMap (StringMap.py:23-647)                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ • Global parameter orchestrator                          │    │
│  │ • Manages pitches, strings, blocks                       │    │
│  │ • Packing coordinator (pack_parameters, pack_deck)       │    │
│  │ • String ID allocation and recycling                     │    │
│  │ • Chores mapping (pitch → string indices)                │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
│  ModeMap (Mode.py:196-351)                                       │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ • Acoustic mode container                                │    │
│  │ • Mode state packing (pack_modes)                        │    │
│  │ • Dummy mode padding for GPU alignment                   │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
                               │
                               ↓
┌────────────────── DOMAIN LAYER ──────────────────────────────────┐
│                                                                   │
│  Pitch (Pitch.py:13-573)                                         │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Container for all parameters of a musical pitch:         │    │
│  │ • StringGeometry - Spatial discretization               │    │
│  │ • PhysicalParameters - String physics                    │    │
│  │ • ExcitationParameters - Velocity curves (128×4×5)       │    │
│  │ • deck - Mode coupling {'feedin', 'feedback'}            │    │
│  │ • tension_offset, hammer_offset - Detuning              │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
│  Piano_mode (Mode.py:8-194)                                      │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Individual acoustic resonator mode:                      │    │
│  │ • Physical: frequency, decrement, mass, stiffness        │    │
│  │ • State: state, state_1 (current/previous displacement)  │    │
│  │ • Computed: omega, dec coefficients                      │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
                               │
                               ↓
┌────────────── PARAMETER COMPONENTS ──────────────────────────────┐
│                                                                   │
│  StringGeometry (StringState.py:31-87)                           │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ • length (meters), main (points), tail (points)          │    │
│  │ • Computed: dx, l_main, l_tail, p_full, bridge           │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
│  PhysicalParameters (PhysicalParameters.py:22-85)                │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ • tension, rho, r, jung, gamma, disp_decay               │    │
│  │ • PianoHammer - Strike profile                           │    │
│  │ • pack(offset) - Applies tension detuning                │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
│  PianoHammer (Hammer.py:8-231)                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ • shape, width, position, sharpness, offset              │    │
│  │ • calculate_hammer_shape() - Gaussian/circular profile   │    │
│  │ • Enforces minimum width (3 grid points)                 │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
│  ExcitationParameters (StringExcitation.py:224-582)              │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ • levels_matrix: (128 velocities, 4 params, 5 curves)    │    │
│  │ • Base levels: [0, 31, 63, 95, 127]                      │    │
│  │ • Interpolation: 5 base → 128 velocity levels            │    │
│  │ • Parameters: mu, sigma, volume, shift per curve         │    │
│  │ • recalculate_excitation_matrix() - Extrapolation        │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
│  ModelParameters (ModelParams.py:35-116)                         │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ • Global config: sr, array_size, num_strings, num_modes  │    │
│  │ • mode_iteration, string_iteration                       │    │
│  │ • Computed: dt(), excitation_length(), num_blocks()      │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
                               │
                               ↓
┌──────────────── RUNTIME STATE ───────────────────────────────────┐
│                                                                   │
│  StringState (StringState.py:89-294)                             │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ • array: (3, length) - Circular displacement buffer      │    │
│  │ • hammer_shape: (p_full,) - Force profile                │    │
│  │ • excitation: (excitation_length,) - Temporal force      │    │
│  │ • Coefficients: c0, c1, c2, cb, cf, c2dec                │    │
│  │ • State: dec_open (damper), exct_cycle_ind (timing)      │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
│  StringBlock (StringBlock.py:4-170)                              │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ • Groups 1-4 strings into contiguous memory               │    │
│  │ • state: (2, max_num_points) - Packed block state        │    │
│  │ • pack_arrays(), unpack_arrays() - Bidirectional sync    │    │
│  │ • get_hammer() - Sum hammer shapes                       │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 1.3 Data Flow Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ STAGE 1: REST API REQUEST                                      │
│ POST /set_parameter/string/60 { "tension": 350 }              │
└──────────────────┬─────────────────────────────────────────────┘
                   │
                   ↓
┌────────────────────────────────────────────────────────────────┐
│ STAGE 2: PIANOIDCORE MIDDLEWARE (pianoid.py)                  │
│ update_parameter(param='string', values={'60': {...}})        │
│ → Dispatches to update handlers                               │
└──────────────────┬─────────────────────────────────────────────┘
                   │
                   ↓
┌────────────────────────────────────────────────────────────────┐
│ STAGE 3: PIANOIDBASIC PARAMETER UPDATE                        │
│ pitch.physics.set_params(tension=350)                         │
│ → Updates Python-side attribute storage                       │
└──────────────────┬─────────────────────────────────────────────┘
                   │
                   ↓
┌────────────────────────────────────────────────────────────────┐
│ STAGE 4: PARAMETER PACKING (MATHEMATICAL PROCESSING)          │
│ sm.pack_parameters()                                           │
│ ├─ pitch.physics.pack(offset=tension_offset)                  │
│ │  └─ Applies detuning: tension *= (1 + offset)               │
│ ├─ pitch.get_coefficients()                                   │
│ │  └─ Computes finite difference coefficients                 │
│ ├─ excitation.pack_gauss_params()                             │
│ │  └─ Interpolates 5 base levels → 128 velocity curves        │
│ └─ hammer.calculate_hammer_shape()                            │
│    └─ Circular profile with sharpness parameter               │
└──────────────────┬─────────────────────────────────────────────┘
                   │
                   ↓
┌────────────────────────────────────────────────────────────────┐
│ STAGE 5: CUDA DATA TRANSFER                                   │
│ pianoidCuda.updateMultiStringParameter_NEW()                  │
│ → Async double-buffered upload via UnifiedGpuMemoryManager    │
└──────────────────┬─────────────────────────────────────────────┘
                   │
                   ↓
┌────────────────────────────────────────────────────────────────┐
│ STAGE 6: GPU KERNEL EXECUTION                                 │
│ parameterKernel, stringMapKernel, MainKernel                  │
│ → Physics simulation with updated parameters                  │
└────────────────────────────────────────────────────────────────┘
```

---

## 2. Parameter Class Hierarchy

### 2.1 ModelParameters - Global Configuration

**File:** `C:\Users\astri\PianoidInstall\PianoidBasic\Pianoid\ModelParams.py`
**Lines:** 35-116

**Purpose:** System-wide simulation configuration

**Key Attributes:**

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `mode_iteration` | int | 48 | Iterations per mode calculation cycle |
| `string_iteration` | int | 12 | String solver iterations per sample |
| `sr` | int | 48000 | Sample rate in Hz |
| `array_size` | int | 384 | Size of string blocks in memory |
| `num_strings_in_array` | int | 2 | Strings per block (1-4 supported) |
| `excitation_factor` | int | 8 | Excitation curve duration multiplier |
| `num_modes` | int | Variable | Number of acoustic modes |
| `num_modes_for_model` | int | Computed | Rounded for GPU alignment |
| `num_strings` | int | Variable | Total number of strings |
| `num_channels` | int | Variable | Audio output channels |
| `buffer_size` | int | 2 | Audio buffer size |

**Computed Properties:**

```python
def dt():
    """Time step in seconds"""
    return 1 / (sr * string_iteration)  # 1.736 μs @ 48kHz

def excitation_length():
    """Excitation curve length in samples"""
    return string_iteration * mode_iteration * excitation_factor  # 4608 samples

def num_blocks():
    """Number of string blocks"""
    return num_strings // num_strings_in_array
```

**GPU Alignment Validation (Lines 86-92):**

```python
def set_num_modes(self, num_modes, num_modes_for_model=None):
    if num_modes_for_model % self.num_blocks() != 0:
        raise ValueError(f"Number of modes for the model should be divisible by number of arrays")
    # Ensures GPU thread block alignment
```

**CUDA Packing (Lines 98-112):**

```python
def pack_as_dict_for_cuda():
    return {
        "array_size": int(array_size),
        "num_strings": int(num_strings),
        "num_modes": int(num_modes_for_model),  # GPU-aligned value
        "num_channels": int(num_channels),
        "mode_iteration": int(mode_iteration),
        "sample_rate": int(sr),
        "sound_step": int(string_iteration),
        "num_strings_in_array": int(num_strings_in_array),
        "buffer_size": int(buffer_size),
        "listen_to_modes": listen_to_modes,
        "mode_channel_index": mode_channel_index
    }
```

---

### 2.2 StringGeometry - Spatial Discretization

**File:** `StringState.py`
**Lines:** 31-87

**Purpose:** Defines physical string dimensions and finite difference grid

**Parameters:**

| Parameter | Type | Unit | Description |
|-----------|------|------|-------------|
| `length` | float | meters | Physical length of main vibrating section |
| `main` | int | points | Number of grid points in main section |
| `tail` | int | points | Damping region length |

**Computed Properties:**

```python
def dx():
    """Spatial discretization step"""
    return length / p_main()  # meters per grid point

def l_main():
    """Main section length in meters"""
    return main * dx()

def l_tail():
    """Tail section length in meters"""
    return tail * dx()

def p_full():
    """Total grid points including stem"""
    return p_main() + tail + STEM_LENGTH  # STEM_LENGTH = 2

def bridge(i):
    """Bridge point index"""
    return p_main() + i

def bridge_range():
    """Bridge coupling region"""
    return [bridge(0), bridge(1) + 1]
```

**Usage Example:**

```python
geometry = StringGeometry(length=1.2, main=100, tail=10)
# Results:
# dx = 1.2 / 100 = 0.012 m (12 mm per point)
# p_full = 100 + 10 + 2 = 112 points
# l_tail = 10 * 0.012 = 0.12 m
```

---

### 2.3 PhysicalParameters - String Physics

**File:** `PhysicalParameters.py`
**Lines:** 22-85

**Default Values (Lines 8-17):**

```python
DEFAULTS = {
    "tension": 300,           # Newtons (typical: 50-2000 N)
    "rho": 0.007,             # kg/m (steel wire: 0.004-0.01)
    "r": 0.0005,              # meters (0.5 mm radius)
    "jung": 19000,            # Pa (Young's modulus)
    "gamma": 0.1,             # Damping coefficient
    "disp_decay": 0,          # Displacement decay
    "volume_coefficient": 1,
    "damper_string": 0.5,
    "damper_tail": 127        # Fully damped
}
```

**Key Methods:**

**`pack(offset)` (Lines 57-68):**
```python
def pack(offset):
    """Pack parameters for CUDA with tension detuning"""
    param_dict = {
        'length': geometry.length,
        'tail': geometry.tail,
        'r': r,
        'rho': rho,
        'jung': jung,
        'tension': tension * (1 + offset),  # ⚡ DETUNING APPLIED HERE
        'gamma': gamma,
        'dx': geometry.dx(),
        'volume_coefficient': volume_coefficient,
        'disp_decay': disp_decay,
        'damper_string': damper_string,
        'damper_tail': damper_tail
    }
    # Merge with hammer parameters
    param_dict.update(hammer.pack(offset))
    return param_dict
```

**Critical:** Tension offset enables detuning for chorus effects (multiple strings per pitch).

---

### 2.4 PianoHammer - Strike Profile

**File:** `Hammer.py`
**Lines:** 8-231

**Parameters:**

| Parameter | Type | Unit | Description |
|-----------|------|------|-------------|
| `shape` | str | - | Shape function ('circular') |
| `width` | float | meters | Contact width |
| `position` | float | 0-1 or meters | Strike position |
| `sharpness` | float | 0-1 | Hardness (0=soft, 1=hard) |
| `offset` | float | - | Position offset for detuning |
| `dummy` | bool | - | Sound channel flag (no hammer) |

**Shape Calculation (Lines 126-155):**

```python
def calculate_hammer_shape(offset):
    """Generate hammer force profile"""
    # Enforce minimum width (3 grid points)
    width = max(self.width, geometry.dx() * 3)

    # Apply offset for detuning
    center = position * (1 + offset)

    # Circular shape function
    def circular(x, center, width, sharpness):
        halfW = width / 2
        xInRange = (x >= center - halfW) and (x <= center + halfW)

        # Compute radius of curvature
        mu = halfW * (1 - sharpness)
        R = sqrt(halfW² + mu²)
        m = R - sqrt(R² - halfW²)  # Zero offset at edges

        if xInRange:
            return sqrt(R² - (center - x)²) - R + m
        return 0

    # Apply to grid
    hammer_shape = np.zeros(geometry.p_full())
    for xi in range(geometry.p_full()):
        x_position = xi * geometry.dx()
        hammer_shape[xi] = circular(x_position, center, width, sharpness)

    return hammer_shape
```

**Sharpness Parameter Effect:**
- `sharpness = 0`: Triangular profile (soft felt hammer)
- `sharpness = 0.5`: Semicircular profile
- `sharpness = 1`: Rectangular profile (hard hammer)

---

### 2.5 ExcitationParameters - Velocity Curves

**File:** `StringExcitation.py`
**Lines:** 224-582

**Data Structure:**

```python
levels_matrix: np.ndarray  # Shape: (128, 4, 5)
# Dimension 0: Velocity level (0-127 MIDI)
# Dimension 1: Parameter index
#   0: mu (peak time in ms)
#   1: sigma (width)
#   2: volume (amplitude)
#   3: shift (vertical offset)
# Dimension 2: Gauss curve index (5 curves per level)
```

**Base Level System (Lines 14, 20-24):**

```python
LEVEL_INDICES = [0, 31, 63, 95, 127]  # 5 base velocity levels

DEFAULT_MU = [1, 2, 2, 2.5, 6]        # Peak time (ms)
DEFAULT_SIGMA = [0.1, 0.4, 0.6, 1, 0.2]   # Width
DEFAULT_VOLUME = [10, 3, 2, 1, 5]     # Amplitude
DEFAULT_SHIFT = [0.1, 0.2, 0.3, 0.2, 0]  # Offset
```

**Key Methods:**

**`recalculate_excitation_matrix()` (Lines 401-412):**
```python
def recalculate_excitation_matrix(apply_coefficients=False):
    """Interpolate 5 base levels to 128 velocity levels"""
    # Extract base levels
    base_level_matrix = levels_matrix[LEVEL_INDICES, :, :]  # (5, 4, 5)

    # Apply volume coefficients if requested
    if apply_coefficients:
        base_level_matrix[:, 2, :] *= volume_coefficients[:, np.newaxis]

    # Linear interpolation to 128 levels
    result = extrapolate(base_level_matrix, newdim=128,
                         indices=LEVEL_INDICES[1:-1])

    levels_matrix[:] = result
```

**`pack_gauss_params()` (Lines 322-334):**
```python
def pack_gauss_params(from_matrix=True, ravel=True):
    """Pack for CUDA transfer"""
    if from_matrix:
        # Recalculate with volume coefficients
        recalculate_excitation_matrix(apply_coefficients=True)

    if ravel:
        # Flatten to 1D: (128, 4, 5) → (2560,)
        return levels_matrix.ravel().tolist()

    return levels_matrix.tolist()
```

**Gaussian Curve Generation (Lines 99-132):**

```python
for i in range(length):
    t = i * excitation_factor / length  # Time in ms

    # Gaussian formula
    s2 = ((t - mu) / sigma) ** 2 * -0.5
    y = volume * exp(s2) - volume * shift

    result[i] = max(y, 0)  # Clip negative values
```

**Total excitation:** Sum of 5 Gaussian curves per velocity level.

---

### 2.6 Piano_mode - Acoustic Resonator

**File:** `Mode.py`
**Lines:** 8-194

**Parameters:**

| Parameter | Type | Unit | Description |
|-----------|------|------|-------------|
| `frequency` | float | Hz | Resonant frequency |
| `decrement` | float | - | Decay rate |
| `mass` | float | kg | Modal mass |
| `stiffness` | float | N/m | Modal stiffness |
| `damping` | float | N·s/m | Modal damping |
| `state` | float | m | Current displacement |
| `state_1` | float | m | Previous displacement |

**Coefficient Computation (Lines 45-65):**

```python
def fit_params():
    """Compute simulation coefficients from physical parameters"""
    dt = 1 / sample_rate

    # Option 1: Given frequency, compute mass
    if mass is None or isnan(mass):
        stiffness = 0.1
        mass = stiffness / (2π * frequency)²

    # Option 2: Given mass/stiffness, compute frequency
    else:
        frequency = sqrt(stiffness / mass) / (2π)

    # Compute decrement from damping
    if damping and not isnan(damping):
        dump_ratio = 0.5 * damping / sqrt(mass * stiffness)
        decrement = 2π * dump_ratio / sqrt(1 - dump_ratio²)

    # Simulation coefficients
    omega = dt² * frequency² * 4π²  # K_OMEGA = 4π²
    dec = dt * decrement * frequency
```

**State Iteration (Lines 148-160):**

```python
def iterate(force):
    """Single time step of mode oscillator"""
    result = ((2*state - state_1) +   # Verlet integration
              state_1 * dec -         # Previous damping
              state * omega +         # Restoring force
              force) * (1 - dec)      # Current damping

    # Update state
    state_1 = state
    state = result

    return result
```

**CUDA Packing (Lines 78-91):**

```python
def get_state(keep_state):
    """Pack mode state for GPU"""
    if keep_state:
        return (state, state_1, dec, omega, mass)
    else:
        return (0, 0, dec, omega, mass)  # Reset state
```

---

### 2.7 Pitch - Note Container

**File:** `Pitch.py`
**Lines:** 13-573

**Attributes:**

```python
class Pitch:
    pitch: int                      # MIDI number (0-139)
    outerSound: bool                # True if pitch ≥ 128 (sound channel)
    geometry: StringGeometry        # Spatial grid
    stringIDs: list[int]            # String IDs in this pitch
    num_strings: int                # Number of strings (chorus size)
    physics: PhysicalParameters     # Physical properties
    excitation: ExcitationParameters  # Velocity curves
    deck: dict                      # Mode coupling
        'feedin': np.ndarray        # String → mode (num_modes,)
        'feedback': np.ndarray      # Mode → string (num_modes,)
    tension_offset: float           # Detuning between strings
    hammer_offset: float            # Hammer position offset
    deck_coeffs: dict               # Coefficient memory
    feedback_record: list           # Feedback history
```

**Deck Initialization (Lines 172-178):**

```python
if 'defaults' in kwargs and kwargs['defaults']:
    # Regular pitches: Strings excite modes, modes don't affect strings
    if not outerSound:
        deck['feedin'] = np.ones(num_modes)
        deck['feedback'] = np.zeros(num_modes)

    # Sound channels: Collect from modes, don't excite modes
    else:
        deck['feedin'] = np.zeros(num_modes)
        deck['feedback'] = np.ones(num_modes)
```

**Key Methods:**

**`pack_params_for_string(stringId)` (Lines 92-108):**
```python
def pack_params_for_string(stringId):
    """Pack parameters with per-string detuning"""
    # Calculate tension offset based on string position in chorus
    tension_ofs = stringIDs.index(stringId) * tension_offset
    # First string: offset = 0
    # Second string: offset = tension_offset
    # Third string: offset = 2 * tension_offset

    # Pack with offset applied
    packed_physics = physics.pack(offset=tension_ofs)

    return packed_physics
```

**`get_coefficients(damper)` (Lines 296-325):**
```python
def get_coefficients(damper=1):
    """Calculate finite difference coefficients for wave equation"""
    # Extract parameters
    dx = physics.geometry.dx()
    dt = 1 / (mp.sample_rate() * mp.string_iteration)
    tension, r, rho, jung, gamma = ...

    # Wave speed
    u² = tension / rho
    coeff_tension = u² * dt² / dx²

    # Bending stiffness
    coeff_G = π * r⁴ / (4 * rho)
    coeff_bending = coeff_G * jung * dt² / dx⁴

    # Damping
    dec_cur = gamma * dt * damper
    dec_inv = 1 / (1 + dec_cur)

    # 5-point stencil coefficients
    c0 = (2 + 12*coeff_bending - 2*coeff_tension) * dec_inv
    c1 = (coeff_tension - 8*coeff_bending) * dec_inv
    c2 = 2 * coeff_bending * dec_inv
    ct = (dec_cur - 1) * dec_inv
    cf = dt² * dec_inv
    c2dec = coeff_2dec / (2 * dt * dx²)

    return c0, c1, c2, c1, c2, ct, cf, c2dec
```

---

### 2.8 StringMap - Top-Level Orchestrator

**File:** `StringMap.py`
**Lines:** 23-647

**Purpose:** Global parameter manager, coordinates entire system

**Attributes:**

```python
class StringMap:
    mp: ModelParameters              # Global config
    blocks: list[StringBlock]        # Memory blocks
    pitches: dict[int, Pitch]        # All pitch objects
    strings: dict[int, StringState]  # All string objects
    keyPitches: list[int]            # Regular pitches
    soundPitches: list[int]          # Output channels (≥128)
    chores: np.ndarray               # Shape (140, 3) - pitch → string mapping
    string_index: list[int]          # Flattened string IDs
    pitch_index: list[int]           # Pitch for each string
    nextID: int                      # String ID allocator
    released_IDs: list[int]          # Recycled IDs
```

**String ID Management (Lines 130-140):**

```python
def _get_next_stringID():
    """Allocate or recycle string ID"""
    if len(released_IDs) > 0:
        ID = released_IDs.pop()  # Recycle
    else:
        ID = nextID
        nextID += 1
    return ID
```

**Chores Mapping (Lines 301-317):**

```python
def generate_chores():
    """Create pitch → string index mapping"""
    # Flatten all string IDs
    string_index = list(np.array([block.get_string_IDs()
                                   for block in blocks]).ravel())

    # Corresponding pitches
    pitch_index = [strings[stringID].pitch for stringID in string_index]

    # Build chores array
    chores = -np.ones((140, 3))  # Max 3 strings per pitch
    for i, pitchID in enumerate(range(140)):
        if pitchID in pitches:
            pitch = pitches[pitchID]
            chore = [string_index.index(stringID)
                     for stringID in pitch.get_strings()]
            chores[i][:len(chore)] = chore

    return chores, string_index, pitch_index
```

**Example chores array:**
```python
chores[60] = [10, 11, 12]  # Pitch 60 uses strings 10, 11, 12
chores[61] = [13, 14, -1]  # Pitch 61 uses strings 13, 14 (only 2)
```

---

## 3. Parameter Storage Architecture

### 3.1 In-Memory Storage Hierarchy

```
StringMap (Global Orchestrator)
├── ModelParameters
│   └── Global simulation config
│
├── pitches: dict[int, Pitch]
│   └── Pitch
│       ├── StringGeometry
│       │   └── length, main, tail, dx, p_full
│       ├── PhysicalParameters
│       │   ├── tension, rho, r, jung, gamma, disp_decay
│       │   └── PianoHammer
│       │       └── shape, width, position, sharpness
│       ├── ExcitationParameters
│       │   └── levels_matrix: (128, 4, 5)
│       ├── deck: dict
│       │   ├── 'feedin': (num_modes,)
│       │   └── 'feedback': (num_modes,)
│       └── stringIDs: list[int]
│
├── strings: dict[int, StringState]
│   └── StringState
│       ├── array: (3, length) - Circular buffer
│       ├── hammer_shape: (p_full,)
│       ├── excitation: (excitation_length,)
│       └── Coefficients: c0, c1, c2, cb, cf, c2dec
│
├── blocks: list[StringBlock]
│   └── StringBlock
│       ├── state: (2, max_num_points)
│       └── strings: dict[int, StringState]
│
├── chores: (140, 3)
│   └── Pitch → string index mapping
│
└── string_index: list[int]
    └── Flattened string IDs

ModeMap (Acoustic Modes)
└── modes: dict[int, Piano_mode]
    └── Piano_mode
        ├── frequency, decrement
        ├── state, state_1
        └── omega, dec (computed)
```

### 3.2 Memory Layout Example

**For a 3-string chorus (pitch 60):**

```
StringMap.strings:
  10: StringState(pitch=60, array=(3, 112), hammer_shape=(112,))
  11: StringState(pitch=60, array=(3, 112), hammer_shape=(112,))
  12: StringState(pitch=60, array=(3, 112), hammer_shape=(112,))

StringMap.pitches:
  60: Pitch(
    stringIDs=[10, 11, 12],
    physics=PhysicalParameters(tension=300),
    excitation=ExcitationParameters(levels_matrix=(128,4,5)),
    deck={'feedin': (64,), 'feedback': (64,)},
    tension_offset=0.002  # 0.2% detuning per string
  )

StringMap.chores:
  [60] = [10, 11, 12]  # Indices in string_index

StringMap.string_index:
  [... 10, 11, 12, ...]  # Positions of strings in global array
```

**When pitch 60 is played with velocity 80:**
1. Lookup `chores[60] = [10, 11, 12]`
2. For each string ID, calculate excitation:
   - `excitation_curve = pitch.excitation.levels_matrix[80, :, :]`
   - Apply to `strings[10].excitation`, `strings[11].excitation`, `strings[12].excitation`
3. Apply tension detuning:
   - String 10: `tension * (1 + 0 * 0.002) = 300 N`
   - String 11: `tension * (1 + 1 * 0.002) = 300.6 N`
   - String 12: `tension * (1 + 2 * 0.002) = 301.2 N`

---

### 3.3 Preset File Storage (JSON)

**File Structure:**

```json
{
  "pitches": {
    "60": {
      "physics": {
        "tension": 300.0,
        "rho": 0.007,
        "r": 0.0005,
        "jung": 19000.0,
        "gamma": 0.1,
        "disp_decay": 0.001,
        "volume_coefficient": 1.0,
        "hammer": {
          "hammer_shape": "circular",
          "hammer_width": 0.005,
          "hammer_position": 0.11,
          "hammer_sharpness": 0.5
        }
      },
      "excitation": {
        "data": "base64_encoded_array",
        "shape": [128, 4, 5],
        "type": "float64"
      },
      "deck": {
        "data": "base64_encoded_array",
        "shape": [2, 64],
        "type": "float64"
      },
      "geometry": {
        "tail": 10,
        "main": 100,
        "length": 1.2
      },
      "strings": [10, 11, 12],
      "tension_offset": 0.002,
      "hammer_offset": 0
    }
  },
  "blocks": [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    ...
  ],
  "model_parameters": {
    "mode_iteration": 48,
    "string_iteration": 12,
    "array_size": 384,
    "num_strings_in_array": 2,
    "num_modes": 64,
    "num_strings": 256
  }
}
```

**Encoding (bytestream_encoding.py:7-12):**

```python
def encode_for_json(data: np.ndarray):
    """Encode numpy array for JSON storage"""
    return {
        'data': base64.b64encode(data.tobytes()).decode('utf-8'),
        'shape': list(data.shape),
        'type': str(data.dtype)
    }
```

---

## 4. Parameter Packing for CUDA

### 4.1 pack_parameters() - Master Packing Function

**File:** `StringMap.py`
**Lines:** 442-491

**Purpose:** Serialize ALL parameters for CUDA initialization

**Returns:** Tuple of 10 elements

```python
def pack_parameters():
    """Pack complete parameter set for CUDA"""
    return (
        packed_chores,      # 1. Pitch → string mapping
        a,                  # 2. Block state 0
        b,                  # 3. Block state 1
        packed_excitations, # 4. Gauss curves
        packed_physics,     # 5. String parameters
        packed_hammer,      # 6. Hammer shapes
        packed_volume,      # 7. Volume coefficients
        packed_eci,         # 8. Excitation cycle indices
        packed_do,          # 9. Damper states
        string_map          # 10. String index mapping
    )
```

**Detailed Breakdown:**

#### 4.1.1 Element 1: packed_chores

**Purpose:** Pitch → string index mapping
**Format:** Flattened list of integers
**Length:** 420 (140 pitches × 3 max strings)

```python
packed_chores = chores.ravel().tolist()
# chores shape: (140, 3)
# Example: [pitch0_s0, pitch0_s1, pitch0_s2, pitch1_s0, ...]
```

#### 4.1.2 Elements 2-3: a, b (Block States)

**Purpose:** Initial displacement arrays
**Format:** Flattened float arrays
**Length:** `num_blocks * array_size` each

```python
a, b = pack_blocks()
# pack_blocks() returns (Lines 374-376):
block_states = np.stack([block.get_state() for block in blocks])
# Shape: (num_blocks, 2, array_size)
block_states = block_states.transpose(1, 0, 2)
# Shape: (2, num_blocks, array_size)
block_states = block_states.reshape(2, num_blocks * array_size)
return block_states[0].tolist(), block_states[1].tolist()
```

#### 4.1.3 Element 4: packed_excitations

**Purpose:** Velocity-dependent excitation curves
**Format:** Nested list of floats
**Length:** `num_strings * 2560` (2560 = 128 velocities × 4 params × 5 curves)

```python
packed_excitations = unfold_list([pitch.pack_excitation()
                                   for pitch in pitch_index])
# Each pitch.pack_excitation() returns:
levels_matrix.ravel().tolist()  # Shape (128, 4, 5) → 2560 floats
```

**Per-string structure:**
```
[mu0_v0, mu1_v0, mu2_v0, mu3_v0, mu4_v0,     # Velocity 0
 sigma0_v0, sigma1_v0, ...,
 volume0_v0, volume1_v0, ...,
 shift0_v0, shift1_v0, ...,
 mu0_v1, mu1_v1, ...,                        # Velocity 1
 ...
 shift0_v127, shift1_v127, ...]              # Velocity 127
```

#### 4.1.4 Element 5: packed_physics

**Purpose:** Physical parameters for each string
**Format:** Flattened list
**Length:** `num_strings * STRING_PARAMS_NO` (16 parameters padded)

```python
packed_physics = []
for stringID in string_index:
    pitch = pitches[strings[stringID].pitch]
    params = pitch.pack_params_for_string(stringID)

    # Parameter order (Lines 447-461):
    ordered_params = [
        params['length'],     # 0
        params['tail'],       # 1
        params['r'],          # 2
        params['rho'],        # 3
        params['jung'],       # 4
        params['tension'],    # 5 ⚡ WITH DETUNING APPLIED
        params['gamma'],      # 6
        params['dx'],         # 7
        params['volume_coefficient'],  # 8
        params['position_in_array'],   # 9
        params['hammer_position'],     # 10
        params['outer_sound'],         # 11
        params['disp_decay'],          # 12
        params['damper_string'],       # 13
        params['damper_tail']          # 14
    ]

    # Pad to 16
    while len(ordered_params) < 16:
        ordered_params.append(0)

    packed_physics.extend(ordered_params)
```

**Critical:** Tension detuning is applied during packing:
```python
# In PhysicalParameters.pack(offset):
param_dict['tension'] = tension * (1 + offset)
```

#### 4.1.5 Element 6: packed_hammer

**Purpose:** Hammer force profiles
**Format:** Flattened array
**Length:** `num_blocks * array_size`

```python
packed_hammer = pack_hammers().ravel().tolist()

# pack_hammers() (Lines 396-401):
block_hammers = np.stack([block.get_hammer() for block in blocks])
# Each block.get_hammer() sums hammer shapes of all strings in block
```

#### 4.1.6 Element 7: packed_volume

**Purpose:** Per-string volume coefficients
**Format:** List of floats
**Length:** `num_strings`

```python
packed_volume = [pitch.physics.volume_coefficient
                 for pitch in pitch_index]
```

#### 4.1.7 Element 8: packed_eci (Excitation Cycle Index)

**Purpose:** Excitation timing control
**Format:** List of integers
**Length:** `num_strings`

```python
packed_eci = [string.exct_cycle_ind for string in string_index]
# exct_cycle_ind = 0 initially, updated during note triggering
```

#### 4.1.8 Element 9: packed_do (Damper Open)

**Purpose:** Damper state (sustain pedal effect)
**Format:** List of integers
**Length:** `num_strings`

```python
packed_do = [string.dec_open for string in string_index]
# dec_open = 127 (closed/damped) or 0 (open/sustained)
```

#### 4.1.9 Element 10: string_map

**Purpose:** Identity mapping (legacy)
**Format:** List of integers
**Length:** `num_strings`

```python
string_map = list(range(len(string_index)))
# [0, 1, 2, 3, ..., num_strings-1]
```

---

### 4.2 pack_deck() - Mode Coupling Coefficients

**File:** `StringMap.py`
**Lines:** 430-437

**Purpose:** Pack feedin/feedback matrices for mode-string coupling

**Returns:** Single flattened list

```python
def pack_deck():
    """Pack mode coupling coefficients"""
    # Pack feedin (string → mode)
    feedin = np.stack([pack_pitch_feedin(pitchID)
                       for pitchID in pitch_index])
    # Shape: (num_strings, num_strings)

    # Pack feedback (mode → string)
    feedback = np.stack([ext_to_the_right(pitch.deck['feedback'],
                                           mp.num_modes_for_model)
                         for pitchID in pitch_index])
    # Shape: (num_strings, num_modes_for_model)

    # Concatenate and flatten
    return feedin.ravel().tolist() + feedback.ravel().tolist()
```

**Feedin Processing (Lines 416-428):**

```python
def pack_pitch_feedin(pitchID):
    """Pack feedin with sound channel coefficients"""
    pitch = pitches[pitchID]

    # Extend to full size
    feedin = ext_to_the_right(pitch.deck['feedin'], mp.num_strings)
    # pitch.deck['feedin'] is (num_modes,), extend to (num_strings,)

    # Insert sound channel coefficients
    if mp.listen_to_modes:
        channel_indices = soundChannelModes.get_index()
        # [mode_channel_index, ..., mode_channel_index + num_channels - 1]
        feedin[channel_indices] = soundChannelModes.get_coeff(pitchID)

    return feedin
```

**Effect:** Modes can excite both other strings AND sound output channels.

---

### 4.3 pack_modes() - Mode State Packing

**File:** `Mode.py`
**Lines:** 264-292

**Purpose:** Pack all mode states for CUDA

**Returns:** Single flattened list

```python
def pack_modes(keep_state=True, updated_modes=None, fit=True):
    """Pack mode parameters and state"""
    mode_state = []

    # Collect mode states
    for i, mode in modes.items():
        if fit:
            mode.fit_params()  # Recompute omega, dec

        ms = mode.get_state(keep_state)
        # Returns (state, state_1, dec, omega, mass)
        mode_state.append(ms)

    # Append dummy modes for GPU alignment
    for i in range(modes_to_append()):
        dummy_mode = Piano_mode(-1, mp, dummy=True)
        mode_state.append(dummy_mode.get_state(True))

    # Reshape into 5 arrays
    result = (
        [a for a,b,c,d,m in mode_state] +     # states
        [b for a,b,c,d,m in mode_state] +     # state_1s
        [c for a,b,c,d,m in mode_state] +     # decs
        [d for a,b,c,d,m in mode_state] +     # omegas
        [m for a,b,c,d,m in mode_state]       # masses
    )

    return result
```

**Structure:**
```
[state_0, state_1, ..., state_N,
 state_1_0, state_1_1, ..., state_1_N,
 dec_0, dec_1, ..., dec_N,
 omega_0, omega_1, ..., omega_N,
 mass_0, mass_1, ..., mass_N]

Length: 5 * num_modes_for_model
```

**Dummy Mode Padding:**
```python
def modes_to_append():
    """Compute padding needed for GPU alignment"""
    return mp.num_modes_for_model - len(modes)
```

---

## 5. Parameter Update Methods

### 5.1 update_hammer_shape() - StringMap

**File:** `StringMap.py`
**Lines:** 384-395

**Signature:**
```python
def update_hammer_shape(pitchID, **params):
    """Update hammer parameters and regenerate shapes"""
```

**Process:**

1. Get pitch object
2. Update hammer parameters in physics
3. Recalculate hammer shapes
4. Distribute to all strings in pitch

**Implementation:**

```python
pitch = pitches[pitchID]

# Update parameters
pitch.physics.set_hammer(**params)
# Accepted params: position, width, sharpness, radius

# Regenerate shapes with offsets
hammer_shapes = pitch.get_hammer_shapes()
# Returns dict: {stringID: hammer_shape_array}

# Distribute to strings
for stringID in pitch.stringIDs:
    strings[stringID].hammer_shape = hammer_shapes[stringID]
```

**Parameters Accepted:**

| Parameter | Type | Effect |
|-----------|------|--------|
| `position` | float (0-1) | Strike position along string |
| `width` | float (meters) | Contact width |
| `sharpness` | float (0-1) | Hardness (0=soft, 1=hard) |
| `radius` | float (meters) | Alternative to width |

**Example:**

```python
sm.update_hammer_shape(60, position=0.125, sharpness=0.3)
# Updates pitch 60 hammer to strike at 1/8 length with soft felt
```

---

### 5.2 update_deck() - StringMap

**File:** `StringMap.py`
**Lines:** 320-342

**Signature:**
```python
def update_deck(matrix, pitches, values, **kwargs):
    """Update mode coupling coefficients"""
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `matrix` | str | 'feedin' or 'feedback' |
| `pitches` | list[int] | Pitch IDs to update |
| `values` | dict | `{pitchID: new_array}` |
| `sound_coefficients` | np.ndarray (optional) | Sound channel feedbacks |

**Process:**

```python
# Handle sound channels
if 'sound_coefficients' in kwargs:
    for pitchID in soundPitches:
        pitch = pitches[pitchID]
        pitch.update_deck(deck_params={
            'feedin': np.zeros(mp.num_modes),
            'feedback': kwargs['sound_coefficients']
        })

# Update regular pitches
for pitchID in pitches:
    new_values = values[str(pitchID)]

    # Validate dimensions
    if len(new_values) != mp.num_modes:
        raise ValueError(...)

    # Update pitch
    if isinstance(new_values, dict):
        pitch.update_deck(values={matrix: new_values})
    else:
        pitch.update_deck(deck_params={matrix: new_values})
```

**Example:**

```python
# Set pitch 60 to couple only with modes 0-15
feedin = np.zeros(64)
feedin[0:16] = 1.0
sm.update_deck('feedin', [60], {'60': feedin})
```

---

### 5.3 update_deck() - Pitch

**File:** `Pitch.py`
**Lines:** 158-189

**Signature:**
```python
def update_deck(deck_params={}, deck_multipliers={},
                deck_flat_values={}, values={}):
    """Flexible deck coefficient updates"""
```

**Four Update Modes:**

#### Mode 1: Replace Entire Array

```python
update_deck(deck_params={'feedin': new_array})
# deck['feedin'] = new_array
```

#### Mode 2: Multiply by Coefficient

```python
update_deck(deck_multipliers={'feedback': 0.5})
# deck['feedback'] *= 0.5
```

#### Mode 3: Set All to Value

```python
update_deck(deck_flat_values={'feedin': 1.0})
# deck['feedin'] = np.ones(num_modes)
```

#### Mode 4: Update Single Mode

```python
update_deck(values={'feedback': {'modeNo': 5, 'value': 0.8}})
# deck['feedback'][5] = 0.8
```

---

### 5.4 update_deck_coefficients() - Pitch

**File:** `Pitch.py`
**Lines:** 191-217

**Signature:**
```python
def update_deck_coefficients(modeID='all', **kwargs):
    """Apply multiplicative coefficients with memory"""
```

**Purpose:** Remember coefficient history for relative adjustments

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `modeID` | int or 'all' | Target mode (unused currently) |
| `feedin` | float | New feedin value |
| `feedback` | float | New feedback value |
| `feedin_coeff` | float | Multiplicative coefficient |
| `feedback_coeff` | float | Multiplicative coefficient |

**Implementation:**

```python
for matrix in ['feedin', 'feedback']:
    # Direct value assignment
    if matrix in kwargs:
        value = kwargs[matrix]
        if modeID == 'all':
            deck[matrix] = np.ones(num_modes) * value
        else:
            deck[matrix][modeID] = value

    # Coefficient-based update (with memory)
    if f"{matrix}_coeff" in kwargs:
        new_coeff = kwargs[f"{matrix}_coeff"]
        old_coeff = deck_coeffs[matrix]

        # Relative adjustment
        deck[matrix] *= (new_coeff / old_coeff)

        # Remember for next call
        deck_coeffs[matrix] = new_coeff
```

**Example:**

```python
# Initial: feedback_coeff = 1.0, deck['feedback'] = [1, 1, 1, ...]
pitch.update_deck_coefficients(feedback_coeff=0.5)
# deck['feedback'] *= 0.5 → [0.5, 0.5, 0.5, ...]

pitch.update_deck_coefficients(feedback_coeff=2.0)
# deck['feedback'] *= (2.0 / 0.5) = 4.0 → [2.0, 2.0, 2.0, ...]
```

---

### 5.5 load_from_dict() - ExcitationParameters

**File:** `StringExcitation.py`
**Lines:** 298-299

**Signature:**
```python
def load_from_dict(gp_dict, num_levels=128):
    """Load excitation curves from dictionary"""
```

**Input Format:**

```python
gp_dict = {
    0: {    # Velocity level
        0: {'mu': 1.0, 'sigma': 0.1, 'volume': 10, 'shift': 0.1},  # Curve 0
        1: {'mu': 2.0, 'sigma': 0.4, 'volume': 3, 'shift': 0.2},   # Curve 1
        ...
    },
    31: {
        0: {...},
        ...
    },
    ...
}
```

**Process (Lines 272-296):**

```python
for level, level_dict in gp_dict.items():
    for curve, curve_dict in level_dict.items():
        for param, value in curve_dict.items():
            param_index = PARAM_NAMES.index(param)
            # PARAM_NAMES = ['mu', 'sigma', 'volume', 'shift']

            levels_matrix[level, param_index, curve] = value

# Extrapolate to 128 levels
recalculate_excitation_matrix()
```

---

### 5.6 update_params() - Mode

**File:** `Mode.py`
**Lines:** 108-146

**Signature:**
```python
def update_params(params, **kwargs):
    """Update mode physical parameters and recompute coefficients"""
```

**Parameters:**

| Parameter | Effect | Clears |
|-----------|--------|--------|
| `frequency` | Sets frequency | mass, stiffness |
| `decrement` | Sets decrement | damping |
| `mass` | Sets modal mass | - |
| `stiffness` | Sets modal stiffness | - |
| `damping` | Sets modal damping | - |

**Process:**

```python
# Update attributes
for param, value in params.items():
    setattr(self, param, value)

    # Clear dependent attributes
    if param == 'frequency':
        mass = None
        stiffness = None
    elif param == 'decrement':
        damping = None

# Recompute simulation coefficients
fit_params()
```

---

## 6. Parameter Processing and Transformations

### 6.1 Coefficient Calculation - Pitch.get_coefficients()

**File:** `Pitch.py`
**Lines:** 296-325

**Purpose:** Calculate finite difference coefficients for string wave equation

**Mathematical Model:**

Wave equation with bending stiffness and damping:

```
∂²u/∂t² = (T/ρ) ∂²u/∂x² - (EI/ρ) ∂⁴u/∂x⁴ - γ ∂u/∂t + F(x,t)
```

**Discretization:**

```python
# Extract parameters
dx = geometry.dx()           # Spatial step
dt = 1 / (sr * string_iter)  # Time step (1.736 μs)
T = tension                  # Newtons
ρ = rho                      # kg/m
E = jung                     # Young's modulus (Pa)
I = π * r⁴ / 4               # Second moment of area
γ = gamma                    # Damping coefficient

# Wave speed squared
u² = T / ρ

# Coefficients
coeff_tension = u² * dt² / dx²
coeff_G = I / ρ
coeff_bending = coeff_G * E * dt² / dx⁴

# Damping factor
dec_cur = γ * dt * damper
dec_inv = 1 / (1 + dec_cur)

# 5-point stencil
c0 = (2 + 12*coeff_bending - 2*coeff_tension) * dec_inv
c1 = (coeff_tension - 8*coeff_bending) * dec_inv
c2 = 2 * coeff_bending * dec_inv
ct = (dec_cur - 1) * dec_inv
cf = dt² * dec_inv
c2dec = disp_decay / (2 * dt * dx²)
```

**Discrete Update Formula:**

```python
u[t+dt, x] = c0 * u[t, x] +
             ct * u[t-dt, x] +
             c1 * (u[t, x-dx] + u[t, x+dx]) +
             c2 * (u[t, x-2dx] + u[t, x+2dx]) +
             cf * force[t, x] +
             c2dec * decay_term
```

**Physical Interpretation:**

- **c0:** Central point weight (inertia + bending + tension)
- **c1:** First neighbor weight (tension - bending)
- **c2:** Second neighbor weight (bending only)
- **ct:** Temporal damping
- **cf:** Force application coefficient
- **c2dec:** Additional displacement decay

---

### 6.2 Mode Coefficient Fitting - Mode.fit_params()

**File:** `Mode.py`
**Lines:** 45-68

**Purpose:** Calculate simulation coefficients from physical properties

**Physical Model:**

Second-order harmonic oscillator:

```
m ∂²x/∂t² + c ∂x/∂t + k x = F(t)
```

**Process:**

```python
dt = 1 / sample_rate  # Time step

# Option 1: Given frequency, compute mass
if mass is None or isnan(mass):
    stiffness = 0.1
    mass = stiffness / (2π * frequency)²
    # From: ω = √(k/m) → m = k/ω²

# Option 2: Given mass/stiffness, compute frequency
else:
    frequency = sqrt(stiffness / mass) / (2π)

# Compute decrement from damping
if damping and not isnan(damping):
    # Damping ratio: ζ = c / (2√(km))
    dump_ratio = 0.5 * damping / sqrt(mass * stiffness)

    # Decrement: δ = 2πζ / √(1-ζ²)
    decrement = 2π * dump_ratio / sqrt(1 - dump_ratio²)

# Simulation coefficients
omega = dt² * frequency² * 4π²   # Restoring force coefficient
dec = dt * decrement * frequency  # Damping coefficient
```

**Discrete Iteration:**

```python
x[t+dt] = ((2*x[t] - x[t-dt]) +
           x[t-dt] * dec -
           x[t] * omega +
           F[t]) * (1 - dec)
```

---

### 6.3 Hammer Shape Calculation - PianoHammer.calculate_hammer_shape()

**File:** `Hammer.py`
**Lines:** 126-155

**Purpose:** Generate spatial force profile for hammer strike

**Circular Shape Function:**

```python
def circular(x, center, width, sharpness):
    """Circular hammer profile"""
    halfW = width / 2

    # Check if x is in contact region
    xInRange = (x >= center - halfW) and (x <= center + halfW)

    # Compute radius of curvature
    mu = halfW * (1 - sharpness)
    R = sqrt(halfW² + mu²)

    # Offset to make edges zero
    m = R - sqrt(R² - halfW²)

    if xInRange:
        return sqrt(R² - (center - x)²) - R + m
    else:
        return 0
```

**Sharpness Parameter Effect:**

| Sharpness | μ | R | Profile Shape |
|-----------|---|---|---------------|
| 0 | halfW | sqrt(2) * halfW | Triangular (soft felt) |
| 0.5 | halfW/2 | sqrt(1.25) * halfW | Semicircular |
| 1 | 0 | halfW | Rectangular (hard hammer) |

**Application to Grid:**

```python
# Enforce minimum width
width = max(self.width, geometry.dx() * 3)  # At least 3 points

# Apply offset for detuning
center = position * (1 + offset)

# Generate profile
hammer_shape = np.zeros(geometry.p_full())
for xi in range(geometry.p_full()):
    x_position = xi * geometry.dx()
    hammer_shape[xi] = circular(x_position, center, width, sharpness)

return hammer_shape
```

**Example:**

```python
# String length: 1.2 m, 100 grid points → dx = 0.012 m
# Hammer: width=0.05 m, position=0.125 (12.5% from left), sharpness=0.3

center = 1.2 * 0.125 = 0.15 m
center_index = 0.15 / 0.012 = 12.5 → points 10-15 affected

# Profile:
# [0, 0, ..., 0.1, 0.5, 0.8, 1.0, 0.8, 0.5, 0.1, 0, ...]
#               ↑                           ↑
#           center-halfW                 center+halfW
```

---

### 6.4 Excitation Curve Extrapolation - ExcitationParameters.recalculate_excitation_matrix()

**File:** `StringExcitation.py`
**Lines:** 401-412

**Purpose:** Interpolate 5 base velocity levels to 128 MIDI velocity levels

**Process:**

```python
# Extract base levels
base_level_matrix = levels_matrix[LEVEL_INDICES, :, :]
# LEVEL_INDICES = [0, 31, 63, 95, 127]
# Shape: (5, 4, 5)

# Apply volume coefficients
if apply_coefficients:
    base_level_matrix[:, 2, :] *= volume_coefficients[:, np.newaxis]
    # Multiply volume parameter by coefficients

# Linear interpolation
result = extrapolate(base_level_matrix, newdim=128,
                     indices=LEVEL_INDICES[1:-1])
# indices = [31, 63, 95] - interior points

levels_matrix[:] = result
```

**Extrapolation Function (Lines 26-89):**

```python
def extrapolate(a, newdim, indices):
    """Linear interpolation along first dimension"""
    olddim = a.shape[0]  # 5 base levels

    result = np.zeros((newdim,) + a.shape[1:])

    # Copy first and last rows
    result[0] = a[0]
    result[-1] = a[-1]

    # Interpolate between interior points
    for i in range(olddim - 1):
        start = indices[i]      # e.g., 31
        end = indices[i + 1]    # e.g., 63
        span = end - start      # 32

        row_start = a[i]
        row_end = a[i + 1]

        # Linear interpolation
        rows = np.linspace(row_start, row_end, span)
        result[start:end] = rows

    return result
```

**Example:**

```
Base levels: [0, 31, 63, 95, 127]
Base mu values: [1.0, 2.0, 3.0, 4.0, 5.0]

Interpolation:
- Velocity 0: mu = 1.0 (exact)
- Velocity 15: mu = 1.0 + (2.0-1.0) * (15/31) = 1.48
- Velocity 31: mu = 2.0 (exact)
- Velocity 47: mu = 2.0 + (3.0-2.0) * (16/32) = 2.5
- Velocity 63: mu = 3.0 (exact)
...
```

---

### 6.5 Tension Offset Application - Pitch.pack_params_for_string()

**File:** `Pitch.py`
**Lines:** 92-108

**Purpose:** Apply detuning to individual strings in a chorus

**Process:**

```python
def pack_params_for_string(stringId):
    """Pack parameters with per-string detuning"""
    # Calculate tension offset based on position in chorus
    string_position = stringIDs.index(stringId)
    tension_ofs = string_position * tension_offset

    # Pack with offset
    packed_physics = physics.pack(offset=tension_ofs)

    return packed_physics
```

**Inside PhysicalParameters.pack(offset):**

```python
def pack(offset):
    param_dict = {
        'tension': tension * (1 + offset),  # ⚡ DETUNING
        'rho': rho,
        ...
    }
    return param_dict
```

**Example:**

```python
# Pitch 60 with 3 strings, tension_offset = 0.002 (0.2%)
# Base tension: 300 N

string_0: tension_ofs = 0 * 0.002 = 0
          tension_packed = 300 * (1 + 0) = 300.0 N

string_1: tension_ofs = 1 * 0.002 = 0.002
          tension_packed = 300 * (1 + 0.002) = 300.6 N

string_2: tension_ofs = 2 * 0.002 = 0.004
          tension_packed = 300 * (1 + 0.004) = 301.2 N

# Frequency deviation (f ∝ √T):
# Δf/f = ΔT/(2T) ≈ 0.001 (0.1%) → ~1.7 cents per string
```

**Musical Effect:** Creates subtle chorus/detuning similar to real piano unisons.

---

### 6.6 Feedin Extension for Sound Channels - StringMap.pack_pitch_feedin()

**File:** `StringMap.py`
**Lines:** 416-428

**Purpose:** Insert sound channel coefficients into feedin array

**Process:**

```python
def pack_pitch_feedin(pitchID):
    """Pack feedin with sound channel coefficients"""
    pitch = pitches[pitchID]

    # Extend feedin array to full size
    feedin = ext_to_the_right(pitch.deck['feedin'], mp.num_strings)
    # pitch.deck['feedin'] is (num_modes,)
    # Extended to (num_strings,) with zero-padding

    # Insert sound channel coefficients
    if mp.listen_to_modes:
        channel_indices = soundChannelModes.get_index()
        # [mode_channel_index, ..., mode_channel_index + num_channels - 1]

        feedin[channel_indices] = soundChannelModes.get_coeff(pitchID)

    return feedin
```

**Example:**

```python
# Configuration:
num_modes = 64
num_strings = 256
mode_channel_index = 200
num_channels = 4

# Pitch 60 feedin:
pitch.deck['feedin'] = np.ones(64)  # Excite all 64 modes

# Extended feedin:
feedin = np.zeros(256)
feedin[0:64] = 1.0  # Modes 0-63

# Sound channel coefficients:
soundChannelModes.get_coeff(60) = [0.8, 0.6, 0.4, 0.2]

# Insert at indices [200, 201, 202, 203]:
feedin[200:204] = [0.8, 0.6, 0.4, 0.2]

# Effect: Modes also excite sound output channels
```

---

### 6.7 Block State Packing - StringBlock.pack_arrays()

**File:** `StringBlock.py`
**Lines:** 96-108

**Purpose:** Copy individual string states into contiguous block memory

**Memory Layout:**

```
Block state array (2, 384):
Row 0: Current displacement
Row 1: Previous displacement

Columns:
[0:2]     interval (unused)
[2:54]    string 0 (length=52)
[54:56]   interval
[56:108]  string 1 (length=52)
[108:110] interval
...
```

**Process:**

```python
def pack_arrays():
    """Copy string states into block"""
    for ID, string in strings.items():
        state[0, string.start : string.end] = string.cur()
        state[1, string.start : string.end] = string.prev()
```

**Reverse Operation:**

```python
def unpack_arrays():
    """Copy block back to strings"""
    for ID, string in strings.items():
        string.set_cur(state[0, string.start : string.end])
        string.set_prev(state[1, string.start : string.end])
```

**Usage:** Bidirectional synchronization for CUDA data transfer.

---

## 7. Default Values and Initialization

### 7.1 ModelParameters Defaults

**File:** `ModelParams.py`
**Lines:** 3-16

```python
MODE_ITERATION = 48          # Iterations per cycle
STRING_ITERATION = 12        # Iterations per sample
SAMPLE_RATE = 48000          # Hz
ARRAY_SIZE = 384             # Block size in points
NUM_STRINGS_IN_ARRAY = 2     # Strings per block (1-4)
DEF_NUM_MODES = 32
MAX_NUM_MODES = 256
MAX_NUM_STRINGS = 256
EXCITATION_FACTOR = 8
LEVEL_INDICES = [0, 31, 63, 95, 127]  # Base velocity levels
MS_TIMESTEP = 1
```

**Derived Values:**

```python
dt = 1 / (48000 * 12) = 1.736 μs
excitation_length = 12 * 48 * 8 = 4608 samples
cycle_duration = 48 * 10^6 / 48000 = 1000 μs (1 ms)
```

---

### 7.2 PhysicalParameters Defaults

**File:** `PhysicalParameters.py`
**Lines:** 8-17

```python
DEFAULTS = {
    "tension": 300,           # N (typical: 50-2000 N)
    "rho": 0.007,             # kg/m (steel: 0.004-0.01)
    "r": 0.0005,              # m (0.5 mm radius)
    "jung": 19000,            # Pa (Young's modulus)
    "gamma": 0.1,             # Damping
    "disp_decay": 0,
    "volume_coefficient": 1,
    "damper_string": 0.5,
    "damper_tail": 127        # Fully damped
}
```

**Physical Interpretation:**

| Parameter | Value | Physical Meaning |
|-----------|-------|------------------|
| tension | 300 N | ~30 kg force (mid-range piano) |
| rho | 0.007 kg/m | Steel wire density |
| r | 0.5 mm | Wire radius |
| jung | 19 GPa | Steel Young's modulus |
| gamma | 0.1 | Moderate damping |

**Wave Speed:**

```python
u = sqrt(T / ρ) = sqrt(300 / 0.007) = 207 m/s
```

---

### 7.3 PianoHammer Defaults

**File:** `Hammer.py`
**Lines:** 6, 44-48

```python
# Default dictionary
DEFAULTS = {
    "width": 0.005,     # 5 mm
    "position": 0.01,   # 1 cm from left
    "sharpness": 0.5,   # Medium hardness
    "offset": 0
}

# If params == 'defaults':
width = geometry.dx() * 3                # Minimum 3 points
position = geometry.l_main() / 9         # Strike at 1/9 length
sharpness = 0
hammer_offset = 0
```

**Musical Context:**

- Position 1/9: Typical piano hammer position (bright tone)
- Sharpness 0: Soft felt hammer
- Width 3 points: Minimum for numerical stability

---

### 7.4 ExcitationParameters Defaults

**File:** `StringExcitation.py`
**Lines:** 20-24

```python
DEFAULT_MU = [1, 2, 2, 2.5, 6]           # Peak time (ms)
DEFAULT_SIGMA = [0.1, 0.4, 0.6, 1, 0.2]  # Width
DEFAULT_VOLUME = [10, 3, 2, 1, 5]        # Amplitude
DEFAULT_SHIFT = [0.1, 0.2, 0.3, 0.2, 0]  # Offset
```

**Default Curve Generation (Lines 458-467):**

```python
# Minimum level (velocity 0): Mostly zero, curve 2 = 1
min_level.default_min()

# Maximum level (velocity 127): Use DEFAULTS
max_level.default_max()

# Interpolate to 5 base levels
lmm = np.stack([min_level.to_matrix(), max_level.to_matrix()])
lm = extrapolate(lmm, 5)

# Load into parameters
load_from_matrix(lm)
```

---

### 7.5 Pitch Deck Defaults

**File:** `Pitch.py`
**Lines:** 172-178

```python
if 'defaults' in kwargs and kwargs['defaults']:
    if outerSound:
        # Sound channels: Collect from modes, don't excite
        deck['feedin'] = np.zeros(num_modes)
        deck['feedback'] = np.ones(num_modes)
    else:
        # Regular pitches: Excite modes, no feedback
        deck['feedin'] = np.ones(num_modes)
        deck['feedback'] = np.zeros(num_modes)
```

**Physical Interpretation:**

- **feedin = 1:** String vibrations fully excite corresponding mode
- **feedback = 0:** Mode vibrations don't affect string
- **Sound channels:** Reverse (collect mode energy for output)

---

### 7.6 StringState Defaults

**File:** `StringState.py`
**Lines:** 90-118

```python
length = geometry.p_full() + 4
array = np.zeros((3, length))           # Displacement history
dec_open = CLOSED                       # 127 (damped)
exct_cycle_ind = 0
margin = 2
start = 0
end = start + geometry.p_full()
feedback = 0
sound = []
force = []
hammer_shape = np.zeros(geometry.p_full())
excitation = np.zeros(mp.excitation_length())

# Coefficients (set later)
c0 = c1 = c2 = cb = cf = c2dec = 0
cF_main = cF_tail = 1
```

---

### 7.7 Mode Defaults

**File:** `Mode.py`
**Lines:** 8-42

```python
# Dummy mode (for GPU padding)
if "dummy" in params and params["dummy"]:
    frequency = 1000  # Hz
    decrement = 0.9

# Regular mode
else:
    # Must provide (frequency, decrement) or (mass, stiffness, damping)
    state = 0
    state_1 = 0
```

---

## 8. Validation Logic

### 8.1 ModelParameters Validation

**GPU Alignment (Lines 83-92):**

```python
def set_num_modes(self, num_modes, num_modes_for_model=None):
    if num_modes_for_model:
        if num_modes_for_model % self.num_blocks() != 0:
            raise ValueError(
                f"Number of modes for the model should be divisible by "
                f"number of arrays. Provided {num_modes_for_model} "
                f"number of arrays {self.num_blocks()}"
            )
        self.num_modes_for_model = num_modes_for_model
    else:
        # Auto-round up
        self.num_modes_for_model = (
            (self.num_modes // self.num_blocks() + 1) * self.num_blocks()
        )
```

**Ensures:** GPU thread blocks align with mode count.

---

### 8.2 StringMap Validation

**Block Structure (Lines 94-99):**

```python
assert self.mp.num_strings % len(blocks) == 0

nsa = self.mp.num_strings // len(blocks)
assert len(blocks[0]) == nsa, \
    f"Block length {len(blocks[0])} mismatch nsa {nsa}"

if nsa not in (1, 2, 3, 4):
    raise ValueError(
        f"{nsa} strings per block is not supported, "
        f"invoked with num_strings {self.mp.num_strings}, "
        f"num_blocks {len(blocks)}"
    )
```

**Pitch Existence (Lines 108-109):**

```python
if pitchID not in self.pitches:
    raise ValueError(f"Pitch {pitchID} not in preset")
```

---

### 8.3 StringBlock Validation

**Capacity Check (Lines 36-42):**

```python
if self.num_points + string.geometry.p_full() + self.interval > self.max_num_points:
    error_message = f"""String mapping error: Failed to add string to the block, not enough space.
    Strings already in the block: {' '.join([str(string) for string in self.strings])}, total length {self.num_points}
    String not added {string.ID} length {string.geometry.p_full()}
    Size of the block {self.max_num_points} """
    raise ValueError(error_message)
```

---

### 8.4 Pitch Validation

**Pitch Range (Lines 22-23):**

```python
if pitch not in range(140):
    raise ValueError(f"Illegal pitch value {pitch}")
```

**String Count (Lines 229-230):**

```python
if len(self.stringIDs) == self.num_strings:
    raise RuntimeError(
        f"Failed to add string: Pitch {self.pitch} "
        f"already has 3 strings"
    )
```

**Deck Dimensions (StringMap.py:331-334):**

```python
if len(new_values) != self.mp.num_modes:
    error = (
        f"Error in StringMap module. Trying to set array of "
        f"shape {new_values.shape} as a {matrix} for pitch {pitchID}. "
        f"Number of modes is {self.mp.num_modes}"
    )
    raise ValueError(error)
```

---

### 8.5 PianoHammer Validation

**Width Bounds (Lines 77-78):**

```python
if self.width < 0 or self.width > self.geometry.l_main():
    raise ValueError(
        f"Incorrect size of hammer {self.width} "
        f"string length is {self.geometry.l_main()}"
    )
```

**Position Bounds (Lines 82-84):**

```python
if self.pos_ratio < 0 or self.pos_ratio > 1:
    raise EnvironmentError(
        f"Inconsistent hammer parameters, position {self.position} "
        f"string length {self.geometry.l_main()}"
    )
```

---

### 8.6 ExcitationParameters Validation

**Parameter Names (Lines 391-392):**

```python
if parameter not in PARAM_NAMES:
    raise ValueError(
        f"Incorrect parameter {parameter}, must be in {PARAM_NAMES}"
    )
# PARAM_NAMES = ['mu', 'sigma', 'volume', 'shift']
```

**Level Indices (Lines 393-394):**

```python
if level not in LEVEL_INDICES:
    raise ValueError(
        f"Incorrect level {level}, must be in {LEVEL_INDICES}"
    )
# LEVEL_INDICES = [0, 31, 63, 95, 127]
```

**Matrix Dimensions (Lines 259-266):**

```python
if type(lm) != type(None):
    num_rows = lm.shape[0]
    assert lm.shape == (num_rows, NUM_PARAMS_GAUSS, NUM_GAUSS), \
        f"Wrong shape of parameters matrix, {lm.shape}"

    if num_rows == NUM_BASE_LEVELS:
        # OK, will extrapolate
        pass
    elif num_rows == NUM_LEVELS:
        # OK, use directly
        pass
    else:
        raise ValueError(
            f"Wrong number of levels parameters matrix, {lm.shape}"
        )
```

---

### 8.7 Mode Validation

**Mode Count Consistency (Lines 233-234):**

```python
if len(self.modes) != self.mp.num_modes:
    raise RuntimeError(
        f"Inconsistency in number of modes: have set up "
        f"{len(self.modes)} modes, in model parameters "
        f"{self.mp.num_modes} modes"
    )
```

**Duplicate IDs (Lines 240-242):**

```python
if not replace:
    if mode_ID in self.modes:
        raise RuntimeError(
            f"Mode with ID {mode_ID} already exists, to update "
            f"existing modes use flag replace"
        )
```

---

## 9. Caching and State Management

### 9.1 String ID Management

**Allocation and Recycling (Lines 49-50, 130-140):**

```python
nextID = 0
released_IDs = []  # Recycle deleted string IDs

def _get_next_stringID():
    """Allocate or recycle string ID"""
    if len(released_IDs) > 0:
        ID = released_IDs.pop()  # Recycle
    else:
        ID = nextID
        nextID += 1

    if ID not in strings.keys():
        return ID
```

**Effect:** Prevents ID exhaustion in long-running sessions.

---

### 9.2 Chores Mapping Cache

**File:** `StringMap.py`
**Lines:** 301-317

**Purpose:** Cache pitch → string index mapping

```python
def generate_chores():
    """Create and cache chores mapping"""
    # Flatten string IDs
    string_index = list(np.array([block.get_string_IDs()
                                   for block in blocks]).ravel())

    # Corresponding pitches
    pitch_index = [strings[stringID].pitch
                   for stringID in string_index]

    # Build mapping
    chores = -np.ones((140, 3))
    for i, pitchID in enumerate(range(140)):
        if pitchID in pitches:
            pitch = pitches[pitchID]
            chore = [string_index.index(stringID)
                     for stringID in pitch.get_strings()]
            chores[i][:len(chore)] = chore

    return chores, string_index, pitch_index
```

**Called:** Once after initialization, not updated dynamically.

---

### 9.3 Hammer Shape Distribution

**File:** `StringMap.py`
**Lines:** 393-395

```python
def update_hammer_shapes():
    """Regenerate all hammer shapes"""
    for pitchID in keyPitches:
        update_hammer_shape(pitchID)
```

**Must be called manually** after hammer parameter changes.

---

### 9.4 Deck Coefficient Memory

**File:** `Pitch.py`
**Lines:** 76-77, 210-217

```python
deck_coeffs = {'feedin': 1, 'feedback': 1}

# In update_deck_coefficients():
old_value = deck_coeffs[matrix]
deck[matrix] *= (value / old_value)  # Relative adjustment
deck_coeffs[matrix] = value          # Remember for next call
```

**Purpose:** Enable relative coefficient adjustments.

---

### 9.5 Feedback History

**File:** `Pitch.py`
**Lines:** 75, 365-366, 375-376

```python
feedback_record = []

# During simulation:
def set_feedback(self, mode_positions):
    feedback = np.sum(mode_positions * self.deck['feedback'])
    feedback_record.append(feedback)  # Accumulate
```

**Purpose:** Debug/analysis feature.

---

### 9.6 Volume Coefficient Tracking

**File:** `StringExcitation.py`
**Lines:** 244, 247-248, 406-407

```python
volume_coefficients = np.ones(NUM_BASE_LEVELS)

# In pack_gauss_params():
if volume_coefficients is not None:
    m = recalculate_excitation_matrix(apply_coefficients=True)
    # Applies volume_coefficients to base levels
```

**Purpose:** Allow global volume scaling per velocity level.

---

### 9.7 Matrix Cache

**File:** `StringExcitation.py`
**Lines:** 230, 256-270

```python
# Dual representation:
levels_matrix: (128, 4, 5)              # Fast array access
parameters: dict[int, ExcitationCurve]  # Object access

def load_from_matrix(lm):
    """Sync representations"""
    for i, level in enumerate(levels_matrix):
        parameters[i] = ExcitationCurve(level, transpose=True)
```

---

### 9.8 StringBlock Packed State

**File:** `StringBlock.py`
**Lines:** 17, 96-108

```python
state = np.zeros((2, max_num_points))

def pack_arrays():
    """String → Block"""
    for ID, string in strings.items():
        state[0, string.start : string.end] = string.cur()
        state[1, string.start : string.end] = string.prev()

def unpack_arrays():
    """Block → String"""
    for ID, string in strings.items():
        string.set_cur(state[0, string.start : string.end])
        string.set_prev(state[1, string.start : string.end])
```

**Bidirectional synchronization** for CUDA transfer.

---

### 9.9 StringState Circular Buffer

**File:** `StringState.py`
**Lines:** 95-96, 198-200

```python
array = np.zeros((3, length))  # [t-1, t, t+1]
pointer = CircularPointer(3)

def increment():
    """Rotate indices"""
    pointer.increment()
    pointer_2der.increment()
    excit_pointer = min(excit_pointer + 1, len(excitation) - 1)
```

---

### 9.10 Saved Feedback Values

**File:** `StringMap.py`
**Lines:** 526-571

```python
_saved_feedback_values = {}  # Persistent storage

def reset_feedback(self, mode_no):
    """Temporarily zero feedback for mode"""
    old_values = {}
    for pitch_id in keyPitches:
        old_values[pitch_id] = pitch.deck['feedback'][mode_no]
        pitch.deck['feedback'][mode_no] = 0
    _saved_feedback_values[mode_no] = old_values
    return old_values

def restore_feedback(self, mode_no, old_values=None):
    """Restore saved feedback values"""
    if old_values is None:
        old_values = _saved_feedback_values[mode_no]
    for pitch_id, old_value in old_values.items():
        pitch.deck['feedback'][mode_no] = old_value
    del _saved_feedback_values[mode_no]
```

**Purpose:** Facilitate mode isolation experiments.

---

## 10. Data Flow: REST API → CUDA

### 10.1 Complete Flow for String Parameter Update

```
┌────────────────────────────────────────────────────────────┐
│ 1. REST API REQUEST                                        │
│ POST /set_parameter/string/60                              │
│ { "tension": 350, "gamma": 0.15 }                          │
└──────────────────┬─────────────────────────────────────────┘
                   │
                   ↓
┌────────────────────────────────────────────────────────────┐
│ 2. PIANOIDCORE MIDDLEWARE (backendServer.py:319)          │
│ set_parameter(parameter='string', key_no=60)               │
│ → Calls pianoid.update_parameter()                         │
└──────────────────┬─────────────────────────────────────────┘
                   │
                   ↓
┌────────────────────────────────────────────────────────────┐
│ 3. MIDDLEWARE DISPATCH (pianoid.py:1811-1846)             │
│ update_parameter(param='string', values={'60': {...}})    │
│ → Branch: param in ('string', 'physics')                   │
│ → Calls update_pitch_physical_params_GRANULAR()           │
└──────────────────┬─────────────────────────────────────────┘
                   │
                   ↓
┌────────────────────────────────────────────────────────────┐
│ 4. PIANOIDBASIC PARAMETER UPDATE (pianoid.py:1494)        │
│ update_pitch_physical_params_GRANULAR(pitchID=60, ...)    │
│ → pitch = sm.pitches[60]                                   │
│ → pitch.physics.set_params(tension=350, gamma=0.15)        │
│                                                             │
│ ⚡ PYTHON-SIDE STATE UPDATED                               │
│ pitch.physics.tension = 350                                │
│ pitch.physics.gamma = 0.15                                 │
└──────────────────┬─────────────────────────────────────────┘
                   │
                   ↓
┌────────────────────────────────────────────────────────────┐
│ 5. PARAMETER PACKING (pianoid.py:1494, CUDA call)         │
│ For each string in pitch:                                  │
│   string_cuda_indices = [10, 11, 12]  # 3-string chorus    │
│                                                             │
│   For stringID in string_cuda_indices:                     │
│     ⚡ DETUNING CALCULATION                                │
│     offset = stringIDs.index(stringID) * tension_offset    │
│     # String 10: offset = 0                                │
│     # String 11: offset = 0.002                            │
│     # String 12: offset = 0.004                            │
│                                                             │
│     ⚡ TENSION PACKING                                      │
│     packed_tension = 350 * (1 + offset)                    │
│     # String 10: 350.0 N                                   │
│     # String 11: 350.7 N                                   │
│     # String 12: 351.4 N                                   │
│                                                             │
│     ⚡ COEFFICIENT CALCULATION                              │
│     c0, c1, c2, ... = pitch.get_coefficients()             │
│     # Finite difference coefficients from physics          │
│     # u² = T/ρ = 350/0.007 = 50000                         │
│     # coeff_tension = 50000 * dt²/dx²                      │
│     # ...                                                  │
└──────────────────┬─────────────────────────────────────────┘
                   │
                   ↓
┌────────────────────────────────────────────────────────────┐
│ 6. CUDA TRANSFER (pianoidCuda)                             │
│ updateMultiStringParameter_NEW(                            │
│   param_name='tension',                                    │
│   string_indices=[10, 11, 12],                             │
│   new_values=[350.0, 350.7, 351.4]                         │
│ )                                                           │
│                                                             │
│ ⚡ GPU MEMORY UPDATE                                        │
│ UnifiedGpuMemoryManager.updateTunableParameter()           │
│ → Async double-buffered upload                             │
│ → Background polling thread                                │
│ → Atomic buffer swap when complete                         │
└──────────────────┬─────────────────────────────────────────┘
                   │
                   ↓
┌────────────────────────────────────────────────────────────┐
│ 7. GPU KERNEL EXECUTION                                    │
│ parameterKernel (MainKernel.cu)                            │
│ → Reads new tension values                                 │
│ → Updates string simulation coefficients                   │
│ → Next MainKernel uses updated physics                     │
└────────────────────────────────────────────────────────────┘
```

---

### 10.2 Flow for Excitation Parameter Update

```
┌────────────────────────────────────────────────────────────┐
│ 1. REST API REQUEST                                        │
│ POST /set_parameter/gauss/60                               │
│ {                                                           │
│   "31": {  // Velocity level 31                            │
│     "0": {"mu": 1.5, "sigma": 0.2, ...},  // Curve 0       │
│     "1": {...},                                             │
│     ...                                                     │
│   }                                                         │
│ }                                                           │
└──────────────────┬─────────────────────────────────────────┘
                   │
                   ↓
┌────────────────────────────────────────────────────────────┐
│ 2. MIDDLEWARE DISPATCH (pianoid.py:1824-1828)             │
│ update_parameter(param='gauss', values={'60': {...}})     │
│ → Branch: param in ('gauss', 'excitation')                 │
│ → pitch.excitation.load_from_dict(values['60'])            │
└──────────────────┬─────────────────────────────────────────┘
                   │
                   ↓
┌────────────────────────────────────────────────────────────┐
│ 3. PIANOIDBASIC EXCITATION UPDATE                          │
│    (StringExcitation.py:298-299)                           │
│                                                             │
│ ⚡ POPULATE BASE LEVELS                                     │
│ for level, level_dict in values.items():                   │
│   for curve, curve_dict in level_dict.items():             │
│     levels_matrix[level, :, curve] = [mu, sigma, vol, shft]│
│                                                             │
│ # levels_matrix[31, :, 0] = [1.5, 0.2, 10, 0.1]            │
│ # Only base level 31 updated                               │
└──────────────────┬─────────────────────────────────────────┘
                   │
                   ↓
┌────────────────────────────────────────────────────────────┐
│ 4. EXTRAPOLATION (recalculate_excitation_matrix)          │
│                                                             │
│ ⚡ EXTRACT BASE LEVELS                                      │
│ base = levels_matrix[[0, 31, 63, 95, 127], :, :]           │
│ # Shape: (5, 4, 5)                                         │
│                                                             │
│ ⚡ APPLY VOLUME COEFFICIENTS                                │
│ base[:, 2, :] *= volume_coefficients[:, np.newaxis]        │
│                                                             │
│ ⚡ LINEAR INTERPOLATION                                     │
│ levels_matrix[:] = extrapolate(base, newdim=128)           │
│ # Interpolate 5 base levels → 128 velocity levels          │
│                                                             │
│ # Example:                                                 │
│ # Velocity 16: Interpolate between base[0] and base[31]    │
│ # Velocity 47: Interpolate between base[31] and base[63]   │
└──────────────────┬─────────────────────────────────────────┘
                   │
                   ↓
┌────────────────────────────────────────────────────────────┐
│ 5. LEGACY BULK PACKING ⚠️ INEFFICIENT                      │
│    (pianoid.py:1439)                                        │
│                                                             │
│ send_updated_params_to_CUDA()                              │
│ → sm.pack_parameters()                                     │
│ → 📦 PACKS ALL 256 STRINGS                                 │
│   packed_excitations = []                                  │
│   for stringID in string_index:  # All strings!            │
│     pitch = pitches[strings[stringID].pitch]               │
│     packed_excitations.extend(                             │
│       pitch.excitation.levels_matrix.ravel()  # 2560 floats│
│     )                                                       │
│   # Total: 256 * 2560 = 655,360 floats (2.6 MB)            │
└──────────────────┬─────────────────────────────────────────┘
                   │
                   ↓
┌────────────────────────────────────────────────────────────┐
│ 6. CUDA TRANSFER                                           │
│ pianoidCuda.setNewExcitationParameters(packed_excitations) │
│ → Uploads 2.6 MB for single pitch update ⚠️                │
│ → UnifiedGpuMemoryManager.updateTunableParameter()         │
│   ("dev_gauss_params_full", 655360 reals)                  │
└────────────────────────────────────────────────────────────┘

⚡ PERFORMANCE ISSUE IDENTIFIED:
Only pitch 60 changed, but ALL 256 strings' excitations uploaded.

Potential improvement: Granular excitation API
→ Update only affected pitch (2560 reals = 10 KB)
→ **260x bandwidth reduction**
```

---

### 10.3 Flow for Hammer Parameter Update

```
┌────────────────────────────────────────────────────────────┐
│ 1. REST API REQUEST                                        │
│ POST /set_parameter/hammer/60                              │
│ { "position": 0.15, "sharpness": 0.3 }                     │
└──────────────────┬─────────────────────────────────────────┘
                   │
                   ↓
┌────────────────────────────────────────────────────────────┐
│ 2. MIDDLEWARE DISPATCH (pianoid.py:1830-1833)             │
│ update_parameter(param='hammer', values={'60': {...}})    │
│ → Branch: param == 'hammer'                                │
│ → sm.update_hammer_shape(60, **values['60'])               │
└──────────────────┬─────────────────────────────────────────┘
                   │
                   ↓
┌────────────────────────────────────────────────────────────┐
│ 3. PIANOIDBASIC HAMMER UPDATE (StringMap.py:384-395)      │
│                                                             │
│ pitch = pitches[60]                                        │
│                                                             │
│ ⚡ UPDATE HAMMER PARAMETERS                                 │
│ pitch.physics.set_hammer(position=0.15, sharpness=0.3)     │
│ # Updates PianoHammer attributes                           │
│                                                             │
│ ⚡ RECALCULATE HAMMER SHAPES                                │
│ hammer_shapes = pitch.get_hammer_shapes()                  │
│                                                             │
│ # For each string in pitch:                                │
│ for i, stringID in enumerate([10, 11, 12]):                │
│   offset = i * hammer_offset  # Positional detuning        │
│   center = 0.15 * (1 + offset)                             │
│   width = max(0.005, dx * 3)  # Minimum 3 points           │
│                                                             │
│   # Circular profile calculation                           │
│   for xi in range(p_full):                                 │
│     x = xi * dx                                            │
│     halfW = width / 2                                      │
│     mu = halfW * (1 - 0.3)  # sharpness                    │
│     R = sqrt(halfW² + mu²)                                 │
│     m = R - sqrt(R² - halfW²)                              │
│     if abs(x - center) < halfW:                            │
│       shape[xi] = sqrt(R² - (center-x)²) - R + m           │
│                                                             │
│ ⚡ DISTRIBUTE TO STRINGS                                    │
│ strings[10].hammer_shape = hammer_shapes[10]               │
│ strings[11].hammer_shape = hammer_shapes[11]               │
│ strings[12].hammer_shape = hammer_shapes[12]               │
└──────────────────┬─────────────────────────────────────────┘
                   │
                   ↓
┌────────────────────────────────────────────────────────────┐
│ 4. ❌ CRITICAL BUG: NO CUDA UPDATE                         │
│    (pianoid.py:1833)                                        │
│                                                             │
│ # Missing line:                                            │
│ # self.send_updated_params_to_CUDA()                       │
│                                                             │
│ ⚠️ PYTHON-SIDE UPDATED, CUDA STILL HAS OLD VALUES          │
└────────────────────────────────────────────────────────────┘

⚡ BUG CONFIRMED:
Hammer parameter updates don't reach GPU.
Fix: Add send_updated_params_to_CUDA() call.
```

---

## 11. Mathematical Processing Deep Dive

### 11.1 Wave Equation Finite Difference Scheme

**Continuous PDE:**

```
∂²u/∂t² = c² ∂²u/∂x² - κ ∂⁴u/∂x⁴ - γ ∂u/∂t + F(x,t)

where:
  u(x,t) = string displacement
  c² = T/ρ = wave speed squared
  κ = EI/ρ = bending coefficient
  γ = damping coefficient
  F(x,t) = external force (hammer, mode feedback)
```

**Discretization:**

```
Time: t^n = n * dt, where dt = 1 / (sr * string_iteration)
Space: x_i = i * dx, where dx = length / main

u^n_i ≈ u(x_i, t^n)
```

**Central Differences:**

```
∂²u/∂t² ≈ (u^{n+1}_i - 2u^n_i + u^{n-1}_i) / dt²

∂²u/∂x² ≈ (u^n_{i+1} - 2u^n_i + u^n_{i-1}) / dx²

∂⁴u/∂x⁴ ≈ (u^n_{i+2} - 4u^n_{i+1} + 6u^n_i - 4u^n_{i-1} + u^n_{i-2}) / dx⁴

∂u/∂t ≈ (u^n_i - u^{n-1}_i) / dt
```

**Update Formula:**

```
u^{n+1}_i = (2 - 2c²dt²/dx² + 12κdt²/dx⁴) u^n_i +
            (γdt - 1) u^{n-1}_i +
            (c²dt²/dx² - 8κdt²/dx⁴) (u^n_{i+1} + u^n_{i-1}) +
            2κdt²/dx⁴ (u^n_{i+2} + u^n_{i-2}) +
            dt² F^n_i

All divided by (1 + γdt)
```

**Coefficient Mapping:**

```python
coeff_tension = c² dt² / dx²
coeff_bending = κ dt² / dx⁴
dec_cur = γ dt
dec_inv = 1 / (1 + γ dt)

c0 = (2 + 12*coeff_bending - 2*coeff_tension) * dec_inv
c1 = (coeff_tension - 8*coeff_bending) * dec_inv
c2 = 2 * coeff_bending * dec_inv
ct = (dec_cur - 1) * dec_inv
cf = dt² * dec_inv
```

**Implementation:**

```python
u_next = c0 * u_cur +
         ct * u_prev +
         c1 * (u_cur[i-1] + u_cur[i+1]) +
         c2 * (u_cur[i-2] + u_cur[i+2]) +
         cf * force
```

**Stability Condition (CFL):**

```
dt ≤ dx / sqrt(T/ρ)

For typical values:
  dx = 0.012 m
  T = 300 N
  ρ = 0.007 kg/m
  c = sqrt(300/0.007) = 207 m/s

  dt_max = 0.012 / 207 = 58 μs

Actual dt = 1.736 μs → Safe (33x margin)
```

---

### 11.2 Mode Oscillator Integration

**Continuous ODE:**

```
m ∂²x/∂t² + c ∂x/∂t + k x = F(t)

Divide by m:
∂²x/∂t² + (c/m) ∂x/∂t + (k/m) x = F(t)/m

Define:
  ω₀² = k/m (natural frequency squared)
  δ = c/(mω₀) (decrement)
```

**Discretization (Verlet Integration):**

```
x^{n+1} = 2x^n - x^{n-1} - ω₀²dt² x^n - δω₀dt (x^n - x^{n-1}) + dt² F^n/m

Simplify:
x^{n+1} = (2 - ω₀²dt²) x^n +
          (δω₀dt - 1) x^{n-1} +
          dt² F^n / m

Apply damping factor (1 - δω₀dt)
```

**Implementation:**

```python
omega = dt² * frequency² * 4π²  # ω₀²dt²
dec = dt * decrement * frequency  # δω₀dt

x_next = ((2*x - x_prev) +
          x_prev * dec -
          x * omega +
          force / mass) * (1 - dec)
```

**Energy Decay:**

```
E(t) = E₀ exp(-δω₀t)

For frequency = 100 Hz, decrement = 0.1:
  δω₀ = 0.1 * 2π * 100 = 62.8 rad/s

  E(1 sec) = E₀ exp(-62.8) ≈ 0 (rapid decay)
```

---

### 11.3 Gaussian Excitation Synthesis

**Formula:**

```
g(t) = Σ_{i=0}^{4} A_i exp(-((t - μ_i) / σ_i)²/2) - A_i s_i

where:
  A_i = volume_i
  μ_i = peak time (ms)
  σ_i = width (ms)
  s_i = shift (fraction)
```

**Purpose:** Model complex hammer-string interaction

**Typical Parameters:**

```
Curve 0 (initial impact): μ=1ms, σ=0.1ms, A=10, s=0.1
Curve 1 (compression):    μ=2ms, σ=0.4ms, A=3,  s=0.2
Curve 2 (bounce):         μ=2ms, σ=0.6ms, A=2,  s=0.3
Curve 3 (secondary):      μ=2.5ms, σ=1ms, A=1,  s=0.2
Curve 4 (tail):           μ=6ms, σ=0.2ms, A=5,  s=0
```

**Velocity Dependence:**

```
Low velocity (v=10):
  - Soft initial impact (curve 0 reduced)
  - Longer contact (curves 1-2 dominate)

High velocity (v=127):
  - Sharp initial impact (curve 0 large)
  - Multiple bounces (all curves active)
```

**Interpolation:**

```
Base levels: v ∈ {0, 31, 63, 95, 127}
Intermediate: Linear interpolation

Example: v = 47
  Position: 47 between 31 and 63
  Weight: (47-31) / (63-31) = 0.5

  μ₀(47) = 0.5 * μ₀(31) + 0.5 * μ₀(63)
```

---

### 11.4 Detuning Mathematics

**Tension Offset:**

```
T_i = T₀ (1 + i * offset)

where:
  i = string index in chorus (0, 1, 2)
  offset = tension_offset (typically 0.002)
```

**Frequency Relationship:**

```
f = (1 / 2L) sqrt(T/ρ)

f_i / f₀ = sqrt(T_i / T₀) = sqrt(1 + i * offset)

For small offset:
  sqrt(1 + x) ≈ 1 + x/2

  f_i / f₀ ≈ 1 + (i * offset) / 2
```

**Example:**

```
T₀ = 300 N
offset = 0.002

String 0: T = 300.0 N → f/f₀ = 1.0000
String 1: T = 300.6 N → f/f₀ = 1.0010 (+1.7 cents)
String 2: T = 301.2 N → f/f₀ = 1.0020 (+3.5 cents)

Total spread: 3.5 cents (subtle chorus effect)
```

**Musical Context:**

```
1 cent = 1/100 semitone
Piano tuning tolerance: ±1 cent
Unison detuning: 1-5 cents (perceptual richness)
```

---

## 12. Integration with PianoidCore

### 12.1 Import Structure

**PianoidCore → PianoidBasic:**

```python
# In pianoid.py
from Pianoid.StringMap import StringMap
from Pianoid.Mode import ModeMap
from Pianoid.ModelParams import ModelParameters
```

**Package Resolution:**

```
Physical location: C:/Users/astri/PianoidInstall/PianoidBasic/Pianoid/
Import path: Pianoid.StringMap (not PianoidBasic.Pianoid.StringMap)
```

---

### 12.2 Initialization Flow

**File:** `pianoid.py`
**Lines:** 100-250

```python
def initialize(self, preset_name=None, preset_path=None):
    """Initialize Pianoid from preset"""

    # 1. Load preset JSON
    preset = load_preset(preset_name, preset_path)

    # 2. Create StringMap (PianoidBasic)
    self.sm = StringMap(
        pitches=preset['pitches'],
        blocks=preset['blocks'],
        mp=preset['model_parameters']
    )

    # 3. Create ModeMap (PianoidBasic)
    self.modes = ModeMap(
        mode_params=preset['modes'],
        mp=self.sm.mp
    )

    # 4. Pack parameters
    params_tuple = self.sm.pack_parameters()
    mode_state = self.modes.pack_modes()
    cycle_params = self.sm.mp.pack_as_dict_for_cuda()

    # 5. Initialize CUDA
    self.pianoid = pianoidCuda.Pianoid(cycle_params)
    self.pianoid.devMemoryInit(*params_tuple, mode_state)
```

---

### 12.3 Parameter Update Integration

**Two-Stage Pattern:**

```python
# Stage 1: Update PianoidBasic (Python-side)
pitch = sm.pitches[60]
pitch.physics.set_params(tension=350)

# Stage 2: Transfer to CUDA
send_updated_params_to_CUDA()
```

**Current Routes:**

| Parameter Type | Update Method | CUDA Transfer | Status |
|----------------|---------------|---------------|--------|
| String/Physics | `update_pitch_physical_params_GRANULAR()` | `updateMultiStringParameter_NEW()` | ✅ Granular |
| Excitation | `pitch.excitation.load_from_dict()` | `send_updated_params_to_CUDA()` | ⚠️ Bulk |
| Hammer | `sm.update_hammer_shape()` | ❌ MISSING | ❌ Bug |
| Mode | `mode.update_params()` | `send_mode_params_to_CUDA()` | ⚠️ Bulk |
| Deck | `sm.update_deck()` | `send_deck_params_to_CUDA()` | ⚠️ Bulk |

---

### 12.4 Critical Integration Points

**Point 1: Chores Mapping**

```python
# PianoidBasic generates mapping
chores = sm.generate_chores()  # (140, 3)

# CUDA uses for note triggering
pianoidCuda.processMidiPoints(pitch=60, velocity=80)
# Internally: lookup chores[60] = [10, 11, 12]
```

**Point 2: Excitation Length**

```python
# PianoidBasic computes
excitation_length = mp.excitation_length()  # 4608 samples

# CUDA allocates
dev_excitation: (num_strings, excitation_length)
```

**Point 3: GPU Alignment**

```python
# PianoidBasic ensures
num_modes_for_model % num_blocks == 0  # Validation

# CUDA relies on
gridDim = (num_modes_for_model / num_blocks, ...)
```

---

### 12.5 Data Consistency Guarantees

**Consistency Mechanisms:**

1. **Single Source of Truth:** PianoidBasic parameters are canonical
2. **Explicit Packing:** `pack_*()` methods create immutable snapshots
3. **Validation:** Multiple layers prevent invalid configurations
4. **Synchronization Points:** Clear boundaries between Python and CUDA state

**Potential Inconsistencies:**

1. **Hammer Bug:** Python updated, CUDA not
2. **Bulk Uploads:** Entire buffers transferred for single parameter change
3. **Caching:** Chores mapping not regenerated dynamically

---

## Conclusion

The PianoidBasic parameter management system provides a sophisticated, hierarchical architecture for transforming high-level musical concepts into low-level physics parameters suitable for GPU-accelerated simulation. Key strengths include:

1. **Mathematical Rigor:** Finite difference coefficients, mode oscillator integration, and Gaussian synthesis ensure physical accuracy
2. **Flexible Processing:** Detuning, interpolation, and coefficient caching enable rich musical expressiveness
3. **Comprehensive Validation:** Multi-layer validation prevents invalid physics configurations
4. **Efficient Packing:** Optimized data structures for CUDA transfer

However, several areas require attention:

1. **Hammer Update Bug:** Critical fix needed for CUDA transfer
2. **Bulk Upload Inefficiency:** Excitation, mode, and deck updates transfer entire buffers
3. **Granular API Migration:** Only string/physics parameters use optimized granular updates

**Integration with PianoidCore** is well-designed, with clear separation between parameter processing (PianoidBasic) and execution (CUDA), enabling maintainable evolution of both layers.

---

**Document Status:** ✅ Complete and Comprehensive
**Last Updated:** 2025-11-09
**Related:** [PARAMETER_SYSTEM_UNIFIED_DOCUMENTATION.md](PARAMETER_SYSTEM_UNIFIED_DOCUMENTATION.md)
