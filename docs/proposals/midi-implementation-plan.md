# MIDI Refactor — Implementation Plan (Wave Breakdown)

**Mode:** Read-only planning. No code changes.
**Author:** plan-midi-refactor agent (orchestrator-spawned)
**Date:** 2026-05-08 (supersedes the 2026-05-05 draft of this same file)
**Source plans:**
1. `docs/proposals/midi-system-refactoring-plan-revised-2026-05-08.md` (primary — 8 phases, 20 decisions, 24–38 h full / 10–17 h original-scope)
2. `docs/proposals/midi-system-refactoring-plan-2026-05-08.md` (original — 5 phases, 11 decisions, 6–11 h)
3. `docs/proposals/kernel-midi-batch-investigation-2026-05-08.md` (Layer-1 bug, Option A fix)
4. `docs/proposals/midi-input-relocation-analysis-2026-05-08.md` (Layer-3 ingress relocation, latency budget)
5. Existing docs: `docs/modules/pianoid-middleware/MIDI_SYSTEM.md`, `docs/architecture/DATA_FLOWS.md`, `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md`

**Output of this plan:** a wave-by-wave dispatch plan that the orchestrator can execute, with conflict detection driving wave boundaries, skill choice per wave, and pre-conditions/decisions surfaced at each gate.

> **Audience:** orchestrator that dispatches `/dev` and `/multitask` agents.
> **Status:** awaiting Gate 1 approval (decisions in §2.1) before any wave starts.

---

## 1. Summary

The user-approved scope from the revised plan recommends **shipping Sequence A first** (original plan + the Phase 1 expansion for `TEST_MODE_ONLY` / `TEST_STRING_ONLY` interleave + the Phase 3 expansion for switchable broadcast) — **10–17 h, ~1.5–2 days**. Sequence B (Phases 5–7 architectural consolidation, +14–21 h) is independently shippable and re-evaluated after Sequence A lands.

This implementation plan organises Sequence A into **5 waves** plus an optional **3-wave Sequence-B continuation**, with parallelism opportunities surfaced where the conflict matrix permits. The dominant constraint is **CUDA build serialisation** (`build_pianoid_cuda.bat --heavy` is sequential), which forces Phase 1 (CUDA) into its own wave but leaves Phase 0 (Python) free to run in parallel.

**One-paragraph synopsis of the revised plan:** the refactor is reframed as a **4-layer architectural cleanup**, not just two acute defects. Layer 1 (CUDA): the per-cycle drain in `OnlinePlaybackEngine::processEventsAtCycle` correctly assembles all events, but `EventDispatcher::handleNoteOn/handleNoteOff` opens its own `beginStringBatch`/`commitStringBatch` per event so each commit overwrites the prior — chord notes in the same cycle are silently dropped. The same envelope bug also fires for `TEST_MODE_ONLY` (commits `addModeExcitation` mid-loop) and `TEST_STRING_ONLY` (calls `addOneString` which is itself begin+commit). Layer 2 (pybind): the `Pianoid` class exposes ~80 methods with multiple semantically-overlapping ways to push state. Layer 3 (Python backend): ~20 distinct event-injection sites with at least 5 different concurrency models. Layer 4 (UI): when the backend takes ownership of MIDI, the frontend needs a switchable broadcast for "last note pressed".

**Wave-shape preview:**

| Wave | Phase(s) | Layer | Skill | Parallelism | Build |
|---|---|---|---|---|---|
| **W1** | Phase 0 ‖ Phase 1 | Python middleware ‖ CUDA kernel | 2× `/dev` parallel | YES (2 agents, disjoint files) | `--heavy` (only Phase 1 agent) |
| **W2** (Gate 2) | Validation pause | — | none | — | — |
| **W3** | Phase 2 | Python middleware | 1× `/dev` | NO | `--light` |
| **W4** | Phase 3 | Frontend | 1× `/dev` | NO | npm |
| **W5** | Phase 4 | Tests + measurement + docs | 1× `/dev` (or `/test-ui` + `/update-docs` split) | NO | none / `--light` |
| **W6** (Gate 3) | UX sign-off | — | none | — | — |
| W7 (Sequence B) | Phase 5 | C++ pybind surface | 1× `/dev` | NO | `--light` |
| W8 (Sequence B) | Phase 6 | EventIngress facade + bypass migration | 1× `/dev` | NO | `--light` |
| W9 (Sequence B) | Phase 7 | Authority + back-pressure | 1× `/dev` | NO | `--light` |

Sequence A total: **5 dispatch waves, 6 dev-agent slots** (W1 = 2, W3-W5 = 1 each).
Sequence B addendum: 3 more waves, 3 more dev-agent slots.

---

## 2. Pre-conditions

Before W1 can be dispatched, the orchestrator must verify:

### 2.1 User decisions confirmed (Gate 1)

The revised plan's Gate 1 lists **20 decisions** (11 original + 9 new). None of these can default-through silently — each is a flag that changes downstream code. Surface to user via Telegram before W1 dispatch:

| # | Group | Decision | Recommended default | Affects |
|---|---|---|---|---|
| 1 | A1 | MIDI port selection: `midi_port: 0` default + `GET /midi/ports` endpoint | yes | Phase 0 |
| 2 | A2 | Inject emit-callback at construction (vs try/except import) | yes | Phase 0 |
| 3 | B1 | Default `listen_to_midi=1` from launcher + add `POST /midi/start` / `/stop` | yes | Phase 2 |
| 4 | B2 | Hard-remove Web MIDI from frontend | yes | Phase 3 |
| 5 | C1 | Delete `MidiComponent.jsx` | yes | Phase 3 |
| 6 | C2 | Note events only, no CC broadcast | yes | Phase 3 |
| 7 | D1 | < 7 ms median latency target | yes | Phase 4 |
| 8 | D2 | Velocity clamp always-on (no behaviour change) | yes | Phase 4 |
| 9 | D3 | NOTE_OFF batched with NOTE_ON | yes | Phase 1 |
| 10 | D4 | Preserve `all_events` insertion order | yes | Phase 1 |
| 11 | E1 | Land Phase 0 + Phase 1 in parallel before Phase 2 | yes | wave shape |
| 12 | F1 | TEST_* in same envelope as NOTE_* | yes | Phase 1 expanded |
| 13 | F2 | Introduce explicit `MAX_EVENTS_PER_CYCLE` cap (256) | yes | Phase 1 expanded |
| 14 | G1 | Keep deprecated direct paths with `[[deprecated]]` warning (vs hard remove) | keep + warn | Phase 5 |
| 15 | G2 | Build C++ MIDI listener (Path C) now | defer | architecture only |
| 16 | H1 | EventIngress in new file `event_ingress.py` (vs in `pianoid.py`) | new file | Phase 6 |
| 17 | H2 | Migrate calibration to events online; carve out offline | yes | Phase 6 |
| 18 | H3 | Delete legacy `/play` fallback and `perform_midi_command` | yes | Phase 6 |
| 19 | I1 | Single global broadcast toggle (vs per-type) | global | Phase 3 |
| 20 | I2 | Default broadcast on (vs off) | on | Phase 3 |
| 21 | I3 | Direct-from-C++ WebSocket scope | defer, document | architecture only |

**Decisions 1–13** must be confirmed before W1 dispatches (they affect Phases 0/1).
**Decisions 14–21** can be deferred until W7 dispatch (Sequence B) — they only affect Phases 5–7.

### 2.2 Repo health

