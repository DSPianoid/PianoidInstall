# Cycle Orchestration Refinement

**Status:** Research snapshot prepared by `cycle-ortho` on 2026-04-20,
revised same day after user design decisions. No source edits. Focused
exclusively on the C++ cycle orchestration + playback engine wiring, per the
user's 4-point streamlining target plus the 2026-04-20 decisions in §3a.

**Scope:** Everything between `executeSynthesisCycle()` and the audio driver /
sound buffer. Online + offline engines, `PlaybackCycleExecutor`, the Pianoid
wrapper layer (`executeSynthesisCycle`, `manageSoundBuffers`, `playSoundSamples`,
`appendRawSound`, `appendSoundRecords`, `recordCycleAudio`, `getCurrentCycleAudio`,
`executeSingleMeasurementCycle`, `startSynthesisCapture`/`stopSynthesisCapture`),
Pianoid lifecycle hooks used by cycle drivers (`startApplication`/`stopApplication`,
`beginMainLoop`/`endMainLoop`, `stopEngineKeepAudio`, `restartOnlineEngine`), and
the pybind surface these expose. `LockFreeCircularBuffer` + audio drivers are in
scope only from the "produce from cycle" side.

**Out of scope:** Python middleware, MIDI listener, parameter update paths,
frontend — covered in
[`PLAYBACK_ARCHITECTURE_REVIEW.md`](PLAYBACK_ARCHITECTURE_REVIEW.md).

**Companion docs:**
[`PLAYBACK_ARCHITECTURE_REVIEW.md`](PLAYBACK_ARCHITECTURE_REVIEW.md) §5 (event
side — not repeated here),
[`DISTORTION_INVESTIGATION_CONTEXT.md`](DISTORTION_INVESTIGATION_CONTEXT.md).

---

## Target Vision (user, 2026-04-20, verbatim)

> The code is very dirty — multiple overlapping paths, one line wrappers etc.
> Streamline the architecture.
>
> 1. **One cycle function**, that runs the synthesis cycle and either outputs
>    samples to the audio driver, or records them into sound buffer, or both.
> 2. Use **different functions** for audio output and for sound buffer
>    recording.
> 3. **One path** to call cycle function from online playback engine, with a
>    clear and streamlined path to feed in online events.
> 4. **One way** to call cycle function from offline playback engine, with
>    predefined event sequence.

The user specifically flagged `manageSoundBuffers` and `playSoundSamples` as
the dirty bundles.

---

## 1. Current State — Function Inventory

All file:line refs are against the working tree as of 2026-04-20
(`PianoidCore/pianoid_cuda/`). Wrappers are functions whose body is ≤3 lines
that forward to one other function.

