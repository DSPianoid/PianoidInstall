
# Playback Refactoring Implementation Plan

## Executive Summary

This document outlines a comprehensive 6-phase refactoring plan for the PianoidCore playback system. The refactoring transforms the current real-time-only architecture into a modular, event-driven system supporting both real-time (online) and faster-than-real-time (offline) playback modes.

### Key Objectives

1. **Enable Offline Rendering**: Support cycle-accurate, faster-than-real-time audio rendering to WAV files
2. **Modular Architecture**: Extract playback logic from monolithic `Pianoid.cu` into reusable components
3. **Unified Event System**: Create type-safe, extensible event coding based on extended MIDI
4. **Test Mode Support**: Enable individual string/mode playback with state isolation
5. **Backward Compatibility**: Preserve existing APIs while adding new capabilities

### Timeline

**Total Duration**: 6 weeks
**Resource Requirements**: 1 developer, access to test MIDI files and audio verification tools

---

## Current State Analysis

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Python Middleware                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ pianoid.py   │  │ MidiRecord   │  │ backendServer│      │
│  │              │  │              │  │              │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
└─────────┼──────────────────┼──────────────────┼─────────────┘
          │                  │                  │
          │                  │                  │
          ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────┐
│                      C++/CUDA Core                           │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Pianoid.cu (~2900 lines)                   │ │
│  │  ┌──────────────────────────────────────────────────┐  │ │
│  │  │  runMainApplication()                             │  │ │
│  │  │  - Real-time synthesis loop                       │  │ │
│  │  │  - Audio driver integration                       │  │ │
│  │  │  - Wall-clock timing                              │  │ │
│  │  │  - Mixed concerns (MIDI, audio, synthesis)        │  │ │
│  │  └──────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  UnifiedGpuMemoryManager                               │ │
│  │  - Async parameter updates                             │ │
│  │  - Double-buffered TUNABLE parameters                  │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
          │                  │
          ▼                  ▼
┌──────────────────┐  ┌──────────────────┐
│   SDL Audio      │  │   ASIO Audio     │
│   Driver         │  │   Driver         │
└──────────────────┘  └──────────────────┘
```

### Strengths

✅ **Solid Real-time Performance**: GPU-accelerated synthesis with ~1ms cycle time
✅ **Robust MIDI Integration**: Python middleware handles keyboard input and file playback
✅ **Async Parameter Updates**: Non-blocking updates via `UnifiedGpuMemoryManager`
✅ **Flexible Audio Drivers**: SDL and ASIO support with factory pattern
✅ **Stable Parameter System**: Recent Phase 6 refactoring provides clean foundation

### Critical Gaps

❌ **No Offline Playback Mode**: `runMainApplication()` is real-time only, cannot render faster
❌ **Wall-clock MIDI Timing**: Uses `std::chrono` instead of cycle-accurate sequencing
❌ **No Cycle-accurate Event Injection**: Events can drift under load
❌ **Mixed Playback Logic**: ~2900 lines in `Pianoid.cu` with intertwined concerns
❌ **No Unified Event System**: MIDI handling scattered across Python and C++
❌ **No Individual String/Mode Testing**: Cannot test single strings in isolation

---

## Target Architecture

### High-Level Design

```
┌─────────────────────────────────────────────────────────────┐
│                     Python Middleware                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ pianoid.py   │  │ MidiRecord   │  │ backendServer│      │
│  │ + offline    │  │ + event      │  │ + REST       │      │
│  │   rendering  │  │   packing    │  │   endpoints  │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
└─────────┼──────────────────┼──────────────────┼─────────────┘
          │                  │                  │
          │                  ▼                  │
          │         ┌────────────────┐          │
          │         │  EventQueue    │          │
          │         │  (cycle-       │          │
          │         │   accurate)    │          │
          │         └────────┬───────┘          │
          │                  │                  │
          ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────┐