- `MODULE_LOCKS.md` clean (or known stale, ready for Step 1.5 cleanup).
- `WORK_IN_PROGRESS.md` Active Dev Sessions table compatible with 2 concurrent agents in W1.
- No other dev agents touching the files in §3 conflict matrix.
- CUDA toolchain known-good (recent successful `build_pianoid_cuda.bat --heavy --release`). If unknown, run a quick check first or accept that W1 Agent B may need to spawn `/startup` if its build fails.

### 2.3 Test infrastructure

- `tests/system/test_performance.py` baseline can run cleanly (Step 2 of `/dev`).
- Hardware MIDI loopback (e.g., `loopMIDI` on Windows) available on the dev machine — this is **only required for Phase 4 manual UX tests** (W5 / Gate 3); CI can run `@pytest.mark.requires_midi_loopback` skipped.
- USB MIDI keyboard plugged in for the manual UX checklist (Gate 3 sign-off).

### 2.4 Documentation prerequisites

The Documentation-First Rule requires reading the following before any Phase 1 / 2 / 3 implementation. The dev agents will do this at Step 1, but the orchestrator should ensure they are reachable:

- `docs/index.md`, `docs/architecture/SYSTEM_OVERVIEW.md` — module map
- `docs/architecture/DATA_FLOWS.md` §1.2 (current MIDI Path A)
- `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md` lines 549-586 (batch API + `new_notes_ind` contract)
- `docs/modules/pianoid-cuda/PLAYBACK_SYSTEM.md` (per-cycle drain)
- `docs/modules/pianoid-middleware/MIDI_SYSTEM.md` (MidiListener + unified)

---

## 3. Conflict Matrix — File Scope per Phase

This drives the wave grouping. Two phases conflict if they touch the same file OR if both require a `--heavy` CUDA build OR if there's an API-shape dependency.

### 3.1 Per-phase file scope (best estimate from the revised plan §2 + §4)

| Phase | Files (relative to repo root) | Layer | Build |
|---|---|---|---|
| **Phase 0** (pre-flight) | `PianoidCore/pianoid_middleware/pianoid.py`, `PianoidCore/pianoid_middleware/pianoidMidiListener.py`, `PianoidCore/pianoid_middleware/backendServer.py` (small — `GET /midi/ports`), `docs/modules/pianoid-middleware/REST_API.md`, `docs/modules/pianoid-middleware/MIDI_SYSTEM.md` | Python + docs | none (or `--light` if pianoid.py touched in import path) |
| **Phase 1** (kernel batch + TEST_* envelope) | `PianoidCore/pianoid_cuda/EventDispatcher.cu`, `PianoidCore/pianoid_cuda/OnlinePlaybackEngine.cu`, `PianoidCore/pianoid_cuda/OfflinePlaybackEngine.cu`, `PianoidCore/pianoid_cuda/PlaybackCycleExecutor.cu`, `PianoidCore/pianoid_cuda/Pianoid.cu` (new `stageModeExcitation` helper), `PianoidCore/pianoid_cuda/RealTimeEventBuffer.cu` (size_limit_ default), `PianoidCore/pianoid_cuda/constants.h` (comment), `PianoidCore/tests/system/test_kernel_midi_batch.py` (new file) | CUDA | **`--heavy --release`** |
| **Phase 2** (ingress activation) | `PianoidCore/pianoid_middleware/pianoid.py` (emit_callback param), `PianoidCore/pianoid_middleware/backendServer.py` (wire callback, `POST /midi/start`, `POST /midi/stop`), `server/launcher.js` OR frontend boot (set `listen_to_midi=1`), `docs/modules/pianoid-middleware/REST_API.md`, `docs/modules/pianoid-middleware/MIDI_SYSTEM.md`, `docs/architecture/DATA_FLOWS.md` §1.2 | Python + launcher + docs | `--light` (pianoid.py edits) |
| **Phase 3** (frontend rewrite + switchable broadcast) | `PianoidTunner/src/hooks/useMidi.js` (rewrite), `PianoidTunner/src/PianoidTuner.js` (drop `midiPlayNote`), `PianoidTunner/src/components/MidiComponent.jsx` (delete), `PianoidTunner/src/hooks/useFixVelocity.js` (template ref, no edit), Settings panel UI (TBD file), `PianoidCore/pianoid_middleware/backendServer.py` (broadcast toggle endpoints), `PianoidCore/pianoid_middleware/pianoid.py` (broadcast flag check) | Frontend + Python | `npm`, `--light` |
| **Phase 4** (validation + docs) | `PianoidCore/tests/system/test_kernel_midi_batch.py` (already created in P1; expand), `PianoidCore/tests/system/test_backend_midi_ingress.py` (new), `PianoidCore/tests/system/midi_latency.py` (new), `docs/modules/pianoid-middleware/MIDI_SYSTEM.md`, `docs/architecture/DATA_FLOWS.md` §1.2, `docs/modules/pianoid-middleware/REST_API.md` | Tests + docs | none |
| Phase 5 (Seq B) | `PianoidCore/pianoid_cuda/AddArraysWithCUDA.cpp` (docstrings only), `PianoidCore/pianoid_middleware/pianoid.py` (extend `_create_playback_event`), `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md`, optionally `PianoidCore/pianoid_cuda/Pianoid.cu` (online-lock flag) | C++ + Python + docs | `--light` (or `--heavy` if Pianoid.cu modified) |
| Phase 6 (Seq B) | NEW `PianoidCore/pianoid_middleware/event_ingress.py`, `PianoidCore/pianoid_middleware/pianoid.py`, `PianoidCore/pianoid_middleware/backendServer.py` (rewire ~20 handlers), `PianoidCore/pianoid_middleware/chartFunctions.py` (replace bypasses at :1212-1245, :2125-2155), `PianoidCore/pianoid_middleware/modal_adapter/modal_adapter.py` (replace bypass at :3865), `PianoidCore/pianoid_middleware/NoteTunner.py`, `docs/modules/pianoid-middleware/REST_API.md`, `docs/modules/pianoid-middleware/OVERVIEW.md` | Python + docs | `--light` |
| Phase 7 (Seq B) | `PianoidCore/pianoid_middleware/event_ingress.py`, `PianoidCore/pianoid_cuda/RealTimeEventBuffer.cu` (only setSizeLimit default — pybind already exposed), `PianoidCore/pianoid_middleware/pianoid.py`, `PianoidCore/pianoid_middleware/chartFunctions.py`, `docs/modules/pianoid-middleware/OVERVIEW.md`, frontend Settings panel (calibration indicator) | Python + small C++ + frontend | `--light` (or `--heavy` if RealTimeEventBuffer.cu default constant changed) |

### 3.2 Conflict matrix

Apply the `/multitask` conflict rules (revised plan §2.1):

