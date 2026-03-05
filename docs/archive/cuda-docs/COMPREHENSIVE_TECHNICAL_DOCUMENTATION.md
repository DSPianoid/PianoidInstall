# COMPREHENSIVE TECHNICAL DOCUMENTATION: PIANOID_CUDA MODULE

**Last Updated:** January 12, 2025

## 🚀 Recent Major Updates

### Volume System Refactoring with Thread Safety (January 2025)

Complete refactoring of the volume parameter system revealed critical thread safety requirements:

#### ✅ Thread Safety Patterns Established
- **Critical Discovery:** CUDA parameter updates during playback require mutex synchronization
- **Problem Identified:** Race conditions between playback thread and parameter update operations
- **Solution Implemented:** All parameter update methods wrapped with `cuda_lock` in middleware
- **Pattern Established:** Template for future runtime parameter updates

#### ⚠️ Thread Safety Requirements

**Critical Rule:** Any Python method that calls CUDA operations during playback MUST use `cuda_lock`:

```python
# CORRECT: Thread-safe parameter update
def set_volume_level(self, level):
    import pianoidCuda
    runtime_params = pianoidCuda.RuntimeParameters(level)

    with self.cuda_lock:  # CRITICAL: Protects CUDA operations
        success = self.pianoid.setRuntimeParameters(runtime_params)

    return success
```

**Without Lock:** Playback stops, state corrupts, audio processing interrupted

**Current Status:**
- ✅ Volume parameter methods: Thread-safe
- ⚠️ Other parameter methods: Review needed
- 📋 Pattern documented for future parameters

**See:**
- [../docs/VOLUME_SYSTEM_REFACTORING_SUMMARY.md](../docs/VOLUME_SYSTEM_REFACTORING_SUMMARY.md) - Complete implementation
- [../docs/guides/VOLUME_API_GUIDE.md](../docs/guides/VOLUME_API_GUIDE.md) - Usage guide

---

### Mode Excitation Playback (October 2025)

Implemented direct soundboard mode excitation for offline playback testing:

#### ✅ Direct Mode Excitation API
- **Added** `addModeExcitation(modeNo, displacement, velocity)` - Stage mode for batch execution
- **Added** `_exciteSingleMode()` - Execute GPU memory copy (2 floats: q, q_prev)
- **Modified** `commitStringBatch()` - Execute pending mode excitation synchronously
- **Efficient:** Only 2 × sizeof(real) bytes per mode excitation

#### ✅ MIDI Integration (0xF1 Custom Command)
- **Format:** Status=0xF1, Data1=mode_index (0-255), Data2=velocity (0-127)
- **MidiEventConverter:** `createModeExcitationEvent()` with simple integer packing
- **EventDispatcher:** TEST_MODE_ONLY handler with commit call
- **Benefits:** Clean separation from note events, extensible design

#### ✅ Chart Function for Testing
- **Function:** `play_mode_chart_function()` in chartFunctions.py
- **Displays:** Mode oscillation (record 1) + generated sound (soundboard output)
- **Access:** Frontend → Charts → "Mode Playback Test"
- **Uses:** Offline playback via EventQueue → MidiEventConverter → EventDispatcher

**Critical Bug Fixes:**
1. Float packing overflow (32-bit float in 16-bit space) → Simple integer format
2. Incorrect unpacking (memcpy garbage data) → Integer extraction + calculation
3. Missing commitStringBatch() call → Mode staged but never executed

**Impact:**
- Individual mode testing and analysis capability
- Direct mode response measurement
- Bypass string-soundboard coupling for debugging
- Foundation for advanced mode analysis tools

**See [../MODE_EXCITATION_IMPLEMENTATION_SUMMARY.md](../MODE_EXCITATION_IMPLEMENTATION_SUMMARY.md) for complete implementation details.**

---

### PlaybackCycleExecutor Enhancement (October 24, 2025)

PianoidCore completed a critical refactoring to eliminate code duplication between online and offline playback engines:

#### ✅ Universal Playback Primitives
- **Added** 4 universal primitives to Pianoid class:
  - `executeSynthesisCycle()` - Wrapper for GPU kernel orchestration
  - `manageSoundBuffers()` - Audio buffer management
  - `recordCycleAudio()` - Audio capture to memory
  - `getCurrentCycleAudio()` - Extract audio from GPU
- **Benefits:** Single point of maintenance, guaranteed identical behavior across engines

#### ✅ PlaybackCycleExecutor Helper Class
- **Created** shared orchestration layer for synthesis cycles
- **Implements** `processEvents()` - unified event processing
- **Implements** `executeCycle()` - 3-step synthesis cycle (GPU → buffers → recording)
- **Added** string excitation helpers:
  - `exciteStringsForPitch(pitch, velocity)` - MIDI pitch → physical strings mapping
  - `exciteStringBatch(string_indices, velocities)` - Efficient batch triggering
- **Zero duplication:** Both online and offline engines use identical cycle logic

#### ✅ Engine Refactoring Complete
- **OnlinePlaybackEngine:** Refactored to use PlaybackCycleExecutor (Oct 24)
- **OfflinePlaybackEngine:** Already using PlaybackCycleExecutor (Oct 23)
- **EventDispatcher:** Simplified from 13 lines → 1 line for note-on handling
- **Code reduction:** ~55 lines removed across engines

**Impact:**
- Zero code duplication between playback engines
- Online engine gained audio recording capability
- Clear architectural layers: Engines (timing) → Executor (orchestration) → Pianoid (GPU)
- Easier maintenance and testing

**See [../GPU_BACKEND_EXTRACTION_STATUS.md](../GPU_BACKEND_EXTRACTION_STATUS.md) for complete implementation details.**

---

### Parameter Refactoring Project - Phases 0-5 Complete (October 12-16, 2025)

PianoidCore underwent a comprehensive 6-phase refactoring to modernize GPU memory management and parameter update systems:

#### ✅ Phase 0: Excitation Flow Refactoring (October 14, 2025)
- **Transformed** excitation parameter system from host-side selection to GPU-resident index-based access
- **Achieved 40x reduction** in memory bandwidth for note triggering (160 bytes → 4 bytes per note)
- **Eliminated** per-note memory copy overhead through full GPU-resident parameter storage (~5 MB buffer)
- **Added** `setNewExcitationParameters()` API for batch updates

**See [../EXCITATION_REFACTORING_SUMMARY.md](../EXCITATION_REFACTORING_SUMMARY.md) for complete implementation details.**

#### ✅ Phase 1-3: GPU Memory Unification (October 14-15, 2025)
- **Unified** dual memory management systems into single `UnifiedGpuMemoryManager`
- **Consolidated** 32+ GPU buffers (~180 MB total) with 5 category organization
- **Implemented** double-buffering for TUNABLE parameters, single-buffering for others
- **Added** async update pipeline with background polling thread
- **Integrated** preset library management with hot-swapping capability
- **Deleted** legacy `GpuDataHandler` and `DoubleBufferedPresetManager` classes

**Impact:**
- Single source of truth for all GPU memory
- Named parameter access with aliasing support
- Type-safe buffer management (REAL, INT, SINT32, FLOAT, DOUBLE)
- Instant preset switching via pointer swap (<1ms vs 20-50ms)

**See [../GPU_MEMORY_UNIFICATION_PLAN.md](../GPU_MEMORY_UNIFICATION_PLAN.md) for complete implementation details.**

#### ✅ Phase 4: Double-Buffer Refactoring (October 15, 2025)
- **Fixed critical memory corruption bugs:**
  - Buffer overflow in `addKernel` (wrong bounds check)
  - Large cudaMemset corruption (381 MB vs 512 bytes intended)
  - Dangling pointer bugs after `cudaDeviceReset()`
  - Dual allocation waste (~3.15 MB redundant)
- **Streamlined initialization** flow with proper lifecycle management
- **Added flexible validation** with padding to support runtime vs compile-time size differences

**See [../DOUBLE_BUFFER_REFACTORING_SUMMARY.md](../DOUBLE_BUFFER_REFACTORING_SUMMARY.md) for complete implementation details.**

#### ✅ Phase 5: Cleanup Refactoring (October 15, 2025)
- **Removed 4 legacy files:** GpuHandler.h/cpp, DoubleBufferedPresetManager.h/cu
- **Deleted 290 lines** of obsolete code from Pianoid.cu (-11%)
- **Eliminated ~180 MB** redundant GPU allocations (handler vector duplication)
- **Optimized synchronization:** Removed 2 redundant cudaDeviceSynchronize() calls
- **Cleaned comments:** Removed obsolete "PHASE X" and "REMOVED" markers

**See [../PIANOID_CLEANUP_REFACTORING_PLAN.md](../PIANOID_CLEANUP_REFACTORING_PLAN.md) for complete implementation details.**

#### 📋 Phase 6: Parameter Update Pipeline (Planned)
- **Goal:** Granular parameter updates with 100x-1000x bandwidth reduction
- **Status:** Detailed planning complete, separated into standalone project
- **Timeline:** ~20 days incremental implementation with checkpoints
- **Approach:** Build new API alongside old, validate at each step

**See Phase 6 Planning Documents:**
- [../PHASE_6_CLEAN_IMPLEMENTATION_PLAN.md](../PHASE_6_CLEAN_IMPLEMENTATION_PLAN.md) - Recommended incremental approach
- [../PHASE_6_QUICK_START.md](../PHASE_6_QUICK_START.md) - Implementation guide
- [../DOCUMENTATION_UPDATE_2025-10-16.md](../DOCUMENTATION_UPDATE_2025-10-16.md) - Complete Phase 0-5 summary

### Earlier Updates (Early October 2025)

#### Crash Fixes and Live Parameter Updates
- **Fixed initialization crashes** through improved exception handling in Python threading
- **Implemented safe live parameter updates** during audio playback using async CUDA kernel launches
- **Added `CUDA_LAUNCH_ASYNC` macro** for concurrent execution without blocking main audio loop
- **Protected note playback** during parameter updates to avoid GPU memory corruption

**See [../CRASH_FIXES_AND_LIVE_PARAMETER_UPDATES.md](../CRASH_FIXES_AND_LIVE_PARAMETER_UPDATES.md) for complete implementation details.**

---

## Section 1: Executive Summary (750 words)

### Overview

The `pianoid_cuda` module is a sophisticated GPU-accelerated physical modeling piano synthesizer that implements real-time modal synthesis of piano strings using CUDA parallel computing. This system represents a complete integration of physical modeling theory, high-performance GPU computation, real-time audio processing, and Python-accessible interfaces.

### Core Architecture

At its heart, the system employs **modal synthesis** - a technique that decomposes string vibration into discrete vibrational modes, each represented as a damped harmonic oscillator. The implementation simulates 256 modes across 256 strings simultaneously, with each simulation cycle processing up to 1024 time steps. The architecture achieves real-time performance through cooperative CUDA kernels that leverage grid-level synchronization, enabling complex string-mode coupling calculations that would be computationally prohibitive on CPU.

The main synthesis engine (`Pianoid` class in Pianoid.cu/cuh) orchestrates three primary computational domains:

1. **String Physics Simulation**: Solves finite-difference equations modeling string displacement, incorporating tension, bending stiffness, and frequency-dependent damping
2. **Modal State Evolution**: Updates modal oscillator states using coupled differential equations with bidirectional energy transfer between strings and modes
3. **Excitation Synthesis**: Generates hammer strike forces using Gaussian curve superposition with velocity layering (128 velocity levels per string)

### Key Innovations

**Bidirectional Modal Coupling**: Unlike traditional modal synthesis approaches that use one-way energy flow, this implementation features full bidirectional coupling through `feedin_cycle_matrix` and `feedback_cycle_matrix`. Strings excite modes through force summation, while modes drive string motion through spatial mode shapes - all computed within a single cooperative kernel launch.

**GPU Memory Architecture**: The system now employs a **unified memory management system** via `UnifiedGpuMemoryManager` (UnifiedGpuMemoryManager.h/.cu):

**Single Manager for All GPU Memory (~180 MB total):**
- **TUNABLE buffers** (~3.15 MB, double-buffered): Physical parameters, hammer curves, excitation envelopes, modal state - async updates with atomic pointer swapping
- **STATIC_INPUT buffers** (~3 MB, single): Configuration data like string maps, stem positions, cycle parameters
- **WORKING buffers** (~45 MB, single): Intermediate computation scratch space (dev_parameters, force functions, etc.)
- **OUTPUT buffers** (~120 MB, single): Audio output buffers, sound records, filtered sound
- **FILTER_SYSTEM buffers** (~10 MB, single): FIR filter coefficients and convolution buffers

This unified approach provides:
- Single source of truth for all GPU allocations
- Named parameter access with type safety (REAL, INT, SINT32, FLOAT, DOUBLE)
- Async update capability for preset parameters with background polling thread
- Instant preset switching via pointer swap (<1ms vs 20-50ms previously)
- Preset library management with hot-swapping

Critical performance-sensitive data resides in shared memory (e.g., `s_a[MAX_ARRAY_SIZE]` for string state), while global memory handles mode coupling through atomic operations.

**Legacy Note:** Previous dual-system architecture (DoubleBufferedPresetManager + GpuDataHandler) was unified in October 2025 refactoring, eliminating ~3.15 MB redundant allocations.

**Audio Driver Abstraction**: Recent refactoring (documented in AUDIO_REFACTORING_SUMMARY.md) extracted all audio driver functionality into a clean interface-based architecture. The `AudioDriverInterface` contract supports both SDL (software, cross-platform) and ASIO (professional, low-latency) backends through a factory pattern. Both implementations support direct GPU memory access via `CircularBuffer` with CUDA context management, eliminating CPU-side memory copies in the critical path.

**Precision Flexibility**: The entire codebase uses the `real` type abstraction (pianoid_types.h), allowing compile-time selection between float and double precision. Currently configured for float (`PIANOID_USE_FLOAT`), the system includes CUDA-intrinsic optimizations like `rsqrt()` for reciprocal square root that automatically adapt based on the selected precision and compilation target (host vs device).

### Design Philosophy

The architecture embodies several key design principles:

1. **Separation of Concerns**: Physical modeling parameters (tension, damping, hammer curves) are completely decoupled from GPU computation kernels through the parameter transformation pipeline (`parameterKernel`, `stringMapKernel`)

2. **Single Source of Truth**: The `CycleParameters` struct centralizes all simulation configuration (array sizes, channel counts, sample rates), preventing parameter drift across subsystems

3. **Safety and Observability**: Comprehensive error checking through the `CUDA_LAUNCH` macro validates memory, synchronization, and launch parameters before/after every kernel. Profiling infrastructure (`Profiler.h`) with CSV export enables performance analysis without code modification

4. **Extensibility**: The modular kernel organization (MainKernel, Kernels, gaussTest, FIRFilter) allows independent development and testing of each computational component

### Performance Characteristics

The system achieves real-time performance targeting 48kHz sample rate with 64-sample buffers (~1.3ms latency). Key performance metrics:

- **Main Kernel**: Cooperative launch with grid configuration matching string arrays (typically 64 blocks) and 2D block structure (dimX × WARP_SIZE) for optimal memory coalescing
- **Gaussian Excitation**: Grid-strided computation with 128-thread blocks processing velocity-layered hammer strikes
- **FIR Filtering**: Multi-channel convolution kernel with register-cached filters and warp-level reduction, supporting up to 18,432-tap filters

The profiling output (enabled via `PIANOID_ENABLE_PROFILING`) writes separate CPU and GPU timing CSVs, capturing per-cycle breakdown of parameterKernel, gaussKernel, and addKernel execution times alongside host-side operations.

### Integration Strategy

Python integration via pybind11 (AddArraysWithCUDA.cpp) exposes the complete `Pianoid` API while maintaining GIL release for long-running operations (`runMainApplication`, `playMidiRecord`). The build system (setup.py) implements custom NVCC integration within setuptools, auto-discovering sources and managing cross-compilation of .cu and .cpp files with appropriate compute capabilities (sm_80, sm_86, sm_89 for Ampere/Ada architectures).

### Current State and Evolution

The codebase shows evidence of ongoing refinement - recent audio driver refactoring eliminated preprocessor-based driver selection in favor of runtime polymorphism, while profiling infrastructure additions suggest active performance optimization. Debug infrastructure (`#ifdef DEBUG`, `#ifdef EXTRACT_DEBUG_DATA`) coexists with production code, indicating a system under active development rather than static deployment.

---

## System Architecture Diagrams

