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
    uint32_t dropped_events_per_cycle_overflow;  // events dropped at the
                                                 // per-cycle drain because
                                                 // a single cycle exceeded
                                                 // MAX_EVENTS_PER_CYCLE = 256
};
```

The `run()` loop:
1. Starts audio device and application, then starts `CycleTimeEstimator`
   (estimator starts *after* audio init to prevent ~150ms startup drift)
2. Immediate `syncToCycle(0)` for initial calibration
3. Calls `processEventsAtCycle(current_cycle)` — drains both sources
   into a single `all_events` vector (rt events first, then queue events,
   preserving insertion order); caps at `MAX_EVENTS_PER_CYCLE = 256`
   (overflow counted in `EngineStats::dropped_events_per_cycle_overflow`);
   calls `dispatcher_->dispatchBatch(all_events)` so all same-cycle
   excitations ride ONE begin/commit envelope (see `EventDispatcher`
   below).
4. Calls `pianoid_->runCycle({CycleRegime::Online, /*record_to_host=*/true})` —
   orchestrated synthesis + driver push + host-buffer ring
5. CUDA error check: `cudaGetLastError()` after each `runCycle()`
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
    void runCycle();      // pianoid_->runCycle({CycleRegime::Offline, false})
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

## Cycle Orchestration — `Pianoid::runCycle`

**File:** `Pianoid.cu` / `Pianoid.cuh`

`Pianoid::runCycle(const CycleOutput&)` is the single cycle-orchestration entry
point. Both engines call it. It runs synthesis and routes the output through
regime-specific primitives — there is one cycle function, one silence gate,
and two mutually-exclusive output regimes.

```cpp
enum class CycleRegime : uint8_t {
    Online,   // synthesis + driver push + (optional) host-buffer ring
    Offline,  // synthesis only; recording is owned by the offline engine
};

struct CycleOutput {
    CycleRegime regime;
    bool        record_to_host = false;  // Online-only; ignored when Offline.
};

int runCycle(const CycleOutput& out);
```

Body:
1. `runSynthesisKernel()` — GPU kernel launch
2. `switch(regime)`:
   - `Online`: if `record_to_host` → `appendCycleAudioToHostBuffer()`;
              always → `pushCycleAudioToDriver()`
   - `Offline`: nothing (the offline engine owns recording via `collectAudio`)
3. `#ifdef PIANOID_DEBUG_DATA`: archive `dev_sound_records_ms` → `dev_sound_records`,
   advance `sound_record_index`

**Regime exclusivity is the single silence gate.** The prior inner
`audioOn.load()` check inside `playSoundSamples` and the executor-level
`audio_enabled` gate inside `PlaybackCycleExecutor::executeCycle` are both
gone. Offline regime structurally never reaches `pushCycleAudioToDriver` —
therefore never reaches `LockFreeCircularBuffer::produce` — therefore never
blocks on the audio back-pressure condvar. Offline is free-running by
construction.

### Concern-specific primitives

| Primitive | Concern | Called from |
|-----------|---------|-------------|
| `pushCycleAudioToDriver()` | FIR filter, channel map, `audioDriver->pushSamples` | Online regime |
| `appendCycleAudioToHostBuffer()` | D2H copy `dev_soundFloat` → `rawSoundBuffer` (5s ring) | Online regime (when `record_to_host`) |
| `collectAudio()` (engine-private) | `getCurrentCycleAudio()` → `recorded_audio_[pos]` | Offline engine run loop |

## PlaybackCycleExecutor

**File:** `PlaybackCycleExecutor.h` / `PlaybackCycleExecutor.cu`

Static utility class with three helpers used by the engines and
`EventDispatcher`:

```cpp
class PlaybackCycleExecutor {
public:
    // Drain the queue's events for one cycle and dispatch them through
    // EventDispatcher::dispatchBatch (which opens the per-cycle envelope
    // — see EventDispatcher below). Caps at MAX_EVENTS_PER_CYCLE (excess
    // dropped from the tail).
    static void processEvents(
        EventQueue& queue,
        EventDispatcher& dispatcher,
        uint32_t cycle_index
    );

    // Excite all strings mapped to a MIDI pitch — single-event commit
    // path. Opens its own beginStringBatch/commitStringBatch envelope.
    // Use only for one-shot callers; multi-event drains use
    // stageStringsForPitch under the engine's outer envelope.
    static void exciteStringsForPitch(Pianoid* pianoid, int pitch, int velocity);

    // Stage strings mapped to a MIDI pitch — staging-only (no envelope).
    // Used by EventDispatcher::handleNoteOn / handleNoteOff. Caller must
    // open Pianoid::beginStringBatch before and Pianoid::commitStringBatch
    // after the dispatch loop.
    static void stageStringsForPitch(Pianoid* pianoid, int pitch, int velocity);
};
```

