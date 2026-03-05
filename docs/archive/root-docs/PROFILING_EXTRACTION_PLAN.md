# Profiling System Extraction Plan

**Date:** October 29, 2025
**Module:** Profiling System (Phase 1, Priority 1)
**Estimated Effort:** Half day (3-4 hours)
**Risk Level:** Lowest (Zero coupling)

---

## Table of Contents

1. [Current Architecture Analysis](#current-architecture-analysis)
2. [Extraction Design](#extraction-design)
3. [Flow Diagrams: Before and After](#flow-diagrams-before-and-after)
4. [Implementation Steps](#implementation-steps)
5. [Testing Strategy](#testing-strategy)
6. [Rollback Plan](#rollback-plan)

---

## Current Architecture Analysis

### File-Level Overview

**Current State:**
```
pianoid_cuda/
├── pianoid.cu                    # 2,347 lines
│   ├── Lines 31-52: Profiling globals and helpers (22 lines)
│   ├── Lines 1587-1712: GPU timing in launchMainKernel() (125 lines)
│   ├── Lines 1881-1938: Filter timing in playSoundSamples() (58 lines)
│   └── Lines 2043-2121: Public profiling API (78 lines)
├── Pianoid.cuh                   # Header
│   └── Lines 441-446: Public API declarations
└── Profiler.h                    # Reusable profiling infrastructure
    ├── CycleCpuProfiler (lines 20-46)
    ├── GpuTimings struct (lines 48-53)
    ├── GpuCycleData struct (lines 56-59)
    └── ProfilingBuffer class (lines 62-128)
```

**Total profiling-related code in pianoid.cu:** ~283 lines
- **Extractable:** 78 lines (public API)
- **Stays in pianoid.cu:** 205 lines (instrumentation in launchMainKernel, playSoundSamples)

### Code Inventory

#### 1. Global State (Lines 31-52)
```cpp
#define PIANOID_ENABLE_PROFILING 1

#if PIANOID_ENABLE_PROFILING
    // Global TU-local variables
    static GpuTimings g_lastGpuTimings;           // Line 36
    static bool g_profiling_enabled = false;       // Line 39
    static ProfilingBuffer g_profiling_buffer;     // Line 40

    // Helper function
    static inline float elapsed_ms(cudaEvent_t a, cudaEvent_t b) {  // Line 47
        float ms = 0.f;
        cudaEventElapsedTime(&ms, a, b);
        return ms;
    }
#endif
```

**Purpose:**
- `g_lastGpuTimings` - Stores latest GPU kernel timings (written by `launchMainKernel()`)
- `g_profiling_enabled` - Controls whether data is recorded to buffer
- `g_profiling_buffer` - Thread-safe storage for profiling data
- `elapsed_ms()` - CUDA event timing helper

**Dependencies:** None (file-local static)

#### 2. Instrumentation in `launchMainKernel()` (Lines 1587-1712)

**Timing Points:**
1. **Parameter Kernel** (lines 1607-1625)
   ```cpp
   cudaEventRecord(e0);
   CUDA_LAUNCH_ASYNC(parameterKernel, ...);
   cudaEventRecord(e1);
   cudaDeviceSynchronize();
   cudaEventRecord(e2);
   parameter_ms = elapsed_ms(e1, e2);
   ```

2. **Gauss Kernel** (lines 1632-1662)
   ```cpp
   cudaEventRecord(e2);
   gaussKernel<<<...>>>(...);
   cudaEventRecord(e3);
   cudaDeviceSynchronize();
   cudaEventRecord(e4);
   gauss_ms = elapsed_ms(e3, e4);
   ```

3. **Add Kernel** (lines 1674-1696)
   ```cpp
   cudaEventRecord(e4);
   cudaLaunchCooperativeKernel((void*)addKernel, ...);
   cudaEventRecord(e5);
   add_ms = elapsed_ms(e4, e5);
   ```

4. **Publish Timings** (lines 1705-1708)
   ```cpp
   g_lastGpuTimings.parameter_ms = parameter_ms;
   g_lastGpuTimings.gauss_ms     = gauss_ms;
   g_lastGpuTimings.add_ms       = add_ms;
   ```

**Dependencies:**
- CUDA events (create, record, destroy)
- `elapsed_ms()` helper
- `g_lastGpuTimings` global

#### 3. Instrumentation in `playSoundSamples()` (Lines 1881-1938)

**Filter Timing:**
```cpp
#if PIANOID_ENABLE_PROFILING
    cudaEvent_t filter_start, filter_end;
    cudaEventCreate(&filter_start);
    cudaEventCreate(&filter_end);
    cudaEventRecord(filter_start);
#endif

cudaLaunchCooperativeKernel((void*)convolutionKernel, ...);

#if PIANOID_ENABLE_PROFILING
    cudaEventRecord(filter_end);
    float filter_ms = elapsed_ms(filter_start, filter_end);
    g_lastGpuTimings.filter_ms = filter_ms;  // Line 1935
    cudaEventDestroy(filter_start);
    cudaEventDestroy(filter_end);
#endif
```

**Dependencies:**
- CUDA events
- `elapsed_ms()` helper
- `g_lastGpuTimings` global

#### 4. Public API (Lines 2043-2121)

```cpp
void Pianoid::startProfiling() {
    g_profiling_enabled = true;
    std::printf("Profiling started\n");
}

void Pianoid::stopProfiling() {
    g_profiling_enabled = false;
    std::printf("Profiling stopped\n");
}

void Pianoid::resetProfiling() {
    g_profiling_buffer.clear();
    std::printf("Profiling buffer cleared\n");
}

void Pianoid::writeProfilingData(const std::string& cpu_filename,
                                 const std::string& gpu_filename) {
    g_profiling_buffer.write_cpu_csv(cpu_filename);
    g_profiling_buffer.write_gpu_csv(gpu_filename);
    std::printf("Profiling data written to:\n  CPU: %s\n  GPU: %s\n",
                cpu_filename.c_str(), gpu_filename.c_str());
}

std::vector<std::vector<float>> Pianoid::getGpuProfilingData() {
    auto gpu_data = g_profiling_buffer.get_gpu_data();
    std::vector<std::vector<float>> result;
    result.reserve(gpu_data.size());

    for (const auto& cycle : gpu_data) {
        std::vector<float> row = {
            static_cast<float>(cycle.cycle_index),
            cycle.timings.parameter_ms,
            cycle.timings.gauss_ms,
            cycle.timings.add_ms,
            cycle.timings.filter_ms
        };
        result.push_back(row);
    }

    return result;
}

std::vector<std::vector<long long>> Pianoid::getCpuProfilingData() {
    auto cpu_data = g_profiling_buffer.get_cpu_data();
    std::vector<std::vector<long long>> result;
    result.reserve(cpu_data.size());

    for (const auto& cycle : cpu_data) {
        std::vector<long long> row;
        row.push_back(cycle.cycle_index);

        for (const auto& mark : cycle.marks) {
            row.push_back(mark.t_us);
        }

        result.push_back(row);
    }

    return result;
}

#else  // PIANOID_ENABLE_PROFILING not defined
    // Stub implementations (lines 2110-2120)
    void Pianoid::startProfiling() {
        std::printf("Profiling is disabled (PIANOID_ENABLE_PROFILING=0)\n");
    }
    void Pianoid::stopProfiling() {}
    void Pianoid::resetProfiling() {}
    void Pianoid::writeProfilingData(const std::string&, const std::string&) {}
    std::vector<std::vector<float>> Pianoid::getGpuProfilingData() { return {}; }
    std::vector<std::vector<long long>> Pianoid::getCpuProfilingData() { return {}; }
#endif
```

**Dependencies:**
- `g_profiling_enabled` global
- `g_profiling_buffer` global
- `ProfilingBuffer` class (from Profiler.h)

### Missing: Data Recording Hook

**IMPORTANT FINDING:** The profiling system **publishes** timings to `g_lastGpuTimings` but **never records** them to `g_profiling_buffer`!

**Current Flow:**
1. `launchMainKernel()` → Measures timings → Writes to `g_lastGpuTimings`
2. `playSoundSamples()` → Measures filter timing → Writes to `g_lastGpuTimings`
3. **NO CODE** calls `g_profiling_buffer.add_gpu_cycle()`

**Implication:** The profiling buffer is never populated with GPU data in the current implementation. This is likely a **dormant feature** or **incomplete implementation**.

**Resolution for Extraction:** We'll add the missing recording hook in the new profiler module.

---

## Extraction Design

### New Module: `PianoidProfiler`

#### File Structure

```
pianoid_cuda/
├── PianoidProfiler.h            # NEW - Class declaration
└── PianoidProfiler.cu           # NEW - Implementation
```

#### Class Design

```cpp
// PianoidProfiler.h
#pragma once

#include "Profiler.h"  // GpuTimings, ProfilingBuffer, CycleCpuProfiler
#include <cuda_runtime.h>
#include <string>
#include <vector>

/**
 * PianoidProfiler - Manages profiling data collection for Pianoid synthesis cycles
 *
 * Responsibilities:
 * - Enable/disable profiling at runtime
 * - Store GPU kernel timings and CPU timestamps
 * - Export profiling data to CSV files
 * - Provide Python API for profiling data retrieval
 *
 * Thread-Safety: All public methods are thread-safe (uses internal mutex via ProfilingBuffer)
 *
 * Compile-Time Control: Entire class can be disabled via PIANOID_ENABLE_PROFILING=0
 */
class PianoidProfiler {
public:
    PianoidProfiler();
    ~PianoidProfiler() = default;

    // === CONTROL API ===

    /**
     * Enable profiling data recording
     * After calling this, recordGpuTimings() will store data to buffer
     */
    void start();

    /**
     * Disable profiling data recording
     * After calling this, recordGpuTimings() becomes a no-op
     */
    void stop();

    /**
     * Clear all accumulated profiling data
     * Thread-safe, can be called while profiling is active
     */
    void reset();

    /**
     * Check if profiling is currently enabled
     */
    bool isEnabled() const { return profiling_enabled_; }

    // === DATA RECORDING API ===

    /**
     * Record GPU kernel timings for the current cycle
     * Called by Pianoid::launchMainKernel() and Pianoid::playSoundSamples()
     *
     * @param cycle_index Current synthesis cycle number
     * @param timings GPU kernel timings (parameter, gauss, add, filter)
     *
     * Thread-safe, no-op if profiling disabled
     */
    void recordGpuTimings(int cycle_index, const GpuTimings& timings);

    /**
     * Record CPU timing marks for the current cycle
     * (For future use - not currently used by Pianoid)
     *
     * @param data CPU cycle profiling data with timing marks
     *
     * Thread-safe, no-op if profiling disabled
     */
    void recordCpuCycle(const CpuCycleData& data);

    // === DATA EXPORT API ===

    /**
     * Write profiling data to CSV files
     *
     * @param cpu_filename Output file for CPU profiling data
     * @param gpu_filename Output file for GPU kernel timings
     */
    void writeData(const std::string& cpu_filename, const std::string& gpu_filename);

    /**
     * Get GPU profiling data as 2D array
     * Format: [cycle_index, parameter_ms, gauss_ms, add_ms, filter_ms]
     *
     * @return Vector of rows, each row is [cycle, param, gauss, add, filter]
     */
    std::vector<std::vector<float>> getGpuData();

    /**
     * Get CPU profiling data as 2D array
     * Format: [cycle_index, mark1_us, mark2_us, ...]
     *
     * @return Vector of rows, each row is [cycle, timestamp1, timestamp2, ...]
     */
    std::vector<std::vector<long long>> getCpuData();

    // === INTERNAL STATE ACCESS (for launchMainKernel) ===

    /**
     * Update the last GPU timings cache
     * Used by launchMainKernel() to publish timings for immediate access
     *
     * @param timings GPU kernel timings to cache
     */
    void updateLastGpuTimings(const GpuTimings& timings);

    /**
     * Get the most recent GPU timings (from last cycle)
     *
     * @return Latest GPU kernel timings
     */
    GpuTimings getLastGpuTimings() const { return last_gpu_timings_; }

    // === CUDA EVENT TIMING HELPER ===

    /**
     * Calculate elapsed time between two CUDA events
     *
     * @param start Start event
     * @param end End event
     * @return Elapsed time in milliseconds
     */
    static float elapsedMs(cudaEvent_t start, cudaEvent_t end);

private:
    bool profiling_enabled_ = false;
    GpuTimings last_gpu_timings_;  // Cache for last cycle (fast access)
    ProfilingBuffer profiling_buffer_;  // Thread-safe storage
};
```

#### Implementation

```cpp
// PianoidProfiler.cu
#include "PianoidProfiler.h"
#include <cstdio>

PianoidProfiler::PianoidProfiler()
    : profiling_enabled_(false)
    , last_gpu_timings_{}
    , profiling_buffer_()
{
}

void PianoidProfiler::start() {
    profiling_enabled_ = true;
    std::printf("Profiling started - data will be recorded to memory buffer\n");
}

void PianoidProfiler::stop() {
    profiling_enabled_ = false;
    std::printf("Profiling stopped\n");
}

void PianoidProfiler::reset() {
    profiling_buffer_.clear();
    std::printf("Profiling buffer cleared\n");
}

void PianoidProfiler::recordGpuTimings(int cycle_index, const GpuTimings& timings) {
    if (!profiling_enabled_) return;

    profiling_buffer_.add_gpu_cycle(cycle_index, timings);
}

void PianoidProfiler::recordCpuCycle(const CpuCycleData& data) {
    if (!profiling_enabled_) return;

    profiling_buffer_.add_cpu_cycle(data);
}

void PianoidProfiler::writeData(const std::string& cpu_filename,
                                const std::string& gpu_filename) {
    profiling_buffer_.write_cpu_csv(cpu_filename);
    profiling_buffer_.write_gpu_csv(gpu_filename);
    std::printf("Profiling data written to:\n  CPU: %s\n  GPU: %s\n",
                cpu_filename.c_str(), gpu_filename.c_str());
}

std::vector<std::vector<float>> PianoidProfiler::getGpuData() {
    auto gpu_data = profiling_buffer_.get_gpu_data();
    std::vector<std::vector<float>> result;
    result.reserve(gpu_data.size());

    for (const auto& cycle : gpu_data) {
        std::vector<float> row = {
            static_cast<float>(cycle.cycle_index),
            cycle.timings.parameter_ms,
            cycle.timings.gauss_ms,
            cycle.timings.add_ms,
            cycle.timings.filter_ms
        };
        result.push_back(row);
    }

    return result;
}

std::vector<std::vector<long long>> PianoidProfiler::getCpuData() {
    auto cpu_data = profiling_buffer_.get_cpu_data();
    std::vector<std::vector<long long>> result;
    result.reserve(cpu_data.size());

    for (const auto& cycle : cpu_data) {
        std::vector<long long> row;
        row.push_back(cycle.cycle_index);

        for (const auto& mark : cycle.marks) {
            row.push_back(mark.t_us);
        }

        result.push_back(row);
    }

    return result;
}

void PianoidProfiler::updateLastGpuTimings(const GpuTimings& timings) {
    last_gpu_timings_ = timings;
}

float PianoidProfiler::elapsedMs(cudaEvent_t start, cudaEvent_t end) {
    float ms = 0.f;
    cudaEventElapsedTime(&ms, start, end);
    return ms;
}
```

---

## Flow Diagrams: Before and After

### BEFORE: Current Profiling Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                         pianoid.cu (2,347 lines)                    │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────┐    │
│  │ Global State (Lines 31-52)                                │    │
│  │                                                            │    │
│  │  static GpuTimings g_lastGpuTimings;                      │    │
│  │  static bool g_profiling_enabled = false;                 │    │
│  │  static ProfilingBuffer g_profiling_buffer;               │    │
│  │                                                            │    │
│  │  static inline float elapsed_ms(cudaEvent_t a, b) {...}   │    │
│  └───────────────────────────────────────────────────────────┘    │
│                              ▲                                      │
│                              │                                      │
│  ┌───────────────────────────┴───────────────────────────────┐    │
│  │ launchMainKernel() (Lines 1575-1715)                      │    │
│  │                                                            │    │
│  │  #if PIANOID_ENABLE_PROFILING                             │    │
│  │    cudaEvent_t e0, e1, e2, e3, e4, e5;                    │    │
│  │    cudaEventCreate(&e0); ... cudaEventCreate(&e5);        │    │
│  │                                                            │    │
│  │    // Measure parameter kernel                            │    │
│  │    cudaEventRecord(e0);                                   │    │
│  │    CUDA_LAUNCH_ASYNC(parameterKernel, ...);               │    │
│  │    cudaEventRecord(e1);                                   │    │
│  │    parameter_ms = elapsed_ms(e1, e2);                     │    │
│  │                                                            │    │
│  │    // Measure gauss kernel                                │    │
│  │    cudaEventRecord(e2);                                   │    │
│  │    gaussKernel<<<...>>>(...);                             │    │
│  │    cudaEventRecord(e3);                                   │    │
│  │    gauss_ms = elapsed_ms(e3, e4);                         │    │
│  │                                                            │    │
│  │    // Measure add kernel                                  │    │
│  │    cudaEventRecord(e4);                                   │    │
│  │    cudaLaunchCooperativeKernel((void*)addKernel, ...);    │    │
│  │    cudaEventRecord(e5);                                   │    │
│  │    add_ms = elapsed_ms(e4, e5);                           │    │
│  │                                                            │    │
│  │    // PUBLISH timings                                     │    │
│  │    g_lastGpuTimings.parameter_ms = parameter_ms;          │    │
│  │    g_lastGpuTimings.gauss_ms = gauss_ms;                  │    │
│  │    g_lastGpuTimings.add_ms = add_ms;                      │    │
│  │                                                            │    │
│  │    cudaEventDestroy(e0); ... cudaEventDestroy(e5);        │    │
│  │  #endif                                                    │    │
│  └───────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────┐    │
│  │ playSoundSamples() (Lines 1750-2007)                      │    │
│  │                                                            │    │
│  │  #if PIANOID_ENABLE_PROFILING                             │    │
│  │    cudaEvent_t filter_start, filter_end;                  │    │
│  │    cudaEventCreate(&filter_start);                        │    │
│  │    cudaEventCreate(&filter_end);                          │    │
│  │    cudaEventRecord(filter_start);                         │    │
│  │  #endif                                                    │    │
│  │                                                            │    │
│  │  cudaLaunchCooperativeKernel((void*)convolutionKernel);   │    │
│  │                                                            │    │
│  │  #if PIANOID_ENABLE_PROFILING                             │    │
│  │    cudaEventRecord(filter_end);                           │    │
│  │    filter_ms = elapsed_ms(filter_start, filter_end);      │    │
│  │    g_lastGpuTimings.filter_ms = filter_ms;  // PUBLISH    │    │
│  │    cudaEventDestroy(filter_start);                        │    │
│  │    cudaEventDestroy(filter_end);                          │    │
│  │  #endif                                                    │    │
│  └───────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────┐    │
│  │ Public API (Lines 2043-2121)                              │    │
│  │                                                            │    │
│  │  void startProfiling() {                                  │    │
│  │    g_profiling_enabled = true;                            │    │
│  │  }                                                         │    │
│  │                                                            │    │
│  │  void stopProfiling() {                                   │    │
│  │    g_profiling_enabled = false;                           │    │
│  │  }                                                         │    │
│  │                                                            │    │
│  │  void resetProfiling() {                                  │    │
│  │    g_profiling_buffer.clear();                            │    │
│  │  }                                                         │    │
│  │                                                            │    │
│  │  void writeProfilingData(...) {                           │    │
│  │    g_profiling_buffer.write_cpu_csv(...);                 │    │
│  │    g_profiling_buffer.write_gpu_csv(...);                 │    │
│  │  }                                                         │    │
│  │                                                            │    │
│  │  vector<vector<float>> getGpuProfilingData() {            │    │
│  │    auto data = g_profiling_buffer.get_gpu_data();         │    │
│  │    return formatted_data;                                 │    │
│  │  }                                                         │    │
│  └───────────────────────────────────────────────────────────┘    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

ISSUE: g_profiling_buffer is NEVER populated!
       No code calls g_profiling_buffer.add_gpu_cycle()
       Profiling data is published to g_lastGpuTimings but never recorded.
```

### AFTER: Extracted Profiling Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                        pianoid.cu (1,989 lines)                      │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ Pianoid Class                                              │    │
│  │                                                             │    │
│  │  private:                                                   │    │
│  │    #if PIANOID_ENABLE_PROFILING                            │    │
│  │      PianoidProfiler profiler_;  // NEW - owns profiling   │    │
│  │    #endif                                                   │    │
│  └────────────────────────────────────────────────────────────┘    │
│                              ▲                                       │
│                              │ uses                                  │
│  ┌───────────────────────────┴────────────────────────────────┐    │
│  │ launchMainKernel() (Lines 1575-1715)                       │    │
│  │                                                             │    │
│  │  #if PIANOID_ENABLE_PROFILING                              │    │
│  │    cudaEvent_t e0, e1, e2, e3, e4, e5;                     │    │
│  │    cudaEventCreate(&e0); ... cudaEventCreate(&e5);         │    │
│  │                                                             │    │
│  │    // Measure parameter kernel                             │    │
│  │    cudaEventRecord(e0);                                    │    │
│  │    CUDA_LAUNCH_ASYNC(parameterKernel, ...);                │    │
│  │    cudaEventRecord(e1);                                    │    │
│  │    float parameter_ms =                                    │    │
│  │        PianoidProfiler::elapsedMs(e1, e2);  // Static      │    │
│  │                                                             │    │
│  │    // ... measure gauss and add kernels ...                │    │
│  │                                                             │    │
│  │    GpuTimings timings = {                                  │    │
│  │        parameter_ms, gauss_ms, add_ms, 0.0f               │    │
│  │    };                                                       │    │
│  │                                                             │    │
│  │    // NEW - Record timings to profiler                     │    │
│  │    profiler_.updateLastGpuTimings(timings);                │    │
│  │    profiler_.recordGpuTimings(cycle_index, timings);       │    │
│  │                                                             │    │
│  │    cudaEventDestroy(e0); ... cudaEventDestroy(e5);         │    │
│  │  #endif                                                     │    │
│  │                                                             │    │
│  │  return *kernel_status;                                    │    │
│  └────────────────────────────────────────────────────────────┘    │
│                              │                                       │
│                              │ uses                                  │
│                              ▼                                       │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ playSoundSamples() (Lines 1750-2007)                       │    │
│  │                                                             │    │
│  │  #if PIANOID_ENABLE_PROFILING                              │    │
│  │    cudaEvent_t filter_start, filter_end;                   │    │
│  │    cudaEventCreate(&filter_start);                         │    │
│  │    cudaEventCreate(&filter_end);                           │    │
│  │    cudaEventRecord(filter_start);                          │    │
│  │  #endif                                                     │    │
│  │                                                             │    │
│  │  cudaLaunchCooperativeKernel((void*)convolutionKernel);    │    │
│  │                                                             │    │
│  │  #if PIANOID_ENABLE_PROFILING                              │    │
│  │    cudaEventRecord(filter_end);                            │    │
│  │    float filter_ms =                                       │    │
│  │        PianoidProfiler::elapsedMs(filter_start, filter_end);│    │
│  │                                                             │    │
│  │    // NEW - Update filter timing in profiler               │    │
│  │    GpuTimings timings = profiler_.getLastGpuTimings();     │    │
│  │    timings.filter_ms = filter_ms;                          │    │
│  │    profiler_.updateLastGpuTimings(timings);                │    │
│  │                                                             │    │
│  │    cudaEventDestroy(filter_start);                         │    │
│  │    cudaEventDestroy(filter_end);                           │    │
│  │  #endif                                                     │    │
│  └────────────────────────────────────────────────────────────┘    │
│                              │                                       │
│                              │ delegates                             │
│                              ▼                                       │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ Public API (Lines 2043-2121) - DELEGATES TO PROFILER       │    │
│  │                                                             │    │
│  │  void startProfiling() {                                   │    │
│  │    #if PIANOID_ENABLE_PROFILING                            │    │
│  │      profiler_.start();                                    │    │
│  │    #else                                                    │    │
│  │      printf("Profiling disabled\n");                       │    │
│  │    #endif                                                   │    │
│  │  }                                                          │    │
│  │                                                             │    │
│  │  void stopProfiling() {                                    │    │
│  │    #if PIANOID_ENABLE_PROFILING                            │    │
│  │      profiler_.stop();                                     │    │
│  │    #endif                                                   │    │
│  │  }                                                          │    │
│  │                                                             │    │
│  │  // ... similar delegation for all methods ...             │    │
│  └────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              │ delegates to
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                PianoidProfiler.cu/.h (NEW MODULE)                    │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ class PianoidProfiler {                                    │    │
│  │   private:                                                  │    │
│  │     bool profiling_enabled_ = false;                       │    │
│  │     GpuTimings last_gpu_timings_;  // Cache                │    │
│  │     ProfilingBuffer profiling_buffer_;  // Storage         │    │
│  │                                                             │    │
│  │   public:                                                   │    │
│  │     void start() {                                         │    │
│  │       profiling_enabled_ = true;                           │    │
│  │     }                                                       │    │
│  │                                                             │    │
│  │     void stop() {                                          │    │
│  │       profiling_enabled_ = false;                          │    │
│  │     }                                                       │    │
│  │                                                             │    │
│  │     void recordGpuTimings(int cycle, GpuTimings timings) { │    │
│  │       if (!profiling_enabled_) return;                     │    │
│  │       profiling_buffer_.add_gpu_cycle(cycle, timings);     │    │
│  │     }                                                       │    │
│  │                                                             │    │
│  │     void updateLastGpuTimings(GpuTimings timings) {        │    │
│  │       last_gpu_timings_ = timings;                         │    │
│  │     }                                                       │    │
│  │                                                             │    │
│  │     GpuTimings getLastGpuTimings() const {                 │    │
│  │       return last_gpu_timings_;                            │    │
│  │     }                                                       │    │
│  │                                                             │    │
│  │     vector<vector<float>> getGpuData() {                   │    │
│  │       auto data = profiling_buffer_.get_gpu_data();        │    │
│  │       return formatted_data;                               │    │
│  │     }                                                       │    │
│  │                                                             │    │
│  │     static float elapsedMs(cudaEvent_t a, b) {             │    │
│  │       float ms = 0.f;                                      │    │
│  │       cudaEventElapsedTime(&ms, a, b);                     │    │
│  │       return ms;                                            │    │
│  │     }                                                       │    │
│  │ };                                                          │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

FIXED: Profiling data is NOW recorded via profiler_.recordGpuTimings()
       Data flows: launchMainKernel() → profiler_ → ProfilingBuffer
```

### Key Improvements

#### 1. Data Recording Works Now
**Before:** Timings published to `g_lastGpuTimings` but never recorded
**After:** Timings both cached (`updateLastGpuTimings()`) AND recorded (`recordGpuTimings()`)

#### 2. Cleaner Lifecycle
**Before:** File-local static globals (unclear lifetime)
**After:** Profiler owned by Pianoid instance (explicit lifetime)

#### 3. Testability
**Before:** Can't unit test profiling without Pianoid instance
**After:** Can create standalone `PianoidProfiler` for testing

#### 4. Encapsulation
**Before:** Global state accessible anywhere in TU
**After:** State encapsulated in class, accessed via API

---

## Implementation Steps

### Step 1: Create New Files (15 minutes)

#### 1.1 Create `PianoidProfiler.h`
```bash
touch pianoid_cuda/PianoidProfiler.h
```

**Content:** (See "Class Design" section above)

#### 1.2 Create `PianoidProfiler.cu`
```bash
touch pianoid_cuda/PianoidProfiler.cu
```

**Content:** (See "Implementation" section above)

#### 1.3 Update build system
```python
# In build.py or CMakeLists.txt
sources = [
    # ... existing sources ...
    'pianoid_cuda/PianoidProfiler.cu',  # ADD THIS
]
```

### Step 2: Integrate into Pianoid Class (30 minutes)

#### 2.1 Add profiler member to `Pianoid.cuh`

**File:** `pianoid_cuda/Pianoid.cuh`

**Location:** After line 66 (in private section)

**Change:**
```cpp
// BEFORE
private:
    // === Unified GPU memory management system ===
    UnifiedGpuMemoryManager memory_manager_;

// AFTER
private:
    // === Unified GPU memory management system ===
    UnifiedGpuMemoryManager memory_manager_;

#if PIANOID_ENABLE_PROFILING
    // === Profiling system ===
    PianoidProfiler profiler_;
#endif
```

**Add include at top:**
```cpp
// After line 16 (after other includes)
#include "PianoidProfiler.h"
```

#### 2.2 Update `launchMainKernel()` in `pianoid.cu`

**File:** `pianoid_cuda/pianoid.cu`

**Location:** Lines 1575-1715

**Changes:**

1. **Replace `elapsed_ms()` calls** with `PianoidProfiler::elapsedMs()`
   ```cpp
   // BEFORE (line 1624)
   parameter_ms = elapsed_ms(e1, e2);

   // AFTER
   parameter_ms = PianoidProfiler::elapsedMs(e1, e2);
   ```

2. **Replace timing publication** (lines 1705-1708)
   ```cpp
   // BEFORE
   g_lastGpuTimings.parameter_ms = parameter_ms;
   g_lastGpuTimings.gauss_ms     = gauss_ms;
   g_lastGpuTimings.add_ms       = add_ms;

   // AFTER
   GpuTimings timings = {parameter_ms, gauss_ms, add_ms, 0.0f};
   profiler_.updateLastGpuTimings(timings);
   profiler_.recordGpuTimings(cycle_index, timings);  // NEW - actually record data
   ```

#### 2.3 Update `playSoundSamples()` in `pianoid.cu`

**File:** `pianoid_cuda/pianoid.cu`

**Location:** Lines 1932-1938

**Changes:**
```cpp
// BEFORE
#if PIANOID_ENABLE_PROFILING
    float filter_ms = elapsed_ms(filter_start, filter_end);
    g_lastGpuTimings.filter_ms = filter_ms;
    cudaEventDestroy(filter_start);
    cudaEventDestroy(filter_end);
#endif

// AFTER
#if PIANOID_ENABLE_PROFILING
    float filter_ms = PianoidProfiler::elapsedMs(filter_start, filter_end);

    // Update filter timing in existing cycle data
    GpuTimings timings = profiler_.getLastGpuTimings();
    timings.filter_ms = filter_ms;
    profiler_.updateLastGpuTimings(timings);
    // Note: Don't record again - already recorded by launchMainKernel()
    // This just updates the filter_ms field for the current cycle

    cudaEventDestroy(filter_start);
    cudaEventDestroy(filter_end);
#endif
```

**IMPORTANT:** Filter timing happens AFTER `launchMainKernel()` in the same cycle, so we update the cached timings but don't create a new record.

### Step 3: Update Public API (30 minutes)

**File:** `pianoid_cuda/pianoid.cu`

**Location:** Lines 2043-2121

**Changes:** Replace all 6 methods with delegation

```cpp
// BEFORE (lines 2043-2121) - 78 lines

#if PIANOID_ENABLE_PROFILING

void Pianoid::startProfiling() {
    g_profiling_enabled = true;
    std::printf("Profiling started - data will be recorded to memory buffer\n");
}

void Pianoid::stopProfiling() {
    g_profiling_enabled = false;
    std::printf("Profiling stopped\n");
}

void Pianoid::resetProfiling() {
    g_profiling_buffer.clear();
    std::printf("Profiling buffer cleared\n");
}

void Pianoid::writeProfilingData(const std::string& cpu_filename, const std::string& gpu_filename) {
    g_profiling_buffer.write_cpu_csv(cpu_filename);
    g_profiling_buffer.write_gpu_csv(gpu_filename);
    std::printf("Profiling data written to:\n  CPU: %s\n  GPU: %s\n",
                cpu_filename.c_str(), gpu_filename.c_str());
}

std::vector<std::vector<float>> Pianoid::getGpuProfilingData() {
    auto gpu_data = g_profiling_buffer.get_gpu_data();
    std::vector<std::vector<float>> result;
    result.reserve(gpu_data.size());

    for (const auto& cycle : gpu_data) {
        std::vector<float> row = {
            static_cast<float>(cycle.cycle_index),
            cycle.timings.parameter_ms,
            cycle.timings.gauss_ms,
            cycle.timings.add_ms,
            cycle.timings.filter_ms
        };
        result.push_back(row);
    }

    return result;
}

std::vector<std::vector<long long>> Pianoid::getCpuProfilingData() {
    auto cpu_data = g_profiling_buffer.get_cpu_data();
    std::vector<std::vector<long long>> result;
    result.reserve(cpu_data.size());

    for (const auto& cycle : cpu_data) {
        std::vector<long long> row;
        row.push_back(cycle.cycle_index);

        for (const auto& mark : cycle.marks) {
            row.push_back(mark.t_us);
        }

        result.push_back(row);
    }

    return result;
}

#else  // PIANOID_ENABLE_PROFILING not defined

void Pianoid::startProfiling() {
    std::printf("Profiling is disabled (PIANOID_ENABLE_PROFILING=0)\n");
}

void Pianoid::stopProfiling() {}
void Pianoid::resetProfiling() {}
void Pianoid::writeProfilingData(const std::string&, const std::string&) {}
std::vector<std::vector<float>> Pianoid::getGpuProfilingData() { return {}; }
std::vector<std::vector<long long>> Pianoid::getCpuProfilingData() { return {}; }

#endif // PIANOID_ENABLE_PROFILING


// AFTER (lines 2043-2067) - 24 lines (saves 54 lines!)

#if PIANOID_ENABLE_PROFILING

void Pianoid::startProfiling() {
    profiler_.start();
}

void Pianoid::stopProfiling() {
    profiler_.stop();
}

void Pianoid::resetProfiling() {
    profiler_.reset();
}

void Pianoid::writeProfilingData(const std::string& cpu_filename,
                                 const std::string& gpu_filename) {
    profiler_.writeData(cpu_filename, gpu_filename);
}

std::vector<std::vector<float>> Pianoid::getGpuProfilingData() {
    return profiler_.getGpuData();
}

std::vector<std::vector<long long>> Pianoid::getCpuProfilingData() {
    return profiler_.getCpuData();
}

#else  // PIANOID_ENABLE_PROFILING not defined

void Pianoid::startProfiling() {
    std::printf("Profiling is disabled (PIANOID_ENABLE_PROFILING=0)\n");
}

void Pianoid::stopProfiling() {}
void Pianoid::resetProfiling() {}
void Pianoid::writeProfilingData(const std::string&, const std::string&) {}
std::vector<std::vector<float>> Pianoid::getGpuProfilingData() { return {}; }
std::vector<std::vector<long long>> Pianoid::getCpuProfilingData() { return {}; }

#endif // PIANOID_ENABLE_PROFILING
```

### Step 4: Remove Global State (10 minutes)

**File:** `pianoid_cuda/pianoid.cu`

**Location:** Lines 31-52

**Delete:**
```cpp
// DELETE THIS ENTIRE SECTION

#define PIANOID_ENABLE_PROFILING 1  // Keep this line!

#if PIANOID_ENABLE_PROFILING

// Global (TU-local) last GPU timings updated by launchMainKernel()
static GpuTimings g_lastGpuTimings;  // DELETE

// Profiling control
static bool g_profiling_enabled = false;  // DELETE
static ProfilingBuffer g_profiling_buffer;  // DELETE

#endif // PIANOID_ENABLE_PROFILING

// -----------------------------------
// Helper: elapsed time from CUDA events
// -----------------------------------
#if PIANOID_ENABLE_PROFILING
static inline float elapsed_ms(cudaEvent_t a, cudaEvent_t b) {  // DELETE
    float ms = 0.f;
    cudaEventElapsedTime(&ms, a, b);
    return ms;
}
#endif
```

**Keep only:**
```cpp
#define PIANOID_ENABLE_PROFILING 1  // Keep this!
```

### Step 5: Compile and Test (45 minutes)

#### 5.1 Build the project
```bash
python build.py
```

**Expected:** Clean build, no errors

#### 5.2 Run existing tests
```bash
pytest test/  # Or however tests are run
```

**Expected:** All existing tests pass (API unchanged)

#### 5.3 Manual smoke test
```python
# test_profiling_extraction.py
import pianoid_wrapper  # Or however Pianoid is imported

def test_profiling_smoke():
    # Initialize Pianoid
    pianoid = pianoid_wrapper.create_pianoid(...)

    # Start profiling
    pianoid.startProfiling()

    # Run some cycles
    for i in range(10):
        pianoid.launchMainKernel()
        pianoid.playSoundSamples()

    # Get profiling data
    gpu_data = pianoid.getGpuProfilingData()

    # Verify data was recorded (THIS IS NEW!)
    assert len(gpu_data) == 10, f"Expected 10 cycles, got {len(gpu_data)}"

    # Verify data format
    assert len(gpu_data[0]) == 5, "Expected [cycle, param, gauss, add, filter]"

    # Verify cycle indices
    assert gpu_data[0][0] == 0, "First cycle should be 0"
    assert gpu_data[9][0] == 9, "Last cycle should be 9"

    print("✓ Profiling data recording works!")

    # Write to CSV
    pianoid.writeProfilingData("cpu_profile.csv", "gpu_profile.csv")

    # Verify files exist
    import os
    assert os.path.exists("cpu_profile.csv")
    assert os.path.exists("gpu_profile.csv")

    print("✓ CSV export works!")

    # Reset and verify
    pianoid.resetProfiling()
    gpu_data = pianoid.getGpuProfilingData()
    assert len(gpu_data) == 0, "Buffer should be empty after reset"

    print("✓ Reset works!")

if __name__ == "__main__":
    test_profiling_smoke()
```

---

## Testing Strategy

### Unit Tests (PianoidProfiler in isolation)

```cpp
// test/test_pianoid_profiler.cu
#include "PianoidProfiler.h"
#include <gtest/gtest.h>

TEST(PianoidProfiler, ConstructorInitializes) {
    PianoidProfiler profiler;
    EXPECT_FALSE(profiler.isEnabled());

    auto data = profiler.getGpuData();
    EXPECT_EQ(data.size(), 0);
}

TEST(PianoidProfiler, StartStopCycle) {
    PianoidProfiler profiler;

    profiler.start();
    EXPECT_TRUE(profiler.isEnabled());

    profiler.stop();
    EXPECT_FALSE(profiler.isEnabled());
}

TEST(PianoidProfiler, RecordGpuTimings) {
    PianoidProfiler profiler;
    profiler.start();

    GpuTimings t1 = {1.0f, 2.0f, 3.0f, 4.0f};
    profiler.recordGpuTimings(0, t1);

    GpuTimings t2 = {5.0f, 6.0f, 7.0f, 8.0f};
    profiler.recordGpuTimings(1, t2);

    auto data = profiler.getGpuData();
    ASSERT_EQ(data.size(), 2);

    // Check first cycle
    EXPECT_EQ(data[0][0], 0);  // cycle index
    EXPECT_FLOAT_EQ(data[0][1], 1.0f);  // parameter_ms
    EXPECT_FLOAT_EQ(data[0][2], 2.0f);  // gauss_ms
    EXPECT_FLOAT_EQ(data[0][3], 3.0f);  // add_ms
    EXPECT_FLOAT_EQ(data[0][4], 4.0f);  // filter_ms

    // Check second cycle
    EXPECT_EQ(data[1][0], 1);  // cycle index
    EXPECT_FLOAT_EQ(data[1][1], 5.0f);  // parameter_ms
}

TEST(PianoidProfiler, DoesNotRecordWhenDisabled) {
    PianoidProfiler profiler;
    // Don't call start()

    GpuTimings t1 = {1.0f, 2.0f, 3.0f, 4.0f};
    profiler.recordGpuTimings(0, t1);

    auto data = profiler.getGpuData();
    EXPECT_EQ(data.size(), 0);  // Should be empty
}

TEST(PianoidProfiler, ResetClearsBuffer) {
    PianoidProfiler profiler;
    profiler.start();

    GpuTimings t1 = {1.0f, 2.0f, 3.0f, 4.0f};
    profiler.recordGpuTimings(0, t1);

    profiler.reset();

    auto data = profiler.getGpuData();
    EXPECT_EQ(data.size(), 0);
}

TEST(PianoidProfiler, LastGpuTimingsCache) {
    PianoidProfiler profiler;

    GpuTimings t1 = {1.0f, 2.0f, 3.0f, 4.0f};
    profiler.updateLastGpuTimings(t1);

    GpuTimings cached = profiler.getLastGpuTimings();
    EXPECT_FLOAT_EQ(cached.parameter_ms, 1.0f);
    EXPECT_FLOAT_EQ(cached.gauss_ms, 2.0f);
    EXPECT_FLOAT_EQ(cached.add_ms, 3.0f);
    EXPECT_FLOAT_EQ(cached.filter_ms, 4.0f);
}

TEST(PianoidProfiler, ElapsedMsHelper) {
    cudaEvent_t start, end;
    cudaEventCreate(&start);
    cudaEventCreate(&end);

    cudaEventRecord(start);
    // Simulate some work
    float* dev_ptr;
    cudaMalloc(&dev_ptr, 1000 * sizeof(float));
    cudaMemset(dev_ptr, 0, 1000 * sizeof(float));
    cudaEventRecord(end);
    cudaEventSynchronize(end);

    float elapsed = PianoidProfiler::elapsedMs(start, end);
    EXPECT_GT(elapsed, 0.0f);
    EXPECT_LT(elapsed, 100.0f);  // Should be fast

    cudaFree(dev_ptr);
    cudaEventDestroy(start);
    cudaEventDestroy(end);
}
```

### Integration Tests (Pianoid with profiler)

```python
# test/test_profiling_integration.py
import pianoid_wrapper as pw
import numpy as np

def test_profiling_records_data():
    """Test that profiling actually records data during synthesis cycles"""

    # Setup Pianoid
    config = pw.create_default_config()
    pianoid = pw.Pianoid(config)
    pianoid.initialize(...)

    # Start profiling
    pianoid.startProfiling()

    # Run synthesis cycles
    num_cycles = 100
    for i in range(num_cycles):
        status = pianoid.launchMainKernel()
        assert status == 200
        pianoid.playSoundSamples()

    # Get profiling data
    gpu_data = pianoid.getGpuProfilingData()

    # Verify data was recorded
    assert len(gpu_data) == num_cycles, f"Expected {num_cycles} cycles, got {len(gpu_data)}"

    # Verify data format
    for i, cycle_data in enumerate(gpu_data):
        assert len(cycle_data) == 5, "Expected [cycle, param, gauss, add, filter]"
        assert cycle_data[0] == i, f"Cycle index mismatch at {i}"

        # Check that timings are reasonable (> 0 and < 100ms)
        for timing_idx in range(1, 5):
            timing_ms = cycle_data[timing_idx]
            assert timing_ms >= 0.0, f"Negative timing at cycle {i}, field {timing_idx}"
            assert timing_ms < 100.0, f"Suspiciously high timing at cycle {i}, field {timing_idx}"

    print(f"✓ Recorded {num_cycles} cycles successfully")

def test_profiling_csv_export():
    """Test CSV export functionality"""

    pianoid = setup_pianoid()
    pianoid.startProfiling()

    # Run cycles
    for _ in range(50):
        pianoid.launchMainKernel()
        pianoid.playSoundSamples()

    # Export to CSV
    import tempfile
    import os

    cpu_file = tempfile.mktemp(suffix=".csv")
    gpu_file = tempfile.mktemp(suffix=".csv")

    pianoid.writeProfilingData(cpu_file, gpu_file)

    # Verify files exist
    assert os.path.exists(cpu_file)
    assert os.path.exists(gpu_file)

    # Verify GPU CSV format
    with open(gpu_file, 'r') as f:
        lines = f.readlines()
        assert len(lines) == 51, "Expected header + 50 data rows"

        header = lines[0].strip()
        assert header == "cycle,parameter_ms,gauss_ms,add_ms,filter_ms"

        # Check first data row
        first_row = lines[1].strip().split(',')
        assert len(first_row) == 5
        assert int(first_row[0]) == 0  # First cycle

    # Cleanup
    os.remove(cpu_file)
    os.remove(gpu_file)

    print("✓ CSV export works correctly")

def test_profiling_start_stop_reset():
    """Test profiling control flow"""

    pianoid = setup_pianoid()

    # Initially disabled
    data = pianoid.getGpuProfilingData()
    assert len(data) == 0

    # Start profiling
    pianoid.startProfiling()

    # Run cycles (should record)
    for _ in range(10):
        pianoid.launchMainKernel()
        pianoid.playSoundSamples()

    data = pianoid.getGpuProfilingData()
    assert len(data) == 10

    # Stop profiling
    pianoid.stopProfiling()

    # Run more cycles (should NOT record)
    for _ in range(5):
        pianoid.launchMainKernel()
        pianoid.playSoundSamples()

    data = pianoid.getGpuProfilingData()
    assert len(data) == 10, "Should still be 10 (not recording)"

    # Reset
    pianoid.resetProfiling()
    data = pianoid.getGpuProfilingData()
    assert len(data) == 0

    print("✓ Start/stop/reset flow works")
```

### Regression Tests

```bash
# Run full test suite
pytest test/ -v

# Check for memory leaks
valgrind --leak-check=full python test/test_profiling_integration.py

# CUDA memory check
cuda-memcheck python test/test_profiling_integration.py

# Performance benchmark (should be same as before)
python benchmark/profile_synthesis.py
```

---

## Rollback Plan

### Quick Rollback (if build breaks)

1. **Revert files:**
   ```bash
   git checkout HEAD -- pianoid_cuda/pianoid.cu
   git checkout HEAD -- pianoid_cuda/Pianoid.cuh
   rm pianoid_cuda/PianoidProfiler.h
   rm pianoid_cuda/PianoidProfiler.cu
   ```

2. **Rebuild:**
   ```bash
   python build.py
   ```

### Partial Rollback (if tests fail)

If the extraction compiles but tests fail:

1. **Keep new files** (PianoidProfiler.h/.cu)
2. **Revert integration** (pianoid.cu changes)
3. **Debug issue** in isolation
4. **Re-apply integration** once fixed

---

## Success Criteria

### ✅ Build Success
- [ ] Project compiles without errors
- [ ] No new warnings introduced
- [ ] Both PIANOID_ENABLE_PROFILING=1 and =0 build successfully

### ✅ Functional Correctness
- [ ] All existing tests pass
- [ ] New unit tests pass
- [ ] Profiling data is actually recorded (NEW - previously broken!)
- [ ] CSV export works
- [ ] Python API unchanged

### ✅ Code Quality
- [ ] pianoid.cu reduced by ~78 lines
- [ ] New module has clear API
- [ ] No performance regression (<1% variance)

### ✅ Documentation
- [ ] PianoidProfiler.h has complete doc comments
- [ ] This extraction plan archived in docs/

---

## Timeline

### Day 1: Implementation (3-4 hours)

- **Hour 1:** Create new files, implement PianoidProfiler class
- **Hour 2:** Integrate into Pianoid (add member, update launchMainKernel)
- **Hour 3:** Update public API, remove global state
- **Hour 4:** Build, fix compilation issues

### Day 1: Testing (1-2 hours)

- **30 min:** Run existing tests
- **30 min:** Write/run unit tests
- **30 min:** Integration tests
- **30 min:** Performance benchmarks

### Total: Half day to full day

---

## Follow-Up Work

### After Extraction

1. **Add CPU profiling support** (currently unused)
   - CycleCpuProfiler exists in Profiler.h but never used
   - Could add `profiler_.recordCpuCycle()` calls in playback engines

2. **Enhance profiling API**
   - Add `getAverageTimings()` method
   - Add `getPercentiles()` method
   - Add real-time monitoring hooks

3. **Document profiling usage**
   - Add to COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md
   - Create PROFILING_GUIDE.md with examples

4. **Frontend integration**
   - Add profiling charts to web UI
   - Real-time performance monitoring dashboard

---

## Appendix: Code Size Comparison

### Before Extraction
```
pianoid.cu: 2,347 lines
├── Profiling globals: 22 lines
├── Profiling instrumentation: 205 lines (stays)
└── Profiling API: 78 lines (extracted)
```

### After Extraction
```
pianoid.cu: 2,269 lines (-78 lines, -3.3%)
├── Profiling instrumentation: 205 lines (stays)
└── Profiling API: 24 lines (delegation)

PianoidProfiler.h: 120 lines (NEW)
PianoidProfiler.cu: 100 lines (NEW)

Total: 2,489 lines (+142 lines, +6%)
```

**Analysis:** Net increase of 142 lines, but:
- Better organization (profiling logic in dedicated module)
- Testable in isolation
- Fixes broken feature (data recording now works)
- Foundation for future profiling enhancements

**Trade-off justified** ✅

---

**Document Status:** Ready for execution
**Next Step:** Begin implementation (Step 1: Create new files)
