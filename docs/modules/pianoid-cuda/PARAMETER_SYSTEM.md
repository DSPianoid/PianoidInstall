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

### Derived parameters must be sent explicitly (granular path)

The granular path sends **only** the parameters present in the incoming update dict —
it does **not** repack via `PhysicalParameters.pack()`. The bulk path *does* repack, so
`pack()` recomputes every derived value (notably `dx = length / p_main`) automatically.

This asymmetry matters for **geometry-derived** parameters. `length` (main-section
physical length, metres) is *not* a GPU parameter — only `dx` (index 7) is. When `length`
changes on the granular path, the middleware must **recompute `dx` and add it to the
update dict itself**; otherwise the GPU `dx` slot keeps its stale preset-load value and
the edit has no audible effect. `ParameterManager.update_pitch_physical_params_GRANULAR`
does this: on a `length` edit it injects `params['dx'] = pitch.geometry.dx()` so the
upload loop sends `updateMultiStringParameter_NEW("dx", ...)`. See
`docs/architecture/DATA_FLOWS.md` §2.1.

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

## Host-Side CFL Stability Gate (physical params — GRANULAR path)

Before a **granular** string edit reaches the kernel, the middleware runs a host-side Courant/CFL
stability check so a destabilising edit cannot diverge the FDTD solver. The guard
`ParameterManager._skip_unstable_physical_upload(pitches)` is called inside
`update_pitch_physical_params_GRANULAR` (the `updateMultiStringParameter_NEW` per-string path — the
Strings-panel edit path), immediately before the GPU upload, after the Python model already holds the
edit. It computes the FDTD amplification `max|g|` (closed form, `cfl_stability.py`, per-string
`tension_offset` honored) over the affected pitch's *current* model physics:

- **reject** — when the edit breaches the CFL **safety** bound: either the worst-string **Courant number**
  `(coeff_tension − 8·coeff_bending) ≥ CFL_MARGIN` (the upper-edge headroom, default `0.99`) **or**
  `max|g| > 1` (true divergence / the lower bending edge) → **raise the `cfl_redline` flag and skip the
  upload**. The edit stays in the Python model; the GPU buffer keeps its last *stable* values, so the
  engine never receives unsafe coefficients and never crashes (no partial write — the granular C++ path
  read-modifies the current buffer, so a skipped call changes nothing).
- **accept** — Courant number `< CFL_MARGIN` **and** `max|g| ≤ 1` → clear the flag and upload normally.

This is **skip-the-upload, not reject-the-edit** (no exception/4xx). The flag is surfaced to the UI via
`/health` + the `param_ack`/REST edit response (a "CFL" warning chip).

**The acceptance threshold — `CFL_MARGIN` (Courant number, default `0.99`).** The exact upper-edge
boundary is the Courant number reaching `1.0` (`max|g| = 1`, lossless). The middleware gate rejects ~1%
*before* that, at `CFL_MARGIN = 0.99`, to give the **float32** engine headroom (it runs float32 with
boundary + force terms and accumulates over thousands of steps, so a config the float64 closed-form
scores exactly `|g| = 1.0` can still creep up live). The margin is applied to the **Courant number**, not
`max|g|` — below the upper edge `|g|` is *flat* at `1.0` then jumps past the edge, so it cannot encode a
fractional headroom; the Courant number rises monotonically with tension and does. `CFL_MARGIN` lives in
`cfl_stability.py` (`is_stable_with_margin`) as a **clearly-named, easily-tunable** constant — raise toward
`1.0` for less headroom (`1.0` = the exact boundary, no margin), lower for more. The margin tightens only
the **upper** edge; the exact `max|g| ≤ 1` test still runs so the lower (bending) edge is caught. The
read-only `stability_ratio` endpoint reports the **exact** `max|g|` (the true boundary), not the
margin-shifted threshold. Verified through the live granular gate at targeted Courant numbers
(`docs/development/diagnostics/dev-eac2-cfl-margin-verify.py`): boundary exactly at `0.99` — courant `0.98`
accepted, `0.995` rejected (was accepted pre-margin since `|g| = 1.0`).

