# Phase E: Online EventQueue Integration - Implementation Plan

**Date**: 2025-10-25
**Status**: ✅ **COMPLETED & FINALIZED** (commits: f73c7bf → ec98e8b)
**Final Version**: v3.0 (always-on unified playback)
**Actual Effort**: 1 week implementation + 1 day cleanup
**Prerequisites**: ✅ SDL3 latency resolved (commit fc2f3e2)

---

## ✅ Implementation Status (Finalized 2025-10-26)

**Phase E is now fully implemented, tested, and finalized!** The unified EventQueue architecture is the **only** online playback system in v3.0. All legacy code has been removed.

### What Was Delivered

✅ **Core C++ Components** (commit f73c7bf)
- `RealTimeEventBuffer`: Thread-safe event scheduling with O(log n) insertion
- `CycleTimeEstimator`: Wall-clock to cycle mapping with drift correction
- Enhanced `OnlinePlaybackEngine`: Unified event processing at each cycle
- Fixed `EventDispatcher`: Proper NOTE_OFF damper handling

✅ **Python Integration** (commits f73c7bf, 5f54762, bf4f82e, 1a21ca7)
- ~~Feature flag: `PIANOID_UNIFIED_PLAYBACK` environment variable~~ (removed in v3.0)
- Auto-routing from all entry points (start_pianoid, start_realtime_playback)
- Enhanced REST API with backward compatibility
- Real-time event scheduling API: `add_realtime_event()`

✅ **Performance Fixes** (commit 00b7717)
- Fixed ~140-150 cycle drift (timer start after audio init)
- Rapid startup calibration (first 10 cycles)
- Drift now stays within ±5 cycles (target achieved)

✅ **Legacy Code Removal** (commits bf4f82e, 1a21ca7, ec98e8b)
- Removed 206 lines of Python legacy code
- Removed 340 lines of C++ legacy code
- Removed 4 legacy methods: `processMidiPoints()`, `runMainApplication()`, `playMidiRecord()`, `midiListener()`
- Total cleanup: **546 lines removed**

✅ **Testing Results**
- ✓ Notes play with correct pitch mapping
- ✓ NOTE_OFF properly closes dampers (strings stop)
- ✓ Cycle-accurate event scheduling (±5 cycles / ±6.67ms)
- ✓ All entry points route to unified system
- ✓ No legacy code paths remain

### How to Use (v3.0+)

**No configuration needed!** Unified EventQueue playback is always enabled in v3.0+.

Simply start the application normally:
```python
pianoid.start_realtime_playback()  # Uses unified system automatically
```

---

## Executive Summary

This document provides a comprehensive implementation plan for **Phase E**: Migrating online/real-time playback to use the EventQueue system, completing the playback unification that was partially implemented in Phases 1-4.

### Current State

**Offline playback**: ✅ Fully unified through EventQueue
**Online playback**: ❌ Uses legacy `runMainApplication()` loop with direct API calls

### Goal

Unify both playback modes to use the same EventQueue architecture, achieving:
- Consistent event handling for online and offline modes
- Cycle-accurate timing for real-time input
- Event logging and debugging capabilities
- Reproducible playback sequences
- Foundation for advanced features (event recording/replay, undo/redo)

---

## Table of Contents

