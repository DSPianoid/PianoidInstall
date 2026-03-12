# Memory Management

## Overview

`UnifiedGpuMemoryManager` is the single point of GPU memory allocation and lifecycle
management for `pianoid_cuda`. It unifies preset (tunable) parameter storage and all
working/output buffers under one class, with asynchronous double-buffering for parameters
that change during playback and direct single-buffering for everything else.

**Files:** `UnifiedGpuMemoryManager.h` / `UnifiedGpuMemoryManager.cu`

---

## BufferCategory Enum

```cpp
enum class BufferCategory {
    TUNABLE,       // Double-buffered preset parameters (~2.93–6.37 MB)
    STATIC_INPUT,  // Single-buffered configuration inputs (~3 MB)
    WORKING,       // Single-buffered intermediate computation (~45 MB)
    OUTPUT,        // Single-buffered audio and state output (~120 MB)
    FILTER_SYSTEM  // FIR convolution buffers (~10 MB)
};
```

Only `TUNABLE` buffers are double-buffered. All other categories use a single GPU
allocation that is overwritten in place.

---

## Tunable Buffer Layout (Preset Parameters)

The tunable region is a packed contiguous block on the GPU defined by `PianoidPresetParameters`
(`PresetParameters.h`). Two identical allocations exist simultaneously — the **working copy**
(read by kernels) and the **updating copy** (written during async updates).

```
PianoidPresetParameters  (USE_SINGLE_DECK_MATRIX=1, float real type)
Total: ~2.93 MB / ~5.86 MB (float / double)

 Offset 0
 +---------------------------+
 | string_physical_parameters|  4,096 reals  (256 strings × 16 params)
 +---------------------------+
 | hammer_shapes             |  24,576 reals (64 arrays × 384 points)
 +---------------------------+
 | excitation_parameters     |  655,360 reals (256 strings × 128 velocities × 20 params)
 +---------------------------+
 | mode_state_parameters     |  1,280 reals  (256 modes × 5 fields)
 +---------------------------+
 | deck_coupling_parameters  |  65,536 reals (256 strings × 256 modes, feedin only)
 +---------------------------+
 | volume_coefficients       |  256 reals    (one per string)
 +---------------------------+
 Total: 751,104 reals
```

`PresetParameterOffsets` provides compile-time byte offsets and typed pointer helpers:

```cpp
struct PresetParameterOffsets {
    static constexpr size_t STRING_PHYSICS_OFFSET = 0;
    static constexpr size_t HAMMER_OFFSET   = STRING_PHYSICS_OFFSET + 4096;
    static constexpr size_t EXCITATION_OFFSET = HAMMER_OFFSET + 24576;
    static constexpr size_t MODE_STATE_OFFSET = EXCITATION_OFFSET + 655360;
    static constexpr size_t DECK_OFFSET     = MODE_STATE_OFFSET + 1280;
    static constexpr size_t VOLUME_OFFSET   = DECK_OFFSET + 65536;
    // Typed pointer helpers: getStringPhysicsPtr(), getHammerPtr(), etc.
};
```

---

## Double-Buffering for TUNABLE Parameters

Parameter updates follow a four-state asynchronous pipeline managed by a background poll
thread and CUDA stream events:

```
UpdateState machine:
  IDLE  ──► UPDATING ──► SWAPPING ──► SYNCING ──► IDLE

  IDLE:      No update in progress; working copy is live; updating copy is identical.
  UPDATING:  Host data is being copied to updating copy via cudaMemcpyAsync on update_stream_.
             GPU kernels continue reading from working copy uninterrupted.
  SWAPPING:  update_complete_event_ has fired. Atomic pointer swap:
               dev_preset_working_  ↔  dev_preset_updating_
             Kernels launched after the swap read the new parameters.
  SYNCING:   New working copy is being synchronised back to new updating copy
             (via another async copy on update_stream_) so both copies are identical again.
  IDLE:      sync_complete_event_ has fired. System returns to idle.
```

The swap is atomic from the GPU's perspective — kernels never observe a partially-updated
parameter block.

Update policy controls behaviour when a second update arrives while one is in progress:

```cpp
enum class UpdatePolicy {
    DROP_IF_BUSY,      // Return false immediately (default)
    BLOCK_UNTIL_READY, // Wait for current update to finish
    QUEUE_NEXT         // Reserved for future implementation
};
```

---

## Preset Library

Multiple presets can be held in CPU memory simultaneously:

