# MIDI System Refactoring — Consolidated Plan (2026-05-08)

**Mode:** Read-only synthesis. No code changes.
**Author:** `/analyse` (orchestrator-spawned)
**Inputs:**
- `docs/proposals/midi-input-relocation-analysis-2026-05-08.md` (frontend → backend ingress relocation)
- `docs/proposals/kernel-midi-batch-investigation-2026-05-08.md` (per-cycle batch coalescence bug)
- `docs/modules/pianoid-middleware/MIDI_SYSTEM.md`, `docs/architecture/SYSTEM_OVERVIEW.md`

**User goal (verbatim):** "Make consolidated plan for the midi system refactoring"

---

## 1. Executive Summary

There are **two independent defects** in the live MIDI path. Both block "live piano feel":

1. **Ingress is in the wrong layer.** The browser (`useMidi.js`) owns the hardware MIDI port. Every press pays a 5–13 ms (typ.) browser→WS→Python round-trip before it reaches `RealTimeEventBuffer`. The backend already has a fully-working `MIDI_listener_unified` thread that would do the same job in 2–7 ms (typ.) — it's just gated off by `listen_to_midi=0` and three small landmines (interactive `input()` port-prompt, double-port-open, no port broadcast back to UI for "last note pressed").
2. **The kernel drops simultaneous-cycle notes.** `EventDispatcher::handleNoteOn → exciteStringsForPitch` opens a fresh `beginStringBatch / commitStringBatch` envelope per event; each commit overwrites `noStrings_in_GP` and `new_notes_ind` host-side, so when N NOTE_ONs land in the same ~1.33 ms cycle window only the **last** event's strings reach `gaussKernel`. Chord-pressing intermittently drops notes; offline MIDI rendering with same-cycle events is **guaranteed** lossy.

These two defects compound: relocating ingress to the backend (defect 1) tightens the inter-event spread on the way to the engine, which makes defect 2 fire **more often**. So the kernel batch fix should land first or in parallel — never after.

The total work is ~1 day of code + measurement, structured in 5 phases. **Phase 1 (kernel fix) and Phase 0 (pre-flight bug fixes) can ship in parallel.** Phases 2–4 strictly serialise after that.

**Outcome:** chord pressing renders all notes; offline MIDI rendering is bit-exact for same-cycle events; live MIDI latency drops from 5–13 ms median (worst 25 ms) to 2–7 ms median (worst 12 ms).

---

## 2. Scope Reconciliation — In/Out

### In scope

| Layer | Change |
|---|---|
| **C++/CUDA kernel** | Lift `beginStringBatch`/`commitStringBatch` envelope from per-event (in `PlaybackCycleExecutor::exciteStringsForPitch`) to per-cycle (in `OnlinePlaybackEngine::processEventsAtCycle` + `OfflinePlaybackEngine` equivalent). Add `stageStringsForPitch` helper that does add-only. |
| **Python middleware** | Fix `input()` port-prompt blocker in `MIDI_listener_unified`. Fix redundant double-port-open in `MidiListener.__init__`. Add `socketio.emit('midi_note_event', ...)` callback alongside `schedule_event`. Default `listen_to_midi=1` for tuning sessions (or expose `POST /midi/start` / `POST /midi/stop`). |
| **Frontend** | Rewrite `useMidi.js` from Web MIDI owner (~130 LOC) to Socket.IO subscriber (~30 LOC). Drop `midiPlayNote` wrapper in `PianoidTuner.js`. Decide fate of `MidiComponent.jsx` (debug panel). |
| **Docs** | Update `MIDI_SYSTEM.md`, `DATA_FLOWS.md` §1.2, `REST_API.md`. |
| **Tests** | Same-cycle chord regression (offline + online), latency measurement script, mock-Socket.IO frontend test for the new broadcast. |

### Out of scope (explicitly)

