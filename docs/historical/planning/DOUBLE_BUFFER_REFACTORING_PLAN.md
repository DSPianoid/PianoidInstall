# Pianoid Double-Buffer Parameter Update Refactoring Plan

**Document Version:** 1.0
**Date:** 2025-10-14
**Purpose:** Implement lock-free double-buffered parameter updates for glitch-free playback
**Status:** Design Phase
**Related:** PARAMETER_REFACTORING_PLAN.md (Phase 2 complete)

---

## Executive Summary

### Objective

Refactor the parameter update mechanism to use a **triple-copy architecture** (1 host + 2 GPU) with atomic double-buffering to eliminate audio glitches and synchronization stalls during parameter updates.

### Key Requirements

1. **Three Copies:** 1 host-side + 2 GPU-side (Working + Updating)
2. **Lock-Free Playback:** Audio engine never blocks on parameter updates
3. **Atomic Swap:** Working ↔ Updating swap is a single pointer assignment
4. **Sequential Updates:** Only one update operation allowed at a time
5. **Consistency:** All three copies identical when no update is in progress

### Benefits

- **Glitch-Free Audio:** Kernel always reads from stable Working copy
- **Zero Blocking:** Parameter updates never stall audio playback
- **Minimal Latency:** Updates take effect at next kernel launch (~2-3ms)
- **Safe Concurrent Access:** No race conditions between update and playback
- **Simple Rollback:** Failed updates don't affect playback

---

## Current State Analysis (Updated 2025-10-14)

### CRITICAL FINDING: Streamlined Initialization Was Never Implemented

**Reality Check**: The STREAMLINED_INITIALIZATION_SUMMARY.md document claims that handler allocations were removed and initialization was streamlined. **THIS IS FALSE**. The actual code in `devMemoryInit` (Pianoid.cu:500-775) still contains ALL the old handler allocations.

**Actual Current State:**
```cpp
void Pianoid::devMemoryInit(...) {
    cudaDeviceReset();  // Line 501 - DESTROYS preset manager GPU buffers!

    // Lines 505-727: ALL handler allocations still present
    handlers.emplace_back("dev_mode_state", ...);          // Line 505 (claimed removed)
    handlers.emplace_back("dev_volume_coeff", ...);        // Line 511 (claimed removed)
    handlers.emplace_back("dev_hammer", ...);              // Line 682 (claimed removed)
    handlers.emplace_back("dev_deck_parameters", ...);     // Line 700 (claimed removed)
    handlers.emplace_back("dev_physical_parameters", ...); // Line 706 (claimed removed)
    handlers.emplace_back("dev_gauss_params_full", ...);   // Line 723 (claimed removed)

    // NO preset manager reinitialization
    // NO default preset creation
    // NO pointer reassignment
}
```

### Existing Architecture Issues

**Problem 1: Dual Allocation System**
- Preset manager allocates 2 GPU buffers (working + updating) in constructor
- `cudaDeviceReset()` destroys those buffers
- Handlers allocate SAME parameters again
- Preset manager never reinitialized → **dangling pointers**
- Result: Wasted memory + memory corruption

**Problem 2: Handler-Based Pointer Management**
```cpp
void setNewPhysicalParameters(...) {
    // Uses handler-allocated memory, NOT preset manager
    loadParameterToPianoid("dev_physical_parameters", physical_parameters);

    // Launch kernel with handler pointers
    CUDA_LAUNCH_ASYNC(parameterKernel, numBlocks, arraySize,
        getRealPointer("dev_physical_parameters"),  // Handler memory!
        getIntPointer("dev_cycle_params"),
        ...);
}
```

**Problem 3: Assertion Failure Root Cause**
1. Constructor: `preset_manager_.initialize()` creates GPU buffers
2. `devMemoryInit`: `cudaDeviceReset()` **destroys** those buffers
3. Preset manager pointers now **dangling**
4. Any code touching preset manager corrupts memory
5. Corruption hits `dev_cycle_params` array
6. Kernel reads corrupted `cycle_parameters[0]`
7. **Assertion fails**: `assert(arraySize == blockDim.x)`

**Current Problems:**
1. **Memory Corruption:** Dangling preset manager pointers corrupt GPU memory
2. **Dual Allocation:** Both handlers AND preset manager allocate same memory (wasteful)
3. **Pointer Mismatch:** Kernels use handler memory, preset manager unused during init
4. **No Integration:** Preset manager only used AFTER initialization for updates
5. **Documentation Fiction:** Summary claims work was done that wasn't

---

## Proposed Architecture

### 1. Triple-Copy Memory Layout