│                      C++/CUDA Core                           │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Pianoid.cu (refactored)                    │ │
│  │  ┌──────────────────────────────────────────────────┐  │ │
│  │  │  executeSynthesisCycle() [extracted core]        │  │ │
│  │  │  runOnlinePlayback()  [new]                      │  │ │
│  │  │  runOfflinePlayback() [new]                      │  │ │
│  │  │  exportAudioToWav()   [new]                      │  │ │
│  │  └──────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Playback Engine Layer (NEW)                           │ │
│  │  ┌──────────────────┐  ┌──────────────────┐           │ │
│  │  │ OnlinePlayback   │  │ OfflinePlayback  │           │ │
│  │  │ Engine           │  │ Engine           │           │ │
│  │  │ - Real-time      │  │ - Cycle-accurate │           │ │
│  │  │ - Audio driver   │  │ - Buffer only    │           │ │
│  │  │ - Wall-clock     │  │ - Faster render  │           │ │
│  │  └──────────────────┘  └──────────────────┘           │ │
│  └────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Event System (NEW)                                     │ │
│  │  ┌──────────────────┐  ┌──────────────────┐           │ │
│  │  │ EventDispatcher  │  │ PlaybackEvent    │           │ │
│  │  │ - Route events   │  │ - Note on/off    │           │ │
│  │  │   to Pianoid API │  │ - Sustain        │           │ │
│  │  │                  │  │ - Parameters     │           │ │
│  │  │                  │  │ - Test modes     │           │ │
│  │  └──────────────────┘  └──────────────────┘           │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
          │                  │
          ▼                  ▼
┌──────────────────┐  ┌──────────────────┐
│   Audio Driver   │  │   WAV File       │
│   (online only)  │  │   (offline only) │
└──────────────────┘  └──────────────────┘
```

### Key Design Decisions

#### 1. Two Separate Playback Functions

**Decision**: Implement `runOnlinePlayback()` and `runOfflinePlayback()` as separate functions rather than a single parameterized function.

**Rationale**:
- Fundamentally different timing models (wall-clock vs cycle-based)
- Different audio routing (driver vs memory buffer)
- Cleaner separation of concerns
- Easier testing and maintenance
- No runtime overhead from branching logic

#### 2. Extended MIDI Event Coding

**Decision**: Use MIDI-compatible event coding extended with custom event types.

**Rationale**:
- Familiar paradigm for music applications
- Standard MIDI events (0x80-0xB0) for notes and control changes
- Custom range (0xE0-0xEF) for parameter updates
- Test mode range (0xF0-0xFF) for diagnostics
- 16-byte aligned structure for cache efficiency
- Extensible for future event types

#### 3. Cycle-Accurate Offline Timing

**Decision**: Use synthesis cycle indices (not wall-clock time) for offline event scheduling.

**Rationale**:
- Guarantees sample-accurate timing
- No drift under CPU load
- Reproducible renders
- Faster than real-time rendering possible
- Essential for test mode validation

---

## Implementation Plan

### Phase 1: Unified Event System Design

**Duration**: 1 week
**Goal**: Create type-safe, extensible event coding system

#### 1.1 Event Type Hierarchy

Create [`pianoid_cuda/PlaybackEvent.h`](pianoid_cuda/PlaybackEvent.h):

```cpp
namespace PianoidPlayback {

// Base event type enumeration
enum class EventType : uint8_t {
    // Standard MIDI events (0x80-0xBF)
    NOTE_OFF = 0x80,
    NOTE_ON = 0x90,
    SUSTAIN = 0xB0,         // CC 64

    // Custom parameter updates (0xE0-0xEF)
    PARAM_UPDATE_SINGLE = 0xE0,
    PARAM_UPDATE_BATCH = 0xE1,

    // Test/diagnostic modes (0xF0-0xFF)
    TEST_STRING_ONLY = 0xF0,
    TEST_MODE_ONLY = 0xF1,
    RESET_STATE = 0xF2,
    TOGGLE_FEEDBACK = 0xF3,

    // Reserved for future expansion
    RESERVED = 0xFF
};

// Base event structure (16 bytes, cache-aligned)
struct PlaybackEvent {
    EventType type;
    uint8_t channel;        // MIDI channel or target channel
    uint16_t timestamp_ms;  // Relative time in ms (for offline) or 0 (for online)
    uint32_t cycle_index;   // Cycle-accurate timing (offline mode)
    uint64_t data;          // Event-specific data

    PlaybackEvent()
        : type(EventType::RESERVED), channel(0),
          timestamp_ms(0), cycle_index(0), data(0) {}
};

// Specialized event types
struct NoteEvent : public PlaybackEvent {
    uint8_t pitch;
    uint8_t velocity;

