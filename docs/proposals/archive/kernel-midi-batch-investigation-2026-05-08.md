# Kernel MIDI Batch Investigation — 2026-05-08

> **STATUS — ARCHIVED 2026-05-09 by dev-prophy.** Preparation investigation that fed into `docs/proposals/midi-system-refactoring-plan-revised-2026-05-08.md`. The canonical plan has absorbed the Option A fix proposal (and broadened it to also handle the TEST_MODE_ONLY commit-interleave). Retained for investigation history.

**Author:** /analyse sub-agent
**Mode:** Read-only investigation (no code edits)
**Scope:** Why the synthesis kernel processes only one MIDI command per cycle when the architecture was designed to drain a bunch.

---

## 1. Executive Summary

**The kernel-side batching API is intact and fully capable of processing multiple
MIDI events per cycle.** Capacity: `MAX_STRINGS_PER_EVENT = 64` strings per
batch, packed into one `gaussKernel` launch driven by `new_notes_ind`. The
per-cycle event drain in `OnlinePlaybackEngine::processEventsAtCycle` does
correctly collect *all* events scheduled for the current cycle into a single
`std::vector<PlaybackEvent> all_events`.

**The bug lives one layer above the kernel: in `EventDispatcher::dispatch`.**
For each `NOTE_ON`, the dispatcher calls
`PlaybackCycleExecutor::exciteStringsForPitch`, which **opens, fills, and
closes a fresh `beginStringBatch / addStringToBatch / commitStringBatch` cycle
per event**. Each `commitStringBatch()` overwrites `noStrings_in_GP` and
`new_notes_ind`, evicting any strings staged by prior NOTE_ONs in the same
cycle. The next iteration of the per-cycle event loop then `cudaMemcpy`s its
own (smaller) batch on top.

**Net behaviour:** when N NOTE_ON events land in a single synthesis cycle, the
kernel sees only the strings of the **last** NOTE_ON. The first N–1 are
silently dropped at the host side — they never reach the GPU. This is
specifically the chord case (and also any MIDI file with simultaneous notes,
sympathetic batches, etc.).

The comment block in `EventDispatcher.cu:75–82` claims this helper "replaces
the manual batch pattern with a clean, reusable API" — and in fact it does so
correctly **for one note at a time**. The architectural intent (drain N events
into ONE batch in ONE kernel launch) was lost in the Phase E refactor that
deleted the legacy `processMidiPoints()` (per
`docs/historical/planning/PHASE_E_ONLINE_EVENTQUEUE_IMPLEMENTATION_PLAN.md`,
line 37) and replaced it with this per-event helper.

**Impact rating:** real and audible. A 4-note chord whose notes land in the
same cycle (~1.3 ms window at default 64 samples / 48 kHz) renders only the
last note. With Python's `MIDI_listener_unified` ingest having no enforced
inter-event spacing, simultaneous chord presses commonly land in the same
cycle once events traverse RtMidi → Python `schedule_event` →
`realtime_buffer.pushEvent(target_cycle = current+1)`.

---

## 2. Current Behaviour — Code Citations

### 2.1 Per-cycle drain (works correctly)

`PianoidCore/pianoid_cuda/OnlinePlaybackEngine.cu:218–259`

```cpp
void OnlinePlaybackEngine::processEventsAtCycle(uint32_t cycle)
{
    std::vector<PlaybackEvent> all_events;

    // 1. Drain real-time events scheduled for this cycle
    if (realtime_buffer_) {
        auto rt_events = realtime_buffer_->drainEventsUpTo(cycle);
        if (!rt_events.empty()) {
            all_events.insert(all_events.end(), rt_events.begin(), rt_events.end());
            ...
        }
    }
    // 2. Get pre-scheduled events for this cycle
    auto sched_events = event_queue_.getEventsAtCycle(cycle);
    if (!sched_events.empty()) {
        all_events.insert(all_events.end(), sched_events.begin(), sched_events.end());
        ...
    }

    // 3. Dispatch all events
    for (const auto& event : all_events) {
        dispatcher_->dispatch(event);              // <-- (3) the bug enters here
        engine_stats_.total_events_processed++;
    }
}
```

`drainEventsUpTo` and `getEventsAtCycle` correctly produce **all** events for
the cycle. But step 3 funnels them one-by-one into a dispatcher that does
not know how to coalesce.