| # | Function | File:line | Role | Wrapper? | Callers |
|---|---|---|---|---|---|
| F1 | `Pianoid::executeSynthesisCycle()` | `Pianoid.cu:1989–1992` | Returns status of `launchMainKernel()` | **Yes** — 1-line forward | `PlaybackCycleExecutor::executeCycle` (`.cu:25`); `Pianoid::executeSingleMeasurementCycle` (`.cu:2565`); 10 direct Python callers (see §2) |
| F2 | `Pianoid::launchMainKernel()` | `Pianoid.cu:2057–2212` | The actual synthesis: stringMap kernel, parameterKernel, gaussKernel, cooperative `addKernel` launch + sync; returns `*kernel_status` | No | F1 only (via pybind: no direct Python binding — reached through `executeSynthesisCycle`) |
| F3 | `Pianoid::manageSoundBuffers()` | `Pianoid.cu:1994–1998` | "Wrapper for playSoundSamples()" — 1-line forward | **Yes** | `PlaybackCycleExecutor::executeCycle` (`.cu:38`); `Pianoid::executeSingleMeasurementCycle` (`.cu:2567`); direct Python: `chartFunctions.py:2063`, `test_audio_driver.py:282`, `test_backendserver_audio.py:297` |
| F4 | `Pianoid::playSoundSamples()` | `Pianoid.cu:2255–2476` | Does THREE distinct things: (a) `appendRawSound("dev_soundFloat")` (recording), (b) if `audioOn` — optional FIR filter + channel mapping, (c) if `audioDriver` — `pushSamples()` (driver push) | No | F3 only |
| F5 | `Pianoid::appendRawSound(name)` | `Pianoid.cu:2492–2526` | Wraps `dev_soundFloat → rawSoundBuffer` cudaMemcpy into circular host buffer `rawSoundBuffer[5s × SR × num_ch]` | No | Only F4 at `Pianoid.cu:2260` |
| F6 | `Pianoid::recordCycleAudio()` | `Pianoid.cu:2000–2004` | "Wrapper for appendSoundRecords()" — 1-line forward | **Yes** | `PlaybackCycleExecutor::executeCycle` (`.cu:45`); direct Python: `chartFunctions.py:2064`, `test_audio_driver.py:283` |
| F7 | `Pianoid::appendSoundRecords()` | `Pianoid.cu:2480–2489` | `#ifdef PIANOID_DEBUG_DATA` only: copies `dev_sound_records_ms` into `dev_sound_records` chunked by `sound_record_index`. **No-op in release builds.** | No | F6 only |
| F8 | `Pianoid::getCurrentCycleAudio()` | `Pianoid.cu:2006–2038` | D2H copy of `dev_soundFloat` (or `dev_soundInt` → float conversion fallback) → `std::vector<float>` | No | `OfflinePlaybackEngine::collectAudio` (`.cu:277`); direct Python: `measurement_engine.py:340` |
| F9 | `PlaybackCycleExecutor::executeCycle(pianoid, record_audio, audio_enabled)` | `PlaybackCycleExecutor.cu:21–51` | **3-step sequence:** `recordTime(0)` → `executeSynthesisCycle()` → `recordTime(1)` → `if (audio_enabled) manageSoundBuffers()` → `recordTime(2)` → `if (record_audio) recordCycleAudio()` → `recordTime(LAST)` | No | `OnlinePlaybackEngine::run` (`.cu:103`); `OfflinePlaybackEngine::runCycle` (`.cu:254`) |
| F10 | `PlaybackCycleExecutor::processEvents(queue, dispatcher, cycle)` | `PlaybackCycleExecutor.cu:7–19` | Drain `EventQueue` at cycle and dispatch each event | No | `OfflinePlaybackEngine::processEventsAtCycle` (`.cu:238`). Note: `OnlinePlaybackEngine::processEventsAtCycle` (`.cu:215–256`) does NOT use F10 — it reimplements the drain + dispatch inline (see §3, Issue 4) |
| F11 | `PlaybackCycleExecutor::exciteStringsForPitch(pianoid, pitch, velocity)` | `PlaybackCycleExecutor.cu:57–78` | `beginStringBatch` → loop `addStringToBatch` → `commitStringBatch` for every string mapped to pitch | No | `EventDispatcher::handleNoteOn` (`.cu:71–75`, indirect via pybind/C++ dispatcher) |
| F12 | `PlaybackCycleExecutor::exciteStringBatch(p, strings, vels)` | `PlaybackCycleExecutor.cu:80–104` | Validate size match then run the same batch sequence | No | **Unused in C++ tree** (not called by any dispatcher/engine) — exposed via pybind only |
| F13 | `OnlinePlaybackEngine::run()` | `OnlinePlaybackEngine.cu:53–174` | Start audio (if `audio_enabled`) + application + cycle estimator, loop `processEventsAtCycle + executeCycle + drift sync`, stop | No | `Pianoid::runOnlinePlayback` (`.cu:2944`) |
| F14 | `OnlinePlaybackEngine::processEventsAtCycle(cycle)` | `OnlinePlaybackEngine.cu:215–256` | Drain realtime buffer, drain event queue, dispatch all via `dispatcher_->dispatch` (duplicates F10's logic for the queue half) | No | F13 |
| F15 | `OfflinePlaybackEngine::run()` | `OfflinePlaybackEngine.cu:53–184` | Check GPU init, check `shouldContinue() == false`, compute total cycles, pre-allocate recorded_audio_, loop `processEventsAtCycle + runCycle + collectAudio` | No | `Pianoid::runOfflinePlayback` (`.cu:2968`) |
| F16 | `OfflinePlaybackEngine::runCycle()` | `OfflinePlaybackEngine.cu:248–272` | Thin forward to `PlaybackCycleExecutor::executeCycle(pianoid_, config_.record_to_buffer, config_.audio_enabled)` + CUDA error check | **Yes** — private member, exists only so F15's body reads "runCycle()" instead of "PlaybackCycleExecutor::executeCycle(...)" | F15 |
| F17 | `OfflinePlaybackEngine::collectAudio()` | `OfflinePlaybackEngine.cu:274–290` | `getCurrentCycleAudio()` + bounds-checked copy into `recorded_audio_[audio_write_pos_..]` | No | F15 |
| F18 | `OfflinePlaybackEngine::processEventsAtCycle(cycle)` | `OfflinePlaybackEngine.cu:235–239` | 1-line forward to `PlaybackCycleExecutor::processEvents` | **Yes** | F15 |
| F19 | `OfflinePlaybackEngine::applyEvent(evt)` | `OfflinePlaybackEngine.cu:241–246` | Marked DEPRECATED in comment; forwards to `dispatcher_->dispatch` | **Yes, and dead code** — no callers in tree (removed from `run()` after unification) | — |
| F20 | `Pianoid::runOnlinePlayback(events, config)` | `Pianoid.cu:2928–2950` | Construct `OnlinePlaybackEngine`, `initialize`, `loadEvents`, `run()`, copy result into `last_recorded_audio_` | **Yes** (thin factory + delegate) | pybind only; Python calls `pianoidCuda.OnlinePlaybackEngine()` directly (`pianoid.py:1329`) and ignores this wrapper |
| F21 | `Pianoid::runOfflinePlayback(events, config)` | `Pianoid.cu:2952–2974` | Same pattern, offline engine | **Yes** (thin factory + delegate) | pybind — this IS used by Python (`pianoid.py:569`, `chartFunctions.py:1066`, 1183, 1319, 1490; `auto_tuner.py:93`; `synthesis_tuner.py:~120`) |
| F22 | `Pianoid::executeSingleMeasurementCycle()` | `Pianoid.cu:2563–2583` | `executeSynthesisCycle()`; if OK — `manageSoundBuffers()` + if `synthesisCaptureActive_` copy `dev_soundFloat → synthesisCaptureBuffer_` | No | pybind → `measurement_engine.py:~200`, `pianoid.py:502` (`run_measurement_cycles`) |
| F23 | `Pianoid::startSynthesisCapture()` | `Pianoid.cu:2655–2659` | Clear buffer + set `synthesisCaptureActive_ = true` | No | pybind → `measurement_engine.py:206` |
| F24 | `Pianoid::stopSynthesisCapture()` | `Pianoid.cu:2661–2667` | Clear flag + `std::move` buffer out | No | pybind → `measurement_engine.py:212, 233` |
| F25 | `Pianoid::stopEngineKeepAudio()` | `Pianoid.cu:2554–2561` | `endMainLoop()`; do NOT `stopAudioDriver()` | No | pybind → `pianoid.py::enter_calibration_mode` (semi-offline) |
| F26 | `Pianoid::restartOnlineEngine()` | `Pianoid.cu:2585–2592` | `beginMainLoop()` and log | No | pybind → `pianoid.py::exit_calibration_mode` |
| F27 | `Pianoid::beginMainLoop()` | `Pianoid.cuh:274` (inline) | `shouldContinueLoop_ = true; applicationIsRunning = true` | **Yes** (setter) | F25 indirectly; F26; `Pianoid::startApplication` (`.cu:1717`) |
| F28 | `Pianoid::endMainLoop()` | `Pianoid.cuh:275` (inline) | Complement of F27 | **Yes** (setter) | F25; `Pianoid::stopApplication` (`.cu:1748`); `Pianoid::shutdownGpu` (`.cu:1650`) |
| F29 | `Pianoid::shouldContinue()` | `Pianoid.cuh:276` (inline) | Read `shouldContinueLoop_.load()` | **Yes** (getter) | `OfflinePlaybackEngine::run` precondition (`.cu:85`); Python (`pianoid.py` `_stop_online_engine`) |
| F30 | `Pianoid::startApplication()` | `Pianoid.cu:1710–1726` | `beginMainLoop() + startAudioDriver()` + log max duration | No | `OnlinePlaybackEngine::run` (`.cu:72`) |
| F31 | `Pianoid::stopApplication(now)` | `Pianoid.cu:1728–1756` | Check max-duration flag; `endMainLoop()`; explicitly does NOT stop audio | No | `OnlinePlaybackEngine::run` (`.cu:148`) |
| F32 | `Pianoid::isApplicationIsRunning()` | `Pianoid.cu:1624–1626` | Read `applicationIsRunning.load()` | **Yes** | F13 loop condition (`.cu:92`); Python `isApplicationRunning` pybind |
| F33 | `Pianoid::startAudioDevice()` | `Pianoid.cu:2532–2534` | 1-line forward to `startAudioDriver()` | **Yes** | F13 (`.cu:68`) |
| F34 | `Pianoid::stopAudioDevice()` | `Pianoid.cu:2536–2538` | 1-line forward to `stopAudioDriver()` | **Yes** | F13 (`.cu:152`); Python |
| F35 | `Pianoid::pauseAudioPlayback()` | `Pianoid.cu:2540–2544` | `audioDriver->pause()` | Near-wrapper | F13 pause path (`.cu:181`) |
| F36 | `Pianoid::resumeAudioPlayback()` | `Pianoid.cu:2546–2550` | `audioDriver->resume()` | Near-wrapper | F13 resume path (`.cu:191`) |

### 1.1 Wrapper density

7 of the 36 functions above (F1, F3, F6, F16, F18, F19, F33, F34 — plus inline
setters F27/F28) are pure 1–2 line forwards. Net: **~9 wrappers for ~9
underlying operations** — the ratio is 1:1, which is the symptom the user
flagged.

### 1.2 Note on confusingly-named members

- `applicationIsRunning` (`Pianoid.cuh:171`) and `shouldContinueLoop_`
  (`Pianoid.cuh:178`) are kept in lockstep by F27/F28. The header comment on
  `applicationIsRunning` says "LEGACY: kept for backward compatibility, maps
  to `shouldContinueLoop_`". Two atomics, one concept.
- `audioOn` (`Pianoid.cuh:173`) and `audioDriverActive_` (`Pianoid.cuh:177`)
  are similarly kept in lockstep by `startAudioDriver`/`stopAudioDriver`
  (`Pianoid.cu:1678`, `1702`). Header comment on `audioOn` says "LEGACY: kept
  for backward compatibility". `playSoundSamples` checks `audioOn.load()` at
  `.cu:2265`. The new gate (`config_.audio_enabled`) is checked a layer up in
  `PlaybackCycleExecutor::executeCycle`. So **there are currently TWO gates
  suppressing driver push** (the executor gate and the `audioOn` gate in
  `playSoundSamples`). Either can cause silence; they are independent.

---

## 2. Current State — Concern-to-Path Map

For each primary concern, every file:line that performs it:

### 2.1 Synthesis step (GPU kernel launch)

| # | Path | File:line |
|---|---|---|
| S1 | Via executor | `PlaybackCycleExecutor::executeCycle` → `pianoid->executeSynthesisCycle` → `launchMainKernel` — `PlaybackCycleExecutor.cu:25` |
| S2 | Via measurement cycle | `executeSingleMeasurementCycle` → `executeSynthesisCycle` — `Pianoid.cu:2565` |
| S3 | Python-direct (flush deferred reset after `resetStringsState`) | `pianoid.py:567`, `auto_tuner.py:91`, `synthesis_tuner.py:125`, `chartFunctions.py:1075, 1196, 1332, 1500` (7 sites, identical idiom) |
| S4 | Python-direct (chart-read / single-sample dynamic) | `chartFunctions.py:514, 2062, 2470, 2482, 2570` |
| S5 | Test harness | `test_backendserver_audio.py:296`, `test_audio_driver.py:281` |

**Observation.** Only S1/S2 go through C++ cycle infrastructure. S3–S5 invoke
`executeSynthesisCycle()` directly from Python. S3 is the "flush deferred
reset" pattern — all 7 sites look identical (`resetStringsState();
executeSynthesisCycle()`). S4 uses it for "render one sample to sample the
string state" (dynamic shape charts, temporal force charts). S5 manually
composes the 3-step cycle (`executeSynthesisCycle + manageSoundBuffers +
recordCycleAudio`) for integration tests.

### 2.2 Driver push (GPU → audio hardware circular buffer)

| # | Path | File:line |
|---|---|---|
| D1 | Via executor, gated by `audio_enabled` | `PlaybackCycleExecutor::executeCycle` → `manageSoundBuffers` → `playSoundSamples` → `audioDriver->pushSamples` — `PlaybackCycleExecutor.cu:37–39` → `Pianoid.cu:1997` → `Pianoid.cu:2473` |
| D2 | Via measurement cycle (unconditional) | `executeSingleMeasurementCycle` → `manageSoundBuffers` → `playSoundSamples` → `pushSamples` — `Pianoid.cu:2567` |
| D3 | Python-direct | `chartFunctions.py:2063`, `test_backendserver_audio.py:297`, `test_audio_driver.py:282` |
| D4 | Gate inside `playSoundSamples`: `audioOn.load()` | `Pianoid.cu:2265` — if `audioOn == false`, early-return AFTER `appendRawSound`. This is a second independent silence gate |

**Observation.** Driver push is bundled with `appendRawSound` inside
`playSoundSamples`. The two concerns cannot be independently selected. The
`audio_enabled` flag in the executor (D1) and the `audioOn` flag inside
`playSoundSamples` (D4) are two separate kill-switches for the same action;
they're checked at different layers and one (D1) also kills recording while
the other (D4) does not.

### 2.3 Buffer record — "rawSoundBuffer" (5-second circular host buffer)

| # | Path | File:line |
|---|---|---|
| R1 | Via `playSoundSamples` (ALWAYS runs, even if `audioOn == false`, as long as `playSoundSamples` is called) | `playSoundSamples` → `appendRawSound("dev_soundFloat")` — `Pianoid.cu:2260` |
| R2 | Blocked when `manageSoundBuffers()` is skipped by executor | Cycle with `audio_enabled = false` — no R1 | — |

**Observation — this is the cohesion bug the user flagged.** `appendRawSound`
lives inside `playSoundSamples` before the `audioOn` early-return. So:
- If driver is alive (online): both driver push and `rawSoundBuffer` append
  happen.
- If `audioOn == false` but `playSoundSamples` is called: `rawSoundBuffer`
  appends, driver push skipped.
- If executor skips `manageSoundBuffers()` entirely (offline, `audio_enabled =
  false`): neither happens — **driver push skipped AS WELL AS
  `rawSoundBuffer` append.** This is exactly the regression `b50363c`
  introduced: offline chart functions couldn't read the circular sound
  buffer. The Python-side workaround (`_load_offline_sound_to_result` in
  `chartFunctions.py:39–55`) fetches from `getRecordedAudio()` instead, but
  the C++ coupling remains.

### 2.4 Buffer record — "recorded_audio_" (pre-sized offline output vector)

| # | Path | File:line |
|---|---|---|
| RO1 | Via executor, gated by `record_audio` | `PlaybackCycleExecutor::executeCycle` — `PlaybackCycleExecutor.cu:44` calls `recordCycleAudio` (which only does `appendSoundRecords`, and that's a debug-only no-op outside `PIANOID_DEBUG_DATA` builds — see F7). **So F6 is currently a no-op in release.** |
| RO2 | Via `OfflinePlaybackEngine::collectAudio` (the real mechanism) | `OfflinePlaybackEngine::runCycle` returns → next line in `run()` calls `collectAudio()` which calls `pianoid_->getCurrentCycleAudio()` and appends to `recorded_audio_` — `OfflinePlaybackEngine.cu:130–136, 274–290` |

**Observation.** There are TWO record-to-buffer mechanisms with the same
name-shape. (a) `recordCycleAudio → appendSoundRecords` is debug-build-only
and fills a separate `dev_sound_records` GPU buffer used by debug data
extraction. (b) `OfflinePlaybackEngine::collectAudio → getCurrentCycleAudio`
is what actually populates the offline result vector. The executor's
`record_audio` flag (F9 parameter) controls (a); the offline engine ignores
it for its real purpose and calls (b) itself. The two are unrelated despite
similar naming.

### 2.5 Synthesis capture — "synthesisCaptureBuffer_" (calibration reference)

| # | Path | File:line |
|---|---|---|
| SC1 | Via measurement cycle, only if `synthesisCaptureActive_ == true` | `executeSingleMeasurementCycle` does `cudaMemcpy(dev_soundFloat → synthesisCaptureBuffer_)` — `Pianoid.cu:2570–2580` |

**Observation.** A THIRD recording mechanism. Only runs in calibration mode
via the measurement-cycle path. Bypasses `appendRawSound` and
`recorded_audio_` entirely. Used by `measurement_engine.py:206–340`.

### 2.6 Event consume (drain + dispatch)

| # | Path | File:line |
|---|---|---|
| EC1 | Offline | `OfflinePlaybackEngine::processEventsAtCycle` → `PlaybackCycleExecutor::processEvents` — `OfflinePlaybackEngine.cu:238` |
| EC2 | Online — reimplements the drain inline | `OnlinePlaybackEngine::processEventsAtCycle` — `OnlinePlaybackEngine.cu:215–256`. Does its own `realtime_buffer_->drainEventsUpTo` + `event_queue_.getEventsAtCycle` + loop-dispatch, with stats accounting woven in. Does NOT call `PlaybackCycleExecutor::processEvents` |

**Observation.** EC1 and EC2 drain + dispatch but differ in whether they
consult `RealTimeEventBuffer` and whether they accumulate `EngineStats`. Two
implementations of drain-and-dispatch.

### 2.7 State reset + deferred-reset flush

| # | Path | File:line |
|---|---|---|
| RS1 | `Pianoid::resetStringsState()` | `Pianoid.cu:848–856` — zeros `dev_mode_running` + sets `resetFlag = true` |
| RS2 | "Flush deferred reset" idiom | `resetStringsState()` sets `resetFlag`; the next `launchMainKernel()` observes `resetFlag` at `Pianoid.cu:2161` and sets `*kernel_status = 500` (which is IGNORED by callers — see below). |
| RS3 | 7 Python callers do: `resetStringsState(); executeSynthesisCycle()` | `pianoid.py:566–567`, `auto_tuner.py:90–91`, `synthesis_tuner.py:~124`, `chartFunctions.py:1074–1075, 1195–1196, 1331–1332, 1499–1500` |

**Observation.** `resetFlag` fires a 500 status AFTER the reset cycle, but
every Python caller ignores the return. The purpose is that the synthesis
kernel observes the reset on entry, initializes the output on that cycle, and
the NEXT call produces meaningful audio. This is a semantic-only contract:
"one cycle after reset is discarded." The fact that it returns 500 is
vestigial.

### 2.8 Audio driver start/stop

| # | Path | File:line |
|---|---|---|
| AD1 | Online start | `OnlinePlaybackEngine::run` → `pianoid_->startAudioDevice()` → `startAudioDriver()` — `.cu:68, 1659` |
| AD2 | Online stop (unless `keep_audio_on_stop`) | `OnlinePlaybackEngine::run` → `pianoid_->stopAudioDevice()` → `stopAudioDriver()` — `.cu:152, 1686` |
| AD3 | Calibration keep-alive | `stopEngineKeepAudio()` — `endMainLoop()` only, audio stays up — `.cu:2554` |
| AD4 | Shutdown | `shutdownGpu()` calls `stopAudioDriver()` defensively — `.cu:1644–1647` |

**Observation.** Driver is `unique_ptr<AudioDriverInterface>` owned by
`Pianoid` (`Pianoid.cuh:184`). Created once in `devMemoryInit`. `start`/`stop`
are idempotent (atomic flag + mutex). No coupling between cycle function and
driver lifecycle — this is clean.

---

## 3. Cohesion + Coupling Problems

### Issue 1 — `playSoundSamples` bundles driver push + raw-sound recording

`Pianoid.cu:2255–2476`. The function does three things, with one inner gate:

```
  appendRawSound("dev_soundFloat");        // buffer record (UNCONDITIONAL)
  if (!audioOn) return;                     // driver gate
  <FIR filter + channel mapping>
  audioDriver->pushSamples(outputData, …); // driver push
```

**Consequence.** Offline paths that want "synthesize but don't push" (all of
them — every offline caller passes `audio_enabled=false`) have two bad
options:
- Call `manageSoundBuffers()` with `audioOn == false`: raw-sound recorded,
  driver skipped — but this only works when the online engine has been
  stopped and `audioOn` is already cleared, and it wastes the FIR-filter +
  channel-mapping codepath through the `audioOn.load()` early return.
- Skip `manageSoundBuffers()` entirely: raw-sound recording ALSO skipped.
  This is what `b50363c` introduced and what the surgical `_load_offline_sound_to_result`
  (`chartFunctions.py:39`) now works around. See also §2.3.

**Root fix:** separate the two concerns.

### Issue 2 — `manageSoundBuffers()` is a pure wrapper for `playSoundSamples()`

`Pianoid.cu:1994–1998`:

```cpp
void Pianoid::manageSoundBuffers() {
    playSoundSamples();    // plus a comment
}
```

No logic. No value. Every call path already called via the wrapper could
call `playSoundSamples()` directly — except "playSoundSamples" is a bad name
once the concern is split (it no longer only "plays"). `manageSoundBuffers`
is also a bad name (it "manages" one buffer and pushes to one driver, no
"management" happening).

### Issue 3 — `executeSynthesisCycle()` is a pure wrapper for `launchMainKernel()`

`Pianoid.cu:1989–1992`. Same pattern. Only value is "consistent interface
name." 14 Python call sites use `executeSynthesisCycle` directly (see §2.1).
The wrapper is cheap but it doubles the surface.

### Issue 4 — Two implementations of "drain + dispatch events at cycle"

See §2.6. `OfflinePlaybackEngine::processEventsAtCycle`
(`OfflinePlaybackEngine.cu:235–239`) is 1 line — it calls
`PlaybackCycleExecutor::processEvents`. `OnlinePlaybackEngine::processEventsAtCycle`
(`OnlinePlaybackEngine.cu:215–256`) is 42 lines and reimplements the whole
drain/dispatch because it needs the realtime buffer side and stats
accounting. The executor's `processEvents` helper is only half the story —
it doesn't know about `RealTimeEventBuffer`.

**Consequence.** Any change to dispatch semantics (burst handling, priority,
logging) has to be made in two places and kept in sync.

### Issue 5 — `OfflinePlaybackEngine::runCycle` is a wrapper around the executor

`OfflinePlaybackEngine.cu:248–272`. The body is "`PlaybackCycleExecutor::executeCycle(pianoid_,
config_.record_to_buffer, config_.audio_enabled)` + a CUDA error check".
`OnlinePlaybackEngine::run` does the same executor call inline (`.cu:103–107`)
and handles the CUDA error inline (`.cu:116–123`). One engine wraps, the
other inlines. Pick one.

### Issue 6 — `OfflinePlaybackEngine::applyEvent` is dead code

`OfflinePlaybackEngine.cu:241–246`. Marked `// DEPRECATED` in a comment,
forwards to `dispatcher_->dispatch`. No callers in the source tree. Not
exposed via pybind.

### Issue 7 — `recordCycleAudio` (F6) / `appendSoundRecords` (F7) is a release-mode no-op

`Pianoid.cu:2480–2489`:

```cpp
void Pianoid::appendSoundRecords() {
#ifdef PIANOID_DEBUG_DATA
    cudaDeviceSynchronize();
    if (sound_record_index < MAX_SOUND_RECORD_INDEX) {
        copyKernel<<<...>>>(dev_sound_records_ms, 0, dev_sound_records, …);
        cudaDeviceSynchronize();
    }
    sound_record_index++;
#endif
}
```

In release builds this is empty. Yet `PlaybackCycleExecutor::executeCycle`
calls it through `recordCycleAudio()` whenever `record_audio == true` — and
the doc comment at `PlaybackCycleExecutor.h:56–57` says "offline: usually
true". Offline callers pay for the no-op call (plus `recordTime(2)` + status
check), but the ACTUAL offline recording happens via
`OfflinePlaybackEngine::collectAudio` → `getCurrentCycleAudio` —
an entirely separate path (§2.4). So `record_audio` plumbing exists, is
passed around, but controls a no-op. **Pure cargo cult.**

