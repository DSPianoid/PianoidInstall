# Excitation Flow Refactoring Plan

**Document Version:** 1.0
**Date:** 2025-10-13
**Purpose:** Optimize excitation parameter handling by moving velocity-dependent selection to GPU
**Status:** Design Phase - To be completed BEFORE main parameter refactoring
**Priority:** HIGH - Prerequisite for unified parameter block

---

## Executive Summary

### Current Problem

The excitation parameter system uses a **host-side selection + GPU copy** pattern that is inefficient and inconsistent:

1. **655,360 parameters** stored only on host (`gauss_params` vector)
2. When note is played, **host selects 20 velocity-specific parameters** and copies to GPU
3. `dev_gauss_parameters` is a **staging buffer** (not full parameter storage)
4. Each note trigger requires **host → GPU memory copy** (20 reals, ~160 bytes)
5. `setNewExcitationParameters()` only updates host, GPU storage doesn't exist

### Refactoring Goal

Move to a **GPU-resident parameter storage + pointer-based selection** pattern:

1. **Full parameter set stored on GPU** in new buffer `dev_gauss_params_full`
2. **Host provides offsets/pointers** to kernel instead of copying data
3. **Kernel reads directly** from full parameter array based on velocity
4. `setNewExcitationParameters()` **updates GPU storage** immediately
5. **Eliminate per-note memory copies** - just pass indices

### Benefits

✓ **Consistent with other parameters** - GPU holds full parameter set
✓ **Eliminates per-note cudaMemcpy** - ~100-500x faster note triggering
✓ **Enables unified parameter block** - prerequisite for preset switching
✓ **Simplified API** - setNewExcitationParameters() works like other setters
✓ **Better for polyphonic playback** - no bandwidth bottleneck

---

## Current Implementation Analysis

### Memory Layout

**Host Side:**
```cpp
std::vector<real> gauss_params;  // Size: 655,360 reals (~5 MB)
// Layout: [string0][vel0-127×20_params][string1][vel0-127×20_params]...
```

**GPU Side:**
```cpp
real* dev_gauss_parameters;  // Size: LEN_LEVEL_GP × NO_EXCITATION_LEVELS × NUM_STRINGS
                             // But typically only holds 20-100 params (current notes)
                             // Allocated for full size but used as staging buffer
```

### Data Structure Details

**Per String:** 2,560 parameters
- 128 velocity levels (0-127)
- 20 parameters per level:
  - 5 Gaussian mu (center) values
  - 5 Gaussian sigma (width) values
  - 5 Gaussian volume (amplitude) values
  - 5 Gaussian shift (offset) values

**Index Calculation:**
```cpp
// Get parameters for specific string and velocity
int offset = LEN_LEVEL_GP * (stringNo * NO_EXCITATION_LEVELS + velocity);
const real* params = &gauss_params[offset];
// params[0..4] = mu values
// params[5..9] = sigma values
// params[10..14] = volume values
// params[15..19] = shift values
```

### Current Flow (Detailed)

