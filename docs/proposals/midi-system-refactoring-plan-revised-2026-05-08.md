# MIDI / Online-Playback System Refactoring — REVISED Consolidated Plan (2026-05-08)

**Mode:** Read-only analysis. No code changes.
**Author:** `/analyse` (orchestrator-spawned, this revision)
**Supersedes:** `docs/proposals/midi-system-refactoring-plan-2026-05-08.md`
**Inputs (read in order, treated as ground truth):**
1. `docs/proposals/midi-input-relocation-analysis-2026-05-08.md` — frontend → backend ingress relocation, latency budget, port-ownership traps
2. `docs/proposals/kernel-midi-batch-investigation-2026-05-08.md` — per-cycle batch coalescence bug (Option A, ~30 LOC)
3. `docs/proposals/midi-system-refactoring-plan-2026-05-08.md` — original 5-phase consolidated plan with 11 batched decisions
4. `docs/proposals/esprit-channel-timing-analysis-2026-05-08.md` — context only (separate measurement-domain refactor)
5. Live source: `EventDispatcher.cu`, `OnlinePlaybackEngine.cu`, `RealTimeEventBuffer.cu`, `PlaybackEvent.h`, `AddArraysWithCUDA.cpp` (pybind surface), `pianoid.py`, `backendServer.py`, `chartFunctions.py`, `useMidi.js`, `PianoidTuner.js`

**User direction (verbatim):** "Let's review online playback system systematically and make sure that the plan reflects correct structure. 1) On kernel level: single event flow feeding events into the running synthesis cycle. Make sure that there is only one unified path to accept all kinds of events from all sources. Make sure that events are processed in batches, up to 64 events per synthesis cycle. 2) c++ level has two pathes: getting midi commands from its own midi listener or from backend. Make sure that API is highly consolidated: one path to get notes and minimal number of other pathes to get other types of commands (if any). 3) backend level: make sure that all event sources (internal midi listener, UI midi calls, space/virtual keyboard/measurement/testing etc) are treated uniformly without functionality duplication and with clear authority separation. 4) UI level: make sure that in case UI does not receive midi itself it has a way to get timely notifications of the active note (last played note) id. Consider making this notification switchable (user case: switch off extra communication to decrease latency - play - switch back on to continue tunning). Also consider optional relaying completely on c++ midi listener with the notifications flowing bottom up."

---

## 1. Executive Summary — What Changed in This Revision

The original consolidated plan correctly identified **two defects** (frontend-owned MIDI ingress; per-event commit overwrite in the kernel batch) and structured them in 5 phases. This revision **broadens the scope** along the user's 4-layer framework and surfaces **architectural defects the original plan did not address**:

### Newly surfaced defects

1. **Layer-1 bug is partial, not just chord-coalescence.** The original plan's Option A fix bundles NOTE_ON/NOTE_OFF into one batch — but `EventDispatcher::handleTestMode` for `TEST_MODE_ONLY` calls `pianoid_->commitStringBatch()` directly inside the dispatcher (`EventDispatcher.cu:190`). So a same-cycle mode-test event lands in the middle of a NOTE_ON drain and **flushes the partial batch** with `noStrings_in_GP` set to whatever NOTE_ONs preceded it — silent destruction of a different shape than the chord bug. The Option A envelope must also wrap this commit, or `TEST_MODE_ONLY` must be a separate kernel-driven path.

2. **There is NO single unified event flow from Python → kernel.** `schedule_event` (the unified MIDI funnel) routes only NOTE_ON / NOTE_OFF / SUSTAIN. **Every other event source bypasses it**:
   - **Calibration / measurement** (`chartFunctions.py:2138`) calls `p.pianoid.addOneString(string_index, velocity)` directly — bypasses `RealTimeEventBuffer`, bypasses cycle scheduling, bypasses the EventDispatcher.
   - **Mode test** (`chartFunctions.py:1223`) calls `pianoid.pianoid.exciteMode(mode_index, displacement, vel)` directly — bypasses everything.
   - **Sustain pedal default** (`pianoid.py:774` `set_sustain` deprecated wrapper) goes through `perform_midi_command` → `schedule_event`, OK; but no sustain UI source is wired for now.
   - **Volume / runtime parameters** go through `setRuntimeParameters` (synchronous pybind), not events.
   - **Per-string parameter updates** go through `updateSingleStringParameter_NEW` / `updateMultiStringParameter_NEW` (synchronous pybind), not events. The `PARAM_UPDATE_SINGLE` / `PARAM_UPDATE_BATCH` EventTypes exist in C++ but are **never produced from Python** — `_create_playback_event` (pianoid.py:1510) only knows NOTE_ON, NOTE_OFF, SUSTAIN, and a generic else fallback.
   - **Preset switch** uses `switchPreset` (synchronous pybind, double-buffered) — appropriate for now, but it means "load this preset *at cycle N*" cannot be requested.

   So the user's framing — "one unified path to accept all kinds of events from all sources" — is **not** the current state at all. The unified path covers exactly 3 event types out of the 8 the C++ enum supports, and the other paths each have their own concurrency model.

3. **Layer-2 C++ surface is huge and mixes verbs of different scales.** The pybind `Pianoid` class exposes ~80 methods (`AddArraysWithCUDA.cpp:529-815`). Of these, the "event-style" surface is: `addOneString`, `beginStringBatch`/`addStringToBatch`/`commitStringBatch`, `addModeExcitation`, `exciteMode`, `processSustain`, `updateSingleStringParameter_NEW`, `updateMultiStringParameter_NEW`. The intended unified surface is: `RealTimeEventBuffer.pushEvent` (via the `EventDispatcher`). The same Python instance can choose either, and the existing code chooses both — leading to the silent "events go through the staging buffer; calibration goes around it" bypass that defect 2 catalogued.

4. **Layer-3 backend has at least 5 event-injection sites with different authority models** (see §3).

5. **Layer-4 UI has no broadcast channel for "last note pressed"** *yet* — the original plan added one (`midi_note_event` Socket.IO emit) but did not address (a) **switchability** under the user's "switch-off-during-play" use case, (b) **bottom-up direct-from-C++** notification path, or (c) what happens when calibration / measurement / test events fire — should the UI see them too?

### What this revision does

- **Reframes** the work as a 4-layer architectural cleanup with the original 5 phases as the *minimum scope* and adds 3 new phases (5, 6, 7) to address the consolidation gaps.
- **Promotes** the kernel batch fix from "Option A 30-LOC" to a full envelope refactor that also handles the `TEST_MODE_ONLY` commit and the `addModeExcitation` interleave.
- **Adds** a Layer-2 C++ surface consolidation step: every event-style operation (note, mode, parameter, sustain, calibration tap) must enter through the unified `RealTimeEventBuffer`, and the per-call shortcut methods (`addOneString`, `exciteMode`, `processSustain`, `updateSingleStringParameter_NEW`) become **deprecated direct paths** retained only for offline test scaffolding.
- **Adds** a Layer-3 backend ingress consolidation: every event source (MIDI listener, REST `/play`, WS `play`, `/play_keyboard`, `/play_mode`, calibration sweeps, modal_adapter measurement triggers, `/start_test`) routes through one `EventIngress` facade with explicit authority (priority + source tag + apply_fix_velocity policy).
- **Adds** a Layer-4 UI subscriber model with **switchable broadcast** and **explicit consideration** of a future direct-from-C++ WebSocket (deferred; documented for visibility).

The total work grows from ~6–11 h (original) to **~20–30 h** in 7 phases, but Phases 1–4 of the original plan still ship in their original form (with Phase 1 enlarged for the `TEST_MODE_ONLY` interleave). The new Phases 5–7 are clearly separable and can defer if user judges scope too large.

---

## 2. Layer-by-Layer Audit

### 2.1 Layer 1 — Kernel (CUDA)

#### Current state