```
┌─────────────────────────────────────────────────────────────┐
│                     HOST MEMORY                             │
│  ┌────────────────────────────────────────────────────┐    │
│  │  Host Active Preset (816,640 reals)                │    │
│  │  - Single source of truth for current parameters   │    │
│  │  - Updated immediately on parameter change          │    │
│  │  - Used for validation and serialization           │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                          │
                          │ cudaMemcpyAsync
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                     GPU MEMORY                              │
│                                                             │
│  ┌─────────────────────────────────┐                       │
│  │  Working Copy (816,640 reals)   │ ← Current Pointer     │
│  │  - Used by audio kernels        │   (dev_working_)      │
│  │  - Never modified during update │                       │
│  │  - Stable, glitch-free playback │                       │
│  └─────────────────────────────────┘                       │
│                    ↕ Atomic Swap                            │
│  ┌─────────────────────────────────┐                       │
│  │  Updating Copy (816,640 reals)  │ ← Update Pointer      │
│  │  - Receives async updates       │   (dev_updating_)     │
│  │  - Never read by kernels        │                       │
│  │  - Becomes Working after swap   │                       │
│  └─────────────────────────────────┘                       │
└─────────────────────────────────────────────────────────────┘
```

### 2. Update State Machine

```
State Machine for Parameter Updates:

   ┌──────────────┐
   │    IDLE      │  All 3 copies identical, no update in progress
   └──────┬───────┘
          │ updateParameters() called
          ↓
   ┌──────────────┐
   │  UPDATING    │  Host copy modified, cudaMemcpyAsync to Updating copy
   └──────┬───────┘
          │ cudaMemcpyAsync completes (event signaled)
          ↓
   ┌──────────────┐
   │  SWAPPING    │  Atomic pointer swap: Working ↔ Updating
   └──────┬───────┘
          │ Swap complete, kernel uses new Working copy
          ↓
   ┌──────────────┐
   │  SYNCING     │  cudaMemcpyAsync: Working → old Updating copy
   └──────┬───────┘
          │ Sync complete (event signaled)
          ↓
   ┌──────────────┐
   │    IDLE      │  All 3 copies identical again
   └──────────────┘

Concurrent Update Request:
- If state != IDLE: Queue or reject (configurable)
- Ensures sequential updates only
```

### 3. Enhanced PresetManager

```cpp
// ==================== DOUBLE-BUFFERED PRESET MANAGER ====================

class DoubleBufferedPresetManager {
private:
    // === HOST STORAGE ===
    // Single source of truth for active preset
    std::vector<real> host_active_preset_;
    std::string active_preset_name_;

    // === GPU DOUBLE BUFFER ===
    real* dev_working_copy_;      // Used by kernels (read-only during playback)
    real* dev_updating_copy_;     // Receives updates (write-only during update)

    // === SYNCHRONIZATION ===
    enum class UpdateState {
        IDLE,       // No update in progress, all copies identical
        UPDATING,   // Host → GPU Updating copy in progress
        SWAPPING,   // Atomic pointer swap in progress
        SYNCING     // Working → old Updating copy in progress
    };

    std::atomic<UpdateState> update_state_;
    std::mutex update_mutex_;  // Protects update operations (not kernel access)

    // CUDA events for async operation tracking
    cudaEvent_t update_complete_event_;
    cudaEvent_t sync_complete_event_;
    cudaStream_t update_stream_;  // Dedicated stream for parameter updates

    // === PRESET LIBRARY ===
    // Multiple presets can still be loaded (from Phase 2)
    std::unordered_map<std::string, std::vector<real>> preset_library_;

    // === STATISTICS ===
    size_t updates_completed_;
    size_t updates_dropped_;
    size_t updates_queued_;

public:
    DoubleBufferedPresetManager();
    ~DoubleBufferedPresetManager();

    // === INITIALIZATION ===
    void initialize();
    void shutdown();

    // === PRESET LOADING (synchronous - Phase 2 functionality) ===
    void loadPresetToLibrary(const std::string& preset_name,
                             const std::vector<real>& packed_parameters);
    void unloadPresetFromLibrary(const std::string& preset_name);
    std::vector<std::string> getLibraryPresets() const;

    // === PRESET SWITCHING (async - uses double buffer) ===
    // Switches to a different preset from library
    bool switchPreset(const std::string& preset_name, bool async = true);

    // === PARAMETER UPDATES (async - uses double buffer) ===
    // Updates specific parameters within active preset
    enum class UpdatePolicy {
        DROP_IF_BUSY,   // Return false if update in progress (default)
        BLOCK_UNTIL_READY,  // Wait for current update to finish
        QUEUE_NEXT      // Queue for execution after current update (future)
    };

    bool updateParameters(const std::string& category,
                         const std::vector<real>& data,
                         size_t offset_in_category = 0,
                         UpdatePolicy policy = UpdatePolicy::DROP_IF_BUSY);

    // === STATE QUERIES ===
    const std::string& getActivePresetName() const;
    UpdateState getUpdateState() const;
    bool isUpdateInProgress() const;

    // Check if async update has completed (non-blocking)
    bool pollUpdateCompletion();

    // Force wait for update to complete (blocking)
    void waitForUpdateCompletion();

    // === POINTER ACCESS ===
    // Returns pointer to current Working copy (for kernel launches)
    real* getWorkingCopyPointer() const;

    // Get specific parameter pointers from Working copy
    real* getStringPhysicsPointer() const;
    real* getHammerPointer() const;
    real* getExcitationPointer() const;
    real* getModeStatePointer() const;
    real* getDeckPointer() const;
    real* getVolumePointer() const;

    // === DIAGNOSTICS ===
    struct UpdateStatistics {
        size_t total_updates;
        size_t successful_updates;
        size_t dropped_updates;
        size_t queued_updates;
        double avg_update_latency_ms;
    };
    UpdateStatistics getStatistics() const;
    void resetStatistics();

private:
    // === INTERNAL UPDATE PIPELINE ===

    // Step 1: Update host copy and start async GPU copy
    bool startUpdate(const std::string& category,
                    const std::vector<real>& data,
                    size_t offset_in_category);

    // Step 2: Swap Working ↔ Updating (called when update_complete_event_ signals)
    void swapBuffers();

    // Step 3: Sync new Working → old Updating (called after swap)
    void syncBuffers();

    // Step 4: Finalize update (called when sync_complete_event_ signals)
    void finalizeUpdate();

    // Background thread to poll events and advance state machine
    void updatePollThread();
    std::thread poll_thread_;
    std::atomic<bool> poll_thread_running_;

    // Helper: Get category offset and size
    void getCategoryInfo(const std::string& category,
                        size_t& base_offset,
                        size_t& max_size);
};
```