### High-Level Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          PYTHON APPLICATION LAYER                            │
│                                                                               │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐     │
│  │ MIDI Sequencer   │    │ Parameter Setup  │    │ Audio Analysis   │     │
│  │ - Load MIDI files│    │ - String physics │    │ - Get state      │     │
│  │ - Trigger notes  │    │ - Gauss params   │    │ - Extract records│     │
│  └────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘     │
│           │                       │                        │                │
└───────────┼───────────────────────┼────────────────────────┼────────────────┘
            │                       │                        │
            │      pybind11 Interface (pianoidCuda module)   │
            ▼                       ▼                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           PIANOID C++/CUDA CORE                              │
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                        Pianoid Class (Host)                           │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │  │
│  │  │ MIDI         │  │ Parameter    │  │ Memory       │              │  │
│  │  │ Processing   │  │ Management   │  │ Management   │              │  │
│  │  │ - Note on/off│  │ - Physical   │  │ - GpuData    │              │  │
│  │  │ - Sustain    │  │ - Excitation │  │   Handler    │              │  │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │  │
│  │         │                  │                  │                       │  │
│  │         └──────────────────┼──────────────────┘                       │  │
│  │                            ▼                                           │  │
│  │                   ┌────────────────────┐                              │  │
│  │                   │  Kernel Launcher   │                              │  │
│  │                   │  - launchMainKernel│                              │  │
│  │                   │  - Cooperative sync│                              │  │
│  │                   └────────┬───────────┘                              │  │
│  └────────────────────────────┼──────────────────────────────────────────┘  │
│                                │                                              │
│                                ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      GPU DEVICE MEMORY                               │   │
│  │                                                                       │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │   │
│  │  │ String State │  │  Mode State  │  │ Parameters   │             │   │
│  │  │ - u(t), u(t-1)│  │ - q(t), q(t-1)│ │ - 32 coeffs │             │   │
│  │  │ - 256KB      │  │ - 6KB        │  │ - 4MB        │             │   │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘             │   │
│  │         │                  │                  │                       │   │
│  │         └──────────────────┼──────────────────┘                       │   │
│  │                            ▼                                           │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │   │
│  │  │Force Function│  │Mode Coupling │  │ FIR Filters  │             │   │
│  │  │ - Gauss exc. │  │ - Feedin     │  │ - Multi-ch   │             │   │
│  │  │ - 6.3MB      │  │ - Feedback   │  │ - 18K taps   │             │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘             │   │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                       CUDA KERNELS (Device)                          │   │
│  │                                                                       │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │   │
│  │  │parameterKernel│  │ gaussKernel  │  │  addKernel   │             │   │
│  │  │ - Phys→Coeffs│  │ - Excitation │  │ - Main physics│            │   │
│  │  │ - 0.1-0.2 ms │  │ - 0.05-1.0ms │  │ - 0.8-1.2 ms │             │   │
│  │  └──────────────┘  └──────────────┘  └──────┬───────┘             │   │
│  │                                               │                       │   │
│  │                                               ▼                       │   │
│  │                                      ┌──────────────┐                │   │
│  │                                      │convolutionKernel│             │   │
│  │                                      │ - FIR filter │                │   │
│  │                                      │ - Multi-channel│              │   │
│  │                                      └──────┬───────┘                │   │
│  └─────────────────────────────────────────────┼────────────────────────┘  │
│                                                 │                            │
└─────────────────────────────────────────────────┼────────────────────────────┘
                                                  │
                                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          AUDIO OUTPUT LAYER                                  │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────┐            │
│  │              AudioDriverInterface (Abstract)                │            │
│  │  + init()  + start()  + pause()  + pushSamples()          │            │
│  └─────────────────┬──────────────────────┬────────────────────┘            │
│                    │                      │                                  │
│         ┌──────────▼─────────┐  ┌────────▼──────────┐                      │
│         │  SDLAudioDriver    │  │ ASIOAudioDriver   │                      │
│         │                    │  │                   │                      │
│         │ - CircularBuffer   │  │ - LockFreeCircular│                      │
│         │   (mutex-based)    │  │   Buffer (atomic) │                      │
│         │ - Cross-platform   │  │ - Low-latency     │                      │
│         │ - Software mixing  │  │ - Professional    │                      │
│         └──────────┬─────────┘  └────────┬──────────┘                      │
│                    │                      │                                  │
│                    └──────────┬───────────┘                                  │
│                               ▼                                              │
│                    ┌──────────────────────┐                                 │
│                    │   Audio Hardware     │                                 │
│                    │   (Speakers/DAC)     │                                 │
│                    └──────────────────────┘                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow Diagram: Single Synthesis Cycle

```
START CYCLE (every 1.33ms @ 48kHz, 64 samples)
    │
    ├─── [MIDI Event Check] ───────────────────────────────────────┐
    │         │                                                     │
    │         ├─ New Note? ──YES──> processMidiPoints()           │
    │         │                      - Parse MIDI data             │
    │         │                      - Map pitch→strings           │
    │         │                      - Update new_notes_ind        │
    │         │                                                     │
    │         └─ NO ─────────────────────────────────────────────> │
    │                                                               │
    ▼                                                               ▼
┌───────────────────────────────────────────────────────────────────────┐
│  HOST: Parameter Update (if new_notes_ind > 0)                       │
│                                                                       │
│  parameterKernel<<<num_string_arrays, arraySize>>>                  │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ INPUT: physical_parameters[NUM_STRINGS × 16]                │   │
│  │        - length, tension, damping, radius, etc.             │   │
│  │                                                              │   │
│  │ PROCESS: Transform to finite-difference coefficients        │   │
│  │   coeff_tension = T / (dx² × ρ × Δt²)                      │   │
│  │   coeff_bending = EI / (dx⁴ × Δt²)                         │   │
│  │   coeff_damping = γ / (Δt × 1000)                          │   │
│  │                                                              │   │
│  │ OUTPUT: parameters[total_points × 32]                       │   │
│  │         - shift_0, shift_1, shift_2, shift_b, ...          │   │
│  └─────────────────────────────────────────────────────────────┘   │
│  Time: ~0.1-0.2 ms                                                  │
└───────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌───────────────────────────────────────────────────────────────────────┐
│  HOST: Excitation Generation (if new_notes_ind > 1)                  │
│                                                                       │
│  gaussKernel<<<dim3(numStrings, numSegments), 128>>>                │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ INPUT: gauss_params[NUM_STRINGS × 128 × 20]                │   │
│  │        - mu[5], sigma[5], volume[5], shift[5]              │   │
│  │                                                              │   │
│  │ PROCESS: Generate hammer excitation force                   │   │
│  │   For each string × velocity layer:                         │   │
│  │     F(t) = Σᵢ vol[i] × max(0, exp(-0.5×((t-μ[i])/σ[i])²) - shift[i])│
│  │                                                              │   │
│  │ OUTPUT: force_function[num_strings × 64 × 12 × 8]          │   │
│  │         - Time-domain excitation waveforms                  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│  Time: ~0.05-1.0 ms (depends on active notes)                      │
└───────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌───────────────────────────────────────────────────────────────────────┐
│  DEVICE: Main Physics Simulation (COOPERATIVE KERNEL)                │
│                                                                       │
│  addKernel<<<64 blocks, dim3(16,32) threads>>> [Grid-Synced]        │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ INITIALIZATION (once per cycle)                             │   │
│  │  - Load string_state → s_a[] (shared memory)               │   │
│  │  - Load mode_state → s_mode[] (shared memory)              │   │
│  │  - Load force_function → s_force_function[]                │   │
│  │  - __syncthreads_grid()                                     │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                       │
│  MAIN LOOP: for (cycle_idx = 0; cycle_idx < 64; cycle_idx++)       │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                                                              │   │
│  │ [1] MODES → STRINGS (Feedback)                             │   │
│  │     ┌──────────────────────────────────────────┐           │   │
│  │     │ Each mode writes to feedback_matrix:     │           │   │
│  │     │   atomicAdd(feedback_matrix[string_idx], │           │   │
│  │     │             mode_feedback[i] × s_mode[k])│           │   │
│  │     │                                           │           │   │
│  │     │ __syncthreads_grid()                     │           │   │
│  │     │                                           │           │   │
│  │     │ Sum feedback_matrix → s_feedback[]       │           │   │
│  │     │   (warp shuffle reduction)                │           │   │
│  │     └──────────────────────────────────────────┘           │   │
│  │                                                              │   │
│  │ [2] STRING EVOLUTION (soundStep iterations)                │   │
│  │     ┌──────────────────────────────────────────┐           │   │
│  │     │ FOR j = 0 to soundStep (12 steps):      │           │   │
│  │     │                                           │           │   │
│  │     │   Load neighbors: sa_-2, sa_-1, sa_+1, sa_+2│       │   │
│  │     │                                           │           │   │
│  │     │   Finite-difference stencil:              │           │   │
│  │     │     target = target × shift_0             │           │   │
│  │     │            + s_b × shift_b                │           │   │
│  │     │            + (sa_-2 + sa_+2) × shift_2   │           │   │
│  │     │            + (sa_-1 + sa_+1) × shift_1   │           │   │
│  │     │            + (d3 - d3_prev) × coeff_decay│           │   │
│  │     │            + s_force[j] × coeff_force    │           │   │
│  │     │                                           │           │   │
│  │     │   Apply boundary: if (onStem) target = feedback│     │   │
│  │     │                                           │           │   │
│  │     │   Update: s_b = s_a[i]; s_a[i] = target │           │   │
│  │     │                                           │           │   │
│  │     │   Record bridge force:                    │           │   │
│  │     │     force += shift_F1 × (neighbor - feedback)│       │   │
│  │     └──────────────────────────────────────────┘           │   │
│  │                                                              │   │
│  │ [3] STRINGS → MODES (Feedin)                               │   │
│  │     ┌──────────────────────────────────────────┐           │   │
│  │     │ Sum bridge forces (atomic)                │           │   │
│  │     │                                           │           │   │
│  │     │ Each string writes to feedin_matrix:     │           │   │
│  │     │   atomicAdd(feedin_matrix[mode_idx],     │           │   │
│  │     │             mode_feedin[i] × bridge_force)│           │   │
│  │     │                                           │           │   │
│  │     │ __syncthreads_grid()                     │           │   │
│  │     │                                           │           │   │
│  │     │ Sum feedin_matrix → s_mode_force[]       │           │   │
│  │     └──────────────────────────────────────────┘           │   │
│  │                                                              │   │
│  │ [4] MODE UPDATE (Verlet integration)                       │   │
│  │     ┌──────────────────────────────────────────┐           │   │
│  │     │ result = (2×q(t) - q(t-1))               │           │   │
│  │     │        + q(t-1) × decay                   │           │   │
│  │     │        - q(t) × omega²                    │           │   │
│  │     │        + force × mass_inv                 │           │   │
│  │     │        × (1 - decay)                      │           │   │
│  │     │                                           │           │   │
│  │     │ q(t-1) = q(t); q(t) = result             │           │   │
│  │     └──────────────────────────────────────────┘           │   │
│  │                                                              │   │
│  │ [5] AUDIO OUTPUT                                            │   │
│  │     soundFloat[sample_idx] = feedback - s_b                │   │
│  │                                                              │   │
│  │ __syncthreads_grid()                                        │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                       │
│  FINALIZATION:                                                       │
│  - Write s_a[] → string_state (global)                              │
│  - Write s_mode[] → mode_state (global)                             │
│  - Increment excitation cycle index                                  │
│                                                                       │
│  Time: ~0.8-1.2 ms                                                   │
└───────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌───────────────────────────────────────────────────────────────────────┐
│  HOST: FIR Filtering (optional)                                      │
│                                                                       │
│  convolutionKernel<<<maxBlocks, samplesPerCycle>>>                  │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ INPUT: soundFloat[64 samples × 2 channels]                 │   │
│  │        filter_taps[18432 taps × 2 filters]                 │   │
│  │                                                              │   │
│  │ PROCESS: Multi-channel convolution                          │   │
│  │   For each output sample:                                   │   │
│  │     y[n] = Σₖ x[n-k] × h[k]                                │   │
│  │                                                              │   │
│  │ OUTPUT: filtered_sound[64 × 2]                             │   │
│  └─────────────────────────────────────────────────────────────┘   │
│  Time: ~0.2-0.5 ms                                                  │
└───────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌───────────────────────────────────────────────────────────────────────┐
│  HOST: Audio Playback                                                │
│                                                                       │
│  audioDriver->pushSamples(soundFloat, 64 × 2 × sizeof(Sint32))      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ SDL Driver:                                                  │   │
│  │   cudaMemcpy(host_buffer, soundFloat, size, D2H)           │   │
│  │   CircularBuffer.produce(host_buffer)                       │   │
│  │   - Mutex lock/unlock                                        │   │
│  │   - Condition variable notify                                │   │
│  │                                                              │   │
│  │ ASIO Driver:                                                 │   │
│  │   cudaMemcpy(host_buffer, soundFloat, size, D2H)           │   │
│  │   LockFreeCircularBuffer.produce(host_buffer)               │   │
│  │   - Atomic index increment                                   │   │
│  │   - No blocking                                              │   │
│  └─────────────────────────────────────────────────────────────┘   │
│  Time: ~0.1-0.3 ms                                                  │
└───────────────────────────────────────────────────────────────────────┘
    │
    ▼
END CYCLE
Total Time: 1.0-1.5 ms (within 1.33ms real-time budget ✓)
```

### Memory Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           HOST MEMORY (RAM)                             │
│                                                                          │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐           │
│  │ Physical Params│  │ Gauss Params   │  │ Mode Coeffs    │           │
│  │ 256×16 floats  │  │ 256×128×20     │  │ 2×256×256      │           │
│  └────────┬───────┘  └────────┬───────┘  └────────┬───────┘           │
│           │                   │                   │                     │
└───────────┼───────────────────┼───────────────────┼─────────────────────┘
            │ cudaMemcpy        │ cudaMemcpy        │ cudaMemcpy
            │ (H2D, once)       │ (H2D, on note)    │ (H2D, once)
            ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        DEVICE GLOBAL MEMORY (VRAM)                       │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    PARAMETER BUFFERS                             │   │
│  │                                                                  │   │
│  │  dev_physical_parameters ──┬──> parameterKernel (read)         │   │
│  │  (256 strings × 16 params)  │                                   │   │
│  │                             │                                   │   │
│  │  dev_gauss_parameters ──────┼──> gaussKernel (read)            │   │
│  │  (256 × 128 × 20)           │                                   │   │
│  │                             │                                   │   │
│  │  dev_deck_parameters ───────┼──> addKernel (read, mode coeffs) │   │
│  │  (2 × 256 × 256)            │                                   │   │
│  └─────────────────────────────┼───────────────────────────────────┘   │
│                                │                                         │
│  ┌─────────────────────────────▼───────────────────────────────────┐   │
│  │                  DERIVED COEFFICIENT BUFFER                      │   │
│  │                                                                  │   │
│  │  dev_parameters ←── parameterKernel (write)                     │   │
│  │  (total_points × 32 coefficients)                               │   │
│  │   ├─ shift_0, shift_1, shift_2, shift_b                        │   │
│  │   ├─ coeff_force, coeff_frequency_decay                        │   │
│  │   └─ stringNo, onString, onStem, isStem                        │   │
│  │                  │                                               │   │
│  │                  └─────> addKernel (read, every cycle)         │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    EXCITATION BUFFER                              │   │
│  │                                                                  │   │
│  │  dev_force_function ←── gaussKernel (write, on note trigger)   │   │
│  │  (256 strings × 64 samples × 12 steps × 8 cycles)              │   │
│  │                     │                                            │   │
│  │                     └─────> addKernel (read, inner loop)       │   │
│  │                             - Loaded to s_force_function[]       │   │
│  │                               (shared memory)                    │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                       STATE BUFFERS                               │   │
│  │                                                                  │   │
│  │  dev_string_state ←──┬─> addKernel (read at start)             │   │
│  │  (2 × array_size × 64)│    - u(t), u(t-1)                       │   │
│  │                       │    - Copied to s_a[], s_b (shared mem)  │   │
│  │                       │                                          │   │
│  │                       └─── addKernel (write at end)             │   │
│  │                            - Updated state written back          │   │
│  │                                                                  │   │
│  │  dev_mode_state ←──┬─> addKernel (read at start)               │   │
│  │  (6 × 256 modes)    │    - q(t), q(t-1), decay, omega², mass⁻¹│   │
│  │                     │    - Copied to s_mode[] (shared memory)   │   │
│  │                     │                                            │   │
│  │                     └─── addKernel (write at end)               │   │
│  │                          - Updated modal state written back      │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                  COUPLING MATRICES (Temporary)                    │   │
│  │                                                                  │   │
│  │  feedin_cycle_matrix ←──┬─── addKernel (write, strings)        │   │
│  │  (64 × 256 = 16K floats)│     - Strings write forces to modes  │   │
│  │                          │     - atomicAdd() from all threads   │   │
│  │                          │                                       │   │
│  │                          ├──> sumArray() - warp reduction      │   │
│  │                          │     - Sum into s_mode_force[]        │   │
│  │                          │                                       │   │
│  │                          └──> CLEARED after each outer iter     │   │
│  │                                                                  │   │
│  │  feedback_cycle_matrix ←─┬─── addKernel (write, modes)         │   │
│  │  (64 × 256 = 16K floats) │     - Modes write forces to strings │   │
│  │                           │     - atomicAdd() from mode threads │   │
│  │                           │                                      │   │
│  │                           ├──> sumArray() - warp reduction     │   │
│  │                           │     - Sum into s_feedback[]         │   │
│  │                           │                                      │   │
│  │                           └──> CLEARED after each outer iter    │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                       OUTPUT BUFFERS                              │   │
│  │                                                                  │   │
│  │  dev_soundFloat ←─── addKernel (write, at stem points)         │   │
│  │  (64 samples × 2 ch)  │                                          │   │
│  │                       │                                          │   │
│  │                       ├─> convolutionKernel (read, if filtering)│   │
│  │                       │    └─> dev_filtered_sound (write)       │   │
│  │                       │                                          │   │
│  │                       └─> cudaMemcpy (D2H, to audio driver)     │   │
│  │                           CircularBuffer.produce()               │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
            │
            │ cudaMemcpy (D2H, after cycle)
            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           HOST MEMORY (RAM)                             │
