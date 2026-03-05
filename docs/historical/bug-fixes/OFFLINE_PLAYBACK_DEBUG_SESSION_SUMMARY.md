# Offline MIDI Playback Debug Session Summary

**Date**: 2025-10-21
**Status**: Investigation in progress - Code reverted to last commit

---

## Changes Made During Debug Session

Extensive diagnostic output was added to identify where offline MIDI playback hangs:

1. **Pianoid.cu - `appendRawSound()`**: Added debug prints for buffer allocation, CUDA sync, memcpy, and vector insertion
2. **Pianoid.cu - `playSoundSamples()`**: Added debug prints before/after calling `appendRawSound()`
3. **Pianoid.cu - `appendSoundRecords()`**: Added debug prints for sync operations and kernel launches
4. **OfflinePlaybackEngine.cu - render loop**: Added debug prints to track cycle progression
5. **OfflinePlaybackEngine.cu - `processEventsAtCycle()`**: Added debug prints for event processing

**All changes have been reverted to the last commit.**

---

## Offline Playback Pipeline and Logic

### High-Level Architecture

The offline MIDI playback system renders MIDI files to audio without real-time audio drivers, using a cycle-accurate simulation:

```
MIDI File → Event Queue → Render Loop → Audio Collection → WAV Export
```

### Detailed Pipeline

#### 1. Initialization (`chartFunctions.py: offline_midi_playback_function()`)

- Loads MIDI file using `pretty_midi` library
- Converts MIDI events (note_on/note_off) to internal `PlaybackEvent` format
- Calculates cycle timing: `cycle_number = int(time_seconds * sample_rate / samples_per_cycle)`
- Creates `OfflinePlaybackEngine` instance with configuration:
  - `audio_enabled = True` (enables audio generation)
  - `record_to_buffer = True` (enables audio collection)
  - `total_cycles` based on max duration

#### 2. Event Queue (`PlaybackEventQueue`)

- Stores events sorted by cycle number
- `getEventsAtCycle(cycle)` retrieves events scheduled for a specific cycle
- Events include: note_on, note_off, control_change, etc.

#### 3. Main Render Loop (`OfflinePlaybackEngine::render()`)

The render loop executes cycle-by-cycle:

```cpp
for (current_cycle = 0; current_cycle < total_cycles; current_cycle++) {
    // 1. Process MIDI events scheduled at this cycle
    processEventsAtCycle(current_cycle);

    // 2. Execute GPU synthesis cycle
    runCycle();

    // 3. Collect audio samples
    if (config.record_to_buffer) {
        collectAudio();
    }
}
```

##### 3a. Process Events (`processEventsAtCycle()`)

- Retrieves events from queue for current cycle
- Dispatches each event through `EventDispatcher`
- Event dispatch calls Pianoid methods like:
  - `noteOn(pitch, velocity)` - triggers string excitation
  - `noteOff(pitch)` - releases string
  - `setParameter(name, value)` - updates synthesis parameters

##### 3b. Run Synthesis Cycle (`runCycle()`)

Each synthesis cycle performs:

```cpp
void OfflinePlaybackEngine::runCycle() {
    // Execute GPU kernels for physical modeling
    pianoid_->launchMainKernel();      // Runs physics simulation

    // Collect audio and manage buffers
    pianoid_->playSoundSamples();       // Copies audio from GPU to rawSound vector

    // Record string state data
    pianoid_->appendSoundRecords();     // Archives synthesis data

    // Periodic maintenance
    if ((current_cycle + 1) % 400 == 0) {
        pianoid_->resetSoundRecordIndex();
    }
}
```

**`launchMainKernel()`** - Executes GPU physics simulation:
- **parameterKernel**: Calculates string/mode parameters (runs when `new_notes_ind > 0`)
- **gaussKernel**: Computes excitation forces for newly triggered notes
- Clears output buffers
- Runs main physics kernels (string/mode propagation)

**`playSoundSamples()`** - Audio collection:

```cpp
void Pianoid::playSoundSamples() {
    // ALWAYS collect audio samples first
    appendRawSound("dev_soundFloat");  // Copies GPU audio to CPU vector

    // Early return if audio driver disabled
    if (!audioOn.load()) {
        return;  // Skip driver operations
    }

    // Apply FIR filtering (if enabled)
    if (FIRfilterON) {
        // Run convolution kernels
        // Convert to output format
    }

    // Push to audio driver (only in real-time mode)
    if (audioDriver) {
        audioDriver->pushSamples(outputData, dataSize);
    }
}
```

**`appendRawSound()`** - GPU-to-CPU audio transfer:

