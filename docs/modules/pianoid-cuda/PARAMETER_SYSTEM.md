# Parameter System

## Overview

The parameter system defines how physical string properties reach the GPU synthesis
kernel. Parameters are organised into two tiers: **physical parameters** (16 values per
string, stored in the TUNABLE double-buffered preset region) and **runtime parameters**
(volume, deck feedback, adjustable without a preset switch). Two update APIs are
provided: a granular per-string API and a bulk preset API.

---

## ParameterInfo Registry

**File:** `ParameterInfo.h`

Each physical parameter is described by a `ParameterInfo` record containing its memory
layout relative to the start of `dev_physical_parameters`:

```cpp
struct ParameterInfo {
    const char* name;                 // "tension", "stiffness", etc.
    size_t offset_from_buffer_start;  // bytes from buffer start (= index × sizeof(real))
    size_t stride_bytes;              // bytes to the same param on the next string
    size_t count;                     // number of strings (256)
    const char* description;

    size_t offsetFor(int index) const;      // byte offset for string[index]
    size_t realOffsetFor(int index) const;  // real offset for string[index]
};
```

`stride_bytes` equals `PHYSICAL_PARAMETERS_NUMBER * sizeof(real)` (16 × sizeof(real))
because the layout is interleaved: all 16 parameters for string 0, then all 16 for
string 1, and so on.

---

## Physical Parameters (16 per string)

Defined in `ParameterInfoRegistry` (`ParameterInfo.h`):

```
Index  Name                      Description
-----  ----                      -----------
  0    string_length             Number of spatial points in string
  1    tail                      Tail point count
  2    radius                    String radius (r)
  3    density                   Density coefficient (coeff_ro)
  4    stiffness                 Young's modulus coefficient (coeff_E)
  5    tension                   String tension
  6    damping                   Damping coefficient (coeff_gamma)
  7    dx                        Spatial step size
  8    volume_coefficient        Per-string volume scaling (deprecated, always 1.0)
  9    position_in_array         Position in the GPU array block
 10    hammer_position           Strike point (hammer center)
 11    outer_sound               Outer sound channel coefficient
 12    frequency_damping         Frequency-dependent damping
 13    damper_string             Damper string coefficient
 14    dump_coeff_tail           Tail damping coefficient
 15    reserved                  Reserved
```

All 16 parameters for all 256 strings occupy 4,096 reals at the start of the preset
block (see [MEMORY_MANAGEMENT.md](MEMORY_MANAGEMENT.md)).

---

## Parameter Categories

The preset block groups parameters by function:

```
Category             Buffer name                    Update method
--------------------------------------------------------------------
String physics       dev_physical_parameters        setNewPhysicalParameters()
Hammer shape         dev_hammer                     setNewHammerParameters()
Excitation shape     dev_gauss_params_full          setNewExcitationBaseLevels()
Mode properties      dev_mode_state                 setNewModeParameters()
Deck coupling        dev_deck_parameters            setNewDeckParameters()
Volume scaling       dev_volume_coeff               setNewPhysicalParameters()
                                                    (volume_coeff is embedded)
```

All of these categories are part of the TUNABLE double-buffered region and update
asynchronously without interrupting the active synthesis cycle.

Runtime parameters (not in the preset):

```cpp
struct RuntimeParameters {
    int  volume_level          = 64;   // 0–127 MIDI range
    real deck_feedback_coefficient = 1.0; // deck coupling scalar
};
```

`setRuntimeParameters(params)` applies these immediately; no double-buffer swap is needed
because they are scalar values copied via atomic or direct `cudaMemcpy`.

---

## Granular API (Phase 6B/6C)

Allows updating individual parameters for specific strings without transmitting the
entire preset block.

### Single-string update

```cpp
bool Pianoid::updateSingleStringParameter_NEW(
    const std::string& param_name,  // e.g. "tension", "stiffness"
    int string_index,               // 0–255
    real new_value
);
```

1. Look up `ParameterInfo` in `ParameterInfoRegistry::PARAMETER_MAP`.
2. Read the current working-copy preset from GPU (`readTunableBuffer`).
3. Overwrite the target element at `realOffsetFor(string_index)`.
4. Upload the modified buffer back via `updateTunableParameter()` (async, double-buffered).

### Multi-string batch update

```cpp
bool Pianoid::updateMultiStringParameter_NEW(
    const std::string& param_name,
    const std::vector<int>& string_indices,
    const std::vector<real>& new_values
);
```

Performs one read, modifies all listed strings in place, and performs one upload — more
efficient than calling the single-string API N times.

Both methods return `false` if the parameter name is not found or if the async update
pipeline drops the request (governed by `UpdatePolicy`).

---