---

## Detailed Update Flow

### Scenario 1: Single Parameter Update

```cpp
// User calls: updateParameters("string_physics", new_data)

┌─────────────────────────────────────────────────────────────┐
│ STEP 1: Update Host Copy (immediate, ~100ns)                │
├─────────────────────────────────────────────────────────────┤
│ 1. Lock update_mutex_                                       │
│ 2. Check update_state_ == IDLE (else return false)          │
│ 3. Set update_state_ = UPDATING                             │
│ 4. Update host_active_preset_[offset:offset+size]           │
│ 5. Unlock update_mutex_                                     │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ STEP 2: Async GPU Copy (non-blocking, ~50μs for small)      │
├─────────────────────────────────────────────────────────────┤
│ 1. cudaMemcpyAsync(dev_updating_copy_ + offset,             │
│                    host_data,                               │
│                    size,                                    │
│                    cudaMemcpyHostToDevice,                  │
│                    update_stream_)                          │
│ 2. cudaEventRecord(update_complete_event_, update_stream_)  │
│ 3. Return immediately (user code continues)                 │
└─────────────────────────────────────────────────────────────┘
                          ↓
         [Audio kernels continue using dev_working_copy_]
         [No blocking, no glitches]
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ STEP 3: Poll Thread Detects Completion (~2-3ms later)       │
├─────────────────────────────────────────────────────────────┤
│ 1. cudaEventQuery(update_complete_event_) == cudaSuccess    │
│ 2. Lock update_mutex_                                       │
│ 3. Set update_state_ = SWAPPING                             │
│ 4. Atomic swap: std::swap(dev_working_copy_,                │
│                           dev_updating_copy_)               │
│ 5. Set update_state_ = SYNCING                              │
│ 6. Unlock update_mutex_                                     │
└─────────────────────────────────────────────────────────────┘
                          ↓
         [Kernels now use new Working copy with updates]
         [Old Working copy becomes Updating copy]
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ STEP 4: Sync Buffers (make copies identical again)          │
├─────────────────────────────────────────────────────────────┤
│ 1. cudaMemcpyAsync(dev_updating_copy_,  // old Working      │
│                    dev_working_copy_,    // new Working     │
│                    TOTAL_SIZE,                              │
│                    cudaMemcpyDeviceToDevice,                │
│                    update_stream_)                          │
│ 2. cudaEventRecord(sync_complete_event_, update_stream_)    │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ STEP 5: Finalize (~1ms later)                               │
├─────────────────────────────────────────────────────────────┤
│ 1. cudaEventQuery(sync_complete_event_) == cudaSuccess      │
│ 2. Lock update_mutex_                                       │
│ 3. Set update_state_ = IDLE                                 │
│ 4. Unlock update_mutex_                                     │
│ 5. Ready for next update                                    │
└─────────────────────────────────────────────────────────────┘

Total latency: ~3-5ms from update call to effect in audio
User blocking time: ~100ns (just the host copy)
```

### Scenario 2: Concurrent Update Request

```cpp
// Update 1 in progress (state = UPDATING)
// User calls: updateParameters("hammer", new_data)

┌─────────────────────────────────────────────────────────────┐
│ Policy: DROP_IF_BUSY (default)                              │
├─────────────────────────────────────────────────────────────┤
│ 1. Lock update_mutex_                                       │
│ 2. Check update_state_ != IDLE                              │
│ 3. Unlock update_mutex_                                     │
│ 4. Return false (update dropped)                            │
│ 5. Increment updates_dropped_ counter                       │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Policy: BLOCK_UNTIL_READY                                   │
├─────────────────────────────────────────────────────────────┤
│ 1. Lock update_mutex_                                       │
│ 2. While (update_state_ != IDLE):                           │
│    - Unlock update_mutex_                                   │
│    - std::this_thread::sleep_for(100us)                     │
│    - Lock update_mutex_                                     │
│ 3. Proceed with update (now state == IDLE)                  │
│ 4. Unlock update_mutex_                                     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Policy: QUEUE_NEXT (future enhancement)                     │
├─────────────────────────────────────────────────────────────┤
│ 1. Lock update_mutex_                                       │
│ 2. Check update_state_ != IDLE                              │
│ 3. Add update to pending_updates_ queue                     │
│ 4. Increment updates_queued_ counter                        │
│ 5. Unlock update_mutex_                                     │
│ 6. Return true (queued)                                     │
│ 7. Poll thread will process queue when state → IDLE         │
└─────────────────────────────────────────────────────────────┘
```