> **`CFL_LIMIT` must stay `1.0` — the margin is NOT here.** `CFL_LIMIT` is the *exact* `max|g|` boundary
> (a lossless string sits at exactly `1.0`). `is_stable_amp` tests `max|g| ≤ CFL_LIMIT + 1e-6`. Lowering
> `CFL_LIMIT` (e.g. to `0.96`) makes `is_stable_amp` reject **every** real string (all have `|g| = 1.0`), so
> the gate rejects every edit and the `cfl_redline` flag never clears. The safety headroom belongs in
> `CFL_MARGIN` (the Courant number), never in `CFL_LIMIT`.

**`cfl_redline` flag lifecycle.** The flag is owned by `ParameterManager` (sole writer via `_set_cfl_redline`
/ `_clear_cfl_redline`). It is **raised** when the granular gate rejects an upload, and **cleared** when:
(1) a subsequent **safe** value is uploaded through the granular gate (the accept branch of
`_skip_unstable_physical_upload`); and (2) a **preset switch** occurs — `Pianoid.switch_preset` (library
switch, which reuses the `ParameterManager`) calls `_clear_cfl_redline`, and the **APPLY** path
(`POST /load_preset`) both recreates the `Pianoid` (fresh `ParameterManager`, flag `False`) and clears
explicitly after `initialize()`. A fresh preset = fresh stability state, so no stale redline survives a load
or switch.

Output/"sound" pitches (`>= 128`, placeholder physics) and modes are not gated. Derivation:
[SYNTHESIS_ENGINE.md "FDTD Stability (CFL/Courant) Bound"](SYNTHESIS_ENGINE.md#fdtd-stability-cfl--courant-bound).

**Scope (the two upload paths).** There are exactly two logical paths that write
`dev_physical_parameters` (see [DATA_FLOWS.md §2.1](../../architecture/DATA_FLOWS.md#21-stringphysics-parameters-granular-path)):
the **granular** path above (gated), and the **bulk** repack-all path
(`update_pitch_physical_params` → `setNewPhysicalParameters`/`setNewHammer`/`setNewExcitation`, reached
by the MIDI-CC knobs and `NoteTunner` auto-tune; plus its init-time variant
`send_updated_params_to_CUDA` → `setUpdatedParameters`). **The bulk path is currently NOT gated**
(an earlier all-path gate was reverted 2026-05-30 per the user; the final placement across the bulk
path is an open decision). The `_skip_unstable_physical_upload` helper is written path-independently
(accepts a list of pitches) so it can be reused at the bulk sites without change if the gate is later
extended there.

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
       swap: dev_preset_working_ ↔ dev_preset_updating_   (under update_mutex_)
       publish new working base (release atomic) + raise swap_pending_
         — the poll thread does NOT write Pianoid's sub-pointers (P1 single-owner)
       cudaMemcpyAsync: dev_preset_working_ → dev_preset_updating_  (sync)
       State → SYNCING

2b. (engine thread, top of next runSynthesisKernel): refreshSwappablePointersIfPending()
       consumeSwapPending() (acquire) → recompute dev_physical_parameters / dev_hammer /
       dev_gauss_params_full / dev_mode_state / dev_deck_parameters from the published base.
       This is the SOLE writer of those members.

3. (poll thread): sync_complete_event_ fires
       State → IDLE
```

GPU kernels launched after the engine adopts the swap (step 2b) use the new parameters; kernels in
flight during step 2 continue reading the previous working copy uninterrupted. **The host-side
sub-pointer refresh moved from the poll thread (step 2) to the engine thread (step 2b) to fix a C++
data race** — the poll thread used to write those members (`updateDerivedPointers`-style loop) while
the engine read them lock-free. The members now have one owner (the engine thread); the poll thread
publishes the base via a release/acquire atomic. See
[MEMORY_MANAGEMENT.md](MEMORY_MANAGEMENT.md#host-side-sub-pointer-ownership-p1-single-owner--dev-427c-2026-05-29)
and SYSTEM_OVERVIEW.md "GPU preset pointer ownership".

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