### Issue 8 — Two gates can silence driver push

See §2.2 D1 vs D4. `config_.audio_enabled == false` (executor level) skips
`manageSoundBuffers` entirely. `audioOn == false` (inside `playSoundSamples`)
early-returns before the driver push but AFTER `appendRawSound`. These are
independent — you can silence via executor and the raw buffer stops; or
silence via `audioOn` and the raw buffer still fills. Confusing when
debugging "why is there no sound."

### Issue 9 — Legacy atomic lockstep pairs

`applicationIsRunning` ↔ `shouldContinueLoop_` and `audioOn` ↔
`audioDriverActive_`. Each pair is written together in F27/F28 and
`startAudioDriver`/`stopAudioDriver`. Doubled state. Not a cycle-function
problem per se, but every reader has to know about both, and `playSoundSamples`
reads the legacy one (`audioOn.load()` at `.cu:2265`) while engine code reads
the new one. Inconsistent reading amplifies Issue 8.

### Issue 10 — `PlaybackCycleExecutor::exciteStringBatch` (F12) is unused

`PlaybackCycleExecutor.cu:80–104`. Exposed via pybind, not called by any
C++ dispatcher or engine. Dispatcher uses `exciteStringsForPitch` (F11) for
pitch-based NOTE_ON. No caller for the generic batch variant. Dead surface.

### Issue 11 — `pianoid->runOnlinePlayback` (F20) is pybind-dead

`Pianoid.cu:2928–2950`. Creates an `OnlinePlaybackEngine`, runs it, returns
stats. But Python creates its OWN `OnlinePlaybackEngine` directly
(`pianoid.py:1329`) with `setRealTimeBuffer` wiring — because the
`runOnlinePlayback` wrapper doesn't expose the buffer-set step. Never
called. By contrast `runOfflinePlayback` (F21) IS used by Python — because
for offline, there's no realtime buffer to wire, so the wrapper suffices.

**Asymmetry:** one wrapper useful, one wrapper dead.

### Issue 12 — Naming drift

- `manageSoundBuffers` — manages zero buffers, one driver push.
- `playSoundSamples` — plays driver AND records raw, despite the name.
- `recordCycleAudio` — records nothing in release (see Issue 7).
- `executeSynthesisCycle` — executes a kernel, not a "cycle" in the
  `PlaybackCycleExecutor` sense.
- `runOnlinePlayback` on `Pianoid` — doesn't run the engine Python uses.
- `collectAudio` (offline only) — the actual recording primitive, but
  private and offline-specific.
- Class name `PlaybackCycleExecutor` is fine, but its `executeCycle` is only
  ONE of the concerns (it does 3 things). Compared with
  `OnlinePlaybackEngine::run()` / `OfflinePlaybackEngine::run()`, the method
  names don't form a consistent hierarchy.

---

## 3a. User Decisions (2026-04-20) + Audio-Sync Audit

### 3a.1 Decisions (verbatim intent)

1. **Online engine output set:** `driver + (optional) host_buffer`. Recording
   is NOT used online.
2. **Offline engine output set:** `recording only`. No driver push, no host
   buffer.
3. **Hard constraint — offline must be free-running.** Nothing in the
   offline path may block on audio-output synchronisation. Online today
   synchronises cycle pacing with the audio driver via the circular
   buffer's producer condvar; offline must NOT share that machinery —
   cycles should run at full GPU/CPU throughput.

**Consequence for §4.** The combinatorial `CycleOutput {push, record_host,
collect_recording}` space proposed earlier collapses to **two mutually
exclusive regimes** — there is no legitimate call site that would mix
"driver push" with "offline recording," nor "host-buffer ring" with
"offline recording," nor any run-time mode that toggles between them.

### 3a.2 Audio-sync audit — does offline block on the audio pipeline today?

**Verdict: No, under normal offline runs. But a latent hazard exists via a
Python-side lock (`cuda_lock`) that online MIDI excitation handlers
indirectly share.**

Evidence:

- **Blocking primitive:** `LockFreeCircularBuffer::produce()` at
  `CircularBuffer.cu:80–123`. Acquires `std::unique_lock<std::mutex>`
  (`.cu:80`) and waits on `canProduce.wait(lock, …)` at `.cu:89–91` until
  `write_position - read_position < num_chunks`. `cudaMemcpy` runs while the
  lock is released (`.cu:106–112`) but the pre-memcpy wait is the audio
  back-pressure point. Consumer-side `notify_one` fires from the audio
  callback thread (`.cu:164`).