`executeCycle` was deleted in C3 — its 3-step orchestration moved to
`Pianoid::runCycle(CycleOutput)`, and the executor-level `audio_enabled`
gate collapsed into regime exclusivity.

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

#### `data` field bit-layouts (decoded by `EventDispatcher`)

| EventType | Bits 63..32 | Bits 31..16 | Bits 15..0 |
|---|---|---|---|
| `NOTE_ON` / `NOTE_OFF` | unused | unused | `(pitch << 8)` \| `velocity` |
| `SUSTAIN` | unused | unused | `value & 0x7F` (raw MIDI CC, 0–127) |
| `PARAM_UPDATE_SINGLE` / `PARAM_UPDATE_BATCH` | bits 63..56=`param_type`, bits 55..40=`string_index`, bits 39..32=unused | (continued) | bits 31..0=IEEE-754 `float` value |
| `TEST_STRING_ONLY` | bit 63=`reset_flag`, bits 62..32=unused | unused | `target_index` (string index, NOT pitch) |
| `TEST_MODE_ONLY` | unused | bits 23..16=`velocity` | `mode_index` |
| `RESET_STATE` / `TOGGLE_FEEDBACK` | unused | unused | unused |

`TEST_STRING_ONLY`'s `target_index` selects a physical string by index
(0..num_strings−1), NOT a MIDI pitch. The handler stages it via
`Pianoid::addStringToBatch` at velocity 64; if `reset_flag` is set, the
running string state is reset BEFORE staging. `TEST_MODE_ONLY` stages
mode excitation: displacement = `1e-5 × velocity / 127`, velocity =
`displacement × 0.4`; the cycle-level commit drains the staged mode
via `_exciteSingleMode`. Both are staging-only — no per-event commit.

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

**Per-cycle envelope contract.** `dispatchBatch(events)` is the canonical
per-cycle entry point. It scans `events` for excitation events
(`NOTE_ON`, `NOTE_OFF`, `TEST_STRING_ONLY`, `TEST_MODE_ONLY`); if any
are present, it opens `Pianoid::beginStringBatch`, runs each event's
handler (which stages without committing), then closes
`Pianoid::commitStringBatch` — so all same-cycle excitations land in
ONE GPU transfer (one `parameterKernel` + one `gaussKernel` grid
spanning every staged string). See SYNTHESIS_ENGINE.md
"Single-Envelope-per-Cycle Invariant" for why this matters.

`dispatch(event)` is the per-event entry point retained for one-shot
callers (legacy REST `/play` direct hits). It does NOT open an
envelope — the staged work hits the kernel only when something else
calls `commitStringBatch` (typically the next engine cycle).

---

## RealTimeEventBuffer

**File:** `RealTimeEventBuffer.h` / `RealTimeEventBuffer.cu`

Thread-safe buffer for events injected at runtime (REST API, MIDI listener) into an
already-running `OnlinePlaybackEngine`. Uses a `std::multimap<uint32_t, PlaybackEvent>`
keyed by target cycle for O(log n) insertion and O(k) range drain.

```cpp
class RealTimeEventBuffer {
public:
    static constexpr size_t kDefaultSizeLimit = 10000;

    void pushEvent(const PlaybackEvent& event, uint32_t target_cycle); // thread-safe
    std::vector<PlaybackEvent> drainEventsUpTo(uint32_t current_cycle); // thread-safe
    bool   hasPendingEvents() const;   // lock-free
    size_t size() const;               // lock-free
    void   clear();

    void   setSizeLimit(size_t limit); // 0 disables back-pressure
    size_t getSizeLimit() const;

    struct Stats {
        size_t total_events_pushed;
        size_t total_events_drained;
        size_t peak_buffer_size;
        double avg_insert_latency_us;
        double avg_drain_latency_us;
        size_t dropped_event_count;    // incremented on back-pressure eviction
    };
    Stats getStats() const;
};
```

The engine calls `drainEventsUpTo(current_cycle)` once per synthesis cycle to collect all
events whose `target_cycle <= current_cycle`. Typical insertion latency is under 1 µs.