    NoteEvent(EventType type, uint8_t pitch, uint8_t velocity, uint32_t cycle = 0);
    static NoteEvent fromMidi(uint8_t status, uint8_t data1, uint8_t data2, uint32_t cycle = 0);
};

struct SustainEvent : public PlaybackEvent {
    bool pedal_down;
    SustainEvent(bool down, uint32_t cycle = 0);
};

struct ParameterUpdateEvent : public PlaybackEvent {
    enum class ParamType : uint8_t {
        TENSION, DAMPING, STIFFNESS, RADIUS, DENSITY,
        FREQUENCY_DAMPING, DAMPER_STRING, VOLUME_COEFFICIENT
    };

    ParamType param_type;
    uint16_t string_index;
    float value;

    ParameterUpdateEvent(ParamType param, uint16_t string_idx, float val, uint32_t cycle = 0);
};

struct TestModeEvent : public PlaybackEvent {
    bool reset_before_play;
    bool disable_feedback;
    uint16_t target_index;  // String or mode index

    TestModeEvent(EventType test_type, uint16_t index, bool reset, bool no_feedback, uint32_t cycle = 0);
};

// Event queue for cycle-accurate playback
class EventQueue {
private:
    std::vector<PlaybackEvent> events_;
    size_t current_index_;

public:
    EventQueue();
    void addEvent(const PlaybackEvent& event);
    void sortByCycle();
    bool hasEventsAtCycle(uint32_t cycle) const;
    std::vector<PlaybackEvent> getEventsAtCycle(uint32_t cycle);
    void reset();
    size_t size() const;
};

} // namespace PianoidPlayback
```

#### 1.2 MIDI to Event Converter

Create [`pianoid_cuda/MidiEventConverter.h`](pianoid_cuda/MidiEventConverter.h):

```cpp
namespace PianoidPlayback {

class MidiEventConverter {
public:
    // Convert standard MIDI byte stream to PlaybackEvent
    static PlaybackEvent fromMidiBytes(uint8_t status, uint8_t data1, uint8_t data2, uint32_t cycle = 0);

    // Convert Python MIDI record format to EventQueue
    static EventQueue fromMidiRecord(const std::vector<int>& midi_record, int sample_rate, int samples_per_cycle);

    // Convert MIDI file to EventQueue
    static EventQueue fromMidiFile(const std::string& filename);

private:
    static uint32_t msToSampleIndex(double time_ms, int sample_rate);
    static uint32_t sampleToCycleIndex(uint32_t sample_index, int samples_per_cycle);
};

} // namespace PianoidPlayback
```

#### Validation Criteria

- [ ] Unit tests for `PlaybackEvent` creation
- [ ] Unit tests for MIDI byte conversion
- [ ] Unit tests for `EventQueue` sorting and retrieval
- [ ] Verify 16-byte alignment of `PlaybackEvent`
- [ ] Test edge cases (empty queue, single event, 10k+ events)

---

### Phase 2: Playback Engine Abstraction

**Duration**: 1 week
**Goal**: Extract playback logic from `Pianoid.cu` into modular components

#### 2.1 Core Playback Engine Interface

Create [`pianoid_cuda/PlaybackEngine.h`](pianoid_cuda/PlaybackEngine.h):

```cpp
namespace PianoidPlayback {

// Configuration for playback engine
struct PlaybackConfig {
    bool audio_enabled = true;
    bool record_to_buffer = false;
    bool cycle_accurate = false;
    int max_duration_ms = 0;      // 0 = infinite
    int sample_rate = 48000;
    int samples_per_cycle = 64;
};

// Playback statistics
struct PlaybackStats {
    uint32_t total_cycles = 0;
    uint32_t events_processed = 0;
    double average_cycle_time_ms = 0.0;
    double total_time_ms = 0.0;
    bool completed_successfully = true;
    std::string error_message;
};

// Abstract playback engine interface
class IPlaybackEngine {
public:
    virtual ~IPlaybackEngine() = default;

    virtual void initialize(Pianoid* pianoid, const PlaybackConfig& config) = 0;
    virtual void loadEvents(const EventQueue& events) = 0;
    virtual PlaybackStats run() = 0;

    virtual void pause() = 0;
    virtual void resume() = 0;
    virtual void stop() = 0;
    virtual bool isRunning() const = 0;