```cpp
// Pianoid API (delegates to UnifiedGpuMemoryManager)
void loadPresetToLibrary(
    const std::vector<real>& string_physics,
    const std::vector<real>& hammer_shapes,
    const std::vector<real>& excitation_params,
    const std::vector<real>& mode_state,
    const std::vector<real>& deck_params,
    const std::vector<real>& volume_coeffs
);
bool switchPreset(const std::string& preset_name, bool async = true);
void unloadPresetFromLibrary(const std::string& preset_name);
std::vector<std::string> getLibraryPresets() const;
std::string getActivePreset() const;
```

`switchPreset()` packs the named preset's vectors into the flat `PianoidPresetParameters`
layout and initiates an async TUNABLE update. With `async=false` it blocks until the swap
completes.

---

## Single-Buffered Allocations (Approximate Sizes)

```
STATIC_INPUT (~3 MB)
  dev_cycle_params      — 16 ints packed kernel configuration
  dev_exct_cycle_index  — 256 ints, per-string excitation cycle counter
  dev_string_map        — pitch → string mapping
  dev_dec_open          — damper open/closed state per string

WORKING (~45 MB)
  dev_string_state      — current and previous displacement for all string points
  dev_force_function    — per-string force time series (excitation)
  dev_hammer            — hammer shape staging buffer
  feedin_cycle_matrix   — string→mode force accumulator (zeroed each outer iteration)
  feedback_cycle_matrix — mode→string feedback accumulator (zeroed each outer iteration)

OUTPUT (~120 MB)
  dev_soundInt          — Sint32 audio output (NUM_CHANNELS × samplesInCycle)
  dev_soundFloat        — float audio output  (NUM_CHANNELS × samplesInCycle)
  dev_output_data       — diagnostic / state export buffer
  dev_sound_records     — optional audio record buffer (up to 500 cycles)

FILTER_SYSTEM (~10 MB)
  dev_filter_input_buffers   — per-channel ring buffers for overlap-add
  dev_filter_input_samples   — current cycle input
  dev_filter_output          — convolution output
  dev_filter_partials        — warp-level partial sums
  dev_filter_sums            — per-output-channel accumulated sums
  dev_fir_filters            — FIR coefficient store
```

Total GPU memory in a typical 256-string, 256-mode configuration: approximately **180 MB**.

---

## Buffer Access API

```cpp
// Typed buffer accessors (throw on type mismatch)
real*    getRealBuffer  (const std::string& name) const;
int*     getIntBuffer   (const std::string& name) const;
float*   getFloatBuffer (const std::string& name) const;
double*  getDoubleBuffer(const std::string& name) const;

// Tunable sub-buffer accessors (pointer into working copy)
real* getStringPhysicsPointer() const;
real* getHammerPointer()        const;
real* getExcitationPointer()    const;
real* getModeStatePointer()     const;
real* getDeckPointer()          const;
real* getVolumePointer()        const;

// Diagnostics
size_t getTotalGpuMemoryUsage() const;
void   printMemoryReport()      const;
```

---

## Allocation / Deallocation Lifecycle

```
Construction:
  UnifiedGpuMemoryManager()  — initialises state, not yet allocated

Initialisation (called from Pianoid::devMemoryInit):
  initialize(descriptors)
    registerTunableBuffer() × N  — register TUNABLE sub-buffers with offsets
    registerBuffer()        × N  — register STATIC_INPUT / WORKING / OUTPUT / FILTER_SYSTEM
    cudaMalloc(dev_preset_working_)
    cudaMalloc(dev_preset_updating_)
    cudaMalloc() for each single buffer
    Start background poll thread (updatePollThread)

Runtime:
  updateTunableParameter()  — async double-buffer update
  updateBuffer()            — synchronous direct update

Shutdown (called from Pianoid::shutdownGpu / ~Pianoid):
  shutdown()
    Stop poll thread
    cudaFree() for all allocations
    cudaStreamDestroy(), cudaEventDestroy()
```

---

## Memory Layout Diagram

```
GPU Device Memory
=================

  [dev_preset_working_]   ← kernels always read from this
  +--------------------+
  | string_physics (W) |  4 KB
  | hammer_shapes  (W) |  96 KB
  | excitation     (W) |  2.5 MB
  | mode_state     (W) |  5 KB
  | deck coupling  (W) |  256 KB
  | volume coeffs  (W) |  1 KB
  +--------------------+

  [dev_preset_updating_]  ← async writes during preset switch
  +--------------------+
  | (identical layout) |
  +--------------------+

  [STATIC_INPUT buffers]  ~3 MB  (single allocation each)
  [WORKING buffers]       ~45 MB (single allocation each)
  [OUTPUT buffers]        ~120 MB (single allocation each)
  [FILTER_SYSTEM buffers] ~10 MB (single allocation each)

  Total: ~180 MB
```
