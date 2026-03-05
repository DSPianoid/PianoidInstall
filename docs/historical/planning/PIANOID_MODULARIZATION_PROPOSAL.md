# Pianoid.cu Modularization Proposal

**Date:** October 29, 2025
**Status:** Proposal for Discussion
**Target File:** `pianoid_cuda/pianoid.cu` (2,347 lines)

---

## Executive Summary

The `pianoid.cu` file has grown to **2,347 lines** and contains multiple distinct functional areas that can be cleanly extracted into separate, focused modules. This proposal identifies **6 extractable modules** (excluding core synthesis) that would:

- **Reduce pianoid.cu by ~900 lines (38%)**
- **Improve maintainability** through focused responsibilities
- **Enable parallel development** on different subsystems
- **Preserve backward compatibility** with existing API

### File Size Breakdown

| Category | Lines | % of Total | Extractable? |
|----------|-------|------------|--------------|
| Core Synthesis (Kernel Launch) | ~140 | 6% | ❌ No (core) |
| Profiling System | ~78 | 3% | ✅ **High Priority** |
| Preset Management | ~157 | 7% | ✅ **High Priority** |
| Lifecycle Management | ~125 | 5% | ✅ **Medium Priority** |
| Audio Processing (FIR Filter) | ~257 | 11% | ✅ **Medium Priority** |
| Event Processing (String Batch) | ~281 | 12% | ✅ **Medium Priority** |
| Parameter Management | ~314 | 13% | ⚠️ **Partial** (validation only) |
| MIDI Processing | ~180 | 8% | 🔄 Already refactored |
| Playback Engines | ~200 | 9% | 🔄 Already refactored |
| Infrastructure (Init, Memory) | ~615 | 26% | ❌ No (core) |

**Total extractable:** ~900 lines (38%)
**Remaining after extraction:** ~1,450 lines (focused on core synthesis)

---

## Proposed Module Extractions

### 🎯 **Module 1: Profiling System** (Priority: **HIGHEST**, Risk: **LOWEST**)

#### Overview
Self-contained profiling system with zero coupling to other Pianoid subsystems. Perfect first extraction to build confidence.

#### Current Location
- **Lines:** 2043-2121 (78 lines)
- **Dependencies:** None (uses global static buffers)
- **External deps:** `Profiler.h`, `<chrono>`, `<vector>`

#### Functions to Extract
```cpp
// Public API (7 methods)
void startProfiling();
void stopProfiling();
void resetProfiling();
void writeProfilingData(const std::string& cpu_filename, const std::string& gpu_filename);
std::vector<std::vector<float>> getGpuProfilingData();
std::vector<std::vector<long long>> getCpuProfilingData();

// Internal state (file-local globals - will become class members)
static bool g_profiling_enabled;
static ProfilingBuffer g_profiling_buffer;
static GpuTimings g_lastGpuTimings;
```

#### Proposed New Files
```
pianoid_cuda/
├── PianoidProfiler.h        # Header with class declaration
└── PianoidProfiler.cu       # Implementation
```

#### Extraction Strategy
```cpp
// PianoidProfiler.h
class PianoidProfiler {
private:
    bool profiling_enabled_ = false;
    ProfilingBuffer profiling_buffer_;
    GpuTimings last_gpu_timings_;

public:
    void start();
    void stop();
    void reset();
    void writeData(const std::string& cpu_filename, const std::string& gpu_filename);
    std::vector<std::vector<float>> getGpuData();
    std::vector<std::vector<long long>> getCpuData();

    // Called by Pianoid::launchMainKernel() to record timings
    void recordGpuTimings(const GpuTimings& timings);
    GpuTimings getLastGpuTimings() const { return last_gpu_timings_; }
};
```

#### Integration into Pianoid
```cpp
// In Pianoid.cuh (private section)
#if PIANOID_ENABLE_PROFILING
    PianoidProfiler profiler_;
#endif

// In pianoid.cu - delegate to profiler
void Pianoid::startProfiling() {
    #if PIANOID_ENABLE_PROFILING
        profiler_.start();
    #endif
}

// In launchMainKernel() - record timings
#if PIANOID_ENABLE_PROFILING
    profiler_.recordGpuTimings(g_lastGpuTimings);
#endif
```

