# Audio Driver Stop/Crash Bug

## Issue Description

When calling `pianoid.stop_pianoid()` or `stopApplication()`, the application crashes or hangs. This appears to be related to audio driver thread conflicts.

## Observed Behavior

```
Application stopped
Application has already been stopped
Stopping the main application
Main application terminated
[CRASH OR HANG]
```

## Console Output

```
PianoidResult::fetch : fetching records
getSoundRecords: Returning records, length 200 sound_record_index 198
getSoundRecords:Returning records, samplesInCycle 64 num strings 224 length 11354112
get_sound_records: Obtained result of length 11354112
Reshaping to 198, self.num_records, 224, 48
PianoidResult::fetch : fetching done

Pianoid.cu::stopApplication Application stopped
Application has already been stopped
Stopping the main application
Main application terminated
[Application crashes or hangs]
```

## Root Cause Analysis

### Likely Causes:
1. **Audio Stream Thread Conflict**: The SDL audio callback thread may still be running when `stopApplication()` is called
2. **Race Condition**: Multiple threads trying to stop the application simultaneously
3. **Audio Driver Malperformance**: SDL audio driver not properly releasing resources
4. **Double Stop**: Messages show "Application has already been stopped" suggesting `stopApplication()` is being called multiple times

## Impact

- Cannot safely stop and restart the application
- Blocks offline playback implementation that requires stopping background thread
- Causes backend crashes during testing

## Context

This bug was discovered during PLAYBACK_REFACTORING_PLAN.md implementation when attempting to:
1. Stop the background `runMainApplication()` thread
2. Run offline playback (to avoid concurrent `launchMainKernel()` calls)
3. Restart the background thread

## Workaround Options

### Option 1: Don't Stop the Background Thread
- Run offline playback concurrently with background thread
- Use mutex/lock to prevent concurrent `launchMainKernel()` calls
- Risk: Complex synchronization required

### Option 2: Use Separate Pianoid Instance
- Create a second Pianoid instance for offline rendering
- Keep main instance running for real-time playback
- Risk: Double GPU memory usage

### Option 3: Implement Proper Thread Shutdown
- Fix the root cause of the stop/crash bug
- Ensure audio stream thread is properly terminated before stopping
- Ensure `stopApplication()` is idempotent (can be called multiple times safely)

## Recommended Solution

**Fix the stop/crash bug properly:**

1. **Audio Stream Thread Safety**:
   - Ensure SDL audio callback stops before `stopApplication()` completes
   - Use proper synchronization primitives (mutex, condition variables)
   - Wait for audio thread to acknowledge shutdown

2. **Idempotent Stop**:
   - Add flag to prevent multiple `stopApplication()` calls
   - Return early if already stopped
   - Clear the flag in `startApplication()`

3. **Resource Cleanup Order**:
   - Stop audio stream first
   - Then stop CUDA kernels
   - Finally release resources

## Investigation Steps

1. Review `stopApplication()` implementation in [Pianoid.cu](pianoid_cuda/Pianoid.cu)
2. Check SDL audio callback thread handling
3. Identify where "Application has already been stopped" message comes from
4. Add proper synchronization between audio thread and main thread
5. Ensure single-responsibility for stop operations

## Related Files

- `pianoid_cuda/Pianoid.cu` - stopApplication() implementation
- `pianoid_cuda/Pianoid.cuh` - applicationIsRunning flag
- `pianoid_middleware/backendServer.py` - stop_pianoid() calls
- `PLAYBACK_REFACTORING_PLAN.md` - Blocked by this issue

## Priority

**MEDIUM** - Blocks offline playback feature but has workarounds

## Status

**OPEN** - Needs investigation and fix

## Date Identified

2025-10-17