    virtual std::vector<float> getRecordedAudio() const = 0;
};

} // namespace PianoidPlayback
```

#### 2.2 Online Playback Engine

Create [`pianoid_cuda/OnlinePlaybackEngine.h`](pianoid_cuda/OnlinePlaybackEngine.h):

```cpp
namespace PianoidPlayback {

class OnlinePlaybackEngine : public IPlaybackEngine {
private:
    Pianoid* pianoid_;
    PlaybackConfig config_;
    EventQueue event_queue_;

    std::atomic<bool> running_;
    std::atomic<bool> paused_;

    std::chrono::steady_clock::time_point start_time_;
    std::vector<float> recorded_audio_;

    void processEventsAtTime(double elapsed_ms);
    void applyEvent(const PlaybackEvent& event);

public:
    OnlinePlaybackEngine();

    void initialize(Pianoid* pianoid, const PlaybackConfig& config) override;
    void loadEvents(const EventQueue& events) override;
    PlaybackStats run() override;

    void pause() override;
    void resume() override;
    void stop() override;
    bool isRunning() const override;

    std::vector<float> getRecordedAudio() const override;
};

} // namespace PianoidPlayback
```

**Key Features**:
- Real-time wall-clock timing (preserves existing behavior)
- Audio driver integration via existing `Pianoid` audio system
- Optional recording to buffer
- Maintains current `runMainApplication()` semantics

#### 2.3 Offline Playback Engine

Create [`pianoid_cuda/OfflinePlaybackEngine.h`](pianoid_cuda/OfflinePlaybackEngine.h):

```cpp
namespace PianoidPlayback {

class OfflinePlaybackEngine : public IPlaybackEngine {
private:
    Pianoid* pianoid_;
    PlaybackConfig config_;
    EventQueue event_queue_;

    std::atomic<bool> running_;
    std::atomic<bool> stop_requested_;
    uint32_t current_cycle_;

    std::vector<float> recorded_audio_;
    size_t audio_write_pos_;

    void processEventsAtCycle(uint32_t cycle);
    void applyEvent(const PlaybackEvent& event);
    void runCycle();
    void collectAudio();
    uint32_t calculateTotalCycles() const;

public:
    OfflinePlaybackEngine();

    void initialize(Pianoid* pianoid, const PlaybackConfig& config) override;
    void loadEvents(const EventQueue& events) override;
    PlaybackStats run() override;

    void pause() override;   // Not supported in offline mode
    void resume() override;  // Not supported in offline mode
    void stop() override;
    bool isRunning() const override;

    std::vector<float> getRecordedAudio() const override;

    // Offline-specific: Export to WAV file
    bool exportToWav(const std::string& filename, int sample_rate) const;
};

} // namespace PianoidPlayback
```

**Key Features**:
- Cycle-accurate timing (events trigger at exact cycle indices)
- No audio driver (pure GPU synthesis to memory buffer)
- Faster than real-time (no waiting for audio callbacks)
- Large buffer allocation (auto-grows to accommodate full render)
- Direct WAV export

#### 2.4 Event Dispatcher

Create [`pianoid_cuda/EventDispatcher.h`](pianoid_cuda/EventDispatcher.h):

```cpp
namespace PianoidPlayback {

// Central event dispatcher - converts events to Pianoid API calls
class EventDispatcher {
private:
    Pianoid* pianoid_;

public:
    explicit EventDispatcher(Pianoid* pianoid);

    void dispatch(const PlaybackEvent& event);
    void dispatchBatch(const std::vector<PlaybackEvent>& events);

private:
    void handleNoteOn(const NoteEvent& event);
    void handleNoteOff(const NoteEvent& event);
    void handleSustain(const SustainEvent& event);
    void handleParameterUpdate(const ParameterUpdateEvent& event);
    void handleTestMode(const TestModeEvent& event);
};

} // namespace PianoidPlayback
```

#### Validation Criteria

- [ ] `OnlinePlaybackEngine` produces identical output to current `runMainApplication()`
- [ ] `OfflinePlaybackEngine` renders audio without glitches
- [ ] `EventDispatcher` calls correct `Pianoid` methods for each event type
- [ ] Performance: Online engine maintains <1ms cycle time
- [ ] Performance: Offline engine renders faster than real-time (target: 5-10x)

---

### Phase 3: Pianoid Integration

**Duration**: 1 week
**Goal**: Add new playback methods to `Pianoid` class while preserving existing API

#### 3.1 New Pianoid Methods

Add to [`Pianoid.cuh`](Pianoid.cuh):

```cpp
class Pianoid {
public:
    // ========================================================================
    // EXISTING METHOD (unchanged)
    // ========================================================================

