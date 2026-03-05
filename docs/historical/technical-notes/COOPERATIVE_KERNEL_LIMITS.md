# Cooperative Kernel Launch Limits - Grid Sizing Fix

## Issue

Cooperative kernel launches have strict limits on the total number of blocks:

```
ERROR: convolutionKernel launch failed: too many blocks in cooperative launch
  Grid: (8, 24), Block: (128)
```

**Root Cause**: `gridDim.x × gridDim.y = 8 × 24 = 192` blocks exceeded the cooperative kernel limit.

## Cooperative Kernel Limits

### What are Cooperative Kernels?

Cooperative kernels (launched via `cudaLaunchCooperativeKernel`) allow:
- **Grid-wide synchronization** via `cooperative_groups::this_grid().sync()`
- **All blocks running concurrently** on the GPU

This requires:
- **ALL blocks fit on GPU simultaneously**
- **Total blocks ≤ max concurrent blocks** on the device

### Maximum Blocks Calculation

The limit depends on:
1. **GPU multiprocessors (SMs)**: e.g., RTX 4090 has 128 SMs
2. **Blocks per SM**: Typically 16-32 depending on resources
3. **Kernel resource usage**: Registers, shared memory, thread count

For Pianoid's main kernel:
- `numBlocks = numStrings / numStringsInArray`
- Example: `88 strings / 4 strings per array = 22 blocks`

## Solution: Dynamic Grid Sizing

### Before (Hardcoded - WRONG)
```cpp
dim3 blocksPerGrid(numMappings, 24);  // ❌ Hardcoded Y-dimension
// Total = 8 × 24 = 192 blocks → EXCEEDS LIMIT!
```

### After (Dynamic - CORRECT)
```cpp
const int maxTotalBlocks = cp_.num_strings / cp_.num_strings_in_array;
const int gridDim_Y = maxTotalBlocks / numMappings;  // Floor division

if (gridDim_Y < 1) {
    printf("ERROR: Not enough blocks for filter kernel\n");
    return;
}

dim3 blocksPerGrid(numMappings, gridDim_Y);
// Total = 8 × 2 = 16 blocks ✓ (for 88 strings / 4 = 22 max blocks)
```

## Calculation Example

**Given:**
- `numStrings = 88`
- `numStringsInArray = 4`
- `numMappings = inputChannels × outputChannels = 4 × 2 = 8`

**Calculate:**
```
maxTotalBlocks = 88 / 4 = 22
gridDim.x = numMappings = 8
gridDim.y = maxTotalBlocks / numMappings = 22 / 8 = 2 (floor division)

Total blocks = 8 × 2 = 16 ✓ (< 22 limit)
```

## Implementation

**File**: [Pianoid.cu:1834-1852](pianoid.cu:1834-1852)

```cpp
// Calculate grid dimensions respecting cooperative launch limits
// Total blocks = gridDim.x × gridDim.y must be <= numBlocks
// numBlocks = cp_.num_strings / cp_.num_strings_in_array
const int maxTotalBlocks = cp_.num_strings / cp_.num_strings_in_array;
const int gridDim_Y = maxTotalBlocks / numMappings;  // Floor division

if (gridDim_Y < 1) {
    printf("ERROR: Not enough blocks for filter kernel\n");
    printf("  numMappings: %d, maxTotalBlocks: %d, required gridDim.y: %d\n",
           numMappings, maxTotalBlocks, gridDim_Y);
    return;
}

dim3 blocksPerGrid(numMappings, gridDim_Y);
dim3 threadsPerBlock(128);

printf("FIR filter kernel launch: Grid(%d, %d) = %d blocks, Block(%d), max allowed: %d\n",
       blocksPerGrid.x, blocksPerGrid.y, blocksPerGrid.x * blocksPerGrid.y,
       threadsPerBlock.x, maxTotalBlocks);
```

## Why This Works

### Kernel Architecture
The filter kernel uses a 2D grid:
- **X-dimension** (`gridDim.x`): One block per input→output mapping
  - For 4 inputs × 2 outputs = 8 mappings → `gridDim.x = 8`
- **Y-dimension** (`gridDim.y`): Filter tiling (processes filter in segments)
  - Divides filter computation across multiple blocks

### Resource Sharing
The main synthesis kernel and filter kernel share the same cooperative block budget:
- Main kernel uses: `numStrings / numStringsInArray` blocks
- Filter kernel uses: `≤ numStrings / numStringsInArray` blocks
- Both launched with `cudaLaunchCooperativeKernel`

### Safety Margin
Using floor division ensures:
```
gridDim.x × gridDim.y ≤ maxTotalBlocks
```

Example:
- `maxTotalBlocks = 22`
- `numMappings = 8`
- `gridDim_Y = 22 / 8 = 2` (floor)
- **Total = 8 × 2 = 16 ≤ 22** ✓

## Error Handling

If `gridDim_Y < 1`, it means `maxTotalBlocks < numMappings`:

```cpp
if (gridDim_Y < 1) {
    printf("ERROR: Not enough blocks for filter kernel\n");
    printf("  numMappings: %d, maxTotalBlocks: %d\n", numMappings, maxTotalBlocks);
    return;
}
```

This would occur if:
- Too few strings configured
- Too many output channels
- Example: 4 total blocks, but 8 mappings needed → impossible

## Performance Implications

### Reduced Y-Dimension
- **Before**: `gridDim.y = 24` (hardcoded)
- **After**: `gridDim.y = 2` (calculated)

**Impact**: Filter computation is parallelized across fewer blocks.
- Each block processes more filter segments
- Slight increase in per-block work
- **Trade-off**: Kernel correctness > raw performance

### Optimization Opportunity
For very large filters, consider:
1. **Non-cooperative kernel**: Remove grid-wide sync requirement
2. **Atomic operations**: Instead of cooperative sync
3. **Multi-pass**: Split filter into multiple kernel launches

## Related Files

1. **[Pianoid.cu:1834-1852](pianoid.cu:1834-1852)** - Grid dimension calculation
2. **[FIRFilter.cu](FIRFilter.cu:4)** - Uses `cooperative_groups::this_grid().sync()`
3. **[FIR_FILTER_UPDATE_SUMMARY.md](FIR_FILTER_UPDATE_SUMMARY.md)** - Overall filter architecture

## Testing Checklist

- [x] Calculate `gridDim.y` from `maxTotalBlocks`
- [x] Verify total blocks ≤ limit
- [x] Add error checking for insufficient blocks
- [x] Add debug printf for grid dimensions
- [ ] Test with various string configurations
- [ ] Verify filter output is correct with reduced Y-dimension
- [ ] Benchmark performance impact

## Debug Output

When filter kernel launches, you'll see:
```
FIR filter kernel launch: Grid(8, 2) = 16 blocks, Block(128), max allowed: 22
```

This confirms:
- Grid dimensions: (8, 2)
- Total blocks: 16
- Max allowed: 22
- **Status**: ✓ Within limits
