# Pianoid Volume API Guide

**Version:** 2.0 (New Parameter System)
**Date:** 2025-01-12
**Status:** Stable

---

## Table of Contents

1. [Overview](#overview)
2. [Core Concepts](#core-concepts)
3. [API Layers](#api-layers)
4. [Usage Examples](#usage-examples)
5. [Initialization](#initialization)
6. [Runtime Control](#runtime-control)
7. [MIDI Integration](#midi-integration)
8. [Backward Compatibility](#backward-compatibility)
9. [Mathematical Reference](#mathematical-reference)
10. [Troubleshooting](#troubleshooting)

---

## Overview

The Pianoid Volume API provides a unified, thread-safe system for controlling audio volume at both initialization and runtime. The system uses **exponential scaling** to provide perceptually linear volume control.

### Key Features

- **Separation of Concerns**: Initialization parameters vs. runtime parameters
- **Exponential Scaling**: Perceptually linear volume response
- **Thread-Safe**: All operations properly locked for concurrent access
- **MIDI Integration**: Direct CC 7 (Volume) support
- **Backward Compatible**: Legacy API continues to work
- **Type-Safe**: Structure-based parameter management

### Quick Start

```python
# New API: Explicit max_volume
pianoid.init_pianoid(max_volume=8000.0)  # Initialization
pianoid.set_volume_level(80)             # Runtime adjustment (0-127)

# Legacy API: Still works!
pianoid.init_pianoid(main_volume=120)    # Old initialization
pianoid.set_volume(64)                   # Old runtime adjustment
```

---

## Core Concepts

### Two Parameter Types

The volume system separates parameters into two categories:

#### 1. Initialization Parameters
- **Set once** at startup/preset load
- Defines the **maximum** volume range
- Cannot be changed during playback without reinitialization

**Key Parameter:**
- `max_volume` (real, positive): Maximum volume coefficient

#### 2. Runtime Parameters
- **Adjustable** during playback
- Changes volume **within** the range defined by `max_volume`
- Updates take effect immediately without stopping playback

**Key Parameter:**
- `volume_level` (int, 0-127): MIDI-range volume control

### Volume Coefficient Formula

The actual volume coefficient sent to the GPU is calculated as:

```
coefficient = max_volume^(volume_level/127)
```

**Properties:**
- At `volume_level = 0`: coefficient = 1.0 (minimum)
- At `volume_level = 127`: coefficient = max_volume (maximum)
- Exponential curve provides perceptually linear volume

**Example:**
```python
max_volume = 10000.0
volume_level = 64

coefficient = 10000^(64/127)
           ≈ 92.66
```

---

## API Layers

The volume system is accessible at multiple layers:

### Layer 1: C++ Core (Pianoid.cuh / Pianoid.cu)

**Structures:**
```cpp
struct InitializationParameters {
    real max_volume = 10000.0;  // Default fallback

    InitializationParameters() = default;
    explicit InitializationParameters(real max_vol);
};

struct RuntimeParameters {
    int volume_level = 64;  // 0-127 MIDI range

    RuntimeParameters() = default;
    explicit RuntimeParameters(int level);
};
```

**Methods:**
```cpp
// Set/get initialization parameters
void setInitializationParameters(const InitializationParameters& params);
InitializationParameters getInitializationParameters() const;

// Set/get runtime parameters (returns false if validation fails)
bool setRuntimeParameters(const RuntimeParameters& params);
RuntimeParameters getRuntimeParameters() const;
```

**Usage:**
```cpp
#include "Pianoid.cuh"

// Create and set initialization parameters
InitializationParameters init_params(8000.0);
pianoid.setInitializationParameters(init_params);

// Create and set runtime parameters
RuntimeParameters runtime_params(80);
bool success = pianoid.setRuntimeParameters(runtime_params);
```

---

### Layer 2: Python Bindings (pianoidCuda module)

The C++ structures and methods are exposed directly to Python via pybind11:

```python
import pianoidCuda

# Create parameter structures
init_params = pianoidCuda.InitializationParameters(8000.0)
runtime_params = pianoidCuda.RuntimeParameters(80)

# Use with Pianoid instance
pianoid.pianoid.setInitializationParameters(init_params)
pianoid.pianoid.setRuntimeParameters(runtime_params)

# Access attributes
print(init_params.max_volume)        # 8000.0
print(runtime_params.volume_level)   # 80
```

---

### Layer 3: Python Wrapper (pianoid.py)

Convenient wrapper methods for common operations:

```python
# Initialization parameter control
pianoid.set_max_volume(8000.0)
max_vol = pianoid.get_max_volume()

# Runtime parameter control
pianoid.set_volume_level(80)        # 0-127
level = pianoid.get_volume_level()

# Utility method
coeff = pianoid.get_current_volume_coefficient()
```

**Source:** [pianoid.py:314-380](../pianoid_middleware/pianoid.py#L314-L380)

---

### Layer 4: REST API (backendServer.py)

HTTP endpoints for web/frontend integration:

#### Load Preset with Volume

```bash
POST /load_preset
Content-Type: application/json

{
  "path": "presets/my_preset.json",
  "max_volume": 8000.0,    # New API
  "volume": 120,           # Legacy API (ignored if max_volume present)
  ...
}
```

#### Adjust Volume During Playback

```bash
POST /set_runtime_parameters
Content-Type: application/json

{
  "volume": 80  # volume_level (0-127)
}

# Response
{
  "message": "OK",
  "updated": {
    "volume": 80
  }
}
```

**Source:** [backendServer.py:168-196](../pianoid_middleware/backendServer.py#L168-L196), [backendServer.py:500-560](../pianoid_middleware/backendServer.py#L500-L560)

---

### Layer 5: MIDI Integration (pianoidMidiListener.py)

MIDI CC 7 (Volume) directly maps to `volume_level`:

```python
# MIDI CC 7 handler
def main_volume(self, pitch, velocity):
    """MIDI main volume control (CC 7)"""
    # Maps 0-127 directly to volume_level
    success = self.p.set_volume_level(velocity)

    if not success:
        # Fallback to legacy API
        self.p.set_volume(velocity)
```

**Source:** [pianoidMidiListener.py:334-349](../pianoid_middleware/pianoidMidiListener.py#L334-L349)

---

## Usage Examples

### Example 1: Basic Initialization (New API)

```python
from pianoid_middleware.pianoid import Pianoid

# Initialize with explicit max_volume
pianoid = Pianoid(preset=preset_dict, ...)
pianoid.init_pianoid(
    max_volume=8000.0,
    firFilterLength=18432,
    save_params=False
)

# Volume starts at level 64 (middle of range)
# coefficient = 8000^(64/127) ≈ 92.66
```

---

### Example 2: Runtime Volume Adjustment

```python
# During playback, adjust volume level
pianoid.set_volume_level(100)  # Increase volume
# coefficient = 8000^(100/127) ≈ 892.00

pianoid.set_volume_level(40)   # Decrease volume
# coefficient = 8000^(40/127) ≈ 15.32

# Check current state
level = pianoid.get_volume_level()
coeff = pianoid.get_current_volume_coefficient()
print(f"Level: {level}, Coefficient: {coeff:.2f}")
```

---

### Example 3: REST API Integration

```javascript
// Load preset with custom volume
fetch('http://localhost:5000/load_preset', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    path: 'presets/grand_piano.json',
    max_volume: 8000.0,
    audio_on: 1,
    // ... other parameters
  })
});

// Adjust volume during playback
fetch('http://localhost:5000/set_runtime_parameters', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    volume: 90  // volume_level
  })
});
```

---

### Example 4: MIDI Control

```python
# Send MIDI CC 7 (Volume) message
# Controller automatically maps to volume_level

# MIDI message: CC 7, value 100
# → pianoid.set_volume_level(100)
# → coefficient = max_volume^(100/127)

# Full MIDI range supported (0-127)
# 0   → minimum volume (coefficient = 1.0)
# 64  → medium volume (coefficient ≈ sqrt(max_volume))
# 127 → maximum volume (coefficient = max_volume)
```

---

### Example 5: Legacy API (Backward Compatible)

```python
# Old initialization method
pianoid.init_pianoid(
    main_volume=120,  # Legacy parameter
    firFilterLength=18432,
    save_params=False
)

# Middleware automatically calculates equivalent max_volume:
# legacy_coeff = exp((120 + 64) / 8) ≈ 9,744,803,840
# max_volume = 9,744,803,840^(127/64) ≈ 6.6e19

# Old volume adjustment
pianoid.set_volume(80)
# Still uses legacy formula: exp((120 + 80) / 8)
```

---

## Initialization

### New API: Explicit max_volume

**Recommended** for new code and presets.

```python
pianoid.init_pianoid(
    max_volume=8000.0,      # Maximum volume coefficient
    firFilterLength=18432,
    save_params=False,
    use_placeholder=False
)
```

**How it works:**
1. Middleware receives `max_volume=8000.0`
2. Creates `InitializationParameters(8000.0)`
3. Sets `volume_level=64` (default middle level)
4. Calculates coefficient: `8000^(64/127) ≈ 92.66`
5. Writes coefficient to GPU memory

**Source:** [pianoid.py:1364-1373](../pianoid_middleware/pianoid.py#L1364-L1373)

---

### Legacy API: main_volume

**Still supported** for backward compatibility.

```python
pianoid.init_pianoid(
    main_volume=120,        # Legacy volume parameter
    firFilterLength=18432,
    save_params=False,
    use_placeholder=False
)
```

**How it works:**
1. Middleware receives `main_volume=120`, `max_volume=None`
2. **Calculates equivalent max_volume:**
   ```python
   legacy_coeff_at_64 = exp((120 + 64) / 8) ≈ 9,744,803,840
   calculated_max_volume = 9,744,803,840^(127/64) ≈ 6.6e19
   ```
3. Creates `InitializationParameters(6.6e19)`
4. Sets `volume_level=64`
5. Calculates coefficient: `6.6e19^(64/127) ≈ 9,744,803,840` ✓
6. **Result:** Same coefficient as legacy formula!

**Source:** [pianoid.py:1374-1405](../pianoid_middleware/pianoid.py#L1374-L1405)

---

### Via REST API

```bash
# New API
curl -X POST http://localhost:5000/load_preset \
  -H "Content-Type: application/json" \
  -d '{
    "path": "presets/my_preset.json",
    "max_volume": 8000.0,
    "audio_on": 1,
    "sample_rate": 44100,
    "cycle_iterations": 100,
    "string_iterations": 12,
    "buffer_size": 2
  }'

# Legacy API
curl -X POST http://localhost:5000/load_preset \
  -H "Content-Type: application/json" \
  -d '{
    "path": "presets/my_preset.json",
    "volume": 120,
    "audio_on": 1,
    ...
  }'
```

---

## Runtime Control

### Python API

```python
# Set volume level (0-127)
success = pianoid.set_volume_level(80)
if not success:
    print("Invalid volume level (must be 0-127)")

# Get current volume level
level = pianoid.get_volume_level()
print(f"Current volume level: {level}")

# Get current coefficient
coeff = pianoid.get_current_volume_coefficient()
print(f"Current coefficient: {coeff:.2f}")

# Get max_volume setting
max_vol = pianoid.get_max_volume()
print(f"Max volume: {max_vol:.2f}")
```

**Source:** [pianoid.py:342-380](../pianoid_middleware/pianoid.py#L342-L380)

---

### REST API

```bash
# Adjust volume during playback
curl -X POST http://localhost:5000/set_runtime_parameters \
  -H "Content-Type: application/json" \
  -d '{"volume": 80}'

# Response
{
  "message": "OK",
  "updated": {
    "volume": 80
  }
}

# Error response (invalid value)
curl -X POST http://localhost:5000/set_runtime_parameters \
  -H "Content-Type: application/json" \
  -d '{"volume": 200}'

# Response
{
  "error": "Invalid volume_level: 200 (must be 0-127)"
}
```

**Source:** [backendServer.py:500-560](../pianoid_middleware/backendServer.py#L500-L560)

---

### Direct C++ API

```cpp
#include "Pianoid.cuh"

// Create runtime parameters
RuntimeParameters params(80);

// Update volume
bool success = pianoid.setRuntimeParameters(params);
if (!success) {
    printf("ERROR: Invalid volume_level\n");
}

// Query current state
RuntimeParameters current = pianoid.getRuntimeParameters();
printf("Current volume_level: %d\n", current.volume_level);
```

---

## MIDI Integration

### CC 7 (Volume)

The MIDI listener automatically maps CC 7 to the volume parameter system:

```python
# In pianoidMidiListener.py
def main_volume(self, pitch, velocity):
    """
    MIDI CC 7 (Volume) handler

    Args:
        pitch: MIDI channel (not used for CC)
        velocity: MIDI value (0-127) → volume_level
    """
    success = self.p.set_volume_level(velocity)

    if not success:
        # Fallback to legacy API if new API unavailable
        self.p.set_volume(velocity)
```

### MIDI Volume Curve

```
MIDI Value → volume_level → coefficient
-----------------------------------------
0          → 0            → 1.0 (minimum)
32         → 32           → max_volume^(32/127) ≈ 9.63 (for max_volume=8000)
64         → 64           → max_volume^(64/127) ≈ 92.66
96         → 96           → max_volume^(96/127) ≈ 892.00
127        → 127          → max_volume (maximum)
```

**Perceptually Linear:** The exponential curve compensates for human hearing's logarithmic response, making volume changes feel linear to the listener.

---

## Backward Compatibility

### What Still Works

All legacy code continues to function without changes:

#### 1. Legacy Initialization

```python
# OLD CODE (still works)
pianoid.init_pianoid(main_volume=120)
```

**Automatic Conversion:**
- Middleware calculates equivalent `max_volume`
- New API used internally
- Same audio output as before

#### 2. Legacy Volume Adjustment

```python
# OLD CODE (still works)
pianoid.set_volume(64)
```

**Behavior:**
- Uses legacy formula: `exp((main_volume + 64) / 8)`
- Directly updates GPU coefficient
- Bypasses new parameter system

#### 3. Legacy REST Endpoints

```bash
# OLD CODE (still works)
POST /load_preset
{
  "volume": 120,  # Legacy parameter name
  ...
}
```

**Automatic Handling:**
- If `max_volume` absent, uses `volume` as `main_volume`
- Middleware performs conversion
- Same initialization as before

---

### Migration Path

To adopt the new API:

#### Step 1: Update Initialization

```python
# Before
pianoid.init_pianoid(main_volume=120)

# After
pianoid.init_pianoid(max_volume=8000.0)
```

**How to choose max_volume:**
- For equivalent volume to `main_volume=120` at level 64:
  ```python
  max_volume = exp((120 + 64) / 8) ** (127/64) ≈ 6.6e19
  ```
- For reasonable range: `max_volume = 8000.0` to `15000.0`
- For subtle control: `max_volume = 1000.0` to `5000.0`

#### Step 2: Update Runtime Control

```python
# Before
pianoid.set_volume(80)

# After
pianoid.set_volume_level(80)
```

#### Step 3: Update REST Calls

```javascript
// Before
fetch('/load_preset', {
  body: JSON.stringify({ volume: 120, ... })
});

// After
fetch('/load_preset', {
  body: JSON.stringify({ max_volume: 8000.0, ... })
});
```

**Note:** Both can coexist during transition period.

---

## Mathematical Reference

### Volume Coefficient Formulas

#### New API Formula

```
coefficient = max_volume^(volume_level/127)
```

**Domain:**
- `max_volume` ∈ (0, ∞) (positive real)
- `volume_level` ∈ [0, 127] (integer)
- `coefficient` ∈ [1.0, max_volume]

#### Legacy API Formula

```
coefficient = exp((main_volume + velocity) / 8)
```

**Domain:**
- `main_volume` ∈ ℝ (any real)
- `velocity` ∈ [0, 127] (integer)
- `coefficient` ∈ (0, ∞)

---

### Conversion Between APIs

To convert legacy `main_volume` to equivalent `max_volume`:

**Given:** Legacy initialization with `main_volume` at default `velocity=64`

**Calculate:**
```python
# Step 1: Calculate legacy coefficient at velocity=64
legacy_coeff = exp((main_volume + 64) / 8)

# Step 2: Solve for max_volume that produces same coefficient at level=64
# max_volume^(64/127) = legacy_coeff
# max_volume = legacy_coeff^(127/64)
max_volume = legacy_coeff ** (127.0 / 64.0)
```

**Example:**
```python
main_volume = 120

# Legacy coefficient at velocity=64
legacy_coeff = exp((120 + 64) / 8) = exp(23) ≈ 9,744,803,840

# Equivalent max_volume
max_volume = 9,744,803,840 ** (127/64) ≈ 6.6293602961733476352e19

# Verification
new_coeff = (6.6e19) ** (64/127) ≈ 9,744,803,840 ✓
```

---

### Exponential Curve Properties

The exponential formula provides **perceptually linear** volume control:

#### Human Hearing Response

Human hearing perceives loudness logarithmically:
- Doubling amplitude → perceived as small increase
- 10x amplitude → perceived as "twice as loud"

#### Exponential Compensation

The formula `coefficient = max_volume^(volume_level/127)` creates an exponential curve:
- Small changes at low levels → small coefficient changes
- Same absolute changes at high levels → larger coefficient changes
- Result: Perceived volume changes feel linear

#### Visual Representation

For `max_volume = 10000`:

```
Level    Coefficient    Perceived
-----    -----------    ---------
0        1.0            Silent
16       2.19           Very Quiet
32       4.81           Quiet
48       10.56          Soft
64       23.16          Medium
80       50.80          Loud
96       111.45         Very Loud
112      244.50         Extremely Loud
127      10000.0        Maximum
```

**Note:** Each 16-level increment roughly doubles the coefficient, creating perceptually equal steps.

---

### Coefficient Range Examples

| max_volume | Level 0 | Level 64 | Level 127 | Use Case |
|------------|---------|----------|-----------|----------|
| 1000.0     | 1.0     | 9.26     | 1000.0    | Subtle control |
| 5000.0     | 1.0     | 41.68    | 5000.0    | Moderate range |
| 10000.0    | 1.0     | 92.66    | 10000.0   | Standard range |
| 50000.0    | 1.0     | 412.89   | 50000.0   | Wide range |
| 6.6e19     | 1.0     | 9.7e9    | 6.6e19    | Legacy equivalent |

---

## Troubleshooting

### Problem: Volume Too Low After Parameter Update

**Symptoms:**
- Sound plays normally after initialization
- After calling `/set_runtime_parameters`, volume becomes very quiet or inaudible
- System doesn't crash, just very low volume

**Cause:**
- Mismatch between initialization `max_volume` and runtime expectations
- Legacy initialization produced large coefficient (~9.7 billion)
- New API using default `max_volume=10000` produces tiny coefficient (~100)
- Result: 94 million times quieter!

**Solution:**
When initializing with legacy API, middleware automatically calculates appropriate `max_volume`. Ensure you're using consistent APIs:

```python
# Option 1: Use new API consistently
pianoid.init_pianoid(max_volume=8000.0)
pianoid.set_volume_level(80)

# Option 2: Use legacy API consistently
pianoid.init_pianoid(main_volume=120)
pianoid.set_volume(80)  # Use old method, not set_volume_level

# DON'T MIX: Initialize with legacy, adjust with new
pianoid.init_pianoid(main_volume=120)  # Creates max_volume ≈ 6.6e19
pianoid.set_volume_level(80)           # ✓ Now works! Middleware handles it
```

**Debug:** Check initialization logs for calculated `max_volume`:
```
Initializing with legacy volume API: main_volume=120, velocity=64
  Legacy coefficient at level 64: 9744803840.00
  Calculated max_volume for new API: 6.629360e+19
  Verification: New API coefficient = 9744803840.00
  Match: True
```

---

### Problem: Playback Stops After Volume Update

**Symptoms:**
- System playing normally
- Call `/set_runtime_parameters`
- Playback stops completely
- Logs show: "WARNING: Ignoring note command - playback not active"

**Cause:**
- Missing thread safety in volume parameter methods
- Race condition between playback thread and parameter update
- CUDA operation interrupted audio processing

**Solution:**
Ensure all volume methods use `cuda_lock` (fixed in [pianoid.py:342-370](../pianoid_middleware/pianoid.py#L342-L370)):

```python
def set_volume_level(self, level):
    import pianoidCuda
    runtime_params = pianoidCuda.RuntimeParameters(level)

    # CRITICAL: Lock CUDA operations
    with self.cuda_lock:
        success = self.pianoid.setRuntimeParameters(runtime_params)

    return success
```

**Status:** This issue was fixed in commit `f49a5a2`.

---

### Problem: Invalid Volume Level Errors

**Symptoms:**
- REST API returns: "Invalid volume_level: X (must be 0-127)"
- `set_volume_level()` returns `False`

**Cause:**
- Volume level outside valid range [0, 127]

**Solution:**
Validate input before sending:

```python
def safe_set_volume_level(pianoid, level):
    if not (0 <= level <= 127):
        print(f"ERROR: volume_level must be 0-127, got {level}")
        return False

    return pianoid.set_volume_level(level)
```

**MIDI:** MIDI controllers automatically constrain to 0-127, so this only affects programmatic control.

---

### Problem: Volume Changes Not Audible

**Symptoms:**
- `set_volume_level()` returns `True`
- No error messages
- Volume doesn't seem to change

**Possible Causes:**

#### 1. max_volume Too Small
```python
# Problematic
pianoid.init_pianoid(max_volume=10.0)  # Very small range
pianoid.set_volume_level(64)           # coefficient ≈ 0.93
pianoid.set_volume_level(127)          # coefficient = 10.0 (only 10x difference)
```

**Solution:** Use larger `max_volume` (1000-10000 range typical)

#### 2. Volume Level Too Low
```python
pianoid.set_volume_level(5)  # coefficient ≈ 1.2 (barely audible)
```

**Solution:** Use level 50-100 for audible range

#### 3. Audio Output Muted
Check system audio output settings and Pianoid audio state:
```python
if not pianoid.audioOn:
    print("Audio output disabled")
```

---

### Problem: Coefficient Calculation Mismatch

**Symptoms:**
- Debug logs show different coefficients than expected
- Manual calculation doesn't match system output

**Debug Steps:**

```python
import math

# Get current state
max_vol = pianoid.get_max_volume()
level = pianoid.get_volume_level()
coeff = pianoid.get_current_volume_coefficient()

# Calculate expected coefficient
expected = max_vol ** (level / 127.0)

# Compare
print(f"Expected: {expected:.6f}")
print(f"Actual:   {coeff:.6f}")
print(f"Match:    {abs(expected - coeff) < 0.01}")
```

**Common Issues:**
- Integer division: Use `127.0` not `127`
- Floating point precision: Allow small tolerance (~0.01)
- Wrong max_volume: Check initialization logs

---

### Testing Volume API

Use the built-in test chart function:

```bash
curl -X POST http://localhost:5000/get_chart_test \
  -H "Content-Type: application/json" \
  -d '{
    "chartType": "test_volume_parameters",
    "max_volume": 8000,
    "volume_level": 80
  }'
```

**Test Output:**
```
✓ Get init params: max_volume = 10000.00
✓ Get runtime params: volume_level = 64
✓ Set init params: max_volume = 8000.00
✓ Set runtime params: volume_level = 80

Volume Coefficient Calculation:
  level=  0: coefficient =       1.00
  level= 32: coefficient =       9.63
  level= 64: coefficient =      92.66
  level= 96: coefficient =     892.00
  level=127: coefficient =    8000.00

Parameter Validation:
  ✓ Rejected volume_level = -10
  ✓ Rejected volume_level = 200
```

**Source:** [chartFunctions.py:1129-1300](../pianoid_middleware/chartFunctions.py#L1129-L1300)

---

## Related Documentation

- [VOLUME_SYSTEM_REFACTORING_SUMMARY.md](../VOLUME_SYSTEM_REFACTORING_SUMMARY.md) - Complete refactoring implementation details
- [PIANOID_CORE_DOCUMENTATION.md](../PIANOID_CORE_DOCUMENTATION.md) - Core architecture overview
- [CHART_API_DOCUMENTATION.md](CHART_API_DOCUMENTATION.md) - Testing via Chart API
- [Pianoid.cuh](../../pianoid_cuda/Pianoid.cuh) - C++ API reference
- [pianoid.py](../../pianoid_middleware/pianoid.py) - Python API reference

---

## Version History

- **v2.0** (2025-01-12): New parameter structure system with middleware defaults
- **v1.0** (2024-xx-xx): Legacy exponential formula system

---

**Questions or Issues?**
See [troubleshooting section](#troubleshooting) or check implementation in source files.