```cpp
void Pianoid::appendRawSound(std::string sound_record_name) {
    std::vector<float> temp(samplesInCycle * numChannels);  // 64 samples × 4 channels = 256 floats

    // Copy from GPU device memory to CPU host memory
    cudaMemcpy(temp.data(),
               getFloatPointer("dev_soundFloat"),  // GPU buffer
               samplesInCycle * numChannels * sizeof(float),
               cudaMemcpyDeviceToHost);  // Synchronous operation

    // Append to accumulated audio buffer
    rawSound.insert(rawSound.end(), temp.begin(), temp.end());
}
```

**`appendSoundRecords()`** - Archive synthesis data:

```cpp
void Pianoid::appendSoundRecords() {
    cudaDeviceSynchronize();

    if (sound_record_index < MAX_SOUND_RECORD_INDEX) {  // 500 max
        // Copy string state data to archive
        copyKernel<<<num_strings, samplesInCycle * NUM_PARAMS_IN_SOUND_RECORD>>>(
            dev_sound_records_ms,  // Source
            dev_sound_records,     // Destination archive
            offset
        );
        cudaDeviceSynchronize();
    }

    sound_record_index++;
}
```

##### 3c. Collect Audio (`collectAudio()`)

- Wrapper that calls `pianoid_->playSoundSamples()`
- In offline mode, this populates the `rawSound` vector

#### 4. Audio State Management

The `audioOn` flag controls audio generation:

- **Before render**: Save current `audioOn` state (typically `false`)
- **During render**: Set `audioOn = true` to enable audio generation
- **After render**: Restore original `audioOn` state

```cpp
bool previous_audio_state = pianoid_->audioOn.load();
if (config_.audio_enabled) {
    pianoid_->audioOn.store(true);  // Temporarily enable
}

// ... render loop ...

pianoid_->audioOn.store(previous_audio_state);  // Restore
```

**Why this is necessary**:
- `playSoundSamples()` checks `audioOn` before processing filters/drivers
- But `appendRawSound()` is called BEFORE the check, so audio is always collected
- The flag prevents filter operations and audio driver calls in offline mode

#### 5. Audio Retrieval

After rendering completes:

```cpp
std::vector<float> audio = pianoid_->getRawSoundRecord();
// Returns the accumulated rawSound vector
// Size = total_cycles × samplesInCycle × numChannels
//      = 2250 × 64 × 4 = 576,000 floats (for 3 seconds at 48kHz)
```

#### 6. WAV Export

The collected audio is written to a WAV file:
- Sample rate: 48000 Hz
- Format: 32-bit float PCM
- Channels: Mono (first channel extracted from 4-channel interleaved data)

### Key Design Points

1. **Cycle-Accurate Timing**: Events trigger at exact sample positions, not wall-clock time
2. **No Real-Time Constraints**: Renders as fast as GPU allows
3. **Audio Always Collected**: `appendRawSound()` executes unconditionally in `playSoundSamples()`
4. **Buffer Management**: `sound_record_index` resets every 400 cycles to prevent overflow
5. **GPU Synchronization**: Heavy use of `cudaDeviceSynchronize()` ensures data consistency

---

## Current Status and Error

### Observed Behavior

The offline MIDI render **hangs after exactly 10 cycles**:

```
Cycle 0: ✓ Complete (appendSoundRecords index 0→1)
Cycle 1: ✓ Complete (appendSoundRecords index 1→2)
Cycle 2: ✓ Complete (appendSoundRecords index 2→3)
...
Cycle 9: ✓ Complete (appendSoundRecords index 9→10)
Cycle 10: ❌ HANGS - no further output
```

### Diagnostic Output from Debug Session

The last messages before hanging:

```
DEBUG appendSoundRecords: START (index=9, max=500)
DEBUG appendSoundRecords: cudaDeviceSynchronize before kernel
DEBUG appendSoundRecords: Launching copyKernel
DEBUG appendSoundRecords: cudaDeviceSynchronize after kernel
DEBUG appendSoundRecords: cudaDeviceSynchronize completed
DEBUG appendSoundRecords: DONE (new index=10)
[FREEZE - no more output]
```

### Analysis

1. **Cycle 9 completes successfully**: All debug output appears, including the final "DONE (new index=10)"
2. **Cycle 10 never starts**: No "Starting cycle 10/2250" message appears (from the planned debug code)
3. **Not a CUDA error**: All `cudaDeviceSynchronize()` calls complete successfully
4. **Not a slow operation**: First 10 cycles execute rapidly (< 1 second total)
5. **Audio collection works**: `rawSound` vector grows successfully (0 → 256 → 512 → ... → 2816 samples)