- **Path C — direct C++ `RtMidi` callback in the engine.** Per the relocation analysis (§2.3, §6.4), this path *does not exist* — the include is commented out and was never built. Path B (backend Python rtmidi) gets ~75% of Path C's latency win at ~5% of the effort. Defer Path C indefinitely; revisit only if measured Path B latency proves insufficient.
- **Velocity clamp redesign.** The `apply_fix_velocity=True` default in `MIDI_listener_unified` matches the WS handler's behaviour for `source="midi"`. Relocation preserves this — no semantic change. (Open Question §5.5 in source doc — recommended default below.)
- **Per-note CC features in the legacy `MidiListener` YAML config.** That listener is a separate code path (`pianoidMidiListener.MidiListener`) used only by `midi_keyboard.py` interactive config tool. The unified path doesn't touch it. Migration of per-note CC to the unified path is a separate future concern.
- **Browser virtual piano, REST `POST /play`, space-bar, calibration, Excitation editor triggers.** These are not MIDI-hardware sources; they keep their existing direct path to `schedule_event`.

---

## 3. Phase Breakdown

### Phase 0 — Pre-flight bug fixes (BLOCKING for Phase 2)

**Goal:** Make `listen_to_midi=1` safe to set without hanging or crashing the backend.

**Deliverables:**
1. Replace `input()` port-prompt at `pianoid.py:1445` with config-driven port selection. Read `midi_port` from a constructor argument or class attribute; default to `0`. The interactive prompt remains available for `playPianoid.py` standalone CLI use behind an explicit `interactive=True` flag.
2. Resolve double-port-open in `pianoidMidiListener.MidiListener.__init__` (`pianoidMidiListener.py:29` opens port 0 unconditionally before the unified listener's `select_port` runs). Defer the open to `select_port` or accept a `port_index` argument that skips the eager open.
3. Add `GET /midi/ports` REST endpoint that returns the list of available ports (for future UI port-picker; useful even if defaulted in Phase 2).
4. Document the `midi_port` payload field in `REST_API.md` for `POST /load_preset` and add `GET /midi/ports`.

**Files touched (~5):** `pianoid.py`, `pianoidMidiListener.py`, `backendServer.py`, `REST_API.md`, `MIDI_SYSTEM.md`.

**Effort:** S (1–2 hours). Pure Python, no CUDA build required.

**Test:** Send `POST /load_preset {"listen_to_midi": 1, "midi_port": 0}` — verify backend stays alive, listener thread starts, no console prompt, audio path still works for browser-virtual-piano clicks (i.e. backend can hold the MIDI port AND still service WS `play` events from the browser virtual piano).

### Phase 1 — Kernel batch fix (INDEPENDENT, can run parallel with Phase 0)

**Goal:** Ensure all NOTE_ON/NOTE_OFF events in one synthesis cycle reach `gaussKernel` in a single batch.

**Deliverables:**
1. Implement Option A from `kernel-midi-batch-investigation-2026-05-08.md` §6:
   - Add `PlaybackCycleExecutor::stageStringsForPitch(pitch, velocity)` — `exciteStringsForPitch` minus the `beginStringBatch`/`commitStringBatch` calls.
   - Change `EventDispatcher::handleNoteOn` and `handleNoteOff` to call the new `stageStringsForPitch` (add-only, no commit).
   - In `OnlinePlaybackEngine::processEventsAtCycle`, wrap the dispatch loop with `pianoid_->beginStringBatch()` / `pianoid_->commitStringBatch()` when `all_events` contains any NOTE_ON or NOTE_OFF.
   - Symmetric change in `OfflinePlaybackEngine` / `PlaybackCycleExecutor::processEvents`.
2. Keep `exciteStringsForPitch(pitch, velocity)` as a public single-shot helper for any caller that legitimately wants per-event commit (REST `/play` direct test paths). Internally it now does `begin → stage → commit`.
3. Confirm `dispatchBatch` is genuinely uncalled (Grep across PianoidCore — already verified in the source investigation §3.5). Optional cleanup: delete the vestigial `dispatchBatch` body or rewrite it to use the new staging helper.

**Files touched (~3):** `OnlinePlaybackEngine.cu`, `OfflinePlaybackEngine.cu`, `PlaybackCycleExecutor.cu`, `EventDispatcher.cu`, `Pianoid.cu` if `exciteStringsForPitch` signature shifts.

**Effort:** M (2–3 hours code + CUDA rebuild via `build_pianoid_cuda.bat --heavy --release`). ~30 LOC touched.

**Test:** New regression test in `tests/system/` — offline MIDI rendering with two NOTE_ONs at identical `cycle_index`, verify both pitches' fundamentals appear in the output spectrum (FFT of `note_playback` output).

### Phase 2 — Backend MIDI ingress activation (DEPENDS on Phase 0)

**Goal:** Make tuning-mode startup activate the backend MIDI listener and broadcast `midi_note_event` to the frontend.

**Deliverables:**
1. Add an `emit_callback` parameter to `MIDI_listener_unified` (or to the `start_midi_listener_unified` constructor). Default to `lambda *a, **kw: None` so `playPianoid.py` standalone usage stays unaffected.
2. In `backendServer.py`, when starting the listener, pass `lambda cmd, pitch, vel: socketio.emit('midi_note_event', {'command': cmd, 'pitch': pitch, 'velocity': vel, 'ts_ms': int(time.time()*1000)})`.
3. The launcher (`server/launcher.js`) — or a new explicit toggle on the frontend — sets `listen_to_midi=1` in the `POST /load_preset` payload for tuning sessions. Decision in §5 below.
4. Verify the `socketio.emit` follows the existing BG-thread pattern (`backendServer.py:545-567` for `lifecycle`, `calibration`, `midi_progress`, `engine_error`) — should require no special threading care because Flask-SocketIO emits from worker threads are queued through eventlet/gevent.

**Files touched (~3):** `pianoid.py`, `backendServer.py`, `launcher.js` (or frontend boot), `REST_API.md`, `MIDI_SYSTEM.md`, `DATA_FLOWS.md`.

**Effort:** S (1–2 hours).

**Test:** With Phase 0 + Phase 1 merged, send `POST /load_preset {"listen_to_midi": 1}`. Press a key on a hardware MIDI keyboard. Verify (a) audio plays via the engine path, (b) a Socket.IO client receives `midi_note_event` with the correct pitch/vel within 50 ms.

### Phase 3 — Frontend simplification (DEPENDS on Phase 2)

**Goal:** Remove the Web MIDI ownership from the browser. `useMidi` becomes a thin Socket.IO subscriber that maintains the same return shape (`midiKeysDown`, `midiLastKeyDown`, `midiLastKeyUp`) so no consumer code changes.

**Deliverables:**
1. Rewrite `PianoidTunner/src/hooks/useMidi.js`:
   - Drop `navigator.requestMIDIAccess`.
   - Subscribe to `socket.on('midi_note_event', ...)` via the existing `useSocketIO` hook.
   - Maintain `midiKeysDown` Set, `midiLastKeyDown`, `midiLastKeyUp` exactly as today, just driven by the broadcast instead of the Web MIDI callback.
   - Drop the `playNote` arg — the backend is now the originator of the audio path.
2. Update `PianoidTuner.js:207-220` — drop `midiPlayNote` and the `useMidi(midiPlayNote)` arg.
3. Decide `MidiComponent.jsx` fate (recommended: delete; see §5).
4. Keep the `setSelectedPitch(midiLastKeyDown)` effect intact — works unchanged.

**Files touched (~3):** `useMidi.js`, `PianoidTuner.js`, optionally `MidiComponent.jsx` (delete).

**Effort:** S (1–2 hours). Net LOC delta: **–100** (removing ~130, adding ~30).

**Test:** UI test (`/test-ui` audio_off mode is sufficient — synthesis output is the same; only ingress changed). Press hardware key, verify (a) `selectedPitch` updates, (b) MIDI virtual-piano "key pressed" indicator updates, (c) audio plays. **Latency UX check:** subjective A/B against pre-Phase-3 build.

### Phase 4 — Validation & documentation

**Goal:** Measured proof of latency improvement and chord-press correctness; docs reflect new architecture.

**Deliverables:**
1. **Kernel-batch regression test** — `tests/system/test_kernel_midi_batch.py` (offline rendering): schedule two NOTE_ONs at the same `cycle_index`, render to WAV, FFT — assert both fundamentals present above noise floor. Add a 4-note same-cycle chord variant.
2. **Latency measurement script** — `tests/system/midi_latency.py`: instrument `MIDI_listener_unified` ingest timestamp and the resulting audio buffer dispatch timestamp, run a synthetic burst of 100 events via `rtmidi` loopback, report median + 99th percentile. Target: median < 7 ms, 99p < 12 ms (per relocation analysis §4 Path B budget).
3. **UX manual test plan** (live, with a real hardware MIDI keyboard):
   - Single notes — feel test for "tightness" before/after.
   - 4-note chord stress test — repeat 20 times, count any audible note drops.
   - Sustain pedal — verify CC#64 still works (backend handles CC; frontend was deaf to it before, so this is unchanged behaviour from the user's perspective).
   - "Last note pressed" indicator updates in <100 ms (perceived as instant).
   - Browser virtual piano click still triggers audio (unchanged path).
   - REST `POST /play` from `curl` still triggers audio (unchanged path).
4. **Doc updates** — `MIDI_SYSTEM.md`, `DATA_FLOWS.md` §1.2 (replace browser-owned diagram with backend-owned), `REST_API.md` (`midi_port`, `listen_to_midi` semantics, new `GET /midi/ports`, new `midi_note_event` Socket.IO emit).

**Effort:** M (3–4 hours: tests + measurement script + doc updates).

---

## 4. Dependency Graph

```
                +---------------------+
                | Phase 0             |   Phase 0 and Phase 1 are
                | Pre-flight fixes    |   INDEPENDENT — can ship
                | (input/double-open) |   in parallel as separate
                +----------+----------+   /dev branches.
                           |
                           |  unblocks
                           v
                +---------------------+         +---------------------+
                | Phase 2             |         | Phase 1             |
                | Backend ingress     |  <----  | Kernel batch fix    |
                | (listen_to_midi=1)  | should  | (~30 LOC, Option A) |
                +----------+----------+ land    +---------------------+
                           |             before     |
                           |             or with    | (kernel fix not strictly required
                           |             Phase 2     |  by Phase 2 to ship, BUT shipping
                           v                         |  Phase 2 first amplifies the
                +---------------------+              |  visible impact of the kernel bug
                | Phase 3             |              |  — chords would drop more often.
                | Frontend rewrite    |              |  Strong recommendation: land
                | (useMidi -> sub)    |              |  Phase 1 BEFORE flipping Phase 2.)
                +----------+----------+              |
                           |                         |
                           v                         v
                +-------------------------------------+
                | Phase 4 — Validation                |
                | latency measurement + chord regress |
                | + doc updates                       |
                +-------------------------------------+
```

**Critical path:** Phase 0 → Phase 2 → Phase 3 → Phase 4. Phase 1 forks off and rejoins at Phase 4.

**Recommended actual sequence (with one CUDA build per cycle):**
1. Spawn two `/dev` agents in parallel: agent A on Phase 0 (Python), agent B on Phase 1 (CUDA).
2. Land both behind separate commits. Agent B's CUDA build (`build_pianoid_cuda.bat --heavy --release`) is the long pole; Agent A's Python work likely finishes first.
3. After both merged: spawn agent C on Phase 2.
4. After Phase 2 merged: spawn agent D on Phase 3.
5. After Phase 3 merged: Phase 4 in a single agent.

This keeps each `/dev` agent in a single coherent layer — minimises module lock contention per the project's `MODULE_LOCKS.md` discipline.

---

## 5. Open Decisions — Grouped with Recommended Defaults

### Group A — Affects Phase 0 (pre-flight)

**A1. MIDI port selection in tuning mode** (relocation analysis §7.1)
- Options: hardcode port 0; expose `GET /midi/ports` + frontend port-picker in `POST /load_preset`; auto-select first port containing keyword (e.g. "Piano").
- **Recommended default:** `midi_port: 0` default in `POST /load_preset`, with `GET /midi/ports` available for a future UI picker. Don't build the picker UI yet (separate small task).

**A2. Pure-playback compatibility guard** (relocation analysis §7.6)
- Options: (a) inject emit-callback at listener construction (default no-op); (b) `try/except` import of `backendServer.socketio`.
- **Recommended:** option (a) — clean, no import-cycle risk, no production code changes when running standalone.

### Group B — Affects Phase 2 (ingress activation)

**B1. Activation toggle UX** — How does the backend learn to start the MIDI listener?
- Options: (i) `listen_to_midi=1` always set by the launcher when starting in tuning mode; (ii) explicit `POST /midi/start` and `POST /midi/stop` REST endpoints called by the frontend on mount/unmount; (iii) frontend toggle in settings ("Use backend MIDI: yes/no").
- **Recommended:** (ii) with default-on. Launcher sends `listen_to_midi=1` in `POST /load_preset` for tuning sessions, AND expose `POST /midi/start` / `POST /midi/stop` so the frontend can hot-toggle (useful for the tablet-with-Bluetooth edge case in B2). Cleanest separation of "wire it up" vs "user opts in/out at runtime."

**B2. Soft-disable Web MIDI vs hard-removal** (relocation analysis §7.2)
- Options: hard-remove `navigator.requestMIDIAccess` from `useMidi.js`; keep as fallback toggled by setting; keep but require user to enable explicitly.
- **Recommended:** hard-remove in Phase 3. The "tablet + Bluetooth keyboard" edge case (relocation analysis §6.3 risk 7) is genuinely rare — pianists wanting low-latency MIDI overwhelmingly run the keyboard plugged into the same machine as the backend. If demand emerges, re-add as a frontend setting later. Keeping both alive is a maintenance burden and risks port-ownership conflicts (relocation analysis §6.3 risk 4).

### Group C — Affects Phase 3 (frontend rewrite)

**C1. `MidiComponent.jsx` fate** (relocation analysis §7.3)
- Options: keep and rewire; delete.
- **Recommended:** delete. It's a debug panel that duplicates `useMidi`'s state. After the relocation it becomes redundant noise. If a debug panel is needed later, rebuild it as a thin component over the new subscriber `useMidi`.

**C2. CC handling broadcast** (relocation analysis §7.4)
- Options: backend silently consumes CC (current behaviour, frontend deaf to CC); backend broadcasts CC events to frontend so UI can show pedal-down indicator etc.
- **Recommended:** Phase 3 ships **note events only** (`midi_note_event` fan-out for NOTE_ON / NOTE_OFF only, matching today's frontend visibility). Add a separate `midi_cc_event` later only when a UI consumer is built. Avoids dead-code Socket.IO traffic.

### Group D — Affects validation (Phase 4)

**D1. Latency target** (relocation analysis §7.7)
- Options: < 10 ms median (Path B is enough); < 5 ms (would require Path C — out of scope per §2).
- **Recommended:** target **< 7 ms median** for Phase 4 sign-off. If Path B measures worse than 10 ms median, **STOP and re-evaluate** before declaring success — that would indicate GIL contention (relocation analysis §6.3 risk 3) and may force a 0.5 ms sleep in the polling loop or Path C re-scoping.

**D2. Velocity-clamp confirmation** (relocation analysis §7.5)
- Options: keep `apply_fix_velocity=True` always (matches today's behaviour for `source="midi"`); make it a runtime toggle.
- **Recommended:** keep always-on (no-change semantics). Toggle is a separate UX feature, not part of this refactor.

**D3. Kernel-batch — NOTE_OFF batched with NOTE_ON?** (kernel investigation §7.2)
- **Recommended:** yes, both go through the same `stageStringsForPitch` and the same `begin/commit` envelope. The kernel handles `velocity=0` as "close damper" already (`gaussKernel` reads `dec_open[stringNo]`); no special casing needed.

**D4. PARAM_UPDATE / SUSTAIN ordering vs NOTE batch** (kernel investigation §7.3)
- **Recommended:** preserve current `all_events` insertion order. PARAM_UPDATE_* and SUSTAIN don't touch `noStrings_in_GP` or `new_notes_ind` — they go through `processSustain` / `updateSingleStringParameter_NEW`. So the begin/commit envelope around the loop is safe; intra-cycle ordering of pedal-vs-note is preserved.

### Group E — Cross-cutting

**E1. Should the kernel fix land before, with, or after the relocation?** (kernel investigation §7.4 already flags this)
- **Recommended:** **before or alongside** Phase 2. Reasoning: relocation tightens inter-event spread (no browser/WS jitter spreading the chord), which means more events collide in one cycle, which means the kernel bug fires more often. Shipping relocation **before** the kernel fix would actively make the user-visible defect worse for the duration of the gap. Two options:
  - Land Phase 1 first (clean, sequential).
  - Land Phases 0 + 1 in parallel `/dev` branches, merge both before Phase 2 (faster, also clean).

---

## 6. Effort + Timeline Estimate

| Phase | Layer | Effort | Wall time (1 dev) |
|---|---|---|---|
| Phase 0 | Python middleware | S | 1–2 h |
| Phase 1 | C++/CUDA kernel | M (incl. CUDA rebuild) | 2–3 h |
| Phase 2 | Python middleware + launcher | S | 1–2 h |
| Phase 3 | Frontend (React) | S | 1–2 h |
| Phase 4 | Tests + measurement + docs | M | 3–4 h |
| **Total (sequential)** | | | **8–13 h** |
| **Total (Phase 0 ‖ Phase 1, then sequential)** | | | **6–11 h** |

A single focused day for one developer; under half a day if Phases 0 and 1 are dispatched as parallel `/dev` agents.

---

## 7. Test + Validation Plan

### 7.1 Phase 1 — Kernel batch regression (offline, deterministic)

`tests/system/test_kernel_midi_batch.py`:

- Test 1 — two-note same-cycle chord. Schedule NOTE_ON pitch 60 and NOTE_ON pitch 64 at identical `cycle_index`. Run offline render. FFT the output; assert peaks at both fundamentals (~261.6 Hz and ~329.6 Hz) with magnitude > 10× noise floor. **Pre-fix expected: only the second peak present.**
- Test 2 — four-note chord (C-E-G-C). Same construction. Assert all four fundamentals present.
- Test 3 — same-cycle NOTE_OFF mixed with NOTE_ON. Ensures `handleNoteOff` participates in the batch correctly.

These tests run **offline** through `OfflinePlaybackEngine` — no audio driver, no mic. Per `docs/development/TESTING.md`, this is the deterministic surface — `audio_off` mode.

### 7.2 Phase 2 — Backend ingress smoke test

`tests/system/test_backend_midi_ingress.py`:

- Start backend with `listen_to_midi=1, midi_port=0`. (Requires a virtual MIDI loopback port like `loopMIDI` on Windows or `snd-virmidi` on Linux — flag as `@pytest.mark.requires_midi_loopback` and skip in CI without it.)
- Connect a Socket.IO client; subscribe to `midi_note_event`.
- Send a NOTE_ON via `rtmidi.MidiOut` to the loopback port.
- Assert (a) `midi_note_event` received within 100 ms with correct pitch/vel, (b) `pianoid.runtime_stats` shows the engine processed a NOTE_ON event.

### 7.3 Phase 3 — Frontend subscriber test

Mock-Socket.IO unit test for the new `useMidi`:
- Render the hook with a mocked socket.
- Emit a fake `midi_note_event`.
- Assert `midiKeysDown` contains the pitch, `midiLastKeyDown` updated, `midiLastKeyUp` empty.
- Emit NOTE_OFF; assert state transitions correctly.

### 7.4 Phase 4 — End-to-end latency measurement

`tests/system/midi_latency.py`:

```
1. Backend start with listen_to_midi=1.
2. Open rtmidi.MidiOut → loopback port.
3. For i in 1..100:
     t0 = time.perf_counter_ns()  (instrument inside MIDI_listener_unified ingest)
     midi_out.send_message([0x90, 60, 100])
     wait for the engine's audio dispatcher to consume the event
     t1 = time.perf_counter_ns()  (instrument at gaussKernel-arming)
     samples.append(t1 - t0)
4. Report median, 95p, 99p.
5. Assert median < 7 ms, 99p < 12 ms (Path B budget per relocation analysis §4).
```

If targets fail, log GIL profile (`py-spy dump`) on the engine thread before declaring regression — it might be GIL contention from the busy poll loop in `MIDI_listener_unified` (relocation §6.3 risk 3).

### 7.5 Manual UX test plan (after Phase 3 merge, with hardware keyboard)

1. **Tightness A/B.** With pre-Phase-3 build, play single notes — note the perceived delay. Switch to post-Phase-3 build, repeat. User judges.
2. **Chord stress.** Play C-E-G-C 20 times rapidly. Count any audible note drops. Pre-Phase-1 build expected: ~1–3 drops. Post-Phase-1 build expected: 0 drops.
3. **Sustain pedal.** Verify CC#64 still triggers `processSustain` (test by holding pedal, releasing a note — should ring; release pedal — should damp).
4. **Last-note-pressed indicator.** Press random keys. Verify `selectedPitch` follows within visibly-instant time (<100 ms).
5. **Browser virtual piano click.** Click on-screen piano key. Verify audio still plays. (Confirms REST/WS `play` paths unaffected.)
6. **REST API.** `curl -X POST http://localhost:5000/play -d '{"command":144,"pitch":60,"velocity":100}'`. Verify audio still plays. (Confirms unchanged.)
7. **Calibration flow.** Run `/calibrate_volume`. Verify it still works (calibration uses backend-internal events, not MIDI-hardware ingress).
8. **Recording / `note_playback`.** Trigger a recording, render a note, verify output. (Confirms recorder + offline path still work after kernel fix.)

---

## 8. Risk Register + Rollback per Phase

### Phase 0 risks

| Risk | Mitigation | Rollback |
|---|---|---|
| `input()` removal breaks `playPianoid.py` standalone CLI usage | Keep `interactive=True` flag for the CLI path; default to `False` for backend usage | Revert the listener constructor change |
| `GET /midi/ports` exposes ports the user shouldn't enumerate | Filter to MIDI-input ports only; document that this is a local-only endpoint | Hide endpoint behind a config flag |

### Phase 1 risks

| Risk | Mitigation | Rollback |
|---|---|---|
| Kernel fix breaks single-note path that legitimately relies on per-event commit | Keep `exciteStringsForPitch` with begin/commit intact for direct REST `/play` callers; only `EventDispatcher::handleNoteOn`/`handleNoteOff` change to `stageStringsForPitch` | `git revert` the dispatcher + engine drain commits; CUDA rebuild |
| `commitStringBatch` semantics affect `addModeExcitation` (which also calls `commitStringBatch`) | Mode excitation path is separate (`addModeExcitation` flushes pending modes); the begin/commit envelope around the engine drain doesn't interleave with mode dispatch — modes are dispatched in their own EventType branches | Add an explicit assertion that `noModes_in_GP == 0` at the top of the engine drain envelope; revert if it fires in tests |
| CUDA build fails (toolchain trap) | Follow `docs/architecture/BUILD_SYSTEM.md` 0xC0000142 recovery; never `pip install --force-reinstall` (per `feedback_pip_install_stale_pyd.md`) | Revert the `.cu` changes; rebuild |

### Phase 2 risks

| Risk | Mitigation | Rollback |
|---|---|---|
| Both backend AND frontend open the MIDI port → double-trigger or device-busy error | Phase 3 must hard-disable Web MIDI. If Phase 2 ships before Phase 3, gate `listen_to_midi=1` behind a feature flag so they don't both run | Set `listen_to_midi=0` default until Phase 3 lands |
| Socket.IO `midi_note_event` emit from BG thread races with frontend connect | Use the existing pattern in `backendServer.py:545-567` — Flask-SocketIO `emit` queues for any connected client | Drop the broadcast; frontend falls back to polling (degraded UX but functional) |
| GIL contention from busy-poll listener degrades engine cycle timing | Measure in Phase 4. If observed, add 0.5 ms `time.sleep(0.0005)` to the poll loop (still gives sub-2 ms latency, removes 100% CPU one-core peg) | Set `listen_to_midi=0` and revert to Path A |

### Phase 3 risks

| Risk | Mitigation | Rollback |
|---|---|---|
| Removing Web MIDI breaks the tablet-with-Bluetooth-keyboard edge case | Documented in §5 B2; if user demand emerges, re-add as a frontend toggle in a follow-up | Re-enable `useMidi`'s old Web MIDI code path behind a flag |
| `MidiComponent.jsx` deletion breaks an import we missed | Grep for imports before deleting; CI catches missing-export errors | `git revert` the deletion |
| `setSelectedPitch(midiLastKeyDown)` effect doesn't fire because `midiLastKeyDown` reference identity changes differently with subscriber state | Ensure the new hook produces a new object reference per event (current behaviour); add a regression unit test | Adjust the effect dependency array; worst case revert frontend changes |

### Phase 4 risks

| Risk | Mitigation | Rollback |
|---|---|---|
| Latency target missed | Diagnose: GIL contention vs Python overhead vs OS-level USB-MIDI driver. Apply targeted mitigation (poll loop sleep, switch to rtmidi callback API) | Document measured baseline, ship the relocation anyway (it's still better than Path A), file follow-up for Path C |
| Chord regression test passes but user reports drops | Investigate other code paths (e.g. `add_realtime_event` `target_cycle = current+1` math; quantisation issues) — fix is not yet complete | Don't claim "fixed" until manual test confirms |

### Cross-cutting risks

| Risk | Mitigation |
|---|---|
| Calibration / mic / recording paths regress | Phase 4 manual test items 6–8 cover this; if any fails, halt before declaring done |
| Preset load/save touches the listener startup contract | `POST /load_preset` payload changes are additive (`midi_port` is optional, defaults to 0; `listen_to_midi` already exists); no preset format change |
| Other agents touch the MIDI surface concurrently | None alive currently per repo state. Acquire `MODULE_LOCKS.md` entries: `pianoid_middleware/pianoid.py` (Phase 0/2), `pianoid_cuda/EventDispatcher.cu` + `OnlinePlaybackEngine.cu` (Phase 1), `PianoidTunner/src/hooks/useMidi.js` (Phase 3) |
| MCP server stdio drop-out mid-session (per CLAUDE.md known gap) | Plan assumes 6–11 hours of focused work — a single VS Code session can usually carry it; if `chrome-devtools` MCP drops, reload VS Code and resume Phase 4 manual testing |

---

## 9. Recommended Sequence with Sign-off Gates

**The user is asked to approve at three gates:**

### Gate 1 — Decisions confirmed (BEFORE any code edits)

User reviews §5 (Open Decisions) and confirms or overrides each recommended default. Specifically:

- A1: `midi_port: 0` default + `GET /midi/ports` endpoint? **(default: yes)**
- A2: Inject emit-callback at construction (not import-cycle)? **(default: yes)**
- B1: Default `listen_to_midi=1` from launcher + add `POST /midi/start` / `POST /midi/stop`? **(default: yes)**
- B2: Hard-remove Web MIDI from frontend? **(default: yes)**
- C1: Delete `MidiComponent.jsx`? **(default: yes)**
- C2: Note events only, no CC broadcast? **(default: yes)**
- D1: < 7 ms median latency target? **(default: yes)**
- D2: Velocity clamp always-on (no behaviour change)? **(default: yes)**
- D3: NOTE_OFF batched with NOTE_ON? **(default: yes)**
- D4: Preserve `all_events` insertion order? **(default: yes)**
- E1: Land Phase 0 + Phase 1 in parallel before Phase 2? **(default: yes)**

### Gate 2 — Phase 1 + Phase 0 merged, before activating ingress

After Phases 0 and 1 land (separate commits, both passing CI + the new Phase 1 kernel-batch regression test), user approves proceeding to Phase 2. Reasoning: this is the last "everything still works as before" snapshot. The kernel fix is in (so chord-press is improved on the existing browser path too — incidental win) and the backend listener is *capable* of starting safely (no `input()` blocker), but `listen_to_midi` is still default-off. Any regression discovered after Phase 1+0 must be fixed before enabling backend ingress.

### Gate 3 — Phase 4 measurements + manual UX sign-off

After Phases 2 and 3 are merged and Phase 4 measurements are in, user reviews:
- Measured latency vs target.
- Chord stress test — drop count.
- Manual UX checklist results.
- Doc updates rendered correctly via `mkdocs serve` at `http://localhost:8001/modules/pianoid-middleware/MIDI_SYSTEM/`.

User signs off. Refactor complete.

---

## 10. One-Sentence Summary

Two independent defects — frontend-owned MIDI ingress (5–13 ms typ., bad piano feel) and per-event commit overwrites in the kernel batch path (chord notes silently dropped) — get fixed in 4–5 phases over ~one day, with Phases 0 and 1 ship-able in parallel, and Phase 2 strictly gated behind Phase 1 to avoid amplifying the kernel bug between commits.

---

## Appendix — Source documents

- `docs/proposals/midi-input-relocation-analysis-2026-05-08.md`
- `docs/proposals/kernel-midi-batch-investigation-2026-05-08.md`
- `docs/modules/pianoid-middleware/MIDI_SYSTEM.md`
- `docs/architecture/SYSTEM_OVERVIEW.md` (lines 68–72, 273–275 — MIDI listener thread mention)
- `docs/architecture/DATA_FLOWS.md` §1.2 (current Path A diagram, to be updated in Phase 4)
- `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md` lines 549–586 (batch API + `new_notes_ind` contract — already documents the multi-string design intent)