- **Producers of `produce()`:** only `pushSamples()` on the three drivers
  (`ASIOAudioDriver.cpp:87`, `SDL3AudioDriver.cpp:327`, `SDLAudioDriver.cpp:130`).
- **Callers of `pushSamples()` from the synthesis side:** exactly one —
  `Pianoid::playSoundSamples` at `Pianoid.cu:2474`. Plus `SinewaveGenerator`
  (test path, not part of the engine).
- **Gate that protects offline from `playSoundSamples`:** the executor-level
  `audio_enabled` flag (`PlaybackCycleExecutor.cu:37`). Every offline caller
  in the tree passes `audio_enabled=false` (`pianoid.py:558`,
  `auto_tuner.py:83`, `synthesis_tuner.py:116`,
  `chartFunctions.py:1064, 1181, 1317, 1489`). So offline today NEVER
  reaches `produce()` and NEVER touches the condvar.
- **Conclusion on the C++ side:** no shared mutex between offline cycle
  execution and the audio-callback thread. `OfflinePlaybackEngine::run`
  (`.cu:53–184`) acquires no lock of its own. `PlaybackCycleExecutor::executeCycle`
  (`.cu:21–51`) acquires no lock. `launchMainKernel` (`Pianoid.cu:2057–2212`)
  uses `cudaDeviceSynchronize` (GPU-only) — not an audio-side mutex.
- **The latent hazard — Python `cuda_lock`:** `pianoid.cuda_lock` is a
  `threading.Lock` wrapped around almost every GPU-touching operation in
  the middleware. 30+ acquisition sites (sampled: `auto_tuner.py:89, 457, 570`,
  `calibration_controller.py:350, 899`, `chartFunctions.py:508, 1072, 1194,
  1326, 1330, 1340, 1497, 2465, 2494, 2564`, `parameter_manager.py:142, 150,
  157, 188, 193, 207, 250, 306, 416`). Offline renders take it
  (`auto_tuner.py:89`, `chartFunctions.py:1072, 1194, 1326, 1497`), AND
  online-side MIDI handlers / REST event pushes / parameter updates take it
  during online playback. Online's audio-callback thread (the consumer side
  of the condvar) does NOT take it. So `cuda_lock` does NOT create a
  direct condvar dependency for offline.
- **But:** when offline is invoked while online was running (the standard
  pattern — `_stop_online_engine` → offline render → `_restart_online_engine`),
  the offline render acquires `cuda_lock`, which serialises it against
  any pending producer of online events / parameter updates. Those
  producers do NOT block on the audio condvar themselves, so the chain
  doesn't reach the audio callback. The risk is one level removed:
  `cuda_lock` is an engine-wide serialisation point, and any future
  addition that makes the online engine thread hold `cuda_lock` while it
  waits on audio back-pressure would transitively bind offline to audio
  pacing. Today: safe. Design-time hazard: real.

### 3a.3 Findings addressed to the user's question

- **A. Does anything in the current offline path block on audio output?**
  No mutex shared with the audio callback is acquired by
  `OfflinePlaybackEngine::run`, `PlaybackCycleExecutor::executeCycle` (with
  `audio_enabled=false`), or `launchMainKernel`. No `produce()` call. No
  `canProduce.wait` exposure. No SDL3/ASIO code path is reached. Offline
  today is free-running in the sense required.
- **Latent risk worth calling out** (not a current bug): the Python
  `cuda_lock` is the one shared serialisation primitive between offline
  renders and online event pushes. It doesn't block on audio callbacks
  today, but it's the thread-safety sink for the whole engine. §6 tracks
  this as an informational note — not a new migration step — because the
  cycle-orchestration refactor doesn't interact with it.
- **B. Drop `recording` from online, drop `driver`+`host_buffer` from
  offline:** done in §4 (revised below). Two disjoint output regimes.
- **C. Migration plan updates:** see §6 (revised — one step removed, one
  simplified, no new steps needed for the sync hazard since the C++ side
  is already clean).
- **D. Open questions resolution:** see §8 (revised — 4 resolved, 3 open,
  3 superseded).
- **E. Impact on `2d922ff` Python fix:** confirmed compatible. See §7
  (revised — new subsection 7.5).

---

## 4. Proposed Target Architecture

**Guiding design choice.** The user's requirement 1 (one cycle function)
combined with the 2026-04-20 decisions (§3a.1) means **one cycle function
parametrised by regime, with two disjoint output regimes**:

- **Online regime** — synthesis + driver push + (optional) host-buffer ring
- **Offline regime** — synthesis + recording append, no driver, no ring

The cycle function itself never pushes bytes or writes to a vector — it
orchestrates and delegates to concern-specific primitives. That way each
concern lives in its own function (requirement 2), there's one cycle
function that orchestrates them (requirement 1), and the two regimes don't
overlap (§3a.1 points 1–2). The offline regime touches zero audio-driver
code paths (§3a.1 point 3, enforced structurally — the offline call site
never passes a flag that would invoke `pushCycleAudioToDriver`).

### 4.1 Single cycle function — `Pianoid::runCycle`

Two disjoint regimes, represented as tagged `CycleOutput`:

```cpp
// Pianoid.cuh
enum class CycleRegime : uint8_t {
    Online,   // synthesis + driver push + (optional) host-buffer ring
    Offline,  // synthesis + recording append (no driver, no ring)
};

struct CycleOutput {
    CycleRegime regime;

    // Online-only: populate rawSoundBuffer for live chart readout.
    // Ignored (and checked == false) when regime == Offline.
    bool        record_to_host = false;
};
```

The alternative (two subtype structs `OnlineOutput` / `OfflineOutput`) was
weighed and rejected — trade-off discussion below.

```cpp
// Returns status code (200 = success, else the kernel_status code).
// Replaces F1+F3+F4+F5+F6+F7+F9+F16+F17+F22 orchestration.
int runCycle(const CycleOutput& out);
```

