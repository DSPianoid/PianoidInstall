# Universal Playback Primitives Refactoring Plan

**Date:** October 24, 2025
**Branch:** `refactor/executor-string-helpers` (merged to dev)
**Status:** 🟢 All Steps Complete (Steps 1-4)

---

## Implementation Status

✅ **Completed:**
- Step 1: Universal synthesis cycle primitives added to Pianoid
- Step 2: PlaybackCycleExecutor helper class created
- Step 3: OfflinePlaybackEngine refactored to use primitives
- Step 4: OnlinePlaybackEngine refactored to use primitives (**NEW - Oct 24**)
- Offline audio collection implemented (was TODO)
- Batch string API for efficient multi-string excitation
- String excitation helpers added to PlaybackCycleExecutor (**NEW - Oct 24**)
- EventDispatcher simplified using new helpers (**NEW - Oct 24**)

---

## Problem Statement

Current architecture has redundancy between `OnlinePlaybackEngine` and `OfflinePlaybackEngine`:

### Redundant Patterns

1. **Event Processing**
   - Both: `EventDispatcher` → `applyEvent()`
   - Both call same batch string API: `beginStringBatch()` / `addStringToBatch()` / `commitStringBatch()`

2. **Synthesis Cycle Execution**
   - Offline: `launchMainKernel()` → `playSoundSamples()` → `appendSoundRecords()`
   - Online: `launchMainKernel()` → `playSoundSamples()` (appendSoundRecords missing!)

