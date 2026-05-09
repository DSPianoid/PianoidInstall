# Cycle-Synchronized Parameter Updates — Design

- **Agent:** dev-paramsync
- **Branch:** `feature/cycle-synchronized-param-updates` (PianoidCore)
- **Status:** Design — awaiting user approval before code edits
- **Related:** [CRASH_ANALYSIS_DETAILED_FLOW.md — "Apply at cycle boundary"](../historical/bug-fixes/CRASH_ANALYSIS_DETAILED_FLOW.md#L568), [PARAMETER_SYSTEM.md](../modules/pianoid-cuda/PARAMETER_SYSTEM.md), [PLAYBACK_SYSTEM.md](../modules/pianoid-cuda/PLAYBACK_SYSTEM.md)

---

## 1. Contract

**Invariant:** No host-thread write to any GPU buffer that a synthesis kernel reads (directly or through a pointer table) may be issued while that kernel is executing.

Concretely:

> Every host → GPU parameter mutation shall be applied on the engine thread, inside `processEventsAtCycle(cycle_index)`, strictly before `pianoid_->runCycle()` launches `addKernel` for that cycle. No other thread may issue a `cudaMemcpy*` to a live-read buffer while the engine thread is inside `runCycle()`.

"Parameter" here means every runtime-mutable quantity the system exposes: per-string physics, hammer shape, excitation base levels, mode state, deck coupling matrices, sound-channel coefficients, `volume_level`, `deck_feedback_coefficient`, `volume_center`, `volume_range`, `max_volume`, `string_iteration`, and any flag that `addKernel` or its downstream filter/post-processing kernel reads. Preset switch (full double-buffer swap) is covered by the same contract — the swap must be driven from the engine thread, not a background poll thread.

The contract is expressed as a one-line assertion (see §5 Testability): at any point in time, the set
`{threads currently inside cudaMemcpy to a live buffer} ∪ {threads currently executing addKernel}`
must have cardinality ≤ 1 (and is in practice always ≤ 1 on the engine thread).

This is a **correctness directive, not a performance optimisation**. Even if a profiler shows the current audible distortion is driven by something else, the invariant is non-negotiable — it's a precondition for reasoning about any other audio defect.

---

## 2. Mechanism

**Chosen approach: queue writes as `PARAM_UPDATE_*` events in `RealTimeEventBuffer`; engine applies them at cycle start.**

### Why this approach

The codebase already contains the right primitives, partially unused:

1. `OnlinePlaybackEngine::run()` (`OnlinePlaybackEngine.cu:100`) already calls `processEventsAtCycle(cycle_index)` before `pianoid_->runCycle(...)`. That is exactly the "between cycles" hook the invariant requires.
2. `RealTimeEventBuffer` (`RealTimeEventBuffer.h/cu`) is a thread-safe multiset keyed by cycle, drained from the engine thread. Producer-side latency is < 1μs per push.
3. `PlaybackEvent` already has `PARAM_UPDATE_SINGLE` and `PARAM_UPDATE_BATCH` types (`PlaybackEvent.h:19–20`). `EventDispatcher::handleParameterUpdate` already exists (`EventDispatcher.cu:106`) and maps the event to `pianoid_->updateSingleStringParameter_NEW(...)`.
4. `processEventsAtCycle` runs **on the engine thread, before kernel launch**. Any `cudaMemcpy` issued inside it is sequenced before the kernel naturally.

What's missing is uniform enforcement. Today only the granular single-string path can be expressed as an event; the bulk paths (`setNewPhysicalParameters`, `setNewHammerParameters`, `setNewExcitationBaseLevels`, `setNewModeParameters`, `setNewDeckParameters`), the runtime-param path (`setRuntimeParameters`), and the preset-library switch (`switchPreset`) all run on the caller's thread (Flask / WS / MIDI listener / poll thread) and write to GPU concurrently with the engine.

### Rejected alternatives

| Alternative | Why not |
|---|---|
| Global mutex across all param writes and the kernel launch | Flask writers would block on the kernel for ~680μs per iter=8 cycle, serialising the REST API to cycle cadence. Events queue instead — producers are lock-free except for buffer-push — and the engine drains them in bulk. |
| Extend UnifiedGpuMemoryManager double-buffer to cover runtime params | Adds a full second allocation per runtime scalar (~tens of bytes, not the cost) but more importantly duplicates the poll-thread state machine for scalars. The current poll thread is already a correctness concern (see §7 Risk); adding more state to it is the wrong direction. |
| Move all writes onto a dedicated CUDA stream with `cudaStreamWaitEvent` | Solves GPU-side ordering but not the host-side timing perturbation caused by synchronous memcpys on the default stream. Also requires every caller to acquire a stream handle, widening the concern boundary. |
| Keep the current poll thread and have it only swap at cycle boundaries (ask the engine thread for "are we in a kernel now?") | Re-introduces a lock between poll and engine. The engine thread already has the authority to drain events; giving it that responsibility is the simpler separation. |

### High-level mechanism

```
┌───────────────────────────────────────────────────┐
│  Producers (Flask HTTP, WS, MIDI listener)        │
│    Python: pianoid.update_parameter(...)          │
│            pianoid.set_volume_level(...)          │
│            pianoid.switch_preset(...)             │
│                                                   │
│  → package as PARAM_UPDATE_* PlaybackEvent(s)     │
│  → realtime_buffer_->pushEvent(evt, next_cycle)   │
│    (thread-safe, < 1μs, lock-free except push)    │
└───────────────────┬───────────────────────────────┘
                    │
         (cycle boundary — engine thread only)
                    │
                    ▼
┌───────────────────────────────────────────────────┐
│  OnlinePlaybackEngine::run() loop body            │
│                                                   │
│  1. processEventsAtCycle(cycle_index):            │
│     drain RealTimeEventBuffer ≤ cycle_index       │
│     for each PARAM_UPDATE_* event:                │
│       EventDispatcher::handleParameterUpdate      │
│       → memory_manager_.updateTunableParameter    │
│         (or scalar cudaMemcpy on engine thread)   │
│                                                   │
│  2. pianoid_->runCycle(Online):                   │
│     runSynthesisKernel()   ← reads frozen params  │
│     pushCycleAudioToDriver()                      │
└───────────────────────────────────────────────────┘
```

### Specific changes

1. **Runtime-param path (volume, deck feedback, volume_center/range, max_volume) — the primary current interference vector.**
   - Today: `Pianoid::setRuntimeParameters` does a synchronous `cudaMemcpy` on the default stream from any caller thread (Pianoid.cu:1283, 1312, 1362).
   - After: a thin producer-side shim enqueues a `PARAM_UPDATE_RUNTIME` event (new subtype, or reuse `PARAM_UPDATE_SINGLE` with a reserved `param_type`). The engine-thread handler is the *only* caller that invokes the actual `cudaMemcpy`. Producer returns immediately after enqueue.

2. **Bulk tunable path (physics, hammer, excitation, modes, deck) — move the write itself onto the engine thread.**
   - Today: `Pianoid::setNewPhysicalParameters` (and siblings) call `memory_manager_.updateTunableParameter(...)` from Flask/WS thread. `updateTunableParameter` issues `cudaMemcpyAsync` on `update_stream_` — non-blocking, but still races with the engine thread in the sense that the subsequent host-side pointer swap is done by the poll thread, not at cycle boundary.
   - After: producer queues a `PARAM_UPDATE_BULK` event carrying a `std::shared_ptr<std::vector<real>>` (or a move-only buffer) and the target name. Engine handler calls `memory_manager_.updateTunableParameter(...)` directly. The `cudaMemcpyAsync` still runs on `update_stream_`, but the pointer swap is driven by the engine at the NEXT cycle boundary (not by the poll thread).
   - Poll thread is retired in its current form. The state-machine advancement (UPDATING → SWAPPING → SYNCING → IDLE) is driven synchronously inside `processEventsAtCycle`: at the start of each cycle the engine calls `memory_manager_.serviceAsyncUpdates()` (new), which queries `update_complete_event_` / `sync_complete_event_` and advances the state on the engine thread if ready.

3. **Preset switch — same treatment.**
   - Today: `pianoid_->switchPreset(name, async)` calls `memory_manager_.switchPreset(...)` from Flask thread. With `async=false` (current REST path) it blocks the Flask thread on D2D completion.
   - After: producer queues a `PARAM_UPDATE_PRESET_SWITCH` event. Engine drains it at cycle start, calls `memory_manager_.switchPreset(name, /*async=*/false)` (or a new cycle-synchronous variant) as part of the cycle-start fence, and the kernel launches on the freshly-swapped preset the same cycle.

4. **Contract enforcement.**
   - All producer-side entry points in Python (`update_parameter`, `set_volume_level`, `set_deck_feedback_coefficient`, `switch_preset`, `set_max_volume`, `set_volume_center`, `set_volume_range`) stop holding `cuda_lock` around the GPU memcpy and instead hold it only around the event enqueue (or drop it entirely — the `RealTimeEventBuffer` is already thread-safe).
   - Direct C++ API (`Pianoid::setRuntimeParameters`, `Pianoid::setNewPhysicalParameters`, etc.) gain a precondition assertion: if called off the engine thread while `isApplicationRunning()`, they log an error and return `false`. They remain callable from `initParameters()` / `loadPresetToLibrary()` (startup — no kernel running) and from the engine handler (safe by construction).
   - Offline render is unaffected: `OfflinePlaybackEngine::run` owns its own thread and serialises event application with `runCycle` the same way.

### What we do NOT touch

- The Python debounce / optimistic-UI pattern in `usePreset`. It still debounces at 50ms and still writes to a REST/WS endpoint. Below that line, the endpoint now enqueues rather than sync-writes.
- `UnifiedGpuMemoryManager`'s allocation layout, `UpdatePolicy` enum semantics (DROP_IF_BUSY vs. BLOCK_UNTIL_READY), the `update_mutex_`, and the device buffers themselves.
- The synthesis math in `addKernel` / `gaussKernel` / `parameterKernel`. No kernel code changes.
- `cuda_lock`: kept for defence in depth. It no longer *provides* safety against GPU races (the event channel does that), but it still prevents two Python threads from concurrently mutating the Python domain model.

---

## 3. Scope Table

Every mutable parameter, its current host→GPU path, and its proposed path. "Producer" = the caller thread that currently issues the write. "Target buffer" = the GPU allocation the kernel reads.

| # | Parameter | Current producer | Current target → method | Proposed path |
|---|---|---|---|---|
| 1 | `volume_level` | Flask / MIDI listener | `dev_main_volume_coeff` via sync `cudaMemcpy` (default stream) | Enqueue `PARAM_UPDATE_RUNTIME{VOLUME_LEVEL, value}`; engine handler does the memcpy on `update_stream_` (Async) |
| 2 | `deck_feedback_coefficient` | Flask / MIDI listener | `dev_deck_feedback_coeff` via sync `cudaMemcpy` | Same as #1, `PARAM_UPDATE_RUNTIME{DECK_FB}` |
| 3 | `volume_center` | Flask | `dev_volume_center` via sync `cudaMemcpy` (part of `RuntimeParameters`) | Same as #1 |
| 4 | `volume_range` | Flask | `dev_volume_range` via sync `cudaMemcpy` | Same as #1 |
| 5 | `max_volume` (from `setInitializationParameters`) | Flask | `dev_main_volume_coeff` via sync `cudaMemcpy` (recompute coefficient) | Same as #1, `PARAM_UPDATE_RUNTIME{MAX_VOLUME}` |
| 6 | `string_iteration` | Flask | `dev_cycle_params[...]` via sync `cudaMemcpy` | Enqueue `PARAM_UPDATE_RUNTIME{ITER}`; engine handler does memcpy |
| 7 | String physics (tension, damping, stiffness, radius, density, …) granular | Flask | `dev_preset_updating_` region via `updateTunableParameter` (Async on `update_stream_`) + pointer swap from poll thread | Enqueue `PARAM_UPDATE_SINGLE` (already exists); engine handler calls `updateTunableParameter`; engine's `serviceAsyncUpdates` advances state machine at next cycle start (poll thread retired) |
| 8 | String physics bulk (setNewPhysicalParameters) | Flask (batch init / load) | `updateTunableParameter("dev_physical_parameters")` from caller thread | Enqueue `PARAM_UPDATE_BULK{physical_params, payload}`; engine applies |
| 9 | Hammer shape | Flask | `updateTunableParameter("dev_hammer")` from caller thread | Same as #8, kind=HAMMER |
| 10 | Excitation base levels | Flask | `setNewExcitationBaseLevels` → host interpolation → `updateTunableParameter("dev_gauss_params_full")` from caller thread | Same as #8, kind=EXCITATION (payload = 6-level base array; interpolation happens on engine thread as part of the handler) |
| 11 | Mode parameters granular | Flask | `updateModeParameters_GRANULAR` → read-modify-write on `dev_mode_state` from caller thread | Enqueue; engine handler executes read-modify-write |
| 12 | Mode parameters bulk | Flask | `updateTunableParameter("dev_mode_state")` | Same as #8, kind=MODE_STATE |
| 13 | Deck coupling (feedin + feedback matrices, sound channel coeffs) | Flask | `updateTunableParameter("dev_deck_parameters")` (via send_deck_params_to_CUDA) | Same as #8, kind=DECK |
| 14 | Preset switch | Flask | `Pianoid::switchPreset` → `memory_manager_.switchPreset` (D2D copy, sync=true) from Flask thread | Enqueue `PARAM_UPDATE_PRESET_SWITCH{name}`; engine handler drives the D2D on `update_stream_` and advances state machine |
| 15 | `set_deck` full matrix upload (if still reachable) | Flask | same path as #13 | Same as #13 |

Not affected (no host → GPU write during playback):
- FIR filter coefficients (`loadFirFilterFromFile`) — loaded at startup, `enableFirFilter` is a bool flag also wrapped into the event model for uniformity.
- Read-only GETs (`getCurrentCycle`, `getStats`, etc.).

---

## 4. Detailed Design Notes

### 4.1 Event payload encoding

`PlaybackEvent` has a 24-byte shape with an 8-byte `data` field. That's enough for scalar runtime params (volume_level as u8, coefficient as float32, kind as u8). Bulk payloads won't fit.

Two options:
- **Extend the event envelope** to carry a `std::shared_ptr<const std::vector<real>>` field, usable only for PARAM_UPDATE_BULK/PRESET_SWITCH. Event size grows; size isn't hot-path critical (events are rare vs. cycles).
- **Side-channel for bulk data:** the event carries only a sequence number; payloads live in a separate `std::unordered_map<uint64_t, BulkPayload>` owned by `RealTimeEventBuffer`. Push inserts into the map and the event; drain removes.

Recommendation: **extend the event**. Simpler, avoids a second allocation boundary. Memory overhead is trivial (events are drained every cycle).

### 4.2 Retire or keep the poll thread?

The poll thread today has two responsibilities:
- Query `update_complete_event_` → transition UPDATING → SWAPPING → do the pointer swap → SYNCING.
- Query `sync_complete_event_` → transition SYNCING → IDLE.

Both are CPU-side bookkeeping on completion of async GPU copies. They are cheap (event queries are nanoseconds). They do NOT need to happen at cycle boundaries for correctness of the pointer swap — the `ptr_ref` table update is a plain host-memory assignment protected by `update_mutex_`. The correctness concern is that the kernel reads the pointer early in its execution; as long as the pointer update happens strictly between kernel launches, swap timing is safe.

Proposal: **retire the poll thread**. Its state-machine advancement becomes a call at the start of every cycle on the engine thread (`memory_manager_.serviceAsyncUpdates()`). This gives us:
- No more "background thread racing the engine thread for the same mutex."
- State transitions happen at known, cycle-aligned moments.
- One fewer thread and one fewer class of sleep-loop timing defect.

Risk: if an update completes mid-cycle, the next `updateTunableParameter` call from a producer would still see `UpdateState != IDLE` and hit `DROP_IF_BUSY`/`BLOCK_UNTIL_READY`. But producers no longer call `updateTunableParameter` directly — they enqueue an event. The engine handler calls it, and it runs right after `serviceAsyncUpdates()`, so the transition is always observed. Clean.

### 4.3 Ordering within a cycle

Order of operations inside `processEventsAtCycle` on the engine thread:

1. `memory_manager_.serviceAsyncUpdates()` — advance state machine; pointer swap if event fired.
2. Drain `event_queue_` (pre-scheduled) and `realtime_buffer_` up to `cycle_index`.
3. For each event, `EventDispatcher::dispatch(event)`:
   - NOTE_ON / NOTE_OFF / SUSTAIN: existing behaviour.
   - PARAM_UPDATE_* (new): call the appropriate memory_manager method. For bulk tunable, that's `updateTunableParameter(name, data)`. For runtime scalar, a new `memory_manager_.setRuntimeScalar(name, value)` that does `cudaMemcpyAsync` on `update_stream_`. For preset switch, `memory_manager_.beginPresetSwitch(name)`.
4. After all events drained, `runCycle()` launches the kernel.

Async copies in (3) enqueue on `update_stream_`. The engine's kernel launches on the default stream. CUDA orders events across streams via event/wait primitives; we add a `cudaStreamWaitEvent(default_stream, update_complete_event_, 0)` in step 4 so the kernel waits for param memcpys to complete before reading the buffers. This is the **structural guarantee** — the kernel provably cannot start until all param writes queued in (3) have reached GPU memory.

If a runtime scalar write is still in flight when the kernel begins, the kernel waits — but only for that one stream event. Typical scalar memcpy latency is ~1μs. Tunable bulk memcpy is ~10–100μs (size-dependent). Either fits in the real-time budget.

### 4.4 Startup / offline paths

- Startup (`initialize_pianoid()`): runs before `start_realtime_playback_unified`, so the engine thread doesn't exist yet. Direct `updateTunableParameter` / `setRuntimeParameters` calls remain allowed. The precondition check gates on `isApplicationRunning()`.
- Offline render: `OfflinePlaybackEngine::run` is its own thread and owns the GPU for its duration. It can (and will) call the event-based path identically.
- Calibration / semi-offline (`executeSingleMeasurementCycle`): the engine loop is stopped but `isApplicationRunning()` returns false. Direct calls remain allowed.

### 4.5 Concern boundaries (P2)

- `Pianoid` (facade): exposes the public C++ API. Producer-side entry points become thin: validate, package event, push to realtime buffer. Engine-side handlers (callable only from engine thread) remain as the actual memcpy issuer.
- `UnifiedGpuMemoryManager`: gains `serviceAsyncUpdates()` (engine-thread only), loses its poll thread. `updateTunableParameter` becomes engine-thread-only (precondition check).
- `EventDispatcher`: gains handlers for `PARAM_UPDATE_RUNTIME`, `PARAM_UPDATE_BULK`, `PARAM_UPDATE_PRESET_SWITCH`. Each handler is a thin delegation to the memory manager.
- `RealTimeEventBuffer`: unchanged. Producer / consumer contract already matches.
- Python middleware (`pianoid.py`, `parameter_manager.py`): calls are re-routed, but the public Python API surface does not change. `update_parameter()`, `set_volume_level()`, etc. still exist and still look synchronous from the caller's perspective — they return after the event is enqueued, not after the GPU write. That's a *semantic* change for callers who expected "my call has taken effect before I return", but the only callers who relied on that (tests, initial load) were startup-path callers, not playback-path callers, and startup still uses the direct path. Playback-path callers (UI) are already optimistic on the frontend.

### 4.6 State ownership (P1)

| State | Current owner | Post-change owner |
|---|---|---|
| `dev_preset_working_` / `dev_preset_updating_` pointers | `UnifiedGpuMemoryManager` + poll thread (mutable cross-thread) | `UnifiedGpuMemoryManager`, mutated only on engine thread |
| `update_state_` | UGM, mutated by poll thread and producer threads | UGM, mutated only on engine thread (producer enqueues don't touch it) |
| `RuntimeParameters` (host copy) | `Pianoid`, mutated by caller thread | `Pianoid`, mutated only on engine thread |
| `dev_main_volume_coeff` etc. | none — racy | UGM, written only on engine thread via `setRuntimeScalar` |

This is a net simplification: three pieces of state move from "shared mutable across threads" to "mutated on engine thread only." That's the P1 test — Authority is clearer after the change.

---

## 5. Testability

### 5.1 Concurrent-write counter (runtime assertion)

Add a debug-build counter to `UnifiedGpuMemoryManager`:

```cpp
std::atomic<int> concurrent_writes_during_kernel_{0};
```

Incremented by any `cudaMemcpy*` code path if `isApplicationRunning()` returns true AND the caller is not the engine thread (thread-id check against an engine-thread id stored at engine start). A test asserts this counter reads **0** after a test battery of:

- 30 seconds of active playback under maximum-rate UI updates (100 param edits per second across all 15 parameter categories in the scope table).
- 30 seconds of active playback under maximum-rate MIDI CC volume changes (CC 7 at 1kHz).
- A preset switch every 500ms while playing.

If any write races a kernel, the counter rises. Post-fix target: **0**.

### 5.2 Deterministic offline render of the same MIDI under param edits

`test_performance.py` currently runs a deterministic offline render. Extend with a variant that schedules 100 param edits at known cycles throughout the render. Post-fix: two renders with identical edit scripts produce **bit-identical** WAV output (md5 check). This demonstrates that param application is deterministic w.r.t. cycle number, which is the behavioural consequence of the invariant.

### 5.3 Baseline audible evidence

Orchestrator has already confirmed (user report):
- iter=4 near-clean audio.
- iter=8 distorts.

Post-fix target: iter=8 audio under active param editing is subjectively indistinguishable from iter=8 audio with no param editing. Measured: RMS spectrum of a held note under 10 Hz volume-jitter edits matches (within 0.5 dB per 100Hz band) the same note with no edits. `/test-ui` will drive this measurement.

### 5.4 Unit-level tests

- `tests/unit/test_param_event_payload.py`: encode/decode round-trip for each `PARAM_UPDATE_*` subtype.
- `tests/integration/test_param_sync_ordering.py`: spawn producer threads that hammer `update_parameter` / `set_volume_level`; verify that (a) none block the engine (measure inter-cycle gap), (b) all edits land within the expected cycle window.
- `tests/system/test_param_sync_invariant.py`: drives the counter in §5.1.

---

## 6. Baseline Evidence (pre-change)

### 6.1 From user reports

- iter=4 (`string_iteration=4`): audio is near-clean.
- iter=8 (`string_iteration=8`): audio distorts audibly.
- The distortion is **not** present under offline render (confirmed in prior `dev-dist-*` sessions — see archive logs). It appears only in the live online path.
- Orchestrator has a parallel agent (`analyse-distortion`) currently profiling cycle stages — findings to be relayed.

### 6.2 From static code analysis (this session)

- `setRuntimeParameters` uses synchronous `cudaMemcpy` on the default stream (Pianoid.cu:1283, 1312). On every MIDI CC 7 (volume), CC 74 (deck feedback), and every volume slider change, an implicit sync point is inserted at an arbitrary point in the cycle.
- The async double-buffer poll thread sleeps 100μs between state checks (UnifiedGpuMemoryManager.cu:690, 954). At iter=8 with a ~680μs kernel, the poll thread typically advances state at least once during each kernel — meaning `swapBuffers()` can fire on the poll thread between any two kernel launches, or the `syncBuffers()` D2D memcpy can complete mid-kernel.
- Multiple param write paths assume `cuda_lock` is sufficient protection; it is not, because the engine thread does not take it.

### 6.3 Consistency with the iter-sensitivity

Longer cycles mean (a) more time in which a concurrent sync memcpy could land, and (b) more likely that a scalar update (volume slider, CC 7) happens to fall within the kernel's execution window rather than between launches. A fix that moves all writes to "between cycles" is **cycle-length-independent** by construction. If post-fix distortion remains at iter=8, the cause is not parameter interference.

---

## 7. Risk

### 7.1 Latency cost of the synchronization

Real-time budget per cycle at 48 kHz, 64 samples/cycle: **1.333 ms**. Current kernel time at iter=8: ~0.68 ms. Headroom: ~650μs.

Added cost per param update on the engine thread:
- Enqueue (producer side): < 1μs. No change from today's event flow.
- Drain + dispatch (engine side): 1-3μs per event.
- Runtime scalar memcpy on `update_stream_` + cudaStreamWaitEvent: ~1-3μs (scalar is tiny).
- Tunable bulk memcpyAsync: unchanged from today (~10-100μs). Already runs on `update_stream_`.
- `serviceAsyncUpdates` overhead: two `cudaEventQuery` calls per cycle + occasional pointer swap. `cudaEventQuery` is ~1μs. Worst case ~5μs per cycle.

**Net estimated cost per cycle: +5μs unconditional + ~5μs per param event handled.**
**Budget target from orchestrator: ≤ 100μs per param update.**
**Estimate: comfortably within budget.**

### 7.2 Event-buffer pressure

`RealTimeEventBuffer` has a soft cap (`kDefaultSizeLimit = 10000`, Tranche A/M12). Under extreme edit bursts (a thousand param edits enqueued inside one cycle), events could evict. Today, `PARAM_UPDATE_*` events are rare compared to MIDI events; the cap is unlikely to matter. If it becomes a concern, the cap is configurable.

More concerning: an edit burst that outpaces the engine's drain rate per cycle could cause visible latency (edits land several cycles later). At 48kHz / 64spc that's 1.33ms per cycle; if drain handles 20 events per cycle, the system processes 15k events/s. A user sliding a single slider at 60fps generates 60 events/s. Two orders of magnitude headroom.

### 7.3 Backwards compatibility

- Python callers: `pianoid.update_parameter(...)` and `pianoid.set_volume_level(...)` still accept the same signatures and return the same types. They return immediately after enqueue. Any test that inspected GPU state immediately after the call will now observe the *old* state for up to one cycle (~1.3ms). Tests must either wait for a cycle or read from the Python-side model (which is updated synchronously before enqueue).
- REST API: unchanged. `/set_parameter/...` and `/set_runtime_parameters` return 200 immediately. WebSocket `param_ack` events still emit (from the engine handler after the GPU write completes).
- `AutoTuner` / `VolumeTuner`: they operate in semi-offline mode with the engine stopped, so they hit the startup / offline path — no changes needed.

### 7.4 Preset-switch latency

Today, a preset switch blocks the Flask thread for ~0.1ms (D2D copy). After the change, it blocks for ~0ms on Flask (just enqueue) but the switch itself happens on the engine thread at the next cycle boundary — i.e. up to 1.3ms wall-time delay before it takes effect. That's one cycle of additional latency, imperceptible.

### 7.5 Debugging

A regression where an event is enqueued but never applied would manifest as a parameter edit silently taking no effect. Mitigation: every `PARAM_UPDATE_*` handler emits a `param_ack` event back to the frontend (same channel already used for WS acks). Lack of ack within N cycles = visible in the UI. Also: the concurrent-write counter in §5.1 catches the opposite failure (a write that *did* run off the engine thread).

### 7.6 Poll-thread removal

If `serviceAsyncUpdates` in §4.2 misses a transition (e.g. sync event fires one cycle late and is queried two cycles later), the symptom is a one-cycle delay on the update becoming visible — not a correctness failure. The state machine is deterministic; state never regresses. Worst case: a tunable update takes effect two cycles after enqueue instead of one. Still imperceptible.

---

## 8. Open Questions

1. **Stream topology.** Today F5 added a dedicated stream for `CircularBuffer::produce()`. The main kernel still launches on the default stream. For this design, `update_stream_` already exists. Question: should the main kernel also move to a dedicated synth stream so `cudaStreamWaitEvent(synth_stream, update_complete_event_)` is strictly scoped? F5 agent may have already done this — we should coordinate. Not blocking for design approval, but affects implementation details.
2. **Python-side `cuda_lock` removal.** Keeping it for defence in depth is cheap. Dropping it removes a lock that's no longer load-bearing. Preference? (Recommendation: keep, document as "protects Python domain model from concurrent mutation by Python callers, NOT the GPU.")
3. **Scope: leave `setInitializationParameters` alone?** It's called once at startup and occasionally at preset load. The user directive says "parameter updates" — arguably init-time calls don't qualify. Current recommendation: route them through the event channel during playback, allow direct call when `isApplicationRunning() == false`.
4. **Tests or fix first?** Orchestrator's workflow says Step 4 (edit) only after approval. When approval arrives, preference: implement §5.1 counter **first** so we can prove the invariant holds as we land each producer path; or land producers first and add the counter last? (Recommendation: counter first. It serves as the acceptance gate for each subsequent change.)

---

## 9. Success Criteria

Design is "done" when:

- [ ] All 15 rows in the scope table route through the event channel (or are explicitly gated by `!isApplicationRunning()`).
- [ ] `concurrent_writes_during_kernel_` counter reads 0 after the 90-second test battery in §5.1.
- [ ] iter=8 audio distortion is measurably reduced (RMS spectrum match within 0.5 dB under active param editing vs. quiescent baseline).
- [ ] Added per-cycle overhead ≤ 20μs (measured via `test_performance.py` + profiler).
- [ ] No new entries in `MODULE_LOCKS.md` left behind; docs updated; feature branch merged to `dev`.

---

## Appendix A — Files to touch (estimate, not yet committed)

Locks to acquire in Step 4:

- `PianoidCore/pianoid_cuda/Pianoid.cuh` / `Pianoid.cu`
- `PianoidCore/pianoid_cuda/UnifiedGpuMemoryManager.h` / `UnifiedGpuMemoryManager.cu`
- `PianoidCore/pianoid_cuda/EventDispatcher.h` / `EventDispatcher.cu`
- `PianoidCore/pianoid_cuda/PlaybackEvent.h` / `PlaybackEvent.cu`
- `PianoidCore/pianoid_cuda/OnlinePlaybackEngine.h` / `OnlinePlaybackEngine.cu`
- `PianoidCore/pianoid_cuda/AddArraysWithCUDA.cpp` (pybind bindings if new event types added)
- `PianoidCore/pianoid_middleware/pianoid.py`
- `PianoidCore/pianoid_middleware/parameter_manager.py`

Tests:
- `PianoidCore/tests/unit/test_param_event_payload.py` (new)
- `PianoidCore/tests/integration/test_param_sync_ordering.py` (new)
- `PianoidCore/tests/system/test_param_sync_invariant.py` (new)

Docs:
- `docs/modules/pianoid-cuda/PARAMETER_SYSTEM.md` (update)
- `docs/modules/pianoid-cuda/MEMORY_MANAGEMENT.md` (note poll-thread retirement)
- `docs/architecture/DATA_FLOWS.md` §2.1–§2.6 (update paths)
- This file → move to `docs/architecture/PARAM_SYNC_CONTRACT.md` once implemented.