│                                                                          │
│  ┌────────────────┐                                                     │
│  │ Audio Buffer   │──> SDL/ASIO Driver ──> Hardware DAC ──> Speakers  │
│  │ (host copy)    │                                                     │
│  └────────────────┘                                                     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Section 2: Physical Modeling Theory (1800 words)

### Mathematical Foundations of Modal Synthesis

Modal synthesis represents string vibration as a superposition of orthogonal vibrational modes. For a piano string of length L, each mode k corresponds to a standing wave with spatial function:

```
φ_k(x) = sin(kπx/L)
```

The string displacement u(x,t) decomposes as:

```
u(x,t) = Σ_k q_k(t) · φ_k(x)
```

where q_k(t) represents the modal amplitude (time-varying oscillator state) for mode k. This formulation converts the continuous partial differential equation (PDE) of string motion into a system of coupled ordinary differential equations (ODEs), which are vastly more efficient to solve numerically.

### String Physics Equations

The implementation solves a **stiff string equation** incorporating both tension and bending stiffness:

```
ρ ∂²u/∂t² = T ∂²u/∂x² - EI ∂⁴u/∂x⁴ - 2ρB₁ ∂u/∂t + 2B₂ ∂³u/∂x²∂t + F_ext(x,t)
```

Where:
- ρ: linear mass density (kg/m)
- T: string tension (N)
- E: Young's modulus (Pa)
- I: moment of inertia (π r⁴/4 for circular cross-section)
- B₁: damping coefficient (frequency-independent)
- B₂: damping coefficient (frequency-dependent)
- F_ext: external forcing (hammer strike, mode coupling)

The **parameterKernel** (Kernels.cu:80-168) transforms physical parameters into finite-difference coefficients:

```cpp
real coeff_tension = tension / (dxMm2 * coeff_ro * iterPerMs * iterPerMs);
real coeff_bending = (π * 250000 * r⁴ * E) / (ρ * dx⁴ * iterPerMs²);
real coeff_frequency_decay = frequency_dependent_damping * 1e12 / (2 * dxMm2);
```

These coefficients directly map to the finite-difference stencil implemented in **MainKernel.cu:464-481**:

```cpp
d3 = (sa__1 + sa_1 - 2 * target);  // Second spatial derivative
target *= shift_0;                   // Central point coefficient
target += s_b * shift_b;            // Previous time step
target += (sa__2 + sa_2) * shift_2; // Fourth-order stencil
target += (sa__1 + sa_1) * shift_1; // Second-order stencil
target += (d3 - d3_1) * coeff_frequency_decay;  // Frequency-dependent damping
target += s_force_function[ff_start_index + j] * coeff_force;  // External force
```

This represents a **fourth-order central difference** scheme for spatial derivatives and a **two-step implicit** scheme for temporal evolution, providing numerical stability at the cost of one time-step of memory (stored in `s_b` for each point).

### Modal Oscillator Dynamics

Each mode evolves according to a **damped harmonic oscillator** equation:

```
m_k q̈_k + γ_k q̇_k + ω_k² q_k = F_k(t)
```

The discrete-time implementation (MainKernel.cu:578-587) uses a **Störmer-Verlet-like** integrator:

```cpp
result = ((2 * s_mode[quarterNumber] - mode_1) +  // Position extrapolation
          mode_1 * mode_dec -                      // Damping from previous step
          s_mode[quarterNumber] * mode_omega +     // Restoring force
          s_mode_applied_force[quarterNumber] * mode_mass_inv  // External forcing
         ) * (1 - mode_dec);                       // Damping normalization
mode_1 = s_mode[quarterNumber];                    // Store for next iteration
s_mode[quarterNumber] = result;                    // Update current state
```

The `mode_state` array (dev_mode_state, 6 × NUM_MODES elements) stores:
- Index 0-255: q_k(t) - current modal amplitude
- Index 256-511: q_k(t-1) - previous amplitude (for Verlet scheme)
- Index 512-767: decay coefficient (γ_k)
- Index 768-1023: angular frequency squared (ω_k²)
- Index 1024-1279: inverse modal mass (1/m_k)
- Index 1280-1535: (reserved for future expansion)

### Bidirectional Mode-String Coupling

The innovation of this implementation lies in **simultaneous bidirectional coupling** between modes and strings:

**String-to-Mode (Feedin) Path:**
Forces from the string (bridge reaction forces) excite modal oscillators:

```cpp
// Record force at stem points (MainKernel.cu:496-500)
if (isStem || onStem) {
    force_on_bridge_point += shift_F1 * (s_a[pointIndex ± 1] - feedback);
}

// Sum forces and project onto modes (MainKernel.cu:534-538)
for (int i = 0; i < NUM_FOLDS_IN_QUARTER; i++) {
    atomicAdd(feedin_cycle_matrix + ...,
              mode_feedin[i] * force_on_bridge_summed[quarterNumber] / soundStep);
}
```

The `mode_feedin` coefficients come from the `mode_coefficients` array (dev_deck_parameters, 2 × NUM_STRINGS × NUM_MODES elements), representing the spatial overlap integral:

```
mode_feedin[k,s] = ∫ φ_k(x) · F_s(x) dx
```

**Mode-to-String (Feedback) Path:**
Modal amplitudes generate forces that drive string motion:

```cpp
// Modes write their contribution (MainKernel.cu:382-388)
for (int i = 0; i < NUM_FOLDS_IN_QUARTER; i++) {
    atomicAdd(feedback_cycle_matrix + ...,
              mode_feedback[i] * s_mode[quarterNumber]);
}

// Strings sum feedback and apply (MainKernel.cu:411, 483-485)
sumArray(&feedback_cycle_matrix[...], ..., s_feedback, ...);
if (onStem) {
    target = feedback;  // Stem point forced to modal feedback value
}
```

The `mode_feedback` coefficients similarly encode the mode shape projection:

```
mode_feedback[s,k] = φ_k(x_stem_s)
```

The critical insight is that feedin and feedback matrices are **zeroed and recomputed every inner timestep** (MainKernel.cu:430-431, 593-595), ensuring energy conservation while allowing complex multi-string coupling through shared modes.

### Excitation Model: Gaussian Hammer Strikes

Piano hammer-string interaction is modeled using **superposition of Gaussian pulses** (gaussKernel, gaussTest.cu:20-94). Each velocity layer (128 levels × 256 strings = 32,768 excitations) defines 5 Gaussian curves with parameters:

```cpp
// Gauss parameters (LEN_LEVEL_GP = 20 floats per velocity/string)
real mu[5]      = gauss_params[blockind * LEN_LEVEL_GP + 0..4];     // Peak positions
real sigma[5]   = gauss_params[blockind * LEN_LEVEL_GP + 5..9];     // Widths
real g_vol[5]   = gauss_params[blockind * LEN_LEVEL_GP + 10..14];   // Amplitudes
real g_shift[5] = gauss_params[blockind * LEN_LEVEL_GP + 15..19];   // Vertical offsets
```

The excitation force as a function of normalized time x is:

```cpp
result = Σ_i g_vol[i] * max(0, exp(-0.5 * ((x - mu[i])/sigma[i])²) - g_shift[i])
```

The `max(0, ...)` ensures non-negative forces (piano hammers push, not pull). The temporal discretization spans `EXCITATION_FACTOR = 8` cycles, with the kernel grid configured as:

```cpp
dim3 gaussGridSize(numStrings, numSegments);  // 2D grid
int gaussBlockSize = 128;                      // Threads per block
// numSegments = samplesInCycle * soundStep * (EXCITATION_FACTOR - 1) / 128
```

This produces a force function `dev_force_function` of size:
```
num_strings × samplesInCycle × soundStep × EXCITATION_FACTOR
```

Each note trigger rotates through these 8 excitation cycles using `exct_cycle_index`, allowing overlapping notes without excitation buffer exhaustion.

### Damping Models

Three damping mechanisms operate simultaneously:

1. **Structural Damping** (frequency-independent):
```cpp
dec_curr = coeff_gamma / (iterPerMs * 1000)
```
Applied via the time-step coefficient `shift_b` in the string equation.

2. **Frequency-Dependent Damping**:
```cpp
coeff_frequency_decay = frequency_dependent_damping * 1e12 / (2 * dxMm2)
target += (d3 - d3_1) * coeff_frequency_decay
```
This term implements a discrete **third-derivative damping** that preferentially attenuates high-frequency components, modeling air resistance and internal friction.

3. **Sustain Pedal Damper**:
```cpp
int dump_coeff = pow((127 - *sustain_value) * dumper_position[stringNo], 0.6);
```
Nonlinearly scales damping based on MIDI sustain pedal value (0-127), with felt damper position per string. The 0.6 exponent models felt compression dynamics.

### Relationship to Real Piano Acoustics

The model captures several key phenomena:

**Inharmonicity**: Bending stiffness (EI term) causes partial frequencies to deviate from integer multiples of the fundamental:
```
f_n = n·f₀·√(1 + B·n²)
```
where B ∝ E·I/(T·L²) is the inharmonicity coefficient.

**Phantom Partials**: Bidirectional mode-string coupling allows energy transfer between strings sharing common modes (unison strings in the bass, duplex scaling in the treble), creating the characteristic "chorus" effect.

**Attack Transients**: The multi-Gaussian excitation model captures the complex spectral evolution during hammer contact, including the initial broadband "thump" and subsequent harmonic build-up.

**Limitations**: The current implementation does not model:
- Soundboard radiation (all output from virtual bridge pickup)
- Longitudinal/torsional string modes (only transverse vibration)
- Nonlinear string behavior (large amplitude) - assumes small perturbations
- Hammer-string contact duration variability with velocity

---

## Section 3: GPU Architecture Deep Dive (2800 words)

### Memory Layout and Organization

The pianoid_cuda system employs a sophisticated multi-tier memory hierarchy optimized for the NVIDIA GPU architecture:

#### Global Memory Buffers

All persistent state resides in global device memory, managed through `GpuDataHandler` objects. The memory map:

```
┌─────────────────────────────────────────────────────────────┐
│ MODE STATE (dev_mode_state)                                 │
│ Size: 6 × NUM_MODES × sizeof(real) = 6 × 256 × 4 = 6KB    │
│ Layout: [q(t), q(t-1), decay, omega², mass_inv, reserved]  │
├─────────────────────────────────────────────────────────────┤
│ STRING STATE (dev_string_state)                             │
│ Size: 2 × arraySize × num_string_arrays × sizeof(real)     │
│      = 2 × 512 × 64 × 4 = 256KB                           │
│ Layout: [u(t,x), u(t-1,x)] for all string points          │
├─────────────────────────────────────────────────────────────┤
│ PARAMETERS (dev_parameters)                                 │
│ Size: POINT_PARAMETERS_NO × total_points × sizeof(real)    │
│      = 32 × 32,768 × 4 = 4MB                              │
│ Stores: 32 derived coefficients per discretization point   │
├─────────────────────────────────────────────────────────────┤
│ MODE COEFFICIENTS (dev_deck_parameters)                     │
│ Size: 2 × NUM_STRINGS × NUM_MODES × sizeof(real)          │
│      = 2 × 256 × 256 × 4 = 512KB                          │
│ Layout: [feedin_coeff, feedback_coeff] for all mode-string │
├─────────────────────────────────────────────────────────────┤
│ FORCE FUNCTION (dev_force_function)                         │
│ Size: num_strings × samplesInCycle × soundStep ×          │
│       EXCITATION_FACTOR × sizeof(real)                     │
│      = 256 × 64 × 12 × 8 × 4 = 6.3MB                      │
│ Per-string excitation waveforms (8 cycle rotation)         │
├─────────────────────────────────────────────────────────────┤
│ COUPLING MATRICES (mode_position, mode_new_position)       │
│ Size: SEGMENT_FOR_SHUFFLE_SUMMATION × NUM_STRINGS ×       │
│       sizeof(real) × 2                                     │
│      = 64 × 256 × 4 × 2 = 128KB                           │
│ Temporary storage for mode-string coupling summation       │
└─────────────────────────────────────────────────────────────┘
Total typical allocation: ~11.5 MB (for 256 strings, 256 modes)
```

#### Shared Memory Organization

The `addKernel` uses block-local shared memory for high-bandwidth access:

```cpp
__shared__ real s_a[MAX_ARRAY_SIZE];                    // 512 × 4B = 2KB
__shared__ real s_mode[MAX_NUM_STRINGS_IN_ARRAY];       // 4 × 4B = 16B
__shared__ real s_feedback[MAX_NUM_STRINGS_IN_ARRAY];   // 4 × 4B = 16B
__shared__ real s_force_function[                       // Variable size
    MAX_ITERATIONS_IN_CYCLE * MAX_NUM_STRINGS_IN_ARRAY]; // ~1KB typical
__shared__ real force_on_bridge_summed[MAX_NUM_STRINGS_IN_ARRAY]; // 16B
__shared__ real s_mode_applied_force[MAX_NUM_STRINGS_IN_ARRAY];   // 16B
```

Total shared memory per block: ~3KB (well under typical 48KB limit)

This organization enables:
- **Zero global memory reads** for string state updates during inner iteration
- **Coalesced global writes** at iteration boundaries
- **Broadcast-efficient** modal state access (all threads read same `s_mode`)

#### Register File Usage

Critical variables reside in registers:

```cpp
real target;      // Current string displacement (updated inner loop)
real s_b;         // Previous time-step displacement
real d3, d3_1;    // Spatial derivatives (for freq-dependent damping)
real mode_1;      // Previous modal amplitude (per quarter)
real mode_dec, mode_omega, mode_mass_inv;  // Modal coefficients
```

The compiler allocates ~20-30 registers per thread, keeping the **occupancy** high (limiting factor is typically shared memory, not registers).

### Kernel Analysis: addKernel (Main Physics Kernel)

#### Thread Organization

The kernel uses a **2D block structure** mapped to string points:

```cpp
dim3 blockSize(dimX, WARP_SIZE);  // dimX = arraySize / 32
int pointIndex = threadIdx.y + threadIdx.x * WARP_SIZE;
```

For arraySize=512:
- dimX = 512/32 = 16
- Block configuration: 16 × 32 = 512 threads per block
- Each thread → one discretization point on the string subdivision

Grid configuration:
```cpp
int numBlocks = num_strings / num_strings_in_array;  // Typically 64
```

Each block processes `num_strings_in_array` (default 4) complete strings packed into shared arrays.

#### Execution Flow Pseudocode