#### Benefits
- ✅ **Zero risk** - no dependencies on other Pianoid state
- ✅ **Compile-time disabling** still works via `PIANOID_ENABLE_PROFILING`
- ✅ **Same API** - public interface unchanged
- ✅ **Testing friendly** - can unit test profiler independently

#### Estimated Effort
- **Extraction:** 2-3 hours
- **Testing:** 1 hour
- **Total:** Half day

---

### 🎯 **Module 2: Preset Management** (Priority: **HIGH**, Risk: **LOW**)

#### Overview
Double-buffered preset system that manages TUNABLE parameter presets. High value extraction with clean API surface.

#### Current Location
- **Lines:** 2123-2280 (157 lines)
- **Dependencies:** `UnifiedGpuMemoryManager` (already abstracted)
- **External deps:** `<vector>`, `<string>`, `constants.h` (for `PresetParameterOffsets`)

#### Functions to Extract
```cpp
// Public API (9 methods)
void loadPresetToLibrary(const std::vector<real>& string_physics, ...);
bool switchPreset(const std::string& preset_name, bool async = true);
void unloadPresetFromLibrary(const std::string& preset_name);
std::vector<std::string> getLibraryPresets() const;
std::string getActivePreset() const;

// Update policy control
void setUpdatePolicy(UnifiedGpuMemoryManager::UpdatePolicy policy);
UnifiedGpuMemoryManager::UpdatePolicy getUpdatePolicy() const;
bool isParameterUpdateInProgress() const;
void waitForParameterUpdate();
```

#### Proposed New Files
```
pianoid_cuda/
├── PresetManager.h          # Header with class declaration
└── PresetManager.cu         # Implementation
```

#### Extraction Strategy
```cpp
// PresetManager.h
class PresetManager {
private:
    UnifiedGpuMemoryManager& memory_manager_;
    bool initial_preset_loaded_ = false;

    // Callback for post-switch operations (stringMapKernel, pointer updates)
    std::function<void()> on_preset_switch_callback_;

public:
    PresetManager(UnifiedGpuMemoryManager& memory_manager);

    // Preset library operations
    void loadToLibrary(const std::vector<real>& string_physics, ...);
    bool switchPreset(const std::string& name, bool async = true);
    void unloadFromLibrary(const std::string& name);

    // Query methods
    std::vector<std::string> getLibraryPresets() const;
    std::string getActivePreset() const;
    bool isInitialPresetLoaded() const { return initial_preset_loaded_; }

    // Update policy
    void setUpdatePolicy(UnifiedGpuMemoryManager::UpdatePolicy policy);
    UnifiedGpuMemoryManager::UpdatePolicy getUpdatePolicy() const;
    bool isUpdateInProgress() const;
    void waitForUpdate();

    // Hook for post-switch operations (called by Pianoid)
    void setOnSwitchCallback(std::function<void()> callback);
};
```

#### Integration into Pianoid
```cpp
// In Pianoid.cuh (private section)
PresetManager preset_manager_;

// In Pianoid constructor
Pianoid::Pianoid(...)
    : memory_manager_(),
      preset_manager_(memory_manager_)
{
    // Set callback for post-switch operations
    preset_manager_.setOnSwitchCallback([this]() {
        // Update compatibility pointers
        dev_physical_parameters = memory_manager_.getStringPhysicsPointer();
        dev_hammer = memory_manager_.getHammerPointer();
        // ... (existing pointer update code)

        // Run stringMapKernel on first load
        if (!preset_manager_.isInitialPresetLoaded()) {
            stringMapKernel<<<...>>>();
        }

        new_notes_ind = 1;
    });
}

// In pianoid.cu - delegate to preset manager
void Pianoid::loadPresetToLibrary(...) {
    preset_manager_.loadToLibrary(...);
}

bool Pianoid::switchPreset(const std::string& name, bool async) {
    return preset_manager_.switchPreset(name, async);
}
```