    /**
     * Legacy main application loop with real-time audio
     * @deprecated Use runOnlinePlayback() instead
     */
    int runMainApplication(int maxDur, bool audioEnabled);

    // ========================================================================
    // NEW PLAYBACK API
    // ========================================================================

    /**
     * Run online playback with event queue
     * Replaces runMainApplication() with event-driven architecture
     */
    PianoidPlayback::PlaybackStats runOnlinePlayback(
        const PianoidPlayback::EventQueue& events,
        const PianoidPlayback::PlaybackConfig& config
    );

    /**
     * Run offline playback (cycle-accurate, no real-time constraint)
     * Renders audio faster than real-time to memory buffer
     */
    PianoidPlayback::PlaybackStats runOfflinePlayback(
        const PianoidPlayback::EventQueue& events,
        const PianoidPlayback::PlaybackConfig& config
    );

    /**
     * Export offline-rendered audio to WAV file
     */
    bool exportAudioToWav(
        const std::string& filename,
        const std::vector<float>& audio_data,
        int sample_rate
    );

    /**
     * Get recorded audio from last playback session
     */
    std::vector<float> getRecordedAudio() const;

private:
    // ========================================================================
    // REFACTORED CORE CYCLE LOGIC
    // ========================================================================

    /**
     * Execute one synthesis cycle (extracted from runMainApplication)
     */
    void executeSynthesisCycle();

    /**
     * Retrieve audio from GPU after cycle (for offline recording)
     */
    std::vector<float> getCurrentCycleAudio();

    std::vector<float> last_recorded_audio_;
};
```

#### 3.2 Python Bindings

Update [`AddArraysWithCUDA.cpp`](AddArraysWithCUDA.cpp):

```cpp
#include <pybind11/pybind11.h>
#include <pybind11/stl.h>

namespace py = pybind11;

PYBIND11_MODULE(pianoidCuda, m) {
    // Event System
    py::enum_<PianoidPlayback::EventType>(m, "EventType")
        .value("NOTE_ON", PianoidPlayback::EventType::NOTE_ON)
        .value("NOTE_OFF", PianoidPlayback::EventType::NOTE_OFF)
        .value("SUSTAIN", PianoidPlayback::EventType::SUSTAIN)
        .value("TEST_STRING_ONLY", PianoidPlayback::EventType::TEST_STRING_ONLY);

    py::class_<PianoidPlayback::EventQueue>(m, "EventQueue")
        .def(py::init<>())
        .def("add_note_on", [](PianoidPlayback::EventQueue& q, uint8_t pitch, uint8_t vel, uint32_t cycle) {
            q.addEvent(PianoidPlayback::NoteEvent(PianoidPlayback::EventType::NOTE_ON, pitch, vel, cycle));
        })
        .def("sort_by_cycle", &PianoidPlayback::EventQueue::sortByCycle);

    py::class_<PianoidPlayback::PlaybackConfig>(m, "PlaybackConfig")
        .def(py::init<>())
        .def_readwrite("audio_enabled", &PianoidPlayback::PlaybackConfig::audio_enabled)
        .def_readwrite("record_to_buffer", &PianoidPlayback::PlaybackConfig::record_to_buffer);

    py::class_<Pianoid>(m, "Pianoid")
        .def("runOnlinePlayback", &Pianoid::runOnlinePlayback, py::call_guard<py::gil_scoped_release>())
        .def("runOfflinePlayback", &Pianoid::runOfflinePlayback, py::call_guard<py::gil_scoped_release>())
        .def("exportAudioToWav", &Pianoid::exportAudioToWav);
}
```

#### Validation Criteria

- [ ] Existing tests pass with unchanged `runMainApplication()`
- [ ] New Python bindings compile without errors
- [ ] Can create and populate `EventQueue` from Python
- [ ] Can call new playback methods from Python

---

### Phase 4: Middleware Integration

**Duration**: 1 week
**Goal**: Update Python middleware to use new playback API

#### 4.1 Update MidiRecord.py

```python
class MidiRecord:
    def pack_for_offline_playback(self) -> 'pianoidCuda.EventQueue':
        """Convert MIDI file to cycle-accurate EventQueue"""
        import pianoidCuda

        event_queue = pianoidCuda.EventQueue()

        for note in self.midi_events:
            time_ms = note['time_ms']
            sample_index = int((time_ms / 1000.0) * self.sample_rate)
            cycle_index = sample_index // self.samples_per_cycle

            if note['type'] == 'note_on':
                event_queue.add_note_on(note['pitch'], note['velocity'], cycle_index)
            elif note['type'] == 'note_off':
                event_queue.add_note_off(note['pitch'], 0, cycle_index)

        event_queue.sort_by_cycle()
        return event_queue