---

## Integration with Pianoid Class

### Modified Pianoid Class

```cpp
class Pianoid {
private:
    // === REPLACE: Single PresetManager with Double-Buffered version ===
    // OLD: PresetManager preset_manager_;
    DoubleBufferedPresetManager preset_manager_;

    // === REMOVE: parameterUpdateInProgress flag (replaced by manager's state machine) ===
    // OLD: std::atomic<bool> parameterUpdateInProgress;

    // === Kernel access pointers (read-only) ===
    // These always point to the current Working copy
    real* dev_physical_parameters;  // → preset_manager_.getStringPhysicsPointer()
    real* dev_hammer;               // → preset_manager_.getHammerPointer()
    real* dev_gauss_params_full;    // → preset_manager_.getExcitationPointer()
    real* dev_mode_state;           // → preset_manager_.getModeStatePointer()
    real* dev_deck_parameters;      // → preset_manager_.getDeckPointer()
    real* dev_volume_coeff;         // → preset_manager_.getVolumePointer()

public:
    // === NEW: Double-buffered preset operations ===

    // Load preset into library (doesn't activate it)
    void loadPresetToLibrary(const std::string& preset_name,
                            const std::vector<real>& string_physics,
                            const std::vector<real>& hammer_shapes,
                            const std::vector<real>& excitation_params,
                            const std::vector<real>& mode_state,
                            const std::vector<real>& deck_params,
                            const std::vector<real>& volume_coeffs);

    // Switch to different preset (async, uses double buffer)
    bool switchPreset(const std::string& preset_name, bool async = true);

    // === MODIFIED: Parameter update methods (now async) ===

    // Returns false if update in progress (dropped), true if accepted
    bool setNewPhysicalParameters(const std::vector<real>& physical_parameters,
                                  const std::vector<real>& volume_coeff);

    bool setNewExcitationParameters(const std::vector<real>& new_gauss_params);
    bool setNewHammerParameters(const std::vector<real>& force);
    bool setNewModeParameters(const std::vector<real>& mode_state);
    bool setNewDeckParameters(const std::vector<real>& deck_parameters);

    // === NEW: Update policy control ===

    void setUpdatePolicy(DoubleBufferedPresetManager::UpdatePolicy policy);

    // Check if update is in progress
    bool isParameterUpdateInProgress() const;

    // Wait for any pending update to complete (blocking)
    void waitForParameterUpdate();

    // === KERNEL LAUNCH (unchanged, uses Working copy) ===

    int launchMainKernel() {
        // Kernels automatically use current Working copy
        // No synchronization needed - always safe to launch
        CUDA_LAUNCH_ASYNC(mainKernel,
            /* ... args ... */,
            dev_physical_parameters,  // Points to Working copy
            dev_hammer,               // Points to Working copy
            /* ... */);
    }
};
```

### Example Usage

```cpp
// ============ Python/C++ API Usage Examples ============

// Load multiple presets into library
pianoid.loadPresetToLibrary("bright_piano", params_bright);
pianoid.loadPresetToLibrary("mellow_piano", params_mellow);
pianoid.loadPresetToLibrary("aggressive_piano", params_aggressive);

// Switch to preset (async, no blocking)
bool success = pianoid.switchPreset("bright_piano");
// Audio continues immediately with old preset
// New preset takes effect in ~3ms

// Update parameters (async, no blocking)
success = pianoid.setNewPhysicalParameters(new_tensions, new_volumes);
if (!success) {
    // Update in progress, this update was dropped
    // Retry later or use BLOCK_UNTIL_READY policy
}

// Real-time parameter tweaking
pianoid.setUpdatePolicy(DoubleBufferedPresetManager::UpdatePolicy::DROP_IF_BUSY);
for (int i = 0; i < 100; i++) {
    std::vector<real> tensions = generateTensions(i);
    bool accepted = pianoid.setNewPhysicalParameters(tensions, volumes);
    // If dropped, no problem - we'll send next update in 10ms anyway
    std::this_thread::sleep_for(10ms);
}

// Critical update that must succeed
pianoid.setUpdatePolicy(DoubleBufferedPresetManager::UpdatePolicy::BLOCK_UNTIL_READY);
pianoid.setNewPhysicalParameters(critical_params, volumes);
// This will wait for current update to finish, then apply
```

---

## PREREQUISITE: Fix Broken Initialization (Must Do First!)

### Phase 0: Emergency Fix - Stop Memory Corruption (1 day)

**Goal:** Fix the dangling pointer bug causing assertion failures

#### 0.1 Add Preset Manager Lifecycle Management

**File:** `pianoid_cuda/Pianoid.cu`, function `devMemoryInit`