#### Special Considerations
- **Validation logic** (lines 2131-2163) stays in PresetManager
- **Padding logic** (lines 2165-2191) stays in PresetManager
- **Callback pattern** allows Pianoid to handle GPU-specific post-switch operations
- **initialPresetLoaded flag** moves to PresetManager state

#### Benefits
- ✅ **Clean separation** - preset logic isolated from synthesis
- ✅ **Reusable** - could be used in future Pianoid variants
- ✅ **Testable** - can unit test validation, padding, library management
- ✅ **Same API** - no breaking changes

#### Estimated Effort
- **Extraction:** 4-5 hours
- **Testing:** 2 hours
- **Total:** 1 day

---

### 🎯 **Module 3: Lifecycle Manager** (Priority: **MEDIUM**, Risk: **LOW**)

#### Overview
Manages GPU initialization, audio driver lifecycle, and application loop state. Clean atomic flag-based state machine.

#### Current Location
- **Lines:** 1155-1280 (125 lines)
- **Dependencies:** `AudioDriverInterface`, atomic flags
- **External deps:** `<atomic>`, `<mutex>`

#### Functions to Extract
```cpp
// GPU lifecycle
void shutdownGpu();
bool isGpuInitialized() const;

// Audio driver lifecycle
void startAudioDriver();
void stopAudioDriver();
bool isAudioDriverActive() const;

// Loop control
void beginMainLoop();
void endMainLoop();
bool shouldContinue() const;

// Legacy API (backward compatible)
void startApplication();
void stopApplication(bool now);
```

#### Proposed New Files
```
pianoid_cuda/
├── LifecycleManager.h       # Header with state machine
└── LifecycleManager.cu      # Implementation
```

#### Extraction Strategy
```cpp
// LifecycleManager.h
class LifecycleManager {
public:
    enum class State {
        UNINITIALIZED,
        GPU_READY,
        AUDIO_ACTIVE,
        RUNNING,
        PAUSED
    };

private:
    std::atomic<bool> gpu_initialized_{false};
    std::atomic<bool> audio_driver_active_{false};
    std::atomic<bool> should_continue_loop_{false};
    std::mutex audio_driver_mutex_;

    AudioDriverInterface* audio_driver_ = nullptr;  // Non-owning pointer

    // Callbacks for GPU operations (Pianoid owns the GPU state)
    std::function<void()> on_gpu_shutdown_callback_;

public:
    // GPU lifecycle
    void shutdownGpu();
    bool isGpuInitialized() const { return gpu_initialized_.load(); }
    void markGpuInitialized() { gpu_initialized_.store(true); }

    // Audio driver lifecycle
    void setAudioDriver(AudioDriverInterface* driver);
    void startAudioDriver();
    void stopAudioDriver();
    bool isAudioDriverActive() const { return audio_driver_active_.load(); }

    // Loop control
    void beginMainLoop();
    void endMainLoop();
    bool shouldContinue() const { return should_continue_loop_.load(); }

    // Callbacks
    void setOnGpuShutdownCallback(std::function<void()> callback);

    // State query
    State getCurrentState() const;
};
```

#### Integration into Pianoid
```cpp
// In Pianoid.cuh (private section)
LifecycleManager lifecycle_;

// Legacy atomic flags REMOVED (replaced by lifecycle_)
// std::atomic<bool> gpuInitialized_;
// std::atomic<bool> audioDriverActive_;
// std::atomic<bool> shouldContinueLoop_;

// In Pianoid constructor
Pianoid::Pianoid(...)
    : lifecycle_()
{
    lifecycle_.setAudioDriver(audioDriver.get());
    lifecycle_.setOnGpuShutdownCallback([this]() {
        shouldContinueLoop_.store(false);
        // GPU memory freed in destructor
    });
}

// In devMemoryInit()
void Pianoid::devMemoryInit(...) {
    // ... existing GPU allocation code ...
    lifecycle_.markGpuInitialized();
}

// Delegate all lifecycle methods
void Pianoid::shutdownGpu() { lifecycle_.shutdownGpu(); }
void Pianoid::startAudioDriver() { lifecycle_.startAudioDriver(); }
bool Pianoid::isGpuInitialized() const { return lifecycle_.isGpuInitialized(); }
```