```
KERNEL addKernel(...) {
    // === INITIALIZATION PHASE ===
    tid = threadIdx.x + threadIdx.y * blockDim.x
    pointIndex = threadIdx.y + threadIdx.x * WARP_SIZE
    blockNo = blockIdx.x

    // Load parameters from global memory
    stringNo = parameters[start_ind + 11*arraySize + pointIndex]
    shift_0 = parameters[start_ind + 0*arraySize + pointIndex]
    shift_1 = parameters[start_ind + 1*arraySize + pointIndex]
    // ... (load all 32 parameters)

    // Initialize shared memory state
    if (status == RESET) {
        s_a[pointIndex] = 0
        s_b = 0
    } else {
        s_a[pointIndex] = string_state[blockNo*arraySize + pointIndex]
        s_b = string_state[numBlocks*arraySize + blockNo*arraySize + pointIndex]
    }

    // Load modal state (one thread per quarter)
    if (indexInQuarter == 0 && modeNo < NUM_MODES) {
        s_mode[quarterNumber] = mode_state[modeNo]
        mode_1 = mode_state[NUM_MODES + modeNo]
        mode_dec = mode_state[2*NUM_MODES + modeNo]
        mode_omega = mode_state[3*NUM_MODES + modeNo]
        mode_mass_inv = mode_state[4*NUM_MODES + modeNo]
    }

    // Load excitation forces into shared memory
    if (indexInQuarter < samplesInCycle) {
        ec_index = exct_cycle_index[stringNoForQuarter]
        for (k = 0; k < soundStep; k++) {
            n = indexInQuarter * soundStep + k
            s_force_function[...] = force_function[...]
        }
    }

    __syncthreads()
    __syncthreads_grid()  // Cooperative kernel: all blocks

    // === MAIN ITERATION (outer cycle) ===
    for (main_cycle_index = 0; main_cycle_index < samplesInCycle; main_cycle_index++) {

        // --- FEEDBACK FROM MODES TO STRINGS ---
        // Each mode writes feedback to global matrix
        if (modeNo < NUM_MODES) {
            for (i = 0; i < NUM_FOLDS_IN_QUARTER; i++) {
                atomicAdd(feedback_cycle_matrix + ...,
                          mode_feedback[i] * s_mode[quarterNumber])
            }
        }
        __syncthreads()
        __syncthreads_grid()

        // Sum feedback matrix into shared memory
        sumArray(&feedback_cycle_matrix[...], ..., s_feedback, ...)

        if (onStem) {
            feedback = s_feedback[stringInArr]
        }

        // Clear feedback matrix for next iteration
        if (tid < SEGMENT_FOR_SHUFFLE_SUMMATION * numStringsInArray) {
            feedback_cycle_matrix[...] = 0
        }

        // Output sound sample at stem
        if (outerSoundChannel && isStem) {
            soundFloat[sampleIndex] = feedback - s_b
        }

        // --- STRING INNER ITERATION ---
        target = s_a[pointIndex]
        force_on_bridge_point = 0

        for (j = 0; j < soundStep; j++) {
            if (onString) {
                // Load neighbors from shared memory
                sa__2 = s_a[pointIndex - 2]
                sa__1 = s_a[pointIndex - 1]
                sa_1 = s_a[pointIndex + 1]
                sa_2 = s_a[pointIndex + 2]

                // Finite-difference stencil
                d3_1 = d3
                d3 = (sa__1 + sa_1 - 2*target)

                target = target * shift_0 +
                         s_b * shift_b +
                         (sa__2 + sa_2) * shift_2 +
                         (sa__1 + sa_1) * shift_1 +
                         (d3 - d3_1) * coeff_frequency_decay +
                         s_force_function[...] * coeff_force
            }

            if (onStem) {
                target = feedback  // Boundary condition
            }

            __syncthreads()

            // Update shared memory state
            s_b = s_a[pointIndex]
            s_a[pointIndex] = target

            __syncthreads()

            // Record bridge force
            if (isStem || onStem) {
                force_on_bridge_point += shift_F1 * (s_a[...] - feedback)
            }
        }

        // --- FEEDIN FROM STRINGS TO MODES ---
        // Sum bridge forces
        if (isStem) {
            force_on_bridge_summed[stringInArr] = 0
        }
        __syncthreads()

        if (onStem) {
            atomicAdd(&force_on_bridge_summed[stringInArr],
                      force_on_bridge_point)
        }
        __syncthreads()

        // Project forces onto modes
        for (i = 0; i < NUM_FOLDS_IN_QUARTER; i++) {
            if (modeIndexInQuarter[i] < NUM_MODES) {
                atomicAdd(feedin_cycle_matrix + ...,
                          mode_feedin[i] * force_on_bridge_summed[...] / soundStep)
            }
        }
        __syncthreads()
        __syncthreads_grid()

        // Sum feedin matrix into shared memory
        sumArray(&feedin_cycle_matrix[...], ..., s_mode_applied_force, ...)

        // Output mode sound (if enabled)
        if (outerSoundModeChannel && indexInQuarter == 0) {
            soundFloat[sampleIndex] = s_mode_applied_force[quarterNumber]
        }

        // --- MODE UPDATE ---
        if (modeNo < NUM_MODES && indexInQuarter == 0) {
            result = ((2*s_mode[quarterNumber] - mode_1) +
                      mode_1 * mode_dec -
                      s_mode[quarterNumber] * mode_omega +
                      s_mode_applied_force[quarterNumber] * mode_mass_inv
                     ) * (1 - mode_dec)
            mode_1 = s_mode[quarterNumber]
            s_mode[quarterNumber] = result
        }
        __syncthreads()

        // Clear feedin matrix for next iteration
        if (tid < SEGMENT_FOR_SHUFFLE_SUMMATION * numStringsInArray) {
            feedin_cycle_matrix[...] = 0
        }

        __syncthreads()
        __syncthreads_grid()
    }

    // === FINALIZATION PHASE ===
    // Write back string state
    string_state[blockNo*arraySize + pointIndex] = s_a[pointIndex]
    string_state[numBlocks*arraySize + blockNo*arraySize + pointIndex] = s_b

    // Write back modal state
    if (indexInQuarter == 0 && modeNo < NUM_MODES) {
        mode_state[modeNo] = s_mode[quarterNumber]
        mode_state[NUM_MODES + modeNo] = mode_1
    }

    // Increment excitation cycle index
    if (blockIdx.x == 0 && tid < NUM_STRINGS) {
        if (exct_cycle_index[tid] < EXCITATION_FACTOR - 1) {
            exct_cycle_index[tid]++
        }
    }
}
```

#### Critical Synchronization Points

The kernel uses **cooperative groups** for grid-level synchronization:

```cpp
grid_group allBlocks = this_grid();
thread_group allThreads = this_thread_block();

// Block-level sync (within-block coherency)
allThreads.sync();

// Grid-level sync (all blocks must reach this point)
allBlocks.sync();
```

Grid synchronization occurs at **6 critical junctures per outer iteration**:
1. After modes write feedback matrix
2. After feedback matrix summation completes
3. After feedin matrix write
4. After feedin matrix summation completes
5. After mode updates complete
6. Before starting next iteration

This pattern enables **pipelined computation** where different blocks work on different string arrays concurrently, with synchronization only where data dependencies exist.

#### Atomic Operation Strategy

The system uses `atomicAdd` for two purposes:

**1. Mode-String Coupling Summation**:
```cpp
atomicAdd(feedback_cycle_matrix + index, mode_contribution)
```
Multiple threads (representing different modes) contribute to the same matrix element. The matrix is **zeroed after each summation** to avoid accumulation across iterations.

**2. Bridge Force Accumulation**:
```cpp
atomicAdd(&force_on_bridge_summed[stringInArr], force_contribution)
```
Multiple threads along the string stem contribute to the total bridge force.

Performance impact: With `SEGMENT_FOR_SHUFFLE_SUMMATION = 64` and typical block counts ~64, atomic contention remains manageable (<10% overhead based on profiling).

### Warp-Level Reduction: sumArray Function

The `sumArray` device function (MainKernel.cu:46-68) implements **warp shuffle reduction**:

```cpp
__device__ void sumArray(real* arr, int length, int numSegments,
                         real* sharedSum, int tid, thread_group allThreads) {
    int totalLength = length * numSegments;
    int segmentIndex = tid / length;
    int indexInSegment = tid % length;

    // Initialize shared output
    if (tid < numSegments) sharedSum[tid] = 0.0;
    allThreads.sync();

    if (indexInSegment < length && tid < totalLength) {
        real localSum = arr[tid];  // Load from global

        // Warp-level shuffle reduction
        real warpSum = warpReduceSum(localSum);

        // First thread in each warp atomically adds to segment sum
        if ((tid % WARP_SIZE) == 0) {
            atomicAdd(&sharedSum[segmentIndex], warpSum);
        }
    }
    allThreads.sync();
}
```

This pattern achieves:
- **O(log₂(32)) = 5 shuffle operations** per warp instead of O(N) sequential adds
- **Reduced atomic contention**: Only one atomic per warp instead of per thread
- **Cache efficiency**: Shuffle operations stay in L1/register file

### Performance Optimization Strategies

**1. Memory Coalescing**:
Thread indexing ensures coalesced global memory access:
```cpp
int pointIndex = threadIdx.y + threadIdx.x * WARP_SIZE;
```
Adjacent threads in x-dimension (same warp) access consecutive memory addresses in `s_a[]`, enabling 128-byte cache-line transactions.

**2. Occupancy Tuning**:
Block size (512 threads) chosen to maximize occupancy while staying under shared memory limits:
- Each SM on Ampere/Ada has 48KB shared memory
- Block shared memory usage: ~3KB
- Theoretical occupancy: 48KB / 3KB = 16 blocks per SM
- Actual occupancy limited by registers (~8-12 blocks typical)

**3. Instruction-Level Parallelism**:
Inner loop minimizes dependencies:
```cpp
// These operations can execute concurrently (different functional units)
target *= shift_0;           // FP mul
target += s_b * shift_b;     // FP mul-add
target += (sa__2 + sa_2) * shift_2;  // FP add, FP mul-add
```

**4. Loop Unrolling**:
The compiler automatically unrolls the `soundStep` inner loop (typically 12 iterations), eliminating branch overhead.

**5. Kernel Fusion**:
Parameter computation, Gaussian excitation, and string evolution exist as separate kernels, but the main kernel **fuses** mode-string coupling into a single launch, avoiding intermediate global memory writes.

---

## Section 4: Software Architecture (1900 words)

### Class Diagram and Relationships

```
┌─────────────────────────────────────────────────────────────────┐
│                           Pianoid                                │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ Private State:                                          │    │
│  │  - DoubleBufferedPresetManager preset_manager_         │    │
│  │  - std::vector<GpuDataHandler> handlers                │    │
│  │  - std::vector<void*> kernelArgs                       │    │
│  │  - std::vector<real> gauss_params                      │    │
│  │  - CycleParameters cp_                                 │    │
│  │  - std::unique_ptr<AudioDriverInterface> audioDriver   │    │
│  │  - std::atomic<bool> applicationIsRunning              │    │
│  │  - std::atomic<bool> midiIsPlaying                     │    │
│  │  - std::atomic<bool> audioOn                           │    │
│  │  - real* dev_mode_state, dev_string_state, ...        │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Public Methods:                                                │
│   + Pianoid(gauss_params, volume_coeff, strings_in_pitches,    │
│             CycleParameters)                                    │
│   + devMemoryInit(...)                                         │
│   + initParameters()                                            │
│   + launchMainKernel() -> int (status code)                    │
│   + processMidiPoints(midi_record, midi_index) -> bool        │
│   + runMainApplication(maxDur, audioEnabled) -> int            │
│   + addOneString(stringNo, velocity)                           │
│   + setNewPhysicalParameters(...)                             │
│   + loadPresetToLibrary(preset_name, ...)                     │
│   + switchPreset(preset_name, async)                           │
│   + setUpdatePolicy(policy)                                    │
│   + getPianoidState() -> std::vector<real>                     │
│   + freeCudaMemory()                                           │
└─────────────────────────────────────────────────────────────────┘
              │
              │ owns (member)        owns (via unique_ptr)
              ▼                      ▼
┌──────────────────────────────────────┐
│  <<interface>>                        │
│  AudioDriverInterface                 │
│  ┌──────────────────────────────┐   │
│  │ Pure Virtual Methods:         │   │
│  │  + init()                     │   │
│  │  + start()                    │   │
│  │  + pause()                    │   │
│  │  + resume()                   │   │
│  │  + stop()                     │   │
│  │  + pushSamples(data, size)   │   │
│  │  + setupCuda(device)          │   │
│  │  + isCudaReady() -> bool     │   │
│  └──────────────────────────────┘   │
└──────────────────────────────────────┘
          ▲               ▲
          │               │
    ┌─────┘               └─────┐
    │                           │
┌───────────────┐       ┌──────────────┐
│SDLAudioDriver │       │ASIOAudioDriver│
│               │       │              │
│- CircularBuffer│      │- LockFreeCircular│
│  audioBuffer  │       │  Buffer audioBuffer│
│- SDL_AudioDeviceID│   │- AsioAudioOutput│
│  audioDev     │       │  AsioDriver   │
└───────────────┘       └──────────────┘
     │                        │
     │ contains               │ contains
     ▼                        ▼
┌─────────────────┐   ┌──────────────────────┐
│CircularBuffer   │   │LockFreeCircularBuffer│
│                 │   │                      │
│- std::vector<Sint32>│ │- std::vector<Sint32>│
│  buffer         │   │  buffer              │
│- std::mutex     │   │- std::atomic<size_t> │
│  mutex          │   │  write_index,        │
│- condition_variable│ │  read_index         │
│  canProduce,    │   │- std::atomic<bool>   │
│  canConsume     │   │  stopFlag            │
│                 │   │                      │
│+ cudaSetup(device)│ │+ cudaSetup(device)  │
│+ produce(gpu_data)│ │+ produce(gpu_data)  │
│+ consume(data)  │   │+ consume(data)       │
└─────────────────┘   └──────────────────────┘

Pianoid also aggregates:
        │
        ├─────> DoubleBufferedPresetManager preset_manager_
        │                 │
        │                 ▼
        │       ┌────────────────────────────────────────────┐
        │       │ DoubleBufferedPresetManager                │
        │       │  ┌──────────────────────────────────────┐ │
        │       │  │ - real* dev_working_copy_            │ │
        │       │  │ - real* dev_updating_copy_           │ │
        │       │  │ - std::vector<real> host_active_preset_ │ │
        │       │  │ - std::unordered_map<string, vector<real>>│ │
        │       │  │   preset_library_                    │ │
        │       │  │ - cudaStream_t update_stream_        │ │
        │       │  │ - std::atomic<UpdateState> state_    │ │
        │       │  │ - std::thread poll_thread_           │ │
        │       │  │                                      │ │
        │       │  │ + initialize()                       │ │
        │       │  │ + shutdown()                         │ │
        │       │  │ + loadPresetToLibrary(name, data)   │ │
        │       │  │ + switchPreset(name, async)         │ │
        │       │  │ + updateParameters(category, data)  │ │
        │       │  │ + getWorkingCopyPointer()           │ │
        │       │  │ + getStringPhysicsPointer()         │ │
        │       │  │ + getHammerPointer()                │ │
        │       │  │ + getExcitationPointer()            │ │
        │       │  └──────────────────────────────────────┘ │
        │       └────────────────────────────────────────────┘
        │
        ├─────> std::vector<GpuDataHandler> handlers
        │                 │
        │                 ▼
        │       ┌────────────────────────────┐
        │       │   GpuDataHandler           │
        │       │  ┌──────────────────────┐ │
        │       │  │ - void* devData      │ │
        │       │  │ - void** devDataPointer│ │
        │       │  │ - size_t numElements │ │
        │       │  │ - size_t elementSize │ │
        │       │  │ - std::string paramName│ │
        │       │  │                      │ │
        │       │  │ + alloc_and_init()  │ │
        │       │  │ + to_host()         │ │
        │       │  │ + to_device()       │ │
        │       │  │ + get_device_ptr()  │ │
        │       │  └──────────────────────┘ │
        │       └────────────────────────────┘
        │
        └─────> CycleParameters cp_
                      │
                      ▼
              ┌──────────────────────────┐
              │  CycleParameters (struct)│
              │  ┌────────────────────┐ │
              │  │ + int array_size   │ │
              │  │ + int num_strings  │ │
              │  │ + int num_modes    │ │
              │  │ + int num_channels │ │
              │  │ + int sample_rate  │ │
              │  │ + ...              │ │
              │  │                    │ │
              │  │ + num_string_arrays()│
              │  │ + total_points()   │ │
              │  └────────────────────┘ │
              └──────────────────────────┘

Factory for driver creation:
┌──────────────────────────────────────┐
│  AudioDriverFactory (static class)   │
│  ┌──────────────────────────────┐   │
│  │ + createDefaultDriver(...)   │   │
│  │   -> unique_ptr<AudioDriverInterface>│
│  │                              │   │
│  │ + createDriver(AudioConfig)  │   │
│  │   -> unique_ptr<AudioDriverInterface>│
│  └──────────────────────────────┘   │
└──────────────────────────────────────┘
```