**BEFORE line 501 (`cudaDeviceReset()`):**
```cpp
void Pianoid::devMemoryInit(...) {
    // CRITICAL: Shutdown preset manager before device reset
    preset_manager_.shutdown();  // Clean up GPU buffers before they're destroyed

    cudaDeviceReset();  // Now safe - no dangling pointers
    // ...
}
```

**AFTER line 502 (after reset):**
```cpp
void Pianoid::devMemoryInit(...) {
    cudaDeviceReset();
    dec_open = init_dec_open;

    // CRITICAL: Reinitialize preset manager after device reset
    preset_manager_.initialize();  // Recreate GPU buffers

    // Continue with handler allocations...
    handlers.emplace_back("dev_mode_state", ...);
    // ...
}
```

**Testing:**
- [ ] Verify initialization completes without crashes
- [ ] Verify async kernel launches work
- [ ] Verify no assertion failures
- [ ] Run cuda-memcheck for memory corruption

**This fixes the immediate crash but keeps dual allocation (wasteful).**

---

## Implementation Phases

### Phase A: Streamlined Initialization (PROPERLY This Time) (2-3 days)

**Goal:** Actually implement what STREAMLINED_INITIALIZATION_SUMMARY.md claimed was done

**NOTE:** DoubleBufferedPresetManager already exists (implemented in earlier commits), so we can use it.

#### A.1 Remove Handler Allocations for Tunable Parameters

**File:** `pianoid_cuda/Pianoid.cu`, function `devMemoryInit`

**DELETE these lines:**
```cpp
// Line 505-509: dev_mode_state handler
handlers.emplace_back("dev_mode_state", ...);

// Line 511-515: dev_volume_coeff handler
handlers.emplace_back("dev_volume_coeff", ...);

// Line 682-686: dev_hammer handler
handlers.emplace_back("dev_hammer", ...);

// Line 700-704: dev_deck_parameters handler
handlers.emplace_back("dev_deck_parameters", ...);

// Line 706-710: dev_physical_parameters handler
handlers.emplace_back("dev_physical_parameters", ...);

// Line 723-727: dev_gauss_params_full handler
handlers.emplace_back("dev_gauss_params_full", ...);
```

**KEEP these handlers (output buffers and config):**
- `dev_stem`, `dev_exct_cycle_index`, `dev_string_state`
- `dev_output_data`, `dev_sound_records_ms`, `dev_sound_records`
- `dev_dec_open`, `dev_soundInt`, `dev_soundFloat`, `dev_soundDouble`
- `dev_bufferForFilter`, `dev_tmpOutputForFilter`
- `dev_filteredSound`, `dev_filteredSoundFloat`
- `dev_filter_*` (all filter buffers)
- `dev_parameters` (computed coefficients)
- `dev_cycle_params` (config data)
- `dev_string_map`, `dev_string_excitation_params`, `dev_gauss_param_indices`
- `mode_position`, `mode_new_position`
- `dev_main_volume_coeff`, `dev_sustain_value`, etc.

**Testing:**
- Compile successfully
- Verify removed handlers don't break lookups

#### A.2 Create Default Preset in devMemoryInit

**File:** `pianoid_cuda/Pianoid.cu`, function `devMemoryInit`

**ADD after preset_manager_.initialize() (Phase 0 code):**
```cpp
void Pianoid::devMemoryInit(...) {
    cudaDeviceReset();
    dec_open = init_dec_open;

    // Phase 0: Prevent dangling pointers
    preset_manager_.shutdown();
    preset_manager_.initialize();

    // Phase A.2: Create default preset FIRST
    printf("Creating default preset from initialization parameters...\n");

    // Validate parameter sizes match runtime config
    size_t expected_string_physics = cp_.num_strings * PHYSICAL_PARAMETERS_NUMBER;
    size_t expected_hammer = cp_.num_string_arrays() * cp_.array_size;
    size_t expected_excitation = cp_.num_strings * NO_EXCITATION_LEVELS * LEN_LEVEL_GP;
    size_t expected_mode_state = cp_.num_modes * 5;
    size_t expected_deck = cp_.num_strings * cp_.num_modes * 2;
    size_t expected_volume = cp_.num_strings;

    // Pack with padding to compile-time max
    std::vector<real> packed_preset;
    packed_preset.reserve(PresetParameterOffsets::TOTAL_SIZE);

    // String physics (pad if runtime < compile-time max)
    packed_preset.insert(packed_preset.end(),
                        physical_parameters.begin(),
                        physical_parameters.end());
    packed_preset.resize(PresetParameterOffsets::HAMMER_OFFSET, 0.0);

    // Hammer shapes
    packed_preset.insert(packed_preset.end(), force.begin(), force.end());
    packed_preset.resize(PresetParameterOffsets::EXCITATION_OFFSET, 0.0);

    // Excitation parameters
    packed_preset.insert(packed_preset.end(), gauss_params.begin(), gauss_params.end());
    packed_preset.resize(PresetParameterOffsets::MODE_STATE_OFFSET, 0.0);

    // Mode state
    packed_preset.insert(packed_preset.end(), mode_state.begin(), mode_state.end());
    packed_preset.resize(PresetParameterOffsets::DECK_OFFSET, 0.0);

    // Deck coupling
    packed_preset.insert(packed_preset.end(), mode_coefficients.begin(), mode_coefficients.end());
    packed_preset.resize(PresetParameterOffsets::VOLUME_OFFSET, 0.0);

    // Volume coefficients
    packed_preset.insert(packed_preset.end(), volume_coeff.begin(), volume_coeff.end());
    packed_preset.resize(PresetParameterOffsets::TOTAL_SIZE, 0.0);

    // Load to preset manager
    preset_manager_.loadPresetToLibrary("default", packed_preset);

    // Switch to default preset (SYNCHRONOUS - must complete before continuing)
    bool success = preset_manager_.switchPreset("default", false);
    if (!success) {
        throw std::runtime_error("Failed to switch to default preset during initialization");
    }

    printf("Default preset loaded and activated\n");

    // Continue with handler allocations for output buffers...
    handlers.emplace_back("dev_stem", ...);
    // ... (all the KEPT handlers from A.1)
}
```