**Back-pressure (Tranche A / M12):** `pushEvent()` enforces a soft cap (default
`kDefaultSizeLimit = 10000`). When the buffer reaches the cap at insertion
time, the oldest pending NOTE_OFF is evicted to make room; if no NOTE_OFF is
present, the oldest event of any kind is evicted. The new event is then
inserted. `Stats::dropped_event_count` tracks evictions. Setting
`size_limit == 0` via `setSizeLimit(0)` disables the policy entirely. The
policy favours musical integrity — NOTE_ONs and SUSTAINs are retained until
their counterpart NOTE_OFFs have been evicted, which keeps the engine hearing
note-ons under extreme producer bursts.

**Threading note:** `pushEvent()` and `drainEventsUpTo()` each use a single
`std::lock_guard` scope covering both the data operation and statistics update.
The back-pressure eviction runs inside the same lock as the insert, so no
additional synchronisation is required.

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

Two mutually-exclusive output regimes routed through a single orchestrator,
`Pianoid::runCycle`. Offline structurally never reaches the audio driver.

```
ONLINE regime                             OFFLINE regime
==================================        ==================================
initialize()                              initialize()
loadEvents(queue)                         loadEvents(queue)
setRealTimeBuffer(buffer)  [optional]

run():                                    run():
  start CycleTimeEstimator                  calculateTotalCycles()
  start audio driver                        allocate recorded_audio_
  loop:                                     loop:
    cycle = estimator.getCurrentCycle()       processEventsAtCycle(current_cycle_)
    processEventsAtCycle(cycle)               pianoid_->runCycle(
      drain EventQueue                          {Offline, false})
      drain RealTimeEventBuffer                   runSynthesisKernel()
    pianoid_->runCycle(                           (no push, no ring —
      {Online, record_to_host=true})             free-running)
      runSynthesisKernel()                    collectAudio()
      appendCycleAudioToHostBuffer()             getCurrentCycleAudio()
      pushCycleAudioToDriver()                   → recorded_audio_[pos]
        → audioDriver->pushSamples           current_cycle_++
        → LockFreeCircularBuffer::produce   end loop
    wait for next audio callback            exportToWav() [optional]
  end loop                                  return PlaybackStats
  stop audio driver
  return PlaybackStats
```

**Key invariant:** the Offline branch of `runCycle`'s switch statement does
nothing after synthesis. The audio back-pressure condvar
(`LockFreeCircularBuffer::produce`'s `canProduce.wait`) is reachable only
through `pushCycleAudioToDriver`, which is called only from the Online
branch. This is enforced structurally — not by a runtime flag — so no test
matrix of mixed modes exists.

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

### Loop-control flag — `shouldContinueLoop_`

The engine loop in `OnlinePlaybackEngine` reads the `Pianoid` flag
`shouldContinueLoop_` to decide whether to keep cycling. **`Pianoid::beginMainLoop()`
/ `endMainLoop()` (inline setters in `Pianoid.cuh`) are the intended
write-interface for that flag.** Two groups call those setters: the lifecycle
path (`startApplication` / `stopApplication` in `Pianoid.cu`) and the
semi-offline calibration path (`restartOnlineEngine` / `stopEngineKeepAudio`
in `Pianoid_calibration.cu`). Both are *callers of the owner's interface*, not
independent writers.

There is one pre-existing exception: `Pianoid::shutdownGpu()` (`Pianoid.cu`)
writes the atomic directly with `shouldContinueLoop_.store(false)` rather than
calling `endMainLoop()`. This predates the split (it was already in the
lifecycle section) and is functionally equivalent — `endMainLoop()` does the
same `store(false)` — but it bypasses the interface. Routing it through
`endMainLoop()` would make the write surface fully uniform; that is a
one-line follow-up, not part of the structural split.

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

## MIDI Input

MIDI input is handled in Python, not C++. The listener thread lives in
`pianoid_middleware/pianoid.py` (`MIDI_listener_unified`) and uses `rtmidi` from
Python. It parses incoming MIDI bytes and calls `Pianoid.schedule_event(...)`,
which pushes `PlaybackEvent` records into the `RealTimeEventBuffer` exposed by
the C++ engine via pybind11.

See [`modules/pianoid-middleware/MIDI_SYSTEM.md`](../pianoid-middleware/MIDI_SYSTEM.md)
for the device-enumeration / event-parsing details, and §6 of
[`development/archive/PLAYBACK_ARCHITECTURE_REVIEW.md`](../../development/archive/PLAYBACK_ARCHITECTURE_REVIEW.md)
for the planned migration toward a unified envelope scheduler.

A prior revision of this doc described a C++ `MidiInputListener` class that
never shipped; the supporting `MidiInputListener.h` / `MidiInputListener.cpp`
files are not in the source tree. Removed to match reality (Tranche A / M5).