### 2.2 The single-note dispatcher (the bug)

`PianoidCore/pianoid_cuda/EventDispatcher.cu:69–82`

```cpp
void EventDispatcher::handleNoteOn(const PlaybackEvent& event)
{
    uint8_t pitch    = static_cast<uint8_t>((event.data >> 8) & 0xFF);
    uint8_t velocity = static_cast<uint8_t>(event.data & 0xFF);

    // Use the centralized string excitation helper from PlaybackCycleExecutor
    // The helper internally:
    // 1. Calls getStringIndicesForPitch() to map pitch → strings
    // 2. Uses beginStringBatch() / addStringToBatch() / commitStringBatch()
    // 3. Handles empty string lists gracefully
    PlaybackCycleExecutor::exciteStringsForPitch(pianoid_, pitch, velocity);
}
```

`PianoidCore/pianoid_cuda/PlaybackCycleExecutor.cu:25–46`

```cpp
void PlaybackCycleExecutor::exciteStringsForPitch(
    Pianoid* pianoid, int pitch, int velocity)
{
    std::vector<int> strings = pianoid->getStringIndicesForPitch(pitch);
    if (strings.empty()) return;

    // Batch excite all strings with the same velocity
    pianoid->beginStringBatch();                     // <-- WIPES prior batch
    for (int string_idx : strings) {
        pianoid->addStringToBatch(string_idx, velocity);
    }
    pianoid->commitStringBatch();                    // <-- OVERWRITES new_notes_ind
}
```

The `beginStringBatch` resets `noStrings_in_GP = 0`
(`PianoidCore/pianoid_cuda/Pianoid.cu:1911–1914`); the prior commit's strings
are erased from the host-side staging arrays before being re-uploaded. The
`commitStringBatch` `cudaMemcpy`s the new (smaller) array and sets
`new_notes_ind = noStrings_in_GP + 1`
(`PianoidCore/pianoid_cuda/Pianoid.cu:1941–1947`).

### 2.3 Kernel reads only the most-recent commit

`PianoidCore/pianoid_cuda/Pianoid.cu:2131–2199`

```cpp
if (new_notes_ind > 0) {
    ... parameterKernel launch ...
}

if (new_notes_ind > 1) {
    int noStrings = new_notes_ind - 1;             // <-- only the LAST batch's count
    dim3 gaussGridSize(noStrings, numSeg);
    gaussKernel<<<gaussGridSize, gaussBlockSize>>>(
        getIntPointer("dev_string_excitation_params"),
        getRealPointer("dev_force_function"),
        dev_gauss_params_full,
        getIntPointer("dev_gauss_param_indices"),       // <-- only the LAST batch's indices
        ...
    );
}

new_notes_ind = 0;                                  // <-- reset at end of cycle
```

`runSynthesisKernel` runs once per outer cycle. By the time it reads
`new_notes_ind`, all but the final per-event commit has been overwritten on
both the host and the device. `gaussKernel`'s grid only spans the most
recent `new_notes_ind − 1` strings.

### 2.4 Offline engine — same bug

`PianoidCore/pianoid_cuda/OfflinePlaybackEngine.cu:235–238` →
`PlaybackCycleExecutor::processEvents` →
`PianoidCore/pianoid_cuda/PlaybackCycleExecutor.cu:7–19`

```cpp
void PlaybackCycleExecutor::processEvents(
    EventQueue& queue, EventDispatcher& dispatcher, uint32_t cycle_index)
{
    std::vector<PlaybackEvent> events = queue.getEventsAtCycle(cycle_index);
    for (const auto& event : events) {
        dispatcher.dispatch(event);                 // <-- same per-event commit pattern
    }
}
```

Same root cause. So MIDI-file playback through the offline engine drops
simultaneous notes too. (User-perceptible only on chords / dense passages
inside one cycle window.)

---

## 3. Original Design Intent — Evidence

### 3.1 The kernel-trigger contract is plainly multi-string

`docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md:578–586`:

```
new_notes_ind == 0  →  addKernel only (normal synthesis cycle)
new_notes_ind == 1  →  parameterKernel + addKernel
new_notes_ind >  1  →  parameterKernel + gaussKernel + addKernel
                        (gaussKernel grid: noStrings = new_notes_ind - 1)
```