```

#### 4.2 Update pianoid.py

```python
class Pianoid:
    def render_midi_offline(self, midi_file: str, output_wav: str, sample_rate: int = 48000):
        """Render MIDI file to WAV using offline playback"""
        import pianoidCuda

        midi_record = MidiRecord()
        midi_record.read_midi(midi_file)
        event_queue = midi_record.pack_for_offline_playback()

        config = pianoidCuda.PlaybackConfig()
        config.audio_enabled = False
        config.record_to_buffer = True

        with self.cuda_lock:
            stats = self.pianoid.runOfflinePlayback(event_queue, config)
            audio_data = self.pianoid.getRecordedAudio()
            success = self.pianoid.exportAudioToWav(output_wav, audio_data, sample_rate)

        return success, stats
```

#### 4.3 Add REST API Endpoints

Update [`backendServer.py`](backendServer.py):

```python
@app.route('/render_offline', methods=['POST'])
def render_offline():
    """Render MIDI file to WAV offline"""
    data = request.json
    midi_file = data.get('midi_file')
    output_file = data.get('output_file', 'output.wav')

    success, stats = pianoid.render_midi_offline(midi_file, output_file)

    return jsonify({
        'success': success,
        'output_file': output_file,
        'stats': {
            'total_cycles': stats.total_cycles,
            'events_processed': stats.events_processed
        }
    })
```

#### Validation Criteria

- [ ] REST API endpoints respond correctly
- [ ] Offline rendering produces valid WAV files
- [ ] WAV files play correctly in audio software
- [ ] Python bindings release GIL during long renders

---

### Phase 5: Testing and Test Modes

**Duration**: 1 week
**Goal**: Implement individual string/mode playback and comprehensive testing

#### 5.1 Test Mode Implementation

```cpp
void EventDispatcher::handleTestMode(const TestModeEvent& event) {
    if (event.reset_before_play) {
        pianoid_->resetStringsState();
    }

    if (event.disable_feedback) {
        // Store and zero feedback parameters
    }

    switch (event.type) {
        case EventType::TEST_STRING_ONLY:
            pianoid_->addOneString(event.target_index, 64);
            break;
    }
}
```

#### 5.2 Test Suite

Create [`tests/test_playback_refactoring.py`](tests/test_playback_refactoring.py):

```python
def test_event_queue_sorting():
    queue = pianoidCuda.EventQueue()
    queue.add_note_on(60, 100, 100)
    queue.add_note_on(64, 100, 50)
    queue.sort_by_cycle()
    assert queue[0].cycle_index == 50

def test_offline_playback_completes(pianoid, sample_event_queue):
    stats = pianoid.runOfflinePlayback(sample_event_queue, config)
    assert stats.completed_successfully
```

#### Validation Criteria

- [ ] All tests pass
- [ ] Individual string tests produce expected audio
- [ ] Test mode correctly disables feedback

---

### Phase 6: Documentation and Migration

**Duration**: 1 week
**Goal**: Complete documentation and provide migration guide

#### 6.1 Update Documentation

Update [PIANOID_CORE_DOCUMENTATION.md](PIANOID_CORE_DOCUMENTATION.md):

- Add section on playback modes
- Document REST API endpoints
- Add examples of test mode usage

Update [pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md](pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md):

- Add section on event system architecture
- Document playback engine internals
- Add performance comparison

#### 6.2 Migration Examples

```python
# OLD: Not possible
# No offline rendering capability

