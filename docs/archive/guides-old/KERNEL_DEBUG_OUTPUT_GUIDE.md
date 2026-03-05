# MainKernel Debug Output Guide

**Document Created:** November 17, 2025
**Purpose:** Complete guide for adding and using debug outputs in MainKernel.cu

---

## Table of Contents

1. [Overview](#overview)
2. [Debug Output Architecture](#debug-output-architecture)
3. [Current Output Slot Assignments](#current-output-slot-assignments)
4. [Adding New Debug Outputs](#adding-new-debug-outputs)
5. [Accessing Debug Data from Python](#accessing-debug-data-from-python)
6. [Creating Chart Functions](#creating-chart-functions)
7. [Best Practices](#best-practices)
8. [Examples](#examples)
9. [Troubleshooting](#troubleshooting)

---

## Overview

The MainKernel.cu debug output system allows you to extract data from the GPU during simulation for analysis, visualization, and debugging. Data is written to the `output_data` buffer and can be accessed via Python/REST API.

### Key Concepts

- **10 Output Slots (Records 0-9)**: Each can hold a full array of data
- **Conditional Compilation**: Debug outputs only active when `EXTRACT_DEBUG_DATA` is defined
- **Reserved vs Flexible Slots**: Records 0-2 are reserved, 3-9 are flexible
- **Thread-Safe Writing**: Uses `recordOutputData()` device function

---

## Debug Output Architecture

### Buffer Structure

```cpp
// output_data buffer shape: [num_records][num_strings][array_size]
// - num_records: 10 (slots 0-9)
// - num_strings: 256 (or configured value)
// - array_size: 512 (or configured value)
```

### Writing Data

```cpp
__device__ void recordOutputData(
    real* arr,              // Base address of output slot
    int arrayBlockNo,       // Block/string index
    int arrayBlockLength,   // Size of array (typically arraySize)
    int posInArray,         // Position within the array
    real data               // Value to write
)
{
    arr[arrayBlockNo * arrayBlockLength + posInArray] = data;
}
```

### Accessing Slots

```cpp
// Record N base address
&output_data[numStrings * arraySize * N]

// Example: Record 5, block 10, position 25
recordOutputData(&output_data[numStrings * arraySize * 5], 10, arraySize, 25, value);
```

---

## Current Output Slot Assignments

### Reserved Slots (Always Present)

| Record | Data | Location | Purpose |
|--------|------|----------|---------|
| **0** | `s_a` | [MainKernel.cu:663](../../../pianoid_cuda/MainKernel.cu#L663) | Current string state (displacement) |
| **1** | `s_b` | [MainKernel.cu:665](../../../pianoid_cuda/MainKernel.cu#L665) | Previous string state |
| **2** | String ID | [MainKernel.cu:675](../../../pianoid_cuda/MainKernel.cu#L675) | String identification data |

### Feedback Coefficient Diagnostic Slots (Flexible)

| Record | Data | Location | Purpose |
|--------|------|----------|---------|
| **3** | `coeff_force` | [MainKernel.cu:340](../../../pianoid_cuda/MainKernel.cu#L340) | Spatial hammer force distribution (Gaussian) |
| **4** | `mode_feedin[i]` | [MainKernel.cu:350](../../../pianoid_cuda/MainKernel.cu#L350) | Feedin coefficients |
| **5** | `mode_feedback[i]` | [MainKernel.cu:351](../../../pianoid_cuda/MainKernel.cu#L351) | Computed feedback values |
| **6** | `feedin_cycle_matrix` | [MainKernel.cu:573](../../../pianoid_cuda/MainKernel.cu#L573) | String→Mode accumulation |
| **7** | `feedback_cycle_matrix` | [MainKernel.cu:420](../../../pianoid_cuda/MainKernel.cu#L420) | Mode→String accumulation |
| **8** | `feedback` | [MainKernel.cu:669](../../../pianoid_cuda/MainKernel.cu#L669) | Final stem feedback |
| **9** | `mode_coefficients` | [MainKernel.cu:356](../../../pianoid_cuda/MainKernel.cu#L356) | Raw FEEDIN matrix |

**Note:** Records 3-9 can be repurposed for other debugging tasks as needed.

---

## Adding New Debug Outputs

### Step 1: Choose an Output Slot

**Decision Tree:**
- Need string state data? → Use records 0-1 (already allocated)
- Need string identification? → Use record 2 (already allocated)
- New diagnostic data? → Use records 3-9 (flexible)

**If repurposing records 3-9:**
1. Document what you're replacing
2. Update this guide
3. Update any affected chart functions
4. Rebuild the kernel

### Step 2: Add Output Code to MainKernel.cu

#### Example 1: Output a Single Value

```cpp
#ifdef EXTRACT_DEBUG_DATA
    // Record 3: Output runtime parameter value
    if (blockNo == 0 && stMdIndex == 0) {
        recordOutputData(&output_data[numStrings * arraySize * 3],
                        0,          // Block 0
                        arraySize,  // Array length
                        0,          // Position 0
                        *my_parameter);
    }
#endif
```

#### Example 2: Output Per-String Values

```cpp
#ifdef EXTRACT_DEBUG_DATA
    // Record 4: Output value for each string
    recordOutputData(&output_data[numStrings * arraySize * 4],
                    stringNo,   // Each string gets its own slot
                    arraySize,
                    pointIndex, // Position in the string
                    my_value);
#endif
```

#### Example 3: Output Per-Mode Values

```cpp
#ifdef EXTRACT_DEBUG_DATA
    // Record 5: Output value for each mode
    if (modeNo < numModes) {
        recordOutputData(&output_data[numStrings * arraySize * 5],
                        modeNo,     // Each mode gets its own slot
                        arraySize,
                        stMdIndex,  // Position index
                        mode_data[i]);
    }
#endif
```

#### Example 4: Output at Specific Cycle

```cpp
#ifdef EXTRACT_DEBUG_DATA
    // Record 6: Output only at cycle 32
    if (main_cycle_index == 32) {
        recordOutputData(&output_data[numStrings * arraySize * 6],
                        blockNo,
                        arraySize,
                        stMdIndex,
                        cycle_specific_data);
    }
#endif
```

#### Example 5: Output Loop Data

```cpp
#ifdef EXTRACT_DEBUG_DATA
    // Record 7: Output data from loop iterations
    for (int i = 0; i < NUM_FOLDS_IN_QUARTER; i++) {
        if (foldedIndexInQuarter[i] < numStrings && modeNo < numModes) {
            int stringID = foldedIndexInQuarter[i];
            recordOutputData(&output_data[numStrings * arraySize * 7],
                            stringID,   // String index
                            arraySize,
                            modeNo,     // Mode index as position
                            loop_data[i]);
        }
    }
#endif
```

### Step 3: Add Documentation Comment

Always add a clear comment above your debug output:

```cpp
#ifdef EXTRACT_DEBUG_DATA
    // ==================== YOUR DIAGNOSTIC NAME ====================
    // Record 3: Description of what this outputs
    // Record 4: Description of what this outputs
    // ...
    // Purpose: Why you're outputting this data
    // Usage: How to interpret the data
    // ==============================================================

    // Your output code here...

#endif
```

---

## Accessing Debug Data from Python

### Method 1: Direct Access via pianoid.result

```python
import pianoid_middleware.pianoid as pianoid

# Fetch all debug data from GPU
pianoid.result.get_output_data_from_pianoid()

# Access specific record
record_3_data = pianoid.result.output_data[3]  # Shape: [num_strings, array_size]

# Access specific string in record
string_60_data = pianoid.result.output_data[3][60]  # Shape: [array_size]

# Access specific value
value = pianoid.result.output_data[3][60][25]  # Single value
```

### Method 2: Use Existing block_output_data Chart

```bash
curl -X POST http://localhost:5000/get_chart_test \
  -H "Content-Type: application/json" \
  -d '{
    "chartType": "block_output_data",
    "parameters": {
      "record_no": 3,
      "pitch_no": 60,
      "num_charts": 1
    }
  }'
```

### Method 3: Create Custom Chart Function

See [Creating Chart Functions](#creating-chart-functions) section below.

---

## Creating Chart Functions

### Step 1: Add Function to chartFunctions.py

```python
def my_diagnostic_function(pianoid, **kwargs):
    """
    Description of what this diagnostic shows.

    Parameters:
        param1: Description
        param2: Description
    """
    charts = ChartArray()

    # Get parameters
    pitch_no = kwargs.get('pitch_no', 60)
    param2 = kwargs.get('param2', default_value)

    # Fetch debug data from GPU
    pianoid.result.get_output_data_from_pianoid()

    # Get string IDs for the pitch
    string_ids = pianoid.sm.get_string_IDs(pitch_no)
    if len(string_ids) == 0:
        return charts, "Error", {"Error": f"No strings for pitch {pitch_no}"}

    string_id = string_ids[0]

    # Extract data from records
    # Kernel writes data by blocks, so we need to:
    # 1. Get the block containing the string
    # 2. Access block data from output_data[record][block_id]
    # 3. Extract the string's portion using start position and length
    block = pianoid.sm.get_block_for_string(string_id)
    block_id = block.ID
    start = block.get_string_address(string_id)
    string_length = pianoid.sm.strings[string_id].geometry.p_full()

    # Get data for this string from each record
    block_data1 = pianoid.result.output_data[3][block_id]
    my_data1 = block_data1[start:start + string_length]

    block_data2 = pianoid.result.output_data[4][block_id]
    my_data2 = block_data2[start:start + string_length]

    # Create charts
    charts.append_chart("Data 1", my_data1.tolist())
    charts.append_chart("Data 2", my_data2.tolist())

    # Calculate metrics
    max_val1 = float(np.max(my_data1))
    max_val2 = float(np.max(my_data2))

    # Return charts and metadata
    text_fields = {
        "Pitch": str(pitch_no),
        "String ID": str(string_id),
        "Block ID": str(block_id),
        "Start in Block": str(start),
        "String Length": str(string_length),
        "Max Value 1": f"{max_val1:.6f}",
        "Max Value 2": f"{max_val2:.6f}"
    }

    return charts, f"My Diagnostic - Pitch {pitch_no}", text_fields
```

### Step 2: Register in chart_config.json

```json
{
  "name": "my_diagnostic",
  "label": "My Diagnostic Chart",
  "function": "my_diagnostic_function",
  "item_type": "chart",
  "parameters": [
    {
      "name": "pitch_no",
      "type": "number",
      "defaultValue": 60,
      "label": "MIDI Pitch Number",
      "choices": null
    },
    {
      "name": "param2",
      "type": "number",
      "defaultValue": 50,
      "label": "Parameter 2 Description",
      "choices": null
    }
  ]
}
```

### Step 3: Use via REST API

```bash
curl -X POST http://localhost:5000/get_chart_test \
  -H "Content-Type: application/json" \
  -d '{
    "chartType": "my_diagnostic",
    "parameters": {
      "pitch_no": 60,
      "param2": 100
    }
  }'
```

---

## Best Practices

### 1. Always Use #ifdef EXTRACT_DEBUG_DATA

```cpp
#ifdef EXTRACT_DEBUG_DATA
    // Your debug outputs here
#endif
```

**Why:** Ensures debug code is only compiled when needed, avoiding performance overhead in production builds.

### 2. Document Your Outputs

Add clear comments explaining:
- What data you're outputting
- Which record slots you're using
- How to interpret the data
- When the data is captured (which cycle, condition, etc.)

### 3. Use Descriptive Variable Names

```cpp
// Good
recordOutputData(&output_data[numStrings * arraySize * 3], blockNo, arraySize, stMdIndex, bridge_force);

// Bad
recordOutputData(&output_data[numStrings * arraySize * 3], blockNo, arraySize, stMdIndex, val);
```

### 4. Limit Data Volume

Only output what you need:
- Use conditional writes (specific cycles, modes, strings)
- Limit loop iterations
- Consider sampling rather than recording every value

```cpp
// Sample every 10th cycle instead of every cycle
if (main_cycle_index % 10 == 0) {
    recordOutputData(...);
}
```

### 5. Verify Indices

Always check bounds before writing:

```cpp
if (stringNo < numStrings && modeNo < numModes) {
    recordOutputData(...);
}
```

### 6. Clean Up When Done

When you're finished debugging:
- Remove or comment out temporary outputs
- Update documentation
- Consider if the output should be kept for future use

---

## Examples

### Example 1: Debug String Damping

**Goal:** Output damping coefficient for each string to verify it's being applied correctly.

**MainKernel.cu:**
```cpp
#ifdef EXTRACT_DEBUG_DATA
    // Record 3: String damping coefficients
    if (onString) {
        recordOutputData(&output_data[numStrings * arraySize * 3],
                        stringNo,
                        arraySize,
                        pointIndex,
                        coeff_frequency_decay);
    }
#endif
```

**Chart Function:**
```python
def damping_diagnostic_function(pianoid, **kwargs):
    charts = ChartArray()
    pitch_no = kwargs.get('pitch_no', 60)

    pianoid.result.get_output_data_from_pianoid()
    string_ids = pianoid.sm.get_string_IDs(pitch_no)

    for string_id in string_ids[:4]:  # Show up to 4 strings
        damping = pianoid.result.output_data[3][string_id]
        charts.append_chart(f"String {string_id} Damping", damping[:100].tolist())

    return charts, f"Damping Diagnostic - Pitch {pitch_no}", {}
```

### Example 2: Debug Mode Excitation

**Goal:** Track which modes are being excited by a string.

**MainKernel.cu:**
```cpp
#ifdef EXTRACT_DEBUG_DATA
    // Record 4: Mode excitation force
    if (modeNo < numModes) {
        recordOutputData(&output_data[numStrings * arraySize * 4],
                        modeNo,
                        arraySize,
                        stMdIndex,
                        s_mode_applied_force[quarterNumber]);
    }
#endif
```

**Python Access:**
```python
pianoid.result.get_output_data_from_pianoid()

# Get excitation for mode 10
mode_10_excitation = pianoid.result.output_data[4][10]

# Find which modes are most excited
all_modes = pianoid.result.output_data[4]
max_excitations = np.max(all_modes, axis=1)
top_modes = np.argsort(max_excitations)[-10:]  # Top 10 excited modes
```

### Example 3: Compare Two Values

**Goal:** Output both input and output of a calculation to verify correctness.

**MainKernel.cu:**
```cpp
#ifdef EXTRACT_DEBUG_DATA
    // Record 5: Input value
    // Record 6: Output value (should equal input × coefficient)
    recordOutputData(&output_data[numStrings * arraySize * 5], blockNo, arraySize, stMdIndex, input_val);

    real output_val = input_val * coefficient;
    recordOutputData(&output_data[numStrings * arraySize * 6], blockNo, arraySize, stMdIndex, output_val);
#endif
```

**Chart Function:**
```python
def calculation_verify_function(pianoid, **kwargs):
    charts = ChartArray()
    pitch_no = kwargs.get('pitch_no', 60)

    pianoid.result.get_output_data_from_pianoid()
    string_id = pianoid.sm.get_string_IDs(pitch_no)[0]

    input_data = pianoid.result.output_data[5][string_id][:100]
    output_data = pianoid.result.output_data[6][string_id][:100]

    # Calculate expected output
    coefficient = 0.5  # Or get from somewhere
    expected = input_data * coefficient
    error = output_data - expected

    charts.append_chart("Input", input_data.tolist())
    charts.append_chart("Output (Actual)", output_data.tolist())
    charts.append_chart("Output (Expected)", expected.tolist())
    charts.append_chart("Error", error.tolist())

    max_error = float(np.max(np.abs(error)))
    text_fields = {
        "Max Error": f"{max_error:.10f}",
        "Status": "✅ PASS" if max_error < 1e-6 else "❌ FAIL"
    }

    return charts, "Calculation Verification", text_fields
```

---

## Troubleshooting

### Issue 1: No Data Appearing

**Symptoms:** All values are 0 or garbage

**Possible Causes:**
1. `EXTRACT_DEBUG_DATA` not defined during compilation
2. Data written to wrong record slot
3. Data written outside valid indices
4. Data not fetched from GPU before accessing

**Solutions:**
```bash
# 1. Check if EXTRACT_DEBUG_DATA is defined
# In constants.h, verify:
#define EXTRACT_DEBUG_DATA

# 2. Rebuild kernel
python setup.py build_ext --inplace

# 3. Verify fetch call
pianoid.result.get_output_data_from_pianoid()
```

### Issue 2: Data in Wrong Location

**Symptoms:** Expected data doesn't match what you're seeing

**Solution:** Verify indexing:
```python
# Print shape to understand structure
print(f"Shape: {pianoid.result.output_data.shape}")
# Expected: (10, num_strings, array_size)

# Check specific record
print(f"Record 3 shape: {pianoid.result.output_data[3].shape}")
```

### Issue 3: Partial Data Only

**Symptoms:** Only some values are written, rest are zero

**Possible Causes:**
1. Conditional write not covering all cases
2. Thread synchronization issue
3. Out of bounds write being skipped

**Solution:** Add bounds checking and logging:
```cpp
#ifdef EXTRACT_DEBUG_DATA
    if (stringNo < numStrings && stMdIndex < arraySize) {
        recordOutputData(...);
    } else {
        // This will tell you if you're hitting bounds issues
        printf("BOUNDS: stringNo=%d, stMdIndex=%d\n", stringNo, stMdIndex);
    }
#endif
```

### Issue 4: Old Data Persisting

**Symptoms:** Data doesn't update after parameter changes

**Solution:** Ensure `get_output_data_from_pianoid()` is called AFTER the simulation/playback:
```python
# Wrong order
pianoid.result.get_output_data_from_pianoid()
pianoid.set_deck_feedback_coefficient(0.5)

# Correct order
pianoid.set_deck_feedback_coefficient(0.5)
# ... play note or run simulation ...
pianoid.result.get_output_data_from_pianoid()
```

### Issue 5: Buffer Overflow / Crash

**Symptoms:** Kernel crash, CUDA errors

**Possible Causes:**
1. Writing beyond array bounds
2. Invalid block/string index

**Solution:** Always validate indices:
```cpp
#ifdef EXTRACT_DEBUG_DATA
    // Add defensive bounds checking
    if (blockNo >= 0 && blockNo < numStrings &&
        pointIndex >= 0 && pointIndex < arraySize) {
        recordOutputData(...);
    }
#endif
```

---

## Quick Reference

### Common Patterns

**Output single global value:**
```cpp
if (blockNo == 0 && stMdIndex == 0) {
    recordOutputData(&output_data[numStrings * arraySize * N], 0, arraySize, 0, value);
}
```

**Output per-string value:**
```cpp
recordOutputData(&output_data[numStrings * arraySize * N], stringNo, arraySize, pointIndex, value);
```

**Output per-mode value:**
```cpp
if (modeNo < numModes) {
    recordOutputData(&output_data[numStrings * arraySize * N], modeNo, arraySize, stMdIndex, value);
}
```

**Output at specific cycle:**
```cpp
if (main_cycle_index == target_cycle) {
    recordOutputData(...);
}
```

**Output from loop:**
```cpp
for (int i = 0; i < NUM_FOLDS_IN_QUARTER; i++) {
    if (valid_condition) {
        recordOutputData(&output_data[numStrings * arraySize * N], index, arraySize, position, data[i]);
    }
}
```

### Workflow Checklist

- [ ] Choose available record slot (3-9)
- [ ] Add `#ifdef EXTRACT_DEBUG_DATA` wrapper
- [ ] Add descriptive comment
- [ ] Implement `recordOutputData()` call
- [ ] Add bounds checking
- [ ] Rebuild kernel: `python setup.py build_ext --inplace`
- [ ] Test data access in Python
- [ ] Create chart function (optional)
- [ ] Register chart in chart_config.json (optional)
- [ ] Document changes in this guide
- [ ] Update CHART_API_DOCUMENTATION.md if needed

---

## Related Documentation

- [CHART_API_DOCUMENTATION.md](CHART_API_DOCUMENTATION.md) - Chart system documentation
- [MainKernel.cu](../../pianoid_cuda/MainKernel.cu) - Kernel source code
- [chartFunctions.py](../../pianoid_middleware/chartFunctions.py) - Chart function implementations
- [chart_config.json](../../pianoid_middleware/chart_config.json) - Chart registry

---

**Last Updated:** November 17, 2025
**Maintainer:** PianoidCore Development Team