That is the entire reason `new_notes_ind` is an integer rather than a bool —
the kernel-launch grid scales with the batch.

### 3.2 The host-side batch API is plainly multi-string

`docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md:549–569`:

```cpp
void beginStringBatch();       // Reset batch counter (noStrings_in_GP = 0)
void addStringToBatch(int stringNo, int velocity);   // Append one string
void commitStringBatch();      // Transfer batch to GPU; arm kernel trigger
```

with explicit "for a single string" wrapper noted as a *convenience*:

```cpp
void addOneString(int stringNo, int velocity);
// Equivalent to beginStringBatch() + addStringToBatch() + commitStringBatch()
// for a single string
```

### 3.3 Capacity sized for chord-class workloads

`PianoidCore/pianoid_cuda/constants.h:29` — `const int MAX_STRINGS_PER_EVENT = 64;`

GPU-side staging buffers are sized for 64 strings per batch
(`Pianoid.cu:170–171, 460, 467`). With typical 3 strings per piano pitch, the
current capacity is ~21 chord pitches per batch. This is far above what
arrives in any real cycle — the design left generous headroom precisely so
the kernel could absorb dense bursts without overflow.

### 3.4 The legacy `processMidiPoints()` was the multi-pitch consumer

`docs/historical/planning/PHASE_E_ONLINE_EVENTQUEUE_IMPLEMENTATION_PLAN.md:37`:

> Removed 4 legacy methods: `processMidiPoints()`, `runMainApplication()`,
> `playMidiRecord()`, `midiListener()`

`PianoidCore/pianoid_cuda/PlaybackCycleExecutor.cu:39–45` (current code,
post-Phase-E):

```
// Batch excite all strings with the same velocity
// This is more efficient than calling addOneString() multiple times
```

That comment is the smoking gun: the helper was **designed to batch many
strings of one pitch** (replacing the per-string `addOneString` loop). It
was *not* designed to batch many pitches. Phase E re-wired the dispatcher to
call this helper per-event, which broke the multi-pitch (chord) batching that
the kernel still expects.

### 3.5 `dispatchBatch` exists but is never called

`PianoidCore/pianoid_cuda/EventDispatcher.cu:58–63`:

```cpp
void EventDispatcher::dispatchBatch(const std::vector<PlaybackEvent>& events)
{
    for (const auto& event : events) {
        dispatch(event);                            // <-- still per-event commits!
    }
}
```

A `dispatchBatch` API was declared, but (a) no caller uses it (verified via
`Grep`), and (b) even its body just loops single-event dispatch — so even if
called it wouldn't fix the bug. It's a vestigial signature where someone
clearly *intended* to handle the multi-event case, but the implementation
never followed.

---

## 4. Why the Design Isn't Realised — Specific Blocker

Three small layers conspire to lose the design:

1. **`OnlinePlaybackEngine::processEventsAtCycle`** correctly assembles
   `all_events` but then loops them through the *single*-event dispatcher.
   No knowledge of "this is a multi-event drain — coalesce before commit."

2. **`EventDispatcher::handleNoteOn`** treats every `NOTE_ON` as an
   independent excitation call. No accumulation across calls. No "begin once,
   commit once" wrapper around the loop.

3. **`PlaybackCycleExecutor::exciteStringsForPitch`** unconditionally calls
   `beginStringBatch()` and `commitStringBatch()` itself. Each invocation is
   a complete commit cycle that overwrites the prior commit's
   `noStrings_in_GP`, host arrays, GPU memcpys, and `new_notes_ind`.

The kernel-launch trigger `new_notes_ind` is a **scalar that gets
overwritten**, not a counter that accumulates. Combined with the per-event
`beginStringBatch` reset, every commit is destructive of the previous one.

There is no constant-set-to-1 hard cap; no rate limiter; no missing loop in
the kernel. The cap is purely emergent from "each event commits and resets
the staging area in isolation."

---

## 5. Impact Analysis — Real or Theoretical?

### 5.1 What the user perceives

- **Chord pressing (4-note chord):** if all 4 NOTE_ON events arrive in the
  same cycle window (~1.3 ms at default 64 samples / 48 kHz / `samples_per_cycle`),
  only the last note's strings are excited. The other 3 are silent. The user
  hears a single note where they pressed 4.
