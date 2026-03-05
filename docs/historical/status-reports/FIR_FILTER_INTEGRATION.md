# FIR Filter Integration - Complete Documentation

## Overview
This document describes the integration of the refactored FIR filter kernel (`convolutionKernel`) into the Pianoid real-time audio synthesis system.

## Table of Contents
1. [Architecture](#architecture)
2. [Implementation Changes](#implementation-changes)
3. [Issues Fixed](#issues-fixed)
4. [Data Flow](#data-flow)
5. [API Reference](#api-reference)

---

## Architecture

### Kernel Signature
**File**: `FIRFilter.cu:37-46`

```cuda
__global__ void convolutionKernel(
    float* __restrict__ input_buffers,      // Ring buffer for all input channels
    const float* __restrict__ input_samples, // Current frame samples (48 samples/cycle)
    const float* __restrict__ filters,       // One filter per mapping (flipped)
    float* __restrict__ output,              // Intermediate output buffer
    float* __restrict__ partials,            // For warp shuffle reduction
    float* __restrict__ filter_sums,         // Filter normalization sums
    Sint16* __restrict__ int16output,        // Sint16 output (legacy)
    float* __restrict__ floatOutput,         // Float output (primary)
    int* __restrict__ cycle_parameters,      // 8-element parameter array
    const real* __restrict__ main_volume_coeff) // Volume coefficient
```

### Cycle Parameters Structure
**8-element array** passed to kernel:

| Index | Name | Description | Source |
|-------|------|-------------|--------|
| 0 | sampleRate | Sample rate in kHz (e.g., 48) | `cp_.sample_rate` |
| 1 | filterSize | Filter length in samples | `switch_filter()` parameter |
| 2 | cycle_index | Ring buffer position (updated by kernel) | Initialized to 0 |
| 3 | dest_index | Destination write index (updated by kernel) | Initialized to -1 |
| 4 | inputChannelsNo | Number of input channels | `cp_.num_channels` (12) |
| 5 | outputChannelsNo | Number of output channels | 2 (stereo) |
| 6 | debugOutputChannel | Debug mapping ID | 0 |
| 7 | samplesPerCycle | Samples processed per cycle | `cp_.mode_iteration` (48) |

### Grid Configuration
- **gridDim.x**: `inputChannelsNo × outputChannelsNo` = 24 mappings
- **gridDim.y**: Calculated dynamically: `(cp_.num_strings / cp_.num_strings_in_array) / gridDim.x`
  - Limited to ≤ 4 to respect cooperative kernel block limits
- **blockDim.x**: 128 threads

---

## Implementation Changes

### 1. Pianoid.cu - switch_filter()
**Lines**: 716-747

**Changes**:
- Expanded `cycle_parameters` from 4 to 8 elements
- Added ring buffer clearing to prevent artifacts

```cpp
void Pianoid::switch_filter(int sampleRate, int filterSize, bool on) {
    FIRfilterON = on;
    if (on) {
        // Initialize 8-element cycle parameters
        std::vector<int> filter_cycle_parameters(8);
        filter_cycle_parameters.at(0) = sampleRate;
        filter_cycle_parameters.at(1) = filterSize;
        filter_cycle_parameters.at(2) = 0;   // cycle_index
        filter_cycle_parameters.at(3) = -1;  // dest_index
        filter_cycle_parameters.at(4) = numChannels;      // inputChannelsNo
        filter_cycle_parameters.at(5) = 2;                // outputChannelsNo (stereo)
        filter_cycle_parameters.at(6) = 0;                // debugOutputChannel
        filter_cycle_parameters.at(7) = samplesInCycle;   // samplesPerCycle
        loadIntParameterToPianoid("dev_filter_cycle_params", filter_cycle_parameters);

        // Clear ring buffers to prevent garbage/rattling artifacts
        const int inputChannelsNo = numChannels;
        const int inputSegmentSize = filterSize + samplesInCycle;
        float* inputBuffers = getFloatPointer("dev_filter_input_buffers");
        if (inputBuffers) {
            cudaMemset(inputBuffers, 0,
                inputChannelsNo * (inputSegmentSize * 2) * sizeof(float));
        }
    }
}
```

### 2. Pianoid.cuh - New Buffer Pointers
**Lines**: 86-90

Added 5 new device buffer pointers:

```cpp
float* dev_filter_input_buffers;  // Ring buffers (12 channels × 2 × (filterSize + 48))
float* dev_filter_input_samples;  // Current frame (12 channels × 48 samples)
float* dev_filter_output;         // Intermediate output (24 mappings × 48 samples)
float* dev_filter_partials;       // Partial sums for reduction
float* dev_filter_sums;           // Filter normalization sums
```

### 3. Pianoid.cu - devMemoryInit()
**Lines**: 562-592

Allocated GPU memory for new buffers:

```cpp
const int inputChannelsNo = cp_.num_channels;  // 12
const int outputChannelsNo = 2;                // Stereo
const int numMappings = inputChannelsNo * outputChannelsNo;  // 24

// Ring buffers for input history
handlers.emplace_back("dev_filter_input_buffers", nullptr,
    inputChannelsNo * (cp_.fir_filter_length + cp_.mode_iteration) * 2,
    inputChannelsNo * (cp_.fir_filter_length + cp_.mode_iteration) * 2,
    sizeof(float), false, (void**)&dev_filter_input_buffers);

// Current frame input samples
handlers.emplace_back("dev_filter_input_samples", nullptr,
    inputChannelsNo * cp_.mode_iteration,
    inputChannelsNo * cp_.mode_iteration,
    sizeof(float), false, (void**)&dev_filter_input_samples);

// Intermediate filter output
handlers.emplace_back("dev_filter_output", nullptr,
    numMappings * cp_.mode_iteration,
    numMappings * cp_.mode_iteration,
    sizeof(float), false, (void**)&dev_filter_output);

// Partial sums buffer
handlers.emplace_back("dev_filter_partials", nullptr,
    numMappings * cp_.mode_iteration * 32,  // 32 = WARP_SIZE
    numMappings * cp_.mode_iteration * 32,
    sizeof(float), false, (void**)&dev_filter_partials);

// Filter sums buffer
handlers.emplace_back("dev_filter_sums", nullptr,
    numMappings * cp_.mode_iteration,
    numMappings * cp_.mode_iteration,
    sizeof(float), false, (void**)&dev_filter_sums);
```

### 4. Pianoid.cu - initParameters()
**Lines**: 772-780

Updated kernel arguments to match new 10-parameter signature:

```cpp
filterKernelArgs.push_back(getFloatHandler("dev_filter_input_buffers"));  // 0
filterKernelArgs.push_back(getFloatHandler("dev_filter_input_samples"));  // 1
filterKernelArgs.push_back(getFloatHandler("dev_fir_filters"));           // 2
filterKernelArgs.push_back(getFloatHandler("dev_filter_output"));         // 3
filterKernelArgs.push_back(getFloatHandler("dev_filter_partials"));       // 4
filterKernelArgs.push_back(getFloatHandler("dev_filter_sums"));           // 5
filterKernelArgs.push_back(getSint32Handler("dev_filteredSound"));        // 6
filterKernelArgs.push_back(getFloatHandler("dev_filteredSoundFloat"));    // 7
filterKernelArgs.push_back(getIntHandler("dev_filter_cycle_params"));     // 8
filterKernelArgs.push_back(getRealHandler("dev_main_volume_coeff"));      // 9
```

### 5. Pianoid.cu - playSoundSamples()
**Lines**: 1812-1950

Updated filter kernel launch and buffer management:

```cpp
// Copy input samples to filter input buffer
cudaMemcpy(filterInputSamples, soundFloat,
    samplesInCycle * numChannels * sizeof(float),
    cudaMemcpyDeviceToDevice);

// Calculate grid dimensions respecting cooperative launch limits
const int maxTotalBlocks = cp_.num_strings / cp_.num_strings_in_array;
int gridDim_Y = maxTotalBlocks / numMappings;
if (gridDim_Y > 4) gridDim_Y = 4;

// Clear output and partials buffers EVERY cycle (critical!)
cudaMemset(dev_filteredSoundFloat, 0, samplesInCycle * outputChannelsNo * sizeof(float));
cudaMemset(filterOutput, 0, numMappings * samplesInCycle * sizeof(float));

const int totalSegments = outputChannelsNo * samplesInCycle;
const int totalBlocks = numMappings * gridDim_Y;
const int segmentsPerBlock = (totalSegments + totalBlocks - 1) / totalBlocks;
const int paddedSegments = segmentsPerBlock * totalBlocks;
cudaMemset(filterPartials, 0, paddedSegments * WARP_SIZE * sizeof(float));

// Launch cooperative kernel
dim3 blocksPerGrid(numMappings, gridDim_Y);
dim3 threadsPerBlock(128);
cudaLaunchCooperativeKernel((void*)convolutionKernel, blocksPerGrid, threadsPerBlock, filterKernelArgs.data());

// Convert float to int32 for audio driver
const int totalOutputSamples = outputChannelsNo * samplesInCycle;
floatToAudioSampleKernel<<<blocksPerGrid_conv, threadsPerBlock_conv>>>(
    dev_filteredSoundFloat, getSint32Pointer("dev_filteredSound"), totalOutputSamples);
```

### 6. Audio Type System
**Files**: `audio_types.h`, `Kernels.cuh`, `Kernels.cu`

Created universal driver-agnostic audio sample type:

```cpp
// audio_types.h
#pragma once
#include <cstdint>
using AudioSample = int32_t;  // Universal type for all drivers
using Sint32 = int32_t;       // Legacy SDL compatibility

// Kernels.cu - Float to AudioSample conversion
__global__ void floatToAudioSampleKernel(
    const float* __restrict__ floatInput,
    AudioSample* __restrict__ audioOutput,
    int numSamples)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx < numSamples) {
        audioOutput[idx] = static_cast<AudioSample>(floatInput[idx]);
    }
}
```

### 7. Filter Loading - pianoid.py
**Lines**: 642-771

Moved filter loading logic from `chartFunctions.py` to `pianoid.py`:

```python
def loadFirFilterFromFile(self, filename: str) -> dict:
    """
    Load FIR filter from file with full validation and path searching.

    Key steps:
    1. Search for filter file in multiple locations
    2. Validate filter size against allocated memory
    3. Flip filters for convolution (time-reversal)
    4. Load into CUDA memory
    """
    # Search paths
    search_paths = [
        Path("presets/filters") / filename,
        Path("presets") / filename,
        Path("pianoid_middleware/presets/filters") / filename,
        Path("pianoid_middleware/presets") / filename,
        Path(filename)
    ]

    # Validate size constraints
    MIN_TOTAL_COEFFS = 4096
    MAX_TOTAL_COEFFS = 524288
    MAX_FIR_FILTERS = 24

    # Flip filters for convolution (CRITICAL!)
    filters_flipped = filters[:, ::-1]
    filters_flat = filters_flipped.ravel().tolist()

    # Load to CUDA
    self.pianoid.set_filter(filter_length, num_filters, filters_flat)
```

### 8. chartFunctions.py - Thin Wrapper
**Lines**: 527-549

Simplified `filter_action` to delegate to pianoid class:

```python
def filter_action(pianoid, **kwargs):
    """Thin wrapper for FIR filter control from front end."""
    toggle_on = kwargs.get('toggle')
    filename = kwargs.get('file')

    if filename:
        pianoid.loadFirFilterFromFile(filename)

    pianoid.switchFirFilter(toggle_on)
```

---

## Issues Fixed

### Issue 1: Compilation Error - Undefined Sint32
**Error**: `identifier 'Sint32' is undefined` in Kernels.cu

**Root Cause**: Sint32 was SDL-specific, not available in CUDA kernels with ASIO driver

**Fix**: Created `audio_types.h` with universal `AudioSample` type (int32_t)

---

### Issue 2: Cooperative Kernel Launch Failure
**Error**: `too many blocks in cooperative launch` - Grid (8, 24) = 192 blocks exceeded limit

**Root Cause**: Hardcoded `gridDim.y = 24` without checking GPU block capacity

**Fix**: Dynamic grid sizing: `gridDim_Y = (cp_.num_strings / cp_.num_strings_in_array) / numMappings`

**Documentation**: Created `COOPERATIVE_KERNEL_LIMITS.md`

---

### Issue 3: Audio Distortion - Filters Not Flipped
**Symptom**: Online audio heavily distorted, test procedure audio clean

**Root Cause**: Filters not time-reversed in online implementation

**Comparison**:
- **Test** (`FirFilterTest.py:141`): `F_flipped = F[:, ::-1]`
- **Online** (`chartFunctions.py:611`): `filters_flat = filters.ravel()` ❌

**Fix**: Added filter flipping in `pianoid.py:727`: `filters_flipped = filters[:, ::-1]`

**Why Critical**: FIR convolution requires time-reversed filter coefficients. Without flipping, the filter operates in reverse temporal order, causing severe distortion.

---

### Issue 4: Rattling at Note Start
**Symptom**: Clean audio after fix #3, but rattling/artifacts at beginning of notes

**Root Cause**: Ring buffers (`dev_filter_input_buffers`) contained uninitialized garbage data

**Comparison**:
- **Test** (`FIRFilter.cu:414`): `cudaMemset(d_input_buffers, 0, ...)` before first cycle
- **Online**: Ring buffers allocated with `nullptr`, never cleared ❌

**Fix**: Added ring buffer clearing in `switch_filter()` at line 736

---

### Issue 5: Output Buffer Accumulation
**Symptom**: Additional noise even after fixing filters

**Root Cause**: Output buffers not cleared between cycles, causing accumulation

**Fix**: Added per-cycle buffer clearing in `playSoundSamples()`:
- `dev_filteredSoundFloat` (line 1860)
- `dev_filter_output` (line 1868)
- `dev_filter_partials` (line 1889)

---

## Data Flow

### Input Path
1. **String synthesis** → `dev_soundFloat` (12 channels × 48 samples/cycle, interleaved)
2. **Copy to filter input** → `dev_filter_input_samples` (device-to-device memcpy)
3. **Ring buffer update** → `dev_filter_input_buffers` (managed by kernel)

### Filter Processing
1. **Kernel reads**: Ring buffers + current samples
2. **Convolution**: Each of 24 blocks processes one mapping (input_ch → output_ch)
3. **Output format**: Planar stereo `[L0...L47, R0...R47]`

### Output Path
1. **Kernel writes** → `dev_filteredSoundFloat` (96 samples: 2 channels × 48)
2. **Type conversion** → `floatToAudioSampleKernel` → `dev_filteredSound` (Sint32)
3. **Audio driver** → Reads `dev_filteredSound` for playback

### Filter Data Layout
- **Storage**: Concatenated by mapping `[map0_filter, map1_filter, ..., map23_filter]`
- **Each filter**: Time-reversed coefficients (flipped during load)
- **Size**: `numMappings × filterSize` floats

---

## API Reference

### C++ API (Pianoid class)

#### `void switch_filter(int sampleRate, int filterSize, bool on)`
Enable/disable FIR filter and initialize parameters.

**Parameters**:
- `sampleRate`: Sample rate in kHz (e.g., 48)
- `filterSize`: Filter length in samples
- `on`: true to enable, false to disable

**Side Effects**:
- Uploads cycle_parameters to GPU
- Clears ring buffers when enabled

---

#### `void set_filter(int filterSize, int numberOfFilters, std::vector<float> filter)`
Load filter coefficients to GPU memory.

**Parameters**:
- `filterSize`: Length of each filter
- `numberOfFilters`: Total number of filters (typically 24 for 12×2)
- `filter`: Flattened filter coefficients (already flipped)

**Preconditions**:
- Filters must be time-reversed (flipped) before calling
- Total size must not exceed allocated capacity

---

### Python API (pianoidHandler class)

#### `loadFirFilterFromFile(filename: str) -> dict`
Load FIR filter from file with full validation.

**Parameters**:
- `filename`: Filter file name or path

**Returns**: Dictionary with filter metadata

**Raises**:
- `FileNotFoundError`: If filter file not found
- `ValueError`: If filter size exceeds allocated memory

**Searches**: Multiple paths in priority order

---

#### `switchFirFilter(on: bool = True)`
Enable or disable FIR filter processing.

**Parameters**:
- `on`: True to enable, False to disable

**Raises**:
- `ValueError`: If enabling with no filter loaded

---

#### `setFirFilter(filterlen: int, filternumber: int, filters: list)`
Low-level API to set filter coefficients directly.

**Note**: For loading from file, use `loadFirFilterFromFile()` instead.

---

## Performance Characteristics

### Latency Budget
- **Cycle time**: 1ms @ 48kHz
- **Samples per cycle**: 48
- **Target filter latency**: < 0.5ms to allow headroom for synthesis

### Memory Usage
- **Ring buffers**: 12 channels × 2 × (filterSize + 48) × 4 bytes
- **Filters**: 24 mappings × filterSize × 4 bytes
- **Partials**: 24 × 48 × 32 × 4 bytes = ~147 KB (per cycle)

### Profiling
GPU timing measured via CUDA events:
- `g_lastGpuTimings.filter_ms` - Filter kernel execution time
- Output to `pianoid_gpu_timings.csv`

---

## Testing

### Test Procedure Reference
**File**: `FirFilterTest.py`, `runConvolutionKernel`

The test procedure validates:
1. Filter flipping correctness
2. Ring buffer management
3. Multi-cycle streaming
4. Output format consistency

**Key difference from online**: Test procedure processes pre-recorded data in batch, while online processes real-time streaming audio.

---

## File Summary

### Modified Files
- `pianoid_cuda/Pianoid.cu` - Main integration
- `pianoid_cuda/Pianoid.cuh` - Buffer declarations
- `pianoid_cuda/Kernels.cuh` - Conversion kernel declaration
- `pianoid_cuda/Kernels.cu` - Conversion kernel implementation
- `pianoid_cuda/audio_types.h` - Universal audio types (NEW)
- `pianoid_middleware/pianoid.py` - Filter loading logic moved here
- `pianoid_middleware/chartFunctions.py` - Simplified to thin wrapper

### Reference Files (Unmodified)
- `pianoid_cuda/FIRFilter.cu` - Kernel implementation
- `pianoid_middleware/FirFilterTest.py` - Test procedure
- `pianoid_middleware/FirFilterFileIO.py` - File I/O utilities

---

## Critical Lessons Learned

1. **Filter flipping is mandatory** for correct FIR convolution - without it, the filter operates backward in time
2. **Ring buffer initialization** must be explicit - uninitialized memory causes audible artifacts
3. **Per-cycle buffer clearing** is essential for cooperative kernels to prevent accumulation
4. **Test vs. online differences** must be carefully analyzed - what works in test may fail online if buffer management differs
5. **Grid sizing for cooperative kernels** must respect hardware limits - calculate dynamically, never hardcode

---

*Document created: 2025*
*Last updated: After successful integration and artifact fixes*
