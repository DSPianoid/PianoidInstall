# Playback System

## Overview

The playback system drives the synthesis engine through time, dispatching timed events
(note-on, note-off, parameter changes) to `Pianoid` at the correct synthesis cycle. Two
concrete engines implement a shared interface: one for real-time audio output and one for
offline rendering. Shared synthesis-step logic lives in `PlaybackCycleExecutor` to prevent
code duplication.

All classes live in the `PianoidPlayback` namespace.

---

## IPlaybackEngine Interface

**File:** `PlaybackEngine.h`

```cpp
class IPlaybackEngine {
public:
    virtual void initialize(Pianoid* pianoid, const PlaybackConfig& config) = 0;
    virtual void loadEvents(const EventQueue& events) = 0;
    virtual PlaybackStats run() = 0;
    virtual void pause() = 0;
    virtual void resume() = 0;
    virtual void stop() = 0;
    virtual bool isRunning() const = 0;
    virtual std::vector<float> getRecordedAudio() const = 0;
};
```

Supporting structures:

```cpp
struct PlaybackConfig {
    bool audio_enabled      = true;
    bool record_to_buffer   = false;
    int  max_duration_ms    = 0;       // 0 = infinite
    int  sample_rate        = 48000;
    int  samples_per_cycle  = 64;
};

struct PlaybackStats {
    uint32_t total_cycles           = 0;
    uint32_t events_processed       = 0;
    double   average_cycle_time_ms  = 0.0;
    double   total_time_ms          = 0.0;
    bool     completed_successfully = true;
    std::string error_message;
};
```

---

## OnlinePlaybackEngine

**File:** `OnlinePlaybackEngine.h` / `OnlinePlaybackEngine.cu`

Drives synthesis in real time, synchronised to the audio driver callback rate. Processes
events from two sources at each cycle:

1. `EventQueue event_queue_` — pre-scheduled events (MIDI files, charts)
2. `RealTimeEventBuffer* realtime_buffer_` — live events injected by REST or MIDI listener

```cpp
class OnlinePlaybackEngine : public IPlaybackEngine {
    // Key members
    Pianoid*                        pianoid_;
    PlaybackConfig                  config_;
    EventQueue                      event_queue_;
    std::unique_ptr<EventDispatcher> dispatcher_;
    std::atomic<bool>               running_;
    std::atomic<bool>               paused_;
    RealTimeEventBuffer*            realtime_buffer_;      // non-owning
    std::unique_ptr<CycleTimeEstimator> cycle_estimator_;

    // Internal methods
    void processEventsAtCycle(uint32_t cycle);   // unified: queue + real-time buffer

public:
    void setRealTimeBuffer(RealTimeEventBuffer* buffer);
    CycleTimeEstimator* getCycleEstimator();
    EngineStats getEngineStats() const;
};
```

`EngineStats` tracks cumulative event processing metrics:

```cpp
struct EngineStats {
    uint32_t total_events_processed;
    uint32_t realtime_events;
    uint32_t scheduled_events;
    double   avg_event_latency_ms;
    uint32_t calibration_count;
};
```

The `run()` loop:
1. Starts audio device and application, then starts `CycleTimeEstimator`
   (estimator starts *after* audio init to prevent ~150ms startup drift)
2. Immediate `syncToCycle(0)` for initial calibration
3. Calls `processEventsAtCycle(current_cycle)` — drains both sources
4. Calls `PlaybackCycleExecutor::executeCycle(pianoid_, record_audio)` — synthesis step
5. CUDA error check: `cudaGetLastError()` after each `executeCycle()`
6. Drift calibration: every cycle for the first 10 cycles (rapid warmup),
   then every 100 cycles (periodic maintenance)
7. Repeats until `stop()` is called or `max_duration_ms` expires
8. On exit: stops estimator, application, and audio device

---

## OfflinePlaybackEngine

**File:** `OfflinePlaybackEngine.h` / `OfflinePlaybackEngine.cu`

Renders audio cycle-by-cycle without real-time constraints. No audio driver is active;
all audio is accumulated in `recorded_audio_` and exported via `exportToWav()`.