## Bulk API (Preset-Based)

The traditional path sends entire parameter arrays at once:

```cpp
// Load one preset into CPU memory library
void loadPresetToLibrary(
    const std::vector<real>& string_physics,    // 256 × 16 reals
    const std::vector<real>& hammer_shapes,     //  64 × 384 reals
    const std::vector<real>& excitation_params, // 256 × 128 × 20 reals
    const std::vector<real>& mode_state,        // 256 × 5 reals
    const std::vector<real>& deck_params,       // 256 × 256 reals
    const std::vector<real>& volume_coeffs      // 256 reals
);

// Activate a preset (triggers async double-buffer swap)
bool switchPreset(const std::string& preset_name, bool async = true);
```

Category-level updates without a full preset switch:

```cpp
bool setNewPhysicalParameters(const std::vector<real>& physical_parameters,
                               const std::vector<real>& volume_coeff);
bool setNewExcitationParameters(const std::vector<real>& new_gauss_params);
bool setNewHammerParameters(const std::vector<real>& force);
bool setNewModeParameters(const std::vector<real>& mode_state);
bool setNewDeckParameters(const std::vector<real>& deck_parameters);
```

Each of these calls `UnifiedGpuMemoryManager::updateTunableParameter()` for the
corresponding named sub-buffer.

---

## Double-Buffer Swap Mechanism

Both the granular and bulk APIs ultimately reach the same swap pipeline in
`UnifiedGpuMemoryManager`. The sequence for one parameter update:

```
1. updateTunableParameter(name, data)
     If UpdateState != IDLE:
       DROP_IF_BUSY → return false
       BLOCK_UNTIL_READY → wait for IDLE
     Else:
       Update host_preset_ at correct offset
       cudaMemcpyAsync: host_preset_ → dev_preset_updating_  (on update_stream_)
       State → UPDATING

2. (poll thread): update_complete_event_ fires
       swap: dev_preset_working_ ↔ dev_preset_updating_
       updateDerivedPointers()  (refresh all sub-pointers in Pianoid)
       cudaMemcpyAsync: dev_preset_working_ → dev_preset_updating_  (sync)
       State → SYNCING

3. (poll thread): sync_complete_event_ fires
       State → IDLE
```

GPU kernels launched after step 2 will use the new parameters; kernels in flight during
step 2 continue reading the previous working copy uninterrupted.

---

## REST to GPU Parameter Flow

```
REST API request (JSON)
        |
        v
Python middleware (PianoidCore Python module)
        |  parse parameter name and value(s)
        |
        v
Pianoid.updateSingleStringParameter_NEW(name, index, value)
 OR
Pianoid.setNewPhysicalParameters(vector)
        |
        v
UnifiedGpuMemoryManager::updateTunableParameter(name, data)
        |
        v
  [UPDATING state]
  cudaMemcpyAsync → dev_preset_updating_
        |
        v
  [SWAPPING state]
  pointer swap: working ↔ updating
        |
        v
  [SYNCING state]
  cudaMemcpyAsync → new updating copy
        |
        v
  [IDLE]
  addKernel reads new parameters from dev_preset_working_
```

---

## Volume Calculation

Volume uses an exponential mapping over the MIDI 0–127 range:

```
volume_base        = max_volume ^ (1 / 127)
volume_coefficient = max_volume ^ (volume_level / 127)
                   = volume_base ^ volume_level
```

`max_volume` is set in `InitializationParameters` at construction time.
`volume_level` (0–127) is part of `RuntimeParameters` and can be changed during playback
via `setRuntimeParameters()`.

Helper methods on `Pianoid`:

```cpp
real calculateVolumeBase()        const;  // max_volume^(1/127)
real calculateVolumeCoefficient() const;  // max_volume^(volume_level/127)
```

The coefficient is uploaded to `dev_main_volume_coeff` and applied in `addKernel`:

```cpp
soundInt[sampleIndex] = static_cast<Sint32>(diff_result * main_volume_coefficient);
```

---

## Parameter Lookup

```cpp
// ParameterInfo.h
namespace ParameterInfoRegistry {
    inline const ParameterInfo* findByName(const std::string& name);
    inline bool isValidStringIndex(int index);
}
```

`findByName()` performs an O(1) lookup in `PARAMETER_MAP` (an
`std::unordered_map<std::string, const ParameterInfo*>`).

`ParameterInfo::realOffsetFor(index)` returns the offset in units of `real` from the
start of `dev_physical_parameters`:

```cpp
realOffset = (param_index_in_layout * sizeof(real)
              + index * PHYSICAL_PARAMETERS_NUMBER * sizeof(real))
             / sizeof(real)
           = param_index_in_layout + index * 16
```