| Pair | Conflict reason | Compatible? |
|---|---|---|
| Phase 0 ‖ Phase 1 | Phase 0 = `pianoid.py`, `pianoidMidiListener.py`, `backendServer.py`; Phase 1 = `*.cu`, `*.h` only. **No file overlap**, no API contract dependency. | **YES — parallel-compatible** |
| Phase 0 ‖ Phase 2 | Both touch `pianoid.py` and `backendServer.py`. **File conflict.** Also: Phase 2 depends on Phase 0's `input()` blocker fix. | NO |
| Phase 0 ‖ Phase 3 | Phase 0 = backend Python; Phase 3 = frontend + small backend touches. Phase 3 needs Phase 2's broadcast endpoints. | NO (transitive) |
| Phase 1 ‖ Phase 2 | Phase 1 = CUDA; Phase 2 = Python. No file overlap. **BUT** Phase 2 amplifies Phase 1's bug if shipped first (revised plan §2.1 E1). Land Phase 1 BEFORE Phase 2. | NO — sequential by user-experience constraint |
| Phase 1 ‖ Phase 3 | No file overlap. Phase 3 depends on Phase 2's broadcast endpoints (transitive Phase 1 → Phase 2 → Phase 3). | NO (transitive) |
| Phase 2 ‖ Phase 3 | Both touch `backendServer.py` (broadcast toggle endpoints AND start/stop). **File conflict.** Also: Phase 3 reads Phase 2's `midi_note_event` schema. | NO |
| Phase 3 ‖ Phase 4 | Phase 3 = frontend rewrite; Phase 4 = tests + measurement + docs. No file overlap. **BUT** Phase 4 measurement script depends on Phase 3 frontend behaviour for the manual UX checklist. Phase 4 latency script can run independently. | partial — Phase 4 latency script could run in parallel with Phase 3 if both are stable; safer to serialise |
| Phase 5 ‖ Phase 6 | Phase 5 = pybind docstrings + `_create_playback_event` extension; Phase 6 = EventIngress facade. Phase 6 USES Phase 5's extended event-type production. | NO — Phase 6 depends on Phase 5 |
| Phase 6 ‖ Phase 7 | Phase 7 builds on Phase 6's EventIngress class. | NO — sequential |

### 3.3 Wave assignment from conflict matrix

The greedy graph-coloring per `/multitask` Phase 2.2 yields:

```
Wave 1: Phase 0 + Phase 1   (parallel — disjoint files, different builds)
Wave 2: GATE 2 (validation pause — no agents)
Wave 3: Phase 2             (sequential — needs Phase 0)
Wave 4: Phase 3             (sequential — needs Phase 2)
Wave 5: Phase 4             (sequential — needs Phase 3)
Wave 6: GATE 3 (manual UX sign-off — no agents)
[Sequence B optional]
Wave 7: Phase 5
Wave 8: Phase 6
Wave 9: Phase 7
```

---

## 4. Per-Wave Plan

### Wave 1 — Phase 0 ‖ Phase 1 (parallel)

**Goal:** Make `listen_to_midi=1` safe to set; lift kernel batch envelope to per-cycle (with TEST_* expansion).

**Dispatch shape:** 2× `/dev` agents in parallel (single orchestrator message, two `Agent` calls).

#### Wave 1 — Agent A (Phase 0, Python)