### Design Patterns Identified

**1. Handler Pattern (GpuDataHandler)**

The `GpuDataHandler` class implements the **Resource Acquisition Is Initialization (RAII)** pattern with additional GPU-specific concerns:

```cpp
class GpuDataHandler {
private:
    void* devData;           // Device memory pointer
    void** devDataPointer;   // Pointer-to-pointer for indirection
    const void* hostData;    // Source data
    size_t numElements;
    size_t elementSize;
    std::string paramName;   // For debugging/lookup
    bool is_input;           // Initialize from host?

public:
    bool alloc_and_init() {
        cudaMalloc(&devData, numElements * elementSize);
        if (is_input) {
            cudaMemcpy(devData, hostData, numElements * elementSize,
                       cudaMemcpyHostToDevice);
        }
        *devDataPointer = devData;  // Set external pointer
        return true;
    }

    ~GpuDataHandler() {
        if (devData) cudaFree(devData);
    }
};
```

**Benefits**:
- Centralized error handling for allocation failures
- Automatic cleanup via destructor (prevents leaks)
- Named parameters for debugging (better than raw pointers)
- Indirection layer allows external code to hold device pointers

**Limitations**:
- Current implementation violates Single Responsibility Principle (manages both allocation AND data transfer)
- Tight coupling to host data source in constructor
- No move semantics (potential double-free if handlers copied)

**2. Factory Pattern (AudioDriverFactory)**

The factory encapsulates driver instantiation logic:

```cpp
std::unique_ptr<AudioDriverInterface>
AudioDriverFactory::createDefaultDriver(int sr, int bs, int nc, int mi, void* ctx) {
#ifdef PLAY_WITH_SDL
    return std::make_unique<SDLAudioDriver>(sr, bs, nc, mi, ctx);
#elif defined(PLAY_WITH_ASIO_CALLBACK)
    return std::make_unique<ASIOAudioDriver>(sr, bs, nc, mi, true, ctx);
#elif defined(PLAY_WITH_ASIO)
    return std::make_unique<ASIOAudioDriver>(sr, bs, nc, mi, false, ctx);
#else
    #error "No audio driver defined"
#endif
}
```

**Benefits**:
- Single point of change for driver selection
- Compile-time vs runtime selection flexibility
- Client code (Pianoid) remains agnostic to concrete driver type

**3. Singleton Pattern (Pianoid instance)**

The Pianoid class maintains a static instance pointer:

```cpp
class Pianoid {
    static Pianoid* instance;
public:
    Pianoid(...) {
        instance = this;  // Set on construction
    }
};
```

**Usage**: Enables static callbacks (e.g., SDL audio callback) to access member functions:

```cpp
static void audioCallback(void* userdata, Uint8* stream, int len) {
    if (Pianoid::instance) {
        // Access instance members
    }
}
```

**Criticism**: This is a **fragile** pattern - multiple Pianoid instances would overwrite the singleton pointer, leading to undefined behavior. Better alternatives:
- Pass instance pointer via `userdata` parameter
- Use `std::function` with capture for callbacks (C++11)

**4. Double-Buffering Pattern (DoubleBufferedPresetManager)**

The `DoubleBufferedPresetManager` implements a sophisticated double-buffering strategy for glitch-free parameter updates:

```cpp
class DoubleBufferedPresetManager {
private:
    real* dev_working_copy_;    // Read by kernels (stable during playback)
    real* dev_updating_copy_;   // Written during async updates

    std::atomic<UpdateState> update_state_;  // IDLE, UPDATING, SWAPPING, SYNCING
    cudaStream_t update_stream_;
    cudaEvent_t update_complete_event_;
    std::thread poll_thread_;  // Background state machine

public:
    // Async update pipeline:
    bool updateParameters(const string& category, const vector<real>& data) {
        // 1. Copy data to host buffer
        // 2. Start async GPU copy to updating_copy_ (on update_stream_)
        // 3. Record event
        // 4. Return immediately (non-blocking)
        // Background thread:
        //   - Polls event completion
        //   - Atomically swaps working ↔ updating pointers
        //   - Syncs new updating copy from new working copy
    }
};
```

**Benefits**:
- Zero audio glitches during parameter changes (kernels always read stable buffer)
- Low latency updates (< 5ms from update call to effect)
- Lock-free reads (kernels never block on mutex)
- Preset library management (pre-load multiple parameter sets)

**Trade-offs**:
- 2× memory usage for tunable parameters (~6.3 MB vs 3.15 MB)
- Complexity of state machine management
- Background thread overhead

**Key Innovation**: Background polling thread advances state machine autonomously:
```
IDLE → [updateParameters called] → UPDATING → [GPU copy complete] →
SWAPPING → [pointers swapped] → SYNCING → [sync complete] → IDLE
```

**5. Strategy Pattern (Audio Drivers)**

The `AudioDriverInterface` defines a family of algorithms (SDL blocking, ASIO callback, ASIO push) with interchangeable implementations:

```cpp
class AudioDriverInterface {
public:
    virtual void pushSamples(Sint32* data, size_t size) = 0;
};

class SDLAudioDriver : public AudioDriverInterface {
    void pushSamples(Sint32* data, size_t size) override {
        audioBuffer.produce(data);  // Blocking circular buffer
    }
};

class ASIOAudioDriver : public AudioDriverInterface {
    void pushSamples(Sint32* data, size_t size) override {
        if (callbackMode) {
            audioBuffer.produce(data);  // Lock-free buffer
        } else {
            // Direct ASIO buffer write
        }
    }
};
```

### Memory Management Lifecycle

**Phase 1: Construction**
```
Pianoid::Pianoid(...)
    ├─> Initialize cycle parameters
    ├─> Create audio driver (factory)
    ├─> cudaSetDevice(0)
    ├─> audioDriver->setupCuda(0)
    └─> Store instance pointer (singleton)
```

**Phase 2: Memory Initialization** (Updated October 2025)
```
Pianoid::devMemoryInit(...)
    ├─> preset_manager_.shutdown()  // ⚠️ CRITICAL: Shutdown before reset
    ├─> cudaDeviceReset()  // Destroys ALL GPU memory (including preset manager)
    ├─> preset_manager_.initialize()  // ⚠️ CRITICAL: Reinitialize after reset
    │    ├─> cudaMalloc(&dev_working_copy_, 816,640 * sizeof(real))
    │    ├─> cudaMalloc(&dev_updating_copy_, 816,640 * sizeof(real))
    │    ├─> cudaStreamCreate(&update_stream_)
    │    ├─> cudaEventCreate(&update_complete_event_)
    │    └─> Start background polling thread
    │
    ├─> loadPresetToLibrary("default", ...)  // Pack parameters with padding
    ├─> preset_manager_.switchPreset("default", false)  // SYNCHRONOUS
    │    ├─> Copy preset data to working_copy_
    │    └─> Update all dev_* pointers (dev_physical_parameters, dev_hammer, etc.)
    │
    ├─> FOR EACH non-preset parameter (28 handlers):
    │    ├─> handlers.emplace_back(name, hostData, numElements,
    │    │                          allocSize, elementSize, is_input,
    │    │                          &dev_pointer)
    │    └─> handler.alloc_and_init()
    │         ├─> cudaMalloc(&devData, size)
    │         ├─> IF is_input: cudaMemcpy(hostData -> devData)
    │         └─> *dev_pointer = devData  // Link external pointer
    │
    ├─> cudaMallocManaged(&kernel_status, sizeof(int))
    ├─> cudaMallocManaged(&incycle_counter, sizeof(int))
    └─> resetParameter("mode_position"), resetParameter("mode_new_position")
```

**Key Changes from Pre-Refactoring:**
- Preset manager lifecycle properly managed around `cudaDeviceReset()`
- Eliminated dual allocation (preset parameters no longer allocated by handlers)
- Default preset created and activated during initialization
- Legacy pointers (`dev_physical_parameters`, etc.) now point into preset manager's working copy
- Saved ~3.15 MB by removing redundant handler allocations

**Phase 3: Kernel Argument Preparation** (Updated October 2025)
```
Pianoid::initParameters()
    ├─> kernelArgs.push_back(&dev_mode_state)        // Direct pointer (preset-managed)
    ├─> kernelArgs.push_back(&dev_string_state)      // Handler-managed
    │   ... (21 total arguments)
    └─> Launch initial kernels:
         ├─> initializeIntKernel<<<1, numStrings>>>(dev_exct_cycle_index, 0)
         ├─> initializeKernel<<<numStrings, arraySize>>>(dev_force_function, 0)
         ├─> stringMapKernel<<<num_string_arrays, arraySize>>>(...)
         └─> parameterKernel<<<numBlocks, arraySize>>>(...)
```

**Phase 4: Execution Loop**
```
Pianoid::runMainApplication(maxDur, audioEnabled)
    ├─> IF audioEnabled: startAudioDevice()
    │    └─> audioDriver->init(), audioDriver->start()
    │
    └─> WHILE applicationIsRunning:
         ├─> launchMainKernel()
         │    ├─> IF new_notes_ind > 0:
         │    │    └─> parameterKernel<<<...>>>()
         │    ├─> IF new_notes_ind > 1:
         │    │    └─> gaussKernel<<<...>>>()
         │    ├─> cudaMemset(dev_output_data, 0, ...)
         │    ├─> cudaLaunchCooperativeKernel((void*)addKernel, ...)
         │    └─> cudaDeviceSynchronize()
         │
         ├─> playSoundSamples()
         │    ├─> IF FIRfilterON:
         │    │    └─> convolutionKernel<<<...>>>()
         │    └─> audioDriver->pushSamples(outputData, dataSize)
         │
         ├─> appendSoundRecords()
         │    └─> copyKernel<<<...>>>()  // Archive to dev_sound_records
         │
         └─> stopApplication(false)  // Check max duration
```

**Phase 5: Cleanup**
```
Pianoid::~Pianoid()
    └─> freeCudaMemory()
         ├─> FOR EACH handler in handlers:
         │    └─> cudaFree(handler.get_device_ptr())
         ├─> cudaFree(d_counter)
         └─> handlers.clear()
```

### Audio Driver Architecture Deep Dive

**SDL Driver (Blocking, Software Mixing)**:
```
SDLAudioDriver
    │
    ├─> init()
    │    └─> SDL_OpenAudioDevice(desired_spec, obtained_spec)
    │         ├─> Callback: audioCallback (static)
    │         └─> Buffer: CircularBuffer(chunk_size=samplesInCycle*numChannels,
    │                                     num_chunks=8)
    │
    ├─> start()
    │    └─> SDL_PauseAudioDevice(audioDev, 0)
    │
    ├─> pushSamples(gpu_data, size)
    │    └─> audioBuffer.produce(gpu_data)
    │         ├─> cudaMemcpy(buffer[end_chunk], gpu_data, chunk_size,
    │         │              cudaMemcpyDeviceToHost)
    │         ├─> Lock mutex
    │         ├─> chunks_in_buffer++
    │         ├─> end_chunk = (end_chunk + 1) % num_chunks
    │         ├─> Unlock mutex
    │         └─> canConsume.notify_one()
    │
    └─> audioCallback(userdata, stream, len)  [Called by SDL thread]
         └─> audioBuffer.consume(stream)
              ├─> Wait on canConsume until chunks_in_buffer > 0
              ├─> memcpy(stream, buffer[begin_chunk], chunk_size)
              ├─> begin_chunk = (begin_chunk + 1) % num_chunks
              ├─> chunks_in_buffer--
              └─> canProduce.notify_one()
```

**ASIO Driver (Callback Mode, Professional Audio)**:
```
ASIOAudioDriver (callbackMode=true)
    │
    ├─> init()
    │    └─> AsioDriver.init(...)
    │         ├─> ASIOInit()
    │         ├─> ASIOCreateBuffers()
    │         └─> ASIOStart()
    │
    ├─> pushSamples(gpu_data, size)
    │    └─> audioBuffer.produce(gpu_data)  [Lock-free version]
    │         ├─> IF buffer full: return false (drop sample)
    │         ├─> cudaMemcpy(buffer[write_index], gpu_data, chunk_size,
    │         │              cudaMemcpyDeviceToHost)
    │         ├─> write_index.fetch_add(1, memory_order_release)
    │         └─> return true
    │
    └─> AsioDriver.bufferSwitch(bufferIndex)  [Called by ASIO driver]
         └─> audioBuffer.consume(asio_buffer_pointers)
              ├─> IF buffer empty: output silence
              ├─> read_pos = read_index.load(memory_order_acquire)
              ├─> memcpy(asio_buffer, buffer[read_pos], chunk_size)
              ├─> read_index.fetch_add(1, memory_order_release)
              └─> return true
```

**Key Difference**:
- **SDL**: Mutex-protected circular buffer with condition variables (blocking)
- **ASIO Callback**: Lock-free atomic index management (real-time safe)

The lock-free buffer avoids **priority inversion** where the high-priority ASIO callback thread waits on a low-priority producer thread holding a mutex.

### Error Handling and Debugging Architecture

**CUDA_LAUNCH Macro** (Pianoid.cu:48-136):

This macro wraps every kernel launch with comprehensive validation:

```cpp
#define CUDA_LAUNCH(kernel, grid, block, ...) \
    do { \
        // 1. Check pending errors
        cudaError_t pending_err = cudaGetLastError();

        // 2. Check available memory
        cudaMemGetInfo(&free_mem, &total_mem);
        if (free_mem < 50 * 1024 * 1024) {
            printf("ERROR: Insufficient GPU memory: %zu MB\n", free_mem/MB);
            exit(EXIT_FAILURE);
        }

        // 3. Synchronize before launch
        cudaDeviceSynchronize();

        // 4. Validate launch parameters
        if (grid.x == 0 || block.x == 0) {
            printf("ERROR: Invalid launch parameters\n");
            exit(EXIT_FAILURE);
        }

        // 5. Check device limits
        cudaGetDeviceProperties(&prop, 0);
        if (block.x * block.y * block.z > prop.maxThreadsPerBlock) {
            printf("ERROR: Too many threads\n");
            exit(EXIT_FAILURE);
        }

        // 6. Launch kernel
        kernel<<<grid, block>>>(__VA_ARGS__);

        // 7. Check launch errors
        cudaError_t launch_err = cudaGetLastError();

        // 8. Synchronize after launch
        cudaDeviceSynchronize();

        // 9. Final memory check
        cudaMemGetInfo(&free_mem, &total_mem);
        if (free_mem < 25 * 1024 * 1024) {
            printf("WARNING: Low GPU memory: %zu MB\n", free_mem/MB);
        }
    } while(0)
```

**Kernel Status Reporting**:

The `kernel_status` managed memory variable enables **bi-directional communication**:

- **Host → Device**: Setting `*kernel_status = 500` triggers string state reset
- **Device → Host**: Kernel writes error codes (negative values indicate NaN detection)

```cpp
// In addKernel (MainKernel.cu:458-462)
#ifdef DEBUG
    if (isnan(target)) {
        pointStatus = -1;  // Signal NaN error
        goto nanInData;
    }
#endif

nanInData:
    atomicAdd(status, pointStatus);  // Accumulate errors

// Host checks after synchronization
if (*kernel_status != 200) {
    printf("Kernel failed with status %d at position %d\n",
           *kernel_status, *incycle_counter);
}
```

### Profiling Infrastructure

**Dual-Domain Profiling**:

The system profiles both CPU and GPU operations independently:

