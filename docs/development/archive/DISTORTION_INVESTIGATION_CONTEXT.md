# Distortion Investigation — Context Report

**Status:** Research snapshot prepared by `ctx-distortion` on 2026-04-20. No source
edits yet. Intended as the briefing document for a future fix agent.

**Scope:** Live-playback audio distortion — "hiccups plus some artifacts at the end of
the note, sometimes even after the note is off." Reproduces far more often through
hardware MIDI than through the space-key path.

---

## 1. User Observations (Ground Truth, 2026-04-20)

The user tested the current `dev` HEAD (just after the prior distortion-investigation
agents' work landed in commits `5137240`, `a3b8dc2`, `83ac75d`).

| Observation | Detail |
|---|---|
| Note-playing delays | **GONE after "fix1".** No further delay symptoms reported. |
| Distortion character | Hiccups plus artifacts **at the end of the note, sometimes continuing after the note is off**. |
| Input asymmetry (strongest clue) | **Space-played notes are almost always clear, even without warmup. MIDI notes are almost always dirty.** |
| SDL driver | Not yet re-tested on HEAD. |
| Volume dependence | Tested at medium volume; **no correlation between volume level and distortion** — rules out clipping / gain-stage saturation. |

Direct implications to bias investigation:

1. **Post-note-off artifacts** → release / envelope / damper-close path, buffer drain,
   or a per-channel persistent state (e.g. `sound_prev_diff`, mode `q`/`q_prev`) that
   is not being properly reset or that continues to feed residual energy after
   `NOTE_OFF`.
2. **MIDI-dirty vs space-clean** → the divergence is in the **input-event path BEFORE
   the kernel**, not in synthesis itself (same kernel, same preset, different
   audible result). Candidates: MIDI driver thread, event scheduling / target-cycle
   arithmetic, velocity/note-off payload differences, listener-thread CPU contention.
3. **Volume-independent** → excludes `dev_main_volume_coeff`, `max_volume`, clipping
   in `Sint32(diff * max_volume^(level/127))`, and the 2nd-derivative magnitude
   boundary artifact as linear-amplitude bugs.

---

## 2. Playback System Architecture (relevant to distortion)

Primary sources: `docs/architecture/SYSTEM_OVERVIEW.md`,
`docs/architecture/DATA_FLOWS.md`, `docs/modules/pianoid-cuda/PLAYBACK_SYSTEM.md`,
`docs/modules/pianoid-middleware/MIDI_SYSTEM.md`. No prior `analyser-playback` report
exists under `docs/` (grep confirmed — only this file mentions MIDI-dirty/space-clean).

### 2.1 Two MIDI input paths, one common downstream

```
MIDI hardware          Browser (space key)
rtmidi port 0              POST /play
      │                        │
      ▼                        ▼
MIDI_listener_unified    backendserver.play() @ backendserver.py:1162
 (pianoid.py:1353)        (handles its own dedup via last_command)
      │                        │
      └────────┬───────────────┘
               ▼
     pianoid.add_realtime_event(event_type, data1, data2, delay_ms=0)
               @ pianoid.py:1391
               │
     target_cycle = estimator.getCurrentCycle() + 1    # delay_ms == 0 branch
     event = _create_playback_event(event_type, data1, data2)
     realtime_buffer.pushEvent(event, target_cycle)
               │
               ▼
     OnlinePlaybackEngine.run()  (C++ engine thread)
       each cycle:
         drainEventsUpTo(current_cycle)
         EventDispatcher::dispatch(event)
         PlaybackCycleExecutor::executeCycle(pianoid, record)
```

### 2.2 Event-construction differences to audit

The Python-level `add_realtime_event` wraps NOTE_OFF's velocity as **hardcoded `0`**
(pianoid.py:1385), regardless of the release velocity the keyboard sent:

```python
elif status == 128 or (status == 144 and data2 == 0):  # Note Off
    self.add_realtime_event(pianoidCuda.EventType.NOTE_OFF, data1, 0)
```

Downstream `EventDispatcher::handleNoteOff` (EventDispatcher.cu:84-93) then calls
`exciteStringsForPitch(pianoid_, pitch, 0)`. With velocity=0,
`_add_string_for_playback` (Pianoid.cu:1763) sets `dec_open[stringNo] = DUMP_CLOSED`
**on the host vector** and schedules the GPU upload of `dev_dec_open` for the next
`new_notes_ind > 0` branch in `launchMainKernel` (Pianoid.cu:2096). This is the
damper-close path used by **both** MIDI and space-key. Both should close dampers
identically.

The C++ `MidiInputListener` + `MidiEventConverter::fromMidiBytes` path (the low-
latency alternative advertised in PLAYBACK_SYSTEM.md §MidiInputListener) packs
NOTE_OFF's `data2` (release velocity) into `event.data`, but `handleNoteOff` extracts
only the pitch byte and discards the release velocity. So both input paths converge
on exactly the same `exciteStringsForPitch(..., 0)` call. **No payload divergence
at the kernel boundary.**

### 2.3 Listener-thread topology and timing

`MIDI_listener_unified` (pianoid.py:1353-1389) is a **pure busy-wait loop** — no
`time.sleep`, no backoff. `listener.get_message()` returns `None` when no message
and the loop `continue`s immediately. On Python this will peg the listener thread at
effectively 100 % CPU whenever the keyboard is idle (rtmidi `get_message` itself is
non-blocking).

The space-key path reaches `add_realtime_event` from a **Flask worker thread** which
only runs during an active HTTP POST — no idle contention, and the inter-event gap
is whatever the browser sends (≥20–50 ms typical).

Two implications for timing jitter that could produce MIDI-dirty / space-clean:

- The busy-wait MIDI thread can starve the engine thread on the same logical CPU
  during note-on bursts if thread affinities are not set. The engine thread drives
  `executeSynthesisCycle()` → `manageSoundBuffers()` → `recordCycleAudio()` in a
  tight loop paced by the audio driver; any long stall can cause `drainEventsUpTo`
  to pick up a **burst of MIDI events** at once in one cycle, then idle for several.
- `target_cycle = getCurrentCycle() + 1` gives only ~1.33 ms of margin. If the MIDI
  thread pushes the event after the engine has already called `drainEventsUpTo` for
  the current cycle but before the kernel launch finishes, the event waits one extra
  cycle (safe — drain will pick it up next call). But if an existing burst causes
  `processEventsAtCycle` to apply several `exciteStringsForPitch` for the same pitch
  in one cycle (repeated note-on, or note-off followed by note-on), the batch API
  may commit the **wrong velocity** to `dev_gauss_param_indices` or clobber
  `new_notes_ind` before the previous batch's parameter upload completes.

### 2.4 Persistent per-channel state that survives NOTE_OFF

Two runtime buffers persist across note boundaries and are implicated by
"post-note-off artifacts":

- `dev_sound_prev_diff` — 4 reals, one per output channel (MainKernel.cu:205, 714).
  In-kernel load/store for the 2nd-derivative computation. The CPU post-processing
  path in `playSoundSamples` is now a stub ("2nd derivative is now computed inside
  the CUDA kernel" — Pianoid.cu:2262). `dev_sound_prev_diff` is zeroed only by
  `resetStringsState()` (Pianoid.cu:851, 1609). Never zeroed on NOTE_OFF. A stale
  or contaminated prev_diff under a new hammer strike can amplify the first cycle's
  derivative step. But since 2nd-derivative is the DEFAULT output for most output
  configurations, this would affect space-key equally.
- `dev_mode_running` — 256*2 reals of `q, q_prev` per mode, introduced by the prior
  agents in the just-committed work. Zeroed ONLY by `resetModeRunningState()`, which
  is now invoked by `resetStringsState()` (Pianoid.cu:846-856). Never zeroed on
  NOTE_OFF. With `processSustain` and mode-feedback coupling, modes can keep
  ringing long after `DUMP_CLOSED` — this is physically correct but amplifies any
  mode coupling pathology.

### 2.5 Offline-render determinism scaffolding (just committed)

The prior agents added a `resetStringsState()` + `executeSynthesisCycle()` pair
before `clearRecords()` in every offline-render entry point
(`chartFunctions.play_note_offline_chart_function`,
`chartFunctions.play_note_offline_action`, `chartFunctions.play_mode_chart_function`,
`auto_tuner.MeasurementEngine`, `pianoid.Pianoid` offline playback call sites,
`synthesis_tuner.SynthesisTuner`). The comment in the code is "flush deferred reset".

This scaffolding applies **only to offline rendering**. Live online playback never
calls the reset-flush-clear sequence — so any per-channel / per-mode residue from a
previous note is carried into the next note. The investigation's user-facing
repro is live; the fix path likely needs an equivalent reset discipline in the
online engine, but that engine is event-driven so the "reset" has to be a per-note
operation (damper close already does the string part; modes and `sound_prev_diff`
are not covered).

---

## 3. What the Prior Agents Changed (commits now in HEAD)

All three commits landed on `dev` on 2026-04-20 via `ctx-distortion`. Originating
agents are unknown; commit messages attribute to "prior distortion-investigation
agents".

### Commit `5137240` (PianoidCore) — mode running-state separation

Single coherent theme: **pull `q`, `q_prev` out of the double-buffered preset block
and into a dedicated GPU WORKING buffer `dev_mode_running` that is never swapped.**
This matches the `explore-agent` lock task (`MODULE_LOCKS.md` entry from 2026-04-12,
released by us when the work landed).

- `PresetParameters.h`: `MODE_STATE_SIZE` 1280 → 768 reals (3 fields × 256 modes).
- `Pianoid.cu/.cuh`: new `dev_mode_running` (NUM_MODES × 2), `resetModeRunningState()`,
  `resetStringsState()` now zeroes it too, `getModeDisplacements()` and
  `_exciteSingleMode()` read/write from `dev_mode_running` instead of
  `dev_mode_state`.
- `MainKernel.cu/.cuh`: kernel signature takes `mode_running` arg; kernel reads
  `q`/`q_prev` from it and `dec`/`omega`/`mass_inv` from the shrunk `mode_state`
  at offsets `[0,N,2N]`.
- `AddArraysWithCUDA.cpp`: pybind11 export of `resetModeRunningState`.
- `pianoid_middleware/pianoid.py`:
  - `reset_synthesis()` no longer calls `send_mode_params_to_CUDA(keep_state=False)`
    (the upload-the-preset-to-zero-q hack). Running state is now zeroed by
    `resetStringsState()` → `resetModeRunningState()` in C++.
  - `play_mode()` now calls `pianoid.exciteMode(mode_no, q, excite_vel)` directly
    instead of round-tripping through `set_state` + `pack_modes`. The `excite_vel`
    computation: `(q - q_prev) * sample_rate` where
    `q = volume * velocity, q_prev = volume * velocity * handicup`.
  - Offline playback paths (`pianoid.play_note_offline` and ilk) added
    `resetStringsState()` + `executeSynthesisCycle()` before `clearRecords()`.
- `pianoid_middleware/parameter_manager.py`: `send_mode_params_to_CUDA` retains
  `keep_state` arg for source-compat but ignores it (pack is config-only).
- `pianoid_middleware/chartFunctions.py`, `auto_tuner.py`, `synthesis_tuner.py`:
  same `reset + flush cycle + clear` pre-offline-render sequence.

### Commit `a3b8dc2` (PianoidCore) — diagnostics

- `diag_cov.py`: 10-run coefficient-of-variation probe at pitch 57 velocity 95.
  Replicates `_synthesis_only_measure` logic with per-run RMS, peak, buffer size,
  cycle counts, and CoV summary. Purpose: verify offline-render determinism.
- `presets/Belarus_8band_196modes-MFeq.json`: MF-equalized Belarus sibling preset.

### Commit `83ac75d` (PianoidBasic) — companion

`Pianoid/Mode.py`: `Piano_mode.get_state()` returns `(dec, omega, mass)`,
`ModeMap.pack_modes()` packs SoA `[dec × N] [omega × N] [mass × N]`. The
`keep_state` argument is retained on `get_state()` for call-site compatibility
but ignored. Aligns with the 768-real `MODE_STATE_SIZE` in C++.

### What's (potentially) still incomplete

- **No online-side reset discipline.** Online playback doesn't call the
  `resetStringsState + executeSynthesisCycle + clearRecords` sequence on any
  per-note boundary. If the fix-agent decides that `sound_prev_diff` or mode
  running state residue causes post-note-off artifacts live, that discipline
  needs an online analogue — likely scoped per-channel or per-mode, not a global
  reset.
- **`diag_cov.py` is a standalone script**, not a pytest test. It is not wired
  into `tests/system/`. The fix-agent may want to promote its logic into a
  determinism test under `tests/system/` so regressions are caught.
- **No visible instrumentation/debug prints** or commented-out code in the
  diffs — the prior agents' work looks clean, not half-finished.

---

## 4. Prioritized Code Paths to Inspect (for the fix agent)

Ordered by probability given user feedback. Each entry: what to look at, why it
matches the evidence, what to measure.

### P1. MIDI listener thread busy-wait + event scheduling race

**File:** `pianoid_middleware/pianoid.py:1353-1389` (`MIDI_listener_unified`).

**Why P1:** Directly explains MIDI-dirty / space-clean asymmetry. The MIDI thread
has no `time.sleep`, no yield; space-key has none of this thread.

**Hypotheses:**
- Thread-affinity / scheduler contention between the busy-wait MIDI thread and
  the engine thread causes cycle-level jitter that clusters events into occasional
  bursts. Events in a burst share `target_cycle` and all hit `processEventsAtCycle`
  simultaneously — `exciteStringsForPitch` runs serially but all target the same
  cycle, so `new_notes_ind` is set, parameterKernel is launched for the final
  call, and **only the last string batch wins**. Note-on + immediate note-off of
  the same pitch in the same cycle ⇒ hammer fires and immediately closes.
- `pushEvent(event, target_cycle)` with `target_cycle = getCurrentCycle() + 1`
  computed just-in-time can target a cycle the engine **just started draining**.
  Mutex serializes, but the event still waits an extra 1.33 ms. Not itself
  dirty, but combined with the burst pattern above, events arrive "clumped".

**What to measure:**
- Wall-clock timestamps around `add_realtime_event` and `drainEventsUpTo` in the
  engine, plus `RealTimeEventBuffer::getStats()` over 30 s of heavy MIDI input.
- Thread CPU time of `MIDI_listener_unified` during idle vs during playback.
- Whether adding `time.sleep(0.001)` to the `None`-message branch in the listener
  loop changes the distortion rate. (This is a diagnostic probe; root-cause fix
  is probably switching to the C++ `MidiInputListener` which uses RtMidi callback
  mode — see §2 of PLAYBACK_SYSTEM.md.)

### P2. Doc/code drift: `MidiInputListener` documented but not present

**Doc claim:** `docs/modules/pianoid-cuda/PLAYBACK_SYSTEM.md:441-490` describes a
C++ `MidiInputListener` using RtMidi callback mode as the "lowest latency, no
polling" listener — with full API, pybind11 binding, and message-handling table.

**Code reality (verified during this investigation):**
- No `MidiInputListener.h`, `MidiInputListener.cpp`, or equivalent file in
  `pianoid_cuda/`.
- `Grep` for `class MidiInputListener` across `PianoidCore/`: **zero matches**.
- `AddArraysWithCUDA.cpp` exports only `MidiEventConverter` (static helpers);
  the file explicitly notes at line 523 that **legacy MIDI methods have been
  removed**: `// Legacy methods removed: processMidiPoints, runMainApplication, midiListener, playMidiRecord`.

**Why this matters for P1:**
The Python busy-wait `MIDI_listener_unified` is the **only** live-MIDI input
path today. There is no competing listener, no alternative, no runtime switch.
That confirms P1 as the most likely distortion source and eliminates the
possibility that the user is hitting a C++ callback-mode fast path that
behaves differently from space-key.

**Secondary implication:** A doc-update pass may be needed once the fix lands
— either reintroduce the C++ listener (and make the doc accurate) or remove
the `MidiInputListener` section from `PLAYBACK_SYSTEM.md`. The fix-agent
should choose based on the direction of the fix.

### P3. In-kernel 2nd-derivative state `sound_prev_diff`

**Files:** `pianoid_cuda/MainKernel.cu:202-206, 712-715`, reset site
`pianoid_cuda/Pianoid.cu:851, 1609, 416`.

**Why P3:** Matches "artifacts at the end of the note, sometimes even after the
note is off". `sound_prev_diff` is persistent across cycles, zeroed only on
`resetStringsState`. The 2nd-derivative takes the sample-to-sample difference
using the previous cycle's final `diff` as seed for the new cycle. If the
damper-close path writes a small residual diff that seeds the decay tail, any
numerical instability keeps echoing.

But: the same state is used for space-key output too. So this alone doesn't
explain asymmetry. However, if the P1 burst pattern makes MIDI events land
in irregular cycle positions, the cycle-boundary sample-pair values flip sign
randomly, producing the *audible* hiccups that space-key (with regular cadence)
avoids.

**What to measure:**
- Capture `dev_sound_prev_diff[ch]` values at every cycle for 2 seconds of MIDI
  play vs space-key play of the same pitch.
- Toggle `sound_derivative_order = 1` (raw velocity output, no second diff) and
  re-test user's MIDI-dirty / space-clean comparison. If distortion disappears
  with 1st-derivative output, the fix is in how `prev_diff` is seeded / cleared
  near event boundaries.

### Other paths to keep in view but lower priority

- **Batch API re-entrancy (`beginStringBatch`/`addStringToBatch`/`commitStringBatch`).**
  `noStrings_in_GP` is a member variable, not per-call. Two successive
  `exciteStringsForPitch` in the same cycle will share the counter. Inspection
  (Pianoid.cu:1909-1945) suggests this is by design (one commit per cycle, engine
  drains all events first). But if the engine does NOT batch all events before
  commit — it calls `dispatch(event)` in a loop and each NOTE_ON's
  `exciteStringsForPitch` internally calls `commitStringBatch` — then successive
  NOTE_ONs within a cycle upload partial batches that ALL set `new_notes_ind = X + 1`,
  and the parameterKernel sees only the last `dev_dec_open` state. Worth
  confirming that `PlaybackCycleExecutor::exciteStringsForPitch` commits
  exactly once per call (it does — line 1939-1945 commits, so note-on + note-off
  in the same cycle means the second commit overwrites the first's `new_notes_ind`
  but damper_close happens via a DIFFERENT write to `dec_open[stringNo]` which
  is preserved because it's host-side — this is subtle, validate).

- **Deduplication in `/play`** (backendserver.py:1213-1217). Identical consecutive
  `(pitch, command)` tuples silently return OK without scheduling. This protects
  space-key rapid-fire from duplication. The MIDI path does NOT have this dedup.
  If a MIDI controller sends duplicate NOTE_OFFs (some do after sustain release),
  the second NOTE_OFF for an already-closed string does no harm (dumper stays
  CLOSED). Unlikely dirty source but verify.

- **Sustain pedal.** `pianoid_middleware/pianoid.py:1387` routes CC 64 through the
  SAME `add_realtime_event` path. No relevant asymmetry.

---

## 5. Open Questions for the Fix Agent

1. ~~**Which MIDI listener is wired today?**~~ **Answered during this
   investigation:** only the Python busy-wait `MIDI_listener_unified` is
   present. The C++ `MidiInputListener` documented in PLAYBACK_SYSTEM.md is
   not in the source tree (removed per `AddArraysWithCUDA.cpp:523` comment).
   Adding a proper non-polling C++ or a Python-side `msleep`-backed listener
   is a structural candidate fix.

2. **Is the user testing with `sound_derivative_order = 1` or `2`?** The preset
   determines the default. If user consistently runs with `= 2`, the P3 path is
   in scope. If `= 1`, skip P3 and focus on P1/P2. The current preset
   (`BaselinePreset1.json`) should be inspected for this field.

3. **What hardware MIDI controller is the user using?** Some controllers
   generate duplicate events, active-sensing noise, or running-status. If the
   Python listener mishandles running-status (it only reads `msg[0][0..2]`, no
   running-status tracking), certain controllers' byte streams could produce
   corrupted events that happen to parse as plausible notes. Unlikely the full
   explanation but easy to check.

4. **Does the distortion appear at low cycle counts (first few notes) or only
   after several notes?** If only after, a resource leak (stats counters, stale
   state accumulation) is likely. If immediate, a structural scheduling issue.
   User report suggests "almost always" — lean structural.

5. **Does space-key exhibit the same distortion when invoked at MIDI-like rapid
   rates** (e.g. auto-repeat or a script sending 50 notes/sec to `POST /play`)?
   Matching the MIDI event-rate through the REST path isolates whether the
   distortion source is per-event-rate or listener-specific.

---

## 6. Evidence Cross-Reference

| Source | File | Evidence |
|---|---|---|
| System overview | `docs/architecture/SYSTEM_OVERVIEW.md` | Four-layer stack; threading model; PLAYBACK_ACTIVE state gating |
| Playback flows | `docs/architecture/DATA_FLOWS.md:52-130` | Both MIDI and REST `/play` paths converge at `add_realtime_event` |
| Playback system | `docs/modules/pianoid-cuda/PLAYBACK_SYSTEM.md:441-490` | Documents C++ `MidiInputListener` (file not observed in tree — verify) |
| MIDI system | `docs/modules/pianoid-middleware/MIDI_SYSTEM.md` | Legacy Python listener vs unified; YAML keyboard config |
| MIDI listener (unified) | `PianoidCore/pianoid_middleware/pianoid.py:1353-1389` | Busy-wait loop, no sleep |
| Event scheduling | `PianoidCore/pianoid_middleware/pianoid.py:1391-1434` | `target_cycle = getCurrentCycle() + 1` for delay_ms=0 |
| Note-off payload | `PianoidCore/pianoid_cuda/EventDispatcher.cu:84-93` | Velocity hardcoded to 0 for NOTE_OFF |
| Damper close | `PianoidCore/pianoid_cuda/Pianoid.cu:1763-1772` | `dec_open[stringNo] = DUMP_CLOSED` host-side |
| 2nd-derivative state | `PianoidCore/pianoid_cuda/MainKernel.cu:202-206, 712-715` | `sound_prev_diff` per output channel, persistent |
| Mode running state | `PianoidCore/pianoid_cuda/Pianoid.cu:846-856` | `resetStringsState` zeroes mode running state (new) |
| Dedup (REST only) | `PianoidCore/pianoid_middleware/backendserver.py:1213-1217` | Only the REST path dedups identical consecutive commands |
| Derivative commit (known artifact) | `git show f178ad8` | "2.0-2.5x boundary artifacts at 64-sample cycle boundaries — root cause under investigation" |

---

## 7. Recommended Next Step

Before spawning a fix agent, answer Question 1 (which MIDI listener is active).
That single check is 30 seconds of work and dramatically prunes the hypothesis
tree: if the C++ callback-mode listener is already wired, P1 drops to low
priority and P3 moves up. If only the Python busy-wait listener is wired,
writing the C++ listener back in (or adding a blocking `get_message` with small
sleep) becomes P1.