- **MIDI file playback (offline rendering):** simultaneous notes in a MIDI
  file (e.g. cluster chords, programmatic chord triggers, score-aligned
  events at one timestamp) collapse to the last-event-wins.
- **Sustain dynamics:** any "burst" of NOTE_ONs landing in one cycle (fast
  arpeggios driven by a sequencer faster than the cycle period, sympathetic
  excitation patterns) loses all but the final event.
- **NOTE_OFF:** also affected — `handleNoteOff` calls the same
  `exciteStringsForPitch(pitch, 0)` helper, so simultaneous note releases also
  drop all but the last. (`EventDispatcher.cu:84–93`.)

### 5.2 Likelihood of "simultaneous in one cycle"

Cycle length at default parameters = `samples_per_cycle / sample_rate` =
64 / 48000 = **~1.33 ms**. The `MIDI_listener_unified` polling loop in
Python (`pianoid.py:1450–1463`) has no sleep, so events are forwarded as
fast as RtMidi delivers them. `schedule_event` with `delay_ms = 0` targets
`current_cycle + 1` (`pianoid.py:1493–1497`).

A human pianist pressing a chord delivers the constituent notes within
~5–20 ms of each other in the typical case (and within ~1 ms of each other
on a precisely-quantised MIDI device). So:

- **Best case (slow chord ~20 ms spread):** 4 notes spread across ~15
  cycles. None lost. Typical chord plays normally.
- **Common case (chord ~5 ms spread):** 4 notes spread across ~4 cycles.
  Each cycle may see 1 event. Typical chord plays normally.
- **Pathological (precise MIDI chord ≤1.3 ms spread, OR Python listener
  briefly preempted, OR MIDI file with same-timestamp notes):** 2–4 notes
  in ONE cycle. **Last-event-wins. Audible drop.**
- **Offline MIDI file rendering:** scheduled events with identical
  `cycle_index` are *guaranteed* to collide. This is the worst-affected path
  because the user expects bit-exact rendering of the score.

So the real-world blast radius is "intermittent dropped chord notes in live
play" plus "guaranteed dropped same-cycle notes in offline MIDI rendering."
Hypothetical it is not — it is simply masked by Python's polling jitter
acting as an unintentional spreader on the live path.

### 5.3 Latency cost of "draining over N cycles vs draining in 1"

Even if the bug were not destructive, *spreading* a 4-note chord over 4
cycles costs ~5 ms of inter-note onset jitter, which is at the edge of human
perceptibility (psychoacoustic chord-fusion threshold ~10 ms). A clean
single-cycle commit would render all 4 notes synchronously, perceived as one
chord. So fixing the batching also improves the **musical timing fidelity**
of any chord that *does* spread across cycles today.

---

## 6. Restoration Options

### Option A — Coalesce in `processEventsAtCycle` (preferred, low risk)

Have the engine call `beginStringBatch()` once, dispatch all events,
`commitStringBatch()` once. Requires changing the dispatcher contract so
NOTE_ON / NOTE_OFF only call the inner helper (`addStringToBatch`) and the
caller takes responsibility for the begin/commit envelope.

```cpp
void OnlinePlaybackEngine::processEventsAtCycle(uint32_t cycle) {
    ... assemble all_events ...

    // Open ONE batch for the whole cycle's worth of NOTE_ON/NOTE_OFF events.
    // PARAM_UPDATE_*, SUSTAIN, TEST_* events bypass the batch and stay per-event.
    bool has_excitation = std::any_of(all_events.begin(), all_events.end(),
        [](const auto& e){ return e.type == EventType::NOTE_ON
                                || e.type == EventType::NOTE_OFF; });
    if (has_excitation) pianoid_->beginStringBatch();

    for (const auto& event : all_events) {
        dispatcher_->dispatch(event);   // dispatcher now adds-to-batch only
    }

    if (has_excitation) pianoid_->commitStringBatch();
}
```

Required dispatcher change: `handleNoteOn` / `handleNoteOff` call
`addStringToBatch` directly (NOT a helper that begins/commits its own
batch). Add a new helper `PlaybackCycleExecutor::stageStringsForPitch` that
is `exciteStringsForPitch` minus the `begin/commit` calls.

- **Effort:** 1–2 hours. ~30 lines touched across two files.
- **Risk:** low. The kernel side is unchanged; the begin/commit contract
  already exists and is documented in SYNTHESIS_ENGINE.md.