1. [Problem Analysis](#problem-analysis)
2. [Architecture Design](#architecture-design)
3. [Implementation Steps](#implementation-steps)
4. [API Design](#api-design)
5. [Thread Safety](#thread-safety)
6. [Testing Strategy](#testing-strategy)
7. [Migration Path](#migration-path)
8. [Risk Mitigation](#risk-mitigation)
9. [Performance Considerations](#performance-considerations)
10. [Timeline and Milestones](#timeline-and-milestones)

---

## Problem Analysis

### Current Online Playback Flow

```
REST API (/play, /stop, etc.)
    ↓
perform_midi_command(cmd, data1, data2)
    ↓
Direct Pianoid API calls:
  - noteOn(pitch, velocity)
  - noteOff(pitch)
  - processSustain(value)
    ↓
runMainApplication() loop
    ↓
GPU synthesis
```

**Problems**:
1. ❌ No EventQueue - events execute immediately
2. ❌ No cycle-accurate timing - wall-clock based
3. ❌ Cannot replay event sequences
4. ❌ No event logging/debugging
5. ❌ Offline/online inconsistency

### Desired Flow

```
REST API (/play, /stop, etc.)
    ↓
EventQueue.addEvent(event, cycle)
    ↓
OnlinePlaybackEngine
    ↓
processEventsAtCycle(current_cycle)
    ↓
EventDispatcher
    ↓
Pianoid API
    ↓
GPU synthesis
```

**Benefits**:
1. ✅ Unified event handling
2. ✅ Cycle-accurate timing
3. ✅ Event replay capability
4. ✅ Event logging/debugging
5. ✅ Consistent with offline mode

---

## Architecture Design

### Component Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     INPUT LAYER                              │
├─────────────────────────────────────────────────────────────┤
│  REST API         MIDI Listener      Chart Functions        │
│     ↓                   ↓                    ↓               │
│     └──────────────────┬────────────────────┘               │
│                        ↓                                      │
│              RealTimeEventBuffer                             │
│              (thread-safe queue)                             │
└────────────────────────┬───────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   PROCESSING LAYER                           │
├─────────────────────────────────────────────────────────────┤
│                OnlinePlaybackEngine                          │
│                         │                                     │
│   ┌─────────────────────┼─────────────────────┐            │
│   │                     │                     │            │
│   ▼                     ▼                     ▼            │
│ EventQueue    EventDispatcher    CycleExecutor            │
│   │                     │                     │            │
│   └─────────────────────┼─────────────────────┘            │
│                         ↓                                     │
└────────────────────────┬───────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                  SYNTHESIS LAYER                             │
├─────────────────────────────────────────────────────────────┤
│                    Pianoid API                               │
│  (noteOn, noteOff, processSustain, setParameter, etc.)     │
│                         │                                     │
│                         ▼                                     │
│                   GPU Kernels                                │
└─────────────────────────────────────────────────────────────┘
```

### Key Components

#### 1. RealTimeEventBuffer (NEW)

**Purpose**: Thread-safe buffer for events arriving from multiple sources

**Interface**:
```cpp
class RealTimeEventBuffer {
public:
    // Thread-safe event insertion
    void pushEvent(const PlaybackEvent& event, uint32_t target_cycle);

    // Drain events scheduled for cycles up to current_cycle
    std::vector<PlaybackEvent> drainEventsUpTo(uint32_t current_cycle);

    // Check if events are pending
    bool hasPendingEvents() const;

private:
    std::mutex mutex_;
    std::multimap<uint32_t, PlaybackEvent> event_buffer_;  // Sorted by cycle
};
```

**Thread Safety**:
- Multiple producers (REST API threads, MIDI listener)
- Single consumer (OnlinePlaybackEngine)
- Lock-free reads using atomic counters
- Minimal lock contention (insert-only with cycle prediction)

#### 2. Enhanced OnlinePlaybackEngine

**Current Implementation**: Basic structure exists but not used
**Enhancement Needed**: Real-time event integration

**Key Methods**:
```cpp
class OnlinePlaybackEngine : public IPlaybackEngine {
public:
    // Initialize with real-time buffer
    void initialize(Pianoid* pianoid, const PlaybackConfig& config) override;

    // Load pre-scheduled events (e.g., from MIDI file for hybrid mode)
    void loadEvents(const EventQueue& events) override;

    // NEW: Set real-time event buffer
    void setRealTimeBuffer(RealTimeEventBuffer* buffer);

    // Main playback loop (runs in dedicated thread)
    PlaybackStats run() override;

private:
    // NEW: Process events from both sources
    void processEventsAtCycle(uint32_t cycle);

    RealTimeEventBuffer* realtime_buffer_;  // Real-time events
    EventQueue event_queue_;                 // Pre-scheduled events
};
```

**Event Processing**:
```cpp
void OnlinePlaybackEngine::processEventsAtCycle(uint32_t cycle) {
    // 1. Drain real-time events scheduled for this cycle
    auto realtime_events = realtime_buffer_->drainEventsUpTo(cycle);

    // 2. Get pre-scheduled events for this cycle
    auto scheduled_events = event_queue_.getEventsAtCycle(cycle);

    // 3. Merge and sort by priority
    std::vector<PlaybackEvent> all_events;
    all_events.insert(all_events.end(), realtime_events.begin(), realtime_events.end());
    all_events.insert(all_events.end(), scheduled_events.begin(), scheduled_events.end());

    // 4. Dispatch all events
    for (const auto& event : all_events) {
        dispatcher_->dispatch(event);
    }
}
```

#### 3. Cycle Time Estimator (NEW)

**Purpose**: Estimate current synthesis cycle based on elapsed time

**Interface**:
```cpp
class CycleTimeEstimator {
public:
    void start(uint32_t sample_rate, uint32_t samples_per_cycle);

    uint32_t getCurrentCycle() const;
    uint32_t predictCycleForDelay(double delay_ms) const;

    void syncToCycle(uint32_t actual_cycle);  // Calibration

private:
    std::chrono::steady_clock::time_point start_time_;
    uint32_t sample_rate_;
    uint32_t samples_per_cycle_;
    std::atomic<int32_t> drift_offset_;  // Drift correction
};
```

**Implementation**:
```cpp
uint32_t CycleTimeEstimator::getCurrentCycle() const {
    auto now = std::chrono::steady_clock::now();
    auto elapsed = std::chrono::duration_cast<std::chrono::microseconds>(now - start_time_);

    // Calculate cycle from elapsed time
    double cycle_time_us = (samples_per_cycle_ * 1000000.0) / sample_rate_;
    uint32_t estimated_cycle = static_cast<uint32_t>(elapsed.count() / cycle_time_us);

    // Apply drift correction
    return estimated_cycle + drift_offset_.load();
}
```

**Drift Calibration**:
- Periodically compare estimated cycle vs actual cycle from engine
- Adjust drift_offset to minimize error
- Target: ±1 cycle accuracy

---

## Implementation Steps

### Step 1: Foundation (Week 1)

#### 1.1 Create RealTimeEventBuffer
**File**: `pianoid_cuda/RealTimeEventBuffer.h/cu`

```cpp
class RealTimeEventBuffer {
public:
    void pushEvent(const PlaybackEvent& event, uint32_t target_cycle);
    std::vector<PlaybackEvent> drainEventsUpTo(uint32_t current_cycle);
    bool hasPendingEvents() const;
    size_t size() const;

private:
    mutable std::mutex mutex_;
    std::multimap<uint32_t, PlaybackEvent> event_buffer_;
    std::atomic<size_t> pending_count_{0};
};
```

**Testing**:
- Unit test: Single-threaded insert/drain
- Unit test: Multi-threaded insert (10 threads, 1000 events each)
- Unit test: Drain with empty buffer
- Performance test: Insert latency < 10μs

#### 1.2 Create CycleTimeEstimator
**File**: `pianoid_cuda/CycleTimeEstimator.h/cu`

```cpp
class CycleTimeEstimator {
public:
    void start(uint32_t sample_rate, uint32_t samples_per_cycle);
    uint32_t getCurrentCycle() const;
    uint32_t predictCycleForDelay(double delay_ms) const;
    void syncToCycle(uint32_t actual_cycle);
    int32_t getDriftOffset() const;

private:
    std::chrono::steady_clock::time_point start_time_;
    uint32_t sample_rate_{48000};
    uint32_t samples_per_cycle_{64};
    std::atomic<int32_t> drift_offset_{0};
    mutable std::mutex sync_mutex_;
};
```

**Testing**:
- Unit test: Cycle estimation accuracy (±1 cycle over 10 seconds)
- Unit test: Drift correction
- Performance test: getCurrentCycle() < 1μs

#### 1.3 Update PlaybackEvent with Timestamp
**File**: `pianoid_cuda/PlaybackEvent.h`

```cpp
struct PlaybackEvent {
    EventType type;
    uint32_t cycle;
    uint64_t timestamp_us;  // NEW: For logging/debugging

    // ... existing fields ...

    void setTimestamp() {
        auto now = std::chrono::steady_clock::now();
        timestamp_us = std::chrono::duration_cast<std::chrono::microseconds>(
            now.time_since_epoch()).count();
    }
};
```

### Step 2: Engine Enhancement (Week 2)

#### 2.1 Enhance OnlinePlaybackEngine
**File**: `pianoid_cuda/OnlinePlaybackEngine.h/cu`

**Changes**:
```cpp
class OnlinePlaybackEngine : public IPlaybackEngine {
public:
    // NEW: Set real-time event buffer
    void setRealTimeBuffer(RealTimeEventBuffer* buffer);

    // NEW: Get cycle estimator for external use
    CycleTimeEstimator* getCycleEstimator();

private:
    // ENHANCED: Process events from both sources
    void processEventsAtCycle(uint32_t cycle);

    RealTimeEventBuffer* realtime_buffer_ = nullptr;
    std::unique_ptr<CycleTimeEstimator> cycle_estimator_;

    // Statistics
    struct Stats {
        uint32_t total_events_processed = 0;
        uint32_t realtime_events = 0;
        uint32_t scheduled_events = 0;
        double avg_event_latency_ms = 0.0;
    } stats_;
};
```

**Implementation**:
```cpp
void OnlinePlaybackEngine::run() {
    cycle_estimator_ = std::make_unique<CycleTimeEstimator>();
    cycle_estimator_->start(config_.sample_rate, config_.samples_per_cycle);

    uint32_t current_cycle = 0;
    start_time_ = std::chrono::steady_clock::now();

    while (running_.load()) {
        // Process events from both sources
        processEventsAtCycle(current_cycle);

        // Execute synthesis cycle
        int status = PlaybackCycleExecutor::executeCycle(pianoid_, config_.record_to_buffer);
        if (status != 200) break;

        // Periodic drift calibration
        if (current_cycle % 100 == 0) {
            cycle_estimator_->syncToCycle(current_cycle);
        }

        current_cycle++;
    }
}

void OnlinePlaybackEngine::processEventsAtCycle(uint32_t cycle) {
    std::vector<PlaybackEvent> all_events;

    // 1. Get real-time events
    if (realtime_buffer_) {
        auto rt_events = realtime_buffer_->drainEventsUpTo(cycle);
        all_events.insert(all_events.end(), rt_events.begin(), rt_events.end());
        stats_.realtime_events += rt_events.size();
    }

    // 2. Get pre-scheduled events
    auto sched_events = event_queue_.getEventsAtCycle(cycle);
    all_events.insert(all_events.end(), sched_events.begin(), sched_events.end());
    stats_.scheduled_events += sched_events.size();

    // 3. Dispatch all events
    for (const auto& event : all_events) {
        dispatcher_->dispatch(event);
        stats_.total_events_processed++;
    }
}
```

#### 2.2 Python Bindings
**File**: `pianoid_cuda/AddArraysWithCUDA.cpp`

**New bindings**:
```cpp
// RealTimeEventBuffer
py::class_<PianoidPlayback::RealTimeEventBuffer>(m, "RealTimeEventBuffer")
    .def(py::init<>())
    .def("pushEvent", &PianoidPlayback::RealTimeEventBuffer::pushEvent)
    .def("drainEventsUpTo", &PianoidPlayback::RealTimeEventBuffer::drainEventsUpTo)
    .def("hasPendingEvents", &PianoidPlayback::RealTimeEventBuffer::hasPendingEvents)
    .def("size", &PianoidPlayback::RealTimeEventBuffer::size);

// CycleTimeEstimator
py::class_<PianoidPlayback::CycleTimeEstimator>(m, "CycleTimeEstimator")
    .def(py::init<>())
    .def("start", &PianoidPlayback::CycleTimeEstimator::start)
    .def("getCurrentCycle", &PianoidPlayback::CycleTimeEstimator::getCurrentCycle)
    .def("predictCycleForDelay", &PianoidPlayback::CycleTimeEstimator::predictCycleForDelay)
    .def("syncToCycle", &PianoidPlayback::CycleTimeEstimator::syncToCycle)
    .def("getDriftOffset", &PianoidPlayback::CycleTimeEstimator::getDriftOffset);
```

### Step 3: Middleware Integration (Week 3)

#### 3.1 Update Pianoid Middleware
**File**: `pianoid_middleware/pianoid.py`

**New Method**:
```python
def start_realtime_playback_unified(self, with_midi_listener=False):
    """Start real-time playback using OnlinePlaybackEngine with EventQueue.

    This is the Phase E unified API that routes all playback through EventQueue.
    """
    if self._lifecycle_state not in [PianoidState.PARAMETERS_LOADED, PianoidState.PAUSED]:
        raise RuntimeError(
            f"Cannot start playback in state {self._lifecycle_state.name}. "
            f"Must call initialize_pianoid() first."
        )

    # Create real-time event buffer
    self.realtime_buffer = pianoidCuda.RealTimeEventBuffer()

    # Create playback config
    config = pianoidCuda.PlaybackConfig()
    config.sample_rate = self.sample_rate
    config.samples_per_cycle = self.samples_in_cycle
    config.audio_enabled = True
    config.record_to_buffer = False
    config.max_duration_ms = 0  # Infinite

    # Create and configure engine
    self.online_engine = pianoidCuda.OnlinePlaybackEngine()
    self.online_engine.initialize(self.pianoid, config)
    self.online_engine.setRealTimeBuffer(self.realtime_buffer)

    # Start engine in background thread
    def run_online():
        try:
            stats = self.online_engine.run()
            print(f"Online playback completed: {stats.total_cycles} cycles")
        except Exception as e:
            print(f"ERROR in online playback: {e}")
            import traceback
            traceback.print_exc()

    self.application_thread = threading.Thread(target=run_online, daemon=False)
    self.application_thread.start()

    # Start MIDI listener if requested
    if with_midi_listener:
        self.start_midi_listener()

    self._lifecycle_state = PianoidState.PLAYBACK_ACTIVE
    print(f"✓ Unified realtime playback started")
```

**New Event Insertion Method**:
```python
def add_realtime_event(self, event_type, data1, data2=0, delay_ms=0):
    """Add a real-time event to the EventQueue.

    Args:
        event_type: pianoidCuda.EventType (NOTE_ON, NOTE_OFF, SUSTAIN, etc.)
        data1: Primary data (pitch for notes, controller for CC)
        data2: Secondary data (velocity for notes, value for CC)
        delay_ms: Optional delay in milliseconds (default: schedule for next cycle)
    """
    if not hasattr(self, 'realtime_buffer'):
        raise RuntimeError("Realtime buffer not initialized. Call start_realtime_playback_unified() first.")

    # Get cycle estimator from engine
    estimator = self.online_engine.getCycleEstimator()

    # Calculate target cycle
    if delay_ms > 0:
        target_cycle = estimator.predictCycleForDelay(delay_ms)
    else:
        target_cycle = estimator.getCurrentCycle() + 1  # Next cycle

    # Create and insert event
    event = self._create_playback_event(event_type, data1, data2)
    event.setTimestamp()
    self.realtime_buffer.pushEvent(event, target_cycle)

    print(f"Event scheduled: {event_type} at cycle {target_cycle}")

def _create_playback_event(self, event_type, data1, data2):
    """Helper to create PlaybackEvent objects."""
    if event_type == pianoidCuda.EventType.NOTE_ON:
        return pianoidCuda.NoteEvent.createNoteOn(data1, data2, 0)
    elif event_type == pianoidCuda.EventType.NOTE_OFF:
        return pianoidCuda.NoteEvent.createNoteOff(data1, 0)
    elif event_type == pianoidCuda.EventType.SUSTAIN:
        return pianoidCuda.SustainEvent(data1, 0)
    # ... other event types ...
```

#### 3.2 Update REST API Endpoints
**File**: `pianoid_middleware/backendServer.py`

**New Endpoint**:
```python
@app.route('/play_unified', methods=['POST'])
def play_unified():
    """Play note using unified EventQueue system (Phase E)."""
    data = request.get_json()
    pitch = data.get('pitch')
    velocity = data.get('velocity', 100)
    delay_ms = data.get('delay_ms', 0)

    try:
        pianoid.add_realtime_event(
            pianoidCuda.EventType.NOTE_ON,
            pitch,
            velocity,
            delay_ms
        )
        return jsonify({
            'status': 'success',
            'message': f'Note {pitch} scheduled'
        })
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500

@app.route('/stop_unified', methods=['POST'])
def stop_unified():
    """Stop note using unified EventQueue system (Phase E)."""
    data = request.get_json()
    pitch = data.get('pitch')

    try:
        pianoid.add_realtime_event(
            pianoidCuda.EventType.NOTE_OFF,
            pitch,
            0,
            0
        )
        return jsonify({
            'status': 'success',
            'message': f'Note {pitch} stopped'
        })
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': str(e)
        }), 500
```

**Backward Compatibility**:
```python
# Keep old endpoints but route to new system
@app.route('/play', methods=['POST'])
def play():
    """Legacy endpoint - routes to unified system."""
    data = request.get_json()
    pitch = data.get('pitch')
    velocity = data.get('velocity', 100)

    # Detect if using legacy or unified system
    if hasattr(pianoid, 'realtime_buffer'):
        # Use unified system
        return play_unified()
    else:
        # Fall back to legacy
        pianoid.perform_midi_command(144, pitch, velocity)
        return jsonify({'status': 'success'})
```

### Step 4: Testing & Validation (Week 4)

#### 4.1 Unit Tests

**Test File**: `test_realtime_eventqueue.py`

```python
def test_realtime_buffer_thread_safety():
    """Test RealTimeEventBuffer with concurrent access."""
    buffer = pianoidCuda.RealTimeEventBuffer()

    def producer(id, count):
        for i in range(count):
            event = create_test_event(id, i)
            buffer.pushEvent(event, i)

    # 10 threads, 100 events each
    threads = [threading.Thread(target=producer, args=(i, 100)) for i in range(10)]
    for t in threads: t.start()
    for t in threads: t.join()

    assert buffer.size() == 1000

def test_cycle_estimator_accuracy():
    """Test cycle estimation accuracy over time."""
    estimator = pianoidCuda.CycleTimeEstimator()
    estimator.start(48000, 64)  # 48kHz, 64 samples per cycle

    time.sleep(1.0)  # Wait 1 second

    estimated = estimator.getCurrentCycle()
    expected = int(48000 / 64)  # ~750 cycles per second

    # Allow ±5 cycles error
    assert abs(estimated - expected) < 5

def test_online_engine_event_processing():
    """Test OnlinePlaybackEngine processes real-time events."""
    # ... test implementation ...
```

#### 4.2 Integration Tests

**Test Scenarios**:
1. Single note play/stop via REST API
2. Rapid note sequence (10 notes/second for 10 seconds)
3. Sustain pedal integration
4. MIDI listener thread integration
5. Mixed real-time and pre-scheduled events
6. Stress test: 100 concurrent REST API requests

#### 4.3 Performance Benchmarks

**Metrics to Measure**:
- Event insertion latency (target: < 10μs)
- Event processing latency (target: < 100μs per cycle)
- Cycle estimation accuracy (target: ±1 cycle)
- Drift over time (target: < 10 cycles per hour)
- Audio latency (target: < 10ms end-to-end)

---

## API Design

### C++ API

```cpp
namespace PianoidPlayback {

// Real-time event buffer
class RealTimeEventBuffer {
public:
    void pushEvent(const PlaybackEvent& event, uint32_t target_cycle);
    std::vector<PlaybackEvent> drainEventsUpTo(uint32_t current_cycle);
    bool hasPendingEvents() const;
    size_t size() const;
};

// Cycle time estimation
class CycleTimeEstimator {
public:
    void start(uint32_t sample_rate, uint32_t samples_per_cycle);
    uint32_t getCurrentCycle() const;
    uint32_t predictCycleForDelay(double delay_ms) const;
    void syncToCycle(uint32_t actual_cycle);
    int32_t getDriftOffset() const;
};

// Enhanced online engine
class OnlinePlaybackEngine : public IPlaybackEngine {
public:
    void setRealTimeBuffer(RealTimeEventBuffer* buffer);
    CycleTimeEstimator* getCycleEstimator();
    PlaybackStats run() override;
};

} // namespace PianoidPlayback
```

### Python API

```python
# High-level API (recommended)
pianoid.start_realtime_playback_unified(with_midi_listener=True)
pianoid.add_realtime_event(EventType.NOTE_ON, pitch=60, velocity=100)
pianoid.add_realtime_event(EventType.NOTE_OFF, pitch=60)

# Low-level API (for advanced use)
buffer = pianoidCuda.RealTimeEventBuffer()
estimator = pianoidCuda.CycleTimeEstimator()
engine = pianoidCuda.OnlinePlaybackEngine()

engine.setRealTimeBuffer(buffer)
cycle = estimator.getCurrentCycle()
buffer.pushEvent(event, cycle + 10)
```

### REST API

```bash
# New unified endpoints
POST /play_unified
{
    "pitch": 60,
    "velocity": 100,
    "delay_ms": 0  # Optional
}

POST /stop_unified
{
    "pitch": 60
}

# Legacy endpoints (auto-detect system)
POST /play
POST /stop
```

---

## Thread Safety

### Threading Model

```
Main Thread
    │
    ├── REST API Server (Flask)
    │   └── Multiple request handlers (concurrent)
    │
    ├── MIDI Listener Thread
    │   └── Continuous MIDI input processing
    │
    └── Playback Thread
        └── OnlinePlaybackEngine::run()
            ├── processEventsAtCycle()
            └── PlaybackCycleExecutor::executeCycle()
```

### Synchronization Strategy

**RealTimeEventBuffer**:
- Mutex-protected multimap for event storage
- Lock-free atomic counter for size queries
- Short critical sections (< 1μs typical)

**CycleTimeEstimator**:
- Atomic drift_offset for lock-free reads
- Mutex-protected sync operations (infrequent)

**OnlinePlaybackEngine**:
- Single consumer pattern (only playback thread reads)
- Multiple producers pattern (API threads, MIDI thread)
- No locks in hot path (processEventsAtCycle)

### Deadlock Prevention

1. **Lock Ordering**: Always acquire locks in consistent order
2. **Minimal Lock Scope**: Hold locks only for data structure access
3. **No Nested Locks**: RealTimeEventBuffer never calls user code under lock
4. **Timeout on Waits**: All condition_variable waits have timeout

---

## Testing Strategy

### Unit Tests (Week 4, Days 1-2)

**Coverage Target**: > 90%

1. **RealTimeEventBuffer**:
   - Single-threaded operations
   - Multi-threaded concurrent access (10 threads)
   - Edge cases (empty buffer, drain with no events)
   - Performance test (insert latency < 10μs)

2. **CycleTimeEstimator**:
   - Basic cycle calculation
   - Drift correction
   - Prediction accuracy
   - Performance test (getCurrentCycle < 1μs)

3. **OnlinePlaybackEngine**:
   - Event processing from buffer
   - Event processing from queue
   - Mixed event processing
   - Drift calibration

### Integration Tests (Week 4, Days 3-4)

1. **REST API Integration**:
   - Single note play/stop
   - Rapid sequence (100 events/second)
   - Concurrent requests (10 threads)
   - Error handling

2. **MIDI Listener Integration**:
   - MIDI input processing
   - Event timing accuracy
   - Mixed MIDI + REST API input

3. **End-to-End**:
   - Complete playback session
   - Start/stop/pause/resume
   - Memory leak check (valgrind)
   - Long-running stability (24 hours)

### Performance Tests (Week 4, Day 5)

**Metrics**:
- Event insertion latency: P50, P95, P99
- Event processing latency: Average per cycle
- Cycle estimation drift: Over 1 hour, 24 hours
- Audio latency: End-to-end (input to sound)
- Memory usage: Baseline, under load, after load

**Load Test Scenarios**:
1. Sustained 100 events/second for 1 hour
2. Burst: 1000 events in 1 second
3. Mixed: Random events, 10-200/second for 10 minutes

---

## Migration Path

### Phase E.1: Feature Flag (Week 1)

Add feature flag to toggle between legacy and unified systems:

```python
# pianoid_middleware/pianoid.py
USE_UNIFIED_PLAYBACK = os.getenv('PIANOID_UNIFIED_PLAYBACK', 'false').lower() == 'true'

def start_realtime_playback(self, with_midi_listener=False):
    if USE_UNIFIED_PLAYBACK:
        return self.start_realtime_playback_unified(with_midi_listener)
    else:
        return self.start_realtime_playback_legacy(with_midi_listener)
```

### Phase E.2: Parallel Implementation (Weeks 2-3)

- Implement unified system alongside legacy
- Both systems functional and testable
- Can switch via environment variable
- No breaking changes

### Phase E.3: Testing & Validation (Week 4)

- Test unified system extensively
- Compare behavior with legacy system
- Performance benchmarking
- Bug fixes and refinements

### Phase E.4: Gradual Rollout (v2.0)

1. **v2.0-beta**: Unified system available, legacy default
2. **v2.0-rc**: Unified system default, legacy available
3. **v2.0**: Unified system only, legacy removed

---

## Risk Mitigation

### Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| **Thread safety bugs** | Medium | High | Extensive unit tests, ThreadSanitizer, code review |
| **Timing drift** | Medium | Medium | Periodic calibration, monitoring, adjustment algorithm |
| **Performance regression** | Low | High | Benchmark before/after, profiling, optimization |
| **Audio glitches** | Medium | High | Buffer sizing, underrun detection, graceful degradation |
| **API breaking changes** | Low | Medium | Feature flag, gradual rollout, legacy support |

### Mitigation Strategies

**Thread Safety**:
- Use ThreadSanitizer during development
- Code review focused on synchronization
- Stress tests with 100+ concurrent threads

**Timing Accuracy**:
- Calibrate estimator every 100 cycles
- Monitor drift and log warnings if > 5 cycles
- Fallback to real-time clock if drift excessive

**Performance**:
- Profile before implementation (baseline)
- Profile after each major change
- Keep lock-free hot paths
- Minimize allocations in event processing

**Audio Quality**:
- Increase buffer size if underruns detected
- Graceful silence fill on underrun
- Monitor underrun rate and alert if > 0.1%

---

## Performance Considerations

### Critical Path Analysis

**Hot Path** (executed every cycle, ~750 times/second):
```
processEventsAtCycle()
    ↓
drainEventsUpTo()  ← Mutex lock (brief)
    ↓
getEventsAtCycle()  ← Lock-free read
    ↓
dispatch()  ← Virtual call (small overhead)
```

**Optimizations**:
1. **Lock-free reads** where possible (atomic counters)
2. **Minimal lock scope** (< 1μs)
3. **Pre-allocated buffers** (no malloc in hot path)
4. **Efficient data structures** (std::multimap for O(log n) access)

### Memory Management

**Event Buffer Sizing**:
- Typical: 10-100 events queued
- Peak: 1000 events (burst scenario)
- Memory: ~100KB for 1000 events

**Pre-allocation Strategy**:
- Pre-allocate vector space for common sizes
- Use object pools for PlaybackEvent instances
- Avoid allocations in processEventsAtCycle()

### Latency Budget

**Total Budget**: < 10ms (end-to-end)

| Component | Budget | Actual (Expected) |
|-----------|--------|-------------------|
| REST API → Event insertion | 1ms | 0.5ms |
| Event queuing | 0.1ms | 0.05ms |
| Event processing | 0.5ms | 0.2ms |
| GPU synthesis | 1.3ms | 1.3ms (64 samples @ 48kHz) |
| Audio buffer | 5ms | 5.3ms (CircularBuffer) |
| Audio driver | 2ms | 2ms (SDL3 callback) |
| **Total** | **10ms** | **~9.4ms** |

---

## Timeline and Milestones

### Week 1: Foundation
- **Days 1-2**: Implement RealTimeEventBuffer
- **Days 3-4**: Implement CycleTimeEstimator
- **Day 5**: Unit tests, documentation

**Deliverable**: Working buffer and estimator with tests

### Week 2: Engine Enhancement
- **Days 1-2**: Enhance OnlinePlaybackEngine
- **Days 3-4**: Python bindings
- **Day 5**: Integration tests

**Deliverable**: Enhanced engine with Python API

### Week 3: Middleware Integration
- **Days 1-2**: Update pianoid.py middleware
- **Days 3-4**: Update REST API endpoints
- **Day 5**: Feature flag and backward compatibility

**Deliverable**: Complete unified system with feature flag

### Week 4: Testing & Validation
- **Days 1-2**: Unit tests (90%+ coverage)
- **Days 3-4**: Integration tests
- **Day 5**: Performance benchmarking

**Deliverable**: Tested and benchmarked implementation

### Post-Implementation (v2.0)
- **Beta testing**: 2-4 weeks
- **Bug fixes**: 1-2 weeks
- **Documentation**: 1 week
- **Release**: v2.0

---

## Success Criteria

### Functional Requirements

- ✅ All MIDI events route through EventQueue
- ✅ Cycle-accurate timing (±1 cycle)
- ✅ No audio glitches or dropouts
- ✅ REST API latency < 10ms
- ✅ Backward compatible with existing code

### Non-Functional Requirements

- ✅ Event insertion latency < 10μs (P99)
- ✅ No memory leaks (24-hour test)
- ✅ Timing drift < 10 cycles/hour
- ✅ Thread-safe (ThreadSanitizer clean)
- ✅ Unit test coverage > 90%

### Documentation Requirements

- ✅ API documentation (C++ and Python)
- ✅ Migration guide for users
- ✅ Architecture diagrams
- ✅ Performance benchmarks

---

## Open Questions

1. **Event Priority**: How to handle simultaneous events at same cycle?
   - **Proposed**: FIFO order, or add priority field to PlaybackEvent

2. **Event Dropping**: What if buffer overflows (> 10,000 events)?
   - **Proposed**: Warn and drop oldest events, log error

3. **Timing Mode**: Should we support both wall-clock and cycle-accurate modes?
   - **Proposed**: Cycle-accurate only for v2.0, add mode later if needed

4. **Legacy Support**: How long to maintain legacy system?
   - **Proposed**: Remove in v2.0, feature flag for beta period only

---

## References

- [PLAYBACK_SYSTEM_COMPREHENSIVE_AUDIT.md](PLAYBACK_SYSTEM_COMPREHENSIVE_AUDIT.md) - Current state analysis
- [PLAYBACK_REFACTORING_PLAN.md](docs/historical/planning/PLAYBACK_REFACTORING_PLAN.md) - Original Phases 1-5
- [PLAYBACK_STATUS_SUMMARY.md](PLAYBACK_STATUS_SUMMARY.md) - Current status
- [SDL3_LATENCY_PROBLEM_SUMMARY.md](docs/historical/bug-fixes/SDL3_LATENCY_PROBLEM_SUMMARY.md) - Latency solution
- [OnlinePlaybackEngine.cu](pianoid_cuda/OnlinePlaybackEngine.cu) - Current implementation
- [EventDispatcher.cu](pianoid_cuda/EventDispatcher.cu) - Event routing

---

**Document Version**: 1.0
**Status**: Planning Phase
**Approval**: Pending
**Next Steps**: Review and approval, then proceed with Week 1 implementation