- **One per-cycle drain loop** at `OnlinePlaybackEngine.cu:218-259` correctly assembles `all_events` from `realtime_buffer_->drainEventsUpTo(cycle)` plus `event_queue_.getEventsAtCycle(cycle)`. Both sources funnel into `dispatcher_->dispatch(event)` per event.
- The dispatcher's `switch (event.type)` (`EventDispatcher.cu:24-56`) covers all 8 EventTypes (NOTE_ON, NOTE_OFF, SUSTAIN, PARAM_UPDATE_SINGLE/BATCH, TEST_STRING_ONLY, TEST_MODE_ONLY, RESET_STATE, TOGGLE_FEEDBACK). **So at the EventDispatcher level there IS a single unified ingest path** — every event of every type goes through `EventDispatcher::dispatch`.
- **Per-event commit overwrite bug** (the original kernel investigation): `handleNoteOn` / `handleNoteOff` call `PlaybackCycleExecutor::exciteStringsForPitch`, which opens its own `beginStringBatch` / `commitStringBatch` per event. Each commit overwrites `noStrings_in_GP` and `new_notes_ind` host-side, so only the last NOTE_ON's strings reach `gaussKernel`.
- **`TEST_MODE_ONLY` commits inside the dispatcher too** — `EventDispatcher.cu:189-191` calls `pianoid_->addModeExcitation(mode_index, displacement, vel)` followed by `pianoid_->commitStringBatch()`. This is structurally identical to the NOTE_ON bug and **also fires same-cycle**.
- **`TEST_STRING_ONLY` calls `pianoid_->addOneString(target_index, 64)`** (`EventDispatcher.cu:169`), which is itself `beginStringBatch + addStringToBatch + commitStringBatch` (`Pianoid.cu` per the kernel investigation). Same bug.
- **`PARAM_UPDATE_*` and `SUSTAIN` go through different GPU paths** (`updateSingleStringParameter_NEW`, `processSustain`) that don't touch `noStrings_in_GP`. These are safe with respect to the batch envelope, but they **do** cause synchronous device work (memcpy + double-buffer swap) inside the per-event drain loop — adding latency to subsequent events in the same cycle.
- **Capacity:** `MAX_STRINGS_PER_EVENT = 64` (`constants.h:29`). This is **strings per cycle**, not events per cycle. With 1–3 strings per pitch the practical cap is ~21 NOTE_ONs per cycle. There is **no separate `MAX_EVENTS_PER_CYCLE`** — the buffer is unbounded (back-pressure is at `RealTimeEventBuffer.size_limit_`, default 0 = disabled). For PARAM_UPDATE / SUSTAIN events the per-cycle count is bounded by how fast the engine drains, not by a constant.
- **Kernel-launch contract** (`SYNTHESIS_ENGINE.md:578-586`): `new_notes_ind == 0` → addKernel only; `== 1` → parameterKernel + addKernel; `> 1` → parameterKernel + gaussKernel + addKernel with grid `(noStrings = new_notes_ind - 1, numSeg)`. So the kernel side is **already** built for the multi-string single-launch pattern; only the host-side accumulation is broken.

#### Gaps vs user intent ("single unified path; events processed in batches, up to 64 events per cycle")

| User intent | Current state | Gap |
|---|---|---|
| Single unified path for ALL event sources | EventDispatcher IS the unified path (all 8 EventTypes). RealTimeEventBuffer + EventQueue both drain into the same `all_events` vector. | None at the dispatcher level — but the **producers** are not unified (see Layer 3). |
| Events processed in batches, up to 64 per cycle | NOTE_ON only batches up to `MAX_STRINGS_PER_EVENT = 64` strings (~21 pitches). NOTE_OFF same. PARAM_UPDATE / SUSTAIN are not batched (each is a synchronous device op). | (a) NOTE_ON+NOTE_OFF batching is broken (per-event commit overwrite). (b) PARAM_UPDATE / SUSTAIN are not part of the per-cycle batch envelope at all. (c) `TEST_MODE_ONLY` and `TEST_STRING_ONLY` interleave with NOTE batches and silently destroy partial commits. |
| 64 events per cycle | The "64" is `MAX_STRINGS_PER_EVENT`, not `MAX_EVENTS_PER_CYCLE`. The number of NOTE_ON *events* per cycle is bounded only by the strings-per-cycle cap (~21–32 events). The number of *all-types* events per cycle is unbounded (limited only by drain throughput). | The user's framing of "64 events per cycle" matches the per-string cap better than the per-event cap. **Decision needed:** confirm that "64" means `MAX_STRINGS_PER_EVENT` (current state, sized for chord workload) or introduce a new explicit `MAX_EVENTS_PER_CYCLE` cap and an overflow policy. Recommendation: keep current `MAX_STRINGS_PER_EVENT=64`, add an explicit comment that this is the binding cap, and let `RealTimeEventBuffer.size_limit_` cover the cross-cycle overflow case. |

#### Files / lines

- `PianoidCore/pianoid_cuda/EventDispatcher.cu:24-56` — `dispatch()` switch (the single unified handler entry point)
- `PianoidCore/pianoid_cuda/EventDispatcher.cu:69-93` — NOTE_ON / NOTE_OFF (per-event commit bug)
- `PianoidCore/pianoid_cuda/EventDispatcher.cu:153-205` — TEST_*, RESET_STATE, TOGGLE_FEEDBACK
- `PianoidCore/pianoid_cuda/OnlinePlaybackEngine.cu:218-259` — per-cycle drain
- `PianoidCore/pianoid_cuda/RealTimeEventBuffer.cu:12-62` — pushEvent (back-pressure policy: evict oldest NOTE_OFF first)
- `PianoidCore/pianoid_cuda/PlaybackEvent.h:12-30` — EventType enum (8 types defined)
- `PianoidCore/pianoid_cuda/constants.h:29` — `MAX_STRINGS_PER_EVENT = 64`

---

### 2.2 Layer 2 — C++ middleware (pybind surface for the engine)

#### Current state

The user's framing here is: **"Two paths: own MIDI listener OR backend"**. This is a **target state**, not the current state.

- **Own C++ MIDI listener:** **does not exist** (Path C in the relocation analysis §2.3). `pianoid_cycle.cu:9` has `// #include <rtmidi/RtMidi.h>` commented out. `MidiEventConverter` is a byte-decoder, not a hardware listener.
- **Backend path:** the entire pybind surface (`AddArraysWithCUDA.cpp`, ~80 methods on `Pianoid`).

The pybind surface exposes **multiple, semantically-overlapping ways** for Python to push state into the engine:

| Operation | Event-route entry | Direct entry | Notes |
|---|---|---|---|
| Note-on / note-off | `RealTimeEventBuffer.pushEvent` (NOTE_ON/NOTE_OFF) | `addOneString(stringNo, velocity)`, `beginStringBatch`/`addStringToBatch`/`commitStringBatch` | Both wired; calibration uses direct, MIDI/REST use event-route |
| Mode excitation | `RealTimeEventBuffer.pushEvent` (TEST_MODE_ONLY) | `addModeExcitation(mode, q, v)`, `exciteMode(mode, q, v)` | Mode-test chart (`chartFunctions.py:1223`) uses `exciteMode` direct |
| Sustain | `RealTimeEventBuffer.pushEvent` (SUSTAIN) | `processSustain(value)` | Listener path uses event; nobody else triggers |
| Per-string param update | `RealTimeEventBuffer.pushEvent` (PARAM_UPDATE_SINGLE/BATCH) | `updateSingleStringParameter_NEW(name, idx, val)`, `updateMultiStringParameter_NEW(name, indices, values)` | **Only direct used today**; event path has C++ handler but no Python producer |
| Reset string state | `RealTimeEventBuffer.pushEvent` (RESET_STATE) | `resetStringsState()` | Both wired |
| Preset switch | (none) | `switchPreset(name, async)` | Synchronous, double-buffered; no event hook |
| Volume / runtime params | (none) | `setRuntimeParameters(params)`, `setNewVolume(v)` | Synchronous, no event hook |
| Per-string physical params | (none) | `setNewPhysicalParameters`, `setNewExcitationBaseLevels`, `setNewHammerParameters`, `setNewModeParameters`, `setNewDeckParameters` | All synchronous |

#### Gaps vs user intent ("API is highly consolidated: one path to get notes and minimal number of other pathes")

| User intent | Current state | Gap |
|---|---|---|
| Two paths to receive commands (own listener OR backend) | Only backend path exists; "own listener" is vestigial. | Either build the C++ listener (Path C, deferred per original plan §2.4) OR explicitly drop "own listener" from the architecture and document. **This revision recommends: defer C++ listener but document the **placeholder slot** in the consolidated API so it can be added later without breaking callers.** |
| One path to get notes | Two paths today: `RealTimeEventBuffer.pushEvent(NOTE_ON)` AND `addOneString` direct. | Calibration / measurement scaffolding should be moved to the event path so the begin/commit envelope, source tagging, and Fix-MIDI handling are uniform. Or, calibration must explicitly own the engine for the duration (current behaviour, but undocumented). |
| Minimal number of other paths for other commands | Today: one path per command type, with sync direct + async event-route both available for the same operation. | The pybind surface should be partitioned into: (a) **event commands** (anything that should land at a specific cycle: notes, modes, sustain, reset) — go through pushEvent; (b) **state mutations** (anything that changes engine config: presets, runtime params, physical params) — synchronous direct calls (current behaviour, OK); (c) **observers** (audio readback, mic capture, profiling) — synchronous reads (current behaviour, OK). Document this partition and migrate callers. |

#### Recommended Layer-2 consolidated surface