```cpp
class OfflinePlaybackEngine : public IPlaybackEngine {
    Pianoid*                        pianoid_;
    PlaybackConfig                  config_;
    EventQueue                      event_queue_;
    std::unique_ptr<EventDispatcher> dispatcher_;
    std::atomic<bool>               running_;
    std::atomic<bool>               stop_requested_;
    uint32_t                        current_cycle_;
    std::vector<float>              recorded_audio_;

    void processEventsAtCycle(uint32_t cycle);
    void runCycle();      // PlaybackCycleExecutor::executeCycle(pianoid_, true)
    void collectAudio();  // getCurrentCycleAudio() → recorded_audio_
    uint32_t calculateTotalCycles() const;

public:
    bool exportToWav(const std::string& filename, int sample_rate) const;
};
```

`pause()` and `resume()` are no-ops — offline rendering runs to completion as fast as
the GPU allows, consuming no system audio resources.

The engine adds a 5-second decay buffer after the last scheduled event to capture natural
note release and resonance tails: `decay_cycles = (5 * sample_rate) / samples_per_cycle`.

---

## PlaybackCycleExecutor

**File:** `PlaybackCycleExecutor.h` / `PlaybackCycleExecutor.cu`

Static utility class eliminating duplicated cycle execution code between the two engines.

```cpp
class PlaybackCycleExecutor {
public:
    // Dispatch all events at given cycle from the queue
    static void processEvents(
        EventQueue& queue,
        EventDispatcher& dispatcher,
        uint32_t cycle_index
    );

    // Execute one complete synthesis cycle (3-step)
    // Returns status code: 200 = success
    static int executeCycle(Pianoid* pianoid, bool record_audio);

    // Excite all strings mapped to a MIDI pitch
    static void exciteStringsForPitch(Pianoid* pianoid, int pitch, int velocity);

    // Excite a list of strings with corresponding velocities (uses batch API)
    static void exciteStringBatch(
        Pianoid* pianoid,
        const std::vector<int>& string_indices,
        const std::vector<int>& velocities
    );
};
```

`executeCycle()` calls in order:
1. `pianoid->executeSynthesisCycle()` — GPU kernel launch
2. `pianoid->manageSoundBuffers()` — audio buffer push
3. `pianoid->recordCycleAudio()` — D2H copy (if `record_audio == true`)

---

## EventQueue

**File:** `PlaybackEvent.h`

Sorted list of `PlaybackEvent` records used by offline and online engines for
pre-scheduled event delivery.

```cpp
class EventQueue {
    std::vector<PlaybackEvent> events_;
    size_t current_index_;

public:
    void addEvent(const PlaybackEvent& event);
    void sortByCycle();           // Sort ascending by cycle_index
    void reset();                 // Rewind current_index_ to 0
    void clear();                 // Remove all events

    bool hasEventsAtCycle(uint32_t cycle) const;
    std::vector<PlaybackEvent> getEventsAtCycle(uint32_t cycle);
    size_t size() const;
    bool empty() const;
};
```

Events are indexed by `PlaybackEvent::cycle_index` (a `uint32_t`). The engine advances
`current_index_` forward monotonically; `getEventsAtCycle()` returns all events at exactly
the requested cycle.

**Important:** `getEventsAtCycle()` also advances past any events with
`cycle_index < requested_cycle`, silently consuming them. If an engine skips a cycle
number, events scheduled for that cycle are dropped. This is by design — the sorted
queue assumes monotonically increasing cycle queries.

---

## PlaybackEvent Types

**File:** `PlaybackEvent.h`

```cpp
enum class EventType : uint8_t {
    NOTE_OFF             = 0x80,
    NOTE_ON              = 0x90,
    SUSTAIN              = 0xB0,   // CC 64
    PARAM_UPDATE_SINGLE  = 0xE0,
    PARAM_UPDATE_BATCH   = 0xE1,
    TEST_STRING_ONLY     = 0xF0,
    TEST_MODE_ONLY       = 0xF1,
    RESET_STATE          = 0xF2,
    TOGGLE_FEEDBACK      = 0xF3,
    RESERVED             = 0xFF
};
```

Base structure (24 bytes, cache-aligned):

```cpp
struct PlaybackEvent {
    EventType type;
    uint8_t   channel;        // MIDI channel or target
    uint16_t  timestamp_ms;   // Relative ms (offline) or 0 (online)
    uint32_t  cycle_index;    // Cycle-accurate trigger point
    uint64_t  data;           // Event-specific payload
    uint64_t  timestamp_us;   // Absolute microseconds (logging)
};
```

Derived event types add typed fields:
- `NoteEvent` — adds `pitch` and `velocity` (`uint8_t` each)
- `SustainEvent` — adds `pedal_down` (`bool`)
- `ParameterUpdateEvent` — adds `param_type`, `string_index`, `value`
- `TestModeEvent` — adds `reset_before_play`, `disable_feedback`, `target_index`