```cpp
#if PIANOID_ENABLE_PROFILING
    // GPU timing via CUDA events
    cudaEvent_t e0, e1, e2, e3, e4, e5;
    cudaEventRecord(e0);
    parameterKernel<<<...>>>();
    cudaEventRecord(e1);
    gaussKernel<<<...>>>();
    cudaEventRecord(e2);
    addKernel<<<...>>>();
    cudaEventRecord(e3);

    // Calculate elapsed times
    g_lastGpuTimings.parameter_ms = elapsed_ms(e0, e1);
    g_lastGpuTimings.gauss_ms = elapsed_ms(e1, e2);
    g_lastGpuTimings.add_ms = elapsed_ms(e2, e3);

    // CPU timing via CycleCpuProfiler
    cpu_prof.begin_cycle(cycle_index);
    launchMainKernel();
    cpu_prof.mark("after_launchMainKernel_us");
    playSoundSamples();
    cpu_prof.mark("after_playSoundSamples_us");

    // Write to CSVs
    g_csv_gpu << cycle_index << "," << parameter_ms << ","
              << gauss_ms << "," << add_ms << "\n";
    cpu_prof.flush_csv(g_csv_cpu);
#endif
```

**Output Files**:
- `cpu_cycle_timing.csv`: Host-side operation timestamps (microseconds)
- `gpu_cycle_timing.csv`: Kernel execution durations (milliseconds)

This dual approach isolates GPU computation time from CPU overhead (memory copies, parameter updates, etc.).

---

### Thread Safety and Concurrency

**Critical Architecture Requirement**: Pianoid operates in a **multi-threaded environment** where CUDA operations can be called from multiple Python threads simultaneously.

#### Threading Model

**Two Primary Threads:**

1. **Audio Playback Thread** (SDL2/SDL3 callback)
   - Continuously calls `cudaCycle()` to generate audio
   - Runs at audio sample rate (44.1kHz typical)
   - MUST NOT be blocked or interrupted

2. **Parameter Update Thread** (REST API, MIDI, GUI)
   - Calls CUDA operations to update parameters
   - Sporadic, user-initiated
   - Must synchronize with playback thread

**Problem:** CUDA runtime is not inherently thread-safe when multiple threads access the same context.

#### Thread Safety Implementation

**Middleware Layer Protection** (pianoid.py):

All Python methods that call CUDA operations during playback use `cuda_lock`:

```python
class Pianoid:
    def __init__(self):
        self.cuda_lock = threading.Lock()  # Protects all CUDA operations
        # ...

    def set_volume_level(self, level):
        """Thread-safe volume parameter update"""
        import pianoidCuda
        runtime_params = pianoidCuda.RuntimeParameters(level)

        # CRITICAL: Acquire lock before CUDA operation
        with self.cuda_lock:
            success = self.pianoid.setRuntimeParameters(runtime_params)
            # setRuntimeParameters() calls cudaMemcpy internally

        return success

    def cudaCycle(self):
        """Audio generation (called from SDL callback thread)"""
        with self.cuda_lock:
            # Call C++ Pianoid::cudaCycle()
            # Executes multiple kernels, updates GPU memory
            self.pianoid.cudaCycle()
```

**Why Lock is Required:**

Without synchronization:
1. Parameter update thread calls `cudaMemcpy` during volume change
2. Audio thread simultaneously launches kernel via `cudaCycle()`
3. CUDA driver state becomes inconsistent
4. **Result**: Playback stops, state corrupts, audio processing fails

**C++ Layer** (Pianoid.cu):

The C++ layer does NOT implement locking—it trusts the middleware to serialize access:

```cpp
// Pianoid.cu - No internal locking
bool Pianoid::setRuntimeParameters(const RuntimeParameters& params) {
    // Assumes caller has acquired lock
    real coefficient = calculateVolumeCoefficient();

    // Direct CUDA memory operation (NOT thread-safe)
    cudaMemcpy(getRealPointer("dev_main_volume_coeff"),
               &coefficient,
               sizeof(real),
               cudaMemcpyHostToDevice);

    return true;
}
```

**Design Rationale:**
- **Performance**: No lock overhead in C++ layer
- **Flexibility**: Middleware can batch operations under single lock
- **Clarity**: Thread safety policy visible in Python layer

#### Current Status and Known Issues

**Thread-Safe Operations:**
- ✅ Volume parameter updates (`set_volume_level`, `set_max_volume`)
- ✅ Audio generation (`cudaCycle`)
- ✅ Preset loading (initialization context)

**Operations Requiring Review:**
- ⚠️ Granular parameter updates (`update_physical_parameters_for_pitch`)
- ⚠️ Filter parameter updates
- ⚠️ Excitation parameter updates
- ⚠️ Mode parameter updates

**Recommended Practice** for Future Parameter Methods:

```python
def update_some_parameter(self, value):
    """Template for thread-safe parameter updates"""

    # 1. Validate input (outside lock - no CUDA calls)
    if not self._validate(value):
        return False

    # 2. Prepare data structures (outside lock)
    params = self._prepare_params(value)

    # 3. CUDA operations inside lock
    with self.cuda_lock:
        # Any operation that calls:
        # - cudaMemcpy
        # - cudaMemcpyAsync
        # - Kernel launches
        # - Any C++ method that touches GPU
        success = self.pianoid.updateParameter(params)

    return success
```

#### Testing for Thread Safety Issues

**Symptoms of Missing Lock:**
- Playback stops unexpectedly
- Log message: "WARNING: Ignoring note command - playback not active"
- State transitions to UNINITIALIZED
- No crash, but audio stops

**How to Test:**
1. Start playback (system playing normally)
2. Call parameter update via REST API
3. Verify playback continues without interruption
4. Check logs for state corruption messages

**Debug Strategy:**
Add comprehensive logging around CUDA operations to trace execution:

```python
print(f"BEFORE CUDA OPERATION: State={self.state}")
with self.cuda_lock:
    result = self.pianoid.someOperation()
print(f"AFTER CUDA OPERATION: State={self.state}, Result={result}")
```

#### Future Work

**Potential Improvements:**

1. **Move Lock to C++ Layer**: Implement mutex in Pianoid class
   - Pro: Enforces thread safety at lowest level
   - Con: Performance overhead, complexity

2. **Lock-Free Updates**: Use atomic operations for simple parameters
   - Pro: No blocking, better real-time performance
   - Con: Limited to simple data types

3. **Parameter Queue**: Batch updates, apply during safe points
   - Pro: No blocking of audio thread
   - Con: Latency in parameter updates

**Current Recommendation**: Keep lock in middleware (Python) layer until performance issues arise. This provides clear visibility and easy debugging.

---

## Section 5: Integration & Build System (1100 words)

### CUDA/C++/Python Integration Strategy

The pianoid_cuda module implements a **three-tier compilation strategy** that bridges CUDA device code, C++ host code, and Python bindings:

**Tier 1: CUDA Compilation (.cu files)**

CUDA source files are compiled with `nvcc` (NVIDIA CUDA Compiler):

```bash
nvcc -c Pianoid.cu -o Pianoid.obj \
     --std=c++17 -O3 -use_fast_math \
     -gencode=arch=compute_80,code=sm_80 \
     -gencode=arch=compute_86,code=sm_86 \
     -gencode=arch=compute_89,code=sm_89 \
     -ccbin "C:/Program Files/Microsoft Visual Studio/.../VC/Tools/MSVC/.../bin/Hostx64/x64" \
     -Xcompiler "/MD /EHsc /bigobj" \
     -I <pybind11_include> -I <cuda_include> -I <python_include> -I <sdl2_include>
```

**Key Flags**:
- `--std=c++17`: Enables modern C++ features (auto, constexpr, structured bindings)
- `-O3 -use_fast_math`: Aggressive optimization, relaxed IEEE 754 compliance
- `-gencode`: Generates code for Ampere (sm_80), RTX 30xx (sm_86), RTX 40xx (sm_89)
- `-Xcompiler /MD`: Link against multithreaded DLL runtime (required for Python extensions)
- `-Xcompiler /bigobj`: Allow >65,536 sections in object file (large template expansion)

**Tier 2: C++ Compilation (.cpp files)**

C++ sources are compiled with MSVC (Microsoft Visual C++ Compiler):

```bash
cl.exe /c AudioDriverFactory.cpp /Fo:AudioDriverFactory.obj \
       /std:c++17 /O2 /bigobj /MD /EHsc \
       /I <includes...>
```

**Tier 3: Linking and Python Extension**

All `.obj` files (from both nvcc and MSVC) are linked into a single Python extension module:

```bash
link.exe /DLL /OUT:pianoidCuda.cp311-win_amd64.pyd \
         Pianoid.obj MainKernel.obj Kernels.obj GpuHandler.obj ... \
         /LIBPATH:<cuda_lib> /LIBPATH:<sdl2_lib> \
         cudart.lib SDL2.lib winmm.lib ole32.lib advapi32.lib
```

The resulting `.pyd` file (Python Dynamic Library) contains:
- CUDA device code (embedded PTX/SASS)
- C++ host logic
- pybind11 bindings for Python interop

### Build Configuration and Toolchain

**Centralized Configuration: build_config.json**

The `detect_paths.py` script generates a JSON configuration file:

```json
{
  "windows": {
    "cuda_home": "C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v12.3",
    "visual_studio": {
      "vc_tools_bin_hostx64_x64": "C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Tools/MSVC/14.38.33130/bin/Hostx64/x64"
    },
    "sdl2": {
      "base_path": "C:/Dev/SDL2-2.28.5",
      "include": "C:/Dev/SDL2-2.28.5/include",
      "lib_x64": "C:/Dev/SDL2-2.28.5/lib/x64"
    }
  },
  "cuda_arch_list": ["80", "86", "89"]
}
```

**Benefits**:
- **Environment Independence**: Build works on any machine once paths are configured
- **Version Control Friendly**: `build_config.json` can be `.gitignore`d (per-developer)
- **CI/CD Ready**: Automated builds can inject configuration via environment variables

**Custom setuptools Build Extension**

The `setup.py` implements a custom `build_ext` class that hijacks the standard C++ compilation:

```python
class build_ext(_build_ext):
    def build_extension(self, ext):
        cfg = _load_cfg()  # Load build_config.json

        # Split sources by extension
        cu_sources = [s for s in ext.sources if s.endswith('.cu')]
        cc_sources = [s for s in ext.sources if not s.endswith('.cu')]

        # Compile .cu with nvcc
        for src in cu_sources:
            obj = Path(self.build_temp) / (src.stem + '.obj')
            nvcc_cmd = [nvcc, '-c', src, '-o', obj, ...gencode flags...]
            subprocess.run(nvcc_cmd, check=True)
            self._nv_objs.append(obj)

        # Pass .cu-generated .obj files to MSVC linker
        ext.extra_objects += self._nv_objs

        # Let parent class compile .cpp and link
        super().build_extension(ext)

        # Copy DLLs next to .pyd
        shutil.copy2(sdl_dll, ext_dir / 'SDL2.dll')
        shutil.copy2(cudart_dll, ext_dir / 'cudart64_*.dll')
```

**Why This Approach?**

Standard setuptools doesn't support CUDA compilation. Alternatives:

1. **CMake**: Requires separate build system, more complex Python integration
2. **scikit-build**: Adds dependency on CMake + scikit-build
3. **Custom setup.py**: Direct control, leverages existing setuptools infrastructure

This implementation chooses option 3 for **minimal dependencies** and **maximum transparency**.

### Cross-Platform Considerations

**Current State: Windows-Only**

The codebase has several Windows-specific dependencies:

```cpp
// Pianoid.cu:21-22
#include <windows.h>
#pragma comment(lib, "User32.lib")

// Pianoid.cu:1037-1039
#ifdef BLACK_SCREEN
    SendMessage(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, (LPARAM) 2);
#endif
```

**ASIO Driver**: Windows-only (proprietary Steinberg SDK)

**Portability Path**:

To enable Linux/macOS support:

1. **Conditional Compilation**:
```cpp
#ifdef _WIN32
    #include <windows.h>
#else
    #include <unistd.h>
#endif
```

2. **Audio Driver Abstraction**:
   - Linux: ALSA or PulseAudio driver implementation
   - macOS: CoreAudio driver implementation
   - Both already compatible via `AudioDriverInterface`

3. **Build System Updates**:
```python
# setup.py
if sys.platform == 'win32':
    nvcc_flags += ['-ccbin', vs_bin, '-Xcompiler', '/MD']
else:
    nvcc_flags += ['-Xcompiler', '-fPIC']
```

4. **Dependency Management**:
   - Replace `#pragma comment(lib, ...)` with `setup.py` library specification
   - Use vcpkg or conan for cross-platform dependency management

### DLL Management and Deployment

**Runtime Dependencies**:

The Python extension requires two external DLLs:

1. **SDL2.dll** (~2 MB): SDL audio/input library
2. **cudart64_*.dll** (~500 KB): CUDA runtime (version-specific)

**Deployment Strategy**:

```python
# setup.py:207-236
ext_dir = Path(self.get_ext_fullpath(ext.name)).parent

# Find SDL2.dll
sdl_dll = _find_dll(cfg['sdl2_home'], ['SDL2.dll'])

# Find cudart64_*.dll (wildcard match for version)
cudart_dll = _find_dll(cfg['cuda_home'] / 'bin', ['cudart64_*.dll'])

# Copy to extension directory
shutil.copy2(sdl_dll, ext_dir / 'SDL2.dll')
shutil.copy2(cudart_dll, ext_dir / cudart_dll.name)
```

**Why Copy DLLs?**

Python extensions are loaded from the package directory:
```
site-packages/
    pianoidCuda.cp311-win_amd64.pyd
    SDL2.dll          ← Required in same directory
    cudart64_12.dll   ← Required in same directory
```

Windows DLL search order:
1. Directory of the executable (.pyd is loaded from package dir)
2. System directories (C:\Windows\System32)
3. PATH environment variable

Copying ensures the correct versions are loaded, avoiding conflicts with system-wide installations.

### Source Discovery and Dynamic Configuration

**Auto-Discovery Pattern**:

```python
def _discover_sources():
    cu = sorted(str(p) for p in THIS_DIR.glob("*.cu"))
    cc = sorted(str(p) for p in THIS_DIR.glob("*.cpp"))
    return cu + cc

ext = Extension(
    name="pianoidCuda",
    sources=_discover_sources(),  # No hardcoded list
    ...
)
```

**Benefits**:
- **Maintenance**: Adding new .cu/.cpp files doesn't require editing setup.py
- **Consistency**: Automatically includes all source files
- **Safety**: Sorted order ensures deterministic builds

**Risks**:
- Includes **all** .cu/.cpp files (e.g., test files)
- No granular control over compilation order

**Mitigation**: Exclude patterns via glob negation:
```python
cu = [p for p in THIS_DIR.glob("*.cu") if not p.stem.startswith("test_")]
```

### NVCC Compute Capability Selection

**Current Configuration**:

```python
gencodes = []
for arch in ["80", "86", "89"]:  # From build_config.json
    gencodes += [f"-gencode=arch=compute_{arch},code=sm_{arch}"]
```

This generates **three** sets of device code:
- `sm_80`: Ampere architecture (RTX 3000 series, A100)
- `sm_86`: Ampere mobile (RTX 30xx laptop)
- `sm_89`: Ada Lovelace (RTX 4000 series)

**Binary Size vs Compatibility**:
- Each architecture adds ~2-3 MB to the .pyd file
- Total: ~9 MB for device code (3 architectures)
- Alternative: Use PTX for forward compatibility at cost of JIT overhead

**Just-In-Time (JIT) Compilation**:

```python
gencodes = ["-gencode=arch=compute_80,code=compute_80"]  # PTX only
```

Generates intermediate PTX (parallel thread execution) code that JIT-compiles at runtime for the actual GPU. **Tradeoff**:
- Smaller binary (~3 MB)
- First launch slower (100-500ms compilation)
- Forward compatible with future architectures

### Pybind11 Integration

**Module Definition** (AddArraysWithCUDA.cpp:16-101):

```cpp
PYBIND11_MODULE(pianoidCuda, m) {
    m.doc() = "GPU-accelerated piano synthesizer";

    // Expose CycleParameters struct
    py::class_<CycleParameters>(m, "CycleParameters")
        .def(py::init<>())
        .def_readwrite("array_size", &CycleParameters::array_size)
        .def_readwrite("num_strings", &CycleParameters::num_strings)
        // ... all 12 fields

    // Expose Pianoid class
    py::class_<Pianoid>(m, "Pianoid")
        .def(py::init<std::vector<real>&,
                      const std::vector<real>&,
                      std::vector<int>&,
                      const CycleParameters&>())
        .def("devMemoryInit", &Pianoid::devMemoryInit)
        .def("runMainApplication", &Pianoid::runMainApplication,
             py::call_guard<py::gil_scoped_release>())  // Release GIL
        // ... 30+ methods

    // Standalone functions
    m.def("gaussTest", &gaussTest);
    m.def("runConvolutionKernel", &runConvolutionKernel);
}
```