# NEW: Offline rendering
success, stats = pianoid.render_midi_offline('input.mid', 'output.wav')
```

---

## Timeline and Milestones

| Phase | Duration | Key Deliverables | Success Criteria |
|-------|----------|------------------|------------------|
| **Phase 1** | 1 week | Event system, converters | Unit tests pass |
| **Phase 2** | 1 week | Playback engines, dispatcher | Online == current, offline works |
| **Phase 3** | 1 week | Pianoid integration, bindings | Existing tests pass |
| **Phase 4** | 1 week | Python/REST integration | Valid WAV files |
| **Phase 5** | 1 week | Test modes, tests | All tests pass |
| **Phase 6** | 1 week | Documentation | Docs complete |

**Total Duration**: 6 weeks

---

## Risk Mitigation

### Risk 1: Breaking Existing Functionality

**Mitigation**: Keep old APIs unchanged, add new ones alongside

### Risk 2: Performance Regression

**Mitigation**: Benchmark at each phase, optimize hot paths

### Risk 3: Audio Glitches in Online Mode

**Mitigation**: Extensive real-time testing, profiling

### Risk 4: Offline Timing Drift

**Mitigation**: Cycle-accurate validation tests

---

## Success Criteria

### Functional Requirements

- ✅ Offline playback renders cycle-accurate audio to WAV
- ✅ Online playback maintains real-time performance
- ✅ All existing tests pass
- ✅ Test modes work for individual strings/modes

### Performance Requirements

- ✅ Offline renders faster than real-time (target: 5-10x)
- ✅ Online playback cycle time ≤ 1ms
- ✅ No audio dropouts or glitches

### Code Quality Requirements

- ✅ Playback logic fully extracted from Pianoid.cu
- ✅ Clear separation of online vs offline
- ✅ Extensible event system

---

## Future Enhancements

1. **Real-time Parameter Automation**: Continuous parameter curves
2. **Multi-track MIDI**: Per-track preset switching
3. **Live MIDI Listener in C++**: Lower-latency input
4. **Distributed Rendering**: Parallel GPU rendering
5. **VST Plugin**: Real-time DAW integration

---

## Open Questions

1. **WAV Export Library**: Use `libsndfile`, `dr_wav`, or custom?
   **Recommendation**: `dr_wav` (header-only, no dependencies)

2. **Event Queue Size**: Pre-allocate or dynamic growth?
   **Recommendation**: Hybrid - `reserve(10000)`, grow if needed

3. **Python GIL**: Release during offline render?
   **Recommendation**: Yes - use `py::gil_scoped_release()`

4. **Audio Export Format**: 32-bit float or 16-bit int?
   **Recommendation**: 32-bit float (standard)

---

## File Structure

```
PianoidCore/
├── pianoid_cuda/
│   ├── Pianoid.cuh                        # [Modified] Add new methods
│   ├── Pianoid.cu                         # [Modified] Refactor cycle logic
│   ├── PlaybackEvent.h                    # [New] Event definitions
│   ├── PlaybackEvent.cpp                  # [New] Event implementation
│   ├── MidiEventConverter.h               # [New] MIDI conversion
│   ├── MidiEventConverter.cpp             # [New] MIDI conversion impl
│   ├── PlaybackEngine.h                   # [New] Engine interface
│   ├── OnlinePlaybackEngine.h             # [New] Real-time engine
│   ├── OnlinePlaybackEngine.cpp           # [New] Real-time impl
│   ├── OfflinePlaybackEngine.h            # [New] Offline engine
│   ├── OfflinePlaybackEngine.cpp          # [New] Offline impl
│   ├── EventDispatcher.h                  # [New] Event routing
│   ├── EventDispatcher.cpp                # [New] Event routing impl
│   ├── WavWriter.h                        # [New] WAV export
│   └── WavWriter.cpp                      # [New] WAV export impl
├── AddArraysWithCUDA.cpp                  # [Modified] Python bindings
├── pianoid.py                             # [Modified] Add playback methods
├── MidiRecord.py                          # [Modified] Add event packing
├── backendServer.py                       # [Modified] Add REST endpoints
└── tests/
    └── test_playback_refactoring.py       # [New] Comprehensive tests
```

---

**Document Version**: 1.0
**Last Updated**: 2025-10-17
**Author**: Claude (Sonnet 4.5)
**Status**: Ready for Implementation
