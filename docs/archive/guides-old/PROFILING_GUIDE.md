# Pianoid Profiling System - Complete Guide

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Architecture](#architecture)
4. [API Reference](#api-reference)
5. [Usage Examples](#usage-examples)
6. [Data Format](#data-format)
7. [Performance Analysis](#performance-analysis)
8. [Troubleshooting](#troubleshooting)
9. [Implementation Details](#implementation-details)
10. [Rebuild Instructions](#rebuild-instructions)

---

## Overview

The Pianoid profiling system provides complete control over GPU and CPU performance measurement. It allows you to:

- **Control when profiling data is recorded** (start/stop/reset)
- **Write profiling data to custom file locations** on demand
- **Access profiling data programmatically** from Python
- **Visualize profiling results** in the chart engine
- **Analyze performance bottlenecks** in real-time audio processing

### Key Features

✓ **Full control** - Start/stop profiling whenever needed
✓ **Flexible output** - Write to custom CSV files or access data in Python
✓ **GPU timing** - Measures parameter, gauss, synthesis, and filter kernels
✓ **CPU timing** - Tracks cycle checkpoints
✓ **Chart visualization** - Built-in plotting functions
✓ **Zero overhead** - Only records when explicitly enabled
✓ **Thread-safe** - Safe for concurrent access

---

## Quick Start

### Simplest Method (Using Chart Functions)

```python
from chartFunctions import profiling_action, profiling_data_function

# 1. Start profiling
profiling_action(pianoid, action='start')

# 2. Run your test
pianoid.runMainApplication(duration=5000, audioEnabled=True)

# 3. Visualize (auto-stops and writes to files)
charts, header, fields = profiling_data_function(
    pianoid,
    cpu_file='my_test_cpu.csv',
    gpu_file='my_test_gpu.csv'
)
```

**Result:**
- ✓ Profiling data saved to `my_test_cpu.csv` and `my_test_gpu.csv`
- ✓ Charts created showing timing breakdown
- ✓ Performance statistics displayed

---

## Architecture

### Component Overview

```
Python Layer (pianoid_middleware)
├── chartFunctions.py
│   ├── profiling_action()         # Start/stop/reset control
│   └── profiling_data_function()  # Visualization
│
C++ Layer (pianoid_cuda)
├── Pianoid.cuh                    # Method declarations
├── Pianoid.cu                     # Implementation
│   ├── startProfiling()
│   ├── stopProfiling()
│   ├── resetProfiling()
│   ├── writeProfilingData()
│   ├── getGpuProfilingData()
│   └── getCpuProfilingData()
└── Profiler.h                     # Data structures
    ├── GpuTimings
    ├── CpuCycleData
    ├── GpuCycleData
    └── ProfilingBuffer
```

### Data Flow

```
1. User calls startProfiling()
   ↓
2. runMainApplication() executes cycles
   ↓
3. Each cycle: CUDA events measure kernel timing
   ↓
4. Timing data stored in ProfilingBuffer (thread-safe)
   ↓
5. User calls stopProfiling()
   ↓
6. Data written to CSV or accessed via Python
```

### Key Structures

#### GpuTimings
```cpp
struct GpuTimings {
    float parameter_ms = 0.f;  // Parameter kernel time
    float gauss_ms     = 0.f;  // Gauss excitation kernel time
    float add_ms       = 0.f;  // Main synthesis kernel time
    float filter_ms    = 0.f;  // FIR filter kernel time
};
```

#### ProfilingBuffer
- Thread-safe storage for profiling data
- Stores GPU and CPU cycle data separately
- Methods: `add_gpu_cycle()`, `add_cpu_cycle()`, `clear()`, `get_gpu_data()`, `get_cpu_data()`
- CSV export: `write_gpu_csv()`, `write_cpu_csv()`

---

## API Reference

### Chart Functions (Recommended)

#### `profiling_action(pianoid, **kwargs)`

Control profiling from chart engine.

**Parameters:**
- `action` (str): 'start', 'stop', or 'reset' **[required]**
- `cpu_file` (str): CPU timing CSV file path (default: 'cpu_profiling.csv')
- `gpu_file` (str): GPU timing CSV file path (default: 'gpu_profiling.csv')

**Returns:** `dict` with status information

**Examples:**
```python
# Start profiling (clears buffer first)
result = profiling_action(pianoid, action='start')

# Stop and write to files
result = profiling_action(pianoid, action='stop',
                          cpu_file='test1_cpu.csv',
                          gpu_file='test1_gpu.csv')
print(f"Recorded {result['cycles_recorded']} cycles")

# Clear buffer without stopping
profiling_action(pianoid, action='reset')
```

#### `profiling_data_function(pianoid, **kwargs)`

Visualize profiling data in chart engine.

**Parameters:**
- `budget_ms` (float): Expected cycle time budget in ms (default: 1.0)
- `show_filter` (bool): Include filter timing (default: True)
- `cpu_file` (str): CPU timing CSV file path (default: 'cpu_profiling.csv')
- `gpu_file` (str): GPU timing CSV file path (default: 'gpu_profiling.csv')
- `auto_stop` (bool): Automatically stop profiling if running (default: True)
- `auto_write` (bool): Automatically write to files (default: True)

**Returns:** `tuple(charts, header, text_fields)`

**Examples:**
```python
# Auto-stop profiling and visualize
charts, header, fields = profiling_data_function(pianoid)

# Custom budget and file paths
charts, header, fields = profiling_data_function(
    pianoid,
    budget_ms=0.8,
    cpu_file='experiment_cpu.csv',
    gpu_file='experiment_gpu.csv'
)

# Visualize without auto-stop (profiling already stopped)
charts, header, fields = profiling_data_function(
    pianoid,
    auto_stop=False,
    auto_write=False
)
```

### C++ API (Python Bindings)

#### `pianoid.pianoid.startProfiling()`
Start recording profiling data to memory buffer.

```python
pianoid.pianoid.startProfiling()
```

#### `pianoid.pianoid.stopProfiling()`
Stop recording profiling data.

```python
pianoid.pianoid.stopProfiling()
```

#### `pianoid.pianoid.resetProfiling()`
Clear profiling data buffer.

```python
pianoid.pianoid.resetProfiling()
```

#### `pianoid.pianoid.writeProfilingData(cpu_file, gpu_file)`
Write profiling data to CSV files.

**Parameters:**
- `cpu_file` (str): Path to CPU timing CSV file
- `gpu_file` (str): Path to GPU timing CSV file

```python
pianoid.pianoid.writeProfilingData("my_cpu_timing.csv", "my_gpu_timing.csv")
```

#### `pianoid.pianoid.getGpuProfilingData()`
Get GPU profiling data as list.

**Returns:** `list` of lists: `[[cycle, parameter_ms, gauss_ms, add_ms, filter_ms], ...]`

```python
gpu_data = pianoid.pianoid.getGpuProfilingData()
# Example: [[0, 0.145, 0.052, 0.287, 0.612], [1, 0.143, ...], ...]
```

#### `pianoid.pianoid.getCpuProfilingData()`
Get CPU profiling data as list.

**Returns:** `list` of lists: `[[cycle, mark1_us, mark2_us, ...], ...]`

```python
cpu_data = pianoid.pianoid.getCpuProfilingData()
```

---

## Usage Examples

### Example 1: Profile and Visualize (Simplest)

```python
from chartFunctions import profiling_action, profiling_data_function

# Start
profiling_action(pianoid, action='start')

# Run test
pianoid.runMainApplication(duration=5000, audioEnabled=True)

# Visualize (auto-stops)
charts, header, fields = profiling_data_function(pianoid)
```

### Example 2: Profile Multiple Tests

```python
from chartFunctions import profiling_action

# Test 1
profiling_action(pianoid, action='start')
pianoid.runMainApplication(duration=5000, audioEnabled=True)
result = profiling_action(pianoid, action='stop',
                          cpu_file='test1_cpu.csv',
                          gpu_file='test1_gpu.csv')
print(f"Test 1: {result['cycles_recorded']} cycles")

# Test 2
profiling_action(pianoid, action='start')
pianoid.runMainApplication(duration=5000, audioEnabled=True)
result = profiling_action(pianoid, action='stop',
                          cpu_file='test2_cpu.csv',
                          gpu_file='test2_gpu.csv')
print(f"Test 2: {result['cycles_recorded']} cycles")
```

### Example 3: Manual Control + Analysis

```python
# Manual control
pianoid.pianoid.startProfiling()
pianoid.runMainApplication(duration=5000, audioEnabled=True)
pianoid.pianoid.stopProfiling()

# Get data for analysis
gpu_data = pianoid.pianoid.getGpuProfilingData()

# Analyze
import numpy as np
data = np.array(gpu_data)
total_time = data[:, 1] + data[:, 2] + data[:, 3] + data[:, 4]
print(f"Mean total time: {total_time.mean():.3f} ms")
print(f"Max total time: {total_time.max():.3f} ms")

# Write to file
pianoid.pianoid.writeProfilingData("analysis_cpu.csv", "analysis_gpu.csv")
```

### Example 4: Compare Filter On/Off

```python
from chartFunctions import profiling_action

# Test without filter
pianoid.switchFirFilter(False)
profiling_action(pianoid, action='start')
pianoid.runMainApplication(duration=5000, audioEnabled=True)
profiling_action(pianoid, action='stop',
                 cpu_file='no_filter_cpu.csv',
                 gpu_file='no_filter_gpu.csv')

# Test with filter
pianoid.switchFirFilter(True)
profiling_action(pianoid, action='start')
pianoid.runMainApplication(duration=5000, audioEnabled=True)
profiling_action(pianoid, action='stop',
                 cpu_file='with_filter_cpu.csv',
                 gpu_file='with_filter_gpu.csv')
```

---

## Data Format

### GPU Data Format

Each row: `[cycle_index, parameter_ms, gauss_ms, add_ms, filter_ms]`

**CSV Example:**
```csv
cycle,parameter_ms,gauss_ms,add_ms,filter_ms
0,0.145,0.052,0.287,0.612
1,0.143,0.051,0.284,0.608
2,0.147,0.053,0.289,0.615
```

**Column Descriptions:**

| Column | Description | Typical Range |
|--------|-------------|---------------|
| cycle | Cycle number | 0, 1, 2, ... |
| parameter_ms | Parameter kernel time | 0.1-0.2 ms |
| gauss_ms | Gauss excitation kernel time | 0.04-0.06 ms |
| add_ms | Main synthesis kernel time | 0.2-0.3 ms |
| filter_ms | FIR filter kernel time | 0.2-0.6 ms (0.0 if disabled) |

### CPU Data Format

Each row: `[cycle_index, mark1_us, mark2_us, mark3_us, mark4_us]`

**Timing Marks:**
1. `after_launchMainKernel_us` - After GPU kernel launch
2. `after_playSoundSamples_us` - After audio output
3. `after_appendSoundRecords_us` - After sound recording
4. `after_stopApplication_us` - After cycle completion

---

## Performance Analysis

### Performance Budgets

#### Typical Timing Budgets (48 kHz, 64 samples/buffer)

**Cycle time budget:** 1.33 ms (64 samples / 48000 Hz)

**Recommended GPU time:** < 0.8 ms (leaves 0.5 ms margin for CPU/driver)

**Individual kernel targets:**
- Parameter kernel: < 0.2 ms
- Gauss kernel: < 0.1 ms
- Add kernel: < 0.3 ms
- Filter kernel: < 0.5 ms

### Interpreting Results

**Total GPU time interpretation:**
- **< 0.8 ms**: ✓ OK - Good performance
- **0.8-1.0 ms**: ⚠️ WARNING - Getting close to limit
- **> 1.0 ms**: ❌ EXCEEDS BUDGET - Audio underruns likely

### Analysis Workflow

1. **Collect profiling data:**
```python
profiling_action(pianoid, action='start')
pianoid.runMainApplication(duration=5000, audioEnabled=True)
profiling_action(pianoid, action='stop', gpu_file='profile.csv')
```

2. **Load and analyze:**
```python
import pandas as pd
df = pd.read_csv("profile.csv")

# Calculate total GPU time per cycle
df['total_ms'] = df['parameter_ms'] + df['gauss_ms'] + df['add_ms'] + df['filter_ms']

# Check if exceeding budget
print(f"Mean total GPU time: {df['total_ms'].mean():.3f} ms")
print(f"Max total GPU time: {df['total_ms'].max():.3f} ms")
print(f"Mean filter time: {df['filter_ms'].mean():.3f} ms")
print(f"% of time in filter: {(df['filter_ms'].sum() / df['total_ms'].sum() * 100):.1f}%")

# Check for cycles exceeding 1ms budget
over_budget = df[df['total_ms'] > 1.0]
print(f"Cycles over 1ms budget: {len(over_budget)} / {len(df)}")
```

3. **Identify bottleneck:**
   - If `filter_ms` > 0.5 ms → Filter kernel is too slow
   - If `total_ms` > 1.0 ms → Missing real-time deadline
   - If `filter_ms` varies widely → Investigate kernel behavior

### Visualization

```python
import pandas as pd
import matplotlib.pyplot as plt

df = pd.read_csv("profile.csv")

# Plot all kernel times
df[['parameter_ms', 'gauss_ms', 'add_ms', 'filter_ms']].plot(figsize=(12,6))
plt.ylabel('Time (ms)')
plt.xlabel('Cycle')
plt.title('GPU Kernel Timing per Cycle')
plt.axhline(y=1.0, color='r', linestyle='--', label='1ms budget')
plt.legend()
plt.show()

# Filter timing distribution
df['filter_ms'].hist(bins=50)
plt.xlabel('Filter Time (ms)')
plt.ylabel('Frequency')
plt.title('FIR Filter Kernel Time Distribution')
plt.show()
```

### Optimization Strategies

If filter kernel is too slow:

1. **Reduce filter length** - Shorter filters = less computation
2. **Reduce grid Y-dimension** - Adjust cooperative launch parameters
3. **Non-cooperative kernel** - Remove grid sync requirement
4. **Multi-pass filtering** - Split large filters across multiple cycles
5. **Increase samplesPerCycle** - Amortize overhead over more samples

---

## Troubleshooting

### Problem: "No profiling data available"
**Solution:** Call `profiling_action(pianoid, action='start')` before running the application.

### Problem: "Profiling methods not available"
**Cause:** The pianoidCuda module needs to be recompiled.
**Solution:** See [Rebuild Instructions](#rebuild-instructions)

### Problem: Empty CSV files
**Cause:** Profiling was not started, or no cycles were recorded.
**Solution:**
1. Ensure profiling is started before `runMainApplication()`
2. Check that the application actually ran (duration > 0)

### Problem: Filter timing is 0.0
**Cause:** FIR filter is disabled.
**Solution:** This is normal. Enable filter with `pianoid.switchFirFilter(True)`.

### Problem: Getting old data from previous run
**Solution:** Call `profiling_action(pianoid, action='reset')` before starting new profiling session.

### Problem: Charts show unexpected results
**Cause:** Profiling might still be running when visualizing.
**Solution:** Use `profiling_data_function()` with default settings - it auto-stops profiling.

### Problem: Legacy CSV files still being created
**Cause:** `PIANOID_LEGACY_CSV_OUTPUT` is set to 1.
**Solution:** See [Legacy CSV Output](#legacy-csv-output) section.

---

## Implementation Details

### Compilation Flags

#### PIANOID_ENABLE_PROFILING
Controls whether profiling infrastructure is compiled.

```cpp
#define PIANOID_ENABLE_PROFILING 1  // In Pianoid.cu:24
```

**When set to 0:**
- All profiling code is compiled out
- Zero runtime overhead
- Profiling methods return empty data

**When set to 1:**
- Profiling infrastructure available
- Profiling only records when explicitly enabled via `startProfiling()`

#### PIANOID_LEGACY_CSV_OUTPUT
Controls legacy automatic CSV file creation.

```cpp
#define PIANOID_LEGACY_CSV_OUTPUT 0  // In Pianoid.cu:25 (default: disabled)
```

**When set to 0 (default):**
- No automatic CSV files created
- Only new controlled profiling system active

**When set to 1:**
- Legacy CSV files created: `cpu_cycle_timing.csv`, `gpu_cycle_timing.csv`
- Both old and new profiling systems run simultaneously

### Timing Measurement

#### GPU Kernels

All GPU kernels are timed using CUDA events:

```cpp
#if PIANOID_ENABLE_PROFILING
    cudaEvent_t start, end;
    cudaEventCreate(&start);
    cudaEventCreate(&end);
    cudaEventRecord(start);
#endif

    // Kernel launch
    myKernel<<<grid, block>>>(...);

#if PIANOID_ENABLE_PROFILING
    cudaEventRecord(end);
    cudaEventSynchronize(end);
    float ms = 0;
    cudaEventElapsedTime(&ms, start, end);
    g_lastGpuTimings.kernel_ms = ms;
    cudaEventDestroy(start);
    cudaEventDestroy(end);
#endif
```

#### CPU Checkpoints

CPU timing uses high-resolution clock:

```cpp
CycleCpuProfiler cpu_prof;
cpu_prof.begin_cycle(cycle_index);  // Record start time

// ... operations ...
cpu_prof.mark("checkpoint_name");    // Record checkpoint

// End of cycle - data saved to buffer
```

### Thread Safety

`ProfilingBuffer` is thread-safe using `std::mutex`:

```cpp
class ProfilingBuffer {
    void add_gpu_cycle(int cycle_idx, const GpuTimings& timings) {
        std::lock_guard<std::mutex> lock(mtx);
        gpu_data.push_back({cycle_idx, timings});
    }
    // ... other methods also protected by mutex
private:
    mutable std::mutex mtx;
};
```

### Memory Overhead

Per cycle:
- GPU record: ~20 bytes (5 floats)
- CPU record: ~40-80 bytes (varies by number of marks)

For 1000 cycles: ~60 KB total (negligible)

---

## Rebuild Instructions

### When to Rebuild

Rebuild the pianoidCuda module when:
- C++ source files are modified (Pianoid.cu, Profiler.h, etc.)
- Compilation flags are changed
- After updating profiling code

### How to Rebuild

#### Option 1: Using batch script (Recommended)

```bash
cd d:\repos\PianoidInstall\PianoidCore
.\build_pianoid_cuda.bat
```

#### Option 2: Using pip

```bash
cd d:\repos\PianoidInstall\PianoidCore\pianoid_cuda
pip install -e . --force-reinstall --no-deps
```

#### Option 3: Clean rebuild

If you have build issues:

```bash
cd d:\repos\PianoidInstall\PianoidCore\pianoid_cuda

# Remove old build artifacts
rmdir /s /q build
rmdir /s /q dist
del /q *.pyd 2>nul
del /q *.exp 2>nul
del /q *.lib 2>nul

# Rebuild
pip install -e . --force-reinstall --no-deps
```

### Verify the Build

After rebuilding:

```python
import pianoidCuda

# Check if methods exist
methods = ['startProfiling', 'stopProfiling', 'resetProfiling',
           'writeProfilingData', 'getGpuProfilingData', 'getCpuProfilingData']

for method in methods:
    if not hasattr(pianoidCuda.Pianoid, method):
        print(f"❌ Missing: {method}")
    else:
        print(f"✓ Found: {method}")
```

### Restart Required

After rebuilding, **restart any running Python processes** (Flask server, Jupyter kernel, etc.) to load the new module.

---

## Legacy CSV Output

### What is Legacy CSV Output?

The original profiling implementation automatically wrote CSV files on every run:
- `cpu_cycle_timing.csv` - CPU timing data
- `gpu_cycle_timing.csv` - GPU timing data

This is now **disabled by default** in favor of the controlled profiling system.

### Re-enable Legacy CSV (If Needed)

Edit [Pianoid.cu:25](pianoid_cuda/Pianoid.cu#L25):
```cpp
#define PIANOID_LEGACY_CSV_OUTPUT 1  // Re-enable legacy CSV output
```

Rebuild:
```bash
cd pianoid_cuda
pip install -e . --force-reinstall --no-deps
```

Now both systems will run:
- New controlled profiling (start/stop via Python)
- Legacy automatic CSVs

### Why Disable Legacy CSV?

**Problems with legacy system:**
- ✗ No control over when data is recorded
- ✗ Files always created (clutter working directory)
- ✗ Can't choose custom file paths
- ✗ Data written immediately (I/O overhead every cycle)

**Benefits of new system:**
- ✓ Full control over recording (start/stop/reset)
- ✓ Custom file paths
- ✓ Data buffered in memory (no I/O overhead during recording)
- ✓ Programmatic access to data

---

## Best Practices

### ✓ Do

1. **Use chart functions for simplicity:**
   ```python
   profiling_action(pianoid, action='start')
   # ... run test ...
   charts, _, _ = profiling_data_function(pianoid)  # Auto-stops
   ```

2. **Use descriptive file names:**
   ```python
   profiling_action(pianoid, action='stop',
                    cpu_file='experiment1_filter_18k_cpu.csv',
                    gpu_file='experiment1_filter_18k_gpu.csv')
   ```

3. **Reset between tests:**
   ```python
   profiling_action(pianoid, action='start')  # Automatically resets
   ```

4. **Check budget in visualization:**
   ```python
   charts, header, fields = profiling_data_function(pianoid, budget_ms=1.0)
   print(fields['Performance Status'])
   ```

### ✗ Don't

1. **Don't forget to start profiling:**
   ```python
   # ❌ Wrong
   pianoid.runMainApplication(5000, True)
   charts = profiling_data_function(pianoid)  # No data!

   # ✓ Correct
   profiling_action(pianoid, action='start')
   pianoid.runMainApplication(5000, True)
   charts = profiling_data_function(pianoid)
   ```

2. **Don't write to same file multiple times:**
   ```python
   # ❌ Wrong - overwrites previous data
   profiling_action(pianoid, action='stop', gpu_file='results.csv')  # Test 1
   profiling_action(pianoid, action='stop', gpu_file='results.csv')  # Test 2 - overwrites!

   # ✓ Correct - use different filenames
   profiling_action(pianoid, action='stop', gpu_file='test1_results.csv')
   profiling_action(pianoid, action='stop', gpu_file='test2_results.csv')
   ```

---

## Files Modified

### Python Files
- **[pianoid_middleware/chartFunctions.py](pianoid_middleware/chartFunctions.py)**
  - `profiling_action()` - Control function
  - `profiling_data_function()` - Visualization function

### C++ Files
- **[pianoid_cuda/Profiler.h](pianoid_cuda/Profiler.h)** - Data structures
  - `GpuTimings`, `CpuCycleData`, `GpuCycleData`, `ProfilingBuffer`

- **[pianoid_cuda/Pianoid.cuh](pianoid_cuda/Pianoid.cuh)** - Method declarations
  - Profiling control methods

- **[pianoid_cuda/Pianoid.cu](pianoid_cuda/Pianoid.cu)** - Implementation
  - Profiling control methods
  - CUDA event timing
  - ProfilingBuffer integration

- **[pianoid_cuda/AddArraysWithCUDA.cpp](pianoid_cuda/AddArraysWithCUDA.cpp)** - Python bindings
  - Exposed all profiling methods to Python

---

## Related Documentation

- [COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md](pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md) - System architecture
- [FIR_FILTER_UPDATE_SUMMARY.md](FIR_FILTER_UPDATE_SUMMARY.md) - Filter implementation
- [COOPERATIVE_KERNEL_LIMITS.md](COOPERATIVE_KERNEL_LIMITS.md) - Grid sizing optimization

---

## Version History

### Current Version
- Full profiling control via Python
- Filter timing measurement
- Legacy CSV output disabled by default
- Chart visualization functions
- Thread-safe profiling buffer

### Previous Version (Legacy)
- Automatic CSV file creation
- No control over recording
- Limited to CSV output only

---

## Summary

The Pianoid profiling system provides comprehensive performance measurement with full user control. Use `profiling_action()` to start/stop recording and `profiling_data_function()` to visualize results. All timing data (parameter, gauss, synthesis, and filter kernels) is accurately measured and can be analyzed to identify performance bottlenecks and ensure real-time audio processing requirements are met.

For questions or issues, refer to the [Troubleshooting](#troubleshooting) section or check the implementation files directly.