**Global Interpreter Lock (GIL) Management**:

Long-running operations release the GIL:
```cpp
py::call_guard<py::gil_scoped_release>()
```

This allows other Python threads to run while CUDA kernels execute, critical for:
- GUI responsiveness in desktop applications
- Concurrent parameter updates
- MIDI input processing in separate thread

**Type Conversion**:

pybind11 automatically converts:
- `std::vector<T>` ↔ Python `list`
- Primitive types (int, float, double)
- Struct fields become Python attributes

Example Python usage:
```python
import pianoidCuda

cp = pianoidCuda.CycleParameters()
cp.array_size = 512
cp.num_strings = 256
cp.sample_rate = 48000

synth = pianoidCuda.Pianoid(gauss_params, volume_coeff,
                             strings_in_pitches, cp)
synth.devMemoryInit(...)
synth.initParameters()
synth.runMainApplication(maxDuration=10000, audioEnabled=True)
```

---

## Section 6: API & Usage Patterns (1400 words)

### Public Interface Documentation

The Pianoid class exposes a comprehensive API through pybind11 bindings. The interface divides into **eight functional categories**:

#### 1. Initialization and Configuration

```python
# Constructor
synth = pianoidCuda.Pianoid(
    gauss_params: List[float],        # NUM_STRINGS × NO_EXCITATION_LEVELS × LEN_LEVEL_GP
    volume_coeff: List[float],        # NUM_STRINGS volume scaling factors
    strings_in_pitches: List[int],    # 128 × 3 MIDI-to-string mapping
    cycle_params: CycleParameters     # Simulation configuration
)

# Memory initialization (must be called before use)
synth.devMemoryInit(
    a: List[float],                   # String coefficient A (reserved, unused)
    b: List[float],                   # String coefficient B (reserved, unused)
    mode_state: List[float],          # Initial modal amplitudes (6 × NUM_MODES)
    force: List[float],               # Hammer force shape (array_size × num_strings / num_strings_in_array)
    mode_coefficients: List[float],   # Feedin/feedback matrices (2 × NUM_STRINGS × NUM_MODES)
    volume_coeff: List[float],        # Per-string volume (NUM_STRINGS)
    physical_parameters: List[float], # String physics (PHYSICAL_PARAMETERS_NUMBER × NUM_STRINGS)
    excitation_cycle_index: List[int],# Rotation index per string (NUM_STRINGS)
    fir_filters: List[float],         # Optional FIR filter taps
    stringMap: List[int],             # String grouping (NUM_STRINGS × 2)
    init_dec_open: List[int],         # Initial damper state (NUM_STRINGS)
    main_volume_coeff: float,         # Global volume multiplier
    sustain_value: int                # Initial sustain pedal (0-127)
)

# Kernel argument preparation
synth.initParameters()
```

**Typical Initialization Sequence**:

```python
import pianoidCuda
import numpy as np

# 1. Define cycle parameters
cp = pianoidCuda.CycleParameters()
cp.array_size = 512
cp.num_strings = 256
cp.num_modes = 256
cp.num_channels = 2
cp.mode_iteration = 64        # Samples per cycle
cp.sample_rate = 48000
cp.sound_step = 12            # Sub-iterations per sample
cp.num_strings_in_array = 4
cp.fir_filter_length = 128 * 48 * 3
cp.buffer_size = 64
cp.listen_to_modes = False
cp.mode_channel_index = 0

# 2. Prepare excitation parameters (example: linear scaling)
gauss_params = []
for string in range(256):
    for velocity in range(128):
        # 5 Gaussians × 4 parameters (mu, sigma, volume, shift)
        mu = [0.1, 0.3, 0.5, 0.7, 0.9]
        sigma = [0.05] * 5
        volume = [velocity / 127.0] * 5
        shift = [0.0] * 5
        gauss_params.extend(mu + sigma + volume + shift)

# 3. Prepare physical parameters
phys_params = []
for string in range(256):
    length = 0.1 + (string / 256) * 0.9  # 0.1m to 1.0m
    tail_points = 10
    radius = 0.0005  # 0.5mm
    density = 7850   # Steel
    youngs = 200e9
    tension = 1000
    damping = 0.001
    dx = length / 512
    # ... (16 parameters total per string)
    phys_params.extend([length, tail_points, radius, density, ...])

# 4. Initialize mode state (all modes at rest)
mode_state = [0.0] * (6 * 256)

# 5. Create and initialize synthesizer
synth = pianoidCuda.Pianoid(gauss_params, volume_coeff,
                             strings_in_pitches, cp)
synth.devMemoryInit(a, b, mode_state, force, mode_coefficients,
                     volume_coeff, phys_params, exct_cycle_index,
                     fir_filters, stringMap, init_dec_open,
                     main_volume_coeff=1.0, sustain_value=0)
synth.initParameters()
```

#### 2. Parameter Updates

```python
# Update all parameters (recomputes derived coefficients)
synth.setUpdatedParameters(
    physical_parameters: List[float],
    force: List[float],
    new_gauss_params: List[float],
    volume_coeff: List[float]
)

# Selective updates (more efficient)
synth.setNewPhysicalParameters(physical_parameters, volume_coeff)
synth.setNewExcitationParameters(gauss_params)
synth.setNewHammerParameters(force)
synth.setNewModeParameters(mode_state)
synth.setNewDeckParameters(mode_coefficients)
synth.setNewVolume(volume_coeff: float)  # Global volume

# Cycle parameters (less common, requires re-initialization)
synth.setNewCycleParameters()  # Pushes cp_ to device
```

**Parameter Update Guidelines**:

- **Physical parameters** (string length, tension, damping): Can be updated between cycles without audible glitches
- **Excitation parameters** (Gaussian curves): Updated immediately for new note triggers
- **Cycle parameters** (array size, sample rate): Requires `devMemoryInit()` to resize buffers

#### 3. Real-Time Playback Control

```python
# Start the application (enables MIDI processing)
synth.startApplication()

# Main synthesis loop (blocks until maxDuration or stopApplication)
status = synth.runMainApplication(
    maxDur: int,          # Duration in milliseconds
    audioEnabled: bool    # Enable audio output
) -> int  # Returns 200 on success, error code otherwise

# Audio device control
synth.pauseAudioPlayback()
synth.resumeAudioPlayback()
synth.stopAudioDevice()

# Application control
synth.stopApplication(now: bool)  # If True, immediate stop; else checks maxDuration
is_running = synth.isApplicationRunning() -> bool
```

**Typical Playback Workflow**:

```python
synth.startApplication()

# Option A: Finite duration
synth.runMainApplication(maxDuration=30000, audioEnabled=True)  # 30 seconds

# Option B: Infinite loop with external control
import threading

def midi_processor():
    while synth.isApplicationRunning():
        # Process MIDI input
        midi_data = read_midi_device()
        synth.processMidiPoints(midi_data, midi_index)
        time.sleep(0.001)

midi_thread = threading.Thread(target=midi_processor)
midi_thread.start()

synth.runMainApplication(maxDuration=0, audioEnabled=True)  # Run until stopApplication

# Later, from another thread:
synth.stopApplication(now=True)
midi_thread.join()
```

#### 4. MIDI Input Processing

```python
# Process MIDI event batch
success = synth.processMidiPoints(
    midi_record: List[int],   # [count, pitch, timing, _, command, velocity, ...]
    midi_index: int           # Starting index (modified in-place)
) -> bool

# Trigger single note
synth.addOneString(
    stringNo: int,    # 0-255
    velocity: int     # 0-127 (0 = note off)
)

# Sustain pedal
synth.processSustain(value: int)  # 0-127

# MIDI playback from sequence
synth.playMidiRecord(midi_record: List[int])  # Blocks until complete

# MIDI listener (commented out, requires RtMidi)
# synth.midiListener()  # Infinite loop, processes external MIDI device
```

**MIDI Record Format**:

```python
midi_record = [
    1,             # Number of notes in this timepoint
    60,            # MIDI pitch (C4)
    0,             # Timing offset (microseconds)
    0,             # Reserved
    144,           # MIDI command (128-143: note off, 144-159: note on)
    64,            # Velocity (0-127)

    # Next timepoint
    1,
    64,            # E4
    1000,          # 1ms after previous
    0,
    144,
    80,
    # ... continues
]
```

**String-to-Pitch Mapping**:

The `strings_in_pitches` array (128 pitches × 3 strings) maps MIDI notes to physical strings:

```python
strings_in_pitches = []
for pitch in range(128):
    if pitch < 21:  # Below A0
        strings_in_pitches.extend([0, 0, 0])  # No strings
    elif pitch < 108:  # Piano range
        # Multiple strings per note (unison)
        base_string = (pitch - 21) * 3
        strings_in_pitches.extend([base_string, base_string + 1, base_string + 2])
    else:
        strings_in_pitches.extend([0, 0, 0])  # Above C8
```

#### 5. State Retrieval

```python
# Get current string displacements
state = synth.getPianoidState() -> List[float]
# Returns: [u(t,x), u(t-1,x)] for all points (2 × total_points)

# Get derived parameters (after parameterKernel)
params = synth.getParameters() -> List[float]
# Returns: 32 coefficients per point (POINT_PARAMETERS_NO × total_points)

# Get debug output data (if EXTRACT_DEBUG_DATA defined)
output = synth.getOutputData() -> List[float]
# Returns: 10 × array_size × num_strings values

# Get sound recordings
raw_sound = synth.getRawSoundRecord() -> List[float]
# Returns: Accumulated float audio samples

records = synth.getSoundRecords(length: int) -> List[float]
# Returns: length × samplesInCycle × num_strings × NUM_PARAMS_IN_SOUND_RECORD

# Clear recording buffer
synth.clearRecords()
```

#### 6. FIR Filtering

```python
# Load filter taps
synth.set_filter(
    filterSize: int,       # Samples per filter
    numberOfFilters: int,  # Total filters (channels × 2 for stereo)
    filter: List[float]    # Tap values (filterSize × numberOfFilters)
)

# Enable/disable filtering
synth.switch_filter(
    sampleRate: int,
    filterSize: int,
    on: bool
)
```

**Filter Usage Example**:

```python
from scipy.signal import firwin

# Design low-pass filter at 8 kHz
taps = firwin(numtaps=128 * 48, cutoff=8000, fs=48000)

# Replicate for stereo (2 channels)
filter_data = list(taps) * 2

synth.set_filter(filterSize=len(taps), numberOfFilters=2, filter=filter_data)
synth.switch_filter(sampleRate=48000, filterSize=len(taps), on=True)
```

#### 7. Testing and Debugging

```python
# Test summation kernel (unit test for warp reduction)
result = synth.testSummationKernel(
    array_for_summation: List[float],
    totalLength: int,
    numSegments: int
) -> List[float]  # Segment sums

# Test note triggering (returns excitation + output)
result = synth.test_add_string_for_playback(
    stringNo: int,
    velocity: int,
    timing: int
) -> List[float]

# Time profiling
synth.initTimeRecord()
# ... perform operations ...
synth.stopTimeRecord()
records = synth.getTimeRecord() -> List[List[int]]  # Microsecond timestamps
```

#### 8. Memory Management

```python
# Explicit cleanup (called automatically by destructor)
synth.freeCudaMemory()

# Reset string state to zero
synth.resetStringsState()
```

### Performance Characteristics

**Computational Complexity**:

Per simulation cycle (64 samples at 48 kHz = 1.33ms):

- **Parameter Kernel**: O(num_string_arrays × array_size) = O(64 × 512) = 32,768 operations
  - Typical duration: 0.1-0.2 ms

- **Gauss Kernel** (per new note): O(num_strings × excitation_length / 128)
  - For 1 note: 0.05-0.1 ms
  - For 10 simultaneous notes: 0.5-1.0 ms

- **Add Kernel** (main physics): O(num_string_arrays × array_size × samplesInCycle × soundStep)
  - = O(64 × 512 × 64 × 12) = 25.2M operations
  - Typical duration: 0.8-1.2 ms

- **Total GPU time**: 1.0-1.5 ms (within 1.33ms real-time budget)

**Memory Bandwidth**:

Main kernel global memory traffic per cycle:

- String state read/write: 2 × 64 × 512 × 4 bytes × 2 = 512 KB
- Mode state read/write: 2 × 256 × 4 bytes × 2 = 4 KB
- Coupling matrices: 2 × 64 × 256 × 4 bytes = 128 KB
- Parameters (read-only): 32 × 64 × 512 × 4 bytes = 4 MB

Total: ~4.6 MB/cycle → 3.5 GB/s sustained (well within PCIe 3.0 x16 bandwidth of 16 GB/s)

**Scalability**:

| Configuration | Strings | Modes | Array Size | GPU Time (ms) | Real-time |
|---------------|---------|-------|------------|---------------|-----------|
| Minimal       | 64      | 64    | 256        | 0.3           | ✓         |
| Standard      | 256     | 256   | 512        | 1.2           | ✓         |
| Extended      | 512     | 512   | 512        | 4.5           | ✗ (3.3×)  |

The system **scales quadratically** with string/mode count due to mode coupling matrix (O(N²) storage and computation).

### Parameter Tuning Guidelines

**String Length and Tension**:

Physical relationship:
```
f₀ = (1/2L) × √(T / (ρ × π × r²))
```

For realistic piano frequencies (A0 = 27.5 Hz to C8 = 4186 Hz):

```python
def compute_tension(frequency, length, radius=0.0005, density=7850):
    return (2 * length * frequency) ** 2 * density * np.pi * radius ** 2

# Bass string (A0, L=1.2m)
tension_bass = compute_tension(27.5, 1.2, 0.001, 7850)  # ~1200 N

# Treble string (C8, L=0.05m)
tension_treble = compute_tension(4186, 0.05, 0.0003, 7850)  # ~120 N
```

**Damping Coefficients**:

Frequency-independent damping (controls sustain duration):
```python
coeff_gamma = -np.log(0.01) / (decay_time_seconds)
# For 5-second decay: gamma ≈ 0.92
```

Frequency-dependent damping (controls brightness):
```python
frequency_dependent_damping = 1e-6  # Low value (bright)
frequency_dependent_damping = 1e-5  # Medium (balanced)
frequency_dependent_damping = 1e-4  # High (muted)
```

**Gaussian Excitation Tuning**:

For realistic piano attack:

```python
# Soft touch (velocity 32)
mu = [0.2, 0.5, 0.8, 1.2, 1.5]       # Early peaks
sigma = [0.1, 0.2, 0.3, 0.4, 0.5]    # Broad curves
volume = [0.3, 0.2, 0.15, 0.1, 0.05] # Decreasing amplitude
shift = [0.0] * 5

# Hard strike (velocity 127)
mu = [0.05, 0.1, 0.2, 0.4, 0.8]      # Immediate attack
sigma = [0.02, 0.05, 0.1, 0.2, 0.3]  # Sharp curves
volume = [1.0, 0.8, 0.6, 0.4, 0.2]   # High energy
shift = [0.0] * 5
```

---

## Section 7: Testing & Validation (700 words)

### Test Infrastructure

The codebase includes **three categories** of testing infrastructure:

#### 1. Unit Tests (Kernel-Level)

**Summation Kernel Test** (`testSummationKernel`, Pianoid.cu:1833-1863):

Validates the warp shuffle reduction algorithm used for mode-string coupling:

```python
# Python usage
array = [1.0] * 320  # 10 segments of 32 elements
result = synth.testSummationKernel(array, totalLength=320, numSegments=10)
assert all(abs(r - 32.0) < 1e-5 for r in result), "Summation failed"
```

Verifies:
- Warp-level shuffle correctness
- Atomic accumulation across warps
- Segment boundary handling

**Excitation Generation Test** (`test_add_string_for_playback`, Pianoid.cu:1142-1207):

Tests Gaussian kernel in isolation:

```python
result = synth.test_add_string_for_playback(stringNo=42, velocity=64, timing=0)
# Returns: [gauss_params (20 floats), generated_force_function (...)]

# Validate excitation shape
import matplotlib.pyplot as plt
plt.plot(result[20:])  # Skip gauss params
plt.title("Hammer Excitation (String 42, Velocity 64)")
plt.show()
```