**Testing:**
- Verify preset creation succeeds
- Verify preset contains correct data
- Verify switchPreset completes

#### A.3 Reassign dev_* Pointers to Preset Working Copy

**File:** `pianoid_cuda/Pianoid.cu`, function `devMemoryInit`

**ADD after switchPreset (before handler allocations):**
```cpp
void Pianoid::devMemoryInit(...) {
    // ... preset creation and switch ...

    // Point legacy dev_* pointers into preset working copy
    real* working_copy = preset_manager_.getWorkingCopyPointer();
    dev_physical_parameters = working_copy + PresetParameterOffsets::STRING_PHYSICS_OFFSET;
    dev_hammer = working_copy + PresetParameterOffsets::HAMMER_OFFSET;
    dev_gauss_params_full = working_copy + PresetParameterOffsets::EXCITATION_OFFSET;
    dev_mode_state = working_copy + PresetParameterOffsets::MODE_STATE_OFFSET;
    dev_deck_parameters = working_copy + PresetParameterOffsets::DECK_OFFSET;
    dev_volume_coeff = working_copy + PresetParameterOffsets::VOLUME_OFFSET;

    printf("Legacy pointers now point into preset working copy\n");

    // Now allocate ONLY output buffers via handlers
    handlers.emplace_back("dev_stem", ...);
    // ...
}
```

**Testing:**
- Verify pointers are not null
- Verify pointers point to correct offsets
- Check pointer arithmetic with cuda-memcheck

### Phase B: Async Update Pipeline (2-3 days)

**Goal:** Make updates fully asynchronous with background polling

#### B.1 Implement Buffer Swapping

**Changes:**
```cpp
void DoubleBufferedPresetManager::swapBuffers() {
    // Atomic pointer swap
    std::lock_guard<std::mutex> lock(update_mutex_);
    std::swap(dev_working_copy_, dev_updating_copy_);
    // Update all derived pointers
    updateDerivedPointers();
}
```

**Testing:**
- Verify swap is atomic
- Test that kernels see new parameters after swap

#### B.2 Implement Buffer Synchronization

**Changes:**
```cpp
void DoubleBufferedPresetManager::syncBuffers() {
    // Device-to-device copy to make buffers identical
    cudaMemcpyAsync(dev_updating_copy_, dev_working_copy_,
                    TOTAL_SIZE, cudaMemcpyDeviceToDevice,
                    update_stream_);
}
```

**Testing:**
- Verify both GPU buffers are identical after sync
- Check no data corruption

#### B.3 Add Polling Thread

**Changes:**
```cpp
void DoubleBufferedPresetManager::updatePollThread() {
    while (poll_thread_running_) {
        // Check update_complete_event_
        if (cudaEventQuery(update_complete_event_) == cudaSuccess) {
            swapBuffers();
            syncBuffers();
        }

        // Check sync_complete_event_
        if (cudaEventQuery(sync_complete_event_) == cudaSuccess) {
            finalizeUpdate();
        }

        std::this_thread::sleep_for(100us);
    }
}
```

**Testing:**
- Verify state machine advances correctly
- Test thread cleanup on shutdown

### Phase C: Integration with Pianoid (1-2 days)

**Goal:** Replace old PresetManager with DoubleBufferedPresetManager

#### C.1 Update Pianoid Class

**File:** `Pianoid.cuh`

**Changes:**
```cpp
// Replace:
// PresetManager preset_manager_;
DoubleBufferedPresetManager preset_manager_;

// Remove:
// std::atomic<bool> parameterUpdateInProgress;

// Update method signatures to return bool
bool setNewPhysicalParameters(...);
bool setNewExcitationParameters(...);
// etc.
```

#### C.2 Update Method Implementations

**File:** `Pianoid.cu`

**Changes:**
```cpp
bool Pianoid::setNewPhysicalParameters(...) {
    // OLD: Acquire lock, direct update, release lock

    // NEW: Just call preset manager (handles everything)
    return preset_manager_.updateParameters("string_physics", data);
}
```

**Testing:**
- Verify all parameter update methods work
- Test return value (false when busy)

#### C.3 Update Kernel Launches

**File:** `Pianoid.cu`