#### Benefits
- ✅ **State machine** - explicit state transitions
- ✅ **Thread-safe** - mutex protection for audio operations
- ✅ **Testable** - can mock audio driver for testing
- ✅ **Same API** - backward compatible

#### Estimated Effort
- **Extraction:** 3-4 hours
- **Testing:** 2 hours
- **Total:** 1 day

---

### 🎯 **Module 4: Audio Processing (FIR Filter)** (Priority: **MEDIUM**, Risk: **MEDIUM**)

#### Overview
Manages audio buffer operations and FIR filtering. More complex due to cooperative kernel launch and buffer management.

#### Current Location
- **Lines:** 1750-2007 (257 lines) + 592-629 (filter switching, 38 lines)
- **Dependencies:** `FIRFilter.cuh`, cooperative kernels, GPU buffers
- **External deps:** `<cuda_runtime.h>`, `cooperative_groups.h`

#### Functions to Extract
```cpp
// Audio playback
void playSoundSamples();                  // Lines 1758-2007
void appendRawSound(std::string name);    // Reads GPU audio buffer
void appendSoundRecords();                // Records audio to history

// FIR filter control
void set_filter(int filterSize, int numberOfFilters, std::vector<float> filter);  // Line 592
void switch_filter(int sampleRate, int filterSize, bool on);                      // Line 601
void setChannelForSDL(int channel);       // Line 1752
```

#### Proposed New Files
```
pianoid_cuda/
├── AudioProcessor.h         # Header with class declaration
└── AudioProcessor.cu        # Implementation
```

#### Extraction Strategy
```cpp
// AudioProcessor.h
class AudioProcessor {
private:
    // FIR filter state
    bool fir_filter_enabled_ = false;
    int fir_filter_length_ = 0;
    int num_channels_ = 0;
    int samples_in_cycle_ = 0;
    int channel_for_sdl_ = 0;

    // GPU buffer pointers (non-owning - managed by UnifiedGpuMemoryManager)
    float* dev_sound_float_ = nullptr;
    float* dev_filtered_sound_float_ = nullptr;
    float* dev_filter_input_samples_ = nullptr;
    float* dev_filter_output_ = nullptr;
    float* dev_filter_partials_ = nullptr;
    float* dev_fir_filters_ = nullptr;

    // Cooperative kernel args
    std::vector<void*> filter_kernel_args_;

    // Cycle parameters (reference to Pianoid's cp_)
    const CycleParameters& cycle_params_;

    // Profiler reference (for timing)
    #if PIANOID_ENABLE_PROFILING
    PianoidProfiler* profiler_ = nullptr;
    #endif

public:
    AudioProcessor(const CycleParameters& cp);

    // Buffer initialization (called by Pianoid after GPU allocation)
    void setBufferPointers(float* dev_sound_float,
                          float* dev_filtered_sound_float,
                          float* dev_filter_input_samples,
                          float* dev_filter_output,
                          float* dev_filter_partials,
                          float* dev_fir_filters);

    // Audio processing
    void processSoundSamples(std::atomic<bool>& audio_on);
    void appendRawSoundToHost(const std::string& buffer_name,
                             std::vector<float>& host_buffer);

    // FIR filter control
    void setFilter(int filter_size, int num_filters, const std::vector<float>& filter);
    void switchFilter(int sample_rate, int filter_size, bool enable);
    void setChannelForSDL(int channel) { channel_for_sdl_ = channel; }

    // State query
    bool isFilterEnabled() const { return fir_filter_enabled_; }

    #if PIANOID_ENABLE_PROFILING
    void setProfiler(PianoidProfiler* profiler) { profiler_ = profiler; }
    #endif
};
```