```
Engine commands (target a synthesis cycle, go through RealTimeEventBuffer):
    pushEvent(PlaybackEvent)
        - NOTE_ON, NOTE_OFF, SUSTAIN              [musical]
        - TEST_STRING_ONLY, TEST_MODE_ONLY        [diagnostic]
        - RESET_STATE                             [state mutation that wants cycle alignment]
        - PARAM_UPDATE_SINGLE, PARAM_UPDATE_BATCH [granular param update — currently unused, plumb in]

Engine state mutations (synchronous, no cycle alignment needed):
    setRuntimeParameters, setNewVolume                    [global volume / runtime knobs]
    setNewPhysicalParameters, setNewExcitationBaseLevels  [per-string physics]
    setNewHammerParameters, setNewModeParameters, setNewDeckParameters
    loadPresetToLibrary, switchPreset, saveActiveToLibrary  [preset library]
    set_filter, switch_filter, setUpdatePolicy            [config]

Engine observers (synchronous reads):
    getRecordedAudio, getCurrentCycleAudio
    getRawSoundRecord, getSoundRecords
    getModeDisplacements, getOutputData, getParameters, getPianoidState
    fetchExcitation
    getCallbackStats, getRuntimeStats, getEngineStats
    startMicCapture, stopMicCapture, isMicCapturing
    listMicDevices, setMicDevice
    analyzeCapturedAudio*

Lifecycle (synchronous):
    devMemoryInit, initParameters, freeCudaMemory, shutdownGpu
    startApplication, stopApplication, isApplicationRunning
    startAudioDriver, stopAudioDriver, isAudioDriverActive
    runCycle, runSynthesisKernel, runOfflinePlayback   [exposed, but normally driven by engines]
```

The `addOneString`, `beginStringBatch`/`addStringToBatch`/`commitStringBatch`, `addModeExcitation`, `exciteMode`, `processSustain`, `updateSingleStringParameter_NEW`, `updateMultiStringParameter_NEW`, `resetStringsState` methods become **internal** to the dispatcher — they remain pybind-callable for offline test scaffolding (and for `OfflinePlaybackEngine` direct construction) but are marked deprecated for online use.

#### Files / lines