---

## EventDispatcher

**File:** `EventDispatcher.h`

Translates `PlaybackEvent` records into `Pianoid` API calls. Isolates playback logic from
core synthesis API details.

```cpp
class EventDispatcher {
    Pianoid* pianoid_;

    void handleNoteOn(const PlaybackEvent& event);
    void handleNoteOff(const PlaybackEvent& event);
    void handleSustain(const PlaybackEvent& event);
    void handleParameterUpdate(const PlaybackEvent& event);
    void handleTestMode(const PlaybackEvent& event);

public:
    explicit EventDispatcher(Pianoid* pianoid);
    void dispatch(const PlaybackEvent& event);
    void dispatchBatch(const std::vector<PlaybackEvent>& events);
};
```

---

## RealTimeEventBuffer

**File:** `RealTimeEventBuffer.h` / `RealTimeEventBuffer.cu`

Thread-safe buffer for events injected at runtime (REST API, MIDI listener) into an
already-running `OnlinePlaybackEngine`. Uses a `std::multimap<uint32_t, PlaybackEvent>`
keyed by target cycle for O(log n) insertion and O(k) range drain.

```cpp
class RealTimeEventBuffer {
public:
    void pushEvent(const PlaybackEvent& event, uint32_t target_cycle); // thread-safe
    std::vector<PlaybackEvent> drainEventsUpTo(uint32_t current_cycle); // thread-safe
    bool   hasPendingEvents() const;   // lock-free
    size_t size() const;               // lock-free
    void   clear();

    struct Stats {
        size_t total_events_pushed;
        size_t total_events_drained;
        size_t peak_buffer_size;
        double avg_insert_latency_us;
        double avg_drain_latency_us;
    };
    Stats getStats() const;
};
```

The engine calls `drainEventsUpTo(current_cycle)` once per synthesis cycle to collect all
events whose `target_cycle <= current_cycle`. Typical insertion latency is under 1 µs.

**Threading note:** `pushEvent()` and `drainEventsUpTo()` each use a single
`std::lock_guard` scope covering both the data operation and statistics update.

---

## CycleTimeEstimator

**File:** `CycleTimeEstimator.h` / `CycleTimeEstimator.cu`

Maps wall-clock time to synthesis cycles for `OnlinePlaybackEngine`. Provides drift
correction to maintain ±1 cycle accuracy over long sessions.

```cpp
class CycleTimeEstimator {
public:
    void     start(uint32_t sample_rate, uint32_t samples_per_cycle);
    void     stop();
    uint32_t getCurrentCycle() const;                     // lock-free, < 1 µs
    uint32_t predictCycleForDelay(double delay_ms) const; // schedule future events
    void     syncToCycle(uint32_t actual_cycle);          // calibration (every ~100 cycles)
    int32_t  getDriftOffset() const;
    double   getCycleDurationUs() const;
    double   getCycleDurationMs() const;
    bool     isRunning() const;
};
```

`cycle_duration_us = (samples_per_cycle / sample_rate) * 1e6`

Drift correction: `syncToCycle()` computes `drift = actual - estimated_raw` and stores
it as an atomic `int32_t` applied on every subsequent `getCurrentCycle()` call.

Calibration schedule (driven by `OnlinePlaybackEngine::run()`):
- Cycles 0–9: every cycle (rapid warmup to absorb audio startup delay)
- Cycle 10+: every 100 cycles (periodic maintenance)

The estimator suppresses drift warnings during the first 10 calibrations (warmup phase)
since large initial drift is expected during audio device startup.

---

## Online vs Offline Flow

```
ONLINE (real-time)                       OFFLINE (rendering)
==================================       ==================================
initialize()                             initialize()
loadEvents(queue)                        loadEvents(queue)
setRealTimeBuffer(buffer)  [optional]
run():                                   run():
  start CycleTimeEstimator                 calculateTotalCycles()
  start audio driver                       allocate recorded_audio_
  loop:                                    loop:
    cycle = estimator.getCurrentCycle()      processEventsAtCycle(current_cycle_)
    processEventsAtCycle(cycle)              runCycle()
      drain EventQueue                         executeSynthesisCycle()
      drain RealTimeEventBuffer                manageSoundBuffers()
    executeCycle(pianoid_, record)             recordCycleAudio()
      executeSynthesisCycle()                collectAudio()
      manageSoundBuffers()                   current_cycle_++
      [recordCycleAudio if needed]         end loop
    wait for next audio callback         exportToWav() [optional]
  end loop
  stop audio driver                      return PlaybackStats
  return PlaybackStats
```