| Field | Value |
|---|---|
| **Skill** | `/dev` |
| **Task description** | "Phase 0: MIDI pre-flight — replace `input()` port-prompt at pianoid.py:1445 with config-driven port; resolve double-port-open in pianoidMidiListener.MidiListener.__init__; add `GET /midi/ports` REST endpoint; document `midi_port` in REST_API.md and `GET /midi/ports`." |
| **Effort** | S (1–2 h) |
| **Risk** | Low. Pure Python. No CUDA build. Decisions A1, A2 confirmed. |
| **Build** | none (or `--light` if Python touches a native-binding interface — unlikely here) |
| **Files (lock list)** | `PianoidCore/pianoid_middleware/pianoid.py`, `PianoidCore/pianoid_middleware/pianoidMidiListener.py`, `PianoidCore/pianoid_middleware/backendServer.py`, `docs/modules/pianoid-middleware/REST_API.md`, `docs/modules/pianoid-middleware/MIDI_SYSTEM.md` |
| **Test command** | `PianoidCore/.venv/Scripts/python -m pytest PianoidCore/tests/system/test_realtime_buffer.py -v -s` (existing realtime smoke + a new test that `start_midi_listener_unified(midi_port=0, interactive=False)` does not block) |
| **Audio mode** | audio_off (no synthesis change). |
| **Pre-conditions for Agent A** | Decisions 1–2 confirmed. Phase 0 known **not** to touch `EventDispatcher.cu` etc. — disjoint from Phase 1. |
| **Conflict-with-Phase-1 ack** | Agent A must verify in its Step 1 that no `MODULE_LOCKS.md` row holds `pianoid.py` (Phase 1 doesn't lock pianoid.py because it is CUDA-only). |
| **Branch** | `feature/midi-phase0-preflight` (or `feature/mt-1-1-midi-phase0` if `/multitask` orchestration syntax) |

#### Wave 1 — Agent B (Phase 1, CUDA)

| Field | Value |
|---|---|
| **Skill** | `/dev` |
| **Task description** | "Phase 1 (EXPANDED): Lift `beginStringBatch`/`commitStringBatch` envelope from per-event (in `PlaybackCycleExecutor::exciteStringsForPitch`) to per-cycle (in `OnlinePlaybackEngine::processEventsAtCycle` + `OfflinePlaybackEngine` equivalent). Add `stageStringsForPitch` helper. Wrap `TEST_MODE_ONLY` and `TEST_STRING_ONLY` in the same envelope (new `stageModeExcitation` helper minus commit). Rewrite vestigial `EventDispatcher::dispatchBatch` to be the actual entry point. Add `MAX_EVENTS_PER_CYCLE = 256` cap with overflow logging. Add the same-cycle chord regression test (Test 1/2/3 from original plan + Test 4 NOTE_ON+TEST_MODE_ONLY same-cycle, Test 5 NOTE_ON+TEST_STRING_ONLY same-cycle)." |
| **Effort** | M+ (3–5 h) |
| **Risk** | Medium. CUDA build (long pole). Mitigation: follow `docs/architecture/BUILD_SYSTEM.md`, never `pip install --force-reinstall`. |
| **Build** | **`--heavy --release`** (mandatory — `.cu` and `.cuh` files touched). Wrapped via `cmd //c "PianoidCore\build_pianoid_cuda.bat --heavy --release"` per the project CLAUDE.md. |
| **Files (lock list)** | `PianoidCore/pianoid_cuda/EventDispatcher.cu`, `PianoidCore/pianoid_cuda/OnlinePlaybackEngine.cu`, `PianoidCore/pianoid_cuda/OfflinePlaybackEngine.cu`, `PianoidCore/pianoid_cuda/PlaybackCycleExecutor.cu`, `PianoidCore/pianoid_cuda/Pianoid.cu`, `PianoidCore/pianoid_cuda/RealTimeEventBuffer.cu`, `PianoidCore/pianoid_cuda/constants.h`, `PianoidCore/tests/system/test_kernel_midi_batch.py` (new) |
| **Test command** | `PianoidCore/.venv/Scripts/python -m pytest PianoidCore/tests/system/test_kernel_midi_batch.py -v -s` (Test 1: 2-note same-cycle chord; Test 2: 4-note chord; Test 3: NOTE_OFF batched; **NEW** Test 4: NOTE_ON+TEST_MODE_ONLY same-cycle; **NEW** Test 5: NOTE_ON+TEST_STRING_ONLY same-cycle). Also re-run `tests/system/test_performance.py` for regression. |
| **Audio mode** | audio_off (offline rendering via `OfflinePlaybackEngine`). |
| **Pre-conditions for Agent B** | Decisions 9, 10, 12, 13 confirmed (NOTE_OFF batching, ordering, TEST_* envelope, MAX_EVENTS_PER_CYCLE). |
| **Conflict-with-Phase-0 ack** | Agent B must verify in its Step 1 that no `MODULE_LOCKS.md` row holds any `*.cu` / `*.h` file. |
| **Branch** | `feature/midi-phase1-kernel-batch` |

**Coordination rules for Wave 1:**

- Both agents register in `WORK_IN_PROGRESS.md` Active Dev Sessions.
- Locks are disjoint by design — Agent A only locks Python, Agent B only locks CUDA. No `MODULE_LOCKS.md` overlap expected. The controller (per `controller-role.md`) flags any cross-agent lock conflict at Tier-3.
- **CUDA build serialisation:** Agent B is the SOLE invoker of `build_pianoid_cuda.bat --heavy` in this wave. If Agent A discovers it needs a `--light` build (e.g., if pianoid.py edits trigger a setup.py reinstall), Agent A waits for Agent B's `--heavy` to complete. The `/multitask` rule "only one nvcc at a time" applies.
- Agent A typically finishes first (1–2 h Python vs 3–5 h CUDA + build). Agent A reports back; orchestrator relays; user reviews. Agent A enters Phase 1 idle wait (do not commit Phase 2 until W3).
- Agent B's longer pole drives Wave 1 end.

**Wave 1 exit criteria:**

- Both agents at Step 10a Phase 1 (commits made, locks released, log not yet archived).
- All Phase 1 regression tests (Test 1–5) pass for Agent B.
- Phase 0 venv-startup smoke test passes for Agent A.
- No `tests/system/test_performance.py` regression (GPU mean delta < +10 %, sound corr ≥ 0.95).

---

### Wave 2 — Gate 2 (validation pause)

**Goal:** Last "everything still works as before" snapshot before activating ingress.

**Dispatch shape:** No agents. Orchestrator action: relay both Agent A and Agent B reports to user via Telegram, ask for explicit "proceed to Phase 2" approval. User confirms.

**Why a gate here:** The kernel fix (Phase 1) is in (so chord-press is improved on the existing browser path too — incidental win) and the backend listener is *capable* of starting safely (`input()` blocker removed), but `listen_to_midi` is still default-off. Any regression discovered after Phase 1+0 must be fixed before enabling backend ingress. This matches Gate 2 in the revised plan §8.

**Manual checks before W3 dispatches (orchestrator-side or user-side):**

- `git log --oneline -5` shows two commits: `[dev-XXXX] feat: midi phase 0 preflight` and `[dev-YYYY] fix: kernel batch per-cycle envelope`.
- `MODULE_LOCKS.md` clean.
- `WORK_IN_PROGRESS.md` Active Dev Sessions cleared (Phase 2 of W1 agents — log archived, WIP rows removed) per user approval relay.
- Manual A/B test (optional): play a 4-note chord via the browser virtual piano; should be audibly tighter than pre-Phase-1 (incidental kernel-fix win).

---

### Wave 3 — Phase 2 (backend MIDI ingress activation)

**Goal:** Make tuning-mode startup activate the backend MIDI listener and broadcast `midi_note_event` to the frontend.

**Dispatch shape:** 1× `/dev` agent (sequential after W1+W2).

| Field | Value |
|---|---|
| **Skill** | `/dev` |
| **Task description** | "Phase 2: Add `emit_callback` parameter on `MIDI_listener_unified` (default no-op for `playPianoid.py` standalone). In `backendServer.py`, pass `lambda cmd, pitch, vel: socketio.emit('midi_note_event', {...})` when starting the listener. Update launcher (`server/launcher.js`) to set `listen_to_midi=1` in tuning sessions. Add `POST /midi/start` and `POST /midi/stop` REST endpoints for hot-toggle. Update REST_API.md, MIDI_SYSTEM.md, DATA_FLOWS.md §1.2." |
| **Effort** | S (1–2 h) |
| **Risk** | Low. Builds on Phase 0's `input()` fix and Phase 1's stable kernel. Decisions 3, 8 confirmed. |
| **Build** | `--light` (Python middleware change only, no `.cu` / setup.py touched). |
| **Files (lock list)** | `PianoidCore/pianoid_middleware/pianoid.py`, `PianoidCore/pianoid_middleware/backendServer.py`, `server/launcher.js`, `docs/modules/pianoid-middleware/REST_API.md`, `docs/modules/pianoid-middleware/MIDI_SYSTEM.md`, `docs/architecture/DATA_FLOWS.md` |
| **Test command** | `PianoidCore/.venv/Scripts/python -m pytest PianoidCore/tests/system/test_backend_midi_ingress.py -v -s` (new in W5; for W3 use `pytest tests/system/ -k midi -v -s` to cover existing). Also: manual `POST /load_preset {"listen_to_midi": 1, "midi_port": 0}` smoke + `curl -X POST /midi/start` smoke + Socket.IO client subscribes to `midi_note_event`. |
| **Audio mode** | audio_off for unit tests; manual smoke needs hardware MIDI loopback (skip on CI). |
| **Pre-conditions** | W1+W2 complete and merged. `MODULE_LOCKS.md` clean. Decision 8 (velocity clamp always-on) confirmed — no semantic change. |
| **Branch** | `feature/midi-phase2-ingress` |

**Coordination notes:**

- This agent must NOT touch `useMidi.js` or any frontend file — that's W4. The `socketio.emit('midi_note_event', ...)` schema is the only contract Phase 3 reads.
- The `socketio.emit` pattern follows `backendServer.py:545-567` (existing `lifecycle`, `calibration`, `midi_progress`, `engine_error` BG-thread pattern). No special threading care needed.
- Risk: GIL contention from busy-poll listener. Phase 4's latency script measures this. If observed, mitigation is a 0.5 ms `time.sleep(0.0005)` in the poll loop.

---

### Wave 4 — Phase 3 (frontend simplification + switchable broadcast)

**Goal:** Frontend becomes a thin Socket.IO subscriber. Add user-facing toggle "Send MIDI feedback to UI: yes/no".

**Dispatch shape:** 1× `/dev` agent.

| Field | Value |
|---|---|
| **Skill** | `/dev` |
| **Task description** | "Phase 3 (EXPANDED): Rewrite `PianoidTunner/src/hooks/useMidi.js` from Web MIDI owner (~130 LOC) to Socket.IO subscriber (~30 LOC). Drop `midiPlayNote` wrapper in `PianoidTuner.js`. Delete `MidiComponent.jsx`. **NEW:** Add backend `POST /midi/broadcast {\"enabled\": bool}` and `GET /midi/broadcast`. `MIDI_listener_unified`'s emit_callback checks the flag — when False, skip the entire `socketio.emit` call. Frontend exposes `midiBroadcastEnabled` plus `setMidiBroadcast(bool)` (mirroring `useFixVelocity.js` pattern). Add Settings panel toggle." |
| **Effort** | S+ (2–3 h) |
| **Risk** | Low-medium. Frontend rewrite is straightforward; switchable broadcast is the new variable. Decisions 4, 5, 6, 19, 20 confirmed. |
| **Build** | `npm` for frontend; `--light` for backend Python touches (broadcast toggle endpoints). |
| **Files (lock list)** | `PianoidTunner/src/hooks/useMidi.js`, `PianoidTunner/src/PianoidTuner.js`, `PianoidTunner/src/components/MidiComponent.jsx` (delete), Settings panel (TBD file — likely `PianoidTunner/src/components/SettingsPanel.jsx` or similar), `PianoidCore/pianoid_middleware/backendServer.py` (add 2 endpoints), `PianoidCore/pianoid_middleware/pianoid.py` (broadcast flag check in MIDI_listener_unified), `docs/modules/pianoid-middleware/REST_API.md` |
| **Test command** | `cd PianoidTunner && npm test -- --watchAll=false` (mock-Socket.IO unit test for new useMidi). Plus manual: launch full stack, press hardware key, verify `selectedPitch` updates AND broadcast-toggle works. |
| **Audio mode** | audio_off for unit tests. **Manual UX A/B** is part of Phase 4 (W5), not this wave. |
| **Pre-conditions** | W3 complete and merged. `midi_note_event` schema available (it's in REST_API.md after W3). Settings panel file identified by agent at Step 1. |
| **Branch** | `feature/midi-phase3-frontend` |

**Coordination notes:**

- This agent overlaps `backendServer.py` and `pianoid.py` with W3's lock list. Lock conflict resolution: W3 must be merged + locks released BEFORE this agent acquires its locks.
- The `useFixVelocity.js` pattern is the reference architecture for the broadcast toggle (GET-on-mount + POST/WS-on-toggle). Agent must read `useFixVelocity.js` at Step 1 (no edit, reference only).
- `MidiComponent.jsx` deletion: grep for imports first per Phase 3 risk mitigation.

---

### Wave 5 — Phase 4 (validation + measurement + docs)

**Goal:** Measured proof of latency improvement and chord-press correctness; docs reflect new architecture.

**Dispatch shape:** 1× `/dev` agent (or split into `/test-ui` + `/update-docs` if scope is too large for one agent slot — see "Recommended split" below).

| Field | Value |
|---|---|
| **Skill** | `/dev` (preferred) — or `/test-ui` then `/update-docs` if split |
| **Task description** | "Phase 4: Add `tests/system/test_kernel_midi_batch.py` (already created in W1; expand if needed). Add `tests/system/test_backend_midi_ingress.py` (Socket.IO client subscribe + rtmidi loopback simulate). Add `tests/system/midi_latency.py` measurement script (instrument `MIDI_listener_unified` ingest + audio dispatch timestamps; report median + 95p + 99p). Manual UX checklist (live MIDI keyboard): single-note tightness A/B, 4-note chord stress (count drops, expect 0), sustain pedal, last-note-pressed indicator <100 ms, browser virtual piano click, REST `POST /play`, calibration `/calibrate_volume`, `note_playback`. Update `docs/modules/pianoid-middleware/MIDI_SYSTEM.md`, `docs/architecture/DATA_FLOWS.md` §1.2 (replace browser-owned diagram with backend-owned), `docs/modules/pianoid-middleware/REST_API.md` (`midi_port`, `listen_to_midi` semantics, `GET /midi/ports`, `POST /midi/start`, `POST /midi/stop`, `POST /midi/broadcast`, `midi_note_event` Socket.IO emit). **Audio verification per strict-A1:** synthesis-output unchanged → use `/test-ui` audio_off for the audio path verification step. **Latency target:** median < 7 ms, 99p < 12 ms (Decision D1)." |
| **Effort** | M (3–5 h) |
| **Risk** | Low (validation only). The risk is that latency target fails — see fallback in §6. |
| **Build** | none (test scripts only) — possibly `--light` if pianoid.py needs latency instrumentation hooks. |
| **Files (lock list)** | `PianoidCore/tests/system/test_kernel_midi_batch.py`, `PianoidCore/tests/system/test_backend_midi_ingress.py` (new), `PianoidCore/tests/system/midi_latency.py` (new), `docs/modules/pianoid-middleware/MIDI_SYSTEM.md`, `docs/architecture/DATA_FLOWS.md`, `docs/modules/pianoid-middleware/REST_API.md`, optionally `PianoidCore/pianoid_middleware/pianoid.py` (latency instrumentation hooks; minor) |
| **Test command** | `PianoidCore/.venv/Scripts/python -m pytest PianoidCore/tests/system/ -v -s -k "midi or kernel_batch or latency"` |
| **Audio mode** | audio_off for unit tests + `/test-ui` for manual UX. |
| **Pre-conditions** | W3+W4 complete and merged. Hardware MIDI loopback (e.g., `loopMIDI`) installed for the latency script and the manual checklist. |
| **Branch** | `feature/midi-phase4-validation` |

**Recommended split (if W5 is too large for one agent slot):**

- **W5a:** `/test-ui` agent — runs the manual UX checklist (live MIDI), records pass/fail with measurements per `docs/guides/UI_TESTING.md`. Audio-affecting Phase 1 change requires this. Output: pass/fail report.
- **W5b:** `/dev` agent — adds the three test scripts (test_kernel_midi_batch.py expansion, test_backend_midi_ingress.py, midi_latency.py).
- **W5c:** `/update-docs` agent — updates the three docs (MIDI_SYSTEM.md, DATA_FLOWS.md, REST_API.md).

The `/dev` single-agent variant is preferred (Sequence A's recommended shape) because Phase 4 already includes the `/test-ui` invocation as part of its workflow per the Audio Verification Rule. The split is the fallback if the agent slot proves too long.

---

### Wave 6 — Gate 3 (manual UX sign-off)

**Goal:** User confirms the refactor is complete.

**Dispatch shape:** No agents. Orchestrator action: relay W5 measurement report + manual UX checklist results + `mkdocs serve` doc-render screenshots to user via Telegram, ask for explicit "Sequence A complete" approval.

**Sign-off criteria** (revised plan §8 Gate 3):

| Item | Pass condition |
|---|---|
| Latency median | < 7 ms |
| Latency 99p | < 12 ms |
| Chord stress test (4 notes × 20 reps) | 0 audible drops |
| Sustain pedal | CC#64 still triggers `processSustain` |
| Last-note-pressed indicator | <100 ms perceived |
| Browser virtual piano click | Audio plays (unchanged path) |
| REST `POST /play` | Audio plays (unchanged path) |
| Calibration `/calibrate_volume` | Still works |
| Switchable broadcast | Toggle off → no `socketio.emit` calls (verified by frontend stale-state observation); toggle on → resumes |
| `note_playback` | Renders correctly post-fix |
| Docs render | `http://localhost:8001/modules/pianoid-middleware/MIDI_SYSTEM/` shows updated content |

**On Gate 3 fail:** orchestrator opens a follow-up `/dev` agent to address the failed item; loops back to W5 for re-validation.

**On Gate 3 pass:** Sequence A complete. Sequence B is optional follow-up (see W7-W9).

---

### Sequence B (optional, post-Gate 3)

The user has explicitly directed to ship Sequence A first and re-evaluate Sequence B afterwards. Document W7-W9 here so the orchestrator has the dispatch shape ready when the user opts in.

---

#### Wave 7 — Phase 5 (Layer-2 surface partition + deprecation)

| Field | Value |
|---|---|
| **Skill** | `/dev` |
| **Task description** | "Phase 5: Update pybind docstrings in `AddArraysWithCUDA.cpp` for `addOneString`, `addModeExcitation`, `exciteMode`, `processSustain`, `updateSingleStringParameter_NEW`, `updateMultiStringParameter_NEW`, `resetStringsState` to point to the unified `RealTimeEventBuffer.pushEvent` path. Extend `pianoid.py:_create_playback_event` to handle PARAM_UPDATE_SINGLE, PARAM_UPDATE_BATCH, TEST_STRING_ONLY, TEST_MODE_ONLY, RESET_STATE, TOGGLE_FEEDBACK so all 8 EventTypes are producible from Python. Add `Pianoid.assert_online_event_path_clean()` debug helper (audit hook over `addOneString` etc. callsites). Document the partition (event commands / state mutations / observers) in `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md`. **Decision G1:** keep deprecated direct paths with `[[deprecated]]` warning, runtime gate by lifecycle state — do NOT hard-remove." |
| **Effort** | M (3–4 h) |
| **Risk** | Low. Mostly docstrings + Python `_create_playback_event` extension. Decision 14 confirmed (keep deprecated). |
| **Build** | `--light` (or `--heavy` only if `Pianoid.cu` modified — likely not, but agent should confirm at Step 1). |
| **Files (lock list)** | `PianoidCore/pianoid_cuda/AddArraysWithCUDA.cpp`, `PianoidCore/pianoid_middleware/pianoid.py`, `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md`, optionally `PianoidCore/pianoid_cuda/Pianoid.cu` |
| **Test command** | New unit test that produces every EventType through `_create_playback_event` and asserts round-trip through `RealTimeEventBuffer` to `EventDispatcher`. |
| **Audio mode** | audio_off. |
| **Pre-conditions** | Sequence A complete. Decisions 14, 15 confirmed. |
| **Branch** | `feature/midi-phase5-surface-partition` |

#### Wave 8 — Phase 6 (Layer-3 EventIngress facade + bypass migration)

| Field | Value |
|---|---|
| **Skill** | `/dev` |
| **Task description** | "Phase 6: Create `PianoidCore/pianoid_middleware/event_ingress.py` (new file). Define `EventIngress` class with `submit_note(source, command, pitch, velocity, *, delay_ms=0)`, `submit_mode_excitation`, `submit_string_test`, `submit_param_update`, `submit_reset` methods. Lookup `SOURCE_PRIORITIES` and `SOURCE_POLICIES` per source. Wire all REST/WS handlers in `backendServer.py` to use `pianoid.event_ingress.submit_note(source=..., ...)`. Backend MIDI listener passes `source='midi'` explicitly. Migrate calibration & measurement bypasses: `chartFunctions.py:2138` (`addOneString`) → `event_ingress.submit_string_test(source='test', ...)`; `chartFunctions.py:1223` (`exciteMode`) → `event_ingress.submit_mode_excitation(source='test', ...)`; `modal_adapter.py:3865` (measurement) → similar. Calibration's online path uses EventIngress; offline calibration keeps direct calls (carve-out documented). Delete `perform_midi_command` (one-line alias kept for `NoteTunner.py` callers OR update NoteTunner too). Delete REST `/play` legacy fallback (`backendServer.py:1282-1314`). Update REST_API.md, OVERVIEW.md with policy table." |
| **Effort** | L (8–12 h) |
| **Risk** | Medium-high. Many call sites; calibration regression risk. **Recommend split into Phase 6a (facade + REST/WS) + Phase 6b (calibration + chart bypasses)** if the agent slot is too large. |
| **Build** | `--light` (Python middleware only). |
| **Files (lock list)** | NEW `PianoidCore/pianoid_middleware/event_ingress.py`, `PianoidCore/pianoid_middleware/pianoid.py`, `PianoidCore/pianoid_middleware/backendServer.py`, `PianoidCore/pianoid_middleware/chartFunctions.py`, `PianoidCore/pianoid_middleware/modal_adapter/modal_adapter.py`, `PianoidCore/pianoid_middleware/NoteTunner.py`, `docs/modules/pianoid-middleware/REST_API.md`, `docs/modules/pianoid-middleware/OVERVIEW.md` |
| **Test command** | Existing calibration tests must pass unchanged (behaviour-preserving migration). New regression: assert `addOneString` is NOT called from any online code path during a live MIDI session (Phase 5 audit helper). |
| **Audio mode** | audio_off + manual `/calibrate_volume` smoke. |
| **Pre-conditions** | W7 (Phase 5) complete. Decisions 16, 17, 18 confirmed. |
| **Branch** | `feature/midi-phase6-event-ingress` (or split into `-6a-facade` and `-6b-bypass-migration`) |

#### Wave 9 — Phase 7 (Authority enforcement + back-pressure tuning)

| Field | Value |
|---|---|
| **Skill** | `/dev` |
| **Task description** | "Phase 7: Add `EventIngress.set_authority_window(allowed_sources, duration_ms)`. Calibration calls this to declare 'only `source='measurement'` allowed for next N ms'. Other events queued or rejected per policy. Frontend shows 'calibration in progress, MIDI muted' indicator. Set `RealTimeEventBuffer.setSizeLimit(256)` as default. Add `engine_stats.dropped_events_per_authority_window` metric. Document authority model in OVERVIEW.md." |
| **Effort** | M (3–5 h) |
| **Risk** | Medium. Authority window can block legitimate user MIDI if mis-tuned. Mitigation: log-only mode first, UX-validated before enforcement. |
| **Build** | `--light` (or `--heavy` only if `RealTimeEventBuffer.cu` constant changed; pybind already exposes `setSizeLimit`). |
| **Files (lock list)** | `PianoidCore/pianoid_middleware/event_ingress.py`, `PianoidCore/pianoid_cuda/RealTimeEventBuffer.cu`, `PianoidCore/pianoid_middleware/pianoid.py`, `PianoidCore/pianoid_middleware/chartFunctions.py`, frontend Settings panel (calibration indicator), `docs/modules/pianoid-middleware/OVERVIEW.md` |
| **Test command** | During `/calibrate_synthesis`, fire simulated NOTE_ONs from a Socket.IO client; assert dropped or queued per policy; assert calibration completes uninterrupted. |
| **Audio mode** | audio_off + manual calibration smoke. |
| **Pre-conditions** | W8 (Phase 6) complete. EventIngress class exists. |
| **Branch** | `feature/midi-phase7-authority` |

---

## 5. Skill Choice — Per-Wave Rationale

| Wave | Skill | Rationale |
|---|---|---|
| W1 Agent A | `/dev` | Code change to `pianoid.py`, `pianoidMidiListener.py`, `backendServer.py` + small docs. Auto-Trigger Rule: any task touching `.py` source code goes through `/dev`. |
| W1 Agent B | `/dev` | CUDA change. CRITICAL: any edit to `.cu`/`.cuh`/`.h` MUST go through `/dev` (project CLAUDE.md mandate). |
| W2 | none | Gate. Orchestrator + user only. |
| W3 | `/dev` | Code change to backend Python. Audio path unaffected (no synthesis change), but adds infrastructure that affects sound delivery. |
| W4 | `/dev` | Frontend rewrite + small backend touches. UI Interaction Rule says `/pianoid-ui` for UI interaction; this is UI **development** so `/dev` applies. |
| W5 | `/dev` (preferred, with `/test-ui` invocation embedded) — or split | Phase 1 affected synthesis output (kernel batch fix); per Audio Verification Rule must invoke `/test-ui` (audio_off). The `/dev` agent's Step 7 handles this. If validation scope is too large for one agent, split as W5a `/test-ui` + W5b `/dev` (tests) + W5c `/update-docs`. |
| W6 | none | Gate. Orchestrator + user only. |
| W7 | `/dev` | C++ docstring edits + Python `_create_playback_event` extension + new doc page. |
| W8 | `/dev` | New file + many call-site rewires. EventIngress facade is a Python-only architectural change. |
| W9 | `/dev` | Authority window + back-pressure tuning. Small frontend touch (calibration indicator) bundled. |

**Why `/dev` and not `/multitask`:** The wave shape IS what `/multitask` would produce — but the orchestrator should run `/multitask` for W1 explicitly so its conflict matrix machinery handles the parallel dispatch. For W3-W9 (single-agent waves), `/multitask` adds no value over direct `/dev` dispatch.

**Recommendation:**
- **W1 dispatch:** `/multitask` with the two-task input "Phase 0: MIDI pre-flight | Phase 1: kernel batch + TEST_* envelope" (pipe-separated). `/multitask` will detect the parallelism, build the wave plan (which should match this artifact), and spawn 2× `/dev` agents in parallel.
- **W3-W9 dispatch:** direct `/dev` per wave.
- An alternative for W1: spawn the 2× `/dev` agents directly from the orchestrator (skip `/multitask` overhead), since the conflict matrix is already verified in this artifact. Both approaches produce the same outcome; `/multitask` has more discipline around parallelism but adds an orchestration layer.

---

## 6. Open Questions (Surface Before Dispatch)

1. **Sequence choice — A only, A+B, or A first then re-evaluate?** Revised plan recommends A first. This artifact assumes A; B documented but not auto-dispatched.
2. **W1 dispatch shape — `/multitask` or 2× direct `/dev`?** Both work. `/multitask` is the canonical route; direct dispatch saves one orchestration layer. Recommend `/multitask` if the user wants to exercise the multitask machinery; otherwise direct.
3. **W5 split — single `/dev` or W5a `/test-ui` + W5b `/dev` + W5c `/update-docs`?** Single is preferred; split is the fallback if the agent slot is too long. Decide at W5 dispatch time based on observed agent slot ceiling in W1-W4.
4. **Settings panel file location for W4 — known?** The revised plan references "Settings panel UI" without naming the file. The W4 agent should identify it at Step 1 by reading `PianoidTunner/src/` structure. If unknown, surface as an open question to the user.
5. **`server/launcher.js` for W3 — does it exist as referenced?** The revised plan cites `server/launcher.js` but the W3 agent should verify at Step 1 whether the file is at that path or under `PianoidTunner/server/launcher.js` or another location. If the launcher does not exist as a single file, the `listen_to_midi=1` flag may need to be set via a different mechanism (frontend boot, environment variable, etc.).
6. **`MidiComponent.jsx` deletion — any imports?** W4 agent must grep for imports before deleting per Phase 3 risk mitigation. If imported, either rewire or refuse to delete (decide at agent runtime).
7. **GIL contention measurement in W5 — what's the plan if median latency is >7 ms but <10 ms?** The revised plan says < 7 ms is the target. If 7-10 ms, should the orchestrator pause and add the 0.5 ms sleep workaround (which trades 0.5 ms for GIL relief), OR ship at 7-10 ms median as "still better than 5-13 ms baseline"? Recommend: if median in 7-10 ms range, ship anyway (still 2-3× improvement) and file a follow-up for GIL profiling.
8. **Hardware MIDI loopback availability for W5 latency script.** Without loopback, the latency script must use the live hardware keyboard (less precise) or skip. Surface to user.
9. **CUDA build cache state.** If W1 Agent B hits 0xC0000142 (STATUS_DLL_INIT_FAILED), recovery is documented in `docs/architecture/BUILD_SYSTEM.md` — but it adds 10-30 min to the wave. Pre-W1: orchestrator can spawn a `/startup` agent quickly to validate the CUDA toolchain.
10. **Concurrent sub-agent permission mode.** All `/dev` agents must spawn with `mode: "bypassPermissions"` per the project CLAUDE.md "Orchestrator Sub-Agent Permission Rule (MANDATORY)". The `/dev` agent's own `/test-ui` and `/fn` sub-agent spawns must also pass `mode: "bypassPermissions"` transitively.

---

## 7. Documentation-Update Plan

The doc updates are spread across waves rather than concentrated in W5; this matches the `/dev` skill's Step 8 (mandatory before exit). Summary:

| Doc | W1 (Agents A/B) | W3 | W4 | W5 |
|---|---|---|---|---|
| `docs/modules/pianoid-middleware/MIDI_SYSTEM.md` | Document `midi_port` config, `GET /midi/ports` (Agent A) | `listen_to_midi` semantics, `POST /midi/start` / `/stop` | broadcast toggle + `useMidi` is now subscriber | final pass — render check |
| `docs/architecture/DATA_FLOWS.md` §1.2 | — | replace browser-owned diagram with backend-owned | reflect Settings toggle | final pass |
| `docs/modules/pianoid-middleware/REST_API.md` | `midi_port`, `GET /midi/ports` (Agent A) | `POST /midi/start`, `POST /midi/stop`, `midi_note_event` schema | `POST /midi/broadcast`, `GET /midi/broadcast` | final pass |
| `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md` | Update batch envelope semantics + `MAX_EVENTS_PER_CYCLE` (Agent B) | — | — | final pass |
| `docs/modules/pianoid-cuda/PLAYBACK_SYSTEM.md` | Update per-cycle drain (Agent B) | — | — | final pass |

**MkDocs render verification:** at Gate 3 (W6), user opens `http://localhost:8001/modules/pianoid-middleware/MIDI_SYSTEM/` etc. and confirms each page renders correctly. The `mkdocs serve` should run on the dev machine for the duration of W5+W6.

**Doc-gap closure:** the revised plan §1.4 says "Frontend MIDI ownership and backend MIDI ownership can co-exist — port-ownership conflict; original plan addresses but only by hard-removing Web MIDI." If during implementation a doc gap surfaces (e.g., the actual port-ownership behaviour on Linux ALSA with multi-subscriber differs from the documented Windows single-owner), W4 or W5 must close the gap per `/dev` Step 8.

---

## 8. Test Plan — Per-Wave + Cumulative

### 8.1 Per-wave tests (added by each wave)

| Wave | New tests | Coverage |
|---|---|---|
| W1 Agent A | `tests/system/test_realtime_buffer.py::test_start_listener_unified_no_input_block` (or extend existing) — assert `start_midi_listener_unified(midi_port=0, interactive=False)` does not block on `input()` | Phase 0 fix |
| W1 Agent B | `tests/system/test_kernel_midi_batch.py` — Test 1 (2-note same-cycle), Test 2 (4-note chord), Test 3 (NOTE_OFF + NOTE_ON same-cycle), **NEW** Test 4 (NOTE_ON+TEST_MODE_ONLY same-cycle), **NEW** Test 5 (NOTE_ON+TEST_STRING_ONLY same-cycle) | Phase 1 (incl. expanded scope) |
| W3 | Manual: `POST /load_preset {"listen_to_midi": 1}` + Socket.IO subscribe to `midi_note_event` + send rtmidi loopback NOTE_ON; assert event received <100 ms | Phase 2 ingress smoke |
| W4 | `cd PianoidTunner && npm test` — mock-Socket.IO unit test for new `useMidi` (subscriber semantics: `midiKeysDown`, `midiLastKeyDown`, `midiLastKeyUp`) | Phase 3 frontend |
| W5 | `tests/system/test_backend_midi_ingress.py` (hardware-loopback integration), `tests/system/midi_latency.py` (measurement), manual UX checklist (8 items per revised plan §7.5) | Phase 4 validation |

### 8.2 Cumulative regression at each gate

**Gate 2 (after W1):** all of the above for W1, plus `tests/system/test_performance.py` (no GPU mean delta > +10%, no sound corr drop below 0.95). The kernel fix should leave performance unchanged or slightly better.

**Gate 3 (after W5):** all W1-W5 tests pass, plus the manual UX checklist's 8 items, plus `mkdocs serve` doc render verification.

### 8.3 Sequence B test additions

| Wave | New tests |
|---|---|
| W7 | Round-trip test: produce every EventType via `_create_playback_event`, assert arrival at `EventDispatcher` |
| W8 | Calibration regression suite passes unchanged; assert no `addOneString` in any online path during a live MIDI session |
| W9 | During `/calibrate_synthesis`, fire NOTE_ONs from a Socket.IO client; assert dropped or queued per policy |

### 8.4 Audio verification routing per strict-A1

Per the project CLAUDE.md "Audio Verification Rule":

- **Phase 1** (synthesis-output change — kernel batch envelope) → `/test-ui` audio_off mode. Comparison via `note_playback` deterministic offline render. The W1 Agent B's `/dev` Step 7 handles this.
- **Phase 2, 3, 4, 5, 6, 7** (no synthesis-output change — only ingress, broadcast, surface partition, facade, authority) → no audio re-verification required, **except**:
  - W3 must verify the audio path still works (existing `note_playback` smoke is sufficient — no behavioural change expected).
  - W4 must verify the broadcast toggle does not affect the audio path (the Settings toggle should be inert with respect to synthesis output).
  - W5 explicitly invokes `/test-ui` audio_off as part of the manual UX checklist.
- **No `/diagnose` (audio_on)** required at any wave — none of these phases touch the mic-engaging path (calibration is mentioned but not modified in Sequence A; calibration migration is W8 and the bypass migration's online path uses EventIngress, but the offline calibration is the `audio_on` path and is not touched).

---

## 9. Risks & Mitigations Beyond the Source Plans

The source plans cover risk in detail (revised plan §7, original plan §8). This section adds dispatch-layer risks specific to this implementation plan:

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| W1 Agent B's CUDA build (3-5 h) blocks Agent A's progress at the merge gate | Low | Medium | Agent A self-merges its branch on Step 9; orchestrator does not gate Agent A on Agent B. They merge independently into `dev`. |
| Concurrent `MODULE_LOCKS.md` edits between W1 Agent A and Agent B | Very low (lock rows are append) | Low | The lock file's "multiple agents may add/remove their own rows" rule (per `/dev`) handles this. Controller agent (per `controller-role.md`) flags any cross-agent same-file lock as Tier-3. |
| W3 / W4 / W5 sequential dispatch consumes too many orchestrator-side wait cycles | Medium | Low | Each wave is bounded (S to M effort). User can dismiss this by approving with broad mandate at Gate 2. |
| User decision oscillation between Gate 1 and W7 dispatch | Low | Medium | Surface decisions 14-21 (Sequence B-only) at W7 dispatch, not at Gate 1. Avoids confusing the user with 21 decisions when only 13 are needed for Sequence A. |
| `/test-ui` UI testing flakiness blocks Gate 3 | Medium (chrome-devtools MCP is known-fragile per CLAUDE.md) | Medium | Gate 3 has fallback: if `/test-ui` flakes, the manual UX checklist (with the user at the keyboard) is sufficient. The latency script does NOT depend on `/test-ui`. |
| Hardware MIDI keyboard not present for Gate 3 | Low | High (cannot complete sign-off) | Pre-W1: orchestrator confirms with user that keyboard is plugged in. If not, defer Gate 3 to a session where it is available; W5 still produces the latency script result (loopback) and the unit/integration tests. |
| Sequence B drift during Sequence A | Low | Low | Sequence B is documented and frozen at the time of this plan. If new defects are discovered during Sequence A that affect Sequence B, file a follow-up note in W6 Gate 3 report. |

---

## 10. Recommended Dispatch Shape (Summary for Orchestrator)

1. **Surface decisions 1–13 to user via Telegram. Get explicit confirmations.** Decisions 14–21 deferred to W7 dispatch.
2. **Verify pre-conditions §2.2 + §2.3.** If repo dirty, run Step 1.5 health check first. If MIDI loopback / hardware keyboard absent, flag now.
3. **W1 dispatch:**
   - **Option A (recommended):** spawn `/multitask` with input "Phase 0: MIDI pre-flight — replace input() port-prompt at pianoid.py:1445 with config-driven port; resolve double-port-open in pianoidMidiListener; add GET /midi/ports REST endpoint; document midi_port. | Phase 1: Lift beginStringBatch/commitStringBatch envelope from per-event to per-cycle in OnlinePlaybackEngine + OfflinePlaybackEngine. Add stageStringsForPitch helper. Wrap TEST_MODE_ONLY and TEST_STRING_ONLY in same envelope. Rewrite vestigial dispatchBatch. Add MAX_EVENTS_PER_CYCLE=256. Add same-cycle chord regression test (5 cases)." — `/multitask` will produce the wave plan, present for approval, then spawn 2× `/dev`.
   - **Option B (faster):** spawn 2× `/dev` directly with the prompts above. Skip `/multitask` since the conflict matrix is already verified.
4. **Wait for W1 Phase 1 reports from both agents.** Relay to user.
5. **W2 Gate 2:** await user "proceed to Phase 2".
6. **W3 dispatch:** 1× `/dev`, prompt per §4 W3.
7. **W4 dispatch:** 1× `/dev`, prompt per §4 W4. (W3 must merge first.)
8. **W5 dispatch:** 1× `/dev` (preferred) or split per §4 W5. (W4 must merge first.)
9. **W6 Gate 3:** relay W5 measurement report + manual UX checklist + doc render screenshots. Await user "Sequence A complete".
10. **Sequence A done.** If user opts in to Sequence B: surface decisions 14–21, then W7-W9 dispatch sequentially.

**Orchestrator-level discipline notes:**
- Every Agent dispatch must include `mode: "bypassPermissions"` per project CLAUDE.md.
- Use Agent Teams (`team_name: "pianoid-dev"`) for `/dev` agents that may need `SendMessage` follow-ups (recommended for all waves).
- After each dev agent reports Phase 1 complete, run Pre-Handoff Process Hygiene (kill stale processes on 5000/5001/3000/3001 + check `pianoidCuda.pyd` lock holders) before relaying.
- Each `/dev` agent's commit prefix must match `[<agent-id>]` per the Commit Convention.

---

## 11. Appendix — Source Cross-References

- **Revised consolidated plan:** `docs/proposals/midi-system-refactoring-plan-revised-2026-05-08.md`
- **Original consolidated plan:** `docs/proposals/midi-system-refactoring-plan-2026-05-08.md`
- **Kernel batch investigation (Layer 1):** `docs/proposals/kernel-midi-batch-investigation-2026-05-08.md`
- **MIDI input relocation analysis (Layer 3):** `docs/proposals/midi-input-relocation-analysis-2026-05-08.md`
- **MIDI module docs:** `docs/modules/pianoid-middleware/MIDI_SYSTEM.md`
- **CUDA synthesis engine:** `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md` (lines 549-586 batch API + new_notes_ind contract)
- **Architecture data flows:** `docs/architecture/DATA_FLOWS.md` §1.2 (current Path A — to be replaced in W3)
- **Project rules:** `.claude/CLAUDE.md` (Audio Verification Rule, Auto-Trigger Rule, Documentation-First Rule, Build Commands)
- **Skill definitions:** `.claude/commands/dev.md`, `.claude/commands/multitask.md`, `.claude/commands/test-ui.md`, `.claude/commands/update-docs.md`
- **Controller proposal (in flight):** `docs/proposals/controller-role.md` — once landed, the controller monitors the multi-agent W1 invariants automatically.

---

## 12. One-Sentence Summary

Sequence A of the MIDI refactor lands in 5 dispatch waves (W1 parallel Phase 0+1 → Gate 2 → W3 Phase 2 → W4 Phase 3 → W5 Phase 4 → Gate 3) with 6 dev-agent slots, gated by 13 user decisions confirmed up front and 8 manual sign-off items at Gate 3, achieving a 2× live-MIDI latency win and a 0-drop chord-press guarantee in 10–17 hours; Sequence B (3 more waves, Phases 5–7) is documented and dispatch-ready but deferred per user direction until Sequence A is validated.