- `PianoidCore/pianoid_cuda/AddArraysWithCUDA.cpp:529-815` — pybind surface
- `PianoidCore/pianoid_cuda/AddArraysWithCUDA.cpp:390-411` — RealTimeEventBuffer pybind (the unified-path entry)
- `PianoidCore/pianoid_cuda/AddArraysWithCUDA.cpp:574-585` — addOneString / beginStringBatch / addStringToBatch / commitStringBatch / addModeExcitation / exciteMode (the per-call shortcuts)
- `PianoidCore/pianoid_cuda/AddArraysWithCUDA.cpp:716-741` — updateSingleStringParameter_NEW / updateMultiStringParameter_NEW (granular param update — the path that *should* be PARAM_UPDATE_* but isn't)

---

### 2.3 Layer 3 — Backend Python

#### Current state — event sources enumerated

| # | Source | Entry point | Path to engine | Authority / source tag | Cycle-aligned? | Apply Fix-MIDI? |
|---|---|---|---|---|---|---|
| 1 | **Hardware MIDI listener (unified)** | `MIDI_listener_unified` thread (`pianoid.py:1436`) | `schedule_event` → `add_realtime_event` → `RealTimeEventBuffer.pushEvent` → EventDispatcher | implicit "midi" (no tag passed; default `apply_fix_velocity=True`) | yes (target_cycle = current+1) | yes (default) |
| 2 | **REST `POST /play`** | `backendServer.py:1205` `play()` | `schedule_event` (unified branch) or `perform_midi_command` (legacy fallback) | from `data['source']`; `is_midi_source = source == 'midi'` | yes | only when `source=='midi'` |
| 3 | **WS `play`** | `backendServer.py:283` `handle_ws_play` | same as #2 | same | yes | only when `source=='midi'` |
| 4 | **REST `POST /play_keyboard`** | `backendServer.py:1411` | `schedule_event` with `apply_fix_velocity=False` for both NOTE_ON and NOTE_OFF | implicit "diagnostic sweep" | yes (delay_ms scheduling) | no (deterministic by design) |
| 5 | **REST `POST /play_mode/<n>`** | `backendServer.py:1317` | `pianoid.play_mode(...)` → eventually `pianoid.exciteMode` direct (offline) | n/a (not an event) | n/a (synchronous offline render) | n/a |
| 6 | **REST `POST /set_parameter`, `/set_string_excitation`, `/set_hammer_shape`, `/set_runtime_parameters`, `/set_mode_parameters`** | various | `_apply_parameter_request`, `setRuntimeParameters`, `setNewExcitationBaseLevels`, etc. — synchronous pybind | n/a (state mutation, not event) | n/a | n/a |
| 7 | **WS `set_parameter`, `set_string_excitation`, `set_hammer_shape`, `set_runtime_parameters`, `set_fix_velocity`** | `backendServer.py:395-` | mirrors REST #6 | n/a | n/a | n/a |
| 8 | **Calibration synthesis** (`/calibrate_synthesis`) | `backendServer.py:2516` `calibration_controller.calibrate_synthesis(...)` | (deeper investigation needed — likely calls `addOneString` or `play_mode` in a sweep loop) | implicit "calibration" | depends | depends |
| 9 | **Calibration acoustic** (`/calibrate_acoustic`) | `backendServer.py:2575` | same | same | same | same |
| 10 | **`/save_reference`, `/capture_reference`, `/normalize_volume`, `/calibration_curve/*`** | various calibration endpoints | similar | similar | similar | similar |
| 11 | **Test mode (`/start_test`)** | `backendServer.py:1795` | (likely calls test-mode events or direct `addOneString`) | implicit "test" | depends | depends |
| 12 | **`midi_playback`** (`/midi_playback`, MIDI file replay) | `backendServer.py:1662` | unknown (not reviewed); likely builds `EventQueue` and runs offline engine | n/a (offline render) | yes (cycle-accurate) | depends |
| 13 | **Modal adapter measurement triggers** | `modal_adapter.py:3865` | `pure_mode_test_function / exciteMode()` direct | implicit "measurement" | n/a (offline) | n/a |
| 14 | **Frontend space-bar play / virtual piano** | UI → WS `play` or REST `/play` | path #2 / #3 | `source: !=='midi'` (no tag) | yes | no |
| 15 | **Frontend Excitation editor live-trigger** | UI → WS `play` | path #3 | `source: !=='midi'` | yes | no |
| 16 | **`chartFunctions.py:2138` (test_string_function)** | direct `p.pianoid.addOneString(string_index, velocity)` | direct C++ call (BYPASSES event route) | implicit "test" | NO (bypasses cycle scheduling) | n/a (raw velocity) |
| 17 | **`chartFunctions.py:1223` (mode test chart)** | `pianoid.pianoid.exciteMode(mode_index, displacement, vel)` direct | direct C++ call (BYPASSES event route) | implicit "test" | NO | n/a |
| 18 | **`pianoid.py:1004` (`play_mode` python wrapper)** | `pianoid.pianoid.exciteMode(mode_no, q, vel)` direct | same | same | NO | n/a |
| 19 | **`pianoid.py:1055` (some addOneString wrapper)** | `pianoid.pianoid.addOneString(stringNo, velocity)` direct | same | same | NO | n/a |
| 20 | **`NoteTunner.py:3,6,14,17,32,35`** | `self.perform_midi_command(144/128, pitch, velocity)` | unified path | implicit (legacy alias) | yes | NO (legacy default) |

**Summary: ~20 distinct event-injection sites; ~5 different concurrency models; 2 different velocity policies.**

#### Gaps vs user intent ("treated uniformly without functionality duplication and with clear authority separation")

| User intent | Current state | Gap |
|---|---|---|
| All event sources treated uniformly | NOTE / SUSTAIN events go through `schedule_event`; calibration / measurement / mode test bypass it via direct `addOneString` / `exciteMode`; per-string parameter updates use a separate sync path. | **Major.** Three distinct paths exist for what the user thinks of as "telling the engine to do something." Calibration & measurement bypassing the buffer means: (a) they cannot be quantised against the audio cycle, (b) they cannot be back-pressured, (c) their latency/age is invisible to engine stats, (d) they can interleave with live MIDI in ways the EventDispatcher's per-cycle envelope does not see. |
| No functionality duplication | `schedule_event` and `perform_midi_command` are aliases (perform_midi_command sets `apply_fix_velocity=False`). REST `/play` has both unified and legacy paths (via `hasattr(pianoid, 'realtime_buffer')`). WS `play` mirrors REST `/play`. The unified branch and legacy fallback exist side-by-side. | Original plan only addresses MIDI ingress; it does not collapse `perform_midi_command` into `schedule_event` with explicit `apply_fix_velocity` arg, and does not delete the legacy fallback in `/play`. |
| Clear authority separation | Today: source tagging is implicit and inconsistent. `MIDI_listener_unified` doesn't pass a `source="midi"` tag to `schedule_event` — the clamp default is `True` because of the function default, not because of source-aware routing. REST/WS check `data.get('source')`. `play_keyboard` hardcodes `apply_fix_velocity=False`. | **No central ingress facade**. Each entry point makes its own decision about clamp, velocity transformation, dedup, lifecycle gate. Need an `EventIngress` class with explicit `(source, priority, clamp_policy, dedup_policy)` declared per source. |

#### Recommended Layer-3 unified ingress facade (target architecture)

```python
class EventIngress:
    """Single entry point for ALL backend event injection.

    All callers (MIDI listener, REST /play, WS play, /play_keyboard,
    calibration, measurement, test) go through this facade. The facade
    enforces source tagging, velocity policy, lifecycle gate, dedup,
    and pushEvent uniformly.
    """

    SOURCE_PRIORITIES = {
        'midi':         100,  # hardware MIDI = highest, pre-empts test/calibration
        'ui':            50,  # virtual piano, space-bar, Excitation
        'sweep':         30,  # /play_keyboard, calibration sweeps
        'measurement':   30,  # modal_adapter triggers
        'test':          10,  # diagnostic chart plays
    }

    SOURCE_POLICIES = {
        'midi':         {'apply_fix_velocity': True,  'dedup': True},
        'ui':           {'apply_fix_velocity': False, 'dedup': True},
        'sweep':        {'apply_fix_velocity': False, 'dedup': False},
        'measurement':  {'apply_fix_velocity': False, 'dedup': False},
        'test':         {'apply_fix_velocity': False, 'dedup': False},
    }

    def submit_note(self, source, command, pitch, velocity, *, delay_ms=0):
        ...   # routes to schedule_event with policy lookup

    def submit_mode_excitation(self, source, mode, q, v, *, delay_ms=0):
        ...   # currently goes through TEST_MODE_ONLY but bypasses dispatcher commit envelope

    def submit_string_test(self, source, string_index, velocity, *, delay_ms=0):
        ...   # currently bypasses event route entirely (chartFunctions.py:2138)

    def submit_param_update(self, source, param_name, target, value, *, delay_ms=0):
        ...   # currently bypasses event route (PARAM_UPDATE_* unused from Python)

    def submit_reset(self, source, *, delay_ms=0):
        ...   # currently calls resetStringsState directly
```

**Authority enforcement:** when the engine is in a calibration / measurement window, the ingress facade can either reject lower-priority events or queue them for after the calibration completes. Without the facade, today's behaviour is "whoever calls last wins" — calibration can race with live MIDI and the EventDispatcher cannot see it because calibration bypasses the buffer.

#### Files / lines

- `PianoidCore/pianoid_middleware/pianoid.py:814-888` — `schedule_event` (the only consolidated entry today)
- `PianoidCore/pianoid_middleware/pianoid.py:890-905` — `perform_midi_command` (alias, legacy default)
- `PianoidCore/pianoid_middleware/pianoid.py:1465-1508` — `add_realtime_event` (lower-level event push)
- `PianoidCore/pianoid_middleware/pianoid.py:1510-1538` — `_create_playback_event` (only NOTE_ON/NOTE_OFF/SUSTAIN supported; PARAM_UPDATE / TEST_* / RESET_STATE not produced from Python)
- `PianoidCore/pianoid_middleware/pianoid.py:1436-1463` — `MIDI_listener_unified`
- `PianoidCore/pianoid_middleware/backendServer.py:283-386, 1205-1315, 1411-1660, 1662-1735, 1795-1840, 2516-2640` — all event-touching REST/WS handlers
- `PianoidCore/pianoid_middleware/chartFunctions.py:1212-1245, 2125-2155` — bypass paths
- `PianoidCore/pianoid_middleware/modal_adapter/modal_adapter.py:3865` — measurement bypass
- `PianoidCore/pianoid_middleware/NoteTunner.py:3,6,14,17,32,35` — legacy alias users

---

### 2.4 Layer 4 — UI / Frontend

#### Current state

- **Frontend owns Web MIDI** (`useMidi.js:23-65`) — `navigator.requestMIDIAccess`, attaches `onmidimessage` per input device.
- **Every MIDI press calls `playNote(...)`** (`useMidi.js:83`) which routes through `usePreset` → `socketEmit('play', payload)` (Socket.IO) or REST `/play` fallback.
- **State exposed:** `midiKeysDown` (Set of currently held), `midiLastKeyDown` (last NOTE_ON), `midiLastKeyUp` (last NOTE_OFF), `midiIsConnected`, `midiLog`.
- **Consumer of state:** `PianoidTuner.js:1418-1421` — `useEffect` that calls `setSelectedPitch(midiLastKeyDown?.keyNumber)` when `virtualPianoSettings.autoSelect` is on.
- **CC filtered:** `useMidi.js:73-75` drops CC entirely (frontend never sees pedal).
- **Active sensing filtered:** `useMidi.js:72` drops `0xFE`.
- **Source tagging:** `PianoidTuner.js:207-210` `midiPlayNote` wraps `playNote` to add `source: "midi"` so the backend knows to apply Fix-MIDI clamp.
- **Other UI play sources** (`PianoidTuner.js`):
  - Sweep-mode UI (`isSweeping`, `sweepingNote`, `rangeOfPitches`) calls `playNote?.({ pitch, command: 144, velocity })` — synchronous trigger from a UI button.
  - Excitation editor / virtual piano click — `usePreset.playNote`, no source tag.
  - There is no space-bar handler in `PianoidTuner.js` (the old code is gone; the user's "space-bar" framing in §3 may be a virtual-piano pane-internal thing now).

#### Gaps vs user intent ("UI gets timely notification of last played note; switchable; consider bottom-up direct from C++")

| User intent | Current state | Gap |
|---|---|---|
| UI gets timely "last note pressed" notification | UI gets it directly because UI owns MIDI. After Layer-3 relocation, UI loses this and needs a backend broadcast. | Original plan's `midi_note_event` Socket.IO emit fills this — but it sends EVERY MIDI event, not "last note", so the UI must derive last-note from the stream. |
| Switchable | Today: not a concept — UI always sees MIDI it owns. After relocation: original plan adds the broadcast unconditionally. **No switch.** | **New requirement:** add a runtime toggle "broadcast MIDI events to frontend: yes/no". When off, the audio path is unaffected, the backend simply doesn't emit. UI shows "last-note-pressed indicator paused" or similar. |
| Bottom-up direct from C++ | Today: doesn't exist. After Layer-3 relocation: still doesn't exist (broadcast goes through Python `socketio.emit`). **Requires a separate WebSocket from the C++ engine process.** | **Out of scope for primary fix; document as deferred.** Building a C++ WebSocket server inside the engine process competes with audio cycle for CPU and is non-trivial. The Python broadcast latency budget (2–10 ms) is well below the 50 ms UX threshold for "last-note-pressed indicator", so direct-C++ is gold-plating. |

#### Recommended Layer-4 architecture

```
Tuning mode (default):
  Backend MIDI listener -> schedule_event (audio path)
                       \-> if (broadcast_enabled): socketio.emit('midi_note_event', {...})
                                                    -> frontend useMidi subscribes
                                                    -> setSelectedPitch updates

Pure-play mode (user actively playing, low-latency requested):
  Frontend toggles broadcast OFF via POST /midi/broadcast {"enabled": false}
  Backend: socketio.emit becomes no-op (or skipped at the listener-thread level
            to save the entire socketio call overhead and any GIL contention)
  Frontend useMidi state goes stale (acceptable; the user is playing, not tuning)
  When user wants to tune again: POST /midi/broadcast {"enabled": true}

Future (deferred, gold-plate):
  C++ engine spawns a lightweight WebSocket server (e.g. uWebSockets) on a
  separate port; the MIDI listener — once it exists in C++ — pushes "last
  note pressed" frames directly. Bypasses Python entirely. Requires building
  the C++ MIDI listener first (Path C, original plan §2.3).
```

#### Files / lines

- `PianoidTunner/src/hooks/useMidi.js` — entire file, target for rewrite (~130 LOC → ~30 LOC subscriber)
- `PianoidTunner/src/PianoidTuner.js:201-220` — `midiPlayNote` wrapper, `useMidi(midiPlayNote)` invocation
- `PianoidTunner/src/PianoidTuner.js:1418-1421` — `setSelectedPitch(midiLastKeyDown)` consumer (unchanged)
- `PianoidTunner/src/components/MidiComponent.jsx` — debug panel, candidate for deletion
- `PianoidTunner/src/hooks/useFixVelocity.js` — already does the GET-on-mount + POST/WS-on-toggle pattern that the broadcast toggle should follow

---

## 3. Cross-Layer Unified Architecture

### Target end-to-end flow (text diagram)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              EVENT SOURCES (Layer 3)                          │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Hardware MIDI         REST /play                Calibration / measurement   │
│  (rtmidi, BG thread)   WS  play                  /play_keyboard / /start_test│
│  source=midi           source=ui|midi            source=sweep|measurement|test│
│         │                    │                            │                  │
│         └──────┬─────────────┴────────────────┬───────────┘                  │
│                │                              │                              │
│                v                              v                              │
│         ┌─────────────────────────────────────────────┐                      │
│         │      EventIngress facade  (NEW)             │                      │
│         │  - source tagging                           │                      │
│         │  - apply_fix_velocity policy lookup         │                      │
│         │  - dedup policy lookup                      │                      │
│         │  - priority enforcement                     │                      │
│         │  - lifecycle gate (PLAYBACK_ACTIVE)         │                      │
│         │  - if broadcast_enabled: enqueue UI emit    │                      │
│         └────────────────────┬────────────────────────┘                      │
└──────────────────────────────┼───────────────────────────────────────────────┘
                               │
                               v
┌──────────────────────────────────────────────────────────────────────────────┐
│                          C++ MIDDLEWARE SURFACE (Layer 2)                     │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────┐      │
│  │                  (future) C++ MIDI listener                        │      │
│  │       (RtMidi callback, no GIL — Path C, deferred)                 │      │
│  │       feeds RealTimeEventBuffer.pushEvent directly                 │      │
│  └────────────────────────┬───────────────────────────────────────────┘      │
│                           v                                                  │
│            ┌──────────────────────────────────────────┐                      │
│            │   pianoidCuda.RealTimeEventBuffer        │                      │
│            │   .pushEvent(PlaybackEvent, target_cycle)│                      │
│            │   - thread-safe multimap, < 1 µs         │                      │
│            │   - back-pressure: evict oldest NOTE_OFF │                      │
│            └────────────────┬─────────────────────────┘                      │
│                             │                                                │
│  Direct paths (DEPRECATED for online; kept for OfflinePlaybackEngine + tests)│
│   - addOneString, addModeExcitation, exciteMode, processSustain              │
│   - updateSingleStringParameter_NEW, updateMultiStringParameter_NEW          │
│   - resetStringsState                                                        │
│  ╳ NOT ALLOWED in online flow — calibration & measurement migrate to events ╳│
└─────────────────────────────┼────────────────────────────────────────────────┘
                              │
                              v
┌──────────────────────────────────────────────────────────────────────────────┐
│                            KERNEL (Layer 1, CUDA)                             │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  OnlinePlaybackEngine::processEventsAtCycle(cycle):                          │
│      all_events = realtime_buffer_->drainEventsUpTo(cycle)                   │
│                 + event_queue_.getEventsAtCycle(cycle)                       │
│                                                                              │
│      ┌────────────────────────────────────────────────────────────┐          │
│      │  if (any NOTE_ON/NOTE_OFF/TEST_*/RESET in batch):          │          │
│      │      pianoid_->beginStringBatch()       <-- ENVELOPE OPEN  │          │
│      │  for (event in all_events):                                │          │
│      │      dispatcher_->dispatch(event)                          │          │
│      │      // dispatcher.handleNoteOn -> stageStringsForPitch    │          │
│      │      // (no commit — accumulates in noStrings_in_GP)       │          │
│      │      // dispatcher.handleParameterUpdate -> direct device  │          │
│      │      //   call (PARAM_UPDATE doesn't touch staging)        │          │
│      │      // dispatcher.handleSustain -> processSustain (same)  │          │
│      │      // dispatcher.handleTestMode -> stageModeExcitation   │          │
│      │      //   (NEW; same envelope as NOTE)                     │          │
│      │  if (envelope opened):                                     │          │
│      │      pianoid_->commitStringBatch()      <-- ENVELOPE CLOSE │          │
│      └────────────────────────────────────────────────────────────┘          │
│                                                                              │
│      runCycle({Online, record_to_host=true})                                 │
│         -> if (new_notes_ind > 1): parameterKernel + gaussKernel + addKernel │
│         -> otherwise:               addKernel only                           │
│                                                                              │
│  Capacity: MAX_STRINGS_PER_EVENT = 64 strings/cycle (~21 chord pitches).     │
│  Event count per cycle bounded by RealTimeEventBuffer.size_limit_            │
│  (default 0 = unbounded; set to e.g. 256 for safety).                        │
└─────────────────────────────┼────────────────────────────────────────────────┘
                              │
                              v
                          AUDIO OUT
                              │
                              │ (separately, off the audio path)
                              v
┌──────────────────────────────────────────────────────────────────────────────┐
│                                UI (Layer 4)                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  if (broadcast_enabled):                                                     │
│      EventIngress -> socketio.emit('midi_note_event', {cmd, pitch, vel, ts}) │
│            └─> useMidi (subscriber, ~30 LOC)                                 │
│                  - midiKeysDown Set                                          │
│                  - midiLastKeyDown / midiLastKeyUp                           │
│                  - PianoidTuner.setSelectedPitch(midiLastKeyDown.keyNumber)  │
│                                                                              │
│  if (NOT broadcast_enabled):                                                 │
│      EventIngress skips the emit entirely                                    │
│      useMidi state stays stale (acceptable when user is in pure-play mode)   │
│      Toggle UI: settings panel "Send MIDI feedback to UI: yes/no"            │
│                                                                              │
│  Future (deferred):                                                          │
│      C++ MIDI listener -> direct WebSocket from engine process -> useMidi    │
│      (bypasses Python; requires Path C C++ MIDI listener built first)        │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Single unified event flow — narrative

The user's framing of "single unified event flow that spans all 4 layers" maps to: **every ingestion of state-changing intent (note, mode excitation, test, reset, granular param update) becomes a `PlaybackEvent` pushed to `RealTimeEventBuffer`. The buffer is the single bottleneck. The `EventDispatcher` is the single fan-out from the buffer. State mutations that need cycle alignment (notes, modes) accumulate in a per-cycle batch; state mutations that don't (sustain CC, parameter updates) execute synchronously inside the dispatcher but outside the batch envelope.**

The original plan delivered a fragment of this (Layer-1 fix + Layer-3 ingress relocation for MIDI only). This revision extends it to: **all** event sources go through `EventIngress` → `RealTimeEventBuffer`, `addOneString` / `exciteMode` etc. become deprecated for online use, and the kernel-side envelope handles the full mixed-event-type case (not just NOTE_ON+NOTE_OFF).

### Layer-crossing duplication / authority confusion identified

1. **`schedule_event` vs `perform_midi_command`** — same Python function with different `apply_fix_velocity` defaults. Collapse to one.
2. **REST `/play` unified branch vs legacy fallback** — both live; remove legacy.
3. **`_create_playback_event` only handles 3 of 8 EventTypes** — extend so `EventIngress.submit_*` can produce all event types from Python.
4. **Calibration / measurement / mode-test bypass `RealTimeEventBuffer` entirely** — route through the facade.
5. **`addOneString` / `exciteMode` / etc. are pybind-callable from anywhere** — mark deprecated for online use; document the OfflinePlaybackEngine carve-out.
6. **`EventDispatcher::handleTestMode` calls `commitStringBatch` mid-loop** — must defer to the engine's per-cycle envelope (or be moved out of the dispatcher entirely).
7. **No consistent source tagging** — backend MIDI listener does not pass `source="midi"` (relies on schedule_event default); frontend MIDI does. Make explicit.
8. **Frontend MIDI ownership and backend MIDI ownership can co-exist** — port-ownership conflict; original plan addresses but only by hard-removing Web MIDI. Phase 3 must either hard-remove or add explicit gating.

---

## 4. Revised Phase Breakdown

The original 5 phases (Phase 0/1/2/3/4) survive but Phase 1 is **enlarged**, and 3 new phases are added. Numbering preserves continuity with the original plan: original Phase 4 becomes Phase 4 still (validation gates the *original* scope). New Phases 5/6/7 are the additional consolidation work.

### Phase 0 — Pre-flight bug fixes (UNCHANGED from original)

Same scope: replace `input()` port-prompt at `pianoid.py:1445` with config-driven port; resolve double-port-open in `MidiListener.__init__`; add `GET /midi/ports`. Effort: S (1–2 h).

### Phase 1 — Kernel batch fix, EXPANDED scope

**Original scope:** lift `beginStringBatch`/`commitStringBatch` envelope from per-event (in `exciteStringsForPitch`) to per-cycle (in `processEventsAtCycle`). Add `stageStringsForPitch` helper. Symmetric fix for offline. ~30 LOC.

**Added scope:**

1. **`TEST_MODE_ONLY` interleave fix** — `EventDispatcher.cu:189-191` calls `pianoid_->commitStringBatch()` directly. This must be replaced with `pianoid_->stageModeExcitation(mode_index, displacement, vel)` (new helper) so the engine's per-cycle envelope flushes it together with NOTE_ON staging. Without this fix, a same-cycle TEST_MODE_ONLY destroys partial NOTE_ON commits.
2. **`TEST_STRING_ONLY` interleave fix** — `EventDispatcher.cu:169` calls `pianoid_->addOneString(target_index, 64)` which is itself begin+commit. Same envelope issue. Replace with `stageStringsForPitch(pitch_for_string, velocity)` or a direct `addStringToBatch(target_index, velocity)` since this is already a string-index target.
3. **Unified `dispatchBatch`** — rewrite the vestigial `EventDispatcher::dispatchBatch` (`EventDispatcher.cu:58-63`) to be the actual batch entry point used by the engine drain. Inside, separate the events into "staging-touching" (NOTE/TEST_*/RESET) vs "side-effect" (PARAM_UPDATE / SUSTAIN); wrap the staging-touching ones in begin/commit, dispatch side-effect ones directly. Then `OnlinePlaybackEngine::processEventsAtCycle` becomes a one-line `dispatcher_->dispatchBatch(all_events)` instead of inlining the envelope logic.
4. **Document MAX_STRINGS_PER_EVENT semantics** — add comment that 64 is per-cycle string cap (~21 pitches), not per-event count cap. Per-event count is bounded by `RealTimeEventBuffer.size_limit_` (set default to 256 for safety).

**Files touched:** `EventDispatcher.cu`, `OnlinePlaybackEngine.cu`, `OfflinePlaybackEngine.cu`, `PlaybackCycleExecutor.cu`, `Pianoid.cu` (new `stageModeExcitation` helper that does `addModeExcitation` minus the commit), `RealTimeEventBuffer.cu` (default size_limit_ change), `constants.h` (comment).

**Effort:** M+ (3–5 h, was 2–3 h). +CUDA rebuild.

**Test:** original Test 1/2/3 plus new Test 4 (NOTE_ON + TEST_MODE_ONLY same-cycle: assert both string fundamental and mode response present), Test 5 (NOTE_ON + TEST_STRING_ONLY same-cycle).

### Phase 2 — Backend MIDI ingress activation (UNCHANGED from original)

Same scope: `emit_callback` parameter on `MIDI_listener_unified`; `socketio.emit('midi_note_event', ...)`; launcher sets `listen_to_midi=1`; `POST /midi/start` and `POST /midi/stop`. Effort: S (1–2 h).

### Phase 3 — Frontend simplification + switchable broadcast (EXPANDED)

**Original scope:** rewrite `useMidi.js` from Web MIDI owner to Socket.IO subscriber. ~30 LOC. Drop `midiPlayNote` wrapper.

**Added scope:**

1. **Switchable broadcast.** Add backend `POST /midi/broadcast {"enabled": bool}` and `GET /midi/broadcast` endpoints. The broadcast-enabled state is owned by the backend (single source of truth, mirroring `useFixVelocity`'s pattern). `MIDI_listener_unified`'s emit_callback checks this flag — when False, the entire `socketio.emit` call is skipped (saves Python overhead and any GIL contention). Frontend `useMidi` exposes `midiBroadcastEnabled` plus `setMidiBroadcast(bool)`.
2. **Settings UI.** Add a toggle in the existing Settings panel: "Send MIDI feedback to UI" — when off, the indicator shows "paused"; when on, follows backend events.
3. **MidiComponent.jsx fate** — same recommendation: delete.

**Files touched:** `useMidi.js`, `PianoidTuner.js`, `backendServer.py` (new endpoints), `pianoid.py` (broadcast flag check), Settings panel UI, `useFixVelocity.js` as template, REST_API.md.

**Effort:** S+ (2–3 h, was 1–2 h).

### Phase 4 — Validation & documentation (UNCHANGED from original, broaden scope to cover Phases 5-7 if executed)

Original tests 1-5 stand. Add:
- Same-cycle NOTE_ON + TEST_MODE_ONLY regression test (verifies Phase 1's expanded fix).
- Broadcast switchability test (toggle off; verify socketio.emit not called).

If Phases 5-7 ship, additional Phase 4 items will be specified in their phase definitions below.

### Phase 5 (NEW) — Layer-2 surface partition + deprecation

**Goal:** make the pybind surface explicit about the three categories (event commands / state mutations / observers). Mark `addOneString`, `addModeExcitation`, `exciteMode`, `processSustain`, `updateSingleStringParameter_NEW`, `updateMultiStringParameter_NEW`, `resetStringsState` as deprecated for online use; add docstrings explaining "use `RealTimeEventBuffer.pushEvent` instead".

**Deliverables:**
1. Update pybind docstrings in `AddArraysWithCUDA.cpp` for the listed methods to point to the unified path.
2. Extend `_create_playback_event` (`pianoid.py:1510`) to handle PARAM_UPDATE_SINGLE, PARAM_UPDATE_BATCH, TEST_STRING_ONLY, TEST_MODE_ONLY, RESET_STATE, TOGGLE_FEEDBACK so all 8 event types are producible from Python.
3. Document the partition in `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md` with the consolidated surface table.
4. Add a `Pianoid.assert_online_event_path_clean()` debug helper that walks `addOneString` / `exciteMode` / `processSustain` callsites at runtime via Python's audithooks (or a simple wrap-and-warn) — when in PLAYBACK_ACTIVE, log a warning with the call stack.

**Files touched:** `AddArraysWithCUDA.cpp` (docstrings only), `pianoid.py` (extend `_create_playback_event`), `SYNTHESIS_ENGINE.md` (new partition section), optionally `Pianoid.cu` (add a flag for "online lock").

**Effort:** M (3–4 h) — mostly docstring & doc work; minimal code logic.

**Test:** unit test that produces every EventType through `_create_playback_event` and verifies it survives a round-trip through `RealTimeEventBuffer` and arrives at `EventDispatcher`.

### Phase 6 (NEW) — Layer-3 EventIngress facade + bypass migration

**Goal:** all backend event sources route through one `EventIngress` class with explicit (source, priority, policy). Migrate calibration / measurement / chart-test bypasses (`chartFunctions.py:2138, 1223`; `modal_adapter.py:3865`; `chartFunctions.py:1212-1245`) to the event path. Collapse `schedule_event` and `perform_midi_command` aliases. Delete REST `/play` legacy fallback branch.

**Deliverables:**

1. **Create `EventIngress` class** (recommended location: `PianoidCore/pianoid_middleware/event_ingress.py`, new file). Constructor takes the `Pianoid` instance. Public methods per category (note / mode / string-test / param-update / reset). Each method takes `source` as required first arg, looks up policy from `SOURCE_POLICIES` dict, applies, calls `pianoid.add_realtime_event(...)`.
2. **Wire all REST/WS handlers** to use `pianoid.event_ingress.submit_note(source=..., command=..., pitch=..., velocity=..., delay_ms=...)` instead of `pianoid.schedule_event(...)`. Backend MIDI listener also passes `source='midi'` explicitly (no more relying on the function default).
3. **Migrate calibration & measurement bypasses.** `chartFunctions.py:2138` `addOneString(string_index, velocity)` becomes `event_ingress.submit_string_test(source='test', string_index=..., velocity=...)`. Mode test (`chartFunctions.py:1223`) becomes `event_ingress.submit_mode_excitation(source='test', mode=..., q=..., v=...)`. **However:** these bypasses are inside `with pianoid.cuda_lock:` blocks that imply the engine is **stopped** for offline rendering. So the migration is: when running offline, calibration uses the OfflinePlaybackEngine + EventQueue path (cycle-aligned); when running online, it uses the EventIngress facade.
4. **Delete `perform_midi_command`** (or make it a one-liner alias inside `EventIngress` for backward compatibility with NoteTunner.py callers; eventually update NoteTunner too).
5. **Delete REST `/play` legacy fallback** (`backendServer.py:1282-1314`). `realtime_buffer` is always initialized after `start_realtime_playback_unified`; the fallback is dead.
6. **Document policy table** in REST_API.md and OVERVIEW.md.

**Files touched:** new `event_ingress.py`; `pianoid.py` (collapse aliases); `backendServer.py` (rewire all event handlers); `chartFunctions.py` (replace bypasses); `modal_adapter/modal_adapter.py` (replace bypass); `NoteTunner.py` (use new facade); `REST_API.md`, `OVERVIEW.md`.

**Effort:** L (8–12 h) — many call sites to rewire; risk of breaking calibration regression unless tested carefully.

**Test:** existing calibration tests must pass unchanged (behaviour-preserving migration). New regression: assert `addOneString` is NOT called from any online code path during a live MIDI session (use the Phase 5 audit helper).

### Phase 7 (NEW) — Authority enforcement + back-pressure tuning

**Goal:** make priority-based authority real. When the engine is in a calibration / measurement window (driver-locked), lower-priority events are queued or rejected per policy. Set sensible `RealTimeEventBuffer.size_limit_` defaults.

**Deliverables:**

1. Add `EventIngress.set_authority_window(allowed_sources, duration_ms)` — calibration calls this to declare "only `source='measurement'` is allowed for the next N ms". Other events are queued (small bounded queue) or rejected (return False with reason). Frontend can show a "calibration in progress, MIDI muted" indicator.
2. Set `RealTimeEventBuffer.setSizeLimit(256)` as a sensible default — currently 0 (unbounded). 256 events at typical drain rate of ~1000 events/s is 256 ms of buffered MIDI; at 4-note chord = 64 chords; well above any realistic burst.
3. Add `engine_stats.dropped_events_per_authority_window` metric.
4. Document the authority model in OVERVIEW.md.

**Files touched:** `event_ingress.py`, `RealTimeEventBuffer.cu` (setSizeLimit default; already callable via pybind), `pianoid.py` (call setSizeLimit at startup), `chartFunctions.py` (calibration declares its window), `OVERVIEW.md`.

**Effort:** M (3–5 h).

**Test:** during `/calibrate_synthesis`, fire simulated NOTE_ONs from a Socket.IO client; assert they are dropped or queued per policy; assert calibration completes uninterrupted.

### NOT a phase: Direct C++ MIDI listener (Path C)

Same as original plan: defer indefinitely. Document the placeholder in the architecture diagram. If post-Phase-2 measured MIDI latency is still > 7 ms median, revisit. The Layer-4 "bottom-up direct from C++" notification is conditional on Path C existing, so it's also deferred — but the architecture diagram in §3 above explicitly shows where it would land.

---

## 5. Updated Decisions List

The original 11 decisions stand. New decisions surfaced by this 4-layer review:

### Group F — Layer 1 expanded scope (NEW)

**F1. Should the kernel envelope wrap TEST_MODE_ONLY and TEST_STRING_ONLY too, or should those become non-staging events?**
- Options: (a) wrap them in the same envelope as NOTE_ON/NOTE_OFF (recommended; preserves the "any same-cycle event coalesces" property the user asked for); (b) carve them out as direct device calls outside the envelope (loses coalescence for diagnostic events but keeps NOTE path simpler).
- **Recommended:** (a). Simpler, more uniform, the diagnostic events are infrequent enough that the envelope cost is negligible.

**F2. Set explicit `MAX_EVENTS_PER_CYCLE` cap?**
- Options: (a) keep MAX_STRINGS_PER_EVENT=64 as the de-facto cap, document it clearly; (b) introduce MAX_EVENTS_PER_CYCLE = 256 (or N) as a hard cap inside `processEventsAtCycle` with overflow logged to engine_stats.
- **Recommended:** (b). The user's framing "up to 64 events per cycle" suggests they want an explicit per-event count cap, not a per-string cap. Set `MAX_EVENTS_PER_CYCLE = 256` (well above any realistic burst, low enough to detect runaway feeds). Log overflows as engine_error.

### Group G — Layer 2 surface consolidation (NEW)

**G1. Remove deprecated direct paths from pybind, or keep with warning?**
- Options: (a) remove (clean break, but breaks any external scripts); (b) keep with `[[deprecated]]` attribute and runtime warning when called during PLAYBACK_ACTIVE.
- **Recommended:** (b). The OfflinePlaybackEngine + tests legitimately need direct calls; runtime gate by lifecycle state.

**G2. Build the C++ MIDI listener (Path C) now or defer?**
- **Recommended:** defer. Document the placeholder in §3 diagram. Re-evaluate after Phase 4 measurements.

### Group H — Layer 3 ingress consolidation (NEW)

**H1. EventIngress in `pianoid.py` or as its own module?**
- **Recommended:** new file `event_ingress.py`. Keeps `pianoid.py` (already 1500+ lines) from growing further; clear module boundary.

**H2. Migrate calibration / measurement bypasses to events, OR formalise the "engine paused" pattern?**
- Options: (a) all calibration goes through events even when offline (uses `OfflinePlaybackEngine` + `EventQueue`); (b) formalise "calibration takes the engine offline + uses direct calls" (current behaviour, but documented).
- **Recommended:** (a) for online calibration; (b) for offline render. This matches what's already mostly there (`pianoid.cuda_lock` blocks already imply engine pause for direct calls). The migration is mostly about online calibration paths.

**H3. Delete `perform_midi_command` and REST `/play` legacy fallback?**
- **Recommended:** delete both. The realtime_buffer is always initialised after Phase 0; the fallback is dead.

### Group I — Layer 4 switchability (NEW)

**I1. Per-event-type granular broadcast or single global toggle?**
- Options: (a) single toggle "broadcast all MIDI events: yes/no"; (b) per-type "broadcast notes / broadcast CCs / broadcast diagnostics".
- **Recommended:** (a) for now. Per-type is YAGNI; revisit if a CC-debug feature ships.

**I2. Backend default for broadcast: on or off?**
- **Recommended:** on. Tuning is the primary use case; user opts out for play sessions.

**I3. Direct-from-C++ WebSocket (bottom-up) — defer or scope now?**
- **Recommended:** defer. Document in §3 diagram only. Build cost > UX benefit at current latency budget.

---

## 6. Updated Effort Estimate

| Phase | Layer | Effort | Wall time (1 dev) |
|---|---|---|---|
| Phase 0 | Python middleware (pre-flight) | S | 1–2 h |
| Phase 1 | C++/CUDA kernel (EXPANDED — TEST_* envelope) | M+ | 3–5 h |
| Phase 2 | Python middleware + launcher (ingress activation) | S | 1–2 h |
| Phase 3 | Frontend (rewrite + switchable broadcast — EXPANDED) | S+ | 2–3 h |
| Phase 4 | Tests + measurement + docs (broadened) | M | 3–5 h |
| **Subtotal — original plan + expanded Phase 1/3** | | | **10–17 h** |
| Phase 5 (NEW) | Layer-2 surface partition | M | 3–4 h |
| Phase 6 (NEW) | Layer-3 EventIngress + bypass migration | L | 8–12 h |
| Phase 7 (NEW) | Authority enforcement + back-pressure | M | 3–5 h |
| **Total — full revised plan** | | | **24–38 h** |
| **Total — original-scope only (Phases 0-4)** | | | **10–17 h** |

The original 6–11 h estimate was for sequential execution with parallel Phase 0 + Phase 1. With the Phase 1 expansion (TEST_* envelope) and Phase 3 expansion (switchability), the original-scope-only timeline grows to **10–17 h sequential** (~6–8 h with Phases 0+1 in parallel).

The full revised plan is **24–38 h** — about 3–5 working days of focused work for one developer. Phases 5–7 are independently shippable and can defer.

---

## 7. Risk Register Update

Original risks (Phases 0-4) all stand. New risks introduced by the broader scope:

### Phase 1 expanded scope risks

| Risk | Mitigation | Rollback |
|---|---|---|
| TEST_MODE_ONLY envelope change breaks an offline diagnostic test that relied on the dispatcher's eager commit | Phase 4 must include a same-cycle NOTE_ON + TEST_MODE_ONLY test that asserts both fired; if any existing test depends on eager commit, fix the test (not the envelope) | `git revert` the dispatcher change; CUDA rebuild |
| `addOneString` removal from `handleTestMode` regresses TEST_STRING_ONLY behaviour | Keep `addOneString` available; just don't call it from inside the dispatcher — use `addStringToBatch` (no commit) | Restore the eager commit; document as known limitation |

### Phase 5 risks (Layer-2 surface partition)

| Risk | Mitigation | Rollback |
|---|---|---|
| External scripts (chartFunctions, NoteTunner, modal_adapter, tests) call deprecated methods and break | Phase 5 is docstring-only by default; runtime gate is opt-in via `set_lifecycle_strict_mode(True)` | Disable strict mode; keep deprecated docstrings |
| Producing PARAM_UPDATE / TEST_* events from Python introduces a new failure mode if the C++ handlers have bugs | Phase 5 includes round-trip tests for every EventType | Don't enable Python-side production of those event types until tests pass |

### Phase 6 risks (Layer-3 EventIngress)

| Risk | Mitigation | Rollback |
|---|---|---|
| Migrating calibration bypass to event path changes calibration timing in subtle ways | Calibration regression suite must run before/after; any timing change documented | `git revert` the calibration changes; keep facade for non-calibration paths only |
| EventIngress wraps every event submission with policy lookup overhead — adds latency to MIDI path | Benchmark in Phase 4 latency suite; if measurable, cache policy per source | Skip the lookup for `source='midi'` (hot path) |
| Deleting `/play` legacy fallback breaks an external script that relied on the fallback | Grep for `realtime_buffer` checks across the codebase; warn for one release before removal | Restore the fallback |

### Phase 7 risks (Authority enforcement)

| Risk | Mitigation | Rollback |
|---|---|---|
| Calibration's authority window blocks legitimate user MIDI input; user thinks the system is broken | Frontend MUST show a "calibration in progress, MIDI muted" indicator; UI blocks button presses too | Make the authority window advisory (log only) until UX is validated |
| `RealTimeEventBuffer.setSizeLimit(256)` causes evictions during legitimate dense passages | Monitor `engine_stats.dropped_event_count`; raise limit to 1024 if observed | Set limit back to 0 (unbounded) |

### Cross-cutting risks (NEW)

| Risk | Mitigation |
|---|---|
| Scope creep — Phases 5/6/7 each have their own subscope decisions and sub-fixes that surface during implementation | Strict gate: each phase ships independently; do not start the next until the previous is merged + manual UX validated |
| The 4-layer review uncovers a 5th layer (e.g. modal_adapter / Esprit channel timing — already ranked separately) | Treat each layer as a separate `/dev` agent; do not pool them |
| Calibration code is ~2500 LOC of `backendServer.py` (lines 2516-3070+) and was not deeply reviewed in this analysis | Phase 6 starts with a calibration-only sub-investigation before touching code |

---

## 8. Sign-off Gates

Same 3 gates as the original plan, with the broader scope:

### Gate 1 — Decisions confirmed (BEFORE any code edits)

User reviews the 11 original decisions PLUS the new decisions in §5 (Groups F/G/H/I — 9 new decisions) and confirms or overrides each. **Total: 20 decisions.**

Critical new decisions:
- F1 — TEST_* in same envelope as NOTE_*? (recommended: yes)
- F2 — Introduce explicit MAX_EVENTS_PER_CYCLE? (recommended: yes, 256)
- G1 — Remove deprecated direct paths or keep with warning? (recommended: keep with warning)
- G2 — Build C++ listener (Path C) now? (recommended: defer)
- H1 — EventIngress location? (recommended: new file `event_ingress.py`)
- H2 — Migrate calibration to events? (recommended: yes for online, no for offline)
- H3 — Delete legacy `/play` fallback and `perform_midi_command`? (recommended: yes)
- I1 — Per-type or global broadcast toggle? (recommended: global)
- I2 — Default broadcast on or off? (recommended: on)
- I3 — Direct-from-C++ WebSocket scope? (recommended: defer, document)

### Gate 2 — Phase 1 + Phase 0 merged, before activating ingress

Same as original. After Phases 0 and 1 land (separate commits), kernel batch fix passes the new TEST_* same-cycle regression test, the backend listener is *capable* of starting safely. Last "everything still works as before" snapshot.

### Gate 3 — Phase 4 measurements + manual UX sign-off

Same as original. Measured latency vs target, chord stress test, manual UX checklist, doc updates rendered correctly.

**NEW Gate 3a — Phase 5/6/7 sign-off (only if those phases ship):**
- Phase 5: every EventType produces a round-trip; deprecated docstrings rendered.
- Phase 6: every event source goes through EventIngress (audit log shows zero direct `addOneString` / `exciteMode` during PLAYBACK_ACTIVE); calibration regression passes.
- Phase 7: authority window blocks lower-priority events as expected; frontend shows the calibration indicator.

---

## 9. Recommended Execution Sequence

**Two recommended sequences depending on user appetite:**

### Sequence A — Original-scope only (10–17 h, ~1.5–2 days)

1. Spawn `/dev` agents in parallel: Agent A on Phase 0 (Python pre-flight), Agent B on Phase 1 (CUDA kernel + TEST_* envelope expansion).
2. Land both behind separate commits. Agent B's CUDA build is the long pole.
3. After both merged: Agent C on Phase 2 (ingress activation).
4. After Phase 2 merged: Agent D on Phase 3 (frontend rewrite + switchability).
5. After Phase 3 merged: Phase 4 in a single agent (validation + measurement + docs).

**Outcome:** chord pressing works; MIDI ingress relocated; UI subscribes; broadcast switchable. Layer-2 surface and Layer-3 bypass paths are NOT consolidated — `addOneString` still callable, calibration still bypasses event route.

### Sequence B — Full revised plan (24–38 h, ~3–5 days)

1–5 as above (original Phases 0-4).
6. After Phase 4 merged: Agent E on Phase 5 (Layer-2 surface partition + extending `_create_playback_event`).
7. After Phase 5 merged: Agent F on Phase 6 (EventIngress + bypass migration). **This is the longest single agent slot — split into Phase 6a (facade + REST/WS migration) and Phase 6b (calibration + chart bypass migration) if the agent slot is too large.**
8. After Phase 6 merged: Agent G on Phase 7 (authority enforcement).
9. Final regression sweep + doc render.

**Outcome:** every event source uses one facade with explicit policy; pybind surface is partitioned and documented; deprecated paths are warned about during PLAYBACK_ACTIVE; authority window blocks lower-priority events during calibration.

### Recommendation

**Ship Sequence A first (the user's original goal — fix chord-drop and MIDI latency). Re-evaluate Sequence B after Sequence A lands.** The Layer-2 / Layer-3 consolidation is architecturally desirable but has lower urgency than the user-facing defects. Sequence B becomes attractive when:
- A new event type is added and the producer-side `_create_playback_event` extension makes the work easier.
- Calibration latency / interleave issues surface in production.
- The pybind surface grows further and the "which is the right method to call" confusion bites a contributor.

---

## 10. Summary Table — What This Revision Adds vs Original

| Concern | Original plan | This revision |
|---|---|---|
| Kernel batch envelope | NOTE_ON + NOTE_OFF only (Option A, ~30 LOC) | + TEST_MODE_ONLY interleave fix; + TEST_STRING_ONLY interleave fix; + dispatchBatch becomes the actual entry; + explicit MAX_EVENTS_PER_CYCLE cap |
| C++ surface consolidation | Not addressed | Phase 5 — partition into event commands / state mutations / observers; deprecate direct event-style paths for online use |
| Backend ingress consolidation | Only MIDI listener relocation (one path) | Phase 6 — EventIngress facade for ALL ~20 sources; collapse aliases; delete legacy fallback |
| Authority / source policy | Implicit through `apply_fix_velocity` defaults and `is_midi_source` checks | Phase 6 — explicit policy table per source; Phase 7 — authority windows during calibration |
| Frontend broadcast | Always-on Socket.IO emit | Phase 3 — switchable backend-owned flag + UI toggle; emit skipped when off |
| Direct-from-C++ notification | Not considered | Documented in §3 diagram as deferred (requires C++ listener first) |
| PARAM_UPDATE event type | Mentioned as separate from batch envelope | Phase 5 — extend Python producer; Phase 6 — migrate `updateSingleStringParameter_NEW` callers to PARAM_UPDATE events |
| Calibration / measurement bypass | Not addressed | Phase 6 — migrate `addOneString` / `exciteMode` direct calls to event path (online); formalise offline carve-out |
| Effort estimate | 6–11 h | 10–17 h (original-scope only); 24–38 h (full plan) |
| Phase count | 5 | 8 (Phases 0-7) |
| Decision count | 11 | 20 |

---

## 11. One-Sentence Summary

The original plan correctly fixes the two acute defects (kernel chord-drop, frontend MIDI latency) but does not address three architectural debts the user's 4-layer review surfaces — TEST_* events that flush partial NOTE_* batches at the kernel level, ~20 backend event sources with no unified ingress facade and inconsistent authority/policy, and a Layer-2 pybind surface that lets calibration bypass the event buffer entirely — and the revised plan extends the original 5 phases with three new phases (Layer-2 surface partition, Layer-3 EventIngress, authority enforcement) to deliver the "single unified event flow that spans all 4 layers" the user asked for.

---

## Appendix — Cross-references

- Original consolidated plan: `docs/proposals/midi-system-refactoring-plan-2026-05-08.md`
- MIDI input relocation analysis: `docs/proposals/midi-input-relocation-analysis-2026-05-08.md`
- Kernel batch investigation: `docs/proposals/kernel-midi-batch-investigation-2026-05-08.md`
- Esprit channel timing analysis (out of scope for this plan): `docs/proposals/esprit-channel-timing-analysis-2026-05-08.md`
- Pybind surface: `PianoidCore/pianoid_cuda/AddArraysWithCUDA.cpp:529-815`
- EventDispatcher: `PianoidCore/pianoid_cuda/EventDispatcher.cu`
- OnlinePlaybackEngine drain: `PianoidCore/pianoid_cuda/OnlinePlaybackEngine.cu:218-259`
- RealTimeEventBuffer: `PianoidCore/pianoid_cuda/RealTimeEventBuffer.cu`
- PlaybackEvent enum: `PianoidCore/pianoid_cuda/PlaybackEvent.h:12-30`
- Python `schedule_event`: `PianoidCore/pianoid_middleware/pianoid.py:814-905`
- Python event production: `PianoidCore/pianoid_middleware/pianoid.py:1465-1538`
- Backend MIDI listener: `PianoidCore/pianoid_middleware/pianoid.py:1426-1463`
- Backend REST/WS event handlers: `PianoidCore/pianoid_middleware/backendServer.py:283-386, 1205-1315, 1411-1660`
- Calibration / measurement bypasses: `PianoidCore/pianoid_middleware/chartFunctions.py:1212-1245, 2125-2155`; `PianoidCore/pianoid_middleware/modal_adapter/modal_adapter.py:3865`
- Frontend MIDI hook: `PianoidTunner/src/hooks/useMidi.js`
- Frontend MIDI consumer: `PianoidTunner/src/PianoidTuner.js:201-220, 1418-1421`