---

## Python-Side Lifecycle Control

`stop_playback()` is the canonical method for halting playback. It:

1. Stops the MIDI listener (if running)
2. Signals `engine.stop()`
3. Joins `_playback_thread` with timeout (no sleep)
4. Stops the audio driver
5. Prints buffer/engine stats
6. Transitions PLAYBACK_ACTIVE → PAUSED

Legacy wrappers delegate to `stop_playback()`:

| Method | Extra Behavior | Use Case |
|--------|---------------|----------|
| `stop_playback()` | — | Canonical stop (preferred) |
| `stop_pianoid()` | Extracts pending audio results first | Chart actions, MIDI keyboard bindings |
| `stop_unified_playback()` | None (direct delegate) | Legacy callers |
| `pause_playback()` | None (direct delegate) | Legacy callers |

---

## Pybind11 Binding Coverage

Not all `EventType` values are exposed to Python. Currently bound:

| EventType | Bound | Notes |
|-----------|-------|-------|
| `NOTE_ON` | Yes | |
| `NOTE_OFF` | Yes | |
| `SUSTAIN` | Yes | |
| `PARAM_UPDATE_SINGLE` | Yes | |
| `PARAM_UPDATE_BATCH` | No | C++ only |
| `TEST_STRING_ONLY` | Yes | |
| `TEST_MODE_ONLY` | No | C++ only |
| `RESET_STATE` | Yes | |
| `TOGGLE_FEEDBACK` | No | C++ only, handler is TODO |

Unbound types can only be used in C++ (e.g., in pre-built `EventQueue` objects).

### MidiEventConverter

Also exposed via pybind11, `MidiEventConverter` provides static helpers for creating
`PlaybackEvent` records from raw MIDI data:

- `fromMidiBytes(status, data1, data2, cycle_index)` — single MIDI message
- `fromMidiRecord(midi_record, sample_rate, samples_per_cycle)` — full MIDI file → `EventQueue`

---

## MidiInputListener

**Files:** `MidiInputListener.h` / `MidiInputListener.cpp`

C++ MIDI input listener using embedded RtMidi (MIT-licensed). Receives MIDI from a
hardware controller via RtMidi's callback mode (lowest latency, no polling) and pushes
events into a `RealTimeEventBuffer` for cycle-accurate dispatch.

```cpp
class MidiInputListener {
public:
    MidiInputListener(Pianoid* pianoid, RealTimeEventBuffer* buffer);
    std::vector<std::string> listPorts();
    void start(int port);
    void stop();
    bool isRunning() const;
    void setCycleEstimator(CycleTimeEstimator* estimator);
};
```

### MIDI Message Handling

| MIDI Message | Action |
|---|---|
| NOTE_ON (0x90, vel>0) | `MidiEventConverter::fromMidiBytes` → `RealTimeEventBuffer` |
| NOTE_OFF (0x80 or vel=0) | `MidiEventConverter::fromMidiBytes` → `RealTimeEventBuffer` |
| Sustain (CC 64) | Sustain event → `RealTimeEventBuffer` |
| Volume (CC 7) | Direct `setRuntimeParameters(volume_level)` on `Pianoid` |
| Deck feedback (CC 74) | Exponential mapping (64→1.0, 127→8.0, 0→0.125) → `setRuntimeParameters` |

Volume and deck feedback bypass the event buffer for immediate effect, matching legacy
Python listener behavior. Note/sustain events go through the event buffer for
cycle-accurate scheduling.

### RtMidi Integration

RtMidi is embedded as single-file source (`RtMidi.h` + `RtMidi.cpp`). On Windows it uses
the WinMM backend (`__WINDOWS_MM__` define, `winmm.lib` already linked). The listener
uses callback mode — RtMidi calls `midiCallback()` on its internal thread, which converts
the message and pushes to the thread-safe `RealTimeEventBuffer`.

### Python Binding

```python
listener = pianoidCuda.MidiInputListener(pianoid_cpp, realtime_buffer)
listener.setCycleEstimator(engine.getCycleEstimator())
ports = listener.listPorts()      # ["MIDI Controller 0", ...]
listener.start(0)                 # Open port 0, begin receiving
listener.stop()                   # Close port
```