#### Integration into Pianoid
```cpp
// In Pianoid.cuh (private section)
AudioProcessor audio_processor_;

// In Pianoid constructor
Pianoid::Pianoid(...)
    : audio_processor_(cp_)
{
    #if PIANOID_ENABLE_PROFILING
    audio_processor_.setProfiler(&profiler_);
    #endif
}

// In devMemoryInit() - after GPU buffer allocation
void Pianoid::devMemoryInit(...) {
    // ... existing allocation code ...

    audio_processor_.setBufferPointers(
        dev_soundFloat,
        dev_filteredSoundFloat,
        getFloatPointer("dev_filter_input_samples"),
        getFloatPointer("dev_filter_output"),
        getFloatPointer("dev_filter_partials"),
        dev_fir_filters
    );
}

// Delegate audio methods
void Pianoid::playSoundSamples() {
    audio_processor_.processSoundSamples(audioOn);
}

void Pianoid::set_filter(...) {
    audio_processor_.setFilter(...);
}
```

#### Special Considerations
- **Cooperative kernel launch** - complex grid calculation logic stays intact
- **Buffer clearing** - memset operations must happen every cycle (stays in AudioProcessor)
- **Profiling integration** - AudioProcessor records filter kernel timing
- **SDL channel selection** - used by audio driver callback

#### Benefits
- ✅ **Isolates FIR filter complexity** - easier to debug/optimize
- ✅ **Testable** - can unit test filter logic separately
- ⚠️ **Medium coupling** - needs buffer pointers from Pianoid

#### Estimated Effort
- **Extraction:** 6-8 hours
- **Testing:** 3 hours
- **Total:** 1.5 days

---

### 🎯 **Module 5: Event Processing (String Batch)** (Priority: **MEDIUM**, Risk: **MEDIUM**)

#### Overview
Manages string excitation batching and mode excitation. Coordinates MIDI event translation to GPU parameter updates.

#### Current Location
- **Lines:** 1282-1563 (281 lines)
- **Dependencies:** GPU buffers, string-to-pitch mapping
- **External deps:** `<vector>`, `constants.h`

#### Functions to Extract
```cpp
// String batch API
void addOneString(int stringNo, int velocity);              // Line 1286
void beginStringBatch();                                    // Line 1337
void addStringToBatch(int stringNo, int velocity);          // Line 1344
void commitStringBatch();                                   // Line 1353

// Mode excitation API
void addModeExcitation(int modeNo, float displacement, float velocity);  // Line 1392

// Internal helpers
void _append_string_gp(int noString, int velocity, int timing);          // Line 1437
void _add_string_for_playback(int stringNo, int velocity, int timing);   // Line 1457
void _exciteSingleMode(int modeNo, float displacement, float velocity);  // Line 1513
void _load_exct_params_to_GPU();                                         // Line 1565
```

#### Proposed New Files
```
pianoid_cuda/
├── EventProcessor.h         # Header with class declaration
└── EventProcessor.cu        # Implementation
```

#### Extraction Strategy
```cpp
// EventProcessor.h
class EventProcessor {
private:
    // Batch state
    int num_strings_in_batch_ = 0;
    int pending_mode_excitation_index_ = -1;
    float pending_mode_displacement_ = 0.0f;
    float pending_mode_velocity_ = 0.0f;

    // Host-side buffers
    std::vector<int> string_excitation_params_;
    std::vector<int> string_gauss_param_indices_;
    std::vector<real> gauss_params_;  // Host copy for backward compatibility

    // GPU buffer pointers (non-owning)
    int* dev_string_excitation_params_ = nullptr;
    int* dev_gauss_param_indices_ = nullptr;
    real* dev_gauss_params_full_ = nullptr;
    real* dev_string_excitations_ = nullptr;

    // String-to-pitch mapping
    const std::vector<int>& strings_in_pitch_;
    const CycleParameters& cycle_params_;

    // Kernel for mode excitation
    void launchModeExcitationKernel(int mode_no, float displacement, float velocity);

public:
    EventProcessor(const std::vector<int>& strings_in_pitch,
                  const CycleParameters& cp);

    // Buffer initialization
    void setBufferPointers(int* dev_string_excitation_params,
                          int* dev_gauss_param_indices,
                          real* dev_gauss_params_full,
                          real* dev_string_excitations);

    // String batch API
    void addOneString(int string_no, int velocity);
    void beginBatch();
    void addStringToBatch(int string_no, int velocity);
    void commitBatch();

    // Mode excitation API
    void addModeExcitation(int mode_no, float displacement, float velocity);

    // State query
    int getBatchSize() const { return num_strings_in_batch_; }
    bool hasPendingModeExcitation() const { return pending_mode_excitation_index_ >= 0; }

    // Host-side parameter access (backward compatibility)
    const std::vector<real>& getGaussParams() const { return gauss_params_; }
};
```