**File: [Pianoid.cu:935-937](pianoid_cuda/Pianoid.cu#L935)**
```cpp
void Pianoid::setNewExcitationParameters(const std::vector<real>& new_gauss_params) {
    gauss_params = new_gauss_params;  // Host-only update
}
```

**File: [Pianoid.cu:1268-1281](pianoid_cuda/Pianoid.cu#L1268) - MIDI Processing**
```cpp
// For each note in MIDI event:
for (auto stringNo : noStrings) {
    _add_string_for_playback(stringNo, velocity, timing);
}
if (noStrings_in_GP > 0) {
    _load_exct_params_to_GPU();  // Batch copy to GPU
}
```

**File: [Pianoid.cu:1290-1301](pianoid_cuda/Pianoid.cu#L1290)**
```cpp
void Pianoid::_add_string_for_playback(int stringNo, int velocity, int timing) {
    if (velocity > 0) {
        _append_string_gp(stringNo, velocity, timing);  // Select params
    }
    dec_open[stringNo] = dumper;
}
```

**File: [Pianoid.cu:1371-1382](pianoid_cuda/Pianoid.cu#L1371)**
```cpp
void Pianoid::_append_string_gp(int noString, int velocity, int timing) {
    // Store string metadata
    string_excitation_params[noStrings_in_GP * 3] = noString;
    string_excitation_params[noStrings_in_GP * 3 + 1] = volume;
    string_excitation_params[noStrings_in_GP * 3 + 2] = timing;

    // HOST-SIDE SELECTION: Copy 20 velocity-specific params
    const real* src_ptr = &gauss_params[LEN_LEVEL_GP * (noString * NO_EXCITATION_LEVELS + velocity)];
    real* dest_ptr = &string_gauss_params[noStrings_in_GP * LEN_LEVEL_GP];
    std::copy(src_ptr, src_ptr + LEN_LEVEL_GP, dest_ptr);

    noStrings_in_GP++;
}
```

**File: [Pianoid.cu:1385-1429](pianoid_cuda/Pianoid.cu#L1385)**
```cpp
void Pianoid::_load_exct_params_to_GPU() {
    if (noStrings_in_GP > 0) {
        // COPY SELECTED PARAMS TO GPU (20 params × N strings)
        cudaMemcpy(getRealPointer("dev_gauss_parameters"),
                   string_gauss_params.data(),
                   noStrings_in_GP * LEN_LEVEL_GP * sizeof(real),
                   cudaMemcpyHostToDevice);
    }
}
```

**File: [gaussTest.cu:20-94](pianoid_cuda/gaussTest.cu#L20) - Kernel**
```cpp
__global__ void gaussKernel(int* string_excitation_params,
                           real* force_function,
                           real* gauss_params,  // ← Staging buffer with selected params
                           int* exct_cycle_index,
                           int* cycle_parameters,
                           real* volume_coeff) {

    int blockind = blockIdx.x;  // String index in batch

    // Read 20 parameters for this string from staging buffer
    for (int i = 0; i < NUM_GAUSS; i++) {
        mu[i] = gauss_params[blockind * LEN_LEVEL_GP + i];
        sigma[i] = gauss_params[blockind * LEN_LEVEL_GP + NUM_GAUSS + i];
        g_vol[i] = gauss_params[blockind * LEN_LEVEL_GP + NUM_GAUSS * 2 + i];
        g_shift[i] = gauss_params[blockind * LEN_LEVEL_GP + NUM_GAUSS * 3 + i];
    }

    // Compute excitation curve using 5 Gaussians
    // ...
}
```

### Performance Analysis

**Per-note overhead (current system):**
1. Host-side parameter selection: ~50-100 CPU cycles
2. Vector copy to staging buffer: ~100-200 CPU cycles
3. cudaMemcpy (20 reals): ~5-10 μs (including overhead)
4. Kernel launch: ~5-10 μs

**For polyphonic chord (10 notes simultaneously):**
- 10 × 20 = 200 reals copied = ~1.6 KB transfer
- Total overhead: ~50-100 μs

**Theoretical improvement:**
- GPU-resident parameters: No copy needed
- Only pass integer offsets: ~10 bytes per note
- Estimated speedup: **100-500x** for note triggering overhead

---

## Proposed Architecture

### New Memory Layout

**Host Side (unchanged):**
```cpp
std::vector<real> gauss_params;  // Still maintain for initialization/updates
// Size: 655,360 reals (~5 MB for double, ~2.6 MB for float)
```

**GPU Side (NEW):**
```cpp
// NEW: Full parameter storage (persistent)
real* dev_gauss_params_full;
// Size: NUM_STRINGS × NO_EXCITATION_LEVELS × LEN_LEVEL_GP
//     = 256 × 128 × 20 = 655,360 reals (~5 MB)
// Layout: [string0][vel0-127×20][string1][vel0-127×20]...

// DEPRECATED: Remove staging buffer (or repurpose for other use)
// real* dev_gauss_parameters;
```

**GPU Side (Metadata for note triggering):**
```cpp
// Array of indices pointing into dev_gauss_params_full
int* dev_gauss_param_indices;
// Size: MAX_STRINGS_PER_EVENT integers
// Each element = offset into dev_gauss_params_full for velocity-specific params
```

### Index Calculation

**Offset for string S, velocity V:**
```cpp
int offset = (stringNo * NO_EXCITATION_LEVELS + velocity) * LEN_LEVEL_GP;
// Result: index into dev_gauss_params_full where 20 params start
```

**Example:**
- String 60, velocity 64: `offset = (60 × 128 + 64) × 20 = 154,880`
- Kernel reads: `dev_gauss_params_full[154880..154899]`

---

## Implementation Plan

### Phase 1: Add Full GPU Storage

**Duration:** 1-2 days

#### 1.1 Add New GPU Buffer

**File:** `Pianoid.cuh` (class definition)

```cpp
class Pianoid {
private:
    // NEW: Full excitation parameter storage on GPU
    real* dev_gauss_params_full;  // 655,360 reals

    // DEPRECATED (to be removed in Phase 3)
    real* dev_gauss_parameters;  // Keep for backward compatibility during transition

    // NEW: Indices for kernel to lookup parameters
    int* dev_gauss_param_indices;  // MAX_STRINGS_PER_EVENT ints

    // ... existing members
};
```

#### 1.2 Allocate GPU Memory

**File:** `Pianoid.cu` - `devMemoryInit()` function (around line 714)

```cpp
void Pianoid::devMemoryInit(...) {
    // ... existing allocations ...

    // NEW: Allocate full parameter storage
    handlers.emplace_back("dev_gauss_params_full",
        gauss_params.data(),  // Initialize with full parameter set
        NUM_STRINGS * NO_EXCITATION_LEVELS * LEN_LEVEL_GP,
        NUM_STRINGS * NO_EXCITATION_LEVELS * LEN_LEVEL_GP,
        sizeof(real), true, (void**)&dev_gauss_params_full);

    // NEW: Allocate index buffer for note triggering
    handlers.emplace_back("dev_gauss_param_indices",
        nullptr,
        MAX_STRINGS_PER_EVENT,
        MAX_STRINGS_PER_EVENT,
        sizeof(int), true, (void**)&dev_gauss_param_indices);

    // KEEP (for now): Old staging buffer for backward compatibility
    handlers.emplace_back("dev_gauss_parameters",
        nullptr,
        LEN_LEVEL_GP * NO_EXCITATION_LEVELS * cp_.num_strings,
        LEN_LEVEL_GP * NO_EXCITATION_LEVELS * cp_.num_strings,
        sizeof(real), false, (void**)&dev_gauss_parameters);

    // ... rest of initialization ...
}
```

#### 1.3 Update setNewExcitationParameters()

**File:** `Pianoid.cu` lines 935-937

```cpp
void Pianoid::setNewExcitationParameters(const std::vector<real>& new_gauss_params) {
    // Validate size
    if (new_gauss_params.size() != gauss_params.size()) {
        printf("ERROR: Invalid excitation parameter size. Expected %zu, got %zu\n",
               gauss_params.size(), new_gauss_params.size());
        return;
    }

    // Update host-side copy (still needed for potential host operations)
    gauss_params = new_gauss_params;

    // NEW: Update GPU full storage
    cudaError_t status = cudaMemcpy(
        dev_gauss_params_full,
        gauss_params.data(),
        gauss_params.size() * sizeof(real),
        cudaMemcpyHostToDevice);

    if (status != cudaSuccess) {
        printf("ERROR: Failed to update excitation parameters on GPU: %s\n",
               cudaGetErrorString(status));
    } else {
        printf("Excitation parameters updated on GPU (%zu reals, %.2f MB)\n",
               gauss_params.size(),
               (gauss_params.size() * sizeof(real)) / (1024.0 * 1024.0));
    }

    // NOTE: dev_gauss_parameters (staging buffer) remains unchanged
    // It will be populated during note triggering
}
```

**Verification:**
- Test updating excitation parameters
- Verify GPU memory usage increased by ~5 MB
- Check that updates don't cause memory errors

---

### Phase 2: Modify Note Triggering (Index-Based)

**Duration:** 2-3 days

#### 2.1 Host-Side Changes

**File:** `Pianoid.cu` - Modify `_append_string_gp()`

**Current implementation (lines 1371-1382):**
```cpp
void Pianoid::_append_string_gp(int noString, int velocity, int timing) {
    real volume = volume_coeff.at(noString);
    string_excitation_params[noStrings_in_GP * 3] = noString;
    string_excitation_params[noStrings_in_GP * 3 + 1] = volume;
    string_excitation_params[noStrings_in_GP * 3 + 2] = timing;

    // OLD: Copy 20 parameters from host
    const real* src_ptr = &gauss_params[LEN_LEVEL_GP * (noString * NO_EXCITATION_LEVELS + velocity)];
    real* dest_ptr = &string_gauss_params[noStrings_in_GP * LEN_LEVEL_GP];
    std::copy(src_ptr, src_ptr + LEN_LEVEL_GP, dest_ptr);

    noStrings_in_GP++;
}
```

**NEW implementation:**
```cpp
void Pianoid::_append_string_gp(int noString, int velocity, int timing) {
    real volume = volume_coeff.at(noString);

    // Store string metadata (unchanged)
    string_excitation_params[noStrings_in_GP * 3] = noString;
    string_excitation_params[noStrings_in_GP * 3 + 1] = volume;
    string_excitation_params[noStrings_in_GP * 3 + 2] = timing;

    // NEW: Calculate offset into dev_gauss_params_full
    // Instead of copying data, just store the offset
    int param_offset = (noString * NO_EXCITATION_LEVELS + velocity) * LEN_LEVEL_GP;
    string_gauss_param_indices[noStrings_in_GP] = param_offset;

    noStrings_in_GP++;
}
```

**Add new member variable:**
```cpp
// In Pianoid class (Pianoid.cuh)
std::vector<int> string_gauss_param_indices;  // Host-side buffer for indices

// In constructor:
string_gauss_param_indices(MAX_STRINGS_PER_EVENT),
```

#### 2.2 Update GPU Transfer Function

**File:** `Pianoid.cu` - Modify `_load_exct_params_to_GPU()`

**Current implementation (lines 1385-1429):**
```cpp
void Pianoid::_load_exct_params_to_GPU() {
    cudaError_t cudaStatus;
    if (noStrings_in_GP > 0) {
        // OLD: Copy selected parameters
        cudaStatus = cudaMemcpy(getRealPointer("dev_gauss_parameters"),
                               string_gauss_params.data(),
                               noStrings_in_GP * LEN_LEVEL_GP * sizeof(real),
                               cudaMemcpyHostToDevice);
        // ... error checking ...
    }
}
```

**NEW implementation:**
```cpp
void Pianoid::_load_exct_params_to_GPU() {
    cudaError_t cudaStatus;
    if (noStrings_in_GP > 0) {
        // NEW: Copy parameter indices (much smaller!)
        // Transfer: noStrings_in_GP × 4 bytes (instead of noStrings_in_GP × 20 × 8 bytes)
        cudaStatus = cudaMemcpy(dev_gauss_param_indices,
                               string_gauss_param_indices.data(),
                               noStrings_in_GP * sizeof(int),
                               cudaMemcpyHostToDevice);

        if (cudaStatus != cudaSuccess) {
            printf("ERROR: Failed to copy gauss param indices: %s\n",
                   cudaGetErrorString(cudaStatus));
            throw std::runtime_error("cudaMemcpy for gauss_param_indices failed");
        }

        // OLD buffer copy REMOVED - no longer needed!
        // Parameters already on GPU in dev_gauss_params_full
    }
}
```

**Bandwidth savings:**
- **Old:** `noStrings_in_GP × 20 reals × 8 bytes = 160N bytes`
- **New:** `noStrings_in_GP × 1 int × 4 bytes = 4N bytes`
- **Improvement:** 40x reduction in transfer size!

#### 2.3 Modify Kernel to Use Full Storage

**File:** `gaussTest.cu` - Update `gaussKernel()`

**Current signature (line 21):**
```cpp
__global__ void gaussKernel(int* string_excitation_params,
                           real* force_function,
                           real* gauss_params,  // ← OLD: staging buffer
                           int* exct_cycle_index,
                           int* cycle_parameters,
                           real* volume_coeff)
```

**NEW signature:**
```cpp
__global__ void gaussKernel(int* string_excitation_params,
                           real* force_function,
                           real* gauss_params_full,        // ← NEW: full parameter array
                           int* gauss_param_indices,       // ← NEW: offset for each string
                           int* exct_cycle_index,
                           int* cycle_parameters,
                           real* volume_coeff)
```

**Current kernel implementation (lines 71-76):**
```cpp
for (int i = 0; i < num_gauss; i++) {
    // Read from staging buffer (sequential per string in batch)
    mu[i] = gauss_params[blockind * LEN_LEVEL_GP + i];
    sigma[i] = gauss_params[blockind * LEN_LEVEL_GP + NUM_GAUSS + i];
    g_vol[i] = gauss_params[blockind * LEN_LEVEL_GP + NUM_GAUSS * 2 + i];
    g_shift[i] = gauss_params[blockind * LEN_LEVEL_GP + NUM_GAUSS * 3 + i];
}
```

**NEW kernel implementation:**
```cpp
// Get the offset for this string's parameters
int blockind = blockIdx.x;  // String index in current batch
int param_offset = gauss_param_indices[blockind];  // Offset into full array

// Read parameters from full GPU storage using offset
for (int i = 0; i < NUM_GAUSS; i++) {
    mu[i] = gauss_params_full[param_offset + i];
    sigma[i] = gauss_params_full[param_offset + NUM_GAUSS + i];
    g_vol[i] = gauss_params_full[param_offset + NUM_GAUSS * 2 + i];
    g_shift[i] = gauss_params_full[param_offset + NUM_GAUSS * 3 + i];
}
```

**Full updated kernel:**
```cpp
__global__ void gaussKernel(int* string_excitation_params,
                           real* force_function,
                           real* gauss_params_full,        // NEW
                           int* gauss_param_indices,       // NEW
                           int* exct_cycle_index,
                           int* cycle_parameters,
                           real* volume_coeff) {

    int midiMult = cycle_parameters[3];
    int soundStep = cycle_parameters[4];
    int totalExcitationLength = midiMult * soundStep * EXCITATION_FACTOR;

    int stringNumber = string_excitation_params[blockIdx.x * 3];
    int timing = string_excitation_params[blockIdx.x * 3 + 2];
    real volume_coefficient = volume_coeff[stringNumber];

    // Calculate x-coordinate (unchanged)
    int xCoordinate_int = blockIdx.y * blockDim.x + threadIdx.x - timing;
    real xCoordinate = xCoordinate_int * (EXCITATION_FACTOR - 1);
    xCoordinate = xCoordinate / (gridDim.y * blockDim.x);

    // Initialize arrays (unchanged)
    real sigma[NUM_GAUSS];
    real mu[NUM_GAUSS];
    real g_vol[NUM_GAUSS];
    real g_shift[NUM_GAUSS];

    // NEW: Get offset for this string's velocity-specific parameters
    int blockind = blockIdx.x;
    int param_offset = gauss_param_indices[blockind];

    // NEW: Read parameters from full storage using offset
    for (int i = 0; i < NUM_GAUSS; i++) {
        mu[i] = gauss_params_full[param_offset + i];
        sigma[i] = gauss_params_full[param_offset + NUM_GAUSS + i];
        g_vol[i] = gauss_params_full[param_offset + NUM_GAUSS * 2 + i];
        g_shift[i] = gauss_params_full[param_offset + NUM_GAUSS * 3 + i];
    }

    // Compute excitation curve (unchanged)
    real result = 0;
    for (int i = 0; i < NUM_GAUSS; i++) {
        real s2 = pow((xCoordinate - mu[i]) / sigma[i], 2) * -0.5;
        real s2exp = expf(s2) - g_shift[i];
        s2exp = max(s2exp, 0.0);
        result += s2exp * g_vol[i];
    }
    result = result * volume_coefficient;

    // Write result (unchanged)
    force_function[totalExcitationLength * stringNumber +
                   blockIdx.y * blockDim.x + threadIdx.x] = static_cast<real>(result);
    exct_cycle_index[stringNumber] = 0;
}
```

#### 2.4 Update Kernel Launch Calls

**File:** `Pianoid.cu` - All `gaussKernel` launch sites

**Location 1: Line 1354 (test function)**
```cpp
// OLD
gaussKernel<<<gaussGridSize, gaussBlockSize>>>(
    getIntPointer("dev_string_excitation_params"),
    getRealPointer("dev_force_function"),
    getRealPointer("dev_gauss_parameters"),  // OLD: staging buffer
    getIntPointer("dev_exct_cycle_index"),
    getIntPointer("dev_cycle_params"),
    getRealPointer("dev_volume_coeff"));

// NEW
gaussKernel<<<gaussGridSize, gaussBlockSize>>>(
    getIntPointer("dev_string_excitation_params"),
    getRealPointer("dev_force_function"),
    getRealPointer("dev_gauss_params_full"),        // NEW: full storage
    getIntPointer("dev_gauss_param_indices"),       // NEW: indices
    getIntPointer("dev_exct_cycle_index"),
    getIntPointer("dev_cycle_params"),
    getRealPointer("dev_volume_coeff"));
```

**Location 2: Line 1667 (main kernel in launchMainKernel)**
```cpp
// OLD
gaussKernel<<<gaussGridSize, gaussBlockSize>>>(
    getIntPointer("dev_string_excitation_params"),
    getRealPointer("dev_force_function"),
    getRealPointer("dev_gauss_parameters"),
    getIntPointer("dev_exct_cycle_index"),
    getIntPointer("dev_cycle_params"),
    getRealPointer("dev_volume_coeff"));

// NEW
gaussKernel<<<gaussGridSize, gaussBlockSize>>>(
    getIntPointer("dev_string_excitation_params"),
    getRealPointer("dev_force_function"),
    getRealPointer("dev_gauss_params_full"),
    getIntPointer("dev_gauss_param_indices"),
    getIntPointer("dev_exct_cycle_index"),
    getIntPointer("dev_cycle_params"),
    getRealPointer("dev_volume_coeff"));
```

**Update header file:**

**File:** `gaussTest.cuh` - Update signature (line 21)
```cpp
__global__ void gaussKernel(int* string_excitation_params,
                           real* force_function,
                           real* gauss_params_full,        // CHANGED
                           int* gauss_param_indices,       // ADDED
                           int* exct_cycle_index,
                           int* cycle_parameters,
                           real* volume_coeff);
```

---

### Phase 3: Cleanup and Optimization

**Duration:** 1 day

#### 3.1 Remove Old Staging Buffer (Optional)

If all tests pass, remove the old `dev_gauss_parameters` buffer:

**File:** `Pianoid.cuh`
```cpp
// REMOVE (no longer needed)
// real* dev_gauss_parameters;
// std::vector<real> string_gauss_params;
```

**File:** `Pianoid.cu` - Remove from devMemoryInit
```cpp
// REMOVE this allocation
// handlers.emplace_back("dev_gauss_parameters", ...);
```

**File:** `Pianoid.cu` - Remove from constructor initialization
```cpp
// REMOVE
// string_gauss_params(MAX_STRINGS_PER_EVENT * LEN_LEVEL_GP),
```

**Reclaimed memory:** ~5 MB GPU, ~0.01 MB host

#### 3.2 Add Validation

**File:** `Pianoid.cu` - Add bounds checking in `_append_string_gp()`
```cpp
void Pianoid::_append_string_gp(int noString, int velocity, int timing) {
    // Validate inputs
    if (noString < 0 || noString >= cp_.num_strings) {
        printf("ERROR: Invalid string number %d (valid: 0-%d)\n",
               noString, cp_.num_strings - 1);
        return;
    }

    if (velocity < 0 || velocity >= NO_EXCITATION_LEVELS) {
        printf("ERROR: Invalid velocity %d (valid: 0-%d)\n",
               velocity, NO_EXCITATION_LEVELS - 1);
        return;
    }

    if (noStrings_in_GP >= MAX_STRINGS_PER_EVENT) {
        printf("ERROR: Too many strings in event (max: %d)\n",
               MAX_STRINGS_PER_EVENT);
        return;
    }

    // Rest of function...
}
```

#### 3.3 Performance Profiling

Add timing measurements to quantify improvements:

```cpp
void Pianoid::_load_exct_params_to_GPU() {
    if (noStrings_in_GP > 0) {
        #ifdef PIANOID_ENABLE_PROFILING
        auto start = std::chrono::high_resolution_clock::now();
        #endif

        cudaError_t cudaStatus = cudaMemcpy(dev_gauss_param_indices,
                                            string_gauss_param_indices.data(),
                                            noStrings_in_GP * sizeof(int),
                                            cudaMemcpyHostToDevice);

        #ifdef PIANOID_ENABLE_PROFILING
        auto end = std::chrono::high_resolution_clock::now();
        auto duration = std::chrono::duration_cast<std::chrono::microseconds>(end - start);
        printf("Excitation param transfer: %ld μs (%d strings, %zu bytes)\n",
               duration.count(), noStrings_in_GP, noStrings_in_GP * sizeof(int));
        #endif

        // Error checking...
    }
}
```

---

## Testing Strategy

### Unit Tests

#### Test 1: Memory Allocation
```cpp
TEST(ExcitationRefactoring, AllocateFullStorage) {
    Pianoid p = createTestPianoid();

    // Verify buffer exists
    ASSERT_NE(p.dev_gauss_params_full, nullptr);

    // Verify size
    size_t expected_size = NUM_STRINGS * NO_EXCITATION_LEVELS * LEN_LEVEL_GP;
    // Check allocation via query
}
```

#### Test 2: Parameter Update
```cpp
TEST(ExcitationRefactoring, UpdateParameters) {
    Pianoid p = createTestPianoid();

    // Create test parameters
    std::vector<real> test_params(NUM_STRINGS * NO_EXCITATION_LEVELS * LEN_LEVEL_GP);
    for (size_t i = 0; i < test_params.size(); i++) {
        test_params[i] = static_cast<real>(i) / 1000.0;
    }

    // Update
    p.setNewExcitationParameters(test_params);

    // Verify GPU has new values (copy back and check)
    std::vector<real> gpu_values(test_params.size());
    cudaMemcpy(gpu_values.data(), p.dev_gauss_params_full,
               test_params.size() * sizeof(real), cudaMemcpyDeviceToHost);

    for (size_t i = 0; i < 100; i++) {  // Check first 100 values
        ASSERT_NEAR(gpu_values[i], test_params[i], 1e-6);
    }
}
```

#### Test 3: Index Calculation
```cpp
TEST(ExcitationRefactoring, IndexCalculation) {
    // Test offset calculation for various strings/velocities

    // String 0, velocity 0 → offset 0
    int offset1 = (0 * NO_EXCITATION_LEVELS + 0) * LEN_LEVEL_GP;
    ASSERT_EQ(offset1, 0);

    // String 0, velocity 1 → offset 20
    int offset2 = (0 * NO_EXCITATION_LEVELS + 1) * LEN_LEVEL_GP;
    ASSERT_EQ(offset2, 20);

    // String 1, velocity 0 → offset 2560
    int offset3 = (1 * NO_EXCITATION_LEVELS + 0) * LEN_LEVEL_GP;
    ASSERT_EQ(offset3, 2560);

    // String 60, velocity 64
    int offset4 = (60 * NO_EXCITATION_LEVELS + 64) * LEN_LEVEL_GP;
    ASSERT_EQ(offset4, 154880);
}
```

### Integration Tests

#### Test 4: Single Note Playback
```python
def test_single_note_excitation():
    """Test that single note uses correct excitation parameters."""
    p = Pianoid()
    p.load_preset("test", "presets/test.json")

    # Update excitation with known values
    test_params = create_test_excitation_params()
    p.setNewExcitationParameters(test_params)

    # Play note
    p.play_note(60, velocity=64)

    # Verify force_function has expected shape
    # (detailed verification via test method)
```

#### Test 5: Polyphonic Playback
```python
def test_polyphonic_excitation():
    """Test multiple simultaneous notes with different velocities."""
    p = Pianoid()

    # Play chord with varying velocities
    notes = [
        (60, 100),  # C4, forte
        (64, 64),   # E4, mezzo-forte
        (67, 32),   # G4, piano
    ]

    for pitch, velocity in notes:
        p.play_note(pitch, velocity)

    # Verify all strings have correct excitation
    # Each should use velocity-specific parameters
```

#### Test 6: Parameter Update During Playback
```python
def test_update_during_playback():
    """Test updating excitation while notes are playing."""
    p = Pianoid()

    # Play sustained note
    p.play_note(60, 100)
    time.sleep(0.1)

    # Update excitation parameters
    new_params = create_different_excitation_params()
    p.setNewExcitationParameters(new_params)

    # Play another note (should use new parameters)
    p.play_note(64, 100)
    time.sleep(0.1)

    # Verify second note has different excitation character
```

### Performance Tests

#### Test 7: Memory Transfer Bandwidth
```python
def test_transfer_bandwidth():
    """Measure bandwidth savings from index-based approach."""
    p = Pianoid()

    # Simulate many note events
    times_old = []
    times_new = []

    for _ in range(1000):
        # Measure old approach (20 reals × 10 strings = 1600 bytes)
        start = time.perf_counter()
        # ... simulate old copy
        times_old.append(time.perf_counter() - start)

        # Measure new approach (10 ints = 40 bytes)
        start = time.perf_counter()
        p._load_exct_params_to_GPU()
        times_new.append(time.perf_counter() - start)

    print(f"Old approach: {np.mean(times_old)*1e6:.2f} μs")
    print(f"New approach: {np.mean(times_new)*1e6:.2f} μs")
    print(f"Speedup: {np.mean(times_old) / np.mean(times_new):.1f}x")

    # Assert significant improvement
    assert np.mean(times_new) < np.mean(times_old) * 0.3  # At least 3x faster
```

#### Test 8: Note Triggering Latency
```python
def test_note_latency():
    """Measure end-to-end note triggering latency."""
    p = Pianoid()

    latencies = []
    for _ in range(1000):
        start = time.perf_counter()
        p.play_note(60, 64)
        latencies.append(time.perf_counter() - start)

    print(f"Mean latency: {np.mean(latencies)*1e6:.2f} μs")
    print(f"99th percentile: {np.percentile(latencies, 99)*1e6:.2f} μs")

    # Verify low latency
    assert np.percentile(latencies, 99) < 0.0005  # <500 μs
```

### Regression Tests

#### Test 9: Audio Output Equivalence
```python
def test_audio_output_unchanged():
    """Verify refactoring doesn't change audio output."""
    # Run same MIDI sequence with old and new implementation
    # Compare audio outputs (should be identical)

    midi_sequence = load_test_midi()

    # Baseline (before refactoring)
    audio_old = load_reference_audio("baseline_output.wav")

    # New implementation
    p = Pianoid()
    audio_new = p.render_midi(midi_sequence)

    # Compare
    diff = np.abs(audio_new - audio_old)
    max_diff = np.max(diff)

    print(f"Max audio difference: {max_diff}")

    # Should be identical (or numerical noise only)
    assert max_diff < 1e-6
```

---

## Validation Checklist

### Functional Requirements

- [ ] `dev_gauss_params_full` allocated with full parameter set
- [ ] `dev_gauss_param_indices` allocated for index storage
- [ ] `setNewExcitationParameters()` updates GPU storage
- [ ] Host provides indices instead of copying parameters
- [ ] Kernel reads from full storage using indices
- [ ] All existing MIDI playback functionality works

### Performance Requirements

- [ ] Note triggering latency reduced by >10x
- [ ] Memory bandwidth reduced by >30x
- [ ] No audio quality degradation
- [ ] GPU memory usage +5 MB (acceptable)

### Code Quality Requirements

- [ ] All new code documented
- [ ] Unit tests pass (>90% coverage)
- [ ] Integration tests pass
- [ ] No memory leaks (cuda-memcheck clean)
- [ ] No compiler warnings

---

## Risk Assessment

### High Risk Items

**1. Kernel Parameter Order**
- **Risk:** Changing kernel signature breaks all call sites
- **Mitigation:** Use compiler errors to find all call sites
- **Testing:** Comprehensive smoke tests after signature change

**2. Index Calculation Error**
- **Risk:** Wrong offset formula causes out-of-bounds access
- **Mitigation:** Extensive unit tests for offset calculation
- **Fallback:** Add bounds checking in kernel (debug build)

### Medium Risk Items

**1. Performance Regression**
- **Risk:** Indirect lookup slower than direct read
- **Mitigation:** Benchmark before/after, should be neutral or faster
- **Likelihood:** Low - GPU memory access patterns optimized

**2. Memory Alignment**
- **Risk:** Unaligned reads cause performance issues
- **Mitigation:** Ensure LEN_LEVEL_GP is multiple of 4/8
- **Testing:** Profile kernel memory throughput

### Low Risk Items

**1. Host-Side Logic Changes**
- **Risk:** Bugs in `_append_string_gp()` logic
- **Mitigation:** Simple change, easy to test
- **Impact:** Minimal - caught in unit tests

---

## Timeline

| Phase | Tasks | Duration | Dependencies |
|-------|-------|----------|--------------|
| **Phase 1** | Add GPU storage, update setter | 1-2 days | None |
| **Phase 2** | Modify note triggering, update kernel | 2-3 days | Phase 1 complete |
| **Phase 3** | Cleanup, optimization, profiling | 1 day | Phase 2 complete |
| **Testing** | All test suites, validation | 1-2 days | Phase 3 complete |
| **Total** | **End-to-end completion** | **5-8 days** | Sequential |

---

## Success Metrics

### Before Refactoring

- Note trigger overhead: ~50-100 μs per note
- Parameter transfer: 160 bytes per string
- GPU memory: ~25 MB
- `setNewExcitationParameters()`: host-only update

### After Refactoring

- Note trigger overhead: **~5-10 μs per note** (10x improvement)
- Parameter transfer: **4 bytes per string** (40x reduction)
- GPU memory: **~30 MB** (+5 MB, acceptable)
- `setNewExcitationParameters()`: **immediate GPU update** (consistent API)

---

## Integration with Main Refactoring

Once this refactoring is complete, the excitation parameters can be cleanly integrated into the unified parameter block:

```cpp
struct PianoidPresetParameters {
    // ... other parameters ...

    // Excitation parameters (now properly GPU-resident)
    real excitation_parameters[NUM_STRINGS * NO_EXCITATION_LEVELS * LEN_LEVEL_GP];
    // ↑ This will be dev_gauss_params_full in the refactored system

    // ... other parameters ...
};
```

The preset switching will be trivial:
```cpp
void PresetManager::switchPreset(const std::string& preset_name) {
    // Swap pointer to full block (includes excitation params)
    dev_active_preset_block = dev_preset_blocks[preset_name];

    // Excitation parameters instantly switched!
    // No special case handling needed
}
```

---

## Conclusion

This refactoring transforms excitation parameter handling from a hybrid host/GPU system to a clean GPU-resident storage model. It eliminates the per-note parameter copy bottleneck, provides consistent API behavior, and sets the foundation for unified parameter block allocation in the main refactoring.

**Key achievements:**
1. ✓ Full parameter set on GPU
2. ✓ Index-based selection (no per-note copies)
3. ✓ Immediate GPU updates via `setNewExcitationParameters()`
4. ✓ 10-40x performance improvement for note triggering
5. ✓ Clean integration path for preset switching

**Next Steps:**
1. Review and approve this plan
2. Create feature branch `excitation-refactoring`
3. Implement Phase 1 (GPU storage)
4. Test and validate
5. Implement Phase 2 (index-based kernel)
6. Comprehensive testing
7. Merge to dev branch
8. Proceed with main parameter refactoring