### Key Observations

- **Exact cycle count**: Always hangs after cycle 9 (never 8, never 11)
- **Clean completion**: Cycle 9 fully completes all operations
- **Hang location**: Between end of cycle 9 and start of cycle 10
- **No error messages**: No CUDA errors, no exceptions, no crashes

### Likely Causes

The hang occurs **between cycles** (after cycle 9 ends, before cycle 10 begins), suggesting:

1. **Event processing deadlock**: A MIDI event at cycle 10 might trigger a blocking operation
   - Possibility: The event dispatcher might be waiting on a lock or callback
   - Possibility: A note_on event might be triggering parameter loading that blocks

2. **Memory allocation issue**: The `rawSound` vector might be hitting a threshold
   - At cycle 10: rawSound size = 2560 floats ≈ 10 KB (unlikely to cause issues)
   - But: `std::vector::insert()` might reallocate and block temporarily

3. **Backend communication**: The Flask server or Python/C++ boundary might be blocking
   - The HTTP request might time out
   - A health check request appears at cycle 10 timing

4. **Thread synchronization**: Race condition in async operations
   - UnifiedGpuMemoryManager update poll thread might conflict
   - Event queue might have thread safety issues

5. **Hidden buffer overflow**: Some internal buffer hits limit at cycle 10
   - Possibility: A fixed-size buffer not checked by diagnostic code

### Why Exactly Cycle 10?

The number 10 is suspicious and might be related to:
- A hardcoded limit or threshold in event processing
- A buffer size set to 10 elements
- A timing coincidence with background threads
- The first "significant" MIDI event in elise.mid occurring around cycle 10

---

## Next Steps to Debug

To identify the exact hang location, add diagnostic output to:

1. **Main render loop** (`OfflinePlaybackEngine.cu`):
   ```cpp
   while (current_cycle_ < total_cycles && !stop_requested_.load()) {
       printf("DEBUG: Starting cycle %u\n", current_cycle_);
       processEventsAtCycle(current_cycle_);
       printf("DEBUG: Events processed\n");
       runCycle();
       printf("DEBUG: Cycle complete\n");
       // ...
   }
   ```

2. **Event processing** (`processEventsAtCycle()`):
   ```cpp
   std::vector<PlaybackEvent> events = event_queue_.getEventsAtCycle(cycle);
   printf("DEBUG: Cycle %u has %zu events\n", cycle, events.size());
   for (const auto& event : events) {
       printf("DEBUG: Dispatching event type=%d\n", event.type);
       applyEvent(event);
       printf("DEBUG: Event dispatched\n");
   }
   ```

3. **Check MIDI event timing**: Print all events and their cycle numbers during loading
   ```python
   for event in events:
       print(f"Event at cycle {event.cycle}: {event.type} pitch={event.pitch}")
   ```

4. **Monitor memory growth**: Track `rawSound.size()` and `rawSound.capacity()` during execution

5. **Thread activity**: Check if background threads (UnifiedGpuMemoryManager poll thread) are active

---

## Workarounds to Try

1. **Skip `appendSoundRecords()`**: Comment out this call to see if it's related
2. **Reduce cycle count**: Test with `max_seconds=0.5` to see if it hangs at cycle 10 or proportionally earlier
3. **Empty MIDI file**: Test with a MIDI file containing no events
4. **Single note**: Test with a MIDI file containing only one note_on at cycle 0
5. **Disable event processing**: Skip `processEventsAtCycle()` to isolate GPU operations

---

## Code State

All diagnostic code has been reverted to the last commit. To re-apply diagnostics:

```bash
# The diagnostic changes are documented above and can be re-added manually
# Focus on the render loop and event processing first
```

---

## Related Files

- [pianoid_cuda/OfflinePlaybackEngine.cu](pianoid_cuda/OfflinePlaybackEngine.cu) - Main render loop
- [pianoid_cuda/Pianoid.cu](pianoid_cuda/Pianoid.cu) - Audio collection functions
- [pianoid_middleware/chartFunctions.py](pianoid_middleware/chartFunctions.py) - MIDI loading and chart function
- [OFFLINE_PLAYBACK_CRASH_FIX.md](OFFLINE_PLAYBACK_CRASH_FIX.md) - Previous crash fix documentation
- [IMPLEMENTATION_SUMMARY_OFFLINE_MIDI_CHART.md](IMPLEMENTATION_SUMMARY_OFFLINE_MIDI_CHART.md) - Implementation details