**Changes:**
```cpp
// Kernels should just use pointers (no changes needed)
// Pointers automatically updated by manager after swap

// Remove old parameterKernel launch from update methods
// (no longer needed - Working copy already has correct data)
```

**Testing:**
- Verify kernels use correct Working copy
- Test audio playback during parameter updates

### Phase D: Python Integration (1 day)

**Goal:** Expose async update API to Python

#### D.1 Update Python Bindings

**File:** `AddArraysWithCUDA.cpp`

**Changes:**
```cpp
// Update existing bindings to return bool
.def("setNewPhysicalParameters", &Pianoid::setNewPhysicalParameters)
// returns bool now instead of void

// Add new methods
.def("setUpdatePolicy", &Pianoid::setUpdatePolicy)
.def("isParameterUpdateInProgress", &Pianoid::isParameterUpdateInProgress)
.def("waitForParameterUpdate", &Pianoid::waitForParameterUpdate)
.def("loadPresetToLibrary", &Pianoid::loadPresetToLibrary)
```

#### D.2 Python Wrapper

**File:** `pianoid.py` (if exists)

**Changes:**
```python
def update_parameter(self, category, data, retry=True):
    """Update parameter with automatic retry on failure."""
    success = self.pianoid.setNewPhysicalParameters(data)

    if not success and retry:
        # Wait for current update and retry
        self.pianoid.waitForParameterUpdate()
        success = self.pianoid.setNewPhysicalParameters(data)

    return success
```

### Phase E: Testing & Validation (2-3 days)

**Goal:** Comprehensive testing of async update system

#### E.1 Unit Tests

**New File:** `tests/test_double_buffer.cpp`

**Tests:**
- Buffer allocation/deallocation
- State machine transitions
- Concurrent update handling (drop vs block vs queue)
- Swap atomicity
- Sync correctness

#### E.2 Integration Tests

**New File:** `tests/test_async_updates.py`

**Tests:**
```python
def test_async_parameter_update():
    """Test parameter update doesn't block playback."""
    p = Pianoid()
    p.loadPresetToLibrary("test", preset_data)
    p.switchPreset("test")

    # Start playback
    p.play_note(60, 100)

    # Update parameters during playback
    t1 = time.time()
    success = p.setNewPhysicalParameters(new_params, volumes)
    t2 = time.time()

    # Should return immediately (non-blocking)
    assert (t2 - t1) < 0.001  # < 1ms
    assert success == True

    # Wait for audio to finish
    time.sleep(1.0)

def test_concurrent_updates():
    """Test concurrent update handling."""
    p = Pianoid()
    p.setUpdatePolicy(UpdatePolicy.DROP_IF_BUSY)

    # Send updates rapidly
    results = []
    for i in range(100):
        success = p.setNewPhysicalParameters(generate_params(i), vols)
        results.append(success)

    # Some should succeed, some should be dropped
    assert any(results)  # At least one succeeded
    assert not all(results)  # At least one was dropped
```

#### E.3 Performance Tests

**New File:** `tests/benchmark_async_updates.py`

**Metrics:**
- Update latency (time from call to effect)
- Update throughput (updates per second)
- Audio glitch rate (should be zero)
- CPU overhead of polling thread

**Target Performance:**
- Update latency: < 5ms (99th percentile)
- Update throughput: > 100 updates/sec
- Audio glitches: 0
- Polling thread CPU: < 1%

---

## Backward Compatibility Strategy

### Transition Period

1. **Phase C.1-C.2:** Keep both old and new implementations
   - Old methods: `setNewPhysicalParametersSync()` (deprecated)
   - New methods: `setNewPhysicalParameters()` (async)
   - Default to async, allow opt-in to sync for testing

2. **Phase D:** Python layer provides compatibility wrapper
   ```python
   def setNewPhysicalParameters(self, params, volumes, block=False):
       if block:
           # Old behavior: block until complete
           success = self.pianoid.setNewPhysicalParameters(params, volumes)
           self.pianoid.waitForParameterUpdate()
       else:
           # New behavior: async
           success = self.pianoid.setNewPhysicalParameters(params, volumes)
       return success
   ```

3. **Phase E:** Deprecate sync methods after validation

---

## Risk Assessment

### High Risk Items

1. **Race Conditions in Swap**
   - **Risk:** Kernel reads during pointer swap sees inconsistent data
   - **Mitigation:** Atomic pointer swap, comprehensive testing
   - **Validation:** Race detection tools (CUDA-TSAN if available)

2. **Memory Ordering Issues**
   - **Risk:** CPU/GPU see different pointer values due to memory ordering
   - **Mitigation:** Proper memory barriers, atomic operations
   - **Testing:** Multi-GPU stress testing

3. **Event Polling Overhead**
   - **Risk:** Background thread consumes too much CPU
   - **Mitigation:** Adaptive polling rate, sleep between checks
   - **Monitoring:** CPU profiling during updates

### Medium Risk Items

1. **Update Latency**
   - **Risk:** Async updates take too long to take effect
   - **Mitigation:** Optimize copy sizes, use dedicated stream
   - **Target:** < 5ms latency