#### Integration into Pianoid
```cpp
// In Pianoid.cuh (private section)
EventProcessor event_processor_;

// In Pianoid constructor
Pianoid::Pianoid(...)
    : event_processor_(strings_in_pitches, cp_)
{
}

// In devMemoryInit()
void Pianoid::devMemoryInit(...) {
    // ... existing allocation code ...

    event_processor_.setBufferPointers(
        dev_string_excitation_params,
        dev_gauss_param_indices,
        dev_gauss_params_full,
        dev_string_excitations
    );
}

// Delegate event methods
void Pianoid::addOneString(int string_no, int velocity) {
    event_processor_.addOneString(string_no, velocity);
}

void Pianoid::beginStringBatch() {
    event_processor_.beginBatch();
}

void Pianoid::commitStringBatch() {
    event_processor_.commitBatch();
}

void Pianoid::addModeExcitation(int mode_no, float d, float v) {
    event_processor_.addModeExcitation(mode_no, d, v);
}
```

#### Special Considerations
- **String-to-pitch mapping** - EventProcessor needs read access to `strings_in_pitch_`
- **Batch counter** - `noStrings_in_GP` becomes `num_strings_in_batch_`
- **Mode excitation flag** - moves to EventProcessor state
- **Kernel launches** - EventProcessor calls `modeExcitationKernel` directly

#### Benefits
- ✅ **Batch logic isolated** - easier to optimize batch size
- ✅ **Mode excitation encapsulated** - new feature cleanly separated
- ⚠️ **Medium coupling** - needs string mapping and GPU buffers

#### Estimated Effort
- **Extraction:** 6-8 hours
- **Testing:** 3 hours
- **Total:** 1.5 days

---

### ⚠️ **Module 6: Parameter Management (Partial Extraction)** (Priority: **LOW**, Risk: **HIGH**)

#### Overview
Parameter update pipeline is tightly coupled to GPU memory management and synthesis kernel. Only **validation logic** should be extracted.

#### Current Location
- **Lines:** 715-1029 (314 lines)
- **Functions:** `setNewPhysicalParameters()`, `setNewExcitationParameters()`, etc.
- **Coupling:** High - directly updates `UnifiedGpuMemoryManager`, triggers kernel reruns

#### Recommendation: **DO NOT EXTRACT** (keep in pianoid.cu)

#### Rationale
1. **Tight coupling** - parameter updates trigger GPU buffer copies, kernel launches
2. **Core functionality** - directly related to synthesis pipeline
3. **Phase 6 work** - parameter system already being refactored (see `PARAMETER_REFACTORING_PLAN.md`)
4. **Diminishing returns** - extraction would create artificial boundaries

#### Possible Partial Extraction: Validation Helper
```cpp
// ParameterValidator.h (lightweight utility)
class ParameterValidator {
public:
    static bool validateStringPhysics(const std::vector<real>& data, int num_strings);
    static bool validateExcitation(const std::vector<real>& data);
    static bool validateHammer(const std::vector<real>& data);
    // ... validation logic only
};
```

**Estimated value:** Low (validation is straightforward, extraction overhead not justified)

---

## Not Extractable (Core Pianoid Functionality)

### Core Synthesis Engine (Lines 1575-1715)
- **Function:** `launchMainKernel()` - orchestrates GPU synthesis kernels
- **Reason:** Heart of Pianoid, tightly coupled to kernel orchestration
- **Keep in:** `pianoid.cu`

### GPU Memory Initialization (Lines 400-714)
- **Function:** `devMemoryInit()` - allocates GPU buffers
- **Reason:** Coordinates with `UnifiedGpuMemoryManager`, sets up entire GPU state
- **Keep in:** `pianoid.cu`