Implementation (sketch — cite F#s from §1):

```cpp
int Pianoid::runCycle(const CycleOutput& out) {
    recordTime(0);
    int status = runSynthesisKernel();   // renamed F1/F2
    if (status != 200) return status;
    recordTime(1);

    switch (out.regime) {
        case CycleRegime::Online:
            pushCycleAudioToDriver();             // new (from F4 driver half)
            if (out.record_to_host) {
                appendCycleAudioToHostBuffer();   // new (from F4+F5 host half)
            }
            break;
        case CycleRegime::Offline:
            appendCycleAudioToRecording();        // new (from F17+F8)
            break;
    }
    recordTime(LAST_CONTROL_POINT);
    return 200;
}
```

**Why a tagged struct over two subtype structs.**

| Option | Pro | Con |
|---|---|---|
| **Tagged struct (chosen)** `CycleOutput {regime, record_to_host}` | One entry point, one pybind binding; switch statement is self-documenting; easy to test both regimes with one test harness | `record_to_host` is meaningless when `regime==Offline` — one assertion required |
| Two subtype structs `OnlineOutput{host_buffer}` / `OfflineOutput{}` + two overloads `runCycle(OnlineOutput)` / `runCycle(OfflineOutput)` | Offline's `OfflineOutput` is zero-arg — simplest call site. Regime encoded in type — no runtime check needed | Two pybind functions to bind; offline empty struct is strange; harder to share test fixtures |
| Two methods `runCycleOnline(bool record_to_host)` / `runCycleOffline()` | No struct at all. Clearest naming at call site. | Two near-identical function bodies; harder to factor a shared prologue / epilogue |

Recommendation: tagged struct. Ergonomics at the engine call site are fine
(`runCycle({CycleRegime::Offline, false})`), pybind stays single-entry, and
the switch inside `runCycle` makes the regime-exclusivity explicit.

**Naming choices to verify.** The project uses `executeSynthesisCycle`,
`manageSoundBuffers`, `recordCycleAudio`, `getCurrentCycleAudio` today; no
dedicated `NAMING_CONVENTIONS.md` found. The chosen names (verb phrases, no
"manage/handle" filler, one concern per name) match the
`startAudioDriver/stopAudioDriver` clean pairing introduced in the Phase 5
lifecycle API (`Pianoid.cuh:260+`). If the user prefers a different verb
(`run` vs `execute`) we can match.

### 4.2 Separated output functions — strict 1:1 concern:function mapping

Extracted from the body of `playSoundSamples` (`Pianoid.cu:2255–2476`):

| New primitive | Responsibility | Code it absorbs |
|---|---|---|
| `pushCycleAudioToDriver()` | Apply FIR filter (if on), channel map, compute `outputData`/`dataSize`, call `audioDriver->pushSamples`. No recording. | `Pianoid.cu:2265–2475` (everything after the `appendRawSound` line and the `audioOn` early return) |
| `appendCycleAudioToHostBuffer()` | D2H copy `dev_soundFloat` → `rawSoundBuffer` at `rawSoundWritePos % capacity`. | Current F5 (`appendRawSound`, `.cu:2492–2526`) — renamed + arg removed (always `"dev_soundFloat"` in practice; the only caller in-tree passes that literal) |
| `appendCycleAudioToRecording()` | D2H copy `dev_soundFloat` → offline `recorded_audio_` write head. | Fuse F17 (`OfflinePlaybackEngine::collectAudio`) + F8 (`getCurrentCycleAudio`) into a Pianoid-level primitive with an out-pointer the offline engine owns. Release-build semantics of F7 (`appendSoundRecords`) are a DEBUG-only no-op — move that behind `#ifdef PIANOID_DEBUG_DATA` inside `runCycle` as a separate flag or delete entirely. |

**Crucial consequence:** raw-sound host buffer and driver push become
independently selectable. The `b50363c` regression becomes structurally
impossible: offline sets `{push_to_driver=false, record_to_host=true,
collect_recording=true}` and both non-driver outputs survive.

**What goes away:**
- `manageSoundBuffers` (F3) — deleted, callers use `runCycle` or the
  primitives.
- `playSoundSamples` (F4) — decomposed into `pushCycleAudioToDriver`
  + `appendCycleAudioToHostBuffer`. Deleted as a named entry.
- `appendRawSound(name)` (F5) — renamed to `appendCycleAudioToHostBuffer()`
  (argument dropped; the literal `"dev_soundFloat"` is the only use).
- `recordCycleAudio` / `appendSoundRecords` (F6/F7) — either deleted (dead
  in release) or moved behind a diagnostic `#ifdef` and not plumbed into
  `runCycle`'s output flags.
- `getCurrentCycleAudio` (F8) — retained publicly as a debugging / one-shot
  accessor, but offline recording goes through the new
  `appendCycleAudioToRecording` primitive.
- `PlaybackCycleExecutor::executeCycle` (F9) — deleted. Its 3-step
  orchestration is now `Pianoid::runCycle`.
- `OfflinePlaybackEngine::runCycle` (F16) — deleted (inline the call).
- `OfflinePlaybackEngine::collectAudio` (F17) — deleted (folded into
  primitive).
- The second inner gate `audioOn.load()` inside `playSoundSamples` (D4) —
  deleted. The executor-level `push_to_driver` flag is the single gate.

### 4.3 Online engine — single feed path, single call site

```cpp
PlaybackStats OnlinePlaybackEngine::run() {
    pianoid_->startAudioDriver();
    pianoid_->beginMainLoop();
    cycle_estimator_->start(config_.sample_rate, config_.samples_per_cycle);

    // Online regime. record_to_host=true makes live chart readouts always
    // work (it was conditional on audio_enabled before; now unconditional
    // for the online regime).
    const CycleOutput out { CycleRegime::Online, /*record_to_host=*/true };

    uint32_t cycle = 0;
    while (pianoid_->shouldContinue() && notMaxDuration(cycle)) {
        if (!paused_.load()) {
            drainAndDispatchEvents(cycle);   // see below
            int status = pianoid_->runCycle(out);
            if (status != 200) { … break; }
            maybeCalibrateDrift(cycle);
            ++cycle;
            ++stats.total_cycles;
        } else {
            std::this_thread::sleep_for(10ms);
        }
    }

    cycle_estimator_->stop();
    pianoid_->endMainLoop();
    if (!config_.keep_audio_on_stop) pianoid_->stopAudioDriver();
    return stats;
}
```

**Note:** `config_.record_to_buffer` is no longer consulted by the online
engine (per §3a.1 point 1 — online never records). That field can be
deleted from `PlaybackConfig` as part of C6 or retained only for the
offline regime in `OfflinePlaybackEngine`.

- **Single event feed:** `drainAndDispatchEvents(cycle)` is the ONE method
  that consults both `realtime_buffer_` (live events from REST/WS/MIDI) and
  `event_queue_` (MIDI-file preload). Same dispatch loop. Stats accumulated
  inside. Replaces EC2 (`OnlinePlaybackEngine::processEventsAtCycle`).
  `PlaybackCycleExecutor::processEvents` (F10) is deleted — its behavior
  folds into `drainAndDispatchEvents` or a shared helper on the base class
  (`IPlaybackEngine`). Issue 4 resolved.
- **Single `runCycle` call site** in this engine. No branching on
  `audio_enabled` here — the `CycleOutput` struct encodes all decisions
  once, at the start of `run()`.
- `record_to_host = true` is UNCONDITIONAL online, so the 5-second chart
  readout buffer is always populated (current behavior online, made
  explicit). Previously it relied on `manageSoundBuffers()` being called,
  which in turn relied on `audio_enabled == true`.

### 4.4 Offline engine — single predefined-sequence path, free-running

```cpp
PlaybackStats OfflinePlaybackEngine::run() {
    if (!pianoid_->isGpuInitialized()) { … }
    if (pianoid_->shouldContinue()) { … }   // must not collide with online

    uint32_t total = calculateTotalCycles();
    recorded_audio_.assign(total * config_.samples_per_cycle, 0.0f);
    pianoid_->resetOfflineRecordingHead(recorded_audio_.data(),
                                       recorded_audio_.size());

    // Offline regime. record_to_host=false is enforced — even if set,
    // runCycle's switch won't reach it. Free-running: no driver, no
    // condvar, no audio-pipeline sync (§3a.1 point 3).
    const CycleOutput out { CycleRegime::Offline, /*record_to_host=*/false };

    for (uint32_t c = 0; c < total && !stop_requested_.load(); ++c) {
        drainAndDispatchEvents(c);     // queue only; no realtime buffer
        int status = pianoid_->runCycle(out);
        if (status != 200) { … break; }
    }
    return stats;
}
```

- **Single `runCycle` call site** — same function as online.
- **Single event source** — `event_queue_` only, no realtime buffer. The
  `drainAndDispatchEvents` helper handles the "no realtime buffer" branch
  by null-check, or offline overrides a smaller helper.
- **Free-running by construction.** The offline regime in `runCycle`
  dispatches ONLY to `appendCycleAudioToRecording` — a D2H cudaMemcpy plus
  a vector append. It does not call `pushCycleAudioToDriver`, which is the
  sole caller of `audioDriver->pushSamples` → `LockFreeCircularBuffer::produce`
  → `canProduce.wait`. So offline cannot reach the audio back-pressure
  condvar. Cycle pacing is gated by `launchMainKernel`'s
  `cudaDeviceSynchronize` only (`Pianoid.cu:2180`).
- **`config_.audio_enabled` is removed from the offline path** (per
  §3a.1 point 2 — offline never drives the audio hardware). The option
  to "play recorded audio through the driver" — part of the earlier
  offline vision in `PLAYBACK_ARCHITECTURE_REVIEW.md` §4.4 — migrates to
  a separate primitive (`Pianoid::pushPrerecordedAudio`, cited in M10 of
  the prior review). It is NOT a cycle-function concern.
- **No host-buffer ring during offline.** The ring (`rawSoundBuffer`) is
  for live chart readout of continuously running synthesis; offline's
  5s+event_queue window is instead the entire `recorded_audio_` vector,
  read from Python via `getRecordedAudio()`. This matches the `2d922ff`
  Python fix (see §7.5).

### 4.5 Data-flow diagram — two disjoint regimes

```
  ONLINE REGIME                                  OFFLINE REGIME
 =================                              =================

 REST/WS/MIDI producers                          MIDI file, test harness
         |                                              |
         v                                              v
 RealTimeEventBuffer                             EventQueue (pre-sorted)
         \                                              |
          \                                             |
           +----+ drainAndDispatchEvents(cycle) +-------+
                (online reads both;        (offline reads queue only)
                 offline reads only
                 the EventQueue)
                          |
                          v
   startAudioDriver()                     (no driver; no condvar exposure)
   beginMainLoop()
   estimator.start()
                          |                             |
                          v                             v
        runCycle({Online, record_to_host})    runCycle({Offline, false})
                          |                             |
                          v                             v
                 runSynthesisKernel()          runSynthesisKernel()
                          |                             |
          +---------------+                             |
          v                       v                     v
  pushCycleAudioToDriver  appendCycleAudioToHostBuffer   appendCycleAudioToRecording
    |                       |                             |
    v                       v                             v
  audioDriver->pushSamples    dev_soundFloat               dev_soundFloat
    |                        → rawSoundBuffer (5s ring)    → recorded_audio_[pos]
    v                        (live chart readout)          (per-session; read by
  CircularBuffer::produce                                   getRecordedAudio()
    — waits on canProduce                                   after run())
    condvar until consumer
    drains (AUDIO BACK-
    PRESSURE — online only)

  ┌──────────────────── Audio callback thread ────────────────────┐
  │  SDL3 / ASIO callback → CircularBuffer::consume → notify_one  │
  │                         ↑                                      │
  │               (consumer — signals condvar that unblocks        │
  │                the producer / synthesis cycle)                 │
  └────────────────────────────────────────────────────────────────┘
  (Exists only in the Online regime. Offline never reaches the
   driver, never touches this mutex. Free-running by construction.)
```

Exactly one orchestrator (`runCycle`), exactly three concern-specific
primitives (`pushCycleAudioToDriver`, `appendCycleAudioToHostBuffer`,
`appendCycleAudioToRecording`), and two mutually exclusive regimes that
route through different primitive subsets. Online and offline engines each
have ONE call to `runCycle`. No audio-pipeline synchronisation can reach
offline.

---

## 5. Streamlining Deltas — Per-Function Disposition

KEEP / MERGE-INTO-X / RENAME-TO-Y / DELETE, with reasons. Numbering matches
§1 F#s.

| F# | Current name | Disposition | Detail |
|---|---|---|---|
| F1 | `executeSynthesisCycle` | **RENAME-TO** `runSynthesisKernel` AND keep as public | Drop the "Cycle" word — this is the kernel step, not the cycle. The Python "flush deferred reset" idiom (§2.1 S3) keeps a direct callsite; rename it there too. Still a 1-line forward to `launchMainKernel`, but the name carries intent so it's justified. |
| F2 | `launchMainKernel` | **MERGE-INTO F1** | Inline into `runSynthesisKernel`. Only caller is F1, and the separation provides no value. Alternative: leave F2 as a private implementation detail and keep F1 as the public face. Recommended: inline unless a unit test or profiler hook references F2 directly (none found — confirm in M5 below). |
| F3 | `manageSoundBuffers` | **DELETE** | Pure wrapper. Callers migrate to `runCycle` or `pushCycleAudioToDriver`. Python test harness (`chartFunctions.py:2063`, `test_audio_driver.py:282`, `test_backendserver_audio.py:297`) migrates to `runCycle({push=true, record_host=true, collect=false})`. |
| F4 | `playSoundSamples` | **SPLIT** into `pushCycleAudioToDriver` (new) + `appendCycleAudioToHostBuffer` (new, from F5) | The body decomposes cleanly at the `appendRawSound` line and the `audioOn` early-return. Each half becomes its own function. `audioOn` gate deleted (Issue 8 resolved). |
| F5 | `appendRawSound(name)` | **RENAME-TO** `appendCycleAudioToHostBuffer()` | Drop the `name` argument — only "dev_soundFloat" is ever passed. Keeps the circular-buffer behaviour. |
| F6 | `recordCycleAudio` | **DELETE** (release). Optional: keep `#ifdef PIANOID_DEBUG_DATA` variant renamed `debugCopySoundRecords`. | Wrapper for F7 which is a debug-only no-op. Doc comment at `Pianoid.cuh:381–386` says "Used by offline rendering" — false; offline rendering uses `getCurrentCycleAudio` (F8). Issue 7. |
| F7 | `appendSoundRecords` | **DELETE** (release). Optional: keep behind `#ifdef PIANOID_DEBUG_DATA` as `debugCopySoundRecords`. | Ditto F6 — same body. |
| F8 | `getCurrentCycleAudio` | **KEEP** (public, for one-shot sampling) | Useful as a standalone D2H accessor for calibration (`measurement_engine.py:340`). Do not route it through `runCycle`. Offline's recording primitive reuses the same cudaMemcpy internally but owns the write head. |
| F9 | `PlaybackCycleExecutor::executeCycle` | **DELETE**. Behaviour moves to `Pianoid::runCycle` | Class `PlaybackCycleExecutor` becomes a dispatching helper only (F10+F11); consider renaming the class itself. See F10/F11 below. |
| F10 | `PlaybackCycleExecutor::processEvents` | **MERGE-INTO** `IPlaybackEngine::drainAndDispatchEvents(cycle)` shared helper | Both engines need this; factor up, delete the static. |
| F11 | `PlaybackCycleExecutor::exciteStringsForPitch` | **KEEP**, relocate out of a dying class | Either move to `EventDispatcher::exciteStringsForPitch` (it's already an event handler pattern) or keep as a free function in `PianoidPlayback` namespace. Do not keep `PlaybackCycleExecutor` as a single-method class. |
| F12 | `PlaybackCycleExecutor::exciteStringBatch` | **DELETE** | Dead. No callers. Issue 10. |
| F13 | `OnlinePlaybackEngine::run` | **KEEP** (simplified per §4.3) | Becomes significantly shorter once the executor is gone. |
| F14 | `OnlinePlaybackEngine::processEventsAtCycle` | **RENAME-TO / MERGE-INTO** `drainAndDispatchEvents(cycle)` | Same logic stays, moves to a shared base-class helper. |
| F15 | `OfflinePlaybackEngine::run` | **KEEP** (simplified per §4.4) | Body becomes much shorter once F16 + F17 disappear. |
| F16 | `OfflinePlaybackEngine::runCycle` | **DELETE** | Inline the `pianoid_->runCycle(out)` call in F15. Issue 5. |
| F17 | `OfflinePlaybackEngine::collectAudio` | **DELETE** | Fold into the new `appendCycleAudioToRecording` primitive on Pianoid (owns the write head via `resetOfflineRecordingHead(buf, len)` handoff from the offline engine). |
| F18 | `OfflinePlaybackEngine::processEventsAtCycle` | **DELETE** | Folds into base-class `drainAndDispatchEvents`. |
| F19 | `OfflinePlaybackEngine::applyEvent` | **DELETE** | Dead. Issue 6. |
| F20 | `Pianoid::runOnlinePlayback` | **DELETE** from both .cu and pybind | Unused by Python; Python uses `pianoidCuda.OnlinePlaybackEngine` directly. Issue 11. |
| F21 | `Pianoid::runOfflinePlayback` | **KEEP** (Python uses it) | Widely used in middleware (`pianoid.py:569`, `chartFunctions.py:1066, 1183, 1319, 1490`, `auto_tuner.py:93`, `synthesis_tuner.py:~120`). Single-entry wrapper is earning its keep here. |
| F22 | `Pianoid::executeSingleMeasurementCycle` | **MERGE-INTO** `Pianoid::runCycle({push=true, record_host=true, collect=false}) + maybeCaptureSynthesis()` | The body (§1 F22) is "synthesize + driver-push + optional capture." Replace with `runCycle` + a check of `synthesisCaptureActive_`. That turns the semi-offline calibration path into one call to `runCycle` with a specific config. |
| F23 | `startSynthesisCapture` | **KEEP** | Orthogonal concern (capture toggle). The copy into `synthesisCaptureBuffer_` can live inside `appendCycleAudioToRecording` or a dedicated `appendCycleAudioToSynthesisCapture` primitive — but keep the start/stop toggles as-is. Consider exposing `record_to_capture` as a fourth flag on `CycleOutput` to unify §2.5. |
| F24 | `stopSynthesisCapture` | **KEEP** | Same. |
| F25 | `stopEngineKeepAudio` | **KEEP** (semi-offline calibration entry) | No simplification opportunity at cycle-function level. Consumers clear. |
| F26 | `restartOnlineEngine` | **KEEP** | Pairs with F25. |
| F27 | `beginMainLoop` | **KEEP** inline setter | Fine. Issue 9 note: `applicationIsRunning` legacy atomic should be dropped — use `shouldContinueLoop_` only. But that's a separate cleanup, not a cycle-orchestration delta. |
| F28 | `endMainLoop` | **KEEP** | Same. |
| F29 | `shouldContinue` | **KEEP** | Offline engine precondition uses it (§1 F15). |
| F30 | `startApplication` | **RENAME or KEEP** — recommend KEEP | It's the "begin main loop + start driver" pair that online uses. After Issue 9 cleanup, reconsider. |
| F31 | `stopApplication` | **KEEP** | Same. |
| F32 | `isApplicationIsRunning` | **KEEP** (plus: fix the typo `IsIs`) | The method name has a stutter. Rename to `isApplicationRunning` in a minor cleanup. |
| F33 | `startAudioDevice` | **DELETE** (rename all callers to `startAudioDriver`) | 1-line forward. Pure alias. |
| F34 | `stopAudioDevice` | **DELETE** (rename all callers to `stopAudioDriver`) | Same. |
| F35 | `pauseAudioPlayback` | **KEEP** | Not a wrapper (slight value in name + null check), but consider renaming to `pauseAudioDriver` for consistency with the new naming. |
| F36 | `resumeAudioPlayback` | **KEEP** | Same. |

### 5.1 Inventory after streamlining

Post-delta, the cycle-orchestration surface is:

```
Pianoid:
    runSynthesisKernel()            // was F1/F2
    pushCycleAudioToDriver()        // was half of F4
    appendCycleAudioToHostBuffer()  // was F5 + other half of F4
    appendCycleAudioToRecording(out, len)  // was F17+F8 (recording path)
    runCycle(CycleOutput)           // new orchestrator
    getCurrentCycleAudio()          // unchanged
    runOfflinePlayback(events, cfg) // unchanged (Python uses it)
    executeSingleMeasurementCycle() // DELETED (merged into runCycle)
    startSynthesisCapture/stopSynthesisCapture      // unchanged

Engines:
    OnlinePlaybackEngine::run   (one call to runCycle)
    OnlinePlaybackEngine::drainAndDispatchEvents(cycle)
    OfflinePlaybackEngine::run  (one call to runCycle)
    OfflinePlaybackEngine::drainAndDispatchEvents(cycle)
    (shared helper in IPlaybackEngine, or duplicated cleanly)

Gone:
    manageSoundBuffers, playSoundSamples, appendRawSound (arg form),
    appendSoundRecords, recordCycleAudio, executeSynthesisCycle,
    PlaybackCycleExecutor (class), OfflinePlaybackEngine::runCycle,
    OfflinePlaybackEngine::collectAudio, OfflinePlaybackEngine::applyEvent,
    OfflinePlaybackEngine::processEventsAtCycle,
    OnlinePlaybackEngine::processEventsAtCycle (folded),
    Pianoid::runOnlinePlayback, exciteStringBatch,
    startAudioDevice, stopAudioDevice, audioOn inner gate
```

Net: ~14 surface items removed, 4 new (`runSynthesisKernel`,
`pushCycleAudioToDriver`, `appendCycleAudioToHostBuffer`,
`appendCycleAudioToRecording`). `runCycle` replaces `executeCycle`.

---

## 6. Migration Plan (revised 2026-04-20 for regime split)

Ordered. Each row lists scope, risk, size, blockers, and a test that locks
the behaviour. S = small (<100 lines), M = medium (100–500), L = large
(>500). Risk levels consider audio timing, offline determinism, and pybind
ABI stability.

**Key change from the original plan:** the regime split (§3a, §4) means
several steps shrink. Online never invokes offline primitives and
vice-versa, so there is no mixed-mode test matrix — each regime is tested
in isolation. `Pianoid::runOnlinePlayback` deletion is now trivial (per
§3a, online has no recording concern to worry about). No new migration
step is needed for the audio-sync constraint because the current offline
path already avoids `produce()` — the constraint is enforced
*structurally* by the regime-exclusive design in §4.

| # | Step | Scope | Size | Risk | Depends on | Mergeable alone? | Test to lock |
|---|---|---|---|---|---|---|---|
| C1 | **Delete dead code** — `F12` exciteStringBatch, `F19` applyEvent, `F20` runOnlinePlayback (and pybind binding). Simpler than before: `runOnlinePlayback` is doubly-dead under the new design because online never needed a recording-aware wrapper anyway. | `Pianoid.cu`, `PlaybackCycleExecutor.cu`, `OfflinePlaybackEngine.cu`, `AddArraysWithCUDA.cpp` | S | Low — confirmed no callers | — | Yes | Existing smoke tests still pass |
| C2 | **Introduce `CycleRegime` enum + `CycleOutput` struct** + add `Pianoid::runCycle(CycleOutput)` alongside existing functions. Body mirrors current `PlaybackCycleExecutor::executeCycle` via switch on regime. No callers yet. **Landed: `77479ea` (dev-568e, 2026-04-20).** Also reinstates the `dev_sound_records` archival path inline under `#ifdef PIANOID_DEBUG_DATA` (§8 Q4 resolution). | `Pianoid.cuh`, `Pianoid.cu`, pybind | S | Low — pure addition | — | Yes | Unit: call `runCycle({Online,true})` and `{Offline,false}`, verify synth + delegation to primitives |
| C3 | **Extract `pushCycleAudioToDriver` + `appendCycleAudioToHostBuffer`** from `playSoundSamples`. Delete `playSoundSamples`, `manageSoundBuffers`, `appendRawSound`, `audioOn` atomic, `audioOn` lockstep mirror writes, `PlaybackCycleExecutor::executeCycle`, and the `audio_enabled` parameter of `executeCycle`. Route both engines through `pianoid_->runCycle({regime, record_to_host})`. Migrate Python call sites (`chartFunctions.py`, `test_audio_driver.py`, `test_backendserver_audio.py`, `test_performance.py`). **Landed: `589fbe6` (dev-568e, 2026-04-20).** No aliases — per §8 no-legacy directive. | `Pianoid.cu`, `Pianoid.cuh`, `AddArraysWithCUDA.cpp`, `PlaybackCycleExecutor.*`, `OnlinePlaybackEngine.cu`, `OfflinePlaybackEngine.cu`, `PianoidProfiler.h`, 5 Python sites | M | **Med** — audio-output behaviour. Verified with live online `/play` (latency 0.867ms, baseline 1.384ms — improved), offline chart `Sound Max 0.171221` (byte-match to Tranche 1 baseline 0.171), 308/308 unit tests pass. | C2 | Yes | Audio: measured RMS before/after note-on under online engine. Offline WAV byte-identical. Regime exclusivity enforced structurally. |
| C4 | **Wire `runCycle` through `OfflinePlaybackEngine`.** Replace `runCycle()` (F16) + `collectAudio()` (F17) with a single `pianoid_->runCycle({CycleRegime::Offline, false})` call. Add `resetOfflineRecordingHead(vec)` helper on Pianoid. Drop `config_.audio_enabled` consultation from the offline path (per §4.4). | `OfflinePlaybackEngine.cu/.h`, `Pianoid.cu/.cuh` | M | Med — offline determinism. All 7 offline render callers must produce identical WAV output. | C2, C3 | With C2+C3 landed, yes | Offline golden: render a fixed MIDI at fixed preset, compare WAV bytes to pre-refactor reference. **New:** assert no `pushSamples()` call happens during offline (trace / mock). |
| C5 | **Wire `runCycle` through `OnlinePlaybackEngine`.** Replace `PlaybackCycleExecutor::executeCycle` call (OnlinePlaybackEngine.cu:103) with `pianoid_->runCycle({CycleRegime::Online, true})`. Drop `config_.record_to_buffer` from the online path. Verify chart readouts still work (`record_to_host=true` is unconditional online now). | `OnlinePlaybackEngine.cu` | S–M | Med — real-time audio timing. `runCycle` must not add latency. Profile it. | C2, C3 | With C2+C3 landed, yes | `/test-ui`: play a note, measure sound chart readout works, audio output present. |
| C6 | **Delete `PlaybackCycleExecutor::executeCycle` (F9)** and `OfflinePlaybackEngine::runCycle` (F16), `::collectAudio` (F17), `::processEventsAtCycle` (F18), `OnlinePlaybackEngine::processEventsAtCycle` (F14). Factor `drainAndDispatchEvents(cycle)` helper into `IPlaybackEngine` or duplicated cleanly across engines. Consider dropping `PlaybackConfig::record_to_buffer` (unused under regime split — online never records, offline always does). | `PlaybackCycleExecutor.cu/.h`, `OfflinePlaybackEngine.cu`, `OnlinePlaybackEngine.cu`, `PlaybackEngine.h` | M | Low–Med — all callers migrated by C4+C5. Pure deletion of now-unreachable code. | C4, C5 | No (depends on C4/C5) | Build + unit: online + offline engines still run, events dispatch. |
| C7 | **Delete `manageSoundBuffers` (F3), `playSoundSamples` (F4 stub), `appendRawSound` alias (F5 renamed).** Update `chartFunctions.py:2063`, `test_audio_driver.py:282, 283`, `test_backendserver_audio.py:297` to use `runCycle` instead. Update pybind bindings (`AddArraysWithCUDA.cpp:561, 563`). | `Pianoid.cu/.cuh`, `AddArraysWithCUDA.cpp`, 3 Python sites | M | Med — pybind removal is a breaking change. Any external consumer breaks. Internal tree has 3 Python sites total — easy to update. | C3, C6 | No | Smoke + audio verification. Run full test suite. |
| C8 | **Delete `recordCycleAudio` (F6), `appendSoundRecords` (F7)** in release builds. Keep `#ifdef PIANOID_DEBUG_DATA` path as `debugCopySoundRecords` if still needed by debug-data chart. | `Pianoid.cu/.cuh`, `AddArraysWithCUDA.cpp` | S | Low — release no-op, debug extraction verified via existing debug-data chart | — | Yes | Debug build: debug-data chart renders (no functional change). Release build: nothing changes. |
| C9 | **Merge `executeSingleMeasurementCycle` (F22) into `runCycle`.** Caller `run_measurement_cycles` in `pianoid.py:500–506` becomes `self.pianoid.runCycle(CycleOutput(push=True, record_host=True, collect=False))` plus explicit synthesis-capture append if `startSynthesisCapture` was called. Add `record_to_capture` flag on `CycleOutput` to unify §2.5 cleanly. | `Pianoid.cu/.cuh`, `AddArraysWithCUDA.cpp`, `pianoid.py`, `measurement_engine.py` | M | Med — calibration/measurement tests. Run volume-tuner and frequency-tuner integration tests to confirm. | C2 | With C2 landed, yes | Volume tuner full sweep test (existing test) produces identical results within tolerance. |
| C10 | **Rename `executeSynthesisCycle` → `runSynthesisKernel`** and inline `launchMainKernel` (F1+F2 merge). Update ~14 Python sites + 2 test sites (`chartFunctions.py`, `pianoid.py`, `auto_tuner.py`, `synthesis_tuner.py`, `test_*.py`). Keep `executeSynthesisCycle` as a deprecated alias for one release cycle. | `Pianoid.cu/.cuh`, `AddArraysWithCUDA.cpp`, ~14 Python sites | M | Low — mechanical rename with alias. | — | Yes | Existing test suite passes. |
| C11 | **Delete audio-device aliases** (F33 `startAudioDevice`, F34 `stopAudioDevice`). Update `OnlinePlaybackEngine::run` (`.cu:68, 152`) to call `startAudioDriver`/`stopAudioDriver` directly. Update pybind. | `Pianoid.cu/.cuh`, `OnlinePlaybackEngine.cu`, `AddArraysWithCUDA.cpp` | S | Low — alias removal | — | Yes | Build + smoke |
| C12 | **Fix `isApplicationIsRunning` typo** (F32 → `isApplicationRunning`). | `Pianoid.cu/.cuh`, `AddArraysWithCUDA.cpp` | S | Low | — | Yes | Build |
| C13 | **Optional: drop legacy atomics** (Issue 9). Replace `applicationIsRunning` + `shouldContinueLoop_` with a single atomic, same for `audioOn` + `audioDriverActive_`. | `Pianoid.cuh`, `Pianoid.cu` | M | Med — touches many call sites. Not required for the user's 4 goals but eliminates a residual source of confusion. | C3 (removes one reader of `audioOn`) | Independently mergeable after C3 | Build + smoke |

**Recommended sequence:** C1 + C8 + C10 + C11 + C12 (independent, low-risk
cleanup) land first. **C2 → C3** opens the split. **C4 || C5** (parallel
safe — different engines). **C6 → C7** closes the loop. **C9** can go in
parallel with any of C4/C5/C6. **C13** optional, last.

Total effective scope for hitting the user's 4 bullets: C1 + C2 + C3 + C4 +
C5 + C6 + C7. That's ~7 PRs; tranche them as the Tranche-A pattern allows.

---

## 7. Compatibility + Risk

### 7.1 Must not break

| Concern | Current guarantee | What could break it |
|---|---|---|
| **Real-time callback timing** | `OnlinePlaybackEngine::run` loop calls `executeCycle` once per audio callback cadence. `PlaybackCycleExecutor::executeCycle` does 3 `recordTime` calls + 3 primitive calls. | `runCycle` must keep the same ordering and not add any allocating operations in hot path. No added log statements inside `runCycle`. Profile before/after. |
| **Double-buffered preset swap** | `launchMainKernel` reads `run_string_map_kernel_` at `.cu:2081` and runs `stringMapKernel` once if a swap is pending. This must happen inside the synthesis kernel step, on the synthesis thread. | Moving synthesis kernel behind a different function name is fine. Moving it OUT of the same thread context is not — preset swap relies on it. `runSynthesisKernel` must still run on the engine thread. |
| **Offline determinism** | `resetStringsState + executeSynthesisCycle (flush deferred reset) + runOfflinePlayback` is the reset recipe (ctx-distortion context). `resetFlag` is checked on the next `launchMainKernel` entry. | `runSynthesisKernel` must preserve the `resetFlag` contract. Any rename that accidentally reorders F1/F2 against `resetFlag` check is a semantic break. |
| **`RawSoundBuffer` chart readout** | Today: online always fills it, offline fills it ONLY if `audio_enabled==true` (i.e., never, in practice — see §2.3 / Issue 1). | Target `record_host=true` unconditional online + true unconditional offline. Migration C4 + C5 must verify chart readouts (`chartFunctions.sound_function`) still work for both modes. |
| **pybind11 ABI** | Python calls `executeSynthesisCycle`, `manageSoundBuffers`, `recordCycleAudio`, `getCurrentCycleAudio`, `runOfflinePlayback`, `executeSingleMeasurementCycle`, `startAudioDevice`, `stopAudioDevice`, `startSynthesisCapture`, `stopSynthesisCapture`. | C3/C7 delete `manageSoundBuffers`. C9 deletes `executeSingleMeasurementCycle`. C10 renames `executeSynthesisCycle` (alias kept). C11 deletes device aliases. All of these require middleware edits in the same PR. Coordinate in tranches. |
| **ASIO driver restart failure** (WIP: "ASIO Driver Re-initialization Failure") | Current: offline path deliberately never stops the audio driver (`OfflinePlaybackEngine::run` skips `startAudioDevice`/`stopAudioDevice` entirely — `.cu:92` comment). | Target `runCycle({push_to_driver=false, …})` must NOT call any driver start/stop. Already the case in current `executeCycle` via the `audio_enabled` gate — must carry forward. |
| **`synthesisCaptureBuffer_` during calibration** | `executeSingleMeasurementCycle` captures into it when active (`.cu:2570`). | C9 merges into `runCycle` + `record_to_capture` flag. The cudaMemcpy must remain in the same ordering relative to synthesis kernel. Tests: volume tuner, frequency tuner (`auto_tuner.py`), synthesis tuner. |
| **`audioOn` external readers** | Legacy flag read by `playSoundSamples` (removed in C3). Is it read anywhere else? | Must verify. If no other reader, delete with Issue 9. If frontend queries it via another path, keep as a read-only mirror of `audioDriverActive_`. Covered in C13's scope. |

### 7.2 Rebuild surface

Changes listed touch `.cu`, `.cuh`, `.cpp` (pybind) — all trigger the `--heavy`
CUDA rebuild per `CLAUDE.md`. Plan tranches so each PR ships with a green
rebuild + backend smoke, never partial. The Tranche-A pattern
(`[impl-tranche-a]` branch, revert + roll-forward if regression) has proven
viable for this scope.

### 7.3 Middleware coupling

Python sites that need coordinated edits (exhaustive list from §2.1 +
pybind removals):

- C3/C7 `manageSoundBuffers` removal: `chartFunctions.py:2063`,
  `test_audio_driver.py:282`, `test_backendserver_audio.py:297`.
- C7 `appendRawSound` pybind: only `AddArraysWithCUDA.cpp` export; no
  Python caller. Safe deletion.
- C9 `executeSingleMeasurementCycle` removal: `pianoid.py:502`,
  `measurement_engine.py` indirectly via `run_measurement_cycles`.
- C10 `executeSynthesisCycle` rename (with alias): 14 Python sites — zero
  forced, but all should migrate. Alias retires next release.
- C11 `startAudioDevice`/`stopAudioDevice` removal: `AddArraysWithCUDA.cpp`
  only (search middleware — if any Python caller, update). Prior review
  didn't flag any.

### 7.4a Compatibility with the `2d922ff` offline-chart-readout Python fix

The `2d922ff` surgical fix routes offline chart readouts through
`getRecordedAudio()` (i.e., `recorded_audio_` / Recording) rather than
through `rawSoundBuffer` (HostBuffer ring). That direction is exactly
what the regime split in §4 prescribes for offline. **Not at risk from
this refactor.** Confirmed.

Specifically:
- `_load_offline_sound_to_result` in `chartFunctions.py:39–55` reads
  `pianoid.pianoid.getRecordedAudio()` and populates
  `pianoid.result.sound`. Under the revised design, offline's `runCycle`
  path exclusively populates `recorded_audio_` (the backing store for
  `getRecordedAudio()`). No change needed.
- The root C++ cohesion fix — separating `playSoundSamples` into
  `pushCycleAudioToDriver` + `appendCycleAudioToHostBuffer` (C3) — is
  still required. It's motivated by:
  (a) making the regime split structurally enforceable (one primitive
  per concern; a regime that doesn't call `pushCycleAudioToDriver`
  cannot accidentally block on audio back-pressure),
  (b) eliminating Issue 8 (two independent silence gates) and Issue 12
  (confusing naming), NOT by the `b50363c` regression itself — that
  regression was specifically about offline's `rawSoundBuffer`
  population, which under the new design is simply not a concern
  (offline doesn't populate `rawSoundBuffer`; it populates
  `recorded_audio_`).
- Post-refactor, the Python workaround `_load_offline_sound_to_result`
  becomes the canonical offline readout path rather than a workaround.
  Consider renaming it after C4 lands (cosmetic only; out of scope for
  this refactor).

### 7.4 Testing gaps

- **No online → offline → online state-snapshot test exists.** The prior
  review proposed one as M13. This refinement doesn't require it, but any
  C9-class change that touches calibration mode should gain at least a
  smoke test for "online run → semi-offline measurement cycle → resume
  online" to validate that `runCycle` variants compose safely.
- **No golden WAV comparison for offline render.** C4 needs one. Pick a
  fixed MIDI + fixed preset, checksum the output, compare before/after.
  Add to `tests/` under the existing offline-render harness.

---

## 8. Open Questions (revised 2026-04-20)

All 10 original questions resolved. Guiding rule from user (2026-04-20):
**"No legacy code left behind" — delete dead/legacy code outright; do not
keep deprecated aliases, stubs, or backwards-compat shims.** This collapses
every "delete vs alias" question to "delete."

Q1. **Orchestrator name** → **Resolved:** `Pianoid::runCycle`.

Q2. **Output primitive names** → **Resolved:**
`pushCycleAudioToDriver`, `appendCycleAudioToHostBuffer`,
`appendCycleAudioToRecording` (the fuller forms, not the abbreviated
`pushToDriver` etc.).

Q3. **`CycleOutput` struct vs bool args** → **Resolved** (design-time):
tagged-regime struct `CycleOutput {CycleRegime regime; bool
record_to_host;}`. Trade-off table in §4.1. Subsumed by the §3a.1 regime
split.

Q4. **`appendSoundRecords` / `recordCycleAudio` release no-op (F6/F7)**
→ **Resolved: DELETE outright.** Release builds are no-op; debug-only
`#ifdef PIANOID_DEBUG_DATA` branch goes with them. If debug-data
extraction still requires `sound_record_index` advancement, inline that
single statement inside `runCycle` behind the same `#ifdef` — not a
separate function.

Q5. **`recordCycleAudio` pybind binding** → **Resolved: DELETE from
pybind** (no alias). Python sites `test_audio_driver.py:283` and
`chartFunctions.py:2064` migrate to `runCycle` in the same PR.

Q6. **Online `record_host` unconditional** → **Resolved: yes** (per
§3a.1 point 1). Online regime = `driver + (optional) host_buffer`;
`record_to_host=true` unconditional keeps live chart readouts working.
Locked in §4.3.

Q7. **`record_to_capture` fourth flag on `CycleOutput`** → **Resolved:
no — moot under regime split.** Synthesis capture (§2.5) stays on
`synthesisCaptureActive_` toggle. The capture append
(`cudaMemcpy(dev_soundFloat → synthesisCaptureBuffer_)`,
`Pianoid.cu:2570–2580`) moves inside the appropriate regime's recording
primitive. `executeSingleMeasurementCycle` (F22) folds into online-regime
`runCycle({Online, true})` with a post-cycle capture-active check.

Q8. **Driver lifecycle ownership** → **Resolved: keep
online-engine-owned.** `OnlinePlaybackEngine::run` starts/stops the audio
driver (`.cu:68, 152`); offline never touches it. Target leaves the
asymmetry.

Q9. **Deletion vs deprecation aliases for pybind-removed functions**
(`executeSynthesisCycle`, `manageSoundBuffers`,
`executeSingleMeasurementCycle`, `startAudioDevice`,
`stopAudioDevice`) → **Resolved: DELETE outright** (no alias). Callers
migrate in the same PR as the deletion.

Q10. **Keep `runOfflinePlayback` wrapper (F21)** → **Resolved: keep.**
Python uses it; right-sized (offline has no `setRealTimeBuffer` to wire).
Asymmetry vs `runOnlinePlayback` (deleted per Q9) is intentional —
`runOnlinePlayback` was a broken wrapper (couldn't wire realtime
buffer); `runOfflinePlayback` is a correct thin wrapper.

Q11. **Legacy-atomic cleanup** (Issue 9: `applicationIsRunning` ↔
`shouldContinueLoop_`, `audioOn` ↔ `audioDriverActive_`) → **Resolved:
INCLUDE in this PR set.** Per "no legacy left behind":
- `audioOn` reader disappears with C3 (the `audioOn.load()` gate inside
  `playSoundSamples` is removed during decomposition). After C3,
  `audioOn` has zero readers — delete the atomic itself plus its
  lockstep mirror writes in `startAudioDriver` (`Pianoid.cu:1678`) and
  `stopAudioDriver` (`Pianoid.cu:1702`). **Scope folded into C3.**
- `applicationIsRunning` is maintained in lockstep with
  `shouldContinueLoop_` by `beginMainLoop`/`endMainLoop`
  (`Pianoid.cuh:274–275`). Readers: `OnlinePlaybackEngine::run` loop
  condition (`.cu:92`, via `isApplicationIsRunning()`) and pybind
  `isApplicationRunning`. Migrate readers to
  `shouldContinueLoop_`/`shouldContinue()`, then delete the atomic, the
  lockstep writes, and `isApplicationIsRunning` itself. **Merges with
  C12 typo fix into a single renamed step C13: "Delete legacy atomics +
  rename `isApplicationIsRunning` → `isApplicationRunning`".** Remains
  required (not optional) under the no-legacy directive.

Q12. **`cuda_lock` formalisation** → **Resolved: defer.** Not legacy —
live, working, heavily used. Not an audio-callback dependency (§3a.2).
Out of scope for cycle-orchestration refactor. Revisit as a separate
concern if a concrete problem arises.

### 8.1 Updated migration-plan scope (reflecting resolutions)

The resolutions tighten §6:

- **No aliases anywhere.** All `DELETE` rows in §5.1 and §6 become
  delete-without-alias. Callers migrate in the same PR as the deletion.
  No "keep for one release cycle" language applies.
- **C3 scope grows** to include `audioOn` atomic deletion + lockstep
  mirror-write removal. Risk class unchanged (Med — audio output
  behaviour); no new risk added since `audioOn` has no readers after
  the gate is deleted.
- **C12 merges into C13.** Rename C13 "Delete legacy atomics +
  rename `isApplicationIsRunning` → `isApplicationRunning`". Required
  under no-legacy directive, not optional.
- **C9** (merge `executeSingleMeasurementCycle` into `runCycle`) stays
  Med risk. Capture-append logic moves inside the recording primitive,
  conditional on `synthesisCaptureActive_` (Q7 resolution).
- **C7** (delete `manageSoundBuffers`, `playSoundSamples` stub,
  renamed `appendRawSound`) executes without alias bridges — the 3
  Python test sites migrate atomically.
- **C10** (rename `executeSynthesisCycle` → `runSynthesisKernel`)
  **no longer keeps a deprecated alias**. The ~14 Python call sites
  migrate in the same PR. Tranche this carefully — single PR with
  C++ + middleware edits.
- **C11** (delete `startAudioDevice`/`stopAudioDevice` aliases) — same
  rule: delete outright, migrate callers in same PR.

---

## 9. Evidence Cross-Reference

| Claim | File:line |
|---|---|
| `PlaybackCycleExecutor::executeCycle` 3-step | `PlaybackCycleExecutor.cu:21–51` |
| `audio_enabled` flag conditionally skips `manageSoundBuffers` | `PlaybackCycleExecutor.cu:37–39` |
| `manageSoundBuffers` is 1-line wrapper | `Pianoid.cu:1994–1998` |
| `executeSynthesisCycle` is 1-line wrapper | `Pianoid.cu:1989–1992` |
| `playSoundSamples` bundles recording + driver-push | `Pianoid.cu:2255–2476`; `appendRawSound` call at `.cu:2260`; `audioOn` gate at `.cu:2265`; `pushSamples` at `.cu:2473` |
| `recordCycleAudio` wraps debug-only no-op | `Pianoid.cu:2000–2004, 2480–2489` (`#ifdef PIANOID_DEBUG_DATA`) |
| `executeSingleMeasurementCycle` = synth + buffer + capture | `Pianoid.cu:2563–2583` |
| `OnlinePlaybackEngine::run` single executor call | `OnlinePlaybackEngine.cu:103–107` |
| `OnlinePlaybackEngine::processEventsAtCycle` reimplements drain | `OnlinePlaybackEngine.cu:215–256` |
| `OfflinePlaybackEngine::run` loop | `OfflinePlaybackEngine.cu:53–184` |
| `OfflinePlaybackEngine::runCycle` wraps executor | `OfflinePlaybackEngine.cu:248–272` |
| `OfflinePlaybackEngine::collectAudio` via `getCurrentCycleAudio` | `OfflinePlaybackEngine.cu:274–290` |
| `OfflinePlaybackEngine::applyEvent` dead | `OfflinePlaybackEngine.cu:241–246` |
| `Pianoid::runOnlinePlayback` unused by Python | `Pianoid.cu:2928–2950`; Python uses direct engine at `pianoid.py:1329` |
| `Pianoid::runOfflinePlayback` used by Python | `Pianoid.cu:2952–2974`; callers listed §5 F21 |
| Offline callers set `audio_enabled=False` | `pianoid.py:558`, `auto_tuner.py:83`, `synthesis_tuner.py:116`, `chartFunctions.py:1064, 1181, 1317, 1489` |
| Online sets `audio_enabled=True, keep_audio_on_stop=True` | `pianoid.py:1323–1326` |
| `rawSoundBuffer` circular, 5s × SR × num_channels | `Pianoid.cu:201–204`, `2492–2526` |
| Legacy atomics `applicationIsRunning` + `audioOn` | `Pianoid.cuh:171, 173` (comments mark LEGACY) |
| `audioOn` read by `playSoundSamples` | `Pianoid.cu:2265` |
| `audioDriverActive_` read elsewhere | `Pianoid.cu:1645, 1662, 1689, 2560, 2591` |
| Reset flag observed by `launchMainKernel` | `Pianoid.cu:2161–2164` |
| Python "flush deferred reset" idiom (7 sites) | `pianoid.py:566–567`, `auto_tuner.py:90–91`, `synthesis_tuner.py:~124`, `chartFunctions.py:1074–1075, 1195–1196, 1331–1332, 1499–1500` |
| Offline chart readout workaround | `chartFunctions.py:39–55` (`_load_offline_sound_to_result`) |
| pybind surface for cycle functions | `AddArraysWithCUDA.cpp:533–566`, `583–597` |
| Audio back-pressure condvar (producer waits) | `CircularBuffer.cu:80–91` (`std::unique_lock` + `canProduce.wait`) |
| Consumer notifies producer from audio callback | `CircularBuffer.cu:142, 164` |
| Only producer of `CircularBuffer::produce` | `SDL3AudioDriver.cpp:327`, `ASIOAudioDriver.cpp:87`, `SDLAudioDriver.cpp:130` |
| Only caller of `pushSamples` from synthesis | `Pianoid.cu:2474` (`playSoundSamples`) |
| `cuda_lock` acquisition sites in middleware | `auto_tuner.py:89, 457, 570`; `calibration_controller.py:350, 899`; `chartFunctions.py:508, 1072, 1194, 1326, 1330, 1340, 1497, 2465, 2494, 2564`; `parameter_manager.py:142, 150, 157, 188, 193, 207, 250, 306, 416` |