- **Tests:** existing `addOneString` and `exciteStringsForPitch` paths still
  work for callers that legitimately want a single-event commit (e.g. one-shot
  REST `/play` endpoints that hit only one note at a time). The change is
  internal to the engine drain loop.
- **Symmetric fix for offline:** `OfflinePlaybackEngine::processEventsAtCycle`
  → `PlaybackCycleExecutor::processEvents` needs the same begin/commit
  envelope around its dispatch loop. Trivial duplication of the wrapper.

### Option B — Make `dispatchBatch` actually batch (medium risk)

Wire `OnlinePlaybackEngine::processEventsAtCycle` and
`PlaybackCycleExecutor::processEvents` to call
`dispatcher_->dispatchBatch(all_events)`, and rewrite `dispatchBatch` to:

1. Pre-pass: collect all NOTE_ON/NOTE_OFF events, expand them to (string,
   velocity) tuples via `getStringIndicesForPitch`.
2. Issue ONE `beginStringBatch / addStringToBatch×N / commitStringBatch`
   sequence for the union.
3. Issue per-event dispatch for the non-excitation events (PARAM_UPDATE_*,
   SUSTAIN, TEST_*) before/after the batch as ordering requires.

- **Effort:** 3–4 hours. The pre-pass needs care to preserve event ordering
  semantics (e.g., a SUSTAIN event landing between two NOTE_ONs in the same
  cycle should logically take effect at the same time — the engine probably
  doesn't care about intra-cycle ordering of these, but worth confirming).
- **Risk:** medium. Changes the semantics of `dispatchBatch`, which is a
  vestigial public method but technically pybind-callable. Need to confirm
  no Python callers use it. (`Grep dispatchBatch` shows only the C++
  declaration — likely no Python callers.)
- **Pro:** keeps `EventDispatcher::dispatch` (single-event entrypoint)
  unchanged, so REST endpoints / one-shot test scaffolding that calls
  `dispatch` directly still works correctly per-event.
- **Con:** the dispatcher now contains batching/expansion logic that arguably
  belongs in the engine. Concern leak.

### Option C — Make `commitStringBatch` accumulative (high risk, NOT recommended)

Make `commitStringBatch` only commit on a *flush* signal, with a separate
`flushPendingBatch` called by the engine before `runCycle`. Effectively
inverts the begin/commit semantics — `begin` becomes a no-op, `commit`
becomes a no-op, and the engine drives the whole thing via flush.

- **Effort:** 4–6 hours plus regression-testing every other consumer of the
  batch API (REST `/play`, `addOneString`, mode-excitation pending-state).
- **Risk:** high. Breaks the "every commit closes a batch" mental model that
  several other call sites assume (notably `addModeExcitation` →
  `commitStringBatch` flushes the staged mode in
  `Pianoid.cu:1923–1949`).
- **NOT recommended.** Option A achieves the same outcome by changing only
  the engine's drain loop and the dispatcher's per-NOTE handler, leaving the
  batch contract intact for REST / test paths.

### Option D — Architectural rework: kernel-side multi-launch

Have the engine call `runSynthesisKernel` once per event instead of once per
cycle. **Trivially worse** — multiplies the per-cycle kernel-launch overhead
by N events, defeats audio-cadence determinism, and breaks the cooperative
grid's "one cycle = one launch" invariant on which `samplesInCycle`-bounded
audio output depends.

- **NOT recommended.** Documented for completeness; this is what someone
  unfamiliar with the kernel design might propose.

---

## 7. Open Questions for the User

1. **Preferred fix scope.** Option A (engine-owned begin/commit envelope, ~30
   LOC) or Option B (dispatcher-owned `dispatchBatch` with multi-event
   expansion, ~80 LOC)? Option A is cleaner; Option B preserves
   `EventDispatcher::dispatch` as a per-event entrypoint that callers can
   still use safely.

2. **Should NOTE_OFF participate in the same batch as NOTE_ON?** Today both
   call the same `exciteStringsForPitch(pitch, velocity_or_zero)` helper. A
   single batch covering both NOTE_ON-with-velocity and NOTE_OFF-with-vel-0
   in the same commit is fine kernel-side (the gauss kernel sees velocity 0
   as "close damper" via `dec_open[stringNo] = DUMP_CLOSED`). Confirming
   intent before the fix lands.

3. **PARAM_UPDATE_* / SUSTAIN ordering vs the NOTE batch.** If a SUSTAIN
   event and a NOTE_ON land in the same cycle, does the user care about the
   relative order of "sustain pedal goes down" vs "note is struck"? Today
   the dispatcher processes events in their `all_events` insertion order
   (RT-buffer events first, then scheduled events). A batched fix should
   preserve that ordering — which means committing the begin/commit envelope
   *around* the whole loop is fine, because PARAM_UPDATE / SUSTAIN don't
   touch `noStrings_in_GP` or `new_notes_ind` (they go through different
   GPU paths via `processSustain` /
   `updateSingleStringParameter_NEW`).

4. **Interaction with the parallel `dev-af08e64a6d279fc65` MIDI ingress
   investigation.** That investigation covers the frontend → backend ingress
   path. The fix here is purely on the C++ kernel-consumption side and is
   orthogonal — but if the ingress investigation lands a change to
   `target_cycle` semantics (e.g. quantising chord-presses to a common
   cycle), the impact of the present bug grows because *more* events would
   collide on the same cycle. Worth verifying scope alignment before the
   fix lands.

5. **Test coverage.** Is there an existing `tests/system/` test that exercises
   "N simultaneous NOTE_ONs in one cycle, expect N voices in the recorded
   audio"? If not, a regression test should ship with the fix — both online
   (deterministic via REST `/play` with a multi-pitch payload) and offline
   (MIDI file with same-cycle notes).

---

## 8. Files & Lines Referenced

| File | Lines | Role |
|------|-------|------|
| `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\OnlinePlaybackEngine.cu` | 218–259 | Per-cycle event drain (correct collection, broken commit) |
| `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\OfflinePlaybackEngine.cu` | 235–238 | Offline drain (delegates to PlaybackCycleExecutor::processEvents) |
| `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\PlaybackCycleExecutor.cu` | 7–19, 25–46 | `processEvents`, `exciteStringsForPitch` (per-event begin/commit) |
| `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\EventDispatcher.cu` | 24–63, 69–93 | `dispatch`, `dispatchBatch`, `handleNoteOn`, `handleNoteOff` |
| `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\Pianoid.cu` | 1790–1804 | `_add_string_for_playback` (host-side staging) |
| `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\Pianoid.cu` | 1846–1903 | `_load_exct_params_to_GPU`, `addOneString` |
| `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\Pianoid.cu` | 1911–1947 | `beginStringBatch`, `addStringToBatch`, `commitStringBatch` |
| `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\Pianoid.cu` | 2131–2199 | `runSynthesisKernel`: parameterKernel + gaussKernel + reset |
| `D:\repos\PianoidInstall\PianoidCore\pianoid_cuda\constants.h` | 29 | `MAX_STRINGS_PER_EVENT = 64` |
| `D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\pianoid.py` | 1436–1463, 1480–1508 | `MIDI_listener_unified`, `add_realtime_event` (target_cycle = current+1) |
| `D:\repos\PianoidInstall\docs\modules\pianoid-cuda\SYNTHESIS_ENGINE.md` | 549–586 | Documented batch API + new_notes_ind contract |
| `D:\repos\PianoidInstall\docs\modules\pianoid-cuda\PLAYBACK_SYSTEM.md` | 100–112, 218–259 | OnlinePlaybackEngine run loop |
| `D:\repos\PianoidInstall\docs\historical\planning\PHASE_E_ONLINE_EVENTQUEUE_IMPLEMENTATION_PLAN.md` | 34–38 | Removed `processMidiPoints()` (the legacy multi-pitch consumer) |

---

## 9. One-Sentence Summary

The kernel still expects a single multi-string batch per cycle (and is sized
for 64 strings); the per-cycle drain still collects multiple events; but the
post-Phase-E `EventDispatcher::handleNoteOn → exciteStringsForPitch`
helper opens-and-closes a fresh `begin/commit` cycle per event, so each
NOTE_ON's `commitStringBatch` overwrites the previous one — and only the
last event's strings ever reach `gaussKernel`. Fix: lift the
`begin/commit` envelope from per-event to per-cycle (Option A, ~30 LOC).