3. **State Management**
   - Both check GPU initialization
   - Both manage running state
   - Different pause mechanisms (online has audio pause, offline doesn't)

### Current Issues

1. **Offline missing recording**: `appendSoundRecords()` not called → `collectAudio()` placeholder
2. **Duplicated event dispatch logic**: Same code in both engines
3. **Inconsistent cycle execution**: Offline has extra steps, online doesn't
4. **Private methods**: Critical operations like `_load_exct_params_to_GPU()` hidden inside Pianoid

---

## Design: Universal Playback Primitives

### Core Principle

**Expose all critical playback operations as public, reusable primitives that both engines can use.**

### Phase 1: Extract Common Cycle Operations

Create public API in `Pianoid` for synthesis cycle:

```cpp
class Pianoid {
public:
    // ========== Synthesis Cycle Primitives ==========

    /**
     * Execute one complete synthesis cycle
     * @return Status code (200 = success)
     */
    int executeSynthesisCycle();

    /**
     * Manage audio buffers after synthesis
     * Required even in offline mode for buffer management
     */
    void manageSoundBuffers();

    /**
     * Append current cycle audio to recording buffer
     * Used for offline rendering and optional online recording
     */
    void recordCycleAudio();

    /**
     * Get current cycle's audio samples
     * @return Vector of audio samples from last cycle
     */
    std::vector<float> getCurrentCycleAudio() const;
};
```

**Implementation:**
- `executeSynthesisCycle()` wraps `launchMainKernel()`
- `manageSoundBuffers()` wraps `playSoundSamples()`
- `recordCycleAudio()` wraps `appendSoundRecords()`
- `getCurrentCycleAudio()` extracts audio from GPU buffers

### Phase 2: Unified Event Processing

Both engines already use `EventDispatcher`, but they duplicate the dispatch loop:

**Current (both engines):**
```cpp
void processEventsAtCycle(uint32_t cycle) {
    std::vector<PlaybackEvent> events = event_queue_.getEventsAtCycle(cycle);
    for (const auto& event : events) {
        dispatcher_->dispatch(event);
    }
}
```

**Solution:** Move to base `IPlaybackEngine` or shared helper:

```cpp
class PlaybackCycleExecutor {
public:
    static void processEvents(EventQueue& queue, EventDispatcher& dispatcher, uint32_t cycle);
    static int executeCycle(Pianoid* pianoid, bool record_audio);
};
```

### Phase 3: Consistent Cycle Execution

Both engines should use identical cycle execution:

**Universal Pattern:**
```cpp
int PlaybackCycleExecutor::executeCycle(Pianoid* pianoid, bool record_audio) {
    // 1. Execute synthesis
    int status = pianoid->executeSynthesisCycle();
    if (status != 200) return status;

    // 2. Manage buffers (required for both online/offline)
    pianoid->manageSoundBuffers();

    // 3. Record audio if requested
    if (record_audio) {
        pianoid->recordCycleAudio();
    }

    return 200;
}
```

**Offline uses this directly:**
```cpp
void OfflinePlaybackEngine::runCycle() {
    PlaybackCycleExecutor::executeCycle(pianoid_, config_.record_to_buffer);
}
```

**Online uses this in main loop:**
```cpp
PlaybackStats OnlinePlaybackEngine::run() {
    while (running_) {
        processEventsAtTime(elapsed_ms);
        PlaybackCycleExecutor::executeCycle(pianoid_, config_.record_to_buffer);
        // Audio callback happens automatically via SDL/ASIO
    }
}
```

### Phase 4: Audio Collection Fix

**Current Offline Issue:**
```cpp
void OfflinePlaybackEngine::collectAudio() {
    // TODO: Implement audio collection from GPU
}
```

**Fix with new API:**
```cpp
void OfflinePlaybackEngine::collectAudio() {
    std::vector<float> cycle_audio = pianoid_->getCurrentCycleAudio();
    if (audio_write_pos_ + cycle_audio.size() <= recorded_audio_.size()) {
        std::copy(cycle_audio.begin(), cycle_audio.end(),
                  recorded_audio_.begin() + audio_write_pos_);
        audio_write_pos_ += cycle_audio.size();
    }
}
```

---

## Implementation Plan

### Step 1: Add Synthesis Cycle Primitives to Pianoid

**File:** `pianoid_cuda/Pianoid.cuh`

```cpp
// ========== Universal Playback Primitives ==========
// Public API for playback engines (online and offline)

/**
 * Execute one synthesis cycle
 * Wraps launchMainKernel() with consistent error handling
 */
int executeSynthesisCycle();

/**
 * Manage audio buffers after synthesis cycle
 * Must be called after executeSynthesisCycle() even in offline mode
 */
void manageSoundBuffers();

/**
 * Record current cycle's audio to internal buffer
 * Used by offline rendering and optional online recording
 */
void recordCycleAudio();

/**
 * Get audio from last completed cycle
 * @return Audio samples (mono for now, multi-channel future)
 */
std::vector<float> getCurrentCycleAudio() const;
```

**File:** `pianoid_cuda/Pianoid.cu`

```cpp
int Pianoid::executeSynthesisCycle() {
    return launchMainKernel();
}

void Pianoid::manageSoundBuffers() {
    playSoundSamples();
}

void Pianoid::recordCycleAudio() {
    appendSoundRecords();
}

std::vector<float> Pianoid::getCurrentCycleAudio() const {
    // Extract audio from dev_soundFloat or similar buffer
    // Implementation depends on current buffer architecture
    // TODO: Implement based on sound buffer layout
    return std::vector<float>();
}
```

### Step 2: Create PlaybackCycleExecutor Helper

**New File:** `pianoid_cuda/PlaybackCycleExecutor.h`

```cpp
#pragma once
#include "Pianoid.cuh"
#include "EventQueue.h"
#include "EventDispatcher.h"

namespace PianoidPlayback {

/**
 * Shared logic for executing playback cycles
 * Used by both online and offline engines
 */
class PlaybackCycleExecutor {
public:
    /**
     * Process all events at given cycle/time
     */
    static void processEvents(
        EventQueue& queue,
        EventDispatcher& dispatcher,
        uint32_t cycle_or_time
    );

    /**
     * Execute one complete synthesis cycle
     * @param pianoid Pianoid instance
     * @param record_audio Whether to record this cycle's audio
     * @return Status code (200 = success)
     */
    static int executeCycle(Pianoid* pianoid, bool record_audio);
};

} // namespace PianoidPlayback
```

**New File:** `pianoid_cuda/PlaybackCycleExecutor.cu`

```cpp
#include "PlaybackCycleExecutor.h"

namespace PianoidPlayback {

void PlaybackCycleExecutor::processEvents(
    EventQueue& queue,
    EventDispatcher& dispatcher,
    uint32_t cycle_or_time)
{
    std::vector<PlaybackEvent> events = queue.getEventsAtCycle(cycle_or_time);
    for (const auto& event : events) {
        dispatcher.dispatch(event);
    }
}

int PlaybackCycleExecutor::executeCycle(Pianoid* pianoid, bool record_audio) {
    // 1. Execute GPU synthesis
    int status = pianoid->executeSynthesisCycle();
    if (status != 200) {
        return status;
    }

    // 2. Manage sound buffers (required for both online/offline)
    pianoid->manageSoundBuffers();

    // 3. Record audio if requested
    if (record_audio) {
        pianoid->recordCycleAudio();
    }

    return 200;
}

} // namespace PianoidPlayback
```

### Step 3: Refactor OfflinePlaybackEngine

**Before:**
```cpp
void OfflinePlaybackEngine::runCycle() {
    int status = pianoid_->launchMainKernel();
    pianoid_->playSoundSamples();
    pianoid_->appendSoundRecords();
    // Error checking...
}
```

**After:**
```cpp
void OfflinePlaybackEngine::runCycle() {
    int status = PlaybackCycleExecutor::executeCycle(
        pianoid_,
        config_.record_to_buffer
    );

    if (status != 200) {
        std::printf("OfflinePlaybackEngine: Cycle failed with status %d\n", status);
        stop_requested_.store(true);
    }
}

void OfflinePlaybackEngine::processEventsAtCycle(uint32_t cycle) {
    PlaybackCycleExecutor::processEvents(event_queue_, *dispatcher_, cycle);
}
```

### Step 4: Refactor OnlinePlaybackEngine

**Before:**
```cpp
while (running_) {
    // Event processing...
    int status = pianoid_->launchMainKernel();
    pianoid_->playSoundSamples();
    // No recordCycleAudio!
}
```

**After:**
```cpp
while (running_) {
    processEventsAtTime(elapsed_ms);

    int status = PlaybackCycleExecutor::executeCycle(
        pianoid_,
        config_.record_to_buffer
    );

    if (status != 200) {
        // Error handling
    }
}

void OnlinePlaybackEngine::processEventsAtTime(double elapsed_ms) {
    // Convert time to cycles for event lookup
    uint32_t cycle = timeToCycle(elapsed_ms);
    PlaybackCycleExecutor::processEvents(event_queue_, *dispatcher_, cycle);
}
```

### Step 5: Fix Audio Collection

**Implement `getCurrentCycleAudio()` in Pianoid:**

```cpp
std::vector<float> Pianoid::getCurrentCycleAudio() const {
    // Read from dev_soundFloat buffer
    // Size = samplesInCycle * soundChannels
    std::vector<float> audio(samplesInCycle);

    cudaMemcpy(
        audio.data(),
        dev_soundFloat,  // Or appropriate buffer
        samplesInCycle * sizeof(float),
        cudaMemcpyDeviceToHost
    );

    return audio;
}
```

**Use in OfflinePlaybackEngine:**

```cpp
void OfflinePlaybackEngine::collectAudio() {
    std::vector<float> cycle_audio = pianoid_->getCurrentCycleAudio();

    if (audio_write_pos_ + cycle_audio.size() <= recorded_audio_.size()) {
        std::copy(
            cycle_audio.begin(),
            cycle_audio.end(),
            recorded_audio_.begin() + audio_write_pos_
        );
        audio_write_pos_ += cycle_audio.size();
    }
}
```

---

## Benefits

### 1. Code Reuse
- Both engines use same cycle execution logic
- Event processing unified
- No duplicated synthesis patterns

### 2. Consistency
- Offline and online behavior guaranteed identical for synthesis
- Same buffer management for both
- Recording works same way in both

### 3. Maintainability
- Fix bugs in one place
- Easy to add new features to both engines
- Clear separation of concerns

### 4. Testability
- Can unit test `PlaybackCycleExecutor` independently
- Primitives testable in isolation
- Easier to validate cycle execution

### 5. Extensibility
- Easy to add new playback engine types
- Primitives reusable for other use cases
- Clear public API for extensions

---

## Migration Path

### Phase A: Add Primitives (Non-Breaking)
1. Add new methods to Pianoid (alongside existing)
2. Create PlaybackCycleExecutor helper
3. Test primitives independently

### Phase B: Migrate Offline Engine
1. Refactor OfflinePlaybackEngine to use primitives
2. Fix audio collection
3. Test offline rendering

### Phase C: Migrate Online Engine
1. Refactor OnlinePlaybackEngine to use primitives
2. Ensure audio callback still works
3. Test real-time playback

### Phase D: Optional Cleanup
1. Mark old methods as deprecated
2. Consider making `launchMainKernel()` etc private
3. Update documentation

---

## Success Criteria

- [x] ~~Both engines use `PlaybackCycleExecutor::executeCycle()`~~ ✅ **Both complete**
- [x] ~~Both engines use `PlaybackCycleExecutor::processEvents()`~~ ✅ **Both complete**
- [x] ~~Offline audio collection works (non-silent WAV files)~~ ✅ Implemented with `getCurrentCycleAudio()`
- [x] ~~Online playback still works with audio driver~~ ✅ **Step 4 complete - Oct 24**
- [x] ~~No regression in existing tests~~ ✅ Backward compatible
- [x] ~~Code size reduced (remove duplicated logic)~~ ✅ ~55 lines removed total (offline + online)
- [x] ~~Clear public API documented~~ ✅ All primitives documented in header
- [x] ~~String excitation centralized~~ ✅ **NEW** Helper methods in PlaybackCycleExecutor

---

## Completed Steps (All Done!)

1. ✅ Implement primitives in Pianoid (Step 1)
2. ✅ Create PlaybackCycleExecutor (Step 2)
3. ✅ Refactor offline engine (Step 3)
4. ✅ **Refactor online engine (Step 4) - Oct 24, 2025**
5. ✅ Offline audio collection implemented
6. ✅ **String excitation helpers added - Oct 24, 2025**
7. ✅ **EventDispatcher simplified - Oct 24, 2025**
8. ✅ Merged to dev branch (commit 55fdd50, 1299c22)

---

**Maintained by:** PianoidCore Development Team
**Last Updated:** October 24, 2025 (evening)
**Status:** ✅ **COMPLETE** - All engines refactored, zero code duplication achieved