### MIDI Processing (Lines 1282+)
- **Status:** ✅ Already refactored to `EventDispatcher`, `PlaybackEvent` system
- **See:** `LIFECYCLE_REFACTORING_SUMMARY.md`, `MIDI_PROCESSING_REFACTORING_SUMMARY.md`

### Playback Engines (Lines 2285+)
- **Status:** ✅ Already refactored to `OnlinePlaybackEngine`, `OfflinePlaybackEngine`
- **See:** `PLAYBACK_REFACTORING_PLAN.md`, `UNIVERSAL_PLAYBACK_REFACTORING_PLAN.md`

---

## Recommended Extraction Phases

### Phase 1: Low-Risk Extractions (1 week)
**Goal:** Build confidence, reduce pianoid.cu by ~360 lines (15%)

1. **Week 1, Day 1-2:** Extract **Profiling System**
   - Lines: 78
   - Risk: Lowest
   - Files: `PianoidProfiler.h/.cu`
   - Deliverable: Working profiler module with backward-compatible API

2. **Week 1, Day 3-5:** Extract **Preset Management**
   - Lines: 157
   - Risk: Low
   - Files: `PresetManager.h/.cu`
   - Deliverable: Working preset manager with library support

3. **Week 1, End:** Extract **Lifecycle Manager**
   - Lines: 125
   - Risk: Low
   - Files: `LifecycleManager.h/.cu`
   - Deliverable: State machine for GPU/audio lifecycle

**Phase 1 Result:**
- ✅ **-360 lines** from pianoid.cu (15% reduction)
- ✅ **3 new modules** with focused responsibilities
- ✅ **Confidence built** in extraction process

### Phase 2: Medium-Risk Extractions (2 weeks - optional)
**Goal:** Further reduce pianoid.cu by ~540 lines (23%)

4. **Week 2-3:** Extract **Audio Processor**
   - Lines: 257
   - Risk: Medium
   - Files: `AudioProcessor.h/.cu`
   - Complexity: Cooperative kernel launch, buffer management

5. **Week 3-4:** Extract **Event Processor**
   - Lines: 281
   - Risk: Medium
   - Files: `EventProcessor.h/.cu`
   - Complexity: String batch coordination, mode excitation

**Phase 2 Result:**
- ✅ **-900 lines total** (38% reduction)
- ✅ **5 new modules** with clean APIs
- ✅ **pianoid.cu down to ~1,450 lines** (focused on core synthesis)

---

## Testing Strategy

### Unit Testing (New Modules)
Each extracted module should have unit tests:

```cpp
// test/test_profiler.cu
TEST(PianoidProfiler, StartStopCycle) {
    PianoidProfiler profiler;
    profiler.start();
    EXPECT_TRUE(profiler.isEnabled());
    profiler.stop();
    EXPECT_FALSE(profiler.isEnabled());
}

TEST(PianoidProfiler, DataRecording) {
    PianoidProfiler profiler;
    profiler.start();
    GpuTimings timings{0, 1.0f, 2.0f, 3.0f, 4.0f};
    profiler.recordGpuTimings(timings);
    auto data = profiler.getGpuData();
    EXPECT_EQ(data.size(), 1);
}
```

### Integration Testing (Pianoid API)
Ensure backward compatibility:

```python
# test/test_pianoid_integration.py
def test_profiling_api_unchanged():
    pianoid = initialize_pianoid()
    pianoid.startProfiling()  # Must work as before
    run_synthesis_cycles(10)
    data = pianoid.getGpuProfilingData()
    assert len(data) == 10

def test_preset_switching_unchanged():
    pianoid = initialize_pianoid()
    pianoid.loadPresetToLibrary(...)
    success = pianoid.switchPreset("default")
    assert success
    assert pianoid.getActivePreset() == "default"
```

### Regression Testing
Run existing test suite after each extraction:
- ✅ Audio output quality tests (compare waveforms)
- ✅ Performance benchmarks (ensure no regression)
- ✅ Memory leak checks (valgrind/cuda-memcheck)

---

## Migration Path