2. **Dropped Updates**
   - **Risk:** Important updates silently dropped when busy
   - **Mitigation:** Expose return value to Python, add queuing option
   - **Logging:** Track drop rate in statistics

### Low Risk Items

1. **Memory Overhead**
   - **Impact:** +3.18 MB per active preset (one extra GPU buffer)
   - **Mitigation:** Acceptable for modern GPUs (8GB+)

2. **Code Complexity**
   - **Impact:** More complex state machine
   - **Mitigation:** Extensive documentation, unit tests

---

## Success Criteria

### Functional Requirements

- [ ] All three copies (host + 2 GPU) correctly synchronized
- [ ] Parameter updates don't block audio playback
- [ ] Concurrent updates handled safely (drop/block/queue)
- [ ] State machine transitions correctly
- [ ] Existing tests pass with async updates

### Performance Requirements

- [ ] Update latency < 5ms (99th percentile)
- [ ] Zero audio glitches during parameter updates
- [ ] Polling thread CPU usage < 1%
- [ ] Update throughput > 100/sec

### Code Quality Requirements

- [ ] Full unit test coverage for state machine
- [ ] Integration tests for concurrent updates
- [ ] Performance benchmarks documented
- [ ] API documentation updated
- [ ] No memory leaks (cuda-memcheck clean)

---

## Timeline Estimate

| Phase | Duration | Dependencies | Deliverables |
|-------|----------|--------------|--------------|
| **Phase A: Core Infrastructure** | **2-3 days** | Phase 2 complete | DoubleBufferedPresetManager class |
| A.1: Create base class | 1 day | None | Basic allocation working |
| A.2: Add async infra | 0.5 day | A.1 | CUDA events/streams |
| A.3: State machine | 0.5-1 day | A.2 | State transitions |
| **Phase B: Async Pipeline** | **2-3 days** | Phase A | Full async updates |
| B.1: Buffer swapping | 1 day | A.3 | Atomic swap working |
| B.2: Buffer sync | 0.5 day | B.1 | D2D copy working |
| B.3: Polling thread | 0.5-1 day | B.2 | Auto state advance |
| **Phase C: Integration** | **1-2 days** | Phase B | Pianoid updated |
| C.1: Update Pianoid class | 0.5 day | B.3 | Class modified |
| C.2: Update methods | 0.5 day | C.1 | All methods async |
| C.3: Update kernels | 0.5 day | C.2 | Kernels use Working |
| **Phase D: Python** | **1 day** | Phase C | Python bindings |
| D.1: Update bindings | 0.5 day | C.3 | New methods exposed |
| D.2: Python wrapper | 0.5 day | D.1 | Helper functions |
| **Phase E: Testing** | **2-3 days** | Phase D | Validated system |
| E.1: Unit tests | 1 day | D.2 | Test suite |
| E.2: Integration tests | 1 day | E.1 | End-to-end tests |
| E.3: Performance tests | 0.5-1 day | E.2 | Benchmarks |
| **Total** | **8-12 days** | Sequential | Production ready |

---

## Open Questions

1. **Polling Rate Optimization**
   - **Question:** What's the optimal polling interval for event checking?
   - **Options:** 100μs (current), adaptive (busy-wait when active, sleep when idle)
   - **Decision:** Start with 100μs, optimize in Phase E if CPU usage too high

2. **Queue Implementation**
   - **Question:** Should we implement UPDATE_POLICY::QUEUE_NEXT in initial version?
   - **Recommendation:** Skip for now, add in future if needed
   - **Rationale:** DROP and BLOCK cover most use cases

3. **Multi-Preset Double Buffering**
   - **Question:** Should each preset in library have its own double buffer?
   - **Current Plan:** No, only active preset is double-buffered
   - **Rationale:** Reduces memory overhead, library presets are loaded on-demand

4. **Partial Updates Optimization**
   - **Question:** Should we optimize to only swap/sync changed regions?
   - **Current Plan:** No, full buffer swap/sync for simplicity
   - **Future:** Could optimize to track dirty regions (Phase 4 enhancement)

5. **Error Recovery**
   - **Question:** What happens if cudaMemcpyAsync fails mid-update?
   - **Strategy:**
     - Log error
     - Revert to IDLE state
     - Don't swap buffers (keep old Working copy)
     - Return false to caller
   - **Result:** Failed update has no effect on playback (safe)

---

## Conclusion

This double-buffering refactoring transforms Pianoid's parameter update mechanism from a blocking, synchronous operation to a lock-free, asynchronous pipeline. The triple-copy architecture ensures that audio playback is never interrupted by parameter updates, while the state machine guarantees safe concurrent access.

Key benefits:
- **Zero audio glitches** during parameter updates
- **Sub-5ms update latency** for glitch-free real-time control
- **Lock-free kernel access** - audio engine never waits
- **Safe concurrent updates** with configurable policies
- **Backward compatible** with existing API

The phased implementation approach ensures stability at each step, with comprehensive testing to validate correctness and performance.

---

**Next Steps:**
1. Review and approve this plan
2. Begin Phase A: Core Infrastructure
3. Validate each phase before proceeding
4. Document performance metrics at each stage