Enables visual inspection of:
- Excitation temporal profile
- Velocity scaling
- Gaussian parameter effects

#### 2. Integration Tests

**Gaussian Test Wrapper** (`gaussTest`, gaussTest.cu:105-240):

Standalone function that exercises excitation generation without full engine:

```cpp
std::vector<real> gaussTest(
    const std::vector<real>& force_function,
    const std::vector<int>& string_params,
    const std::vector<real>& gauss_params,
    const std::vector<real>& volume_coeff,
    const int numStrings,
    int numCycles,
    int midiMult,
    int soundStep,
    int numExcitations,
    int numRepetitions
);
```

Usage from Python:
```python
import pianoidCuda

force_function = [0.0] * (256 * 64 * 12 * 8)
string_params = [42, 1.0, 0] * 10  # 10 strings: [stringNo, volume, timing]
gauss_params = [...]  # 20 floats per excitation × 10
volume_coeff = [1.0] * 256

result = pianoidCuda.gaussTest(
    force_function, string_params, gauss_params, volume_coeff,
    numStrings=256, numCycles=8, midiMult=64, soundStep=12,
    numExcitations=10, numRepetitions=100
)

# Result contains generated excitation waveforms
# Performance reported: "Cycle time: XXXX us"
```

**FIR Filter Test** (`runConvolutionKernel`, FIRFilter.cu:296-493):

Tests multi-channel convolution in isolation:

```python
import pianoidCuda
from scipy.signal import firwin

# Generate test signal (2 input channels)
input_signal = np.sin(2 * np.pi * 440 * np.arange(48000) / 48000)  # 1s at 440 Hz
input_signal = np.tile(input_signal, (2, 1)).flatten()  # Duplicate for stereo

# Design filters (2 input × 2 output = 4 filters)
taps = firwin(128 * 48, cutoff=1000, fs=48000)  # Low-pass at 1 kHz
filters = list(taps) * 4

cycle_params = [48, len(taps), 0, 2, 2, 48]  # sampleRate, filterSize, debugMap, nInputs, nOutputs, samplesPerCycle

result = pianoidCuda.runConvolutionKernel(
    input=input_signal.tolist(),
    filters=filters,
    cycle_parameters=cycle_params,
    inputSize=len(input_signal),
    maxBlocks=24,
    output_volume=1.0,
    new_procedure=True
)

# Result contains filtered output
# Console output shows timing: "Average cycle duration: XXX us"
```

#### 3. System-Level Tests

**Sinewave Test Mode** (`#ifdef SINEWAVE_TEST`, Pianoid.cu:1783-1803):

Bypasses physics simulation to inject pure sinewaves for audio path validation:

```cpp
#ifdef SINEWAVE_TEST
void Pianoid::enableSineWaveTest(real frequency=440.0, real amplitude=0.5,
                                  int sampleRate=44100) {
    testModeEnabled = true;
    testFrequency = frequency;
    testAmplitude = amplitude;
    testSampleRate = sampleRate;
}
#endif
```

When enabled, the audio callback outputs:
```cpp
real phase = (2.0 * M_PI * testFrequency * testSampleIndex) / testSampleRate;
Sint32 sample = static_cast<Sint32>(testAmplitude * sin(phase));
```

Validates:
- Audio driver functionality
- Sample rate accuracy
- Buffer synchronization
- Latency measurement

### Debugging Capabilities

**Preprocessor-Controlled Debug Data**:

```cpp
#define DEBUG                  // Enable NaN detection, console output
#define EXTRACT_DEBUG_DATA     // Extract intermediate values to output_data
```

When `EXTRACT_DEBUG_DATA` is defined, the main kernel populates `dev_output_data` with:

```cpp
// MainKernel.cu:216-217 (mode coefficients)
recordOutputData(&output_data[numStrings * arraySize*4], rowNo, arraySize,
                 stMdIndex, mode_coefficients[rowNo * numModes + stMdIndex]);

// MainKernel.cu:332-333 (mode-per-block mapping)
recordOutputData(&output_data[numStrings * arraySize*8], blockNo, arraySize,
                 stMdIndex, modeNo);

// MainKernel.cu:395 (feedback matrix at specific cycle)
if (main_cycle_index == 32) {
    recordOutputData(&output_data[numStrings * arraySize * 6], blockNo, arraySize,
                     stMdIndex, feedback_cycle_matrix[...]);
}
```

Python retrieval:
```python
debug_data = synth.getOutputData()
# Reshape for analysis
mode_coeffs = np.array(debug_data[len(debug_data)//10*4 : len(debug_data)//10*5])
mode_coeffs = mode_coeffs.reshape((num_strings, array_size))

import matplotlib.pyplot as plt
plt.imshow(mode_coeffs, aspect='auto', cmap='viridis')
plt.title("Mode Coefficients (Feedin Matrix)")
plt.colorbar()
plt.show()
```

**NaN Detection**:

```cpp
#ifdef DEBUG
    if (isnan(target)) {
        pointStatus = -1;
        goto nanInData;
    }
#endif

nanInData:
    atomicAdd(status, pointStatus);
```

If NaN is detected:
- Kernel immediately breaks outer loop
- `*kernel_status` becomes negative
- `*incycle_counter` records the cycle where NaN occurred
- Host can query exact failure location

### Profiling Methodology

**CSV-Based Performance Logging**:

When `PIANOID_ENABLE_PROFILING` is enabled (Pianoid.cu:24):

```cpp
static std::ofstream g_csv_cpu;  // CPU-side operation timestamps
static std::ofstream g_csv_gpu;  // GPU kernel durations
```

**CPU Profiling** (via `CycleCpuProfiler`, Profiler.h:9-36):

```cpp
CycleCpuProfiler cpu_prof;
cpu_prof.begin_cycle(cycle_index);

launchMainKernel();
cpu_prof.mark("after_launchMainKernel_us");

playSoundSamples();
cpu_prof.mark("after_playSoundSamples_us");

cpu_prof.flush_csv(g_csv_cpu);
```

Output (`cpu_cycle_timing.csv`):
```
cycle,start_us,0,after_launchMainKernel_us,0,after_playSoundSamples_us,0
0,0,after_launchMainKernel_us,1234,after_playSoundSamples_us,1456
1,0,after_launchMainKernel_us,1189,after_playSoundSamples_us,1398
...
```

**GPU Profiling** (CUDA events):

```cpp
cudaEvent_t e0, e1, e2, e3;
cudaEventRecord(e0);
parameterKernel<<<...>>>();
cudaEventRecord(e1);
gaussKernel<<<...>>>();
cudaEventRecord(e2);
addKernel<<<...>>>();
cudaEventRecord(e3);

g_lastGpuTimings.parameter_ms = elapsed_ms(e0, e1);
g_lastGpuTimings.gauss_ms = elapsed_ms(e1, e2);
g_lastGpuTimings.add_ms = elapsed_ms(e2, e3);

g_csv_gpu << cycle_index << "," << parameter_ms << ","
          << gauss_ms << "," << add_ms << "\n";
```

Output (`gpu_cycle_timing.csv`):
```
cycle,parameter_ms,gauss_ms,add_ms
0,0.142,0.087,1.234
1,0.0,0.0,1.189
...
```

Note: `parameter_ms` and `gauss_ms` are zero when no new notes trigger (`new_notes_ind == 0`).

**Analysis Example**:

```python
import pandas as pd
import matplotlib.pyplot as plt

cpu = pd.read_csv('cpu_cycle_timing.csv')
gpu = pd.read_csv('gpu_cycle_timing.csv')

# Extract alternating columns (mark names and timestamps)
marks = cpu.columns[1::2]
times = cpu.iloc[:, 2::2]

# Plot CPU timeline
for i, mark in enumerate(marks):
    plt.plot(times.iloc[:, i], label=mark)
plt.legend()
plt.xlabel('Cycle')
plt.ylabel('Time (us)')
plt.title('CPU-Side Timing')
plt.show()

# Plot GPU kernel durations
gpu.plot(x='cycle', y=['parameter_ms', 'gauss_ms', 'add_ms'],
         title='GPU Kernel Durations')
plt.ylabel('Time (ms)')
plt.show()
```

---

## Section 8: Future Work & Extensibility (550 words)

### Identified Limitations

**1. Memory Management Fragmentation**

Current `GpuDataHandler` design tightly couples allocation, initialization, and data transfer:

```cpp
bool alloc_and_init() {
    cudaMalloc(&devData, numElements * elementSize);
    if (is_input) {
        cudaMemcpy(devData, hostData, numElements * elementSize, ...);
    }
    *devDataPointer = devData;
    return true;
}
```

**Limitation**: Cannot allocate without immediate initialization, preventing lazy loading strategies.

**Solution**: Separate concerns into distinct methods:
```cpp
class GpuDataHandler {
    bool allocate();            // Just cudaMalloc
    bool initialize();          // Transfer hostData -> device
    bool update(const void*);   // Update device data
    bool retrieve(void*);       // Retrieve device -> host
};
```

**2. MIDI Processing Integration**

MIDI handling is **tightly coupled** to the Pianoid class (lines 1068-1440), mixing:
- Protocol parsing (`processMidiPoints`)
- Note-to-string mapping (`_get_strings_in_pitch`)
- Excitation parameter management (`_append_string_gp`)
- Sustain pedal logic (`processSustain`)

**Solution**: Extract into dedicated `MidiProcessor` class:
```cpp
class MidiProcessor {
    const std::vector<int>& string_mapping;
    const std::vector<real>& gauss_params;

public:
    struct NoteEvent {
        int stringNo;
        int velocity;
        int timing;
        std::vector<real> excitation_params;
    };

    std::vector<NoteEvent> processMidiRecord(const std::vector<int>& midi);
    void updateSustain(int value);
};
```

**3. Single-Precision Limitation**

Current configuration uses `float` (`PIANOID_USE_FLOAT`), limiting numerical precision for:
- Long simulations (accumulated rounding errors)
- Very low damping coefficients (underflow risk)
- High modal frequencies (phase accumulation errors)

**Solution**: Template-based precision selection:
```cpp
template<typename Real>
class PianoidT {
    Real* dev_mode_state;
    // ... all operations templated
};

using PianoidFloat = PianoidT<float>;
using PianoidDouble = PianoidT<double>;
```

Python bindings expose both:
```python
m.def_class<PianoidFloat>("PianoidFloat")
m.def_class<PianoidDouble>("PianoidDouble")
```

### Extension Points

**1. Alternative Physical Models**

The **parameterKernel** is the sole location where physical laws are encoded. To implement alternate string models:

```cpp
__global__ void parameterKernelNonlinear(
    real* physical_parameters,
    int* dumper_position,
    real* hammer,
    int* cycle_parameters,
    real* parameters,
    int* sustain_value,
    real* nonlinear_coeffs  // NEW: nonlinear stiffness
) {
    // Existing linear coefficients...

    // Add geometric nonlinearity (large amplitude)
    real coeff_nonlinear = nonlinear_coeffs[stringNo] / (dxMm2 * dxMm2);
    parameters[rec_start_ind + (27 * arraySize) + i] = coeff_nonlinear;
}
```

Update `addKernel` inner loop:
```cpp
// Load nonlinear coefficient
real coeff_nonlinear = parameters[start_ind + (27 * arraySize) + pointIndex];

// Add cubic nonlinearity term
real amplitude = s_a[pointIndex];
target += coeff_nonlinear * amplitude * amplitude * amplitude;
```

This enables modeling of **chaotic overtones** in high-amplitude strikes without touching the core architecture.

**2. Additional Audio Drivers**

The `AudioDriverInterface` is designed for easy extension:

```cpp
// Linux ALSA driver
class ALSAAudioDriver : public AudioDriverInterface {
    snd_pcm_t* pcm_handle;
    CircularBuffer audioBuffer;

public:
    void init() override {
        snd_pcm_open(&pcm_handle, "default", SND_PCM_STREAM_PLAYBACK, 0);
        snd_pcm_hw_params_t* params;
        // ... configure ALSA
    }

    void pushSamples(Sint32* data, size_t size) override {
        audioBuffer.produce(data);
    }

    void start() override {
        std::thread([this]() {
            while (!should_stop) {
                Sint32* buffer = audioBuffer.consume();
                snd_pcm_writei(pcm_handle, buffer, buffer_size);
            }
        }).detach();
    }
};
```

Register in factory:
```cpp
#ifdef __linux__
    return std::make_unique<ALSAAudioDriver>(...);
#endif
```

**3. Multi-GPU Scaling**

Current architecture uses a **single GPU** (device 0). For ultra-large simulations (1000+ strings):

**Strategy**: Partition strings across GPUs

```cpp
class MultiGpuPianoid {
    std::vector<std::unique_ptr<Pianoid>> gpu_instances;
    std::vector<cudaStream_t> streams;

    void launchMainKernel() {
        for (int gpu = 0; gpu < num_gpus; ++gpu) {
            cudaSetDevice(gpu);
            cudaLaunchCooperativeKernel(..., streams[gpu]);
        }

        // Synchronize all GPUs
        for (auto& stream : streams) {
            cudaStreamSynchronize(stream);
        }

        // Gather results (optional: peer-to-peer transfer)
        gatherAudioOutput();
    }
};
```

Challenges:
- Mode coupling requires **cross-GPU communication** (slow)
- Minimize coupling by grouping physically adjacent strings
- Use CUDA Unified Memory or GPUDirect for P2P transfers

### Optimization Opportunities

**1. Shared Memory Bank Conflict Elimination**

Current `s_a[MAX_ARRAY_SIZE]` access pattern:
```cpp
int pointIndex = threadIdx.y + threadIdx.x * WARP_SIZE;
s_a[pointIndex] = ...;  // Potential conflicts
```

**Optimization**: Pad shared array to avoid conflicts:
```cpp
__shared__ real s_a[MAX_ARRAY_SIZE + WARP_SIZE];  // Extra padding

// Access with stride to avoid same bank
int paddedIndex = pointIndex + (pointIndex / WARP_SIZE);
s_a[paddedIndex] = ...;
```

Expected speedup: 5-10% in memory-bound kernels.

**2. Persistent Kernel Strategy**

Instead of launching `addKernel` every cycle, use a **persistent kernel**:

```cpp
__global__ void persistentAddKernel(..., std::atomic<bool>* stop_flag) {
    while (!stop_flag->load(std::memory_order_acquire)) {
        // Wait for work signal
        if (blockIdx.x == 0 && threadIdx.x == 0) {
            while (!work_available->load(...)) { /* spin */ }
        }
        __syncthreads_grid();

        // Execute one cycle of computation
        // ... (existing addKernel logic)

        // Signal completion
        if (blockIdx.x == 0 && threadIdx.x == 0) {
            cycle_complete->store(true, ...);
        }
    }
}
```

Benefits:
- Eliminates kernel launch overhead (~10-50 µs per launch)
- Enables **ultra-low latency** (sub-millisecond)
- Requires CUDA 11.0+ with dynamic parallelism

**3. Warp-Specialized Kernels**

Current `addKernel` has **divergence** (different threads execute different branches):

```cpp
if (onString) { /* 90% of threads */ }
if (onStem) { /* 1% of threads */ }
if (isStem) { /* 1% of threads */ }
```

**Optimization**: Use **warp-specialized execution**:
```cpp
unsigned int mask_string = __ballot_sync(0xffffffff, onString);
unsigned int mask_stem = __ballot_sync(0xffffffff, onStem);

if (mask_string) {
    if (onString) {
        // String computation
    }
}

if (mask_stem) {
    if (onStem) {
        // Stem computation
    }
}
```

This ensures full warps execute together, reducing divergence overhead.

---

## Conclusion

The pianoid_cuda module represents a mature, production-grade GPU-accelerated physical modeling synthesizer. Its architecture demonstrates sophisticated understanding of both physical acoustics and GPU computing, achieving real-time performance through careful optimization of memory access patterns, thread organization, and algorithmic design.

The recent audio driver refactoring showcases ongoing architectural refinement toward cleaner abstractions and better extensibility. The comprehensive profiling infrastructure and multi-layered testing approach indicate a system designed for continuous improvement and validation.

Key strengths include the bidirectional modal coupling implementation (enabling realistic sympathetic resonance), flexible type system (supporting both float/double precision), and well-documented build system (enabling reproducible compilation across environments).

Areas for future development include cross-platform audio driver support, multi-GPU scaling for larger simulations, and extraction of MIDI processing into a separate module. The existing architecture provides clear extension points for these enhancements without requiring fundamental redesign.