### Backward Compatibility Guarantee
- ✅ **No API changes** - all public methods delegate to new modules
- ✅ **No behavior changes** - extracted code runs identically
- ✅ **No performance regression** - inline delegation has zero overhead

### Example: Profiling Migration
```cpp
// BEFORE (pianoid.cu)
void Pianoid::startProfiling() {
    g_profiling_enabled = true;
    std::printf("Profiling started\n");
}

// AFTER (pianoid.cu) - delegates to module
void Pianoid::startProfiling() {
    #if PIANOID_ENABLE_PROFILING
        profiler_.start();
    #else
        std::printf("Profiling is disabled\n");
    #endif
}

// NEW MODULE (PianoidProfiler.cu)
void PianoidProfiler::start() {
    profiling_enabled_ = true;
    std::printf("Profiling started - data will be recorded to memory buffer\n");
}
```

**Result:** Identical behavior, same output, cleaner code organization.

---

## Benefits Summary

### Code Organization
- **Focused files** - each module has single responsibility
- **Easier navigation** - find profiling code in `PianoidProfiler.cu`, not buried in pianoid.cu
- **Parallel development** - multiple developers can work on different modules

### Maintainability
- **Smaller files** - pianoid.cu down to ~1,450 lines (focused on synthesis)
- **Clear boundaries** - module APIs define interaction points
- **Easier debugging** - narrower scope for bug location

### Testing
- **Unit testable** - each module can be tested independently
- **Mock-friendly** - can mock AudioProcessor for lifecycle tests
- **Regression safety** - module boundaries prevent unintended coupling

### Future Refactoring
- **GPU Backend Extraction** - easier to separate Pianoid into GPU + middleware layers
- **Phase 6 Parameter System** - isolated modules don't interfere with parameter refactoring
- **Alternative Implementations** - could swap AudioProcessor for different FIR filter strategy

---

## Risks and Mitigations

### Risk 1: Unintended Dependencies
**Mitigation:** Incremental extraction with unit tests after each module

### Risk 2: Performance Regression
**Mitigation:** Benchmark before/after each extraction, ensure inlining where needed

### Risk 3: API Breakage
**Mitigation:** Keep all public methods in Pianoid, delegate to modules (zero breaking changes)

### Risk 4: Increased Build Complexity
**Mitigation:** Use CMake/build.py to automatically include new modules, no manual config

---

## Recommended Decision

### ✅ **Approve Phase 1** (Profiler + Preset + Lifecycle)
- **Low risk, high value**
- **1 week effort**
- **-360 lines** (15% reduction)
- **Builds confidence** for future extractions

### ⏸️ **Defer Phase 2** (Audio + Event)
- **Medium risk, medium value**
- **2 weeks effort**
- **Wait until Phase 1 validated**
- **Re-evaluate after Phase 6 parameter refactoring**

### ❌ **Do Not Extract** Parameter Management
- **High risk, low value**
- **Phase 6 already refactoring this area**
- **Tight coupling to synthesis pipeline**

---

## Next Steps

1. **Review this proposal** with team
2. **Approve Phase 1 scope** (Profiler + Preset + Lifecycle)
3. **Create feature branch:** `feature/modularization-phase1`
4. **Extract modules one at a time** (profiler first)
5. **Test after each extraction** (unit + integration)
6. **Merge to dev** when Phase 1 complete

---

## References

- [COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md](pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md) - Architecture overview
- [GPU_MEMORY_UNIFICATION_PLAN.md](GPU_MEMORY_UNIFICATION_PLAN.md) - UnifiedGpuMemoryManager design
- [PARAMETER_REFACTORING_PLAN.md](PARAMETER_REFACTORING_PLAN.md) - Phase 6 parameter system work
- [LIFECYCLE_REFACTORING_SUMMARY.md](LIFECYCLE_REFACTORING_SUMMARY.md) - Recent lifecycle work
- [PLAYBACK_REFACTORING_PLAN.md](PLAYBACK_REFACTORING_PLAN.md) - Playback engine extraction

---

**Document prepared by:** Claude Code
**Date:** October 29, 2025
**Status:** Awaiting approval for Phase 1 execution
